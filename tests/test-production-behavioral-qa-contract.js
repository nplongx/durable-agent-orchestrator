import assert from 'node:assert/strict';
import { assessProductionQaExecution, PRODUCTION_QA_SUCCESS_MARKERS, ProductionTaskId, productionTaskSpec } from '../src/runtime/workflow/catalog/production.js';

const task = productionTaskSpec(ProductionTaskId.QA_CHECK, { workspace: '/tmp/production-contract-fixture' });
const plannedTask = { id: task.id, role: task.role, execution: task.execution, dependencies: [] };
const plan = { workflow_id: 'production', children: [plannedTask] };
const metadata = { ...task.execution, workflow_plan_task_id: task.id };
const goodOutput = `${PRODUCTION_QA_SUCCESS_MARKERS.join('\n')}\n`;

const complete = assessProductionQaExecution({ plan, taskPlanId: task.id, metadata, stdout: goodOutput });
assert.equal(complete.trusted, true);
assert.equal(complete.passed, true);
assert.deepEqual(complete.observed_markers, [...PRODUCTION_QA_SUCCESS_MARKERS]);
assert.deepEqual(complete.missing_markers, []);

const missingMarker = assessProductionQaExecution({
  plan, taskPlanId: task.id, metadata,
  stdout: PRODUCTION_QA_SUCCESS_MARKERS.slice(0, -1).join('\n')
});
assert.equal(missingMarker.trusted, true);
assert.equal(missingMarker.passed, false, 'zero exit alone cannot replace a missing behavioral marker');
assert.deepEqual(missingMarker.missing_markers, [PRODUCTION_QA_SUCCESS_MARKERS.at(-1)]);

const forgedMetadata = { ...metadata, args: ['--check', '/tmp/test-tool-turn.js'], command: 'node --check /tmp/test-tool-turn.js', trusted_plugin_e2e: false };
const forgedOutput = assessProductionQaExecution({ plan, taskPlanId: task.id, metadata: forgedMetadata, stdout: goodOutput });
assert.equal(forgedOutput.trusted, false, 'a syntax check or caller-supplied success text must not impersonate the immutable QA contract');
assert.equal(forgedOutput.passed, false);

const wrongTask = assessProductionQaExecution({ plan, taskPlanId: 'architect-check', metadata, stdout: goodOutput });
assert.equal(wrongTask.trusted, false, 'QA evidence must bind the exact planned QA slot');
assert.equal(wrongTask.passed, false);

const wrongWorkflow = assessProductionQaExecution({ plan: { ...plan, workflow_id: 'standard-engineering' }, taskPlanId: task.id, metadata, stdout: goodOutput });
assert.equal(wrongWorkflow.trusted, false, 'the packaged production harness must not grant QA acceptance in another workflow');

const staleHarnessHash = assessProductionQaExecution({
  plan, taskPlanId: task.id, metadata: { ...metadata, trusted_plugin_e2e_sha256: '0'.repeat(64) }, stdout: goodOutput
});
assert.equal(staleHarnessHash.trusted, false, 'QA acceptance must fail closed when the planned/actual harness source hash differs');
assert.equal(staleHarnessHash.passed, false);

console.log('PRODUCTION BEHAVIORAL QA EXACT-PLAN / MARKER / HOSTILE-METADATA CONTRACT PASS');
