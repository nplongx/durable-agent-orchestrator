import crypto from 'node:crypto';

const id = () => `lease_${crypto.randomUUID()}`;

export class TaskLeaseManager {
  constructor(store, { ttlMs = 60000, workerId = process.env.WORKER_ID || `worker-${process.pid}` } = {}) {
    this.store = store;
    this.ttlMs = Math.max(1000, Number(ttlMs) || 60000);
    this.workerId = workerId;
  }

  acquire(taskId, { attempt = null } = {}) {
    return this.store.acquireTaskLease(taskId, { leaseId: id(), workerId: this.workerId, ttlMs: this.ttlMs, attempt });
  }

  heartbeat(leaseId) {
    return this.store.heartbeatTaskLease(leaseId, { workerId: this.workerId, ttlMs: this.ttlMs });
  }

  complete(leaseId, { success = true, error = null } = {}) {
    return this.store.completeTaskLease(leaseId, { workerId: this.workerId, success, error });
  }

  recover({ now = Date.now(), jobId = null } = {}) {
    return this.store.reapExpiredTaskLeases({ now, jobId });
  }
}
