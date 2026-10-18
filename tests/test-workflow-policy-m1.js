import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProductionWorkflow, isProductionWorkflow } from '../src/runtime/workflow/definitions/production.js';
import { PRODUCTION_QA_HARNESS_SHA256, PRODUCTION_QA_SUCCESS_MARKERS, ProductionRoles, ProductionTaskId, productionChildTaskSpecs, productionTaskSpec } from '../src/runtime/workflow/catalog/production.js';
import { validateProductionWorkflow } from '../src/runtime/workflow/schema.js';
import { WorkflowPhase } from '../src/runtime/workflow/phases.js';
import { tempDir } from './test-temp-dir.js';

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

const workspace = tempDir('workflow-policy-m1-');
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = productionChildTaskSpecs(workspace);
assert.deepEqual(specs.map(spec => spec.role), ProductionRoles);
assert.deepEqual(specs.map(spec => spec.id), [ProductionTaskId.ARCHITECT_CHECK, ProductionTaskId.QA_CHECK]);
assert.deepEqual(specs.map(spec => ({
  executor: spec.execution.executor,
  executable: spec.execution.executable,
  args: spec.execution.args,
  command: spec.execution.command,
  cwd: spec.execution.cwd,
  timeout_ms: spec.execution.timeout_ms,
  deterministic: spec.execution.deterministic,
  trusted_plugin_e2e: spec.execution.trusted_plugin_e2e,
  trusted_plugin_e2e_sha256: spec.execution.trusted_plugin_e2e_sha256,
  required_success_markers: spec.execution.required_success_markers
})), [
  {
    executor: 'ExecutionManager',
    executable: 'node',
    args: ['--check', path.join(workspace, 'server.js')],
    command: `node --check ${path.join(workspace, 'server.js')}`,
    cwd: workspace,
    timeout_ms: 120000,
    deterministic: true,
    trusted_plugin_e2e: undefined,
    trusted_plugin_e2e_sha256: undefined,
    required_success_markers: undefined
  },
  {
    executor: 'ExecutionManager',
    executable: 'node',
    args: [path.join(pluginRoot, 'tests', 'test-production-behavioral-qa.js')],
    command: `node ${path.join(pluginRoot, 'tests', 'test-production-behavioral-qa.js')}`,
    cwd: pluginRoot,
    timeout_ms: 300000,
    deterministic: true,
    trusted_plugin_e2e: true,
    trusted_plugin_e2e_sha256: PRODUCTION_QA_HARNESS_SHA256,
    required_success_markers: [...PRODUCTION_QA_SUCCESS_MARKERS]
  }
]);

assert.equal(productionTaskSpec(ProductionTaskId.CTO_SYNTHESIS, { workspace }).role, 'cto');
assert.equal(productionTaskSpec(ProductionTaskId.CTO_SYNTHESIS, { workspace }).execution.deterministic, false);
assert.ok(ProductionWorkflow.phases.includes(WorkflowPhase.APPROVED));
assert.ok(ProductionWorkflow.phases.includes(WorkflowPhase.PROJECT));

assert.throws(() => productionTaskSpec('unknown-task', { workspace }), /unknown production task/);
console.log('test-workflow-policy-m1: PASS');
