#!/usr/bin/env bash
set -euo pipefail

: "${ROUTER_HOST:?ROUTER_HOST is required}"
: "${ROUTER_STATE_DIR:=/var/lib/aialra-model-router}"
: "${ROUTER_USER:=aialra-router}"

[[ "$EUID" -eq 0 ]] || { echo "Run this script as root" >&2; exit 1; }
[[ "$ROUTER_HOST" =~ ^[a-z0-9.-]+$ ]] || { echo "Invalid router hostname" >&2; exit 1; }
id "$ROUTER_USER" >/dev/null 2>&1 || { echo "Dedicated router user does not exist" >&2; exit 1; }

secret_dir="$ROUTER_STATE_DIR/secrets"
codex_dir="$ROUTER_STATE_DIR/codex"
environment_file="$ROUTER_STATE_DIR/production.env"
install -d -o root -g "$ROUTER_USER" -m 0710 "$secret_dir"
install -d -o "$ROUTER_USER" -g "$ROUTER_USER" -m 0700 "$codex_dir"

write_secret_once() {
  local name="$1"
  local value="$2"
  local target="$secret_dir/$name"
  if [[ ! -e "$target" ]]; then
    printf '%s' "$value" >"$target"
  fi
  chown root:"$ROUTER_USER" "$target"
  chmod 0640 "$target"
}

database_password="$(openssl rand -base64 36 | tr -d '\n/+=' | head -c 48)"
write_secret_once postgres_password "$database_password"
database_password="$(<"$secret_dir/postgres_password")"
write_secret_once database_url "postgresql://router:${database_password}@postgres:5432/router"
write_secret_once payload_master_key "$(openssl rand -base64 32 | tr -d '\n')"
write_secret_once api_key_pepper "$(openssl rand -base64 48 | tr -d '\n')"
write_secret_once session_pepper "$(openssl rand -base64 48 | tr -d '\n')"
write_secret_once bootstrap_admin_token "$(openssl rand -base64 32 | tr -d '\n')"
write_secret_once internal_proxy_secret "$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 64)"
write_secret_once edge_proxy_secret "$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 64)"
write_secret_once runner_api_token "$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 64)"
write_secret_once chatgpt_bridge_api_token "$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 64)"
write_secret_once chatgpt_web_diagnostic_token "$(openssl rand -base64 48 | tr -d '\n/+=' | head -c 64)"
write_secret_once chatgpt_vnc_password "$(openssl rand -base64 24 | tr -d '\n/+=' | head -c 24)"

router_uid="$(id -u "$ROUTER_USER")"
router_gid="$(id -g "$ROUTER_USER")"
umask 077
cat >"$environment_file" <<EOF
SECRETS_DIR=$secret_dir
CODEX_AUTH_DIR=$codex_dir
ROUTER_UID=$router_uid
ROUTER_GID=$router_gid
CODEX_MAX_CONCURRENCY=1
AUTH_MODE=authentik
AUTHENTIK_TRUST_PROXY=true
AUTHENTIK_REQUIRED_GROUP=aialra:access:model-router
JOB_SUBMISSION_ENABLED=false
CHATGPT_WEB_ADAPTER_ENABLED=false
CHATGPT_WEB_DIAGNOSTIC_ENABLED=false
CHATGPT_WEB_MAX_CONCURRENCY=1
CHATGPT_CHROMIUM_NO_SANDBOX=false
CHATGPT_BROWSER_SECCOMP_PROFILE=/etc/aialra-model-router/chromium-seccomp.json
CHATGPT_BROWSER_CONTROL_IP=10.253.240.2
CHATGPT_CONTROL_SUBNET=10.253.240.0/28
CHATGPT_PROXY_SUBNET=10.253.240.16/28
CHATGPT_EGRESS_SUBNET=10.253.240.32/28
WEBAUTHN_RP_ID=$ROUTER_HOST
WEBAUTHN_ORIGIN=https://$ROUTER_HOST
SESSION_COOKIE_SECURE=true
EOF

echo "Production secrets and environment are ready"
echo "Codex jobs remain disabled until the dedicated login and isolation canary pass"
echo "The ChatGPT web experiment remains disabled until the visible-browser probe passes"
