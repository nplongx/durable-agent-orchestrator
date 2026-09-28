import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dbPath = path.join('/tmp', 'workflow-plan-m2-' + crypto.randomUUID() + '.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = path.dirname(dbPath);
process.env.WORKFLOW_WORKSPACE = '/tmp/m2-workspace';

const { WorkflowStore, conversationKeyFromMessages } = await import('../src/runtime/job-store.js');
const { compileWorkflowPlan } = await import('../src/runtime/workflow/compiler.js');
const { canonicalJson } = await import('../src/runtime/workflow/plan.js');

const store = new WorkflowStore();
const title = 'Production E2E acceptance M2';
const job = store.getOrCreateJob({
  conversationKey: conversationKeyFromMessages([{ role: 'user', content: title }]),
  title
});
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'duyệt');

const plan = store.getExecutionPlan(job.job_id);
assert.ok(plan);
assert.equal(plan.workflow_id, 'production');
assert.equal(plan.workflow_version, 1);
assert.equal(plan.children.length, 2);
assert.deepEqual(plan.children.map(t => t.role), ['architect', 'qa']);
assert.deepEqual(plan.children.map(t => t.execution.executable), ['node', 'node']);
assert.deepEqual(plan.children.map(t => t.execution.args), [
  ['--check', '/tmp/m2-workspace/server.js'],
  ['--check', '/tmp/m2-workspace/test-tool-turn.js']
]);
assert.match(plan.plan_hash, /^[a-f0-9]{64}$/);
const rowBefore = store.db.prepare('SELECT plan_hash, plan_json, compiled_at, approved_at FROM workflow_plans WHERE job_id=?').get(job.job_id);
assert.equal(rowBefore.plan_hash, plan.plan_hash);
assert.equal(plan.plan_hash, crypto.createHash('sha256').update(rowBefore.plan_json).digest('hex'));

const again = store.compileExecutionPlan(job.job_id, { workspace: '/tmp/m2-workspace' });
assert.equal(again.plan_hash, plan.plan_hash);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workflow_plans WHERE job_id=?').get(job.job_id).n, 1);

const different = compileWorkflowPlan(job, { workspace: '/tmp/other-workspace' });
assert.notEqual(different.plan_hash, plan.plan_hash);
assert.throws(() => store.compileExecutionPlan(job.job_id, { workspace: '/tmp/other-workspace' }), /immutable execution plan mismatch/);

const task = store.createChildTask(job.job_id, {
  parentTaskId: null,
  role: 'architect',
  description: 'planned architect'
});
const metadata = JSON.parse(task.metadata_json);
assert.equal(metadata.executable, 'node');
assert.deepEqual(metadata.args, ['--check', '/tmp/m2-workspace/server.js']);
assert.equal(metadata.command, 'node --check /tmp/m2-workspace/server.js');

fs.rmSync(dbPath, { force: true });
console.log('test-workflow-plan-m2: PASS');
