import assert from 'node:assert/strict';
import { getRoleContract, ROLE_CONTRACTS } from '../src/runtime/workflow/roles.js';
import { getWorkflowDefinition } from '../src/runtime/workflow/definitions/index.js';
import { ProductionWorkflow } from '../src/runtime/workflow/definitions/production.js';
import { EngineeringWorkflow } from '../src/runtime/workflow/definitions/engineering.js';
import { StandardEngineeringWorkflow } from '../src/runtime/workflow/definitions/standard-engineering.js';
import { compileWorkflowPlan } from '../src/runtime/workflow/compiler.js';

const canonicalRoles = [
  'product-owner', 'researcher', 'architect', 'engineer', 'security',
  'qa', 'platform', 'writer', 'reviewer', 'cto'
];

for (const role of canonicalRoles) {
  const contract = getRoleContract(role);
  assert.equal(contract.role, role);
  assert.equal(contract.executor, 'OpenClaw');
  assert.ok(contract.capability);
  assert.ok(Array.isArray(contract.permissions));
}

assert.ok(ROLE_CONTRACTS.productowner, 'legacy productowner alias must remain available');
assert.ok(ROLE_CONTRACTS['product-owner'], 'canonical product-owner role must be available');

assert.equal(getWorkflowDefinition({ title: 'production e2e acceptance' }).id, 'production');
assert.equal(getWorkflowDefinition({ title: 'engineering m4 acceptance' }).id, 'engineering');
assert.equal(getWorkflowDefinition({ title: 'Software Delivery: payments' }).id, 'standard-engineering');

assert.equal(ProductionWorkflow.version, 1);
assert.equal(EngineeringWorkflow.version, 1);
assert.equal(StandardEngineeringWorkflow.version, 1);

assert.deepEqual(EngineeringWorkflow.requiredChildren, [
  'engineering-architect',
  'engineering-engineer',
  'engineering-qa',
  'engineering-reviewer'
]);
assert.equal(EngineeringWorkflow.synthesisTask, 'engineering-cto-synthesis');

const m4Plan = compileWorkflowPlan({ job_id: 'm0-m4', title: 'Engineering M4 acceptance' }, { workspace: '/tmp' });
assert.equal(m4Plan.workflow_id, 'engineering');
assert.deepEqual(m4Plan.children.map(task => task.role), ['architect', 'engineer', 'qa', 'reviewer']);
assert.deepEqual(m4Plan.children.find(task => task.role === 'engineer').dependencies, ['engineering-architect']);
assert.deepEqual(m4Plan.children.find(task => task.role === 'qa').dependencies, ['engineering-engineer']);
assert.deepEqual(m4Plan.children.find(task => task.role === 'reviewer').dependencies, ['engineering-qa']);
assert.equal(m4Plan.synthesis.dependencies[0], 'engineering-reviewer');
assert.match(m4Plan.plan_hash, /^[a-f0-9]{64}$/);

const standardPlan = compileWorkflowPlan({ job_id: 'm0-standard', title: 'Engineering Standard delivery' }, { workspace: '/tmp' });
assert.equal(standardPlan.workflow_id, 'standard-engineering');
assert.equal(standardPlan.children.length, 9);
assert.match(standardPlan.plan_hash, /^[a-f0-9]{64}$/);

console.log('M0 ARCHITECTURE FREEZE PASS');

