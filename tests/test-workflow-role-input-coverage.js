import assert from 'node:assert/strict';
import { compileWorkflowPlan } from '../src/runtime/workflow/compiler.js';
import { getAgentContract } from '../src/runtime/workflow/agent-contracts.js';
import { validateExecutionPlan } from '../src/runtime/workflow/plan.js';

function assertRoleInputsHaveDependencyProducers(plan) {
  const tasks = [...plan.children, plan.synthesis];
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    const contract = getAgentContract(task.role);
    const ancestors = new Set();
    const visit = id => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      for (const dependency of byId.get(id)?.dependencies || []) visit(dependency);
    };
    for (const dependency of task.dependencies) visit(dependency);
    const availableOutputs = new Set(tasks
      .filter(candidate => ancestors.has(candidate.id))
      .flatMap(candidate => getAgentContract(candidate.role).outputs));
    for (const input of contract.inputs.filter(value => value !== 'job.request')) {
      assert.ok(availableOutputs.has(input),
        `${plan.workflow_id}/${task.role} input ${input} must be produced by a dependency ancestor; ancestors=${[...ancestors].map(id => byId.get(id)?.role).join(',')}`);
    }
  }
}

const engineering = compileWorkflowPlan({ job_id: 'engineering-role-input-coverage', title: 'Engineering M4 role input coverage' }, { workspace: '/tmp' });
assertRoleInputsHaveDependencyProducers(engineering);
assert.deepEqual(engineering.children.map(task => task.role), [
  'product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer'
]);
assert.deepEqual(engineering.children.find(task => task.role === 'reviewer').dependencies, [
  'engineering-security', 'engineering-qa', 'engineering-platform', 'engineering-writer'
]);
assert.deepEqual(engineering.synthesis.dependencies, ['engineering-reviewer']);

const standard = compileWorkflowPlan({ job_id: 'standard-role-input-coverage', title: 'Software Development: role input coverage' }, { workspace: '/tmp' });
assertRoleInputsHaveDependencyProducers(standard);

// Persisted version-1 Engineering M4 plans must remain readable as immutable
// history even though new version-2 plans require the complete evidence graph.
const legacyEngineering = structuredClone(engineering);
legacyEngineering.workflow_version = 1;
legacyEngineering.children = [
  { ...engineering.children.find(task => task.role === 'architect'), dependencies: [] },
  { ...engineering.children.find(task => task.role === 'engineer'), dependencies: ['engineering-architect'] },
  { ...engineering.children.find(task => task.role === 'qa'), dependencies: ['engineering-engineer'] },
  { ...engineering.children.find(task => task.role === 'reviewer'), dependencies: ['engineering-qa'] }
];
legacyEngineering.required_children = legacyEngineering.children.map(task => task.id);
legacyEngineering.required_children = legacyEngineering.children.map(task => task.id);
legacyEngineering.synthesis.dependencies = ['engineering-reviewer'];
assert.doesNotThrow(() => validateExecutionPlan(legacyEngineering), 'legacy immutable plan history must remain readable without being silently recompiled');

// Adversarial mutation: an otherwise well-formed DAG that disconnects a
// required evidence producer must be rejected by the production plan validator.
const missingReviewerEvidenceDependency = structuredClone(engineering);
missingReviewerEvidenceDependency.children.find(task => task.role === 'reviewer').dependencies = ['engineering-qa'];
const unsigned = Object.fromEntries(Object.entries(missingReviewerEvidenceDependency)
  .filter(([key]) => !['plan_hash', 'compiled_at', 'approved_at'].includes(key)));
import crypto from 'node:crypto';
import { canonicalJson } from '../src/runtime/workflow/plan.js';
missingReviewerEvidenceDependency.plan_hash = crypto.createHash('sha256').update(canonicalJson(unsigned)).digest('hex');
assert.throws(() => validateExecutionPlan(missingReviewerEvidenceDependency), /role input has no dependency-bound artifact producer/,
  'plan validator must reject a reviewer whose immutable dependency graph omits required evidence');

console.log('WORKFLOW ROLE INPUT COVERAGE PASS');
