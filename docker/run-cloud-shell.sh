#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IMAGE="${IMAGE:-chatgpt-adapter:cloud-shell}"
CONTAINER="${CONTAINER:-chatgpt-adapter}"
ACCOUNT_COUNT="${ACCOUNT_COUNT:-4}"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker volume inspect chatgpt-adapter-data >/dev/null 2>&1 || docker volume create chatgpt-adapter-data >/dev/null
for n in 1 2 3 4; do
  docker volume inspect "chatgpt-chrome-${n}" >/dev/null 2>&1 || docker volume create "chatgpt-chrome-${n}" >/dev/null
done
docker volume inspect chatgpt-openclaw >/dev/null 2>&1 || docker volume create chatgpt-openclaw >/dev/null

docker run --rm \
  --name "$CONTAINER" \
  --init \
  --shm-size=2g \
  -p "${PORT:-8318}:8318" \
  -e "ACCOUNT_COUNT=${ACCOUNT_COUNT}" \
  -e "HTTP_HOST=0.0.0.0" \
  -v chatgpt-adapter-data:/home/long/work/chatgpt-adapter/data \
  -v chatgpt-chrome-1:/home/long/.config/google-chrome-chatgpt \
  -v chatgpt-chrome-2:/home/long/.config/google-chrome-chatgpt-2 \
  -v chatgpt-chrome-3:/home/long/.config/google-chrome-chatgpt-3 \
  -v chatgpt-chrome-4:/home/long/.config/google-chrome-chatgpt-4 \
  -v chatgpt-openclaw:/home/long/.openclaw \
  "$IMAGE"
