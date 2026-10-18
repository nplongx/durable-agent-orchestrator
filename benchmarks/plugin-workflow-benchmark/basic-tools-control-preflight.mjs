#!/usr/bin/env node
// Validates the disposable workspace contract for the no-plugin control condition.
// This is infrastructure preflight only, not an agent-performance baseline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outPath = process.argv[2];
if (!outPath) throw new Error('Usage: node basic-tools-control-preflight.mjs <evidence-output.json>');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-phase2-basic-tools-'));
const workspace = path.join(temp, 'workspace');
const dataDir = path.join(temp, 'data');
const executionTmp = path.join(temp, 'execution-tmp');
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(executionTmp, { recursive: true, mode: 0o700 });
const hash = value => createHash('sha256').update(value).digest('hex');
let evidence;
try {
  // Use only harmless file operations on synthetic data; no network or external process.
  const initial = { service: 'synthetic-demo', port: 43127 };
  const inputPath = path.join(workspace, 'input.json');
  const outputPath = path.join(workspace, 'result.json');
  fs.writeFileSync(inputPath, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const readBack = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  assert.deepEqual(readBack, initial);
  const result = { validated: true, service: readBack.service, port: readBack.port };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const verified = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(verified.validated, true);
  assert.equal(verified.service, 'synthetic-demo');
  const files = fs.readdirSync(workspace).sort();
  assert.deepEqual(files, ['input.json', 'result.json']);
  evidence = {
    captured_at: new Date().toISOString(),
    preflight_only: true,
    baseline_started: false,
    condition: 'basic-tools-no-plugin',
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      workspace, data_directory: dataDir, execution_tmp_directory: executionTmp,
      workspace_mode_octal: (fs.statSync(workspace).mode & 0o777).toString(8),
      data_directory_mode_octal: (fs.statSync(dataDir).mode & 0o777).toString(8),
      external_network_used: false, external_process_spawned: false,
      plugin_orchestrator_started: false, external_provider_credentials_used: false,
      temporary_paths_deleted_after_capture: true },
    available_control_operations: ['list synthetic workspace files', 'read UTF-8 file', 'write new UTF-8 file', 'parse/validate JSON', 'compute SHA-256'],
    synthetic_smoke: { passed: true, files, input_sha256: hash(fs.readFileSync(inputPath)),
      result_sha256: hash(fs.readFileSync(outputPath)), result: verified },
    permissions: { workflow_approval_tool_available: false, plugin_tools_available: false,
      host_os_sandbox_enforced: false,
      note: 'This verifies a disposable basic-file-operations harness, not a full OS sandbox or an LLM A/B run.' },
    result: 'PASS'
  };
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ result: evidence.result, condition: evidence.condition,
  syntheticSmoke: evidence.synthetic_smoke.passed, baselineStarted: evidence.baseline_started,
  evidence: path.resolve(outPath) }, null, 2));
