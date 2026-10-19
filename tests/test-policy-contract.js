import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  attachWorkflowPolicy,
  createWorkflowPolicy,
  normalizePolicyDefinition,
  createPolicySnapshot,
  validatePolicySnapshot,
  composePolicySuccessContract,
  getWorkflowPolicy,
  getWorkflowPolicyCatalog,
  getWorkflowPolicySnapshotsForJob,
  initializeWorkflowPolicyStore,
  listWorkflowPolicies,
  listWorkflowPolicyAttachments,
  recordWorkflowPolicyViolation,
  updateWorkflowPolicy
} from '../src/runtime/workflow/policy-contract.js';
import { compileWorkflowPlan } from '../src/runtime/workflow/compiler.js';
import { validateExecutionPlan } from '../src/runtime/workflow/plan.js';
import { normalizeSuccessContract } from '../src/runtime/workflow/success-contract.js';

const base = normalizeSuccessContract({
  goal: 'Release a verified change',
  constraints: [{ id: 'system-local-only', type: 'local_execution_only' }],
  success_criteria: [{ id: 'all-work', type: 'all_tasks_completed' }]
});

const secureDefinition = normalizePolicyDefinition({
  policy_id: 'secure-release',
  name: 'Secure release',
  description: 'Require an accepted QA artifact.',
  constraints: [{ id: 'required-qa', type: 'task_role_present', role: 'qa' }],
  success_criteria: [{ id: 'qa-accepts', type: 'artifact_field_equals', artifact_type: 'qa-report', producer_role: 'qa', field: 'decision', expected: 'accept' }]
});
assert.equal(secureDefinition.policy_id, 'secure-release');
assert.equal(secureDefinition.schema_version, 1);
assert.throws(() => normalizePolicyDefinition({ ...secureDefinition, executable: 'process.exit(0)' }), /unsupported fields/i);
assert.throws(() => normalizePolicyDefinition({ ...secureDefinition, constraints: [{ id: 'anything', type: 'arbitrary_js', source: 'return true' }] }), /unsupported/i);
assert.throws(() => normalizePolicyDefinition({ ...secureDefinition, constraints: [{ id: 'a'.repeat(40), type: 'all_tasks_completed' }] }), /39 characters/i);
assert.throws(() => normalizePolicyDefinition({ ...secureDefinition, constraints: [{ id: 'dup', type: 'all_tasks_completed' }], success_criteria: [{ id: 'dup', type: 'all_tasks_completed' }] }), /duplicate id/i);

const snapshot = createPolicySnapshot('secure-release', 3, secureDefinition);
assert.equal(validatePolicySnapshot(snapshot).content_hash, snapshot.content_hash);
assert.throws(() => validatePolicySnapshot({ ...snapshot, version: 4 }), /hash mismatch/i);
assert.throws(() => validatePolicySnapshot({ ...snapshot, name: 'tampered' }), /hash mismatch/i);

const merged = composePolicySuccessContract(base, [snapshot], {
  workflowId: 'standard-engineering',
  children: [{ id: 'standard-qa', role: 'qa' }, { id: 'standard-engineer', role: 'engineer' }]
});
assert.equal(merged.success_contract.goal, base.goal);
assert.equal(merged.success_contract.constraints.length, 2);
assert.equal(merged.success_contract.success_criteria.length, 2);
assert.ok(merged.success_contract.constraints.some(rule => rule.id !== 'required-qa' && rule.type === 'task_role_present'));
assert.equal(merged.policy_packs[0].policy_id, 'secure-release');

assert.throws(() => composePolicySuccessContract(base, [snapshot], {
  workflowId: 'standard-engineering', children: [{ id: 'standard-engineer', role: 'engineer' }]
}), /requires planned role qa/i);
assert.throws(() => composePolicySuccessContract(base, [createPolicySnapshot('wrong-workflow', 1, normalizePolicyDefinition({
  policy_id: 'wrong-workflow', name: 'Wrong workflow', constraints: [{ id: 'workflow-only', type: 'workflow_id_equals', expected: 'production' }]
}))], { workflowId: 'standard-engineering', children: [] }), /expects workflow .* target plan/i);

const present = createPolicySnapshot('require-security', 1, normalizePolicyDefinition({
  policy_id: 'require-security', name: 'Require security', constraints: [{ id: 'security-present', type: 'task_role_present', role: 'security' }]
}));
const absent = createPolicySnapshot('ban-security', 1, normalizePolicyDefinition({
  policy_id: 'ban-security', name: 'Ban security', constraints: [{ id: 'security-absent', type: 'task_role_absent', role: 'security' }]
}));
assert.throws(() => composePolicySuccessContract(base, [present, absent], { workflowId: 'standard-engineering', children: [{ id: 's', role: 'security' }] }), /conflicting policy predicates/i);
const scalarQa = createPolicySnapshot('qa-decision-scalar', 1, normalizePolicyDefinition({
  policy_id: 'qa-decision-scalar', name: 'Scalar QA decision', success_criteria: [{ id: 'qa-scalar', type: 'artifact_field_equals', artifact_type: 'qa-report', field: 'decision', expected: 'accept' }]
}));
const arrayQa = createPolicySnapshot('qa-decision-array', 1, normalizePolicyDefinition({
  policy_id: 'qa-decision-array', name: 'Array QA decision', success_criteria: [{ id: 'qa-array', type: 'artifact_field_includes', artifact_type: 'qa-report', field: 'decision', expected: 'accept' }]
}));
assert.throws(() => composePolicySuccessContract(base, [scalarQa, arrayQa]), /conflicting policy predicates/i);
const numericNonEmpty = createPolicySnapshot('qa-numeric-non-empty', 1, normalizePolicyDefinition({
  policy_id: 'qa-numeric-non-empty', name: 'Numeric QA decision', constraints: [{ id: 'qa-numeric', type: 'artifact_field_equals', artifact_type: 'qa-report', field: 'decision', expected: 1 }]
}));
const nonEmptyQa = createPolicySnapshot('qa-non-empty', 1, normalizePolicyDefinition({
  policy_id: 'qa-non-empty', name: 'Non-empty QA decision', constraints: [{ id: 'qa-non-empty', type: 'artifact_field_non_empty', artifact_type: 'qa-report', field: 'decision' }]
}));
assert.throws(() => composePolicySuccessContract(base, [numericNonEmpty, nonEmptyQa]), /conflicting policy predicates/i);

const catalog = getWorkflowPolicyCatalog();
assert.ok(catalog.rule_types.some(rule => rule.type === 'artifact_field_equals' && /synthesis/i.test(rule.enforcement)));
assert.ok(!catalog.rule_types.some(rule => rule.type === 'max_execution_attempts'), 'unsupported rule types must not be advertised');

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE jobs(job_id TEXT PRIMARY KEY,state TEXT NOT NULL,status TEXT NOT NULL,title TEXT NOT NULL);
CREATE TABLE events(event_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
INSERT INTO jobs(job_id,state,status,title) VALUES('job-policy-test','IDLE','active','Software Development: policy test');`);
initializeWorkflowPolicyStore(db);
const stored = createWorkflowPolicy(db, {
  policy_id: 'stored-policy', name: 'Stored Policy',
  constraints: [{ id: 'qa-present', type: 'task_role_present', role: 'qa' }]
}, { actor: 'test-operator' });
assert.equal(stored.version, 1);
const updated = updateWorkflowPolicy(db, {
  policy_id: 'stored-policy', description: 'Version two description'
}, { actor: 'test-operator' });
assert.equal(updated.version, 2);
assert.equal(getWorkflowPolicy(db, 'stored-policy', 1).name, 'Stored Policy');
assert.equal(getWorkflowPolicy(db, 'stored-policy', 2).description, 'Version two description');
assert.equal(listWorkflowPolicies(db, { includeVersions: true }).items.length, 2);
assert.throws(() => db.prepare('UPDATE workflow_policy_versions SET name=? WHERE policy_id=? AND version=1').run('mutated', 'stored-policy'), /immutable/i);
assert.throws(() => db.prepare('DELETE FROM workflow_policy_versions WHERE policy_id=?').run('stored-policy'), /immutable/i);
const { created_at: storedCreatedAt, created_by: storedCreatedBy, ...storedSnapshot } = stored;

const baseProposal = {
  task: 'Verify policy attachment behavior',
  workspace: '/home/long/work/chatgpt-adapter',
  workflowId: 'standard-engineering',
  success_contract: base
};
let jobState = { state: 'IDLE', status: 'active' };
const workflowStub = {
  getJob(jobId) { return jobId === 'job-policy-test' ? { job_id: jobId, ...jobState, title: 'Software Development: policy test' } : null; },
  getWorkflowRuntimeState() { return { phase: jobState.phase || 'PROPOSED' }; },
  getLatestApproval() { return jobState.approved ? { decision: 'approved' } : null; },
  getExecutionPlan() { return jobState.compiled ? { plan_hash: 'immutable' } : null; },
  getCurrentProposal() { return { payload: baseProposal }; },
  recordEvent(jobId, type, payload) {
    const eventId = `${jobId}:${type}:${payload.policy_id || ''}:${payload.version || ''}`;
    db.prepare('INSERT OR IGNORE INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(eventId, jobId, type, JSON.stringify(payload), new Date().toISOString());
    return eventId;
  }
};
const planned = compileWorkflowPlan({ job_id: 'job-policy-test', title: 'Software Development: policy test' }, {
  workspace: baseProposal.workspace,
  successContract: base,
  policyPacks: [storedSnapshot]
});
const ungovernedPlan = compileWorkflowPlan({ job_id: 'job-policy-test', title: 'Software Development: policy test' }, {
  workspace: baseProposal.workspace,
  successContract: base
});
assert.notEqual(planned.plan_hash, ungovernedPlan.plan_hash, 'adding an attached policy snapshot changes the immutable execution plan hash');
assert.equal(planned.policy_packs.length, 1);
assert.equal(planned.base_success_contract.goal, base.goal);
assert.ok(planned.success_contract.constraints.some(rule => rule.id === 'p-stored-policy-qa-present'));
assert.doesNotThrow(() => validateExecutionPlan(planned));
assert.throws(() => validateExecutionPlan({ ...planned, policy_packs: [{ ...planned.policy_packs[0], version: 2 }] }), /policy snapshot hash mismatch/i);

const attached = attachWorkflowPolicy(db, workflowStub, {
  jobId: 'job-policy-test', policyId: 'stored-policy', version: 1,
  actor: 'test-operator', planContext: { workflowId: 'standard-engineering', children: planned.children }
});
assert.equal(attached.version, 1);
assert.equal(getWorkflowPolicySnapshotsForJob(db, 'job-policy-test')[0].content_hash, stored.content_hash);
assert.equal(listWorkflowPolicyAttachments(db, { jobId: 'job-policy-test' })[0].policy_id, 'stored-policy');
assert.throws(() => attachWorkflowPolicy(db, workflowStub, {
  jobId: 'job-policy-test', policyId: 'stored-policy', version: 2,
  actor: 'test-operator', planContext: { workflowId: 'standard-engineering', children: planned.children }
}), /already attached/i);
jobState = { state: 'APPROVED', status: 'active', approved: true, phase: 'APPROVED' };
assert.throws(() => attachWorkflowPolicy(db, workflowStub, {
  jobId: 'job-policy-test', policyId: 'other-policy', version: 1,
  actor: 'test-operator', planContext: { workflowId: 'standard-engineering', children: planned.children }
}), /unapproved workflow proposal/i);
assert.equal(db.prepare("SELECT COUNT(*) n FROM workflow_policy_events WHERE event_type='attached'").get().n, 1);
const violation = recordWorkflowPolicyViolation(db, workflowStub, {
  jobId: 'job-policy-test', policySnapshot: storedSnapshot, planHash: 'a'.repeat(64),
  predicate: { id: 'p-stored-policy-qa-present', type: 'task_role_present' }, reason: 'required role missing in plan'
});
const duplicateViolation = recordWorkflowPolicyViolation(db, workflowStub, {
  jobId: 'job-policy-test', policySnapshot: storedSnapshot, planHash: 'a'.repeat(64),
  predicate: { id: 'p-stored-policy-qa-present', type: 'task_role_present' }, reason: 'required role missing in plan'
});
assert.equal(duplicateViolation.event_id, violation.event_id, 'the same plan/predicate violation must be idempotent across retries');
assert.equal(db.prepare("SELECT COUNT(*) n FROM workflow_policy_events WHERE event_type='violation_detected'").get().n, 1);
db.close();

console.log('WORKFLOW POLICY CONTRACT PASS (closed schema, immutable snapshot hashing, namespaced merge, compatibility/conflict rejection, enforcement catalog)');
