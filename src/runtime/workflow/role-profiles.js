import crypto from 'node:crypto';
import { getCustomRole } from './custom-roles.js';
import { getAgentArtifactType, getAgentContract } from './agent-contracts.js';

// Profile overlays are behavior/knowledge add-ons only. They never replace a
// built-in role contract or authorize the profile's declared permissions/tools.
export const BUILTIN_ROLE_PROFILE_OVERLAY_ROLES = Object.freeze([
  'product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa',
  'platform', 'writer', 'reviewer'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export function roleProfileSnapshot(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('custom role profile snapshot is required');
  }
  return {
    role_id: profile.role_id,
    version: profile.version,
    name: profile.name,
    system_prompt: profile.system_prompt,
    input_contract: profile.input_contract,
    output_artifact_type: profile.output_artifact_type,
    skills: Array.isArray(profile.skills) ? profile.skills : []
  };
}

export function roleProfileHash(profile) {
  return sha256(canonicalJson(roleProfileSnapshot(profile)));
}

function validateTargetRole(role) {
  if (!BUILTIN_ROLE_PROFILE_OVERLAY_ROLES.includes(role)) {
    throw new Error(`role profile overlays are not supported for built-in role: ${role}`);
  }
  return getAgentContract(role);
}

function validateContractCompatibility(role, profile) {
  const contract = validateTargetRole(role);
  const expectedOutput = getAgentArtifactType(role);
  if (profile.output_artifact_type !== expectedOutput) {
    throw new Error(`custom role ${profile.role_id}@${profile.version} output type ${profile.output_artifact_type} does not match built-in role ${role} output ${expectedOutput}`);
  }
  const declaredInputs = new Set(Array.isArray(profile.input_contract) ? profile.input_contract : []);
  const missingInputs = contract.inputs.filter(input => !declaredInputs.has(input));
  if (missingInputs.length) {
    throw new Error(`custom role ${profile.role_id}@${profile.version} input contract does not cover built-in role ${role} inputs: ${missingInputs.join(', ')}`);
  }
  if (typeof profile.system_prompt !== 'string' || !profile.system_prompt.trim()) {
    throw new Error(`custom role ${profile.role_id}@${profile.version} system_prompt is required`);
  }
  if (!Array.isArray(profile.skills)) throw new Error(`custom role ${profile.role_id}@${profile.version} skills snapshot is invalid`);
}

export function normalizeRoleProfileBindings(db, workflowId, bindings = []) {
  if (!Array.isArray(bindings)) throw new Error('role_bindings must be an array');
  if (bindings.length > BUILTIN_ROLE_PROFILE_OVERLAY_ROLES.length) {
    throw new Error(`role_bindings may contain at most ${BUILTIN_ROLE_PROFILE_OVERLAY_ROLES.length} entries`);
  }
  if (bindings.length && !['standard-engineering', 'hybrid-engineering'].includes(workflowId)) {
    throw new Error('role_bindings are currently supported only for standard-engineering and hybrid-engineering workflows');
  }

  const seenRoles = new Set();
  return bindings.map((binding, index) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new Error(`role_bindings[${index}] must be an object`);
    }
    const keys = Object.keys(binding).sort();
    const expectedKeys = ['custom_role_id', 'custom_role_version', 'role'];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`role_bindings[${index}] must contain only role, custom_role_id, and custom_role_version`);
    }
    const { role, custom_role_id: roleId, custom_role_version: version } = binding;
    if (typeof role !== 'string' || !BUILTIN_ROLE_PROFILE_OVERLAY_ROLES.includes(role)) {
      throw new Error(`role_bindings[${index}].role is not a supported built-in specialist role`);
    }
    if (seenRoles.has(role)) throw new Error(`duplicate role profile binding for built-in role: ${role}`);
    seenRoles.add(role);
    if (typeof roleId !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(roleId) || roleId.length > 80) {
      throw new Error(`role_bindings[${index}].custom_role_id must be a lowercase role slug`);
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error(`role_bindings[${index}].custom_role_version must be a positive integer; latest is not implicit`);
    }
    const profile = getCustomRole(db, roleId, version);
    validateContractCompatibility(role, profile);
    return { role, custom_role_id: profile.role_id, custom_role_version: profile.version, profile_hash: roleProfileHash(profile) };
  });
}

export function resolveRoleProfileBindings(db, bindings = []) {
  if (!Array.isArray(bindings)) throw new Error('persisted role profile bindings are invalid');
  const seenRoles = new Set();
  return bindings.map((binding, index) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        !BUILTIN_ROLE_PROFILE_OVERLAY_ROLES.includes(binding.role) ||
        typeof binding.custom_role_id !== 'string' || !Number.isSafeInteger(binding.custom_role_version) ||
        binding.custom_role_version < 1 || !/^[a-f0-9]{64}$/.test(binding.profile_hash || '')) {
      throw new Error(`persisted role profile binding ${index} is malformed`);
    }
    if (seenRoles.has(binding.role)) throw new Error(`duplicate persisted role profile binding for ${binding.role}`);
    seenRoles.add(binding.role);
    const profile = getCustomRole(db, binding.custom_role_id, binding.custom_role_version);
    validateContractCompatibility(binding.role, profile);
    const computedHash = roleProfileHash(profile);
    if (computedHash !== binding.profile_hash) {
      throw new Error(`custom role profile snapshot hash mismatch: ${binding.custom_role_id}@${binding.custom_role_version}`);
    }
    return { role: binding.role, profile: roleProfileSnapshot(profile), profile_hash: computedHash };
  });
}

export function createRoleProfileOverlay(role, profile, profileHash = roleProfileHash(profile)) {
  validateContractCompatibility(role, profile);
  const overlay = { role, ...roleProfileSnapshot(profile), profile_hash: profileHash };
  validateRoleProfileOverlay(role, overlay);
  return overlay;
}

export function validateRoleProfileOverlay(role, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay) || overlay.role !== role) {
    throw new Error(`execution role profile overlay does not match built-in task role ${role}`);
  }
  if (typeof overlay.role_id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(overlay.role_id) ||
      !Number.isSafeInteger(overlay.version) || overlay.version < 1 || typeof overlay.name !== 'string' ||
      !overlay.name.trim() || typeof overlay.system_prompt !== 'string' || !overlay.system_prompt.trim() ||
      !Array.isArray(overlay.input_contract) || !Array.isArray(overlay.skills) ||
      typeof overlay.output_artifact_type !== 'string' || !/^[a-f0-9]{64}$/.test(overlay.profile_hash || '')) {
    throw new Error(`execution role profile overlay for ${role} has an invalid snapshot schema`);
  }
  validateContractCompatibility(role, overlay);
  const computedHash = roleProfileHash(overlay);
  if (computedHash !== overlay.profile_hash) {
    throw new Error(`execution role profile overlay hash mismatch for ${role} (${overlay.role_id}@${overlay.version}): expected ${overlay.profile_hash}, computed ${computedHash}`);
  }
  return true;
}
