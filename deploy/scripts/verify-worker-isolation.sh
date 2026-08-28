#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${PRODUCTION_ENV:?PRODUCTION_ENV is required}"
: "${CODEX_AUTH_DIR:?CODEX_AUTH_DIR is required}"

[[ -s "$CODEX_AUTH_DIR/auth.json" ]] || { echo "Dedicated Codex login is missing" >&2; exit 1; }
grep -q '^aialra-codex-worker ' /sys/kernel/security/apparmor/profiles || {
  echo "Worker AppArmor profile is not loaded" >&2
  exit 1
}

cd "$RELEASE_DIR"
result_dir="$(mktemp -d)"
trap 'rm -rf "$result_dir"' EXIT

compose=(docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml --profile codex)
sandbox=(
  run -T --rm --no-deps --workdir /workspace/jobs --entrypoint codex runner
  sandbox --sandbox-state-disable-network
  -c 'permissions.aialra_router_task.filesystem={":root"="read","/run/secrets"="deny","/proc"="deny","/codex-auth"="deny","/workspace/jobs"="read"}'
  -P aialra_router_task -C /workspace/jobs --
)

auth_output="$result_dir/auth.txt"
if "${compose[@]}" "${sandbox[@]}" bash -lc 'wc -c /codex-auth/auth.json' \
  >"$auth_output" 2>&1; then
  echo "Codex identity directory isolation canary failed" >&2
  exit 1
fi
grep -F 'Permission denied' "$auth_output" >/dev/null || {
  echo "Codex identity directory isolation did not produce the expected denial" >&2
  exit 1
}

proc_output="$result_dir/proc.txt"
if "${compose[@]}" "${sandbox[@]}" bash -lc 'wc -c /proc/1/environ' \
  >"$proc_output" 2>&1; then
  echo "Runner process-environment isolation canary failed" >&2
  exit 1
fi
grep -F 'Permission denied' "$proc_output" >/dev/null || {
  echo "Runner process-environment canary did not produce the expected denial" >&2
  exit 1
}

secret_mount_output="$result_dir/secrets.txt"
if "${compose[@]}" "${sandbox[@]}" bash -lc 'ls -la /run/secrets' \
  >"$secret_mount_output" 2>&1; then
  echo "Runner secret-mount isolation canary failed" >&2
  exit 1
fi
grep -E 'Permission denied|No such file or directory' "$secret_mount_output" >/dev/null || {
  echo "Runner secret-mount canary did not prove that the mount is unavailable" >&2
  exit 1
}

environment_output="$result_dir/environment.txt"
if "${compose[@]}" "${sandbox[@]}" bash -lc \
  'env | grep -E "^(DATABASE_URL|DATABASE_URL_FILE|PAYLOAD_MASTER_KEY|PAYLOAD_MASTER_KEY_FILE|API_KEY_PEPPER)="' \
  >"$environment_output" 2>&1; then
  echo "Runner inherited a trusted scheduler secret" >&2
  exit 1
fi

network_output="$result_dir/network.txt"
if "${compose[@]}" "${sandbox[@]}" getent hosts example.com >"$network_output" 2>&1; then
  echo "Codex task network isolation canary failed" >&2
  exit 1
fi

echo "Runner identity, process, secret-mount, environment and network isolation canaries passed"
