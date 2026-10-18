import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';
import { compileWorkflowPlan } from '../src/runtime/workflow/compiler.js';
import { canonicalJson, validateExecutionPlan } from '../src/runtime/workflow/plan.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const rehash = plan => {
  const unsigned = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'plan_hash'));
  plan.plan_hash = sha256(canonicalJson(unsigned));
  return plan;
};

const fixtures = [
  { job_id: 'plan-contract-engineering', title: 'Engineering M4 structural contract' },
  { job_id: 'plan-contract-standard', title: 'Software Development structural contract' },
  { job_id: 'plan-contract-production', title: 'Production E2E structural contract' }
];

for (const job of fixtures) {
  const plan = compileWorkflowPlan(job, { workspace: '/tmp/workflow-plan-contract' });
  assert.doesNotThrow(() => validateExecutionPlan(plan), `${plan.workflow_id} compiler output remains valid`);

  const missingRequiredChild = structuredClone(plan);
  missingRequiredChild.required_children.pop();
  rehash(missingRequiredChild);
  assert.throws(
    () => validateExecutionPlan(missingRequiredChild),
    /required_children.*match|required child.*plan/i,
    `${plan.workflow_id} must reject a plan whose required child contract omits a compiled task`
  );

  const substitutedRequiredChild = structuredClone(plan);
  substitutedRequiredChild.required_children[0] = 'unplanned-substitute';
  rehash(substitutedRequiredChild);
  assert.throws(
    () => validateExecutionPlan(substitutedRequiredChild),
    /required_children.*match|required child.*plan/i,
    `${plan.workflow_id} must reject a coordinated required-child identity substitution`
  );

  const duplicatePhase = structuredClone(plan);
  duplicatePhase.phases[1] = duplicatePhase.phases[0];
  rehash(duplicatePhase);
  assert.throws(
    () => validateExecutionPlan(duplicatePhase),
    /phases must contain unique/i,
    `${plan.workflow_id} must reject duplicate phase identities`
  );
}

// Exercise the durable production read path with a coordinated substitution:
// rewrite the plan JSON, recompute its hash, and update the deterministic
// workflow.plan_compiled event to match. Hash/event agreement alone must not
// let a structurally incomplete plan through recovery or task issuance.
const tempRoot = tempDir('workflow-plan-structural-durable-');
const dataDir = path.join(tempRoot, 'data');
const workspace = path.join(tempRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = workspace;
process.env.NODE_ENV = 'test';
process.on('exit', () => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {} });
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `plan-structure-durable-${process.pid}`, title: 'Engineering M4 durable structural contract' });
store.approve(job.job_id, 'isolated structural plan contract approval', 'test-actor', { workspace });
const originalPlan = store.getExecutionPlan(job.job_id);
const tamperedPlan = structuredClone(originalPlan);
tamperedPlan.required_children.pop();
const unsignedTamperedPlan = Object.fromEntries(Object.entries(tamperedPlan)
  .filter(([key]) => !['plan_hash', 'compiled_at', 'approved_at'].includes(key)));
const tamperedPlanJson = canonicalJson(unsignedTamperedPlan);
const tamperedPlanHash = sha256(tamperedPlanJson);
store.db.prepare('UPDATE workflow_plans SET plan_json=?,plan_hash=? WHERE job_id=?')
  .run(tamperedPlanJson, tamperedPlanHash, job.job_id);
store.db.prepare("UPDATE events SET event_id=?,payload_json=? WHERE job_id=? AND type='workflow.plan_compiled'")
  .run(sha256(`${job.job_id}|workflow.plan_compiled|${tamperedPlanHash}`),
    JSON.stringify({ workflowId: originalPlan.workflow_id, workflowVersion: originalPlan.workflow_version, planHash: tamperedPlanHash }), job.job_id);
assert.throws(() => store.getExecutionPlan(job.job_id), /required_children do not match/,
  'durable plan read must reject coordinated plan JSON/hash/compiled-event substitution');
store.db.close();

console.log('WORKFLOW PLAN STRUCTURAL CONTRACT PASS');
