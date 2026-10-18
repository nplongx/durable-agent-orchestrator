import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('github-actions-run-identity-binding-');
const dbPath = path.join(root, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { GitHubActionsProvider } = await import('../src/runtime/github-actions-provider.js');
const { DistributedScheduler } = await import('../src/runtime/distributed-scheduler.js');
const { canonicalProviderDispatchRequest, createProviderDispatchIdentity, providerDispatchKey } = await import('../src/runtime/provider-dispatch-identity.js');
const store = new WorkflowStore();
// Ensure the provider-owned durable intent/run ledger exists before fixtures
// insert the exact dispatch intent used by the real provider boundary.
new GitHubActionsProvider({ token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async () => { throw new Error('schema bootstrap must not perform network requests'); } });
process.on('exit', () => {
  try { store.db.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const input = {
  schema_version: 1, job_id: 'job-run-identity', task_id: 'task-run-identity', lease_id: 'lease-run-identity',
  attempt: 3, owner_epoch: 9, role: 'engineer', input_commit: 'ee24280441c2cf2d8ae4d706a295c90f8fef7bd6',
  task_payload_ref: 'task://run-identity', workspace: 'ephemeral', required_evidence: ['task-payload.json', 'execution.json']
};
const createdAt = new Date().toISOString();
const providerConfig = { provider: 'github-actions', workflow: 'p3-worker.yml', repository: 'example/repo', event: 'workflow_dispatch', ref: 'main' };
function ensureFixtureLease(request) {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  store.db.prepare(`INSERT OR IGNORE INTO jobs
    (job_id,conversation_key,title,state,status,created_at,updated_at)
    VALUES(?,?,?,'active','active',?,?)`)
    .run(request.job_id, `fixture-${request.job_id}`, 'run identity lease fixture', now, now);
  store.db.prepare(`INSERT OR IGNORE INTO tasks
    (task_id,job_id,role,description,status,dependency_json,metadata_json,created_at,updated_at)
    VALUES(?,?,?,'run identity lease fixture','running','[]','{}',?,?)`)
    .run(request.task_id, request.job_id, request.role || 'engineer', now, now);
  store.db.prepare("UPDATE tasks SET execution_attempt=? WHERE task_id=? AND status='running'")
    .run(request.attempt, request.task_id);
  store.db.prepare(`INSERT OR IGNORE INTO task_leases
    (lease_id,task_id,job_id,attempt,worker_id,owner_epoch,state,issued_at,heartbeat_at,expires_at)
    VALUES(?,?,?,?,?,?,'ACTIVE',?,?,?)`)
    .run(request.lease_id, request.task_id, request.job_id, request.attempt, 'run-identity-fixture',
      request.owner_epoch, now, now, expires);
}
function insertIntent(_requestedKey, suffix = '') {
  const identity = { ...input, job_id: `${input.job_id}${suffix}`, task_id: `${input.task_id}${suffix}`, lease_id: `${input.lease_id}${suffix}` };
  ensureFixtureLease(identity);
  const durableIdentity = createProviderDispatchIdentity(identity, providerConfig);
  const dispatchKey = providerDispatchKey(durableIdentity);
  const requestJson = canonicalProviderDispatchRequest(identity);
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
    .run(dispatchKey, durableIdentity.job_id, durableIdentity.task_id, durableIdentity.lease_id, durableIdentity.attempt, durableIdentity.owner_epoch,
      durableIdentity.provider, durableIdentity.input_commit, durableIdentity.request_sha256, requestJson, durableIdentity.api_base, durableIdentity.workflow, durableIdentity.repository,
      durableIdentity.event, durableIdentity.ref, createdAt, createdAt);
  return { ...durableIdentity, request_json: requestJson, dispatch_claim_id: null, dispatch_claimed_at: null,
    dispatch_key: dispatchKey, state: 'DISPATCHING', provider_run_id: null, created_at: createdAt, updated_at: createdAt };
}
function validRun(intent, id, overrides = {}) {
  return {
    id, display_title: `P3 worker ${intent.dispatch_key}`, name: 'P3 worker', status: 'in_progress', conclusion: null,
    html_url: `https://github.com/example/repo/actions/runs/${id}`, created_at: intent.created_at,
    path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
    repository: { full_name: 'example/repo' }, head_sha: intent.input_commit, run_attempt: 1, ...overrides
  };
}
const response = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });

// A successful dispatch response containing a numeric ID is still untrusted.
// An unrelated workflow must not be durably bound to the one-way intent.
const firstIntent = insertIntent('a'.repeat(64));
const key = firstIntent.dispatch_key;
let artifactReads = 0;
const provider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async (url, options = {}) => {
    if (url.endsWith('/dispatches') && options.method === 'POST') return response({ workflow_run_id: 24680 });
    if (url.endsWith('/actions/runs/24680')) return response(validRun(firstIntent, 24680, { path: '.github/workflows/unrelated.yml@refs/heads/main' }));
    if (url.includes('/actions/runs/24680/artifacts')) artifactReads++;
    throw new Error(`unexpected invalid-direct-run request ${url}`);
  }
});
const unresolved = await provider.dispatch({ ...input, dispatch_key: key });
assert.equal(unresolved.pending_reconciliation, true);
assert.equal(unresolved.provider_run_id, null);
assert.equal(store.db.prepare('SELECT state,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(key).state, 'DISPATCHING');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM provider_runs WHERE provider_run_id=?').get('24680').n, 0);
assert.equal(artifactReads, 0);
assert.throws(() => provider._bindDispatchRun(firstIntent, {
  provider_run_id: '24682', job_id: firstIntent.job_id, task_id: firstIntent.task_id.toUpperCase(),
  lease_id: firstIntent.lease_id, attempt: firstIntent.attempt, owner_epoch: firstIntent.owner_epoch,
  input_commit: firstIntent.input_commit, workflow: firstIntent.workflow, ref: firstIntent.ref, run_attempt: 1
}), /durable task_id identity/,
'provider-run binding must not case-fold opaque task identifiers even when all other run fields match');

// Reconciliation of the same intent may bind only the exact workflow/run
// metadata. The validated GitHub run_attempt is stored in the durable ledger.
const reconciledProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async url => {
    if (url.includes('/actions/workflows/p3-worker.yml/runs?')) return response({ workflow_runs: [validRun(firstIntent, 24681)] });
    if (url.endsWith('/actions/runs/24681')) return response(validRun(firstIntent, 24681));
    if (url.includes('/actions/runs/24681/artifacts')) artifactReads++;
    throw new Error(`unexpected reconciliation request ${url}`);
  }
});
const reconciled = await reconciledProvider.reconcileDispatchIntent(firstIntent);
assert.equal(reconciled.provider_run_id, '24681');
const bound = store.db.prepare('SELECT state,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(key);
assert.equal(bound.state, 'DISPATCHED');
assert.equal(bound.provider_run_id, '24681');
assert.equal(store.db.prepare('SELECT run_attempt FROM provider_runs WHERE provider_run_id=?').get('24681').run_attempt, 1);

// A later rerun reuses the GitHub run ID but changes run_attempt. It is not the
// same provider execution; reject before even listing artifacts.
const rerunProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async url => {
    if (url.endsWith('/actions/runs/24681')) return response(validRun(firstIntent, 24681, { run_attempt: 2, status: 'completed', conclusion: 'success' }));
    if (url.includes('/actions/runs/24681/artifacts')) artifactReads++;
    throw new Error(`unexpected rerun request ${url}`);
  }
});
await assert.rejects(() => rerunProvider.collectResult('24681'), /run_attempt changed or lacks a durable initial binding/);
assert.equal(artifactReads, 0, 'a different provider run attempt must be rejected before artifact listing');

// Result bytes can be valid when downloaded but stale by the time the final
// provider-run artifact/output write is about to occur. The post-await fence
// must re-read the live task/lease/parent and immutable dispatch lineage.
const completedObservation = store.db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get('24681');
reconciledProvider._persist({ ...completedObservation, state: 'COMPLETED', conclusion: 'success' });
const collectionResult = {
  job_id: firstIntent.job_id, task_id: firstIntent.task_id, lease_id: firstIntent.lease_id,
  attempt: firstIntent.attempt, owner_epoch: firstIntent.owner_epoch,
  provider_run_attempt: 1, input_commit: firstIntent.input_commit
};
assert.doesNotThrow(() => reconciledProvider._assertP3ResultCollectionLease('24681', collectionResult, firstIntent.owner_epoch),
  'exact active lease and dispatch intent must pass the post-await result fence');
store.db.prepare('UPDATE task_leases SET owner_epoch=? WHERE lease_id=?')
  .run(firstIntent.owner_epoch + 1, firstIntent.lease_id);
assert.throws(() => reconciledProvider._assertP3ResultCollectionLease('24681', collectionResult, firstIntent.owner_epoch),
  /lost its exact active task\/lease\/dispatch fence/,
  'a stale owner epoch discovered after artifact collection must not be persisted as accepted terminal output');
store.db.prepare('UPDATE task_leases SET owner_epoch=? WHERE lease_id=?')
  .run(firstIntent.owner_epoch, firstIntent.lease_id);
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(firstIntent.task_id);
assert.throws(() => reconciledProvider._assertP3ResultCollectionLease('24681', collectionResult, firstIntent.owner_epoch),
  /lost its exact active task\/lease\/dispatch fence/,
  'a late callback must not pass result collection after the task has become terminal');
store.db.prepare("UPDATE tasks SET status='running' WHERE task_id=?").run(firstIntent.task_id);

// End-to-end interleaving: pause after mocked status/artifact listing while a
// competing SQLite writer terminalizes the task and lease, then resume the
// valid evidence download. The final outer writer fence must reject before the
// provider ledger acquires artifact/output metadata for the stale attempt.
const raceIntent = insertIntent('c'.repeat(64), '-collection-race');
const raceRunId = '24682';
reconciledProvider._bindDispatchRun(raceIntent, {
  ...validRun(raceIntent, raceRunId), provider_run_id: raceRunId,
  job_id: raceIntent.job_id, task_id: raceIntent.task_id, lease_id: raceIntent.lease_id,
  attempt: raceIntent.attempt, owner_epoch: raceIntent.owner_epoch, input_commit: raceIntent.input_commit,
  workflow: raceIntent.workflow, ref: raceIntent.ref, run_attempt: 1, state: 'RUNNING', conclusion: null
});
const raceResult = {
  schema_version: 1, job_id: raceIntent.job_id, task_id: raceIntent.task_id, lease_id: raceIntent.lease_id,
  attempt: raceIntent.attempt, owner_epoch: raceIntent.owner_epoch, status: 'SUCCEEDED',
  input_commit: raceIntent.input_commit, output_commit: raceIntent.input_commit, exit_code: 0,
  provider_run_id: raceRunId, provider_run_attempt: 1, evidence_artifact: `p3-worker-${raceRunId}`,
  evidence_refs: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'],
  started_at: '2026-10-16T12:00:00.000Z', finished_at: '2026-10-16T12:00:01.000Z', error: null
};
const racePayload = {
  schema_version: 1, job_id: raceIntent.job_id, task_id: raceIntent.task_id, lease_id: raceIntent.lease_id,
  attempt: raceIntent.attempt, owner_epoch: raceIntent.owner_epoch, role: JSON.parse(raceIntent.request_json).role,
  required_evidence: JSON.parse(raceIntent.request_json).required_evidence
};
const raceStdout = Buffer.from('P3_EXECUTION_OK\n');
const raceStderr = Buffer.from('');
const raceGitStatus = Buffer.from('\n');
const raceExecution = {
  task_id: raceIntent.task_id, exit_code: 0, timed_out: false, output_commit: raceResult.output_commit,
  stdout_bytes: raceStdout.length, stderr_bytes: raceStderr.length, git_status_bytes: raceGitStatus.length,
  stdout_sha256: crypto.createHash('sha256').update(raceStdout).digest('hex'),
  stderr_sha256: crypto.createHash('sha256').update(raceStderr).digest('hex'),
  git_status_sha256: crypto.createHash('sha256').update(raceGitStatus).digest('hex')
};
const raceEvidence = {
  'task-payload.json': racePayload, 'execution.json': raceExecution,
  'stdout.txt': raceStdout.toString('utf8'), 'stderr.txt': raceStderr.toString('utf8'), 'git-status.txt': raceGitStatus.toString('utf8')
};
const raceEvidenceBytes = {
  'result.json': Buffer.from(`${JSON.stringify(raceResult, null, 2)}\n`),
  'task-payload.json': Buffer.from(`${JSON.stringify(racePayload, null, 2)}\n`),
  'execution.json': Buffer.from(`${JSON.stringify(raceExecution, null, 2)}\n`),
  'stdout.txt': raceStdout, 'stderr.txt': raceStderr, 'git-status.txt': raceGitStatus
};
let downloadEntered;
const downloadStarted = new Promise(resolve => { downloadEntered = resolve; });
let resumeDownload;
const downloadRelease = new Promise(resolve => { resumeDownload = resolve; });
const raceCollector = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  taskPayloadSourceReader: async () => raceEvidenceBytes['task-payload.json'],
  fetchImpl: async url => {
    if (url.endsWith(`/actions/runs/${raceRunId}`)) return response(validRun(raceIntent, raceRunId,
      { status: 'completed', conclusion: 'success' }));
    if (url.includes(`/actions/runs/${raceRunId}/artifacts`)) return response({ artifacts: [{
      id: 82, name: `p3-worker-${raceRunId}`, expired: false, archive_download_url: 'https://artifact.test/82'
    }] });
    throw new Error(`unexpected collection-race request ${url}`);
  },
  artifactDownloader: async () => {
    downloadEntered();
    await downloadRelease;
    return { result: raceResult, evidence: raceEvidence, evidence_bytes: raceEvidenceBytes };
  }
});
const collectingRace = raceCollector.collectResult(raceRunId);
await downloadStarted;
const competingDb = new DatabaseSync(dbPath, { timeout: 5000 });
competingDb.exec('BEGIN IMMEDIATE');
try {
  competingDb.prepare("UPDATE tasks SET status='failed' WHERE task_id=? AND status='running'").run(raceIntent.task_id);
  competingDb.prepare("UPDATE task_leases SET state='FAILED' WHERE lease_id=? AND state='ACTIVE'").run(raceIntent.lease_id);
  competingDb.exec('COMMIT');
} catch (error) {
  try { competingDb.exec('ROLLBACK'); } catch {}
  throw error;
} finally { competingDb.close(); }
resumeDownload();
await assert.rejects(() => collectingRace, /lost its exact active task\/lease\/dispatch fence/,
  'a valid artifact collected across a task-terminalization race must not be persisted as accepted result evidence');
const afterCollectionRace = store.db.prepare('SELECT state,conclusion,artifact_id,output_commit FROM provider_runs WHERE provider_run_id=?').get(raceRunId);
assert.equal(afterCollectionRace.state, 'COMPLETED', 'the provider status observation may remain durable');
assert.equal(afterCollectionRace.conclusion, 'success');
assert.equal(afterCollectionRace.artifact_id, null, 'stale collection must not attach an artifact after task terminalization');
assert.equal(afterCollectionRace.output_commit, null, 'stale collection must not attach output commit after task terminalization');

// Prove native DatabaseSync uses a real transaction boundary: SIGKILL after the
// intent CAS but before provider_runs insert must roll both changes back.
const crashIntent = insertIntent('b'.repeat(64), '-crash');
const crashKey = crashIntent.dispatch_key;
const crashRun = {
  provider_run_id: '77777', job_id: crashIntent.job_id, task_id: crashIntent.task_id, lease_id: crashIntent.lease_id,
  attempt: crashIntent.attempt, owner_epoch: crashIntent.owner_epoch, input_commit: crashIntent.input_commit, workflow: 'p3-worker.yml', ref: 'main',
  state: 'RUNNING', conclusion: null, html_url: null, created_at: crashIntent.created_at, run_attempt: 1
};
const providerModuleUrl = new URL('../src/runtime/github-actions-provider.js', import.meta.url).href;
const storeModuleUrl = new URL('../src/runtime/job-store.js', import.meta.url).href;
const childSource = `
  const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
  const { GitHubActionsProvider } = await import(${JSON.stringify(providerModuleUrl)});
  const s = new WorkflowStore();
  const p = new GitHubActionsProvider({ token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: s, fetchImpl: async () => { throw new Error('no network expected'); } });
  const intent = s.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(${JSON.stringify(crashKey)});
  p._bindDispatchRun(intent, ${JSON.stringify(crashRun)});
`;
const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
  env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: root, WORKFLOW_WORKSPACE: root,
    NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_CRASH_AFTER_PROVIDER_INTENT_BIND_CAS: 'SIGKILL' }
});
assert.equal(crashed.signal, 'SIGKILL', `binding child should die inside the savepoint: ${crashed.stderr}`);
const afterCrash = store.db.prepare('SELECT state,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(crashKey);
assert.equal(afterCrash.state, 'DISPATCHING', 'intent binding must roll back on process death before provider-run insert');
assert.equal(afterCrash.provider_run_id, null, 'process death must not leave a partially bound provider run');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM provider_runs WHERE provider_run_id=?').get('77777').n, 0);
const recoveredRun = provider._bindDispatchRun(crashIntent, crashRun);
assert.equal(recoveredRun.provider_run_id, '77777');
const afterRecovery = store.db.prepare('SELECT state,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(crashKey);
assert.equal(afterRecovery.state, 'DISPATCHED');
assert.equal(afterRecovery.provider_run_id, '77777');
const recoveredLedger = store.db.prepare('SELECT run_attempt,dispatch_key,request_sha256 FROM provider_runs WHERE provider_run_id=?').get('77777');
assert.equal(recoveredLedger.run_attempt, 1);
assert.equal(recoveredLedger.dispatch_key, crashKey, 'provider result ledger must preserve the exact winning dispatch key');
assert.equal(recoveredLedger.request_sha256, crashIntent.request_sha256, 'provider result ledger must preserve complete execution-request binding');
assert.throws(() => provider._persist({ ...crashRun, dispatch_key: crashKey, request_sha256: 'f'.repeat(64) }),
  /immutable request_sha256 binding conflicts/,
  'late/stale writes must not replace the winning request digest for a reused provider run id');
assert.equal(store.db.prepare('SELECT request_sha256 FROM provider_runs WHERE provider_run_id=?').get('77777').request_sha256, crashIntent.request_sha256);
provider._persist({ ...crashRun, dispatch_key: crashKey, request_sha256: crashIntent.request_sha256,
  state: 'COMPLETED', conclusion: 'success', artifact_id: 'artifact-good', output_commit: 'a'.repeat(40) });
const terminalBeforeConflict = store.db.prepare('SELECT state,conclusion,artifact_id,output_commit,run_attempt FROM provider_runs WHERE provider_run_id=?').get('77777');
assert.throws(() => provider._persist({ ...crashRun, dispatch_key: crashKey, request_sha256: crashIntent.request_sha256,
  state: 'COMPLETED', conclusion: 'failure', artifact_id: 'artifact-conflicting', output_commit: 'b'.repeat(40) }),
/incoming state\/conclusion conflicts with durable terminal state/,
'contradictory terminal persistence must be rejected before changing the durable row');
assert.deepEqual(store.db.prepare('SELECT state,conclusion,artifact_id,output_commit,run_attempt FROM provider_runs WHERE provider_run_id=?').get('77777'),
  terminalBeforeConflict, 'failed terminal conflict must roll back all state, artifact, and output mutations');
assert.throws(() => provider._persist({ ...crashRun, dispatch_key: crashKey, request_sha256: crashIntent.request_sha256,
  state: 'COMPLETED', conclusion: 'success', artifact_id: 'artifact-substituted', output_commit: 'b'.repeat(40) }),
/incoming artifact_id conflicts with durable terminal evidence/,
'same-conclusion terminal polling must not replace already-bound artifact/output evidence');
assert.deepEqual(store.db.prepare('SELECT state,conclusion,artifact_id,output_commit,run_attempt FROM provider_runs WHERE provider_run_id=?').get('77777'),
  terminalBeforeConflict, 'conflicting terminal evidence must not mutate the provider-run ledger');
assert.throws(() => provider._persist({ ...crashRun, dispatch_key: crashKey, request_sha256: crashIntent.request_sha256,
  state: 'RUNNING', conclusion: null, artifact_id: 'artifact-stale' }),
/incoming state\/conclusion conflicts with durable terminal state/,
'a stale nonterminal poll must not update metadata on a terminal provider run');
assert.deepEqual(store.db.prepare('SELECT state,conclusion,artifact_id,output_commit,run_attempt FROM provider_runs WHERE provider_run_id=?').get('77777'),
  terminalBeforeConflict, 'stale nonterminal poll must leave terminal ledger unchanged');

// The scheduler must not release a lease after an ambiguous provider failure
// merely because dispatch() threw; a definite pre-send rejection remains safe
// to release. Both cases use real SQLite and local provider doubles only.
const schedulerJob = store.createJob({ conversationKey: `provider-ambiguous-${process.pid}`, title: 'Ambiguous dispatch recovery fixture' });
const ambiguousTask = store.ensureTask(schedulerJob.job_id, { role: 'executor', description: 'preserve lease after ambiguous dispatch' });
const ambiguousScheduler = new DistributedScheduler({
  store, workerId: `ambiguous-worker-${process.pid}`,
  provider: { dispatch: async () => { throw Object.assign(new Error('simulated timeout after remote acceptance'), { remoteOutcome: 'ambiguous' }); } }
});
const ambiguous = await ambiguousScheduler.dispatchTask(ambiguousTask, { inputCommit: input.input_commit });
assert.equal(ambiguous.pending_reconciliation, true);
assert.equal(store.getTaskLease(ambiguous.lease.lease_id).state, 'ACTIVE');
assert.equal(store.getTask(ambiguousTask.task_id).status, 'running');
assert.equal(store.db.prepare('SELECT state FROM provider_dispatch_intents WHERE lease_id=?').get(ambiguous.lease.lease_id).state, 'DISPATCHING');

const rejectedJob = store.createJob({ conversationKey: `provider-rejected-${process.pid}`, title: 'Definite pre-send rejection fixture' });
const rejectedTask = store.ensureTask(rejectedJob.job_id, { role: 'executor', description: 'release lease after definite pre-send rejection' });
const rejectedScheduler = new DistributedScheduler({
  store, workerId: `rejected-worker-${process.pid}`,
  provider: { dispatch: async () => { throw Object.assign(new Error('simulated local validation failure'), { remoteOutcome: 'not_sent' }); } }
});
await assert.rejects(() => rejectedScheduler.dispatchTask(rejectedTask, { inputCommit: input.input_commit }), /simulated local validation failure/);
const rejectedLease = store.db.prepare('SELECT * FROM task_leases WHERE task_id=? ORDER BY issued_at DESC LIMIT 1').get(rejectedTask.task_id);
assert.equal(rejectedLease.state, 'EXPIRED');
assert.equal(store.getTask(rejectedTask.task_id).status, 'pending');

// Concurrent status polls may resolve out of order across processes. A stale
// in_progress response must not roll a terminal row back to RUNNING or erase
// artifact/output lineage already persisted by a result collector.
const staleStatusIntent = insertIntent('c'.repeat(64), '-stale-status');
const staleStatusKey = staleStatusIntent.dispatch_key;
const staleStatusRunId = '88888';
store.db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHED',provider_run_id=?,updated_at=? WHERE dispatch_key=?`)
  .run(staleStatusRunId, new Date().toISOString(), staleStatusKey);
const staleStatusProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: (() => {
    let calls = 0;
    let releaseStale;
    const staleGate = new Promise(resolve => { releaseStale = resolve; });
    const fetch = async url => {
      assert.ok(url.endsWith(`/actions/runs/${staleStatusRunId}`));
      if (calls++ === 0) {
        await staleGate;
        return response(validRun(staleStatusIntent, staleStatusRunId, { status: 'in_progress', conclusion: null }));
      }
      return response(validRun(staleStatusIntent, staleStatusRunId, { status: 'completed', conclusion: 'success' }));
    };
    fetch.releaseStale = releaseStale;
    return fetch;
  })()
});
staleStatusProvider._persist({
  provider_run_id: staleStatusRunId, job_id: staleStatusIntent.job_id, task_id: staleStatusIntent.task_id,
  lease_id: staleStatusIntent.lease_id, attempt: staleStatusIntent.attempt, owner_epoch: staleStatusIntent.owner_epoch, input_commit: staleStatusIntent.input_commit,
  dispatch_key: staleStatusKey, request_sha256: staleStatusIntent.request_sha256,
  workflow: 'p3-worker.yml', ref: 'main', state: 'RUNNING', conclusion: null, run_attempt: 1,
  artifact_id: 'artifact-88888', output_commit: 'd'.repeat(40), created_at: staleStatusIntent.created_at
});
const stalePoll = staleStatusProvider.getStatus(staleStatusRunId);
const terminalPoll = await staleStatusProvider.getStatus(staleStatusRunId);
assert.equal(terminalPoll.state, 'COMPLETED');
// Resolve the earlier request only after the completed response was persisted.
staleStatusProvider.fetch.releaseStale();
await assert.rejects(() => stalePoll, /(?:contradicts the durable terminal run state\/conclusion|incoming state\/conclusion conflicts with durable terminal state)/,
  'a delayed nonterminal response must not be returned after another process durably records terminal completion');
const afterOutOfOrderPolls = store.db.prepare('SELECT state,conclusion,artifact_id,output_commit FROM provider_runs WHERE provider_run_id=?').get(staleStatusRunId);
assert.equal(afterOutOfOrderPolls.state, 'COMPLETED', 'late stale poll must not downgrade the durable terminal state');
assert.equal(afterOutOfOrderPolls.conclusion, 'success', 'late stale poll must not erase the terminal conclusion');
assert.equal(afterOutOfOrderPolls.artifact_id, 'artifact-88888', 'late status poll must not erase the verified artifact pointer');
assert.equal(afterOutOfOrderPolls.output_commit, 'd'.repeat(40), 'late status poll must not erase the bound output commit');

// Two terminal callbacks can also resolve out of order with contradictory
// conclusions. The first response is delayed as a failure while a later poll
// commits success; the delayed failure must be rejected without changing the
// terminal conclusion or already-bound evidence pointers.
const conflictingTerminalIntent = insertIntent('d'.repeat(64), '-conflicting-terminal-status');
const conflictingTerminalKey = conflictingTerminalIntent.dispatch_key;
const conflictingTerminalRunId = '88889';
store.db.prepare("UPDATE provider_dispatch_intents SET state='DISPATCHED',provider_run_id=?,updated_at=? WHERE dispatch_key=?")
  .run(conflictingTerminalRunId, new Date().toISOString(), conflictingTerminalKey);
let releaseFailureObservation;
const failureObservationGate = new Promise(resolve => { releaseFailureObservation = resolve; });
let conflictingPollCount = 0;
const conflictingTerminalProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async url => {
    assert.ok(url.endsWith(`/actions/runs/${conflictingTerminalRunId}`));
    if (conflictingPollCount++ === 0) {
      await failureObservationGate;
      return response(validRun(conflictingTerminalIntent, conflictingTerminalRunId, { status: 'completed', conclusion: 'failure' }));
    }
    return response(validRun(conflictingTerminalIntent, conflictingTerminalRunId, { status: 'completed', conclusion: 'success' }));
  }
});
conflictingTerminalProvider._persist({
  provider_run_id: conflictingTerminalRunId, job_id: conflictingTerminalIntent.job_id,
  task_id: conflictingTerminalIntent.task_id, lease_id: conflictingTerminalIntent.lease_id,
  attempt: conflictingTerminalIntent.attempt, owner_epoch: conflictingTerminalIntent.owner_epoch,
  input_commit: conflictingTerminalIntent.input_commit, dispatch_key: conflictingTerminalKey,
  request_sha256: conflictingTerminalIntent.request_sha256, workflow: 'p3-worker.yml', ref: 'main',
  state: 'RUNNING', conclusion: null, run_attempt: 1,
  artifact_id: 'artifact-conflicting-terminal', output_commit: 'e'.repeat(40), created_at: conflictingTerminalIntent.created_at
});
const delayedFailurePoll = conflictingTerminalProvider.getStatus(conflictingTerminalRunId);
assert.equal((await conflictingTerminalProvider.getStatus(conflictingTerminalRunId)).conclusion, 'success');
releaseFailureObservation();
await assert.rejects(() => delayedFailurePoll, /(?:contradicts the durable terminal run state\/conclusion|incoming state\/conclusion conflicts with durable terminal state)/,
  'a late contradictory terminal conclusion must not replace a committed provider-run outcome');
const preservedTerminal = store.db.prepare('SELECT state,conclusion,artifact_id,output_commit FROM provider_runs WHERE provider_run_id=?').get(conflictingTerminalRunId);
assert.equal(preservedTerminal.state, 'COMPLETED');
assert.equal(preservedTerminal.conclusion, 'success');
assert.equal(preservedTerminal.artifact_id, 'artifact-conflicting-terminal');
assert.equal(preservedTerminal.output_commit, 'e'.repeat(40));

console.log('GITHUB ACTIONS DIRECT-RUN IDENTITY, RUN-ATTEMPT PINNING, SIGKILL ATOMICITY, AND AMBIGUOUS DISPATCH RECOVERY PASS');
// Keep exact workflow/repository/event/ref binding in the integrated workflow
// regression set, not only as a separately invokable adversarial test.
await import('./test-github-actions-dispatch-intent-config-binding.js');
const dispatchConcurrency = spawnSync(process.execPath, [fileURLToPath(new URL('./test-github-actions-dispatch-concurrency.js', import.meta.url))], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 45000,
  env: { ...process.env, PHASE2_PRE_FIX_SYNCHRONIZED_DISPATCH_REPRO: '0' }
});
assert.equal(dispatchConcurrency.status, 0,
  `independent-process dispatch/claim crash regression failed\nstdout=${dispatchConcurrency.stdout}\nstderr=${dispatchConcurrency.stderr}`);
process.stdout.write(dispatchConcurrency.stdout);
