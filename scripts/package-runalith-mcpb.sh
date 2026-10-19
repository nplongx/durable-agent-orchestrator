#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
assert_regular_source() {
  local relative="$1" current="$ROOT" part index=0
  local -a parts
  IFS='/' read -r -a parts <<< "$relative"
  for part in "${parts[@]}"; do
    current="$current/$part"
    if [[ -L "$current" || ! -e "$current" ]]; then
      echo "Refusing missing or symlinked package source: $relative" >&2
      exit 2
    fi
    index=$((index + 1))
    if [[ "$index" -lt "${#parts[@]}" ]]; then
      [[ -d "$current" ]] || { echo "Refusing non-directory source parent: $relative" >&2; exit 2; }
    else
      [[ -f "$current" ]] || { echo "Refusing non-regular package source: $relative" >&2; exit 2; }
    fi
  done
  [[ "$(realpath -e "$current")" == "$current" ]] || { echo "Refusing non-canonical package source: $relative" >&2; exit 2; }
}
for SOURCE in README.md LICENSE package.json plugin/manifest.json tests/test-runalith-plugin.js tests/test-production-behavioral-qa.js tests/test-extracted-package-tool-schemas.mjs tests/test-execution-lease-fencing.js tests/test-mcp-stdio-backpressure.mjs tests/test-temp-dir.js tests/test-mcp-graceful-signal-shutdown-20261017.js tests/test-mcp-shutdown-backpressure-deadline-20261017.js tests/test-mcp-eof-shutdown-framing-20261017.js scripts/package-runalith-mcpb.sh scripts/collect-plugin-runtime.mjs scripts/plugin-package-metadata.mjs; do
  assert_regular_source "$SOURCE"
done
VERSION="$(node -p "require('$ROOT/package.json').version")"
OUT="${PLUGIN_BUNDLE_OUT:-$ROOT/dist/runalith-${VERSION}-candidate-$(date -u +%Y%m%dT%H%M%SZ).mcpb}"
if [[ "$OUT" != /* ]]; then OUT="$ROOT/$OUT"; fi
# Canonicalize the output parent (including symlinked parents) before comparing the
# protected release path, so ./, ../, and symlink aliases cannot bypass the guard.
mkdir -p "$(dirname "$OUT")"
OUT_PARENT="$(cd "$(dirname "$OUT")" && pwd -P)"
OUT="$OUT_PARENT/$(basename "$OUT")"
PROTECTED_FROZEN_OUT="$ROOT/dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb"
PROTECTED_PARENT="$(cd "$(dirname "$PROTECTED_FROZEN_OUT")" && pwd -P)"
PROTECTED_FROZEN_OUT="$PROTECTED_PARENT/$(basename "$PROTECTED_FROZEN_OUT")"
if [[ "$OUT" == "$PROTECTED_FROZEN_OUT" ]]; then
  echo "Refusing to build to the Phase 1 frozen bundle path: $OUT" >&2
  echo "Restore the exact trusted frozen bytes, or use the formal re-freeze/review process. Build candidates to a separate path." >&2
  exit 2
fi
mkdir -p "$ROOT/dist"
if [[ -e "$OUT" || -L "$OUT" ]]; then
  echo "Refusing to overwrite existing plugin bundle: $OUT" >&2
  echo "Set PLUGIN_BUNDLE_OUT to a new candidate path, or move the existing file only after verifying its custody and purpose." >&2
  exit 2
fi
mkdir -p "$(dirname "$OUT")"
STAGE="$(mktemp -d "$(dirname "$OUT")/.plugin-package-stage.XXXXXX")"
SMOKE_ROOT=''
trap 'rm -rf "$STAGE"; if [[ -n "${SMOKE_ROOT:-}" ]]; then rm -rf "$SMOKE_ROOT"; fi' EXIT
PAYLOAD="$STAGE/payload"
BUNDLE="$STAGE/bundle.mcpb"
EXTRACTED="$STAGE/extracted-bundle"
mkdir -p "$PAYLOAD"
cp "$ROOT/plugin/manifest.json" "$PAYLOAD/manifest.json"
cp "$ROOT/README.md" "$ROOT/LICENSE" "$PAYLOAD/"
node --input-type=module - "$ROOT/package.json" "$PAYLOAD/package.json" "$ROOT/scripts/plugin-package-metadata.mjs" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [sourcePath, outputPath, projectionPath] = process.argv.slice(2);
const { serializePluginPackageMetadata } = await import(pathToFileURL(projectionPath));
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
fs.writeFileSync(outputPath, serializePluginPackageMetadata(source), { flag: 'wx', mode: 0o644 });
NODE
mkdir -p "$PAYLOAD/tests"
cp "$ROOT/tests/test-runalith-plugin.js" "$PAYLOAD/tests/"
cp "$ROOT/tests/test-production-behavioral-qa.js" "$PAYLOAD/tests/"
cp "$ROOT/tests/test-mcp-stdio-backpressure.mjs" "$PAYLOAD/tests/"
cp "$ROOT/tests/test-mcp-graceful-signal-shutdown-20261017.js" "$PAYLOAD/tests/"
cp "$ROOT/tests/test-mcp-shutdown-backpressure-deadline-20261017.js" "$PAYLOAD/tests/"
cp "$ROOT/tests/test-mcp-eof-shutdown-framing-20261017.js" "$PAYLOAD/tests/"
node "$ROOT/scripts/collect-plugin-runtime.mjs" "$ROOT" "$PAYLOAD"
# Normalize payload timestamps before archiving. ZIP's DOS timestamp fields
# otherwise inherit fresh staging mtimes, making identical payload bytes produce
# different archive hashes across otherwise equivalent builds. Strip extended
# timestamp extras as well; this changes archive metadata only, not payload.
# Normalize file permission bits too. `cp`, collector writes, and the projected
# package metadata inherit the caller's umask; zip records those mode bits in
# the central directory, so byte-identical payloads otherwise produce different
# MCPB hashes under umask 0022 vs 0077. The bundle is data consumed by Node, not
# a set of executable scripts, so all regular payload files use mode 0644.
find "$PAYLOAD" -type f -exec chmod 0644 {} +
find "$PAYLOAD" -exec touch -h -t 198001010000 {} +
(
  cd "$PAYLOAD"
  # Feed ZIP a stable, locale-independent file order. Recursive zip traversal
  # can otherwise emit directory entries in filesystem enumeration order even
  # when every payload timestamp and byte is identical.
  find manifest.json README.md LICENSE package.json server src protocol tests -type f -print \
    | LC_ALL=C sort \
    | zip -X -q "$BUNDLE" -@
)
unzip -t "$BUNDLE" >/dev/null
# Test the archive's actual payload bytes, not the pre-archive staging tree.
# A correct staging tree does not prove that the ZIP contains those same bytes
# or that the extracted entry point/tests still work after packaging.
mkdir -p "$EXTRACTED"
chmod 700 "$EXTRACTED"
unzip -q "$BUNDLE" -d "$EXTRACTED"
STRICT_JSON_MODULE="$ROOT/src/runtime/strict-json.js" node --input-type=module - "$BUNDLE" <<'NODE'
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const { parseStrictJson } = await import(pathToFileURL(process.env.STRICT_JSON_MODULE));
const file = process.argv[2];
const manifest = parseStrictJson(execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8' }), 'candidate package manifest');
if (manifest.server?.entry_point !== 'server/index.js') throw new Error('bundle manifest entry point mismatch');
for (const item of ['server/index.js', 'src/runtime/job-store.js', 'src/runtime/execution-manager.js', 'protocol/cos-ap-v1/index.js']) {
  execFileSync('unzip', ['-p', file, item], { stdio: 'ignore' });
}
const entries = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
if (/github-actions-provider|distributed-scheduler|server\.js/.test(entries)) throw new Error('cloud/legacy HTTP runtime unexpectedly included in plugin bundle');
console.log(`Plugin bundle PASS: ${file} (${fs.statSync(file).size} bytes; cloud and legacy HTTP code excluded)`);
NODE

# Launch the extracted bundle with isolated state and verify its real MCP stdio
# handshake. The extracted bundle itself lives beside the candidate output and
# may therefore sit beneath a shared/writable workspace parent. Runtime state
# must not inherit those ancestor permissions; put smoke state in a private OS
# temporary directory instead of beside the extracted runtime.
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/plugin-package-smoke.XXXXXX")"
chmod 700 "$SMOKE_ROOT"
SMOKE_DATA_DIR="$SMOKE_ROOT/data"
mkdir -p "$SMOKE_DATA_DIR"
chmod 700 "$SMOKE_DATA_DIR"
SMOKE_DB_PATH="$SMOKE_DATA_DIR/workflow.db"
SMOKE_OUTPUT="$(env -u OPENAI_API_KEY \
  RUNALITH_DATA_DIR="$SMOKE_DATA_DIR" \
  RUNALITH_WORKFLOW_DB="$SMOKE_DB_PATH" \
  RUNALITH_EXECUTION_TMP_DIR="$SMOKE_DATA_DIR/runtime" \
  RUNALITH_WORKSPACE="$EXTRACTED" \
  CHAT_ON_STEROIDS_DATA_DIR="$SMOKE_DATA_DIR" \
  CHAT_ON_STEROIDS_WORKFLOW_DB="$SMOKE_DB_PATH" \
  WORKFLOW_DATA_DIR="$SMOKE_DATA_DIR" \
  WORKFLOW_DB="$SMOKE_DB_PATH" \
  CHAT_ON_STEROIDS_EXECUTION_TMP_DIR="$SMOKE_DATA_DIR/runtime" \
  EXECUTION_TMP_DIR="$SMOKE_DATA_DIR/runtime" \
  CHAT_ON_STEROIDS_WORKSPACE="$EXTRACTED" \
  WORKFLOW_WORKSPACE="$EXTRACTED" \
  node "$EXTRACTED/server/index.js" <<'JSONRPC'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"bundle-smoke","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
JSONRPC
)"
SMOKE_OUTPUT="$SMOKE_OUTPUT" EXPECTED_MANIFEST="$PAYLOAD/manifest.json" STRICT_JSON_MODULE="$ROOT/src/runtime/strict-json.js" node --input-type=module <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const { parseStrictJson } = await import(pathToFileURL(process.env.STRICT_JSON_MODULE));
const lines = process.env.SMOKE_OUTPUT.trim().split(/\r?\n/).map((line, index) => parseStrictJson(line, `MCP smoke response ${index + 1}`));
if (lines.length !== 2 || lines[0].result?.serverInfo?.name !== 'runalith-agent-orchestrator') throw new Error('bundled MCP initialize failed');
const exposed = lines[1].result?.tools || [];
const expected = parseStrictJson(fs.readFileSync(process.env.EXPECTED_MANIFEST, 'utf8'), 'source package manifest').tools.map(tool => tool.name);
const exposedNames = new Set(exposed.map(tool => tool.name));
const missing = expected.filter(name => !exposedNames.has(name));
if (missing.length || exposed.length !== expected.length) {
  throw new Error(`bundled MCP tools/list mismatch: expected ${expected.length}, got ${exposed.length}, missing=${missing.join(',')}`);
}
console.log(`Bundled plugin runtime smoke test PASS (initialize + tools/list: ${exposed.length}/${expected.length} manifest tools exposed)`);
NODE

# Validate the tool schema contract from the exact candidate archive as well
# as the MCP tool names/count. A candidate must not be published merely because
# every declared tool name appears while its extracted schema is malformed.
PHASE2_CANDIDATE_BUNDLE="$BUNDLE" PHASE2_ALLOW_EXTERNAL_CANDIDATE_BUNDLE=1 node "$ROOT/tests/test-extracted-package-tool-schemas.mjs"
node "$ROOT/tests/test-execution-lease-fencing.js"
node "$EXTRACTED/tests/test-mcp-stdio-backpressure.mjs"
node "$EXTRACTED/tests/test-mcp-graceful-signal-shutdown-20261017.js"
node "$EXTRACTED/tests/test-mcp-shutdown-backpressure-deadline-20261017.js"
node "$EXTRACTED/tests/test-mcp-eof-shutdown-framing-20261017.js"

# Run the complete acceptance workflow against bytes extracted from the exact archive.
env -u OPENAI_API_KEY node "$EXTRACTED/tests/test-runalith-plugin.js"

# Publish only after every package check passes. The hard link is atomic and fails if
# another process created OUT after the initial existence check; STAGE lives beside OUT.
ln "$BUNDLE" "$OUT"
echo "Published validated plugin candidate: $OUT ($(stat -c '%s' "$OUT") bytes; SHA-256 $(sha256sum "$OUT" | cut -d' ' -f1))"
