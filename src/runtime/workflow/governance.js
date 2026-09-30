import { getAgentContract } from './agent-contracts.js';

export const SessionPermission = Object.freeze({
  OBSERVE: 'OBSERVE', MESSAGE: 'MESSAGE', EXECUTE: 'EXECUTE', TAKEOVER: 'TAKEOVER'
});

const GRANTABLE = new Set(Object.values(SessionPermission));

function canonicalRole(role) {
  const key = String(role || '').trim().toLowerCase();
  if (key === 'system') return 'system';
  if (key === 'productowner') return 'product-owner';
  getAgentContract(key);
  return key;
}

export function normalizeGovernanceRole(role) {
  return canonicalRole(role);
}

export function hasAgentPermission(role, permission) {
  const canonical = canonicalRole(role);
  if (canonical === 'system') return true;
  return getAgentContract(canonical).permissions.includes(permission);
}

export function assertAgentPermission(role, permission) {
  if (!hasAgentPermission(role, permission)) {
    throw new Error(`Agent permission denied: role=${role} permission=${permission}`);
  }
  return true;
}

export function assertSessionGrantAuthority(grantedBy, targetRole, permission) {
  const actor = canonicalRole(grantedBy);
  const target = canonicalRole(targetRole);
  const perm = String(permission || '').toUpperCase();
  if (!GRANTABLE.has(perm)) throw new Error(`Invalid session permission: ${perm}`);
  if (actor === 'system' || actor === 'cto') return true;
  if (actor === target && perm !== SessionPermission.TAKEOVER) return true;
  throw new Error(`Session grant denied: role=${grantedBy} target=${targetRole} permission=${perm}`);
}

export function assertSessionRevokeAuthority(actorRole, sessionRole, accessRole, permission) {
  const actor = canonicalRole(actorRole);
  const owner = canonicalRole(sessionRole);
  const target = canonicalRole(accessRole);
  if (actor === 'system' || actor === 'cto' || actor === owner || actor === target) return true;
  throw new Error(`Session revoke denied: role=${actorRole} target=${accessRole} permission=${permission}`);
}

