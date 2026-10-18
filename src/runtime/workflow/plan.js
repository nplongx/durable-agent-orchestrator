import { parseStrictJson } from '../strict-json.js';
import { getAgentContract } from './agent-contracts.js';

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    // Do not assign untrusted JSON keys to an ordinary object: `__proto__`
    // invokes Object.prototype's legacy setter and silently disappears from
    // the canonical representation. That can collapse distinct plan/evidence
    // documents to the same hash. A null-prototype dictionary treats every
    // own key as data while JSON.stringify still emits canonical key order.
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(out, key, {
        value: canonicalize(value[key]), enumerable: true, writable: true, configurable: true
      });
    }
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function assertTaskDependenciesMatchPlan(task, plannedTask, label = 'task') {
  let dependencies;
  try {
    dependencies = parseStrictJson(task?.dependency_json ?? '[]', `${label} durable dependencies`);
  } catch (error) {
    throw new Error(`${label} durable dependencies are malformed: ${error.message}`);
  }
  const expected = plannedTask?.dependencies;
  if (!Array.isArray(dependencies) || !Array.isArray(expected) ||
      canonicalJson(dependencies) !== canonicalJson(expected)) {
    throw new Error(`${label} durable dependencies differ from the immutable execution plan`);
  }
  return dependencies;
}

export function validateExecutionPlan(plan) {
  if (!plan?.workflow_id) throw new Error('execution plan workflow_id is required');
  if (!Number.isInteger(plan.workflow_version) || plan.workflow_version < 1) throw new Error('invalid execution plan workflow_version: ' + plan.workflow_version);
  if (!plan.job_id) throw new Error('execution plan job_id is required');
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) throw new Error('execution plan phases are required');
  if (plan.phases.some(phase => typeof phase !== 'string' || !phase.trim()) || new Set(plan.phases).size !== plan.phases.length) {
    throw new Error('execution plan phases must contain unique non-empty string identities');
  }
  if (!Array.isArray(plan.children)) throw new Error('execution plan children are required');
  if (!Array.isArray(plan.required_children) || plan.required_children.some(item => typeof item !== 'string' || !item.trim()) ||
      new Set(plan.required_children).size !== plan.required_children.length) {
    throw new Error('execution plan required_children must contain unique non-empty string identities');
  }
  if (!plan.synthesis) throw new Error('execution plan synthesis is required');
  const ids = new Set();
  for (const task of [...plan.children, plan.synthesis]) {
    if (!task?.id || ids.has(task.id)) throw new Error('invalid or duplicate execution plan task: ' + task?.id);
    ids.add(task.id);
    if (!task.role) throw new Error('execution plan task role is required: ' + task.id);
    if (task.capability != null && typeof task.capability !== 'string') throw new Error('execution plan task capability is invalid: ' + task.id);
    if (!Array.isArray(task.dependencies)) throw new Error('execution plan task dependencies are required: ' + task.id);
    const dependencyIds = new Set();
    for (const dependency of task.dependencies) {
      if (typeof dependency !== 'string' || !dependency) throw new Error('invalid execution plan dependency: ' + task.id);
      if (dependency === task.id) throw new Error('execution plan task cannot depend on itself: ' + task.id);
      if (dependencyIds.has(dependency)) throw new Error(`duplicate execution plan dependency: ${task.id} -> ${dependency}`);
      dependencyIds.add(dependency);
    }
    if (task.execution?.deterministic) {
      if (task.execution.executor !== 'ExecutionManager') throw new Error('deterministic task must use ExecutionManager: ' + task.id);
      if (!task.execution.executable || !Array.isArray(task.execution.args)) throw new Error('structured execution contract required: ' + task.id);
      if (!task.execution.cwd || !Number.isInteger(task.execution.timeout_ms) || task.execution.timeout_ms <= 0) throw new Error('invalid deterministic execution metadata: ' + task.id);
    }
  }
  // Terminalization and recovery consume required_children independently of
  // the scheduler's children list. Keep the two immutable representations in
  // lockstep. Custom plans store generated child role names here; built-in
  // plans store task IDs.
  const expectedRequiredChildren = plan.custom_workflow
    ? plan.children.map(task => task.role)
    : plan.children.map(task => task.id);
  if (canonicalJson(plan.required_children) !== canonicalJson(expectedRequiredChildren)) {
    throw new Error('execution plan required_children do not match the immutable child task identities');
  }
  const taskIds = new Set([...plan.children, plan.synthesis].map(task => task.id));
  for (const task of [...plan.children, plan.synthesis]) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) throw new Error(`execution plan dependency not found: ${task.id} -> ${dependency}`);
    }
  }
  // A dependency graph must be a DAG. A merely well-referenced cyclic plan
  // can otherwise remain permanently blocked or be interpreted differently
  // by schedulers/recovery code that only checks immediate prerequisites.
  const tasksById = new Map([...plan.children, plan.synthesis].map(task => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (taskId, path = []) => {
    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      throw new Error(`execution plan dependency cycle: ${[...path.slice(cycleStart), taskId].join(' -> ')}`);
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of tasksById.get(taskId).dependencies) visit(dependency, [...path, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of tasksById.keys()) visit(taskId);

  // Built-in engineering role contracts declare evidence inputs. Every input
  // must have a producer in the task's transitive immutable dependency graph;
  // otherwise the runtime can issue a reviewer/CTO task that is structurally
  // incapable of receiving the evidence its contract requires.
  if (!plan.custom_workflow && (plan.workflow_id === 'standard-engineering' ||
      (plan.workflow_id === 'engineering' && plan.workflow_version >= 2))) {
    for (const task of [...plan.children, plan.synthesis]) {
      const contract = getAgentContract(task.role);
      const ancestors = new Set();
      const collectAncestors = dependencyId => {
        if (ancestors.has(dependencyId)) return;
        ancestors.add(dependencyId);
        for (const ancestor of tasksById.get(dependencyId).dependencies) collectAncestors(ancestor);
      };
      for (const dependency of task.dependencies) collectAncestors(dependency);
      const availableInputs = new Set([...ancestors]
        .flatMap(ancestorId => getAgentContract(tasksById.get(ancestorId).role).outputs));
      for (const input of contract.inputs) {
        if (input === 'job.request') continue;
        if (!availableInputs.has(input)) {
          throw new Error(`execution plan role input has no dependency-bound artifact producer: ${task.id} (${task.role}) <- ${input}`);
        }
      }
    }
  }
  return plan;
}
