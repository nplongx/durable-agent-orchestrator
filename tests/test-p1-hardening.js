import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('p1-hardening-');
process.env.WORKFLOW_DB = path.join(root, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_WORKSPACE = root;

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { DistributedScheduler } = await import('../src/runtime/distributed-scheduler.js');
const { GitHubActionsProvider } = await import('../src/runtime/github-actions-provider.js');
const { verifyWorkflowCompletion } = await import('../src/runtime/workflow/verifier.js');
const { canonicalProviderDispatchRequest, createProviderDispatchIdentity, providerDispatchKey, providerDispatchConfig } = await import('../src/runtime/provider-dispatch-identity.js');

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

const pendingTask = store.createChildTask(intentJob.job_id, { role: 'engineer', description: 'provider pending dispatch task' });
const pendingScheduler = new DistributedScheduler({
  store,
  provider: { async dispatch() { return { provider_run_id: null, state: 'DISPATCHING', pending_reconciliation: true }; } },
  workerId: 'p2-pending'
});
const pendingDispatch = await pendingScheduler.dispatchTask(pendingTask, { inputCommit: 'c'.repeat(40) });
assert.equal(pendingDispatch.run.provider_run_id, null);
const pendingIntent = store.db.prepare('SELECT state,provider_run_id FROM provider_dispatch_intents WHERE task_id=?').get(pendingTask.task_id);
assert.equal(pendingIntent.state, 'DISPATCHING');
assert.equal(pendingIntent.provider_run_id, null);
assert.equal(store.getTask(pendingTask.task_id).status, 'running');

const recoveryIdentity = createProviderDispatchIdentity({
  job_id: intentJob.job_id, task_id: task.task_id, lease_id: 'lease-recovery', attempt: 2, owner_epoch: 2, input_commit: 'b'.repeat(40)
}, providerDispatchConfig({}));
const recoveryKey = providerDispatchKey(recoveryIdentity);
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,dispatch_claim_id,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING','test-existing-send-claim',?,?)`)
  .run(recoveryKey, recoveryIdentity.job_id, recoveryIdentity.task_id, recoveryIdentity.lease_id, recoveryIdentity.attempt, recoveryIdentity.owner_epoch,
    recoveryIdentity.provider, recoveryIdentity.input_commit, recoveryIdentity.request_sha256, canonicalProviderDispatchRequest({
      job_id: recoveryIdentity.job_id, task_id: recoveryIdentity.task_id, lease_id: recoveryIdentity.lease_id,
      attempt: recoveryIdentity.attempt, owner_epoch: recoveryIdentity.owner_epoch, input_commit: recoveryIdentity.input_commit
    }), recoveryIdentity.api_base, recoveryIdentity.workflow, recoveryIdentity.repository,
    recoveryIdentity.event, recoveryIdentity.ref, new Date().toISOString(), new Date().toISOString());
const recoveryScheduler = new DistributedScheduler({
  store,
  provider: { async reconcileDispatchIntent() { return {
    provider_run_id: 'gha-recovered', job_id: recoveryIdentity.job_id, task_id: recoveryIdentity.task_id,
    lease_id: recoveryIdentity.lease_id, attempt: recoveryIdentity.attempt, owner_epoch: recoveryIdentity.owner_epoch, input_commit: recoveryIdentity.input_commit,
    workflow: recoveryIdentity.workflow, ref: recoveryIdentity.ref, state: 'RUNNING'
  }; } },
  workerId: 'p1-recovery'
});
const reconciled = await recoveryScheduler.reconcileProviderDispatches();
assert.equal(reconciled.some(item => item.dispatchKey === recoveryKey && item.status === 'RECONCILED'), true);
assert.equal(store.db.prepare('SELECT state,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(recoveryKey).provider_run_id, 'gha-recovered');

// A dispatch reconciliation can race with another process that already bound
// the intent. The late result must not overwrite the winner or leave an orphan
// provider_runs row. This uses the real SQLite store and a mock GitHub API only.
const raceCreatedAt = new Date().toISOString();
const raceInputCommit = 'c'.repeat(40);
const raceIdentity = createProviderDispatchIdentity({
  job_id: intentJob.job_id, task_id: task.task_id, lease_id: 'lease-race-reconcile', attempt: 3, owner_epoch: 3, input_commit: raceInputCommit
}, { provider: 'github-actions', workflow: 'p3-worker.yml', repository: 'example/repo', event: 'workflow_dispatch', ref: 'main' });
const raceKey = providerDispatchKey(raceIdentity);
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
  .run(raceKey, raceIdentity.job_id, raceIdentity.task_id, raceIdentity.lease_id, raceIdentity.attempt, raceIdentity.owner_epoch,
    raceIdentity.provider, raceIdentity.input_commit, raceIdentity.request_sha256, canonicalProviderDispatchRequest({
      job_id: raceIdentity.job_id, task_id: raceIdentity.task_id, lease_id: raceIdentity.lease_id,
      attempt: raceIdentity.attempt, owner_epoch: raceIdentity.owner_epoch, input_commit: raceIdentity.input_commit
    }), raceIdentity.api_base, raceIdentity.workflow, raceIdentity.repository,
    raceIdentity.event, raceIdentity.ref, raceCreatedAt, raceCreatedAt);
const racingProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async url => {
    assert.match(url, /actions\/workflows\/p3-worker\.yml\/runs\?/);
    store.db.prepare(`INSERT INTO provider_runs
      (provider_run_id,provider,job_id,task_id,lease_id,attempt,owner_epoch,input_commit,dispatch_key,request_sha256,workflow,ref,state,conclusion,html_url,artifact_id,output_commit,run_attempt,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'RUNNING',NULL,NULL,NULL,NULL,1,?,?)`)
      .run('99999', 'github-actions', intentJob.job_id, task.task_id, 'lease-race-reconcile', 3, raceIdentity.owner_epoch, raceInputCommit, raceKey, raceIdentity.request_sha256, 'p3-worker.yml', 'main', raceCreatedAt, raceCreatedAt);
    store.db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHED',provider_run_id='99999',updated_at=? WHERE dispatch_key=?`)
      .run(new Date().toISOString(), raceKey);
    return new Response(JSON.stringify({ workflow_runs: [{
      id: 88888, display_title: `P3 worker ${raceKey}`, name: 'P3 Distributed Worker', status: 'in_progress',
      conclusion: null, html_url: 'https://github.com/example/repo/actions/runs/88888', created_at: raceCreatedAt,
      path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
      repository: { full_name: 'example/repo' }, head_sha: raceInputCommit, run_attempt: 1
    }] }), { status: 200 });
  }
});
await assert.rejects(() => racingProvider.reconcileDispatchIntent({
  ...store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(raceKey), created_at: raceCreatedAt
}), /dispatch intent changed identity before result binding|concurrently bound to a different provider run/);
assert.equal(store.db.prepare('SELECT provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(raceKey).provider_run_id, '99999');
assert.equal(store.db.prepare('SELECT provider_run_id FROM provider_runs WHERE provider_run_id=?').get('88888'), undefined,
  'late reconciliation must not leave an orphan run record after losing the intent CAS race');

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
