import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';
import { validateArtifactContent } from '../src/runtime/workflow/artifacts.js';

const decision = {
  decision: 'approve',
  summary: 'All reviewed evidence is accepted.',
  accepted_requirements: ['scope and acceptance criteria reviewed'],
  unresolved_risks: [],
  follow_up_actions: [],
  evidence_refs: ['review-1']
};
assert.equal(validateArtifactContent('cto-decision', decision), true);
assert.throws(() => validateArtifactContent('cto-decision', { ...decision, decision: 'bad' }), /cto-decision artifact content has invalid fields/);
assert.throws(() => validateArtifactContent('cto-decision', { ...decision, evidence_refs: [123] }), /cto-decision artifact content has invalid fields/);

const tempRoot = tempDir('m7-cto-');
process.env.WORKFLOW_DB = path.join(tempRoot, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = tempRoot;
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `m7-${process.pid}-${Date.now()}`, title: 'Software development M7 CTO synthesis' });
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'Duyet');
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'M7 CTO synthesis' });
const reviewerContent = { requirementsSatisfied: true, architectureConformant: true, securityAccepted: true, qaAccepted: true, platformAccepted: true, documentationAccepted: true, implementationIssues: [], evidenceIssues: [], securityIssues: [], blockingIssues: [], decision: 'accept' };
for (const role of ['product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer']) {
  const child = store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role, description: role });
  store.db.prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(child.task_id);
  if (role === 'reviewer') store.createArtifact({ artifact_id: 'review-m7', job_id: job.job_id, task_id: child.task_id, type: 'review', producer_role: 'reviewer', content: reviewerContent, evidence: [] });
}
store.attachTaskRuntime(cto.task_id, { runId: 'm7-cto-run', sessionKey: 'agent:cto:subagent:m7' });
store.completeTaskByRuntime(job.job_id, { runId: 'm7-cto-run', content: JSON.stringify(decision), outcome: 'success' });
const durable = store.getLatestArtifact(job.job_id, 'cto-decision');
assert.equal(durable.producer_role, 'cto');
assert.equal(durable.content.decision, 'approve');
assert.match(durable.evidence[0], /^result_/);
assert.equal(durable.evidence[1], 'review-m7');
console.log('M7 CTO ARTIFACT PASS');
