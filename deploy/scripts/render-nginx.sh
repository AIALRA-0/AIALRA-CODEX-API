#!/usr/bin/env bash
set -euo pipefail

: "${ROUTER_HOST:?ROUTER_HOST is required}"
: "${ROUTER_TAILSCALE_IPV4:?ROUTER_TAILSCALE_IPV4 is required}"
: "${NGINX_TEMPLATE:?NGINX_TEMPLATE is required}"
: "${NGINX_OUTPUT:?NGINX_OUTPUT is required}"
: "${EDGE_PROOF_SNIPPET:?EDGE_PROOF_SNIPPET is required}"
: "${EDGE_PROXY_SECRET_FILE:?EDGE_PROXY_SECRET_FILE is required}"
: "${AUTH_ENDPOINTS_SNIPPET:?AUTH_ENDPOINTS_SNIPPET is required}"
: "${AUTH_PROTECT_SNIPPET:?AUTH_PROTECT_SNIPPET is required}"
: "${CHATGPT_BROWSER_CONTROL_IP:=10.253.240.10}"
: "${CHATGPT_BROWSER_CONTROL_IP_B:=10.253.240.11}"
: "${CHATGPT_BROWSER_CONTROL_IP_C:=10.253.240.12}"
: "${CHATGPT_BROWSER_CONTROL_IP_D:=10.253.240.13}"
: "${CHATGPT_CONTROL_SUBNET:=10.253.240.0/28}"

[[ "$ROUTER_HOST" =~ ^[a-z0-9.-]+$ ]] || { echo "Invalid router hostname" >&2; exit 1; }
python3 - "$ROUTER_TAILSCALE_IPV4" <<'PY'
import ipaddress, sys
address = ipaddress.ip_address(sys.argv[1])
if address not in ipaddress.ip_network("100.64.0.0/10"):
    raise SystemExit("ROUTER_TAILSCALE_IPV4 must be a Tailscale IPv4 address")
PY
python3 - "$CHATGPT_BROWSER_CONTROL_IP" "$CHATGPT_BROWSER_CONTROL_IP_B" "$CHATGPT_BROWSER_CONTROL_IP_C" "$CHATGPT_BROWSER_CONTROL_IP_D" "$CHATGPT_CONTROL_SUBNET" <<'PY'
import ipaddress, sys
network = ipaddress.ip_network(sys.argv[-1], strict=True)
addresses = [ipaddress.ip_address(value) for value in sys.argv[1:-1]]
if not network.is_private or any(address.version != 4 or address not in network for address in addresses):
    raise SystemExit("ChatGPT browser control IPs must be inside the private control subnet")
if len(set(addresses)) != len(addresses):
    raise SystemExit("ChatGPT browser control IPs must be unique")
if any(address in {network.network_address, network.broadcast_address, network.network_address + 1} for address in addresses):
    raise SystemExit("ChatGPT browser control IP uses a reserved subnet address")
PY
for source in "$NGINX_TEMPLATE" "$EDGE_PROXY_SECRET_FILE" "$AUTH_ENDPOINTS_SNIPPET" "$AUTH_PROTECT_SNIPPET"; do
  [[ -f "$source" ]] || { echo "Required file is missing: $source" >&2; exit 1; }
done

edge_secret="$(<"$EDGE_PROXY_SECRET_FILE")"
[[ "$edge_secret" =~ ^[A-Za-z0-9_-]{32,}$ ]] || { echo "Invalid edge proxy secret" >&2; exit 1; }

umask 077
proof_candidate="$(mktemp)"
nginx_candidate="$(mktemp)"
trap 'rm -f "$proof_candidate" "$nginx_candidate"' EXIT
printf 'proxy_set_header X-Aialra-Edge-Proof "%s";\n' "$edge_secret" >"$proof_candidate"
sed \
  -e "s|__ROUTER_HOST__|$ROUTER_HOST|g" \
  -e "s|__TAILSCALE_IPV4__|$ROUTER_TAILSCALE_IPV4|g" \
  -e "s|__AUTH_ENDPOINTS_SNIPPET__|$AUTH_ENDPOINTS_SNIPPET|g" \
  -e "s|__AUTH_PROTECT_SNIPPET__|$AUTH_PROTECT_SNIPPET|g" \
  -e "s|__EDGE_PROOF_SNIPPET__|$EDGE_PROOF_SNIPPET|g" \
  -e "s|__CHATGPT_BROWSER_CONTROL_IP__|$CHATGPT_BROWSER_CONTROL_IP|g" \
  -e "s|__CHATGPT_BROWSER_CONTROL_IP_B__|$CHATGPT_BROWSER_CONTROL_IP_B|g" \
  -e "s|__CHATGPT_BROWSER_CONTROL_IP_C__|$CHATGPT_BROWSER_CONTROL_IP_C|g" \
  -e "s|__CHATGPT_BROWSER_CONTROL_IP_D__|$CHATGPT_BROWSER_CONTROL_IP_D|g" \
  "$NGINX_TEMPLATE" >"$nginx_candidate"

install -o root -g root -m 0600 "$proof_candidate" "$EDGE_PROOF_SNIPPET"
install -o root -g root -m 0644 "$nginx_candidate" "$NGINX_OUTPUT"
