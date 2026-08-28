#!/usr/bin/env bash
set -euo pipefail

: "${APPARMOR_PROFILE_SOURCE:?APPARMOR_PROFILE_SOURCE is required}"
: "${APPARMOR_PROFILE_TARGET:=/etc/apparmor.d/aialra-codex-worker}"

[[ "$EUID" -eq 0 ]] || { echo "Run this script as root" >&2; exit 1; }
[[ -f "$APPARMOR_PROFILE_SOURCE" ]] || { echo "AppArmor profile source is missing" >&2; exit 1; }
command -v apparmor_parser >/dev/null 2>&1 || { echo "apparmor_parser is required" >&2; exit 1; }

install -o root -g root -m 0644 "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
apparmor_parser --replace "$APPARMOR_PROFILE_TARGET"
grep -q '^aialra-codex-worker ' /sys/kernel/security/apparmor/profiles
echo "Worker AppArmor user-namespace profile is loaded"
