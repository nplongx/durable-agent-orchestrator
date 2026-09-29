#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=/home/long/work/chatgpt-adapter
DISPLAY="${VIRTUAL_DISPLAY:-:99}"
export DISPLAY

cleanup() {
  trap - TERM INT EXIT
  [[ -n "${ADAPTER_PID:-}" ]] && kill "${ADAPTER_PID}" 2>/dev/null || true
  for pid in ${CHROME_PIDS:-}; do kill "$pid" 2>/dev/null || true; done
  [[ -n "${XVFB_PID:-}" ]] && kill "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup TERM INT EXIT

echo "[container] Node: $(node --version)"
echo "[container] Chrome: $(google-chrome --version)"
echo "[container] OpenClaw: $(openclaw --version 2>/dev/null || true)"

if ! xdpyinfo >/dev/null 2>&1; then
  display_num="${DISPLAY#:}"
  rm -f "/tmp/.X${display_num}-lock" "/tmp/.X11-unix/X${display_num}"
  echo "[container] Starting Xvfb on ${DISPLAY}"
  Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/chatgpt-xvfb.log 2>&1 &
  XVFB_PID=$!
  for _ in {1..30}; do
    xdpyinfo >/dev/null 2>&1 && break
    sleep 0.2
  done
  xdpyinfo >/dev/null 2>&1 || { cat /tmp/chatgpt-xvfb.log; exit 1; }
fi

ACCOUNT_COUNT="${ACCOUNT_COUNT:-4}"
if ! [[ "$ACCOUNT_COUNT" =~ ^[1-4]$ ]]; then
  echo "ACCOUNT_COUNT must be 1, 2, 3, or 4" >&2
  exit 2
fi

for account in $(seq 1 "$ACCOUNT_COUNT"); do
  port=$((9020 + account))
  if curl -fsS --connect-timeout 1 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
    continue
  fi
  case "$account" in
    1) profile=/home/long/.config/google-chrome-chatgpt ;;
    2) profile=/home/long/.config/google-chrome-chatgpt-2 ;;
    3) profile=/home/long/.config/google-chrome-chatgpt-3 ;;
    4) profile=/home/long/.config/google-chrome-chatgpt-4 ;;
  esac
  mkdir -p "$profile"
  echo "[container] Starting Chrome account ${account} on CDP ${port}"
  google-chrome \
    --ozone-platform=x11 \
    --no-sandbox \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="${port}" \
    --user-data-dir="${profile}" \
    --no-first-run \
    --no-default-browser-check \
    --disable-background-networking \
    --disable-component-update \
    --disable-domain-reliability \
    --disable-sync \
    --mute-audio \
    --disable-dev-shm-usage \
    --disable-gpu \
    --disable-gpu-compositing \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --js-flags="--max-old-space-size=1024" \
    --window-size=1920,1080 \
    https://chatgpt.com/ >/tmp/chatgpt-chrome-${account}.log 2>&1 &
  CHROME_PIDS="${CHROME_PIDS:-} $!"
done

cd "$APP_DIR"
echo "[container] Starting adapter on :${PORT}"
node server.js >>/tmp/chatgpt-adapter/server.log 2>&1 &
ADAPTER_PID=$!

for _ in {1..60}; do
  if curl -fsS --connect-timeout 1 "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
    echo "[container] Adapter ready: :${PORT}"
    break
  fi
  if ! kill -0 "$ADAPTER_PID" 2>/dev/null; then
    cat /tmp/chatgpt-adapter/server.log
    exit 1
  fi
  sleep 0.5
done

curl -fsS --connect-timeout 2 "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1 || {
  echo "[container] Adapter failed readiness check" >&2
  cat /tmp/chatgpt-adapter/server.log >&2
  exit 1
}

wait "$ADAPTER_PID"
