import assert from 'node:assert/strict';
import path from 'node:path';
import { ProductionWorkflow, isProductionWorkflow } from '../src/runtime/workflow/definitions/production.js';
import { ProductionRoles, ProductionTaskId, productionChildTaskSpecs, productionTaskSpec } from '../src/runtime/workflow/catalog/production.js';
import { validateProductionWorkflow } from '../src/runtime/workflow/schema.js';
import { WorkflowPhase } from '../src/runtime/workflow/phases.js';

assert.equal(ProductionWorkflow.id, 'production');
assert.equal(ProductionWorkflow.version, 1);
assert.deepEqual(ProductionWorkflow.requiredChildren, [
  ProductionTaskId.ARCHITECT_CHECK,
  ProductionTaskId.QA_CHECK
]);
assert.equal(ProductionWorkflow.synthesisTask, ProductionTaskId.CTO_SYNTHESIS);
assert.equal(isProductionWorkflow({ title: 'Production E2E acceptance' }), true);
assert.equal(isProductionWorkflow({ title: 'ordinary job' }), false);
assert.equal(validateProductionWorkflow(), true);

const workspace = '/tmp/workflow-policy-m1';
const specs = productionChildTaskSpecs(workspace);
assert.deepEqual(specs.map(spec => spec.role), ProductionRoles);
assert.deepEqual(specs.map(spec => spec.id), [ProductionTaskId.ARCHITECT_CHECK, ProductionTaskId.QA_CHECK]);
assert.deepEqual(specs.map(spec => spec.execution), [
  {
    executor: 'ExecutionManager',
    command: `node --check ${path.join(workspace, 'server.js')}`,
    cwd: workspace,
    timeout_ms: 120000,
    deterministic: true
  },
  {
    executor: 'ExecutionManager',
    command: `node --check ${path.join(workspace, 'test-tool-turn.js')}`,
    cwd: workspace,
    timeout_ms: 120000,
    deterministic: true
  }
]);

assert.equal(productionTaskSpec(ProductionTaskId.CTO_SYNTHESIS, { workspace }).role, 'cto');
assert.equal(productionTaskSpec(ProductionTaskId.CTO_SYNTHESIS, { workspace }).execution.deterministic, false);
assert.ok(ProductionWorkflow.phases.includes(WorkflowPhase.APPROVED));
assert.ok(ProductionWorkflow.phases.includes(WorkflowPhase.PROJECT));

assert.throws(() => productionTaskSpec('unknown-task', { workspace }), /unknown production task/);
console.log('test-workflow-policy-m1: PASS');
