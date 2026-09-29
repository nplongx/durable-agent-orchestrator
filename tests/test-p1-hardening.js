import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('p1-hardening-');
process.env.WORKFLOW_DB = path.join(root, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_WORKSPACE = root;

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { DistributedScheduler } = await import('../src/runtime/distributed-scheduler.js');
const { verifyWorkflowCompletion } = await import('../src/runtime/workflow/verifier.js');

const store = new WorkflowStore();

const approvalJob = store.createJob({ conversationKey: 'p1-approval', title: 'Engineering M4 P1 approval binding' });
store.recordEvent(approvalJob.job_id, 'job.proposal_requested', { task: 'initial scope' }, 'initial');
store.approve(approvalJob.job_id, 'approved');
assert.equal(store.isApprovalCurrent(approvalJob.job_id), true);
store.recordEvent(approvalJob.job_id, 'job.proposal_refined', { task: 'changed scope' }, 'refined');
assert.equal(store.isApprovalCurrent(approvalJob.job_id), false);
assert.throws(() => store.dispatch(approvalJob.job_id, { role: 'cto', description: 'must not dispatch stale approval' }), /approval is not current/);

const intentJob = store.createJob({ conversationKey: 'p1-intent', title: 'P1 provider intent' });
store.approve(intentJob.job_id, 'approved');
const task = store.createChildTask(intentJob.job_id, { role: 'engineer', description: 'provider intent task' });
const scheduler = new DistributedScheduler({
  store,
  provider: { async dispatch() { return { provider_run_id: 'gha-p1-1', state: 'QUEUED' }; } },
  workerId: 'p1-test'
});
const dispatched = await scheduler.dispatchTask(task, { inputCommit: 'a'.repeat(40) });
assert.equal(dispatched.run.provider_run_id, 'gha-p1-1');
const intent = store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE lease_id=?').get(dispatched.lease.lease_id);
assert.equal(intent.state, 'DISPATCHED');
assert.equal(intent.provider_run_id, 'gha-p1-1');
assert.equal(intent.attempt, 1);
assert.match(intent.dispatch_key, /^[a-f0-9]{64}$/);

const recoveryKey = 'b'.repeat(64);
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,provider,input_commit,state,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,'DISPATCHING',?,?)`)
  .run(recoveryKey, intentJob.job_id, task.task_id, 'lease-recovery', 2, 'github-actions', 'b'.repeat(40), new Date().toISOString(), new Date().toISOString());
const recoveryScheduler = new DistributedScheduler({
  store,
  provider: { async reconcileDispatchIntent() { return { provider_run_id: 'gha-recovered', state: 'RUNNING' }; } },
  workerId: 'p1-recovery'
});
const reconciled = await recoveryScheduler.reconcileProviderDispatches();
assert.equal(reconciled.some(item => item.dispatchKey === recoveryKey && item.status === 'RECONCILED'), true);
assert.equal(store.db.prepare('SELECT state,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(recoveryKey).provider_run_id, 'gha-recovered');

const plan = {
  schema_version: 1,
  workflow_id: 'engineering',
  workflow_version: 1,
  job_id: 'p1-verifier',
  phases: ['PROPOSED'],
  children: [
    { id: 'plan-a', role: 'engineer', dependencies: [], execution: { deterministic: false } },
    { id: 'plan-b', role: 'engineer', dependencies: ['plan-a'], execution: { deterministic: false } }
  ],
  synthesis: { id: 'plan-synthesis', role: 'cto', dependencies: ['plan-b'], execution: { deterministic: false } }
};
import crypto from 'node:crypto';
import { canonicalJson } from '../src/runtime/workflow/plan.js';
plan.plan_hash = crypto.createHash('sha256').update(canonicalJson(plan)).digest('hex');
const tasks = [
  { task_id: 'real-a', role: 'engineer', status: 'completed', parent_task_id: 'cto', metadata_json: JSON.stringify({ workflow_plan_task_id: 'plan-a' }) },
  { task_id: 'real-b', role: 'engineer', status: 'completed', parent_task_id: 'cto', metadata_json: JSON.stringify({ workflow_plan_task_id: 'plan-b' }) },
  { task_id: 'real-cto', role: 'cto', status: 'completed', parent_task_id: null, metadata_json: JSON.stringify({ workflow_plan_task_id: 'plan-synthesis' }) }
];
const results = tasks.map(task => ({ task_id: task.task_id, outcome: 'success', content: 'verified' }));
const verified = verifyWorkflowCompletion({ plan, tasks, results, reports: [{ kind: 'executive_summary', content: 'done' }], projection: { pendingEvents: 0 } });
assert.equal(verified.valid, true, verified.errors.join('; '));

const ambiguous = verifyWorkflowCompletion({
  plan,
  tasks: tasks.map(({ metadata_json, ...task }) => task),
  results,
  reports: [{ kind: 'executive_summary', content: 'done' }],
  projection: { pendingEvents: 0 }
});
assert.equal(ambiguous.valid, false);
assert.ok(ambiguous.errors.some(error => error.includes('required task missing')));

console.log('test-p1-hardening: PASS');
