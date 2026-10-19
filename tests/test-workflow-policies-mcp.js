import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-policy-mcp-'));
const dataDir = path.join(temp, 'private-data');
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const dbPath = path.join(dataDir, 'workflow.db');
const env = {
  ...process.env,
  NODE_ENV: 'test',
  CHAT_ON_STEROIDS_DATA_DIR: dataDir,
  CHAT_ON_STEROIDS_WORKSPACE: workspace,
  CHAT_ON_STEROIDS_WORKFLOW_DB: dbPath,
  WORKFLOW_DB: dbPath,
  CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(dataDir, 'runtime')
};
delete env.OPENAI_API_KEY;

const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
let buffer = '';
let nextId = 0;
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => {
  stdout += chunk;
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let response;
    try { response = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); waiter(response); }
  }
});
child.stderr.on('data', chunk => { stderr += chunk; });

function rpc(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`policy MCP RPC timed out: ${method}\nstdout=${stdout}\nstderr=${stderr}`));
    }, 15_000);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function tool(name, args = {}) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, `${name} JSON-RPC error: ${JSON.stringify(response.error)}`);
  assert.equal(response.result?.isError, false, `${name} failed: ${response.result?.content?.[0]?.text}\n${stderr}`);
  return response.result.structuredContent;
}
async function toolError(name, args = {}, pattern = undefined) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, `${name} JSON-RPC error: ${JSON.stringify(response.error)}`);
  assert.equal(response.result?.isError, true, `${name} unexpectedly succeeded: ${JSON.stringify(response.result?.structuredContent)}`);
  const message = response.result?.content?.[0]?.text || '';
  if (pattern) assert.match(message, pattern, `${name} error did not explain why it was rejected: ${message}`);
  return message;
}

try {
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'workflow-policy-test', version: '1' } });
  assert.equal(initialized.error, undefined, initialized.error?.message);
  const listed = await rpc('tools/list', {});
  const toolNames = listed.result.tools.map(tool => tool.name);
  assert.equal(toolNames.length, 46);
  for (const name of ['workflow_policy_catalog', 'workflow_policy_create', 'workflow_policy_list', 'workflow_policy_get', 'workflow_policy_update', 'workflow_policy_validate', 'workflow_policy_attach']) {
    assert.ok(toolNames.includes(name), `the runtime must expose ${name}`);
    assert.equal(listed.result.tools.find(tool => tool.name === name).inputSchema.additionalProperties, false);
  }

  const catalog = await tool('workflow_policy_catalog');
  assert.ok(catalog.rule_types.some(rule => rule.type === 'artifact_field_equals' && /synthesis/i.test(rule.enforcement)));
  assert.ok(!catalog.rule_types.some(rule => rule.type === 'max_execution_attempts'));
  await toolError('workflow_policy_validate', {
    policy_id: 'unsafe-policy', name: 'Unsafe policy',
    constraints: [{ id: 'limit-retry', type: 'max_execution_attempts', max_attempts: 1 }]
  }, /match exactly one supported schema|unsupported/i);
  await toolError('workflow_policy_validate', {
    policy_id: 'unsafe-policy', name: 'Unsafe policy', executable: 'process.exit(0)',
    constraints: [{ id: 'all-tasks', type: 'all_tasks_completed' }]
  }, /not allowed|unsupported fields/i);
  assert.equal((await tool('workflow_policy_list', { query: 'unsafe-policy', limit: 20 })).items.length, 0,
    'failed policy validation must not write a policy definition');

  const policyDefinition = {
    policy_id: 'secure-release',
    name: 'Secure release',
    description: 'Keep plan execution local and require QA acceptance evidence.',
    constraints: [{ id: 'local-only', type: 'local_execution_only', description: 'Only approved local execution contracts may be used.' }],
    success_criteria: [{ id: 'qa-accepted', type: 'artifact_field_equals', artifact_type: 'qa-report', producer_role: 'qa', field: 'decision', expected: 'accept' }]
  };
  const validation = await tool('workflow_policy_validate', policyDefinition);
  assert.equal(validation.valid, true);
  assert.match(validation.preview.content_hash, /^[a-f0-9]{64}$/);
  const created = await tool('workflow_policy_create', policyDefinition);
  assert.equal(created.policy.version, 1);
  assert.equal(created.policy.content_hash, validation.preview.content_hash);
  await toolError('workflow_policy_create', policyDefinition, /already exists/i);

  const proposal = await tool('workflow_create', {
    title: 'Policy attach/immutable plan verification',
    task: 'Verify versioned policy pack storage, attachment gates, immutable plan hashing and fail-closed tamper handling.',
    workflow: 'standard-engineering', workspace,
    goal: 'Attach and enforce a policy snapshot without weakening fixed workflow invariants.'
  });
  assert.equal(proposal.requires_explicit_approval, true);
  const attached = await tool('workflow_policy_attach', {
    job_id: proposal.job_id, policy_id: 'secure-release', version: 1
  });
  assert.equal(attached.attached, true);
  assert.equal(attached.version, 1);
  assert.equal(attached.approval_required, true);

  const updated = await tool('workflow_policy_update', {
    policy_id: 'secure-release',
    description: 'Version two deliberately differs; existing attachments must remain pinned to version one.'
  });
  assert.equal(updated.policy.version, 2);
  assert.notEqual(updated.policy.content_hash, created.policy.content_hash);
  const history = await tool('workflow_policy_list', { include_versions: true, limit: 20, query: 'secure' });
  assert.deepEqual(history.items.map(item => item.version).sort(), [1, 2]);
  assert.equal(history.attachments.length, 1);
  assert.equal(history.attachments[0].version, 1);
  const exact = await tool('workflow_policy_get', { policy_id: 'secure-release', version: 1 });
  assert.equal(exact.policy.content_hash, created.policy.content_hash);
  assert.equal(exact.attachments[0].job_id, proposal.job_id);

  const approved = await tool('workflow_approve', {
    job_id: proposal.job_id,
    confirmation: 'Approve the reviewed immutable standard-engineering plan with secure-release policy version 1 pinned.'
  });
  assert.equal(approved.approved, true);
  const plan = approved.plan;
  assert.equal(plan.policy_packs.length, 1);
  assert.equal(plan.policy_packs[0].policy_id, 'secure-release');
  assert.equal(plan.policy_packs[0].version, 1);
  assert.equal(plan.policy_packs[0].content_hash, created.policy.content_hash);
  assert.equal(plan.base_success_contract.success_criteria.length, 0);
  assert.ok(plan.success_contract.constraints.some(rule => rule.id === 'p-secure-release-local-only'));
  assert.ok(plan.success_contract.success_criteria.some(rule => rule.id === 'p-secure-release-qa-accepted'));
  assert.match(plan.plan_hash, /^[a-f0-9]{64}$/);

  const second = await tool('workflow_policy_create', {
    policy_id: 'require-security', name: 'Require security review',
    constraints: [{ id: 'security-role', type: 'task_role_present', role: 'security' }]
  });
  assert.equal(second.policy.version, 1);
  await toolError('workflow_policy_attach', {
    job_id: proposal.job_id, policy_id: 'require-security'
  }, /unapproved workflow proposal|after approval|plan compilation/i);
  const stillPinned = await tool('workflow_get', { job_id: proposal.job_id });
  assert.equal(stillPinned.plan.plan_hash, plan.plan_hash);
  assert.equal(stillPinned.plan.policy_packs[0].version, 1,
    'policy updates after attachment must not silently change the approved plan snapshot');

  const audit = new DatabaseSync(dbPath);
  try {
    assert.equal(audit.prepare("SELECT COUNT(*) n FROM workflow_policy_events WHERE policy_id='secure-release' AND event_type='created'").get().n, 1);
    assert.equal(audit.prepare("SELECT COUNT(*) n FROM workflow_policy_events WHERE policy_id='secure-release' AND event_type='updated'").get().n, 1);
    assert.equal(audit.prepare("SELECT COUNT(*) n FROM workflow_policy_events WHERE policy_id='secure-release' AND event_type='attached'").get().n, 1);
    assert.throws(() => audit.prepare('UPDATE workflow_policy_versions SET name=? WHERE policy_id=? AND version=1').run('tampered', 'secure-release'), /immutable/i);
    assert.throws(() => audit.prepare('DELETE FROM workflow_policy_attachments WHERE job_id=?').run(proposal.job_id), /immutable/i);
    const row = audit.prepare('SELECT plan_json,plan_hash FROM workflow_plans WHERE job_id=?').get(proposal.job_id);
    const changed = JSON.parse(row.plan_json);
    changed.policy_packs[0].content_hash = '0'.repeat(64);
    audit.prepare('UPDATE workflow_plans SET plan_json=? WHERE job_id=?').run(JSON.stringify(changed), proposal.job_id);
  } finally { audit.close(); }
  await toolError('workflow_get', { job_id: proposal.job_id }, /immutable execution plan hash|policy contract is invalid|policy snapshot hash mismatch/i);

  console.log('WORKFLOW POLICY MCP E2E PASS (46-tool schema parity, strict rule rejection, CRUD immutable versions, pre-approval attach, plan hash pinning, attachment gates, append-only audit and tamper rejection)');
} finally {
  child.stdin.end();
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 1500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  const makeWritable = target => {
    let stat;
    try { stat = fs.lstatSync(target); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(target, 0o700);
      for (const name of fs.readdirSync(target)) makeWritable(path.join(target, name));
    } else if (stat.isFile()) fs.chmodSync(target, 0o600);
  };
  makeWritable(temp);
  fs.rmSync(temp, { recursive: true, force: true });
}
