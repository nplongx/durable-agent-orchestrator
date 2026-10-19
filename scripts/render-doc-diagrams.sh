#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ARCHIFY_BIN="${ARCHIFY_BIN:-$(command -v archify || true)}"
if [[ -z "$ARCHIFY_BIN" || ! -f "$ARCHIFY_BIN" ]]; then
  echo "Set ARCHIFY_BIN to the installed Archify CLI entrypoint (bin/archify.mjs)." >&2
  exit 2
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RECEIPTS="docs/diagrams/receipts/$RUN_ID"
mkdir -p "$RECEIPTS"

render_one() {
  local type="$1" stem="$2"
  local source="docs/diagrams/source/$stem.$type.json"
  local html="docs/diagrams/rendered/$stem.html"
  local out="$RECEIPTS/$stem"
  mkdir -p "$out"
  "$ARCHIFY_BIN" finalize "$type" "$source" "$html" \
    --repo-root "$ROOT" --quality showcase --out-dir "$out/finalize" --json
  "$ARCHIFY_BIN" visual-check "$html" --json --require-provenance --out-dir "$out/visual"
  cp "$out/visual/$stem.visual-check.1440x900.light.png" "docs/diagrams/rendered/$stem.png"
}

render_one architecture system-architecture
render_one workflow hybrid-engineering
render_one lifecycle workflow-policy-lifecycle
render_one tree repository-map
printf 'Rendered four Archify diagrams and 1440x900 PNG previews. Receipts: %s\n' "$RECEIPTS"
