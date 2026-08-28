#!/usr/bin/env bash
set -euo pipefail

# Reject mutable application tags in the production deployment environment.
for name in API_IMAGE WEB_IMAGE WORKER_IMAGE RUNNER_IMAGE; do
  value="${!name:-}"
  if [[ ! "$value" =~ @sha256:[a-f0-9]{64}$ ]]; then
    echo "$name must use an immutable sha256 image digest" >&2
    exit 1
  fi
done
