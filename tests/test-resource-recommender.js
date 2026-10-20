import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeCustomRoleStore, createCustomRole } from '../src/runtime/workflow/custom-roles.js';
import { initializeCustomWorkflowStore, createCustomWorkflow } from '../src/runtime/workflow/custom-workflows.js';
import { initializeWorkflowPolicyStore, createWorkflowPolicy } from '../src/runtime/workflow/policy-contract.js';
import { recommendReusableResources } from '../src/runtime/workflow/resource-recommender.js';

const db = new DatabaseSync(':memory:');
try {
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('CREATE TABLE jobs (job_id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL, status TEXT NOT NULL)');
  initializeCustomRoleStore(db);
  initializeCustomWorkflowStore(db);
  initializeWorkflowPolicyStore(db);

  await createCustomRole(db, {
    role_id: 'security-reviewer',
    name: 'Security Threat Reviewer',
    description: 'Review application security, authentication, authorization, vulnerabilities and trust boundaries.',
    system_prompt: 'Perform an evidence-based security review. Do not execute or mutate files.',
    input_contract: ['job.request', 'requirements', 'architecture', 'implementation'],
    output_artifact_type: 'security-review',
    allowed_capabilities: ['security.audit'],
    permissions: ['workspace.read', 'artifact.create'],
    allowed_tools: [],
    skills: []
  });
  createCustomWorkflow(db, {
    workflow_id: 'security-review-flow',
    name: 'Security Review Flow',
    description: 'Review code for vulnerabilities, authentication and authorization boundaries, and write a security report.',
    input_contract: ['job.request'],
    tasks: [{ id: 'security-review', role_id: 'security-reviewer', role_version: 1, input_contract: ['job.request'], output_artifact_type: 'security-review', depends_on: [] }]
  });
  createWorkflowPolicy(db, {
    policy_id: 'security-review-gates',
    name: 'Security Review Gates',
    description: 'Require all planned tasks to complete successfully and use approved local execution contracts.',
    constraints: [
      { id: 'completed-work', type: 'all_tasks_completed' },
      { id: 'local-only', type: 'local_execution_only' }
    ],
    success_criteria: []
  });

  const intent = 'Rà soát bảo mật ứng dụng, tìm lỗ hổng và kiểm tra quyền truy cập.';
  const before = {
    roles: db.prepare('SELECT COUNT(*) AS n FROM custom_role_versions').get().n,
    workflows: db.prepare('SELECT COUNT(*) AS n FROM custom_workflow_versions').get().n,
    policies: db.prepare('SELECT COUNT(*) AS n FROM workflow_policy_versions').get().n
  };
  const result = recommendReusableResources(db, intent, { limit: 5 });
  const after = {
    roles: db.prepare('SELECT COUNT(*) AS n FROM custom_role_versions').get().n,
    workflows: db.prepare('SELECT COUNT(*) AS n FROM custom_workflow_versions').get().n,
    policies: db.prepare('SELECT COUNT(*) AS n FROM workflow_policy_versions').get().n
  };

  assert.equal(result.read_only, true);
  assert.match(result.matching_method, /lexical/i);
  assert.equal(result.recommendations.custom_roles_and_skills[0]?.role_id, 'security-reviewer');
  assert.ok(result.recommendations.custom_roles_and_skills[0].compatible_profile_overlay_roles.includes('security'));
  assert.equal(result.recommendations.custom_workflows[0]?.workflow_id, 'security-review-flow');
  assert.equal(result.recommendations.workflow_policies[0]?.policy_id, 'security-review-gates');
  assert.equal(result.recommendations.workflow_policies[0]?.reuse_scope, 'portable_candidate');
  assert.equal(result.recommendations.workflow_policies[0]?.attachment_requires_target_plan_validation, true);
  assert.equal(result.recommendations.built_in_role_hints[0]?.role, 'security');
  assert.deepEqual(after, before, 'discovery must not create or mutate saved resources');
  assert.throws(() => recommendReusableResources(db, '   '), /non-empty/);
  assert.throws(() => recommendReusableResources(db, 'x'.repeat(12001)), /12000/);
  console.log('WORKFLOW RESOURCE RECOMMENDATION AND REUSE CONTRACT PASS');
} finally {
  db.close();
}
