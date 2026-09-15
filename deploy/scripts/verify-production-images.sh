#!/usr/bin/env bash
set -euo pipefail

# Both a local content-addressed image ID and a registry digest are immutable.
for name in API_IMAGE WEB_IMAGE WORKER_IMAGE RUNNER_IMAGE CHATGPT_BROWSER_IMAGE CHATGPT_EGRESS_PROXY_IMAGE; do
  value="${!name:-}"
  if [[ "$name" == CHATGPT_* && -z "$value" ]]; then continue; fi
  if [[ ! "$value" =~ ^sha256:[a-f0-9]{64}$ && ! "$value" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]]; then
    echo "$name must use an immutable sha256 image digest" >&2
    exit 1
  fi
done

if [[ -n "${AIALRA_RELEASE_REVISION:-}" ]]; then
  [[ "$AIALRA_RELEASE_REVISION" =~ ^[a-f0-9]{40}$ ]] || {
    echo "AIALRA_RELEASE_REVISION must be a full Git commit" >&2
    exit 1
  }
  for name in API_IMAGE WEB_IMAGE WORKER_IMAGE RUNNER_IMAGE CHATGPT_BROWSER_IMAGE CHATGPT_EGRESS_PROXY_IMAGE; do
    value="${!name:-}"
    [[ -n "$value" ]] || continue
    actual_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$value")"
    [[ "$actual_revision" == "$AIALRA_RELEASE_REVISION" ]] || {
      echo "$name revision label does not match AIALRA_RELEASE_REVISION" >&2
      exit 1
    }
  done
fi
