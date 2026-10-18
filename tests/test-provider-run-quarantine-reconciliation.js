import assert from 'node:assert/strict';
import { LangGraphControlLoop } from '../src/runtime/langgraph-control-loop.js';

function fixtureStore(initialRun, { applyResult = { status: 'VERIFIED' } } = {}) {
  const events = new Map();
  const lease = {
    lease_id: initialRun.lease_id, state: initialRun.lease_state,
    last_error: initialRun.lease_last_error || null
  };
  let applied = 0;
  let heartbeat = 0;
  let expiry = 0;
  const store = {
    db: {
      prepare(sql) {
        if (sql.includes('FROM provider_runs')) return { all: () => [{ ...initialRun,
          lease_state: lease.state, lease_last_error: lease.last_error }] };
        if (sql.includes('FROM events WHERE event_id=?')) return { get: eventId => events.get(eventId) || null };
        throw new Error(`unexpected fake SQL: ${sql}`);
      }
    },
    recordEvent(jobId, type, payload, dedupeKey) {
      const eventId = `${jobId}|${type}|${dedupeKey}`;
      const row = { event_id: eventId, job_id: jobId, type, payload_json: JSON.stringify(payload) };
      const existing = events.get(eventId);
      if (!existing) events.set(eventId, row);
      return eventId;
    },
    heartbeatTaskLease() { heartbeat++; return { ok: true }; },
    expireTaskLease(_leaseId, { reason = 'provider_result_collection_uncertain' } = {}) {
      expiry++;
      lease.state = 'FAILED';
      lease.last_error = `REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION: ${reason}`;
      return lease;
    },
    getTaskLease() { return { ...lease }; },
    applyVerifiedExecutionResult() { applied++; return applyResult; },
    snapshot() { return { events: [...events.values()], applied, heartbeat, expiry, lease: { ...lease } }; }
  };
  return store;
}

function providerFor({ state = 'COMPLETED', result = null, statusError = null, collectError = null } = {}) {
  let statusCalls = 0;
  let collectCalls = 0;
  return {
    async getStatus() { statusCalls++; if (statusError) throw statusError; return { state }; },
    async collectResult() {
      collectCalls++;
      if (collectError) throw collectError;
      return result;
    },
    calls() { return { statusCalls, collectCalls }; }
  };
}

const baseRun = {
  job_id: 'job_quarantine_fixture', task_id: 'task_quarantine_fixture', lease_id: 'lease_quarantine_fixture',
  lease_attempt: 1, worker_id: 'worker_fixture', provider_run_id: '12345', lease_state: 'FAILED',
  lease_last_error: 'REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION: lease_expired'
};
const result = {
  schema_version: 1, job_id: baseRun.job_id, task_id: baseRun.task_id, lease_id: baseRun.lease_id,
  attempt: 1, status: 'SUCCEEDED', input_commit: 'a'.repeat(40), output_commit: 'b'.repeat(40),
  exit_code: 0, provider_run_id: baseRun.provider_run_id, evidence_artifact: 'p3-worker-12345',
  evidence_refs: ['task-payload.json', 'execution.json'], started_at: '2026-10-15T00:00:00.000Z',
  finished_at: '2026-10-15T00:01:00.000Z', error: null,
  evidence_verification: { valid: true, errors: [], evidence_hash: 'c'.repeat(64) }
};

{
  const activeRun = { ...baseRun, lease_state: 'ACTIVE', lease_last_error: null };
  const store = fixtureStore(activeRun);
  const provider = providerFor({ statusError: new Error('provider status read timed out') });
  const loop = new LangGraphControlLoop({ store, provider, scheduler: { leaseTtlMs: 60_000 } });
  const outcomes = await loop.reconcile(baseRun.job_id);
  assert.equal(outcomes[0].status, 'QUARANTINED_STATUS_REQUIRES_RECONCILIATION',
    'a status-read failure leaves remote execution outcome unknown and must not escape reconciliation');
  assert.equal(store.snapshot().expiry, 1, 'unknown remote outcome must stop renewing the lease and quarantine the attempt');
  assert.equal(store.snapshot().lease.state, 'FAILED');
  assert.match(store.snapshot().lease.last_error, /^REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION:/);
  assert.equal(store.snapshot().applied, 0);
  assert.equal(store.snapshot().events.length, 1);
  assert.equal(store.snapshot().events[0].type, 'task.execution.quarantine_status_failed');
  const observation = JSON.parse(store.snapshot().events[0].payload_json);
  assert.equal(observation.applied, false);
  assert.equal(observation.reconciliationRequired, true);
  assert.match(observation.statusErrorSha256, /^[a-f0-9]{64}$/);
}

{
  const store = fixtureStore({ ...baseRun });
  const provider = providerFor({ result });
  const loop = new LangGraphControlLoop({ store, provider, scheduler: { leaseTtlMs: 60_000 } });
  const outcomes = await loop.reconcile(baseRun.job_id);
  assert.equal(outcomes[0].status, 'QUARANTINED_RESULT_OBSERVED_NOT_APPLIED');
  assert.equal(store.snapshot().applied, 0, 'a quarantined provider result must never be applied automatically');
  assert.equal(store.snapshot().events.length, 1);
  assert.equal(store.snapshot().events[0].type, 'task.execution.quarantine_observed');
  const observation = JSON.parse(store.snapshot().events[0].payload_json);
  assert.equal(observation.applied, false);
  assert.equal(observation.reconciliationRequired, true);
  assert.equal(observation.evidenceHash, 'c'.repeat(64));
  assert.match(observation.resultSha256, /^[a-f0-9]{64}$/);
}

{
  const activeRun = { ...baseRun, lease_state: 'ACTIVE', lease_last_error: null };
  const store = fixtureStore(activeRun);
  const provider = providerFor({ state: 'IN_PROGRESS' });
  const loop = new LangGraphControlLoop({ store, provider, scheduler: { leaseTtlMs: 60_000 } });
  await loop.reconcile(activeRun.job_id);
  assert.equal(store.snapshot().heartbeat, 1, 'active remote runs must renew the exact durable lease owner');
  assert.equal(provider.calls().collectCalls, 0);
  assert.equal(store.snapshot().applied, 0);
}

{
  const activeRun = { ...baseRun, lease_state: 'ACTIVE', lease_last_error: null };
  const untrustedResult = { ...result, evidence_verification: { ...result.evidence_verification,
    output_commit_provenance: 'worker_reported_and_execution_json_bound_not_independently_attested' } };
  const store = fixtureStore(activeRun, { applyResult: { status: 'REJECTED', reason: 'output_commit_attestation_required' } });
  const provider = providerFor({ result: untrustedResult });
  const loop = new LangGraphControlLoop({ store, provider, scheduler: { leaseTtlMs: 60_000 } });
  const outcomes = await loop.reconcile(baseRun.job_id);
  assert.equal(outcomes[0].status, 'QUARANTINED_RESULT_OBSERVED_NOT_APPLIED');
  assert.equal(outcomes[0].reason, 'output_commit_attestation_required');
  assert.equal(store.snapshot().expiry, 1, 'unattested output must stop lease heartbeats and enter quarantine');
  assert.equal(store.snapshot().lease.state, 'FAILED');
  assert.match(store.snapshot().lease.last_error, /^REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION:/);
  assert.equal(store.snapshot().events.length, 1);
  const observation = JSON.parse(store.snapshot().events[0].payload_json);
  assert.equal(observation.applied, false);
  assert.equal(observation.reconciliationRequired, true);
  assert.equal(observation.workerReportedOutputCommit, result.output_commit);
  assert.equal(observation.outputCommitProvenance, 'worker_reported_and_execution_json_bound_not_independently_attested');
  assert.equal(Object.hasOwn(observation, 'outputCommit'), false,
    'quarantine event must not present the worker claim as a trusted output commit');
}

{
  const activeRun = { ...baseRun, lease_state: 'ACTIVE', lease_last_error: null };
  const store = fixtureStore(activeRun);
  const provider = providerFor({ collectError: new Error('fixture artifact bytes failed verification') });
  const loop = new LangGraphControlLoop({ store, provider, scheduler: { leaseTtlMs: 60_000 } });
  const outcomes = await loop.reconcile(activeRun.job_id);
  assert.equal(store.snapshot().expiry, 1);
  assert.equal(store.snapshot().lease.state, 'FAILED');
  assert.equal(outcomes[0].status, 'QUARANTINED_COLLECTION_REQUIRES_RECONCILIATION');
  assert.equal(store.snapshot().applied, 0);
  assert.equal(store.snapshot().events.length, 1);
  assert.equal(store.snapshot().events[0].type, 'task.execution.quarantine_collection_failed');
  assert.match(JSON.parse(store.snapshot().events[0].payload_json).collectionErrorSha256, /^[a-f0-9]{64}$/);
}

console.log('PROVIDER RUN QUARANTINE RECONCILIATION: lease heartbeats, durable observations, and no automatic apply/replay PASS');
