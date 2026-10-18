import { EngineeringTaskId } from '../definitions/engineering.js';
import { getRoleContract } from '../roles.js';

const SPECS = Object.freeze([
  Object.freeze({ id: EngineeringTaskId.PRODUCT_OWNER, role: 'product-owner', dependencies: [] }),
  Object.freeze({ id: EngineeringTaskId.RESEARCHER, role: 'researcher', dependencies: [EngineeringTaskId.PRODUCT_OWNER] }),
  Object.freeze({ id: EngineeringTaskId.ARCHITECT, role: 'architect', dependencies: [EngineeringTaskId.PRODUCT_OWNER, EngineeringTaskId.RESEARCHER] }),
  Object.freeze({ id: EngineeringTaskId.ENGINEER, role: 'engineer', dependencies: [EngineeringTaskId.ARCHITECT] }),
  Object.freeze({ id: EngineeringTaskId.SECURITY, role: 'security', dependencies: [EngineeringTaskId.ENGINEER] }),
  Object.freeze({ id: EngineeringTaskId.QA, role: 'qa', dependencies: [EngineeringTaskId.ENGINEER] }),
  Object.freeze({ id: EngineeringTaskId.PLATFORM, role: 'platform', dependencies: [EngineeringTaskId.ENGINEER] }),
  Object.freeze({ id: EngineeringTaskId.WRITER, role: 'writer', dependencies: [EngineeringTaskId.ENGINEER] }),
  Object.freeze({ id: EngineeringTaskId.REVIEWER, role: 'reviewer', dependencies: [EngineeringTaskId.SECURITY, EngineeringTaskId.QA, EngineeringTaskId.PLATFORM, EngineeringTaskId.WRITER] })
]);

function taskSpec(spec, workspace) {
  const contract = getRoleContract(spec.role);
  const nativeTimeoutMs = Math.max(30_000, Number(process.env.LOCAL_HOST_CHILD_TIMEOUT_MS) || 300_000);
  return {
    id: spec.id,
    role: spec.role,
    capability: contract.capability,
    dependencies: [...spec.dependencies],
    execution: {
      executor: 'ChatOnSteroidsHost',
      deterministic: false,
      runtime_owner: 'chat-on-steroids-plugin',
      execution_mode: 'host-conversation',
      cwd: workspace || null,
      timeout_ms: nativeTimeoutMs
    }
  };
}

const DEFAULT_WORKSPACE = process.env.WORKFLOW_WORKSPACE || process.cwd();

export function engineeringTaskSpecs(workspace = DEFAULT_WORKSPACE) {
  return SPECS.map(spec => taskSpec(spec, workspace));
}

export function engineeringTaskSpec(taskId, { workspace = DEFAULT_WORKSPACE } = {}) {
  if (taskId === EngineeringTaskId.CTO_SYNTHESIS) {
    const contract = getRoleContract('cto');
    return {
      id: taskId,
      role: 'cto',
      capability: contract.capability,
      dependencies: [EngineeringTaskId.REVIEWER],
      execution: { executor: contract.executor, deterministic: false, cwd: workspace || null }
    };
  }
  const spec = engineeringTaskSpecs(workspace).find(item => item.id === taskId);
  if (!spec) throw new Error(`unknown engineering task: ${taskId}`);
  return spec;
}

export const EngineeringRoles = Object.freeze(SPECS.map(spec => spec.role));
