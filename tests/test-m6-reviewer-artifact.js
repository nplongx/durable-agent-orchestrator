import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';
import { validateArtifactContent } from '../src/runtime/workflow/artifacts.js';

const accepted = {
  requirementsSatisfied: true, architectureConformant: true, securityAccepted: true,
  qaAccepted: true, platformAccepted: true, documentationAccepted: true,
  implementationIssues: [], evidenceIssues: [], securityIssues: [], blockingIssues: [], decision: 'accept'
};
assert.equal(validateArtifactContent('review', accepted), true);
assert.equal(validateArtifactContent('review', { ...accepted, decision: 'needs_changes', blockingIssues: ['QA evidence missing'] }), true);
for (const field of ['requirementsSatisfied', 'architectureConformant', 'securityAccepted', 'qaAccepted', 'platformAccepted', 'documentationAccepted']) {
  assert.throws(() => validateArtifactContent('review', { ...accepted, [field]: undefined }), /review artifact content has invalid fields/);
}
assert.throws(() => validateArtifactContent('review', { ...accepted, decision: 'bad' }), /review artifact content has invalid fields/);

const tempRoot = tempDir('m6-review-');
process.env.WORKFLOW_DB = path.join(tempRoot, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = tempRoot;
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `m6-${process.pid}-${Date.now()}`, title: 'Software development M6 reviewer artifact' });
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'Duyet');
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'M6 reviewer integration' });
const roleTypes = [
  ['product-owner', 'requirements'], ['architect', 'architecture'], ['engineer', 'implementation'],
  ['security', 'security-review'], ['qa', 'qa-report'], ['platform', 'platform-review'], ['writer', 'documentation']
];
for (const [role, type] of roleTypes) {
  const task = store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role, description: `M6 ${role}` });
  const content = {
    requirements: { scope: 'scope', acceptance_criteria: [], non_goals: [] },
    architecture: { components: [], interfaces: [], failure_modes: [], implementation_boundary: 'boundary' },
    implementation: { summary: 'done', files_changed: [], verification: [], execution: { session_id: 'exec-m6', exit_code: 0 } },
    'security-review': { threats: [], findings: [], decision: 'accept' },
    'qa-report': { checks: [], results: [], decision: 'accept' },
    'platform-review': { runtime: {}, deployment: {}, recovery: {} },
    documentation: { summary: 'docs', user_facing_changes: [], verification: [] }
  }[type];
  store.createArtifact({ artifact_id: `${type}-m6-${task.task_id}`, job_id: job.job_id, task_id: task.task_id, type, producer_role: role, content, evidence: [] });
}
const reviewer = store.createChildTask(job.job_id, { parentTaskId: cto.task_id, role: 'reviewer', description: 'M6 reviewer' });
store.attachTaskRuntime(reviewer.task_id, { runId: 'm6-review-run', sessionKey: 'agent:reviewer:subagent:m6' });
store.completeTaskByRuntime(job.job_id, { runId: 'm6-review-run', content: JSON.stringify({ review: accepted }), outcome: 'success' });
const durableReview = store.getLatestArtifact(job.job_id, 'review');
assert.equal(durableReview.producer_role, 'reviewer');
assert.equal(durableReview.content.decision, 'accept');
assert.equal(durableReview.evidence.length, 8);
console.log('M6 REVIEWER ARTIFACT PASS');
