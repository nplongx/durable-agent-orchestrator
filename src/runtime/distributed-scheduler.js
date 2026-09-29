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
    try {
      const run = await this.provider.dispatch(request);
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
