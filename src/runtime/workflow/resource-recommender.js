import { listCustomRoles } from './custom-roles.js';
import { listCustomWorkflows } from './custom-workflows.js';
import { listWorkflowPolicies } from './policy-contract.js';
import { getAgentContract } from './agent-contracts.js';
import { BUILTIN_ROLE_PROFILE_OVERLAY_ROLES, normalizeRoleProfileBindings } from './role-profiles.js';

const STOP_WORDS = new Set((
  'about after all also am an and any are as at be been before being between both but by can could did do does doing down during each for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves '
  + 'cua bao cach cac cho chinh chung cung da dang de den dieu duoc gi gio hay ho hoac khi khong la lam len lieu moi mot nay neu nhieu nhung nhu noi o ong qua ra rat sau se theo thi trong tu tren toi tuyen va vao voi vi ve xu ly yeu cau viec '
).split(/\s+/));

const SYNONYM_GROUPS = Object.freeze([
  ['security', 'bảo mật', 'bao mat', 'an toàn', 'an toan', 'vulnerability', 'threat', 'audit'],
  ['test', 'testing', 'kiểm thử', 'kiem thu', 'qa', 'verify', 'verification', 'regression'],
  ['documentation', 'docs', 'tài liệu', 'tai lieu', 'viết tài liệu', 'viet tai lieu', 'writer'],
  ['research', 'nghiên cứu', 'nghien cuu', 'investigate', 'investigation', 'source'],
  ['architecture', 'kiến trúc', 'kien truc', 'design', 'interfaces', 'tradeoffs'],
  ['implementation', 'implement', 'triển khai', 'trien khai', 'code', 'coding', 'bug', 'fix', 'engineer'],
  ['policy', 'chính sách', 'chinh sach', 'quy định', 'quy dinh', 'guardrail', 'constraint'],
  ['recovery', 'phục hồi', 'phuc hoi', 'rollback', 'retry', 'repair'],
  ['workflow', 'quy trình', 'quy trinh', 'pipeline', 'process'],
  ['skill', 'kỹ năng', 'ky nang', 'instructions', 'playbook'],
  ['role', 'vai trò', 'vai tro', 'specialist', 'persona']
]);

const BUILTIN_ROLE_CUES = Object.freeze({
  'product-owner': 'requirements scope acceptance criteria product need non goals',
  researcher: 'research investigation sources evidence explore understand discover',
  architect: 'architecture design interfaces modules tradeoffs failure modes',
  engineer: 'implementation code change implement fix bug refactor build',
  security: 'security audit vulnerability threat authentication authorization trust boundary',
  qa: 'test testing verification regression acceptance checks validation',
  platform: 'platform runtime packaging deployment operations recovery rollback',
  writer: 'documentation docs guide reference examples user instructions',
  reviewer: 'review diff independent findings correctness evidence scope'
});

function normalizeText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function tokens(value) {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu)?.filter(token =>
    (token.length >= 3 || ['ai', 'qa', 'ux', 'ui', 'db', 'api'].includes(token)) && !STOP_WORDS.has(token)
  ) || [];
}

function expandQuery(query) {
  const normalized = normalizeText(query);
  const expanded = new Set(tokens(query));
  for (const group of SYNONYM_GROUPS) {
    const normalizedAliases = group.map(normalizeText);
    const matches = normalizedAliases.some(alias => alias.includes(' ')
      ? normalized.includes(alias)
      : expanded.has(alias));
    if (matches) for (const alias of group) for (const token of tokens(alias)) expanded.add(token);
  }
  return { original: new Set(tokens(query)), expanded };
}

function scoreResource(query, { primary = '', secondary = '', id = '' } = {}) {
  const { original, expanded } = query;
  if (original.size === 0) return null;
  const primaryTokens = new Set(tokens(`${primary} ${id}`));
  const allTokens = new Set(tokens(`${primary} ${id} ${secondary}`));
  const matchedOriginal = [...original].filter(token => allTokens.has(token));
  const matchedExpanded = [...expanded].filter(token => allTokens.has(token));
  if (matchedExpanded.length === 0) return null;
  const coverage = Math.min(1, matchedExpanded.length / Math.max(1, Math.min(original.size, 6)));
  const primaryCoverage = Math.min(1, [...primaryTokens].filter(token => expanded.has(token)).length / Math.max(1, Math.min(primaryTokens.size, 5)));
  const score = Math.min(1, coverage * 0.78 + primaryCoverage * 0.22);
  return {
    score: Number(score.toFixed(3)),
    confidence: score >= 0.5 ? 'high' : score >= 0.27 ? 'medium' : 'low',
    matched_terms: [...new Set([...matchedOriginal, ...matchedExpanded])].slice(0, 8)
  };
}

function policyReuseScope(policy) {
  const rules = [...(policy.constraints || []), ...(policy.success_criteria || [])];
  const contextBoundTypes = new Set(['workflow_id_equals', 'task_status_equals', 'execution_exit_code_equals', 'task_role_present', 'task_role_absent']);
  if (rules.some(rule => contextBoundTypes.has(rule.type))) {
    return {
      reuse_scope: 'context_bound',
      reuse_note: 'Contains workflow-, task-, or role-specific predicates; inspect and validate against the target plan before attaching.'
    };
  }
  if (rules.some(rule => rule.type.startsWith('artifact_field_') || rule.producer_role)) {
    return {
      reuse_scope: 'compatible_subject_to_plan_validation',
      reuse_note: 'Contains artifact field or producer assumptions; reuse only when artifact schema and producer evidence match.'
    };
  }
  return {
    reuse_scope: 'portable_candidate',
    reuse_note: 'Uses workflow-wide predicates, but still run target-plan compatibility validation before attaching.'
  };
}

function compatibleOverlayRoles(db, role) {
  const compatible = [];
  for (const builtInRole of BUILTIN_ROLE_PROFILE_OVERLAY_ROLES) {
    try {
      normalizeRoleProfileBindings(db, 'standard-engineering', [{
        role: builtInRole,
        custom_role_id: role.role_id,
        custom_role_version: role.version
      }]);
      compatible.push(builtInRole);
    } catch {
      // An incompatible output/input contract is not an overlay candidate.
    }
  }
  return compatible;
}

function rank(items, query, { limit, type, toCandidate }) {
  return items.map(item => {
    const candidate = toCandidate(item);
    const relevance = scoreResource(query, candidate.search);
    if (!relevance || relevance.score < 0.14) return null;
    return { ...candidate.value, ...relevance, resource_type: type };
  }).filter(Boolean).sort((a, b) => b.score - a.score || String(a.id || a.policy_id || a.role_id || a.workflow_id).localeCompare(String(b.id || b.policy_id || b.role_id || b.workflow_id))).slice(0, limit);
}

/**
 * Read-only lexical discovery of reusable Runalith resources for an intent.
 * Recommendations never attach policies, alter roles, or authorize execution.
 */
export function recommendReusableResources(db, task, { limit = 5 } = {}) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('task must be a non-empty string');
  if (task.length > 12000) throw new Error('task exceeds 12000 characters');
  const safeLimit = Math.max(1, Math.min(10, Number.isSafeInteger(limit) ? limit : 5));
  const query = expandQuery(task.trim());
  const roles = listCustomRoles(db, { includeVersions: false, limit: 200 });
  const workflows = listCustomWorkflows(db, { includeVersions: false, limit: 200 });
  const policies = listWorkflowPolicies(db, { includeVersions: false, limit: 200 }).items;

  const recommendedRoles = rank(roles, query, {
    limit: safeLimit, type: 'custom_role',
    toCandidate: role => ({
      search: {
        id: role.role_id,
        primary: `${role.name} ${role.role_id}`,
        secondary: `${role.description} ${(role.allowed_capabilities || []).join(' ')} ${(role.input_contract || []).join(' ')} ${role.output_artifact_type} ${(role.skills || []).map(skill => `${skill.name} ${skill.description}`).join(' ')}`
      },
      value: {
        role_id: role.role_id, version: role.version, name: role.name,
        description: role.description, input_contract: role.input_contract,
        output_artifact_type: role.output_artifact_type,
        allowed_capabilities: role.allowed_capabilities,
        skill_hints: (role.skills || []).map(skill => ({ name: skill.name, description: skill.description, sha256: skill.sha256 })),
        compatible_profile_overlay_roles: compatibleOverlayRoles(db, role),
        reusable_as: 'custom workflow role; or immutable profile overlay on a compatible built-in role',
        execution_authorized: false
      }
    })
  });

  const recommendedWorkflows = rank(workflows, query, {
    limit: safeLimit, type: 'custom_workflow',
    toCandidate: workflow => ({
      search: {
        id: workflow.workflow_id,
        primary: `${workflow.name} ${workflow.workflow_id}`,
        secondary: `${workflow.description} ${(workflow.input_contract || []).join(' ')} ${(workflow.tasks || []).map(taskSpec => `${taskSpec.id} ${taskSpec.role_id} ${taskSpec.output_artifact_type} ${(taskSpec.input_contract || []).join(' ')}`).join(' ')}`
      },
      value: {
        workflow_id: workflow.workflow_id, version: workflow.version,
        name: workflow.name, description: workflow.description,
        input_contract: workflow.input_contract,
        tasks: (workflow.tasks || []).map(taskSpec => ({ task_id: taskSpec.id, role_id: taskSpec.role_id, role_version: taskSpec.role_version, output_artifact_type: taskSpec.output_artifact_type })),
        reuse_note: 'Review the current version and preview its pinned contract before use; preview/run approvals remain separate.'
      }
    })
  });

  const recommendedPolicies = rank(policies, query, {
    limit: safeLimit, type: 'workflow_policy',
    toCandidate: policy => {
      const scope = policyReuseScope(policy);
      return {
        search: {
          id: policy.policy_id,
          primary: `${policy.name} ${policy.policy_id}`,
          secondary: `${policy.description} ${[...(policy.constraints || []), ...(policy.success_criteria || [])].map(rule => `${rule.type} ${rule.id} ${rule.role || ''} ${rule.task_id || ''} ${rule.artifact_type || ''} ${rule.field || ''} ${rule.expected ?? ''}`).join(' ')}`
        },
        value: {
          policy_id: policy.policy_id, version: policy.version,
          name: policy.name, description: policy.description,
          content_hash: policy.content_hash,
          rule_types: [...new Set([...(policy.constraints || []), ...(policy.success_criteria || [])].map(rule => rule.type))],
          ...scope,
          auto_attach_candidate: scope.reuse_scope === 'portable_candidate',
          attachment_requires_target_plan_validation: true
        }
      };
    }
  });

  const builtInRoleHints = rank(Object.entries(BUILTIN_ROLE_CUES).map(([role, cues]) => ({ role, cues })), query, {
    limit: Math.min(5, safeLimit), type: 'built_in_role_hint',
    toCandidate: item => ({
      search: { id: item.role, primary: `${item.role} ${getAgentContract(item.role).capability}`, secondary: `${item.cues} ${getAgentContract(item.role).inputs.join(' ')} ${getAgentContract(item.role).outputs.join(' ')}` },
      value: { role: item.role, capability: getAgentContract(item.role).capability, inputs: getAgentContract(item.role).inputs, outputs: getAgentContract(item.role).outputs, guidance: item.cues }
    })
  });

  return {
    read_only: true,
    task_fingerprint: query.original.size ? [...query.original].sort().join(' ').slice(0, 240) : '',
    matching_method: 'deterministic lexical overlap with Vietnamese-English phrase expansion; not semantic model inference',
    recommendations: {
      custom_workflows: recommendedWorkflows,
      custom_roles_and_skills: recommendedRoles,
      workflow_policies: recommendedPolicies,
      built_in_role_hints: builtInRoleHints
    },
    selection_rules: [
      'Prefer a high-confidence, contract-compatible existing resource over creating a near-duplicate.',
      'Treat low-confidence matches as discovery hints only; do not force-fit them.',
      'Use custom roles in custom workflows, or as role-profile overlays only when input/output contract compatibility is confirmed.',
      'A policy recommendation is not an attachment. Validate against the actual target plan, attach an exact immutable version before approval, and show the added constraints in the plan summary.',
      'Skills are supplemental instructions pinned with a selected role; they do not grant tools, permissions, or filesystem access.',
      'No recommendation creates, attaches, approves, dispatches, edits files, or grants execution authorization.'
    ]
  };
}
