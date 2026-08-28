#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${PRODUCTION_ENV:?PRODUCTION_ENV is required}"

[[ "$EUID" -eq 0 ]] || { echo "Run this script as root" >&2; exit 1; }
[[ -f "$RELEASE_DIR/deploy/compose.yaml" ]] || { echo "Release directory is incomplete" >&2; exit 1; }
[[ -f "$PRODUCTION_ENV" ]] || { echo "Production environment is missing" >&2; exit 1; }

cd "$RELEASE_DIR"
docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml build api web worker runner
docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml up --detach postgres api web
docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml ps
curl --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 2 \
  http://127.0.0.1:13210/readyz >/dev/null
curl --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 2 \
  http://127.0.0.1:13211/ >/dev/null
echo "Control plane is healthy; the Codex Worker profile is still gated"
