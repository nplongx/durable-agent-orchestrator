import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { tempDir } from './test-temp-dir.js';
import { collectCase01SnapshotReferences, createCase01WorkspaceSnapshot, reconcileCase01WorkspaceSnapshots, removeCase01WorkspaceSnapshot, validateCase01WorkspaceArtifact, validateCase01DurableSnapshotReferences } from '../src/runtime/workflow/case01-artifact-acceptance.js';

const root = tempDir('case01-artifact-transaction-');
const dbPath = path.join(root, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_WORKSPACE = path.join(root, 'workspace');
fs.mkdirSync(process.env.WORKFLOW_WORKSPACE, { recursive: true });

const { WorkflowStore, conversationKeyFromMessages } = await import('../src/runtime/job-store.js');
const store = new WorkflowStore();
const job = store.createJob({
  conversationKey: conversationKeyFromMessages([{ role: 'user', content: 'CASE-01 transaction rollback fixture' }]),
  title: 'Engineering M4 CASE-01 transaction rollback fixture'
});
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'approved for offline fixture');
const plan = store.getExecutionPlan(job.job_id);
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'Offline transaction fixture' });
const engineerSpec = plan.children.find(item => item.role === 'engineer');
const task = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id,
  role: 'engineer',
  description: 'Exercise transaction rollback hook',
  metadata: { ...(engineerSpec.execution || {}), workflow_plan_task_id: engineerSpec.id }
});
store.beginLocalTask(task.task_id);

assert.throws(() => store.completeLocalTask(task.task_id, {
  content: 'synthetic transaction rollback fixture',
  outcome: 'success',
  artifact: {
    summary: 'Fixture only', files_changed: [], verification: ['fixture'],
    execution: { mode: 'chat-on-steroids-local-tools', exit_code: null, session_id: null, evidence_refs: ['test:rollback'] }
  },
  validateBeforeCommit: ({ resultId, artifactId }) => {
    assert.ok(resultId);
    assert.ok(artifactId);
    assert.equal(store.db.prepare('SELECT outcome FROM results WHERE result_id=?').get(resultId)?.outcome, 'success');
    assert.equal(store.getArtifact(artifactId)?.task_id, task.task_id);
    throw new Error('forced CASE-01 acceptance rejection');
  }
}), /forced CASE-01 acceptance rejection/);

assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n, 0);
assert.equal(store.listArtifacts(job.job_id, { taskId: task.task_id, activeOnly: true }).length, 0);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE job_id=?').get(job.job_id).n, 0);
assert.equal(store.getTask(task.task_id).status, 'running');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(task.task_id).n, 1);

const artifact = {
  summary: 'Fixture only', files_changed: [], verification: ['fixture'],
  execution: { mode: 'chat-on-steroids-local-tools', exit_code: null, session_id: null, evidence_refs: ['test:rollback'] }
};
const successful = store.completeLocalTask(task.task_id, { content: 'synthetic transaction rollback fixture', outcome: 'success', artifact });
assert.ok(successful.resultId);
const idempotentRetry = store.completeLocalTask(task.task_id, {
  content: 'synthetic transaction rollback fixture', outcome: 'success', artifact
});
assert.throws(() => store.completeLocalTask(task.task_id, {
  content: 'synthetic transaction rollback fixture', outcome: 'success', artifact,
  validateBeforeCommit: () => { throw new Error('forced idempotent acceptance rejection'); }
}), /forced idempotent acceptance rejection/);
assert.equal(idempotentRetry.idempotent, true);
assert.equal(idempotentRetry.resultId, successful.resultId, 'idempotent retry must return the exact durable result identity');
assert.throws(() => store.completeLocalTask(task.task_id, {
  content: 'synthetic transaction rollback fixture', outcome: 'success',
  artifact: { ...artifact, summary: 'Conflicting retry artifact' },
}), /conflicts with its durable typed artifact/,
  'same result text must not make a retry idempotent when its typed artifact differs');
assert.equal(store.getArtifact(`implementation-${successful.resultId}`).content.summary, 'Fixture only',
  'a conflicting retry must not replace or mutate the original typed artifact');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n, 1);
assert.equal(store.getTask(task.task_id).status, 'completed');

// End-to-end deterministic interleaving: snapshot finalization occurs, a writer
// changes the live workspace before SQLite completion, and the durable typed
// artifact is accepted only against the snapshot bytes it names.
const workspace = process.env.WORKFLOW_WORKSPACE;
fs.writeFileSync(path.join(workspace, 'config.json'), '{"service":"snapshot-source","port":43127}');
fs.writeFileSync(path.join(workspace, 'result.json'), '{"validated":true,"service":"snapshot-source"}');
const snapshotBase = path.join(root, 'case01-snapshots');
fs.mkdirSync(snapshotBase, { recursive: true, mode: 0o700 });
const snapshotSeed = { workspace_artifacts: [
  { path: 'config.json', sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(workspace, 'config.json'))).digest('hex') },
  { path: 'result.json', sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(workspace, 'result.json'))).digest('hex') }
] };
const snapshot = createCase01WorkspaceSnapshot({ workspace, content: snapshotSeed, snapshotBase });
const snapshotArtifact = {
  summary: 'Finalized snapshot fixture', files_changed: [], verification: ['snapshot hash verified'],
  execution: { mode: 'chat-on-steroids-local-tools', exit_code: null, session_id: null, evidence_refs: ['test:case01-snapshot'] },
  workspace_snapshot_id: snapshot.snapshot_id, workspace_artifacts: snapshot.workspace_artifacts
};
const secondTask = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id, role: 'engineer', description: 'Persist immutable snapshot evidence',
  metadata: { ...(engineerSpec.execution || {}), workflow_plan_task_id: engineerSpec.id }
});
store.beginLocalTask(secondTask.task_id);
fs.writeFileSync(path.join(workspace, 'config.json'), '{"service":"late-writer","port":43127}');
const snapshotCompletion = store.completeLocalTask(secondTask.task_id, {
  content: 'snapshot-backed completion', artifact: snapshotArtifact,
  validateBeforeCommit: ({ resultId, artifactId }) => {
    const persisted = store.getArtifact(artifactId);
    assert.equal(persisted.content.workspace_snapshot_id, snapshot.snapshot_id);
    assert.deepEqual(validateCase01WorkspaceArtifact({ workspace, content: persisted.content, snapshotBase, snapshotId: snapshot.snapshot_id }), snapshot.workspace_artifacts);
    assert.equal(store.db.prepare('SELECT task_id, outcome FROM results WHERE result_id=?').get(resultId)?.task_id, secondTask.task_id);
  }
});
assert.ok(snapshotCompletion.resultId);
const durableSnapshotArtifact = store.getArtifact(`implementation-${snapshotCompletion.resultId}`);
assert.equal(durableSnapshotArtifact.content.workspace_snapshot_id, snapshot.snapshot_id);
assert.deepEqual(durableSnapshotArtifact.content.workspace_artifacts, snapshot.workspace_artifacts);
fs.writeFileSync(path.join(workspace, 'result.json'), '{"validated":false,"service":"post-commit-writer"}');
assert.deepEqual(validateCase01WorkspaceArtifact({ workspace, content: durableSnapshotArtifact.content, snapshotBase, snapshotId: snapshot.snapshot_id }), snapshot.workspace_artifacts);
console.log('PASS: deterministic late workspace writer interleaving persists a typed artifact bound to exact finalized snapshot bytes');

// Corrupt duplicate active attempts must not let a direct local completion pick
// the newest row and strand another started attempt behind a terminal task.
const ambiguousTask = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id, role: 'engineer', description: 'Reject ambiguous local attempt lineage',
  metadata: { ...(engineerSpec.execution || {}), workflow_plan_task_id: engineerSpec.id }
});
const ambiguousStart = store.beginLocalTask(ambiguousTask.task_id);
const injectedAttemptId = `attempt-duplicate-local-${process.pid}`;
store.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?,?,'started',NULL,?)")
  .run(injectedAttemptId, ambiguousTask.task_id, new Date(Date.now() + 1).toISOString());
assert.throws(() => store.beginLocalTask(ambiguousTask.task_id), /ambiguous active durable attempts/);
assert.throws(() => store.completeLocalTask(ambiguousTask.task_id, {
  content: 'must not complete with two active attempts', outcome: 'failed'
}), /requires exactly one active durable attempt/);
assert.equal(store.getTask(ambiguousTask.task_id).status, 'running');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(ambiguousTask.task_id).n, 0);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(ambiguousTask.task_id).n, 2);
store.db.prepare('DELETE FROM attempts WHERE attempt_id=?').run(injectedAttemptId);
const settledAmbiguousTask = store.completeLocalTask(ambiguousTask.task_id, {
  content: 'settle the sole canonical local attempt after removing injected corruption', outcome: 'failed'
});
assert.ok(settledAmbiguousTask.resultId);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(ambiguousTask.task_id).n, 0);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.local_failed' AND json_extract(payload_json,'$.resultId')=?")
  .get(job.job_id, settledAmbiguousTask.resultId).n, 1);
console.log('PASS: duplicate active local attempts fail closed and canonical completion settles one exact result/attempt/event lineage');

const failedTask = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id, role: 'engineer', description: 'Compensate snapshot after rollback',
  metadata: { ...(engineerSpec.execution || {}), workflow_plan_task_id: engineerSpec.id }
});
store.beginLocalTask(failedTask.task_id);
const failedSnapshot = createCase01WorkspaceSnapshot({
  workspace,
  content: { workspace_artifacts: [
    { path: 'config.json', sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(workspace, 'config.json'))).digest('hex') },
    { path: 'result.json', sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(workspace, 'result.json'))).digest('hex') }
  ] }, snapshotBase
});
assert.throws(() => store.completeLocalTask(failedTask.task_id, {
  content: 'injected rollback after snapshot creation',
  artifact: { ...snapshotArtifact, workspace_snapshot_id: failedSnapshot.snapshot_id, workspace_artifacts: failedSnapshot.workspace_artifacts },
  validateBeforeCommit: () => { throw new Error('injected durable acceptance failure'); }
}), /injected durable acceptance failure/);
assert.equal(store.getTask(failedTask.task_id).status, 'running');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(failedTask.task_id).n, 0);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE task_id=?').get(failedTask.task_id).n, 0);
assert.equal(removeCase01WorkspaceSnapshot({ snapshotBase, snapshotId: failedSnapshot.snapshot_id }), true);
assert.equal(fs.existsSync(path.join(snapshotBase, failedSnapshot.snapshot_id)), false);
console.log('PASS: injected SQLite rollback leaves no durable result/artifact and the unreferenced snapshot can be compensated safely');

// Durable reference discovery must fail closed for malformed IDs/JSON instead
// of treating an unparseable artifact as an unreferenced snapshot.
assert.throws(() => collectCase01SnapshotReferences([{ content: { workspace_snapshot_id: '../escape' } }]), /invalid workspace_snapshot_id/);
assert.throws(() => collectCase01SnapshotReferences([{ content: '{"workspace_snapshot_id":' }]), /reference is malformed/);
assert.throws(() => collectCase01SnapshotReferences([{ content: `{"workspace_snapshot_id":"${snapshot.snapshot_id}","workspace_snapshot_\\u0069d":"00000000-0000-4000-8000-000000000001"}` }]), /repeats workspace_snapshot_id/,
  'duplicate JSON reference keys, including Unicode-escaped spellings, must not hide an earlier durable snapshot reference');
assert.throws(() => validateCase01DurableSnapshotReferences({
  artifactRows: [{ content: `{"workspace_snapshot_id":"${snapshot.snapshot_id}","workspace_snapshot_\\u0069d":"00000000-0000-4000-8000-000000000001"}` }],
  snapshotBase,
}), /repeats workspace_snapshot_id/,
  'recovery must reject ambiguous duplicate snapshot references before any orphan collection');
assert.deepEqual([...collectCase01SnapshotReferences([{ content: { workspace_snapshot_id: snapshot.snapshot_id } }])], [snapshot.snapshot_id]);

// Recovery verifies every durable reference against actual finalized bytes.
// Missing or corrupted snapshots must block reconciliation, not be silently
// treated as already-reconciled state merely because no orphan directory exists.
assert.deepEqual([...validateCase01DurableSnapshotReferences({
  artifactRows: [{ content: snapshotArtifact }], snapshotBase,
})], [snapshot.snapshot_id]);
const missingSnapshot = createCase01WorkspaceSnapshot({ workspace, content: {
  workspace_artifacts: [
    { path: 'config.json', sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(workspace, 'config.json'))).digest('hex') },
    { path: 'result.json', sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(workspace, 'result.json'))).digest('hex') },
  ],
}, snapshotBase });
const missingReference = { workspace_snapshot_id: missingSnapshot.snapshot_id, workspace_artifacts: missingSnapshot.workspace_artifacts };
removeCase01WorkspaceSnapshot({ snapshotBase, snapshotId: missingSnapshot.snapshot_id });
assert.throws(() => validateCase01DurableSnapshotReferences({ artifactRows: [{ content: missingReference }], snapshotBase }), /ENOENT|no such file/i,
  'durable reference to a missing snapshot must fail closed during recovery');
assert.throws(() => validateCase01DurableSnapshotReferences({
  artifactRows: [{ content: missingReference }], snapshotBase: path.join(root, 'snapshot-base-missing-entirely'),
}), /ENOENT|no such file/i, 'durable reference must fail closed even when the entire snapshot base is missing');
const corruptSnapshot = createCase01WorkspaceSnapshot({ workspace, content: {
  workspace_artifacts: [
    { path: 'config.json', sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(workspace, 'config.json'))).digest('hex') },
    { path: 'result.json', sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(workspace, 'result.json'))).digest('hex') },
  ],
}, snapshotBase });
const corruptReference = { workspace_snapshot_id: corruptSnapshot.snapshot_id, workspace_artifacts: corruptSnapshot.workspace_artifacts };
fs.chmodSync(path.join(snapshotBase, corruptSnapshot.snapshot_id), 0o700);
fs.chmodSync(path.join(snapshotBase, corruptSnapshot.snapshot_id, 'config.json'), 0o600);
fs.writeFileSync(path.join(snapshotBase, corruptSnapshot.snapshot_id, 'config.json'), 'tampered after snapshot finalization');
fs.chmodSync(path.join(snapshotBase, corruptSnapshot.snapshot_id, 'config.json'), 0o400);
fs.chmodSync(path.join(snapshotBase, corruptSnapshot.snapshot_id), 0o500);
assert.throws(() => validateCase01DurableSnapshotReferences({ artifactRows: [{ content: corruptReference }], snapshotBase }), /mismatch|hashing|changed/i,
  'durable reference to altered bytes must fail closed during recovery');
removeCase01WorkspaceSnapshot({ snapshotBase, snapshotId: corruptSnapshot.snapshot_id });
console.log('PASS: recovery fails closed when a durable snapshot reference is missing or its exact finalized bytes have changed');

// Cleanup of an adversarial-but-static symlink tree must not touch its target.
const cleanupSentinel = path.join(root, 'outside-snapshot-sentinel.txt');
const cleanupRootId = (await import('node:crypto')).randomUUID();
const cleanupRoot = path.join(snapshotBase, cleanupRootId);
fs.mkdirSync(cleanupRoot, { mode: 0o700 });
fs.writeFileSync(cleanupSentinel, 'outside bytes must survive cleanup refusal');
fs.symlinkSync(cleanupSentinel, path.join(cleanupRoot, 'config.json'));
assert.throws(() => removeCase01WorkspaceSnapshot({ snapshotBase, snapshotId: cleanupRootId }), /refuses symlinks/);
assert.equal(fs.readFileSync(cleanupSentinel, 'utf8'), 'outside bytes must survive cleanup refusal');
assert.equal(fs.lstatSync(path.join(cleanupRoot, 'config.json')).isSymbolicLink(), true);
fs.rmSync(cleanupRoot, { recursive: true, force: true });
console.log('PASS: malformed durable snapshot references fail closed and cleanup refuses symlink targets without modifying external bytes');

// Reconciliation must retain snapshots that are durably referenced, even when
// they are older than the orphan grace period, and report untrusted entries.
const legacyName = path.join(snapshotBase, 'not-a-snapshot-id');
fs.mkdirSync(legacyName);
const reconcile = reconcileCase01WorkspaceSnapshots({
  snapshotBase, referencedSnapshotIds: [snapshot.snapshot_id], reservedSnapshotIds: [],
  minOrphanAgeMs: 0, nowMs: Date.now() + 10_000
});
assert.ok(reconcile.preserved.some(item => item.snapshot_id === snapshot.snapshot_id && item.reason === 'durable-reference'));
assert.ok(reconcile.preserved.some(item => item.snapshot_id === 'not-a-snapshot-id' && item.reason === 'non-snapshot-name'));
assert.equal(fs.existsSync(path.join(snapshotBase, snapshot.snapshot_id)), true);
fs.rmSync(legacyName, { recursive: true, force: true });
console.log('PASS: orphan reconciliation preserves durable references and does not collect untrusted non-UUID entries');

// Bind the runtime's reference read to its SQLite writer lock and verify that a
// second connection cannot commit into the gap before reservation enumeration.
const serverSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const reconcileStart = serverSource.indexOf('function reconcileCase01SnapshotStore()');
const reconcileEnd = serverSource.indexOf('// Reservations are committed before any snapshot bytes are created.', reconcileStart);
assert.ok(reconcileStart >= 0 && reconcileEnd > reconcileStart, 'snapshot reconciliation function must remain discoverable for its ordering invariant');
const reconcileSource = serverSource.slice(reconcileStart, reconcileEnd);
const lockOffset = reconcileSource.indexOf("workflowStore.db.exec('BEGIN IMMEDIATE')");
const referenceReadOffset = reconcileSource.indexOf('validateCase01DurableSnapshotReferences(');
const reservationReadOffset = reconcileSource.indexOf("SELECT snapshot_id, owner_pid, created_at FROM case01_snapshot_reservations");
assert.ok(lockOffset >= 0 && lockOffset < referenceReadOffset && lockOffset < reservationReadOffset,
  'SQLite writer lock must begin before durable references are validated or reservations are read');
store.db.exec('BEGIN IMMEDIATE');
const contender = new DatabaseSync(dbPath, { timeout: 0 });
try {
  assert.throws(() => contender.exec('BEGIN IMMEDIATE'), /locked|busy/i,
    'a concurrent writer must not interleave while snapshot reconciliation owns the SQLite writer lock');
} finally {
  contender.close();
  store.db.exec('ROLLBACK');
}
console.log('PASS: reconciliation acquires SQLite writer serialization before reference/reservation reads; concurrent writers cannot interleave the cleanup decision');

// Compensation after a failed completion has the same database/filesystem
// interleaving hazard as periodic reconciliation. Keep its durable reference
// read, guarded deletion, and reservation update inside a writer transaction.
const compensationStart = serverSource.indexOf('function compensateCase01SnapshotIfUnreferenced(');
const compensationEnd = serverSource.indexOf('\nfunction processIsAlive(', compensationStart);
assert.ok(compensationStart >= 0 && compensationEnd > compensationStart,
  'snapshot compensation must expose a single guarded helper');
const compensationSource = serverSource.slice(compensationStart, compensationEnd);
const compensationLock = compensationSource.indexOf("workflowStore.db.exec('BEGIN IMMEDIATE')");
const compensationReferences = compensationSource.indexOf('case01ReferencedSnapshotIds()');
const compensationRemoval = compensationSource.indexOf('removeCase01WorkspaceSnapshot(');
const compensationReservationDelete = compensationSource.indexOf("DELETE FROM case01_snapshot_reservations", compensationRemoval);
assert.ok(compensationLock >= 0 && compensationLock < compensationReferences &&
  compensationReferences < compensationRemoval && compensationRemoval < compensationReservationDelete,
  'compensation must serialize writers before reference discovery and only remove an unreferenced snapshot');
assert.match(compensationSource, /if \(referenced\.has\(snapshotId\)\)[\s\S]*?COMMIT/,
  'if a durable reference exists, compensation must preserve snapshot bytes and commit only reservation cleanup');
assert.match(compensationSource, /catch \(error\)[\s\S]*?ROLLBACK[\s\S]*?throw error/,
  'reference/cleanup failures must roll back reservation changes and preserve the original failure');
console.log('PASS: failed-completion compensation serializes durable-reference check, filesystem cleanup, and reservation deletion under a SQLite writer lock');

// Exercise the actual MCP server startup path with a durable artifact whose
// snapshot bytes are absent. Startup must refuse to serve tools rather than
// silently starting with a broken acceptance chain.
const missingSnapshotArtifact = {
  ...snapshotArtifact,
  workspace_snapshot_id: missingSnapshot.snapshot_id,
  workspace_artifacts: missingSnapshot.workspace_artifacts,
};
store.createArtifact({
  artifact_id: `implementation-recovery-missing-snapshot-${missingSnapshot.snapshot_id}`,
  job_id: job.job_id,
  task_id: secondTask.task_id,
  type: 'implementation',
  producer_role: 'engineer',
  content: missingSnapshotArtifact,
  evidence: [snapshotCompletion.resultId],
});
const startup = spawnSync(process.execPath, [path.resolve('server/index.js')], {
  cwd: path.resolve('.'),
  encoding: 'utf8',
  timeout: 5000,
  env: {
    ...process.env,
    CHAT_ON_STEROIDS_DATA_DIR: root,
    CHAT_ON_STEROIDS_WORKFLOW_DB: dbPath,
    CHAT_ON_STEROIDS_WORKSPACE: workspace,
    CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(root, 'execution-tmp'),
  },
});
assert.notEqual(startup.status, 0, 'MCP server must refuse startup when a durable snapshot reference cannot be verified');
assert.match(`${startup.stderr}\n${startup.stdout}`, /ENOENT|no such file|snapshot/i,
  'startup failure must expose the missing durable snapshot integrity error');
console.log('PASS: actual MCP runtime fails closed at startup when durable acceptance metadata points to missing snapshot bytes');
console.log('PASS: a CASE-01 write-time acceptance rejection rolls back result, artifact, and task terminalization atomically');
console.log('PASS: idempotent completion retries re-run the acceptance guard rather than bypassing validation');
