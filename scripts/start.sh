#!/usr/bin/env bash
# start.sh — Launch Chrome CDP for 4 Accounts (9021-9024) and ChatGPT Web Adapter 8318

set -e

ADAPTER_PORT=8318
VIRTUAL_DISPLAY=":99"
XVFB_BIN="/home/long/.local/bin/Xvfb"
ADAPTER_DIR="/home/long/work/chatgpt-adapter"
TARGET_URL="https://chatgpt.com/"

echo "=== [ChatGPT Web Multi-Account Bridge Starter] ==="

# 0. Check Virtual Display (Xvfb)
if DISPLAY="${VIRTUAL_DISPLAY}" xdpyinfo >/dev/null 2>&1; then
  echo "✓ Virtual display ${VIRTUAL_DISPLAY} is active."
else
  echo "→ Starting Xvfb on display ${VIRTUAL_DISPLAY}..."
  nohup "${XVFB_BIN}" "${VIRTUAL_DISPLAY}" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/dev/null 2>&1 &
  sleep 1
fi

start_chrome_account() {
  local ACC_ID="$1"
  local PORT="$2"
  local DATA_DIR="$3"

  if curl -s --connect-timeout 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "✓ Account ${ACC_ID} (CDP Port ${PORT}) is already running."
  else
    echo "→ Starting Account ${ACC_ID} on CDP Port ${PORT} (Profile: ${DATA_DIR})..."
    mkdir -p "${DATA_DIR}"
    env -u WAYLAND_DISPLAY DISPLAY="${VIRTUAL_DISPLAY}" nohup google-chrome \
      --ozone-platform=x11 \
      --no-sandbox \
      --remote-debugging-port="${PORT}" \
      --user-data-dir="${DATA_DIR}" \
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
      --window-position=0,0 \
      "${TARGET_URL}" >/dev/null 2>&1 &

    for i in {1..15}; do
      if curl -s --connect-timeout 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
        echo "✓ Account ${ACC_ID} CDP is online on port ${PORT}!"
        break
      fi
      sleep 0.5
    done
  fi
}

# 1. Start Chrome for configured accounts
start_chrome_account 1 9021 "/home/long/.config/google-chrome-chatgpt"
start_chrome_account 2 9022 "/home/long/.config/google-chrome-chatgpt-2"
start_chrome_account 3 9023 "/home/long/.config/google-chrome-chatgpt-3"
start_chrome_account 4 9024 "/home/long/.config/google-chrome-chatgpt-4"

# 2. Check & Start ChatGPT Adapter 8318
if curl -s --connect-timeout 2 "http://127.0.0.1:${ADAPTER_PORT}/v1/models" >/dev/null 2>&1; then
  echo "✓ ChatGPT Adapter is already running on port ${ADAPTER_PORT}"
else
  echo "→ Starting ChatGPT Multi-Account Adapter on port ${ADAPTER_PORT}..."
  cd "${ADAPTER_DIR}"
  nohup node server.js > /tmp/chatgpt-adapter.log 2>&1 &
  
  for i in {1..20}; do
    if curl -s --connect-timeout 1 "http://127.0.0.1:${ADAPTER_PORT}/v1/models" >/dev/null 2>&1; then
      echo "✓ ChatGPT Multi-Account Adapter is ready on port ${ADAPTER_PORT}!"
      break
    fi
    sleep 0.5
  done
fi

echo "=== [All services online] ==="
