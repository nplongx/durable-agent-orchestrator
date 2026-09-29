import { WorkflowPhase } from './workflow/phases.js';

const TERMINAL_PHASES = new Set([WorkflowPhase.COMPLETED, WorkflowPhase.FAILED]);
const TERMINAL_JOB_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export class AutonomousDeliveryRunner {
  constructor({ controlLoop, store, scheduler, pollMs = 2000, maxTicks = 300, hooks = {} } = {}) {
    if (!controlLoop || !store || !scheduler) throw new Error('AutonomousDeliveryRunner requires controlLoop, store and scheduler');
    this.controlLoop = controlLoop;
    this.store = store;
    this.scheduler = scheduler;
    this.pollMs = Math.max(0, Number(pollMs) || 0);
    this.maxTicks = Math.max(1, Number(maxTicks) || 300);
    this.hooks = hooks;
  }

  _heartbeat(jobId) {
    const workerId = this.scheduler.workerId;
    if (!workerId || typeof this.store.listTaskLeases !== 'function') return [];
    const active = this.store.listTaskLeases({ state: 'ACTIVE' });
    return active
      .filter(lease => !jobId || lease.job_id === jobId)
      .map(lease => this.store.heartbeatTaskLease(lease.lease_id, {
        workerId,
        ttlMs: this.scheduler.leaseTtlMs
      }));
  }

  async run({ jobId, inputCommit, onTick = null } = {}) {
    if (!jobId) throw new Error('jobId is required');
    if (!inputCommit) throw new Error('inputCommit is required');
    const history = [];
    for (let tick = 1; tick <= this.maxTicks; tick++) {
      const before = this.store.getJob(jobId);
      if (!before) throw new Error(`job not found: ${jobId}`);
      if (TERMINAL_JOB_STATES.has(String(before.state).toUpperCase()) || TERMINAL_PHASES.has(this.store.getWorkflowRuntimeState(jobId)?.phase)) {
        return { job: before, ticks: tick - 1, history };
      }

      this._heartbeat(jobId);
      const out = await this.controlLoop.tick({
        jobId,
        inputCommit,
        event: `autonomous.tick.${tick}`,
        hooks: this.hooks
      });
      history.push({ tick, decision: out.decision?.action || null, reason: out.decision?.reason || null, reconciled: out.reconciled || [], dispatched: out.dispatched || [] });
      if (typeof onTick === 'function') await onTick(out, tick);

      const after = out.job || this.store.getJob(jobId);
      const phase = this.store.getWorkflowRuntimeState(jobId)?.phase;
      if (TERMINAL_JOB_STATES.has(String(after?.state || '').toUpperCase()) || TERMINAL_PHASES.has(phase)) {
        return { job: after, ticks: tick, history };
      }
      if (this.pollMs) await sleep(this.pollMs);
    }
    throw new Error(`autonomous delivery exceeded maxTicks=${this.maxTicks}`);
  }
}

export { TERMINAL_PHASES };
