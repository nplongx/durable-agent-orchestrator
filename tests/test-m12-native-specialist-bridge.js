import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm12-native-bridge-'));
process.env.WORKFLOW_DATA_DIR = dir;
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { M12NativeSpecialistBridge } = await import('../src/runtime/m12-native-specialist-bridge.js');
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: 'native-bridge-test', title: 'Native bridge' });
const task = store.ensureTask(job.job_id, { role: 'researcher', description: 'native task' });
const lease = store.acquireTaskLease(task.task_id, { leaseId: 'lease-native-bridge', workerId: 'runner', ttlMs: 120000, attempt: 1 });

let starts = 0;
let waits = 0;
let complete = false;
let malformedOutput = false;
const gateway = {
  role: 'node',
  scopes: [],
  async request(method, params) {
    if (method === 'm12.specialist.start') {
      starts++;
      assert.equal(params.taskId, task.task_id);
      assert.equal(params.leaseId, lease.lease_id);
      return {
        taskId: task.task_id, attempt: 1, role: 'researcher', inputCommit: 'abc123',
        environmentId: 'env-native', nodeId: 'node-native', ownerEpoch: lease.owner_epoch,
        leaseId: lease.lease_id, sessionKey: 'agent:m12-test:specialist:1',
        sessionId: 'native-session-real', runId: 'native-run-real',
      };
    }
    if (method === 'm12.specialist.wait') {
      waits++;
      assert.equal(params.runId, 'native-run-real');
      if (!complete) return { taskId: task.task_id, runId: params.runId, status: 'RUNNING' };
      if (malformedOutput) return { taskId: task.task_id, runId: params.runId, sessionId: 'native-session-real', status: 'SUCCEEDED', output: { text: 'not a string' } };
      return { taskId: task.task_id, runId: params.runId, sessionId: 'native-session-real', status: 'SUCCEEDED', output: 'native output' };
    }
    throw new Error(`unexpected Gateway method: ${method}`);
  },
};

const bridge = new M12NativeSpecialistBridge({ store, gateway });
const input = {
  taskId: task.task_id, attempt: 1, leaseId: lease.lease_id,
  environmentId: 'env-native', nodeId: 'node-native', ownerEpoch: lease.owner_epoch,
  inputCommit: 'abc123', role: 'researcher', prompt: 'Research the task',
  admissionIdempotencyKey: 'admission-native-1', timeoutMs: 1000,
};

await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume({ ...input, ownerEpoch: '1' }),
  /ownerEpoch must be a positive safe integer/, 'native bridge must not coerce owner-epoch identity from a string');
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume({ ...input, ownerEpoch: lease.owner_epoch + 1 }),
  /owner epoch does not match the exact durable task lease/, 'native bridge must reject an owner epoch not bound to the lease');
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway, now: () => Date.parse(lease.expires_at) }).startOrResume(input),
  /lease is expired or has malformed time identity/, 'native bridge must not use an expired lease');
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume({ ...input, timeoutMs: '1000' }),
  /timeoutMs must be a positive safe integer/, 'native bridge must not coerce a string timeout');
assert.equal(starts, 0, 'rejected preflight inputs must not invoke native specialist start');
assert.equal(waits, 0, 'rejected preflight inputs must not invoke native specialist wait');

const first = await bridge.startOrResume(input);
assert.equal(first.status, 'RUNNING');
assert.equal(starts, 1);
assert.equal(waits, 1);
assert.equal(store.getM12NativeSpecialistRuntime(task.task_id, 1).native_session_id, 'native-session-real');

complete = true;
malformedOutput = true;
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume(input),
  /terminal result output must be a string/, 'native bridge must reject structured output instead of coercing it');
assert.equal(store.getM12NativeSpecialistRuntime(task.task_id, 1).state, 'ACTIVE',
  'malformed terminal output must not complete the persisted runtime');
assert.equal(store.getTaskLease(lease.lease_id).state, 'ACTIVE', 'malformed terminal output must not complete the task lease');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(task.task_id).n, 0,
  'malformed native receipt must not create a result');
malformedOutput = false;
const recovered = await new M12NativeSpecialistBridge({ store, gateway }).startOrResume(input);
assert.equal(recovered.status, 'COMPLETED');
assert.equal(recovered.resumed, true);
assert.equal(starts, 1, 'recovery must not create a replacement native run');
assert.equal(waits, 3);
assert.equal(store.getTask(task.task_id).status, 'completed');
assert.equal(store.getTaskLease(lease.lease_id).state, 'COMPLETED');

assert.throws(() => new M12NativeSpecialistBridge({ store, gateway: { ...gateway, role: 'operator', scopes: ['operator.admin'] } }), /node-role Gateway client/);
const terminalJob = store.createJob({ conversationKey: 'native-bridge-terminal-parent', title: 'Reject terminal parent job' });
const terminalTask = store.ensureTask(terminalJob.job_id, { role: 'researcher', description: 'must not start after parent terminalization' });
const terminalLease = store.acquireTaskLease(terminalTask.task_id, {
  leaseId: 'lease-native-bridge-terminal', workerId: 'runner-terminal', ttlMs: 120000, attempt: 1
});
store.transition(terminalJob.job_id, 'COMPLETED', 'completed');
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume({
  ...input, taskId: terminalTask.task_id, leaseId: terminalLease.lease_id, attempt: 1, ownerEpoch: terminalLease.owner_epoch
}), /live non-terminal parent job/, 'native bridge must fail closed after parent job terminalization');
assert.equal(starts, 1, 'terminal parent job must not trigger a remote native start');
assert.equal(store.getTaskLease(terminalLease.lease_id).state, 'ACTIVE', 'rejected terminal-parent start must not mutate lease state');
const ambiguousJob = store.createJob({ conversationKey: 'native-bridge-ambiguous-lease', title: 'Reject ambiguous lease runtime mapping' });
const ambiguousTask = store.ensureTask(ambiguousJob.job_id, { role: 'researcher', description: 'must not start a second native turn' });
const ambiguousLease = store.acquireTaskLease(ambiguousTask.task_id, {
  leaseId: 'lease-native-bridge-ambiguous', workerId: 'runner-ambiguous', ttlMs: 120000, attempt: 1
});
store.attachM12NativeSpecialistRuntime(ambiguousTask.task_id, {
  attempt: 1, sessionKey: 'agent:m12-test:ambiguous:1', nativeSessionId: 'native-bridge-ambiguous-session-1',
  runId: 'native-bridge-ambiguous-run-1', environmentId: 'env-native', nodeId: 'node-native',
  leaseId: ambiguousLease.lease_id, ownerEpoch: ambiguousLease.owner_epoch,
});
store.db.prepare(`INSERT INTO m12_native_specialist_runtime
  (task_id,attempt,session_key,native_session_id,run_id,environment_id,node_id,lease_id,owner_epoch,state,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',?,?)`).run(
    ambiguousTask.task_id, 2, 'agent:m12-test:ambiguous:2', 'native-bridge-ambiguous-session-2',
    'native-bridge-ambiguous-run-2', 'env-native', 'node-native', ambiguousLease.lease_id,
    ambiguousLease.owner_epoch, new Date().toISOString(), new Date().toISOString()
  );
await assert.rejects(() => new M12NativeSpecialistBridge({ store, gateway }).startOrResume({
  ...input, taskId: ambiguousTask.task_id, leaseId: ambiguousLease.lease_id, attempt: 1, ownerEpoch: ambiguousLease.owner_epoch,
}), /ambiguous or mismatched durable runtime/, 'ambiguous reverse mapping must be rejected before Gateway start/wait');
assert.equal(starts, 1, 'ambiguous runtime mapping must not cross the remote start boundary');
assert.equal(waits, 3, 'ambiguous runtime mapping must not call remote wait');
assert.equal(store.getTaskLease(ambiguousLease.lease_id).state, 'ACTIVE', 'preflight rejection must preserve lease state');
console.log('M12 NATIVE SPECIALIST BRIDGE PASS');
store.close?.();
for (const file of [path.join(dir, 'workflow.db'), path.join(dir, 'workflow.db-wal'), path.join(dir, 'workflow.db-shm')]) fs.rmSync(file, { force: true });
