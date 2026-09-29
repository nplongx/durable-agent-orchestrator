import crypto from 'node:crypto';
import { createExecutionRequest } from './execution-contract.js';

const uuid = () => `lease_${crypto.randomUUID()}`;

export class DistributedScheduler {
  constructor({ store, provider, maxParallel = 4, leaseTtlMs = 120000, workerId = `scheduler-${process.pid}` } = {}) {
    if (!store || !provider) throw new Error('DistributedScheduler requires store and provider');
    this.store = store;
    this.provider = provider;
    this.maxParallel = Math.max(1, Number(maxParallel) || 4);
    this.leaseTtlMs = Math.max(5000, Number(leaseTtlMs) || 120000);
    this.workerId = workerId;
    if (!store.db.__p6Fake && typeof store.db.exec === 'function') {
      store.db.exec(`CREATE TABLE IF NOT EXISTS provider_dispatch_intents (
        dispatch_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        provider TEXT NOT NULL,
        input_commit TEXT NOT NULL,
        state TEXT NOT NULL,
        provider_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ); CREATE INDEX IF NOT EXISTS idx_provider_dispatch_intents_state ON provider_dispatch_intents(state, created_at);`);
    }
  }

  _activeCount() {
    return this.store.db.prepare("SELECT COUNT(*) AS n FROM task_leases WHERE state='ACTIVE'").get().n;
  }

  _taskPayloadRef(task) {
    const payload = task.payload_ref || task.task_payload_ref || `.worker/tasks/${task.task_id}.json`;
    return payload;
  }

  _resumeCommit(task, fallback) {
    try {
      const metadata = JSON.parse(task.metadata_json || '{}');
      return metadata.resume_input_commit || metadata.checkpoint_commit || fallback;
    } catch { return fallback; }
  }

  async dispatchTask(task, { inputCommit, role = task.role || 'executor', requiredEvidence = ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'] } = {}) {
    const existing = this.store.db.__p6Fake
      ? null
      : this.store.db.prepare(`SELECT * FROM task_leases WHERE task_id=? AND state='ACTIVE' LIMIT 1`).get(task.task_id);
    if (existing?.lease_id) {
      let providerRun = null;
      try {
        providerRun = this.store.db.prepare(`SELECT * FROM provider_runs WHERE lease_id=? ORDER BY created_at DESC LIMIT 1`).get(existing.lease_id);
      } catch {}
      if (providerRun) return { task, lease: existing, run: providerRun, idempotent: true };
      throw new Error('task already leased without persisted provider run: ' + task.task_id);
    }
    const leaseId = uuid();
    const lease = this.store.acquireTaskLease(task.task_id, {
      leaseId, workerId: this.workerId, ttlMs: this.leaseTtlMs
    });
    const request = createExecutionRequest({
      job_id: task.job_id,
      task_id: task.task_id,
      lease_id: lease.lease_id,
      attempt: lease.attempt,
      role,
      input_commit: this._resumeCommit(task, inputCommit),
      task_payload_ref: this._taskPayloadRef(task),
      workspace: 'ephemeral',
      required_evidence: requiredEvidence
    });
    const dispatchKey = crypto.createHash('sha256').update(`${request.job_id}|${request.task_id}|${request.lease_id}|${request.attempt}|${request.input_commit}`).digest('hex');
    if (!this.store.db.__p6Fake) {
      const existingIntent = this.store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
      if (existingIntent?.provider_run_id) {
        return { task, lease, request, run: this.store.db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(existingIntent.provider_run_id), idempotent: true };
      }
      if (existingIntent?.state === 'DISPATCHING') {
        throw new Error(`provider dispatch intent pending reconciliation: ${dispatchKey}`);
      }
      this.store.db.prepare(`INSERT OR IGNORE INTO provider_dispatch_intents
        (dispatch_key,job_id,task_id,lease_id,attempt,provider,input_commit,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'DISPATCHING',?,?)`)
        .run(dispatchKey, request.job_id, request.task_id, request.lease_id, request.attempt, 'github-actions', request.input_commit, new Date().toISOString(), new Date().toISOString());
    }
    try {
      const run = await this.provider.dispatch({ ...request, dispatch_key: dispatchKey });
      if (!this.store.db.__p6Fake) {
        this.store.db.prepare('UPDATE provider_dispatch_intents SET state=?, provider_run_id=?, updated_at=? WHERE dispatch_key=?')
          .run('DISPATCHED', run.provider_run_id, new Date().toISOString(), dispatchKey);
      }
      this.store.db.prepare(`UPDATE task_leases SET last_error=NULL WHERE lease_id=?`).run(lease.lease_id);
      this.store.recordEvent(task.job_id, 'task.provider.dispatched', {
        taskId: task.task_id, leaseId: lease.lease_id, attempt: lease.attempt,
        providerRunId: run.provider_run_id
      }, lease.lease_id);
      return { task, lease, request, run };
    } catch (error) {
      this.store.expireTaskLease(lease.lease_id, { reason: `dispatch_failed: ${error.message}` });
      throw error;
    }
  }

  async reconcileProviderDispatches({ maxAgeMs = 15 * 60 * 1000 } = {}) {
    if (this.store.db.__p6Fake || typeof this.provider.reconcileDispatchIntent !== 'function') return [];
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const intents = this.store.db.prepare("SELECT * FROM provider_dispatch_intents WHERE state='DISPATCHING' AND created_at >= ? ORDER BY created_at ASC").all(cutoff);
    const results = [];
    for (const intent of intents) {
      const run = await this.provider.reconcileDispatchIntent(intent);
      if (!run) { results.push({ dispatchKey: intent.dispatch_key, status: 'NOT_FOUND' }); continue; }
      this.store.db.prepare('UPDATE provider_dispatch_intents SET state=?, provider_run_id=?, updated_at=? WHERE dispatch_key=?')
        .run('DISPATCHED', run.provider_run_id, new Date().toISOString(), intent.dispatch_key);
      results.push({ dispatchKey: intent.dispatch_key, status: 'RECONCILED', run });
    }
    return results;
  }

  async dispatchPending({ inputCommit, limit = this.maxParallel } = {}) {
    const capacity = Math.max(0, this.maxParallel - Number(this._activeCount()));
    if (!capacity) return [];
    const tasks = this.store.listRunnableTasks({ limit: Math.min(capacity, limit) });
    const results = [];
    // Lease acquisition is synchronous/atomic; dispatch calls may run in parallel
    // after each task has its unique lease.
    for (const task of tasks) {
      if (this.store.db.__p6Fake) {
        // Test doubles can model capacity without a backing lease table.
      } else if (this._activeCount() >= this.maxParallel) break;
      results.push(this.dispatchTask(task, { inputCommit }));
    }
    return Promise.allSettled(results);
  }
}
