#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${PRODUCTION_ENV:?PRODUCTION_ENV is required}"

[[ "$EUID" -eq 0 ]] || { echo "Run this script as root" >&2; exit 1; }
[[ -f "$RELEASE_DIR/deploy/compose.yaml" ]] || { echo "Release directory is incomplete" >&2; exit 1; }
[[ -f "$PRODUCTION_ENV" ]] || { echo "Production environment is missing" >&2; exit 1; }

cd "$RELEASE_DIR"
release_tag="$(basename "$RELEASE_DIR")"
[[ "$release_tag" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Release directory name is not a valid image tag" >&2; exit 1; }

export API_IMAGE="aialra-model-router-api:$release_tag"
export WEB_IMAGE="aialra-model-router-web:$release_tag"
export WORKER_IMAGE="aialra-model-router-worker:$release_tag"
export RUNNER_IMAGE="aialra-model-router-runner:$release_tag"
export CHATGPT_BROWSER_IMAGE="aialra-model-router-chatgpt-browser:$release_tag"
export CHATGPT_EGRESS_PROXY_IMAGE="aialra-model-router-chatgpt-egress-proxy:$release_tag"
docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml build \
  api web worker runner chatgpt-browser chatgpt-egress-proxy

upsert_image() {
  local name="$1"
  local value="$2"
  if grep -q "^${name}=" "$PRODUCTION_ENV"; then
    sed -i "s|^${name}=.*|${name}=${value}|" "$PRODUCTION_ENV"
  else
    printf '%s=%s\n' "$name" "$value" >>"$PRODUCTION_ENV"
  fi
}

cp -an "$PRODUCTION_ENV" "${PRODUCTION_ENV}.before-image-${release_tag}"
upsert_image API_IMAGE "$(docker image inspect --format '{{.Id}}' "$API_IMAGE")"
upsert_image WEB_IMAGE "$(docker image inspect --format '{{.Id}}' "$WEB_IMAGE")"
upsert_image WORKER_IMAGE "$(docker image inspect --format '{{.Id}}' "$WORKER_IMAGE")"
upsert_image RUNNER_IMAGE "$(docker image inspect --format '{{.Id}}' "$RUNNER_IMAGE")"
upsert_image CHATGPT_BROWSER_IMAGE "$(docker image inspect --format '{{.Id}}' "$CHATGPT_BROWSER_IMAGE")"
upsert_image CHATGPT_EGRESS_PROXY_IMAGE "$(docker image inspect --format '{{.Id}}' "$CHATGPT_EGRESS_PROXY_IMAGE")"
unset API_IMAGE WEB_IMAGE WORKER_IMAGE RUNNER_IMAGE CHATGPT_BROWSER_IMAGE CHATGPT_EGRESS_PROXY_IMAGE

docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml up --detach postgres
docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml up --detach --force-recreate api web
docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml ps
curl --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 2 \
  http://127.0.0.1:13210/readyz >/dev/null
curl --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 2 \
  http://127.0.0.1:13211/ >/dev/null
echo "Control plane is healthy; the Codex Worker profile is still gated"
