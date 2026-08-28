#!/usr/bin/env bash
set -euo pipefail

# Required inputs are provided by the operator or a secret manager; no account data is stored here.
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ZONE_NAME:?Set CLOUDFLARE_ZONE_NAME}"
: "${ROUTER_HOST:?Set ROUTER_HOST}"
: "${ROUTER_TAILSCALE_IPV6:?Set ROUTER_TAILSCALE_IPV6}"

python3 - "$ROUTER_TAILSCALE_IPV6" <<'PY'
import ipaddress, sys
address = ipaddress.ip_address(sys.argv[1])
if address.version != 6 or not address.is_private:
    raise SystemExit("ROUTER_TAILSCALE_IPV6 must be a private Tailscale IPv6 address")
PY

api_base="https://api.cloudflare.com/client/v4"
auth_header="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

# Resolve the zone by its exact name so the script cannot modify another zone accidentally.
zone_response="$(curl --fail-with-body --silent --show-error \
  --get "${api_base}/zones" \
  --header "$auth_header" \
  --data-urlencode "name=${CLOUDFLARE_ZONE_NAME}" \
  --data-urlencode "status=active")"
zone_id="$(jq -r '.result | map(select(.name == env.CLOUDFLARE_ZONE_NAME)) | first | .id // empty' <<<"$zone_response")"
[[ -n "$zone_id" ]] || { echo "Cloudflare zone not found" >&2; exit 1; }

# Read the exact hostname before writing, which makes repeated deployments idempotent.
record_response="$(curl --fail-with-body --silent --show-error \
  --get "${api_base}/zones/${zone_id}/dns_records" \
  --header "$auth_header" \
  --data-urlencode "name=${ROUTER_HOST}")"
record_id="$(jq -r '.result | map(select(.type == "A" or .type == "AAAA" or .type == "CNAME")) | first | .id // empty' <<<"$record_response")"
payload="$(jq -cn \
  --arg type "AAAA" \
  --arg name "$ROUTER_HOST" \
  --arg content "$ROUTER_TAILSCALE_IPV6" \
  '{type:$type,name:$name,content:$content,ttl:60,proxied:false}')"

# Create a missing record or replace the existing exact record with the requested origin.
if [[ -n "$record_id" ]]; then
  curl --fail-with-body --silent --show-error \
    --request PUT "${api_base}/zones/${zone_id}/dns_records/${record_id}" \
    --header "$auth_header" \
    --header "Content-Type: application/json" \
    --data "$payload" \
    | jq -e 'if .success == true then {success, result: {id: .result.id, name: .result.name, type: .result.type, proxied: .result.proxied}} else error("Cloudflare DNS update failed") end'
else
  curl --fail-with-body --silent --show-error \
    --request POST "${api_base}/zones/${zone_id}/dns_records" \
    --header "$auth_header" \
    --header "Content-Type: application/json" \
    --data "$payload" \
    | jq -e 'if .success == true then {success, result: {id: .result.id, name: .result.name, type: .result.type, proxied: .result.proxied}} else error("Cloudflare DNS creation failed") end'
fi
