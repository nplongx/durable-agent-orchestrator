import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSpecialistRoleGuidance, SPECIALIST_GUIDANCE_ROLES } from '../src/runtime/workflow/specialist-role-guidance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedRoles = ['product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer'];
assert.deepEqual([...SPECIALIST_GUIDANCE_ROLES].sort(), [...expectedRoles].sort());
for (const role of expectedRoles) {
  const guidance = getSpecialistRoleGuidance(role);
  assert.equal(typeof guidance, 'string', `${role} guidance must be a string`);
  for (const cue of ['Focus:', 'Deliverable:', 'Evidence:', 'Stop/escalate:', 'Tool selection:']) {
    assert.ok(guidance.includes(cue), `${role} guidance is missing ${cue}`);
  }
}
assert.notEqual(getSpecialistRoleGuidance('engineer'), getSpecialistRoleGuidance('reviewer'));
assert.throws(() => getSpecialistRoleGuidance('cto'), /unknown specialist role/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tool-guidance-'));
const dataDir = path.join(temp, 'data');
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true });
const env = {
  ...process.env,
  NODE_ENV: 'test',
  CHAT_ON_STEROIDS_DATA_DIR: dataDir,
  WORKFLOW_DATA_DIR: dataDir,
  CHAT_ON_STEROIDS_WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
  WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
  CHAT_ON_STEROIDS_WORKSPACE: workspace,
  WORKFLOW_WORKSPACE: workspace,
  CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(dataDir, 'runtime'),
  EXECUTION_TMP_DIR: path.join(dataDir, 'runtime')
};
const payload = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'guidance-regression-test', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workflow_recommend_resources', arguments: { task: 'Rà soát bảo mật ứng dụng, tìm lỗ hổng và kiểm tra quyền truy cập.' } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'workflow_liveness_diagnostics', arguments: {} } }
].map(message => JSON.stringify(message)).join('\n') + '\n';
let toolList;
let initialization;
let recommendation;
let liveness;
try {
  const run = spawnSync(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env, input: payload, encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, `MCP catalog probe failed: ${run.stderr}`);
  const replies = run.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  initialization = replies.find(item => item.id === 1)?.result;
  toolList = replies.find(item => item.id === 2)?.result?.tools;
  recommendation = replies.find(item => item.id === 3)?.result?.structuredContent;
  liveness = replies.find(item => item.id === 4)?.result?.structuredContent;
  assert.ok(Array.isArray(toolList) && toolList.length > 0, 'live tools/list must return registered tools');
  assert.equal(replies.find(item => item.id === 3)?.result?.isError, false, 'resource recommendation must execute through the public MCP tool seam');
  assert.equal(replies.find(item => item.id === 4)?.result?.isError, false, 'job liveness diagnostics must execute through the public MCP tool seam');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
assert.match(initialization?.instructions || '', /proactively call workflow_recommend_resources/i);
assert.match(initialization?.instructions || '', /call workflow_liveness_diagnostics/i);
assert.equal(recommendation?.read_only, true);
assert.equal(liveness?.read_only, true);
assert.equal(recommendation?.recommendations?.built_in_role_hints?.[0]?.role, 'security');
const tools = new Map(toolList.map(tool => [tool.name, tool]));
function description(name) {
  assert.ok(tools.has(name), `missing registered tool ${name}`);
  return tools.get(name).description;
}
assert.match(description('workflow_create'), /never approves or executes|does not approve.*execute/i);
assert.match(description('workflow_recommend_resources'), /proactive|before creating/i);
assert.deepEqual(Object.keys(tools.get('workflow_recommend_resources').inputSchema.properties).sort(), ['limit', 'task']);
assert.deepEqual([...tools.get('workflow_recommend_resources').inputSchema.required], ['task']);
assert.match(description('workflow_preflight'), /read-only feasibility|feasibility check/i);
assert.match(description('workflow_write_files'), /plan-pinned|plan.*scope/i);
assert.match(description('workflow_approve'), /proposal and proposed immutable plan are inspected|after inspecting|inspect.*proposal/i);
assert.match(description('workflow_dispatch'), /approved/i);
assert.match(description('workflow_get'), /read-only|inspect/i);
assert.match(description('workflow_next_task'), /dependency-ready/i);
assert.match(description('workflow_complete_task'), /deterministic.*task_execute_local|task_execute_local.*deterministic/i);
assert.match(description('workflow_diagnose'), /read-only/i);
assert.match(description('workflow_liveness_diagnostics'), /read-only|stale candidates/i);
assert.deepEqual(Object.keys(tools.get('workflow_liveness_diagnostics').inputSchema.properties).sort(), ['job_id', 'limit', 'stale_after_ms']);
assert.match(description('workflow_request_rework'), /reviewer decision|review decision|review recovery/i);
assert.match(description('workflow_request_reviewer_revision'), /evidenceIssues/i);
assert.match(description('workflow_policy_validate'), /without storing|does not store/i);
assert.match(description('workflow_policy_attach'), /unapproved/i);
assert.match(description('custom_workflow_preview'), /does not .*execute/i);
assert.match(description('custom_workflow_approve'), /workflow_approve/i);
assert.match(description('custom_workflow_run_create'), /workflow_approve/i);

// Public identifiers and key input contracts must remain stable while descriptions evolve.
assert.deepEqual(Object.keys(tools.get('workflow_approve').inputSchema.properties).sort(), ['confirmation', 'job_id']);
assert.deepEqual([...tools.get('workflow_approve').inputSchema.required].sort(), ['confirmation', 'job_id']);
assert.deepEqual(Object.keys(tools.get('workflow_complete_task').inputSchema.properties).sort(), ['artifact', 'content', 'outcome', 'task_id']);
assert.deepEqual([...tools.get('workflow_complete_task').inputSchema.required].sort(), ['artifact', 'content', 'task_id']);
console.log('AGENT TOOL GUIDANCE PASS');
