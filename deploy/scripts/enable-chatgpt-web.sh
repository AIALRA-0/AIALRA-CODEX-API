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

wait_for_bridge() {
  local expected="$1"
  local attempt
  for attempt in $(seq 1 30); do
    if "${compose[@]}" exec -T chatgpt-browser node -e \
      "fetch('http://127.0.0.1:13216/healthz').then(r=>process.exit(${expected})).catch(()=>process.exit(1))"; then
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
    "${compose[@]}" build chatgpt-browser chatgpt-egress-proxy
    "${compose[@]}" up --detach chatgpt-egress-proxy chatgpt-browser
    wait_for_bridge "[200,503].includes(r.status)?0:1"
    echo "Visible browser started with the experiment disabled"
    echo "Open /chatgpt-browser/vnc.html?autoconnect=true&resize=remote&path=chatgpt-browser/websockify through the protected Router origin"
    ;;
  enable)
    [[ "$QUALIFICATION_RUN_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || {
      echo "QUALIFICATION_RUN_ID must name a completed single probe or full qualification" >&2
      exit 1
    }
    qualification_status="$("${compose[@]}" exec -T postgres psql -At -U router -d router \
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
END
FROM chatgpt_web_qualification_runs
WHERE id=:'run_id';
SQL
)"
    [[ "$qualification_status" == "pass" ]] || {
      echo "The qualification record did not pass every release gate" >&2
      exit 1
    }
    "${compose[@]}" exec -T chatgpt-browser node -e \
      "fetch('http://127.0.0.1:13216/healthz').then(async r=>{const b=await r.json();process.exit(b.sandboxVerified&&b.extensionConnected&&b.pageReady&&b.authenticated?0:1)}).catch(()=>process.exit(1))"
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
      -v run_id="$QUALIFICATION_RUN_ID" <<'SQL'
INSERT INTO chatgpt_web_status (singleton,status,updated_at)
VALUES (
  TRUE,
  jsonb_build_object(
    'configuredEnabled', TRUE,
    'effectiveConcurrency', 1,
    'maximumConcurrency', 1,
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
    'updatedAt', :'qualified_at'
  ),
  :'qualified_at'
)
ON CONFLICT (singleton) DO UPDATE SET
  status=chatgpt_web_status.status || jsonb_build_object(
    'configuredEnabled', TRUE,
    'effectiveConcurrency', 1,
    'maximumConcurrency', 1,
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
    'updatedAt', :'qualified_at'
  ),
  updated_at=EXCLUDED.updated_at;
SQL
    set_flag true
    set_environment_value CHATGPT_WEB_DIAGNOSTIC_ENABLED false
    "${compose[@]}" up --detach --force-recreate api worker chatgpt-browser
    echo "ChatGPT web experiment enabled at concurrency 1"
    ;;
  disable)
    set_flag false
    set_environment_value CHATGPT_WEB_DIAGNOSTIC_ENABLED false
    "${compose[@]}" up --detach --force-recreate api worker
    echo "ChatGPT web experiment disabled; the visible browser remains available for diagnosis"
    ;;
  stop)
    set_flag false
    set_environment_value CHATGPT_WEB_DIAGNOSTIC_ENABLED false
    "${compose[@]}" up --detach --force-recreate api worker
    "${compose[@]}" stop chatgpt-browser
    echo "ChatGPT web experiment and visible browser stopped"
    ;;
  *)
    echo "ACTION must be start, enable, disable, or stop" >&2
    exit 1
    ;;
esac
