import { StandardEngineeringTaskId as T } from '../definitions/standard-engineering.js';
import { getRoleContract } from '../roles.js';

const S = Object.freeze([
  { id: T.PRODUCT_OWNER, role: 'product-owner', dependencies: [] },
  { id: T.RESEARCHER, role: 'researcher', dependencies: [T.PRODUCT_OWNER] },
  { id: T.ARCHITECT, role: 'architect', dependencies: [T.PRODUCT_OWNER, T.RESEARCHER] },
  { id: T.ENGINEER, role: 'engineer', dependencies: [T.ARCHITECT] },
  { id: T.SECURITY, role: 'security', dependencies: [T.ENGINEER] },
  { id: T.QA, role: 'qa', dependencies: [T.ENGINEER] },
  { id: T.PLATFORM, role: 'platform', dependencies: [T.ENGINEER] },
  { id: T.WRITER, role: 'writer', dependencies: [T.ENGINEER] },
  { id: T.REVIEWER, role: 'reviewer', dependencies: [T.SECURITY, T.QA, T.PLATFORM, T.WRITER] }
]);

function taskSpec(spec, workspace) {
  const contract = getRoleContract(spec.role);
  return {
    id: spec.id,
    role: spec.role,
    capability: contract.capability,
    dependencies: [...spec.dependencies],
    execution: { executor: contract.executor, deterministic: false, runtime_owner: 'github-runner', execution_mode: 'agent', cwd: workspace || null, timeout_ms: 300_000 }
  };
}

export function standardEngineeringTaskSpecs(workspace = process.env.WORKFLOW_WORKSPACE || null) {
  return S.map(spec => taskSpec(spec, workspace));
}

export function standardEngineeringTaskSpec(taskId, { workspace = process.env.WORKFLOW_WORKSPACE || null } = {}) {
  if (taskId === T.CTO_SYNTHESIS) {
    const contract = getRoleContract('cto');
    return { id: taskId, role: 'cto', capability: contract.capability, dependencies: [T.REVIEWER], execution: { executor: contract.executor, deterministic: false, runtime_owner: 'github-runner', execution_mode: 'agent', cwd: workspace || null } };
  }
  const spec = standardEngineeringTaskSpecs(workspace).find(item => item.id === taskId);
  if (!spec) throw new Error(`unknown standard engineering task: ${taskId}`);
  return spec;
}

export const StandardEngineeringRoles = Object.freeze(S.map(spec => spec.role));
