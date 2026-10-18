#!/usr/bin/env node
// Negative conformance test: a host that does not return a real paired trace must fail closed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'paired-host-harness.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-paired-harness-test-'));
try {
  const config = path.join(temp, 'config.json');
  const testCase = path.join(temp, 'case.json');
  // Keep the expected evidence outside the input-fixture directory. This also
  // proves the runner writes its blocked record even when a host exits early.
  const output = path.join(os.tmpdir(), `cos-paired-harness-evidence-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(config, JSON.stringify({
    protocol: 'cos-paired-host-v1', timeout_ms: 3000,
    conditions: {
      plugin: { command: '/bin/false', base_args: [], args: ['plugin'] },
      control: { command: '/bin/false', base_args: [], args: ['control'] },
    },
  }));
  fs.writeFileSync(testCase, JSON.stringify({ kind: 'read-only-host-probe', case_id: 'HARNESS-NEGATIVE-TEST',
    prompt: 'Use read-only capabilities only. Do not mutate state.' }));
  const result = spawnSync(process.execPath, [runner, '--config', config, '--case', testCase, '--output', output, '--probe-only'], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1, `expected fail-closed exit; got ${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
  assert.ok(fs.existsSync(output), `runner must persist blocked evidence; stdout=${result.stdout}; stderr=${result.stderr}`);
  const evidence = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(evidence.status, 'blocked');
  assert.equal(evidence.benchmark_scenarios_executed, false);
  assert.equal(evidence.native_tool_call_and_result_traces_verified, false);
  assert.equal(evidence.paired_effective_permissions_captured, false);
  console.log('PASS: paired host harness fails closed when host cannot provide evidence; no benchmark scenarios executed');
} finally {
  // Remove only test-prefixed temporary evidence files belonging to this test process.
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (name.startsWith(`cos-paired-harness-evidence-${process.pid}-`) && name.endsWith('.json')) {
      fs.rmSync(path.join(os.tmpdir(), name), { force: true });
      fs.rmSync(`${path.join(os.tmpdir(), name)}.traces`, { recursive: true, force: true });
    }
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
