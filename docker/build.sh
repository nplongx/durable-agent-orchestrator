#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
IMAGE="${IMAGE:-chatgpt-adapter:cloud-shell}"
docker build -t "$IMAGE" .
echo "Built $IMAGE"

