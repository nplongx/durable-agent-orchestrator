const TERMINAL_NATIVE_STATES = new Set(['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'OK', 'FAILED', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'TIMEOUT']);
const SUCCESS_NATIVE_STATES = new Set(['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'OK']);

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function nativeResultPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Gateway returned no native specialist result');
  const result = raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result) ? raw.result : raw;
  for (const [label, value] of [['result.status', result.status], ['receipt.status', raw.status]]) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !value.trim())) {
      throw new Error(`Gateway native result ${label} must be a non-empty string when present`);
    }
  }
  const resultStatus = typeof result.status === 'string' ? result.status.trim().toUpperCase() : '';
  const receiptStatus = typeof raw.status === 'string' ? raw.status.trim().toUpperCase() : '';
  if (result !== raw && resultStatus && receiptStatus && resultStatus !== receiptStatus) {
    throw new Error('Gateway native result has conflicting nested and outer status fields');
  }
  const status = resultStatus || receiptStatus;
  if (!TERMINAL_NATIVE_STATES.has(status)) return { terminal: false, status, raw };
  const output = result.output ?? result.content ?? result.error ?? '';
  if (typeof output !== 'string') throw new Error('Gateway native terminal result output must be a string');
  return {
    terminal: true,
    status,
    output,
    result: raw,
  };
}

/**
 * Bridge a task lease to the fork's node-scoped native specialist RPC.
 * `gateway` must be an already-authenticated node-role client (role=node,
 * scopes=[]). This class never creates a local session or fabricates IDs.
 */
export class M12NativeSpecialistBridge {
  constructor({ store, gateway, now = () => Date.now() } = {}) {
    if (!store || typeof store.attachM12NativeSpecialistRuntime !== 'function' ||
        typeof store.reconcileM12NativeSpecialistResult !== 'function') {
      throw new TypeError('M12NativeSpecialistBridge requires a compatible WorkflowStore');
    }
    if (!gateway || typeof gateway.request !== 'function' || gateway.role !== 'node' ||
        (gateway.scopes || []).some(scope => String(scope).startsWith('operator.'))) {
      throw new TypeError('M12NativeSpecialistBridge requires an authenticated node-role Gateway client without operator scopes');
    }
    this.store = store;
    this.gateway = gateway;
    this.now = now;
  }

  async startOrResume({ taskId, attempt, leaseId, environmentId, nodeId, ownerEpoch, inputCommit, prompt, role, admissionIdempotencyKey, timeoutMs = 900_000 }) {
    const task = this.store.getTask(requiredString(taskId, 'taskId'));
    if (!task) throw new Error(`task not found: ${taskId}`);
    const normalizedAttempt = positiveInteger(attempt, 'attempt');
    const normalizedTimeoutMs = positiveInteger(timeoutMs, 'timeoutMs');
    if (normalizedTimeoutMs > 900_000) throw new Error('timeoutMs must not exceed 900000 ms');
    if (task.status !== 'running') throw new Error(`native specialist requires a running task, got ${task.status}`);
    const job = this.store.getJob(task.job_id);
    if (!job || job.status !== 'active' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase())) {
      throw new Error('native specialist requires a live non-terminal parent job');
    }
    const lease = this.store.getTaskLease(requiredString(leaseId, 'leaseId'));
    if (!lease || lease.task_id !== taskId || lease.job_id !== task.job_id || lease.attempt !== normalizedAttempt || lease.state !== 'ACTIVE') {
      throw new Error('native specialist requires an active task lease bound to this task attempt');
    }
    const nowMs = this.now();
    const expiryMs = Date.parse(lease.expires_at);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(expiryMs) || expiryMs <= nowMs) {
      throw new Error('native specialist lease is expired or has malformed time identity');
    }
    const binding = {
      taskId,
      attempt: normalizedAttempt,
      leaseId,
      environmentId: requiredString(environmentId, 'environmentId'),
      nodeId: requiredString(nodeId, 'nodeId'),
      ownerEpoch: positiveInteger(ownerEpoch, 'ownerEpoch'),
    };
    if (!Number.isSafeInteger(lease.owner_epoch) || lease.owner_epoch < 1 || lease.owner_epoch !== binding.ownerEpoch) {
      throw new Error('native specialist owner epoch does not match the exact durable task lease');
    }
    // Check the reverse mapping before crossing the Gateway start boundary. A
    // task/attempt lookup alone is insufficient if corrupted durable history
    // maps this lease to another native turn; starting in that state can create
    // a second remote side effect that local attachment then rejects.
    const leaseRuntimeRows = this.store.db.prepare(
      'SELECT task_id,attempt,lease_id,owner_epoch,run_id FROM m12_native_specialist_runtime WHERE lease_id=? ORDER BY attempt ASC, rowid ASC'
    ).all(leaseId);
    const existing = this.store.getM12NativeSpecialistRuntime(taskId, normalizedAttempt);
    if (leaseRuntimeRows.length > 1 || (leaseRuntimeRows.length === 1 &&
        (leaseRuntimeRows[0].task_id !== taskId || leaseRuntimeRows[0].attempt !== normalizedAttempt ||
          leaseRuntimeRows[0].lease_id !== leaseId || leaseRuntimeRows[0].owner_epoch !== binding.ownerEpoch ||
          !existing || leaseRuntimeRows[0].run_id !== existing.run_id))) {
      throw new Error('native specialist lease maps to an ambiguous or mismatched durable runtime; refusing Gateway call');
    }
    let native;

    if (existing) {
      for (const field of ['lease_id', 'environment_id', 'node_id']) {
        const expected = field === 'lease_id' ? binding.leaseId : field === 'environment_id' ? binding.environmentId : binding.nodeId;
        if (existing[field] !== expected) throw new Error(`persisted native runtime ${field} does not match current admission`);
      }
      if (!Number.isSafeInteger(existing.owner_epoch) || existing.owner_epoch !== binding.ownerEpoch) {
        throw new Error('persisted native runtime owner epoch is stale');
      }
      if (existing.state !== 'ACTIVE') return { status: existing.state, runtime: existing, resumed: false };
      // Restart recovery is wait-only. Never create a replacement native turn.
      native = await this.gateway.request('m12.specialist.wait', {
        environmentId: binding.environmentId,
        leaseId: binding.leaseId,
        ownerEpoch: binding.ownerEpoch,
        taskId,
        attempt: normalizedAttempt,
        runId: existing.run_id,
        timeoutMs: normalizedTimeoutMs,
      });
    } else {
      const start = await this.gateway.request('m12.specialist.start', {
        environmentId: binding.environmentId,
        admissionIdempotencyKey: requiredString(admissionIdempotencyKey, 'admissionIdempotencyKey'),
        leaseId: binding.leaseId,
        ownerEpoch: binding.ownerEpoch,
        taskId,
        attempt: normalizedAttempt,
        role: requiredString(role, 'role'),
        inputCommit: requiredString(inputCommit, 'inputCommit'),
        prompt: requiredString(prompt, 'prompt'),
        waitTimeoutMs: 0,
      });
      if (!start || typeof start !== 'object') throw new Error('Gateway did not return native specialist identity');
      const identity = {
        sessionKey: requiredString(start.sessionKey, 'native sessionKey'),
        nativeSessionId: requiredString(start.sessionId, 'native sessionId'),
        runId: requiredString(start.runId, 'native runId'),
        environmentId: requiredString(start.environmentId, 'native environmentId'),
        nodeId: requiredString(start.nodeId, 'native nodeId'),
        leaseId: requiredString(start.leaseId, 'native leaseId'),
        ownerEpoch: positiveInteger(start.ownerEpoch, 'native ownerEpoch'),
      };
      for (const field of ['environmentId', 'nodeId', 'leaseId', 'ownerEpoch']) {
        if (identity[field] !== binding[field]) throw new Error(`Gateway native identity binding mismatch: ${field}`);
      }
      // Persist actual Gateway IDs before waiting for completion. A crash after
      // this point can only resume by runId, never by starting a second turn.
      this.store.attachM12NativeSpecialistRuntime(taskId, {
        attempt: normalizedAttempt,
        sessionKey: identity.sessionKey,
        nativeSessionId: identity.nativeSessionId,
        runId: identity.runId,
        environmentId: identity.environmentId,
        nodeId: identity.nodeId,
        leaseId: identity.leaseId,
        ownerEpoch: identity.ownerEpoch,
      });
      native = await this.gateway.request('m12.specialist.wait', {
        environmentId: binding.environmentId,
        leaseId: binding.leaseId,
        ownerEpoch: binding.ownerEpoch,
        taskId,
        attempt: normalizedAttempt,
        runId: identity.runId,
        timeoutMs: normalizedTimeoutMs,
      });
    }

    const parsed = nativeResultPayload(native);
    if (!parsed.terminal) return { status: 'RUNNING', runtime: this.store.getM12NativeSpecialistRuntime(taskId, normalizedAttempt), native_status: parsed.status || 'UNKNOWN', resumed: Boolean(existing) };
    const runtime = this.store.getM12NativeSpecialistRuntime(taskId, normalizedAttempt);
    const returned = parsed.result && typeof parsed.result === 'object' ? parsed.result : {};
    for (const [field, expected] of [
      ['runId', runtime.run_id],
      ['sessionId', runtime.native_session_id],
      ['taskId', taskId],
      ['leaseId', binding.leaseId],
      ['environmentId', binding.environmentId],
      ['nodeId', binding.nodeId],
    ]) {
      if (returned[field] !== undefined && (typeof returned[field] !== 'string' || returned[field] !== expected)) {
        throw new Error(`Gateway native result binding mismatch: ${field}`);
      }
    }
    const reconciled = this.store.reconcileM12NativeSpecialistResult({
      taskId,
      attempt: normalizedAttempt,
      leaseId: binding.leaseId,
      runId: runtime.run_id,
      nativeSessionId: runtime.native_session_id,
      status: SUCCESS_NATIVE_STATES.has(parsed.status) ? 'SUCCEEDED' : 'FAILED',
      output: parsed.output,
      result: parsed.result,
    });
    return { ...reconciled, native_status: parsed.status, resumed: Boolean(existing) };
  }
}

export { TERMINAL_NATIVE_STATES };
