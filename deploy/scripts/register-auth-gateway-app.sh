#!/usr/bin/env bash
set -euo pipefail

# This helper updates an AIALRA Authentik-backed gateway inventory without embedding deployment paths.
: "${AUTH_GATEWAY_APPS_FILE:?Set AUTH_GATEWAY_APPS_FILE}"
: "${AUTH_GATEWAY_SERVICE:?Set AUTH_GATEWAY_SERVICE}"
: "${AUTH_GATEWAY_ENV_FILE:?Set AUTH_GATEWAY_ENV_FILE}"
: "${AUTHENTIK_SERVER_CONTAINER:?Set AUTHENTIK_SERVER_CONTAINER}"
: "${ROUTER_HOST:?Set ROUTER_HOST}"

router_name="${ROUTER_NAME:-AIALRA Model Router}"
router_slug="${ROUTER_SLUG:-model-router}"
router_style="${ROUTER_STYLE:-simple}"

[[ -f "$AUTH_GATEWAY_APPS_FILE" ]] || { echo "Auth gateway inventory not found" >&2; exit 1; }
[[ -f "$AUTH_GATEWAY_ENV_FILE" ]] || { echo "Auth gateway environment file not found" >&2; exit 1; }
[[ "$AUTHENTIK_SERVER_CONTAINER" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Invalid Authentik container name" >&2; exit 1; }
backup="${AUTH_GATEWAY_APPS_FILE}.before-model-router.$(date -u +%Y%m%dT%H%M%SZ)"
cp --preserve=mode,ownership,timestamps "$AUTH_GATEWAY_APPS_FILE" "$backup"

temporary="$(mktemp "${AUTH_GATEWAY_APPS_FILE}.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
jq \
  --arg host "$ROUTER_HOST" \
  --arg name "$router_name" \
  --arg slug "$router_slug" \
  --arg style "$router_style" \
  '.[$host] = {name:$name, slug:$slug, style:$style}' \
  "$AUTH_GATEWAY_APPS_FILE" >"$temporary"
jq -e --arg host "$ROUTER_HOST" '.[$host].slug | length > 0' "$temporary" >/dev/null
install --mode="$(stat -c '%a' "$AUTH_GATEWAY_APPS_FILE")" \
  --owner="$(stat -c '%u' "$AUTH_GATEWAY_APPS_FILE")" \
  --group="$(stat -c '%g' "$AUTH_GATEWAY_APPS_FILE")" \
  "$temporary" "$AUTH_GATEWAY_APPS_FILE"
if ! systemctl restart "$AUTH_GATEWAY_SERVICE" || ! systemctl is-active --quiet "$AUTH_GATEWAY_SERVICE"; then
  echo "Auth gateway restart failed; restoring the previous inventory" >&2
  cp --preserve=mode,ownership,timestamps "$backup" "$AUTH_GATEWAY_APPS_FILE"
  systemctl restart "$AUTH_GATEWAY_SERVICE" || true
  exit 1
fi

authentik_client_id="$(sed -n 's/^AUTHENTIK_CLIENT_ID=//p' "$AUTH_GATEWAY_ENV_FILE")"
[[ -n "$authentik_client_id" ]] || {
  echo "Authentik client ID is missing" >&2
  cp --preserve=mode,ownership,timestamps "$backup" "$AUTH_GATEWAY_APPS_FILE"
  systemctl restart "$AUTH_GATEWAY_SERVICE" || true
  exit 1
}

export AIALRA_GATEWAY_CLIENT_ID="$authentik_client_id"
export AIALRA_GATEWAY_CALLBACK="https://${ROUTER_HOST}/_aialra_auth/callback"
if ! registration_output="$(docker exec \
  -e AIALRA_GATEWAY_CLIENT_ID \
  -e AIALRA_GATEWAY_CALLBACK \
  "$AUTHENTIK_SERVER_CONTAINER" \
  ak shell -c '
import os
from authentik.providers.oauth2.models import (
    OAuth2Provider,
    RedirectURI,
    RedirectURIMatchingMode,
    RedirectURIType,
)

provider = OAuth2Provider.objects.get(client_id=os.environ["AIALRA_GATEWAY_CLIENT_ID"])
target = os.environ["AIALRA_GATEWAY_CALLBACK"]
if not any(item.url == target for item in provider.redirect_uris):
    provider.redirect_uris = [
        *provider.redirect_uris,
        RedirectURI(
            RedirectURIMatchingMode.STRICT,
            target,
            RedirectURIType.AUTHORIZATION,
        ),
    ]
    provider.save()
provider.refresh_from_db()
print("CALLBACK_REGISTERED=" + str(any(
    item.url == target and item.matching_mode == RedirectURIMatchingMode.STRICT
    for item in provider.redirect_uris
)))
' 2>&1)" || [[ "$registration_output" != *"CALLBACK_REGISTERED=True"* ]]; then
  unset AIALRA_GATEWAY_CLIENT_ID AIALRA_GATEWAY_CALLBACK
  echo "Authentik callback registration failed; restoring the previous inventory" >&2
  cp --preserve=mode,ownership,timestamps "$backup" "$AUTH_GATEWAY_APPS_FILE"
  systemctl restart "$AUTH_GATEWAY_SERVICE" || true
  exit 1
fi
unset AIALRA_GATEWAY_CLIENT_ID AIALRA_GATEWAY_CALLBACK authentik_client_id registration_output
echo "Auth gateway application registered; backup: $backup"
