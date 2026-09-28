import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { WorkflowPhase } from './workflow/phases.js';
import { ProductionRoles } from './workflow/catalog/production.js';
import { isProductionWorkflow } from './workflow/definitions/production.js';

export const LangGraphActions = Object.freeze({
  NOOP: 'NOOP',
  SPAWN_CTO: 'SPAWN_CTO',
  ASSIGN_CHILDREN: 'ASSIGN_CHILDREN',
  RUN_CHILDREN: 'RUN_CHILDREN',
  WAIT: 'WAIT',
  VALIDATE_EVIDENCE: 'VALIDATE_EVIDENCE',
  SYNTHESIZE: 'SYNTHESIZE',
  TERMINALIZE: 'TERMINALIZE',
  PROJECT: 'PROJECT',
  BLOCK: 'BLOCK'
});

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout']);
export { WorkflowPhase };

function production(job) { return isProductionWorkflow(job); }
function executionSpec(task) {
  try { return JSON.parse(task?.metadata_json || '{}'); } catch (_) { return {}; }
}

function evidenceValid(task, result) {
  const spec = executionSpec(task);
  return spec.executor === 'ExecutionManager'
    && spec.command
    && spec.cwd
    && task?.execution_status === 'completed'
    && Number(task?.execution_exit_code) === 0
    && result?.outcome === 'success';
}

const GraphState = Annotation.Root({
  job: Annotation({ default: () => null }),
  tasks: Annotation({ default: () => [] }),
  results: Annotation({ default: () => [] }),
  runtime: Annotation({ default: () => null }),
  synthesisDispatched: Annotation({ default: () => false }),
  event: Annotation({ default: () => 'turn' }),
  action: Annotation({ default: () => LangGraphActions.NOOP }),
  reason: Annotation({ default: () => '' })
});

function classify(state) {
  const job = state.job;
  const runtime = state.runtime;
  if (!job || !runtime) return { action: LangGraphActions.BLOCK, reason: 'missing durable workflow state' };

  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const cto = tasks.find(t => t.task_id === job.active_task_id && String(t.role).toLowerCase() === 'cto');
  const children = cto ? tasks.filter(t => t.parent_task_id === cto.task_id) : [];
  const required = ProductionRoles.map(role => children.find(t => String(t.role).toLowerCase() === role));
  const results = new Map((state.results || []).map(r => [r.task_id, r]));

  switch (runtime.phase) {
    case WorkflowPhase.PROPOSED:
      return { action: LangGraphActions.NOOP, reason: 'awaiting approval' };
    case WorkflowPhase.APPROVED:
      return { action: LangGraphActions.SPAWN_CTO, reason: 'approved job requires CTO native spawn' };
    case WorkflowPhase.SPAWN_CTO:
      return cto?.openclaw_session_key
        ? { action: LangGraphActions.ASSIGN_CHILDREN, reason: 'CTO runtime attached; assign required children' }
        : { action: LangGraphActions.SPAWN_CTO, reason: 'waiting for CTO native runtime attachment' };
    case WorkflowPhase.ASSIGN_CHILDREN: {
      const missing = required.filter(Boolean).length < ProductionRoles.length;
      return missing
        ? { action: LangGraphActions.ASSIGN_CHILDREN, reason: 'required child assignments incomplete' }
        : { action: LangGraphActions.RUN_CHILDREN, reason: 'required child assignments complete' };
    }
    case WorkflowPhase.RUN_CHILDREN:
      return { action: LangGraphActions.WAIT, reason: 'children dispatched; runtime owns completion waiting' };
    case WorkflowPhase.WAIT: {
      const open = required.filter(t => !t || !TERMINAL.has(String(t.status).toLowerCase()));
      return open.length
        ? { action: LangGraphActions.WAIT, reason: `waiting for: ${open.map(t => t?.role || 'missing').join(', ')}` }
        : { action: LangGraphActions.VALIDATE_EVIDENCE, reason: 'all required children terminal' };
    }
    case WorkflowPhase.VALIDATE_EVIDENCE: {
      if (!production(job)) return { action: LangGraphActions.SYNTHESIZE, reason: 'non-E2E evidence gate delegated to workflow policy' };
      const invalid = required.filter(t => !evidenceValid(t, results.get(t?.task_id)));
      return invalid.length
        ? { action: LangGraphActions.BLOCK, reason: `invalid execution evidence: ${invalid.map(t => t?.role || 'missing').join(', ')}` }
        : { action: LangGraphActions.SYNTHESIZE, reason: 'required execution evidence validated' };
    }
    case WorkflowPhase.SYNTHESIZE:
      if (cto && String(cto.status).toLowerCase() === 'completed') {
        return { action: LangGraphActions.TERMINALIZE, reason: 'CTO synthesis terminal; durable terminalization required' };
      }
      if (state.synthesisDispatched && cto && String(cto.status).toLowerCase() === 'running') {
        return { action: LangGraphActions.NOOP, reason: 'CTO synthesis attempt active; awaiting terminal result' };
      }
      return state.synthesisDispatched && cto && String(cto.status).toLowerCase() === 'pending'
        ? { action: LangGraphActions.SYNTHESIZE, reason: 'CTO synthesis attempt not attached; dispatch required' }
        : { action: LangGraphActions.SYNTHESIZE, reason: 'CTO synthesis attempt failed or is absent; retry required' };
    case WorkflowPhase.TERMINALIZE:
      return job.state === 'COMPLETED'
        ? { action: LangGraphActions.PROJECT, reason: 'job terminal; durable Slack projection required' }
        : { action: LangGraphActions.TERMINALIZE, reason: 'durable terminalization required' };
    case WorkflowPhase.PROJECT:
      return { action: LangGraphActions.PROJECT, reason: 'durable Slack projection required' };
    case WorkflowPhase.COMPLETED:
      return { action: LangGraphActions.NOOP, reason: 'workflow completed' };
    case WorkflowPhase.FAILED:
      return { action: LangGraphActions.NOOP, reason: 'workflow failed' };
    default:
      return { action: LangGraphActions.BLOCK, reason: `unknown workflow phase: ${runtime.phase}` };
  }
}

const graph = new StateGraph(GraphState)
  .addNode('classify', classify)
  .addEdge(START, 'classify')
  .addEdge('classify', END)
  .compile();

export async function evaluateLangGraph({ job, tasks = [], results = [], runtime: suppliedRuntime = null, event = 'turn', persist = false, store = null, executeTask = null, spawnCto = null, assignChildren = null, synthesize = null, terminalize = null, project = null }) {
  let runtime = store?.getWorkflowRuntimeState(job?.job_id) || suppliedRuntime;
  if (persist && store && runtime?.phase === WorkflowPhase.PROPOSED && job?.state === 'APPROVED') {
    store.transitionWorkflowPhase(job.job_id, WorkflowPhase.SPAWN_CTO, {
      event: 'workflow.transition', payload: { trigger: event }
    });
    runtime = store.getWorkflowRuntimeState(job.job_id);
  }
  const cto = (tasks || []).find(t => t.task_id === job?.active_task_id && String(t.role).toLowerCase() === 'cto');
  const synthesisDispatched = Boolean(
    store?.hasEvent?.(job?.job_id, 'workflow.synthesis_dispatched')
      && String(cto?.status || '').toLowerCase() === 'running'
  );
  const decision = await graph.invoke({ job, tasks, results, runtime, synthesisDispatched, event });
  if (!persist || !store || !runtime) return decision;

  const phase = runtime.phase;
  if (decision.action === LangGraphActions.SPAWN_CTO && typeof spawnCto === 'function') {
    try { await spawnCto({ job, tasks, store }); }
    catch (error) { return { ...decision, action: LangGraphActions.BLOCK, reason: 'CTO spawn failed: ' + error.message }; }
  }
  if (decision.action === LangGraphActions.ASSIGN_CHILDREN && typeof assignChildren === 'function') {
    try {
      await assignChildren({ job, tasks, store });
    } catch (error) {
      const message = String(error?.message || error);
      const waitMatch = message.match(/PROVIDER_UNAVAILABLE:.*?retry after\s+(\d+)s/i);
      if (waitMatch) {
        const resumeAfter = new Date(Date.now() + Number(waitMatch[1]) * 1000).toISOString();
        store.setWorkflowRuntimeState(job.job_id, phase, { resumeAfter, lastError: message });
      }
      return { ...decision, action: LangGraphActions.BLOCK, reason: `child assignment failed: ${error.message}` };
    }
  }
  if (decision.action === LangGraphActions.SYNTHESIZE && typeof synthesize === 'function') {
    try { await synthesize({ job, tasks, results, store }); }
    catch (error) { return { ...decision, action: LangGraphActions.BLOCK, reason: `synthesis dispatch failed: ${error.message}` }; }
  }
  if (decision.action === LangGraphActions.TERMINALIZE && typeof terminalize === 'function') {
    try { await terminalize({ job, tasks, results, store }); }
    catch (error) { return { ...decision, action: LangGraphActions.BLOCK, reason: `terminalization failed: ${error.message}` }; }
  }
  if (decision.action === LangGraphActions.PROJECT && typeof project === 'function') {
    try { await project({ job, store }); }
    catch (error) { return { ...decision, action: LangGraphActions.BLOCK, reason: `projection failed: ${error.message}` }; }
  }
  let next = {
    [LangGraphActions.SPAWN_CTO]: WorkflowPhase.ASSIGN_CHILDREN,
    [LangGraphActions.ASSIGN_CHILDREN]: WorkflowPhase.ASSIGN_CHILDREN,
    [LangGraphActions.RUN_CHILDREN]: WorkflowPhase.RUN_CHILDREN,
    [LangGraphActions.WAIT]: WorkflowPhase.WAIT,
    [LangGraphActions.VALIDATE_EVIDENCE]: WorkflowPhase.VALIDATE_EVIDENCE,
    [LangGraphActions.SYNTHESIZE]: WorkflowPhase.SYNTHESIZE,
    [LangGraphActions.TERMINALIZE]: WorkflowPhase.TERMINALIZE,
    [LangGraphActions.PROJECT]: WorkflowPhase.COMPLETED
  }[decision.action];
  if (decision.action === LangGraphActions.PROJECT && phase === WorkflowPhase.TERMINALIZE) {
    next = WorkflowPhase.PROJECT;
  }
  if (next && next !== phase) {
    try { store.transitionWorkflowPhase(job.job_id, next, { event: 'workflow.transition', payload: { trigger: event, reason: decision.reason } }); }
    catch (error) { return { ...decision, action: LangGraphActions.BLOCK, reason: error.message }; }
  }
  if (decision.action === LangGraphActions.RUN_CHILDREN && typeof executeTask === 'function') {
    const cto = tasks.find(t => t.task_id === job.active_task_id && String(t.role).toLowerCase() === 'cto');
    const children = cto ? tasks.filter(t => t.parent_task_id === cto.task_id) : [];
    const deterministic = children.filter(task => {
      const spec = executionSpec(task);
        return ProductionRoles.includes(String(task.role).toLowerCase())
        && spec.executor === 'ExecutionManager'
        && spec.command
        && spec.cwd
        && !['completed'].includes(String(task.execution_status).toLowerCase());
    });
    await Promise.all(deterministic.map(task => executeTask(task)));
  }
  return decision;
}

export { GraphState };
