#!/usr/bin/env node
// Static policy validation only: reads the frozen bundle manifest; never starts plugin or model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getBasicToolSchemas } from './scenario-basic-tools.mjs';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const spec = JSON.parse(fs.readFileSync(path.join(here, 'scenario-execution-spec-v1.json'), 'utf8'));
const adapterSource = fs.readFileSync(path.join(here, 'ollama-scenario-adapter.mjs'), 'utf8');
const harnessSource = fs.readFileSync(path.join(here, 'scenario-paired-harness.mjs'), 'utf8');
const sandboxSource = fs.readFileSync(path.join(here, 'scenario-sandbox.mjs'), 'utf8');
const exportSource = fs.readFileSync(path.join(here, 'plugin-state-export.mjs'), 'utf8');
const traceIntegritySource = fs.readFileSync(path.join(here, 'trace-integrity.mjs'), 'utf8');
const bundle = path.join(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb');
const expectedBundleHash = '413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa';
const denyAlways = new Set(['workflow_approve', 'workflow_dispatch', 'workflow_e2e_run', 'task_execute_local',
  'workflow_prepare_tasks', 'workflow_complete_task', 'workflow_complete_synthesis', 'custom_workflow_approve', 'custom_workflow_run_create']);
// Fail closed with a stable operator-facing diagnostic. A missing frozen artifact
// is an expected recovery state, not an uncaught ENOENT stack trace; never fall
// back to a candidate bundle here.
if (!fs.existsSync(bundle)) {
  console.error(`BLOCKED: frozen bundle is missing: ${path.relative(repo, bundle)}; required SHA-256 ${expectedBundleHash}. Restore the exact bytes from trusted custody or complete the formal re-freeze/review process. Candidate packages are not substitutes.`);
  process.exit(2);
}
let bundleBytes;
try {
  bundleBytes = fs.readFileSync(bundle);
} catch (error) {
  console.error(`BLOCKED: cannot read frozen bundle ${path.relative(repo, bundle)}: ${error.code ?? error.message}; required SHA-256 ${expectedBundleHash}.`);
  process.exit(2);
}
const bundleHash = createHash('sha256').update(bundleBytes).digest('hex');
assert.equal(bundleHash, expectedBundleHash, 'frozen plugin bundle hash changed');
const manifestResult = spawnSync('/usr/bin/unzip', ['-p', bundle, 'manifest.json'], {
  encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
});
assert.equal(manifestResult.status, 0, `cannot read frozen bundle manifest: ${manifestResult.stderr}`);
const manifest = JSON.parse(manifestResult.stdout);
assert.equal(manifest.version, '1.0.8');
const manifestNames = new Set((manifest.tools ?? []).map(t => t.name));
assert.equal(manifestNames.size, manifest.tools.length, 'bundle manifest has duplicate tool names');
assert.equal(spec.status, 'prepared-not-authorized');
assert.equal(spec.execution_gate.status, 'blocked');
assert.deepEqual(spec.execution_gate.authorized_case_ids, []);
assert.equal(spec.execution_gate.authorization_record, null);
const isolatedEnvAssignments = {
  WORKFLOW_DATA_DIR: /'WORKFLOW_DATA_DIR',\s*'\/case\/data'/,
  WORKFLOW_DB: /'WORKFLOW_DB',\s*'\/case\/data\/workflow\.db'/,
  WORKFLOW_WORKSPACE: /'WORKFLOW_WORKSPACE',\s*'\/case\/workspace'/,
  EXECUTION_TMP_DIR: /'EXECUTION_TMP_DIR',\s*'\/case\/execution-tmp'/,
};
for (const [envKey, pattern] of Object.entries(isolatedEnvAssignments)) {
  assert.match(sandboxSource, pattern, `OS-sandboxed plugin process must explicitly set ${envKey}`);
}
assert.match(adapterSource, /buildPluginSandboxLaunch\(/, 'plugin condition must use the OS-sandbox launcher');
assert.match(sandboxSource, /--unshare-net/, 'plugin sandbox must isolate the network namespace');
assert.match(sandboxSource, /--unshare-pid/, 'plugin sandbox must isolate the PID namespace');
assert.match(sandboxSource, /--ro-bind',\s*plugin,\s*'\/plugin'/, 'frozen bundle must be mounted read-only');
assert.match(sandboxSource, /MemoryMax=\$\{memoryMax\}/, 'plugin process must have a cgroup memory limit');
assert.match(sandboxSource, /CPUQuota=\$\{cpuQuota\}/, 'plugin process must have a cgroup CPU quota');
assert.match(sandboxSource, /TasksMax=\$\{tasksMax\}/, 'plugin process tree must have a task limit');
assert.match(adapterSource, /exportPluginState\(/, 'plugin condition must export its isolated durable state');
assert.match(exportSource, /new DatabaseSync\(dbPath, \{ readOnly: true \}\)/, 'durable state export must open SQLite read-only');
assert.match(exportSource, /workspace_artifact_causality_proven:\s*false/, 'DB export must not be mistaken for workspace artifact causality');
assert.match(harnessSource, /verifyExecutorTrace\(/, 'paired harness must validate model/executor trace reconciliation');
assert.match(traceIntegritySource, /executor-terminal-reconciliation/, 'trace validator must check one terminal executor record per attempt');
assert.match(traceIntegritySource, /plugin-rpc-terminal-reconciliation/, 'trace validator must check plugin RPC result/denial reconciliation');

for (const scenario of spec.cases) {
  const basic = getBasicToolSchemas(scenario, '/tmp/synthetic-policy-only').map(t => t.function.name);
  const plugin = scenario.plugin_tools;
  assert.equal(new Set(basic).size, basic.length, `${scenario.case_id}: duplicate basic tool`);
  assert.equal(new Set(plugin).size, plugin.length, `${scenario.case_id}: duplicate plugin tool`);
  for (const name of basic) assert.ok(spec.paired_conditions.basic_tool_catalog.includes(name), `${scenario.case_id}: basic tool ${name} absent from catalog`);
  for (const name of plugin) {
    assert.ok(manifestNames.has(name), `${scenario.case_id}: ${name} absent from frozen bundle`);
    assert.ok(!denyAlways.has(name), `${scenario.case_id}: forbidden plugin tool ${name} in allowlist`);
    assert.ok(!basic.includes(name), `${scenario.case_id}: basic/plugin tool name collision ${name}`);
  }
  for (const name of scenario.hard_denied_tools ?? []) {
    assert.ok(!basic.includes(name), `${scenario.case_id}: hard-denied basic tool leaked: ${name}`);
    assert.ok(!plugin.includes(name), `${scenario.case_id}: hard-denied plugin tool leaked: ${name}`);
  }
}
const c6 = spec.cases.find(c => c.case_id === 'CASE-06');
for (const name of ['workflow_approve', 'workflow_dispatch', 'workflow_e2e_run', 'task_execute_local', 'write_file']) {
  assert.ok(c6.hard_denied_tools.includes(name));
  assert.ok(!c6.plugin_tools.includes(name));
  assert.ok(!getBasicToolSchemas(c6, '/tmp/synthetic-policy-only').some(t => t.function.name === name));
}
const c7 = spec.cases.find(c => c.case_id === 'CASE-07');
assert.deepEqual(c7.path_policy.write_or_delete_paths, ['sandbox-copy/original.txt']);
assert.ok(c7.path_policy.immutable_paths.includes('original.txt'));
console.log(`PASS: frozen bundle SHA-256 ${bundleHash} and manifest version 1.0.8 verified`);
console.log('PASS: every scenario plugin allowlist references existing frozen tools and excludes always-denied actions');
console.log('PASS: basic tool sets are case-specific, hard denies do not leak, and CASE-07 path policy is exact');
console.log('PASS: plugin child is launched through bwrap + systemd cgroup resource limits with only case-local writable mounts');
console.log('PASS: plugin condition captures read-only SQLite state and explicitly does not infer workspace artifact causality');
console.log('PASS: reviewed execution gate remains blocked; no plugin process or model prompt executed');
