#!/usr/bin/env bash
set -euo pipefail

# Prepare only this project's directories. Existing Nginx, Docker and other services are untouched.
ROUTER_INSTALL_DIR="${ROUTER_INSTALL_DIR:-/opt/aialra-model-router}"
ROUTER_STATE_DIR="${ROUTER_STATE_DIR:-/var/lib/aialra-model-router}"

sudo apt-get update
sudo apt-get install --yes curl ca-certificates jq age postgresql-client apparmor apparmor-utils

# Create a dedicated system account and bounded project directories.
if ! id aialra-router >/dev/null 2>&1; then
  sudo useradd --create-home --shell /bin/bash aialra-router
fi
sudo install -d -o aialra-router -g aialra-router -m 0700 "$ROUTER_INSTALL_DIR"
sudo install -d -o aialra-router -g aialra-router -m 0700 "$ROUTER_STATE_DIR"
sudo install -d -o aialra-router -g aialra-router -m 0700 \
  "$ROUTER_STATE_DIR/codex" \
  "$ROUTER_STATE_DIR/jobs" \
  "$ROUTER_STATE_DIR/secrets" \
  "$ROUTER_STATE_DIR/backups"

echo "VPS directories are ready"
echo "Next: complete a dedicated Codex login as aialra-router before enabling the codex profile"
