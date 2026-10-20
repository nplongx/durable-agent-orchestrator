import fs from 'node:fs';
import path from 'node:path';
import { getAgentContract } from './agent-contracts.js';
import { lstatWithin, openDirectoryWithin } from '../secure-filesystem.js';

const SUPPORTED_WORKFLOW_ID = 'standard-engineering';
const MINIMUM_WORKFLOW_VERSION = 3;
const ROLES_WITH_SCOPED_WRITE = new Set(['engineer', 'writer']);
const MAX_SCOPES = 8;
const MAX_PATHS_PER_SCOPE = 16;

export class WorkspaceWriteContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspaceWriteContractError';
    this.code = code;
    this.category = details.category || 'validation_failure';
    this.details = details;
  }
}

function invalid(code, message, details = {}) {
  return new WorkspaceWriteContractError(code, message, details);
}

function normalizeRequiredOperations(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw invalid('WORKFLOW_OPERATIONS_INVALID', 'required_operations must be an array of non-empty operation IDs.');
  }
  if (new Set(value).size !== value.length) throw invalid('WORKFLOW_OPERATIONS_INVALID', 'required_operations must not contain duplicates.');
  const unsupported = value.filter(item => item !== 'workspace.write');
  if (unsupported.length) throw invalid('WORKFLOW_OPERATION_UNSUPPORTED', `Unsupported required operation(s): ${unsupported.join(', ')}.`);
  return [...value];
}

function normalizeRelativeScopePath(input) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\\') || input.includes('\0') ||
      path.posix.isAbsolute(input) || /^[A-Za-z]:/.test(input) || input.split('/').some(part => !part || part === '.' || part === '..')) {
    throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', 'Scope paths must be normalized, relative workspace paths without empty, dot, parent, absolute, or backslash segments.');
  }
  const normalized = path.posix.normalize(input);
  if (normalized !== input || normalized === '.') throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', `Scope path is not canonical: ${input}`);
  return normalized;
}

function assertWorkspaceRoot(workspace) {
  if (typeof workspace !== 'string' || !workspace.trim()) throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', 'A concrete approved workspace is required for workspace-write scopes.');
  let real;
  try { real = fs.realpathSync(workspace); }
  catch (error) { throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', `Approved workspace cannot be resolved: ${error.message}`); }
  if (path.resolve(workspace) !== real || !fs.statSync(real).isDirectory()) {
    throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', 'Approved workspace must be an existing canonical non-symlink directory.');
  }
  return real;
}

function validateScopeTarget(workspace, entry) {
  try {
    if (entry.kind === 'directory') {
      const opened = openDirectoryWithin(workspace, entry.path);
      try {
        const stat = fs.fstatSync(opened.fd);
        if (!stat.isDirectory()) throw new Error('scope target is not a directory');
      } finally { opened.close(); }
    } else {
      const stat = lstatWithin(workspace, entry.path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error('scope target must be a regular, non-symlink, single-link file');
    }
  } catch (error) {
    throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', `Cannot approve workspace write scope ${entry.path}: ${String(error?.message || error)}`, { path: entry.path });
  }
}

function scopeContains(scopeEntry, candidate) {
  if (scopeEntry.kind === 'file') return candidate === scopeEntry.path;
  return candidate.startsWith(`${scopeEntry.path}/`) && candidate.length > scopeEntry.path.length + 1;
}

export function normalizeWorkspaceWriteContract({
  workflowId,
  workflowVersion,
  workspace,
  requiredOperations = [],
  scopes = [],
  customWorkflow = false
} = {}) {
  const operations = normalizeRequiredOperations(requiredOperations);
  if (!Array.isArray(scopes) || scopes.length > MAX_SCOPES) throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', `workspace_write_scopes must be an array with at most ${MAX_SCOPES} role scopes.`);
  if (scopes.length && !operations.includes('workspace.write')) {
    throw invalid('WORKSPACE_SCOPE_WITHOUT_OPERATION', 'workspace_write_scopes require required_operations to include workspace.write.');
  }
  if (operations.includes('workspace.write') && !scopes.length) {
    throw invalid('WORKSPACE_WRITE_SCOPE_MISSING', 'workspace.write was requested but no role-specific workspace_write_scopes were declared.');
  }
  if (!operations.length && !scopes.length) return null;
  if (customWorkflow || String(workflowId || '').toLowerCase() !== SUPPORTED_WORKFLOW_ID || Number(workflowVersion) < MINIMUM_WORKFLOW_VERSION) {
    throw invalid('WORKSPACE_WRITE_UNSUPPORTED_WORKFLOW', `Scoped workspace writes require ${SUPPORTED_WORKFLOW_ID}@${MINIMUM_WORKFLOW_VERSION}+; custom workflows and other templates remain read-only for host specialists.`, { workflow_id: workflowId || null, workflow_version: Number.isInteger(Number(workflowVersion)) ? Number(workflowVersion) : null });
  }
  const canonicalWorkspace = assertWorkspaceRoot(workspace);
  const seenRoles = new Set();
  const normalizedScopes = scopes.map((scope, scopeIndex) => {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !ROLES_WITH_SCOPED_WRITE.has(scope.role)) {
      throw invalid('WORKSPACE_WRITE_ROLE_NOT_AUTHORIZED', `workspace_write_scopes[${scopeIndex}].role must be engineer or writer.`);
    }
    if (seenRoles.has(scope.role)) throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', `Only one scope entry is allowed for role ${scope.role}.`);
    seenRoles.add(scope.role);
    let contract;
    try { contract = getAgentContract(scope.role); }
    catch { throw invalid('WORKSPACE_WRITE_ROLE_NOT_AUTHORIZED', `No built-in role contract exists for ${scope.role}.`); }
    if (contract.capability !== (scope.role === 'engineer' ? 'code.modify' : 'documentation.write') || !contract.permissions.includes('workspace.write')) {
      throw invalid('WORKSPACE_WRITE_ROLE_NOT_AUTHORIZED', `Built-in role ${scope.role} does not declare the required workspace.write permission and expected capability.`);
    }
    if (!Array.isArray(scope.paths) || !scope.paths.length || scope.paths.length > MAX_PATHS_PER_SCOPE) {
      throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', `Role ${scope.role} must declare 1..${MAX_PATHS_PER_SCOPE} file or directory scope paths.`);
    }
    const seenPaths = new Set();
    const normalizedPaths = scope.paths.map((input, index) => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !['file', 'directory'].includes(input.kind)) {
        throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', `Scope path ${scope.role}[${index}] must declare kind=file or kind=directory.`);
      }
      const scopePath = normalizeRelativeScopePath(input.path);
      const key = `${input.kind}:${scopePath}`;
      if (seenPaths.has(key)) throw invalid('WORKSPACE_WRITE_SCOPE_INVALID', `Duplicate ${input.kind} scope path for ${scope.role}: ${scopePath}.`);
      seenPaths.add(key);
      const entry = { path: scopePath, kind: input.kind };
      validateScopeTarget(canonicalWorkspace, entry);
      return entry;
    });
    return { role: scope.role, paths: normalizedPaths };
  });

  // Prevent two roles from independently authorizing the same file tree. A
  // parent directory and its descendants overlap; reject cross-role overlap
  // rather than relying on agent discipline to resolve ownership ambiguity.
  for (let left = 0; left < normalizedScopes.length; left++) {
    for (let right = left + 1; right < normalizedScopes.length; right++) {
      for (const a of normalizedScopes[left].paths) for (const b of normalizedScopes[right].paths) {
        const aContainsB = a.kind === 'file' ? a.path === b.path : b.path.startsWith(`${a.path}/`) || b.path === a.path;
        const bContainsA = b.kind === 'file' ? b.path === a.path : a.path.startsWith(`${b.path}/`) || a.path === b.path;
        if (aContainsB || bContainsA) throw invalid('WORKSPACE_WRITE_SCOPE_OVERLAP', `Workspace write scopes overlap across roles ${normalizedScopes[left].role} and ${normalizedScopes[right].role}.`, { paths: [a.path, b.path] });
      }
    }
  }
  return {
    version: 1,
    required_operations: operations,
    scopes: normalizedScopes,
    mode: 'scoped-atomic-file-replacement',
    max_file_bytes: 2_000_000,
    allowed_side_effects: ['create regular files inside an existing approved directory', 'atomically replace existing regular files in approved scope'],
    forbidden_side_effects: ['arbitrary command execution', 'delete files', 'rename paths', 'create directories', 'follow symlinks', 'write outside approved scope'],
    precondition: 'sha256 compare-before-write; use ABSENT only for exclusive creation',
    recovery: 'durable per-file receipt; idempotent replay by patch_id and path; report partial writes explicitly'
  };
}

export function pathIsWithinWorkspaceWriteScope(candidate, scope) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\\') || candidate.includes('\0') ||
      path.posix.isAbsolute(candidate) || candidate.split('/').some(part => !part || part === '.' || part === '..')) return false;
  const normalized = path.posix.normalize(candidate);
  if (normalized !== candidate) return false;
  const entries = Array.isArray(scope?.paths) ? scope.paths : [scope];
  return entries.some(entry => entry && ['file', 'directory'].includes(entry.kind) && typeof entry.path === 'string' && scopeContains(entry, normalized));
}

export function workspaceWriteScopeForRole(contract, role) {
  return contract?.required_operations?.includes('workspace.write')
    ? contract.scopes?.find(scope => scope.role === role) || null
    : null;
}
