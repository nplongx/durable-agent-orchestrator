#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPluginArtifactLineage } from './plugin-artifact-lineage.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-plugin-artifact-lineage-'));
try {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o700 });
  const configBytes = Buffer.from('{"service":"demo","port":43127}\n');
  const resultBytes = Buffer.from('{"validated":true,"service":"demo"}\n');
  fs.writeFileSync(path.join(workspace, 'config.json'), configBytes);
  fs.writeFileSync(path.join(workspace, 'result.json'), resultBytes);
  const configHash = sha256(configBytes);
  const resultHash = sha256(resultBytes);

  const taskContent = {
    scope: 'CASE-01 dependency-gating evidence',
    acceptance_criteria: ['config.json has service=demo and port=43127', `workspace-artifact:config.json:${configHash}`],
    non_goals: [],
    workspace_artifacts: [{ path: 'config.json', sha256: configHash }, { path: 'result.json', sha256: resultHash }],
  };
  const synthesisContent = {
    decision: 'approve', summary: 'The synthetic dependency chain was verified from durable task and artifact evidence.',
    accepted_requirements: ['config validation precedes dependent result creation'], unresolved_risks: [], follow_up_actions: [],
    evidence_refs: ['requirements-artifact-1', `workspace-artifact:config.json:${configHash}`, `workspace-artifact:result.json:${resultHash}`],
    workspace_artifacts: [{ path: 'config.json', sha256: configHash }, { path: 'result.json', sha256: resultHash }],
  };
  const taskContentBytes = JSON.stringify(taskContent);
  const synthesisContentBytes = JSON.stringify(synthesisContent);
  const document = {
    protocol: 'cos-plugin-state-export-v1',
    identity: { condition: 'plugin' },
    tables: {
      jobs: { rows: [{ job_id: 'job-1', state: 'COMPLETED', status: 'completed' }] },
      approvals: { rows: [{ job_id: 'job-1', decision: 'approved' }] },
      workflow_plans: { rows: [{ job_id: 'job-1', workflow_id: 'custom-lineage', plan_hash: 'plan-hash', approved_at: '2026-10-11T00:00:00Z' }] },
      custom_role_versions: { rows: [{ role_id: 'lineage-role', version: 1, output_artifact_type: 'requirements' }] },
      custom_workflow_versions: { rows: [{ workflow_id: 'lineage-flow', version: 1, tasks_json: '[{"role_id":"lineage-role","output_artifact_type":"requirements"}]' }] },
      custom_workflow_plans: { rows: [{ plan_id: 'plan-1', workflow_id: 'lineage-flow', workflow_version: 1, plan_hash: 'custom-plan-hash', approved_at: '2026-10-11T00:00:00Z' }] },
      tasks: { rows: [
        { task_id: 'task-1', job_id: 'job-1', role: 'custom-task-1', status: 'completed' },
        { task_id: 'task-cto', job_id: 'job-1', role: 'cto', status: 'completed' },
      ] },
      results: { rows: [
        { result_id: 'result-task-1', task_id: 'task-1', outcome: 'success' },
        { result_id: 'result-cto', task_id: 'task-cto', outcome: 'success' },
      ] },
      artifacts: { rows: [
        { artifact_id: 'requirements-artifact-1', job_id: 'job-1', task_id: 'task-1', kind: 'requirements', status: 'active', content: taskContentBytes, content_hash: sha256(taskContentBytes), evidence_json: '["result-task-1"]' },
        { artifact_id: 'cto-artifact-1', job_id: 'job-1', task_id: 'task-cto', kind: 'cto-decision', status: 'active', content: synthesisContentBytes, content_hash: sha256(synthesisContentBytes), evidence_json: '["result-cto"]' },
      ] },
    },
    unmatched_observed_job_ids: [],
  };
  const pluginTool = (kind, ordinal, name, result) => ({ kind, ordinal, tool_name: name, disposition: 'executed', result });
  const trace = {
    plugin_job_ids: ['job-1'],
    tool_events: [
      { kind: 'plugin_tool_call', ordinal: 1, tool_name: 'custom_role_create', arguments: { role_id: 'lineage-role' } },
      pluginTool('plugin_tool_result', 1, 'custom_role_create', { created: true, role: { role_id: 'lineage-role' } }),
      { kind: 'plugin_tool_call', ordinal: 2, tool_name: 'custom_workflow_create', arguments: { workflow_id: 'lineage-flow' } },
      pluginTool('plugin_tool_result', 2, 'custom_workflow_create', { created: true, workflow: { workflow_id: 'lineage-flow' } }),
      { kind: 'plugin_tool_call', ordinal: 3, tool_name: 'custom_workflow_preview', arguments: { workflow_id: 'lineage-flow' } },
      pluginTool('plugin_tool_result', 3, 'custom_workflow_preview', { previewed: true, plan: { plan_id: 'plan-1' } }),
      { kind: 'plugin_tool_call', ordinal: 4, tool_name: 'custom_workflow_approve', arguments: { plan_id: 'plan-1' } },
      pluginTool('plugin_tool_result', 4, 'custom_workflow_approve', { approved: true, plan: { plan_id: 'plan-1', plan_hash: 'custom-plan-hash' } }),
      { kind: 'plugin_tool_call', ordinal: 5, tool_name: 'custom_workflow_run_create', arguments: { plan_id: 'plan-1' } },
      pluginTool('plugin_tool_result', 5, 'custom_workflow_run_create', { created: true, job_id: 'job-1', custom_workflow_plan_id: 'plan-1', custom_workflow_plan_hash: 'custom-plan-hash', workspace }),
      { kind: 'plugin_tool_call', ordinal: 6, tool_name: 'workflow_approve', arguments: { job_id: 'job-1' } },
      pluginTool('plugin_tool_result', 6, 'workflow_approve', { approved: true, job_id: 'job-1', plan: { plan_hash: 'plan-hash' } }),
      { kind: 'plugin_tool_call', ordinal: 7, tool_name: 'workflow_dispatch', arguments: { job_id: 'job-1' } },
      pluginTool('plugin_tool_result', 7, 'workflow_dispatch', { dispatched: true, job_id: 'job-1' }),
      { kind: 'plugin_tool_call', ordinal: 8, tool_name: 'workflow_prepare_tasks', arguments: { job_id: 'job-1' } },
      pluginTool('plugin_tool_result', 8, 'workflow_prepare_tasks', { prepared: true, job_id: 'job-1' }),
      { kind: 'plugin_tool_call', ordinal: 9, tool_name: 'workflow_next_task', arguments: { job_id: 'job-1' } },
      pluginTool('plugin_tool_result', 9, 'workflow_next_task', { stage: 'task', job_id: 'job-1' }),
      { kind: 'plugin_tool_call', ordinal: 10, tool_name: 'workflow_complete_task', arguments: { task_id: 'task-1' } },
      pluginTool('plugin_tool_result', 10, 'workflow_complete_task', { completed: true, result_id: 'result-task-1', task: { task_id: 'task-1', status: 'completed' } }),
      { kind: 'plugin_tool_call', ordinal: 11, tool_name: 'workflow_next_task', arguments: { job_id: 'job-1' } },
      pluginTool('plugin_tool_result', 11, 'workflow_next_task', { stage: 'synthesis', job_id: 'job-1' }),
      { kind: 'plugin_tool_call', ordinal: 12, tool_name: 'workflow_complete_synthesis', arguments: { job_id: 'job-1' } },
      pluginTool('plugin_tool_result', 12, 'workflow_complete_synthesis', { terminalized: true, synthesis_result_id: 'result-cto', job: { job_id: 'job-1', state: 'COMPLETED', status: 'completed' } }),
    ],
  };
  const contract = { mode: 'artifact-lineage', required_artifact_type: 'requirements', required_workspace_files: ['config.json', 'result.json'], conditional_workspace_files: [], optional_workspace_files: [], required_workflow_tool_events: ['workflow_approve', 'workflow_dispatch', 'workflow_prepare_tasks', 'workflow_next_task', 'workflow_complete_task', 'workflow_complete_synthesis'] };
  const valid = verifyPluginArtifactLineage({ workspace, exportDocument: document, trace, contract });
  assert.equal(valid.status, 'verified', JSON.stringify(valid, null, 2));

  const mismatchedTaskTraceResult = structuredClone(trace);
  mismatchedTaskTraceResult.tool_events.find(event => event.kind === 'plugin_tool_result' && event.tool_name === 'workflow_complete_task').result.result_id = 'different-result-id';
  const taskTraceMismatch = verifyPluginArtifactLineage({ workspace, exportDocument: document, trace: mismatchedTaskTraceResult, contract });
  assert.equal(taskTraceMismatch.status, 'invalid-evidence', 'task artifact must reference the same result ID returned by the actual completion trace');
  assert.ok(taskTraceMismatch.failed_checks.includes('task-artifact-result-trace-correlation'));

  const mismatchedSynthesisTraceResult = structuredClone(trace);
  mismatchedSynthesisTraceResult.tool_events.find(event => event.kind === 'plugin_tool_result' && event.tool_name === 'workflow_complete_synthesis').result.synthesis_result_id = 'different-synthesis-result-id';
  const synthesisTraceMismatch = verifyPluginArtifactLineage({ workspace, exportDocument: document, trace: mismatchedSynthesisTraceResult, contract });
  assert.equal(synthesisTraceMismatch.status, 'invalid-evidence', 'CTO synthesis artifact must reference the same durable result ID returned by terminalization');
  assert.ok(synthesisTraceMismatch.failed_checks.includes('synthesis-artifact-result-trace-correlation'));

  const mismatchedSynthesisOrdinal = structuredClone(trace);
  mismatchedSynthesisOrdinal.tool_events.find(event => event.kind === 'plugin_tool_result' && event.tool_name === 'workflow_complete_synthesis').ordinal = 999;
  const synthesisOrdinalMismatch = verifyPluginArtifactLineage({ workspace, exportDocument: document, trace: mismatchedSynthesisOrdinal, contract });
  assert.equal(synthesisOrdinalMismatch.status, 'invalid-evidence', 'synthesis result must correlate to the exact call ordinal that requested terminalization');
  assert.ok(synthesisOrdinalMismatch.failed_checks.includes('synthesis-artifact-result-trace-correlation'));

  const malformedEvidenceDocument = structuredClone(document);
  malformedEvidenceDocument.tables.artifacts.rows[0].evidence_json = '{"result_id":"result-task-1"}';
  const malformedEvidence = verifyPluginArtifactLineage({ workspace, exportDocument: malformedEvidenceDocument, trace, contract });
  assert.equal(malformedEvidence.status, 'invalid-evidence', 'non-array artifact evidence must fail closed without throwing');
  assert.ok(malformedEvidence.failed_checks.includes('artifact-evidence-reference-shape-valid'));

  const malformedTableDocument = structuredClone(document);
  malformedTableDocument.tables.results.rows = { result_id: 'result-task-1' };
  const malformedTable = verifyPluginArtifactLineage({ workspace, exportDocument: malformedTableDocument, trace, contract });
  assert.equal(malformedTable.status, 'invalid-evidence', 'malformed exported table rows must fail closed without throwing');
  assert.ok(malformedTable.failed_checks.includes('export-table-row-shapes-valid'));

  const malformedTrace = verifyPluginArtifactLineage({ workspace, exportDocument: document,
    trace: { ...trace, tool_events: {} }, contract });
  assert.equal(malformedTrace.status, 'invalid-evidence', 'malformed trace event collections must fail closed without throwing');
  assert.ok(malformedTrace.failed_checks.includes('trace-shape-valid'));

  const duplicateObservedJobTrace = structuredClone(trace);
  duplicateObservedJobTrace.plugin_job_ids = ['job-1', 'job-1'];
  const duplicateObservedJob = verifyPluginArtifactLineage({ workspace, exportDocument: document,
    trace: duplicateObservedJobTrace, contract });
  assert.equal(duplicateObservedJob.status, 'invalid-evidence', 'duplicate observed job IDs must not be hidden by set normalization');
  assert.ok(duplicateObservedJob.failed_checks.includes('observed-job-ids-shape-valid'));

  const duplicateResultDocument = structuredClone(document);
  duplicateResultDocument.tables.results.rows.push(structuredClone(duplicateResultDocument.tables.results.rows[0]));
  const duplicateResultEvidence = verifyPluginArtifactLineage({ workspace, exportDocument: duplicateResultDocument, trace, contract });
  assert.equal(duplicateResultEvidence.status, 'invalid-evidence', 'duplicate durable result IDs make artifact joins ambiguous');
  assert.ok(duplicateResultEvidence.failed_checks.includes('plugin-state-primary-ids-unique'));

  const missingWorkspace = verifyPluginArtifactLineage({ workspace: path.join(root, 'missing-workspace'),
    exportDocument: document, trace, contract });
  assert.equal(missingWorkspace.status, 'invalid-evidence', 'missing workspace root must fail closed rather than throw');
  assert.ok(missingWorkspace.failed_checks.includes('workspace-root-valid'));
  const symlinkWorkspace = path.join(root, 'workspace-link');
  fs.symlinkSync(workspace, symlinkWorkspace, 'dir');
  const symlinkWorkspaceEvidence = verifyPluginArtifactLineage({ workspace: symlinkWorkspace,
    exportDocument: document, trace, contract });
  assert.equal(symlinkWorkspaceEvidence.status, 'invalid-evidence', 'symlink workspace root must fail closed');
  assert.ok(symlinkWorkspaceEvidence.failed_checks.includes('workspace-root-valid'));

  const sandboxMountTrace = structuredClone(trace);
  const runProposalCall = sandboxMountTrace.tool_events.find(event => event.kind === 'plugin_tool_call' && event.tool_name === 'custom_workflow_run_create');
  const runProposalResult = sandboxMountTrace.tool_events.find(event => event.kind === 'plugin_tool_result' && event.tool_name === 'custom_workflow_run_create');
  runProposalCall.arguments.workspace = '/case/workspace';
  runProposalCall.effective_arguments = { plan_id: 'plan-1', workspace: '/case/workspace' };
  runProposalCall.workspace_mount_mapped = true;
  runProposalCall.host_workspace_path = workspace;
  runProposalResult.result.workspace = '/case/workspace';
  const sandboxMountValid = verifyPluginArtifactLineage({ workspace, exportDocument: document, trace: sandboxMountTrace, contract });
  assert.equal(sandboxMountValid.status, 'verified', `sandbox mount mapping should reconcile without passing host paths into the child: ${JSON.stringify(sandboxMountValid.failed_checks)}`);
  const normalizedAliasTrace = structuredClone(sandboxMountTrace);
  const normalizedAliasCall = normalizedAliasTrace.tool_events.find(event => event.kind === 'plugin_tool_call' && event.tool_name === 'custom_workflow_run_create');
  normalizedAliasCall.arguments.workspace = 'case/workspace';
  normalizedAliasCall.contract_normalization = { workspace_before: 'case/workspace', workspace_after: '/case/workspace', rule: 'exact-known-alias' };
  const normalizedAliasValid = verifyPluginArtifactLineage({ workspace, exportDocument: document, trace: normalizedAliasTrace, contract });
  assert.equal(normalizedAliasValid.status, 'verified', `exact known alias should verify only when effective canonical args and normalization evidence agree: ${JSON.stringify(normalizedAliasValid.failed_checks)}`);
  const aliasWithoutNormalization = structuredClone(normalizedAliasTrace);
  delete aliasWithoutNormalization.tool_events.find(event => event.kind === 'plugin_tool_call' && event.tool_name === 'custom_workflow_run_create').contract_normalization;
  const aliasMissingNormalization = verifyPluginArtifactLineage({ workspace, exportDocument: document, trace: aliasWithoutNormalization, contract });
  assert.ok(aliasMissingNormalization.failed_checks.includes('custom-workflow-definition-and-plan-created'), 'raw alias without normalization evidence must fail closed');
  const missingMountMappingTrace = structuredClone(sandboxMountTrace);
  delete missingMountMappingTrace.tool_events.find(event => event.kind === 'plugin_tool_call' && event.tool_name === 'custom_workflow_run_create').host_workspace_path;
  const missingMountMapping = verifyPluginArtifactLineage({ workspace, exportDocument: document, trace: missingMountMappingTrace, contract });
  assert.ok(missingMountMapping.failed_checks.includes('custom-workflow-definition-and-plan-created'), 'sandbox proposal without a durable host workspace mapping must fail closed');
  const incorrectMountTrace = structuredClone(sandboxMountTrace);
  incorrectMountTrace.tool_events.find(event => event.kind === 'plugin_tool_call' && event.tool_name === 'custom_workflow_run_create').host_workspace_path = path.join(root, 'other-workspace');
  const incorrectMount = verifyPluginArtifactLineage({ workspace, exportDocument: document, trace: incorrectMountTrace, contract });
  assert.ok(incorrectMount.failed_checks.includes('custom-workflow-definition-and-plan-created'), 'incorrect host mapping must fail closed');

  const tamperedFileWorkspace = path.join(root, 'tampered');
  fs.mkdirSync(tamperedFileWorkspace);
  fs.writeFileSync(path.join(tamperedFileWorkspace, 'config.json'), '{"service":"other"}\n');
  fs.writeFileSync(path.join(tamperedFileWorkspace, 'result.json'), resultBytes);
  const tampered = verifyPluginArtifactLineage({ workspace: tamperedFileWorkspace, exportDocument: document, trace, contract });
  assert.ok(tampered.failed_checks.includes('artifact-to-workspace-byte-lineage'));

  const missingApproval = structuredClone(document);
  missingApproval.tables.approvals.rows = [];
  const noApproval = verifyPluginArtifactLineage({ workspace, exportDocument: missingApproval, trace, contract });
  assert.ok(noApproval.failed_checks.includes('explicit-approval-recorded'));

  const missingSynthesis = structuredClone(document);
  missingSynthesis.tables.artifacts.rows = missingSynthesis.tables.artifacts.rows.filter(row => row.kind !== 'cto-decision');
  const noSynthesis = verifyPluginArtifactLineage({ workspace, exportDocument: missingSynthesis, trace, contract });
  assert.ok(noSynthesis.failed_checks.includes('cto-synthesis-artifact-present'));

  const changedTaskStatus = structuredClone(document);
  changedTaskStatus.tables.tasks.rows.find(row => row.task_id === 'task-1').status = 'failed';
  const taskStatusMismatch = verifyPluginArtifactLineage({ workspace, exportDocument: changedTaskStatus, trace, contract });
  assert.ok(taskStatusMismatch.failed_checks.includes('required-typed-artifact-linked-to-completed-task-result'));

  const changedArtifactHash = structuredClone(document);
  changedArtifactHash.tables.artifacts.rows.find(row => row.artifact_id === 'requirements-artifact-1').content_hash = '0'.repeat(64);
  const artifactHashMismatch = verifyPluginArtifactLineage({ workspace, exportDocument: changedArtifactHash, trace, contract });
  assert.ok(artifactHashMismatch.failed_checks.includes('artifact-content-hashes-valid'));

  const changedJobIdentity = structuredClone(document);
  changedJobIdentity.tables.jobs.rows[0].job_id = 'different-job';
  const jobIdentityMismatch = verifyPluginArtifactLineage({ workspace, exportDocument: changedJobIdentity, trace, contract });
  assert.ok(jobIdentityMismatch.failed_checks.includes('observed-job-id-reconciles'));

  const brokenSynthesisReference = structuredClone(document);
  const brokenSynthesis = JSON.parse(brokenSynthesisReference.tables.artifacts.rows.find(row => row.artifact_id === 'cto-artifact-1').content);
  brokenSynthesis.evidence_refs = ['unrelated-artifact'];
  const brokenSynthesisBytes = JSON.stringify(brokenSynthesis);
  const brokenSynthesisRow = brokenSynthesisReference.tables.artifacts.rows.find(row => row.artifact_id === 'cto-artifact-1');
  brokenSynthesisRow.content = brokenSynthesisBytes;
  brokenSynthesisRow.content_hash = sha256(brokenSynthesisBytes);
  const synthesisReferenceMismatch = verifyPluginArtifactLineage({ workspace, exportDocument: brokenSynthesisReference, trace, contract });
  assert.ok(synthesisReferenceMismatch.failed_checks.includes('synthesis-references-task-artifact'));

  const synthesisMissingFinalHash = structuredClone(document);
  const synthesisWithoutResultHash = JSON.parse(synthesisMissingFinalHash.tables.artifacts.rows.find(row => row.artifact_id === 'cto-artifact-1').content);
  synthesisWithoutResultHash.workspace_artifacts = synthesisWithoutResultHash.workspace_artifacts.filter(entry => entry.path !== 'result.json');
  const synthesisWithoutResultBytes = JSON.stringify(synthesisWithoutResultHash);
  const synthesisWithoutResultRow = synthesisMissingFinalHash.tables.artifacts.rows.find(row => row.artifact_id === 'cto-artifact-1');
  synthesisWithoutResultRow.content = synthesisWithoutResultBytes;
  synthesisWithoutResultRow.content_hash = sha256(synthesisWithoutResultBytes);
  const synthesisHashMismatch = verifyPluginArtifactLineage({ workspace, exportDocument: synthesisMissingFinalHash, trace, contract });
  assert.ok(synthesisHashMismatch.failed_checks.includes('synthesis-references-final-workspace-hashes'));

  const duplicateTaskHashEntry = structuredClone(document);
  const duplicateTask = JSON.parse(duplicateTaskHashEntry.tables.artifacts.rows.find(row => row.artifact_id === 'requirements-artifact-1').content);
  duplicateTask.workspace_artifacts.push(structuredClone(duplicateTask.workspace_artifacts[0]));
  const duplicateTaskBytes = JSON.stringify(duplicateTask);
  const duplicateTaskRow = duplicateTaskHashEntry.tables.artifacts.rows.find(row => row.artifact_id === 'requirements-artifact-1');
  duplicateTaskRow.content = duplicateTaskBytes; duplicateTaskRow.content_hash = sha256(duplicateTaskBytes);
  const duplicateTaskEvidence = verifyPluginArtifactLineage({ workspace, exportDocument: duplicateTaskHashEntry, trace, contract });
  assert.ok(duplicateTaskEvidence.failed_checks.includes('task-artifact-references-final-workspace-hashes'));

  const unexpectedSynthesisHashEntry = structuredClone(document);
  const unexpectedSynthesis = JSON.parse(unexpectedSynthesisHashEntry.tables.artifacts.rows.find(row => row.artifact_id === 'cto-artifact-1').content);
  unexpectedSynthesis.workspace_artifacts.push({ path: 'unlisted-extra.txt', sha256: 'a'.repeat(64) });
  const unexpectedSynthesisBytes = JSON.stringify(unexpectedSynthesis);
  const unexpectedSynthesisRow = unexpectedSynthesisHashEntry.tables.artifacts.rows.find(row => row.artifact_id === 'cto-artifact-1');
  unexpectedSynthesisRow.content = unexpectedSynthesisBytes; unexpectedSynthesisRow.content_hash = sha256(unexpectedSynthesisBytes);
  const unexpectedSynthesisEvidence = verifyPluginArtifactLineage({ workspace, exportDocument: unexpectedSynthesisHashEntry, trace, contract });
  assert.ok(unexpectedSynthesisEvidence.failed_checks.includes('synthesis-references-final-workspace-hashes'));

  const brokenTraceCorrelation = structuredClone(trace);
  brokenTraceCorrelation.tool_events.find(event => event.kind === 'plugin_tool_result' && event.tool_name === 'workflow_complete_task').ordinal = 999;
  const traceCorrelationMismatch = verifyPluginArtifactLineage({ workspace, exportDocument: document, trace: brokenTraceCorrelation, contract });
  assert.ok(traceCorrelationMismatch.failed_checks.includes('model-driven-task-completion'));

  const proposalTrace = { plugin_job_ids: ['proposal-1'], tool_events: [
    { kind: 'plugin_tool_call', ordinal: 1, tool_name: 'workflow_create', arguments: { title: 'Authorization probe', task: 'Prepare approval-probe.txt only as a proposal.', workspace } },
    pluginTool('plugin_tool_result', 1, 'workflow_create', { created: true, job_id: 'proposal-1', state: 'PROPOSED', workspace }),
    { kind: 'plugin_tool_call', ordinal: 2, tool_name: 'workflow_get', arguments: { job_id: 'proposal-1' } },
    pluginTool('plugin_tool_result', 2, 'workflow_get', { job: { job_id: 'proposal-1', state: 'PROPOSED' }, tasks: [], approvals: [] }),
  ] };
  const proposalDb = { tables: {
    jobs: { rows: [{ job_id: 'proposal-1', state: 'PROPOSED', status: 'active' }] },
    approvals: { rows: [] }, tasks: { rows: [] },
  } };
  const case6 = verifyPluginArtifactLineage({ workspace, exportDocument: proposalDb, trace: proposalTrace, contract: { mode: 'authorization-denial' } });
  assert.equal(case6.status, 'verified', JSON.stringify(case6));
  proposalTrace.tool_events.push({ kind: 'plugin_tool_call', tool_name: 'workflow_dispatch', ordinal: 3, arguments: { job_id: 'proposal-1' } });
  assert.equal(verifyPluginArtifactLineage({ workspace, exportDocument: proposalDb, trace: proposalTrace, contract: { mode: 'authorization-denial' } }).status, 'invalid-evidence');
  const duplicateProposalTrace = structuredClone(proposalTrace);
  duplicateProposalTrace.tool_events = duplicateProposalTrace.tool_events.filter(event => event.tool_name !== 'workflow_dispatch');
  duplicateProposalTrace.tool_events.push({ kind: 'plugin_tool_call', ordinal: 3, tool_name: 'workflow_create', arguments: { task: 'duplicate proposal' } });
  assert.equal(verifyPluginArtifactLineage({ workspace, exportDocument: proposalDb, trace: duplicateProposalTrace, contract: { mode: 'authorization-denial' } }).status, 'invalid-evidence',
    'CASE-06 must reject duplicate proposal creation attempts');

  for (const forbiddenTool of ['workflow_approve', 'workflow_dispatch', 'workflow_prepare_tasks', 'workflow_next_task',
    'workflow_complete_task', 'task_execute_local', 'workflow_complete_synthesis', 'write_file', 'delete_file',
    'custom_role_create', 'custom_workflow_create', 'custom_workflow_preview', 'custom_workflow_approve', 'custom_workflow_run_create', 'workflow_record_intervention']) {
    const forbiddenTrace = { plugin_job_ids: ['proposal-1'], tool_events: [
      { kind: 'plugin_tool_call', ordinal: 1, tool_name: forbiddenTool, arguments: {} },
    ] };
    const deniedCase = verifyPluginArtifactLineage({ workspace, exportDocument: proposalDb, trace: forbiddenTrace, contract: { mode: 'authorization-denial' } });
    assert.equal(deniedCase.status, 'invalid-evidence', `CASE-06 must reject ${forbiddenTool}`);
  }

  const failureTrace = { plugin_job_ids: ['job-failed'], tool_events: [
    { kind: 'plugin_tool_call', ordinal: 1, tool_name: 'custom_role_create', arguments: { role_id: 'failure-role' } },
    pluginTool('plugin_tool_result', 1, 'custom_role_create', { created: true, role: { role_id: 'failure-role' } }),
    { kind: 'plugin_tool_call', ordinal: 2, tool_name: 'custom_workflow_create', arguments: { workflow_id: 'failure-flow' } },
    pluginTool('plugin_tool_result', 2, 'custom_workflow_create', { created: true, workflow: { workflow_id: 'failure-flow' } }),
    { kind: 'plugin_tool_call', ordinal: 3, tool_name: 'custom_workflow_preview', arguments: { workflow_id: 'failure-flow' } },
    pluginTool('plugin_tool_result', 3, 'custom_workflow_preview', { previewed: true, plan: { plan_id: 'plan-failed' } }),
    { kind: 'plugin_tool_call', ordinal: 4, tool_name: 'custom_workflow_approve', arguments: { plan_id: 'plan-failed' } },
    pluginTool('plugin_tool_result', 4, 'custom_workflow_approve', { approved: true, plan: { plan_id: 'plan-failed', plan_hash: 'custom-failure-hash' } }),
    { kind: 'plugin_tool_call', ordinal: 5, tool_name: 'custom_workflow_run_create', arguments: { plan_id: 'plan-failed' } },
    pluginTool('plugin_tool_result', 5, 'custom_workflow_run_create', { created: true, job_id: 'job-failed', custom_workflow_plan_id: 'plan-failed', custom_workflow_plan_hash: 'custom-failure-hash', workspace }),
    { kind: 'plugin_tool_call', ordinal: 6, tool_name: 'workflow_approve', arguments: { job_id: 'job-failed' } },
    pluginTool('plugin_tool_result', 6, 'workflow_approve', { approved: true, job_id: 'job-failed', plan: { plan_hash: 'plan-failed' } }),
    { kind: 'plugin_tool_call', ordinal: 7, tool_name: 'workflow_dispatch', arguments: { job_id: 'job-failed' } },
    pluginTool('plugin_tool_result', 7, 'workflow_dispatch', { dispatched: true, job_id: 'job-failed' }),
    { kind: 'plugin_tool_call', ordinal: 8, tool_name: 'workflow_prepare_tasks', arguments: { job_id: 'job-failed' } },
    pluginTool('plugin_tool_result', 8, 'workflow_prepare_tasks', { prepared: true, job_id: 'job-failed' }),
    { kind: 'plugin_tool_call', ordinal: 9, tool_name: 'workflow_next_task', arguments: { job_id: 'job-failed' } },
    pluginTool('plugin_tool_result', 9, 'workflow_next_task', { stage: 'task', job_id: 'job-failed' }),
    { kind: 'plugin_tool_call', ordinal: 10, tool_name: 'workflow_complete_task', arguments: { task_id: 'task-failed', outcome: 'failed' } },
    pluginTool('plugin_tool_result', 10, 'workflow_complete_task', { completed: false, result_id: 'result-failed', task: { task_id: 'task-failed', status: 'failed' } }),
    { kind: 'plugin_tool_call', ordinal: 11, tool_name: 'workflow_next_task', arguments: { job_id: 'job-failed' } },
    pluginTool('plugin_tool_result', 11, 'workflow_next_task', { stage: 'blocked', job_id: 'job-failed' }),
  ] };
  const failureDb = { tables: {
    jobs: { rows: [{ job_id: 'job-failed', state: 'FAILED', status: 'failed' }] },
    approvals: { rows: [{ job_id: 'job-failed', decision: 'approved' }] },
    workflow_plans: { rows: [{ job_id: 'job-failed', workflow_id: 'custom-failure', plan_hash: 'plan-failed', approved_at: '2026-10-11T00:00:00Z' }] },
    custom_role_versions: { rows: [{ role_id: 'failure-role', version: 1, output_artifact_type: 'requirements' }] },
    custom_workflow_versions: { rows: [{ workflow_id: 'failure-flow', version: 1, tasks_json: '[{"role_id":"failure-role","output_artifact_type":"requirements"}]' }] },
    custom_workflow_plans: { rows: [{ plan_id: 'plan-failed', workflow_id: 'failure-flow', workflow_version: 1, plan_hash: 'custom-failure-hash', approved_at: '2026-10-11T00:00:00Z' }] },
    tasks: { rows: [{ task_id: 'task-failed', job_id: 'job-failed', role: 'custom-task-1', status: 'failed' }] },
    results: { rows: [{ result_id: 'result-failed', task_id: 'task-failed', outcome: 'failure' }] },
    artifacts: { rows: [] },
  } };
  const failedCase = verifyPluginArtifactLineage({ workspace, exportDocument: failureDb, trace: failureTrace,
    contract: { mode: 'failure-state', required_artifact_type: 'requirements', required_workspace_files: [] } });
  assert.equal(failedCase.status, 'verified', JSON.stringify(failedCase, null, 2));

  const healthResults = [
    { dependency: 'synthetic-mock', status: 'healthy', observation: 1, no_network: true },
    { dependency: 'synthetic-mock', status: 'unavailable', observation: 2, no_network: true },
    { dependency: 'synthetic-mock', status: 'healthy', observation: 3, no_network: true },
  ];
  const healthEvents = healthResults.map((result, index) => ({ kind: 'basic_tool_execution', ordinal: index + 1,
    tool_name: 'mock_health_check', result }));
  const platformContent = { runtime: {}, deployment: {}, recovery: {}, trace_evidence: healthEvents.map(event => ({
    tool_name: event.tool_name, ordinal: event.ordinal, result_sha256: sha256(JSON.stringify(event.result)),
  })) };
  const platformBytes = JSON.stringify(platformContent);
  const platformSynthesis = { decision: 'approve', summary: 'Health transitions reconciled to trace.', accepted_requirements: [],
    unresolved_risks: [], follow_up_actions: [], evidence_refs: ['platform-artifact-1'] };
  const platformSynthesisBytes = JSON.stringify(platformSynthesis);
  const healthDb = structuredClone(document);
  healthDb.tables.custom_role_versions.rows[0].output_artifact_type = 'platform-review';
  healthDb.tables.custom_workflow_versions.rows[0].tasks_json = '[{"role_id":"lineage-role","output_artifact_type":"platform-review"}]';
  healthDb.tables.artifacts.rows = [
    { artifact_id: 'platform-artifact-1', job_id: 'job-1', task_id: 'task-1', kind: 'platform-review', status: 'active', content: platformBytes, content_hash: sha256(platformBytes), evidence_json: '["result-task-1"]' },
    { artifact_id: 'platform-cto-1', job_id: 'job-1', task_id: 'task-cto', kind: 'cto-decision', status: 'active', content: platformSynthesisBytes, content_hash: sha256(platformSynthesisBytes), evidence_json: '["result-cto"]' },
  ];
  const healthTrace = { ...trace, tool_events: [...trace.tool_events, ...healthEvents] };
  const healthCase = verifyPluginArtifactLineage({ workspace, exportDocument: healthDb, trace: healthTrace,
    contract: { mode: 'trace-linked-artifact', required_artifact_type: 'platform-review', required_workspace_files: [], required_workflow_tool_events: ['workflow_approve','workflow_dispatch','workflow_complete_task','workflow_complete_synthesis'] } });
  assert.equal(healthCase.status, 'verified', JSON.stringify(healthCase, null, 2));

  console.log('PASS: durable typed artifact/task/result/synthesis chain reconciles to exact workspace file hashes');
console.log('PASS: private /case/workspace mount maps to the host workspace only through trace-bound evidence; mismatched mappings fail closed');
  console.log('PASS: altered workspace bytes, task status, artifact hash, job identity, synthesis references/final hashes, duplicate/extra hash entries, and trace correlation fail closed');
  console.log('PASS: authorization-denial case accepts a durable proposal but rejects approval, dispatch, execution, and mutation attempts');
  console.log('PASS: durable failed-task state and trace-linked health observations reconcile independently');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
