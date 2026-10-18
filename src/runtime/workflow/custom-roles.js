import crypto from 'node:crypto';
import { parseStrictJson } from '../strict-json.js';
import { loadAgentSkills, MAX_SKILLS_PER_ROLE } from './agent-skills.js';

export const CUSTOM_ROLE_ARTIFACT_TYPES = Object.freeze([
  'requirements', 'research', 'architecture', 'implementation', 'security-review',
  'qa-report', 'platform-review', 'documentation', 'review', 'cto-decision'
]);

export const CUSTOM_ROLE_CAPABILITIES = Object.freeze([
  'product.requirements', 'research.collect', 'architecture.design', 'code.modify',
  'security.audit', 'code.verify', 'infrastructure.verify', 'documentation.write',
  'change.review', 'synthesis.approve'
]);

// Phase 1 deliberately excludes execution, workspace writes, and arbitrary tools.
export const CUSTOM_ROLE_PERMISSIONS = Object.freeze(['workspace.read', 'artifact.create']);
export const CUSTOM_ROLE_ALLOWED_TOOLS = Object.freeze([
  'workflow_catalog', 'workflow_list', 'workflow_get', 'workflow_events',
  'workflow_artifacts', 'workflow_validate_artifact'
]);

const MAX_PROMPT = 12000;
const MAX_DESCRIPTION = 2000;
const MAX_LIST = 32;

export function initializeCustomRoleStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS custom_role_versions (
    role_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    input_contract_json TEXT NOT NULL,
    output_artifact_type TEXT NOT NULL,
    allowed_capabilities_json TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    allowed_tools_json TEXT NOT NULL,
    skills_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY(role_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_custom_role_versions_latest ON custom_role_versions(role_id, version DESC);`);
  // Migrate existing local SQLite databases without deleting immutable role history.
  const columns = db.prepare('PRAGMA table_info(custom_role_versions)').all();
  if (!columns.some(column => column.name === 'skills_json')) {
    db.exec("ALTER TABLE custom_role_versions ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'");
  }
}

function nonEmpty(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return result;
}

function slug(value) {
  const id = nonEmpty(value, 'role_id', 80).toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) throw new Error('role_id must be a lowercase slug (letters, numbers, hyphens)');
  if (['cto', 'engineer', 'architect', 'qa', 'reviewer', 'security', 'platform', 'writer', 'researcher', 'product-owner'].includes(id) || id.startsWith('system-')) {
    throw new Error(`role_id is reserved for a built-in role or system namespace: ${id}`);
  }
  return id;
}

function stringList(value, field, allowed, { required = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > MAX_LIST) throw new Error(`${field} may contain at most ${MAX_LIST} entries`);
  const items = value.map((item, index) => nonEmpty(item, `${field}[${index}]`, 200));
  if (new Set(items).size !== items.length) throw new Error(`${field} must not contain duplicates`);
  if (required && items.length === 0) throw new Error(`${field} must contain at least one entry`);
  if (allowed) {
    const invalid = items.filter(item => !allowed.includes(item));
    if (invalid.length) throw new Error(`${field} contains unsupported value(s): ${invalid.join(', ')}`);
  }
  return items;
}

async function normalizeDefinition(input, { partial = false, base = null, skillsSnapshot = undefined } = {}) {
  const source = { ...(base || {}), ...(input || {}) };
  const pickString = (field, max) => {
    if (partial && !Object.hasOwn(input || {}, field) && base) return base[field];
    return nonEmpty(source[field], field, max);
  };
  const inputContract = partial && !Object.hasOwn(input || {}, 'input_contract') && base
    ? base.input_contract
    : stringList(source.input_contract, 'input_contract', ['job.request', ...CUSTOM_ROLE_ARTIFACT_TYPES]);
  const allowedCapabilities = partial && !Object.hasOwn(input || {}, 'allowed_capabilities') && base
    ? base.allowed_capabilities
    : stringList(source.allowed_capabilities ?? [], 'allowed_capabilities', CUSTOM_ROLE_CAPABILITIES);
  const permissions = partial && !Object.hasOwn(input || {}, 'permissions') && base
    ? base.permissions
    : stringList(source.permissions ?? ['workspace.read', 'artifact.create'], 'permissions', CUSTOM_ROLE_PERMISSIONS, { required: true });
  const allowedTools = partial && !Object.hasOwn(input || {}, 'allowed_tools') && base
    ? base.allowed_tools
    : stringList(source.allowed_tools ?? [], 'allowed_tools', CUSTOM_ROLE_ALLOWED_TOOLS);
  const skills = partial && !Object.hasOwn(input || {}, 'skills') && base
    ? base.skills
    : skillsSnapshot !== undefined ? skillsSnapshot : await loadAgentSkills(source.skills ?? []);
  if (!inputContract.length) throw new Error('input_contract must contain at least one entry');
  if (!CUSTOM_ROLE_ARTIFACT_TYPES.includes(source.output_artifact_type)) {
    throw new Error(`output_artifact_type must be one of: ${CUSTOM_ROLE_ARTIFACT_TYPES.join(', ')}`);
  }
  if (!permissions.includes('artifact.create')) throw new Error('permissions must include artifact.create');
  return {
    role_id: slug(source.role_id),
    name: pickString('name', 120),
    description: pickString('description', MAX_DESCRIPTION),
    system_prompt: pickString('system_prompt', MAX_PROMPT),
    input_contract: inputContract,
    output_artifact_type: source.output_artifact_type,
    allowed_capabilities: allowedCapabilities,
    permissions,
    allowed_tools: allowedTools,
    skills
  };
}

function rowToRole(row) {
  if (!row) return null;
  return {
    role_id: row.role_id,
    version: row.version,
    name: row.name,
    description: row.description,
    system_prompt: row.system_prompt,
    input_contract: parseStrictJson(row.input_contract_json),
    output_artifact_type: row.output_artifact_type,
    allowed_capabilities: parseStrictJson(row.allowed_capabilities_json),
    permissions: parseStrictJson(row.permissions_json),
    allowed_tools: parseStrictJson(row.allowed_tools_json),
    skills: parseStrictJson(row.skills_json || '[]'),
    created_at: row.created_at,
    created_by: row.created_by
  };
}

function insertVersion(db, definition, version, createdBy) {
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO custom_role_versions
    (role_id,version,name,description,system_prompt,input_contract_json,output_artifact_type,allowed_capabilities_json,permissions_json,allowed_tools_json,skills_json,created_at,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    definition.role_id, version, definition.name, definition.description, definition.system_prompt,
    JSON.stringify(definition.input_contract), definition.output_artifact_type,
    JSON.stringify(definition.allowed_capabilities), JSON.stringify(definition.permissions),
    JSON.stringify(definition.allowed_tools), JSON.stringify(definition.skills), createdAt, createdBy
  );
  return rowToRole(db.prepare('SELECT * FROM custom_role_versions WHERE role_id=? AND version=?').get(definition.role_id, version));
}

export async function createCustomRole(db, input, { createdBy = 'user' } = {}) {
  const definition = await normalizeDefinition(input);
  const exists = db.prepare('SELECT 1 FROM custom_role_versions WHERE role_id=? LIMIT 1').get(definition.role_id);
  if (exists) throw new Error(`custom role already exists: ${definition.role_id}; use custom_role_update to create a new version`);
  return insertVersion(db, definition, 1, nonEmpty(createdBy, 'created_by', 200));
}

export async function updateCustomRole(db, roleId, input, { createdBy = 'user' } = {}) {
  const id = slug(roleId);
  const currentRow = db.prepare('SELECT * FROM custom_role_versions WHERE role_id=? ORDER BY version DESC LIMIT 1').get(id);
  if (!currentRow) throw new Error(`custom role not found: ${id}`);
  const current = rowToRole(currentRow);
  const definition = await normalizeDefinition({ ...input, role_id: id }, { partial: true, base: current });
  if (JSON.stringify({ ...definition, role_id: id }) === JSON.stringify({
    role_id: current.role_id, name: current.name, description: current.description,
    system_prompt: current.system_prompt, input_contract: current.input_contract,
    output_artifact_type: current.output_artifact_type, allowed_capabilities: current.allowed_capabilities,
    permissions: current.permissions, allowed_tools: current.allowed_tools, skills: current.skills
  })) throw new Error('custom role update contains no changes');
  return insertVersion(db, definition, current.version + 1, nonEmpty(createdBy, 'created_by', 200));
}

export function getCustomRole(db, roleId, version) {
  const id = slug(roleId);
  if (version != null && (!Number.isInteger(version) || version < 1)) throw new Error('version must be a positive integer');
  const row = version == null
    ? db.prepare('SELECT * FROM custom_role_versions WHERE role_id=? ORDER BY version DESC LIMIT 1').get(id)
    : db.prepare('SELECT * FROM custom_role_versions WHERE role_id=? AND version=?').get(id, version);
  if (!row) throw new Error(`custom role version not found: ${id}${version == null ? '' : `@${version}`}`);
  return rowToRole(row);
}

export function listCustomRoles(db, { includeVersions = false, limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 100));
  const rows = includeVersions
    ? db.prepare('SELECT * FROM custom_role_versions ORDER BY role_id, version DESC LIMIT ?').all(safeLimit)
    : db.prepare(`SELECT v.* FROM custom_role_versions v JOIN (
        SELECT role_id, MAX(version) AS version FROM custom_role_versions GROUP BY role_id
      ) latest ON latest.role_id=v.role_id AND latest.version=v.version ORDER BY v.role_id LIMIT ?`).all(safeLimit);
  return rows.map(rowToRole);
}

export async function cloneCustomRole(db, sourceRoleId, input, { createdBy = 'user' } = {}) {
  const source = getCustomRole(db, sourceRoleId);
  const roleId = slug(input?.role_id);
  const definitionInput = {
    role_id: roleId,
    name: input?.name || `${source.name} (copy)`,
    description: input?.description || source.description,
    system_prompt: input?.system_prompt || source.system_prompt,
    input_contract: input?.input_contract || source.input_contract,
    output_artifact_type: input?.output_artifact_type || source.output_artifact_type,
    allowed_capabilities: input?.allowed_capabilities || source.allowed_capabilities,
    permissions: input?.permissions || source.permissions,
    allowed_tools: input?.allowed_tools || source.allowed_tools,
    ...(Object.hasOwn(input || {}, 'skills') ? { skills: input.skills } : {})
  };
  const definition = await normalizeDefinition(definitionInput, {
    skillsSnapshot: Object.hasOwn(input || {}, 'skills') ? undefined : source.skills
  });
  const exists = db.prepare('SELECT 1 FROM custom_role_versions WHERE role_id=? LIMIT 1').get(definition.role_id);
  if (exists) throw new Error(`custom role already exists: ${definition.role_id}; use custom_role_update to create a new version`);
  return insertVersion(db, definition, 1, nonEmpty(createdBy, 'created_by', 200));
}

export function customRoleSchema() {
  return {
    role_id: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 80 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', minLength: 1, maxLength: MAX_DESCRIPTION },
    system_prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT },
    input_contract: { type: 'array', minItems: 1, maxItems: MAX_LIST, items: { type: 'string', enum: ['job.request', ...CUSTOM_ROLE_ARTIFACT_TYPES] } },
    output_artifact_type: { type: 'string', enum: [...CUSTOM_ROLE_ARTIFACT_TYPES] },
    allowed_capabilities: { type: 'array', maxItems: MAX_LIST, items: { type: 'string', enum: [...CUSTOM_ROLE_CAPABILITIES] } },
    permissions: { type: 'array', minItems: 1, maxItems: MAX_LIST, items: { type: 'string', enum: [...CUSTOM_ROLE_PERMISSIONS] } },
    allowed_tools: { type: 'array', maxItems: MAX_LIST, items: { type: 'string', enum: [...CUSTOM_ROLE_ALLOWED_TOOLS] } },
    skills: { type: 'array', maxItems: MAX_SKILLS_PER_ROLE, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 2048, description: 'Local skill directory or public GitHub skill directory URL.' } }
  };
}

export function customRoleFingerprint(role) {
  return crypto.createHash('sha256').update(JSON.stringify(role)).digest('hex');
}
