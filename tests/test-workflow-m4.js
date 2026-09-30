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
const { validateExecutionPlan } = await import('../src/runtime/workflow/plan.js');
const { verifyWorkflowCompletion } = await import('../src/runtime/workflow/verifier.js');
const { evaluateLangGraph, LangGraphActions } = await import('../src/runtime/langgraph-orchestrator.js');
const { ExecutionManager } = await import('../src/runtime/execution-manager.js');

assert.equal(isEngineeringWorkflow({ title: 'Engineering M4 acceptance' }), true);
assert.equal(validateEngineeringWorkflow(), true);
assert.equal(EngineeringWorkflow.id, 'engineering');
assert.equal(EngineeringWorkflow.version, 1);
assert.deepEqual(EngineeringWorkflow.requiredChildren, [
  EngineeringTaskId.ARCHITECT,
  EngineeringTaskId.ENGINEER,
  EngineeringTaskId.QA,
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
assert.throws(() => store.approve(atomicJob.job_id, 'duyệt'), /invalid deterministic execution metadata/);
assert.equal(store.getJob(atomicJob.job_id).state, 'PROPOSED');
assert.equal(store.getExecutionPlan(atomicJob.job_id), null);
assert.equal(store.getJobTrace(atomicJob.job_id).approvals.length, 0);
process.env.WORKFLOW_WORKSPACE = workspaceBeforeApproval;

const job = store.getOrCreateJob({
  conversationKey: conversationKeyFromMessages([{ role: 'user', content: title }]),
  title
});
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'duyệt');

const plan = store.getExecutionPlan(job.job_id);
assert.equal(plan.workflow_id, 'engineering');
assert.equal(plan.workflow_version, 1);
assert.deepEqual(plan.children.map(task => task.role), ['architect', 'engineer', 'qa', 'reviewer']);
assert.deepEqual(plan.children.map(task => task.dependencies), [
  [],
  [EngineeringTaskId.ARCHITECT],
  [EngineeringTaskId.ENGINEER],
  [EngineeringTaskId.QA]
]);
assert.deepEqual(plan.children.map(task => task.capability), [
  TaskCapability.ARCHITECTURE_DESIGN,
  TaskCapability.CODE_MODIFY,
  TaskCapability.CODE_VERIFY,
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
const executionManager = new ExecutionManager(store);
const executionResult = await executionManager.executeAuthorizedTask(engineer.task_id);
assert.equal(executionResult.exitCode, 0, JSON.stringify(executionResult));
assert.equal(store.getTask(engineer.task_id).execution_status, 'completed');
assert.equal(store.getTask(engineer.task_id).execution_exit_code, 0);
assert.equal(fs.existsSync(path.join(process.env.WORKFLOW_WORKSPACE, '.m4-engineer-proof.js')), true);
const implementationArtifact = store.getLatestArtifact(job.job_id, 'implementation');
assert.equal(implementationArtifact.producer_role, 'engineer');
assert.equal(implementationArtifact.content.execution.exit_code, 0);
assert.ok(implementationArtifact.evidence.includes(implementationArtifact.content.execution.session_id));

const again = store.compileExecutionPlan(job.job_id, { workspace });
assert.equal(again.plan_hash, plan.plan_hash);
const otherWorkspace = path.join(tempRoot, 'other-workspace');
assert.throws(() => store.compileExecutionPlan(job.job_id, { workspace: otherWorkspace }), /immutable execution plan mismatch/);

const bad = JSON.parse(JSON.stringify(plan));
bad.children[2].dependencies = ['missing-task'];
assert.throws(() => validateExecutionPlan(bad), /dependency not found/);

const incomplete = verifyWorkflowCompletion({ plan, tasks: [], results: [], reports: [], projection: { pendingEvents: 0 } });
assert.equal(incomplete.valid, false);
assert.ok(incomplete.errors.some(error => error.includes('required task missing')));
assert.ok(!incomplete.errors.some(error => error.includes('UNPROJECTED')));

const completedTasks = [
  { task_id: 't-architect', role: 'architect', status: 'completed', parent_task_id: 't-cto', metadata_json: JSON.stringify({ workflow_plan_task_id: EngineeringTaskId.ARCHITECT }) },
  { task_id: 't-engineer', role: 'engineer', status: 'completed', parent_task_id: 't-cto', metadata_json: JSON.stringify({ workflow_plan_task_id: EngineeringTaskId.ENGINEER }) },
  { task_id: 't-qa', role: 'qa', status: 'completed', parent_task_id: 't-cto', metadata_json: JSON.stringify({ workflow_plan_task_id: EngineeringTaskId.QA }) },
  { task_id: 't-reviewer', role: 'reviewer', status: 'completed', parent_task_id: 't-cto', metadata_json: JSON.stringify({ workflow_plan_task_id: EngineeringTaskId.REVIEWER }) },
  { task_id: 't-cto', role: 'cto', status: 'completed', parent_task_id: null, metadata_json: JSON.stringify({ workflow_plan_task_id: EngineeringTaskId.CTO_SYNTHESIS }) }
];
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

const reviewerWrapperDuplicate = verifyWorkflowCompletion({
  plan,
  tasks: completedTasks,
  results: [
    ...completedResults,
    {
      task_id: 't-reviewer',
      outcome: 'success',
      content: 'OpenClaw internal completion wrapper around a prior valid reviewer artifact.'
    }
  ],
  reports: [{ kind: 'executive_summary', content: 'verified report' }],
  projection: { pendingEvents: 0 }
});
assert.equal(reviewerWrapperDuplicate.valid, true, reviewerWrapperDuplicate.errors.join('; '));

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
const architectTask = { task_id: 'architect', role: 'architect', status: 'running', parent_task_id: 'cto', metadata_json: JSON.stringify({ executor: 'OpenClaw' }) };
const engineerTask = { task_id: 'engineer', role: 'engineer', status: 'pending', parent_task_id: 'cto', metadata_json: JSON.stringify(plan.children.find(t => t.role === 'engineer').execution) };
const baseJob = { job_id: job.job_id, active_task_id: 'cto', title };
const assignWaiting = await evaluateLangGraph({ job: baseJob, tasks: [ctoTask, architectTask], results: [], plan, runtime: { phase: 'ASSIGN_CHILDREN' } });
assert.equal(assignWaiting.action, LangGraphActions.WAIT);
architectTask.status = 'completed';
const assignEngineer = await evaluateLangGraph({ job: baseJob, tasks: [ctoTask, architectTask], results: [], plan, runtime: { phase: 'ASSIGN_CHILDREN' } });
assert.equal(assignEngineer.action, LangGraphActions.ASSIGN_CHILDREN);
const runEngineer = await evaluateLangGraph({ job: baseJob, tasks: [ctoTask, architectTask, engineerTask], results: [], plan, runtime: { phase: 'ASSIGN_CHILDREN' } });
assert.equal(runEngineer.action, LangGraphActions.RUN_CHILDREN);

await new Promise(resolve => setImmediate(resolve));
console.log('test-workflow-m4: PASS');
