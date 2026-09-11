#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${PRODUCTION_ENV:?PRODUCTION_ENV is required}"
: "${ACTION:=start}"
: "${QUALIFICATION_RUN_ID:=}"

[[ "$EUID" -eq 0 ]] || { echo "Run this script as root" >&2; exit 1; }
[[ -f "$PRODUCTION_ENV" ]] || { echo "Production environment is missing" >&2; exit 1; }

cd "$RELEASE_DIR"
compose=(docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml --profile codex --profile chatgpt-web)

set_flag() {
  local value="$1"
  if grep -q '^CHATGPT_WEB_ADAPTER_ENABLED=' "$PRODUCTION_ENV"; then
    sed -i "s/^CHATGPT_WEB_ADAPTER_ENABLED=.*/CHATGPT_WEB_ADAPTER_ENABLED=${value}/" "$PRODUCTION_ENV"
  else
    printf 'CHATGPT_WEB_ADAPTER_ENABLED=%s\n' "$value" >>"$PRODUCTION_ENV"
  fi
}

set_environment_value() {
  local name="$1"
  local value="$2"
  if grep -q "^${name}=" "$PRODUCTION_ENV"; then
    sed -i "s/^${name}=.*/${name}=${value}/" "$PRODUCTION_ENV"
  else
    printf '%s=%s\n' "$name" "$value" >>"$PRODUCTION_ENV"
  fi
}

read_environment_value() {
  local name="$1"
  local fallback="$2"
  local value
  value="$(awk -F= -v key="$name" '$1==key{print substr($0,index($0,"=")+1); exit}' "$PRODUCTION_ENV")"
  printf '%s' "${value:-$fallback}"
}

assert_no_active_work() {
  local active_count
  active_count="$("${compose[@]}" exec -T postgres psql -At -U router -d router <<'SQL'
SELECT
  (SELECT count(*) FROM jobs WHERE status IN ('accepted','awaiting_approval','queued','running','validating')) +
  (SELECT count(*) FROM chatgpt_web_qualification_runs
   WHERE run->>'status' IN ('accepted','running'));
SQL
)"
  [[ "$active_count" == "0" ]] || {
    echo "Refusing to restart API or Worker while ${active_count} task or qualification run is active" >&2
    exit 1
  }
}

wait_for_service_health() {
  local service="$1"
  local attempt container_id state
  for attempt in $(seq 1 90); do
    container_id="$("${compose[@]}" ps -q "$service")"
    if [[ -n "$container_id" ]]; then
      state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      if [[ "$state" == "healthy" || "$state" == "running" ]]; then
        return 0
      fi
      [[ "$state" != "unhealthy" ]] || break
    fi
    sleep 1
  done
  echo "Service ${service} did not become healthy" >&2
  return 1
}

wait_for_control_plane() {
  wait_for_service_health api
  wait_for_service_health worker
  "${compose[@]}" exec -T api node -e \
    "Promise.all(['/healthz','/readyz'].map(p=>fetch('http://127.0.0.1:13210'+p))).then(r=>process.exit(r.every(x=>x.ok)?0:1)).catch(()=>process.exit(1))"
}

restart_control_plane_with_rollback() {
  local target_enabled="$1"
  local target_diagnostic="$2"
  local target_concurrency="$3"
  local old_enabled old_diagnostic old_concurrency transition_active=true
  old_enabled="$(read_environment_value CHATGPT_WEB_ADAPTER_ENABLED false)"
  old_diagnostic="$(read_environment_value CHATGPT_WEB_DIAGNOSTIC_ENABLED false)"
  old_concurrency="$(read_environment_value CHATGPT_WEB_MAX_CONCURRENCY 1)"
  rollback_runtime() {
    local exit_code=$?
    trap - ERR INT TERM
    if [[ "$transition_active" == "true" ]]; then
      set_flag "$old_enabled"
      set_environment_value CHATGPT_WEB_DIAGNOSTIC_ENABLED "$old_diagnostic"
      set_environment_value CHATGPT_WEB_MAX_CONCURRENCY "$old_concurrency"
      "${compose[@]}" up --detach --force-recreate api worker >/dev/null 2>&1 || true
      wait_for_control_plane >/dev/null 2>&1 || true
    fi
    exit "$exit_code"
  }
  trap rollback_runtime ERR INT TERM
  set_flag "$target_enabled"
  set_environment_value CHATGPT_WEB_DIAGNOSTIC_ENABLED "$target_diagnostic"
  set_environment_value CHATGPT_WEB_MAX_CONCURRENCY "$target_concurrency"
  "${compose[@]}" up --detach --force-recreate api worker
  wait_for_control_plane
  transition_active=false
  trap - ERR INT TERM
}

wait_for_bridge() {
  local service="$1"
  local attempt
  for attempt in $(seq 1 30); do
    if "${compose[@]}" exec -T "$service" node -e \
      "fetch('http://127.0.0.1:13216/healthz').then(r=>process.exit([200,503].includes(r.status)?0:1)).catch(()=>process.exit(1))"; then
      return 0
    fi
    sleep 1
  done
  echo "ChatGPT browser bridge did not become ready" >&2
  return 1
}

case "$ACTION" in
  start)
    set_flag false
    set_environment_value CHATGPT_WEB_DIAGNOSTIC_ENABLED true
    # Keep the bridge ready for production requests while the API and Worker remain closed.
    # This lets ACTION=enable open admission without restarting Chromium and invalidating
    # an account session that just passed its real probe.
    CHATGPT_WEB_ADAPTER_ENABLED=true CHATGPT_WEB_DIAGNOSTIC_ENABLED=true \
      "${compose[@]}" up --detach --force-recreate \
      chatgpt-egress-proxy chatgpt-browser chatgpt-browser-b
    wait_for_bridge chatgpt-browser
    wait_for_bridge chatgpt-browser-b
    echo "Visible browser pool started with the experiment disabled"
    echo "Open the protected /chatgpt-browser/ and /chatgpt-browser-b/ VNC paths through the Router origin"
    ;;
  enable)
    assert_no_active_work
    [[ "$QUALIFICATION_RUN_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || {
      echo "QUALIFICATION_RUN_ID must name a completed single probe or full qualification" >&2
      exit 1
    }
    effective_concurrency="$(awk -F= '$1=="CHATGPT_WEB_MAX_CONCURRENCY"{print $2; exit}' "$PRODUCTION_ENV")"
    if ! [[ "$effective_concurrency" =~ ^[1-9][0-9]*$ ]] || (( effective_concurrency > 2 )); then
      effective_concurrency=1
    fi
    qualification_record="$("${compose[@]}" exec -T postgres psql -At -U router -d router \
      -v run_id="$QUALIFICATION_RUN_ID" <<'SQL'
SELECT CASE
  WHEN run->>'suite'='single_probe'
    AND run->>'status'='succeeded'
    AND COALESCE((run->>'total')::integer,0) = 1
    AND COALESCE((run->>'completed')::integer,0) = 1
    AND COALESCE((run->>'succeeded')::integer,0) = 1
    AND COALESCE((run->>'failed')::integer,0) = 0
    AND jsonb_array_length(COALESCE(run->'items','[]'::jsonb)) = 1
    AND (run->'items'->0->>'status')='succeeded'
    AND COALESCE((run->'items'->0->>'submittedCount')::integer,0) = 1
    AND (run->'items'->0->>'ownershipMatched')='true'
    AND (run->'items'->0->>'temporaryChatVerified')='true'
  THEN 'pass'
  WHEN run->>'suite'='full_10'
    AND run->>'status'='succeeded'
    AND COALESCE((run->>'succeeded')::integer,0) >= 9
  THEN 'pass'
  ELSE 'fail'
END || '|' || COALESCE(run->>'accountId', 'account-a')
FROM chatgpt_web_qualification_runs
WHERE id=:'run_id';
SQL
)"
    qualification_status="${qualification_record%%|*}"
    account_id="${qualification_record##*|}"
    [[ "$qualification_status" == "pass" ]] || {
      echo "The qualification record did not pass the account qualification gate" >&2
      exit 1
    }
    bridge_service=""
    case "$account_id" in
      account-a) bridge_service="chatgpt-browser" ;;
      account-b) bridge_service="chatgpt-browser-b" ;;
      account-c) bridge_service="chatgpt-browser-c" ;;
      account-d) bridge_service="chatgpt-browser-d" ;;
      *) echo "Qualification record has an invalid account slot" >&2; exit 1 ;;
    esac
    "${compose[@]}" exec -T "$bridge_service" node -e \
      "fetch('http://127.0.0.1:13216/healthz').then(async r=>{const b=await r.json();process.exit(b.enabled&&b.sandboxVerified&&b.extensionConnected&&b.pageReady&&b.authenticated?0:1)}).catch(()=>process.exit(1))"
    qualified_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    succeeded="$("${compose[@]}" exec -T postgres psql -At -U router -d router \
      -v run_id="$QUALIFICATION_RUN_ID" <<'SQL'
SELECT run->>'succeeded'
FROM chatgpt_web_qualification_runs
WHERE id=:'run_id';
SQL
)"
    "${compose[@]}" exec -T postgres psql -U router -d router -v ON_ERROR_STOP=1 \
      -v qualified_at="$qualified_at" -v succeeded="$succeeded" \
      -v run_id="$QUALIFICATION_RUN_ID" -v account_id="$account_id" \
      -v effective_concurrency="$effective_concurrency" <<'SQL'
UPDATE chatgpt_web_accounts
SET enabled=TRUE,
    qualified=TRUE,
    status=status || jsonb_build_object(
      'enabled', TRUE,
      'qualified', TRUE,
      'state', 'ready',
      'lastProbePassed', TRUE,
      'lastProbeAt', :'qualified_at',
      'updatedAt', :'qualified_at'
    ),
    updated_at=:'qualified_at'
WHERE account_id=:'account_id';

INSERT INTO chatgpt_web_status (singleton,status,updated_at)
VALUES (
  TRUE,
  jsonb_build_object(
    'configuredEnabled', TRUE,
    'effectiveConcurrency', :'effective_concurrency'::integer,
    'maximumConcurrency', 2,
    'activeTabs', 0,
    'queuedJobs', 0,
    'sandboxVerified', TRUE,
    'extensionConnected', TRUE,
    'pageReady', TRUE,
    'authenticated', TRUE,
    'circuitState', 'closed',
    'circuitReason', NULL,
    'cooldownUntil', NULL,
    'rateLimitState', 'clear',
    'retryAfter', NULL,
    'lastRateLimitAt', NULL,
    'consecutiveRateLimits', 0,
    'conversationMode', 'temporary_per_request',
    'temporaryChatVerified', TRUE,
    'lastRecoveryProbeAt', NULL,
    'lastRecoveryProbePassed', NULL,
    'lastSubmissionAt', NULL,
    'successesAtCurrentLevel', 0,
    'attemptsAtCurrentLevel', 0,
    'severeErrorsAtCurrentLevel', 0,
    'lastQualifiedAt', :'qualified_at',
    'lastQualificationPassed', TRUE,
    'lastQualificationSucceeded', :'succeeded'::integer,
    'lastQualificationRunId', :'run_id',
    'accounts', jsonb_build_array((SELECT status FROM chatgpt_web_accounts WHERE account_id=:'account_id')),
    'updatedAt', :'qualified_at'
  ),
  :'qualified_at'
)
ON CONFLICT (singleton) DO UPDATE SET
  status=chatgpt_web_status.status || jsonb_build_object(
    'configuredEnabled', TRUE,
    'effectiveConcurrency', :'effective_concurrency'::integer,
    'maximumConcurrency', 2,
    'circuitState', 'closed',
    'circuitReason', NULL,
    'cooldownUntil', NULL,
    'rateLimitState', 'clear',
    'retryAfter', NULL,
    'consecutiveRateLimits', 0,
    'conversationMode', 'temporary_per_request',
    'temporaryChatVerified', TRUE,
    'successesAtCurrentLevel', 0,
    'attemptsAtCurrentLevel', 0,
    'severeErrorsAtCurrentLevel', 0,
    'lastQualifiedAt', :'qualified_at',
    'lastQualificationPassed', TRUE,
    'lastQualificationSucceeded', :'succeeded'::integer,
    'lastQualificationRunId', :'run_id',
    'accounts', jsonb_build_array((SELECT status FROM chatgpt_web_accounts WHERE account_id=:'account_id')),
    'updatedAt', :'qualified_at'
  ),
  updated_at=EXCLUDED.updated_at;
SQL
    # Browsers were deliberately started with their internal bridge enabled by ACTION=start.
    # Do not recreate them here: a Chromium restart can invalidate a freshly verified login.
    restart_control_plane_with_rollback true false "$effective_concurrency"
    echo "ChatGPT web account pool enabled at concurrency $effective_concurrency"
    ;;
  disable)
    assert_no_active_work
    restart_control_plane_with_rollback false false \
      "$(read_environment_value CHATGPT_WEB_MAX_CONCURRENCY 1)"
    echo "ChatGPT web experiment disabled; the visible browser remains available for diagnosis"
    ;;
  stop)
    assert_no_active_work
    restart_control_plane_with_rollback false false \
      "$(read_environment_value CHATGPT_WEB_MAX_CONCURRENCY 1)"
    "${compose[@]}" stop chatgpt-browser chatgpt-browser-b
    echo "ChatGPT web experiment and visible browser stopped"
    ;;
  *)
    echo "ACTION must be start, enable, disable, or stop" >&2
    exit 1
    ;;
esac
