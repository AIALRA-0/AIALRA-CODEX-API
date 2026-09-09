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
