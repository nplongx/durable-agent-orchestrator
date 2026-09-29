import { evaluateLangGraph, LangGraphActions } from './langgraph-orchestrator.js';
import { WorkflowPhase } from './workflow/phases.js';

export class LangGraphControlLoop {
  constructor({ store, scheduler, provider, graph = evaluateLangGraph } = {}) {
    if (!store || !scheduler || !provider) throw new Error('LangGraphControlLoop requires store, scheduler and provider');
    this.store = store;
    this.scheduler = scheduler;
    this.provider = provider;
    this.graph = graph;
  }

  _activeProviderRuns(jobId) {
    return this.store.db.prepare(`SELECT pr.*, l.lease_id, l.attempt AS lease_attempt
      FROM provider_runs pr JOIN task_leases l ON l.lease_id=pr.lease_id
      WHERE pr.job_id=? AND l.state='ACTIVE'`).all(jobId);
  }

  async reconcile(jobId) {
    const active = this._activeProviderRuns(jobId);
    const reconciled = [];
    for (const run of active) {
      const status = await this.provider.getStatus(run.provider_run_id);
      if (status.status !== 'COMPLETED') continue;
      let result;
      try {
        result = await this.provider.collectResult(run.provider_run_id);
      } catch (error) {
        this.store.expireTaskLease(run.lease_id, { reason: `evidence_rejected: ${error.message}` });
        reconciled.push({ taskId: run.task_id, leaseId: run.lease_id, status: 'REJECTED', error: error.message });
        continue;
      }
      const applied = this.store.applyVerifiedExecutionResult(result);
      reconciled.push({ taskId: run.task_id, leaseId: run.lease_id, status: applied.status, result });
    }
    return reconciled;
  }

  async tick({ jobId, inputCommit, event = 'control.tick', hooks = {} } = {}) {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    this.store.reapExpiredTaskLeases({ jobId });
    const reconciled = await this.reconcile(jobId);
    const refreshedJob = this.store.getJob(jobId);
    const tasks = this.store.db.prepare('SELECT * FROM tasks WHERE job_id=? ORDER BY created_at ASC').all(jobId);
    const results = this.store.db.prepare(`SELECT r.* FROM results r JOIN tasks t ON t.task_id=r.task_id WHERE t.job_id=? ORDER BY r.created_at DESC`).all(jobId);
    const plan = this.store.getExecutionPlan(jobId);
    const decision = await this.graph({
      job: refreshedJob, tasks, results, plan,
      runtime: this.store.getWorkflowRuntimeState(jobId),
      event, persist: true, store: this.store,
      executeTask: async task => this.scheduler.dispatchTask(task, { inputCommit }),
      ...hooks
    });
    if (decision.action === LangGraphActions.RUN_CHILDREN) {
      const dispatched = await this.scheduler.dispatchPending({ inputCommit });
      return { job: this.store.getJob(jobId), decision, reconciled, dispatched };
    }
    return { job: this.store.getJob(jobId), decision, reconciled, dispatched: [] };
  }
}

export { WorkflowPhase };
