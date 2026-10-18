import assert from 'node:assert/strict';
import { compileWorkflowPlan } from '../src/runtime/workflow/compiler.js';
import { validateExecutionPlan } from '../src/runtime/workflow/plan.js';
import {
  evaluateSuccessPredicate,
  hasEnforcedSuccessCriteria,
  normalizeSuccessContract,
  validateSuccessAssessment,
  validateSuccessContract
} from '../src/runtime/workflow/success-contract.js';

const contract = normalizeSuccessContract({
  goal: 'Deliver a reliable local workflow.',
  constraints: [{ id: 'local-only', type: 'local_execution_only', description: 'Only approved local execution contracts are allowed.' }],
  success_criteria: [
    { id: 'qa-accepted', type: 'artifact_field_equals', artifact_type: 'qa-report', field: 'decision', expected: 'accept' },
    { id: 'qa-task-completed', type: 'task_status_equals', task_id: 'engineering-qa', expected: 'completed' }
  ]
}, 'unused fallback');

assert.equal(contract.goal, 'Deliver a reliable local workflow.');
assert.equal(hasEnforcedSuccessCriteria(contract), true);
assert.doesNotThrow(() => validateSuccessContract(contract));

const compiled = compileWorkflowPlan({ job_id: 'success-contract-compile', title: 'Engineering M4 success contract' }, {
  workspace: '/tmp/success-contract-workspace', successContract: contract
});
assert.doesNotThrow(() => validateExecutionPlan(compiled));
assert.deepEqual(compiled.success_contract, contract, 'the exact normalized goal/constraint/criteria contract is pinned into the plan');

const stricterContract = normalizeSuccessContract({
  goal: contract.goal,
  constraints: contract.constraints,
  success_criteria: [
    ...contract.success_criteria,
    { id: 'docs-updated', type: 'artifact_field_non_empty', artifact_type: 'documentation', field: 'summary' }
  ]
});
const stricterPlan = compileWorkflowPlan({ job_id: 'success-contract-compile', title: 'Engineering M4 success contract' }, {
  workspace: '/tmp/success-contract-workspace', successContract: stricterContract
});
assert.notEqual(compiled.plan_hash, stricterPlan.plan_hash, 'changing success criteria changes the immutable plan hash');

const evidence = [
  { artifact_id: 'qa-report-pass-001', type: 'qa-report', producer_role: 'qa', content: { decision: 'accept' } },
  { artifact_id: 'documentation-report-002', type: 'documentation', producer_role: 'writer', content: { summary: 'Docs match implementation.' } }
];
const context = {
  plan: compiled,
  tasks: compiled.children.map((spec, index) => ({
    task_id: `durable-${spec.id}`, role: spec.role, status: 'completed',
    metadata_json: JSON.stringify({ workflow_plan_task_id: spec.id }),
    created_at: `2026-10-18T10:${String(index).padStart(2, '0')}:00.000Z`
  })),
  artifacts: evidence
};
const validAssessment = {
  goal_status: 'achieved',
  summary: 'The acceptance test passed and the workflow stayed local.',
  criteria: [
    { id: 'qa-accepted', status: 'met', evidence_refs: ['qa-report-pass-001'] },
    { id: 'qa-task-completed', status: 'met', evidence_refs: [] }
  ],
  constraints: [{ id: 'local-only', status: 'satisfied', evidence_refs: [] }]
};
assert.deepEqual(validateSuccessAssessment(contract, validAssessment, context), { valid: true, errors: [] });

assert.match(validateSuccessAssessment(contract, null, context).errors.join('; '), /requires success_assessment/);
assert.match(validateSuccessAssessment(contract, {
  ...validAssessment,
  constraints: [{ id: 'local-only', status: 'violated', evidence_refs: [] }]
}, context).errors.join('; '), /constraint local-only status must be satisfied/);
assert.match(validateSuccessAssessment(contract, {
  ...validAssessment,
  criteria: [
    { id: 'qa-accepted', status: 'met', evidence_refs: ['not-an-active-artifact'] },
    { id: 'qa-task-completed', status: 'met', evidence_refs: [] }
  ]
}, context).errors.join('; '), /references missing, inactive, or unverified artifact/);
assert.match(validateSuccessAssessment(contract, {
  ...validAssessment,
  criteria: [
    { id: 'qa-accepted', status: 'met', evidence_refs: ['documentation-report-002'] },
    { id: 'qa-task-completed', status: 'met', evidence_refs: [] }
  ]
}, context).errors.join('; '), /must cite artifact IDs that satisfy the declared predicate/,
'a valid but unrelated artifact cannot be cited as proof of a different predicate');
assert.match(validateSuccessAssessment(contract, {
  ...validAssessment,
  criteria: [{ id: 'qa-task-completed', status: 'met', evidence_refs: [] }]
}, context).errors.join('; '), /missing required id: qa-accepted/);
assert.match(validateSuccessAssessment(contract, {
  ...validAssessment,
  goal_status: 'partial'
}, context).errors.join('; '), /goal_status must be achieved/);

const falsePositiveArtifactContext = {
  ...context,
  artifacts: [{ ...evidence[0], content: { decision: 'needs_changes' } }, evidence[1]]
};
assert.match(validateSuccessAssessment(contract, validAssessment, falsePositiveArtifactContext).errors.join('; '),
  /success criterion qa-accepted failed runtime evaluation/, 'a claimed status=met cannot override a false machine-evaluated predicate');

const nonLocalPlan = structuredClone(compiled);
nonLocalPlan.children[0].execution.executor = 'RemoteRunner';
const nonLocalContext = { ...context, plan: nonLocalPlan };
assert.match(validateSuccessAssessment(contract, validAssessment, nonLocalContext).errors.join('; '),
  /workflow constraint local-only failed runtime evaluation/, 'a claimed status=satisfied cannot override the immutable execution-plan inspection');

assert.equal(evaluateSuccessPredicate(contract.success_criteria[0], context).passed, true);
assert.equal(evaluateSuccessPredicate(contract.constraints[0], context).passed, true);

const goalOnly = normalizeSuccessContract({ goal: 'Inspect current source.' });
assert.equal(hasEnforcedSuccessCriteria(goalOnly), false, 'a goal alone is documented/pinned, while explicit rows opt into strict evidence assessment');
assert.deepEqual(validateSuccessAssessment(goalOnly, undefined, {}), { valid: true, errors: [] }, 'legacy goal-only workflows remain compatible');

assert.throws(() => normalizeSuccessContract({ constraints: [
  { id: 'local-only', type: 'local_execution_only' }, { id: 'local-only', type: 'local_execution_only' }
] }), /duplicate id/);
assert.throws(() => normalizeSuccessContract({ success_criteria: [{ id: 'Bad_ID', description: 'Bad slug.' }] }), /lowercase slug/);
assert.throws(() => normalizeSuccessContract({ success_criteria: [{ id: 'unsupported', type: 'model_says_pass' }] }), /type is unsupported/);
assert.throws(() => normalizeSuccessContract({ success_criteria: [{ id: 'unsafe-field', type: 'artifact_field_equals', artifact_type: 'qa-report', field: 'result.decision', expected: 'accept' }] }), /top-level JSON field/);
assert.throws(() => normalizeSuccessContract({ success_criteria: [{ id: 'nonzero-exit', type: 'execution_exit_code_equals', task_id: 'engineering-qa', expected: 1 }] }), /expected must be numeric 0/);
assert.throws(() => normalizeSuccessContract({ success_criteria: [{ id: 'free-text-only', description: 'Please run all tests.' }] }), /type must be a non-empty string/);

console.log('WORKFLOW SUCCESS CONTRACT PASS (closed JSON predicates, immutable plan binding/hash, independently evaluated constraint/criterion gates, provenance-bound artifact refs, goal-only compatibility)');
