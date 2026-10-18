import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const tempRoot = tempDir('workflow-m4-');
const workspace = path.join(tempRoot, 'workspace');
const dbPath = path.join(tempRoot, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = path.dirname(dbPath);
process.env.WORKFLOW_WORKSPACE = workspace;
fs.mkdirSync(process.env.WORKFLOW_WORKSPACE, { recursive: true });

const { WorkflowStore, conversationKeyFromMessages } = await import('../src/runtime/job-store.js');
const { compileWorkflowPlan } = await import('../src/runtime/workflow/compiler.js');
const { EngineeringWorkflow, EngineeringTaskId, isEngineeringWorkflow } = await import('../src/runtime/workflow/definitions/engineering.js');
const { TaskCapability, getRoleContract } = await import('../src/runtime/workflow/roles.js');
const { validateEngineeringWorkflow } = await import('../src/runtime/workflow/schema.js');
const { validateExecutionPlan, canonicalJson } = await import('../src/runtime/workflow/plan.js');
const { verifyWorkflowCompletion } = await import('../src/runtime/workflow/verifier.js');
const { canonicalExecutionEvidenceContent, validateEvidenceContract } = await import('../src/runtime/workflow/evidence.js');
const { evaluateLangGraph, LangGraphActions } = await import('../src/runtime/langgraph-orchestrator.js');

assert.equal(isEngineeringWorkflow({ title: 'Engineering M4 acceptance' }), true);
assert.equal(validateEngineeringWorkflow(), true);
assert.equal(EngineeringWorkflow.id, 'engineering');
assert.equal(EngineeringWorkflow.version, 2);
assert.deepEqual(EngineeringWorkflow.requiredChildren, [
  EngineeringTaskId.PRODUCT_OWNER,
  EngineeringTaskId.RESEARCHER,
  EngineeringTaskId.ARCHITECT,
  EngineeringTaskId.ENGINEER,
  EngineeringTaskId.SECURITY,
  EngineeringTaskId.QA,
  EngineeringTaskId.PLATFORM,
  EngineeringTaskId.WRITER,
  EngineeringTaskId.REVIEWER
]);
assert.equal(getRoleContract('engineer').capability, TaskCapability.CODE_MODIFY);
assert.ok(getRoleContract('engineer').permissions.includes('workspace.write'));
assert.ok(!getRoleContract('reviewer').permissions.includes('workspace.write'));
assert.equal(getRoleContract('productowner').capability, TaskCapability.PRODUCT_REQUIREMENTS);
assert.equal(getRoleContract('researcher').capability, TaskCapability.RESEARCH_COLLECT);
assert.equal(getRoleContract('security').capability, TaskCapability.SECURITY_AUDIT);
assert.equal(getRoleContract('platform').capability, TaskCapability.INFRASTRUCTURE_VERIFY);
assert.equal(getRoleContract('writer').capability, TaskCapability.DOCUMENTATION_WRITE);

const store = new WorkflowStore();
const title = 'Engineering M4 acceptance';

const atomicJob = store.createJob({
  conversationKey: conversationKeyFromMessages([{ role: 'user', content: 'Engineering M4 atomic approval' }]),
  title: 'Engineering M4 atomic approval'
});
store.transition(atomicJob.job_id, 'PROPOSED');
const workspaceBeforeApproval = process.env.WORKFLOW_WORKSPACE;
process.env.WORKFLOW_WORKSPACE = '';
// Engineering M4 now delegates non-deterministic specialist reasoning to the
// host conversation, so an empty workspace must not be rejected as if these
// tasks were deterministic local commands.
const approvedWithoutWorkspace = store.approve(atomicJob.job_id, 'duyệt');
assert.equal(approvedWithoutWorkspace.state, 'APPROVED');
const hostPlan = store.getExecutionPlan(atomicJob.job_id);
assert.ok(hostPlan);
assert.ok(hostPlan.children.every(item => item.execution.deterministic === false));
assert.ok(hostPlan.children.every(item => item.execution.executor === 'ChatOnSteroidsHost'));
assert.ok(hostPlan.children.every(item => item.execution.cwd === null));
assert.equal(store.getJobTrace(atomicJob.job_id).approvals.length, 1);
process.env.WORKFLOW_WORKSPACE = workspaceBeforeApproval;

const job = store.getOrCreateJob({
  conversationKey: conversationKeyFromMessages([{ role: 'user', content: title }]),
  title
});
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'duyệt');

const plan = store.getExecutionPlan(job.job_id);
assert.equal(plan.workflow_id, 'engineering');
assert.equal(plan.workflow_version, 2);
assert.deepEqual(plan.children.map(task => task.role), ['product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer']);
assert.deepEqual(plan.children.map(task => task.dependencies), [
  [],
  [EngineeringTaskId.PRODUCT_OWNER],
  [EngineeringTaskId.PRODUCT_OWNER, EngineeringTaskId.RESEARCHER],
  [EngineeringTaskId.ARCHITECT],
  [EngineeringTaskId.ENGINEER],
  [EngineeringTaskId.ENGINEER],
  [EngineeringTaskId.ENGINEER],
  [EngineeringTaskId.ENGINEER],
  [EngineeringTaskId.SECURITY, EngineeringTaskId.QA, EngineeringTaskId.PLATFORM, EngineeringTaskId.WRITER]
]);
assert.deepEqual(plan.children.map(task => task.capability), [
  TaskCapability.PRODUCT_REQUIREMENTS,
  TaskCapability.RESEARCH_COLLECT,
  TaskCapability.ARCHITECTURE_DESIGN,
  TaskCapability.CODE_MODIFY,
  TaskCapability.SECURITY_AUDIT,
  TaskCapability.CODE_VERIFY,
  TaskCapability.INFRASTRUCTURE_VERIFY,
  TaskCapability.DOCUMENTATION_WRITE,
  TaskCapability.CHANGE_REVIEW
]);
assert.equal(plan.synthesis.capability, TaskCapability.SYNTHESIS_APPROVE);
assert.match(plan.plan_hash, /^[a-f0-9]{64}$/);

const cto = store.dispatch(job.job_id, { role: 'cto', description: title });
const engineerPlan = plan.children.find(item => item.role === 'engineer');
const engineer = store.createChildTask(job.job_id, {
  parentTaskId: cto.task_id,
  role: engineerPlan.role,
  description: 'M4 Engineer execution',
  metadata: engineerPlan.execution
});
assert.equal(engineerPlan.execution.executor, 'ChatOnSteroidsHost');
assert.equal(engineerPlan.execution.deterministic, false);
const started = store.beginLocalTask(engineer.task_id);
assert.equal(started.task.status, 'running');
const localResult = store.completeLocalTask(engineer.task_id, {
  content: 'Host conversation completed the engineer role contract for the M4 fixture.',
  outcome: 'success',
  artifact: {
    summary: 'Completed the host-owned engineer task contract.',
    files_changed: [],
    verification: ['Role output persisted with typed implementation evidence.'],
    execution: {
      mode: 'chat-on-steroids-local-tools',
      exit_code: null,
      session_id: null,
      evidence_refs: ['test:workflow-m4:host-conversation']
    }
  }
});
assert.ok(localResult.resultId);
assert.equal(store.getTask(engineer.task_id).status, 'completed');
const implementationArtifact = store.getLatestArtifact(job.job_id, 'implementation');
assert.equal(implementationArtifact.producer_role, 'engineer');
assert.equal(implementationArtifact.content.execution.mode, 'chat-on-steroids-local-tools');
assert.equal(implementationArtifact.content.execution.exit_code, null);
assert.ok(implementationArtifact.evidence.includes(localResult.resultId));

const again = store.compileExecutionPlan(job.job_id, { workspace });
assert.equal(again.plan_hash, plan.plan_hash);
const otherWorkspace = path.join(tempRoot, 'other-workspace');
assert.throws(() => store.compileExecutionPlan(job.job_id, { workspace: otherWorkspace }), /immutable execution plan mismatch/);

const bad = JSON.parse(JSON.stringify(plan));
bad.children[2].dependencies = ['missing-task'];
assert.throws(() => validateExecutionPlan(bad), /dependency not found/);

const cyclic = JSON.parse(JSON.stringify(plan));
const cycleA = cyclic.children[0];
const cycleB = cyclic.children[1];
cycleA.dependencies = [cycleB.id];
cycleB.dependencies = [cycleA.id];
assert.throws(() => validateExecutionPlan(cyclic), /dependency cycle/,
  'well-referenced dependency cycles must be rejected before scheduling or recovery');

const duplicateDependency = JSON.parse(JSON.stringify(plan));
duplicateDependency.children[0].dependencies = [duplicateDependency.children[1].id, duplicateDependency.children[1].id];
assert.throws(() => validateExecutionPlan(duplicateDependency), /duplicate execution plan dependency/,
  'duplicate dependency edges must not produce ambiguous readiness counts');

const protoKeyDocument = JSON.parse('{"__proto__":{"authority":"untrusted"},"workflow_id":"proto-key-test"}');
assert.equal(canonicalJson(protoKeyDocument), '{"__proto__":{"authority":"untrusted"},"workflow_id":"proto-key-test"}',
  'canonical JSON must preserve own __proto__ keys instead of silently dropping hash-bound content');
assert.notEqual(canonicalJson(protoKeyDocument), canonicalJson({ workflow_id: 'proto-key-test' }),
  'distinct documents containing a __proto__ member must not collapse to the same canonical bytes');

const incomplete = verifyWorkflowCompletion({ plan, tasks: [], results: [], reports: [], projection: { pendingEvents: 0 } });
assert.equal(incomplete.valid, false);
assert.ok(incomplete.errors.some(error => error.includes('required task missing')));
assert.ok(!incomplete.errors.some(error => error.includes('UNPROJECTED')));

const completedTasks = [
  ...plan.children.map(spec => ({ task_id: `t-${spec.role}`, role: spec.role, status: 'completed', parent_task_id: 't-cto', metadata_json: JSON.stringify({ workflow_plan_task_id: spec.id }) })),
  { task_id: 't-cto', role: 'cto', status: 'completed', parent_task_id: null, metadata_json: JSON.stringify({ workflow_plan_task_id: EngineeringTaskId.CTO_SYNTHESIS }) }
];
const completedArchitectFixture = completedTasks.find(task => task.role === 'architect');
const completedResults = completedTasks.map(task => ({
  task_id: task.task_id,
  outcome: 'success',
  content: task.role === 'reviewer'
    ? JSON.stringify({ review: { requirementsSatisfied: true, architectureConformant: true, implementationIssues: [], evidenceIssues: [], blockingIssues: [] } })
    : `verified ${task.role}`
}));
const verified = verifyWorkflowCompletion({
  plan,
  tasks: completedTasks,
  results: completedResults,
  reports: [{ kind: 'executive_summary', content: 'verified report' }],
  projection: { pendingEvents: 0 }
});
assert.equal(verified.valid, true, verified.errors.join('; '));

// The durable trace carries SQLite rowid because multiple results can share a
// millisecond timestamp. Verification must select the latest result by durable
// ordering, not whichever row a caller happens to place last in its array.
const orderedResults = completedResults.map((result, index) => ({
  ...result, created_at: '2026-10-16T10:00:00.000Z', durable_rowid: index + 10
}));
const historicalReviewer = {
  ...orderedResults.find(result => result.task_id === 't-reviewer'),
  content: JSON.stringify({ review: { requirementsSatisfied: true, architectureConformant: true,
    implementationIssues: [], evidenceIssues: [], blockingIssues: [] } }), durable_rowid: 100
};
const latestMalformedReviewer = {
  ...historicalReviewer, content: '{not a review}', durable_rowid: 101
};
const reverseOrderedResults = [...orderedResults.filter(result => result.task_id !== 't-reviewer'),
  latestMalformedReviewer, historicalReviewer];
const latestReviewerWins = verifyWorkflowCompletion({
  plan, tasks: completedTasks, results: reverseOrderedResults,
  reports: [{ kind: 'executive_summary', content: 'durable result ordering test' }], projection: { pendingEvents: 0 }
});
assert.equal(latestReviewerWins.valid, false,
  'a historical valid reviewer result must not override a newer malformed result when input rows are reversed');
assert.ok(latestReviewerWins.errors.some(error => error.includes('review artifact is not valid JSON')));

const ambiguousDuplicateResults = [...completedResults,
  { ...completedResults[0], content: 'same timestamp without durable row identity', created_at: '2026-10-16T10:00:00.000Z' },
  { ...completedResults[0], content: 'same timestamp without durable row identity (conflict)', created_at: '2026-10-16T10:00:00.000Z' }
];
const ambiguousOrdering = verifyWorkflowCompletion({
  plan, tasks: completedTasks, results: ambiguousDuplicateResults,
  reports: [{ kind: 'executive_summary', content: 'ambiguous result ordering test' }], projection: { pendingEvents: 0 }
});
assert.equal(ambiguousOrdering.valid, false,
  'duplicate results without stable durable ordering must fail closed instead of depending on caller array order');
assert.ok(ambiguousOrdering.errors.some(error => error.includes('durable result ordering is ambiguous')));

const duplicatedDurableRowid = verifyWorkflowCompletion({
  plan, tasks: completedTasks,
  results: [...orderedResults.filter(result => result.task_id !== 't-reviewer'),
    { ...historicalReviewer, durable_rowid: 100 },
    { ...historicalReviewer, content: '{"review":{"requirementsSatisfied":true,"architectureConformant":true,"implementationIssues":[],"evidenceIssues":[],"blockingIssues":[]}}', durable_rowid: 100 }],
  reports: [{ kind: 'executive_summary', content: 'duplicate row identity test' }], projection: { pendingEvents: 0 }
});
assert.equal(duplicatedDurableRowid.valid, false,
  'duplicate durable row identities must not make equal-timestamp result ordering depend on input order');
assert.ok(duplicatedDurableRowid.errors.some(error => error.includes('durable result row identity is duplicated')));

const multipleSuccessfulResults = verifyWorkflowCompletion({
  plan, tasks: completedTasks,
  results: [...orderedResults, { ...orderedResults.find(result => result.task_id === 't-reviewer'),
    content: JSON.stringify({ review: { requirementsSatisfied: true, architectureConformant: true,
      implementationIssues: [], evidenceIssues: [], blockingIssues: [] } }), durable_rowid: 200 }],
  reports: [{ kind: 'executive_summary', content: 'duplicate success evidence test' }], projection: { pendingEvents: 0 }
});
assert.equal(multipleSuccessfulResults.valid, false,
  'multiple durable successful results for one task must not be hidden by choosing the latest one');
assert.ok(multipleSuccessfulResults.errors.some(error => error.includes('multiple successful durable results: reviewer')));

const malformedTraceProjection = verifyWorkflowCompletion({
  plan, tasks: completedTasks, results: completedResults, reports: [{ kind: 'executive_summary', content: 'projection type test' }],
  projection: { pendingEvents: '0' }
});
assert.equal(malformedTraceProjection.valid, false,
  'a string-valued projection counter must not coerce to a successful numeric zero');
assert.ok(malformedTraceProjection.errors.some(error => error.includes('UNPROJECTED=0')));

const malformedResultCollection = verifyWorkflowCompletion({
  plan, tasks: completedTasks, results: { task_id: 't-reviewer', outcome: 'success' },
  reports: [{ kind: 'executive_summary', content: 'malformed result collection test' }], projection: { pendingEvents: 0 }
});
assert.equal(malformedResultCollection.valid, false,
  'malformed trace collections must return an invalid verification result instead of throwing or passing');
assert.ok(malformedResultCollection.errors.some(error => error.includes('results must be a durable row array')));

// Standard-engineering rework creates a new durable task for the same immutable
// plan slot. The verifier must deterministically select the latest revision,
// and must not fall back to an older completed task when the latest revision
// has failed or is still incomplete.
const firstRevisionAt = '2026-10-15T10:00:00.000Z';
const secondRevisionAt = '2026-10-16T10:00:00.000Z';
const latestArchitectTask = { ...completedArchitectFixture, created_at: secondRevisionAt };
const historicalArchitectTask = {
  ...completedArchitectFixture, task_id: 't-architect-revision-1', created_at: firstRevisionAt,
  status: 'completed'
};
const reworkTasks = [historicalArchitectTask, latestArchitectTask,
  ...completedTasks.filter(task => task.task_id !== completedArchitectFixture.task_id).map(task => ({ ...task, created_at: secondRevisionAt }))];
const reworkResults = [
  { task_id: historicalArchitectTask.task_id, outcome: 'success', content: 'superseded architect revision' },
  ...completedResults
];
const reworkVerified = verifyWorkflowCompletion({
  plan, tasks: reworkTasks, results: reworkResults,
  reports: [{ kind: 'executive_summary', content: 'verified rework report' }], projection: { pendingEvents: 0 }
});
assert.equal(reworkVerified.valid, true, reworkVerified.errors.join('; '));
const failedLatestRework = verifyWorkflowCompletion({
  plan,
  tasks: reworkTasks.map(task => task.task_id === latestArchitectTask.task_id ? { ...task, status: 'failed' } : task),
  results: reworkResults,
  reports: [{ kind: 'executive_summary', content: 'failed latest rework must not use stale success' }],
  projection: { pendingEvents: 0 }
});
assert.equal(failedLatestRework.valid, false,
  'failed latest rework must not silently fall back to an older completed result for the same plan slot');

const sameTimestampReworkTasks = [
  { ...historicalArchitectTask, created_at: secondRevisionAt, durable_rowid: 50 },
  { ...latestArchitectTask, status: 'failed', created_at: secondRevisionAt, durable_rowid: 51 },
  ...completedTasks.filter(task => task.task_id !== completedArchitectFixture.task_id).map((task, index) => ({ ...task, created_at: secondRevisionAt, durable_rowid: index + 60 }))
].reverse();
const sameTimestampReworkResults = [
  ...reworkResults.map((result, index) => ({ ...result, created_at: secondRevisionAt, durable_rowid: index + 70 }))
];
const sameTimestampLatestRework = verifyWorkflowCompletion({
  plan, tasks: sameTimestampReworkTasks, results: sameTimestampReworkResults,
  reports: [{ kind: 'executive_summary', content: 'same-timestamp rework ordering test' }], projection: { pendingEvents: 0 }
});
assert.equal(sameTimestampLatestRework.valid, false,
  'same-timestamp task revisions must use durable rowid rather than caller array order');
assert.ok(sameTimestampLatestRework.errors.some(error => error.includes('required task not completed: architect')));

// JavaScript Number(null) === 0. A success verifier must require a literal,
// durable numeric zero instead of allowing NULL or string-valued exit codes to
// become successful evidence through coercion.
const deterministicNullExitPlan = JSON.parse(JSON.stringify(plan));
const deterministicSpec = deterministicNullExitPlan.children[0];
deterministicSpec.execution = {
  ...(deterministicSpec.execution || {}),
  executor: 'ExecutionManager', deterministic: true,
  executable: 'node', args: ['--check', 'fixture.js'], command: 'node --check fixture.js',
  cwd: workspace, timeout_ms: 5000
};
const deterministicNullExitTasks = completedTasks.map(task => ({ ...task }));
deterministicNullExitTasks[0] = {
  ...deterministicNullExitTasks[0],
  execution_session_id: 'exec-null-exit', execution_status: 'completed', execution_exit_code: null,
  metadata_json: JSON.stringify({ workflow_plan_task_id: deterministicSpec.id, executor: 'ExecutionManager',
    deterministic: true, executable: 'node', args: ['--check', 'fixture.js'], command: 'node --check fixture.js', cwd: workspace })
};
const deterministicNullExitResults = completedResults.map(item => ({ ...item }));
deterministicNullExitResults[0].content = '[ACTUAL EXECUTION EVIDENCE]\nexit status/code: N/A';
const unsignedDeterministicPlan = Object.fromEntries(Object.entries(deterministicNullExitPlan)
  .filter(([key]) => !['plan_hash', 'compiled_at', 'approved_at'].includes(key)));
deterministicNullExitPlan.plan_hash = crypto.createHash('sha256').update(canonicalJson(unsignedDeterministicPlan)).digest('hex');
const nullExitVerification = verifyWorkflowCompletion({
  plan: deterministicNullExitPlan, tasks: deterministicNullExitTasks, results: deterministicNullExitResults,
  reports: [{ kind: 'executive_summary', content: 'verified report' }], projection: { pendingEvents: 0 }
});
assert.equal(nullExitVerification.valid, false,
  'workflow verification must reject a completed deterministic task whose durable execution exit code is NULL');
assert.ok(nullExitVerification.errors.some(error => error.includes('ExecutionManager evidence invalid')));
const stringExitVerification = verifyWorkflowCompletion({
  plan: deterministicNullExitPlan,
  tasks: deterministicNullExitTasks.map((task, index) => index === 0 ? { ...task, execution_exit_code: '0' } : task),
  results: deterministicNullExitResults,
  reports: [{ kind: 'executive_summary', content: 'verified report' }], projection: { pendingEvents: 0 }
});
assert.equal(stringExitVerification.valid, false,
  'workflow verification must reject numeric-string durable execution exit codes');
const downgradedMetadataVerification = verifyWorkflowCompletion({
  plan: deterministicNullExitPlan,
  tasks: deterministicNullExitTasks.map((task, index) => index === 0 ? {
    ...task,
    metadata_json: JSON.stringify({
      workflow_plan_task_id: deterministicSpec.id,
      executor: 'ChatOnSteroidsHost', deterministic: false,
      executable: 'node', args: ['--check', 'fixture.js'], command: 'node --check fixture.js', cwd: workspace
    })
  } : task),
  results: deterministicNullExitResults,
  reports: [{ kind: 'executive_summary', content: 'verified report' }], projection: { pendingEvents: 0 }
});
assert.equal(downgradedMetadataVerification.valid, false,
  'task metadata may not downgrade an immutable ExecutionManager plan to bypass execution evidence verification');
assert.ok(downgradedMetadataVerification.errors.some(error => error.includes('metadata executor differs from immutable execution plan')));

for (const exitCode of [null, '0', 0]) {
  const evidenceTaskId = 'task-evidence-type';
  const evidenceSessionId = 'exec-evidence-type';
  const evidenceCommand = 'node --check fixture.js';
  const evidenceResult = validateEvidenceContract({
    task_id: evidenceTaskId, status: 'completed', execution_exit_code: exitCode, execution_status: 'completed',
    execution_session_id: evidenceSessionId, execution_attempt: 1,
    execution_stdout: '', execution_stderr: '',
    metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: evidenceCommand })
  }, {
    outcome: 'success', content: canonicalExecutionEvidenceContent({
      taskId: evidenceTaskId, executionSessionId: evidenceSessionId, attempt: 1,
      command: evidenceCommand, exitCode, status: 'completed', stdout: '', stderr: ''
    })
  });
  assert.equal(evidenceResult.valid, exitCode === 0,
    `execution evidence must accept only exact numeric zero, not ${String(exitCode)}`);
}
const incompleteBoundEvidence = validateEvidenceContract({
  task_id: 'task-unbound-evidence', status: 'completed', execution_exit_code: 0, execution_status: 'completed',
  execution_session_id: 'exec-real-session', execution_attempt: 1,
  execution_stdout: '', execution_stderr: '',
  metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check expected.js' })
}, {
  outcome: 'success', content: canonicalExecutionEvidenceContent({
    taskId: 'task-unbound-evidence', executionSessionId: 'attacker-session', attempt: 1,
    command: 'node --check substituted.js', exitCode: 0, status: 'completed', stdout: '', stderr: ''
  })
});
assert.equal(incompleteBoundEvidence.valid, false,
  'LangGraph evidence validation must reject success-shaped output whose session and command do not bind to durable task identity');
assert.ok(incompleteBoundEvidence.errors.some(error => error.includes('does not bind exact execution_session_id')));
assert.ok(incompleteBoundEvidence.errors.some(error => error.includes('command does not match the immutable expected command')));
const metadataAndResultSubstitution = validateEvidenceContract({
  task_id: 'task-plan-bound', status: 'completed', execution_exit_code: 0, execution_status: 'completed',
  execution_session_id: 'exec-plan-bound', execution_attempt: 1,
  execution_stdout: '', execution_stderr: '',
  metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check substituted.js' })
}, {
  outcome: 'success', content: canonicalExecutionEvidenceContent({
    taskId: 'task-plan-bound', executionSessionId: 'exec-plan-bound', attempt: 1,
    command: 'node --check substituted.js', exitCode: 0, status: 'completed', stdout: '', stderr: ''
  })
}, { executor: 'ExecutionManager', command: 'node --check immutable-plan.js' });
assert.equal(metadataAndResultSubstitution.valid, false,
  'matching task metadata and result bytes still cannot replace the immutable approved command');
assert.ok(metadataAndResultSubstitution.errors.some(error => error.includes('does not match the immutable execution plan')));
const stdoutSubstitution = validateEvidenceContract({
  task_id: 'task-output-bound', status: 'completed', execution_exit_code: 0, execution_status: 'completed',
  execution_session_id: 'exec-output-bound', execution_attempt: 1,
  execution_stdout: 'actual stdout bytes', execution_stderr: 'actual stderr bytes',
  metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check output.js' })
}, {
  outcome: 'success', content: canonicalExecutionEvidenceContent({
    taskId: 'task-output-bound', executionSessionId: 'exec-output-bound', attempt: 1,
    command: 'node --check output.js', exitCode: 0, status: 'completed',
    stdout: 'substituted stdout bytes', stderr: 'actual stderr bytes'
  })
}, { executor: 'ExecutionManager', command: 'node --check output.js' });
assert.equal(stdoutSubstitution.valid, false,
  'a successful-looking result cannot replace the actual durable stdout/stderr bytes while retaining matching task/session/command markers');
assert.ok(stdoutSubstitution.errors.some(error => error.includes('result bytes do not match canonical')));
for (const missingIdentity of [
  { execution_session_id: null, execution_attempt: 1 },
  { execution_session_id: 'exec-present', execution_attempt: null },
  { execution_session_id: 'exec-present', execution_attempt: '1' }
]) {
  const invalidIdentity = validateEvidenceContract({
    task_id: 'task-bad-identity', status: 'completed', execution_exit_code: 0, execution_status: 'completed',
    execution_stdout: '', execution_stderr: '', ...missingIdentity,
    metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check identity.js' })
  }, {
    outcome: 'success', content: canonicalExecutionEvidenceContent({
      taskId: 'task-bad-identity', executionSessionId: missingIdentity.execution_session_id,
      attempt: missingIdentity.execution_attempt, command: 'node --check identity.js',
      exitCode: 0, status: 'completed', stdout: '', stderr: ''
    })
  });
  assert.equal(invalidIdentity.valid, false, 'missing or malformed durable session/attempt identity must block workflow synthesis');
}
const failedTaskWithSuccessShapedExecution = validateEvidenceContract({
  task_id: 'task-failed-status', status: 'failed', execution_exit_code: 0, execution_status: 'completed',
  execution_session_id: 'exec-failed-status', execution_attempt: 1,
  execution_stdout: '', execution_stderr: '',
  metadata_json: JSON.stringify({ executor: 'ExecutionManager', command: 'node --check failed.js' })
}, {
  outcome: 'success', content: canonicalExecutionEvidenceContent({
    taskId: 'task-failed-status', executionSessionId: 'exec-failed-status', attempt: 1,
    command: 'node --check failed.js', exitCode: 0, status: 'completed', stdout: '', stderr: ''
  })
});
assert.equal(failedTaskWithSuccessShapedExecution.valid, false,
  'a failed durable task cannot be promoted to successful by a success-shaped process-result ledger');
assert.ok(failedTaskWithSuccessShapedExecution.errors.includes('durable task status must be completed'));

const nullExitRuntimeJob = store.createJob({
  conversationKey: `m4-null-exit-runtime-${process.pid}`,
  title: 'Engineering M4 null exit runtime fixture'
});
store.transition(nullExitRuntimeJob.job_id, 'PROPOSED');
store.approve(nullExitRuntimeJob.job_id, 'test-only approval');
const nullExitRuntimeCto = store.dispatch(nullExitRuntimeJob.job_id, { role: 'cto', description: 'null exit-code runtime fixture' });
const nullExitRuntimeTask = store.recordSpawn(nullExitRuntimeJob.job_id, {
  parentTaskId: nullExitRuntimeCto.task_id,
  role: 'architect',
  description: 'deterministic execution fixture with missing durable exit status',
  dependencies: plan.children.find(item => item.id === EngineeringTaskId.ARCHITECT).dependencies,
  runId: `m4-null-exit-run-${process.pid}`,
  sessionKey: `agent:architect:subagent:m4-null-exit-${process.pid}`,
  metadata: {
    workflow_plan_task_id: EngineeringTaskId.ARCHITECT,
    executor: 'ExecutionManager', deterministic: true,
    command: 'node --check fixture.js', executable: 'node', args: ['--check', 'fixture.js'], cwd: workspace
  }
});
store.db.prepare("UPDATE tasks SET execution_session_id=?, execution_status='completed', execution_exit_code=NULL WHERE task_id=?")
  .run(`exec-null-exit-runtime-${process.pid}`, nullExitRuntimeTask.task_id);
assert.throws(() => store.completeTaskByRuntime(nullExitRuntimeJob.job_id, {
  runId: nullExitRuntimeTask.openclaw_run_id,
  sessionKey: nullExitRuntimeTask.openclaw_session_key,
  content: '[ACTUAL EXECUTION EVIDENCE]\nexact command: node --check fixture.js\nexit status/code: N/A',
  outcome: 'success'
}), /metadata executor differs from immutable plan for role=architect/,
'runtime completion must not accept a success-shaped execution record that downgrades the immutable host-workflow policy');
assert.equal(store.getTask(nullExitRuntimeTask.task_id).status, 'running',
  'rejected metadata policy substitution must leave the durable task and active attempt unchanged');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task_id=?').get(nullExitRuntimeTask.task_id).n, 0,
  'rejected metadata policy substitution must not append any success/failure result row');

const reviewerWrapperDuplicate = verifyWorkflowCompletion({
  plan,
  tasks: completedTasks,
  results: [
    ...completedResults.map((result, index) => ({
      ...result, created_at: '2026-10-16T10:00:00.000Z', durable_rowid: index + 10
    })),
    {
      task_id: 't-reviewer',
      outcome: 'success',
      content: 'OpenClaw internal completion wrapper around a prior valid reviewer artifact.',
      created_at: '2026-10-16T10:00:00.000Z', durable_rowid: 100
    }
  ],
  reports: [{ kind: 'executive_summary', content: 'verified report' }],
  projection: { pendingEvents: 0 }
});
assert.equal(reviewerWrapperDuplicate.valid, false,
  'a stale valid reviewer artifact must not rescue a newer malformed completion wrapper');
assert.ok(reviewerWrapperDuplicate.errors.some(error => error.includes('review artifact is not valid JSON')),
  'the verifier must validate the latest reviewer result bytes, not historical reviewer output');

const reviewerContentBlock = JSON.stringify([{ type: 'text', text: JSON.stringify({
  review: { requirementsSatisfied: true, architectureConformant: true, implementationIssues: [], evidenceIssues: [], blockingIssues: [] }
}) }]);
const reviewerStore = new WorkflowStore();
const reviewerJob = reviewerStore.createJob({ conversationKey: 'm4-reviewer-content-block', title: 'Engineering M4 reviewer content block' });
reviewerStore.transition(reviewerJob.job_id, 'PROPOSED');
reviewerStore.approve(reviewerJob.job_id, 'duyệt');
const reviewerCto = reviewerStore.dispatch(reviewerJob.job_id, { role: 'cto', description: 'M4 reviewer content block' });
const reviewerTask = reviewerStore.createChildTask(reviewerJob.job_id, {
  parentTaskId: reviewerCto.task_id,
  role: 'reviewer',
  description: 'M4 reviewer content block',
  dependencies: plan.children.find(item => item.id === EngineeringTaskId.REVIEWER).dependencies,
  metadata: { workflow_plan_task_id: EngineeringTaskId.REVIEWER }
});
reviewerStore.attachTaskRuntime(reviewerTask.task_id, { runId: 'reviewer-content-block-run', sessionKey: 'agent:reviewer:content-block' });
reviewerStore.completeTaskByRuntime(reviewerJob.job_id, {
  runId: 'reviewer-content-block-run',
  content: reviewerContentBlock,
  outcome: 'success'
});
const reviewerStored = reviewerStore.db.prepare('SELECT content FROM results WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(reviewerTask.task_id);
assert.deepEqual(JSON.parse(reviewerStored.content), JSON.parse(JSON.stringify({
  review: { requirementsSatisfied: true, architectureConformant: true, implementationIssues: [], evidenceIssues: [], blockingIssues: [] }
})));

const reviewerEnvelope = JSON.stringify([{ type: 'text', text: `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]\nsource: subagent\n\nIf those gates pass, output this exact one-line JSON literal and nothing else: {\\"review\\":{\\"requirementsSatisfied\\":true,\\"architectureConformant\\":true,\\"implementationIssues\\":[],\\"evidenceIssues\\":[],\\"blockingIssues\\":[]}}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>` }]);
const reviewerEnvelopeStore = new WorkflowStore();
const reviewerEnvelopeJob = reviewerEnvelopeStore.createJob({ conversationKey: 'm4-reviewer-envelope', title: 'Engineering M4 reviewer internal envelope' });
reviewerEnvelopeStore.transition(reviewerEnvelopeJob.job_id, 'PROPOSED');
reviewerEnvelopeStore.approve(reviewerEnvelopeJob.job_id, 'duyệt');
const reviewerEnvelopeCto = reviewerEnvelopeStore.dispatch(reviewerEnvelopeJob.job_id, { role: 'cto', description: 'M4 reviewer internal envelope' });
const reviewerEnvelopeTask = reviewerEnvelopeStore.createChildTask(reviewerEnvelopeJob.job_id, {
  parentTaskId: reviewerEnvelopeCto.task_id,
  role: 'reviewer',
  description: 'M4 reviewer internal envelope',
  dependencies: plan.children.find(item => item.id === EngineeringTaskId.REVIEWER).dependencies,
  metadata: { workflow_plan_task_id: EngineeringTaskId.REVIEWER }
});
reviewerEnvelopeStore.attachTaskRuntime(reviewerEnvelopeTask.task_id, { runId: 'reviewer-envelope-run', sessionKey: 'agent:reviewer:envelope' });
reviewerEnvelopeStore.completeTaskByRuntime(reviewerEnvelopeJob.job_id, {
  runId: 'reviewer-envelope-run',
  content: reviewerEnvelope,
  outcome: 'success'
});
const reviewerEnvelopeStored = reviewerEnvelopeStore.db.prepare('SELECT content FROM results WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(reviewerEnvelopeTask.task_id);
assert.deepEqual(JSON.parse(reviewerEnvelopeStored.content), JSON.parse(JSON.stringify({
  review: { requirementsSatisfied: true, architectureConformant: true, implementationIssues: [], evidenceIssues: [], blockingIssues: [] }
})));

const missingReport = verifyWorkflowCompletion({
  plan,
  tasks: completedTasks,
  results: completedResults,
  reports: [],
  projection: { pendingEvents: 0 }
});
assert.ok(missingReport.errors.includes('durable executive report missing'));

const clean = verifyWorkflowCompletion({ plan, tasks: [], results: [], reports: [], projection: { pendingEvents: 1 } });
assert.ok(clean.errors.includes('UNPROJECTED=1'));

const ctoTask = { task_id: 'cto', role: 'cto', status: 'running' };
const productOwnerTask = { task_id: 'product-owner', role: 'product-owner', status: 'completed', parent_task_id: 'cto', metadata_json: JSON.stringify({ workflow_plan_task_id: EngineeringTaskId.PRODUCT_OWNER }) };
const researcherTask = { task_id: 'researcher', role: 'researcher', status: 'completed', parent_task_id: 'cto', metadata_json: JSON.stringify({ workflow_plan_task_id: EngineeringTaskId.RESEARCHER }) };
const architectTask = { task_id: 'architect', role: 'architect', status: 'running', parent_task_id: 'cto', metadata_json: JSON.stringify({ workflow_plan_task_id: EngineeringTaskId.ARCHITECT, executor: 'OpenClaw' }) };
const engineerTask = { task_id: 'engineer', role: 'engineer', status: 'pending', parent_task_id: 'cto', metadata_json: JSON.stringify(plan.children.find(t => t.role === 'engineer').execution) };
const baseJob = { job_id: job.job_id, active_task_id: 'cto', title };
const assignWaiting = await evaluateLangGraph({ job: baseJob, tasks: [ctoTask, productOwnerTask, researcherTask, architectTask], results: [], plan, runtime: { phase: 'ASSIGN_CHILDREN' } });
assert.equal(assignWaiting.action, LangGraphActions.WAIT);
architectTask.status = 'completed';
const assignEngineer = await evaluateLangGraph({ job: baseJob, tasks: [ctoTask, productOwnerTask, researcherTask, architectTask], results: [], plan, runtime: { phase: 'ASSIGN_CHILDREN' } });
assert.equal(assignEngineer.action, LangGraphActions.ASSIGN_CHILDREN);
const runEngineer = await evaluateLangGraph({ job: baseJob, tasks: [ctoTask, productOwnerTask, researcherTask, architectTask, engineerTask], results: [], plan, runtime: { phase: 'ASSIGN_CHILDREN' } });
assert.equal(runEngineer.action, LangGraphActions.ASSIGN_CHILDREN);
assert.match(runEngineer.reason, /ready child assignments: engineer/);

await new Promise(resolve => setImmediate(resolve));
console.log('test-workflow-m4: PASS');
