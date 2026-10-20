import crypto from 'node:crypto';
import path from 'node:path';
import { parseStrictJson } from '../strict-json.js';
import { normalizeSuccessContract } from './success-contract.js';

const POLICY_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const POLICY_ID_MAX = 38;
const POLICY_RULE_ID_MAX = 39;
const MAX_POLICY_RULES = 32;
const MAX_POLICY_VERSIONS = 200;
const DEFINITION_KEYS = new Set(['schema_version', 'policy_id', 'name', 'description', 'constraints', 'success_criteria']);
const SNAPSHOT_KEYS = new Set(['schema_version', 'policy_id', 'version', 'name', 'description', 'constraints', 'success_criteria', 'content_hash']);

const RULE_CATALOG = Object.freeze([
  { type: 'all_tasks_completed', description: 'Every immutable child task must have a successful durable completed result.', enforcement: 'independent synthesis/terminalization evaluation', required_fields: [] },
  { type: 'local_execution_only', description: 'Every planned task must use an approved local execution contract.', enforcement: 'plan compatibility validation and independent synthesis/terminalization evaluation', required_fields: [] },
  { type: 'workflow_id_equals', description: 'The approved plan workflow ID must match the selected slug.', enforcement: 'attachment/plan compatibility validation and independent synthesis/terminalization evaluation', required_fields: ['expected'] },
  { type: 'task_status_equals', description: 'A named immutable plan task must be durably completed.', enforcement: 'independent synthesis/terminalization evaluation', required_fields: ['task_id', 'expected'] },
  { type: 'execution_exit_code_equals', description: 'A named deterministic task must have durable completed execution evidence and exit code zero.', enforcement: 'independent synthesis/terminalization evaluation', required_fields: ['task_id', 'expected'] },
  { type: 'task_role_present', description: 'The immutable plan must contain the named specialist role.', enforcement: 'attachment/plan compatibility validation and independent synthesis/terminalization evaluation', required_fields: ['role'] },
  { type: 'task_role_absent', description: 'The immutable plan must not contain the named role.', enforcement: 'attachment/plan compatibility validation and independent synthesis/terminalization evaluation', required_fields: ['role'] },
  { type: 'artifact_exists', description: 'An active validated artifact must be bound to a successful durable producer result.', enforcement: 'independent synthesis/terminalization evaluation with provenance validation', required_fields: ['artifact_type'] },
  { type: 'artifact_field_equals', description: 'A top-level scalar in an eligible artifact must equal the specified value.', enforcement: 'independent synthesis/terminalization evaluation with provenance validation', required_fields: ['artifact_type', 'field', 'expected'] },
  { type: 'artifact_field_includes', description: 'An eligible artifact array must include the specified scalar.', enforcement: 'independent synthesis/terminalization evaluation with provenance validation', required_fields: ['artifact_type', 'field', 'expected'] },
  { type: 'artifact_field_non_empty', description: 'A top-level field in an eligible artifact must be a non-empty string, array, or object.', enforcement: 'independent synthesis/terminalization evaluation with provenance validation', required_fields: ['artifact_type', 'field'] }
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function assertPlainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be a plain JSON object`);
  }
}
function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}
function requiredText(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return result;
}
function normalizePolicyId(value) {
  const id = requiredText(value, 'policy_id', POLICY_ID_MAX);
  if (!POLICY_ID_PATTERN.test(id)) throw new Error(`policy_id must be a lowercase slug of at most ${POLICY_ID_MAX} characters`);
  return id;
}
function checkRuleIds(policy) {
  const allIds = new Set();
  for (const field of ['constraints', 'success_criteria']) {
    for (const rule of policy[field]) {
      if (rule.id.length > POLICY_RULE_ID_MAX) throw new Error(`${field} rule id exceeds ${POLICY_RULE_ID_MAX} characters so it can be safely namespaced`);
      if (allIds.has(rule.id)) throw new Error(`policy contains duplicate id across constraints and success_criteria: ${rule.id}`);
      allIds.add(rule.id);
    }
  }
  if (allIds.size > MAX_POLICY_RULES) throw new Error(`policy may contain at most ${MAX_POLICY_RULES} total rules`);
}

export function normalizePolicyDefinition(input) {
  assertPlainRecord(input, 'policy definition');
  assertOnlyKeys(input, DEFINITION_KEYS, 'policy definition');
  const policyId = normalizePolicyId(input.policy_id);
  if (input.schema_version != null && input.schema_version !== 1) throw new Error('policy schema_version must be 1');
  const name = requiredText(input.name, 'name', 120);
  if (input.description != null && typeof input.description !== 'string') throw new Error('description must be a string');
  const description = input.description == null ? '' : input.description.trim();
  if (description.length > 2000) throw new Error('description exceeds 2000 characters');
  const normalizedContract = normalizeSuccessContract({
    goal: name,
    constraints: input.constraints ?? [],
    success_criteria: input.success_criteria ?? []
  }, name);
  const result = {
    schema_version: 1,
    policy_id: policyId,
    name,
    description,
    constraints: normalizedContract.constraints.map(rule => ({ ...rule })),
    success_criteria: normalizedContract.success_criteria.map(rule => ({ ...rule }))
  };
  checkRuleIds(result);
  if (result.constraints.length + result.success_criteria.length === 0) throw new Error('policy must declare at least one enforceable constraint or success criterion');
  assertNoSemanticConflicts([...result.constraints, ...result.success_criteria]);
  return result;
}

function snapshotHashMaterial(policyId, version, definition) {
  return { policy_id: policyId, version, definition };
}

export function createPolicySnapshot(policyId, version, definition) {
  const id = normalizePolicyId(policyId);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('policy version must be a positive safe integer');
  const normalized = normalizePolicyDefinition({ ...definition, policy_id: id });
  const snapshot = {
    schema_version: 1,
    policy_id: id,
    version,
    name: normalized.name,
    description: normalized.description,
    constraints: normalized.constraints,
    success_criteria: normalized.success_criteria
  };
  const body = {
    schema_version: 1,
    policy_id: id,
    name: normalized.name,
    description: normalized.description,
    constraints: normalized.constraints,
    success_criteria: normalized.success_criteria
  };
  snapshot.content_hash = sha256(canonicalJson(snapshotHashMaterial(id, version, body)));
  return snapshot;
}

export function validatePolicySnapshot(input) {
  assertPlainRecord(input, 'policy snapshot');
  assertOnlyKeys(input, SNAPSHOT_KEYS, 'policy snapshot');
  if (input.schema_version !== 1) throw new Error('policy snapshot schema_version must be 1');
  const normalized = createPolicySnapshot(input.policy_id, input.version, {
    schema_version: input.schema_version,
    policy_id: input.policy_id,
    name: input.name,
    description: input.description,
    constraints: input.constraints,
    success_criteria: input.success_criteria
  });
  if (input.content_hash !== normalized.content_hash) throw new Error(`policy snapshot hash mismatch: ${String(input.policy_id)}@${String(input.version)}`);
  if (canonicalJson(normalized) !== canonicalJson(input)) throw new Error('policy snapshot is not canonically normalized');
  return normalized;
}

function policyPredicateId(policyId, ruleId) {
  return `p-${policyId}-${ruleId}`;
}

function assertNoSemanticConflicts(predicates) {
  const rolePresence = new Map();
  const workflowIds = new Set();
  const artifactFieldRules = [];
  for (const rule of predicates) {
    if (rule.type === 'task_role_present' || rule.type === 'task_role_absent') {
      const desired = rule.type === 'task_role_present';
      const previous = rolePresence.get(rule.role);
      if (previous != null && previous !== desired) throw new Error(`conflicting policy predicates for role ${rule.role}`);
      rolePresence.set(rule.role, desired);
    }
    if (rule.type === 'workflow_id_equals') workflowIds.add(rule.expected);
    if (rule.type.startsWith('artifact_field_')) artifactFieldRules.push(rule);
  }
  if (workflowIds.size > 1) throw new Error('conflicting policy predicates require different workflow IDs');
  for (let i = 0; i < artifactFieldRules.length; i++) {
    const left = artifactFieldRules[i];
    for (let j = i + 1; j < artifactFieldRules.length; j++) {
      const right = artifactFieldRules[j];
      if (left.artifact_type !== right.artifact_type || left.field !== right.field) continue;
      // A missing producer role means any eligible producer, so it overlaps
      // every role-specific predicate for this artifact type and field.
      if (left.producer_role && right.producer_role && left.producer_role !== right.producer_role) continue;
      let conflict = false;
      if (left.type === 'artifact_field_equals' && right.type === 'artifact_field_equals') {
        conflict = typeof left.expected !== typeof right.expected || left.expected !== right.expected;
      } else if (
        (left.type === 'artifact_field_equals' && right.type === 'artifact_field_includes') ||
        (left.type === 'artifact_field_includes' && right.type === 'artifact_field_equals')
      ) {
        // Equality requires a JSON scalar, while includes requires an array.
        conflict = true;
      } else {
        const equals = left.type === 'artifact_field_equals' ? left : right.type === 'artifact_field_equals' ? right : null;
        const nonEmpty = left.type === 'artifact_field_non_empty' ? left : right.type === 'artifact_field_non_empty' ? right : null;
        // The current deterministic evaluator considers only non-empty
        // strings, arrays and objects non-empty; numeric/boolean equality can
        // therefore never satisfy a non-empty predicate on the same field.
        conflict = Boolean(equals && nonEmpty && typeof equals.expected !== 'string');
      }
      if (conflict) throw new Error(`conflicting policy predicates for artifact field ${left.artifact_type}.${left.field}`);
    }
  }
}

function assertPredicateCompatible(rule, { workflowId, children }) {
  if (workflowId && rule.type === 'workflow_id_equals' && rule.expected !== workflowId) {
    throw new Error(`policy rule ${rule.id} expects workflow ${rule.expected} but target plan is ${workflowId}`);
  }
  if (!Array.isArray(children)) return;
  const roles = new Set(children.map(child => child.role));
  const taskIds = new Set(children.map(child => child.id));
  if (rule.type === 'task_role_present' && !roles.has(rule.role)) throw new Error(`policy rule ${rule.id} requires planned role ${rule.role}`);
  if (rule.type === 'task_role_absent' && roles.has(rule.role)) throw new Error(`policy rule ${rule.id} forbids planned role ${rule.role}`);
  if ((rule.type === 'task_status_equals' || rule.type === 'execution_exit_code_equals') && !taskIds.has(rule.task_id)) {
    throw new Error(`policy rule ${rule.id} references unknown planned task ${rule.task_id}`);
  }
  if (rule.type === 'execution_exit_code_equals') {
    const task = children.find(child => child.id === rule.task_id);
    if (task?.execution?.deterministic !== true || task.execution.executor !== 'ExecutionManager') {
      throw new Error(`policy rule ${rule.id} requires task ${rule.task_id} to have a deterministic approved local execution contract`);
    }
  }
  if (rule.type.startsWith('artifact_') && rule.producer_role && !roles.has(rule.producer_role)) {
    throw new Error(`policy rule ${rule.id} requires artifact producer role ${rule.producer_role}`);
  }
}

export function composePolicySuccessContract(baseContract, policySnapshots = [], context = {}) {
  if (!Array.isArray(policySnapshots)) throw new Error('policy_packs must be an array');
  if (policySnapshots.length > 32) throw new Error('a workflow may attach at most 32 policy packs');
  const base = normalizeSuccessContract(baseContract || {}, 'Fulfill the workflow request');
  const seenPolicyIds = new Set();
  const snapshots = policySnapshots.map(validatePolicySnapshot).sort((a, b) => a.policy_id.localeCompare(b.policy_id));
  for (const snapshot of snapshots) {
    if (seenPolicyIds.has(snapshot.policy_id)) throw new Error(`duplicate policy attachment: ${snapshot.policy_id}`);
    seenPolicyIds.add(snapshot.policy_id);
  }
  assertNoSemanticConflicts(snapshots.flatMap(snapshot => [...snapshot.constraints, ...snapshot.success_criteria]));
  for (const snapshot of snapshots) for (const rule of [...snapshot.constraints, ...snapshot.success_criteria]) assertPredicateCompatible(rule, context);
  const constraints = [...base.constraints];
  const successCriteria = [...base.success_criteria];
  const baseIds = new Set([...constraints, ...successCriteria].map(rule => rule.id));
  for (const snapshot of snapshots) {
    for (const rule of snapshot.constraints) {
      const id = policyPredicateId(snapshot.policy_id, rule.id);
      if (baseIds.has(id)) throw new Error(`policy predicate ID collision: ${id}`);
      baseIds.add(id);
      constraints.push({ ...rule, id });
    }
    for (const rule of snapshot.success_criteria) {
      const id = policyPredicateId(snapshot.policy_id, rule.id);
      if (baseIds.has(id)) throw new Error(`policy predicate ID collision: ${id}`);
      baseIds.add(id);
      successCriteria.push({ ...rule, id });
    }
  }
  const merged = normalizeSuccessContract({ goal: base.goal, constraints, success_criteria: successCriteria });
  assertNoSemanticConflicts([...merged.constraints, ...merged.success_criteria]);
  return { base_success_contract: base, success_contract: merged, policy_packs: snapshots };
}

export function getWorkflowPolicyCatalog() {
  return { schema_version: 1, supported_rule_count: RULE_CATALOG.length, rule_types: RULE_CATALOG.map(rule => ({ ...rule, required_fields: [...rule.required_fields] })) };
}

export function initializeWorkflowPolicyStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_policy_versions (
      policy_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      PRIMARY KEY(policy_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_policy_versions_name ON workflow_policy_versions(name, policy_id, version DESC);
    CREATE TABLE IF NOT EXISTS workflow_policy_attachments (
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      policy_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
      attached_at TEXT NOT NULL,
      attached_by TEXT NOT NULL,
      PRIMARY KEY(job_id, policy_id),
      FOREIGN KEY(policy_id, version) REFERENCES workflow_policy_versions(policy_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_policy_attachments_policy ON workflow_policy_attachments(policy_id, version);
    CREATE TABLE IF NOT EXISTS workflow_policy_events (
      event_id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      version INTEGER,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_policy_events_policy_created ON workflow_policy_events(policy_id, created_at DESC);
    CREATE TRIGGER IF NOT EXISTS workflow_policy_versions_no_update
      BEFORE UPDATE ON workflow_policy_versions BEGIN SELECT RAISE(ABORT, 'workflow policy versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_policy_versions_no_delete
      BEFORE DELETE ON workflow_policy_versions BEGIN SELECT RAISE(ABORT, 'workflow policy versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_policy_attachments_no_update
      BEFORE UPDATE ON workflow_policy_attachments BEGIN SELECT RAISE(ABORT, 'workflow policy attachments are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_policy_attachments_no_delete
      BEFORE DELETE ON workflow_policy_attachments BEGIN SELECT RAISE(ABORT, 'workflow policy attachments are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_policy_events_no_update
      BEFORE UPDATE ON workflow_policy_events BEGIN SELECT RAISE(ABORT, 'workflow policy events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_policy_events_no_delete
      BEFORE DELETE ON workflow_policy_events BEGIN SELECT RAISE(ABORT, 'workflow policy events are append-only'); END;
  `);
}

function recordPolicyEvent(db, policyId, version, eventType, payload, actor) {
  const createdAt = new Date().toISOString();
  const serialized = canonicalJson(payload);
  const eventId = sha256(`${policyId}|${version ?? ''}|${eventType}|${createdAt}|${crypto.randomUUID()}`);
  db.prepare('INSERT INTO workflow_policy_events(event_id,policy_id,version,event_type,payload_json,created_at,created_by) VALUES(?,?,?,?,?,?,?)')
    .run(eventId, policyId, version ?? null, eventType, serialized, createdAt, actor);
  return { event_id: eventId, created_at: createdAt };
}

function savepoint(db, name, callback) {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = callback();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try { db.exec(`ROLLBACK TO SAVEPOINT ${name}`); } catch {}
    try { db.exec(`RELEASE SAVEPOINT ${name}`); } catch {}
    throw error;
  }
}

function rowToPolicy(row) {
  let definition;
  try { definition = parseStrictJson(row.definition_json, 'stored workflow policy definition'); }
  catch (error) { throw new Error(`stored policy definition is malformed: ${row.policy_id}@${row.version}: ${error.message}`); }
  const normalized = normalizePolicyDefinition(definition);
  if (canonicalJson(normalized) !== row.definition_json || normalized.name !== row.name || normalized.description !== row.description) {
    throw new Error(`stored policy definition does not match its indexed fields: ${row.policy_id}@${row.version}`);
  }
  const snapshot = createPolicySnapshot(row.policy_id, Number(row.version), normalized);
  if (snapshot.content_hash !== row.content_hash) throw new Error(`stored policy content hash mismatch: ${row.policy_id}@${row.version}`);
  return { ...snapshot, created_at: row.created_at, created_by: row.created_by };
}

export function inspectStoredWorkflowPolicyRow(row) {
  try {
    const policy = rowToPolicy(row);
    return { valid: true, validation_status: 'valid', reason: null, policy };
  } catch (error) {
    return {
      valid: false,
      validation_status: 'invalid',
      reason: String(error?.message || error).slice(0, 600),
      policy: null
    };
  }
}

function withDefinition(snapshot) {
  return {
    schema_version: snapshot.schema_version,
    policy_id: snapshot.policy_id,
    name: snapshot.name,
    description: snapshot.description,
    constraints: snapshot.constraints,
    success_criteria: snapshot.success_criteria
  };
}

export function createWorkflowPolicy(db, input, { actor = 'local-operator' } = {}) {
  initializeWorkflowPolicyStore(db);
  const normalized = normalizePolicyDefinition(input);
  return savepoint(db, 'create_workflow_policy', () => {
    if (db.prepare('SELECT 1 FROM workflow_policy_versions WHERE policy_id=? LIMIT 1').get(normalized.policy_id)) {
      throw new Error(`workflow policy already exists: ${normalized.policy_id}; use workflow_policy_update to create a new version`);
    }
    const snapshot = createPolicySnapshot(normalized.policy_id, 1, normalized);
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO workflow_policy_versions(policy_id,version,name,description,definition_json,content_hash,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)')
      .run(normalized.policy_id, 1, normalized.name, normalized.description, canonicalJson(normalized), snapshot.content_hash, createdAt, actor);
    recordPolicyEvent(db, normalized.policy_id, 1, 'created', { policy_id: normalized.policy_id, version: 1, content_hash: snapshot.content_hash }, actor);
    return { ...snapshot, created_at: createdAt, created_by: actor };
  });
}

export function updateWorkflowPolicy(db, input, { actor = 'local-operator' } = {}) {
  initializeWorkflowPolicyStore(db);
  assertPlainRecord(input, 'policy update');
  assertOnlyKeys(input, DEFINITION_KEYS, 'policy update');
  const policyId = normalizePolicyId(input.policy_id);
  return savepoint(db, 'update_workflow_policy', () => {
    const row = db.prepare('SELECT * FROM workflow_policy_versions WHERE policy_id=? ORDER BY version DESC LIMIT 1').get(policyId);
    if (!row) throw new Error(`workflow policy not found: ${policyId}`);
    const current = rowToPolicy(row);
    const normalized = normalizePolicyDefinition({
      ...withDefinition(current),
      ...input,
      policy_id: policyId
    });
    const version = Number(row.version) + 1;
    if (!Number.isSafeInteger(version)) throw new Error('workflow policy version overflow');
    const snapshot = createPolicySnapshot(policyId, version, normalized);
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO workflow_policy_versions(policy_id,version,name,description,definition_json,content_hash,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)')
      .run(policyId, version, normalized.name, normalized.description, canonicalJson(normalized), snapshot.content_hash, createdAt, actor);
    recordPolicyEvent(db, policyId, version, 'updated', { policy_id: policyId, previous_version: Number(row.version), version, content_hash: snapshot.content_hash }, actor);
    return { ...snapshot, created_at: createdAt, created_by: actor };
  });
}

export function getWorkflowPolicy(db, policyId, version = undefined) {
  const id = normalizePolicyId(policyId);
  const row = version == null
    ? db.prepare('SELECT * FROM workflow_policy_versions WHERE policy_id=? ORDER BY version DESC LIMIT 1').get(id)
    : db.prepare('SELECT * FROM workflow_policy_versions WHERE policy_id=? AND version=?').get(id, version);
  if (!row) return null;
  return rowToPolicy(row);
}

export function listWorkflowPolicies(db, { includeVersions = false, limit = 100, query = '' } = {}) {
  const safeLimit = Math.max(1, Math.min(MAX_POLICY_VERSIONS, Number.isSafeInteger(Number(limit)) ? Number(limit) : 100));
  const q = typeof query === 'string' ? query.trim().slice(0, 120) : '';
  const rows = includeVersions
    ? db.prepare(`SELECT * FROM workflow_policy_versions WHERE (?='' OR policy_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') ORDER BY policy_id,version DESC LIMIT ?`).all(q, `%${q.replace(/[\\%_]/g, '\\$&')}%`, `%${q.replace(/[\\%_]/g, '\\$&')}%`, safeLimit)
    : db.prepare(`SELECT v.* FROM workflow_policy_versions v JOIN (SELECT policy_id,MAX(version) version FROM workflow_policy_versions GROUP BY policy_id) latest ON latest.policy_id=v.policy_id AND latest.version=v.version WHERE (?='' OR v.policy_id LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\') ORDER BY v.name COLLATE NOCASE,v.policy_id LIMIT ?`).all(q, `%${q.replace(/[\\%_]/g, '\\$&')}%`, `%${q.replace(/[\\%_]/g, '\\$&')}%`, safeLimit);
  const items = rows.map(rowToPolicy);
  return { items, total: Number(db.prepare('SELECT COUNT(DISTINCT policy_id) AS n FROM workflow_policy_versions').get()?.n || 0), versions_included: includeVersions, limit: safeLimit };
}

export function attachWorkflowPolicy(db, workflowStore, { jobId, policyId, version = undefined, actor = 'local-operator', planContext }) {
  initializeWorkflowPolicyStore(db);
  const id = normalizePolicyId(policyId);
  return savepoint(db, 'attach_workflow_policy', () => {
    const job = workflowStore.getJob(jobId);
    if (!job) throw new Error(`workflow not found: ${jobId}`);
    const phase = workflowStore.getWorkflowRuntimeState(jobId)?.phase;
    if (job.status !== 'active' || !['IDLE', 'PROPOSED', 'DISCUSSING'].includes(String(job.state || '').toUpperCase()) || !['PROPOSED', undefined, null].includes(phase)) {
      throw new Error(`policy attachment requires an active unapproved workflow proposal; state=${job.state} phase=${phase || 'unset'}`);
    }
    if (workflowStore.getLatestApproval(jobId) || workflowStore.getExecutionPlan(jobId)) {
      throw new Error('policy attachment is forbidden after approval or plan compilation');
    }
    const proposal = workflowStore.getCurrentProposal(jobId);
    if (!proposal?.payload) throw new Error(`workflow proposal not found: ${jobId}`);
    const policyRecord = getWorkflowPolicy(db, id, version);
    if (!policyRecord) throw new Error(`workflow policy version not found: ${id}${version == null ? '' : `@${version}`}`);
    const { created_at: policyCreatedAt, created_by: policyCreatedBy, ...snapshot } = policyRecord;
    const attached = getWorkflowPolicySnapshotsForJob(db, jobId);
    if (attached.some(item => item.policy_id === id)) throw new Error(`policy already attached to workflow: ${id}`);
    const candidates = [...attached, snapshot];
    composePolicySuccessContract(proposal.payload.success_contract || { goal: proposal.payload.task || job.title }, candidates, planContext || {});
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO workflow_policy_attachments(job_id,policy_id,version,content_hash,attached_at,attached_by) VALUES(?,?,?,?,?,?)')
      .run(jobId, id, snapshot.version, snapshot.content_hash, createdAt, actor);
    const payload = { job_id: jobId, policy_id: id, version: snapshot.version, content_hash: snapshot.content_hash, attached_at: createdAt, attached_by: actor };
    workflowStore.recordEvent(jobId, 'workflow.policy.attached', payload, `${id}@${snapshot.version}`);
    recordPolicyEvent(db, id, snapshot.version, 'attached', payload, actor);
    return { ...payload, name: snapshot.name, constraint_count: snapshot.constraints.length, success_criteria_count: snapshot.success_criteria.length };
  });
}

export function getWorkflowPolicySnapshotsForJob(db, jobId) {
  const rows = db.prepare('SELECT policy_id,version,content_hash FROM workflow_policy_attachments WHERE job_id=? ORDER BY policy_id').all(jobId);
  return rows.map(row => {
    const policy = getWorkflowPolicy(db, row.policy_id, Number(row.version));
    if (!policy || policy.content_hash !== row.content_hash) throw new Error(`workflow policy attachment snapshot mismatch: ${jobId} ${row.policy_id}@${row.version}`);
    const { created_at, created_by, ...snapshot } = policy;
    return snapshot;
  });
}

export function listWorkflowPolicyAttachments(db, { jobId = null, policyId = null, limit = 200 } = {}) {
  const safeLimit = Math.max(1, Math.min(MAX_POLICY_VERSIONS, Number.isSafeInteger(Number(limit)) ? Number(limit) : 200));
  let rows;
  if (jobId && policyId) rows = db.prepare(`SELECT a.job_id,a.policy_id,a.version,a.content_hash,a.attached_at,a.attached_by,j.title AS job_title,j.state AS job_state,j.status AS job_status FROM workflow_policy_attachments a JOIN jobs j ON j.job_id=a.job_id WHERE a.job_id=? AND a.policy_id=? ORDER BY a.attached_at,a.policy_id LIMIT ?`).all(jobId, normalizePolicyId(policyId), safeLimit);
  else if (jobId) rows = db.prepare(`SELECT a.job_id,a.policy_id,a.version,a.content_hash,a.attached_at,a.attached_by,j.title AS job_title,j.state AS job_state,j.status AS job_status FROM workflow_policy_attachments a JOIN jobs j ON j.job_id=a.job_id WHERE a.job_id=? ORDER BY a.attached_at,a.policy_id LIMIT ?`).all(jobId, safeLimit);
  else if (policyId) rows = db.prepare(`SELECT a.job_id,a.policy_id,a.version,a.content_hash,a.attached_at,a.attached_by,j.title AS job_title,j.state AS job_state,j.status AS job_status FROM workflow_policy_attachments a JOIN jobs j ON j.job_id=a.job_id WHERE a.policy_id=? ORDER BY a.attached_at DESC,a.job_id LIMIT ?`).all(normalizePolicyId(policyId), safeLimit);
  else rows = db.prepare(`SELECT a.job_id,a.policy_id,a.version,a.content_hash,a.attached_at,a.attached_by,j.title AS job_title,j.state AS job_state,j.status AS job_status FROM workflow_policy_attachments a JOIN jobs j ON j.job_id=a.job_id ORDER BY a.attached_at DESC,a.job_id LIMIT ?`).all(safeLimit);
  return rows.map(row => {
    const policy = getWorkflowPolicy(db, row.policy_id, Number(row.version));
    if (!policy || policy.content_hash !== row.content_hash) throw new Error(`workflow policy attachment snapshot mismatch: ${row.job_id} ${row.policy_id}@${row.version}`);
    return { ...row, name: policy.name, description: policy.description, constraint_count: policy.constraints.length, success_criteria_count: policy.success_criteria.length };
  });
}

export function getWorkflowPolicyEvents(db, { policyId = null, limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(MAX_POLICY_VERSIONS, Number.isSafeInteger(Number(limit)) ? Number(limit) : 100));
  return policyId
    ? db.prepare('SELECT * FROM workflow_policy_events WHERE policy_id=? ORDER BY created_at DESC LIMIT ?').all(normalizePolicyId(policyId), safeLimit)
    : db.prepare('SELECT * FROM workflow_policy_events ORDER BY created_at DESC LIMIT ?').all(safeLimit);
}

export function recordWorkflowPolicyViolation(db, workflowStore, { jobId, policySnapshot, planHash, predicate, reason }) {
  const snapshot = validatePolicySnapshot(policySnapshot);
  const predicateId = requiredText(predicate?.id, 'predicate.id', 80);
  const predicateType = requiredText(predicate?.type, 'predicate.type', 80);
  const safeReason = requiredText(reason, 'reason', 2000);
  if (typeof planHash !== 'string' || !/^[a-f0-9]{64}$/.test(planHash)) throw new Error('plan_hash must be a lowercase SHA-256 digest');
  const payload = {
    job_id: requiredText(jobId, 'job_id', 200),
    policy_id: snapshot.policy_id,
    policy_version: snapshot.version,
    policy_content_hash: snapshot.content_hash,
    plan_hash: requiredText(planHash, 'plan_hash', 64),
    predicate_id: predicateId,
    predicate_type: predicateType,
    reason: safeReason
  };
  const createdAt = new Date().toISOString();
  // A repeated submission of the exact failing predicate for the same plan is
  // idempotent: audit evidence must not grow without bound on request retries.
  const eventId = sha256(canonicalJson({ event_type: 'violation_detected', ...payload }));
  return savepoint(db, 'record_workflow_policy_violation', () => {
    db.prepare('INSERT OR IGNORE INTO workflow_policy_events(event_id,policy_id,version,event_type,payload_json,created_at,created_by) VALUES(?,?,?,?,?,?,?)')
      .run(eventId, snapshot.policy_id, snapshot.version, 'violation_detected', canonicalJson(payload), createdAt, 'workflow-runtime');
    workflowStore.recordEvent(payload.job_id, 'workflow.policy.violation_detected', payload,
      `${payload.plan_hash}|${snapshot.policy_id}@${snapshot.version}|${predicateId}|${safeReason}`);
    return { event_id: eventId, ...payload, created_at: createdAt };
  });
}

export function policyRuleIdForSnapshot(policyId, ruleId) { return policyPredicateId(normalizePolicyId(policyId), ruleId); }


const MCPB_PACKAGE_BUILD_WRAPPER = "import { spawnSync } from 'node:child_process'; const result = spawnSync('npm', ['run', 'pack:runalith-mcpb'], { cwd: process.cwd(), stdio: 'inherit' }); if (result.error) { console.error(result.error.message); process.exitCode = 1; } else { process.exitCode = result.status ?? 1; }";
const MCPB_PACKAGE_BUILD_ISOLATED_WRAPPER = "import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-npm-config-')); const userConfig = path.join(temp, 'user.npmrc'); const globalConfig = path.join(temp, 'global.npmrc'); try {   fs.writeFileSync(userConfig, '', { mode: 0o600 });   fs.writeFileSync(globalConfig, '', { mode: 0o600 });   const env = { ...process.env, NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig };   const result = spawnSync('npm', ['run', 'pack:runalith-mcpb'], { cwd: process.cwd(), stdio: 'inherit', env });   if (result.error) { console.error(result.error.message); process.exitCode = 1; } else { process.exitCode = result.status ?? 1; } } finally { fs.rmSync(temp, { recursive: true, force: true }); }";

const VALIDATION_PROFILES = Object.freeze({
  'core-release-validation': Object.freeze({
    schema_version: 1,
    profile_id: 'core-release-validation',
    profile_version: 1,
    execution_target: 'local',
    route: 'core-validation',
    task_contracts: Object.freeze([
      { task_id: 'standard-batch-test-execution-batch', role: 'batch-test-execution-batch', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-execution-batch.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-batch-test-execution-concurrency', role: 'batch-test-execution-concurrency', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-execution-batch-concurrency.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-batch-test-terminal-recovery', role: 'batch-test-terminal-recovery', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-execution-batch-terminal-recovery.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-batch-test-success-contract', role: 'batch-test-success-contract', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-execution-success-contract.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-batch-test-phase5-recovery', role: 'batch-test-phase5-recovery', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-phase5-recovery.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-batch-test-agent-tool-guidance', role: 'batch-test-agent-tool-guidance', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-agent-tool-guidance.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-docs-generate-reference', role: 'validation-docs-generate-reference', executable: 'node', args: ['$WORKSPACE/scripts/generate-mcp-reference.mjs'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'documentation', batch_validation_task: true },
      { task_id: 'standard-docs-check', role: 'validation-docs-check', executable: 'node', args: ['$WORKSPACE/scripts/check-docs.mjs'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer', 'standard-docs-generate-reference'], output_artifact_type: 'qa-report', batch_validation_task: true }
    ])
  }),
  'mcpb-package-build': Object.freeze({
    schema_version: 1,
    profile_id: 'mcpb-package-build',
    profile_version: 1,
    execution_target: 'local',
    route: 'mcpb-package-build',
    task_contracts: Object.freeze([
      { task_id: 'standard-mcpb-package-build', role: 'validation-mcpb-package-build', executable: 'node', args: ['--input-type=module', '-e', MCPB_PACKAGE_BUILD_WRAPPER], cwd: '$WORKSPACE', timeout_ms: 600000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true }
    ])
  }),
  'mcpb-package-build-isolated': Object.freeze({
    schema_version: 1,
    profile_id: 'mcpb-package-build-isolated',
    profile_version: 1,
    execution_target: 'local',
    route: 'mcpb-package-build-isolated',
    task_contracts: Object.freeze([
      { task_id: 'standard-mcpb-package-build-isolated', role: 'validation-mcpb-package-build-isolated', executable: 'node', args: ['--input-type=module', '-e', MCPB_PACKAGE_BUILD_ISOLATED_WRAPPER], cwd: '$WORKSPACE', timeout_ms: 600000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true }
    ])
  }),
  'mcpb-workspace-smoke': Object.freeze({
    schema_version: 1,
    profile_id: 'mcpb-workspace-smoke',
    profile_version: 1,
    execution_target: 'local',
    route: 'mcpb-workspace-smoke',
    task_contracts: Object.freeze([
      { task_id: 'standard-mcpb-workspace-smoke-execution-batch', role: 'validation-mcpb-workspace-smoke-execution-batch', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-execution-batch.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-mcpb-workspace-smoke-execution-concurrency', role: 'validation-mcpb-workspace-smoke-execution-concurrency', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-execution-batch-concurrency.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-mcpb-workspace-smoke-terminal-recovery', role: 'validation-mcpb-workspace-smoke-terminal-recovery', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-execution-batch-terminal-recovery.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-mcpb-workspace-smoke-success-contract', role: 'validation-mcpb-workspace-smoke-success-contract', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-execution-success-contract.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-mcpb-workspace-smoke-phase5-recovery', role: 'validation-mcpb-workspace-smoke-phase5-recovery', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-phase5-recovery.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true },
      { task_id: 'standard-mcpb-workspace-smoke-agent-tool-guidance', role: 'validation-mcpb-workspace-smoke-agent-tool-guidance', executable: 'node', args: ['--test', '$WORKSPACE/tests/test-agent-tool-guidance.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true }
    ])
  }),
  'plugin-e2e': Object.freeze({
    schema_version: 1,
    profile_id: 'plugin-e2e',
    profile_version: 1,
    execution_target: 'local',
    route: 'outer-e2e',
    task_contracts: Object.freeze([
      { task_id: 'standard-plugin-e2e', role: 'validation-plugin-e2e', executable: 'node', args: ['$WORKSPACE/tests/test-runalith-plugin.js'], cwd: '$WORKSPACE', timeout_ms: 300000, dependencies: ['standard-engineer'], output_artifact_type: 'qa-report', batch_validation_task: true }
    ])
  })
});

const VALIDATION_PROFILE_SNAPSHOT_KEYS = new Set([
  'schema_version', 'profile_id', 'profile_version', 'execution_target', 'route', 'task_contracts', 'content_hash'
]);

function deepFreezeValidationProfile(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeValidationProfile(child);
  return Object.freeze(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validationProfileContentHash(definition) {
  return sha256(canonicalJson(definition));
}

export function resolveValidationProfileSnapshot(selector) {
  assertPlainRecord(selector, 'validation_profile');
  assertOnlyKeys(selector, new Set(['profile_id', 'profile_version']), 'validation_profile');
  const profileId = requiredText(selector.profile_id, 'validation_profile.profile_id', 80);
  if (!Number.isSafeInteger(selector.profile_version) || selector.profile_version < 1) {
    throw new Error('validation_profile.profile_version must be a positive safe integer');
  }
  const definition = VALIDATION_PROFILES[profileId];
  if (!definition || definition.profile_version !== selector.profile_version) {
    throw new Error('unknown validation profile or version: ' + profileId + '@' + selector.profile_version);
  }
  if (definition.execution_target !== 'local' || !Array.isArray(definition.task_contracts) || !definition.task_contracts.length) {
    throw new Error('validation profile definition is invalid: ' + profileId + '@' + selector.profile_version);
  }
  const ids = definition.task_contracts.map(task => task.task_id);
  if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('validation profile task identities are invalid: ' + profileId + '@' + selector.profile_version);
  }
  if (profileId === 'core-release-validation' &&
      (definition.route !== 'core-validation' || ids.includes('standard-plugin-e2e') ||
       !ids.includes('standard-docs-generate-reference') || !ids.includes('standard-docs-check') ||
       definition.task_contracts.find(task => task.task_id === 'standard-docs-check')?.dependencies?.includes('standard-docs-generate-reference') !== true)) {
    throw new Error('core release validation profile violates its command/dependency/recursion contract');
  }
  if (profileId === 'mcpb-workspace-smoke') {
    const expectedSmokeTasks = [
      ['standard-mcpb-workspace-smoke-execution-batch', 'validation-mcpb-workspace-smoke-execution-batch', '$WORKSPACE/tests/test-execution-batch.js'],
      ['standard-mcpb-workspace-smoke-execution-concurrency', 'validation-mcpb-workspace-smoke-execution-concurrency', '$WORKSPACE/tests/test-execution-batch-concurrency.js'],
      ['standard-mcpb-workspace-smoke-terminal-recovery', 'validation-mcpb-workspace-smoke-terminal-recovery', '$WORKSPACE/tests/test-execution-batch-terminal-recovery.js'],
      ['standard-mcpb-workspace-smoke-success-contract', 'validation-mcpb-workspace-smoke-success-contract', '$WORKSPACE/tests/test-execution-success-contract.js'],
      ['standard-mcpb-workspace-smoke-phase5-recovery', 'validation-mcpb-workspace-smoke-phase5-recovery', '$WORKSPACE/tests/test-phase5-recovery.js'],
      ['standard-mcpb-workspace-smoke-agent-tool-guidance', 'validation-mcpb-workspace-smoke-agent-tool-guidance', '$WORKSPACE/tests/test-agent-tool-guidance.js']
    ];
    if (definition.route !== 'mcpb-workspace-smoke' || definition.task_contracts.length !== expectedSmokeTasks.length ||
        definition.task_contracts.some((task, index) => {
          const [taskId, role, testPath] = expectedSmokeTasks[index];
          return task.task_id !== taskId || task.role !== role || task.executable !== 'node' ||
            canonicalJson(task.args) !== canonicalJson(['--test', testPath]) || task.cwd !== '$WORKSPACE' ||
            task.timeout_ms !== 300000 || canonicalJson(task.dependencies) !== canonicalJson(['standard-engineer']) ||
            task.output_artifact_type !== 'qa-report' || task.batch_validation_task !== true;
        })) {
      throw new Error('MCPB workspace smoke profile violates its exact packaged local validation contract');
    }
  }
  if (profileId === 'plugin-e2e' &&
      (definition.route !== 'outer-e2e' || ids.length !== 1 || ids[0] !== 'standard-plugin-e2e' ||
       definition.task_contracts[0].args?.join('/') !== '$WORKSPACE/tests/test-runalith-plugin.js')) {
    throw new Error('plugin E2E profile must contain only the isolated outer plugin test command');
  }
  if (profileId === 'mcpb-package-build' &&
      (definition.route !== 'mcpb-package-build' || ids.length !== 1 || ids[0] !== 'standard-mcpb-package-build' ||
       definition.task_contracts[0]?.role !== 'validation-mcpb-package-build' ||
       definition.task_contracts[0]?.executable !== 'node' ||
       canonicalJson(definition.task_contracts[0]?.args) !== canonicalJson(['--input-type=module', '-e', "import { spawnSync } from 'node:child_process'; const result = spawnSync('npm', ['run', 'pack:runalith-mcpb'], { cwd: process.cwd(), stdio: 'inherit' }); if (result.error) { console.error(result.error.message); process.exitCode = 1; } else { process.exitCode = result.status ?? 1; }"]) ||
       definition.task_contracts[0]?.timeout_ms !== 600000 ||
       canonicalJson(definition.task_contracts[0]?.dependencies) !== canonicalJson(['standard-engineer']) ||
       definition.task_contracts[0]?.output_artifact_type !== 'qa-report' ||
       definition.task_contracts[0]?.batch_validation_task !== true)) {
    throw new Error('MCPB package validation profile violates its exact local command/timeout/dependency contract');
  }
  if (profileId === 'mcpb-package-build-isolated' &&
      (definition.route !== 'mcpb-package-build-isolated' || ids.length !== 1 || ids[0] !== 'standard-mcpb-package-build-isolated' ||
       definition.task_contracts[0]?.role !== 'validation-mcpb-package-build-isolated' ||
       definition.task_contracts[0]?.executable !== 'node' ||
       canonicalJson(definition.task_contracts[0]?.args) !== canonicalJson(['--input-type=module', '-e', "import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'runalith-npm-config-')); const userConfig = path.join(temp, 'user.npmrc'); const globalConfig = path.join(temp, 'global.npmrc'); try {   fs.writeFileSync(userConfig, '', { mode: 0o600 });   fs.writeFileSync(globalConfig, '', { mode: 0o600 });   const env = { ...process.env, NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig };   const result = spawnSync('npm', ['run', 'pack:runalith-mcpb'], { cwd: process.cwd(), stdio: 'inherit', env });   if (result.error) { console.error(result.error.message); process.exitCode = 1; } else { process.exitCode = result.status ?? 1; } } finally { fs.rmSync(temp, { recursive: true, force: true }); }"]) ||
       definition.task_contracts[0]?.timeout_ms !== 600000 ||
       canonicalJson(definition.task_contracts[0]?.dependencies) !== canonicalJson(['standard-engineer']) ||
       definition.task_contracts[0]?.output_artifact_type !== 'qa-report' ||
       definition.task_contracts[0]?.batch_validation_task !== true)) {
    throw new Error('Isolated MCPB package profile violates its exact npm-config/command/timeout/dependency contract');
  }
  const profiles = Object.values(VALIDATION_PROFILES);
  for (let left = 0; left < profiles.length; left += 1) {
    for (let right = left + 1; right < profiles.length; right += 1) {
      const otherIds = profiles[right].task_contracts.map(task => task.task_id);
      if (profiles[left].task_contracts.some(task => otherIds.includes(task.task_id))) {
        throw new Error('validation profiles must not share task IDs; recursive execution is forbidden');
      }
    }
  }
  const snapshot = { ...cloneJson(definition), content_hash: validationProfileContentHash(definition) };
  return deepFreezeValidationProfile(snapshot);
}

export function validateValidationProfileSnapshot(snapshot) {
  assertPlainRecord(snapshot, 'execution plan validation_profile');
  assertOnlyKeys(snapshot, VALIDATION_PROFILE_SNAPSHOT_KEYS, 'execution plan validation_profile');
  if (snapshot.schema_version !== 1) throw new Error('unsupported validation profile snapshot schema_version');
  const expected = resolveValidationProfileSnapshot({
    profile_id: snapshot.profile_id,
    profile_version: snapshot.profile_version
  });
  if (canonicalJson(snapshot) !== canonicalJson(expected)) {
    throw new Error('immutable validation profile snapshot/hash mismatch: ' + String(snapshot.profile_id) + '@' + String(snapshot.profile_version));
  }
  return expected;
}

export function materializeValidationProfileTasks(snapshot, workspace) {
  const profile = validateValidationProfileSnapshot(snapshot);
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('validation profile requires a concrete local workspace');
  const root = path.resolve(workspace);
  return profile.task_contracts.map(contract => {
    if (contract.cwd !== '$WORKSPACE' || contract.executable !== 'node' ||
        !Array.isArray(contract.args) || contract.args.some(arg => typeof arg !== 'string') ||
        !Number.isSafeInteger(contract.timeout_ms) || contract.timeout_ms < 1000 ||
        !Array.isArray(contract.dependencies) || contract.output_artifact_type == null ||
        contract.batch_validation_task !== true) {
      throw new Error('validation profile command contract is malformed: ' + contract.task_id);
    }
    const args = contract.args.map(arg => arg === '$WORKSPACE'
      ? root
      : arg.startsWith('$WORKSPACE/')
        ? path.resolve(root, arg.slice('$WORKSPACE/'.length))
        : arg);
    return {
      id: contract.task_id,
      role: contract.role,
      capability: null,
      dependencies: [...contract.dependencies],
      execution: {
        executor: 'ExecutionManager',
        executable: contract.executable,
        args,
        command: [contract.executable, ...args].join(' '),
        cwd: root,
        timeout_ms: contract.timeout_ms,
        deterministic: true,
        batch_validation_task: true,
        output_artifact_type: contract.output_artifact_type,
        validation_profile_id: profile.profile_id,
        validation_profile_version: profile.profile_version,
        validation_profile_task_id: contract.task_id,
        execution_mode: 'local-only',
        local_only: true
      }
    };
  });
}
