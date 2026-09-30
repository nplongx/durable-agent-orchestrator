import assert from 'node:assert/strict';
import { StandardEngineeringWorkflow, StandardEngineeringTaskId, isStandardEngineeringWorkflow } from '../src/runtime/workflow/definitions/standard-engineering.js';
import { standardEngineeringTaskSpecs, standardEngineeringTaskSpec } from '../src/runtime/workflow/catalog/standard-engineering.js';
import { validateStandardEngineeringWorkflow } from '../src/runtime/workflow/schema.js';
import { compileWorkflowPlan } from '../src/runtime/workflow/compiler.js';

assert.equal(isStandardEngineeringWorkflow({ title: 'Engineering Standard delivery' }), true);
assert.equal(validateStandardEngineeringWorkflow('/tmp'), true);
assert.equal(StandardEngineeringWorkflow.version, 1);
assert.deepEqual(standardEngineeringTaskSpecs('/tmp').map(x => x.role), [
  'product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer'
]);
const specs = standardEngineeringTaskSpecs('/tmp');
const byRole = Object.fromEntries(specs.map(x => [x.role, x]));
assert.deepEqual(byRole.architect.dependencies, [StandardEngineeringTaskId.PRODUCT_OWNER, StandardEngineeringTaskId.RESEARCHER]);
assert.deepEqual(byRole.engineer.dependencies, [StandardEngineeringTaskId.ARCHITECT]);
assert.deepEqual(byRole.reviewer.dependencies, [StandardEngineeringTaskId.SECURITY, StandardEngineeringTaskId.QA, StandardEngineeringTaskId.PLATFORM, StandardEngineeringTaskId.WRITER]);
assert.equal(standardEngineeringTaskSpec(StandardEngineeringTaskId.CTO_SYNTHESIS, { workspace: '/tmp' }).dependencies[0], StandardEngineeringTaskId.REVIEWER);
const plan = compileWorkflowPlan({ job_id: 'standard-test', title: 'Software delivery: payments' }, { workspace: '/tmp' });
assert.equal(plan.workflow_id, 'standard-engineering');
assert.equal(plan.children.length, 9);
assert.deepEqual(plan.required_children, StandardEngineeringWorkflow.requiredChildren);
assert.ok(plan.plan_hash);
console.log('STANDARD ENGINEERING WORKFLOW PASS');
