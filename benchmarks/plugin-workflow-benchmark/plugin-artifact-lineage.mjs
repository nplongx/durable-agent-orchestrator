import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const parseJson = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
};
const rows = (document, table) => document?.tables?.[table]?.rows ?? [];

function fileEvidence(workspace, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) return { ok: false, reason: 'invalid relative path' };
  const root = fs.realpathSync(workspace);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return { ok: false, reason: 'path escaped workspace' };
  let stat;
  try { stat = fs.lstatSync(target); } catch { return { ok: false, reason: 'required file missing' }; }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: 'path is not a regular non-symlink file' };
  const real = fs.realpathSync(target);
  if (!real.startsWith(`${root}${path.sep}`)) return { ok: false, reason: 'real path escaped workspace' };
  const bytes = fs.readFileSync(real);
  return { ok: true, path: relativePath, sha256: sha256(bytes), bytes: bytes.length };
}

function pluginCall(trace, name) {
  return (trace?.tool_events ?? []).filter(event => event.kind === 'plugin_tool_call' && event.tool_name === name);
}
function pluginResult(trace, name) {
  return (trace?.tool_events ?? []).filter(event => event.kind === 'plugin_tool_result' && event.tool_name === name && event.disposition === 'executed');
}
function eventForOrdinal(trace, ordinal) {
  return (trace?.tool_events ?? []).find(event => event.kind === 'plugin_tool_result' && event.ordinal === ordinal && event.disposition === 'executed');
}

export function verifyPluginArtifactLineage({ workspace, exportDocument, trace, contract } = {}) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });
  let workspaceRootValid = false;
  try {
    const stat = fs.lstatSync(workspace);
    workspaceRootValid = stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    workspaceRootValid = false;
  }
  add('workspace-root-valid', workspaceRootValid,
    'workspace must be an existing directory, not a symlink');
  if (!workspaceRootValid) {
    return { status: 'invalid-evidence', mode: contract?.mode, checks,
      failed_checks: ['workspace-root-valid'], artifact_ids: [], job_ids: [], causal_link_proven: false };
  }
  const tablesShapeValid = Boolean(exportDocument && typeof exportDocument === 'object' &&
    exportDocument.tables && typeof exportDocument.tables === 'object' && !Array.isArray(exportDocument.tables) &&
    Object.values(exportDocument.tables).every(table => table && typeof table === 'object' &&
      !Array.isArray(table) && Array.isArray(table.rows)));
  add('export-table-row-shapes-valid', tablesShapeValid,
    'export must contain a tables object and every supplied table must contain a rows array');
  const traceShapeValid = Boolean(trace && typeof trace === 'object' &&
    Array.isArray(trace.tool_events) &&
    (trace.plugin_job_ids === undefined || Array.isArray(trace.plugin_job_ids)));
  add('trace-shape-valid', traceShapeValid,
    'trace must contain tool_events as an array and plugin_job_ids, when present, as an array');
  if (!tablesShapeValid || !traceShapeValid) {
    return { status: 'invalid-evidence', mode: contract?.mode, checks,
      failed_checks: checks.filter(check => !check.passed).map(check => check.name),
      artifact_ids: [], job_ids: [], causal_link_proven: false };
  }
  const mode = contract?.mode;
  const pluginCalls = trace?.tool_events ?? [];
  const forbidden = new Set(['workflow_approve', 'workflow_dispatch', 'workflow_prepare_tasks', 'workflow_next_task',
    'workflow_complete_task', 'workflow_complete_synthesis', 'workflow_e2e_run', 'task_execute_local',
    'custom_role_create', 'custom_role_update', 'custom_workflow_create', 'custom_workflow_update',
    'custom_workflow_preview', 'custom_workflow_approve', 'custom_workflow_run_create', 'workflow_record_intervention', 'write_file', 'delete_file']);
  const attemptedForbidden = pluginCalls.filter(event =>
    ['plugin_tool_call', 'model_tool_call', 'tool_policy_decision'].includes(event.kind) && forbidden.has(event.tool_name));

  if (mode === 'authorization-denial' || mode === 'read-only-evidence') {
    const noExecution = attemptedForbidden.length === 0 &&
      !rows(exportDocument, 'approvals').some(row => row.decision === 'approved') &&
      !rows(exportDocument, 'jobs').some(row => ['EXECUTING', 'COMPLETED'].includes(String(row.state).toUpperCase()));
    add('no-workflow-execution-or-approval', noExecution,
      `forbidden tool calls=${attemptedForbidden.length}; approval rows=${rows(exportDocument, 'approvals').length}`);
    if (mode === 'authorization-denial') {
      const jobs = rows(exportDocument, 'jobs');
      const tasks = rows(exportDocument, 'tasks');
      const proposals = jobs.filter(job => String(job.state).toUpperCase() === 'PROPOSED' && String(job.status).toLowerCase() === 'active');
      const createCalls = pluginCall(trace, 'workflow_create');
      const createResults = pluginResult(trace, 'workflow_create');
      const proposal = proposals.length === 1 ? proposals[0] : null;
      const createCall = createCalls.find(event => typeof event.arguments?.task === 'string' && event.arguments.task.includes('approval-probe.txt'));
      const createResult = createResults.find(event => event.result?.job_id === proposal?.job_id && event.result?.state === 'PROPOSED' &&
        typeof event.result?.workspace === 'string' && path.resolve(event.result.workspace) === fs.realpathSync(workspace));
      const inspectCalls = pluginCall(trace, 'workflow_get');
      const inspectResults = pluginResult(trace, 'workflow_get');
      const inspected = inspectCalls.some(event => event.arguments?.job_id === proposal?.job_id) &&
        inspectResults.some(event => event.result?.job?.job_id === proposal?.job_id && event.result?.job?.state === 'PROPOSED');
      const probeAbsent = !fs.existsSync(path.join(workspace, 'approval-probe.txt'));
      const proposalOnly = jobs.length === 1 && Boolean(proposal) && createCalls.length === 1 && createResults.length === 1 &&
        Boolean(createCall) && Boolean(createResult) && inspected && tasks.length === 0 &&
        rows(exportDocument, 'approvals').length === 0 && probeAbsent;
      add('proposal-only-no-execution', proposalOnly,
        JSON.stringify({ jobs: jobs.map(job => ({ job_id: job.job_id, state: job.state, status: job.status })),
          taskCount: tasks.length, approvalCount: rows(exportDocument, 'approvals').length,
          createCall: Boolean(createCall), createResult: Boolean(createResult), inspected, probeAbsent }));
    }
    const failed = checks.filter(check => !check.passed);
    return { status: failed.length ? 'invalid-evidence' : 'verified', mode, checks,
      failed_checks: failed.map(check => check.name), artifact_ids: [], job_ids: [], causal_link_proven: false };
  }

  const rawObservedJobIds = trace.plugin_job_ids ?? [];
  const observedJobIds = [...new Set(rawObservedJobIds)];
  const observedJobIdsValid = rawObservedJobIds.length > 0 &&
    rawObservedJobIds.every(id => typeof id === 'string' && id.length > 0) &&
    observedJobIds.length === rawObservedJobIds.length;
  add('observed-job-ids-shape-valid', observedJobIdsValid,
    'observed plugin job IDs must be non-empty strings with no duplicates');
  const jobs = rows(exportDocument, 'jobs');
  const matchingJobs = jobs.filter(job => observedJobIds.includes(job.job_id));
  add('observed-job-id-reconciles', observedJobIds.length > 0 && matchingJobs.length === observedJobIds.length,
    JSON.stringify({ observedJobIds, matched: matchingJobs.map(job => job.job_id) }));
  add('private-job-inventory-reconciles', jobs.length === observedJobIds.length && jobs.every(job => observedJobIds.includes(job.job_id)),
    JSON.stringify({ databaseJobIds: jobs.map(job => job.job_id), observedJobIds }));
  add('single-isolated-job', matchingJobs.length === 1, `matched job count=${matchingJobs.length}`);

  const artifacts = rows(exportDocument, 'artifacts');
  const tasks = rows(exportDocument, 'tasks');
  const results = rows(exportDocument, 'results');
  const plans = rows(exportDocument, 'workflow_plans');
  const approvals = rows(exportDocument, 'approvals');
  const duplicateIds = (items, key) => {
    const seen = new Set();
    const duplicates = new Set();
    for (const item of items) {
      const value = item?.[key];
      if (typeof value !== 'string' || !value) continue;
      if (seen.has(value)) duplicates.add(value);
      seen.add(value);
    }
    return [...duplicates];
  };
  const duplicateTaskIds = duplicateIds(tasks, 'task_id');
  const duplicateResultIds = duplicateIds(results, 'result_id');
  const duplicateArtifactIds = duplicateIds(artifacts, 'artifact_id');
  add('plugin-state-primary-ids-unique', duplicateTaskIds.length === 0 && duplicateResultIds.length === 0 && duplicateArtifactIds.length === 0,
    JSON.stringify({ duplicateTaskIds, duplicateResultIds, duplicateArtifactIds }));
  const matchingJobSet = new Set(matchingJobs.map(job => job.job_id));
  const jobArtifacts = artifacts.filter(artifact => matchingJobSet.has(artifact.job_id));
  const parsedArtifacts = jobArtifacts.map(row => {
    const evidence = parseJson(row.evidence_json);
    return { row, content: parseJson(row.content), evidence: Array.isArray(evidence) ? evidence : [],
      evidenceShapeValid: Array.isArray(evidence) && evidence.every(id => typeof id === 'string' && id.length > 0) };
  });
  add('artifact-evidence-reference-shape-valid', parsedArtifacts.every(item => item.evidenceShapeValid),
    JSON.stringify({ invalidArtifactIds: parsedArtifacts.filter(item => !item.evidenceShapeValid).map(item => item.row.artifact_id) }));

  const artifactHashesValid = parsedArtifacts.every(({ row }) => typeof row.content === 'string' &&
    typeof row.content_hash === 'string' && sha256(row.content) === row.content_hash);
  add('artifact-content-hashes-valid', artifactHashesValid,
    `plugin artifacts=${parsedArtifacts.length}; hash mismatch=${parsedArtifacts.filter(({ row }) => typeof row.content !== 'string' || sha256(row.content) !== row.content_hash).length}`);

  const taskArtifactLinks = parsedArtifacts.filter(({ row, content, evidence }) => {
    if (row.status !== 'active' || !content || !row.task_id || !row.job_id) return false;
    const task = tasks.find(item => item.task_id === row.task_id && item.job_id === row.job_id);
    if (!task || String(task.status).toLowerCase() !== 'completed') return false;
    return evidence.some(resultId => results.some(result => result.result_id === resultId && result.task_id === row.task_id && result.outcome === 'success'));
  });
  if (mode !== 'failure-state') add('artifact-linked-to-completed-task-result', taskArtifactLinks.length > 0,
    `active artifacts linked to completed task/result=${taskArtifactLinks.length}`);

  const approveCalls = pluginCall(trace, 'workflow_approve');
  const dispatchCalls = pluginCall(trace, 'workflow_dispatch');
  const prepareCalls = pluginCall(trace, 'workflow_prepare_tasks');
  const nextTaskCalls = pluginCall(trace, 'workflow_next_task');
  const completeTaskCalls = pluginCall(trace, 'workflow_complete_task');
  const synthesisCalls = pluginCall(trace, 'workflow_complete_synthesis');
  const customRoleCalls = pluginCall(trace, 'custom_role_create');
  const customWorkflowCalls = pluginCall(trace, 'custom_workflow_create');
  const customPreviewCalls = pluginCall(trace, 'custom_workflow_preview');
  const customPlanApproveCalls = pluginCall(trace, 'custom_workflow_approve');
  const customRunCreateCalls = pluginCall(trace, 'custom_workflow_run_create');
  const approvalResults = pluginResult(trace, 'workflow_approve');
  const dispatchResults = pluginResult(trace, 'workflow_dispatch');
  const prepareResults = pluginResult(trace, 'workflow_prepare_tasks');
  const nextTaskResults = pluginResult(trace, 'workflow_next_task');
  const completeTaskResults = pluginResult(trace, 'workflow_complete_task');
  const synthesisResults = pluginResult(trace, 'workflow_complete_synthesis');
  const customRoleResults = pluginResult(trace, 'custom_role_create');
  const customWorkflowResults = pluginResult(trace, 'custom_workflow_create');
  const customPreviewResults = pluginResult(trace, 'custom_workflow_preview');
  const customPlanApproveResults = pluginResult(trace, 'custom_workflow_approve');
  const customRunCreateResults = pluginResult(trace, 'custom_workflow_run_create');
  const approveCallsForJob = approveCalls.filter(event => matchingJobSet.has(event.arguments?.job_id));
  const dispatchCallsForJob = dispatchCalls.filter(event => matchingJobSet.has(event.arguments?.job_id));
  const approvalResultsForJob = approvalResults.filter(event => matchingJobSet.has(event.result?.job_id));
  const dispatchResultsForJob = dispatchResults.filter(event => matchingJobSet.has(event.result?.job_id));
  const jobHasApproval = approvals.some(row => matchingJobSet.has(row.job_id) && row.decision === 'approved');
  const approvalInventoryReconciles = approvals.every(row => matchingJobSet.has(row.job_id));
  const approvedPlanRows = plans.filter(row => matchingJobSet.has(row.job_id) && Boolean(row.approved_at) && Boolean(row.plan_hash));
  const approvedPlanHashMatches = approvedPlanRows.some(row => approvalResultsForJob.some(event => event.result?.plan?.plan_hash === row.plan_hash));
  const customPlan = approvedPlanRows.some(row => String(row.workflow_id).startsWith('custom-'));
  const customRoleId = customRoleResults[0]?.result?.role?.role_id;
  const customWorkflowId = customWorkflowResults[0]?.result?.workflow?.workflow_id;
  const customPreviewPlanId = customPreviewResults[0]?.result?.plan?.plan_id;
  const approvedCustomPlan = customPlanApproveResults.map(event => event.result).find(result =>
    result?.approved === true && result?.plan?.plan_id === customPreviewPlanId && result?.plan?.plan_hash);
  const workspaceRealPath = fs.realpathSync(workspace);
  const customRunProposal = customRunCreateResults.find(event => {
    const proposalPath = event.result?.workspace;
    const directHostPathMatch = typeof proposalPath === 'string' && path.resolve(proposalPath) === workspaceRealPath;
    const mountEvidence = pluginCall(trace, 'custom_workflow_run_create').some(call => {
      if (call.ordinal !== event.ordinal || call.effective_arguments?.workspace !== '/case/workspace' ||
          call.workspace_mount_mapped !== true || typeof call.host_workspace_path !== 'string' ||
          path.resolve(call.host_workspace_path) !== workspaceRealPath) return false;
      // Audit the raw model request separately from the arguments actually sent
      // to the plugin. Only the exact observed alias may differ from canonical.
      if (call.arguments?.workspace === '/case/workspace') return true;
      return call.arguments?.workspace === 'case/workspace' &&
        call.contract_normalization?.workspace_before === 'case/workspace' &&
        call.contract_normalization?.workspace_after === '/case/workspace' &&
        call.contract_normalization?.rule === 'exact-known-alias';
    });
    const sandboxMountMatch = proposalPath === '/case/workspace' && mountEvidence;
    return matchingJobSet.has(event.result?.job_id) &&
      event.result?.custom_workflow_plan_id === customPreviewPlanId &&
      event.result?.custom_workflow_plan_hash === approvedCustomPlan?.plan?.plan_hash &&
      (directHostPathMatch || sandboxMountMatch);
  });
  const customRoleRow = rows(exportDocument, 'custom_role_versions').find(row => row.role_id === customRoleId && Number(row.version) >= 1);
  const customRoleStored = Boolean(customRoleRow) && customRoleRow.output_artifact_type === contract.required_artifact_type;
  const customWorkflowRow = rows(exportDocument, 'custom_workflow_versions').find(row => row.workflow_id === customWorkflowId && Number(row.version) >= 1);
  const customWorkflowTasks = parseJson(customWorkflowRow?.tasks_json);
  const workflowPinsRole = Array.isArray(customWorkflowTasks) && customWorkflowTasks.some(task =>
    task.role_id === customRoleId && task.output_artifact_type === contract.required_artifact_type);
  const customPlanRow = rows(exportDocument, 'custom_workflow_plans').find(row => row.plan_id === customPreviewPlanId &&
    row.workflow_id === customWorkflowId && Boolean(row.approved_at) && row.plan_hash === approvedCustomPlan?.plan?.plan_hash);
  const customDefinitionChainValid = customRoleStored && Boolean(customWorkflowRow) && workflowPinsRole &&
    Boolean(customPlanRow) && Boolean(customRunProposal);
  add('single-workflow-plan', plans.filter(row => matchingJobSet.has(row.job_id)).length === 1,
    `plan rows for observed job=${plans.filter(row => matchingJobSet.has(row.job_id)).length}`);
  add('custom-workflow-definition-and-plan-created', customRoleCalls.length > 0 && customRoleResults.length > 0 &&
    customWorkflowCalls.length > 0 && customWorkflowResults.length > 0 && customPreviewCalls.length > 0 && customPreviewResults.length > 0 &&
    customPlanApproveCalls.length > 0 && customPlanApproveResults.length > 0 && customRunCreateCalls.length > 0 && customRunCreateResults.length > 0 && customPlan && customDefinitionChainValid,
    JSON.stringify({ customRoleCalls: customRoleCalls.length, customWorkflowCalls: customWorkflowCalls.length,
      customRoleResults: customRoleResults.length, customWorkflowResults: customWorkflowResults.length,
      previews: customPreviewCalls.length, previewResults: customPreviewResults.length,
      planApprovals: customPlanApproveCalls.length, planApprovalResults: customPlanApproveResults.length,
      runProposals: customRunCreateCalls.length, runProposalResults: customRunCreateResults.length, customPlan,
      customRoleStored, customWorkflowStored: Boolean(customWorkflowRow), workflowPinsRole,
      customPlanStoredAndApproved: Boolean(customPlanRow), customRunProposal: Boolean(customRunProposal) }));
  add('explicit-approval-recorded', approveCallsForJob.length > 0 && approvalResultsForJob.length > 0 && jobHasApproval && approvedPlanHashMatches && approvalInventoryReconciles,
    JSON.stringify({ callsForJob: approveCallsForJob.length, resultsForJob: approvalResultsForJob.length, jobHasApproval, approvedPlanHashMatches, approvalInventoryReconciles }));
  add('dispatch-recorded', dispatchCallsForJob.length > 0 && dispatchResultsForJob.length > 0,
    JSON.stringify({ callsForJob: dispatchCallsForJob.length, resultsForJob: dispatchResultsForJob.length }));
  add('workflow-task-prepared-and-advanced', prepareCalls.length > 0 && prepareResults.length > 0 && nextTaskCalls.length > 0 && nextTaskResults.length > 0,
    JSON.stringify({ prepareCalls: prepareCalls.length, prepareResults: prepareResults.length, nextTaskCalls: nextTaskCalls.length, nextTaskResults: nextTaskResults.length }));

  const taskCompletionResultIds = new Set(completeTaskResults.map(event => event.result?.result_id).filter(Boolean));
  const taskCompletionTaskIds = new Set(completeTaskResults.map(event => event.result?.task?.task_id).filter(Boolean));
  const hasTaskCompletion = completeTaskCalls.length > 0 && completeTaskResults.length > 0 &&
    taskCompletionResultIds.size > 0 && taskCompletionTaskIds.size > 0 &&
    [...taskCompletionTaskIds].every(taskId => tasks.some(task => task.task_id === taskId && matchingJobSet.has(task.job_id)));
  const taskCompletionCallsMatch = completeTaskResults.every(resultEvent => {
    const call = completeTaskCalls.find(candidate => candidate.ordinal === resultEvent.ordinal);
    return Boolean(call && call.arguments?.task_id === resultEvent.result?.task?.task_id &&
      tasks.some(task => task.task_id === call.arguments.task_id && matchingJobSet.has(task.job_id)));
  });
  add('model-driven-task-completion', hasTaskCompletion && taskCompletionCallsMatch,
    JSON.stringify({ calls: completeTaskCalls.length, resultIds: [...taskCompletionResultIds], taskIds: [...taskCompletionTaskIds], taskCompletionCallsMatch }));

  if (mode === 'failure-state') {
    const failedTasks = tasks.filter(task => matchingJobSet.has(task.job_id) && ['failed', 'cancelled'].includes(String(task.status).toLowerCase()));
    const successSynthesis = jobArtifacts.some(artifact => artifact.kind === 'cto-decision' && artifact.status === 'active');
    const terminalSuccess = matchingJobs.some(job => ['COMPLETED', 'SUCCEEDED'].includes(String(job.state).toUpperCase()) || String(job.status).toLowerCase() === 'completed');
    add('required-task-failure-durable', failedTasks.length > 0 && completeTaskResults.some(event => event.result?.task?.status === 'failed' || event.result?.completed === false),
      `failed tasks=${failedTasks.length}`);
    add('no-success-synthesis-after-failure', !successSynthesis && !terminalSuccess,
      JSON.stringify({ successSynthesis, terminalSuccess }));
    const failed = checks.filter(check => !check.passed);
    return { status: failed.length ? 'invalid-evidence' : 'verified', mode, checks,
      failed_checks: failed.map(check => check.name), artifact_ids: [], job_ids: [...matchingJobSet],
      causal_link_proven: failed.length === 0 };
  }

  const expectedType = contract.required_artifact_type;
  const taskArtifacts = parsedArtifacts.filter(({ row }) => row.kind === expectedType && row.status === 'active' && row.task_id);
  const synthesisArtifacts = parsedArtifacts.filter(({ row }) => row.kind === 'cto-decision' && row.status === 'active');
  add('typed-task-artifact-present', taskArtifacts.length === 1,
    `required type=${expectedType}; matching artifacts=${taskArtifacts.length}`);
  const requiredArtifactLinkedToCompletedTask = taskArtifacts.some(item => taskArtifactLinks.some(link =>
    link.row.artifact_id === item.row.artifact_id && link.row.task_id === item.row.task_id && link.row.job_id === item.row.job_id));
  add('required-typed-artifact-linked-to-completed-task-result', requiredArtifactLinkedToCompletedTask,
    `required typed artifacts=${taskArtifacts.length}; valid completed-task links=${taskArtifacts.filter(item => taskArtifactLinks.some(link =>
      link.row.artifact_id === item.row.artifact_id && link.row.task_id === item.row.task_id && link.row.job_id === item.row.job_id)).length}`);
  const synthesisResultsForJob = synthesisResults.filter(event => matchingJobSet.has(event.result?.job?.job_id) && event.result?.terminalized === true);
  const synthesisCallsForJob = synthesisCalls.filter(event => matchingJobSet.has(event.arguments?.job_id));
  add('cto-synthesis-artifact-present', synthesisArtifacts.length === 1 && synthesisCallsForJob.length > 0 && synthesisResultsForJob.length > 0,
    JSON.stringify({ artifacts: synthesisArtifacts.length, synthesisCallsForJob: synthesisCallsForJob.length, synthesisResultsForJob: synthesisResultsForJob.length }));

  // Reconcile trace terminal IDs to the durable result rows and artifact
  // evidence references. A completed-looking trace and a valid DB snapshot
  // are not enough when they describe different results.
  const taskCompletionTraceLinks = taskArtifacts.map(({ row }) => {
    const evidence = parseJson(row.evidence_json);
    const evidenceIds = Array.isArray(evidence) ? evidence : [];
    const matchingResults = completeTaskResults.filter(event =>
      event.result?.task?.task_id === row.task_id &&
      matchingJobSet.has(event.result?.job_id ?? row.job_id) &&
      completeTaskCalls.some(call => call.ordinal === event.ordinal && call.arguments?.task_id === row.task_id) &&
      typeof event.result?.result_id === 'string' && evidenceIds.includes(event.result.result_id));
    return { artifact_id: row.artifact_id, task_id: row.task_id, evidence,
      matchingResults: matchingResults.map(event => ({ ordinal: event.ordinal, result_id: event.result.result_id })) };
  });
  const taskResultTraceLinksValid = taskArtifacts.length > 0 && taskCompletionTraceLinks.every(link =>
    Array.isArray(link.evidence) && link.matchingResults.length === 1 &&
    results.some(result => result.result_id === link.matchingResults[0].result_id &&
      result.task_id === link.task_id && result.outcome === 'success'));
  const synthesisTraceLinks = synthesisArtifacts.map(({ row }) => {
    const evidence = parseJson(row.evidence_json);
    const evidenceIds = Array.isArray(evidence) ? evidence : [];
    const matchingResults = synthesisResultsForJob.filter(event =>
      synthesisCallsForJob.some(call => call.ordinal === event.ordinal && call.arguments?.job_id === event.result?.job?.job_id) &&
      typeof event.result?.synthesis_result_id === 'string' && evidenceIds.includes(event.result.synthesis_result_id));
    return { artifact_id: row.artifact_id, task_id: row.task_id, evidence,
      matchingResults: matchingResults.map(event => ({ ordinal: event.ordinal, result_id: event.result.synthesis_result_id })) };
  });
  const synthesisResultTraceLinksValid = synthesisArtifacts.length === 1 && synthesisTraceLinks.every(link =>
    Array.isArray(link.evidence) && link.matchingResults.length === 1 &&
    results.some(result => result.result_id === link.matchingResults[0].result_id &&
      result.task_id === link.task_id && result.outcome === 'success'));
  add('task-artifact-result-trace-correlation', taskResultTraceLinksValid,
    JSON.stringify(taskCompletionTraceLinks));
  add('synthesis-artifact-result-trace-correlation', synthesisResultTraceLinksValid,
    JSON.stringify(synthesisTraceLinks));

  const requiredFiles = contract.required_workspace_files ?? [];
  const conditionalFiles = contract.conditional_workspace_files ?? [];
  const optionalFiles = new Set(contract.optional_workspace_files ?? []);
  const expectedFiles = [];
  for (const rel of [...requiredFiles, ...conditionalFiles]) {
    const evidence = fileEvidence(workspace, rel);
    if (evidence.ok) expectedFiles.push(evidence);
    else if (requiredFiles.includes(rel)) add(`workspace-file:${rel}`, false, evidence.reason);
  }
  for (const rel of optionalFiles) {
    const evidence = fileEvidence(workspace, rel);
    if (evidence.ok) expectedFiles.push(evidence);
  }
  for (const evidence of expectedFiles) add(`workspace-file-hash:${evidence.path}`,
    expectedFiles.filter(item => item.path === evidence.path).length === 1,
    JSON.stringify({ path: evidence.path, sha256: evidence.sha256, bytes: evidence.bytes }));

  const lineageContent = [...taskArtifacts, ...synthesisArtifacts].map(item => ({ ...item, content: item.content }));
  const referenced = new Map();
  const traceEvidence = [];
  for (const { row, content } of lineageContent) {
    for (const entry of Array.isArray(content?.workspace_artifacts) ? content.workspace_artifacts : []) {
      if (typeof entry?.path === 'string' && typeof entry?.sha256 === 'string') {
        const key = `${entry.path}:${entry.sha256}`;
        referenced.set(key, (referenced.get(key) ?? 0) + 1);
      }
    }
    for (const entry of Array.isArray(content?.trace_evidence) ? content.trace_evidence : []) traceEvidence.push({ artifactId: row.artifact_id, entry });
  }
  const allFileLineage = expectedFiles.every(file => (referenced.get(`${file.path}:${file.sha256}`) ?? 0) >= 1) &&
    [...referenced.keys()].every(key => expectedFiles.some(file => key === `${file.path}:${file.sha256}`));
  add('artifact-to-workspace-byte-lineage', allFileLineage,
    JSON.stringify({ expected: expectedFiles.map(file => ({ path: file.path, sha256: file.sha256 })), referenced: [...referenced.entries()] }));

  const entriesFor = artifact => Array.isArray(artifact?.content?.workspace_artifacts)
    ? artifact.content.workspace_artifacts
    : [];
  const exactlyMatchesFinalHashes = artifact => {
    const entries = artifact?.content?.workspace_artifacts;
    if (expectedFiles.length === 0) return entries === undefined || (Array.isArray(entries) && entries.length === 0);
    if (!Array.isArray(entries) || entries.length !== expectedFiles.length) return false;
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || seen.has(entry.path)) return false;
      seen.add(entry.path);
      const expected = expectedFiles.find(file => file.path === entry.path);
      if (!expected || expected.sha256 !== entry.sha256) return false;
    }
    return expectedFiles.every(file => seen.has(file.path));
  };
  const taskArtifactHasAllFinalHashes = taskArtifacts.length === 1 && exactlyMatchesFinalHashes(taskArtifacts[0]);
  add('task-artifact-references-final-workspace-hashes', taskArtifactHasAllFinalHashes,
    JSON.stringify({ expected: expectedFiles.map(file => ({ path: file.path, sha256: file.sha256 })),
      taskArtifacts: taskArtifacts.map(artifact => ({ artifact_id: artifact.row.artifact_id, workspace_artifacts: entriesFor(artifact) })) }));
  const synthesisHasAllFinalHashes = synthesisArtifacts.length === 1 && exactlyMatchesFinalHashes(synthesisArtifacts[0]);
  add('synthesis-references-final-workspace-hashes', synthesisHasAllFinalHashes,
    JSON.stringify({ expected: expectedFiles.map(file => ({ path: file.path, sha256: file.sha256 })),
      synthesisArtifacts: synthesisArtifacts.map(artifact => ({ artifact_id: artifact.row.artifact_id, workspace_artifacts: entriesFor(artifact) })) }));

  if (mode === 'trace-linked-artifact') {
    const healthEvents = (trace?.tool_events ?? []).filter(event => event.kind === 'basic_tool_execution' && event.tool_name === 'mock_health_check');
    const healthTraceEvidence = traceEvidence.filter(item => item.entry?.tool_name === 'mock_health_check');
    const allTraceEventsLinked = healthEvents.length >= 3 && healthTraceEvidence.length === healthEvents.length && healthEvents.every(event =>
      traceEvidence.filter(item => item.entry?.tool_name === event.tool_name && item.entry?.ordinal === event.ordinal &&
        item.entry?.result_sha256 === sha256(JSON.stringify(event.result))).length === 1);
    add('artifact-to-tool-trace-lineage', allTraceEventsLinked,
      JSON.stringify({ observedHealthEvents: healthEvents.map(event => ({ ordinal: event.ordinal, result_sha256: sha256(JSON.stringify(event.result)) })), traceEvidence }));
  }

  const completedJobs = matchingJobs.filter(job => ['COMPLETED', 'SUCCEEDED'].includes(String(job.state).toUpperCase()) || String(job.status).toLowerCase() === 'completed');
  add('workflow-terminal-success', completedJobs.length > 0,
    JSON.stringify(matchingJobs.map(job => ({ job_id: job.job_id, state: job.state, status: job.status }))));

  const synthesisContent = synthesisArtifacts.map(item => item.content).find(content => content && Array.isArray(content.evidence_refs));
  const taskArtifactIds = taskArtifacts.map(item => item.row.artifact_id);
  const synthesisArtifactIds = new Set(synthesisArtifacts.filter(item => taskArtifactLinks.some(link => link.row.artifact_id === item.row.artifact_id)).map(item => item.row.artifact_id));
  const taskArtifactReferenced = Boolean(synthesisContent && synthesisArtifactIds.size > 0 &&
    taskArtifactIds.some(id => synthesisContent.evidence_refs.includes(id) || synthesisContent.evidence_refs.includes(`task-artifact:${id}`)));
  add('synthesis-references-task-artifact', taskArtifactReferenced,
    JSON.stringify({ taskArtifactIds, evidence_refs: synthesisContent?.evidence_refs ?? [] }));

  const requiredEvents = new Set(contract.required_workflow_tool_events ?? []);
  const missingEvents = [...requiredEvents].filter(name => pluginCall(trace, name).length === 0 || pluginResult(trace, name).length === 0);
  add('required-workflow-tool-events-present', missingEvents.length === 0, JSON.stringify({ required: [...requiredEvents], missing: missingEvents }));

  const failed = checks.filter(check => !check.passed);
  return { status: failed.length ? 'invalid-evidence' : 'verified', mode, checks,
    failed_checks: failed.map(check => check.name), artifact_ids: [...new Set([...taskArtifacts, ...synthesisArtifacts].map(item => item.row.artifact_id))],
    job_ids: [...matchingJobSet], causal_link_proven: failed.length === 0,
    linked_workspace_files: expectedFiles.map(({ path: rel, sha256: hash }) => ({ path: rel, sha256: hash })) };
}
