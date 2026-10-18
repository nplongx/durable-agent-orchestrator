import crypto from 'node:crypto';
import { getCustomRole } from './custom-roles.js';
import { parseStrictJson } from '../strict-json.js';

const ARTIFACT_TYPES = Object.freeze([
  'requirements', 'research', 'architecture', 'implementation', 'security-review',
  'qa-report', 'platform-review', 'documentation', 'review', 'cto-decision'
]);
const MAX_TASKS = 32;

export function initializeCustomWorkflowStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS custom_workflow_versions (
    workflow_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1),
    name TEXT NOT NULL, description TEXT NOT NULL, input_contract_json TEXT NOT NULL,
    tasks_json TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
    PRIMARY KEY(workflow_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_custom_workflow_versions_latest ON custom_workflow_versions(workflow_id, version DESC);
  CREATE TABLE IF NOT EXISTS custom_workflow_plans (
    plan_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_version INTEGER NOT NULL,
    plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL, created_at TEXT NOT NULL,
    approved_at TEXT, approved_by TEXT, approval_confirmation TEXT,
    FOREIGN KEY(workflow_id, workflow_version) REFERENCES custom_workflow_versions(workflow_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_custom_workflow_plans_workflow ON custom_workflow_plans(workflow_id, created_at DESC);`);
}

function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return result;
}
function slug(value, field = 'workflow_id') {
  const result = text(value, field, 80);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(result)) throw new Error(`${field} must be a lowercase slug`);
  if (['engineering', 'standard-engineering', 'production'].includes(result)) throw new Error(`${field} conflicts with a built-in workflow`);
  return result;
}
function stringList(value, field, allowed, { required = false } = {}) {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${field} must be an array with at most 32 entries`);
  const list = value.map((item, index) => text(item, `${field}[${index}]`, 120));
  if (new Set(list).size !== list.length) throw new Error(`${field} must not contain duplicates`);
  if (required && !list.length) throw new Error(`${field} must contain at least one entry`);
  if (allowed && list.some(item => !allowed.includes(item))) throw new Error(`${field} contains unsupported values`);
  return list;
}
function normalize(input, db) {
  const workflowId = slug(input.workflow_id);
  const name = text(input.name, 'name', 120);
  const description = text(input.description, 'description', 2000);
  const inputContract = stringList(input.input_contract, 'input_contract', ['job.request', ...ARTIFACT_TYPES], { required: true });
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > MAX_TASKS) throw new Error(`tasks must contain 1-${MAX_TASKS} entries`);
  const ids = new Set();
  const tasks = input.tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error(`tasks[${index}] must be an object`);
    const unsupported = Object.keys(task).filter(key => !['id', 'role_id', 'role_version', 'depends_on', 'input_contract', 'output_artifact_type'].includes(key));
    if (unsupported.length) throw new Error(`tasks[${index}] contains unsupported fields: ${unsupported.join(', ')}`);
    const id = slug(task.id, `tasks[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate task id: ${id}`);
    ids.add(id);
    const roleId = slug(task.role_id, `tasks[${index}].role_id`);
    const role = getCustomRole(db, roleId, task.role_version);
    const taskInput = stringList(task.input_contract ?? role.input_contract, `tasks[${index}].input_contract`, ['job.request', ...ARTIFACT_TYPES], { required: true });
    const unsupportedInputs = taskInput.filter(type => !role.input_contract.includes(type));
    if (unsupportedInputs.length) throw new Error(`task ${id} input contract is not supported by role ${roleId}@${role.version}: ${unsupportedInputs.join(', ')}`);
    const output = task.output_artifact_type ?? role.output_artifact_type;
    if (!ARTIFACT_TYPES.includes(output)) throw new Error(`tasks[${index}].output_artifact_type is unsupported`);
    if (output !== role.output_artifact_type) throw new Error(`task ${id} output type ${output} does not match pinned role ${roleId}@${role.version} output ${role.output_artifact_type}`);
    return { id, role_id: roleId, role_version: role.version, input_contract: taskInput, output_artifact_type: output, depends_on: stringList(task.depends_on ?? [], `tasks[${index}].depends_on`) };
  });
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) for (const dep of task.depends_on) {
    if (!byId.has(dep)) throw new Error(`task ${task.id} depends on unknown task: ${dep}`);
    if (!task.input_contract.includes(byId.get(dep).output_artifact_type)) throw new Error(`task ${task.id} input contract must include predecessor artifact type ${byId.get(dep).output_artifact_type} from ${dep}`);
  }
  const visiting = new Set(); const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`dependency cycle detected at task: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).depends_on) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  for (const task of tasks) visit(task.id);
  return { workflow_id: workflowId, name, description, input_contract: inputContract, tasks };
}
function rowToWorkflow(row) {
  return { workflow_id: row.workflow_id, version: row.version, name: row.name, description: row.description, input_contract: parseStrictJson(row.input_contract_json), tasks: parseStrictJson(row.tasks_json), created_at: row.created_at, created_by: row.created_by };
}
function latestRow(db, id) { return db.prepare('SELECT * FROM custom_workflow_versions WHERE workflow_id=? ORDER BY version DESC LIMIT 1').get(id); }
function insertVersion(db, definition, version, createdBy) {
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO custom_workflow_versions (workflow_id,version,name,description,input_contract_json,tasks_json,created_at,created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(definition.workflow_id, version, definition.name, definition.description, JSON.stringify(definition.input_contract), JSON.stringify(definition.tasks), createdAt, text(createdBy, 'created_by', 200));
  return rowToWorkflow(db.prepare('SELECT * FROM custom_workflow_versions WHERE workflow_id=? AND version=?').get(definition.workflow_id, version));
}
export function createCustomWorkflow(db, input, { createdBy = 'user' } = {}) {
  const definition = normalize(input, db);
  if (db.prepare('SELECT 1 FROM custom_workflow_versions WHERE workflow_id=? LIMIT 1').get(definition.workflow_id)) throw new Error(`custom workflow already exists: ${definition.workflow_id}`);
  return insertVersion(db, definition, 1, createdBy);
}
export function updateCustomWorkflow(db, workflowId, input, { createdBy = 'user' } = {}) {
  const id = slug(workflowId);
  const currentRow = latestRow(db, id);
  if (!currentRow) throw new Error(`custom workflow not found: ${id}`);
  const definition = normalize({ ...input, workflow_id: id }, db);
  const current = rowToWorkflow(currentRow);
  if (JSON.stringify({ ...definition, workflow_id: id }) === JSON.stringify({ workflow_id: current.workflow_id, name: current.name, description: current.description, input_contract: current.input_contract, tasks: current.tasks })) throw new Error('custom workflow update contains no changes');
  return insertVersion(db, definition, current.version + 1, createdBy);
}
export function getCustomWorkflow(db, workflowId, version) {
  const id = slug(workflowId);
  if (version != null && (!Number.isInteger(version) || version < 1)) throw new Error('version must be a positive integer');
  const row = version == null ? latestRow(db, id) : db.prepare('SELECT * FROM custom_workflow_versions WHERE workflow_id=? AND version=?').get(id, version);
  if (!row) throw new Error(`custom workflow version not found: ${id}${version == null ? '' : `@${version}`}`);
  return rowToWorkflow(row);
}
export function listCustomWorkflows(db, { includeVersions = false, limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 100));
  const rows = includeVersions
    ? db.prepare('SELECT * FROM custom_workflow_versions ORDER BY workflow_id, version DESC LIMIT ?').all(safeLimit)
    : db.prepare(`SELECT v.* FROM custom_workflow_versions v JOIN (SELECT workflow_id, MAX(version) version FROM custom_workflow_versions GROUP BY workflow_id) x ON x.workflow_id=v.workflow_id AND x.version=v.version ORDER BY v.workflow_id LIMIT ?`).all(safeLimit);
  return rows.map(rowToWorkflow);
}
export function cloneCustomWorkflow(db, sourceId, input, { createdBy = 'user' } = {}) {
  const source = getCustomWorkflow(db, sourceId);
  return createCustomWorkflow(db, { workflow_id: input.workflow_id, name: input.name || `${source.name} (copy)`, description: input.description || source.description, input_contract: input.input_contract || source.input_contract, tasks: input.tasks || source.tasks }, { createdBy });
}
export function previewCustomWorkflow(db, workflowId, version) {
  const definition = getCustomWorkflow(db, workflowId, version);
  const rolePins = definition.tasks.map(task => {
    const role = getCustomRole(db, task.role_id, task.role_version);
    return { task_id: task.id, role_id: role.role_id, role_version: role.version, role_name: role.name, input_contract: task.input_contract, output_artifact_type: task.output_artifact_type, depends_on: task.depends_on, execution_mode: 'host-conversation', deterministic: false };
  });
  const canonical = JSON.stringify({ schema_version: 1, workflow_id: definition.workflow_id, workflow_version: definition.version, name: definition.name, input_contract: definition.input_contract, tasks: rolePins });
  const planHash = crypto.createHash('sha256').update(canonical).digest('hex');
  const planId = `cwp-${crypto.randomUUID()}`;
  // execution_enabled describes runtime capability, not approval state. The
  // plan remains unauthorized until both plan approval and workflow approval.
  const plan = { schema_version: 1, plan_id: planId, workflow_id: definition.workflow_id, workflow_version: definition.version, name: definition.name, input_contract: definition.input_contract, tasks: rolePins, plan_hash: planHash, requires_explicit_approval: true, execution_enabled: true, plan_approved: false, execution_authorized: false };
  db.prepare('INSERT INTO custom_workflow_plans (plan_id,workflow_id,workflow_version,plan_hash,plan_json,created_at) VALUES (?,?,?,?,?,?)').run(planId, definition.workflow_id, definition.version, planHash, JSON.stringify(plan), new Date().toISOString());
  return plan;
}
export function approveCustomWorkflowPlan(db, planId, confirmation, { approvedBy = 'user' } = {}) {
  const id = text(planId, 'plan_id', 120);
  const note = text(confirmation, 'confirmation', 2000);
  const row = db.prepare('SELECT * FROM custom_workflow_plans WHERE plan_id=?').get(id);
  if (!row) throw new Error(`custom workflow plan not found: ${id}`);
  if (row.approved_at) return { approved: true, idempotent: true, plan: { ...parseStrictJson(row.plan_json), execution_enabled: true, plan_approved: true, execution_authorized: false }, approved_at: row.approved_at, approved_by: row.approved_by, execution_enabled: true, execution_authorized: false };
  // Older persisted previews may carry the Phase 2 `execution_enabled:false`
  // marker. Normalize on read so approval decisions are not contradicted by
  // stale metadata, without mutating the immutable stored snapshot/hash.
  const plan = { ...parseStrictJson(row.plan_json), execution_enabled: true, plan_approved: true, execution_authorized: false };
  const recomputed = crypto.createHash('sha256').update(JSON.stringify({ schema_version: plan.schema_version, workflow_id: plan.workflow_id, workflow_version: plan.workflow_version, name: plan.name, input_contract: getCustomWorkflow(db, plan.workflow_id, plan.workflow_version).input_contract, tasks: plan.tasks })).digest('hex');
  if (recomputed !== row.plan_hash || plan.plan_hash !== row.plan_hash) throw new Error('custom workflow plan hash verification failed');
  const approvedAt = new Date().toISOString();
  db.prepare('UPDATE custom_workflow_plans SET approved_at=?,approved_by=?,approval_confirmation=? WHERE plan_id=? AND approved_at IS NULL').run(approvedAt, text(approvedBy, 'approved_by', 200), note, id);
  return { approved: true, idempotent: false, plan: { ...plan, plan_approved: true, execution_authorized: false }, approved_at: approvedAt, approved_by: approvedBy, execution_enabled: true, execution_authorized: false, requires_separate_execution_approval: true, note: 'The plan is approved and the custom workflow execution engine is available; a separate workflow_approve call is still required to authorize this run.' };
}

// Phase 3 consumes only a plan that was explicitly approved in Phase 2. The
// returned execution spec is rebuilt from immutable workflow/role versions;
// caller-supplied role prompts or permissions are never accepted.
export function getApprovedCustomWorkflowExecutionSpec(db, planId) {
  const id = text(planId, 'plan_id', 120);
  const row = db.prepare('SELECT * FROM custom_workflow_plans WHERE plan_id=?').get(id);
  if (!row) throw new Error(`custom workflow plan not found: ${id}`);
  if (!row.approved_at) throw new Error(`custom workflow plan requires explicit plan approval before execution: ${id}`);
  const plan = { ...parseStrictJson(row.plan_json), execution_enabled: true, plan_approved: true, execution_authorized: false };
  const definition = getCustomWorkflow(db, row.workflow_id, row.workflow_version);
  const canonical = JSON.stringify({ schema_version: 1, workflow_id: definition.workflow_id, workflow_version: definition.version, name: definition.name, input_contract: definition.input_contract, tasks: plan.tasks });
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  if (hash !== row.plan_hash || plan.plan_hash !== row.plan_hash) throw new Error('custom workflow plan hash verification failed');
  const tasks = definition.tasks.map(task => ({ ...task, role: getCustomRole(db, task.role_id, task.role_version) }));
  return { plan_id: id, plan_hash: row.plan_hash, approved_at: row.approved_at, approved_by: row.approved_by, plan, workflow: definition, tasks };
}
export function customWorkflowTaskSchema() {
  return { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 80 },
    role_id: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 80 },
    role_version: { type: 'integer', minimum: 1 },
    depends_on: { type: 'array', maxItems: 32, items: { type: 'string' } },
    input_contract: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', enum: ['job.request', ...ARTIFACT_TYPES] } },
    output_artifact_type: { type: 'string', enum: [...ARTIFACT_TYPES] }
  }, required: ['id', 'role_id'] };
}
