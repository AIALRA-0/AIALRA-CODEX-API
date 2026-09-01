#!/usr/bin/env bash
set -euo pipefail

: "${PRODUCTION_ENV:?PRODUCTION_ENV is required}"

[[ "$EUID" -eq 0 ]] || { echo "Run this script as root" >&2; exit 1; }

compose=(docker compose --env-file "$PRODUCTION_ENV" --file deploy/compose.yaml --profile codex)
runner_id=""
for _ in $(seq 1 60); do
  runner_id="$("${compose[@]}" ps --quiet runner)"
  [[ -n "$runner_id" ]] && break
  sleep 2
done
[[ -n "$runner_id" ]] || { echo "Start the Runner container before installing egress rules" >&2; exit 1; }
runner_pid="$(docker inspect --format '{{.State.Pid}}' "$runner_id")"
[[ "$runner_pid" -gt 0 ]] || { echo "Start the Runner container before installing egress rules" >&2; exit 1; }

mapfile -t runner_addresses < <(
  docker inspect --format '{{range $network, $value := .NetworkSettings.Networks}}{{println $value.IPAddress}}{{end}}' "$runner_id" |
    sed '/^$/d'
)
[[ "${#runner_addresses[@]}" -ge 2 ]] || {
  echo "Runner network addresses are incomplete" >&2
  exit 1
}

chain="AIALRA_CODEX_EGRESS"
iptables -N "$chain" 2>/dev/null || true
iptables -F "$chain"

blocked=(
  0.0.0.0/8
  10.0.0.0/8
  100.64.0.0/10
  127.0.0.0/8
  169.254.0.0/16
  172.16.0.0/12
  192.0.0.0/24
  192.0.2.0/24
  192.168.0.0/16
  198.18.0.0/15
  198.51.100.0/24
  203.0.113.0/24
  224.0.0.0/4
  240.0.0.0/4
)

for destination in "${blocked[@]}"; do
  nsenter --target "$runner_pid" --net ip route replace prohibit "$destination" metric 1
done

for source in "${runner_addresses[@]}"; do
  for destination in "${blocked[@]}"; do
    iptables -A "$chain" -s "$source/32" -d "$destination" -j REJECT
  done
done
iptables -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A "$chain" -j RETURN

iptables -C DOCKER-USER -j "$chain" 2>/dev/null || iptables -I DOCKER-USER 1 -j "$chain"
iptables -C INPUT -j "$chain" 2>/dev/null || iptables -I INPUT 1 -j "$chain"
echo "Runner egress policy installed for ${runner_addresses[*]}"
