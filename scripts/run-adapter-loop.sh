#!/usr/bin/env bash
# run-adapter-loop.sh — Robust self-healing daemon for ChatGPT Web Adapter
ADAPTER_DIR="/home/long/work/chatgpt-adapter"
cd "$ADAPTER_DIR"

while true; do
  echo "[$(date -Iseconds)] [Daemon] Starting ChatGPT Web Adapter..." >> adapter.log
  node server.js >> adapter.log 2>&1
  EXIT_CODE=$?
  echo "[$(date -Iseconds)] [Daemon] Adapter exited with code $EXIT_CODE. Restarting in 3 seconds..." >> adapter.log
  sleep 3
done
