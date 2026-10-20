import { parseStrictJson } from '../strict-json.js';
import path from 'node:path';
import { getAgentContract } from './agent-contracts.js';
import { validateSuccessContract } from './success-contract.js';
import { composePolicySuccessContract, validateValidationProfileSnapshot, materializeValidationProfileTasks } from './policy-contract.js';
import { validateRoleProfileOverlay } from './role-profiles.js';

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

const BATCH_EXECUTION_POLICY_KEYS = Object.freeze([
  'schema_version', 'mode', 'scope', 'route', 'grouping', 'evidence',
  'workspace_fingerprint_required', 'validation_task_ids', 'exemption_reason'
]);

function validateBatchExecutionPolicy(policy, plan) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('execution plan batch_execution_policy is required for schema version 2');
  const actualKeys = Object.keys(policy).sort();
  if (canonicalJson(actualKeys) !== canonicalJson([...BATCH_EXECUTION_POLICY_KEYS].sort())) throw new Error('batch execution policy fields are missing or unsupported');
  if (policy.schema_version !== 1 || !['required', 'exempt'].includes(policy.mode) || policy.scope !== 'deterministic-local' ||
      !Array.isArray(policy.validation_task_ids) || policy.validation_task_ids.some(id => typeof id !== 'string' || !id.trim()) ||
      new Set(policy.validation_task_ids).size !== policy.validation_task_ids.length || typeof policy.workspace_fingerprint_required !== 'boolean' ||
      !(policy.exemption_reason === null || typeof policy.exemption_reason === 'string')) throw new Error('batch execution policy has an invalid version, mode, scope, or field value');
  const deterministicTasks = plan.children.filter(task => task.execution?.deterministic === true && task.execution?.executor === 'ExecutionManager');
  const markedValidationTasks = plan.children.filter(task => task.execution?.batch_validation_task === true);
  const expectedValidationIds = markedValidationTasks.map(task => task.id).sort();
  if (canonicalJson([...policy.validation_task_ids].sort()) !== canonicalJson(expectedValidationIds)) throw new Error('batch execution policy validation_task_ids do not match the immutable task contracts');
  for (const taskId of policy.validation_task_ids) {
    const task = plan.children.find(item => item.id === taskId);
    if (!task || task.execution?.deterministic !== true || task.execution?.executor !== 'ExecutionManager' ||
        task.execution?.batch_validation_task !== true || typeof task.execution?.output_artifact_type !== 'string') throw new Error('batch execution policy references a task without an exact deterministic validation contract: ' + taskId);
  }
  const requiresWorkspaceValidation = plan.required_operations?.includes('workspace.write') === true ||
    (Array.isArray(plan.workspace_write_scopes) && plan.workspace_write_scopes.length > 0);
  if (policy.mode === 'required') {
    if (!deterministicTasks.length) throw new Error('required batch execution policy has no deterministic local tasks');
    if (policy.route !== 'batch-required' || policy.grouping !== 'ready-compatible' || policy.evidence !== 'durable-batch-and-execution-ledger' || policy.exemption_reason !== null) throw new Error('required batch execution policy has invalid route, grouping, evidence, or exemption fields');
    if (policy.workspace_fingerprint_required !== (policy.validation_task_ids.length > 0)) throw new Error('workspace fingerprint requirement must match the presence of deterministic validation tasks');
    if (requiresWorkspaceValidation && policy.validation_task_ids.length === 0) throw new Error('code-writing plans require deterministic local validation task contracts');
  } else {
    if (deterministicTasks.length || requiresWorkspaceValidation || policy.validation_task_ids.length || policy.route !== 'not-applicable' ||
        policy.grouping !== 'not-applicable' || policy.evidence !== 'not-applicable' || policy.workspace_fingerprint_required !== false ||
        typeof policy.exemption_reason !== 'string' || !policy.exemption_reason.trim()) throw new Error('batch execution exemption is invalid for a plan with deterministic or workspace-write work');
  }
  return true;
}

export function resolveTaskBatchRoute(plan, taskSpec) {
  const execution = taskSpec?.execution || {};
  if (execution.deterministic !== true || execution.executor !== 'ExecutionManager') return { required: false, route: 'not-applicable', policy_version: plan?.batch_execution_policy?.schema_version ?? null };
  const policy = plan?.batch_execution_policy;
  if (!policy) return { required: true, route: 'batch-required', policy_version: 0, legacy: true };
  if (policy.mode !== 'required' || policy.route !== 'batch-required') throw new Error('deterministic task ' + (taskSpec.id || '(unknown)') + ' conflicts with the immutable batch execution policy');
  return { required: true, route: policy.route, policy_version: policy.schema_version, legacy: false };
}

export function validateExecutionPlan(plan) {
  if (![1, 2].includes(plan?.schema_version ?? 1)) throw new Error('unsupported execution plan schema_version: ' + plan?.schema_version);
  if ((plan.schema_version ?? 1) === 1 && Object.hasOwn(plan, 'batch_execution_policy')) throw new Error('schema version 1 execution plans cannot contain batch_execution_policy');
  if ((plan.schema_version ?? 1) === 1 && Object.hasOwn(plan, 'validation_profile')) throw new Error('schema version 1 execution plans cannot contain validation_profile');
  if ((plan.schema_version ?? 1) === 2 && !Object.hasOwn(plan, 'batch_execution_policy')) throw new Error('schema version 2 execution plans must pin batch_execution_policy');
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
  const scopedWriteTasks = [...plan.children, plan.synthesis].filter(task =>
    Object.hasOwn(task.execution || {}, 'workspace_write_contract') ||
    task.execution?.execution_mode === 'host-conversation-scoped-workspace-write');
  const hasWriteOperations = Object.hasOwn(plan, 'required_operations') || Object.hasOwn(plan, 'workspace_write_scopes') || Object.hasOwn(plan, 'workspace_write_contract_version');
  if (hasWriteOperations || scopedWriteTasks.length) {
    if (plan.custom_workflow || String(plan.workflow_id).toLowerCase() !== 'standard-engineering' || plan.workflow_version < 3) {
      throw new Error('scoped workspace-write operations require a built-in standard-engineering v3+ plan');
    }
    if (canonicalJson(plan.required_operations) !== canonicalJson(['workspace.write']) ||
        plan.workspace_write_contract_version !== 1 || !Array.isArray(plan.workspace_write_scopes) || !plan.workspace_write_scopes.length) {
      throw new Error('workspace-write execution contract requires workspace.write, contract version 1, and role-scoped paths');
    }
    const scopesByRole = new Map();
    for (const scope of plan.workspace_write_scopes) {
      if (!scope || !['engineer', 'writer'].includes(scope.role) || scopesByRole.has(scope.role) ||
          !Array.isArray(scope.paths) || !scope.paths.length || scope.paths.length > 16) {
        throw new Error('workspace-write scope has an invalid or duplicate built-in role');
      }
      const roleContract = getAgentContract(scope.role);
      const expectedCapability = scope.role === 'engineer' ? 'code.modify' : 'documentation.write';
      if (roleContract.capability !== expectedCapability || !roleContract.permissions.includes('workspace.write')) {
        throw new Error(`workspace-write scope role lacks the expected capability/permission: ${scope.role}`);
      }
      const seenPaths = new Set();
      for (const entry of scope.paths) {
        if (!entry || !['file', 'directory'].includes(entry.kind) || typeof entry.path !== 'string' || !entry.path ||
            entry.path.includes('\\') || entry.path.includes('\0') || path.posix.isAbsolute(entry.path) ||
            entry.path.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
            path.posix.normalize(entry.path) !== entry.path || seenPaths.has(`${entry.kind}:${entry.path}`)) {
          throw new Error(`workspace-write scope path is invalid or duplicate for ${scope.role}`);
        }
        seenPaths.add(`${entry.kind}:${entry.path}`);
      }
      scopesByRole.set(scope.role, scope);
    }
    for (let left = 0; left < plan.workspace_write_scopes.length; left++) {
      for (let right = left + 1; right < plan.workspace_write_scopes.length; right++) {
        for (const a of plan.workspace_write_scopes[left].paths) for (const b of plan.workspace_write_scopes[right].paths) {
          const overlap = a.path === b.path || (a.kind === 'directory' && b.path.startsWith(`${a.path}/`)) ||
            (b.kind === 'directory' && a.path.startsWith(`${b.path}/`));
          if (overlap) throw new Error(`workspace-write scopes overlap across roles ${plan.workspace_write_scopes[left].role} and ${plan.workspace_write_scopes[right].role}`);
        }
      }
    }
    for (const task of plan.children) {
      const scope = scopesByRole.get(task.role);
      const contract = task.execution?.workspace_write_contract;
      if (!scope) {
        if (contract || task.execution?.execution_mode === 'host-conversation-scoped-workspace-write') {
          throw new Error(`task has a scoped workspace-write executor without a matching role scope: ${task.id}`);
        }
        continue;
      }
      if (!contract || task.execution?.executor !== 'ChatOnSteroidsHost' || task.execution?.deterministic !== false ||
          task.execution?.execution_mode !== 'host-conversation-scoped-workspace-write' || task.capability !== getAgentContract(task.role).capability ||
          contract.version !== 1 || contract.operation !== 'workspace.write' || contract.mode !== 'scoped-atomic-file-replacement' ||
          contract.role !== task.role || canonicalJson(contract.paths) !== canonicalJson(scope.paths) ||
          contract.max_file_bytes !== 2_000_000 ||
          contract.precondition !== 'sha256 compare-before-write; use ABSENT only for exclusive creation' ||
          contract.recovery !== 'durable per-file receipt; idempotent replay by patch_id and path; report partial writes explicitly') {
        throw new Error(`task workspace-write execution contract does not match its role scope: ${task.id}`);
      }
    }
    for (const [role] of scopesByRole) {
      if (plan.children.filter(task => task.role === role).length !== 1) {
        throw new Error(`workspace-write role scope must map to exactly one planned child task: ${role}`);
      }
    }
    if (scopedWriteTasks.some(task => task === plan.synthesis)) {
      throw new Error('CTO synthesis is never authorized to write workspace files');
    }
  } else if (plan.required_operations != null || plan.workspace_write_scopes != null) {
    throw new Error('workspace-write plan contract fields are incomplete');
  }
  if (plan.success_contract != null) {
    try { validateSuccessContract(plan.success_contract); }
    catch (error) { throw new Error(`execution plan success_contract is invalid: ${error.message}`); }
  }
  if (Object.hasOwn(plan, 'policy_packs') || Object.hasOwn(plan, 'base_success_contract')) {
    if (!Array.isArray(plan.policy_packs) || plan.policy_packs.length === 0 || !plan.base_success_contract) {
      throw new Error('execution plan policy_packs and base_success_contract must both be present for an attached policy set');
    }
    try {
      const recomposed = composePolicySuccessContract(plan.base_success_contract, plan.policy_packs, {
        workflowId: plan.workflow_id,
        children: plan.children
      });
      if (canonicalJson(recomposed.success_contract) !== canonicalJson(plan.success_contract)) {
        throw new Error('merged success contract does not match immutable policy snapshots');
      }
      if (canonicalJson(recomposed.policy_packs) !== canonicalJson(plan.policy_packs)) {
        throw new Error('policy snapshots are not canonical');
      }
      if (canonicalJson(recomposed.base_success_contract) !== canonicalJson(plan.base_success_contract)) {
        throw new Error('base success contract is not canonical');
      }
    } catch (error) {
      throw new Error(`execution plan policy contract is invalid: ${error.message}`);
    }
  }
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
    if (Object.hasOwn(task.execution || {}, 'role_profile_overlay')) {
      if (plan.custom_workflow || !['standard-engineering', 'hybrid-engineering'].includes(plan.workflow_id) || task === plan.synthesis || task.execution?.deterministic) {
        throw new Error(`role profile overlay is not permitted for task ${task.id} in workflow ${plan.workflow_id}`);
      }
      try { validateRoleProfileOverlay(task.role, task.execution.role_profile_overlay); }
      catch (error) { throw new Error(`execution plan role profile overlay is invalid: ${task.id}: ${error.message}`); }
    }
  }
  if ((plan.schema_version ?? 1) === 2) validateBatchExecutionPolicy(plan.batch_execution_policy, plan);
  if (Object.hasOwn(plan, 'validation_profile')) {
    const snapshot = validateValidationProfileSnapshot(plan.validation_profile);
    const engineer = plan.children.find(task => task.role === 'engineer');
    const workspace = engineer?.execution?.cwd;
    if (typeof workspace !== 'string' || !workspace) {
      throw new Error('immutable validation profile plan has no concrete engineer workspace');
    }
    const expectedProfileTasks = materializeValidationProfileTasks(snapshot, workspace);
    const expectedProfileTaskIds = new Set(expectedProfileTasks.map(task => task.id));
    const unboundDeterministicTasks = plan.children.filter(task =>
      task.execution?.deterministic === true && task.execution?.executor === 'ExecutionManager' &&
      !expectedProfileTaskIds.has(task.id));
    if (unboundDeterministicTasks.length) {
      throw new Error('immutable validation profile plan contains deterministic tasks outside the pinned profile: ' + unboundDeterministicTasks.map(task => task.id).join(', '));
    }
    const actualProfileTasks = plan.children.filter(task => task.execution?.validation_profile_id != null);
    if (canonicalJson(actualProfileTasks) !== canonicalJson(expectedProfileTasks)) {
      throw new Error('immutable validation profile task membership or exact command contract differs from the pinned profile snapshot');
    }
    if (!plan.required_operations?.includes('workspace.write') ||
        plan.workflow_id !== 'standard-engineering' || plan.workflow_version < 3) {
      throw new Error('validation profiles require standard-engineering v3+ with explicit workspace.write');
    }
  } else if (plan.children.some(task => task.execution?.validation_profile_id != null)) {
    throw new Error('plan validation profile tasks are present without a pinned validation_profile snapshot');
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
  if (!plan.custom_workflow && (plan.workflow_id === 'standard-engineering' || plan.workflow_id === 'hybrid-engineering' ||
      (plan.workflow_id === 'engineering' && plan.workflow_version >= 2))) {
    for (const task of [...plan.children, plan.synthesis]) {
      // Hybrid deterministic tasks expose their typed output via the immutable
      // execution contract, not a built-in specialist role contract.
      if (task.execution?.deterministic === true) continue;
      const contract = getAgentContract(task.role);
      const ancestors = new Set();
      const collectAncestors = dependencyId => {
        if (ancestors.has(dependencyId)) return;
        ancestors.add(dependencyId);
        for (const ancestor of tasksById.get(dependencyId).dependencies) collectAncestors(ancestor);
      };
      for (const dependency of task.dependencies) collectAncestors(dependency);
      const availableInputs = new Set([...ancestors].flatMap(ancestorId => {
        const ancestor = tasksById.get(ancestorId);
        if (ancestor.execution?.output_artifact_type) return [ancestor.execution.output_artifact_type];
        return getAgentContract(ancestor.role).outputs;
      }));
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
