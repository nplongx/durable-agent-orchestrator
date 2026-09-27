#!/usr/bin/env bash
# watchdog.sh — Healthcheck & Auto-recovery for ChatGPT Adapter (Port 8318) and Chrome CDP (Port 9021)

ADAPTER_DIR="/home/long/work/chatgpt-adapter"
LOCK_FILE="/tmp/chatgpt-watchdog.lock"

# Prevent concurrent watchdog runs
exec 200>"$LOCK_FILE"
flock -n 200 || exit 0

check_and_recover() {
  local HEALTH_OK=0
  if curl -s --connect-timeout 2 http://127.0.0.1:8318/health >/dev/null 2>&1; then
    HEALTH_OK=1
  fi

  if [ "$HEALTH_OK" -eq 1 ]; then
    exit 0
  fi

  echo "[$(date -Iseconds)] [Watchdog] Port 8318 is not responding! Initiating restart..." >> "$ADAPTER_DIR/adapter.log"
  
  # 1. Kill stale adapter node process if any
  pkill -f "node server.js" 2>/dev/null || true
  sleep 1

  # 2. Check Virtual Display (:99)
  if ! DISPLAY=":99" xdpyinfo >/dev/null 2>&1; then
    nohup /home/long/.local/bin/Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/dev/null 2>&1 &
    sleep 1
  fi

  # 3. Check Account 1 Chrome CDP (Port 9021)
  if ! curl -s --connect-timeout 1 http://127.0.0.1:9021/json/version >/dev/null 2>&1; then
    DISPLAY=":99" nohup google-chrome \
      --ozone-platform=x11 \
      --no-sandbox \
      --remote-debugging-port=9021 \
      --user-data-dir=/home/long/.config/google-chrome-chatgpt \
      --no-first-run \
      --no-default-browser-check \
      --mute-audio \
      --disable-dev-shm-usage \
      --disable-gpu \
      https://chatgpt.com/ >/dev/null 2>&1 &
    sleep 3
  fi

  # 4. Start ChatGPT adapter server
  cd "$ADAPTER_DIR"
  nohup node server.js >> "$ADAPTER_DIR/adapter.log" 2>&1 &
  sleep 2

  if curl -s --connect-timeout 2 http://127.0.0.1:8318/v1/models >/dev/null 2>&1; then
    echo "[$(date -Iseconds)] [Watchdog] Adapter successfully recovered on port 8318." >> "$ADAPTER_DIR/adapter.log"
  else
    echo "[$(date -Iseconds)] [Watchdog] Failed to recover adapter." >> "$ADAPTER_DIR/adapter.log"
  fi
}

check_and_recover
