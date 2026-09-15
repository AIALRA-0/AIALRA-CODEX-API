#!/usr/bin/env bash

# Source this file from every command that builds, recreates, or switches the
# production release. The open file descriptor keeps the lock for the caller's
# entire lifetime, including child docker processes.
acquire_aialra_deploy_lock() {
  [[ "${AIALRA_DEPLOY_LOCK_HELD:-false}" != "true" ]] || return 0
  command -v flock >/dev/null 2>&1 || {
    echo "flock is required for production build and deployment operations" >&2
    return 1
  }

  local lock_file="${AIALRA_DEPLOY_LOCK_FILE:-/run/lock/aialra-model-router-deploy.lock}"
  local owner_file="${lock_file}.owner"
  local lock_directory
  lock_directory="$(dirname "$lock_file")"
  [[ -d "$lock_directory" ]] || install -d -m 0755 "$lock_directory"
  exec {AIALRA_DEPLOY_LOCK_FD}>"$lock_file"
  if ! flock -n "$AIALRA_DEPLOY_LOCK_FD"; then
    echo "Another Model Router build or deployment owns ${lock_file}" >&2
    [[ -r "$owner_file" ]] && sed -n '1,8p' "$owner_file" >&2
    return 1
  fi

  local previous_umask
  previous_umask="$(umask)"
  umask 077
  printf 'pid=%s\noperation=%s\nrelease=%s\nstarted_at=%s\n' \
    "$$" \
    "${AIALRA_DEPLOY_OPERATION:-unspecified}" \
    "${RELEASE_DIR:-unspecified}" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$owner_file"
  umask "$previous_umask"
  export AIALRA_DEPLOY_LOCK_HELD=true
  trap 'rm -f -- "${AIALRA_DEPLOY_LOCK_FILE:-/run/lock/aialra-model-router-deploy.lock}.owner"' EXIT
}
