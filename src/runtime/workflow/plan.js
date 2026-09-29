export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function validateExecutionPlan(plan) {
  if (!plan?.workflow_id) throw new Error('execution plan workflow_id is required');
  if (!Number.isInteger(plan.workflow_version) || plan.workflow_version < 1) throw new Error('invalid execution plan workflow_version: ' + plan.workflow_version);
  if (!plan.job_id) throw new Error('execution plan job_id is required');
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) throw new Error('execution plan phases are required');
  if (!Array.isArray(plan.children)) throw new Error('execution plan children are required');
  if (!plan.synthesis) throw new Error('execution plan synthesis is required');
  const ids = new Set();
  for (const task of [...plan.children, plan.synthesis]) {
    if (!task?.id || ids.has(task.id)) throw new Error('invalid or duplicate execution plan task: ' + task?.id);
    ids.add(task.id);
    if (!task.role) throw new Error('execution plan task role is required: ' + task.id);
    if (task.capability != null && typeof task.capability !== 'string') throw new Error('execution plan task capability is invalid: ' + task.id);
    if (!Array.isArray(task.dependencies)) throw new Error('execution plan task dependencies are required: ' + task.id);
    for (const dependency of task.dependencies) {
      if (typeof dependency !== 'string' || !dependency) throw new Error('invalid execution plan dependency: ' + task.id);
      if (dependency === task.id) throw new Error('execution plan task cannot depend on itself: ' + task.id);
    }
    if (task.execution?.deterministic) {
      if (task.execution.executor !== 'ExecutionManager') throw new Error('deterministic task must use ExecutionManager: ' + task.id);
      if (!task.execution.executable || !Array.isArray(task.execution.args)) throw new Error('structured execution contract required: ' + task.id);
      if (!task.execution.cwd || !Number.isInteger(task.execution.timeout_ms) || task.execution.timeout_ms <= 0) throw new Error('invalid deterministic execution metadata: ' + task.id);
    }
  }
  const taskIds = new Set([...plan.children, plan.synthesis].map(task => task.id));
  for (const task of [...plan.children, plan.synthesis]) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) throw new Error(`execution plan dependency not found: ${task.id} -> ${dependency}`);
    }
  }
  return plan;
}
