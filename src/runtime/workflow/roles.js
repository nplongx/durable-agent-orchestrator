export const TaskCapability = Object.freeze({
  ARCHITECTURE_DESIGN: 'architecture.design',
  CODE_MODIFY: 'code.modify',
  CODE_VERIFY: 'code.verify',
  CHANGE_REVIEW: 'change.review',
  SYNTHESIS_APPROVE: 'synthesis.approve',
  PRODUCT_REQUIREMENTS: 'product.requirements',
  RESEARCH_COLLECT: 'research.collect',
  SECURITY_AUDIT: 'security.audit',
  INFRASTRUCTURE_VERIFY: 'infrastructure.verify',
  DOCUMENTATION_WRITE: 'documentation.write'
});

import { getAgentContract } from './agent-contracts.js';

const ROLE_CONTRACTS = Object.freeze({
  productowner: Object.freeze({
    role: 'productowner',
    capability: TaskCapability.PRODUCT_REQUIREMENTS,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'artifact.create'])
  }),
  'product-owner': Object.freeze({
    role: 'product-owner',
    capability: TaskCapability.PRODUCT_REQUIREMENTS,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'artifact.create'])
  }),
  researcher: Object.freeze({
    role: 'researcher',
    capability: TaskCapability.RESEARCH_COLLECT,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'artifact.create'])
  }),
  architect: Object.freeze({
    role: 'architect',
    capability: TaskCapability.ARCHITECTURE_DESIGN,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'artifact.create'])
  }),
  engineer: Object.freeze({
    role: 'engineer',
    capability: TaskCapability.CODE_MODIFY,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'workspace.write', 'execution.request', 'artifact.create'])
  }),
  qa: Object.freeze({
    role: 'qa',
    capability: TaskCapability.CODE_VERIFY,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'execution.request', 'artifact.create'])
  }),
  reviewer: Object.freeze({
    role: 'reviewer',
    capability: TaskCapability.CHANGE_REVIEW,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'artifact.create'])
  }),
  security: Object.freeze({
    role: 'security',
    capability: TaskCapability.SECURITY_AUDIT,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'artifact.create'])
  }),
  platform: Object.freeze({
    role: 'platform',
    capability: TaskCapability.INFRASTRUCTURE_VERIFY,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'artifact.create'])
  }),
  writer: Object.freeze({
    role: 'writer',
    capability: TaskCapability.DOCUMENTATION_WRITE,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'artifact.create'])
  }),
  cto: Object.freeze({
    role: 'cto',
    capability: TaskCapability.SYNTHESIS_APPROVE,
    executor: 'OpenClaw',
    permissions: Object.freeze(['workspace.read', 'artifact.create'])
  })
});

export function getRoleContract(role) {
  const key = String(role || '').toLowerCase();
  const contract = ROLE_CONTRACTS[key];
  if (!contract) throw new Error(`unknown workflow role: ${role}`);
  const canonicalRole = key === 'productowner' ? 'product-owner' : key;
  return getAgentContract(canonicalRole);
}

export function validateRoleContract(role, { capability, executor } = {}) {
  const contract = getRoleContract(role);
  if (capability && contract.capability !== capability) {
    throw new Error(`role ${role} does not support capability ${capability}`);
  }
  if (executor && contract.executor !== executor) {
    throw new Error(`role ${role} requires executor ${contract.executor}`);
  }
  return contract;
}

export { ROLE_CONTRACTS };
