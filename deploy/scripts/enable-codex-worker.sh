#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${PRODUCTION_ENV:?PRODUCTION_ENV is required}"
: "${CODEX_AUTH_DIR:?CODEX_AUTH_DIR is required}"

[[ "$EUID" -eq 0 ]] || { echo "Run this script as root" >&2; exit 1; }
[[ -s "$CODEX_AUTH_DIR/auth.json" ]] || { echo "Dedicated Codex login is missing" >&2; exit 1; }

cd "$RELEASE_DIR"
compose=(docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml --profile codex)
RELEASE_DIR="$RELEASE_DIR" \
  PRODUCTION_ENV="$PRODUCTION_ENV" \
  CODEX_AUTH_DIR="$CODEX_AUTH_DIR" \
  bash deploy/scripts/verify-worker-isolation.sh
"${compose[@]}" up --detach runner
"${compose[@]}" exec -T runner node -e \
  "fetch('http://127.0.0.1:13214/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
PRODUCTION_ENV="$PRODUCTION_ENV" bash deploy/scripts/install-runner-egress-policy.sh
PRODUCTION_ENV="$PRODUCTION_ENV" bash deploy/scripts/verify-runner-egress.sh
"${compose[@]}" up --detach worker
curl --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 2 \
  http://127.0.0.1:13212/healthz >/dev/null
sed -i 's/^JOB_SUBMISSION_ENABLED=false$/JOB_SUBMISSION_ENABLED=true/' "$PRODUCTION_ENV"
docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml up --detach api
curl --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 2 \
  http://127.0.0.1:13210/readyz >/dev/null
echo "Codex Worker and task submission are enabled"
