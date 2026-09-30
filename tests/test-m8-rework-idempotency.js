import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('m8-rework-');
process.env.WORKFLOW_DB = path.join(root, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = root;
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { evaluateLangGraph, LangGraphActions } = await import('../src/runtime/langgraph-orchestrator.js');
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `m8-${process.pid}-${Date.now()}`, title: 'Software development M8 rework' });
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'Duyet');
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'M8 rework synthesis' });

const artifactContent = {
  requirements: { scope: 'scope', acceptance_criteria: [], non_goals: [] },
  research: { findings: [], sources: [], limitations: [] },
  architecture: { components: [], interfaces: [], failure_modes: [], implementation_boundary: 'src' },
  implementation: { summary: 'done', files_changed: [], verification: [], execution: { session_id: 'm8-exec', exit_code: 0 } },
  'security-review': { threats: [], findings: [], decision: 'accept' },
  'qa-report': { checks: [], results: [], decision: 'needs_changes' },
  'platform-review': { runtime: {}, deployment: {}, recovery: {} },
  documentation: { summary: 'docs', user_facing_changes: [], verification: [] }
};
for (const [role, type] of [['product-owner','requirements'], ['researcher','research'], ['architect','architecture'], ['engineer','implementation'], ['security','security-review'], ['qa','qa-report'], ['platform','platform-review'], ['writer','documentation']]) {
  const task = store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role, description: `initial ${role}` });
  store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(task.task_id);
  store.createArtifact({ artifact_id: `${type}-m8`, job_id: job.job_id, task_id: task.task_id, type, producer_role: role, content: artifactContent[type], evidence: [] });
}
const reviewer = store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role: 'reviewer', description: 'initial reviewer' });
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(reviewer.task_id);
store.createArtifact({
  artifact_id: 'review-m8', job_id: job.job_id, task_id: reviewer.task_id, type: 'review', producer_role: 'reviewer',
  content: { requirementsSatisfied: true, architectureConformant: true, securityAccepted: true, qaAccepted: false, platformAccepted: true, documentationAccepted: true, implementationIssues: [], evidenceIssues: [], securityIssues: [], blockingIssues: ['QA failure'], decision: 'needs_changes' }, evidence: []
});
store.createArtifact({
  artifact_id: 'cto-decision-m8', job_id: job.job_id, task_id: cto.task_id, type: 'cto-decision', producer_role: 'cto',
  content: { decision: 'rework', summary: 'QA must be rerun after implementation changes.', accepted_requirements: [], unresolved_risks: ['QA failure'], follow_up_actions: ['Engineer then QA'], evidence_refs: ['review-m8'] }, evidence: ['review-m8']
});

const prepared = store.prepareStandardEngineeringRework(job.job_id);
assert.equal(prepared.prepared, true);
assert.deepEqual(prepared.targetRoles.sort(), ['engineer', 'qa', 'reviewer']);
assert.equal(store.getArtifact('qa-report-m8').status, 'invalidated');
assert.equal(store.getArtifact('review-m8').status, 'invalidated');
assert.equal(store.getArtifact('cto-decision-m8').status, 'invalidated');
const newTasks = store.db.prepare("SELECT role,status FROM tasks WHERE job_id=? AND parent_task_id=? AND description LIKE 'Rework revision%' ORDER BY role").all(job.job_id, cto.task_id).map(row => ({ role: row.role, status: row.status }));
assert.deepEqual(newTasks, [
  { role: 'engineer', status: 'pending' },
  { role: 'qa', status: 'pending' },
  { role: 'reviewer', status: 'pending' }
]);
const again = store.prepareStandardEngineeringRework(job.job_id);
assert.equal(again.idempotent, true);
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE job_id=? AND type='workflow.rework.prepared'").get(job.job_id).count, 1);
const sameTask = store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role: 'engineer', description: `Rework revision for engineer after CTO decision cto-decision-m8.`, dependencies: ['standard-architect'] });
assert.equal(sameTask.status, 'pending');
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE job_id=? AND role='engineer' AND description LIKE 'Rework revision%'").get(job.job_id).count, 1);

store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(cto.task_id);
store.setWorkflowRuntimeState(job.job_id, 'SYNTHESIZE');
const plan = store.getExecutionPlan(job.job_id);
const classify = () => evaluateLangGraph({
  job: store.getJob(job.job_id),
  tasks: store.getJobTrace(job.job_id).tasks,
  results: [],
  plan,
  runtime: store.getWorkflowRuntimeState(job.job_id),
  persist: true,
  store
});
let decision = await classify();
assert.equal(decision.action, LangGraphActions.ASSIGN_CHILDREN);

const reworkTasks = store.db.prepare("SELECT task_id,role FROM tasks WHERE job_id=? AND description LIKE 'Rework revision%' ORDER BY created_at").all(job.job_id);
const reworkByRole = new Map(reworkTasks.map(task => [task.role, task.task_id]));
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(reworkByRole.get('engineer'));
store.setWorkflowRuntimeState(job.job_id, 'SYNTHESIZE');
decision = await classify();
assert.equal(decision.action, LangGraphActions.ASSIGN_CHILDREN);
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(reworkByRole.get('qa'));
store.setWorkflowRuntimeState(job.job_id, 'SYNTHESIZE');
decision = await classify();
assert.equal(decision.action, LangGraphActions.ASSIGN_CHILDREN);
store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(reworkByRole.get('reviewer'));
store.setWorkflowRuntimeState(job.job_id, 'SYNTHESIZE');
decision = await classify();
assert.equal(decision.action, LangGraphActions.SYNTHESIZE);

// Simulate an interrupted pre-M8 implementation that persisted invalidation but
// crashed before task/event creation. Recovery must resume from inactive artifacts.
store.db.prepare("DELETE FROM events WHERE job_id=? AND type='workflow.rework.prepared'").run(job.job_id);
store.db.prepare("DELETE FROM tasks WHERE job_id=? AND description LIKE 'Rework revision%'").run(job.job_id);
const recovered = store.prepareStandardEngineeringRework(job.job_id);
assert.equal(recovered.prepared, true);
assert.equal(recovered.idempotent, false);
assert.deepEqual(recovered.targetRoles.sort(), ['engineer', 'qa', 'reviewer']);
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE job_id=? AND description LIKE 'Rework revision%'").get(job.job_id).count, 3);

console.log('M8 REWORK IDEMPOTENCY PASS');
