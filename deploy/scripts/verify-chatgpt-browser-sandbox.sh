#!/usr/bin/env bash
set -euo pipefail

: "${BROWSER_CONTAINER:?BROWSER_CONTAINER is required}"

docker inspect "$BROWSER_CONTAINER" >/dev/null
docker exec "$BROWSER_CONTAINER" unshare -Ur true

command_line="$(docker exec "$BROWSER_CONTAINER" sh -c \
  "for command_file in /proc/[0-9]*/cmdline; do tr '\000' ' ' <\"\$command_file\" 2>/dev/null || true; printf '\n'; done" |
  awk '/(^|\/)chromium([[:space:]]|$)/ && !seen { print; seen=1 }')"
[[ -n "$command_line" ]] || { echo "Chromium process is missing" >&2; exit 1; }
if grep -q -- '--no-sandbox' <<<"$command_line"; then
  echo "Chromium still uses --no-sandbox" >&2
  exit 1
fi

security_options="$(docker inspect "$BROWSER_CONTAINER" --format '{{json .HostConfig.SecurityOpt}}')"
grep -q 'no-new-privileges' <<<"$security_options"
grep -q 'aialra-chatgpt-browser' <<<"$security_options"
# Docker expands a file-backed seccomp profile into JSON in SecurityOpt, so the
# original host path is not available here. The in-container Seccomp status
# below is the reliable runtime check that the filter is active.
grep -q 'seccomp=' <<<"$security_options"

docker exec "$BROWSER_CONTAINER" sh -c \
  "grep -q '^NoNewPrivs:[[:space:]]*1' /proc/1/status && grep -q '^Seccomp:[[:space:]]*2' /proc/1/status"
docker exec "$BROWSER_CONTAINER" sh -c \
  "grep -q '^aialra-chatgpt-browser (enforce)' /proc/1/attr/current"

health="$(docker exec "$BROWSER_CONTAINER" node -e \
  "fetch('http://127.0.0.1:13216/healthz').then(async r=>process.stdout.write(JSON.stringify(await r.json())))")"
jq -e '.sandboxVerified == true and .extensionConnected == true and .pageReady == true and .authenticated == true' \
  <<<"$health" >/dev/null

echo "ChatGPT browser process and outer sandbox checks passed"
echo "Open chrome://sandbox in the protected visible browser and retain the administrator check record"
