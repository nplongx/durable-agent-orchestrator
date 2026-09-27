// LangGraph orchestration POC.
//
// This graph is deliberately NOT a second source of truth and does not own
// OpenClaw sessions. SQLite remains authoritative; OpenClaw sessions_spawn
// remains the execution primitive. The graph is an event-driven deterministic
// policy layer: invoke it again after approval/child events/report attempts.

import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

export const LangGraphActions = Object.freeze({
  NOOP: 'NOOP',
  SPAWN_CTO: 'SPAWN_CTO',
  WAIT_CHILDREN: 'WAIT_CHILDREN',
  SYNTHESIZE: 'SYNTHESIZE',
  TERMINALIZE: 'TERMINALIZE',
  BLOCK: 'BLOCK'
});

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout']);
const REQUIRED_PRODUCTION_ROLES = ['architect', 'qa'];

function isProductionE2E(job) {
  return /production e2e/i.test(String(job?.title || ''));
}

function requiredChildren(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const parentTaskId = state.job?.active_task_id;
  const children = tasks.filter(t => parentTaskId && t.parent_task_id === parentTaskId);
  return REQUIRED_PRODUCTION_ROLES.map(role => ({
    role,
    task: children.find(t => String(t.role).toLowerCase() === role) || null
  }));
}

function hasActualEvidence(result) {
  const text = String(result?.content || '');
  return /\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(text) &&
    /exit\s*(?:status|code)(?:\/code)?\s*(?::|=)?\s*(?:was\s+successful\s*\()?\s*\d+/i.test(text);
}

const GraphState = Annotation.Root({
  job: Annotation({ default: () => null }),
  tasks: Annotation({ default: () => [] }),
  results: Annotation({ default: () => [] }),
  event: Annotation({ default: () => 'turn' }),
  action: Annotation({ default: () => LangGraphActions.NOOP }),
  reason: Annotation({ default: () => '' })
});

function classify(state) {
  const job = state.job;
  if (!job) return { action: LangGraphActions.BLOCK, reason: 'no durable job' };

  const jobState = String(job.state || '').toUpperCase();
  if (jobState === 'APPROVED') {
    return { action: LangGraphActions.SPAWN_CTO, reason: 'approved durable job requires native CTO dispatch' };
  }
  if (jobState !== 'EXECUTING') {
    return { action: LangGraphActions.NOOP, reason: `job state=${jobState}` };
  }

  if (!isProductionE2E(job)) {
    return { action: LangGraphActions.NOOP, reason: 'non-production-e2e job remains on legacy orchestration path' };
  }

  const children = requiredChildren(state);
  const missing = children.filter(x => !x.task).map(x => x.role);
  if (missing.length) {
    return { action: LangGraphActions.SPAWN_CTO, reason: `missing required children: ${missing.join(', ')}` };
  }

  const open = children.filter(x => !TERMINAL.has(String(x.task.status).toLowerCase()));
  if (open.length) {
    return { action: LangGraphActions.WAIT_CHILDREN, reason: `waiting for: ${open.map(x => x.role).join(', ')}` };
  }

  const byTask = new Map((state.results || []).map(r => [r.task_id, r]));
  const failed = children.filter(x => ['failed', 'timeout'].includes(String(x.task.status).toLowerCase()));
  if (failed.length) {
    return { action: LangGraphActions.SYNTHESIZE, reason: `child failure requires factual synthesis: ${failed.map(x => x.role).join(', ')}` };
  }

  const missingEvidence = children.filter(x => !hasActualEvidence(byTask.get(x.task.task_id)));
  if (missingEvidence.length) {
    return { action: LangGraphActions.BLOCK, reason: `terminal child lacks actual execution evidence: ${missingEvidence.map(x => x.role).join(', ')}` };
  }

  return { action: LangGraphActions.SYNTHESIZE, reason: 'all required children terminal with actual evidence' };
}

const graph = new StateGraph(GraphState)
  .addNode('classify', classify)
  .addEdge(START, 'classify')
  .addEdge('classify', END)
  .compile();

export async function evaluateLangGraph({ job, tasks = [], results = [], event = 'turn' }) {
  return graph.invoke({ job, tasks, results, event });
}

export { GraphState };
