const CONTRACTS = Object.freeze({
  'product-owner': {
    id: 'agent.product-owner', version: 1, role: 'product-owner', capability: 'product.requirements',
    executor: 'OpenClaw', inputs: ['job.request'], outputs: ['requirements'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['scope_defined', 'acceptance_criteria_defined', 'non_goals_defined']
  },
  researcher: {
    id: 'agent.researcher', version: 1, role: 'researcher', capability: 'research.collect',
    executor: 'OpenClaw', inputs: ['requirements'], outputs: ['research'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['findings_recorded', 'sources_or_code_references_recorded', 'limitations_recorded']
  },
  architect: {
    id: 'agent.architect', version: 1, role: 'architect', capability: 'architecture.design',
    executor: 'OpenClaw', inputs: ['requirements', 'research'], outputs: ['architecture'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['components_defined', 'interfaces_defined', 'failure_modes_defined', 'implementation_boundary_defined']
  },
  engineer: {
    id: 'agent.engineer', version: 1, role: 'engineer', capability: 'code.modify',
    executor: 'OpenClaw', inputs: ['requirements', 'architecture'], outputs: ['implementation'],
    permissions: ['workspace.read', 'workspace.write', 'execution.request', 'artifact.create'], allowedTools: [],
    completionCriteria: ['approved_scope_implemented', 'tests_or_verification_run', 'implementation_evidence_recorded']
  },
  security: {
    id: 'agent.security', version: 1, role: 'security', capability: 'security.audit',
    executor: 'OpenClaw', inputs: ['requirements', 'architecture', 'implementation'], outputs: ['security-review'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['threats_reviewed', 'security_findings_recorded', 'decision_recorded']
  },
  qa: {
    id: 'agent.qa', version: 1, role: 'qa', capability: 'code.verify',
    executor: 'OpenClaw', inputs: ['requirements', 'architecture', 'implementation'], outputs: ['qa-report'], permissions: ['workspace.read', 'execution.request', 'artifact.create'],
    allowedTools: [], completionCriteria: ['acceptance_checks_run', 'actual_results_recorded', 'failures_recorded_or_none']
  },
  platform: {
    id: 'agent.platform', version: 1, role: 'platform', capability: 'infrastructure.verify',
    executor: 'OpenClaw', inputs: ['architecture', 'implementation'], outputs: ['platform-review'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['runtime_reviewed', 'deployment_reviewed', 'rollback_or_recovery_reviewed']
  },
  writer: {
    id: 'agent.writer', version: 1, role: 'writer', capability: 'documentation.write',
    executor: 'OpenClaw', inputs: ['requirements', 'implementation'], outputs: ['documentation'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['docs_match_implementation', 'user_facing_changes_documented']
  },
  reviewer: {
    id: 'agent.reviewer', version: 1, role: 'reviewer', capability: 'change.review',
    executor: 'OpenClaw', inputs: ['requirements', 'architecture', 'implementation', 'security-review', 'qa-report', 'platform-review', 'documentation'], outputs: ['review'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['all_required_evidence_reconciled', 'blocking_findings_recorded', 'decision_recorded']
  },
  cto: {
    id: 'agent.cto', version: 1, role: 'cto', capability: 'synthesis.approve',
    executor: 'OpenClaw', inputs: ['requirements', 'architecture', 'implementation', 'security-review', 'qa-report', 'platform-review', 'documentation', 'review'], outputs: ['cto-decision'], permissions: ['workspace.read', 'artifact.create'],
    allowedTools: [], completionCriteria: ['decision_recorded', 'risks_recorded', 'follow_up_actions_recorded']
  }
});

const ROLE_ARTIFACT_TYPES = Object.freeze({
  'product-owner': 'requirements', researcher: 'research', architect: 'architecture', engineer: 'implementation',
  security: 'security-review', qa: 'qa-report', platform: 'platform-review', writer: 'documentation', reviewer: 'review', cto: 'cto-decision'
});

function immutableContract(contract) {
  return Object.freeze({
    ...contract,
    inputs: Object.freeze([...contract.inputs]),
    outputs: Object.freeze([...contract.outputs]),
    permissions: Object.freeze([...contract.permissions]),
    allowedTools: Object.freeze([...contract.allowedTools]),
    completionCriteria: Object.freeze([...contract.completionCriteria])
  });
}

const IMMUTABLE_CONTRACTS = Object.freeze(Object.fromEntries(
  Object.entries(CONTRACTS).map(([role, contract]) => [role, immutableContract(contract)])
));

export function getAgentContract(role) {
  const key = String(role || '').toLowerCase();
  const contract = IMMUTABLE_CONTRACTS[key];
  if (!contract) throw new Error(`unknown agent contract: ${role}`);
  return contract;
}

export function listAgentContracts() {
  return Object.freeze(Object.values(IMMUTABLE_CONTRACTS));
}

export function getAgentArtifactType(role) {
  const key = String(role || '').toLowerCase();
  const type = ROLE_ARTIFACT_TYPES[key === 'productowner' ? 'product-owner' : key];
  if (!type) throw new Error(`unknown agent role: ${role}`);
  return type;
}

const INPUT_ARTIFACT_TYPES = Object.freeze({
  requirements: 'requirements',
  research: 'research',
  architecture: 'architecture',
  implementation: 'implementation',
  'security-review': 'security-review',
  'qa-report': 'qa-report',
  'platform-review': 'platform-review',
  documentation: 'documentation',
  review: 'review'
});

export function getAgentInputArtifactTypes(role) {
  const contract = getAgentContract(role);
  return Object.freeze(contract.inputs.map(input => INPUT_ARTIFACT_TYPES[input]).filter(Boolean));
}

export function validateAgentContract(contract) {
  if (!contract || typeof contract !== 'object') throw new Error('agent contract is required');
  for (const field of ['id', 'role', 'capability', 'executor']) {
    if (!String(contract[field] || '').trim()) throw new Error(`agent contract ${field} is required`);
  }
  if (!Number.isInteger(contract.version) || contract.version < 1) throw new Error(`invalid agent contract version: ${contract.version}`);
  for (const field of ['inputs', 'outputs', 'permissions', 'allowedTools', 'completionCriteria']) {
    if (!Array.isArray(contract[field])) throw new Error(`agent contract ${field} must be an array`);
    if (contract[field].some(item => typeof item !== 'string' || !item.trim())) throw new Error(`agent contract ${field} contains an invalid entry`);
  }
  if (!/^agent\.[a-z0-9-]+$/.test(contract.id)) throw new Error(`invalid agent contract id: ${contract.id}`);
  return true;
}

for (const contract of Object.values(IMMUTABLE_CONTRACTS)) validateAgentContract(contract);

export { IMMUTABLE_CONTRACTS as AGENT_CONTRACTS };
