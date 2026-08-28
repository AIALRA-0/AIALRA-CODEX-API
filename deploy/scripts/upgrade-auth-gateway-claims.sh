#!/usr/bin/env bash
set -euo pipefail

: "${AUTH_GATEWAY_SOURCE:?AUTH_GATEWAY_SOURCE is required}"
: "${AUTH_GATEWAY_SERVICE:?AUTH_GATEWAY_SERVICE is required}"
: "${AUTH_PROTECT_SNIPPET:?AUTH_PROTECT_SNIPPET is required}"
: "${AUTH_IDENTITY_SNIPPET:?AUTH_IDENTITY_SNIPPET is required}"

[[ "$EUID" -eq 0 ]] || { echo "Run this script as root" >&2; exit 1; }
for target in "$AUTH_GATEWAY_SOURCE" "$AUTH_PROTECT_SNIPPET" "$AUTH_IDENTITY_SNIPPET"; do
  [[ -f "$target" ]] || { echo "Required file is missing: $target" >&2; exit 1; }
done

backup_dir="$(mktemp -d /var/tmp/aialra-auth-claims.XXXXXX)"
trap 'rm -rf "$backup_dir"' EXIT
cp --preserve=mode,ownership,timestamps "$AUTH_GATEWAY_SOURCE" "$backup_dir/gateway"
cp --preserve=mode,ownership,timestamps "$AUTH_PROTECT_SNIPPET" "$backup_dir/protect"
cp --preserve=mode,ownership,timestamps "$AUTH_IDENTITY_SNIPPET" "$backup_dir/identity"

python3 - "$AUTH_GATEWAY_SOURCE" "$AUTH_PROTECT_SNIPPET" "$AUTH_IDENTITY_SNIPPET" <<'PY'
from pathlib import Path
import os, sys, tempfile

def replace_once(path, before, after):
    target = Path(path)
    source = target.read_text()
    if after in source:
        return
    if source.count(before) != 1:
        raise SystemExit(f"Expected one upgrade marker in {target}")
    rendered = source.replace(before, after)
    stat = target.stat()
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    try:
        os.write(fd, rendered.encode())
        os.close(fd)
        os.chmod(temporary, stat.st_mode)
        os.chown(temporary, stat.st_uid, stat.st_gid)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

replace_once(
    sys.argv[1],
    "      'X-Aialra-Groups': groupsHeader.length <= 4096 ? groupsHeader : '',\n      'X-Aialra-Authenticated': '1'",
    "      'X-Aialra-Groups': groupsHeader.length <= 4096 ? groupsHeader : '',\n      'X-Aialra-Auth-Time': new Date(session.row.created_at * 1000).toISOString(),\n      'X-Aialra-Authenticated': '1'",
)
replace_once(
    sys.argv[2],
    "auth_request_set $aialra_identity_groups $upstream_http_x_aialra_groups;",
    "auth_request_set $aialra_identity_groups $upstream_http_x_aialra_groups;\nauth_request_set $aialra_identity_auth_time $upstream_http_x_aialra_auth_time;",
)
replace_once(
    sys.argv[2],
    "proxy_set_header X-Aialra-Groups $aialra_identity_groups;",
    "proxy_set_header X-Aialra-Groups $aialra_identity_groups;\nproxy_set_header X-Aialra-Auth-Time $aialra_identity_auth_time;",
)
replace_once(
    sys.argv[3],
    "proxy_set_header X-Aialra-Groups $aialra_identity_groups;",
    "proxy_set_header X-Aialra-Groups $aialra_identity_groups;\nproxy_set_header X-Aialra-Auth-Time $aialra_identity_auth_time;",
)
PY

if ! node --check "$AUTH_GATEWAY_SOURCE" || ! nginx -t; then
  cp --preserve=mode,ownership,timestamps "$backup_dir/gateway" "$AUTH_GATEWAY_SOURCE"
  cp --preserve=mode,ownership,timestamps "$backup_dir/protect" "$AUTH_PROTECT_SNIPPET"
  cp --preserve=mode,ownership,timestamps "$backup_dir/identity" "$AUTH_IDENTITY_SNIPPET"
  echo "Claim upgrade validation failed and was rolled back" >&2
  exit 1
fi
if ! systemctl restart "$AUTH_GATEWAY_SERVICE" || ! systemctl is-active --quiet "$AUTH_GATEWAY_SERVICE"; then
  cp --preserve=mode,ownership,timestamps "$backup_dir/gateway" "$AUTH_GATEWAY_SOURCE"
  cp --preserve=mode,ownership,timestamps "$backup_dir/protect" "$AUTH_PROTECT_SNIPPET"
  cp --preserve=mode,ownership,timestamps "$backup_dir/identity" "$AUTH_IDENTITY_SNIPPET"
  systemctl restart "$AUTH_GATEWAY_SERVICE" || true
  echo "Claim upgrade restart failed and was rolled back" >&2
  exit 1
fi
systemctl reload nginx
echo "Authentik group and authentication-time claims are available to protected applications"
