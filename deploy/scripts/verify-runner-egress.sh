#!/usr/bin/env bash
set -euo pipefail

: "${PRODUCTION_ENV:?PRODUCTION_ENV is required}"

compose=(docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml --profile codex)
runner_id="$("${compose[@]}" ps --quiet runner)"
[[ -n "$runner_id" ]] || { echo "Runner is not running" >&2; exit 1; }

docker exec "$runner_id" node -e \
  "fetch('https://example.com').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

for target in \
  http://169.254.169.254/latest/meta-data/ \
  http://100.100.100.100/ \
  http://10.0.0.1/ \
  http://172.16.0.1/ \
  http://192.168.0.1/
do
  if docker exec "$runner_id" node -e \
    "fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))" \
    "$target"
  then
    echo "Runner private-network egress canary failed for $target" >&2
    exit 1
  fi
done

status="$(docker exec "$runner_id" node -e \
  "fetch('http://127.0.0.1:13214/quota').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('blocked'))")"
[[ "$status" == "401" || "$status" == "blocked" ]] || {
  echo "Runner loopback control endpoint accepted an unauthenticated request" >&2
  exit 1
}

echo "Runner public egress, private-address blocking and loopback authentication canaries passed"
