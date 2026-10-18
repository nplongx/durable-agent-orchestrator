import crypto from 'node:crypto';
import { canonicalJson } from './plan.js';
import { parseReviewerArtifact } from './artifact-normalizer.js';
import { parseStrictJson } from '../strict-json.js';
import { validateEvidenceContract } from './evidence.js';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function verifyWorkflowCompletion({ plan, tasks = [], results = [], reports = [], projection = null } = {}) {
  const errors = [];
  if (!Array.isArray(tasks)) errors.push('tasks must be a durable row array');
  if (!Array.isArray(results)) errors.push('results must be a durable row array');
  if (!Array.isArray(reports)) errors.push('reports must be a durable row array');
  tasks = Array.isArray(tasks) ? tasks : [];
  results = Array.isArray(results) ? results : [];
  reports = Array.isArray(reports) ? reports : [];
  if (!plan?.plan_hash) errors.push('plan_hash is required');
  else {
    const withoutHash = Object.fromEntries(Object.entries(plan).filter(([key]) => !['plan_hash', 'compiled_at', 'approved_at'].includes(key)));
    if (hash(canonicalJson(withoutHash)) !== plan.plan_hash) errors.push('plan_hash mismatch');
  }
  if (!Array.isArray(plan?.children)) errors.push('immutable plan children must be an array');

  if (!Array.isArray(reports) || !reports.some(report => String(report?.kind || '').toLowerCase() === 'executive_summary' && String(report?.content || '').trim())) {
    errors.push('durable executive report missing');
  }

  const taskIdCounts = new Map();
  for (const task of tasks) {
    const taskId = task?.task_id || task?.id;
    if (typeof taskId !== 'string' || !taskId) {
      errors.push('durable task row has no exact task identity');
      continue;
    }
    taskIdCounts.set(taskId, (taskIdCounts.get(taskId) || 0) + 1);
  }
  const byId = new Map();
  const ambiguousTaskIds = new Set();
  for (const task of tasks) {
    const taskId = task?.task_id || task?.id;
    if (!taskId) continue;
    if (taskIdCounts.get(taskId) !== 1) ambiguousTaskIds.add(taskId);
    else byId.set(taskId, task);
  }
  if (ambiguousTaskIds.size) errors.push('durable task identity is duplicated: ' + [...ambiguousTaskIds].join(','));
  const resultRowids = results.filter(result => Number.isSafeInteger(result?.durable_rowid) && result.durable_rowid > 0)
    .map(result => result.durable_rowid);
  if (new Set(resultRowids).size !== resultRowids.length) errors.push('durable result row identity is duplicated');
  const resultByTask = new Map();
  const ambiguousResultTasks = new Set();
  const resultsByTask = new Map();
  for (const result of results) {
    if (!result || typeof result.task_id !== 'string' || !result.task_id) {
      errors.push('durable result row has no exact task identity');
      continue;
    }
    if (!resultsByTask.has(result.task_id)) resultsByTask.set(result.task_id, []);
    resultsByTask.get(result.task_id).push(result);
  }
  for (const [taskId, taskResults] of resultsByTask) {
    if (taskResults.length === 1) {
      resultByTask.set(taskId, taskResults[0]);
      continue;
    }
    // The store exposes SQLite rowid as durable_rowid because created_at has
    // millisecond precision and multiple result writes can share a timestamp.
    // Never let caller array ordering choose which durable result is trusted.
    const rowids = taskResults.map(result => result.durable_rowid);
    const hasStableRowOrder = rowids.every(value => Number.isSafeInteger(value) && value > 0) &&
      new Set(rowids).size === rowids.length;
    if (!hasStableRowOrder) {
      const timestamps = taskResults.map(result => result.created_at);
      const allTimestamped = timestamps.every(value => typeof value === 'string' && value.length > 0);
      const distinctTimestamps = new Set(timestamps).size === timestamps.length;
      if (!allTimestamped || !distinctTimestamps) {
        ambiguousResultTasks.add(taskId);
        continue;
      }
    }
    taskResults.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '') ) ||
      (Number.isSafeInteger(a.durable_rowid) && Number.isSafeInteger(b.durable_rowid)
        ? a.durable_rowid - b.durable_rowid : 0));
    resultByTask.set(taskId, taskResults[taskResults.length - 1]);
  }
  const resolvePlanTask = spec => {
    const direct = ambiguousTaskIds.has(spec.id) ? null : byId.get(spec.id);
    if (direct) return direct;
    const idMatches = tasks.map((task, index) => ({ task, index })).filter(({ task }) => {
      let metadata = {};
      try { metadata = parseStrictJson(task.metadata_json || '{}'); } catch (_) {}
      return (metadata.workflow_plan_task_id || metadata.workflowPlanTaskId) === spec.id;
    });
    if (idMatches.length) {
      if (idMatches.some(({ task }) => ambiguousTaskIds.has(task.task_id || task.id))) return null;
      // Rework legitimately creates multiple historical tasks for one plan
      // slot. Select the latest task only when every task carrying this plan ID
      // has the expected role; a wrong-role collision is an identity conflict,
      // not an invitation to fall back to whichever task happens to be latest.
      if (idMatches.some(({ task }) => String(task?.role || '').toLowerCase() !== String(spec.role || '').toLowerCase())) return null;
      const sameTimestamp = idMatches.some((entry, index) => idMatches.some((other, otherIndex) =>
        index !== otherIndex && entry.task.created_at === other.task.created_at));
      const taskRowids = idMatches.map(({ task }) => task.durable_rowid);
      if (sameTimestamp && (!taskRowids.every(value => Number.isSafeInteger(value) && value > 0) ||
          new Set(taskRowids).size !== taskRowids.length)) return null;
      idMatches.sort((a, b) => String(a.task.created_at || '').localeCompare(String(b.task.created_at || '')) ||
        (Number.isSafeInteger(a.task.durable_rowid) && Number.isSafeInteger(b.task.durable_rowid)
          ? a.task.durable_rowid - b.task.durable_rowid : a.index - b.index));
      return idMatches[idMatches.length - 1].task;
    }
    const roleMatches = tasks.filter(candidate => String(candidate?.role || '').toLowerCase() === String(spec.role || '').toLowerCase());
    if (roleMatches.length === 1) return roleMatches[0];
    return null;
  };
  for (const spec of (Array.isArray(plan?.children) ? plan.children : [])) {
    // The mutable task metadata is evidence to validate, not sufficient
    // authority to satisfy an immutable plan entry. Use a unique plan-id match
    // where repeated roles make role-only matching ambiguous, then independently
    // verify the task role, exact plan id, executor policy, and command bytes.
    // A forged plan-id/metadata rewrite therefore cannot bypass the later checks.
    const task = resolvePlanTask(spec);
    if (!task) {
      errors.push(`required task missing or ambiguously bound: ${spec.role} (plan task ${spec.id})`);
      continue;
    }
    if (String(task.role || '').toLowerCase() !== String(spec.role || '').toLowerCase()) {
      errors.push(`required task role does not match immutable plan entry: ${spec.role} (plan task ${spec.id})`);
    }
    if (String(task.status).toLowerCase() !== 'completed') errors.push(`required task not completed: ${spec.role}`);
    const result = resultByTask.get(task.task_id);
    if (ambiguousResultTasks.has(task.task_id)) errors.push(`durable result ordering is ambiguous: ${spec.role}`);
    const taskResults = resultsByTask.get(task.task_id) || [];
    if (taskResults.filter(item => item?.outcome === 'success').length > 1) {
      errors.push(`multiple successful durable results: ${spec.role}`);
    }
    if (!result || String(result.outcome).toLowerCase() !== 'success') errors.push(`successful result missing: ${spec.role}`);
    const metadata = (() => {
      try { return parseStrictJson(task.metadata_json || '{}'); } catch (_) { return {}; }
    })();
    if ((metadata.workflow_plan_task_id ?? metadata.workflowPlanTaskId ?? null) !== spec.id) {
      errors.push(`required task plan identity does not match immutable entry: ${spec.role} (plan task ${spec.id})`);
    }
    const plannedDeterministic = spec.execution?.executor === 'ExecutionManager' || spec.execution?.deterministic === true;
    const metadataDeterministic = metadata.executor === 'ExecutionManager' || metadata.deterministic === true;
    const deterministic = plannedDeterministic || metadataDeterministic;
    if (deterministic) {
      if (plannedDeterministic && metadata.workflow_plan_task_id !== spec.id) {
        errors.push(`ExecutionManager evidence invalid: ${spec.role}: task does not retain its immutable plan-task identity`);
      }
      for (const key of ['executor', 'deterministic', 'command', 'executable', 'args', 'cwd', 'timeout_ms']) {
        if (Object.hasOwn(spec.execution || {}, key) &&
            JSON.stringify(metadata[key] ?? null) !== JSON.stringify(spec.execution[key] ?? null)) {
          errors.push(`ExecutionManager evidence invalid: ${spec.role}: task metadata ${key} differs from immutable execution plan`);
        }
      }
      const executionEvidence = validateEvidenceContract(task, result, spec.execution || null);
      for (const error of executionEvidence.errors) {
        errors.push(`ExecutionManager evidence invalid: ${spec.role}: ${error}`);
      }
    } else if (!String(result?.content || '').trim()) {
      errors.push(`native artifact missing: ${spec.role}`);
    }
    if (String(spec.role).toLowerCase() === 'reviewer' && result) {
      // The result selected above is the latest durable result for this task
      // (getJobTrace returns results in created_at/rowid order). Never rescue a
      // malformed current reviewer result by scanning an older successful
      // artifact: that would let stale approval survive a later wrapper,
      // rejection, or tampered result row.
      const parsedReview = parseReviewerArtifact(result.content);
      try {
        if (!parsedReview) throw new Error('review artifact is not valid JSON');
        const review = parsedReview;
        if (!review?.review || typeof review.review !== 'object') errors.push('review artifact missing');
        if (review.review.requirementsSatisfied !== true) errors.push('review requirementsSatisfied is not true');
        if (review.review.architectureConformant !== true) errors.push('review architectureConformant is not true');
        if (!Array.isArray(review.review.implementationIssues) || !review.review.implementationIssues.every(item => typeof item === 'string')) errors.push('review implementationIssues must be an array of strings');
        if (!Array.isArray(review.review.evidenceIssues) || !review.review.evidenceIssues.every(item => typeof item === 'string')) errors.push('review evidenceIssues must be an array of strings');
        if (!Array.isArray(review.review.blockingIssues) || review.review.blockingIssues.length) errors.push('review contains blocking issues');
        if (!Array.isArray(review.review.blockingIssues) || !review.review.blockingIssues.every(item => typeof item === 'string')) errors.push('review blockingIssues must be an array of strings');
      } catch (_) {
        errors.push('review artifact is not valid JSON');
      }
    }
    for (const dependency of spec.dependencies || []) {
      const dependencySpec = [...(plan.children || []), plan.synthesis].find(item => item.id === dependency);
      const dependencyTask = dependencySpec ? resolvePlanTask(dependencySpec) : null;
      if (!dependencyTask || String(dependencyTask.status).toLowerCase() !== 'completed') errors.push(`dependency incomplete: ${spec.role} <- ${dependency}`);
    }
  }

  const synthesis = plan?.synthesis;
  if (!synthesis) errors.push('synthesis plan entry missing');
  else {
    const synthesisTask = resolvePlanTask(synthesis);
    if (!synthesisTask || String(synthesisTask.status).toLowerCase() !== 'completed') errors.push('synthesis not completed');
    else {
      let synthesisMetadata = {};
      try { synthesisMetadata = parseStrictJson(synthesisTask.metadata_json || '{}'); } catch (_) {}
      if ((synthesisMetadata.workflow_plan_task_id ?? synthesisMetadata.workflowPlanTaskId ?? null) !== synthesis.id) {
        errors.push('synthesis task plan identity does not match immutable synthesis entry');
      }
      if (ambiguousResultTasks.has(synthesisTask.task_id)) errors.push('synthesis durable result ordering is ambiguous');
      if ((resultsByTask.get(synthesisTask.task_id) || []).filter(item => item?.outcome === 'success').length > 1) {
        errors.push('multiple successful durable results: synthesis');
      }
      if (!resultByTask.get(synthesisTask.task_id) || String(resultByTask.get(synthesisTask.task_id).outcome).toLowerCase() !== 'success') errors.push('synthesis result missing');
    }
  }

  if (projection && projection.pendingEvents !== 0) errors.push(`UNPROJECTED=${projection.pendingEvents}`);
  return Object.freeze({ valid: errors.length === 0, errors });
}

export function assertWorkflowCompletion(input) {
  const result = verifyWorkflowCompletion(input);
  if (!result.valid) throw new Error(`workflow verification failed: ${result.errors.join('; ')}`);
  return result;
}
