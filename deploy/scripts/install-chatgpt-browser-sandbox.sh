#!/usr/bin/env bash
set -euo pipefail

: "${APPARMOR_PROFILE_SOURCE:?APPARMOR_PROFILE_SOURCE is required}"
: "${SECCOMP_PROFILE_TARGET:=/etc/aialra-model-router/chromium-seccomp.json}"
: "${APPARMOR_PROFILE_TARGET:=/etc/apparmor.d/aialra-chatgpt-browser}"
: "${MOBY_SECCOMP_URL:=https://raw.githubusercontent.com/moby/profiles/61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31/seccomp/default.json}"

[[ "$EUID" -eq 0 ]] || { echo "Run this script as root" >&2; exit 1; }
command -v apparmor_parser >/dev/null 2>&1 || { echo "apparmor_parser is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

install -d -o root -g root -m 0755 "$(dirname "$SECCOMP_PROFILE_TARGET")"
install -o root -g root -m 0644 "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
apparmor_parser --replace "$APPARMOR_PROFILE_TARGET"
grep -q '^aialra-chatgpt-browser ' /sys/kernel/security/apparmor/profiles

temporary_profile="$(mktemp)"
trap 'rm -f "$temporary_profile"' EXIT
curl --fail --silent --show-error --location "$MOBY_SECCOMP_URL" |
  jq '.syscalls += [{"names":["chroot","clone","clone3","unshare"],"action":"SCMP_ACT_ALLOW"}]' >"$temporary_profile"
jq -e '.defaultAction and (.syscalls | length > 0)' "$temporary_profile" >/dev/null
install -o root -g root -m 0644 "$temporary_profile" "$SECCOMP_PROFILE_TARGET"

echo "ChatGPT browser AppArmor and seccomp profiles are installed"
