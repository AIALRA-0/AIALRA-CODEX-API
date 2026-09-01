#!/bin/sh
set -eu

runtime_dir=/run/aialra-chatgpt-bridge
extension_root=/run/aialra-chatgpt-extension
profile_dir=/opt/aialra-browser-home/.config/chromium
extension_enabled="${CHATGPT_BROWSER_EXTENSION_ENABLED:-true}"

extension_instance="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
extension_dir="$extension_root/$extension_instance"
unset extension_instance

mkdir -p \
  "$runtime_dir" \
  "$extension_dir" \
  "$profile_dir" \
  /opt/aialra-browser-home/.cache \
  /opt/aialra-browser-home/.local/share/pki/nssdb \
  /opt/aialra-browser-home/.vnc \
  /opt/aialra-browser-home/Downloads
chmod 0700 \
  "$runtime_dir" \
  "$extension_root" \
  "$extension_dir" \
  "$profile_dir" \
  /opt/aialra-browser-home/.cache \
  /opt/aialra-browser-home/.local \
  /opt/aialra-browser-home/.vnc
rm -f "$profile_dir/SingletonCookie" "$profile_dir/SingletonLock" "$profile_dir/SingletonSocket"
extension_token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s' "$extension_token" > "$runtime_dir/extension-token"
chmod 0600 "$runtime_dir/extension-token"

chromium_extension_flags=""
if [ "$extension_enabled" = "true" ]; then
  cp -R /opt/aialra/chatgpt-extension/. "$extension_dir/"
  chmod u+w "$extension_dir/runtime-config.js"
  printf 'export const BRIDGE_TOKEN = "%s";\n' "$extension_token" > "$extension_dir/runtime-config.js"
  chmod 0600 "$extension_dir/runtime-config.js"
  chromium_extension_flags="--disable-extensions-except=$extension_dir --load-extension=$extension_dir"
elif [ "$extension_enabled" != "false" ]; then
  echo "CHATGPT_BROWSER_EXTENSION_ENABLED must be true or false" >&2
  exit 1
fi
unset extension_token

[ -r /run/secrets/chatgpt_vnc_password ] || {
  echo "VNC password secret is unavailable" >&2
  exit 1
}
vnc_password="$(cat /run/secrets/chatgpt_vnc_password)"
x11vnc -storepasswd "$vnc_password" /opt/aialra-browser-home/.vnc/passwd >/dev/null
chmod 0600 /opt/aialra-browser-home/.vnc/passwd
unset vnc_password

export DISPLAY=:99
export CHATGPT_EXTENSION_TOKEN_FILE="$runtime_dir/extension-token"

chromium_sandbox_flag=""
if [ "${CHATGPT_CHROMIUM_NO_SANDBOX:-false}" = "true" ]; then
  chromium_sandbox_flag="--no-sandbox"
fi

if [ -z "$chromium_sandbox_flag" ] && unshare -Ur true; then
  export CHATGPT_CHROMIUM_SANDBOX_VERIFIED=true
else
  export CHATGPT_CHROMIUM_SANDBOX_VERIFIED=false
fi

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
xvfb_pid=$!

# Xvfb creates its display socket asynchronously. Starting the window manager or
# x11vnc before that socket exists makes both processes exit while the bridge
# health endpoint continues to look healthy.
x_display_ready=false
attempt=0
while [ "$attempt" -lt 100 ]; do
  if [ -S /tmp/.X11-unix/X99 ]; then
    x_display_ready=true
    break
  fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "Xvfb exited before the display became ready" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
unset attempt

if [ "$x_display_ready" != "true" ]; then
  echo "Timed out waiting for the X display" >&2
  exit 1
fi
unset x_display_ready

openbox-session >/tmp/openbox.log 2>&1 &
openbox_pid=$!
x11vnc -display :99 -localhost -forever -shared -rfbauth /opt/aialra-browser-home/.vnc/passwd >/tmp/x11vnc.log 2>&1 &
vnc_pid=$!
websockify --web=/usr/share/novnc/ 0.0.0.0:6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 &
novnc_pid=$!

chromium \
  --user-data-dir="$profile_dir" \
  --disable-default-apps \
  --disable-features=Translate \
  $chromium_sandbox_flag \
  --proxy-server=http://chatgpt-egress-proxy:3128 \
  --proxy-bypass-list="127.0.0.1;[::1]" \
  $chromium_extension_flags \
  --no-first-run \
  --no-default-browser-check \
  https://chatgpt.com/ >/tmp/chromium.log 2>&1 &
chrome_pid=$!

node /app/apps/chatgpt-bridge/dist/main.js &
bridge_pid=$!

cleanup() {
  kill "$bridge_pid" "$chrome_pid" "$novnc_pid" "$vnc_pid" "$openbox_pid" "$xvfb_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

while :; do
  for supervised_process in \
    "bridge:$bridge_pid" \
    "chromium:$chrome_pid" \
    "websockify:$novnc_pid" \
    "x11vnc:$vnc_pid" \
    "openbox:$openbox_pid" \
    "xvfb:$xvfb_pid"; do
    supervised_name="${supervised_process%%:*}"
    supervised_pid="${supervised_process#*:}"
    if ! kill -0 "$supervised_pid" 2>/dev/null; then
      echo "Required browser desktop process exited: $supervised_name" >&2
      exit 1
    fi
  done
  sleep 2
done
