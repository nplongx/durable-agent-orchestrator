import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './test-temp-dir.js';

const dir = tempDir('cos-phase4-');
process.env.WORKFLOW_DATA_DIR = dir;
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');

const { WorkflowStore } = await import('../job-store.js');
const { ExecutionManager, parseCanonicalExecutionExitMarker, readCanonicalExecutionExitMarkerFile } = await import('../execution-manager.js');

const store = new WorkflowStore();
const job = store.createJob({ conversationKey: 'phase4-test', title: 'Phase 4 deterministic execution' });
const task = store.ensureTask(job.job_id, { role: 'executor', description: 'deterministic command' });
store.db.prepare('UPDATE tasks SET metadata_json=? WHERE task_id=?').run(JSON.stringify({ executor: 'ExecutionManager' }), task.task_id);
// mkdir({mode:0700}) does not repair permissions on an existing directory.
// The execution manager must make a service-owned output directory private
// before a task can redirect output into files under it.
const executionTmpDir = path.join(dir, 'runtime');
fs.mkdirSync(executionTmpDir, { recursive: true, mode: 0o777 });
fs.chmodSync(executionTmpDir, 0o777);
const manager = new ExecutionManager(store, { timeoutMs: 5000 });

for (const marker of ['-0', '00', '-00', '+0', ' 0', '0\n', '9007199254740992', '-9007199254740992']) {
  assert.throws(() => parseCanonicalExecutionExitMarker(marker), /malformed|canonical safe integer/,
    `non-canonical exit marker ${JSON.stringify(marker)} must never be normalized into a terminal result`);
}
assert.equal(parseCanonicalExecutionExitMarker('0'), 0);
assert.equal(parseCanonicalExecutionExitMarker('7'), 7);
assert.equal(parseCanonicalExecutionExitMarker('-7'), -7);
assert.equal(parseCanonicalExecutionExitMarker(''), null, 'an absent/incomplete marker is not yet an exit observation');
const validMarkerPath = path.join(executionTmpDir, `exit-marker-valid-${process.pid}`);
const emptyMarkerPath = path.join(executionTmpDir, `exit-marker-empty-${process.pid}`);
const oversizedMarkerPath = path.join(executionTmpDir, `exit-marker-oversized-${process.pid}`);
const malformedMarkerPath = path.join(executionTmpDir, `exit-marker-malformed-${process.pid}`);
const symlinkMarkerPath = path.join(executionTmpDir, `exit-marker-symlink-${process.pid}`);
fs.mkdirSync(executionTmpDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(validMarkerPath, '0', { flag: 'wx', mode: 0o600 });
fs.writeFileSync(emptyMarkerPath, '', { flag: 'wx', mode: 0o600 });
fs.writeFileSync(oversizedMarkerPath, '1'.repeat(65), { flag: 'wx', mode: 0o600 });
fs.writeFileSync(malformedMarkerPath, '-0', { flag: 'wx', mode: 0o600 });
fs.symlinkSync(validMarkerPath, symlinkMarkerPath);
assert.equal(await readCanonicalExecutionExitMarkerFile(validMarkerPath), 0);
assert.equal(await readCanonicalExecutionExitMarkerFile(emptyMarkerPath), null);
assert.equal(await readCanonicalExecutionExitMarkerFile(path.join(executionTmpDir, `exit-marker-absent-${process.pid}`)), null);
await assert.rejects(() => readCanonicalExecutionExitMarkerFile(oversizedMarkerPath), /bounded regular file/);
await assert.rejects(() => readCanonicalExecutionExitMarkerFile(malformedMarkerPath), /malformed/);
await assert.rejects(() => readCanonicalExecutionExitMarkerFile(symlinkMarkerPath), error =>
  ['ELOOP', 'EINVAL', 'ENOTSUP'].includes(error?.code) || /symbolic|symlink|regular file/i.test(error.message),
  'exit-marker reads must not follow symlinks');

const ok = await manager.executeTask(task.task_id, { command: "node -e \"process.stdout.write('OUT'); process.stderr.write('ERR')\"" });
assert.equal(ok.exitCode, 0);
assert.equal(ok.stdout, 'OUT');
assert.equal(ok.stderr, 'ERR');
assert.equal(ok.timedOut, false);
const okTask = store.getTask(task.task_id);
assert.equal(okTask.execution_status, 'completed');
assert.equal(okTask.execution_attempt, 1);
assert.equal(okTask.execution_exit_code, 0);
assert.ok(Number.isInteger(okTask.execution_pid));
assert.equal(okTask.status, 'completed');
assert.equal(fs.statSync(executionTmpDir).mode & 0o777, 0o700,
  'execution output directory must be repaired to owner-only permissions before use');
const successReplay = await manager.executeTask(task.task_id, {
  command: "node -e \"process.stdout.write('OUT'); process.stderr.write('ERR')\""
});
assert.equal(successReplay.status, 'completed', 'a replay of a valid terminal execution returns the existing durable task');
assert.equal(successReplay.execution_attempt, 1, 'a successful terminal replay must not create a new execution attempt');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='execution.completed' AND json_extract(payload_json,'$.taskId')=?")
  .get(job.job_id, task.task_id).n, 1, 'idempotent execution replay must verify, not duplicate, the terminal execution event');

const malformedAttemptTask = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id, role: 'executor', description: 'string-valued durable execution attempt must fail closed',
  metadata: { executor: 'ExecutionManager', deterministic: true, command: 'node --version' }
});
store.db.prepare("UPDATE tasks SET execution_attempt='1x' WHERE task_id=?").run(malformedAttemptTask.task_id);
assert.equal(typeof store.getTask(malformedAttemptTask.task_id).execution_attempt, 'string',
  'fixture must persist an actually malformed SQLite execution-attempt value');
await assert.rejects(() => manager.executeTask(malformedAttemptTask.task_id, { command: 'node --version' }),
  /malformed durable execution attempt/,
  'the execution manager must reject a malformed persisted attempt rather than normalize it into a new attempt');
assert.equal(store.getTask(malformedAttemptTask.task_id).status, 'pending');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(malformedAttemptTask.task_id).n, 0,
  'a malformed persisted attempt must fail before creating an attempt/session');
const originalSuccessfulResult = store.db.prepare('SELECT result_id,outcome,content FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
  .get(task.task_id);
const successfulResultCount = store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n;
const rejectedTranscriptRepair = store.repairResultEvidence(task.task_id,
  '[ACTUAL TOOL RESULT EVIDENCE]\nexact command: false-substituted-command\nexit status/code: 0\nexecution status: completed',
  { outcome: 'success' });
assert.equal(rejectedTranscriptRepair, false,
  'a host/runtime transcript that omits task/session/attempt/execution markers must not replace a valid local-execution result');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n, successfulResultCount,
  'rejected transcript repair must not append a newer failure/success row');
assert.deepEqual(store.db.prepare('SELECT result_id,outcome,content FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
  .get(task.task_id), originalSuccessfulResult,
  'the canonical durable execution result remains the latest result after rejecting an unbound transcript');

// Reproduce the resource-exhaustion boundary with a real child process and
// real tmux session: pre-fix this returned and persisted all 12 MiB in memory
// and SQLite. The shell's inherited RLIMIT_FSIZE and bounded collector must
// cap disk, memory, and durable result growth and must not report success.
const oversizedOutput = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id, role: 'executor', description: 'emit output beyond the per-stream cap'
});
const oversizedResult = await manager.executeTask(oversizedOutput.task_id, {
  command: 'node -e "process.stdout.write(Buffer.alloc(12582912, 65))"',
  timeoutMs: 5000,
  cwd: dir
});
assert.equal(oversizedResult.outputLimited, true, 'output beyond the cap must be marked as limited');
assert.ok(Buffer.byteLength(oversizedResult.stdout) <= 4 * 1024 * 1024,
  'the collector must not materialize more than the per-stream output cap');
assert.equal(store.getTask(oversizedOutput.task_id).execution_status, 'failed',
  'a successful process exit cannot hide truncated execution evidence');
assert.ok(store.getJobTrace(job.job_id).results.some(result => result.task_id === oversizedOutput.task_id &&
  /output reached the .* per-stream limit/.test(result.content)),
  'durable execution evidence must explain output truncation');
const attemptedFalseSuccessRepair = store.repairResultEvidence(oversizedOutput.task_id,
  '[ACTUAL TOOL RESULT EVIDENCE]\nexit status/code: 0\nexecution status: completed', { outcome: 'success' });
assert.equal(attemptedFalseSuccessRepair, true,
  'an evidence-repair request should durably record the observed response instead of silently dropping it');
const repairedOutputLimitResult = store.db.prepare('SELECT outcome,content FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
  .get(oversizedOutput.task_id);
assert.equal(repairedOutputLimitResult.outcome, 'failure',
  'result repair must not promote an output-limited durable execution to outcome=success, even if the caller requests success');
assert.match(repairedOutputLimitResult.content, /execution status: completed/,
  'preserve the observed caller text; correctness comes from the durable outcome classification, not rewriting history');
const repairEvent = store.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='result.evidence_repaired' AND json_extract(payload_json,'$.resultId')=(SELECT result_id FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1)")
  .get(job.job_id, oversizedOutput.task_id);
assert.equal(JSON.parse(repairEvent.payload_json).outcome, 'failure',
  'result-repair audit must carry the same failure classification as its durable result row');
assert.equal(fs.readdirSync(executionTmpDir).some(name => name.includes(oversizedResult.execution_session_id)), false,
  'collected output and exit marker files must be removed after durable completion');
console.log('EXECUTION OUTPUT RESOURCE CAP / TRUNCATION QUARANTINE / PRIVATE DIRECTORY: PASS');

// A supervisor/process crash can bypass collect(), leaving the truncation
// marker behind. Orphan cleanup must remove every artifact type, not just the
// output streams and exit marker.
const orphanStem = `cos-exec-exec_orphan-cleanup-${process.pid}`;
for (const suffix of ['stdout', 'stderr', 'exit', 'output-limit']) {
  fs.writeFileSync(path.join(executionTmpDir, `${orphanStem}.${suffix}`), 'stale');
}
const removedOrphans = await manager.cleanupOrphanedArtifacts();
assert.equal(removedOrphans, 4, 'orphan cleanup must count and remove output-limit markers too');
for (const suffix of ['stdout', 'stderr', 'exit', 'output-limit']) {
  assert.equal(fs.existsSync(path.join(executionTmpDir, `${orphanStem}.${suffix}`)), false,
    `orphan cleanup must remove stale .${suffix} artifact`);
}
console.log('EXECUTION ORPHAN ARTIFACT CLEANUP INCLUDES OUTPUT-LIMIT MARKERS: PASS');

// The orphan sweeper must also preserve a marker for a durably running task.
// Otherwise concurrent startup/recovery cleanup could erase the only durable
// indication that captured output was truncated and incorrectly accept exit 0.
const activeMarkerTask = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id, role: 'executor', description: 'preserve active output-limit marker during cleanup'
});
const activeMarkerSession = `exec_active-marker-${process.pid}`;
const activeMarkerStem = `cos-exec-${activeMarkerSession}`;
store.db.prepare("UPDATE tasks SET execution_status='running', execution_session_id=? WHERE task_id=?")
  .run(activeMarkerSession, activeMarkerTask.task_id);
const activeMarkerPath = path.join(executionTmpDir, `${activeMarkerStem}.output-limit`);
fs.writeFileSync(activeMarkerPath, 'truncated', { flag: 'wx', mode: 0o600 });
assert.equal(await manager.cleanupOrphanedArtifacts(), 0,
  'active output-limit marker must not be counted as an orphan');
assert.equal(fs.existsSync(activeMarkerPath), true,
  'cleanup must preserve active output-limit marker until result collection');
store.db.prepare("UPDATE tasks SET execution_status='failed', execution_session_id=NULL WHERE task_id=?")
  .run(activeMarkerTask.task_id);
assert.equal(await manager.cleanupOrphanedArtifacts(), 1,
  'output-limit marker must become collectible after execution is no longer active');
assert.equal(fs.existsSync(activeMarkerPath), false);
console.log('EXECUTION ORPHAN CLEANUP PRESERVES ACTIVE OUTPUT-LIMIT MARKERS: PASS');

// Output limiting must not impose RLIMIT_FSIZE on the task itself: approved
// build/test commands may legitimately create artifacts larger than the log
// cap. Only captured stdout/stderr are bounded by the supervisor.
const largeArtifactPath = path.join(dir, 'large-approved-artifact.bin');
const largeArtifactTask = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id, role: 'executor', description: 'create an artifact larger than the log cap'
});
const largeArtifactResult = await manager.executeTask(largeArtifactTask.task_id, {
  command: 'node -e "require(\'node:fs\').writeFileSync(\'large-approved-artifact.bin\', Buffer.alloc(5242880, 65)); process.stdout.write(\'ARTIFACT_OK\')"',
  timeoutMs: 5000,
  cwd: dir
});
assert.equal(largeArtifactResult.exitCode, 0);
assert.equal(largeArtifactResult.stdout, 'ARTIFACT_OK');
assert.equal(largeArtifactResult.outputLimited, false);
assert.equal(fs.statSync(largeArtifactPath).size, 5 * 1024 * 1024,
  'the output cap must not restrict ordinary task-created files');
fs.rmSync(largeArtifactPath, { force: true });
console.log('EXECUTION OUTPUT CAP DOES NOT LIMIT TASK ARTIFACT FILE SIZES: PASS');

// An explicit environment merge must not re-enable Git's external fsmonitor
// hook or replace the isolated global config used by the execution manager.
// The former implementation accepted GIT_CONFIG_GLOBAL and ran this hook.
const gitWorkspace = path.join(dir, 'git-config-workspace');
const gitHook = path.join(dir, 'ambient-git-fsmonitor-hook.sh');
const gitHookSentinel = path.join(dir, 'UNAPPROVED_GIT_CONFIG_HOOK_EXECUTED.txt');
const injectedGitConfig = path.join(dir, 'injected-git-global-config');
fs.mkdirSync(gitWorkspace, { recursive: true, mode: 0o700 });
execFileSync('git', ['init', gitWorkspace], { stdio: 'ignore' });
fs.writeFileSync(gitHook, `#!/bin/sh\nprintf '%s' 'executed' > ${JSON.stringify(gitHookSentinel)}\nprintf 'default\\0'\n`, { flag: 'wx', mode: 0o700 });
fs.chmodSync(gitHook, 0o700);
fs.writeFileSync(injectedGitConfig, `[core]\n\tfsmonitor = ${gitHook}\n`, { flag: 'wx', mode: 0o600 });
const gitConfigTask = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id, role: 'executor', description: 'reject ambient Git config hook injection'
});
await assert.rejects(() => manager.executeTask(gitConfigTask.task_id, {
  command: 'git status --short', cwd: gitWorkspace,
  env: { GIT_CONFIG_GLOBAL: injectedGitConfig }
}), /protected variable GIT_CONFIG_GLOBAL/);
assert.equal(fs.existsSync(gitHookSentinel), false,
  'untrusted execution environment must not re-enable a Git hook outside the command contract');
assert.equal(store.getTask(gitConfigTask.task_id).execution_session_id, null,
  'rejected Git configuration injection must fail before durable execution preparation');
console.log('EXECUTION ENVIRONMENT REJECTS GIT CONFIG HOOK INJECTION: PASS');

const badCommand = "node -e \"process.stderr.write('BAD'); process.exit(7)\"";
const bad = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id,
  role: 'executor',
  description: `Run immediately: ${badCommand}. Return exact command and exit status.`,
  metadata: { deterministic: true, command: badCommand }
});
const badResult = await manager.executeTask(bad.task_id, { command: badCommand });
assert.equal(badResult.exitCode, 7);
assert.equal(store.getTask(bad.task_id).execution_status, 'failed');
assert.equal(store.getTask(bad.task_id).execution_exit_code, 7);
const deterministicCommandDecoy = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id, role: 'executor',
  description: `This unrelated task merely mentions the command ${badCommand} in its prose.`,
  metadata: { deterministic: true, command: 'node --version' }
});
assert.equal(store.findDeterministicTask(job.job_id, {
  role: 'executor',
  command: badCommand
}).task_id, bad.task_id);
assert.notEqual(store.findDeterministicTask(job.job_id, {
  role: 'executor', command: badCommand
}).task_id, deterministicCommandDecoy.task_id,
  'a different deterministic task must not be selected just because its description mentions the requested command');

// Legacy command strings are tokenized into argv; shell control operators and
// expansion outside quoted arguments must be rejected before prepareExecution.
const shellInjectionTask = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id, role: 'executor', description: 'reject shell operator injection before prepare'
});
const shellInjectionSentinel = path.join(dir, 'unapproved-shell-operator-executed.txt');
const injectedCommand = `node -e "require('node:fs').writeFileSync(${JSON.stringify(shellInjectionSentinel)}, 'bad')" ; node -e "process.exit(0)"`;
await assert.rejects(() => manager.executeTask(shellInjectionTask.task_id, { command: injectedCommand }),
  /unsupported shell syntax outside quotes/);
assert.equal(fs.existsSync(shellInjectionSentinel), false, 'shell operator injection must not create its sentinel');
assert.equal(store.getTask(shellInjectionTask.task_id).execution_session_id, null, 'rejected shell syntax must not prepare an execution session');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(shellInjectionTask.task_id).n, 0,
  'rejected shell syntax must not create an attempt row');
await assert.rejects(() => manager.executeTask(shellInjectionTask.task_id, {
  command: `node -e "process.exit(0)" $(touch ${shellInjectionSentinel})`
}), /unsupported shell syntax outside quotes/);
assert.equal(fs.existsSync(shellInjectionSentinel), false, 'command substitution must never reach a shell');
await assert.rejects(() => manager.executeTask(shellInjectionTask.task_id, { command: 'bash -lc "touch /tmp/not-run"' }),
  /unplanned shell execution is not permitted/);
console.log('EXECUTION COMMAND TOKENIZATION REJECTS SHELL OPERATORS/EXPANSION BEFORE DURABLE PREPARE: PASS');

const leasedTask = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id, role: 'executor', description: 'refuse local execution under external worker lease'
});
store.acquireTaskLease(leasedTask.task_id, {
  leaseId: `lease-execution-manager-active-${process.pid}`, workerId: 'independent-worker', ttlMs: 10000, attempt: 1
});
await assert.rejects(() => manager.executeTask(leasedTask.task_id, { command: 'node -e "process.exit(0)"' }),
  /active task lease is not bound to this OS execution owner/);
assert.equal(store.getTask(leasedTask.task_id).execution_session_id, null, 'external worker lease must block local process creation');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(leasedTask.task_id).n, 0,
  'external worker lease rejection must happen before durable execution prepare');

const epochBoundTask = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id, role: 'executor', description: 'execute only with the exact active owner epoch proof'
});
const epochLease = store.acquireTaskLease(epochBoundTask.task_id, {
  leaseId: `lease-execution-manager-epoch-${process.pid}`, workerId: `worker-${process.pid}`, ttlMs: 10000, attempt: 1
});
assert.ok(Number.isSafeInteger(epochLease.owner_epoch) && epochLease.owner_epoch > 0,
  'durable task leases must expose a positive owner epoch');
const epochResult = await manager.executeTask(epochBoundTask.task_id, {
  command: 'node -e "process.stdout.write(\'EPOCH_BOUND\')"',
  executionLease: {
    leaseId: epochLease.lease_id, workerId: epochLease.worker_id,
    ownerEpoch: epochLease.owner_epoch, attempt: epochLease.attempt
  }
});
assert.equal(epochResult.exitCode, 0);
assert.equal(epochResult.stdout, 'EPOCH_BOUND');
const epochBoundary = JSON.parse(store.getTask(epochBoundTask.task_id).metadata_json).execution_boundary_identity;
assert.deepEqual(epochBoundary.lease, {
  lease_id: epochLease.lease_id, state: 'ACTIVE', attempt: 1,
  worker_id: epochLease.worker_id, owner_epoch: epochLease.owner_epoch, expires_at: epochLease.expires_at
}, 'durable execution boundary identity must bind the exact active lease owner epoch');
const contradictoryEpochLease = store.completeTaskLease(epochLease.lease_id, { workerId: epochLease.worker_id, success: false, error: 'stale conflicting callback' });
assert.equal(contradictoryEpochLease.ok, false,
  'a terminal success task must not let a late failure callback settle its active lease');
assert.equal(contradictoryEpochLease.reason, 'task_terminal_outcome_mismatch');
assert.equal(store.getTaskLease(epochLease.lease_id).state, 'ACTIVE',
  'a contradictory callback must leave the lease unchanged for the matching terminal owner');
const completedEpochLease = store.completeTaskLease(epochLease.lease_id, { workerId: epochLease.worker_id, success: true });
assert.equal(completedEpochLease.ok, true);
assert.equal(completedEpochLease.lease.state, 'COMPLETED');

const expiredLeaseTask = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id, role: 'executor', description: 'refuse expired worker lease'
});
const expiredLeaseId = `lease-execution-manager-expired-${process.pid}`;
store.acquireTaskLease(expiredLeaseTask.task_id, { leaseId: expiredLeaseId, workerId: 'expired-worker', ttlMs: 10000, attempt: 1 });
store.db.prepare('UPDATE task_leases SET expires_at=? WHERE lease_id=?').run(new Date(Date.now() - 1000).toISOString(), expiredLeaseId);
await assert.rejects(() => manager.executeTask(expiredLeaseTask.task_id, { command: 'node -e "process.exit(0)"' }),
  /task lease is absent, stale, expired, substituted, or detached/);
assert.equal(store.getTask(expiredLeaseTask.task_id).execution_session_id, null, 'expired worker lease must block local process creation');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(expiredLeaseTask.task_id).n, 0,
  'expired lease rejection must happen before durable execution prepare');
console.log('EXECUTION BOUNDARY REJECTS ACTIVE FOREIGN-OWNER AND EXPIRED TASK LEASES BEFORE SPAWN: PASS');

const timeout = store.createChildTask(job.job_id, { parentTaskId: task.task_id, role: 'executor', description: 'timeout command' });
const timeoutResult = await manager.executeTask(timeout.task_id, { command: "node -e \"setTimeout(() => {}, 1000)\"", timeoutMs: 100 });
assert.equal(timeoutResult.timedOut, true);
assert.equal(store.getTask(timeout.task_id).execution_status, 'timeout');
assert.equal(store.getTask(timeout.task_id).execution_exit_code, null);

const trace = store.getJobTrace(job.job_id);
assert.ok(trace.results.some(r => r.content.includes('[ACTUAL EXECUTION EVIDENCE]')));
assert.ok(trace.events.some(e => e.type === 'execution.completed'));
assert.ok(trace.events.some(e => e.type === 'execution.failed'));

const authorized = store.createChildTask(job.job_id, {
  parentTaskId: task.task_id,
  role: 'executor',
  description: 'deterministic command',
  metadata: { deterministic: true, command: 'node -e "process.stdout.write(\'AUTHORIZED\')"' }
});
const authorizedResult = await manager.executeAuthorizedTask(authorized.task_id);
assert.equal(authorizedResult.exitCode, 0);
assert.equal(authorizedResult.stdout, 'AUTHORIZED');

const cancelled = store.createChildTask(job.job_id, { parentTaskId: task.task_id, role: 'executor', description: 'cancel command' });
const controller = new AbortController();
const cancellation = manager.executeTask(cancelled.task_id, {
  command: "node -e \"setTimeout(() => {}, 5000)\"",
  timeoutMs: 5000,
  signal: controller.signal
});
setTimeout(() => controller.abort(), 100);
await assert.rejects(cancellation, /Request aborted by caller/);
const cancelledTask = store.getTask(cancelled.task_id);
assert.equal(cancelledTask.execution_status, 'cancelled');
assert.equal(cancelledTask.status, 'cancelled');
assert.ok(cancelledTask.execution_session_id);
assert.notEqual(cancelledTask.execution_status, 'running');
assert.throws(() => execFileSync('tmux', ['has-session', '-t', cancelledTask.execution_tmux_name], { stdio: 'ignore' }));
assert.ok(store.getJobTrace(job.job_id).events.some(e => e.type === 'execution.cancelled'));
console.log('test-execution-manager: PASS');
