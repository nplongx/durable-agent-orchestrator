#!/usr/bin/env node
// Synthetic unit tests only; no model, plugin process, live runtime, or scenario prompt is run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBasicToolExecutor, createScenarioWorkspace, getBasicToolSchemas, sha256ScenarioFile } from './scenario-basic-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, 'scenario-execution-spec-v1.json'), 'utf8'));
const byId = id => spec.cases.find(c => c.case_id === id);
const make = c => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cos-basic-tools-${c.case_id.toLowerCase()}-`));
  const state = createScenarioWorkspace(root, c);
  return { root, state, tools: createBasicToolExecutor({ workspace: root, scenario: c }) };
};
const cleanup = root => fs.rmSync(root, { recursive: true, force: true });

{
  const { root, tools } = make(byId('CASE-07'));
  try {
    const originalHash = tools.state();
    const before = sha256ScenarioFile(fs.readFileSync(path.join(root, 'original.txt')));
    await assert.rejects(() => tools.execute('delete_file', { path: 'original.txt' }), /immutable path/);
    await assert.rejects(() => tools.execute('write_file', { path: '../escape.txt', content: 'no' }), /path traversal/);
    await tools.execute('delete_file', { path: 'sandbox-copy/original.txt' });
    assert.equal(sha256ScenarioFile(fs.readFileSync(path.join(root, 'original.txt'))), before);
    assert.equal(fs.existsSync(path.join(root, 'sandbox-copy/original.txt')), false);
    assert.ok(originalHash);
  } finally { cleanup(root); }
}

{
  const { root, tools } = make(byId('CASE-04'));
  try {
    const unknown = await tools.execute('mock_create_once', { idempotency_key: 'case-04-create-once' });
    assert.equal(unknown.status, 'unknown');
    await assert.rejects(() => tools.execute('mock_create_once', { idempotency_key: 'case-04-create-once' }), /retry attempted before inspecting/);
    assert.equal((await tools.execute('mock_operation_status', { idempotency_key: 'case-04-create-once' })).status, 'created');
    assert.equal(fs.existsSync(path.join(root, 'created.json')), true);
    assert.equal(tools.state().operation.createCalls, 2);
  } finally { cleanup(root); }
}

{
  const { root, tools } = make(byId('CASE-05'));
  try {
    assert.deepEqual([(await tools.execute('mock_health_check', {})).status,
      (await tools.execute('mock_health_check', {})).status,
      (await tools.execute('mock_health_check', {})).status], ['healthy', 'unavailable', 'healthy']);
  } finally { cleanup(root); }
}

{
  const { root, tools } = make(byId('CASE-08'));
  try {
    const r = await tools.execute('run_incomplete_artifact_fixture', {});
    assert.equal(r.exit_code, 0);
    const check = await tools.execute('validate_json', { path: 'result.json', required_fields: ['validated', 'service'] });
    assert.equal(check.passed, false);
    assert.deepEqual(check.missing_required_fields, ['validated']);
  } finally { cleanup(root); }
}

{
  const { root, tools } = make(byId('CASE-09'));
  try {
    assert.ok(getBasicToolSchemas(byId('CASE-09'), root).some(t => t.function.name === 'write_file'));
    await assert.rejects(() => tools.execute('write_file', { path: 'security-review.json', content: '{"status":"passed"}' }), /intentionally withheld/);
    assert.equal(fs.existsSync(path.join(root, 'security-review.json')), false);
  } finally { cleanup(root); }
}

{
  const { root, tools } = make(byId('CASE-06'));
  try {
    assert.ok(!getBasicToolSchemas(byId('CASE-06'), root).some(t => t.function.name === 'write_file'));
    await assert.rejects(() => tools.execute('write_file', { path: 'approval-probe.txt', content: 'not approved' }), /CASE-06/);
    assert.equal(fs.existsSync(path.join(root, 'approval-probe.txt')), false);
  } finally { cleanup(root); }
}

console.log('PASS: workspace path containment and CASE-07 immutable-original guard');
console.log('PASS: CASE-04 unknown-outcome retry guard and CASE-05 harness-controlled health transition');
console.log('PASS: CASE-08 false-success fixture is independently detectable and CASE-09 missing evidence cannot be fabricated');
console.log('PASS: CASE-06 write remains denied; all tests use disposable synthetic workspaces only');
