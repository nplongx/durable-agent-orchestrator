import crypto from 'node:crypto';
import { canonicalJson } from './plan.js';
import { parseReviewerArtifact } from './artifact-normalizer.js';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function verifyWorkflowCompletion({ plan, tasks = [], results = [], reports = [], projection = null } = {}) {
  const errors = [];
  if (!plan?.plan_hash) errors.push('plan_hash is required');
  else {
    const withoutHash = Object.fromEntries(Object.entries(plan).filter(([key]) => !['plan_hash', 'compiled_at', 'approved_at'].includes(key)));
    if (hash(canonicalJson(withoutHash)) !== plan.plan_hash) errors.push('plan_hash mismatch');
  }

  if (!Array.isArray(reports) || !reports.some(report => String(report?.kind || '').toLowerCase() === 'executive_summary' && String(report?.content || '').trim())) {
    errors.push('durable executive report missing');
  }

  const byId = new Map(tasks.map(task => [task.task_id || task.id, task]));
  const byPlanId = new Map();
  for (const task of tasks) {
    let metadata = {};
    try { metadata = JSON.parse(task.metadata_json || '{}'); } catch (_) {}
    const planTaskId = metadata.workflow_plan_task_id || metadata.workflowPlanTaskId;
    if (planTaskId) byPlanId.set(planTaskId, task);
  }
  const resultByTask = new Map(results.map(result => [result.task_id, result]));
  for (const spec of plan?.children || []) {
    const task = byId.get(spec.id) || byPlanId.get(spec.id);
    if (!task) {
      errors.push(`required task missing: ${spec.role} (plan task ${spec.id})`);
      continue;
    }
    if (String(task.status).toLowerCase() !== 'completed') errors.push(`required task not completed: ${spec.role}`);
    const result = resultByTask.get(task.task_id);
    if (!result || String(result.outcome).toLowerCase() !== 'success') errors.push(`successful result missing: ${spec.role}`);
    const metadata = (() => {
      try { return JSON.parse(task.metadata_json || '{}'); } catch (_) { return {}; }
    })();
    const deterministic = metadata.executor === 'ExecutionManager' || metadata.deterministic === true;
    if (deterministic) {
      if (!task.execution_session_id || task.execution_status !== 'completed' || Number(task.execution_exit_code) !== 0) {
        errors.push(`ExecutionManager evidence invalid: ${spec.role}`);
      }
      if (!/\[ACTUAL (?:TOOL RESULT|EXECUTION BATCH|EXECUTION) EVIDENCE\]/i.test(String(result?.content || ''))) {
        errors.push(`ExecutionManager evidence missing: ${spec.role}`);
      }
    } else if (!String(result?.content || '').trim()) {
      errors.push(`native artifact missing: ${spec.role}`);
    }
    if (String(spec.role).toLowerCase() === 'reviewer' && result) {
      const reviewerResults = results.filter(item => item.task_id === task.task_id).reverse();
      let parsedReview = null;
      for (const candidate of reviewerResults) {
        parsedReview = parseReviewerArtifact(candidate.content);
        if (parsedReview) break;
      }
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
      const dependencyTask = byId.get(dependency) || byPlanId.get(dependency);
      if (!dependencyTask || String(dependencyTask.status).toLowerCase() !== 'completed') errors.push(`dependency incomplete: ${spec.role} <- ${dependency}`);
    }
  }

  const synthesis = plan?.synthesis;
  if (!synthesis) errors.push('synthesis plan entry missing');
  else {
    const synthesisTask = byId.get(synthesis.id) || byPlanId.get(synthesis.id);
    if (!synthesisTask || String(synthesisTask.status).toLowerCase() !== 'completed') errors.push('synthesis not completed');
    else if (!resultByTask.get(synthesisTask.task_id) || String(resultByTask.get(synthesisTask.task_id).outcome).toLowerCase() !== 'success') errors.push('synthesis result missing');
  }

  if (projection && Number(projection.pendingEvents) !== 0) errors.push(`UNPROJECTED=${projection.pendingEvents}`);
  return Object.freeze({ valid: errors.length === 0, errors });
}

export function assertWorkflowCompletion(input) {
  const result = verifyWorkflowCompletion(input);
  if (!result.valid) throw new Error(`workflow verification failed: ${result.errors.join('; ')}`);
  return result;
}
