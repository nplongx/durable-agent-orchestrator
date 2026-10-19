import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createEnvelope, validateEnvelope, validatePayload, validateDurableExecutionResult, MAX_EXECUTION_BATCH_ITEMS, MAX_EXECUTION_COMMAND_CHARS, MAX_EXECUTION_TIMEOUT_MS } from '../../protocol/cos-ap-v1/index.js';
import { isProductionWorkflow } from './workflow/definitions/production.js';
import { isSupportedWorkflow } from './workflow/definitions/index.js';
import { assessProductionQaExecution, ProductionRoles } from './workflow/catalog/production.js';
import { compileWorkflowPlan } from './workflow/compiler.js';
import { assertTaskDependenciesMatchPlan, canonicalJson, validateExecutionPlan } from './workflow/plan.js';
import { summarizeObservability, sanitizeObservabilityEvent } from './observability.js';
import { normalizeReviewerArtifact } from './workflow/artifact-normalizer.js';
import { createArtifactRecord, validateArtifact, validateArtifactContent, ArtifactStatus } from './workflow/artifacts.js';
import { getAgentArtifactType, getAgentInputArtifactTypes } from './workflow/agent-contracts.js';
import { canonicalExecutionEvidenceContent as executionEvidenceContent, validateEvidenceContract } from './workflow/evidence.js';
import { assertSessionGrantAuthority, assertSessionRevokeAuthority, normalizeGovernanceRole } from './workflow/governance.js';
import { parseStrictJson } from './strict-json.js';
import { assertProviderDispatchIntent } from './provider-dispatch-identity.js';
import { getWorkflowPolicySnapshotsForJob, initializeWorkflowPolicyStore } from './workflow/policy-contract.js';
import { normalizeSuccessContract } from './workflow/success-contract.js';
import { resolveRoleProfileBindings } from './workflow/role-profiles.js';

const DATA_DIR = process.env.WORKFLOW_DATA_DIR || '/home/long/work/chatgpt-adapter/data';
const configuredDbPath = path.resolve(process.env.WORKFLOW_DB || path.join(DATA_DIR, 'workflow.db'));

function assertWorkflowDatabaseDirectory(directory, { allowMissing = false } = {}) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let cursor = root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let missingSeen = false;
  if (components.length === 0) {
    const info = fs.lstatSync(root);
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new Error(`workflow database directory is not private: ${root}`);
    }
  }
  for (let index = 0; index < components.length; index++) {
    cursor = path.join(cursor, components[index]);
    let entry;
    try { entry = fs.lstatSync(cursor); }
    catch (error) {
      if (allowMissing && error?.code === 'ENOENT') { missingSeen = true; continue; }
      throw new Error(`workflow database directory is missing or unreadable: ${cursor}: ${error?.message || error}`);
    }
    if (missingSeen) throw new Error(`workflow database directory path changed while being checked: ${cursor}`);
    if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync(cursor) !== cursor) {
      throw new Error(`workflow database directory must use canonical real directories: ${cursor}`);
    }
    if (process.platform !== 'win32') {
      const isFinalDirectory = index === components.length - 1;
      const mode = entry.mode & 0o7777;
      if (isFinalDirectory) {
        if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
          throw new Error(`workflow database directory is not owned by the runtime user: ${cursor}`);
        }
        if ((mode & 0o077) !== 0 || (mode & 0o700) !== 0o700) {
          throw new Error(`workflow database directory is not private: ${cursor} mode=0${(mode & 0o777).toString(8).padStart(3, '0')}; expected owner rwx and no group/world permissions`);
        }
      } else if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
        // Sticky shared directories such as /tmp protect child entries from
        // replacement by another UID. A writable non-sticky ancestor does not.
        throw new Error(`workflow database path has a replaceable writable ancestor: ${cursor}`);
      }
    }
  }
  if (!allowMissing && missingSeen) throw new Error(`workflow database directory is missing: ${absolute}`);
}

function secureWorkflowDatabaseFile(filePath) {
  let before;
  try { before = fs.lstatSync(filePath); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(filePath) !== filePath) {
    throw new Error(`workflow database path must be a canonical regular file, not a symlink or special file: ${filePath}`);
  }
  if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    throw new Error(`workflow database file is not owned by the runtime user: ${filePath}`);
  }
  if (before.nlink !== 1) throw new Error(`workflow database file has unexpected hard links: ${filePath}`);
  if (process.platform !== 'win32') {
    if ((before.mode & 0o077) !== 0) {
      try { fs.chmodSync(filePath, 0o600); }
      catch (error) { throw new Error(`workflow database file permissions cannot be secured: ${filePath}: ${error?.message || error}`); }
    }
    const after = fs.lstatSync(filePath);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
        after.nlink !== 1 || (after.mode & 0o077) !== 0 || fs.realpathSync(filePath) !== filePath) {
      throw new Error(`workflow database file identity or permissions changed while being secured: ${filePath}`);
    }
  }
}

function canonicalizeWorkflowDatabaseDirectory(directory) {
  // On macOS, for example, os.tmpdir() may be under /var while /var resolves
  // to /private/var. Resolve the nearest existing directory prefix first and
  // rebase missing suffix components on that real path. The chain validator
  // then checks actual filesystem ancestry rather than rejecting a harmless
  // platform alias (or checking the wrong ancestor's permissions).
  const absolute = path.resolve(directory);
  let existing = absolute;
  while (true) {
    try {
      const info = fs.statSync(existing);
      if (!info.isDirectory()) throw new Error(`workflow database parent prefix is not a directory: ${existing}`);
      const canonicalExisting = fs.realpathSync(existing);
      return path.resolve(canonicalExisting, path.relative(existing, absolute));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`cannot resolve workflow database parent path: ${absolute}`);
      existing = parent;
    }
  }
}

// Keep SQLite itself behind a private, canonical directory even when callers
// override WORKFLOW_DB. Securing only WORKFLOW_DATA_DIR is insufficient: an
// override like /tmp/workflow.db creates a mode-0644 database under common
// umasks, exposing durable prompts, approvals, artifacts and execution traces.
// Validate existing ancestors before mkdir so a missing child is never created
// below a group/world-writable non-sticky directory.
const DB_PATH = path.join(canonicalizeWorkflowDatabaseDirectory(path.dirname(configuredDbPath)), path.basename(configuredDbPath));
const DB_DIRECTORY = path.dirname(DB_PATH);
assertWorkflowDatabaseDirectory(DB_DIRECTORY, { allowMissing: true });
fs.mkdirSync(DB_DIRECTORY, { recursive: true, mode: 0o700 });
assertWorkflowDatabaseDirectory(DB_DIRECTORY);
secureWorkflowDatabaseFile(DB_PATH);
const db = new DatabaseSync(DB_PATH, { timeout: 5000, enableForeignKeyConstraints: true });
try { secureWorkflowDatabaseFile(DB_PATH); }
catch (error) { try { db.close(); } catch {} throw error; }

db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, title TEXT NOT NULL,
  state TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','completed','failed','cancelled')),
  active_task_id TEXT, provider_waiting INTEGER NOT NULL DEFAULT 0, provider_retry_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_at TEXT, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_conversation_active ON jobs(conversation_key, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), role TEXT NOT NULL,
  description TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
  openclaw_run_id TEXT, openclaw_session_key TEXT, parent_task_id TEXT, dependency_json TEXT NOT NULL DEFAULT '[]', metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id, created_at);
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  role TEXT NOT NULL,
  openclaw_session_key TEXT NOT NULL UNIQUE,
  parent_session_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('CREATED','ACTIVE','PAUSED','STALE','FAILED','TERMINATED')),
  current_turn_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_job ON agent_sessions(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_task ON agent_sessions(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_activity ON agent_sessions(state, last_activity_at);
CREATE TABLE IF NOT EXISTS session_access (
  access_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id),
  accessor_role TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('OBSERVE','MESSAGE','EXECUTE','TAKEOVER')),
  granted_by TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_access_active
  ON session_access(session_id, accessor_role, permission)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_access_session ON session_access(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_access_accessor ON session_access(accessor_role, session_id, revoked_at);
CREATE TABLE IF NOT EXISTS session_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(session_id),
  sender_role TEXT NOT NULL,
  recipient_role TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'legacy',
  protocol_version INTEGER NOT NULL DEFAULT 0,
  message_type TEXT NOT NULL DEFAULT 'MESSAGE',
  payload_json TEXT NOT NULL,
  correlation_id TEXT,
  dedupe_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','DELIVERED','ACKED','FAILED')),
  attempt INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_until TEXT,
  delivered_at TEXT,
  acked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_dedupe
  ON session_messages(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_messages_inbox
  ON session_messages(session_id, recipient_role, status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_correlation
  ON session_messages(session_id, correlation_id, created_at);
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')), actor TEXT NOT NULL, raw_text TEXT NOT NULL,
  proposal_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
  status TEXT NOT NULL CHECK (status IN ('started','completed','failed','timeout','cancelled')),
  openclaw_run_id TEXT, started_at TEXT NOT NULL, finished_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS results (
  result_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','partial')), content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), task_id TEXT,
  kind TEXT NOT NULL, uri TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  report_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), kind TEXT NOT NULL,
  content TEXT NOT NULL, delivered_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), type TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, created_at);
CREATE TABLE IF NOT EXISTS workflow_events (
  workflow_event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  from_phase TEXT,
  to_phase TEXT NOT NULL,
  event TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_events_job ON workflow_events(job_id, created_at);
CREATE TABLE IF NOT EXISTS slack_threads (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id), channel TEXT NOT NULL, target TEXT NOT NULL,
  root_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_projections (
  event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id),
  channel TEXT NOT NULL, target TEXT NOT NULL, message_id TEXT, projected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_projection_uncertain (
  event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id),
  channel TEXT NOT NULL, target TEXT NOT NULL, error TEXT NOT NULL, marked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_job_views (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
  state TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_waiting INTEGER NOT NULL DEFAULT 0,
  provider_retry_at TEXT,
  task_total INTEGER NOT NULL DEFAULT 0,
  task_pending INTEGER NOT NULL DEFAULT 0,
  task_running INTEGER NOT NULL DEFAULT 0,
  task_completed INTEGER NOT NULL DEFAULT 0,
  task_failed INTEGER NOT NULL DEFAULT 0,
  last_event_type TEXT,
  last_event_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_batches (
  batch_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  parent_task_id TEXT REFERENCES tasks(task_id),
  role TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','WAITING','COMPLETED','FAILED','CANCELLED')),
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  aggregate_content TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_execution_batches_job ON execution_batches(job_id, created_at);
CREATE TABLE IF NOT EXISTS execution_batch_items (
  batch_id TEXT NOT NULL REFERENCES execution_batches(batch_id),
  item_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  command TEXT NOT NULL,
  cwd TEXT,
  timeout_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','TIMEOUT','CANCELLED')),
  execution_session_id TEXT,
  execution_pid INTEGER,
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  PRIMARY KEY (batch_id, item_id),
  UNIQUE (batch_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_execution_batch_items_task ON execution_batch_items(task_id, batch_id);
CREATE TABLE IF NOT EXISTS workflow_runtime_state (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
  phase TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  resume_after TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_leases (
  lease_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  attempt INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','EXPIRED','RELEASED','COMPLETED','FAILED')),
  issued_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_leases_active_task ON task_leases(task_id) WHERE state='ACTIVE';
CREATE INDEX IF NOT EXISTS idx_task_leases_expiry ON task_leases(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_task_leases_worker ON task_leases(worker_id, state);
CREATE TABLE IF NOT EXISTS task_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  attempt INTEGER NOT NULL,
  checkpoint_commit TEXT NOT NULL,
  checkpoint_ref TEXT,
  provider_run_id TEXT,
  evidence_artifact TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_checkpoints_attempt ON task_checkpoints(task_id, attempt);
CREATE INDEX IF NOT EXISTS idx_task_checkpoints_latest ON task_checkpoints(task_id, created_at DESC);
CREATE TABLE IF NOT EXISTS workflow_plans (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  compiled_at TEXT NOT NULL,
  approved_at TEXT
);
`);

for (const sql of [
  "ALTER TABLE artifacts ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE artifacts ADD COLUMN producer_role TEXT",
  "ALTER TABLE artifacts ADD COLUMN content TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE artifacts ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE artifacts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
  "ALTER TABLE artifacts ADD COLUMN supersedes TEXT",
  "ALTER TABLE artifacts ADD COLUMN content_hash TEXT"
]) {
  try { db.exec(sql); } catch (err) {
    if (!String(err?.message || err).toLowerCase().includes('duplicate column')) throw err;
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_job_created ON artifacts(job_id, created_at); CREATE INDEX IF NOT EXISTS idx_artifacts_task_created ON artifacts(task_id, created_at); CREATE INDEX IF NOT EXISTS idx_artifacts_type_status ON artifacts(kind, status, created_at);');

try { db.exec('ALTER TABLE approvals ADD COLUMN proposal_hash TEXT'); } catch (_) {}
db.exec('CREATE INDEX IF NOT EXISTS idx_approvals_job_created ON approvals(job_id, created_at DESC);');

const WORKFLOW_PHASES = Object.freeze([
  'PROPOSED', 'APPROVED', 'SPAWN_CTO', 'ASSIGN_CHILDREN', 'RUN_CHILDREN',
  'WAIT', 'VALIDATE_EVIDENCE', 'SYNTHESIZE', 'TERMINALIZE', 'PROJECT',
  'COMPLETED', 'FAILED'
]);
const WORKFLOW_TRANSITIONS = Object.freeze({
  PROPOSED: new Set(['APPROVED', 'FAILED']),
  APPROVED: new Set(['SPAWN_CTO', 'FAILED']),
  SPAWN_CTO: new Set(['ASSIGN_CHILDREN', 'FAILED']),
  ASSIGN_CHILDREN: new Set(['RUN_CHILDREN', 'WAIT', 'FAILED']),
  RUN_CHILDREN: new Set(['WAIT', 'FAILED']),
  WAIT: new Set(['WAIT', 'ASSIGN_CHILDREN', 'VALIDATE_EVIDENCE', 'FAILED']),
  VALIDATE_EVIDENCE: new Set(['SYNTHESIZE', 'FAILED']),
  SYNTHESIZE: new Set(['TERMINALIZE', 'ASSIGN_CHILDREN', 'FAILED']),
  TERMINALIZE: new Set(['PROJECT', 'FAILED']),
  PROJECT: new Set(['COMPLETED', 'FAILED']),
  COMPLETED: new Set(),
  FAILED: new Set()
});

for (const sql of [
  "ALTER TABLE jobs ADD COLUMN provider_waiting INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE jobs ADD COLUMN provider_retry_at TEXT"
]) {
  try { db.exec(sql); } catch (err) {
    if (!String(err?.message || err).toLowerCase().includes('duplicate column')) throw err;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS m12_native_specialist_runtime (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','COMPLETED','FAILED','STALE')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, attempt),
  UNIQUE (native_session_id),
  UNIQUE (run_id)
);
CREATE INDEX IF NOT EXISTS idx_m12_native_runtime_run ON m12_native_specialist_runtime(run_id);
CREATE INDEX IF NOT EXISTS idx_m12_native_runtime_lease ON m12_native_specialist_runtime(lease_id);
`);

// Forward-compatible migrations for databases created by earlier phases.
for (const sql of [
  "ALTER TABLE tasks ADD COLUMN parent_task_id TEXT",
  "ALTER TABLE tasks ADD COLUMN dependency_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE tasks ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE tasks ADD COLUMN execution_session_id TEXT",
  "ALTER TABLE tasks ADD COLUMN execution_status TEXT",
  "ALTER TABLE tasks ADD COLUMN execution_attempt INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE tasks ADD COLUMN execution_pid INTEGER",
  "ALTER TABLE tasks ADD COLUMN execution_exit_code INTEGER",
  "ALTER TABLE tasks ADD COLUMN execution_started_at TEXT",
  "ALTER TABLE tasks ADD COLUMN execution_finished_at TEXT",
  "ALTER TABLE tasks ADD COLUMN execution_stdout TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE tasks ADD COLUMN execution_stderr TEXT NOT NULL DEFAULT ''"
]) {
  try { db.exec(sql); } catch (err) {
    if (!String(err?.message || err).toLowerCase().includes('duplicate column')) throw err;
  }
}
for (const sql of [
  "ALTER TABLE session_messages ADD COLUMN protocol TEXT NOT NULL DEFAULT 'legacy'",
  "ALTER TABLE session_messages ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 0"
]) {
  try { db.exec(sql); } catch (err) {
    if (!String(err?.message || err).toLowerCase().includes('duplicate column')) throw err;
  }
}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_runtime ON tasks(openclaw_run_id, openclaw_session_key)'); } catch (_) {}
try { db.exec("ALTER TABLE execution_batch_items ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1"); } catch (err) {
  if (!String(err?.message || err).toLowerCase().includes('duplicate column')) throw err;
}
for (const sql of [
  "ALTER TABLE execution_batch_items ADD COLUMN cwd TEXT",
  "ALTER TABLE execution_batch_items ADD COLUMN timeout_ms INTEGER"
]) {
  try { db.exec(sql); } catch (err) {
    if (!String(err?.message || err).toLowerCase().includes('duplicate column')) throw err;
  }
}
// Owner epochs fence stale workers across lease recovery and reacquisition.
// Existing rows remain historical; a caller still needs an exact live proof.
try { db.exec('ALTER TABLE task_leases ADD COLUMN owner_epoch INTEGER NOT NULL DEFAULT 1'); } catch (err) {
  if (!String(err?.message || err).toLowerCase().includes('duplicate column')) throw err;
}
// Backfill the registry from durable task runtime identities created by older phases.
// This is metadata reconstruction only; it does not spawn, resume, or terminate any runtime.
try {
  const ts = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO agent_sessions(
    session_id, job_id, task_id, role, openclaw_session_key, parent_session_key,
    state, current_turn_id, attempt, created_at, updated_at, last_activity_at
  )
  SELECT
    'session_' || lower(hex(randomblob(16))),
    t.job_id,
    t.task_id,
    t.role,
    t.openclaw_session_key,
    NULL,
    CASE WHEN t.status = 'running' THEN 'ACTIVE'
         WHEN t.status = 'pending' THEN 'CREATED'
         ELSE 'PAUSED' END,
    NULL,
    1,
    t.created_at,
    t.updated_at,
    t.updated_at
  FROM tasks t
  WHERE t.openclaw_session_key IS NOT NULL AND trim(t.openclaw_session_key) <> ''`).run();
  db.prepare(`UPDATE agent_sessions SET updated_at = ? WHERE openclaw_session_key IN (
    SELECT openclaw_session_key FROM tasks WHERE openclaw_session_key IS NOT NULL
  ) AND updated_at IS NULL`).run(ts);
} catch (err) {
  console.warn('[WorkflowStore] Agent session registry backfill skipped:', err?.message || err);
}

function now() { return new Date().toISOString(); }
function id(prefix) { return prefix + '_' + crypto.randomUUID(); }
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function eventId(jobId, type, dedupeKey = '') { return hash(`${jobId}|${type}|${dedupeKey}`); }
export function conversationKeyFromMessages(messages) {
  const first = (messages || []).find(m => {
    if (m?.role !== 'user') return false;
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    return text && !text.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') && !text.includes('[Subagent Context]');
  });
  const text = typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content || '');
  return hash(text.trim().replace(/^\[[^\]]+\]\s*/, ''));
}

export class WorkflowStore {
  constructor(database = db) {
    this.db = database;
    initializeWorkflowPolicyStore(this.db);
  }
  getActiveJob(conversationKey) {
    return this.db.prepare("SELECT * FROM jobs WHERE conversation_key = ? AND status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(conversationKey) || null;
  }

  getLatestProposedJob() {
    return this.db.prepare("SELECT * FROM jobs WHERE status = 'active' AND state = 'PROPOSED' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() || null;
  }
  getJob(jobId) { return this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) || null; }
  createArtifact(input) {
    const task = this.getTask(input.task_id);
    if (!task) throw new Error(`task not found: ${input.task_id}`);
    if (task.job_id !== input.job_id) throw new Error('artifact job/task mismatch');
    if (input.producer_role && String(input.producer_role).toLowerCase() !== String(task.role).toLowerCase()) {
      throw new Error('artifact producer role does not match owning task role');
    }
    if (input.producer_role) {
      let metadata = {};
      try { metadata = parseStrictJson(task.metadata_json || '{}'); } catch {}
      const executionPlan = this.getExecutionPlan(task.job_id);
      const taskRole = String(task.role).toLowerCase();
      const plannedByRole = executionPlan?.children?.find(item => String(item.role).toLowerCase() === taskRole);
      const plannedById = metadata.workflow_plan_task_id
        ? executionPlan?.children?.find(item => item.id === metadata.workflow_plan_task_id)
        : null;
      if (isSupportedWorkflow(this.getJob(task.job_id)) && taskRole !== 'cto' && metadata.workflow_plan_task_id &&
          (!plannedById || !plannedByRole || plannedById.id !== plannedByRole.id)) {
        throw new Error('task workflow_plan_task_id does not match the immutable plan entry for its role');
      }
      const plannedTask = plannedByRole || plannedById;
      const expectedType = plannedTask?.execution?.output_artifact_type || metadata.output_artifact_type || getAgentArtifactType(input.producer_role);
      if (expectedType && expectedType !== input.type) throw new Error('artifact type ' + input.type + ' is not allowed for producer role ' + input.producer_role);
    }
    const artifact = createArtifactRecord(input);
    const ts = artifact.created_at;
    // Bind the event ledger to the exact serialized artifact bytes. Without
    // this digest, a durable artifact row and its content_hash could be
    // rewritten together while the creation event still appeared consistent.
    const creationEvent = { artifactId: artifact.artifact_id, taskId: artifact.task_id, type: artifact.type, status: artifact.status, supersedes: artifact.supersedes, contentHash: artifact.content_hash };
    const creationEventPayload = JSON.stringify(creationEvent);
    const creationEventId = eventId(artifact.job_id, 'artifact.created', artifact.artifact_id);
    const assertCreationEventLink = () => {
      const row = this.db.prepare('SELECT job_id, type, payload_json FROM events WHERE event_id=?').get(creationEventId);
      if (!row || row.job_id !== artifact.job_id || row.type !== 'artifact.created' || row.payload_json !== creationEventPayload) {
        throw new Error(`artifact creation event lineage mismatch: ${artifact.artifact_id}`);
      }
    };
    // A savepoint composes with both standalone calls and callers that already
    // own a transaction. Supersession, row insertion, creation event, and the
    // read-back validation must either all succeed or all roll back together.
    this.db.exec('SAVEPOINT create_artifact_record');
    try {
      const existing = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifact.artifact_id);
      if (existing) {
      // Idempotency is valid only when every durable lineage-bearing field
      // matches. Comparing content hash/type/task alone used to accept a retry
      // with different evidence references, producer role, status, or
      // supersession metadata and silently return the older artifact. That can
      // make callers believe new provenance was persisted when it was not.
      const serializedContent = typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content);
      const same = existing.job_id === artifact.job_id &&
        existing.task_id === artifact.task_id &&
        existing.kind === artifact.type &&
        Number(existing.schema_version || 1) === artifact.schema_version &&
        (existing.producer_role ?? null) === (artifact.producer_role ?? null) &&
        existing.content === serializedContent &&
        existing.content_hash === artifact.content_hash &&
        existing.evidence_json === JSON.stringify(artifact.evidence) &&
        existing.status === artifact.status &&
        (existing.supersedes ?? null) === (artifact.supersedes ?? null) &&
        existing.uri === `artifact://${artifact.artifact_id}` &&
        existing.metadata_json === JSON.stringify({ schema_version: artifact.schema_version });
      if (!same) throw new Error(`artifact id collision: ${artifact.artifact_id}`);
        const persisted = this.getArtifact(artifact.artifact_id);
        assertCreationEventLink();
        this.db.exec('RELEASE SAVEPOINT create_artifact_record');
        return persisted;
      }
      if (artifact.supersedes) {
        const previous = this.getArtifact(artifact.supersedes);
        if (!previous || previous.job_id !== artifact.job_id) throw new Error('artifact supersedes unknown artifact');
        if (previous.status === ArtifactStatus.SUPERSEDED) throw new Error('artifact supersedes an already superseded artifact');
        if (previous.type !== artifact.type) throw new Error('artifact type cannot change during supersession');
        this.db.prepare('UPDATE artifacts SET status = ? WHERE artifact_id = ?').run(ArtifactStatus.SUPERSEDED, previous.artifact_id);
      }
      this.db.prepare(`INSERT INTO artifacts(artifact_id, job_id, task_id, kind, uri, metadata_json, created_at, schema_version, producer_role, content, evidence_json, status, supersedes, content_hash)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        artifact.artifact_id, artifact.job_id, artifact.task_id, artifact.type, `artifact://${artifact.artifact_id}`,
        JSON.stringify({ schema_version: artifact.schema_version }), ts, artifact.schema_version, artifact.producer_role,
        typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content), JSON.stringify(artifact.evidence), artifact.status,
        artifact.supersedes, artifact.content_hash
      );
      this.recordEvent(artifact.job_id, 'artifact.created', creationEvent, artifact.artifact_id);
      const persisted = this.getArtifact(artifact.artifact_id);
      // recordEvent is intentionally idempotent for general event traffic, but
      // INSERT OR IGNORE alone cannot prove that this exact event was inserted:
      // a conflicting pre-existing event ID must abort this artifact transaction.
      assertCreationEventLink();
      this.db.exec('RELEASE SAVEPOINT create_artifact_record');
      return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT create_artifact_record'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT create_artifact_record'); } catch {}
      throw error;
    }
  }
  getArtifact(artifactId) {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId);
    return row ? this.hydrateArtifact(row) : null;
  }
  listArtifacts(jobId, { taskId = null, type = null, activeOnly = false } = {}) {
    const clauses = ['job_id = ?']; const params = [jobId];
    if (taskId) { clauses.push('task_id = ?'); params.push(taskId); }
    if (type) { clauses.push('kind = ?'); params.push(type); }
    if (activeOnly) clauses.push("status = 'active'");
    return this.db.prepare(`SELECT * FROM artifacts WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, rowid ASC`).all(...params).map(row => this.hydrateArtifact(row));
  }
  getLatestArtifact(jobId, type) {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE job_id = ? AND kind = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId, type);
    return row ? this.hydrateArtifact(row) : null;
  }
  prepareStandardEngineeringRework(jobId) {
    const plan = this.getExecutionPlan(jobId);
    if (String(plan?.workflow_id || '').toLowerCase() !== 'standard-engineering') return { prepared: false, reason: 'not-standard-engineering' };
    const decisionRow = this.db.prepare("SELECT * FROM artifacts WHERE job_id=? AND kind='cto-decision' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId);
    const decisionArtifact = decisionRow ? this.hydrateArtifact(decisionRow) : null;
    if (!decisionArtifact) return { prepared: false, reason: 'cto-decision-missing' };
    const decision = decisionArtifact.content;
    if (decision?.decision !== 'rework') return { prepared: false, reason: 'decision-is-not-rework' };
    const existing = this.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='workflow.rework.prepared' AND json_extract(payload_json,'$.decisionArtifactId')=? LIMIT 1").get(jobId, decisionArtifact.artifact_id);
    if (existing) {
      try { return { prepared: true, idempotent: true, ...parseStrictJson(existing.payload_json) }; } catch (_) { return { prepared: true, idempotent: true }; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const reviewRow = this.db.prepare("SELECT * FROM artifacts WHERE job_id=? AND kind='review' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId);
      const review = reviewRow ? this.hydrateArtifact(reviewRow) : null;
      if (!review) throw new Error(`cannot prepare rework without ReviewArtifact: ${jobId}`);
      const reviewContent = review.content || {};
      const targets = new Set(['reviewer']);
      if (reviewContent.requirementsSatisfied === false) ['product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer'].forEach(role => targets.add(role));
      if (reviewContent.architectureConformant === false) ['architect', 'engineer', 'security', 'qa', 'platform', 'writer'].forEach(role => targets.add(role));
      if (reviewContent.securityAccepted === false) ['engineer', 'security'].forEach(role => targets.add(role));
      if (reviewContent.qaAccepted === false) ['engineer', 'qa'].forEach(role => targets.add(role));
      if (reviewContent.platformAccepted === false) ['engineer', 'platform'].forEach(role => targets.add(role));
      if (reviewContent.documentationAccepted === false) ['engineer', 'writer'].forEach(role => targets.add(role));
      const planByRole = new Map((plan.children || []).map(spec => [String(spec.role).toLowerCase(), spec]));
      const targetRoles = [...targets].filter(role => planByRole.has(role));
      const invalidatedTypes = new Set(targetRoles.map(role => getAgentArtifactType(role)));
      invalidatedTypes.add('review');
      invalidatedTypes.add('cto-decision');
      const invalidatedArtifacts = [];
      for (const type of invalidatedTypes) {
        const rows = this.db.prepare("SELECT artifact_id FROM artifacts WHERE job_id=? AND kind=? AND status='active'").all(jobId, type);
        this.db.prepare("UPDATE artifacts SET status=? WHERE job_id=? AND kind=? AND status='active'").run(ArtifactStatus.INVALIDATED, jobId, type);
        invalidatedArtifacts.push(...rows.map(row => row.artifact_id));
      }
      const createdTasks = [];
      const cto = this.db.prepare("SELECT task_id FROM tasks WHERE job_id=? AND role='cto' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId);
      for (const role of targetRoles) {
        const spec = planByRole.get(role);
        const previous = this.db.prepare("SELECT task_id FROM tasks WHERE job_id=? AND parent_task_id=? AND role=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId, cto?.task_id || null, spec.role);
        const task = this.createChildTask(jobId, {
          parentTaskId: cto?.task_id || null,
          role: spec.role,
          description: `Rework revision for ${spec.role} after CTO decision ${decisionArtifact.artifact_id}.`,
          dependencies: spec.dependencies || [],
          metadata: { rework: true, rework_of_task_id: previous?.task_id || null, rework_of_artifact_id: decisionArtifact.artifact_id, workflow_plan_task_id: spec.id }
        });
        createdTasks.push(task.task_id);
      }
      const payload = { decisionArtifactId: decisionArtifact.artifact_id, reviewArtifactId: review.artifact_id, targetRoles, createdTasks, invalidatedArtifacts };
      this.recordEvent(jobId, 'workflow.artifacts.invalidated', { decisionArtifactId: decisionArtifact.artifact_id, artifactIds: invalidatedArtifacts }, `${jobId}|artifact-invalidation|${decisionArtifact.artifact_id}`);
      this.recordEvent(jobId, 'workflow.rework.prepared', payload, `${jobId}|rework|${decisionArtifact.artifact_id}`);
      this.db.exec('COMMIT');
      return { prepared: true, idempotent: false, ...payload };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }
  prepareReviewDrivenRework(jobId, { reason } = {}) {
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!normalizedReason || normalizedReason.length > 4000) throw new Error('workflow rework requires a concise non-empty reason (max 4000 characters)');
    this.assertApprovalCurrent(jobId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.getJob(jobId);
      if (!job || job.state !== 'EXECUTING' || job.status !== 'active') throw new Error(`workflow rework requires an active executing workflow: ${jobId}`);
      const plan = this.getExecutionPlan(jobId);
      if (String(plan?.workflow_id || '').toLowerCase() !== 'standard-engineering' || Number(plan?.workflow_version) < 2) throw new Error('workflow rework is only supported for standard-engineering workflow version 2 or later');
      const parent = this.getTask(job.active_task_id);
      if (!parent || parent.role !== 'cto' || parent.status !== 'running') throw new Error('workflow rework requires the active running CTO coordinator task');
      const priorReworkEvent = this.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='workflow.review_rework.prepared' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId);
      if (priorReworkEvent) {
        const payload = parseStrictJson(priorReworkEvent.payload_json, 'workflow review rework event payload');
        const tasks = (payload.createdTasks || []).map(taskId => this.getTask(taskId));
        const allStillPresent = tasks.length > 0 && tasks.every(task => task && ['pending', 'running', 'completed'].includes(task.status));
        const currentActiveReview = this.db.prepare("SELECT artifact_id FROM artifacts WHERE job_id=? AND kind='review' AND status='active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId);
        if (allStillPresent && (!currentActiveReview || currentActiveReview.artifact_id === payload.reviewArtifactId)) {
          this.db.exec('COMMIT');
          return { prepared: true, idempotent: true, ...payload, tasks };
        }
      }
      const reviewRow = this.db.prepare("SELECT * FROM artifacts WHERE job_id=? AND kind='review' AND status='active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId);
      if (!reviewRow) throw new Error('workflow rework requires an active reviewer artifact');
      const reviewArtifact = this.hydrateArtifact(reviewRow);
      const review = reviewArtifact.content || {};
      if (!['needs_changes', 'reject'].includes(review.decision)) throw new Error('workflow rework requires a reviewer decision of needs_changes or reject');
      if (Array.isArray(review.securityIssues) && review.securityIssues.length && review.securityAccepted !== false) throw new Error('review findings are internally inconsistent; resolve security review data before rework');
      const children = this.db.prepare('SELECT * FROM tasks WHERE job_id=? AND parent_task_id=? ORDER BY created_at ASC, rowid ASC').all(jobId, parent.task_id);
      const unsettled = children.filter(task => task.status !== 'completed');
      if (unsettled.length) throw new Error(`workflow rework requires all current specialist tasks to be completed: ${unsettled.map(task => `${task.role}:${task.status}`).join(', ')}`);
      const reviewerTask = this.getTask(reviewArtifact.task_id);
      if (!reviewerTask || reviewerTask.role !== 'reviewer' || reviewerTask.status !== 'completed' || reviewerTask.parent_task_id !== parent.task_id) throw new Error('active review artifact is not owned by the completed reviewer task under the active CTO parent');
      const specs = plan.children || [];
      const roles = new Set(['reviewer']);
      if (review.requirementsSatisfied === false) ['product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer'].forEach(role => roles.add(role));
      if (review.architectureConformant === false) ['architect', 'engineer', 'security', 'qa', 'platform', 'writer'].forEach(role => roles.add(role));
      if (review.securityAccepted === false) ['engineer', 'security'].forEach(role => roles.add(role));
      if (review.qaAccepted === false) ['engineer', 'qa'].forEach(role => roles.add(role));
      if (review.platformAccepted === false) ['engineer', 'platform'].forEach(role => roles.add(role));
      if (review.documentationAccepted === false) ['engineer', 'writer'].forEach(role => roles.add(role));
      if (Array.isArray(review.implementationIssues) && review.implementationIssues.length) roles.add('engineer');
      if (Array.isArray(review.securityIssues) && review.securityIssues.length) ['engineer', 'security'].forEach(role => roles.add(role));
      const targetSpecs = specs.filter(spec => roles.has(String(spec.role).toLowerCase()));
      if (!targetSpecs.some(spec => String(spec.role).toLowerCase() === 'reviewer')) throw new Error('immutable plan does not include a reviewer task');
      const latestTaskForSpec = spec => children.filter(task => {
        try { return parseStrictJson(task.metadata_json || '{}', 'task metadata').workflow_plan_task_id === spec.id; } catch { return false; }
      }).at(-1);
      const invalidateIds = [];
      const createSpecs = [];
      for (const spec of targetSpecs) {
        const previous = latestTaskForSpec(spec);
        if (!previous || previous.status !== 'completed') throw new Error(`cannot rework ${spec.role}: latest planned task is missing or incomplete`);
        const expectedType = String(spec.role).toLowerCase() === 'reviewer' ? 'review' : getAgentArtifactType(spec.role);
        const active = this.db.prepare("SELECT artifact_id FROM artifacts WHERE job_id=? AND task_id=? AND kind=? AND status='active' ORDER BY created_at DESC, rowid DESC").all(jobId, previous.task_id, expectedType);
        if (active.length !== 1) throw new Error(`cannot rework ${spec.role}: expected exactly one active ${expectedType} artifact for prior task`);
        invalidateIds.push(active[0].artifact_id);
        createSpecs.push({ spec, previous, priorArtifactId: active[0].artifact_id });
      }
      for (const artifactId of invalidateIds) {
        const updated = this.db.prepare("UPDATE artifacts SET status=? WHERE artifact_id=? AND job_id=? AND status='active'").run(ArtifactStatus.INVALIDATED, artifactId, jobId);
        if (updated.changes !== 1) throw new Error(`artifact invalidation lost a concurrent update: ${artifactId}`);
      }
      const createdTasks = [];
      for (const { spec, previous, priorArtifactId } of createSpecs) {
        const task = this.createChildTask(jobId, {
          parentTaskId: parent.task_id,
          role: spec.role,
          description: `Evidence-driven rework for ${spec.role} after reviewer finding in ${reviewArtifact.artifact_id}: ${normalizedReason}`,
          dependencies: spec.dependencies || [],
          metadata: { ...(spec.execution || {}), rework: true, rework_of_task_id: previous.task_id, rework_of_artifact_id: priorArtifactId, workflow_plan_task_id: spec.id }
        });
        createdTasks.push(task.task_id);
      }
      const payload = { jobId, parentTaskId: parent.task_id, reviewArtifactId: reviewArtifact.artifact_id, previousReviewerTaskId: reviewerTask.task_id, targetRoles: createSpecs.map(entry => entry.spec.role), createdTasks, invalidatedArtifacts: invalidateIds, reason: normalizedReason, planHash: plan.plan_hash };
      this.recordEvent(jobId, 'workflow.artifacts.invalidated', { reviewArtifactId: reviewArtifact.artifact_id, artifactIds: invalidateIds }, `${jobId}|review-rework-invalidation|${reviewArtifact.artifact_id}`);
      this.recordEvent(jobId, 'workflow.review_rework.prepared', payload, `${jobId}|review-rework|${reviewArtifact.artifact_id}`);
      this.db.exec('COMMIT');
      return { prepared: true, idempotent: false, ...payload, tasks: createdTasks.map(taskId => this.getTask(taskId)) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }
  prepareReviewerRevision(jobId, { reason } = {}) {
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!normalizedReason || normalizedReason.length > 4000) {
      throw new Error('reviewer revision requires a concise non-empty reason (max 4000 characters)');
    }
    this.assertApprovalCurrent(jobId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.getJob(jobId);
      if (!job || job.state !== 'EXECUTING' || job.status !== 'active') {
        throw new Error(`reviewer revision requires an active executing workflow: ${jobId}`);
      }
      const plan = this.getExecutionPlan(jobId);
      if (String(plan?.workflow_id || '').toLowerCase() !== 'standard-engineering' || Number(plan?.workflow_version) < 2) {
        throw new Error('reviewer revision is only supported for standard-engineering workflow version 2 or later');
      }
      const parent = this.getTask(job.active_task_id);
      if (!parent || parent.role !== 'cto' || parent.status !== 'running') {
        throw new Error('reviewer revision requires the active running CTO coordinator task');
      }

      const pendingRevisionEvent = this.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='workflow.reviewer.revision_requested' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId);
      if (pendingRevisionEvent) {
        const payload = parseStrictJson(pendingRevisionEvent.payload_json, 'reviewer revision event payload');
        const task = this.getTask(payload.revisionTaskId);
        const stillSameReview = this.db.prepare("SELECT 1 AS found FROM artifacts WHERE artifact_id=? AND status='invalidated' AND job_id=? AND kind='review'").get(payload.reviewArtifactId, jobId);
        if (task && ['pending', 'running'].includes(task.status) && stillSameReview) {
          this.db.exec('COMMIT');
          return { prepared: true, idempotent: true, ...payload, task };
        }
      }

      const activeReviewRow = this.db.prepare("SELECT * FROM artifacts WHERE job_id=? AND kind='review' AND status='active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId);
      if (!activeReviewRow) throw new Error('reviewer revision requires a current active review artifact');
      const reviewArtifact = this.hydrateArtifact(activeReviewRow);

      const priorEvent = this.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='workflow.reviewer.revision_requested' AND json_extract(payload_json,'$.reviewArtifactId')=? LIMIT 1")
        .get(jobId, reviewArtifact.artifact_id);
      if (priorEvent) {
        const payload = parseStrictJson(priorEvent.payload_json, 'reviewer revision event payload');
        const task = this.getTask(payload.revisionTaskId);
        if (!task || task.job_id !== jobId || task.parent_task_id !== parent.task_id || task.role !== 'reviewer') {
          throw new Error('idempotent reviewer revision event does not bind its planned reviewer task');
        }
        this.db.exec('COMMIT');
        return { prepared: true, idempotent: true, ...payload, task };
      }

      const review = reviewArtifact.content || {};
      if (review.decision !== 'accept' ||
          !['requirementsSatisfied', 'architectureConformant', 'securityAccepted', 'qaAccepted', 'platformAccepted', 'documentationAccepted'].every(field => review[field] === true) ||
          !['implementationIssues', 'securityIssues', 'blockingIssues'].every(field => Array.isArray(review[field]) && review[field].length === 0) ||
          !Array.isArray(review.evidenceIssues) || review.evidenceIssues.length === 0 ||
          !review.evidenceIssues.every(item => typeof item === 'string')) {
        throw new Error('reviewer revision is only allowed for an accepted review whose sole findings are documented evidence limitations');
      }

      const reviewerSpec = (plan.children || []).find(spec => String(spec.role).toLowerCase() === 'reviewer');
      if (!reviewerSpec) throw new Error('reviewer revision requires a reviewer in the immutable plan');
      const children = this.db.prepare('SELECT * FROM tasks WHERE job_id=? AND parent_task_id=? ORDER BY created_at ASC, rowid ASC').all(jobId, parent.task_id);
      const unsettled = children.filter(task => task.status !== 'completed');
      if (unsettled.length) throw new Error(`reviewer revision requires all prior workflow tasks to be completed: ${unsettled.map(task => `${task.role}:${task.status}`).join(', ')}`);
      const currentReviewer = this.getTask(reviewArtifact.task_id);
      if (!currentReviewer || currentReviewer.job_id !== jobId || currentReviewer.parent_task_id !== parent.task_id || currentReviewer.role !== 'reviewer' || currentReviewer.status !== 'completed') {
        throw new Error('active review artifact is not owned by the completed reviewer task under the active CTO parent');
      }
      const reviewerMetadata = parseStrictJson(currentReviewer.metadata_json || '{}', 'reviewer task metadata');
      if (reviewerMetadata.workflow_plan_task_id !== reviewerSpec.id) {
        throw new Error('active review artifact is not bound to the immutable reviewer plan task');
      }

      this.db.prepare("UPDATE artifacts SET status=? WHERE artifact_id=? AND job_id=? AND kind='review' AND status='active'")
        .run(ArtifactStatus.INVALIDATED, reviewArtifact.artifact_id, jobId);
      const revisionTask = this.createChildTask(jobId, {
        parentTaskId: parent.task_id,
        role: reviewerSpec.role,
        description: `Review revision for reviewer after documented evidence limitation in ${reviewArtifact.artifact_id}.`,
        dependencies: reviewerSpec.dependencies || [],
        metadata: {
          rework: true,
          rework_of_task_id: currentReviewer.task_id,
          rework_of_artifact_id: reviewArtifact.artifact_id,
          workflow_plan_task_id: reviewerSpec.id
        }
      });
      const payload = {
        jobId,
        parentTaskId: parent.task_id,
        reviewArtifactId: reviewArtifact.artifact_id,
        previousReviewerTaskId: currentReviewer.task_id,
        revisionTaskId: revisionTask.task_id,
        reason: normalizedReason,
        planHash: plan.plan_hash
      };
      this.recordEvent(jobId, 'workflow.reviewer.revision_requested', payload, `${jobId}|reviewer-revision|${reviewArtifact.artifact_id}`);
      this.db.exec('COMMIT');
      return { prepared: true, idempotent: false, ...payload, task: revisionTask };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }
  hydrateArtifact(row) {
    const content = row.content;
    const parsed = (() => { try { return parseStrictJson(content); } catch (_) { return content; } })();
    const artifact = { artifact_id: row.artifact_id, job_id: row.job_id, task_id: row.task_id, type: row.kind, schema_version: Number(row.schema_version || 1), producer_role: row.producer_role, content: parsed, evidence: parseStrictJson(row.evidence_json || '[]'), status: row.status, created_at: row.created_at, supersedes: row.supersedes, content_hash: row.content_hash };
    validateArtifact(artifact);
    return artifact;
  }
  getWorkflowRuntimeState(jobId) {
    return this.db.prepare('SELECT * FROM workflow_runtime_state WHERE job_id = ?').get(jobId) || null;
  }
  getExecutionPlan(jobId) {
    const row = this.db.prepare('SELECT * FROM workflow_plans WHERE job_id = ?').get(jobId);
    if (!row) return null;
    let plan;
    try { plan = parseStrictJson(row.plan_json); }
    catch { throw new Error(`immutable execution plan JSON is malformed: ${jobId}`); }
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || row.plan_json !== canonicalJson(plan) ||
        hash(row.plan_json) !== row.plan_hash || plan.job_id !== jobId || row.workflow_id !== plan.workflow_id ||
        Number(row.workflow_version) !== Number(plan.workflow_version)) {
      throw new Error(`immutable execution plan hash, canonical bytes, or row identity mismatch: ${jobId}`);
    }
    try { validateExecutionPlan(plan); }
    catch (error) { throw new Error(`immutable execution plan schema validation failed: ${jobId}: ${error.message}`); }
    const attachedPolicySnapshots = getWorkflowPolicySnapshotsForJob(this.db, jobId);
    const planPolicySnapshots = Array.isArray(plan.policy_packs) ? plan.policy_packs : [];
    if (canonicalJson(attachedPolicySnapshots) !== canonicalJson(planPolicySnapshots)) {
      throw new Error(`immutable execution plan policy attachment ledger mismatch: ${jobId}`);
    }
    if (planPolicySnapshots.length) {
      const job = this.getJob(jobId);
      const proposalPayload = this.getCurrentProposal(jobId)?.payload || {};
      const expectedBaseContract = normalizeSuccessContract(
        proposalPayload.success_contract || { goal: proposalPayload.task || job?.title || jobId },
        job?.title || jobId
      );
      if (canonicalJson(expectedBaseContract) !== canonicalJson(plan.base_success_contract)) {
        throw new Error(`immutable execution plan base success contract mismatch: ${jobId}`);
      }
    }
    const planEvents = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='workflow.plan_compiled'").all(jobId);
    const expectedEventId = eventId(jobId, 'workflow.plan_compiled', row.plan_hash);
    const expectedPayload = { workflowId: plan.workflow_id, workflowVersion: plan.workflow_version, planHash: row.plan_hash };
    if (planEvents.length !== 1 || planEvents[0].event_id !== expectedEventId || planEvents[0].job_id !== jobId ||
        planEvents[0].type !== 'workflow.plan_compiled' || planEvents[0].payload_json !== JSON.stringify(expectedPayload)) {
      throw new Error(`immutable execution plan does not reconcile with its unique canonical compiled event: ${jobId}`);
    }
    return { ...plan, plan_hash: row.plan_hash, compiled_at: row.compiled_at, approved_at: row.approved_at };
  }
  compileExecutionPlan(jobId, { workspace = process.env.WORKFLOW_WORKSPACE, customWorkflow = null, successContract = undefined, roleProfiles = null } = {}) {
    const job = this.getJob(jobId);
    if (!job) throw new Error('job not found: ' + jobId);
    const existing = this.getExecutionPlan(jobId);
    const proposalPayload = this.getCurrentProposal(jobId)?.payload || {};
    const pinnedSuccessContract = successContract ?? proposalPayload.success_contract ?? { goal: proposalPayload.task || job.title };
    const policyPacks = getWorkflowPolicySnapshotsForJob(this.db, jobId);
    // Recompilation during local task/batch execution must reconstruct the same
    // role profile overlay snapshots from exact IDs/versions/hash pins in the
    // approved proposal. Treating an omitted argument as [] silently removed
    // overlays during plan revalidation and made every profile-bound execution
    // fail the immutable-plan comparison. Explicit [] remains meaningful for
    // callers that deliberately compiled a proposal with no overlays.
    const pinnedRoleProfiles = roleProfiles ?? resolveRoleProfileBindings(this.db, proposalPayload.role_profile_bindings || []);
    const plan = compileWorkflowPlan(job, { workspace, customWorkflow, successContract: pinnedSuccessContract, policyPacks, roleProfiles: pinnedRoleProfiles });
    const planJson = canonicalJson(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'plan_hash')));
    if (existing) {
      const storedPlan = this.db.prepare('SELECT plan_json, plan_hash FROM workflow_plans WHERE job_id = ?').get(jobId);
      if (storedPlan?.plan_hash !== plan.plan_hash || storedPlan?.plan_json !== planJson) {
        throw new Error('immutable execution plan mismatch: ' + jobId);
      }
      return existing;
    }
    const ts = now();
    this.db.prepare('INSERT INTO workflow_plans(job_id, workflow_id, workflow_version, plan_hash, plan_json, compiled_at, approved_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(
      jobId, plan.workflow_id, plan.workflow_version, plan.plan_hash, planJson, ts, job.approved_at || ts
    );
    this.recordEvent(jobId, 'workflow.plan_compiled', {
      workflowId: plan.workflow_id, workflowVersion: plan.workflow_version, planHash: plan.plan_hash
    }, plan.plan_hash);
    return this.getExecutionPlan(jobId);
  }
  setWorkflowRuntimeState(jobId, phase, { attempt = null, resumeAfter = null, lastError = null } = {}) {
    const current = this.getWorkflowRuntimeState(jobId);
    const nextAttempt = attempt == null ? (current?.attempt ?? 0) : attempt;
    if (typeof nextAttempt !== 'number' || !Number.isSafeInteger(nextAttempt) || nextAttempt < 0) {
      throw new Error('workflow runtime attempt must be a non-negative safe integer');
    }
    const ts = now();
    this.db.prepare(`
      INSERT INTO workflow_runtime_state(job_id, phase, attempt, resume_after, last_error, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        phase=excluded.phase,
        attempt=excluded.attempt,
        resume_after=excluded.resume_after,
        last_error=excluded.last_error,
        updated_at=excluded.updated_at
    `).run(jobId, phase, nextAttempt, resumeAfter, lastError, ts);
    return this.getWorkflowRuntimeState(jobId);
  }
  setProviderWaiting(jobId, retryAfterMs = 0, reason = null) {
    const retryAt = new Date(Date.now() + Math.max(0, Number(retryAfterMs) || 0)).toISOString();
    const ts = now();
    this.db.prepare('UPDATE jobs SET provider_waiting=1, provider_retry_at=?, updated_at=? WHERE job_id=?').run(retryAt, ts, jobId);
    this.recordEvent(jobId, 'provider.waiting', { retryAfterMs: Math.max(0, Number(retryAfterMs) || 0), retryAt, reason }, `provider-wait|${retryAt}`);
    return this.getJob(jobId);
  }
  clearProviderWaiting(jobId) {
    this.db.prepare('UPDATE jobs SET provider_waiting=0, provider_retry_at=NULL, updated_at=? WHERE job_id=?').run(now(), jobId);
    const runtime = this.getWorkflowRuntimeState(jobId);
    if (runtime?.resume_after || runtime?.last_error) {
      this.setWorkflowRuntimeState(jobId, runtime.phase, {
        attempt: runtime.attempt,
        resumeAfter: null,
        lastError: null
      });
    }
    return this.getJob(jobId);
  }
  createJob({ conversationKey, title }) {
    const jobId = id('job'); const ts = now();
    this.db.prepare("INSERT INTO jobs(job_id, conversation_key, title, state, status, created_at, updated_at) VALUES(?, ?, ?, 'IDLE', 'active', ?, ?)").run(jobId, conversationKey, title || 'Boss request', ts, ts);
    this.setWorkflowRuntimeState(jobId, 'PROPOSED');
    return this.getJob(jobId);
  }
  getOrCreateJob({ conversationKey, title }) { return this.getActiveJob(conversationKey) || this.createJob({ conversationKey, title }); }
  recordEvent(jobId, type, payload = {}, dedupeKey = '') {
    const eid = eventId(jobId, type, dedupeKey); const ts = now();
    this.db.prepare('INSERT OR IGNORE INTO events(event_id, job_id, type, payload_json, created_at) VALUES(?, ?, ?, ?, ?)').run(eid, jobId, type, JSON.stringify(payload), ts);
    return eid;
  }

  getCurrentProposal(jobId) {
    const proposals = this.db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE job_id=? AND type IN ('job.proposal_requested','job.proposal_refined') ORDER BY created_at ASC,rowid ASC")
      .all(jobId);
    const event = proposals.at(-1);
    if (!event) return null;
    let payload;
    try { payload = parseStrictJson(event.payload_json || ''); }
    catch { throw new Error(`current proposal event payload is malformed: ${jobId}`); }
    if (event.job_id !== jobId || !['job.proposal_requested','job.proposal_refined'].includes(event.type) ||
        !payload || typeof payload !== 'object' || Array.isArray(payload) || event.payload_json !== JSON.stringify(payload)) {
      throw new Error(`current proposal event payload is non-canonical or detached from its job: ${jobId}`);
    }
    return { event, payload, proposalHash: hash(canonicalJson(payload)) };
  }

  getLatestApproval(jobId) {
    return this.db.prepare('SELECT * FROM approvals WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(jobId) || null;
  }

  isApprovalCurrent(jobId) {
    const approval = this.getLatestApproval(jobId);
    if (!approval || approval.decision !== 'approved') return false;
    const proposal = this.getCurrentProposal(jobId);
    return !proposal || approval.proposal_hash === proposal.proposalHash;
  }

  assertApprovalCurrent(jobId) {
    if (!this.isApprovalCurrent(jobId)) throw new Error(`approval is not current for immutable proposal: ${jobId}`);
    return true;
  }

  listEvents(jobId, { limit = 200, type = null } = {}) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
    if (type) return this.db.prepare('SELECT * FROM events WHERE job_id=? AND type=? ORDER BY created_at ASC, rowid ASC LIMIT ?').all(jobId, type, safeLimit);
    return this.db.prepare('SELECT * FROM events WHERE job_id=? ORDER BY created_at ASC, rowid ASC LIMIT ?').all(jobId, safeLimit);
  }

  getObservabilitySnapshot(jobId, { eventLimit = 500 } = {}) {
    const events = this.listEvents(jobId, { limit: eventLimit });
    const tasks = this.db.prepare('SELECT task_id,status,execution_attempt,execution_started_at,execution_finished_at FROM tasks WHERE job_id=? ORDER BY created_at ASC').all(jobId);
    const leases = this.db.prepare('SELECT * FROM task_leases WHERE job_id=? ORDER BY issued_at ASC').all(jobId);
    const hasProviderRuns = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_runs' LIMIT 1").get();
    const providerRuns = hasProviderRuns
      ? this.db.prepare('SELECT * FROM provider_runs WHERE job_id=? ORDER BY created_at ASC').all(jobId)
      : [];
    const summary = summarizeObservability({ events, tasks, leases, providerRuns });
    return { schema_version: 1, trace_id: `workflow:${jobId}`, job_id: jobId, generated_at: now(), ...summary };
  }

  hasEvent(jobId, type) {
    return Boolean(this.db.prepare('SELECT 1 FROM events WHERE job_id = ? AND type = ? LIMIT 1').get(jobId, type));
  }
  transitionWorkflowPhase(jobId, toPhase, { attempt = null, resumeAfter = null, lastError = null, event = 'workflow.transition', payload = {} } = {}) {
    if (!WORKFLOW_PHASES.includes(toPhase)) throw new Error(`invalid workflow phase: ${toPhase}`);
    const current = this.getWorkflowRuntimeState(jobId);
    if (!current) throw new Error(`workflow runtime state not found: ${jobId}`);
    const fromPhase = current.phase;
    if (fromPhase === toPhase) {
      return this.setWorkflowRuntimeState(jobId, toPhase, { attempt, resumeAfter, lastError });
    }
    if (!WORKFLOW_TRANSITIONS[fromPhase]?.has(toPhase)) {
      throw new Error(`invalid workflow transition: ${fromPhase} -> ${toPhase}`);
    }
    const next = this.setWorkflowRuntimeState(jobId, toPhase, { attempt, resumeAfter, lastError });
    if (typeof next.attempt !== 'number' || !Number.isSafeInteger(next.attempt) || next.attempt < 0) {
      throw new Error('workflow phase transition refuses a malformed durable runtime attempt');
    }
    this.db.prepare(`INSERT OR IGNORE INTO workflow_events(
      workflow_event_id, job_id, from_phase, to_phase, event, attempt, payload_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id('workflow_event'), jobId, fromPhase, toPhase, event, next.attempt, JSON.stringify(payload), now());
    this.recordEvent(jobId, event, { fromPhase, toPhase, ...payload }, `${fromPhase}|${toPhase}|${attempt ?? next.attempt}`);
    return next;
  }
  failWorkflowVerification(jobId, { reason, errors = [] } = {}) {
    if (typeof jobId !== 'string' || !jobId || typeof reason !== 'string' || !reason.trim() ||
        !Array.isArray(errors) || !errors.every(item => typeof item === 'string' && item.length > 0)) {
      throw new Error('workflow verification failure requires exact job identity, reason, and string errors');
    }
    const payload = { reason, errors };
    const terminalPayloadJson = JSON.stringify(payload);
    const terminalId = eventId(jobId, 'job.failed', 'workflow-verification-failed');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.getJob(jobId);
      if (!job) throw new Error(`workflow verification failure job not found: ${jobId}`);
      const terminalRows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type IN ('job.completed','job.failed')")
        .all(jobId);
      const existingTerminal = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(terminalId);
      if (String(job.state || '').toUpperCase() === 'FAILED') {
        const runtime = this.getWorkflowRuntimeState(jobId);
        if (terminalRows.length !== 1 || !existingTerminal || terminalRows[0].event_id !== terminalId ||
            existingTerminal.job_id !== jobId || existingTerminal.type !== 'job.failed' ||
            existingTerminal.payload_json !== terminalPayloadJson || runtime?.phase !== 'FAILED') {
          throw new Error('workflow verification failure idempotency conflicts with durable terminal lineage');
        }
        this.db.exec('COMMIT');
        return { job: this.getJob(jobId), idempotent: true };
      }
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase()) ||
          ['completed', 'failed', 'cancelled'].includes(String(job.status || '').toLowerCase())) {
        throw new Error(`workflow verification failure refuses to replace terminal job state=${job.state}/${job.status}`);
      }
      if (terminalRows.length || existingTerminal) throw new Error('workflow verification failure conflicts with existing terminal event history');
      const runtime = this.getWorkflowRuntimeState(jobId);
      if (!runtime || typeof runtime.attempt !== 'number' || !Number.isSafeInteger(runtime.attempt) || runtime.attempt < 0) {
        throw new Error('workflow verification failure requires a valid durable workflow runtime attempt');
      }
      const ts = now();
      if (runtime.phase === 'FAILED') {
        const phaseEvents = this.db.prepare("SELECT workflow_event_id,from_phase,to_phase,event,attempt,payload_json FROM workflow_events WHERE job_id=? AND event='workflow.failed' AND to_phase='FAILED'")
          .all(jobId);
        const generalEvents = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='workflow.failed'")
          .all(jobId);
        if (phaseEvents.length !== 1 || generalEvents.length !== 1 ||
            phaseEvents[0].attempt !== runtime.attempt || phaseEvents[0].payload_json !== terminalPayloadJson ||
            generalEvents[0].event_id !== eventId(jobId, 'workflow.failed', `${phaseEvents[0].from_phase}|FAILED|${runtime.attempt}`) ||
            generalEvents[0].payload_json !== JSON.stringify({ fromPhase: phaseEvents[0].from_phase, toPhase: 'FAILED', ...payload })) {
          throw new Error('pre-existing FAILED workflow phase has no exact durable failure event lineage');
        }
      } else {
        const priorPhaseEvents = this.db.prepare("SELECT workflow_event_id FROM workflow_events WHERE job_id=? AND event='workflow.failed'").all(jobId);
        const priorGeneralEvents = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='workflow.failed'").all(jobId);
        if (priorPhaseEvents.length || priorGeneralEvents.length) throw new Error('workflow failure event already exists before failure transition');
        const phaseUpdate = this.db.prepare('UPDATE workflow_runtime_state SET phase=?,resume_after=NULL,last_error=?,updated_at=? WHERE job_id=? AND phase=? AND attempt=?')
          .run('FAILED', reason, ts, jobId, runtime.phase, runtime.attempt);
        if (phaseUpdate.changes !== 1) throw new Error('workflow failure phase compare-and-set did not update exactly one runtime row');
        this.db.prepare(`INSERT INTO workflow_events(
          workflow_event_id,job_id,from_phase,to_phase,event,attempt,payload_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`).run(id('workflow_event'), jobId, runtime.phase, 'FAILED', 'workflow.failed', runtime.attempt, terminalPayloadJson, ts);
        this.recordEvent(jobId, 'workflow.failed', { fromPhase: runtime.phase, toPhase: 'FAILED', ...payload }, `${runtime.phase}|FAILED|${runtime.attempt}`);
      }
      const jobUpdate = this.db.prepare("UPDATE jobs SET state='FAILED',status='failed',completed_at=?,updated_at=?,provider_waiting=0,provider_retry_at=NULL WHERE job_id=? AND state=? AND status=?")
        .run(ts, ts, jobId, job.state, job.status);
      if (jobUpdate.changes !== 1) throw new Error('workflow failure job compare-and-set did not update exactly one observed nonterminal job');
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_WORKFLOW_FAILURE_JOB_UPDATE === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
      this.recordEvent(jobId, 'job.failed', payload, 'workflow-verification-failed');
      const finalTerminalRows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type IN ('job.completed','job.failed')")
        .all(jobId);
      const finalEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(terminalId);
      const finalPhaseEvents = this.db.prepare("SELECT workflow_event_id,from_phase,to_phase,event,attempt,payload_json FROM workflow_events WHERE job_id=? AND event='workflow.failed' AND to_phase='FAILED'")
        .all(jobId);
      const finalWorkflowEvents = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='workflow.failed'")
        .all(jobId);
      const finalJob = this.getJob(jobId);
      const finalRuntime = this.getWorkflowRuntimeState(jobId);
      if (finalTerminalRows.length !== 1 || finalTerminalRows[0].event_id !== terminalId ||
          !finalEvent || finalEvent.job_id !== jobId || finalEvent.type !== 'job.failed' ||
          finalEvent.payload_json !== terminalPayloadJson || finalJob?.state !== 'FAILED' || finalJob?.status !== 'failed' ||
          finalRuntime?.phase !== 'FAILED' || finalRuntime?.last_error !== reason ||
          finalPhaseEvents.length !== 1 || finalPhaseEvents[0].attempt !== finalRuntime.attempt ||
          finalPhaseEvents[0].payload_json !== terminalPayloadJson ||
          finalWorkflowEvents.length !== 1 ||
          finalWorkflowEvents[0].event_id !== eventId(jobId, 'workflow.failed', `${finalPhaseEvents[0].from_phase}|FAILED|${finalRuntime.attempt}`) ||
          finalWorkflowEvents[0].job_id !== jobId || finalWorkflowEvents[0].payload_json !== JSON.stringify({
            fromPhase: finalPhaseEvents[0].from_phase, toPhase: 'FAILED', ...payload
          })) {
        throw new Error('workflow verification failure terminal readback/cardinality mismatch');
      }
      this.db.exec('COMMIT');
      return { job: this.getJob(jobId), idempotent: false };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  transition(jobId, state, status = 'active') {
    if (typeof jobId !== 'string' || !jobId || typeof state !== 'string' || !state ||
        typeof status !== 'string' || !status) throw new Error('job transition requires exact job/state/status strings');
    this.db.exec('SAVEPOINT job_state_transition');
    try {
      // Serialize the state decision before reading it. A stale ingress or
      // coordinator continuation must not reopen a terminal job after another
      // process has committed its terminal status.
      const reservation = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(jobId);
      if (reservation.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT job_state_transition');
        return null;
      }
      const current = this.getJob(jobId);
      const currentState = String(current?.state || '').toUpperCase();
      const currentStatus = String(current?.status || '').toLowerCase();
      const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(currentState) ||
        ['completed', 'failed', 'cancelled'].includes(currentStatus);
      if (terminal) {
        if (current.state !== state || current.status !== status) {
          throw new Error(`cannot transition terminal Job ${jobId} from ${current.state}/${current.status} to ${state}/${status}`);
        }
        this.db.exec('RELEASE SAVEPOINT job_state_transition');
        return current;
      }
      if (status === 'active') {
        const allowedActiveTransitions = {
          IDLE: new Set(['IDLE', 'PROPOSED', 'DISCUSSING', 'EXECUTING']),
          PROPOSED: new Set(['PROPOSED', 'DISCUSSING', 'EXECUTING']),
          DISCUSSING: new Set(['PROPOSED', 'DISCUSSING', 'EXECUTING']),
          APPROVED: new Set(['APPROVED', 'EXECUTING']),
          EXECUTING: new Set(['EXECUTING'])
        };
        const allowed = allowedActiveTransitions[currentState];
        if (!allowed || !allowed.has(String(state).toUpperCase())) {
          throw new Error(`illegal active Job state transition ${current.state}/${current.status} -> ${state}/${status}`);
        }
      }
      const ts = now();
      const update = this.db.prepare("UPDATE jobs SET state=?,status=?,updated_at=?,completed_at=CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE completed_at END WHERE job_id=? AND state=? AND status=?")
        .run(state, status, ts, status, ts, jobId, current.state, current.status);
      if (update.changes !== 1) throw new Error(`job state transition lost compare-and-set race: ${jobId}`);
      const persisted = this.getJob(jobId);
      if (persisted?.state !== state || persisted?.status !== status) throw new Error(`job state transition readback mismatch: ${jobId}`);
      this.db.exec('RELEASE SAVEPOINT job_state_transition');
      return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT job_state_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT job_state_transition'); } catch {}
      throw error;
    }
  }
  reconcileRunningTaskForTerminalJob(taskId, reason = 'parent job is terminal') {
    this.db.exec('SAVEPOINT reconcile_terminal_job_task');
    try {
      const initial = this.getTask(taskId);
      if (!initial || initial.status !== 'running') {
        this.db.exec('RELEASE SAVEPOINT reconcile_terminal_job_task');
        return initial || null;
      }
      // Reserve the parent job's writer slot first, then claim the running task
      // so concurrent recovery and runtime callbacks cannot both settle it.
      const jobReservation = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(initial.job_id);
      if (jobReservation.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT reconcile_terminal_job_task');
        return this.getTask(taskId);
      }
      const job = this.getJob(initial.job_id);
      if (!job || !['completed', 'failed', 'cancelled'].includes(String(job.status).toLowerCase())) {
        this.db.exec('RELEASE SAVEPOINT reconcile_terminal_job_task');
        return this.getTask(taskId);
      }
      const taskReservation = this.db.prepare("UPDATE tasks SET updated_at=updated_at WHERE task_id=? AND job_id=? AND status='running'")
        .run(taskId, initial.job_id);
      if (taskReservation.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT reconcile_terminal_job_task');
        return this.getTask(taskId);
      }
      const task = this.getTask(taskId);
      if (!task || task.status !== 'running' || task.job_id !== job.job_id) {
        this.db.exec('RELEASE SAVEPOINT reconcile_terminal_job_task');
        return task || null;
      }
      // The writer reservation above makes this durable-execution check atomic
      // with terminalization. OpenClaw inventory alone cannot prove that a
      // provider worker or an ambiguous dispatch has stopped remotely.
      if (this.db.prepare("SELECT 1 FROM task_leases WHERE job_id=? AND task_id=? AND state='ACTIVE' LIMIT 1")
        .get(job.job_id, taskId)) {
        this.db.exec('RELEASE SAVEPOINT reconcile_terminal_job_task');
        return task;
      }
      const hasTable = name => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(name));
      if (hasTable('provider_dispatch_intents')) {
        const unresolvedDispatch = this.db.prepare(`SELECT 1 FROM provider_dispatch_intents
          WHERE job_id=? AND state='DISPATCHING' AND provider_run_id IS NULL AND dispatch_claim_id IS NOT NULL LIMIT 1`)
          .get(job.job_id);
        if (unresolvedDispatch) {
          this.db.exec('RELEASE SAVEPOINT reconcile_terminal_job_task');
          return task;
        }
      }
      if (hasTable('provider_runs')) {
        const unresolvedProviderRun = this.db.prepare(`SELECT 1 FROM provider_runs
          WHERE job_id=? AND UPPER(COALESCE(state,'')) NOT IN ('COMPLETED','FAILED','CANCELLED') LIMIT 1`)
          .get(job.job_id);
        if (unresolvedProviderRun) {
          this.db.exec('RELEASE SAVEPOINT reconcile_terminal_job_task');
          return task;
        }
      }
      const activeAttempts = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started'").all(taskId);
      if (activeAttempts.length > 1) throw new Error(`terminal-job recovery found ambiguous active attempts: ${taskId}`);
      const ts = now();
      const taskUpdate = this.db.prepare(`UPDATE tasks SET status='cancelled', execution_status=CASE WHEN execution_status='running' THEN 'cancelled' ELSE execution_status END,
        execution_finished_at=COALESCE(execution_finished_at, ?), updated_at=? WHERE task_id=? AND job_id=? AND status='running'`)
        .run(ts, ts, taskId, job.job_id);
      if (taskUpdate.changes !== 1) throw new Error(`terminal-job recovery lost task-state CAS: ${taskId}`);
      if (activeAttempts.length === 1) {
        const attemptUpdate = this.db.prepare("UPDATE attempts SET status='cancelled',finished_at=?,error=? WHERE task_id=? AND attempt_id=? AND status='started'")
          .run(ts, reason, taskId, activeAttempts[0].attempt_id);
        if (attemptUpdate.changes !== 1) throw new Error(`terminal-job recovery lost active-attempt CAS: ${taskId}`);
      }
      const payload = { taskId, reason, outcome: 'cancelled' };
      const key = `${taskId}|terminal-job-reconciled`;
      const idValue = this.recordEvent(task.job_id, 'task.runtime_reconciled', payload, key);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(idValue);
      const persistedTask = this.getTask(taskId);
      const remainingActive = this.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(taskId).n;
      if (!event || event.event_id !== eventId(job.job_id, 'task.runtime_reconciled', key) || event.job_id !== job.job_id ||
          event.type !== 'task.runtime_reconciled' || event.payload_json !== JSON.stringify(payload) ||
          persistedTask?.status !== 'cancelled' || remainingActive !== 0) {
        throw new Error(`terminal-job task reconciliation lineage readback failed: ${taskId}`);
      }
      this.db.exec('RELEASE SAVEPOINT reconcile_terminal_job_task');
      return persistedTask;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT reconcile_terminal_job_task'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT reconcile_terminal_job_task'); } catch {}
      throw error;
    }
  }
  ensureTask(jobId, { role = 'cto', description }) {
    this.db.exec('SAVEPOINT ensure_task_fenced');
    try {
      const reservation = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(jobId);
      if (reservation.changes !== 1) throw new Error(`task creation requires an existing active Job: ${jobId}`);
      const job = this.getJob(jobId);
      if (!job || job.status !== 'active' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase())) {
        throw new Error(`cannot create task for terminal/inactive Job: ${jobId}`);
      }
      const task = this.ensureTaskLocked(jobId, { role, description });
      this.db.exec('RELEASE SAVEPOINT ensure_task_fenced');
      return task;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT ensure_task_fenced'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT ensure_task_fenced'); } catch {}
      throw error;
    }
  }
  ensureTaskLocked(jobId, { role = 'cto', description }) {
    const existing = this.db.prepare("SELECT * FROM tasks WHERE job_id = ? AND status IN ('pending','running') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId);
    if (existing) return existing;
    const taskId = id('task'); const ts = now();
    this.db.prepare("INSERT INTO tasks(task_id, job_id, role, description, status, created_at, updated_at) VALUES(?, ?, ?, ?, 'pending', ?, ?)").run(taskId, jobId, role, description, ts, ts);
    this.db.prepare('UPDATE jobs SET active_task_id = ?, updated_at = ? WHERE job_id = ?').run(taskId, ts, jobId);
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  }
  findJobIdFromMessages(messages = []) {
    const raw = (messages || []).map(m => typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '')).join('\n');
    const matches = [...raw.matchAll(/(?:Durable Job ID|job_id|jobId)[^A-Za-z0-9_-]*([A-Za-z0-9_-]+)/gi)];
    return matches.at(-1)?.[1] || null;
  }
  getTask(taskId) { return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) || null; }

  acquireTaskLease(taskId, { leaseId, workerId, ttlMs = 60000, attempt = null } = {}) {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('taskId must be a non-empty string');
    if (typeof leaseId !== 'string' || !leaseId.trim() || typeof workerId !== 'string' || !workerId.trim()) {
      throw new Error('leaseId and workerId must be non-empty strings');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 2_147_483_647) {
      throw new Error('ttlMs must be a positive safe integer no greater than 2147483647');
    }
    if (attempt !== null && attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) {
      throw new Error('attempt must be a positive safe integer');
    }
    const task = this.getTask(taskId); if (!task) throw new Error(`task not found: ${taskId}`);
    const requestedAttempt = attempt == null ? null : attempt;
    const nowTs = new Date().toISOString();
    const expires = new Date(Date.now() + Math.max(1000, ttlMs)).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare("SELECT * FROM task_leases WHERE task_id=? AND state='ACTIVE'").get(taskId);
      if (active) throw new Error(`task already leased: ${taskId}`);
      const current = this.getTask(taskId);
      if (!current) throw new Error(`task not found: ${taskId}`);
      if (['completed','cancelled'].includes(String(current.status).toLowerCase())) throw new Error(`cannot lease terminal task: ${taskId}`);
      // A retryable failed task is only retryable while its parent job remains
      // live. Check the parent under the same SQLite writer reservation as the
      // lease insert; otherwise a stale scheduler can acquire a fresh lease for
      // a task whose job was terminalized after the scheduler selected it.
      const parentJob = this.getJob(current.job_id);
      if (!parentJob || ['completed', 'failed', 'cancelled'].includes(String(parentJob.status || '').toLowerCase()) ||
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(parentJob.state || '').toUpperCase())) {
        throw new Error(`cannot lease task in terminal or missing job: ${taskId}`);
      }
      // Attempt numbering is part of the durable execution identity. Validate
      // explicit attempts against the task row read under the SQLite writer
      // reservation; a pre-lock snapshot can be stale if another process
      // completes/expires an attempt before this caller acquires the lock.
      const currentAttempt = current.execution_attempt ?? 0;
      if (!Number.isSafeInteger(currentAttempt) || currentAttempt < 0) {
        throw new Error('malformed durable task execution_attempt; refusing lease acquisition');
      }
      const nextAttempt = requestedAttempt == null ? Math.max(1, currentAttempt + 1) : requestedAttempt;
      if (!Number.isSafeInteger(nextAttempt) || nextAttempt < 1) throw new Error('invalid lease attempt');
      if (nextAttempt <= currentAttempt) {
        throw new Error(`lease attempt must advance beyond task execution_attempt (${currentAttempt})`);
      }
      // Do not use SQL MAX(owner_epoch)+1 here: SQLite coerces malformed text
      // values during arithmetic (for example, 'corrupt' + 1 can become 1),
      // which could reuse an owner epoch and weaken stale-worker fencing.
      // Validate every historical epoch while holding the same writer lock.
      const priorEpochs = this.db.prepare('SELECT owner_epoch FROM task_leases WHERE task_id=?').all(taskId);
      let maxOwnerEpoch = 0;
      for (const row of priorEpochs) {
        if (!Number.isSafeInteger(row.owner_epoch) || row.owner_epoch < 1) {
          throw new Error('malformed durable task lease owner_epoch ledger; refusing lease acquisition');
        }
        if (row.owner_epoch > maxOwnerEpoch) maxOwnerEpoch = row.owner_epoch;
      }
      if (maxOwnerEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('task lease owner epoch is exhausted or invalid');
      const ownerEpoch = maxOwnerEpoch + 1;
      this.db.prepare(`INSERT INTO task_leases(lease_id,task_id,job_id,attempt,worker_id,owner_epoch,state,issued_at,heartbeat_at,expires_at)
        VALUES(?,?,?,?,?,?,'ACTIVE',?,?,?)`).run(leaseId, taskId, current.job_id, nextAttempt, workerId, ownerEpoch, nowTs, nowTs, expires);
      const taskUpdate = this.db.prepare("UPDATE tasks SET status='running', execution_attempt=?, updated_at=? WHERE task_id=? AND job_id=? AND status IN ('pending','failed','running')")
        .run(nextAttempt, nowTs, taskId, current.job_id);
      if (taskUpdate.changes !== 1) throw new Error('task lease acquisition lost its task-state compare-and-set');
      const eventPayload = { taskId, leaseId, workerId, ownerEpoch, attempt: nextAttempt, expiresAt: expires };
      const eventIdValue = this.recordEvent(task.job_id, 'task.lease.acquired', eventPayload, leaseId);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const matchingEvents = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='task.lease.acquired' AND json_extract(payload_json,'$.leaseId')=?")
        .all(task.job_id, leaseId);
      const persistedLease = this.getTaskLease(leaseId);
      const persistedTask = this.getTask(taskId);
      if (matchingEvents.length !== 1 || !event || event.event_id !== eventId(task.job_id, 'task.lease.acquired', leaseId) ||
          event.job_id !== task.job_id || event.type !== 'task.lease.acquired' || event.payload_json !== JSON.stringify(eventPayload) ||
          !persistedLease || persistedLease.task_id !== taskId || persistedLease.job_id !== current.job_id ||
          persistedLease.worker_id !== workerId || persistedLease.owner_epoch !== ownerEpoch || persistedLease.attempt !== nextAttempt ||
          persistedLease.state !== 'ACTIVE' || persistedLease.expires_at !== expires ||
          persistedTask?.status !== 'running' || persistedTask.execution_attempt !== nextAttempt) {
        throw new Error('task lease acquisition durable lease/task/event readback failed');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return this.getTaskLease(leaseId);
  }

  getTaskLease(leaseId) { return this.db.prepare('SELECT * FROM task_leases WHERE lease_id=?').get(leaseId) || null; }

  heartbeatTaskLease(leaseId, { workerId, ttlMs = 60000 } = {}) {
    if (typeof leaseId !== 'string' || !leaseId.trim() || typeof workerId !== 'string' || !workerId.trim()) {
      throw new Error('leaseId and workerId must be non-empty strings');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 2_147_483_647) {
      throw new Error('ttlMs must be a positive safe integer no greater than 2147483647');
    }
    this.db.exec('SAVEPOINT heartbeat_task_lease_transition');
    try {
      const lock = this.db.prepare('UPDATE task_leases SET last_error=last_error WHERE lease_id=?').run(leaseId);
      if (lock.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT heartbeat_task_lease_transition');
        return { ok: false, reason: 'lease_not_active' };
      }
      const lease = this.getTaskLease(leaseId);
      if (!lease || lease.state !== 'ACTIVE') {
        this.db.exec('RELEASE SAVEPOINT heartbeat_task_lease_transition');
        return { ok: false, reason: 'lease_not_active' };
      }
      if (lease.worker_id !== workerId) {
        this.db.exec('RELEASE SAVEPOINT heartbeat_task_lease_transition');
        return { ok: false, reason: 'worker_fenced' };
      }
      const task = this.getTask(lease.task_id);
      const parentJob = this.getJob(lease.job_id);
      if (!task || task.job_id !== lease.job_id || task.status !== 'running' || task.execution_attempt !== lease.attempt) {
        this.db.exec('RELEASE SAVEPOINT heartbeat_task_lease_transition');
        return { ok: false, reason: 'task_attempt_fenced' };
      }
      if (!parentJob || parentJob.status !== 'active' ||
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(parentJob.state || '').toUpperCase())) {
        this.db.exec('RELEASE SAVEPOINT heartbeat_task_lease_transition');
        return { ok: false, reason: 'parent_job_terminal' };
      }
      if (!Number.isFinite(Date.parse(lease.expires_at)) || Date.parse(lease.expires_at) <= Date.now()) {
        this.expireTaskLease(leaseId, { reason: 'heartbeat_after_expiry', expiredBefore: new Date().toISOString(), requireExpired: true });
        this.db.exec('RELEASE SAVEPOINT heartbeat_task_lease_transition');
        return { ok: false, reason: 'lease_expired' };
      }
      const nowTs = new Date().toISOString();
      const expires = new Date(Date.now() + Math.max(1000, ttlMs)).toISOString();
      const update = this.db.prepare("UPDATE task_leases SET heartbeat_at=?, expires_at=? WHERE lease_id=? AND state='ACTIVE' AND worker_id=? AND expires_at>?")
        .run(nowTs, expires, leaseId, workerId, nowTs);
      if (update.changes !== 1) throw new Error('task lease heartbeat lost its active owner/expiry compare-and-set');
      const persisted = this.getTaskLease(leaseId);
      if (persisted?.state !== 'ACTIVE' || persisted.worker_id !== workerId || persisted.expires_at !== expires) {
        throw new Error('task lease heartbeat readback does not match the updated owner/expiry');
      }
      this.db.exec('RELEASE SAVEPOINT heartbeat_task_lease_transition');
      return { ok: true, lease: persisted };
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT heartbeat_task_lease_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT heartbeat_task_lease_transition'); } catch {}
      throw error;
    }
  }

  completeTaskLease(leaseId, { workerId, success = true, error = null } = {}) {
    if (typeof leaseId !== 'string' || !leaseId.trim() || typeof workerId !== 'string' || !workerId.trim()) {
      throw new Error('leaseId and workerId must be non-empty strings');
    }
    if (typeof success !== 'boolean') throw new Error('success must be a boolean');
    if (error !== null && error !== undefined && typeof error !== 'string') throw new Error('error must be a string or null');
    this.db.exec('SAVEPOINT complete_task_lease_transition');
    try {
      const lock = this.db.prepare('UPDATE task_leases SET last_error=last_error WHERE lease_id=?').run(leaseId);
      if (lock.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT complete_task_lease_transition');
        return { ok: false, reason: 'lease_not_active' };
      }
      const lease = this.getTaskLease(leaseId);
      if (!lease || lease.state !== 'ACTIVE') {
        this.db.exec('RELEASE SAVEPOINT complete_task_lease_transition');
        return { ok: false, reason: 'lease_not_active' };
      }
      if (typeof lease.attempt !== 'number' || !Number.isSafeInteger(lease.attempt) || lease.attempt < 1) {
        throw new Error('task lease completion refuses a malformed durable attempt');
      }
      if (lease.worker_id !== workerId) {
        this.db.exec('RELEASE SAVEPOINT complete_task_lease_transition');
        return { ok: false, reason: 'worker_fenced' };
      }
      const task = this.getTask(lease.task_id);
      const parentJob = this.getJob(lease.job_id);
      if (!task || task.job_id !== lease.job_id || task.execution_attempt !== lease.attempt) {
        this.db.exec('RELEASE SAVEPOINT complete_task_lease_transition');
        return { ok: false, reason: 'task_attempt_fenced' };
      }
      if (!parentJob || parentJob.status !== 'active' ||
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(parentJob.state || '').toUpperCase())) {
        this.db.exec('RELEASE SAVEPOINT complete_task_lease_transition');
        return { ok: false, reason: 'parent_job_terminal' };
      }
      // Verified provider/native result application settles the lease before
      // its enclosing transaction publishes execution_status='completed'. A
      // running task with no local execution projection is therefore valid only
      // at this pre-terminal lease-settlement boundary.
      const taskStillRunning = task.status === 'running' &&
        (task.execution_status === 'running' || task.execution_status == null);
      const taskAlreadyTerminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(task.execution_status) &&
        typeof task.execution_finished_at === 'string' && Boolean(task.execution_finished_at) &&
        task.status === (task.execution_status === 'completed' ? 'completed' : task.execution_status === 'cancelled' ? 'cancelled' : 'failed');
      if (!taskStillRunning && !taskAlreadyTerminal) {
        this.db.exec('RELEASE SAVEPOINT complete_task_lease_transition');
        return { ok: false, reason: 'task_attempt_fenced' };
      }
      if (taskAlreadyTerminal) {
        if ((task.execution_status === 'completed') !== success) {
          this.db.exec('RELEASE SAVEPOINT complete_task_lease_transition');
          return { ok: false, reason: 'task_terminal_outcome_mismatch' };
        }
        const terminalRows = this.db.prepare(`SELECT event_id,job_id,type,payload_json FROM events
          WHERE job_id=? AND type IN ('execution.completed','execution.failed','execution.cancelled')
            AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?`)
          .all(task.job_id, task.task_id, lease.attempt);
        if (terminalRows.length !== 1) throw new Error('terminal task lease completion requires exactly one canonical execution terminal event');
        const terminalEvent = terminalRows[0];
        const terminalPayload = parseStrictJson(terminalEvent.payload_json, 'terminal task event for lease completion');
        const attempt = this.db.prepare('SELECT * FROM attempts WHERE attempt_id=? AND task_id=?')
          .get(terminalPayload.attemptId, task.task_id);
        const metadata = parseStrictJson(task.metadata_json || '{}', 'terminal task metadata for lease completion');
        if (!attempt || attempt.status === 'started' || !attempt.finished_at ||
            terminalEvent.event_id !== eventId(task.job_id, terminalEvent.type, `${task.task_id}|execution-result|${lease.attempt}`) ||
            terminalEvent.payload_json !== JSON.stringify(terminalPayload) || terminalPayload.executionSessionId !== task.execution_session_id ||
            terminalPayload.attempt !== lease.attempt || terminalPayload.attemptId !== attempt.attempt_id ||
            terminalPayload.status !== task.execution_status ||
            terminalEvent.type !== (task.execution_status === 'completed' ? 'execution.completed' : task.execution_status === 'cancelled' ? 'execution.cancelled' : 'execution.failed')) {
          throw new Error('terminal task lease completion has inconsistent task/attempt/event lineage');
        }
        // Reuse the canonical terminal ledger verifier before settling a lease
        // that was left active by a local executor which completed its task
        // before the lease callback arrived. Never trust terminal-shaped fields
        // alone, and never let a stale success callback settle a failed task.
        this.finishExecution(task.task_id, {
          executionSessionId: task.execution_session_id, attempt: lease.attempt,
          command: metadata.command, exitCode: task.execution_exit_code,
          stdout: task.execution_stdout || '', stderr: task.execution_stderr || '',
          status: task.execution_status, error: attempt.error
        });
      }
      if (!Number.isFinite(Date.parse(lease.expires_at)) || Date.parse(lease.expires_at) <= Date.now()) {
        this.expireTaskLease(leaseId, { reason: 'completion_after_expiry', expiredBefore: new Date().toISOString(), requireExpired: true });
        this.db.exec('RELEASE SAVEPOINT complete_task_lease_transition');
        return { ok: false, reason: 'lease_expired' };
      }
      const state = success ? 'COMPLETED' : 'FAILED';
      const ts = new Date().toISOString();
      const normalizedError = error == null ? null : error;
      const payload = { taskId: lease.task_id, leaseId, attempt: lease.attempt, success, error: normalizedError };
      const update = this.db.prepare("UPDATE task_leases SET state=?, released_at=?, last_error=? WHERE lease_id=? AND state='ACTIVE' AND worker_id=? AND attempt=?")
        .run(state, ts, normalizedError, leaseId, workerId, lease.attempt);
      if (update.changes !== 1) throw new Error('task lease completion lost its active owner/attempt compare-and-set');
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_LEASE_COMPLETE_STATE_UPDATE === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
      const eventIdValue = this.recordEvent(lease.job_id, 'task.lease.completed', payload, leaseId);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const rows = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='task.lease.completed' AND json_extract(payload_json,'$.leaseId')=?")
        .all(lease.job_id, leaseId);
      if (rows.length !== 1 || !event || event.event_id !== eventId(lease.job_id, 'task.lease.completed', leaseId) ||
          event.job_id !== lease.job_id || event.type !== 'task.lease.completed' || event.payload_json !== JSON.stringify(payload)) {
        throw new Error('task lease completion event does not exactly bind the durable lease transition');
      }
      const persisted = this.getTaskLease(leaseId);
      if (persisted?.state !== state || persisted.worker_id !== workerId || persisted.attempt !== lease.attempt) {
        throw new Error('task lease completion readback does not match the exact worker/attempt/state');
      }
      this.db.exec('RELEASE SAVEPOINT complete_task_lease_transition');
      return { ok: true, lease: persisted };
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT complete_task_lease_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT complete_task_lease_transition'); } catch {}
      throw failure;
    }
  }

  expireTaskLease(leaseId, { reason = 'lease_expired', expiredBefore = new Date().toISOString(), requireExpired = false } = {}) {
    if (typeof leaseId !== 'string' || !leaseId.trim()) throw new Error('leaseId must be a non-empty string');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('task lease expiry reason must be a non-empty string');
    if (typeof requireExpired !== 'boolean') throw new Error('requireExpired must be a boolean');
    if (typeof expiredBefore !== 'string') throw new Error('task lease expiry cutoff must be a canonical UTC timestamp');
    const expiryCutoff = new Date(expiredBefore);
    if (!Number.isFinite(expiryCutoff.getTime()) || expiryCutoff.toISOString() !== expiredBefore) {
      throw new Error('task lease expiry cutoff must be a canonical UTC timestamp');
    }
    const expiryCutoffIso = expiryCutoff.toISOString();
    this.db.exec('SAVEPOINT expire_task_lease_transition');
    try {
      const lock = this.db.prepare('UPDATE task_leases SET last_error=last_error WHERE lease_id=?').run(leaseId);
      if (lock.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT expire_task_lease_transition');
        return null;
      }
      const lease = this.getTaskLease(leaseId);
      if (!lease || lease.state !== 'ACTIVE') {
        this.db.exec('RELEASE SAVEPOINT expire_task_lease_transition');
        return null;
      }
      if (typeof lease.attempt !== 'number' || !Number.isSafeInteger(lease.attempt) || lease.attempt < 1) {
        throw new Error('task lease expiry refuses a malformed durable attempt');
      }
      let malformedLeaseExpiry = typeof lease.expires_at !== 'string';
      const parsedLeaseExpiry = Date.parse(lease.expires_at);
      if (!Number.isFinite(parsedLeaseExpiry)) malformedLeaseExpiry = true;
      else {
        try { if (new Date(parsedLeaseExpiry).toISOString() !== lease.expires_at) malformedLeaseExpiry = true; }
        catch { malformedLeaseExpiry = true; }
      }
      // The reaper's initial SELECT is only a candidate list. Re-check expiry
      // after obtaining the SQLite writer reservation so a renewed lease is
      // not reset to pending from a stale candidate snapshot.
      if (requireExpired && !malformedLeaseExpiry && lease.expires_at > expiryCutoffIso) {
        this.db.exec('RELEASE SAVEPOINT expire_task_lease_transition');
        return null;
      }
      const ts = new Date().toISOString();
      // An expired local lease is only safe to recycle when no durable provider
      // send could have crossed the external boundary. A claimed dispatch (or
      // any bound provider run) is one-way evidence: expiry must quarantine the
      // attempt instead of returning the task to the runnable queue.
      const hasDispatchLedger = Boolean(this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_dispatch_intents' LIMIT 1"
      ).get());
      let uncertainDispatch = null;
      if (hasDispatchLedger) {
        const claimedIntents = this.db.prepare(`SELECT * FROM provider_dispatch_intents
          WHERE lease_id=? AND (dispatch_claim_id IS NOT NULL OR provider_run_id IS NOT NULL)
          ORDER BY created_at ASC, rowid ASC`).all(leaseId);
        if (claimedIntents.length > 1) {
          uncertainDispatch = { dispatch_key: `ambiguous-dispatch-intents:${leaseId}`, provider_run_id: null, state: 'AMBIGUOUS_DISPATCH_INTENT_CARDINALITY' };
        } else if (claimedIntents.length === 1) {
          const intent = claimedIntents[0];
          if (intent.job_id !== lease.job_id || intent.task_id !== lease.task_id || intent.lease_id !== leaseId ||
              intent.attempt !== lease.attempt || intent.owner_epoch !== lease.owner_epoch ||
              typeof intent.dispatch_key !== 'string' || !intent.dispatch_key ||
              (intent.provider_run_id !== null && intent.provider_run_id !== undefined &&
                (typeof intent.provider_run_id !== 'string' || !intent.provider_run_id))) {
            uncertainDispatch = { dispatch_key: `invalid-dispatch-intent-binding:${leaseId}`, provider_run_id: intent.provider_run_id || null, state: 'INVALID_DISPATCH_INTENT_BINDING' };
          } else {
            uncertainDispatch = { dispatch_key: intent.dispatch_key, provider_run_id: intent.provider_run_id || null, state: intent.state };
          }
        }
      }
      if (!uncertainDispatch) {
        const hasProviderRunLedger = Boolean(this.db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_runs' LIMIT 1"
        ).get());
        const providerRuns = hasProviderRunLedger
          ? this.db.prepare('SELECT * FROM provider_runs WHERE lease_id=? ORDER BY created_at ASC, rowid ASC').all(leaseId)
          : [];
        if (providerRuns.length > 1) {
          uncertainDispatch = { dispatch_key: `ambiguous-provider-runs:${leaseId}`, provider_run_id: null, state: 'AMBIGUOUS_PROVIDER_RUN_CARDINALITY' };
        } else if (providerRuns.length === 1) {
          const providerRun = providerRuns[0];
          if (providerRun.job_id !== lease.job_id || providerRun.task_id !== lease.task_id ||
              providerRun.lease_id !== leaseId || providerRun.attempt !== lease.attempt ||
              (providerRun.owner_epoch !== null && providerRun.owner_epoch !== undefined && providerRun.owner_epoch !== lease.owner_epoch) ||
              typeof providerRun.provider_run_id !== 'string' || !providerRun.provider_run_id) {
            uncertainDispatch = { dispatch_key: `invalid-provider-run-binding:${leaseId}`, provider_run_id: providerRun.provider_run_id || null, state: 'INVALID_PROVIDER_RUN_BINDING' };
          } else {
          uncertainDispatch = {
            dispatch_key: `provider-run:${providerRun.provider_run_id}`,
            provider_run_id: providerRun.provider_run_id,
            state: `PROVIDER_RUN_${providerRun.state}`
          };
          }
        }
      }
      // Native-specialist start is also an external side-effect boundary. Once
      // its actual Gateway run/session IDs have been committed locally, expiry
      // must not reset the task to pending: doing so could start a duplicate
      // remote turn while the original run remains active or unobserved.
      if (!uncertainDispatch) {
        const hasNativeRuntimeLedger = Boolean(this.db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='m12_native_specialist_runtime' LIMIT 1"
        ).get());
        const nativeRuntimes = hasNativeRuntimeLedger
          ? this.db.prepare('SELECT * FROM m12_native_specialist_runtime WHERE lease_id=? ORDER BY attempt ASC, rowid ASC').all(leaseId)
          : [];
        if (nativeRuntimes.length > 1) {
          uncertainDispatch = { dispatch_key: `ambiguous-native-runtimes:${leaseId}`, provider_run_id: null, state: 'AMBIGUOUS_NATIVE_RUNTIME_CARDINALITY' };
        } else if (nativeRuntimes.length === 1) {
          const nativeRuntime = nativeRuntimes[0];
          if (nativeRuntime.task_id !== lease.task_id || nativeRuntime.lease_id !== leaseId ||
              nativeRuntime.attempt !== lease.attempt || nativeRuntime.owner_epoch !== lease.owner_epoch ||
              typeof nativeRuntime.run_id !== 'string' || !nativeRuntime.run_id) {
            uncertainDispatch = { dispatch_key: `invalid-native-runtime-binding:${leaseId}`, provider_run_id: nativeRuntime.run_id || null, state: 'INVALID_NATIVE_RUNTIME_BINDING' };
          } else {
          uncertainDispatch = {
            dispatch_key: `native-runtime:${nativeRuntime.run_id}`,
            provider_run_id: nativeRuntime.run_id,
            state: `NATIVE_RUNTIME_${nativeRuntime.state}`
          };
          }
        }
      }
      if (!uncertainDispatch && malformedLeaseExpiry) {
        // A malformed expiry cannot prove that an old lease is safe to recycle.
        // Quarantine rather than returning its task to the runnable queue.
        uncertainDispatch = {
          dispatch_key: `malformed-lease-expiry:${leaseId}`,
          provider_run_id: null,
          state: 'MALFORMED_LEASE_EXPIRY'
        };
      }
      if (uncertainDispatch) {
        const quarantineError = `REMOTE_EFFECT_UNCERTAIN_REQUIRES_RECONCILIATION: ${reason}`;
        const quarantined = this.db.prepare(`UPDATE task_leases SET state='FAILED',released_at=?,last_error=?
          WHERE lease_id=? AND state='ACTIVE' AND worker_id=? AND attempt=?`)
          .run(ts, quarantineError, leaseId, lease.worker_id, lease.attempt);
        if (quarantined.changes !== 1) throw new Error('uncertain provider lease quarantine lost its active owner/attempt compare-and-set');
        const taskUpdate = this.db.prepare(`UPDATE tasks SET status='failed',execution_status='failed',execution_finished_at=?,updated_at=?
          WHERE task_id=? AND job_id=? AND status IN ('pending','running') AND execution_attempt=?`)
          .run(ts, ts, lease.task_id, lease.job_id, lease.attempt);
        const payload = {
          taskId: lease.task_id, leaseId, attempt: lease.attempt, dispatchKey: uncertainDispatch.dispatch_key,
          providerRunId: uncertainDispatch.provider_run_id || null, dispatchState: uncertainDispatch.state,
          remoteEffect: 'uncertain', reconciliationRequired: true, reason: quarantineError
        };
        const eventIdValue = this.recordEvent(lease.job_id, 'task.lease.quarantined', payload, leaseId);
        const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
        const quarantineEvents = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='task.lease.quarantined' AND json_extract(payload_json,'$.leaseId')=?")
          .all(lease.job_id, leaseId);
        const persisted = this.getTaskLease(leaseId);
        const task = this.getTask(lease.task_id);
        const taskIsTerminal = ['completed', 'failed', 'cancelled'].includes(String(task?.status || '').toLowerCase());
        if (quarantineEvents.length !== 1 || !event || event.event_id !== eventId(lease.job_id, 'task.lease.quarantined', leaseId) ||
            event.job_id !== lease.job_id || event.type !== 'task.lease.quarantined' || event.payload_json !== JSON.stringify(payload) ||
            persisted?.state !== 'FAILED' || persisted.last_error !== quarantineError ||
            (taskUpdate.changes === 1 && task?.status !== 'failed') ||
            (taskUpdate.changes === 0 && !taskIsTerminal)) {
          throw new Error('uncertain provider lease quarantine state/event readback failed');
        }
        this.db.exec('RELEASE SAVEPOINT expire_task_lease_transition');
        return persisted;
      }
      const update = this.db.prepare(`UPDATE task_leases SET state='EXPIRED', released_at=?, last_error=?
        WHERE lease_id=? AND state='ACTIVE' AND worker_id=? AND attempt=?${requireExpired ? ' AND expires_at<=?' : ''}`)
        .run(...(requireExpired ? [ts, reason, leaseId, lease.worker_id, lease.attempt, expiryCutoffIso] : [ts, reason, leaseId, lease.worker_id, lease.attempt]));
      if (update.changes !== 1) throw new Error('task lease expiry lost its active owner/attempt compare-and-set');
      const parentJob = this.getJob(lease.job_id);
      const parentTerminal = !parentJob || parentJob.status !== 'active' ||
        ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(parentJob.state || '').toUpperCase());
      // Expiry must not reopen a runnable task after its parent Job has become
      // terminal. Settle the exact still-running attempt as failed instead of
      // resetting it to pending under a stale lease-reaper callback.
      const taskUpdate = parentTerminal
        ? this.db.prepare("UPDATE tasks SET status='failed', execution_status='failed', execution_finished_at=?, updated_at=? WHERE task_id=? AND job_id=? AND status='running' AND execution_attempt=?")
          .run(ts, ts, lease.task_id, lease.job_id, lease.attempt)
        : this.db.prepare("UPDATE tasks SET status='pending', updated_at=? WHERE task_id=? AND job_id=? AND status='running' AND execution_attempt=?")
          .run(ts, lease.task_id, lease.job_id, lease.attempt);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_LEASE_EXPIRE_STATE_UPDATE === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
      const payload = { taskId: lease.task_id, leaseId, attempt: lease.attempt, reason };
      const eventIdValue = this.recordEvent(lease.job_id, 'task.lease.expired', payload, leaseId);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const rows = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='task.lease.expired' AND json_extract(payload_json,'$.leaseId')=?")
        .all(lease.job_id, leaseId);
      if (rows.length !== 1 || !event || event.event_id !== eventId(lease.job_id, 'task.lease.expired', leaseId) ||
          event.job_id !== lease.job_id || event.type !== 'task.lease.expired' || event.payload_json !== JSON.stringify(payload)) {
        throw new Error('task lease expiry event does not exactly bind the durable lease transition');
      }
      const persisted = this.getTaskLease(leaseId);
      const task = this.getTask(lease.task_id);
      if (persisted?.state !== 'EXPIRED' || (taskUpdate.changes === 1 && task?.status !== (parentTerminal ? 'failed' : 'pending')) ||
          (taskUpdate.changes === 0 && task?.status === 'running' &&
            (typeof task.execution_attempt !== 'number' || !Number.isSafeInteger(task.execution_attempt) ||
              (task.execution_attempt === lease.attempt && !parentTerminal)))) {
        throw new Error('task lease expiry readback contradicts the durable lease/task state');
      }
      this.db.exec('RELEASE SAVEPOINT expire_task_lease_transition');
      return persisted;
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT expire_task_lease_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT expire_task_lease_transition'); } catch {}
      throw failure;
    }
  }

  reapExpiredTaskLeases({ now = Date.now(), jobId = null } = {}) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('lease reaper now must be a non-negative safe integer timestamp');
    if (jobId !== null && (typeof jobId !== 'string' || !jobId.trim())) throw new Error('lease reaper jobId must be a non-empty string or null');
    const cutoff = new Date(now).toISOString();
    const activeRows = this.db.prepare(`SELECT lease_id,expires_at FROM task_leases WHERE state='ACTIVE'${jobId ? ' AND job_id=?' : ''}`)
      .all(...(jobId ? [jobId] : []));
    // SQL lexical ordering alone misses malformed expiry values, which could
    // otherwise leave an ACTIVE lease unreaped indefinitely. Treat noncanonical
    // timestamps as expiry candidates; expireTaskLease quarantines them fail-closed.
    const rows = activeRows.filter(row => {
      if (typeof row.expires_at !== 'string') return true;
      const parsed = Date.parse(row.expires_at);
      if (!Number.isFinite(parsed)) return true;
      try { if (new Date(parsed).toISOString() !== row.expires_at) return true; }
      catch { return true; }
      return row.expires_at <= cutoff;
    });
    let expired = 0;
    const expiryCutoff = cutoff;
    for (const row of rows) if (this.expireTaskLease(row.lease_id, { expiredBefore: expiryCutoff, requireExpired: true })) expired++;
    return expired;
  }

  listTaskLeases({ taskId = null, workerId = null, state = null, limit = 100 } = {}) {
    const clauses = []; const args = [];
    if (taskId) { clauses.push('task_id=?'); args.push(taskId); }
    if (workerId) { clauses.push('worker_id=?'); args.push(workerId); }
    if (state) { clauses.push('state=?'); args.push(state); }
    return this.db.prepare(`SELECT * FROM task_leases${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY issued_at DESC LIMIT ?`).all(...args, limit);
  }

  listRunnableTasks({ jobId = null, limit = 100 } = {}) {
    return this.db.prepare(`SELECT t.* FROM tasks t
      WHERE t.status='pending'
        AND NOT EXISTS (SELECT 1 FROM task_leases l WHERE l.task_id=t.task_id AND l.state='ACTIVE')
        ${jobId ? 'AND t.job_id=?' : ''}
      ORDER BY t.created_at ASC LIMIT ?`).all(...(jobId ? [jobId, limit] : [limit]));
  }

  applyVerifiedExecutionResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { status: 'REJECTED', reason: 'invalid_execution_result_schema' };
    }
    const { evidence_verification: evidenceVerification, ...wireResult } = result;
    // The P3 evidence verifier currently binds output_commit only to another
    // worker-controlled execution.json claim. Do not let that metadata fall
    // through to the generic evidence-shape rejection (or, worse, be stripped
    // by a caller and treated as an ordinary verified result). A future trusted
    // attestation path must add a separate verifier-owned proof contract; a
    // worker-supplied provenance label is never sufficient.
    if (evidenceVerification && Object.prototype.hasOwnProperty.call(evidenceVerification, 'output_commit_provenance')) {
      return { status: 'REJECTED', reason: 'output_commit_attestation_required',
        output_commit_provenance: evidenceVerification.output_commit_provenance };
    }
    try { validateDurableExecutionResult(wireResult); }
    catch (error) { return { status: 'REJECTED', reason: 'invalid_execution_result_schema', error: error.message }; }
    if (!evidenceVerification || evidenceVerification.valid !== true || evidenceVerification.skipped === true ||
        !Array.isArray(evidenceVerification.errors) || evidenceVerification.errors.length !== 0 ||
        !/^[a-f0-9]{64}$/i.test(String(evidenceVerification.evidence_hash || '')) ||
        Object.keys(evidenceVerification).sort().join(',') !== 'errors,evidence_hash,valid') {
      return { status: 'REJECTED', reason: 'execution_evidence_not_verified' };
    }
    const requiredIdentity = ['job_id', 'task_id', 'lease_id', 'provider_run_id'];
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        requiredIdentity.some(field => typeof result[field] !== 'string' || !result[field].trim()) ||
        !Number.isSafeInteger(result.attempt) || result.attempt < 1) {
      return { status: 'REJECTED', reason: 'invalid_execution_result_identity' };
    }

    // Native-specialist reconciliation is a separate persistence path, but it
    // must not bypass the verified-result trust boundary. The dedicated M12
    // bridge calls reconcileM12NativeSpecialistResult directly after its own
    // authenticated Gateway identity checks; this compatibility path therefore
    // requires the same verified evidence envelope as ordinary provider results.
    if (wireResult.native_specialist) {
      const native = wireResult.native_specialist;
      const nativeTask = this.getTask(wireResult.task_id);
      const nativeLease = this.getTaskLease(wireResult.lease_id);
      if (!nativeTask || nativeTask.job_id !== wireResult.job_id || !nativeLease ||
          nativeLease.job_id !== wireResult.job_id || nativeLease.task_id !== wireResult.task_id ||
          nativeLease.attempt !== wireResult.attempt || nativeLease.state !== 'ACTIVE' ||
          !Number.isSafeInteger(nativeLease.owner_epoch) || nativeLease.owner_epoch < 1 ||
          nativeLease.owner_epoch !== wireResult.owner_epoch) {
        return { status: 'REJECTED', reason: 'native_specialist_execution_identity_mismatch' };
      }
      if (!Number.isSafeInteger(wireResult.owner_epoch) || wireResult.owner_epoch < 1 ||
          native.owner_epoch !== wireResult.owner_epoch) {
        return { status: 'REJECTED', reason: 'native_specialist_owner_epoch_mismatch' };
      }
      const nativeParentJob = this.getJob(nativeTask.job_id);
      if (nativeTask.status !== 'running' || !nativeParentJob || nativeParentJob.status !== 'active' ||
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(nativeParentJob.state || '').toUpperCase())) {
        return { status: 'REJECTED', reason: 'native_specialist_parent_or_task_not_runnable' };
      }
      const nativeLeaseExpiry = Date.parse(nativeLease.expires_at);
      if (typeof nativeLease.expires_at !== 'string' || !Number.isFinite(nativeLeaseExpiry) ||
          new Date(nativeLeaseExpiry).toISOString() !== nativeLease.expires_at || nativeLeaseExpiry <= Date.now()) {
        return { status: 'REJECTED', reason: 'native_specialist_lease_expired' };
      }
      if (native.status !== wireResult.status) {
        return { status: 'REJECTED', reason: 'native_specialist_status_mismatch' };
      }
      return this.reconcileM12NativeSpecialistResult({
        taskId: wireResult.task_id,
        attempt: wireResult.attempt,
        leaseId: wireResult.lease_id,
        runId: native.run_id,
        nativeSessionId: native.session_id,
        status: native.status,
        output: native.output ?? wireResult.agent_output ?? wireResult.error ?? '',
        result: native,
      });
    }

    // The provider may call back twice or two control-loop processes may collect
    // the same completed run concurrently. Serialize on the lease row before
    // duplicate detection and all lineage reads so both callbacks cannot pass a
    // stale preflight and independently publish result/artifact/task/lease/event.
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_VERIFIED_RESULT_BARRIER_DIR) {
      const barrierDir = path.resolve(process.env.CHAT_ON_STEROIDS_TEST_VERIFIED_RESULT_BARRIER_DIR);
      fs.mkdirSync(barrierDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(barrierDir, `${process.pid}.ready`), result.provider_run_id, { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(path.join(barrierDir, 'release'))) {
        if (Date.now() >= deadline) throw new Error('test verified-result barrier timed out before writer transaction');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }

    this.db.exec('SAVEPOINT apply_verified_execution_result');
    const reject = (reason, extra = {}) => {
      this.db.exec('RELEASE SAVEPOINT apply_verified_execution_result');
      return { status: 'REJECTED', reason, ...extra };
    };
    try {
      // First statement after SAVEPOINT is a no-op update used to claim the
      // SQLite writer reservation. Re-evaluate duplicate, lease, expiry and task
      // attempt only after the reservation is held.
      const leaseLock = this.db.prepare('UPDATE task_leases SET last_error=last_error WHERE lease_id=? AND job_id=? AND task_id=? AND attempt=?')
        .run(result.lease_id, result.job_id, result.task_id, result.attempt);
      if (leaseLock.changes !== 1) return reject('lease_binding_mismatch');

      const success = result.status === 'SUCCEEDED' && result.exit_code === 0;
      const agentOutput = typeof result.agent_output === 'string' ? result.agent_output : '';
      const checkpointed = result.status === 'TIMED_OUT' && Boolean(result.checkpoint_commit);
      const expectedResultOutcome = success ? 'success' : checkpointed ? 'partial' : 'failure';
      const expectedResultContent = JSON.stringify({
        job_id: result.job_id, task_id: result.task_id, lease_id: result.lease_id,
        attempt: result.attempt, owner_epoch: result.owner_epoch ?? null,
        provider_run_attempt: result.provider_run_attempt ?? null, input_commit: result.input_commit,
        provider_run_id: result.provider_run_id, output_commit: result.output_commit,
        evidence_artifact: result.evidence_artifact, evidence_refs: result.evidence_refs,
        agent_output: agentOutput || null, runner_id: result.runner_id || null,
        evidence_verification: result.evidence_verification || null, error: result.error || null,
        checkpoint_commit: result.checkpoint_commit || null, checkpoint_ref: result.checkpoint_ref || null
      });
      const existingResults = this.db.prepare('SELECT result_id, task_id, outcome, content FROM results WHERE task_id=? ORDER BY created_at DESC, rowid DESC')
        .all(result.task_id);
      const matchingProviderResults = [];
      for (const row of existingResults) {
        let stored;
        try { stored = parseStrictJson(row.content); }
        catch { continue; } // Legacy non-JSON rows cannot establish provider identity.
        if (stored?.provider_run_id === result.provider_run_id) matchingProviderResults.push(row);
      }
      if (matchingProviderResults.length > 1) {
        return reject('provider_result_duplicate_terminal_lineage_mismatch', {
          result_ids: matchingProviderResults.map(row => row.result_id)
        });
      }
      if (matchingProviderResults.length === 1) {
            const row = matchingProviderResults[0];
            if (row.task_id !== result.task_id || row.outcome !== expectedResultOutcome || row.content !== expectedResultContent) {
              return reject('provider_result_duplicate_conflict', { result_id: row.result_id });
            }
            const task = this.getTask(result.task_id);
            const lease = this.getTaskLease(result.lease_id);
            const expectedTaskStatus = success ? 'completed' : checkpointed ? 'pending' : 'failed';
            const expectedLeaseState = success ? 'COMPLETED' : 'FAILED';
            if (!task || task.job_id !== result.job_id || task.status !== expectedTaskStatus ||
                task.execution_attempt !== result.attempt || lease?.task_id !== result.task_id ||
                lease.job_id !== result.job_id || lease.attempt !== result.attempt || lease.state !== expectedLeaseState ||
                !Number.isSafeInteger(lease.owner_epoch) || lease.owner_epoch !== result.owner_epoch ||
                task.execution_status !== (success ? 'completed' : checkpointed ? 'timeout' : 'failed') ||
                task.execution_exit_code !== (result.exit_code ?? null) || task.execution_finished_at !== result.finished_at) {
              return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
            }
            // A prior result row is not enough to claim idempotency. Reconcile
            // the provider-run and intent ledgers again before accepting a late
            // callback as a no-op: a deleted/re-pointed intent or tampered run
            // row must not be hidden by the result's already-terminal status.
            const hasProviderRunLedger = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_runs' LIMIT 1").get());
            if (hasProviderRunLedger) {
              const hasDispatchIntentLedger = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_dispatch_intents' LIMIT 1").get());
              if (!hasDispatchIntentLedger) return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
              const providerRun = this.db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(result.provider_run_id);
              const runIntents = this.db.prepare('SELECT * FROM provider_dispatch_intents WHERE provider_run_id=?').all(result.provider_run_id);
              const runDispatchKey = providerRun?.dispatch_key;
              const keyIntents = runDispatchKey
                ? this.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').all(runDispatchKey) : [];
              const conclusion = String(providerRun?.conclusion || '').toLowerCase();
              const terminalConclusionMatches = success
                ? conclusion === 'success' && result.exit_code === 0
                : conclusion !== 'success' && result.status !== 'UNKNOWN';
            if (!providerRun || providerRun.provider !== 'github-actions' || providerRun.state !== 'COMPLETED' ||
                  providerRun.job_id !== result.job_id || providerRun.task_id !== result.task_id ||
                  providerRun.lease_id !== result.lease_id || providerRun.attempt !== result.attempt ||
                  providerRun.owner_epoch !== result.owner_epoch || providerRun.input_commit !== result.input_commit ||
                  providerRun.run_attempt !== result.provider_run_attempt || !terminalConclusionMatches ||
                  (providerRun.output_commit ?? null) !== (result.output_commit ?? null) ||
                  typeof providerRun.artifact_id !== 'string' || !/^\d+$/.test(providerRun.artifact_id) ||
                  !/^[a-f0-9]{64}$/.test(String(providerRun.request_sha256 || '')) ||
                  runIntents.length !== 1 || keyIntents.length !== 1 ||
                  runIntents[0].dispatch_key !== runDispatchKey || keyIntents[0].provider_run_id !== result.provider_run_id ||
                  runIntents[0].state !== 'DISPATCHED' || keyIntents[0].state !== 'DISPATCHED' ||
                  runIntents[0].request_sha256 !== providerRun.request_sha256 || keyIntents[0].request_sha256 !== providerRun.request_sha256 ||
                  typeof runIntents[0].request_json !== 'string' ||
                  hash(runIntents[0].request_json) !== providerRun.request_sha256) {
                return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
              }
              try {
                const immutableRequest = parseStrictJson(runIntents[0].request_json, 'duplicate provider result immutable request');
                if (JSON.stringify(immutableRequest) !== runIntents[0].request_json) throw new Error('non-canonical request bytes');
                assertProviderDispatchIntent(runIntents[0], {
                  job_id: result.job_id, task_id: result.task_id, lease_id: result.lease_id,
                  attempt: result.attempt, owner_epoch: result.owner_epoch, provider: providerRun.provider,
                  api_base: runIntents[0].api_base, workflow: providerRun.workflow,
                  repository: runIntents[0].repository, event: runIntents[0].event,
                  ref: providerRun.ref, input_commit: result.input_commit, request_sha256: providerRun.request_sha256
                });
              } catch {
                return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
              }
            }
            const expectedExecutionType = success ? 'task.execution.verified' : checkpointed ? 'task.execution.checkpointed' : 'task.execution.rejected';
            const expectedExecutionPayload = {
              taskId: result.task_id, leaseId: result.lease_id, attempt: result.attempt,
              providerRunId: result.provider_run_id, resultId: row.result_id,
              resultContentSha256: hash(expectedResultContent), outputCommit: result.output_commit,
              evidenceHash: result.evidence_verification?.evidence_hash || null
            };
            const executionRows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type IN ('task.execution.verified','task.execution.checkpointed','task.execution.rejected') AND json_extract(payload_json,'$.leaseId')=?")
              .all(result.job_id, result.lease_id);
            const executionEventId = eventId(result.job_id, expectedExecutionType, `${result.lease_id}|verified|${result.attempt}`);
            const executionEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(executionEventId);
            if (executionRows.length !== 1 || !executionEvent || executionEvent.job_id !== result.job_id ||
                executionEvent.type !== expectedExecutionType || executionEvent.payload_json !== JSON.stringify(expectedExecutionPayload)) {
              return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
            }
            const completionRows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type IN ('task.completed','task.failed') AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.runId')=?")
              .all(result.job_id, result.task_id, result.provider_run_id);
            if (completionRows.length !== 1) return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
            let completionPayload;
            try { completionPayload = parseStrictJson(completionRows[0].payload_json); }
            catch { return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id }); }
            if (completionRows[0].event_id !== eventId(result.job_id, completionRows[0].type,
                `${result.task_id}|${success ? 'success' : 'failure'}|${row.result_id}`) ||
                completionRows[0].job_id !== result.job_id || completionPayload.taskId !== result.task_id ||
                completionPayload.resultId !== row.result_id || completionPayload.runId !== result.provider_run_id ||
                completionPayload.outcome !== (success ? 'success' : 'failure') ||
                typeof completionPayload.attemptId !== 'string' || !completionPayload.attemptId ||
                completionRows[0].payload_json !== JSON.stringify({ taskId: result.task_id, resultId: row.result_id,
                  runId: result.provider_run_id, sessionKey: null, attemptId: completionPayload.attemptId,
                  outcome: success ? 'success' : 'failure', failureClass: success ? null : 'PROVIDER_EXECUTION_FAILURE' })) {
              return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
            }
            const expectedAttemptStatus = success ? 'completed' : checkpointed ? 'timeout' : 'failed';
            const expectedAttemptError = success ? null : String(result.error || 'provider execution did not succeed').slice(0, 2000);
            const attemptRows = this.db.prepare('SELECT attempt_id,task_id,status,started_at,finished_at,error FROM attempts WHERE attempt_id=?')
              .all(completionPayload.attemptId);
            if (attemptRows.length !== 1 || attemptRows[0].task_id !== result.task_id ||
                attemptRows[0].status !== expectedAttemptStatus ||
                attemptRows[0].started_at !== new Date(Date.parse(result.started_at)).toISOString() ||
                attemptRows[0].finished_at !== new Date(Date.parse(result.finished_at)).toISOString() ||
                (attemptRows[0].error ?? null) !== expectedAttemptError) {
              return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
            }
            const leaseCompletionPayload = { taskId: result.task_id, leaseId: result.lease_id,
              attempt: result.attempt, success, error: result.error || null };
            const leaseCompletionRows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='task.lease.completed' AND json_extract(payload_json,'$.leaseId')=?")
              .all(result.job_id, result.lease_id);
            if (leaseCompletionRows.length !== 1 ||
                leaseCompletionRows[0].event_id !== eventId(result.job_id, 'task.lease.completed', result.lease_id) ||
                leaseCompletionRows[0].job_id !== result.job_id || leaseCompletionRows[0].type !== 'task.lease.completed' ||
                leaseCompletionRows[0].payload_json !== JSON.stringify(leaseCompletionPayload)) {
              return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
            }
            const taskMetadata = parseStrictJson(task.metadata_json || '{}', 'duplicate provider result task metadata');
            if (success && taskMetadata.runtime_owner === 'github-runner') {
              const role = String(task.role || '').toLowerCase();
              const typeByRole = { 'product-owner': 'requirements', researcher: 'research', architect: 'architecture', engineer: 'implementation', security: 'security-review', qa: 'qa-report', platform: 'platform-review', writer: 'documentation', reviewer: 'review', cto: 'cto-decision' };
              let output = null;
              try { output = agentOutput ? parseStrictJson(agentOutput) : null; } catch {}
              const type = typeByRole[role];
              if (type && output) {
                const artifactId = `${type}-${row.result_id}`;
                const artifact = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id=?').get(artifactId);
                const artifactEventId = eventId(result.job_id, 'artifact.created', artifactId);
                const artifactEvents = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='artifact.created' AND json_extract(payload_json,'$.artifactId')=?")
                  .all(result.job_id, artifactId);
                const artifactEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(artifactEventId);
                if (!artifact || artifact.job_id !== result.job_id || artifact.task_id !== result.task_id || artifact.kind !== type ||
                    artifactEvents.length !== 1 || !artifactEvent || artifactEvent.job_id !== result.job_id || artifactEvent.type !== 'artifact.created') {
                  return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
                }
                let artifactPayload;
                let artifactEvidence;
                try { artifactPayload = parseStrictJson(artifactEvent.payload_json); }
                catch { return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id }); }
                try { artifactEvidence = parseStrictJson(artifact.evidence_json, 'duplicate provider result artifact evidence'); }
                catch { return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id }); }
                const expectedArtifactContent = type === 'review' && output.review ? output.review : output;
                const expectedArtifactBytes = typeof expectedArtifactContent === 'string'
                  ? expectedArtifactContent : JSON.stringify(expectedArtifactContent);
                if (artifactPayload.artifactId !== artifactId || artifactPayload.taskId !== result.task_id ||
                    artifactPayload.type !== type || artifactPayload.status !== artifact.status ||
                    (artifactPayload.supersedes ?? null) !== (artifact.supersedes ?? null) ||
                    artifactPayload.contentHash !== hash(artifact.content) ||
                    artifactEvent.payload_json !== JSON.stringify(artifactPayload) ||
                    artifact.content !== expectedArtifactBytes || artifact.content_hash !== hash(artifact.content) ||
                    String(artifact.producer_role || '').toLowerCase() !== String(task.role || '').toLowerCase() || artifact.status !== 'active' ||
                    !Array.isArray(artifactEvidence) || !artifactEvidence.includes(row.result_id) ||
                    artifact.evidence_json !== JSON.stringify(artifactEvidence)) {
                  return reject('provider_result_duplicate_terminal_lineage_mismatch', { result_id: row.result_id });
                }
              }
            }
            return reject('duplicate_provider_result', { result_id: row.result_id });
      }

      const lease = this.getTaskLease(result.lease_id);
      if (!lease) return reject('lease_not_found');
      if (lease.state !== 'ACTIVE') return reject('lease_not_active');
      if (lease.task_id !== result.task_id || lease.job_id !== result.job_id ||
          !Number.isSafeInteger(lease.attempt) || lease.attempt !== result.attempt) {
        return reject('stale_attempt_or_correlation_mismatch');
      }
      const parentJob = this.getJob(result.job_id);
      if (!parentJob || parentJob.status !== 'active' ||
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(parentJob.state || '').toUpperCase())) {
        this.expireTaskLease(lease.lease_id, { reason: 'verified_result_arrived_for_terminal_or_missing_parent_job' });
        this.db.exec('RELEASE SAVEPOINT apply_verified_execution_result');
        return { status: 'REJECTED', reason: 'parent_job_not_active' };
      }
      const task = this.getTask(result.task_id);
      if (!task || task.job_id !== result.job_id ||
          !Number.isSafeInteger(task.execution_attempt) || task.execution_attempt !== result.attempt) {
        return reject('task_attempt_mismatch');
      }
      if (task.status !== 'running') return reject('task_not_running');

      const leaseExpiry = typeof lease.expires_at === 'string' ? Date.parse(lease.expires_at) : NaN;
      let canonicalLeaseExpiry = false;
      if (Number.isFinite(leaseExpiry)) {
        try { canonicalLeaseExpiry = new Date(leaseExpiry).toISOString() === lease.expires_at; } catch {}
      }
      if (!canonicalLeaseExpiry || leaseExpiry <= Date.now()) {
        this.expireTaskLease(lease.lease_id, {
          reason: canonicalLeaseExpiry
            ? 'verified_result_arrived_after_lease_expiry'
            : 'verified_result_arrived_with_malformed_lease_expiry'
        });
        this.db.exec('RELEASE SAVEPOINT apply_verified_execution_result');
        return { status: 'REJECTED', reason: canonicalLeaseExpiry ? 'lease_expired' : 'lease_expiry_malformed' };
      }
      const hasProviderRunLedger = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_runs' LIMIT 1").get());
      if (hasProviderRunLedger) {
        const providerRun = this.db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(result.provider_run_id);
        if (!providerRun) return reject('provider_run_record_missing');
        const ownerEpochMismatch = !Number.isSafeInteger(providerRun.owner_epoch) || providerRun.owner_epoch < 1 ||
          !Number.isSafeInteger(result.owner_epoch) || result.owner_epoch < 1 || providerRun.owner_epoch !== result.owner_epoch ||
          !Number.isSafeInteger(lease.owner_epoch) || lease.owner_epoch !== result.owner_epoch;
        const providerRunAttemptMismatch = !Number.isSafeInteger(providerRun.run_attempt) || providerRun.run_attempt < 1 ||
          !Number.isSafeInteger(result.provider_run_attempt) || result.provider_run_attempt < 1 ||
          providerRun.run_attempt !== result.provider_run_attempt;
        const conclusion = String(providerRun.conclusion || '').toLowerCase();
        const terminalConclusionMismatch = result.status === 'SUCCEEDED'
          ? conclusion !== 'success' || result.exit_code !== 0
          : conclusion === 'success' || result.status === 'UNKNOWN';
        if (providerRun.job_id !== result.job_id || providerRun.task_id !== result.task_id ||
            providerRun.lease_id !== result.lease_id || !Number.isSafeInteger(providerRun.attempt) || providerRun.attempt !== result.attempt ||
            ownerEpochMismatch || providerRun.input_commit !== result.input_commit || providerRun.state !== 'COMPLETED' ||
            providerRun.provider !== 'github-actions' || providerRunAttemptMismatch || terminalConclusionMismatch ||
            typeof providerRun.dispatch_key !== 'string' || !providerRun.dispatch_key ||
            typeof providerRun.request_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(providerRun.request_sha256) ||
            typeof providerRun.artifact_id !== 'string' || !/^\d+$/.test(providerRun.artifact_id) ||
            (providerRun.output_commit ?? null) !== (result.output_commit ?? null)) {
          return reject('provider_run_result_binding_mismatch');
        }
        // A run ledger row is not sufficient provenance by itself: bind it to
        // the exact immutable request that authorized the send. Resolve by both
        // run ID and dispatch key so an overwritten/re-pointed intent, duplicate
        // run association, or digest-only substitution cannot authorize result
        // publication. This executes after SAVEPOINT has acquired the writer.
        const hasDispatchIntentLedger = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_dispatch_intents' LIMIT 1").get());
        if (!hasDispatchIntentLedger) return reject('provider_dispatch_intent_ledger_missing');
        const runIntents = this.db.prepare('SELECT * FROM provider_dispatch_intents WHERE provider_run_id=?').all(result.provider_run_id);
        const keyIntents = this.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').all(providerRun.dispatch_key);
        if (runIntents.length !== 1 || keyIntents.length !== 1 ||
            runIntents[0].dispatch_key !== providerRun.dispatch_key || keyIntents[0].provider_run_id !== result.provider_run_id ||
            runIntents[0].state !== 'DISPATCHED' || keyIntents[0].state !== 'DISPATCHED' ||
            runIntents[0].request_sha256 !== providerRun.request_sha256 || keyIntents[0].request_sha256 !== providerRun.request_sha256) {
          return reject('provider_dispatch_intent_result_binding_mismatch');
        }
        const intent = runIntents[0];
        try {
          assertProviderDispatchIntent(intent, {
            job_id: result.job_id, task_id: result.task_id, lease_id: result.lease_id,
            attempt: result.attempt, owner_epoch: result.owner_epoch, provider: providerRun.provider,
            api_base: intent.api_base, workflow: providerRun.workflow, repository: intent.repository,
            event: intent.event, ref: providerRun.ref, input_commit: result.input_commit,
            request_sha256: providerRun.request_sha256
          });
        } catch {
          return reject('provider_dispatch_intent_result_binding_mismatch');
        }
      }
      const ts = now();
      if (checkpointed) {
        this.db.prepare(`INSERT INTO task_checkpoints(
          checkpoint_id, task_id, job_id, attempt, checkpoint_commit, checkpoint_ref,
          provider_run_id, evidence_artifact, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
          id('checkpoint'), result.task_id, result.job_id, result.attempt,
          result.checkpoint_commit, result.checkpoint_ref || null,
          result.provider_run_id, result.evidence_artifact || null, ts
        );
        const metadata = parseStrictJson(task.metadata_json || '{}');
        metadata.checkpoint_commit = result.checkpoint_commit;
        metadata.resume_input_commit = result.checkpoint_commit;
        metadata.checkpoint_ref = result.checkpoint_ref || null;
        const metadataUpdate = this.db.prepare("UPDATE tasks SET metadata_json=? WHERE task_id=? AND status='running' AND execution_attempt=?")
          .run(JSON.stringify(metadata), result.task_id, result.attempt);
        if (metadataUpdate.changes !== 1) throw new Error('checkpoint metadata write lost task attempt ownership');
      }

      const resultId = id('result');
      const resultContent = expectedResultContent;
      this.db.prepare('INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(resultId, result.task_id, success ? 'success' : checkpointed ? 'partial' : 'failure', resultContent, ts);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_VERIFIED_RESULT_INSERT === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }

      const taskMetadata = parseStrictJson(this.getTask(result.task_id).metadata_json || '{}');
      if (success && taskMetadata.runtime_owner === 'github-runner') {
        const role = String(task.role || '').toLowerCase();
        let content = null;
        try { content = agentOutput ? parseStrictJson(agentOutput) : null; } catch { content = null; }
        const typeByRole = { 'product-owner': 'requirements', researcher: 'research', architect: 'architecture', engineer: 'implementation', security: 'security-review', qa: 'qa-report', platform: 'platform-review', writer: 'documentation', reviewer: 'review', cto: 'cto-decision' };
        const type = typeByRole[role];
        if (type && content) {
          const activeArtifacts = this.listArtifacts(result.job_id, { activeOnly: true });
          const evidence = [resultId, ...activeArtifacts.map(a => a.artifact_id)];
          const artifactContent = type === 'review' && content.review ? content.review : content;
          this.createArtifact({ artifact_id: `${type}-${resultId}`, job_id: result.job_id, task_id: task.task_id, type, producer_role: role, content: artifactContent, evidence });
        }
      }

      // The lease ledger and workflow attempt ledger are distinct durable
      // projections. Persist an attempt row for the verified provider attempt
      // and a canonical task completion event in this same savepoint, so the
      // terminal-ledger validator can prove result -> artifact -> attempt ->
      // completion event lineage for distributed runner tasks as well as native
      // local tasks. A provider lease alone is not a completed attempt record.
      const attemptId = id('attempt');
      const startedAt = Date.parse(result.started_at);
      const finishedAt = Date.parse(result.finished_at);
      if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
        throw new Error('verified execution result has invalid attempt timestamps');
      }
      this.db.prepare(`INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at,finished_at,error)
        VALUES(?,?,?,?,?,?,?)`).run(
        attemptId, task.task_id, success ? 'completed' : checkpointed ? 'timeout' : 'failed',
        null, new Date(startedAt).toISOString(), new Date(finishedAt).toISOString(), success ? null : String(result.error || 'provider execution did not succeed').slice(0, 2000)
      );

      const leaseCompletion = this.completeTaskLease(result.lease_id, { workerId: lease.worker_id, success, error: result.error || null });
      if (!leaseCompletion.ok || leaseCompletion.lease?.state !== (success ? 'COMPLETED' : 'FAILED')) {
        throw new Error(`verified execution result could not settle its exact lease: ${leaseCompletion.reason || 'lease state mismatch'}`);
      }
      const taskUpdate = this.db.prepare(`UPDATE tasks SET status=?, execution_status=?, execution_exit_code=?, execution_finished_at=?, updated_at=?
        WHERE task_id=? AND job_id=? AND status='running' AND execution_attempt=?`)
        .run(success ? 'completed' : checkpointed ? 'pending' : 'failed', success ? 'completed' : checkpointed ? 'timeout' : 'failed', result.exit_code ?? null, result.finished_at || ts, ts, result.task_id, result.job_id, result.attempt);
      if (taskUpdate.changes !== 1) throw new Error('verified execution result lost its task/attempt compare-and-set');
      const completionType = success ? 'task.completed' : 'task.failed';
      const completionPayload = {
        taskId: result.task_id, resultId, runId: result.provider_run_id, sessionKey: null,
        attemptId, outcome: success ? 'success' : 'failure', failureClass: success ? null : 'PROVIDER_EXECUTION_FAILURE'
      };
      const completionDedupeKey = `${task.task_id}|${success ? 'success' : 'failure'}|${resultId}`;
      const completionEventId = this.recordEvent(result.job_id, completionType, completionPayload, completionDedupeKey);
      const completionEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(completionEventId);
      if (!completionEvent || completionEvent.event_id !== eventId(result.job_id, completionType, completionDedupeKey) ||
          completionEvent.job_id !== result.job_id || completionEvent.type !== completionType ||
          completionEvent.payload_json !== JSON.stringify(completionPayload)) {
        throw new Error('verified execution result completion event conflicts with its durable result and attempt');
      }
      const eventType = success ? 'task.execution.verified' : checkpointed ? 'task.execution.checkpointed' : 'task.execution.rejected';
      const eventPayload = {
        taskId: result.task_id, leaseId: result.lease_id, attempt: result.attempt,
        providerRunId: result.provider_run_id, resultId, resultContentSha256: hash(resultContent),
        outputCommit: result.output_commit, evidenceHash: result.evidence_verification?.evidence_hash || null
      };
      const dedupeKey = `${result.lease_id}|verified|${result.attempt}`;
      const eventIdValue = this.recordEvent(result.job_id, eventType, eventPayload, dedupeKey);
      const eventRows = this.db.prepare("SELECT event_id, job_id, type, payload_json FROM events WHERE job_id=? AND type IN ('task.execution.verified','task.execution.checkpointed','task.execution.rejected') AND json_extract(payload_json,'$.leaseId')=?")
        .all(result.job_id, result.lease_id);
      const event = this.db.prepare('SELECT event_id, job_id, type, payload_json FROM events WHERE event_id=?').get(eventIdValue);
      if (eventRows.length !== 1 || !event || event.event_id !== eventId(result.job_id, eventType, dedupeKey) ||
          event.job_id !== result.job_id || event.type !== eventType || event.payload_json !== JSON.stringify(eventPayload)) {
        throw new Error('verified execution result event conflicts with durable result/attempt/lease lineage');
      }
      const resultRow = this.db.prepare('SELECT result_id, task_id, outcome, content FROM results WHERE result_id=?').get(resultId);
      const taskAfter = this.getTask(result.task_id);
      if (!resultRow || resultRow.task_id !== result.task_id ||
          resultRow.outcome !== (success ? 'success' : checkpointed ? 'partial' : 'failure') || resultRow.content !== resultContent ||
          taskAfter?.status !== (success ? 'completed' : checkpointed ? 'pending' : 'failed')) {
        throw new Error('verified execution result durable readback does not match the committed transition');
      }
      this.db.exec('RELEASE SAVEPOINT apply_verified_execution_result');
      return { status: success ? 'VERIFIED' : checkpointed ? 'CHECKPOINTED' : 'REJECTED', task: taskAfter, result_id: resultId, checkpoint_commit: result.checkpoint_commit || null };
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT apply_verified_execution_result'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT apply_verified_execution_result'); } catch {}
      throw error;
    }
  }

  getLatestTaskCheckpoint(taskId) {
    return this.db.prepare('SELECT * FROM task_checkpoints WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId) || null;
  }
  getExecutionBatch(batchId) { return this.db.prepare('SELECT * FROM execution_batches WHERE batch_id = ?').get(batchId) || null; }
  listExecutionBatchItems(batchId) { return this.db.prepare('SELECT * FROM execution_batch_items WHERE batch_id = ? ORDER BY rowid ASC').all(batchId); }
  createExecutionBatch(jobId, { parentTaskId = null, role = 'executor', items = [], attempt = 1 } = {}) {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_EXECUTION_BATCH_ITEMS) {
      throw new Error(`execution batch requires 1..${MAX_EXECUTION_BATCH_ITEMS} items`);
    }
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('execution batch attempt must be a positive safe integer');
    if (typeof jobId !== 'string' || !jobId ||
        (parentTaskId !== null && (typeof parentTaskId !== 'string' || !parentTaskId)) ||
        typeof role !== 'string' || !role.trim()) {
      throw new Error('execution batch requires exact job, optional parent task, and role strings');
    }
    const job = this.getJob(jobId);
    if (!job || job.state !== 'EXECUTING') throw new Error(`execution batch requires EXECUTING job: ${jobId}`);
    const normalized = items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.taskId !== 'string' || !item.taskId.trim()) {
        throw new Error('execution batch item requires an exact taskId string');
      }
      const task = this.getTask(item.taskId);
      if (!task || task.job_id !== jobId) throw new Error(`batch task not found in Job: ${item.taskId}`);
      const metadata = parseStrictJson(task.metadata_json || '{}');
      const command = item.command === undefined || item.command === null ? metadata.command : item.command;
      if (typeof command !== 'string' || !command.trim() || command.length > MAX_EXECUTION_COMMAND_CHARS ||
          metadata.deterministic !== true || typeof metadata.command !== 'string' || !metadata.command.trim() ||
          (metadata.executor && metadata.executor !== 'ExecutionManager')) {
        throw new Error(`batch task is not an exact deterministic task: ${item.taskId}`);
      }
      const cwdInput = item.cwd === undefined || item.cwd === null ? metadata.cwd : item.cwd;
      if (cwdInput != null && (typeof cwdInput !== 'string' || !cwdInput.trim() || cwdInput.length > 4096)) {
        throw new Error(`execution batch item cwd must be a non-empty string up to 4096 characters: ${item.taskId}`);
      }
      const cwd = cwdInput == null ? null : cwdInput.trim();
      const timeoutMs = item.timeout_ms == null ? null : item.timeout_ms;
      if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXECUTION_TIMEOUT_MS)) {
        throw new Error(`execution batch item timeout_ms must be a safe integer in 1..${MAX_EXECUTION_TIMEOUT_MS}: ${item.taskId}`);
      }
      if (metadata.workflow_plan_task_id && metadata.executor === 'ExecutionManager') {
        // Structured workflow tasks store a human-readable command before
        // execution, while ExecutionManager requires the canonical shell-quoted
        // command that it will bind into the durable attempt. Only the
        // immutable-plan verifier may authorize that representation; do not
        // accept arbitrary command substitutions for planned task IDs.
        const approved = this.assertPreparedExecutionPlan(task, { command, cwd: cwd ?? metadata.cwd });
        if (!approved || approved.executable !== metadata.executable ||
            JSON.stringify(approved.args) !== JSON.stringify(metadata.args) ||
            Number(approved.timeout_ms) !== Number(metadata.timeout_ms)) {
          throw new Error(`batch structured execution differs from the immutable plan: ${item.taskId}`);
        }
      } else if (metadata.command !== command) {
        throw new Error(`batch task is not an exact deterministic task: ${item.taskId}`);
      }
      return { taskId: task.task_id, command, cwd, timeoutMs };
    });
    if (new Set(normalized.map(item => item.taskId)).size !== normalized.length) {
      throw new Error('execution batch task IDs must be unique');
    }
    const batchId = id('batch'); const ts = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentJob = this.getJob(jobId);
      if (!currentJob || currentJob.status !== 'active' || currentJob.state !== 'EXECUTING') {
        throw new Error(`execution batch requires an active EXECUTING job at durable reservation: ${jobId}`);
      }
      // Planned production requests recheck the current approval under the same
      // SQLite writer reservation as batch/item insertion. This closes the gap
      // between MCP preflight and durable creation if an approval is revoked or
      // the approved proposal is replaced concurrently.
      if (this.getExecutionPlan(jobId)) this.assertApprovalCurrent(jobId);
      // Two MCP requests can pass their read-only preflight concurrently. A
      // second transaction must not create another batch for a task even if
      // the first one finishes between those preflights. Recovery/retry uses
      // the existing batch ID; a new batch is never a task replay capability.
      const taskIds = normalized.map(item => item.taskId);
      const placeholders = taskIds.map(() => '?').join(',');
      const states = this.db.prepare(`SELECT task_id,status,execution_status,execution_session_id,execution_attempt
        FROM tasks WHERE task_id IN (${placeholders})`).all(...taskIds);
      if (states.length !== taskIds.length) throw new Error('execution batch task set changed before durable reservation');
      const ineligible = states.find(task => task.status !== 'pending' || task.execution_status != null ||
        task.execution_session_id != null || (task.execution_attempt != null && task.execution_attempt !== 0));
      if (ineligible) throw new Error(`execution batch task is no longer pending and unexecuted: ${ineligible.task_id}`);
      const previousItems = this.db.prepare(`SELECT task_id,batch_id FROM execution_batch_items
        WHERE task_id IN (${placeholders}) LIMIT 1`).get(...taskIds);
      if (previousItems) throw new Error(`execution batch task already belongs to durable batch history: ${previousItems.task_id}`);
      const previousAttempts = this.db.prepare(`SELECT task_id FROM attempts WHERE task_id IN (${placeholders}) LIMIT 1`).get(...taskIds);
      if (previousAttempts) throw new Error(`execution batch task already has execution attempt history: ${previousAttempts.task_id}`);
      this.db.prepare(`INSERT INTO execution_batches(batch_id, job_id, parent_task_id, role, status, attempt, created_at, started_at)
        VALUES(?, ?, ?, ?, 'RUNNING', ?, ?, ?)`).run(batchId, jobId, parentTaskId, role, attempt, ts, ts);
      for (const item of normalized) {
        const itemId = id('batch_item');
        this.db.prepare(`INSERT INTO execution_batch_items(batch_id, item_id, task_id, command, cwd, timeout_ms, status, attempt)
          VALUES(?, ?, ?, ?, ?, ?, 'PENDING', ?)`).run(batchId, itemId, item.taskId, item.command, item.cwd, item.timeoutMs, attempt);
      }
      this.recordEvent(jobId, 'execution.batch.created', {
        batchId, parentTaskId, role, attempt, taskIds: normalized.map(x => x.taskId), commands: normalized.map(x => x.command), items: normalized
      }, batchId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getExecutionBatch(batchId);
  }
  markExecutionBatchItemRunning(batchId, itemId, { expectedAttempt, startedAt = now() } = {}) {
    const attempt = expectedAttempt;
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('execution batch item claim requires its exact positive attempt');
    this.db.exec('SAVEPOINT claim_execution_batch_item');
    try {
      const claim = this.db.prepare(`UPDATE execution_batch_items SET status='RUNNING', started_at=?
        WHERE batch_id=? AND item_id=? AND status='PENDING' AND attempt=?
          AND EXISTS (SELECT 1 FROM execution_batches b JOIN jobs j ON j.job_id=b.job_id
            WHERE b.batch_id=execution_batch_items.batch_id AND b.status IN ('RUNNING','WAITING')
              AND b.attempt=? AND j.status='active' AND j.state='EXECUTING')`)
        .run(startedAt, batchId, itemId, attempt, attempt);
      if (claim.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT claim_execution_batch_item');
        return null;
      }
      const row = this.db.prepare(`SELECT i.*,b.attempt AS batch_attempt,j.state AS job_state,j.status AS job_status
        FROM execution_batch_items i JOIN execution_batches b ON b.batch_id=i.batch_id JOIN jobs j ON j.job_id=b.job_id
        WHERE i.batch_id=? AND i.item_id=?`).get(batchId, itemId) || null;
      if (!row || row.status !== 'RUNNING' || typeof row.attempt !== 'number' || row.attempt !== attempt ||
          row.batch_attempt !== attempt || row.job_state !== 'EXECUTING' || row.job_status !== 'active' || row.started_at !== startedAt) {
        throw new Error(`execution batch item claim readback does not bind exact active Job/batch/attempt: ${batchId}/${itemId}/${attempt}`);
      }
      this.db.exec('RELEASE SAVEPOINT claim_execution_batch_item');
      return row;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT claim_execution_batch_item'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT claim_execution_batch_item'); } catch {}
      throw error;
    }
  }
  prepareExecutionBatchRetry(batchId) {
    this.db.exec('SAVEPOINT retry_execution_batch');
    try {
      const reserve = this.db.prepare('UPDATE execution_batches SET status=status WHERE batch_id=?').run(batchId);
      if (reserve.changes !== 1) throw new Error(`execution batch not found: ${batchId}`);
      const batch = this.getExecutionBatch(batchId);
      if (!batch) throw new Error(`execution batch not found: ${batchId}`);
      if (batch.status !== 'FAILED') {
        this.db.exec('RELEASE SAVEPOINT retry_execution_batch');
        return batch;
      }
      if (typeof batch.attempt !== 'number' || !Number.isSafeInteger(batch.attempt) || batch.attempt < 1) {
        throw new Error('execution batch retry refuses a malformed durable attempt');
      }
      const nextAttempt = batch.attempt + 1;
      if (!Number.isSafeInteger(nextAttempt) || nextAttempt < 2) throw new Error('execution batch retry attempt is invalid');
      const ts = now();
      const transitioned = this.db.prepare(`UPDATE execution_batches SET status='RUNNING', attempt=?, started_at=?, finished_at=NULL
        WHERE batch_id=? AND status='FAILED' AND attempt=?`).run(nextAttempt, ts, batchId, batch.attempt);
      if (transitioned.changes !== 1) throw new Error(`execution batch retry lost state/attempt compare-and-set: ${batchId}`);
      this.db.prepare(`UPDATE execution_batch_items SET status='PENDING', attempt=attempt+1, execution_session_id=NULL,
        execution_pid=NULL, exit_code=NULL, stdout='', stderr='', error=NULL, started_at=NULL, finished_at=NULL
        WHERE batch_id=? AND status <> 'COMPLETED'`).run(batchId);
      this.recordEvent(batch.job_id, 'execution.batch.retry_started', { batchId, attempt: nextAttempt }, `${batchId}|retry|${nextAttempt}`);
      const persisted = this.getExecutionBatch(batchId);
      if (!persisted || persisted.status !== 'RUNNING' || typeof persisted.attempt !== 'number' || persisted.attempt !== nextAttempt ||
          this.listExecutionBatchItems(batchId).some(item => item.status !== 'COMPLETED' &&
            (typeof item.attempt !== 'number' || item.attempt !== nextAttempt || item.attempt > persisted.attempt))) {
        throw new Error(`execution batch retry readback does not match next attempt: ${batchId}`);
      }
      this.db.exec('RELEASE SAVEPOINT retry_execution_batch');
      return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT retry_execution_batch'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT retry_execution_batch'); } catch {}
      throw error;
    }
  }
  finishExecutionBatchItem(batchId, itemId, { expectedAttempt, executionSessionId = null, executionPid = null, exitCode = null, stdout = '', stderr = '', status = 'FAILED', error = null, finishedAt = now() } = {}) {
    const attempt = expectedAttempt;
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('execution batch item completion requires its exact positive attempt');
    if (!['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(status)) throw new Error(`invalid terminal execution batch item status: ${String(status)}`);
    if (exitCode !== null && exitCode !== undefined &&
        (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || Object.is(exitCode, -0))) {
      throw new Error('execution batch item exit code must be a canonical safe integer or null');
    }
    if (status === 'COMPLETED' && exitCode !== 0) {
      throw new Error('completed execution batch item requires exact numeric exit code 0');
    }
    if (status === 'COMPLETED' && error !== null) {
      throw new Error('completed execution batch item cannot carry a terminal error');
    }
    if (status === 'COMPLETED' && (typeof executionSessionId !== 'string' || !executionSessionId)) {
      throw new Error('completed execution batch item requires the exact durable execution session');
    }
    if (status === 'FAILED' && exitCode === 0 && (typeof error !== 'string' || !error.trim())) {
      throw new Error('failed execution batch item with exit code 0 requires an explicit failure reason');
    }
    if (executionPid !== null && executionPid !== undefined && (typeof executionPid !== 'number' || !Number.isSafeInteger(executionPid) || executionPid < 1)) {
      throw new Error('execution batch item PID must be a positive safe integer or null');
    }
    if (typeof stdout !== 'string' || typeof stderr !== 'string' || (error !== null && typeof error !== 'string')) {
      throw new Error('execution batch item output/error fields must use exact string types');
    }
    this.db.exec('SAVEPOINT finish_execution_batch_item');
    try {
      const transition = this.db.prepare(`UPDATE execution_batch_items SET status=?, execution_session_id=?, execution_pid=?,
        exit_code=?, stdout=?, stderr=?, error=?, finished_at=?
        WHERE batch_id=? AND item_id=? AND status='RUNNING' AND attempt=?
          AND EXISTS (SELECT 1 FROM execution_batches b WHERE b.batch_id=? AND b.status IN ('RUNNING','WAITING'))`)
        .run(status, executionSessionId, executionPid, exitCode == null ? null : exitCode, stdout, stderr, error, finishedAt,
          batchId, itemId, attempt, batchId);
      if (transition.changes !== 1) throw new Error(`execution batch item completion lost status/attempt ownership: ${batchId}/${itemId}/${attempt}`);
      const row = this.db.prepare('SELECT * FROM execution_batch_items WHERE batch_id = ? AND item_id = ?').get(batchId, itemId) || null;
      if (status === 'COMPLETED') {
        const identity = this.db.prepare(`SELECT i.attempt,b.attempt AS batch_attempt
          FROM execution_batch_items i JOIN execution_batches b ON b.batch_id=i.batch_id
          WHERE i.batch_id=? AND i.item_id=?`).get(batchId, itemId);
        if (typeof identity?.batch_attempt !== 'number' || identity.batch_attempt !== attempt ||
            typeof identity?.attempt !== 'number' || identity.attempt !== attempt) {
          throw new Error(`completed batch item does not bind the active batch attempt: ${batchId}/${itemId}/${attempt}`);
        }
        this.verifyCompletedExecutionBatchItem(batchId, itemId, { expectedItemAttempt: attempt });
      }
      if (!row || row.status !== status || typeof row.attempt !== 'number' || row.attempt !== attempt || row.finished_at !== finishedAt ||
          (row.stdout || '') !== (stdout || '') || (row.stderr || '') !== (stderr || '')) {
        throw new Error(`execution batch item terminal readback mismatch: ${batchId}/${itemId}/${attempt}`);
      }
      this.db.exec('RELEASE SAVEPOINT finish_execution_batch_item');
      return row;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT finish_execution_batch_item'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT finish_execution_batch_item'); } catch {}
      throw error;
    }
  }
  verifyCompletedExecutionBatchItem(batchId, itemId, { expectedItemAttempt = null } = {}) {
    if (typeof batchId !== 'string' || !batchId || typeof itemId !== 'string' || !itemId ||
        (expectedItemAttempt !== null && (!Number.isSafeInteger(expectedItemAttempt) || expectedItemAttempt < 1))) {
      throw new Error('completed batch-item verification requires exact batch/item identity and optional attempt');
    }
    const item = this.db.prepare(`SELECT i.*,b.job_id,b.attempt AS current_batch_attempt,b.status AS batch_status
      FROM execution_batch_items i JOIN execution_batches b ON b.batch_id=i.batch_id
      WHERE i.batch_id=? AND i.item_id=?`).get(batchId, itemId);
    const task = item ? this.getTask(item.task_id) : null;
    if (!item || item.status !== 'COMPLETED' || item.exit_code !== 0 || item.error !== null ||
        typeof item.execution_session_id !== 'string' || !item.execution_session_id ||
        typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1 ||
        typeof item.current_batch_attempt !== 'number' || !Number.isSafeInteger(item.current_batch_attempt) ||
        item.current_batch_attempt < item.attempt ||
        (expectedItemAttempt !== null && item.attempt !== expectedItemAttempt) ||
        !task || task.job_id !== item.job_id || task.status !== 'completed' || task.execution_status !== 'completed' ||
        task.execution_exit_code !== 0 || task.execution_session_id !== item.execution_session_id ||
        typeof task.execution_attempt !== 'number' || !Number.isSafeInteger(task.execution_attempt) || task.execution_attempt < 1 ||
        (task.execution_stdout || '') !== (item.stdout || '') || (task.execution_stderr || '') !== (item.stderr || '')) {
      throw new Error(`completed batch item lacks exact successful durable task/session/result evidence: ${batchId}/${itemId}`);
    }
    const metadata = parseStrictJson(task.metadata_json || '{}', 'task metadata for completed batch item');
    const expectedClaim = { batchId, itemId, batchAttempt: item.attempt, itemAttempt: item.attempt };
    if (item.command !== String(metadata.command || '') ||
        canonicalJson(metadata.execution_batch_claim) !== canonicalJson(expectedClaim)) {
      throw new Error(`completed batch item is not bound to its exact durable execution claim: ${batchId}/${itemId}`);
    }
    // Reuse the canonical task terminal-ledger validator rather than creating a
    // weaker parallel definition of result/event/attempt/artifact integrity.
    this.finishExecution(task.task_id, {
      executionSessionId: task.execution_session_id,
      attempt: task.execution_attempt,
      command: item.command,
      exitCode: 0,
      stdout: task.execution_stdout || '',
      stderr: task.execution_stderr || '',
      status: 'completed',
      error: null
    });
    return task;
  }
  verifyTerminalExecutionBatchItem(batchId, itemId) {
    const item = this.db.prepare(`SELECT i.*,b.job_id,b.attempt AS current_batch_attempt
      FROM execution_batch_items i JOIN execution_batches b ON b.batch_id=i.batch_id
      WHERE i.batch_id=? AND i.item_id=?`).get(batchId, itemId);
    if (!item || !['FAILED', 'TIMEOUT', 'CANCELLED'].includes(item.status) ||
        typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1 ||
        typeof item.current_batch_attempt !== 'number' || !Number.isSafeInteger(item.current_batch_attempt) ||
        item.attempt !== item.current_batch_attempt || typeof item.error !== 'string' || !item.error.trim() ||
        typeof item.started_at !== 'string' || typeof item.finished_at !== 'string' ||
        !Number.isFinite(Date.parse(item.started_at)) || !Number.isFinite(Date.parse(item.finished_at)) ||
        new Date(Date.parse(item.started_at)).toISOString() !== item.started_at ||
        new Date(Date.parse(item.finished_at)).toISOString() !== item.finished_at ||
        Date.parse(item.finished_at) < Date.parse(item.started_at)) {
      throw new Error(`failed batch item lacks exact terminal attempt/error evidence: ${batchId}/${itemId}`);
    }
    const task = this.getTask(item.task_id);
    if (!task || task.job_id !== item.job_id) throw new Error(`failed batch item task identity is missing: ${batchId}/${itemId}`);
    const startedAttempts = this.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(item.task_id).n;
    if (task.execution_status === 'running' || task.execution_session_id || startedAttempts !== 0) {
      if (!['failed', 'timeout', 'cancelled'].includes(task.execution_status) || !task.execution_finished_at ||
          !task.execution_session_id || task.status !== (task.execution_status === 'cancelled' ? 'cancelled' : 'failed')) {
        throw new Error(`failed batch item conflicts with a live or incomplete task execution: ${batchId}/${itemId}`);
      }
      const expectedStatus = task.execution_status === 'timeout' ? 'TIMEOUT' :
        task.execution_status === 'cancelled' ? 'CANCELLED' : 'FAILED';
      const taskFinishedMs = Date.parse(task.execution_finished_at);
      const itemFinishedMs = Date.parse(item.finished_at);
      if (item.status !== expectedStatus || item.execution_session_id !== task.execution_session_id ||
          item.exit_code !== task.execution_exit_code || (item.stdout || '') !== (task.execution_stdout || '') ||
          (item.stderr || '') !== (task.execution_stderr || '') || !Number.isFinite(taskFinishedMs) ||
          !Number.isFinite(itemFinishedMs) || itemFinishedMs < taskFinishedMs) {
        throw new Error(`failed batch item contradicts its durable task terminal state: ${batchId}/${itemId}`);
      }
      const metadata = parseStrictJson(task.metadata_json || '{}', 'task metadata for failed batch item');
      const expectedClaim = { batchId, itemId, batchAttempt: item.attempt, itemAttempt: item.attempt };
      if (item.command !== String(metadata.command || '') ||
          canonicalJson(metadata.execution_batch_claim) !== canonicalJson(expectedClaim)) {
        throw new Error(`failed batch item is not bound to its exact durable execution claim: ${batchId}/${itemId}`);
      }
      const attempt = this.db.prepare('SELECT status,finished_at,error FROM attempts WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(item.task_id);
      if (!attempt || attempt.status === 'started' || attempt.finished_at !== task.execution_finished_at) {
        throw new Error(`failed batch item lacks its exact settled task attempt: ${batchId}/${itemId}`);
      }
      const defaultExitError = task.execution_exit_code !== null && task.execution_exit_code !== undefined && task.execution_exit_code !== 0
        ? `exit status ${task.execution_exit_code}` : null;
      const terminalError = attempt.error === defaultExitError ? null : attempt.error;
      this.finishExecution(task.task_id, {
        executionSessionId: task.execution_session_id, attempt: task.execution_attempt,
        command: item.command, exitCode: task.execution_exit_code,
        stdout: task.execution_stdout || '', stderr: task.execution_stderr || '',
        status: task.execution_status, error: terminalError
      });
      return task;
    }
    // A command can fail before prepareExecution creates a task attempt. That
    // is valid only when there is no execution/session/attempt evidence at all
    // and the caller recorded an explicit failure reason.
    if (item.status !== 'FAILED' || task.execution_status != null || task.execution_session_id != null ||
        this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(item.task_id).n !== 0) {
      throw new Error(`failed batch item has no matching task terminal ledger or safe pre-start failure: ${batchId}/${itemId}`);
    }
    return task;
  }
  verifyCompletedExecutionBatch(batchId) {
    const batch = this.getExecutionBatch(batchId);
    const items = this.listExecutionBatchItems(batchId);
    if (!batch || batch.status !== 'COMPLETED' || !items.length || items.some(item => item.status !== 'COMPLETED')) {
      throw new Error(`completed batch does not have a fully completed durable item ledger: ${batchId}`);
    }
    for (const item of items) this.verifyCompletedExecutionBatchItem(batchId, item.item_id);
    return { ...batch, items };
  }
  recoverUnstartedExecutionBatchClaims({ staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString(), finishedAt = now(), jobId = null } = {}) {
    const cutoff = new Date(staleBefore);
    if (!Number.isFinite(cutoff.getTime())) throw new Error('unstarted batch recovery cutoff is invalid');
    const cutoffIso = cutoff.toISOString();
    this.db.exec('SAVEPOINT recover_unstarted_batch_claims');
    try {
      // A RUNNING batch item is normally owned by its executor. Recover only
      // old claims for which task execution never durably began: no running
      // execution status/session and no started attempt. The age gate avoids
      // racing the small claim-to-prepareExecution window of a live process.
      const candidates = this.db.prepare(`SELECT i.batch_id,i.item_id,i.task_id,i.attempt,i.started_at,b.job_id,b.attempt AS batch_attempt
        FROM execution_batch_items i JOIN execution_batches b ON b.batch_id=i.batch_id
        JOIN tasks t ON t.task_id=i.task_id
        WHERE i.status='RUNNING' AND i.started_at IS NOT NULL AND i.started_at<=?
          AND b.status IN ('RUNNING','WAITING') AND t.execution_status IS NOT 'running'
          AND t.execution_session_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.task_id=t.task_id AND a.status='started')
          ${jobId ? 'AND b.job_id=?' : ''}
        ORDER BY i.started_at`).all(...(jobId ? [cutoffIso, jobId] : [cutoffIso]));
      const recovered = [];
      for (const item of candidates) {
        if (typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1 ||
            typeof item.batch_attempt !== 'number' || !Number.isSafeInteger(item.batch_attempt) || item.batch_attempt < 1 ||
            item.attempt !== item.batch_attempt) {
          throw new Error(`unstarted batch claim has malformed item/batch attempt lineage: ${item.batch_id}/${item.item_id}`);
        }
        const reserve = this.db.prepare(`UPDATE execution_batches SET status=status WHERE batch_id=? AND attempt=? AND status IN ('RUNNING','WAITING')`)
          .run(item.batch_id, item.batch_attempt);
        if (reserve.changes !== 1) continue;
        const changed = this.db.prepare(`UPDATE execution_batch_items SET status='FAILED',error=?,stderr=?,finished_at=?
          WHERE batch_id=? AND item_id=? AND task_id=? AND status='RUNNING' AND attempt=? AND started_at<=?
            AND EXISTS (SELECT 1 FROM execution_batches b WHERE b.batch_id=execution_batch_items.batch_id
              AND b.attempt=? AND b.status IN ('RUNNING','WAITING'))
            AND EXISTS (SELECT 1 FROM tasks t WHERE t.task_id=execution_batch_items.task_id
              AND t.execution_status IS NOT 'running' AND t.execution_session_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.task_id=t.task_id AND a.status='started'))`)
          .run('executor process disappeared before durable task execution began; safe retry required',
            'executor process disappeared before durable task execution began; safe retry required', finishedAt,
            item.batch_id, item.item_id, item.task_id, item.attempt, cutoffIso, item.batch_attempt);
        if (changed.changes !== 1) continue;
        const payload = { batchId: item.batch_id, itemId: item.item_id, taskId: item.task_id,
          itemAttempt: item.attempt, recovery: 'unstarted_claim', finishedAt };
        this.recordEvent(item.job_id, 'execution.batch.item_recovered_unstarted', payload,
          `${item.batch_id}|${item.item_id}|${item.attempt}`);
        const remaining = this.db.prepare(`SELECT COUNT(*) AS count FROM execution_batch_items
          WHERE batch_id=? AND status IN ('PENDING','RUNNING')`).get(item.batch_id).count;
        if (remaining === 0) {
          const terminal = this.db.prepare(`UPDATE execution_batches SET status='FAILED',finished_at=?,aggregate_content=?
            WHERE batch_id=? AND status IN ('RUNNING','WAITING') AND attempt=?`)
            .run(finishedAt, '[RECOVERY FAILURE] Executor disappeared before task execution began; safe retry required.',
              item.batch_id, item.batch_attempt);
          if (terminal.changes === 1) this.recordEvent(item.job_id, 'execution.batch.failed', {
            batchId: item.batch_id, attempt: item.batch_attempt, status: 'FAILED', recoveryReason: 'unstarted_item_claim_recovered'
          }, `${item.batch_id}|terminal|${item.batch_attempt}`);
        }
        const persisted = this.db.prepare('SELECT status,attempt,finished_at FROM execution_batch_items WHERE batch_id=? AND item_id=?')
          .get(item.batch_id, item.item_id);
        if (persisted?.status !== 'FAILED' || typeof persisted.attempt !== 'number' || persisted.attempt !== item.attempt || persisted.finished_at !== finishedAt) {
          throw new Error(`unstarted batch claim recovery readback mismatch: ${item.batch_id}/${item.item_id}`);
        }
        recovered.push({ batchId: item.batch_id, itemId: item.item_id, taskId: item.task_id, attempt: item.attempt });
      }
      this.db.exec('RELEASE SAVEPOINT recover_unstarted_batch_claims');
      return recovered;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT recover_unstarted_batch_claims'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT recover_unstarted_batch_claims'); } catch {}
      throw error;
    }
  }
  recoverTerminalExecutionBatchItemFromTask(batchId, itemId, { expectedBatchAttempt, expectedItemAttempt, recoveredAt = now() } = {}) {
    const batchAttempt = expectedBatchAttempt;
    const itemAttempt = expectedItemAttempt;
    if (typeof batchId !== 'string' || !batchId || typeof itemId !== 'string' || !itemId ||
        typeof batchAttempt !== 'number' || typeof itemAttempt !== 'number' ||
        !Number.isSafeInteger(batchAttempt) || batchAttempt < 1 ||
        !Number.isSafeInteger(itemAttempt) || itemAttempt < 1) {
      throw new Error('terminal batch-item recovery requires exact batch/item/attempt identity');
    }
    this.db.exec('SAVEPOINT recover_terminal_execution_batch_item');
    try {
      // A crash after finishExecution commits but before the batch-item write
      // leaves a RUNNING item beside a terminal task. Lock the same batch row
      // used by cancel/retry/claim transitions, then accept only a task result
      // whose start event durably binds this exact batch/item claim. A newer or
      // unrelated task attempt must never be used to settle this item.
      const reserve = this.db.prepare(`UPDATE execution_batches SET status=status
        WHERE batch_id=? AND attempt=? AND status IN ('RUNNING','WAITING')`).run(batchId, batchAttempt);
      if (reserve.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT recover_terminal_execution_batch_item');
        return null;
      }
      const item = this.db.prepare(`SELECT i.task_id,i.command,i.status,i.attempt,b.job_id,b.attempt AS batch_attempt
        FROM execution_batch_items i JOIN execution_batches b ON b.batch_id=i.batch_id
        WHERE i.batch_id=? AND i.item_id=?`).get(batchId, itemId);
      if (!item || item.status !== 'RUNNING' || typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) ||
          item.attempt !== itemAttempt || typeof item.batch_attempt !== 'number' || !Number.isSafeInteger(item.batch_attempt) ||
          item.batch_attempt !== batchAttempt || itemAttempt !== batchAttempt) {
        this.db.exec('RELEASE SAVEPOINT recover_terminal_execution_batch_item');
        return null;
      }
      const task = this.getTask(item.task_id);
      if (!task || task.job_id !== item.job_id || typeof task.execution_attempt !== 'number' ||
          !Number.isSafeInteger(task.execution_attempt) || task.execution_attempt < 1 ||
          !['completed', 'failed', 'timeout', 'cancelled'].includes(task.execution_status) ||
          task.status !== (task.execution_status === 'completed' ? 'completed' : task.execution_status === 'cancelled' ? 'cancelled' : 'failed') ||
          !task.execution_session_id || !task.execution_finished_at) {
        this.db.exec('RELEASE SAVEPOINT recover_terminal_execution_batch_item');
        return null;
      }
      const metadata = parseStrictJson(task.metadata_json || '{}');
      const expectedClaim = { batchId, itemId, batchAttempt, itemAttempt };
      if (canonicalJson(metadata.execution_batch_claim) !== canonicalJson(expectedClaim) ||
          String(metadata.command || '') !== item.command) {
        this.db.exec('RELEASE SAVEPOINT recover_terminal_execution_batch_item');
        return null;
      }
      const startId = eventId(task.job_id, 'execution.started', `${task.task_id}|execution|${task.execution_attempt}`);
      const startRows = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?")
        .all(task.job_id, task.task_id, task.execution_attempt);
      const startEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(startId);
      let startPayload;
      try { startPayload = parseStrictJson(startEvent?.payload_json || ''); }
      catch { throw new Error(`terminal batch-item recovery has no canonical execution-start event: ${batchId}/${itemId}`); }
      if (startRows.length !== 1 || !startEvent || startEvent.event_id !== startId || startEvent.job_id !== task.job_id ||
          startEvent.type !== 'execution.started' || startEvent.payload_json !== JSON.stringify(startPayload) ||
          startPayload.taskId !== task.task_id || startPayload.executionSessionId !== task.execution_session_id ||
          typeof startPayload.attempt !== 'number' || startPayload.attempt !== task.execution_attempt || startPayload.command !== item.command ||
          canonicalJson(startPayload.executionBatchClaim) !== canonicalJson(expectedClaim)) {
        throw new Error(`terminal batch-item recovery start-event claim binding conflicts: ${batchId}/${itemId}`);
      }
      const attempt = this.db.prepare(`SELECT attempt_id,task_id,status,finished_at,error FROM attempts
        WHERE attempt_id=? AND task_id=?`).get(startPayload.attemptId, task.task_id);
      if (!attempt || attempt.status === 'started' || !attempt.finished_at ||
          this.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(task.task_id).n !== 0) {
        throw new Error(`terminal batch-item recovery has incomplete durable attempt evidence: ${batchId}/${itemId}`);
      }
      // Re-enter the store's existing terminal-ledger validator. This verifies
      // result bytes, terminal event, artifact lineage (where required), exact
      // session/attempt identity and settled attempt row before copying results.
      const verifiedTask = this.finishExecution(task.task_id, {
        executionSessionId: task.execution_session_id,
        attempt: task.execution_attempt,
        command: item.command,
        exitCode: task.execution_exit_code,
        stdout: task.execution_stdout || '',
        stderr: task.execution_stderr || '',
        status: task.execution_status,
        error: attempt.error
      });
      const itemStatus = verifiedTask.execution_status === 'completed' ? 'COMPLETED' :
        verifiedTask.execution_status === 'timeout' ? 'TIMEOUT' :
          verifiedTask.execution_status === 'cancelled' ? 'CANCELLED' : 'FAILED';
      const recoveredItem = this.finishExecutionBatchItem(batchId, itemId, {
        expectedAttempt: itemAttempt,
        executionSessionId: verifiedTask.execution_session_id,
        executionPid: verifiedTask.execution_pid == null ? null : Number(verifiedTask.execution_pid),
        exitCode: verifiedTask.execution_exit_code,
        stdout: verifiedTask.execution_stdout || '',
        stderr: verifiedTask.execution_stderr || '',
        status: itemStatus,
        error: attempt.error || null,
        finishedAt: verifiedTask.execution_finished_at
      });
      this.recordEvent(item.job_id, 'execution.batch.item_recovered_from_terminal_task', {
        batchId, itemId, taskId: item.task_id, batchAttempt, itemAttempt,
        taskExecutionAttempt: verifiedTask.execution_attempt, executionSessionId: verifiedTask.execution_session_id,
        status: itemStatus, recoveredAt
      }, `${batchId}|${itemId}|terminal-task-recovery|${itemAttempt}`);
      const persisted = this.db.prepare('SELECT status,attempt,execution_session_id,stdout,stderr,finished_at FROM execution_batch_items WHERE batch_id=? AND item_id=?')
        .get(batchId, itemId);
      if (!persisted || persisted.status !== itemStatus || typeof persisted.attempt !== 'number' || persisted.attempt !== itemAttempt ||
          persisted.execution_session_id !== verifiedTask.execution_session_id ||
          (persisted.stdout || '') !== (verifiedTask.execution_stdout || '') ||
          (persisted.stderr || '') !== (verifiedTask.execution_stderr || '') ||
          persisted.finished_at !== verifiedTask.execution_finished_at) {
        throw new Error(`terminal batch-item recovery readback mismatch: ${batchId}/${itemId}`);
      }
      this.db.exec('RELEASE SAVEPOINT recover_terminal_execution_batch_item');
      return recoveredItem;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT recover_terminal_execution_batch_item'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT recover_terminal_execution_batch_item'); } catch {}
      throw error;
    }
  }
  recoverStaleExecutionBatchItem(taskId, { expectedAttempt, reason = 'execution supervisor/session missing; recovery terminalized the orphaned attempt as failed', finishedAt = now() } = {}) {
    const attempt = expectedAttempt;
    if (typeof taskId !== 'string' || !taskId || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error('stale batch recovery requires exact task and positive execution attempt identity');
    }
    this.db.exec('SAVEPOINT recover_stale_execution_batch_item');
    try {
      const matching = this.db.prepare(`SELECT i.batch_id,i.item_id,i.task_id,i.attempt,i.status,b.job_id,b.status AS batch_status,b.attempt AS batch_attempt
        FROM execution_batch_items i JOIN execution_batches b ON b.batch_id=i.batch_id
        WHERE i.task_id=? AND i.status='RUNNING' AND i.attempt=? AND b.status IN ('RUNNING','WAITING')`)
        .all(taskId, attempt);
      if (matching.length > 1) throw new Error(`stale execution is bound to multiple active batch items: ${taskId}/${attempt}`);
      if (matching.length === 0) {
        this.db.exec('RELEASE SAVEPOINT recover_stale_execution_batch_item');
        return null;
      }
      const item = matching[0];
      if (typeof item.attempt !== 'number' || item.attempt !== attempt ||
          typeof item.batch_attempt !== 'number' || !Number.isSafeInteger(item.batch_attempt) || item.batch_attempt < 1) {
        throw new Error(`stale batch recovery found malformed durable item/batch attempt: ${item.batch_id}/${item.item_id}`);
      }
      const reserve = this.db.prepare(`UPDATE execution_batches SET status=status WHERE batch_id=? AND attempt=? AND status IN ('RUNNING','WAITING')`)
        .run(item.batch_id, item.batch_attempt);
      if (reserve.changes !== 1) throw new Error(`stale batch recovery lost batch state/attempt ownership: ${item.batch_id}`);
      const transition = this.db.prepare(`UPDATE execution_batch_items SET status='FAILED', error=?, stderr=?, finished_at=?
        WHERE batch_id=? AND item_id=? AND task_id=? AND status='RUNNING' AND attempt=?`)
        .run(reason, reason, finishedAt, item.batch_id, item.item_id, taskId, attempt);
      if (transition.changes !== 1) throw new Error(`stale batch recovery lost item state/attempt ownership: ${item.batch_id}/${item.item_id}/${attempt}`);
      const items = this.listExecutionBatchItems(item.batch_id);
      if (!items.some(candidate => ['PENDING', 'RUNNING'].includes(candidate.status))) {
        const terminal = this.db.prepare(`UPDATE execution_batches SET status='FAILED', finished_at=?, aggregate_content=?
          WHERE batch_id=? AND status IN ('RUNNING','WAITING') AND attempt=?`)
          .run(finishedAt, `[RECOVERY FAILURE]\n${reason}`, item.batch_id, item.batch_attempt);
        if (terminal.changes !== 1) throw new Error(`stale batch recovery terminal compare-and-set failed: ${item.batch_id}`);
        this.recordEvent(item.job_id, 'execution.batch.failed', {
          batchId: item.batch_id, attempt: item.batch_attempt, status: 'FAILED',
          itemCount: items.length, failedCount: items.filter(candidate => candidate.status !== 'COMPLETED').length,
          recoveryReason: reason
        }, `${item.batch_id}|terminal|${item.batch_attempt}`);
      }
      const persistedItem = this.db.prepare('SELECT * FROM execution_batch_items WHERE batch_id=? AND item_id=?').get(item.batch_id, item.item_id);
      const persistedBatch = this.getExecutionBatch(item.batch_id);
      if (!persistedItem || persistedItem.status !== 'FAILED' || typeof persistedItem.attempt !== 'number' || persistedItem.attempt !== attempt ||
          persistedItem.finished_at !== finishedAt || persistedItem.error !== reason || !persistedBatch ||
          !['RUNNING', 'WAITING', 'FAILED'].includes(persistedBatch.status)) {
        throw new Error(`stale batch recovery readback mismatch: ${item.batch_id}/${item.item_id}`);
      }
      this.db.exec('RELEASE SAVEPOINT recover_stale_execution_batch_item');
      return { batch: persistedBatch, item: persistedItem, items: this.listExecutionBatchItems(item.batch_id) };
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT recover_stale_execution_batch_item'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT recover_stale_execution_batch_item'); } catch {}
      throw error;
    }
  }
  markExecutionBatchWaiting(batchId) {
    this.db.prepare("UPDATE execution_batches SET status='WAITING' WHERE batch_id=? AND status='RUNNING'").run(batchId);
    return this.getExecutionBatch(batchId);
  }
  finishExecutionBatch(batchId, { status = null, aggregateContent = '', expectedAttempt = null } = {}) {
    const attempt = expectedAttempt;
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('execution batch completion requires its exact positive attempt');
    if (status !== null && status !== 'COMPLETED' && status !== 'FAILED') throw new Error(`invalid execution batch terminal status: ${String(status)}`);
    if (typeof aggregateContent !== 'string') throw new Error('execution batch aggregate content must be a string');
    this.db.exec('SAVEPOINT finish_execution_batch');
    try {
      const reserve = this.db.prepare(`UPDATE execution_batches SET status=status WHERE batch_id=?
        AND status IN ('RUNNING','WAITING') AND attempt=?`).run(batchId, attempt);
      if (reserve.changes !== 1) throw new Error(`execution batch completion lost state/attempt ownership: ${batchId}/${attempt}`);
      const batch = this.getExecutionBatch(batchId);
      if (!batch || typeof batch.attempt !== 'number' || batch.attempt !== attempt) throw new Error(`execution batch completion attempt changed: ${batchId}`);
      const items = this.listExecutionBatchItems(batchId);
      if (!items.length || items.some(item => !['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(item.status))) {
        throw new Error(`execution batch cannot terminalize while an item is pending or running: ${batchId}`);
      }
      const expectedStatus = items.every(item => item.status === 'COMPLETED') ? 'COMPLETED' : 'FAILED';
      const finalStatus = status || expectedStatus;
      if (finalStatus !== expectedStatus) throw new Error(`execution batch terminal status contradicts its durable item states: ${batchId}`);
      if (finalStatus === 'COMPLETED') {
        // A status-shaped item ledger is not sufficient evidence for batch
        // success, including when a caller invokes finishExecutionBatch
        // directly. Revalidate each item's exact task result and batch claim
        // before publishing the aggregate terminal transition.
        for (const item of items) this.verifyCompletedExecutionBatchItem(batchId, item.item_id);
      } else {
        // A FAILED aggregate must not be manufactured from terminal-looking
        // item rows while the underlying task still owns a live execution.
        // Failures after execution began must match the exact task terminal
        // ledger; pre-start failures need an explicit reason and no attempt.
        for (const item of items) {
          if (item.status === 'COMPLETED') this.verifyCompletedExecutionBatchItem(batchId, item.item_id);
          else this.verifyTerminalExecutionBatchItem(batchId, item.item_id);
        }
      }
      const ts = now();
      const update = this.db.prepare(`UPDATE execution_batches SET status=?, finished_at=?, aggregate_content=?
        WHERE batch_id=? AND status IN ('RUNNING','WAITING') AND attempt=?`).run(finalStatus, ts, aggregateContent, batchId, attempt);
      if (update.changes !== 1) throw new Error(`execution batch terminal compare-and-set failed: ${batchId}/${attempt}`);
      const terminalEventType = finalStatus === 'COMPLETED' ? 'execution.batch.completed' : 'execution.batch.failed';
      const terminalEventPayload = {
        batchId, attempt, status: finalStatus, itemCount: items.length,
        failedCount: items.filter(item => item.status !== 'COMPLETED').length
      };
      const terminalEventId = this.recordEvent(batch.job_id, terminalEventType, terminalEventPayload, `${batchId}|terminal|${attempt}`);
      const terminalEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(terminalEventId);
      const terminalEvents = this.db.prepare(`SELECT event_id,job_id,type,payload_json FROM events
        WHERE job_id=? AND type IN ('execution.batch.completed','execution.batch.failed')
          AND json_extract(payload_json,'$.batchId')=? AND json_extract(payload_json,'$.attempt')=?`)
        .all(batch.job_id, batchId, attempt);
      if (terminalEvents.length !== 1 || !terminalEvent ||
          terminalEvent.event_id !== eventId(batch.job_id, terminalEventType, `${batchId}|terminal|${attempt}`) ||
          terminalEvent.job_id !== batch.job_id || terminalEvent.type !== terminalEventType ||
          terminalEvent.payload_json !== JSON.stringify(terminalEventPayload)) {
        throw new Error(`execution batch terminal event readback conflicts with durable item aggregate: ${batchId}/${attempt}`);
      }
      const persisted = this.getExecutionBatch(batchId);
      const persistedItems = this.listExecutionBatchItems(batchId);
      if (!persisted || persisted.status !== finalStatus || persisted.finished_at !== ts || persisted.aggregate_content !== aggregateContent ||
          persistedItems.some(item => !['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(item.status))) {
        throw new Error(`execution batch terminal readback mismatch: ${batchId}/${attempt}`);
      }
      this.db.exec('RELEASE SAVEPOINT finish_execution_batch');
      return { ...persisted, items: persistedItems };
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT finish_execution_batch'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT finish_execution_batch'); } catch {}
      throw error;
    }
  }
  cancelExecutionBatch(batchId, reason = 'execution request cancelled') {
    this.db.exec('SAVEPOINT cancel_execution_batch');
    try {
      const batch = this.getExecutionBatch(batchId);
      if (!batch) throw new Error(`execution batch not found: ${batchId}`);
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(batch.status)) {
        this.db.exec('RELEASE SAVEPOINT cancel_execution_batch');
        return { ...batch, items: this.listExecutionBatchItems(batchId) };
      }
      const reserve = this.db.prepare(`UPDATE execution_batches SET status=status WHERE batch_id=? AND status IN ('RUNNING','WAITING')`).run(batchId);
      if (reserve.changes !== 1) throw new Error(`execution batch cancellation lost state ownership: ${batchId}`);
      const ts = now();
      this.db.prepare(`UPDATE execution_batch_items SET status='CANCELLED', error=?, finished_at=?
        WHERE batch_id=? AND status IN ('PENDING','RUNNING')`).run(reason, ts, batchId);
      const transition = this.db.prepare(`UPDATE execution_batches SET status='CANCELLED', finished_at=?, aggregate_content=?
        WHERE batch_id=? AND status IN ('RUNNING','WAITING')`).run(ts, reason, batchId);
      if (transition.changes !== 1) throw new Error(`execution batch cancellation compare-and-set failed: ${batchId}`);
      this.recordEvent(batch.job_id, 'execution.batch.cancelled', { batchId, reason }, `${batchId}|cancelled`);
      const persisted = this.getExecutionBatch(batchId);
      const items = this.listExecutionBatchItems(batchId);
      if (!persisted || persisted.status !== 'CANCELLED' || items.some(item => ['PENDING', 'RUNNING'].includes(item.status))) {
        throw new Error(`execution batch cancellation readback mismatch: ${batchId}`);
      }
      this.db.exec('RELEASE SAVEPOINT cancel_execution_batch');
      return { ...persisted, items };
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT cancel_execution_batch'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT cancel_execution_batch'); } catch {}
      throw error;
    }
  }
  findDeterministicTask(jobId, { role = null, command = null } = {}) {
    // Same-task recovery must be able to re-enter the deterministic executor
    // after a prior agent attempt failed. Prefer live work, then the newest
    // failed matching task; never select a terminal successful task.
    const rows = this.db.prepare("SELECT * FROM tasks WHERE job_id = ? AND status IN ('pending','running','failed','completed') ORDER BY CASE WHEN status IN ('pending','running') THEN 0 WHEN status = 'failed' THEN 1 ELSE 2 END, created_at DESC, rowid DESC").all(jobId);
    return rows.find(task => {
      if (role && String(task.role || '').toLowerCase() !== String(role).toLowerCase()) return false;
      if (String(task.status).toLowerCase() === 'completed') {
        // OpenClaw completion can race the adapter's deterministic exec turn.
        // Re-open only a completed task that has no durable execution evidence;
        // a task with actual ExecutionManager evidence remains terminal.
        if (task.execution_status || task.execution_session_id) return false;
      }
      if (!command) return true;
      const description = String(task.description || '');
      const metadata = parseStrictJson(task.metadata_json || '{}');
      if (typeof metadata.command === 'string' && metadata.command.trim()) return metadata.command === command;
      // Determinism authorizes a class of execution, not every command string.
      // Recovery must select the exact requested command rather than an
      // unrelated deterministic task that happens to sort first.
      return (typeof metadata.command === 'string' && metadata.command === command) ||
        description.includes(command) || new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(description);
    }) || null;
  }
  assertPreparedExecutionPlan(task, { command, cwd }) {
    const metadata = parseStrictJson(task.metadata_json || '{}');
    const plan = this.getExecutionPlan(task.job_id);
    // Unplanned generic jobs retain their legacy deterministic command path;
    // only tasks explicitly tied to a durable workflow plan (or a child of a
    // supported plan) are constrained to its executable contract.
    if (!plan && !metadata.workflow_plan_task_id) return null;
    if (!metadata.workflow_plan_task_id && !task.parent_task_id) return null;
    if (!plan || typeof metadata.workflow_plan_task_id !== 'string' || !metadata.workflow_plan_task_id) {
      throw new Error(`immutable execution plan/task binding is missing for ${task.task_id}`);
    }
    const planned = plan.children.find(item => item.id === metadata.workflow_plan_task_id);
    const sameRole = plan.children.find(item => String(item.role || '').toLowerCase() === String(task.role || '').toLowerCase());
    if (!planned || !sameRole || planned.id !== sameRole.id) {
      throw new Error(`immutable execution plan task ID does not match the task role: ${task.task_id}`);
    }
    assertTaskDependenciesMatchPlan(task, planned, `task ${task.task_id}`);
    const specification = planned.execution;
    if (!specification || specification.deterministic !== true || specification.executor !== 'ExecutionManager' ||
        typeof specification.executable !== 'string' || !Array.isArray(specification.args) ||
        specification.args.some(arg => typeof arg !== 'string') || typeof specification.cwd !== 'string' ||
        !Number.isSafeInteger(Number(specification.timeout_ms)) || Number(specification.timeout_ms) < 1) {
      throw new Error(`immutable plan does not authorize deterministic execution for ${task.task_id}`);
    }
    if (metadata.deterministic !== true || metadata.executor !== specification.executor ||
        metadata.executable !== specification.executable || JSON.stringify(metadata.args) !== JSON.stringify(specification.args) ||
        path.resolve(String(metadata.cwd || '')) !== path.resolve(specification.cwd) ||
        Number(metadata.timeout_ms) !== Number(specification.timeout_ms)) {
      throw new Error(`task metadata differs from the immutable approved execution plan for ${task.task_id}`);
    }
    const proposal = this.getCurrentProposal(task.job_id);
    if (!proposal?.payload || typeof proposal.payload.workspace !== 'string' || !proposal.payload.workspace) {
      throw new Error(`approved proposal workspace is missing for immutable plan ${task.job_id}`);
    }
    this.assertApprovalCurrent(task.job_id);
    const recompiled = this.compileExecutionPlan(task.job_id, { workspace: proposal.payload.workspace });
    if (!recompiled || recompiled.plan_hash !== plan.plan_hash) {
      throw new Error(`immutable execution plan differs from the current approved proposal: ${task.job_id}`);
    }
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const approvedCommand = [specification.executable, ...specification.args].map(quote).join(' ');
    if (command !== approvedCommand || path.resolve(String(cwd || '')) !== path.resolve(specification.cwd)) {
      throw new Error(`requested command or working directory differs from the immutable approved plan for ${task.task_id}`);
    }
    return specification;
  }

  prepareExecutionForBatchClaim(taskId, execution, batchClaim) {
    const batchId = batchClaim?.batchId;
    const itemId = batchClaim?.itemId;
    const batchAttempt = batchClaim?.batchAttempt;
    const itemAttempt = batchClaim?.itemAttempt;
    if (typeof taskId !== 'string' || !taskId || typeof batchId !== 'string' || !batchId ||
        typeof itemId !== 'string' || !itemId || typeof batchAttempt !== 'number' || typeof itemAttempt !== 'number' ||
        !Number.isSafeInteger(batchAttempt) || batchAttempt < 1 ||
        !Number.isSafeInteger(itemAttempt) || itemAttempt < 1 || !execution || typeof execution !== 'object' || Array.isArray(execution)) {
      throw new Error('batch execution preparation requires exact task, batch, item, and attempt identity');
    }
    const claimLost = reason => {
      const error = new Error(`execution batch claim lost before durable task preparation: ${batchId}/${itemId}/${itemAttempt}; ${reason}`);
      error.code = 'ERR_EXECUTION_BATCH_CLAIM_LOST';
      return error;
    };
    this.db.exec('SAVEPOINT prepare_execution_for_batch_claim');
    try {
      // Reserve the same durable batch row used by claim recovery/cancellation
      // before checking the item. This writer reservation and prepareExecution's
      // task/attempt/event transition commit under one outer savepoint. Recovery
      // can therefore win before preparation or observe the prepared task after
      // it, but cannot terminalize the unstarted claim in between those states.
      const reserve = this.db.prepare(`UPDATE execution_batches SET status=status
        WHERE batch_id=? AND attempt=? AND status IN ('RUNNING','WAITING')
          AND EXISTS (SELECT 1 FROM jobs j WHERE j.job_id=execution_batches.job_id AND j.status='active' AND j.state='EXECUTING')`)
        .run(batchId, batchAttempt);
      if (reserve.changes !== 1) throw claimLost('batch is terminal or its attempt changed');
      const item = this.db.prepare(`SELECT task_id,command,status,attempt FROM execution_batch_items
        WHERE batch_id=? AND item_id=?`).get(batchId, itemId);
      if (!item || item.task_id !== taskId || item.command !== execution.command || item.status !== 'RUNNING' ||
          typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt !== itemAttempt ||
          itemAttempt !== batchAttempt) {
        throw claimLost('item ownership/command/status/attempt no longer matches');
      }
      const prepared = this.prepareExecution(taskId, {
        ...execution,
        batchClaim: { batchId, itemId, batchAttempt, itemAttempt }
      });
      const persistedItem = this.db.prepare(`SELECT task_id,status,attempt FROM execution_batch_items
        WHERE batch_id=? AND item_id=?`).get(batchId, itemId);
      const persistedTask = this.getTask(taskId);
      if (!persistedItem || persistedItem.task_id !== taskId || persistedItem.status !== 'RUNNING' ||
          typeof persistedItem.attempt !== 'number' || persistedItem.attempt !== itemAttempt || persistedTask?.execution_status !== 'running' ||
          persistedTask.execution_session_id !== execution.executionSessionId ||
          typeof persistedTask.execution_attempt !== 'number' || persistedTask.execution_attempt !== execution.attempt) {
        throw new Error(`atomic batch/task preparation readback mismatch: ${batchId}/${itemId}/${itemAttempt}`);
      }
      this.db.exec('RELEASE SAVEPOINT prepare_execution_for_batch_claim');
      return prepared;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT prepare_execution_for_batch_claim'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT prepare_execution_for_batch_claim'); } catch {}
      throw error;
    }
  }

  prepareExecution(taskId, { executionSessionId, attempt, command, cwd = null, startedAt = now(), tmuxName = null, boundaryIdentity = null, batchClaim = null } = {}) {
    if (typeof taskId !== 'string' || !taskId || typeof executionSessionId !== 'string' || !executionSessionId ||
        typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 || typeof command !== 'string' || !command.trim()) {
      throw new Error('execution start requires exact task/session/attempt/command identity');
    }
    const requestedAttempt = attempt;
    if (batchClaim !== null && (!batchClaim || typeof batchClaim !== 'object' || Array.isArray(batchClaim) ||
        typeof batchClaim.batchId !== 'string' || !batchClaim.batchId ||
        typeof batchClaim.itemId !== 'string' || !batchClaim.itemId ||
        !Number.isSafeInteger(batchClaim.batchAttempt) || batchClaim.batchAttempt < 1 ||
        !Number.isSafeInteger(batchClaim.itemAttempt) || batchClaim.itemAttempt < 1 ||
        batchClaim.batchAttempt !== batchClaim.itemAttempt)) {
      throw new Error('execution start batch claim must bind exact batch/item and equal positive attempts');
    }
    const leaseBound = Boolean(boundaryIdentity?.lease?.lease_id);
    this.db.exec('SAVEPOINT prepare_execution_transition');
    try {
      // Acquire the writer reservation before trusting task state or opening an
      // attempt. A duplicate/stale caller must not overwrite a newer session.
      const claim = this.db.prepare("UPDATE tasks SET updated_at=updated_at WHERE task_id=? AND execution_status IS NOT 'running' AND (COALESCE(execution_attempt,0) < ? OR (?=1 AND COALESCE(execution_attempt,0)=?))")
        .run(taskId, requestedAttempt, leaseBound ? 1 : 0, requestedAttempt);
      if (claim.changes !== 1) throw new Error(`execution start lost task/session/attempt ownership: ${taskId}`);
      const task = this.getTask(taskId);
      if (leaseBound) {
        const leaseIdentity = boundaryIdentity.lease;
        const lease = this.db.prepare('SELECT * FROM task_leases WHERE lease_id=?').get(String(leaseIdentity.lease_id));
        if (!lease || lease.state !== 'ACTIVE' || lease.task_id !== taskId || lease.job_id !== task?.job_id ||
            lease.worker_id !== leaseIdentity.worker_id || typeof lease.owner_epoch !== 'number' ||
            lease.owner_epoch !== leaseIdentity.owner_epoch || typeof lease.attempt !== 'number' ||
            lease.attempt !== requestedAttempt || Date.parse(lease.expires_at) <= Date.now() ||
            typeof task?.execution_attempt !== 'number' || task.execution_attempt !== requestedAttempt) {
          throw new Error(`execution prepare lost the exact active lease owner/epoch/attempt fence: ${taskId}`);
        }
      }
      const durableAttempt = task?.execution_attempt == null ? 0 : task.execution_attempt;
      if (!task || typeof durableAttempt !== 'number' || !Number.isSafeInteger(durableAttempt) || durableAttempt < 0 ||
          task.execution_status === 'running' ||
          (requestedAttempt <= durableAttempt && !(leaseBound && requestedAttempt === durableAttempt))) {
        throw new Error(`execution start identity is stale or task is already executing: ${taskId}`);
      }
      if (task.status === 'completed' || task.execution_status === 'completed') {
        throw new Error(`cannot reopen a successfully completed task for a new execution attempt: ${taskId}`);
      }
      if (!['pending', 'running', 'failed'].includes(task.status)) {
        throw new Error(`cannot start execution for terminal task state=${task.status}: ${taskId}`);
      }
      if (boundaryIdentity !== null) {
        if (!boundaryIdentity || typeof boundaryIdentity !== 'object' || Array.isArray(boundaryIdentity) ||
            boundaryIdentity.schema_version !== 1 || boundaryIdentity.task_id !== taskId ||
            typeof boundaryIdentity.attempt !== 'number' || boundaryIdentity.attempt !== requestedAttempt || boundaryIdentity.command !== command ||
            boundaryIdentity.cwd?.requested !== path.resolve(String(cwd || '')) ||
            !/^[a-f0-9]{64}$/.test(String(boundaryIdentity.environment_sha256 || '')) ||
            !/^[a-f0-9]{64}$/.test(String(boundaryIdentity.executable?.sha256 || '')) ||
            !/^[a-f0-9]{64}$/.test(String(boundaryIdentity.tmux?.sha256 || ''))) {
          throw new Error(`execution OS-boundary identity is malformed or detached from task/attempt/command/cwd: ${taskId}`);
        }
      }
      if (task.status === 'failed' && task.execution_status && !['failed', 'timeout'].includes(task.execution_status)) {
        throw new Error(`cannot retry execution from contradictory task/execution states=${task.status}/${task.execution_status}: ${taskId}`);
      }
      // Re-check approval, proposal, source-derived plan and exact requested
      // command under the same writer reservation that inserts the attempt and
      // execution.started event. Preflight checks outside this transaction can
      // race with approval revocation or task metadata substitution.
      this.assertPreparedExecutionPlan(task, { command, cwd });
      const openAttempts = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started'").all(taskId);
      if (openAttempts.length !== 0) throw new Error(`execution start requires no pre-existing open attempt: ${taskId}`);
      const metadata = { ...(parseStrictJson(task.metadata_json || '{}')), command, cwd, tmuxName,
        ...(boundaryIdentity ? { execution_boundary_identity: boundaryIdentity } : {}) };
      // A later non-batch execution must not inherit a stale batch claim from a
      // previous attempt; batch recovery relies on this exact latest-attempt tag.
      delete metadata.execution_batch_claim;
      if (batchClaim) metadata.execution_batch_claim = batchClaim;
      const startedAtValue = String(startedAt || now());
      const attemptId = id('attempt');
      const updated = this.db.prepare(`UPDATE tasks SET status='running', execution_session_id = ?, execution_status = 'running', execution_attempt = ?, execution_pid = NULL,
        execution_exit_code = NULL, execution_started_at = ?, execution_finished_at = NULL, execution_stdout = '', execution_stderr = ?, metadata_json = ?, updated_at = ?
        WHERE task_id = ? AND status=? AND execution_session_id IS ? AND COALESCE(execution_attempt,0)=COALESCE(?,0) AND execution_status IS ?`)
        .run(executionSessionId, requestedAttempt, startedAtValue, '', JSON.stringify(metadata), startedAtValue,
          taskId, task.status, task.execution_session_id ?? null, task.execution_attempt ?? 0, task.execution_status ?? null);
      if (updated.changes !== 1) throw new Error(`execution start lost task compare-and-set: ${taskId}`);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_START_TASK_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', NULL, ?)")
        .run(attemptId, taskId, startedAtValue);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_START_ATTEMPT_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const eventPayload = { taskId, executionSessionId, attempt: requestedAttempt, attemptId, command, cwd, tmuxName,
        ...(batchClaim ? { executionBatchClaim: batchClaim } : {}),
        ...(boundaryIdentity ? { executionBoundaryIdentity: boundaryIdentity } : {}) };
      const dedupeKey = `${taskId}|execution|${requestedAttempt}`;
      const startedEventId = this.recordEvent(task.job_id, 'execution.started', eventPayload, dedupeKey);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_START_EVENT_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const persistedEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(startedEventId);
      const persistedTask = this.getTask(taskId);
      const persistedAttempt = this.db.prepare('SELECT attempt_id,task_id,status,started_at FROM attempts WHERE attempt_id=?').get(attemptId);
      if (!persistedEvent || persistedEvent.event_id !== eventId(task.job_id, 'execution.started', dedupeKey) ||
          persistedEvent.job_id !== task.job_id || persistedEvent.type !== 'execution.started' ||
          persistedEvent.payload_json !== JSON.stringify(eventPayload) || persistedTask?.execution_session_id !== executionSessionId ||
          typeof persistedTask.execution_attempt !== 'number' || persistedTask.execution_attempt !== requestedAttempt ||
          persistedTask.execution_status !== 'running' || persistedTask.status !== 'running' ||
          persistedAttempt?.task_id !== taskId || persistedAttempt.status !== 'started' || persistedAttempt.started_at !== startedAtValue) {
        throw new Error(`execution start durable readback does not bind task/session/attempt/event: ${taskId}`);
      }
      this.db.exec('RELEASE SAVEPOINT prepare_execution_transition');
      return persistedTask;
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT prepare_execution_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT prepare_execution_transition'); } catch {}
      throw failure;
    }
  }
  setExecutionPid(taskId, pid, { executionSessionId, attempt } = {}) {
    if (typeof taskId !== 'string' || !taskId || typeof executionSessionId !== 'string' || !executionSessionId ||
        typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 ||
        typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) {
      throw new Error('execution PID persistence requires exact task/session/attempt and positive safe PID');
    }
    const ts = now();
    const changed = this.db.prepare(`UPDATE tasks SET execution_pid=?,updated_at=?
      WHERE task_id=? AND execution_session_id=? AND execution_attempt=? AND execution_status='running' AND status='running'`)
      .run(pid, ts, taskId, executionSessionId, attempt);
    if (changed.changes !== 1) throw new Error(`execution PID persistence lost task/session/attempt ownership: ${taskId}/${executionSessionId}/${attempt}`);
    const persisted = this.getTask(taskId);
    if (!persisted || persisted.execution_session_id !== executionSessionId || typeof persisted.execution_attempt !== 'number' ||
        persisted.execution_attempt !== attempt ||
        persisted.execution_status !== 'running' || persisted.status !== 'running' || Number(persisted.execution_pid) !== pid) {
      throw new Error(`execution PID persistence readback mismatch: ${taskId}/${executionSessionId}/${attempt}`);
    }
    return persisted;
  }
  finishExecution(taskId, { executionSessionId, attempt, command, exitCode = null, stdout = '', stderr = '', status = 'failed', error = null } = {}) {
    const requestedAttempt = attempt;
    if (!taskId || typeof executionSessionId !== 'string' || !executionSessionId ||
        typeof requestedAttempt !== 'number' || !Number.isSafeInteger(requestedAttempt) || requestedAttempt < 1 || typeof command !== 'string' || !command.trim()) {
      throw new Error('execution completion requires exact task/session/attempt/command identity');
    }
    if (!['completed', 'failed', 'timeout', 'cancelled'].includes(status)) throw new Error(`invalid execution completion status: ${String(status)}`);
    if (exitCode !== null && exitCode !== undefined &&
        (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || Object.is(exitCode, -0))) {
      throw new Error('execution completion exit code must be a canonical safe integer or null');
    }
    // The status is durable authority used by recovery and downstream callers.
    // Never allow a caller to publish execution.completed when the process did
    // not provide the exact success signal; outcome='failure' alone is not
    // sufficient because event/attempt status are derived from `status`.
    if (status === 'completed' && exitCode !== 0) {
      throw new Error('completed execution requires exact numeric exit code 0');
    }
    if (status === 'completed' && error !== null) {
      throw new Error('completed execution cannot carry a terminal error');
    }
    if (status === 'failed' && exitCode === 0 && (typeof error !== 'string' || !error.trim())) {
      throw new Error('failed execution with exit code 0 requires an explicit failure reason');
    }
    if (typeof stdout !== 'string' || typeof stderr !== 'string' || (error !== null && typeof error !== 'string')) {
      throw new Error('execution completion stdout/stderr/error fields must use exact string types');
    }
    let terminal = status;
    let normalizedExitCode = exitCode == null ? null : exitCode;
    let effectiveStdout = stdout;
    let effectiveStderr = stderr;
    let effectiveError = error;
    let outcome = terminal === 'completed' && normalizedExitCode === 0 ? 'success' : 'failure';
    const initial = this.getTask(taskId);
    if (!initial) throw new Error(`task not found: ${taskId}`);
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_FINISH_EXECUTION_BARRIER_DIR) {
      const barrierDir = path.resolve(process.env.CHAT_ON_STEROIDS_TEST_FINISH_EXECUTION_BARRIER_DIR);
      const readyPath = path.join(barrierDir, `${process.pid}.ready`);
      const releasePath = path.join(barrierDir, 'release');
      if (!fs.existsSync(readyPath)) fs.writeFileSync(readyPath, String(taskId), { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(releasePath)) {
        if (Date.now() >= deadline) throw new Error('test finish-execution barrier timed out before writer transaction');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    this.db.exec('SAVEPOINT finish_execution_transition');
    try {
      // Reserve SQLite's writer lock, then re-read the execution identity. A
      // late/retried collector may not finish an overwritten session or newer
      // attempt and must not publish rows based on stale preflight state.
      const lock = this.db.prepare("UPDATE tasks SET updated_at=updated_at WHERE task_id=? AND execution_session_id=? AND execution_attempt=? AND execution_status IN ('running','completed','failed','timeout','cancelled')")
        .run(taskId, executionSessionId, requestedAttempt);
      if (lock.changes !== 1) throw new Error(`execution completion lost task/session/attempt ownership: ${taskId}`);
      const task = this.getTask(taskId);
      if (!task || task.job_id !== initial.job_id || task.execution_session_id !== executionSessionId ||
          typeof task.execution_attempt !== 'number' || !Number.isSafeInteger(task.execution_attempt) ||
          task.execution_attempt !== requestedAttempt || !['running','completed','failed','timeout','cancelled'].includes(task.execution_status)) {
        throw new Error(`execution completion task identity changed during persistence: ${taskId}`);
      }
      const startDedupeKey = `${taskId}|execution|${requestedAttempt}`;
      const startEventId = eventId(task.job_id, 'execution.started', startDedupeKey);
      const startEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE event_id=?').get(startEventId);
      let startPayload;
      try { startPayload = parseStrictJson(startEvent?.payload_json || ''); }
      catch { throw new Error(`execution completion has no canonical durable start event: ${taskId}`); }
      const startRows = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?")
        .all(task.job_id, taskId, requestedAttempt);
      const startKeys = Object.keys(startPayload).sort().join(',');
      const metadata = parseStrictJson(task.metadata_json || '{}');
      // A start-time lease check is not a completion fence. A lease can expire
      // or be replaced while the OS process is still running, so revalidate the
      // exact owner/epoch under this transaction's SQLite writer reservation
      // before accepting any result, artifact, or terminal event. A heartbeat
      // may renew expires_at, therefore identity binds lease/worker/epoch/attempt
      // while the current durable expiry must independently still be in future.
      const boundaryLease = metadata.execution_boundary_identity?.lease;
      if (task.execution_status === 'running' && boundaryLease?.lease_id) {
        const durableLease = this.db.prepare(`SELECT lease_id,task_id,job_id,attempt,worker_id,owner_epoch,state,expires_at
          FROM task_leases WHERE lease_id=?`).get(boundaryLease.lease_id);
        const leaseExpiry = Date.parse(durableLease?.expires_at || '');
        const leaseStillOwnsExecution = task.status === 'running' && boundaryLease.state === 'ACTIVE' &&
            durableLease && durableLease.state === 'ACTIVE' && durableLease.task_id === taskId &&
            durableLease.job_id === task.job_id && durableLease.worker_id === boundaryLease.worker_id &&
            typeof boundaryLease.attempt === 'number' && Number.isSafeInteger(boundaryLease.attempt) && boundaryLease.attempt === requestedAttempt &&
            typeof boundaryLease.owner_epoch === 'number' && Number.isSafeInteger(boundaryLease.owner_epoch) && boundaryLease.owner_epoch > 0 &&
            typeof durableLease.attempt === 'number' && durableLease.attempt === requestedAttempt &&
            typeof durableLease.owner_epoch === 'number' && durableLease.owner_epoch === boundaryLease.owner_epoch &&
            Number.isFinite(leaseExpiry) && leaseExpiry > Date.now();
        if (!leaseStillOwnsExecution) {
          // A stale local process may have completed work after its lease was
          // expired/replaced. Never publish its stdout or success result. Close
          // this exact in-flight attempt as a durable failure so it cannot stay
          // permanently EXECUTING; retries still need a new monotonic attempt.
          const leaseLostError = `execution lease lost before completion persistence; stale process output discarded for attempt ${requestedAttempt}`;
          terminal = 'failed';
          normalizedExitCode = null;
          effectiveStdout = '';
          effectiveStderr = leaseLostError;
          effectiveError = leaseLostError;
          outcome = 'failure';
        }
      }
      const expectedStartKeys = [
        'attempt', 'attemptId', 'command', 'cwd',
        ...(metadata.execution_batch_claim ? ['executionBatchClaim'] : []),
        ...(metadata.execution_boundary_identity ? ['executionBoundaryIdentity'] : []),
        'executionSessionId', 'taskId', 'tmuxName'
      ].sort().join(',');
      if (!startEvent || startEvent.event_id !== startEventId || startEvent.job_id !== task.job_id || startEvent.type !== 'execution.started' ||
          startRows.length !== 1 || startPayload.taskId !== taskId || startPayload.executionSessionId !== executionSessionId ||
          typeof startPayload.attempt !== 'number' || startPayload.attempt !== requestedAttempt || typeof startPayload.attemptId !== 'string' || !startPayload.attemptId ||
          startEvent.payload_json !== JSON.stringify(startPayload) ||
          startPayload.command !== command || metadata.command !== command || (metadata.cwd ?? null) !== (startPayload.cwd ?? null) ||
          startKeys !== expectedStartKeys ||
          (metadata.execution_batch_claim
            ? canonicalJson(metadata.execution_batch_claim) !== canonicalJson(startPayload.executionBatchClaim)
            : Object.hasOwn(startPayload, 'executionBatchClaim')) ||
          (metadata.execution_boundary_identity && canonicalJson(metadata.execution_boundary_identity) !== canonicalJson(startPayload.executionBoundaryIdentity))) {
        throw new Error(`execution completion start-event/task/session/attempt binding is invalid or non-canonical: ${taskId}`);
      }
      const openAttempts = this.db.prepare("SELECT attempt_id, status, started_at FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC, rowid DESC")
        .all(taskId);
      const durableAttempt = this.db.prepare('SELECT attempt_id,task_id,status,started_at,finished_at,error FROM attempts WHERE attempt_id=? AND task_id=?')
        .get(startPayload.attemptId, taskId);
      if (!durableAttempt || durableAttempt.attempt_id !== startPayload.attemptId ||
          !Number.isFinite(Date.parse(durableAttempt.started_at)) || !Number.isFinite(Date.parse(startEvent.created_at)) ||
          Date.parse(durableAttempt.started_at) > Date.parse(startEvent.created_at)) {
        throw new Error(`execution completion has no exact durable attempt from its start event: ${taskId}`);
      }

      const evidence = executionEvidenceContent({ taskId, executionSessionId, attempt: requestedAttempt, command,
        exitCode: normalizedExitCode, status: terminal, stdout: effectiveStdout, stderr: effectiveStderr, error: effectiveError });
      const currentTaskStatus = task.execution_status;
      if (currentTaskStatus !== 'running') {
        const expectedTaskStatus = outcome === 'success' ? 'completed' : terminal === 'cancelled' ? 'cancelled' : 'failed';
        const expectedAttemptStatus = terminal === 'completed' ? 'completed' : terminal === 'timeout' ? 'timeout' : terminal === 'cancelled' ? 'cancelled' : 'failed';
        const expectedEventType = terminal === 'completed' ? 'execution.completed' : terminal === 'cancelled' ? 'execution.cancelled' : 'execution.failed';
        const dedupeKey = `${taskId}|execution-result|${requestedAttempt}`;
        const terminalEventId = eventId(task.job_id, expectedEventType, dedupeKey);
        const terminalEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE event_id=?').get(terminalEventId);
        let terminalPayload = null;
        try { terminalPayload = parseStrictJson(terminalEvent?.payload_json || ''); } catch {}
        const matchingTerminalEvents = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type IN ('execution.completed','execution.failed','execution.cancelled') AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?")
          .all(task.job_id, taskId, requestedAttempt);
        const priorResult = terminalPayload?.resultId
          ? this.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=?').get(terminalPayload.resultId)
          : null;
        const expectedAttemptError = effectiveError || (normalizedExitCode !== 0 ? `exit status ${normalizedExitCode}` : null);
        const exactTerminalPayload = terminalPayload && terminalPayload.taskId === taskId &&
          terminalPayload.executionSessionId === executionSessionId && typeof terminalPayload.attempt === 'number' && terminalPayload.attempt === requestedAttempt &&
          terminalPayload.attemptId === durableAttempt.attempt_id && terminalPayload.command === command &&
          terminalPayload.exitCode === normalizedExitCode && terminalPayload.status === terminal &&
          typeof terminalPayload.resultId === 'string' && Object.keys(terminalPayload).sort().join(',') ===
            'attempt,attemptId,command,executionSessionId,exitCode,resultId,status,taskId';
        const taskExitMatches = task.execution_exit_code === normalizedExitCode;
        if (task.execution_status !== terminal || task.status !== expectedTaskStatus || !taskExitMatches ||
            (task.execution_stdout || '') !== effectiveStdout || (task.execution_stderr || '') !== effectiveStderr ||
            durableAttempt.status !== expectedAttemptStatus || !durableAttempt.finished_at || durableAttempt.error !== expectedAttemptError ||
            openAttempts.length !== 0 || matchingTerminalEvents.length !== 1 || !terminalEvent ||
            terminalEvent.event_id !== terminalEventId || terminalEvent.job_id !== task.job_id || terminalEvent.type !== expectedEventType ||
            terminalEvent.payload_json !== JSON.stringify(terminalPayload) || !exactTerminalPayload ||
            !priorResult || priorResult.result_id !== terminalPayload.resultId || priorResult.task_id !== taskId ||
            priorResult.outcome !== outcome || priorResult.content !== evidence) {
          throw new Error(`execution completion retry conflicts with the exact durable result/session/attempt/terminal state: ${taskId}`);
        }
        if (outcome === 'success') {
          const plan = this.getExecutionPlan(task.job_id);
          const workflowId = String(plan?.workflow_id || '').toLowerCase();
          const role = String(task.role || '').toLowerCase();
          const plannedTask = plan?.children?.find(item => item.id === metadata.workflow_plan_task_id);
          const artifactType = workflowId === 'hybrid-engineering' && plannedTask?.execution?.deterministic === true
            ? plannedTask.execution.output_artifact_type
            : workflowId === 'production' && ['architect','qa'].includes(role)
            ? getAgentArtifactType(task.role)
            : workflowId === 'engineering' && role === 'engineer' ? 'implementation'
              : workflowId === 'engineering' ? ({ security: 'security-review', qa: 'qa-report', platform: 'platform-review', writer: 'documentation' })[role]
                : null;
          if (artifactType) {
            const artifact = this.getArtifact(`${artifactType}-${priorResult.result_id}`);
            const eventIdValue = eventId(task.job_id, 'artifact.created', artifact?.artifact_id || `${artifactType}-${priorResult.result_id}`);
            const artifactEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
            const activeCount = this.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=? AND task_id=? AND status='active'").get(task.job_id, taskId).n;
            if (!artifact || artifact.job_id !== task.job_id || artifact.task_id !== taskId || artifact.type !== artifactType ||
                artifact.status !== 'active' || artifact.evidence.filter(ref => ref === priorResult.result_id).length !== 1 ||
                activeCount !== 1 || !artifactEvent || artifactEvent.job_id !== task.job_id || artifactEvent.type !== 'artifact.created') {
              throw new Error(`execution completion retry lacks its exact active typed artifact lineage: ${taskId}`);
            }
            const artifactPayload = parseStrictJson(artifactEvent.payload_json);
            if (artifactPayload.artifactId !== artifact.artifact_id || artifactPayload.taskId !== taskId ||
                artifactPayload.type !== artifactType || artifactPayload.status !== 'active' || artifactPayload.contentHash !== artifact.content_hash ||
                (artifactPayload.supersedes ?? null) !== (artifact.supersedes ?? null) ||
                Object.keys(artifactPayload).sort().join(',') !== 'artifactId,contentHash,status,supersedes,taskId,type') {
              throw new Error(`execution completion retry artifact event does not bind its exact bytes: ${taskId}`);
            }
          }
        }
        this.db.exec('RELEASE SAVEPOINT finish_execution_transition');
        return task;
      }
      if (openAttempts.length !== 1 || openAttempts[0].attempt_id !== durableAttempt.attempt_id || durableAttempt.status !== 'started') {
        throw new Error(`execution completion requires exactly its own open durable attempt: ${taskId}`);
      }

      const ts = now();
      const resultId = id('result');
      this.db.prepare('INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(resultId, taskId, outcome, evidence, ts);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_RESULT_INSERT === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }

      const planForExecution = this.getExecutionPlan(task.job_id);
      const workflowId = String(planForExecution?.workflow_id || '').toLowerCase();
      const engineeringWorkflow = workflowId === 'engineering';
      const productionWorkflow = workflowId === 'production';
      const hybridWorkflow = workflowId === 'hybrid-engineering';
      if (outcome === 'success' && engineeringWorkflow && String(task.role || '').toLowerCase() === 'engineer') {
        this.createArtifact({
          artifact_id: `implementation-${resultId}`, job_id: task.job_id, task_id: task.task_id,
          type: 'implementation', producer_role: 'engineer',
          content: {
            summary: 'Engineer implementation completed with verified execution evidence.',
            files_changed: [], verification: [resultId],
            execution: { session_id: executionSessionId, exit_code: normalizedExitCode, command, verified_at: ts }
          },
          evidence: [resultId, executionSessionId]
        });
      }
      const specialistTypes = Object.freeze({ security: 'security-review', qa: 'qa-report', platform: 'platform-review', writer: 'documentation' });
      const specialistType = specialistTypes[String(task.role || '').toLowerCase()];
      if (outcome === 'success' && engineeringWorkflow && specialistType) {
        const implementation = this.getLatestArtifact(task.job_id, 'implementation');
        if (!implementation || implementation.status !== 'active') throw new Error(`cannot persist ${specialistType}: implementation artifact is missing`);
        const contentByType = {
          'security-review': { threats: [], findings: [evidence], decision: 'accept' },
          'qa-report': { checks: ['execution completed'], results: [evidence], decision: 'accept' },
          'platform-review': { runtime: { status: 'reviewed' }, deployment: { status: 'reviewed' }, recovery: { status: 'reviewed' } },
          documentation: { summary: 'Documentation review completed.', user_facing_changes: [], verification: [evidence] }
        };
        this.createArtifact({
          artifact_id: `${specialistType}-${resultId}`, job_id: task.job_id, task_id: task.task_id,
          type: specialistType, producer_role: task.role, content: contentByType[specialistType],
          evidence: [resultId, implementation.artifact_id]
        });
      }
      // Hybrid deterministic tasks publish a typed artifact only after the
      // approved ExecutionManager command succeeds. Keep it in the same SQLite
      // savepoint as result/session/attempt/completion evidence so recovery can
      // validate the exact result -> artifact -> terminal-event lineage.
      if (outcome === 'success' && hybridWorkflow) {
        const plannedTask = planForExecution?.children?.find(item => item.id === metadata.workflow_plan_task_id);
        const artifactType = plannedTask?.execution?.deterministic === true
          ? plannedTask.execution.output_artifact_type
          : null;
        if (artifactType) {
          const existingArtifact = this.db.prepare("SELECT artifact_id FROM artifacts WHERE job_id=? AND task_id=? AND kind=? AND status='active'")
            .get(task.job_id, taskId, artifactType);
          if (existingArtifact) throw new Error(`hybrid execution already has an active ${artifactType} artifact before its terminal result`);
          let artifactContent;
          if (artifactType === 'documentation') {
            artifactContent = {
              summary: `Deterministic local check completed: ${command}`,
              user_facing_changes: [],
              verification: [`execution_session_id=${executionSessionId}`, `exit_code=${normalizedExitCode}`, evidence]
            };
          } else {
            throw new Error(`hybrid deterministic task has unsupported typed output artifact: ${artifactType}`);
          }
          this.createArtifact({
            artifact_id: `${artifactType}-${resultId}`, job_id: task.job_id, task_id: taskId,
            type: artifactType, producer_role: task.role, content: artifactContent,
            evidence: [resultId, executionSessionId]
          });
        }
      }
      // Production syntax-check tasks used to create their typed artifact in a
      // second server/index.js write, after execution.completed. Persist it here
      // before the terminal execution event so result -> artifact -> completion
      // has one transactional, timestamp-ordered lineage.
      if (outcome === 'success' && productionWorkflow && ['architect', 'qa'].includes(String(task.role || '').toLowerCase())) {
        const artifactType = getAgentArtifactType(task.role);
        const existingArtifact = this.db.prepare("SELECT artifact_id FROM artifacts WHERE job_id=? AND task_id=? AND kind=? AND status='active'")
          .get(task.job_id, task.task_id, artifactType);
        if (existingArtifact) throw new Error(`production execution already has an active ${artifactType} artifact before its terminal result`);
        const syntaxOnlyQa = Array.isArray(metadata.args) && metadata.args.includes('--check');
        const productionQaAssessment = artifactType === 'qa-report'
          ? assessProductionQaExecution({
            plan: planForExecution,
            taskPlanId: metadata.workflow_plan_task_id,
            metadata,
            stdout: effectiveStdout
          })
          : null;
        const artifactContent = artifactType === 'architecture' ? {
          components: [`Static syntax check executed: ${command}`],
          interfaces: ['Local Node.js syntax-check interface'],
          failure_modes: ['Syntax validation does not establish runtime correctness.'],
          implementation_boundary: 'This artifact records the exact static check only; it does not claim a broader architecture review.'
        } : {
          checks: [command, ...(productionQaAssessment?.required_markers || [])],
          results: [
            `execution_scope=${syntaxOnlyQa ? 'static-syntax-only' : productionQaAssessment?.trusted ? 'packaged-behavioral-e2e' : 'command-executed'}`,
            `exit_code=${normalizedExitCode}`,
            `execution_session_id=${executionSessionId || 'unavailable'}`,
            ...(productionQaAssessment?.observed_markers || []).map(marker => `pass_marker=${marker}`),
            ...(productionQaAssessment?.missing_markers || []).map(marker => `missing_marker=${marker}`)
          ],
          // A syntax check proves only that the file parses. It is not a QA
          // acceptance signal for a production workflow.
          decision: syntaxOnlyQa || (artifactType === 'qa-report' && productionQaAssessment?.passed !== true)
            ? 'needs_changes'
            : 'accept'
        };
        this.createArtifact({
          artifact_id: `${artifactType}-${resultId}`, job_id: task.job_id, task_id: task.task_id,
          type: artifactType, producer_role: task.role, content: artifactContent,
          evidence: [resultId, executionSessionId]
        });
      }

      const nextTaskStatus = outcome === 'success' ? 'completed' : terminal === 'cancelled' ? 'cancelled' : 'failed';
      const taskUpdate = this.db.prepare(`UPDATE tasks SET execution_status=?, execution_exit_code=?, execution_finished_at=?, execution_stdout=?, execution_stderr=?,
        status=?, updated_at=? WHERE task_id=? AND execution_session_id=? AND execution_attempt=? AND execution_status='running'`)
        .run(terminal, normalizedExitCode, ts, effectiveStdout, effectiveStderr, nextTaskStatus, ts, taskId, executionSessionId, requestedAttempt);
      if (taskUpdate.changes !== 1) throw new Error(`execution completion lost task compare-and-set at terminal update: ${taskId}`);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_TASK_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const attemptStatus = terminal === 'completed' ? 'completed' : terminal === 'timeout' ? 'timeout' : terminal === 'cancelled' ? 'cancelled' : 'failed';
      const attemptUpdate = this.db.prepare("UPDATE attempts SET status=?, finished_at=?, error=? WHERE attempt_id=? AND task_id=? AND status='started'")
        .run(attemptStatus, ts, effectiveError || (normalizedExitCode !== 0 ? `exit status ${normalizedExitCode}` : null), durableAttempt.attempt_id, taskId);
      if (attemptUpdate.changes !== 1) throw new Error(`execution completion could not settle its exact attempt row: ${taskId}`);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_EXECUTION_ATTEMPT_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const eventType = terminal === 'completed' ? 'execution.completed' : terminal === 'cancelled' ? 'execution.cancelled' : 'execution.failed';
      const eventPayload = { taskId, executionSessionId, attempt: requestedAttempt, attemptId: durableAttempt.attempt_id, command, exitCode: normalizedExitCode, status: terminal, resultId };
      const eventDedupeKey = `${taskId}|execution-result|${requestedAttempt}`;
      const eventIdValue = this.recordEvent(task.job_id, eventType, eventPayload, eventDedupeKey);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const eventRows = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type IN ('execution.completed','execution.failed','execution.cancelled') AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?")
        .all(task.job_id, taskId, requestedAttempt);
      if (eventRows.length !== 1 || !event || event.event_id !== eventId(task.job_id, eventType, eventDedupeKey) ||
          event.job_id !== task.job_id || event.type !== eventType || event.payload_json !== JSON.stringify(eventPayload)) {
        throw new Error('execution completion event does not exactly bind result/session/attempt/status');
      }
      const persistedResult = this.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=?').get(resultId);
      const finishedTask = this.getTask(taskId);
      if (!persistedResult || persistedResult.task_id !== taskId || persistedResult.outcome !== outcome || persistedResult.content !== evidence ||
          finishedTask?.execution_session_id !== executionSessionId || typeof finishedTask.execution_attempt !== 'number' || finishedTask.execution_attempt !== requestedAttempt ||
          finishedTask.execution_status !== terminal ||
          finishedTask.execution_exit_code !== normalizedExitCode ||
          finishedTask.status !== nextTaskStatus) {
        throw new Error('execution completion durable readback conflicts with its exact task/result state');
      }
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_BEFORE_EXECUTION_SAVEPOINT_RELEASE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      this.db.exec('RELEASE SAVEPOINT finish_execution_transition');
      return finishedTask;
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT finish_execution_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT finish_execution_transition'); } catch {}
      throw failure;
    }
  }
  getSession(sessionId) { return this.db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sessionId) || null; }
  getSessionByOpenClawKey(sessionKey) { return this.db.prepare('SELECT * FROM agent_sessions WHERE openclaw_session_key = ?').get(sessionKey) || null; }
  getSessionByTask(taskId) { return this.db.prepare('SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId) || null; }
  createAgentSession(taskId, { sessionKey, role = null, parentSessionKey = null, attempt = 1, state = 'CREATED', currentTurnId = null } = {}) {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('taskId must be a non-empty string');
    if (typeof sessionKey !== 'string' || !sessionKey.trim()) throw new Error('openclaw session key must be a non-empty string');
    if (role !== null && role !== undefined && (typeof role !== 'string' || !role.trim())) throw new Error('session role must be a non-empty string or null');
    if (parentSessionKey !== null && parentSessionKey !== undefined && (typeof parentSessionKey !== 'string' || !parentSessionKey.trim())) {
      throw new Error('parentSessionKey must be a non-empty string or null');
    }
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('session attempt must be a positive safe integer');
    if (typeof state !== 'string' || !['CREATED', 'ACTIVE', 'PAUSED', 'STALE', 'FAILED', 'TERMINATED'].includes(state)) {
      throw new Error('invalid agent session state');
    }
    if (currentTurnId !== null && currentTurnId !== undefined && (typeof currentTurnId !== 'string' || !currentTurnId.trim())) {
      throw new Error('currentTurnId must be a non-empty string or null');
    }
    this.db.exec('SAVEPOINT create_agent_session_transition');
    try {
      const taskLock = this.db.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=?').run(taskId);
      if (taskLock.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT create_agent_session_transition');
        return null;
      }
      const task = this.getTask(taskId);
      if (!task) throw new Error(`task disappeared during session creation: ${taskId}`);
      const normalizedRole = role || task.role || 'unknown';
      const existing = this.getSessionByOpenClawKey(sessionKey);
      if (existing) {
        if (existing.task_id !== taskId || existing.job_id !== task.job_id || existing.role !== normalizedRole ||
            (parentSessionKey != null && existing.parent_session_key !== parentSessionKey)) {
          throw new Error(`OpenClaw session key is already bound to a different task/session identity: ${sessionKey}`);
        }
        this.db.exec('RELEASE SAVEPOINT create_agent_session_transition');
        return existing;
      }
      const sessionId = id('session'); const ts = now();
      this.db.prepare(`INSERT INTO agent_sessions(
        session_id, job_id, task_id, role, openclaw_session_key, parent_session_key,
        state, current_turn_id, attempt, created_at, updated_at, last_activity_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sessionId, task.job_id, task.task_id, normalizedRole, sessionKey,
          parentSessionKey ?? null, state, currentTurnId ?? null, attempt, ts, ts, ts);
      const payload = {
        sessionId, taskId: task.task_id, role: normalizedRole, sessionKey,
        parentSessionKey: parentSessionKey ?? null, state, attempt
      };
      const eventIdValue = this.recordEvent(task.job_id, 'session.created', payload, sessionId);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const persisted = this.getSession(sessionId);
      if (!event || event.event_id !== eventId(task.job_id, 'session.created', sessionId) || event.job_id !== task.job_id ||
          event.type !== 'session.created' || event.payload_json !== JSON.stringify(payload) ||
          !persisted || persisted.task_id !== taskId || persisted.openclaw_session_key !== sessionKey || persisted.attempt !== attempt || persisted.state !== state) {
        throw new Error('agent session creation row/event lineage readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT create_agent_session_transition');
      return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT create_agent_session_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT create_agent_session_transition'); } catch {}
      throw error;
    }
  }
  updateAgentSession(sessionId, { state, currentTurnId, heartbeat = false, attempt, parentSessionKey } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId must be a non-empty string');
    if (state !== undefined && (typeof state !== 'string' || !['CREATED', 'ACTIVE', 'PAUSED', 'STALE', 'FAILED', 'TERMINATED'].includes(state))) {
      throw new Error('invalid agent session state');
    }
    if (typeof heartbeat !== 'boolean') throw new Error('heartbeat must be a boolean');
    if (currentTurnId !== undefined && currentTurnId !== null && (typeof currentTurnId !== 'string' || !currentTurnId.trim())) {
      throw new Error('currentTurnId must be a non-empty string or null');
    }
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) {
      throw new Error('session attempt must be a positive safe integer');
    }
    if (parentSessionKey !== undefined && parentSessionKey !== null && (typeof parentSessionKey !== 'string' || !parentSessionKey.trim())) {
      throw new Error('parentSessionKey must be a non-empty string or null');
    }
    this.db.exec('SAVEPOINT update_agent_session_transition');
    try {
      const sessionLock = this.db.prepare('UPDATE agent_sessions SET updated_at=updated_at WHERE session_id=?').run(sessionId);
      if (sessionLock.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT update_agent_session_transition');
        return null;
      }
      const existing = this.getSession(sessionId);
      if (!existing || !Number.isSafeInteger(existing.attempt) || existing.attempt < 1) {
        throw new Error('agent session is missing or has malformed durable attempt identity');
      }
      const nextState = state === undefined ? existing.state : state;
      const allowedNext = {
        CREATED: new Set(['CREATED', 'ACTIVE', 'PAUSED', 'STALE', 'FAILED', 'TERMINATED']),
        ACTIVE: new Set(['ACTIVE', 'PAUSED', 'STALE', 'FAILED', 'TERMINATED']),
        PAUSED: new Set(['PAUSED', 'ACTIVE', 'STALE', 'FAILED', 'TERMINATED']),
        STALE: new Set(['STALE', 'ACTIVE', 'FAILED', 'TERMINATED']),
        FAILED: new Set(['FAILED', 'ACTIVE', 'TERMINATED']),
        TERMINATED: new Set(['TERMINATED']),
      };
      if (!allowedNext[existing.state]?.has(nextState)) {
        throw new Error(`invalid agent session state transition: ${existing.state} -> ${nextState}`);
      }
      const nextTurn = currentTurnId === undefined ? existing.current_turn_id : currentTurnId;
      const nextAttempt = attempt === undefined ? existing.attempt : attempt;
      if (nextAttempt < existing.attempt) throw new Error('agent session attempt must not move backwards');
      const nextParent = parentSessionKey === undefined ? existing.parent_session_key : parentSessionKey;
      const ts = now();
      const update = this.db.prepare(`UPDATE agent_sessions
        SET state = ?, current_turn_id = ?, attempt = ?, parent_session_key = ?,
            updated_at = ?, last_activity_at = CASE WHEN ? THEN ? ELSE last_activity_at END
        WHERE session_id = ? AND state = ? AND attempt = ?`)
        .run(nextState, nextTurn, nextAttempt, nextParent, ts, heartbeat ? 1 : 0, ts, sessionId, existing.state, existing.attempt);
      if (update.changes !== 1) throw new Error('agent session update lost its state/attempt compare-and-set');
      let eventType = null;
      let eventPayload = null;
      let eventKey = null;
      if (nextState !== existing.state) {
        eventType = 'session.state_changed';
        eventPayload = {
          sessionId, taskId: existing.task_id, from: existing.state, to: nextState,
          previousAttempt: existing.attempt, attempt: nextAttempt,
          currentTurnId: nextTurn, parentSessionKey: nextParent
        };
        // A session can legitimately transition STALE/FAILED -> ACTIVE more
        // than once. Keying only by target state aliases later ownership epochs
        // to an earlier event, so bind each distinct transition to its time and
        // prior state/attempt while the savepoint guarantees atomicity.
        eventKey = `${sessionId}|transition|${crypto.randomUUID()}`;
      } else if (heartbeat) {
        eventType = 'session.heartbeat';
        eventPayload = {
          sessionId, taskId: existing.task_id, state: nextState, currentTurnId: nextTurn,
          attempt: nextAttempt, parentSessionKey: nextParent
        };
        eventKey = `${sessionId}|${ts}`;
      } else if (nextAttempt !== existing.attempt || nextTurn !== existing.current_turn_id || nextParent !== existing.parent_session_key) {
        eventType = 'session.updated';
        eventPayload = {
          sessionId, taskId: existing.task_id, state: nextState,
          previousAttempt: existing.attempt, attempt: nextAttempt,
          previousTurnId: existing.current_turn_id, currentTurnId: nextTurn,
          previousParentSessionKey: existing.parent_session_key, parentSessionKey: nextParent
        };
        eventKey = `${sessionId}|updated|${hash(JSON.stringify(eventPayload))}`;
      }
      if (eventType) {
        const eventIdValue = this.recordEvent(existing.job_id, eventType, eventPayload, eventKey);
        const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
        if (!event || event.event_id !== eventId(existing.job_id, eventType, eventKey) || event.job_id !== existing.job_id ||
            event.type !== eventType || event.payload_json !== JSON.stringify(eventPayload)) {
          throw new Error('agent session update/event lineage readback failed');
        }
      }
      const persisted = this.getSession(sessionId);
      if (!persisted || persisted.state !== nextState || persisted.attempt !== nextAttempt ||
          persisted.current_turn_id !== nextTurn || persisted.parent_session_key !== nextParent) {
        throw new Error('agent session update durable readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT update_agent_session_transition');
      return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT update_agent_session_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT update_agent_session_transition'); } catch {}
      throw error;
    }
  }
  heartbeatAgentSession(sessionId, { currentTurnId = null } = {}) {
    return this.updateAgentSession(sessionId, { heartbeat: true, currentTurnId });
  }
  listAgentSessions({ jobId = null, taskId = null, state = null, limit = 100 } = {}) {
    const clauses = []; const params = [];
    if (jobId) { clauses.push('job_id = ?'); params.push(jobId); }
    if (taskId) { clauses.push('task_id = ?'); params.push(taskId); }
    if (state) { clauses.push('state = ?'); params.push(state); }
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return this.db.prepare(`SELECT * FROM agent_sessions ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params);
  }
  getSessionAccess(accessId) {
    return this.db.prepare('SELECT * FROM session_access WHERE access_id = ?').get(accessId) || null;
  }
  listSessionAccess(sessionId, { includeRevoked = false } = {}) {
    return this.db.prepare(`SELECT * FROM session_access WHERE session_id = ? ${includeRevoked ? '' : 'AND revoked_at IS NULL'} ORDER BY created_at`).all(sessionId);
  }
  grantSessionAccess(sessionId, { accessorRole, permission = 'OBSERVE', grantedBy = null, expiresAt = null } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId must be a non-empty string');
    if (typeof accessorRole !== 'string' || !accessorRole.trim()) throw new Error('accessorRole must be a non-empty string');
    if (typeof permission !== 'string' || !permission.trim()) throw new Error('permission must be a non-empty string');
    if (typeof grantedBy !== 'string' || !grantedBy.trim()) throw new Error('grantedBy must be a non-empty string');
    if (expiresAt !== null) {
      if (typeof expiresAt !== 'string') throw new Error('expiresAt must be a canonical UTC timestamp or null');
      const expiryMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiryMs) || new Date(expiryMs).toISOString() !== expiresAt) {
        throw new Error('expiresAt must be a canonical UTC timestamp or null');
      }
    }
    this.db.exec('SAVEPOINT grant_session_access_transition');
    try {
      // Serialize grant decisions against revokes/renewals and ensure the row
      // change cannot survive if its audit event or readback fails.
      const sessionLock = this.db.prepare('UPDATE agent_sessions SET updated_at=updated_at WHERE session_id=?').run(sessionId);
      if (sessionLock.changes !== 1) throw new Error(`Unknown agent session: ${sessionId}`);
      const session = this.getSession(sessionId);
      if (!session) throw new Error(`Unknown agent session: ${sessionId}`);
      const role = normalizeGovernanceRole(accessorRole);
      const perm = permission.toUpperCase();
      if (!role) throw new Error('accessorRole is required');
      if (!['OBSERVE', 'MESSAGE', 'EXECUTE', 'TAKEOVER'].includes(perm)) throw new Error(`Invalid session permission: ${perm}`);
      assertSessionGrantAuthority(grantedBy, role, perm);
      const existing = this.db.prepare(`SELECT * FROM session_access
        WHERE session_id = ? AND accessor_role = ? AND permission = ? AND revoked_at IS NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sessionId, role, perm);
      let accessId;
      let eventType;
      let payload;
      let dedupeKey;
      if (existing) {
        if (existing.granted_by === grantedBy && existing.expires_at === expiresAt) {
          this.db.exec('RELEASE SAVEPOINT grant_session_access_transition');
          return existing;
        }
        const update = this.db.prepare('UPDATE session_access SET granted_by=?,expires_at=? WHERE access_id=? AND revoked_at IS NULL')
          .run(grantedBy, expiresAt, existing.access_id);
        if (update.changes !== 1) throw new Error('session access renewal lost its active-grant compare-and-set');
        accessId = existing.access_id;
        eventType = 'session.access_updated';
        payload = {
          accessId, sessionId, taskId: session.task_id, accessorRole: role, permission: perm,
          previousGrantedBy: existing.granted_by, previousExpiresAt: existing.expires_at,
          grantedBy, expiresAt
        };
        dedupeKey = `${accessId}|updated|${hash(JSON.stringify(payload))}`;
      } else {
        accessId = id('access'); const ts = now();
        this.db.prepare(`INSERT INTO session_access(access_id, session_id, accessor_role, permission, granted_by, expires_at, created_at, revoked_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`).run(accessId, sessionId, role, perm, grantedBy, expiresAt, ts);
        eventType = 'session.access_granted';
        payload = { accessId, sessionId, taskId: session.task_id, accessorRole: role, permission: perm, grantedBy, expiresAt };
        dedupeKey = accessId;
      }
      const eventIdValue = this.recordEvent(session.job_id, eventType, payload, dedupeKey);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const persisted = this.getSessionAccess(accessId);
      if (!event || event.event_id !== eventId(session.job_id, eventType, dedupeKey) || event.job_id !== session.job_id ||
          event.type !== eventType || event.payload_json !== JSON.stringify(payload) ||
          !persisted || persisted.session_id !== sessionId || persisted.accessor_role !== role || persisted.permission !== perm ||
          persisted.granted_by !== grantedBy || persisted.expires_at !== expiresAt || persisted.revoked_at !== null) {
        throw new Error('session access grant/event lineage readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT grant_session_access_transition');
      return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT grant_session_access_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT grant_session_access_transition'); } catch {}
      throw error;
    }
  }
  revokeSessionAccess(accessId, { actor = null } = {}) {
    if (typeof accessId !== 'string' || !accessId.trim()) throw new Error('accessId must be a non-empty string');
    if (typeof actor !== 'string' || !actor.trim()) throw new Error('revoke actor must be a non-empty string');
    this.db.exec('SAVEPOINT revoke_session_access_transition');
    try {
      const accessLock = this.db.prepare('UPDATE session_access SET revoked_at=revoked_at WHERE access_id=?').run(accessId);
      if (accessLock.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT revoke_session_access_transition');
        return null;
      }
      const access = this.getSessionAccess(accessId);
      if (!access) throw new Error('session access disappeared during revoke');
      if (access.revoked_at) {
        this.db.exec('RELEASE SAVEPOINT revoke_session_access_transition');
        return access;
      }
      const session = this.getSession(access.session_id);
      if (!session) throw new Error('session access refers to a missing session');
      assertSessionRevokeAuthority(actor, session.role, access.accessor_role, access.permission);
      const ts = now();
      const update = this.db.prepare('UPDATE session_access SET revoked_at=? WHERE access_id=? AND revoked_at IS NULL').run(ts, accessId);
      if (update.changes !== 1) throw new Error('session access revoke lost its active-grant compare-and-set');
      const payload = {
        accessId, sessionId: session.session_id, taskId: session.task_id,
        accessorRole: access.accessor_role, permission: access.permission, actor, revokedAt: ts
      };
      const eventIdValue = this.recordEvent(session.job_id, 'session.access_revoked', payload, accessId);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const persisted = this.getSessionAccess(accessId);
      if (!event || event.event_id !== eventId(session.job_id, 'session.access_revoked', accessId) || event.job_id !== session.job_id ||
          event.type !== 'session.access_revoked' || event.payload_json !== JSON.stringify(payload) || persisted?.revoked_at !== ts) {
        throw new Error('session access revoke/event lineage readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT revoke_session_access_transition');
      return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT revoke_session_access_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT revoke_session_access_transition'); } catch {}
      throw error;
    }
  }
  hasSessionPermission(sessionId, accessorRole, permission, { at = new Date().toISOString() } = {}) {
    const session = this.getSession(sessionId); if (!session) return false;
    if (typeof accessorRole !== 'string' || !accessorRole.trim() || typeof permission !== 'string' || !permission.trim()) return false;
    const role = String(accessorRole || '').trim(); const perm = String(permission || '').toUpperCase();
    // Owner has implicit OBSERVE/MESSAGE/EXECUTE access. TAKEOVER is deliberately
    // never implicit: it changes ownership and requires an explicit grant.
    if (role === session.role && ['OBSERVE', 'MESSAGE', 'EXECUTE'].includes(perm)) return true;
    // SQLite's lexical timestamp comparison is unsafe for malformed durable
    // grant expiry values (e.g. 'zzzz' sorts after today's ISO timestamp and
    // accidentally grants an unbounded permission). Parse canonical UTC values
    // and compare epoch milliseconds; malformed time inputs fail closed.
    if (typeof at !== 'string') return false;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) return false;
    try { if (new Date(atMs).toISOString() !== at) return false; } catch { return false; }
    const rows = this.db.prepare(`SELECT expires_at FROM session_access
      WHERE session_id = ? AND accessor_role = ? AND permission = ? AND revoked_at IS NULL`)
      .all(sessionId, role, perm);
    for (const row of rows) {
      if (row.expires_at === null) return true;
      if (typeof row.expires_at !== 'string') continue;
      const expiryMs = Date.parse(row.expires_at);
      if (!Number.isFinite(expiryMs)) continue;
      try { if (new Date(expiryMs).toISOString() !== row.expires_at) continue; }
      catch { continue; }
      if (expiryMs > atMs) return true;
    }
    return false;
  }
  assertSessionPermission(sessionId, accessorRole, permission, options = {}) {
    if (!this.hasSessionPermission(sessionId, accessorRole, permission, options)) {
      throw new Error(`Session access denied: role=${accessorRole} permission=${String(permission).toUpperCase()} session=${sessionId}`);
    }
    return this.getSession(sessionId);
  }
  attachAgentSession(sessionId, { actorRole, mode = 'observe' } = {}) {
    const normalized = String(mode || 'observe').toUpperCase();
    const permission = normalized === 'INTERACT' ? 'MESSAGE' : normalized === 'TAKEOVER' ? 'TAKEOVER' : 'OBSERVE';
    const session = this.assertSessionPermission(sessionId, actorRole, permission);
    this.recordEvent(session.job_id, 'session.attached', {
      sessionId, taskId: session.task_id, actorRole, mode: normalized, permission
    }, `${sessionId}|${actorRole}|${normalized}`);
    return { session, mode: normalized, permission };
  }
  takeoverAgentSession(sessionId, { actorRole, reason = 'session takeover' } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('sessionId must be a non-empty string');
    if (typeof actorRole !== 'string' || !actorRole.trim()) throw new Error('takeover actorRole must be a non-empty string');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('takeover reason must be a non-empty string');
    this.db.exec('SAVEPOINT takeover_agent_session_transition');
    try {
      // Hold the SQLite writer reservation before checking the TAKEOVER grant.
      // Without this lock, another process could revoke/expire the grant after
      // the check but before ownership is changed.
      const lock = this.db.prepare('UPDATE agent_sessions SET updated_at=updated_at WHERE session_id=?').run(sessionId);
      if (lock.changes !== 1) throw new Error(`Unknown agent session: ${sessionId}`);
      const session = this.assertSessionPermission(sessionId, actorRole, 'TAKEOVER');
      if (normalizeGovernanceRole(session.role) === normalizeGovernanceRole(actorRole)) {
        throw new Error('Session owner cannot takeover its own session');
      }
      if (!['STALE', 'FAILED', 'PAUSED'].includes(session.state)) {
        throw new Error(`Session takeover requires PAUSED, STALE, or FAILED state; got ${session.state}`);
      }
      const updated = this.updateAgentSession(sessionId, { state: 'ACTIVE', heartbeat: true });
      const payload = { sessionId, taskId: session.task_id, fromRole: session.role, actorRole, reason };
      const eventKey = `${sessionId}|${actorRole}|takeover|${crypto.randomUUID()}`;
      const eventIdValue = this.recordEvent(session.job_id, 'session.takeover', payload, eventKey);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const persisted = this.getSession(sessionId);
      if (!event || event.event_id !== eventId(session.job_id, 'session.takeover', eventKey) || event.job_id !== session.job_id ||
          event.type !== 'session.takeover' || event.payload_json !== JSON.stringify(payload) || persisted?.state !== 'ACTIVE') {
        throw new Error('session takeover row/event lineage readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT takeover_agent_session_transition');
      return updated;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT takeover_agent_session_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT takeover_agent_session_transition'); } catch {}
      throw error;
    }
  }
  enqueueSessionMessage(sessionId, { senderRole, recipientRole, payload = {}, messageType = 'session.message', correlationId = null, dedupeKey = null, availableAt = null } = {}) {
    const sender = String(senderRole || '').trim();
    if (!sender) throw new Error('senderRole is required');
    const recipient = String(recipientRole || '').trim();
    if (!recipient) throw new Error('recipientRole is required');
    const type = String(messageType || 'session.message').trim();
    if (!type) throw new Error('messageType is required');
    if (correlationId != null && (typeof correlationId !== 'string' || !correlationId.trim())) throw new Error('correlationId must be a non-empty string or null');
    if (dedupeKey != null && (typeof dedupeKey !== 'string' || !dedupeKey.trim())) throw new Error('dedupeKey must be a non-empty string or null');
    if (availableAt != null && (typeof availableAt !== 'string' || !Number.isFinite(Date.parse(availableAt)) ||
        new Date(Date.parse(availableAt)).toISOString() !== availableAt)) throw new Error('availableAt must be a canonical UTC ISO-8601 timestamp');
    let detachedPayload;
    let detachedPayloadJson;
    try {
      detachedPayloadJson = JSON.stringify(payload);
      if (typeof detachedPayloadJson !== 'string') throw new Error('payload is not JSON serializable');
      detachedPayload = parseStrictJson(detachedPayloadJson);
    } catch (error) { throw new Error(`session message payload must be detached JSON: ${error.message}`); }
    if (!detachedPayload || typeof detachedPayload !== 'object' || Array.isArray(detachedPayload)) {
      throw new Error('session message payload must be a JSON object');
    }
    validatePayload(type, detachedPayload);

    // Pause competing callers immediately before writer reservation in tests.
    // The actual durable dedupe lookup deliberately happens only after the
    // writer reservation and a fresh permission/session read below.
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_SESSION_ENQUEUE_BARRIER_DIR) {
      const barrierDirectory = path.resolve(process.env.CHAT_ON_STEROIDS_TEST_SESSION_ENQUEUE_BARRIER_DIR);
      const readyPath = path.join(barrierDirectory, `${process.pid}.ready`);
      const releasePath = path.join(barrierDirectory, 'release');
      fs.writeFileSync(readyPath, `${sessionId}|${dedupeKey || ''}\n`, { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(releasePath)) {
        if (Date.now() >= deadline) throw new Error('test session-message enqueue barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }

    this.db.exec('SAVEPOINT enqueue_session_message_transition');
    try {
      const reservation = this.db.prepare('UPDATE agent_sessions SET updated_at=updated_at WHERE session_id=?').run(sessionId);
      if (reservation.changes !== 1) throw new Error(`session not found while enqueueing durable message: ${sessionId}`);
      const session = this.getSession(sessionId);
      if (!session) throw new Error(`session not found while enqueueing durable message: ${sessionId}`);
      this.assertSessionPermission(sessionId, sender, 'MESSAGE');
      const ts = now();
      const readyAt = availableAt ?? ts;
      const makeQueuedPayload = messageId => ({
        messageId, sessionId, taskId: session.task_id, senderRole: sender, recipientRole: recipient,
        messageType: type, correlationId, dedupeKey
      });
      const validateOrRepairQueueEvent = row => {
        const expectedPayload = makeQueuedPayload(row.message_id);
        const expectedEventId = eventId(session.job_id, 'session.message_queued', row.message_id);
        const rows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_queued'").all(session.job_id);
        const matches = [];
        for (const event of rows) {
          let eventPayload;
          try { eventPayload = parseStrictJson(event.payload_json); }
          catch { throw new Error('session queue contains malformed session.message_queued event JSON'); }
          if (event.payload_json !== JSON.stringify(eventPayload)) throw new Error('session queue contains non-canonical session.message_queued event JSON');
          if (eventPayload?.messageId === row.message_id) matches.push({ event, payload: eventPayload });
        }
        if (matches.length > 1) throw new Error('session enqueue found duplicate logical session.message_queued events');
        if (matches.length === 0) {
          const occupied = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(expectedEventId);
          if (occupied) throw new Error('session queue deterministic event ID is occupied by conflicting durable evidence');
          this.recordEvent(session.job_id, 'session.message_queued', expectedPayload, row.message_id);
          if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_MESSAGE_EVENT_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
        } else if (matches[0].event.event_id !== expectedEventId || matches[0].event.job_id !== session.job_id ||
            matches[0].event.type !== 'session.message_queued' || matches[0].event.payload_json !== JSON.stringify(expectedPayload)) {
          throw new Error('existing session.message_queued event conflicts with the exact durable message identity');
        }
        const finalRows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_queued'").all(session.job_id);
        const finalMatches = finalRows.filter(event => {
          try { return parseStrictJson(event.payload_json)?.messageId === row.message_id; } catch { return false; }
        });
        if (finalMatches.length !== 1 || finalMatches[0].event_id !== expectedEventId || finalMatches[0].job_id !== session.job_id ||
            finalMatches[0].type !== 'session.message_queued' || finalMatches[0].payload_json !== JSON.stringify(expectedPayload)) {
          throw new Error('session enqueue row/event readback or cardinality failed');
        }
        return expectedPayload;
      };

      const existingRows = dedupeKey == null ? [] : this.db.prepare('SELECT * FROM session_messages WHERE session_id=? AND dedupe_key=? ORDER BY rowid').all(sessionId, dedupeKey);
      if (existingRows.length > 1) throw new Error('session enqueue found multiple rows for one dedupe key');
      if (existingRows.length === 1) {
        const existing = existingRows[0];
        const sameContract = existing.session_id === sessionId && existing.sender_role === sender &&
          existing.recipient_role === recipient && existing.protocol === 'cos-ap' && Number(existing.protocol_version) === 1 &&
          existing.message_type === type && existing.payload_json === detachedPayloadJson &&
          existing.correlation_id === correlationId && existing.dedupe_key === dedupeKey &&
          (availableAt == null || existing.available_at === availableAt);
        if (!sameContract) throw new Error('session enqueue dedupe key conflicts with existing durable message payload/sender/recipient contract');
        validateOrRepairQueueEvent(existing);
        const persisted = this.getSessionMessage(existing.message_id);
        if (!persisted || persisted.message_id !== existing.message_id || persisted.session_id !== sessionId ||
            persisted.sender_role !== sender || persisted.recipient_role !== recipient || persisted.message_type !== type ||
            persisted.payload_json !== detachedPayloadJson || persisted.dedupe_key !== dedupeKey) {
          throw new Error('session enqueue idempotent row readback failed');
        }
        this.db.exec('RELEASE SAVEPOINT enqueue_session_message_transition');
        return persisted;
      }

      const messageId = id('msg');
      const envelope = createEnvelope({ messageId, messageType: type, jobId: session.job_id, taskId: session.task_id || null,
        attempt: 1, sender, recipient, correlationId, payload: detachedPayload, createdAt: ts });
      validateEnvelope(envelope);
      const persistedPayloadJson = JSON.stringify(envelope.payload);
      if (persistedPayloadJson !== detachedPayloadJson) throw new Error('session enqueue envelope changed exact payload bytes during validation');
      this.db.prepare(`INSERT INTO session_messages(
        message_id,session_id,sender_role,recipient_role,protocol,protocol_version,message_type,payload_json,
        correlation_id,dedupe_key,status,attempt,available_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'QUEUED',0,?,?,?)`)
        .run(messageId, sessionId, sender, recipient, envelope.protocol, envelope.version, envelope.message_type,
          persistedPayloadJson, correlationId, dedupeKey, readyAt, ts, ts);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_MESSAGE_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      validateOrRepairQueueEvent({ message_id: messageId });
      const persisted = this.getSessionMessage(messageId);
      if (!persisted || persisted.message_id !== messageId || persisted.session_id !== sessionId || persisted.sender_role !== sender ||
          persisted.recipient_role !== recipient || persisted.protocol !== envelope.protocol || persisted.protocol_version !== envelope.version ||
          persisted.message_type !== type || persisted.payload_json !== persistedPayloadJson || persisted.correlation_id !== correlationId ||
          persisted.dedupe_key !== dedupeKey || persisted.status !== 'QUEUED' || typeof persisted.attempt !== 'number' || persisted.attempt !== 0 ||
          persisted.available_at !== readyAt || persisted.created_at !== ts || persisted.updated_at !== ts) {
        throw new Error('session enqueue exact durable row readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT enqueue_session_message_transition');
      return persisted;
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT enqueue_session_message_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT enqueue_session_message_transition'); } catch {}
      throw failure;
    }
  }
  getSessionMessage(messageId) {
    return this.db.prepare('SELECT * FROM session_messages WHERE message_id = ?').get(messageId) || null;
  }
  listSessionMessages(sessionId, { recipientRole = null, status = null, limit = 100 } = {}) {
    const clauses = ['session_id = ?']; const params = [sessionId];
    if (recipientRole) { clauses.push('recipient_role = ?'); params.push(recipientRole); }
    if (status) { clauses.push('status = ?'); params.push(String(status).toUpperCase()); }
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return this.db.prepare(`SELECT * FROM session_messages WHERE ${clauses.join(' AND ')} ORDER BY created_at, rowid LIMIT ?`).all(...params);
  }
  claimSessionMessage(messageId, { recipientRole, leaseMs = 60_000 } = {}) {
    const message = this.getSessionMessage(messageId);
    if (!message) return null;
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_SESSION_CLAIM_BARRIER_DIR) {
      const barrierDirectory = path.resolve(process.env.CHAT_ON_STEROIDS_TEST_SESSION_CLAIM_BARRIER_DIR);
      const readyPath = path.join(barrierDirectory, `${process.pid}.ready`);
      const releasePath = path.join(barrierDirectory, 'release');
      fs.writeFileSync(readyPath, `${messageId}|${message.status}|${message.attempt}\n`, { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(releasePath)) {
        if (Date.now() >= deadline) throw new Error('test session-message claim barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    this.db.exec('SAVEPOINT claim_session_message_transition');
    try {
      // Acquire SQLite's writer reservation before checking recipient permission,
      // status or lease. The old read-then-update flow let two processes observe
      // QUEUED and both increment attempt + dispatch the external transport.
      const reservation = this.db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT claim_session_message_transition');
        return null;
      }
      const current = this.getSessionMessage(messageId);
      if (!current) throw new Error(`session message disappeared during claim: ${messageId}`);
      if (typeof current.attempt !== 'number' || !Number.isSafeInteger(current.attempt) || current.attempt < 0) {
        throw new Error(`session message has a malformed durable attempt: ${messageId}`);
      }
      this.assertSessionPermission(current.session_id, recipientRole, 'MESSAGE');
      if (current.recipient_role !== recipientRole) throw new Error(`Message recipient mismatch: expected=${current.recipient_role} got=${recipientRole}`);
      const ts = now();
      if (current.status === 'ACKED' || current.status === 'FAILED' || current.last_error?.startsWith('DELIVERY_UNCERTAIN:')) {
        this.db.exec('RELEASE SAVEPOINT claim_session_message_transition');
        return { ...current, claimAcquired: false };
      }
      if (current.status === 'DELIVERED' && current.lease_until && current.lease_until > ts) {
        this.db.exec('RELEASE SAVEPOINT claim_session_message_transition');
        return { ...current, claimAcquired: false };
      }
      if (current.status === 'DELIVERED' && (!current.lease_until || current.lease_until <= ts)) {
        const session = this.getSession(current.session_id);
        if (!session) throw new Error(`session missing while reclaiming an expired lease: ${messageId}`);
        const startKey = `${messageId}|${current.attempt}`;
        const expectedStartId = eventId(session.job_id, 'session.message_delivery_started', startKey);
        const startRows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_delivery_started'").all(session.job_id);
        const started = [];
        let corruptStartLedger = false;
        for (const row of startRows) {
          let payload;
          try { payload = parseStrictJson(row.payload_json); }
          catch { corruptStartLedger = true; break; }
          if (row.payload_json !== JSON.stringify(payload)) { corruptStartLedger = true; break; }
          if (payload?.messageId === messageId && typeof payload.attempt === 'number' && payload.attempt === current.attempt) started.push({ row, payload });
        }
        const exactStart = started.length === 1 && started[0].row.event_id === expectedStartId &&
          started[0].row.job_id === session.job_id && started[0].row.type === 'session.message_delivery_started' &&
          Object.keys(started[0].payload).sort().join(',') === 'attempt,idempotencyKey,leaseUntil,messageId,recipientRole,sessionId,startedAt' &&
          started[0].payload.sessionId === current.session_id && started[0].payload.recipientRole === current.recipient_role &&
          started[0].payload.idempotencyKey === messageId && typeof started[0].payload.startedAt === 'string' &&
          started[0].payload.attempt === current.attempt;
        if (corruptStartLedger || started.length > 0) {
          // An expired lease with a durable transport-start marker (or a
          // malformed marker ledger) may already have produced an external
          // side effect. Never hand that attempt to another sender.
          const uncertain = this.markSessionMessageDeliveryUncertain(messageId, {
            attempt: current.attempt, leaseUntil: current.lease_until,
            phase: corruptStartLedger || !exactStart ? 'claim_found_corrupt_transport_start_ledger' : 'expired_lease_after_transport_start',
            error: corruptStartLedger || !exactStart
              ? 'transport-start event ledger is malformed, duplicated, or detached'
              : 'delivery lease expired after durable transport-start intent; external outcome may be unknown'
          });
          this.db.exec('RELEASE SAVEPOINT claim_session_message_transition');
          return { ...uncertain, claimAcquired: false };
        }
      }
      if (!['QUEUED', 'DELIVERED'].includes(current.status) || current.available_at > ts) {
        this.db.exec('RELEASE SAVEPOINT claim_session_message_transition');
        return { ...current, claimAcquired: false };
      }
      const leaseUntil = new Date(Date.now() + Math.max(1, Number(leaseMs) || 60_000)).toISOString();
      const updatedClaim = this.db.prepare(`UPDATE session_messages
        SET status='DELIVERED',attempt=attempt+1,delivered_at=?,lease_until=?,updated_at=?
        WHERE message_id=? AND status=? AND attempt=? AND available_at<=?
          AND (status='QUEUED' OR lease_until IS NULL OR lease_until<=?)`)
        .run(ts, leaseUntil, ts, messageId, current.status, current.attempt, ts, ts);
      if (updatedClaim.changes !== 1) {
        const latest = this.getSessionMessage(messageId);
        this.db.exec('RELEASE SAVEPOINT claim_session_message_transition');
        return latest ? { ...latest, claimAcquired: false } : null;
      }
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_CLAIM_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const updated = this.getSessionMessage(messageId);
      const session = this.getSession(updated.session_id);
      if (!session) throw new Error(`session message session no longer exists: ${messageId}`);
      const payload = { messageId, sessionId: updated.session_id, recipientRole, attempt: updated.attempt, leaseUntil };
      const expectedEventId = eventId(session.job_id, 'session.message_delivered', `${messageId}|${updated.attempt}`);
      this.recordEvent(session.job_id, 'session.message_delivered', payload, `${messageId}|${updated.attempt}`);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_CLAIM_EVENT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const matchingEvents = [];
      for (const row of this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_delivered'").all(session.job_id)) {
        let existingPayload;
        try { existingPayload = parseStrictJson(row.payload_json); }
        catch { throw new Error('session delivery claim found malformed durable delivery event'); }
        if (row.payload_json !== JSON.stringify(existingPayload)) throw new Error('session delivery claim found non-canonical delivery event JSON');
        if (existingPayload?.messageId === messageId && typeof existingPayload.attempt === 'number' && existingPayload.attempt === updated.attempt) {
          matchingEvents.push({ row, payload: existingPayload });
        }
      }
      const persisted = this.getSessionMessage(messageId);
      if (typeof updated.attempt !== 'number' || !Number.isSafeInteger(updated.attempt) || updated.attempt !== current.attempt + 1 ||
          matchingEvents.length !== 1 || matchingEvents[0].row.event_id !== expectedEventId ||
          matchingEvents[0].row.job_id !== session.job_id || matchingEvents[0].row.type !== 'session.message_delivered' ||
          matchingEvents[0].row.payload_json !== JSON.stringify(payload) || persisted?.status !== 'DELIVERED' ||
          typeof persisted.attempt !== 'number' || persisted.attempt !== updated.attempt || persisted.lease_until !== leaseUntil ||
          persisted.session_id !== updated.session_id || persisted.recipient_role !== recipientRole) {
        throw new Error('session delivery claim did not reconcile one exact lease row and canonical delivery event');
      }
      this.db.exec('RELEASE SAVEPOINT claim_session_message_transition');
      return { ...persisted, claimAcquired: true };
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT claim_session_message_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT claim_session_message_transition'); } catch {}
      throw failure;
    }
  }
  claimNextSessionMessage(sessionId, { recipientRole, leaseMs = 60_000 } = {}) {
    this.assertSessionPermission(sessionId, recipientRole, 'MESSAGE');
    const ts = now();
    const message = this.db.prepare(`SELECT * FROM session_messages
      WHERE session_id = ? AND recipient_role = ? AND status IN ('QUEUED','DELIVERED')
        AND available_at <= ? AND (status = 'QUEUED' OR lease_until IS NULL OR lease_until <= ?)
      ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(sessionId, recipientRole, ts, ts);
    return message ? this.claimSessionMessage(message.message_id, { recipientRole, leaseMs }) : null;
  }
  deliverNextSessionMessage(sessionId, { recipientRole, transport, deliveryOptions = {} } = {}) {
    if (typeof transport !== 'function') throw new TypeError('session delivery transport must be a function');
    this.assertSessionPermission(sessionId, recipientRole, 'MESSAGE');
    // Select without claiming: deliverSessionMessage owns the single atomic
    // claim immediately before recording transport-start intent. Pre-claiming
    // here would leave a live DELIVERED lease that the managed sender then
    // correctly refuses to claim a second time, silently suppressing delivery.
    const message = this.db.prepare(`SELECT * FROM session_messages
      WHERE session_id = ? AND recipient_role = ? AND status = 'QUEUED' AND available_at <= ?
      ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(sessionId, recipientRole, now());
    if (!message) return Promise.resolve(null);
    return this.deliverSessionMessage(message.message_id, transport, deliveryOptions);
  }
  assertDurableSuccessfulSessionReceipt(message, session, { allowClearedLease = false } = {}) {
    if (typeof message.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 1) {
      throw new Error('session successful receipt has a malformed durable delivery attempt');
    }
    const startKey = `${message.message_id}|${message.attempt}`;
    const startId = eventId(session.job_id, 'session.message_delivery_started', startKey);
    const allStarts = this.db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE job_id=? AND type='session.message_delivery_started'").all(session.job_id);
    const startMatches = [];
    for (const row of allStarts) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('session delivery started ledger contains malformed JSON'); }
      if (row.payload_json !== JSON.stringify(payload)) throw new Error('session delivery started ledger is non-canonical');
      if (payload?.messageId === message.message_id && typeof payload.attempt === 'number' && payload.attempt === message.attempt) startMatches.push({ row, payload });
    }
    if (startMatches.length !== 1 || startMatches[0].row.event_id !== startId ||
        startMatches[0].row.job_id !== session.job_id || startMatches[0].row.type !== 'session.message_delivery_started' ||
        Object.keys(startMatches[0].payload).sort().join(',') !== 'attempt,idempotencyKey,leaseUntil,messageId,recipientRole,sessionId,startedAt' ||
        startMatches[0].payload.messageId !== message.message_id || startMatches[0].payload.sessionId !== message.session_id ||
        startMatches[0].payload.recipientRole !== message.recipient_role || startMatches[0].payload.attempt !== message.attempt ||
        startMatches[0].payload.idempotencyKey !== message.message_id || typeof startMatches[0].payload.leaseUntil !== 'string' ||
        (!allowClearedLease && startMatches[0].payload.leaseUntil !== message.lease_until) ||
        typeof startMatches[0].payload.startedAt !== 'string') {
      throw new Error('session successful receipt lacks one exact canonical transport-start lineage event');
    }

    const allReceipts = this.db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE job_id=? AND type='session.message_receipt'").all(session.job_id);
    const receiptMatches = [];
    for (const row of allReceipts) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('session delivery receipt ledger contains malformed JSON'); }
      if (row.payload_json !== JSON.stringify(payload)) throw new Error('session delivery receipt ledger is non-canonical');
      if (payload?.messageId === message.message_id && typeof payload.attempt === 'number' && payload.attempt === message.attempt) receiptMatches.push({ row, payload });
    }
    if (receiptMatches.length !== 1) throw new Error('session successful receipt recovery requires exactly one durable receipt for the current attempt');
    const { row, payload } = receiptMatches[0];
    const receiptId = eventId(session.job_id, 'session.message_receipt', `${message.message_id}|${message.attempt}|${payload.status}`);
    const receiptKeys = 'attempt,error,messageId,recordedAt,response,runId,sessionKey,status';
    const hasRunId = (typeof payload.runId === 'string' && payload.runId.trim().length > 0) ||
      (typeof payload.runId === 'number' && Number.isFinite(payload.runId));
    const recordedAt = Date.parse(payload.recordedAt);
    const startedAt = Date.parse(startMatches[0].payload.startedAt);
    const eventOrder = Date.parse(row.created_at) >= Date.parse(startMatches[0].row.created_at);
    if (row.event_id !== receiptId || row.job_id !== session.job_id || row.type !== 'session.message_receipt' ||
        Object.keys(payload).sort().join(',') !== receiptKeys || payload.messageId !== message.message_id ||
        typeof payload.attempt !== 'number' || payload.attempt !== message.attempt || payload.status !== 'OK' ||
        !hasRunId || payload.error !== null || payload.sessionKey !== session.openclaw_session_key ||
        !Number.isFinite(recordedAt) || new Date(recordedAt).toISOString() !== payload.recordedAt ||
        !Number.isFinite(startedAt) || !eventOrder || Date.parse(row.created_at) < Date.parse(startMatches[0].row.created_at)) {
      throw new Error('session success receipt does not bind exact message/session/attempt and chronological transport-start lineage');
    }
    return payload;
  }

  ackSessionMessage(messageId, { recipientRole, correlationId = null, expectedAttempt = null, expectedLeaseUntil = null,
    allowExpiredLeaseWithDurableReceipt = false } = {}) {
    this.db.exec('SAVEPOINT ack_session_message_transition');
    try {
      const reservation = this.db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT ack_session_message_transition');
        return null;
      }
      const message = this.getSessionMessage(messageId);
      if (!message) throw new Error(`session message not found: ${messageId}`);
      if (typeof message.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 0) {
        throw new Error(`session message ACK refuses a malformed durable attempt: ${messageId}`);
      }
      this.assertSessionPermission(message.session_id, recipientRole, 'MESSAGE');
      if (message.recipient_role !== recipientRole) throw new Error(`Message recipient mismatch: expected=${message.recipient_role} got=${recipientRole}`);
      const session = this.getSession(message.session_id);
      if (!session) throw new Error(`session not found for ACKed message: ${messageId}`);
      const expectedPayload = {
        messageId, sessionId: message.session_id, recipientRole, attempt: message.attempt,
        correlationId: correlationId || message.correlation_id
      };
      const expectedId = eventId(session.job_id, 'session.message_acked', messageId);
      const matchingEvents = [];
      for (const row of this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_acked'").all(session.job_id)) {
        let payload;
        try { payload = parseStrictJson(row.payload_json); }
        catch { throw new Error('session message ACK found malformed durable ACK event'); }
        if (row.payload_json !== JSON.stringify(payload)) throw new Error('session message ACK found non-canonical ACK event JSON');
        if (payload?.messageId === messageId) matchingEvents.push({ row, payload });
      }
      if (message.status === 'ACKED') {
        if (matchingEvents.length !== 1 || matchingEvents[0].row.event_id !== expectedId ||
            matchingEvents[0].row.payload_json !== JSON.stringify(expectedPayload)) {
          throw new Error('idempotent ACK readback is missing or conflicts with exact durable ACK lineage');
        }
        this.assertDurableSuccessfulSessionReceipt(message, session, { allowClearedLease: true });
        this.db.exec('RELEASE SAVEPOINT ack_session_message_transition');
        return { ...message, ackAcquired: false };
      }
      if (message.status !== 'DELIVERED') throw new Error(`Message cannot be ACKed from state ${message.status}`);
      if (expectedAttempt !== null && (typeof expectedAttempt !== 'number' || !Number.isSafeInteger(expectedAttempt) || expectedAttempt !== message.attempt)) {
        throw new Error('message ACK belongs to a stale or malformed delivery attempt');
      }
      if (expectedLeaseUntil !== null && message.lease_until !== expectedLeaseUntil) {
        throw new Error('message ACK belongs to a replaced delivery lease');
      }
      const leaseExpired = !message.lease_until || message.lease_until <= now();
      if (leaseExpired) {
        if (allowExpiredLeaseWithDurableReceipt !== true) throw new Error('message ACK delivery lease expired before durable acknowledgement');
      }
      // ACK is a terminal delivery transition, not a caller assertion. Require
      // the exact successful receipt and transport-start lineage for both the
      // live fast path and expired-lease recovery; previously only recovery
      // validated this proof, allowing direct callers to ACK an unreceipted send.
      this.assertDurableSuccessfulSessionReceipt(message, session);
      const ts = now();
      const ackUpdate = leaseExpired
        ? this.db.prepare(`UPDATE session_messages SET status='ACKED',acked_at=?,lease_until=NULL,updated_at=?
            WHERE message_id=? AND status='DELIVERED' AND attempt=? AND lease_until=?`)
          .run(ts, ts, messageId, message.attempt, message.lease_until)
        : this.db.prepare(`UPDATE session_messages SET status='ACKED',acked_at=?,lease_until=NULL,updated_at=?
            WHERE message_id=? AND status='DELIVERED' AND attempt=? AND lease_until=? AND lease_until>?`)
          .run(ts, ts, messageId, message.attempt, message.lease_until, ts);
      const updatedCount = ackUpdate.changes;
      if (updatedCount !== 1) throw new Error('message ACK lost compare-and-set ownership of its exact lease');
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_ACK_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      this.recordEvent(session.job_id, 'session.message_acked', expectedPayload, messageId);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_ACK_EVENT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const rows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_acked'").all(session.job_id);
      const finalMatches = rows.filter(row => {
        try { return parseStrictJson(row.payload_json)?.messageId === messageId; } catch { return false; }
      });
      const persisted = this.getSessionMessage(messageId);
      if (finalMatches.length !== 1 || finalMatches[0].event_id !== expectedId || finalMatches[0].job_id !== session.job_id ||
          finalMatches[0].type !== 'session.message_acked' || finalMatches[0].payload_json !== JSON.stringify(expectedPayload) ||
          persisted?.status !== 'ACKED' || typeof persisted.attempt !== 'number' || persisted.attempt !== message.attempt || persisted.acked_at !== ts || persisted.lease_until !== null) {
        throw new Error('session message ACK row/event exact readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT ack_session_message_transition');
      return { ...persisted, ackAcquired: true };
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT ack_session_message_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT ack_session_message_transition'); } catch {}
      throw failure;
    }
  }

  markSessionMessageDeliveryUncertain(messageId, { attempt, leaseUntil = null, phase, error } = {}) {
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error('delivery uncertainty requires an exact positive safe-integer attempt');
    }
    const normalizedPhase = String(phase || 'delivery_outcome_unknown');
    const errorText = String(error?.message || error || 'external delivery outcome is unknown').slice(0, 1000);
    const uncertainError = `DELIVERY_UNCERTAIN: phase=${normalizedPhase}; attempt=${attempt}; ${errorText}`;
    this.db.exec('SAVEPOINT session_delivery_uncertain_transition');
    try {
      const reservation = this.db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) throw new Error(`cannot mark missing session message delivery uncertain: ${messageId}`);
      const message = this.getSessionMessage(messageId);
      if (typeof message?.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 1) {
        throw new Error(`cannot quarantine uncertain delivery with malformed durable message attempt: ${messageId}`);
      }
      const session = this.getSession(message.session_id);
      if (!session) throw new Error(`cannot mark uncertain delivery without its session: ${messageId}`);
      if (message.status === 'ACKED') {
        // A late uncertainty callback is a no-op only if the already-terminal
        // ACK and its successful receipt still reconcile exactly.
        this.ackSessionMessage(messageId, { recipientRole: message.recipient_role });
        this.db.exec('RELEASE SAVEPOINT session_delivery_uncertain_transition');
        return message;
      }
      if (message.attempt !== attempt || !['DELIVERED', 'FAILED'].includes(message.status)) {
        throw new Error(`cannot mark a replaced session delivery attempt uncertain: ${messageId}`);
      }
      if (leaseUntil !== null && message.lease_until !== leaseUntil) {
        throw new Error(`cannot mark a replaced session delivery lease uncertain: ${messageId}`);
      }
      if (message.status === 'FAILED' && message.last_error?.startsWith('DELIVERY_UNCERTAIN:')) {
        const expectedId = eventId(session.job_id, 'session.message_delivery_uncertain', `${messageId}|${attempt}`);
        const rows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_delivery_uncertain'").all(session.job_id);
        const matches = [];
        for (const row of rows) {
          let payload;
          try { payload = parseStrictJson(row.payload_json); }
          catch { throw new Error('existing delivery-uncertain ledger contains malformed JSON'); }
          if (row.payload_json !== JSON.stringify(payload)) throw new Error('existing delivery-uncertain ledger is non-canonical');
          if (payload?.messageId === messageId && typeof payload.attempt === 'number' && payload.attempt === attempt) matches.push({ row, payload });
        }
        if (matches.length !== 1 || matches[0].row.event_id !== expectedId || matches[0].row.job_id !== session.job_id ||
            matches[0].row.type !== 'session.message_delivery_uncertain' ||
            Object.keys(matches[0].payload).sort().join(',') !== 'attempt,error,idempotencyKey,markedAt,messageId,outcome,phase,recipientRole,sessionId' ||
            matches[0].payload.sessionId !== message.session_id || matches[0].payload.recipientRole !== message.recipient_role ||
            matches[0].payload.idempotencyKey !== message.message_id || matches[0].payload.outcome !== 'unknown' ||
            message.last_error !== `DELIVERY_UNCERTAIN: phase=${matches[0].payload.phase}; attempt=${attempt}; ${matches[0].payload.error}`) {
          throw new Error('existing delivery-uncertain status does not reconcile to one exact durable uncertainty event');
        }
        this.db.exec('RELEASE SAVEPOINT session_delivery_uncertain_transition');
        return message;
      }
      const ts = now();
      const changed = this.db.prepare(`UPDATE session_messages SET status='FAILED',last_error=?,lease_until=NULL,updated_at=?
        WHERE message_id=? AND status=? AND attempt=? AND lease_until IS ?`)
        .run(uncertainError, ts, messageId, message.status, message.attempt, message.lease_until ?? null);
      if (changed.changes !== 1) throw new Error(`delivery-uncertain marking lost ownership of message ${messageId}`);
      const payload = {
        messageId, sessionId: message.session_id, recipientRole: message.recipient_role,
        attempt, phase: normalizedPhase, outcome: 'unknown',
        idempotencyKey: message.message_id, error: errorText, markedAt: ts
      };
      const key = `${messageId}|${attempt}`;
      const expectedId = eventId(session.job_id, 'session.message_delivery_uncertain', key);
      this.recordEvent(session.job_id, 'session.message_delivery_uncertain', payload, key);
      const rows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_delivery_uncertain'").all(session.job_id);
      const matches = [];
      for (const row of rows) {
        let existing;
        try { existing = parseStrictJson(row.payload_json); }
        catch { throw new Error('delivery-uncertain event ledger contains malformed JSON'); }
        if (row.payload_json !== JSON.stringify(existing)) throw new Error('delivery-uncertain event ledger contains non-canonical JSON');
        if (existing?.messageId === messageId && typeof existing.attempt === 'number' && existing.attempt === attempt) matches.push({ row, payload: existing });
      }
      const persisted = this.getSessionMessage(messageId);
      if (matches.length !== 1 || matches[0].row.event_id !== expectedId || matches[0].row.job_id !== session.job_id ||
          matches[0].row.type !== 'session.message_delivery_uncertain' || matches[0].row.payload_json !== JSON.stringify(payload) ||
          persisted?.status !== 'FAILED' ||
          persisted.last_error !== uncertainError || persisted.lease_until !== null || typeof persisted.attempt !== 'number' || persisted.attempt !== attempt) {
        throw new Error('delivery-uncertain state/event readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT session_delivery_uncertain_transition');
      return persisted;
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT session_delivery_uncertain_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT session_delivery_uncertain_transition'); } catch {}
      // Best-effort fail-closed fallback: even if the uncertainty event itself
      // cannot be written, durably prevent automatic replay of the attempt whose
      // external side effect may already have happened. This is not joint
      // transactionality across SQLite and the external transport.
      try {
        const current = this.getSessionMessage(messageId);
        if (current && typeof current.attempt === 'number' && current.attempt === attempt && current.status === 'DELIVERED') {
          const fallbackError = `DELIVERY_UNCERTAIN: phase=${normalizedPhase}; durable uncertainty event failed; ${errorText}; ledgerError=${String(failure?.message || failure).slice(0, 300)}`;
          this.db.prepare("UPDATE session_messages SET status='FAILED',last_error=?,lease_until=NULL,updated_at=? WHERE message_id=? AND status='DELIVERED' AND attempt=?")
            .run(fallbackError, now(), messageId, attempt);
        }
      } catch {}
      throw failure;
    }
  }

  retrySessionMessage(messageId, { error = 'delivery lease expired', delayMs = null, maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 60_000 } = {}) {
    this.db.exec('SAVEPOINT retry_session_message_transition');
    try {
      const reservation = this.db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT retry_session_message_transition');
        return null;
      }
      const message = this.getSessionMessage(messageId);
      if (!message) {
        this.db.exec('RELEASE SAVEPOINT retry_session_message_transition');
        return null;
      }
      if (message.status === 'ACKED') {
        // Stale retry/reaper callbacks must not silently bless a corrupted
        // terminal ACK projection; reuse the exact idempotent ACK verifier.
        this.ackSessionMessage(messageId, { recipientRole: message.recipient_role });
        this.db.exec('RELEASE SAVEPOINT retry_session_message_transition');
        return message;
      }
      if (message.last_error?.startsWith('DELIVERY_UNCERTAIN:') || !['DELIVERED', 'FAILED'].includes(message.status)) {
        this.db.exec('RELEASE SAVEPOINT retry_session_message_transition');
        return message;
      }
      if (typeof message.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 1) {
        throw new Error(`session retry refuses a malformed durable delivery attempt: ${messageId}`);
      }
      const session = this.getSession(message.session_id);
      if (!session) throw new Error(`session missing during delivery retry: ${messageId}`);
      const logicalEvent = (type, key, payload) => {
        const expectedId = eventId(session.job_id, type, key);
        const rows = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type=?').all(session.job_id, type);
        const matches = [];
        for (const row of rows) {
          let eventPayload;
          try { eventPayload = parseStrictJson(row.payload_json); }
          catch { throw new Error(`session retry found malformed ${type} event JSON`); }
          if (row.payload_json !== JSON.stringify(eventPayload)) throw new Error(`session retry found non-canonical ${type} event JSON`);
          const sameLogicalTransition = eventPayload?.messageId === messageId &&
            typeof eventPayload.attempt === 'number' && eventPayload.attempt === payload.attempt &&
            (type !== 'session.message_retry' || eventPayload?.availableAt === payload.availableAt);
          if (sameLogicalTransition) matches.push({ row, payload: eventPayload });
        }
        if (matches.length > 1) throw new Error(`session retry found duplicate logical ${type} events`);
        if (matches.length === 1) {
          const { row, payload: storedPayload } = matches[0];
          if (row.event_id !== expectedId || row.job_id !== session.job_id || row.type !== type ||
              row.payload_json !== JSON.stringify(payload) || JSON.stringify(storedPayload) !== JSON.stringify(payload)) {
            throw new Error(`session retry existing ${type} event conflicts with exact durable transition payload`);
          }
        } else {
          const occupied = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(expectedId);
          if (occupied) throw new Error(`session retry deterministic ${type} event ID is occupied by conflicting evidence`);
          this.recordEvent(session.job_id, type, payload, key);
          if (process.env.NODE_ENV === 'test' && type === 'session.message_retry' &&
              process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RETRY_EVENT_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
        }
        const finalRows = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type=?').all(session.job_id, type);
        const finalMatches = finalRows.filter(row => {
          try {
            const stored = parseStrictJson(row.payload_json);
            return stored?.messageId === messageId && typeof stored.attempt === 'number' && stored.attempt === payload.attempt &&
              (type !== 'session.message_retry' || stored?.availableAt === payload.availableAt);
          } catch { return false; }
        });
        if (finalMatches.length !== 1 || finalMatches[0].event_id !== expectedId || finalMatches[0].job_id !== session.job_id ||
            finalMatches[0].type !== type || finalMatches[0].payload_json !== JSON.stringify(payload)) {
          throw new Error(`session retry ${type} event readback/cardinality failed`);
        }
      };

      const max = Math.max(1, Number(maxAttempts) || 5);
      if (message.attempt >= max) {
        const failureReason = message.last_error || error;
        const failedAt = now();
        const update = this.db.prepare(`UPDATE session_messages SET status='FAILED',last_error=?,lease_until=NULL,updated_at=?
          WHERE message_id=? AND status=? AND attempt=? AND COALESCE(last_error,'') NOT LIKE 'DELIVERY_UNCERTAIN:%'`)
          .run(failureReason, failedAt, messageId, message.status, message.attempt);
        if (update.changes !== 1) throw new Error(`session message failure terminalization lost attempt ownership: ${messageId}`);
        if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RETRY_STATE_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
        const current = this.getSessionMessage(messageId);
        logicalEvent('session.message_failed', `${messageId}|${current.attempt}`, {
          messageId, sessionId: session.session_id, attempt: current.attempt, error: failureReason
        });
        const persisted = this.getSessionMessage(messageId);
        if (persisted?.status !== 'FAILED' || typeof persisted.attempt !== 'number' || persisted.attempt !== message.attempt ||
            persisted.last_error !== failureReason || persisted.lease_until !== null) {
          throw new Error(`session failed-message exact state readback failed: ${messageId}`);
        }
        this.db.exec('RELEASE SAVEPOINT retry_session_message_transition');
        return persisted;
      }

      const ts = now();
      const attempt = message.attempt;
      const explicitDelay = delayMs === null || delayMs === undefined ? null : Math.max(0, Number(delayMs) || 0);
      const base = Math.max(0, Number(baseDelayMs) || 0);
      const cap = Math.max(base, Number(maxDelayMs) || 60_000);
      const retryDelay = explicitDelay === null ? Math.min(cap, base * (2 ** Math.max(0, attempt - 1))) : explicitDelay;
      const availableAt = new Date(Date.now() + retryDelay).toISOString();
      const changed = this.db.prepare(`UPDATE session_messages SET status='QUEUED',available_at=?,lease_until=NULL,last_error=?,updated_at=?
        WHERE message_id=? AND status=? AND attempt=? AND COALESCE(last_error,'') NOT LIKE 'DELIVERY_UNCERTAIN:%'`)
        .run(availableAt, error, ts, messageId, message.status, message.attempt);
      if (changed.changes !== 1) throw new Error(`session retry lost compare-and-set ownership of ${messageId}`);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RETRY_STATE_UPDATE === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const updated = this.getSessionMessage(messageId);
      logicalEvent('session.message_retry', `${messageId}|${updated.attempt}|${availableAt}`, {
        messageId, sessionId: session.session_id, attempt: updated.attempt, availableAt, error
      });
      const persisted = this.getSessionMessage(messageId);
      if (persisted?.status !== 'QUEUED' || typeof persisted.attempt !== 'number' || persisted.attempt !== message.attempt ||
          persisted.available_at !== availableAt || persisted.lease_until !== null || persisted.last_error !== error) {
        throw new Error(`session retry exact state readback failed: ${messageId}`);
      }
      this.db.exec('RELEASE SAVEPOINT retry_session_message_transition');
      return persisted;
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT retry_session_message_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT retry_session_message_transition'); } catch {}
      throw failure;
    }
  }
  retryExpiredSessionMessages({ sessionId = null, maxAttempts = 5, baseDelayMs = 0, maxDelayMs = 60_000 } = {}) {
    const ts = now();
    const rows = this.db.prepare(`SELECT message_id,session_id,recipient_role,attempt,lease_until FROM session_messages
      WHERE status = 'DELIVERED' AND lease_until IS NOT NULL AND lease_until <= ? ${sessionId ? 'AND session_id = ?' : ''}
      ORDER BY updated_at, rowid`).all(...(sessionId ? [ts, sessionId] : [ts]));
    for (const row of rows) {
      if (typeof row.attempt !== 'number' || !Number.isSafeInteger(row.attempt) || row.attempt < 1) {
        throw new Error(`expired session message has a malformed durable attempt; recovery refuses retry: ${row.message_id}`);
      }
      const session = this.getSession(row.session_id);
      if (!session) continue;
      const startKey = `${row.message_id}|${row.attempt}`;
      const expectedStartId = eventId(session.job_id, 'session.message_delivery_started', startKey);
      const startRows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_delivery_started'").all(session.job_id);
      const starts = [];
      let malformed = false;
      for (const event of startRows) {
        let payload;
        try { payload = parseStrictJson(event.payload_json); }
        catch { malformed = true; break; }
        if (event.payload_json !== JSON.stringify(payload)) { malformed = true; break; }
        if (payload?.messageId === row.message_id && typeof payload.attempt === 'number' && payload.attempt === row.attempt) starts.push({ event, payload });
      }
      if (malformed || starts.length > 1 || (starts.length === 1 &&
          (starts[0].event.event_id !== expectedStartId || starts[0].event.job_id !== session.job_id ||
           starts[0].event.type !== 'session.message_delivery_started'))) {
        this.markSessionMessageDeliveryUncertain(row.message_id, { attempt: row.attempt,
          phase: 'recovery_found_corrupt_delivery_started_ledger', error: 'delivery-start event lineage is malformed or duplicated' });
        continue;
      }
      if (starts.length === 1) {
        const current = this.getSessionMessage(row.message_id);
        if (current?.status === 'DELIVERED' && typeof current.attempt === 'number' && current.attempt === row.attempt) {
          try {
            const recoveredAck = this.ackSessionMessage(row.message_id, {
              recipientRole: row.recipient_role, expectedAttempt: row.attempt, expectedLeaseUntil: row.lease_until,
              allowExpiredLeaseWithDurableReceipt: true
            });
            if (recoveredAck?.status === 'ACKED') continue;
          } catch (error) {
            // A valid durable successful transport receipt may let recovery
            // finalize ACK locally without reissuing the remote side effect.
            // If that lineage is absent/corrupt, fall through to uncertain.
            row.recoveryReceiptError = String(error?.message || error).slice(0, 500);
          }
        }
        // Once the transport-start intent is durable, a process crash/timeout
        // cannot prove whether the external service accepted the request.
        // Fail closed rather than blindly retrying a possible duplicate side effect.
        this.markSessionMessageDeliveryUncertain(row.message_id, { attempt: row.attempt, leaseUntil: row.lease_until,
          phase: 'delivery_lease_expired_after_transport_start',
          error: row.recoveryReceiptError || 'worker lease expired after transport start; external outcome not durably acknowledged' });
      } else {
        // No transport-start marker means the managed delivery method never
        // crossed the side-effect boundary; this lease can be safely reclaimed.
        this.retrySessionMessage(row.message_id, { error: 'delivery lease expired before transport start', maxAttempts, baseDelayMs, maxDelayMs });
      }
    }
    return rows.length;
  }
  reconcileSessionDelivery({ sessionId = null, maxAttempts = 5, baseDelayMs = 0, maxDelayMs = 60_000 } = {}) {
    return this.retryExpiredSessionMessages({ sessionId, maxAttempts, baseDelayMs, maxDelayMs });
  }
  recordSessionDeliveryReceipt(messageId, { attempt, status, runId = null, sessionKey = null, response = null, error = null } = {}) {
    this.db.exec('SAVEPOINT session_delivery_receipt_transition');
    try {
      if (!['OK', 'EMPTY', 'ERROR'].includes(status)) throw new Error(`unsupported session delivery receipt status: ${status}`);
      const reservation = this.db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) throw new Error(`session message missing during delivery receipt: ${messageId}`);
      const message = this.getSessionMessage(messageId);
      const exactAttempt = attempt == null ? message?.attempt : attempt;
      if (typeof message?.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 1 ||
          typeof exactAttempt !== 'number' || !Number.isSafeInteger(exactAttempt) || exactAttempt !== message.attempt ||
          !['DELIVERED', 'ACKED'].includes(message.status)) {
        throw new Error(`session delivery receipt belongs to stale attempt or message state: ${messageId}`);
      }
      if (status === 'OK' && !(typeof runId === 'string' && runId.trim().length > 0)) {
        throw new Error('successful session delivery receipt requires a correlated non-empty string runId; sessionKey alone is not delivery proof');
      }
      if (sessionKey !== null && sessionKey !== undefined && (typeof sessionKey !== 'string' || !sessionKey.trim())) {
        throw new Error('session delivery receipt sessionKey must be a non-empty opaque string or null');
      }
      const session = this.getSession(message.session_id);
      if (!session) throw new Error(`session missing during delivery receipt: ${messageId}`);
      if (status === 'OK' && runId !== null && runId !== undefined && String(runId).trim()) {
        for (const prior of this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_receipt'").all(session.job_id)) {
          let priorPayload;
          try { priorPayload = parseStrictJson(prior.payload_json); }
          catch { throw new Error('session delivery receipt replay check found malformed receipt event'); }
          if (prior.payload_json !== JSON.stringify(priorPayload)) throw new Error('session delivery receipt replay check found non-canonical receipt event');
          if (String(priorPayload?.runId ?? '') === String(runId) &&
              (priorPayload.messageId !== messageId || typeof priorPayload.attempt !== 'number' || priorPayload.attempt !== exactAttempt)) {
            throw new Error(`OpenClaw run ID ${String(runId)} was replayed across distinct session delivery attempts`);
          }
        }
      }
      const key = `${messageId}|${exactAttempt}|${status}`;
      const expectedId = eventId(session.job_id, 'session.message_receipt', key);
      const rows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='session.message_receipt'").all(session.job_id);
      const matches = [];
      for (const row of rows) {
        let payload;
        try { payload = parseStrictJson(row.payload_json); }
        catch { throw new Error('session delivery receipt found malformed receipt event'); }
        if (row.payload_json !== JSON.stringify(payload)) throw new Error('session delivery receipt found non-canonical receipt event JSON');
        if (payload?.messageId === messageId && typeof payload.attempt === 'number' && payload.attempt === exactAttempt && payload?.status === status) matches.push({ row, payload });
      }
      if (matches.length > 1) throw new Error('session delivery receipt has duplicate durable logical events');
      const expectedFields = { messageId, attempt: exactAttempt, status, runId, sessionKey, response, error };
      if (matches.length === 1) {
        const { row, payload } = matches[0];
        if (row.event_id !== expectedId || row.job_id !== session.job_id || row.type !== 'session.message_receipt' ||
            Object.keys(payload).sort().join(',') !== 'attempt,error,messageId,recordedAt,response,runId,sessionKey,status' ||
            payload.messageId !== expectedFields.messageId || payload.attempt !== expectedFields.attempt || payload.status !== expectedFields.status ||
            payload.runId !== expectedFields.runId || payload.sessionKey !== expectedFields.sessionKey ||
            JSON.stringify(payload.response) !== JSON.stringify(expectedFields.response) || payload.error !== expectedFields.error ||
            typeof payload.recordedAt !== 'string' || !Number.isFinite(Date.parse(payload.recordedAt)) ||
            new Date(Date.parse(payload.recordedAt)).toISOString() !== payload.recordedAt) {
          throw new Error('session delivery receipt replay conflicts with exact durable receipt lineage');
        }
        this.db.exec('RELEASE SAVEPOINT session_delivery_receipt_transition');
        return payload;
      }
      const receipt = { ...expectedFields, recordedAt: now() };
      this.recordEvent(session.job_id, 'session.message_receipt', receipt, key);
      const row = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(expectedId);
      if (!row || row.job_id !== session.job_id || row.type !== 'session.message_receipt' || row.payload_json !== JSON.stringify(receipt)) {
        throw new Error('session delivery receipt exact event readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT session_delivery_receipt_transition');
      return receipt;
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT session_delivery_receipt_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT session_delivery_receipt_transition'); } catch {}
      throw failure;
    }
  }
  recordSessionDeliveryStarted(messageId, { attempt, leaseUntil = null } = {}) {
    this.db.exec('SAVEPOINT session_delivery_started_transition');
    try {
      const reservation = this.db.prepare('UPDATE session_messages SET updated_at=updated_at WHERE message_id=?').run(messageId);
      if (reservation.changes !== 1) throw new Error(`session message missing before transport start: ${messageId}`);
      const message = this.getSessionMessage(messageId);
      if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 ||
          typeof message?.attempt !== 'number' || !Number.isSafeInteger(message.attempt) || message.attempt < 1 ||
          message.status !== 'DELIVERED' || message.attempt !== attempt ||
          !message.lease_until || message.lease_until <= now() || (leaseUntil !== null && message.lease_until !== leaseUntil)) {
        throw new Error(`session transport start does not own the exact live delivery lease: ${messageId}`);
      }
      const session = this.getSession(message.session_id);
      if (!session) throw new Error(`session not found before transport start: ${messageId}`);
      const key = `${messageId}|${attempt}`;
      const expectedId = eventId(session.job_id, 'session.message_delivery_started', key);
      const prior = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(expectedId);
      if (prior) {
        let priorPayload;
        try { priorPayload = parseStrictJson(prior.payload_json); }
        catch { throw new Error('session transport-start idempotency key contains malformed durable event'); }
        if (prior.job_id !== session.job_id || prior.type !== 'session.message_delivery_started' ||
            prior.payload_json !== JSON.stringify(priorPayload) ||
            Object.keys(priorPayload).sort().join(',') !== 'attempt,idempotencyKey,leaseUntil,messageId,recipientRole,sessionId,startedAt' ||
            priorPayload.messageId !== messageId || typeof priorPayload.attempt !== 'number' || priorPayload.attempt !== attempt ||
            priorPayload.sessionId !== message.session_id || priorPayload.recipientRole !== message.recipient_role ||
            priorPayload.leaseUntil !== message.lease_until || priorPayload.idempotencyKey !== message.message_id ||
            typeof priorPayload.startedAt !== 'string') throw new Error('session transport-start idempotency key conflicts with durable event');
        this.db.exec('RELEASE SAVEPOINT session_delivery_started_transition');
        return priorPayload;
      }
      this.assertSessionPermission(message.session_id, message.recipient_role, 'MESSAGE');
      const payload = { messageId, sessionId: message.session_id, recipientRole: message.recipient_role,
        attempt, leaseUntil: message.lease_until, idempotencyKey: message.message_id, startedAt: now() };
      this.recordEvent(session.job_id, 'session.message_delivery_started', payload, key);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_DELIVERY_STARTED_EVENT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(expectedId);
      if (!event || event.job_id !== session.job_id || event.type !== 'session.message_delivery_started' ||
          event.payload_json !== JSON.stringify(payload)) throw new Error('session transport-start event exact readback failed');
      this.db.exec('RELEASE SAVEPOINT session_delivery_started_transition');
      return payload;
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT session_delivery_started_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT session_delivery_started_transition'); } catch {}
      throw failure;
    }
  }
  deliverSessionMessage(messageId, transport, { maxAttempts = 5, retryDelayMs = 1000, retryMaxDelayMs = 60_000, timeoutSeconds = 120, leaseMs = null } = {}) {
    const message = this.getSessionMessage(messageId);
    if (!message) return Promise.resolve(null);
    const session = this.getSession(message.session_id);
    if (!session) return Promise.reject(new Error(`Session not found: ${message.session_id}`));
    const recipientRole = message.recipient_role;
    // The OpenClaw transport's effective timeout is max(5s, timeoutSeconds+5s),
    // followed by a termination grace period before its promise settles. The
    // lease must outlive that complete local deadline or another process can
    // quarantine an in-flight send before it returns its receipt. Keep an
    // additional 5s scheduling/SQLite margin; this fences local recovery only
    // and cannot make the remote side effect atomic with SQLite.
    const requestedTimeoutSeconds = Number(timeoutSeconds);
    const effectiveTimeoutSeconds = Number.isFinite(requestedTimeoutSeconds) && requestedTimeoutSeconds > 0
      ? requestedTimeoutSeconds : 120;
    const transportDeadlineMs = Math.max(5_000, effectiveTimeoutSeconds * 1000 + 5_000);
    const minimumLeaseMs = transportDeadlineMs + 5_000;
    const requestedLeaseMs = Number(leaseMs);
    const effectiveLeaseMs = Number.isFinite(requestedLeaseMs) && requestedLeaseMs > 0
      ? Math.max(minimumLeaseMs, requestedLeaseMs) : minimumLeaseMs;
    const claimed = this.claimSessionMessage(messageId, { recipientRole, leaseMs: effectiveLeaseMs });
    if (!claimed || claimed.status !== 'DELIVERED' || claimed.claimAcquired !== true) return Promise.resolve(claimed);
    const context = { timeoutSeconds: effectiveTimeoutSeconds, idempotencyKey: message.message_id,
      deliveryAttempt: claimed.attempt, leaseUntil: claimed.lease_until };
    return Promise.resolve().then(async () => {
      try {
        this.recordSessionDeliveryStarted(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until });
      } catch (error) {
        // The transport has not been called yet, so no external side effect has
        // occurred in this managed path. A safely retriable local setup failure
        // may release the lease; if reconciliation cannot prove pre-send state,
        // keep the failure explicit and avoid issuing the external request.
        try {
          return this.retrySessionMessage(messageId, { error: `transport start ledger failed before send: ${error?.message || error}`,
            maxAttempts, baseDelayMs: retryDelayMs, maxDelayMs: retryMaxDelayMs });
        } catch (retryError) {
          throw new AggregateError([error, retryError], `transport was not invoked but lease recovery failed: ${messageId}`);
        }
      }
      let receipt;
      try {
        receipt = await transport(session, claimed, context);
      } catch (error) {
        const transportCode = error?.transportCode || error?.code || 'TRANSPORT_ERROR';
        const messageText = `${transportCode}: ${error?.message || error}`;
        // Retrying is safe only when the transport explicitly certifies that no
        // remote side effect occurred. A timeout/disconnect after request send
        // is ambiguous and must not silently replay the external operation.
        if (error?.deliveryOutcome === 'not_sent' || error?.externalSideEffectCommitted === false) {
          try { this.recordSessionDeliveryReceipt(messageId, { attempt: claimed.attempt, status: 'ERROR', runId: null,
            sessionKey: session.openclaw_session_key, response: null, error: messageText }); } catch {}
          return this.retrySessionMessage(messageId, { error: messageText, maxAttempts,
            baseDelayMs: retryDelayMs, maxDelayMs: retryMaxDelayMs });
        }
        try {
          return this.markSessionMessageDeliveryUncertain(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until,
            phase: 'transport_outcome_unknown', error: messageText });
        } catch (ledgerError) {
          throw new AggregateError([error, ledgerError], `external delivery outcome is unknown and could not be durably marked: ${messageId}`);
        }
      }
      const reportedReceiptStatus = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
        ? String(receipt.status || '').toUpperCase() : '';
      let receiptStatus = ['OK', 'ERROR', 'EMPTY'].includes(reportedReceiptStatus)
        ? reportedReceiptStatus : 'ERROR';
      let receiptValidationError = null;
      if (receiptStatus === 'OK') {
        const returnedRunId = receipt.runId;
        const hasSessionKey = receipt.sessionKey !== null && receipt.sessionKey !== undefined;
        const returnedSessionKey = typeof receipt.sessionKey === 'string' && receipt.sessionKey.trim() ? receipt.sessionKey : null;
        const hasRunId = typeof returnedRunId === 'string' && returnedRunId.trim().length > 0;
        if (hasSessionKey && !returnedSessionKey) {
          receiptStatus = 'ERROR';
          receiptValidationError = 'OpenClaw receipt sessionKey must be a non-empty opaque string; remote outcome is ambiguous';
        } else if (returnedSessionKey && returnedSessionKey !== session.openclaw_session_key) {
          receiptStatus = 'ERROR';
          receiptValidationError = 'OpenClaw receipt sessionKey does not match the target session; remote outcome is ambiguous';
        } else if (!hasRunId) {
          receiptStatus = 'ERROR';
          receiptValidationError = 'OpenClaw success receipt lacks a valid non-empty string runId; sessionKey alone does not prove this delivery attempt and remote outcome is ambiguous';
        }
      }
      if (receiptStatus === 'ERROR' || receiptStatus === 'EMPTY') {
        const receiptError = receipt?.error || receiptValidationError || (receiptStatus === 'EMPTY'
          ? 'transport returned an empty response; remote acceptance is not established'
          : 'transport returned a missing, malformed, unknown, or explicit error receipt; remote side effects are not ruled out');
        try {
          this.recordSessionDeliveryReceipt(messageId, {
            attempt: claimed.attempt, status: receiptStatus,
            runId: typeof receipt?.runId === 'string' && receipt.runId.trim() ? receipt.runId : null,
            sessionKey: typeof receipt?.sessionKey === 'string' && receipt.sessionKey.trim() ? receipt.sessionKey : session.openclaw_session_key,
            response: receipt?.result ?? receipt?.payload ?? receipt?.raw ?? null, error: receiptError
          });
        } catch (recordError) {
          // A returned error/empty receipt does not prove that the remote side
          // effect did not occur. Preserve fail-closed uncertainty even if its
          // diagnostic receipt cannot be committed.
          try {
            return this.markSessionMessageDeliveryUncertain(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until,
              phase: 'non_success_receipt_persistence_failed', error: `${receiptError}; receiptError=${recordError?.message || recordError}` });
          } catch (ledgerError) {
            throw new AggregateError([recordError, ledgerError], `non-success transport receipt and uncertainty could not be persisted: ${messageId}`);
          }
        }
        return this.markSessionMessageDeliveryUncertain(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until,
          phase: 'transport_returned_non_success_receipt', error: receiptError });
      }
      try {
        this.recordSessionDeliveryReceipt(messageId, {
          attempt: claimed.attempt, status: receipt?.status || 'OK', runId: receipt?.runId || null,
          sessionKey: receipt?.sessionKey || session.openclaw_session_key,
          response: receipt?.result ?? receipt?.payload ?? receipt?.raw ?? null, error: null
        });
      } catch (error) {
        try {
          return this.markSessionMessageDeliveryUncertain(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until,
            phase: 'success_receipt_persistence_failed', error });
        } catch (ledgerError) {
          throw new AggregateError([error, ledgerError], `delivery succeeded remotely but receipt/uncertainty persistence failed: ${messageId}`);
        }
      }
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RECEIPT_COMMIT === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
      try {
        return this.ackSessionMessage(messageId, { recipientRole, expectedAttempt: claimed.attempt, expectedLeaseUntil: claimed.lease_until });
      } catch (error) {
        try {
          return this.markSessionMessageDeliveryUncertain(messageId, { attempt: claimed.attempt, leaseUntil: claimed.lease_until,
            phase: 'ack_persistence_failed_after_remote_success', error });
        } catch (ledgerError) {
          throw new AggregateError([error, ledgerError], `delivery succeeded remotely but ACK/uncertainty persistence failed: ${messageId}`);
        }
      }
    });
  }
  markStaleAgentSessions(maxAgeMs = 5 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.db.prepare("SELECT * FROM agent_sessions WHERE state = 'ACTIVE' AND last_activity_at < ?").all(cutoff);
    const ts = now();
    for (const row of rows) {
      this.db.prepare("UPDATE agent_sessions SET state = 'STALE', updated_at = ? WHERE session_id = ? AND state = 'ACTIVE'").run(ts, row.session_id);
      this.recordEvent(row.job_id, 'session.stale', { sessionId: row.session_id, taskId: row.task_id, lastActivityAt: row.last_activity_at }, row.session_id);
    }
    return rows.length;
  }
  markAgentSessionStale(sessionId, { reason = 'runtime session no longer active' } = {}) {
    const session = this.getSession(sessionId); if (!session) return null;
    if (['TERMINATED', 'FAILED', 'STALE'].includes(session.state)) return session;
    const ts = now();
    this.db.prepare("UPDATE agent_sessions SET state = 'STALE', updated_at = ? WHERE session_id = ? AND state IN ('ACTIVE','CREATED','PAUSED')").run(ts, sessionId);
    const updated = this.getSession(sessionId);
    if (updated?.state === 'STALE') {
      this.recordEvent(updated.job_id, 'session.stale', {
        sessionId, taskId: updated.task_id, lastActivityAt: updated.last_activity_at, reason
      }, `${sessionId}|stale|${reason}`);
    }
    return updated;
  }
  beginAgentRetry(taskId, { actorRole, reason = 'same-task runtime retry' } = {}) {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('retry taskId must be a non-empty string');
    if (typeof actorRole !== 'string' || !actorRole.trim()) throw new Error('retry actorRole must be a non-empty string');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('retry reason must be a non-empty string');
    // Take the SQLite writer reservation before reading permission/session/task
    // state. Otherwise a concurrent permission revocation or takeover can race
    // the preflight reads, and failures midway can persist only part of a retry.
    this.db.exec('SAVEPOINT begin_agent_retry_transition');
    try {
      const taskLock = this.db.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=?').run(taskId);
      if (taskLock.changes !== 1) throw new Error(`task not found: ${taskId}`);
      const task = this.getTask(taskId);
      const job = task ? this.getJob(task.job_id) : null;
      if (!task || !job || job.status !== 'active' || job.state !== 'EXECUTING') {
        throw new Error(`task retry requires an existing task in an EXECUTING job: ${task?.job_id || taskId}`);
      }
      if (!['failed', 'pending', 'running'].includes(task.status)) {
        throw new Error(`task retry is not allowed from task status ${task.status}`);
      }
      const sessionCandidate = this.getSessionByTask(taskId);
      if (!sessionCandidate) throw new Error(`agent session not found for task: ${taskId}`);
      const sessionLock = this.db.prepare('UPDATE agent_sessions SET updated_at=updated_at WHERE session_id=?').run(sessionCandidate.session_id);
      if (sessionLock.changes !== 1) throw new Error(`agent session disappeared during retry: ${taskId}`);
      const session = this.getSession(sessionCandidate.session_id);
      if (!session || session.task_id !== taskId || session.job_id !== task.job_id) {
        throw new Error(`agent session/task binding changed during retry: ${taskId}`);
      }
      // Permission is deliberately rechecked after the writer lock is acquired.
      this.assertSessionPermission(session.session_id, actorRole, 'TAKEOVER');
      if (!['STALE', 'FAILED', 'PAUSED'].includes(session.state)) {
        throw new Error(`same-task retry requires STALE, FAILED, or PAUSED session; got ${session.state}`);
      }
      const activeLease = this.db.prepare("SELECT lease_id,attempt,owner_epoch,expires_at FROM task_leases WHERE task_id=? AND state='ACTIVE' ORDER BY issued_at DESC LIMIT 1").get(taskId);
      if (activeLease) {
        throw new Error(`same-task retry requires the prior task lease to be settled or quarantined: ${activeLease.lease_id}`);
      }
      const taskAttempt = task.execution_attempt ?? 0;
      const sessionAttempt = session.attempt;
      if (!Number.isSafeInteger(taskAttempt) || taskAttempt < 0 ||
          !Number.isSafeInteger(sessionAttempt) || sessionAttempt < 1) {
        throw new Error('malformed durable retry attempt identity; refusing retry');
      }
      const activeAttempts = this.db.prepare("SELECT attempt_id,openclaw_run_id,started_at FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC,rowid DESC")
        .all(taskId);
      if (activeAttempts.length > 1) throw new Error(`task has multiple unresolved runtime attempts; refusing same-task retry: ${taskId}`);
      const priorAttempt = activeAttempts[0] || null;
      if (priorAttempt && (priorAttempt.openclaw_run_id || null) !== (task.openclaw_run_id || null)) {
        throw new Error(`stale runtime attempt identity does not match the task binding: ${taskId}`);
      }
      const baseAttempt = Math.max(taskAttempt, sessionAttempt);
      if (baseAttempt >= Number.MAX_SAFE_INTEGER) throw new Error('durable retry attempt identity is exhausted');
      const nextAttempt = baseAttempt + 1;
      this.takeoverAgentSession(session.session_id, { actorRole, reason });
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_AGENT_RETRY_TAKEOVER === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
      const ts = now();
      if (priorAttempt) {
        const priorError = `stale runtime attempt superseded by authorized retry ${nextAttempt}: ${reason}`;
        const priorUpdate = this.db.prepare("UPDATE attempts SET status='failed', finished_at=?, error=? WHERE attempt_id=? AND status='started'")
          .run(ts, priorError, priorAttempt.attempt_id);
        if (priorUpdate.changes !== 1) throw new Error('stale runtime attempt lost its terminalization compare-and-set');
        const failurePayload = {
          attemptId: priorAttempt.attempt_id, taskId, openclawRunId: priorAttempt.openclaw_run_id || null,
          failureClass: 'stale_runtime_recovered', nextAttempt, reason
        };
        const failureEventKey = `${priorAttempt.attempt_id}|failed`;
        const failureEventId = this.recordEvent(task.job_id, 'attempt.failed', failurePayload, failureEventKey);
        const failureEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(failureEventId);
        if (!failureEvent || failureEvent.event_id !== eventId(task.job_id, 'attempt.failed', failureEventKey) ||
            failureEvent.job_id !== task.job_id || failureEvent.type !== 'attempt.failed' || failureEvent.payload_json !== JSON.stringify(failurePayload)) {
          throw new Error('stale runtime attempt failure event lineage mismatch');
        }
      }
      const sessionUpdate = this.db.prepare("UPDATE agent_sessions SET attempt = ?, updated_at = ?, last_activity_at = ? WHERE session_id = ? AND state='ACTIVE'")
        .run(nextAttempt, ts, ts, session.session_id);
      if (sessionUpdate.changes !== 1) throw new Error('agent retry lost its active session compare-and-set');
      const taskUpdate = this.db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE task_id = ? AND job_id=? AND status IN ('failed','pending','running')")
        .run(ts, taskId, task.job_id);
      if (taskUpdate.changes !== 1) throw new Error('agent retry lost its task status compare-and-set');
      const attemptId = id('attempt');
      this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', ?, ?)")
        .run(attemptId, taskId, task.openclaw_run_id || null, ts);
      const payload = { taskId, sessionId: session.session_id, actorRole, attempt: nextAttempt, attemptId, reason };
      const dedupeKey = `${taskId}|retry|${nextAttempt}`;
      const retryEventId = this.recordEvent(task.job_id, 'task.retry_started', payload, dedupeKey);
      const retryEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(retryEventId);
      const retryEventRows = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='task.retry_started' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?")
        .all(task.job_id, taskId, nextAttempt);
      const persistedTask = this.getTask(taskId);
      const persistedSession = this.getSession(session.session_id);
      const attemptRecord = this.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
      const openAttemptRows = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC,rowid DESC").all(taskId);
      if (!retryEvent || retryEvent.event_id !== eventId(task.job_id, 'task.retry_started', dedupeKey) ||
          retryEvent.job_id !== task.job_id || retryEvent.type !== 'task.retry_started' || retryEvent.payload_json !== JSON.stringify(payload) ||
          retryEventRows.length !== 1 || persistedTask?.status !== 'running' || persistedSession?.state !== 'ACTIVE' ||
          persistedSession?.attempt !== nextAttempt || !attemptRecord || attemptRecord.status !== 'started' ||
          openAttemptRows.length !== 1 || openAttemptRows[0].attempt_id !== attemptId) {
        throw new Error('agent retry durable row/event readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT begin_agent_retry_transition');
      return { task: persistedTask, session: persistedSession, attempt: nextAttempt, attemptRecord };
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT begin_agent_retry_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT begin_agent_retry_transition'); } catch {}
      throw failure;
    }
  }
  createChildTask(jobId, { parentTaskId = null, role = 'unknown', description, dependencies = [], metadata = {} } = {}) {
    this.db.exec('SAVEPOINT create_child_task_fenced');
    try {
      const reservation = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(jobId);
      if (reservation.changes !== 1) throw new Error(`child task creation requires an existing active Job: ${jobId}`);
      const job = this.getJob(jobId);
      if (!job || job.status !== 'active' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase())) {
        throw new Error(`cannot create child task for terminal/inactive Job: ${jobId}`);
      }
      const task = this.createChildTaskLocked(jobId, { parentTaskId, role, description, dependencies, metadata });
      this.db.exec('RELEASE SAVEPOINT create_child_task_fenced');
      return task;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT create_child_task_fenced'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT create_child_task_fenced'); } catch {}
      throw error;
    }
  }
  createChildTaskLocked(jobId, { parentTaskId = null, role = 'unknown', description, dependencies = [], metadata = {} } = {}) {
    if (!description) throw new Error('child task description is required');
    const existing = this.db.prepare("SELECT * FROM tasks WHERE job_id = ? AND parent_task_id = ? AND role = ? AND description = ? AND status IN ('pending','running') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId, parentTaskId, role, description);
    if (existing) return existing;
    const job = this.getJob(jobId);
    const normalizedRole = String(role).toLowerCase();
    const supportedWorkflow = isSupportedWorkflow(job);
    const plan = supportedWorkflow ? this.getExecutionPlan(jobId) : null;
    if (supportedWorkflow && !plan) {
      throw new Error('immutable execution plan missing before production task creation: ' + jobId);
    }
    const requestedPlanTaskId = metadata?.workflow_plan_task_id;
    const plannedById = requestedPlanTaskId ? plan?.children?.find(item => item.id === requestedPlanTaskId) : null;
    const plannedByRole = plan?.children?.find(item => String(item.role).toLowerCase() === normalizedRole) || null;
    if (supportedWorkflow && requestedPlanTaskId && (!plannedById || !plannedByRole || plannedById.id !== plannedByRole.id)) {
      throw new Error('requested workflow_plan_task_id does not match the immutable plan entry for role ' + normalizedRole);
    }
    const plannedTask = plannedByRole || plannedById;
    if (supportedWorkflow && !plannedTask && String(role).toLowerCase() !== 'cto') {
      throw new Error('workflow role is absent from immutable execution plan: ' + normalizedRole);
    }
    const productionTask = plannedTask || null;
    const productionExecution = productionTask?.execution || null;
    const durableMetadata = productionTask
      ? { ...(productionExecution || {}), ...metadata, workflow_plan_task_id: productionTask.id }
      : metadata;
    const taskId = id('task'); const ts = now();
    this.db.prepare("INSERT INTO tasks(task_id, job_id, role, description, status, parent_task_id, dependency_json, metadata_json, created_at, updated_at) VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)").run(taskId, jobId, role, description, parentTaskId, JSON.stringify(dependencies), JSON.stringify(durableMetadata), ts, ts);
    this.recordEvent(jobId, 'task.created', { taskId, parentTaskId, role, description, dependencies }, taskId);
    return this.getTask(taskId);
  }
  beginLocalTask(taskId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`task not found: ${taskId}`);
      const job = this.getJob(task.job_id);
      if (job?.state !== 'EXECUTING' || job.status !== 'active') throw new Error(`local task requires an active executing Job: ${task.job_id}`);
      const metadata = parseStrictJson(task.metadata_json || '{}');
      if (metadata.deterministic) throw new Error(`deterministic task must use the local execution manager: ${taskId}`);
      if (task.status === 'running') {
        const activeAttempts = this.db.prepare("SELECT * FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC, rowid DESC").all(taskId);
        if (activeAttempts.length > 1) throw new Error(`local task has ambiguous active durable attempts: ${taskId}`);
        const active = activeAttempts[0] || null;
        if (active && !active.openclaw_run_id && !task.openclaw_session_key) {
          this.db.exec('COMMIT');
          return { task, attempt: active, idempotent: true };
        }
        throw new Error(`local task has an unresolved prior attempt: ${taskId}`);
      }
      if (task.status !== 'pending') throw new Error(`local task is not pending: ${taskId} (${task.status})`);
      const ts = now();
      const taskUpdate = this.db.prepare("UPDATE tasks SET status='running', updated_at=? WHERE task_id=? AND job_id=? AND status='pending'")
        .run(ts, taskId, task.job_id);
      if (taskUpdate.changes !== 1) throw new Error(`local task start lost its pending-task compare-and-set: ${taskId}`);
      const attemptId = id('attempt');
      this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', NULL, ?)").run(attemptId, taskId, ts);
      const eventPayload = { taskId, executor: 'chat-on-steroids-plugin', attemptId };
      const eventIdValue = this.recordEvent(task.job_id, 'task.local_started', eventPayload, attemptId);
      const persistedEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      if (!persistedEvent || persistedEvent.event_id !== eventId(task.job_id, 'task.local_started', attemptId) ||
          persistedEvent.job_id !== task.job_id || persistedEvent.type !== 'task.local_started' || persistedEvent.payload_json !== JSON.stringify(eventPayload)) {
        throw new Error(`local task start event lineage readback failed: ${taskId}`);
      }
      const result = { task: this.getTask(taskId), attempt: this.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attemptId), idempotent: false };
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  reviewerArtifactEvidence(task, plan, resultId) {
    const evidence = [resultId];
    if (String(task?.role || '').toLowerCase() !== 'reviewer' ||
        !['engineering', 'standard-engineering', 'hybrid-engineering'].includes(plan?.workflow_id) || plan.workflow_version < 2) return evidence;
    const children = this.db.prepare('SELECT * FROM tasks WHERE job_id=? AND parent_task_id=? ORDER BY created_at, rowid').all(task.job_id, task.parent_task_id);
    for (const type of getAgentInputArtifactTypes('reviewer')) {
      const producerSpec = plan.children.find(spec => {
        if (spec.execution?.output_artifact_type) return spec.execution.output_artifact_type === type;
        try { return getAgentArtifactType(spec.role) === type; } catch { return false; }
      });
      if (!producerSpec) throw new Error(`reviewer input ${type} has no producer in immutable workflow plan`);
      const producer = children.filter(child => {
        try { return parseStrictJson(child.metadata_json || '{}').workflow_plan_task_id === producerSpec.id; }
        catch { return false; }
      }).at(-1);
      if (!producer || producer.status !== 'completed' || producer.role !== producerSpec.role) {
        throw new Error(`reviewer input ${type} producer is not durably completed: ${producerSpec.id}`);
      }
      const results = this.db.prepare("SELECT result_id,task_id,outcome FROM results WHERE task_id=? AND outcome='success'").all(producer.task_id);
      if (results.length !== 1 || results[0].task_id !== producer.task_id) {
        throw new Error(`reviewer input ${type} requires exactly one successful durable producer result: ${producerSpec.id}`);
      }
      const artifacts = this.listArtifacts(task.job_id, { taskId: producer.task_id, activeOnly: true, type });
      if (artifacts.length !== 1) throw new Error(`reviewer input ${type} requires exactly one active typed artifact: ${producerSpec.id}`);
      const artifact = artifacts[0];
      validateArtifact(artifact);
      if (artifact.job_id !== task.job_id || artifact.task_id !== producer.task_id || artifact.producer_role !== producerSpec.role ||
          !Array.isArray(artifact.evidence) || !artifact.evidence.includes(results[0].result_id)) {
        throw new Error(`reviewer input ${type} artifact does not bind its successful producer result: ${producerSpec.id}`);
      }
      evidence.push(artifact.artifact_id);
    }
    return evidence;
  }

  completeLocalTask(taskId, { content, outcome = 'success', artifact = null, validateBeforeCommit = null } = {}) {
    if (!['success', 'failed'].includes(outcome)) throw new Error(`invalid local task outcome: ${outcome}`);
    if (validateBeforeCommit !== null && typeof validateBeforeCommit !== 'function') throw new Error('validateBeforeCommit must be a function');
    const resultOutcome = outcome === 'failed' ? 'failure' : 'success';
    const normalizedContent = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    if (!normalizedContent.trim()) throw new Error('local task result content is required');
    if (Buffer.byteLength(normalizedContent, 'utf8') > 1_000_000) throw new Error('local task result exceeds 1 MB');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTask(taskId);
      if (!task) throw new Error(`task not found: ${taskId}`);
      const job = this.getJob(task.job_id);
      if (job?.state !== 'EXECUTING' || job.status !== 'active') throw new Error(`local task result requires an active executing Job: ${task.job_id}`);
      const metadata = parseStrictJson(task.metadata_json || '{}');
      if (metadata.deterministic) throw new Error(`deterministic task result must come from actual local execution: ${taskId}`);
      if (outcome === 'success' && isSupportedWorkflow(job) && (!artifact || typeof artifact !== 'object' || Array.isArray(artifact))) {
        throw new Error(`successful local workflow task requires a typed artifact: ${taskId}`);
      }
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      const prior = this.db.prepare('SELECT result_id, outcome, content FROM results WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId);
        if (prior?.outcome === resultOutcome && prior?.content === normalizedContent) {
          // Result-content equality alone is not enough for idempotency: a
          // retry can carry a different typed artifact while reusing the same
          // result text. Never report that request as accepted unless its
          // artifact content and full durable lineage match the original.
          if (outcome === 'success' && isSupportedWorkflow(job)) {
            if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
              throw new Error(`idempotent local task retry requires its original typed artifact: ${taskId}`);
            }
            const plan = this.getExecutionPlan(task.job_id);
            const artifactType = plan?.children?.find(item => item.id === metadata.workflow_plan_task_id)?.execution?.output_artifact_type || metadata.output_artifact_type || getAgentArtifactType(task.role);
            const expectedArtifactId = `${artifactType}-${prior.result_id}`;
            const existingArtifact = this.getArtifact(expectedArtifactId);
            const expectedEvidence = this.reviewerArtifactEvidence(task, plan, prior.result_id);
            const expectedArtifact = createArtifactRecord({
              artifact_id: expectedArtifactId,
              job_id: task.job_id,
              task_id: taskId,
              type: artifactType,
              producer_role: task.role,
              content: artifact,
              evidence: expectedEvidence,
            });
            if (!existingArtifact || existingArtifact.job_id !== task.job_id ||
                existingArtifact.task_id !== taskId || existingArtifact.type !== artifactType ||
                existingArtifact.producer_role !== task.role ||
                existingArtifact.content_hash !== expectedArtifact.content_hash ||
                JSON.stringify(existingArtifact.evidence) !== JSON.stringify(expectedArtifact.evidence) ||
                existingArtifact.artifact_id !== expectedArtifactId) {
              throw new Error(`idempotent local task retry conflicts with its durable typed artifact: ${taskId}`);
            }
          }
          if (validateBeforeCommit) {
            const plan = this.getExecutionPlan(task.job_id);
            const artifactType = plan?.children?.find(item => item.id === metadata.workflow_plan_task_id)?.execution?.output_artifact_type || metadata.output_artifact_type || getAgentArtifactType(task.role);
            validateBeforeCommit({ task, resultId: prior.result_id, artifactId: outcome === 'success' && isSupportedWorkflow(job) ? `${artifactType}-${prior.result_id}` : null });
          }
          this.db.exec('COMMIT');
          // Return the durable identity on retries as well as first completion.
          // Callers use resultId to reconcile typed-artifact evidence and trace
          // lineage; returning null here made a successful idempotent retry look
          // like it had no result even though the transaction was already durable.
          return { task, resultId: prior.result_id, idempotent: true };
        }
        throw new Error(`local task already has a conflicting terminal result: ${taskId}`);
      }
      if (task.status !== 'running') throw new Error(`local task must be started before completion: ${taskId}`);
      const activeAttempts = this.db.prepare("SELECT * FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC, rowid DESC").all(taskId);
      if (activeAttempts.length !== 1) throw new Error(`local task requires exactly one active durable attempt: ${taskId}`);
      const active = activeAttempts[0];
      if (active.openclaw_run_id || task.openclaw_run_id || task.openclaw_session_key) throw new Error(`local task has no active plugin-owned attempt: ${taskId}`);
      const resultId = id('result');
      const ts = now();
      this.db.prepare('INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, ?, ?, ?)').run(resultId, taskId, resultOutcome, normalizedContent, ts);
      if (outcome === 'success' && isSupportedWorkflow(job)) {
        const planTask = this.getExecutionPlan(task.job_id)?.children?.find(item => item.id === metadata.workflow_plan_task_id);
        const artifactType = planTask?.execution?.output_artifact_type || metadata.output_artifact_type || getAgentArtifactType(task.role);
        const artifactEvidence = this.reviewerArtifactEvidence(task, this.getExecutionPlan(task.job_id), resultId);
        this.createArtifact({
          artifact_id: `${artifactType}-${resultId}`,
          job_id: task.job_id,
          task_id: taskId,
          type: artifactType,
          producer_role: task.role,
          content: artifact,
          evidence: artifactEvidence
        });
      }
      const taskUpdate = this.db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE task_id=? AND job_id=? AND status='running'")
        .run(outcome === 'success' ? 'completed' : 'failed', ts, taskId, task.job_id);
      if (taskUpdate.changes !== 1) throw new Error(`local task completion lost its task-state compare-and-set race: ${taskId}`);
      const attemptUpdate = this.db.prepare("UPDATE attempts SET status=?, finished_at=?, error=? WHERE attempt_id=? AND task_id=? AND status='started'")
        .run(outcome === 'success' ? 'completed' : 'failed', ts, outcome === 'failed' ? normalizedContent.slice(0, 2000) : null, active.attempt_id, taskId);
      if (attemptUpdate.changes !== 1) throw new Error(`local task completion lost its active-attempt compare-and-set: ${taskId}`);
      const eventType = outcome === 'success' ? 'task.local_completed' : 'task.local_failed';
      const eventPayload = { taskId, resultId, attemptId: active.attempt_id, executor: 'chat-on-steroids-plugin' };
      const eventIdValue = this.recordEvent(task.job_id, eventType, eventPayload, resultId);
      const persistedEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const matchingEvents = this.db.prepare('SELECT event_id FROM events WHERE job_id=? AND type=? AND json_extract(payload_json,\'$.resultId\')=?')
        .all(task.job_id, eventType, resultId);
      const persistedTask = this.getTask(taskId);
      const persistedAttempt = this.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(active.attempt_id);
      if (matchingEvents.length !== 1 || !persistedEvent || persistedEvent.event_id !== eventId(task.job_id, eventType, resultId) ||
          persistedEvent.job_id !== task.job_id || persistedEvent.type !== eventType || persistedEvent.payload_json !== JSON.stringify(eventPayload) ||
          persistedTask?.status !== (outcome === 'success' ? 'completed' : 'failed') ||
          persistedAttempt?.status !== (outcome === 'success' ? 'completed' : 'failed') || persistedAttempt.task_id !== taskId) {
        throw new Error(`local task completion result/attempt/event lineage readback failed: ${taskId}`);
      }
      if (validateBeforeCommit) {
        const metadata = parseStrictJson(task.metadata_json || '{}');
        const plan = this.getExecutionPlan(task.job_id);
        const artifactType = plan?.children?.find(item => item.id === metadata.workflow_plan_task_id)?.execution?.output_artifact_type || metadata.output_artifact_type || getAgentArtifactType(task.role);
        validateBeforeCommit({ task: this.getTask(taskId), resultId, artifactId: outcome === 'success' && isSupportedWorkflow(job) ? `${artifactType}-${resultId}` : null });
      }
      const result = { task: this.getTask(taskId), resultId, idempotent: false };
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  attachM12NativeSpecialistRuntime(taskId, {
    attempt, sessionKey, nativeSessionId, runId, environmentId, nodeId, leaseId, ownerEpoch,
  } = {}) {
    // Runtime attachment crosses the native-runtime row, task/session/attempt
    // state, and two event streams. Keep them in one SQLite transaction so a
    // late event/session failure cannot leave a half-attached native run.
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const normalizedAttempt = attempt;
    if (typeof taskId !== 'string' || !taskId.trim() ||
        !Number.isSafeInteger(normalizedAttempt) || normalizedAttempt < 1 ||
        typeof sessionKey !== 'string' || !sessionKey.trim() ||
        typeof nativeSessionId !== 'string' || !nativeSessionId.trim() ||
        typeof runId !== 'string' || !runId.trim() ||
        typeof environmentId !== 'string' || !environmentId.trim() ||
        typeof nodeId !== 'string' || !nodeId.trim() ||
        typeof leaseId !== 'string' || !leaseId.trim() ||
        !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) {
      throw new Error('incomplete M12 native specialist runtime identity');
    }
    const lease = this.getTaskLease(leaseId);
    if (!lease || lease.task_id !== taskId || lease.job_id !== task.job_id ||
        lease.attempt !== normalizedAttempt || lease.state !== 'ACTIVE') {
      throw new Error(`M12 native specialist lease binding is not active for task ${taskId}`);
    }
    if (!Number.isSafeInteger(lease.owner_epoch) || lease.owner_epoch < 1 || lease.owner_epoch !== ownerEpoch) {
      throw new Error(`M12 native specialist owner epoch does not match the durable task lease for ${taskId}`);
    }
    const leaseRuntimeRows = this.db.prepare('SELECT task_id,attempt,lease_id,owner_epoch,run_id FROM m12_native_specialist_runtime WHERE lease_id=? ORDER BY attempt ASC, rowid ASC').all(leaseId);
    if (leaseRuntimeRows.length > 1 || (leaseRuntimeRows.length === 1 &&
        (leaseRuntimeRows[0].task_id !== taskId || leaseRuntimeRows[0].attempt !== normalizedAttempt ||
          leaseRuntimeRows[0].lease_id !== leaseId || leaseRuntimeRows[0].owner_epoch !== ownerEpoch))) {
      throw new Error(`M12 native specialist lease maps to an ambiguous or mismatched runtime: ${leaseId}`);
    }
    const existing = this.db.prepare('SELECT * FROM m12_native_specialist_runtime WHERE task_id=? AND attempt=?').get(taskId, normalizedAttempt);
    if (existing) {
      const same = existing.session_key === sessionKey && existing.native_session_id === nativeSessionId &&
        existing.run_id === runId && existing.environment_id === environmentId && existing.node_id === nodeId &&
        existing.lease_id === leaseId && existing.owner_epoch === ownerEpoch;
      if (!same) throw new Error(`M12 native specialist attempt ${taskId}/${normalizedAttempt} is already bound to a different runtime`);
      this.attachTaskRuntime(taskId, { runId, sessionKey });
      const attached = this.db.prepare('SELECT job_id, type, payload_json FROM events WHERE event_id=?').get(
        eventId(task.job_id, 'm12.specialist.runtime_attached', `${taskId}|${normalizedAttempt}|${runId}`)
      );
      const expectedPayload = JSON.stringify({ taskId, attempt: normalizedAttempt, sessionKey, nativeSessionId, runId, environmentId, nodeId, leaseId, ownerEpoch: Number(ownerEpoch) });
      if (!attached || attached.job_id !== task.job_id || attached.type !== 'm12.specialist.runtime_attached' || attached.payload_json !== expectedPayload) {
        throw new Error(`M12 native runtime attachment event lineage mismatch for task ${taskId}`);
      }
      this.db.exec('COMMIT');
      return existing;
    }
    const conflicting = this.db.prepare('SELECT * FROM m12_native_specialist_runtime WHERE native_session_id=? OR run_id=?').get(nativeSessionId, runId);
    if (conflicting && conflicting.task_id !== taskId) throw new Error('M12 native runtime identity already belongs to another task');
    const ts = now();
    this.db.prepare(`INSERT INTO m12_native_specialist_runtime(
      task_id, attempt, session_key, native_session_id, run_id, environment_id, node_id, lease_id, owner_epoch, state, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',?,?)`).run(
      taskId, normalizedAttempt, sessionKey, nativeSessionId, runId, environmentId, nodeId, leaseId, ownerEpoch, ts, ts,
    );
    this.beginRuntimeAttempt(taskId, { runId, sessionKey, reason: 'M12 native specialist start' });
    const attachedPayload = {
      taskId, attempt: normalizedAttempt, sessionKey, nativeSessionId, runId, environmentId, nodeId, leaseId, ownerEpoch,
    };
    this.recordEvent(task.job_id, 'm12.specialist.runtime_attached', attachedPayload, `${taskId}|${normalizedAttempt}|${runId}`);
    const attached = this.db.prepare('SELECT job_id, type, payload_json FROM events WHERE event_id=?').get(
      eventId(task.job_id, 'm12.specialist.runtime_attached', `${taskId}|${normalizedAttempt}|${runId}`)
    );
    if (!attached || attached.job_id !== task.job_id || attached.type !== 'm12.specialist.runtime_attached' || attached.payload_json !== JSON.stringify(attachedPayload)) {
      throw new Error(`M12 native runtime attachment event lineage mismatch for task ${taskId}`);
    }
    const persisted = this.db.prepare('SELECT * FROM m12_native_specialist_runtime WHERE task_id=? AND attempt=?').get(taskId, normalizedAttempt);
    this.db.exec('COMMIT');
    return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  getM12NativeSpecialistRuntime(taskId, attempt = null) {
    if (attempt == null) return this.db.prepare('SELECT * FROM m12_native_specialist_runtime WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(taskId) || null;
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error('M12 native runtime lookup attempt must be a positive safe integer');
    }
    return this.db.prepare('SELECT * FROM m12_native_specialist_runtime WHERE task_id=? AND attempt=?').get(taskId, attempt) || null;
  }

  reconcileM12NativeSpecialistResult(input = {}) {
    const { taskId, attempt, leaseId, runId, nativeSessionId, status = 'SUCCEEDED', output = '', result = null } = input;
    if (typeof taskId !== 'string' || !taskId.trim() ||
        typeof leaseId !== 'string' || !leaseId.trim() ||
        typeof runId !== 'string' || !runId.trim() ||
        typeof nativeSessionId !== 'string' || !nativeSessionId.trim() ||
        !Number.isSafeInteger(attempt) || attempt < 1) {
      throw new TypeError('native specialist completion requires exact string identities and a positive safe-integer attempt');
    }
    if (status !== 'SUCCEEDED' && status !== 'FAILED') {
      throw new TypeError('native specialist completion status must be SUCCEEDED or FAILED');
    }
    if (typeof output !== 'string') throw new TypeError('native specialist completion output must be a string');
    if (result !== null && (!result || typeof result !== 'object' || Array.isArray(result))) {
      throw new TypeError('native specialist completion result must be an object or null');
    }
    if (result !== null) {
      let detached;
      try { detached = JSON.stringify(result); } catch (error) {
        throw new TypeError(`native specialist completion result must be JSON-safe: ${error.message}`);
      }
      if (typeof detached !== 'string') throw new TypeError('native specialist completion result must be JSON-safe');
      parseStrictJson(detached, 'native specialist completion result');
    }
    // A native completion spans runtime, result, task, lease, attempt, and event
    // rows. Serialize the decision and commit them as one SQLite unit; without
    // this boundary an event/lease write failure could leave a terminal runtime
    // with no result, and a retry would incorrectly treat it as complete.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const runtime = this.getM12NativeSpecialistRuntime(taskId, attempt);
      if (!runtime) {
        this.db.exec('COMMIT');
        return { status: 'REJECTED', reason: 'native_runtime_not_found' };
      }
      if (!Number.isSafeInteger(runtime.attempt) || runtime.attempt !== attempt ||
          !Number.isSafeInteger(runtime.owner_epoch) || runtime.owner_epoch < 1) {
        this.db.exec('COMMIT');
        return { status: 'REJECTED', reason: 'native_runtime_durable_identity_malformed' };
      }
      if (runtime.lease_id !== leaseId || runtime.run_id !== runId || runtime.native_session_id !== nativeSessionId) {
        this.db.exec('COMMIT');
        return { status: 'REJECTED', reason: 'native_runtime_identity_mismatch' };
      }
      const lease = this.getTaskLease(leaseId);
      const boundTask = this.getTask(taskId);
      if (!lease || !boundTask || lease.task_id !== taskId || lease.job_id !== boundTask.job_id || lease.attempt !== attempt ||
          !Number.isSafeInteger(lease.owner_epoch) || lease.owner_epoch < 1 || lease.owner_epoch !== runtime.owner_epoch) {
        this.db.exec('COMMIT');
        return { status: 'REJECTED', reason: 'native_runtime_lease_owner_epoch_mismatch' };
      }
      if (runtime.state !== 'ACTIVE') {
        const expectedLeaseState = runtime.state === 'COMPLETED' ? 'COMPLETED' : runtime.state === 'FAILED' ? 'FAILED' : null;
        if (!expectedLeaseState || lease.state !== expectedLeaseState) {
          this.db.exec('COMMIT');
          return { status: 'REJECTED', reason: 'native_terminal_lease_state_mismatch' };
        }
        const priorRows = this.db.prepare("SELECT result_id, outcome, content FROM results WHERE task_id=? AND json_valid(content) AND json_extract(content, '$.run_id')=? ORDER BY created_at ASC")
          .all(taskId, runId);
        const expectedOutcome = runtime.state === 'COMPLETED' ? 'success' : runtime.state === 'FAILED' ? 'failure' : null;
        if (!expectedOutcome || priorRows.length !== 1) {
          this.db.exec('COMMIT');
          return { status: 'REJECTED', reason: 'native_terminal_result_lineage_inconsistent' };
        }
        const prior = priorRows[0];
        let priorContent;
        let persistedRuntimeResult;
        try {
          priorContent = parseStrictJson(prior.content);
          persistedRuntimeResult = parseStrictJson(runtime.result_json);
        } catch {
          this.db.exec('COMMIT');
          return { status: 'REJECTED', reason: 'native_terminal_result_lineage_inconsistent' };
        }
        const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
        const hasOutput = Object.hasOwn(input, 'output');
        const hasResult = Object.hasOwn(input, 'result');
        const requestedRuntimeResult = result ?? { status, output };
        const durableRuntimeResult = priorContent.result ?? {
          status: expectedOutcome === 'success' ? 'SUCCEEDED' : 'FAILED',
          output: priorContent.output,
        };
        const requestedSuccess = String(status).toUpperCase() === 'SUCCEEDED';
        const conflicts = prior.outcome !== expectedOutcome || requestedSuccess !== (runtime.state === 'COMPLETED') ||
          priorContent.native_session_id !== nativeSessionId || priorContent.run_id !== runId ||
          priorContent.lease_id !== leaseId || priorContent.owner_epoch !== runtime.owner_epoch ||
          priorContent.environment_id !== runtime.environment_id || priorContent.node_id !== runtime.node_id ||
          !sameJson(persistedRuntimeResult, durableRuntimeResult) ||
          (hasOutput && priorContent.output !== String(output || '')) ||
          (hasResult && !sameJson(priorContent.result, result ?? null)) ||
          (hasOutput && !hasResult && result == null && !sameJson(persistedRuntimeResult, { status, output: String(output || '') })) ||
          (hasResult && !sameJson(persistedRuntimeResult, requestedRuntimeResult));
        // A matching result/runtime row is not enough to claim an idempotent
        // terminal callback after restart. Verify the task's terminal attempt
        // projection and both canonical event streams as well; otherwise a
        // deleted/tampered terminal event or reopened task could be hidden by
        // the native runtime's already-terminal state.
        const expectedTaskStatus = expectedOutcome === 'success' ? 'completed' : 'failed';
        // Attempt status records lifecycle settlement, while task/result outcome
        // records success versus failure. Native failed runs still close the
        // durable attempt with attempt.completed (reason carries the outcome).
        const expectedAttemptStatus = 'completed';
        const terminalTask = this.getTask(taskId);
        const terminalAttempts = this.db.prepare('SELECT * FROM attempts WHERE task_id=? AND openclaw_run_id=? ORDER BY started_at ASC, rowid ASC')
          .all(taskId, runId);
        const openAttempts = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started'").all(taskId);
        const terminalType = expectedOutcome === 'success' ? 'm12.specialist.completed' : 'm12.specialist.failed';
        const terminalDedupeKey = `${taskId}|${attempt}|${runId}|terminal`;
        const terminalEventId = eventId(boundTask.job_id, terminalType, terminalDedupeKey);
        const terminalEvents = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type IN ('m12.specialist.completed','m12.specialist.failed') AND json_extract(payload_json,'$.leaseId')=? AND json_extract(payload_json,'$.runId')=?")
          .all(boundTask.job_id, leaseId, runId);
        const expectedTerminalPayload = JSON.stringify({ taskId, attempt, nativeSessionId, runId,
          environmentId: runtime.environment_id, nodeId: runtime.node_id, leaseId, ownerEpoch: runtime.owner_epoch,
          resultId: prior.result_id });
        const attemptCompletionRows = terminalAttempts.length === 1
          ? this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='attempt.completed' AND json_extract(payload_json,'$.attemptId')=?")
            .all(boundTask.job_id, terminalAttempts[0].attempt_id)
          : [];
        const expectedAttemptPayload = terminalAttempts.length === 1
          ? JSON.stringify({ attemptId: terminalAttempts[0].attempt_id, taskId, reason: `native specialist ${expectedOutcome === 'success' ? 'completed' : 'failed'}` })
          : null;
        if (conflicts || !terminalTask || terminalTask.job_id !== boundTask.job_id ||
            terminalTask.status !== expectedTaskStatus || terminalTask.execution_attempt !== attempt ||
            terminalAttempts.length !== 1 || terminalAttempts[0].status !== expectedAttemptStatus ||
            terminalAttempts[0].finished_at == null || openAttempts.length !== 0 ||
            terminalEvents.length !== 1 || terminalEvents[0].event_id !== terminalEventId ||
            terminalEvents[0].job_id !== boundTask.job_id || terminalEvents[0].type !== terminalType ||
            terminalEvents[0].payload_json !== expectedTerminalPayload ||
            attemptCompletionRows.length !== 1 ||
            attemptCompletionRows[0].event_id !== eventId(boundTask.job_id, 'attempt.completed', terminalAttempts[0].attempt_id + '|completed') ||
            attemptCompletionRows[0].job_id !== boundTask.job_id || attemptCompletionRows[0].type !== 'attempt.completed' ||
            attemptCompletionRows[0].payload_json !== expectedAttemptPayload) {
          this.db.exec('COMMIT');
          return { status: 'REJECTED', reason: conflicts
            ? 'native_terminal_retry_conflicts_with_durable_result'
            : 'native_terminal_result_lineage_inconsistent' };
        }
        this.db.exec('COMMIT');
        return { status: 'IDEMPOTENT', runtime, resultId: prior.result_id };
      }
      const task = this.getTask(taskId);
      const parentJob = task ? this.getJob(task.job_id) : null;
      if (lease.state !== 'ACTIVE') {
        this.db.exec('COMMIT');
        return { status: 'REJECTED', reason: 'native_runtime_lease_not_active' };
      }
      const leaseRuntimeRows = this.db.prepare('SELECT task_id,attempt,lease_id,owner_epoch,run_id FROM m12_native_specialist_runtime WHERE lease_id=? ORDER BY attempt ASC, rowid ASC').all(leaseId);
      if (leaseRuntimeRows.length !== 1 || leaseRuntimeRows[0].task_id !== taskId ||
          leaseRuntimeRows[0].attempt !== attempt || leaseRuntimeRows[0].lease_id !== leaseId ||
          leaseRuntimeRows[0].owner_epoch !== runtime.owner_epoch || leaseRuntimeRows[0].run_id !== runId) {
        this.db.exec('COMMIT');
        return { status: 'REJECTED', reason: 'native_runtime_lease_runtime_cardinality_mismatch' };
      }
      let canonicalExpiry = false;
      const leaseExpiry = typeof lease.expires_at === 'string' ? Date.parse(lease.expires_at) : NaN;
      if (Number.isFinite(leaseExpiry)) {
        try { canonicalExpiry = new Date(leaseExpiry).toISOString() === lease.expires_at; } catch {}
      }
      if (!canonicalExpiry) {
        this.db.exec('COMMIT');
        return { status: 'REJECTED', reason: 'native_runtime_lease_expiry_malformed' };
      }
      if (leaseExpiry <= Date.now()) {
        this.db.exec('COMMIT');
        return { status: 'REJECTED', reason: 'native_runtime_lease_expired' };
      }
      if (!task || task.job_id !== lease.job_id || task.status !== 'running' || !parentJob || parentJob.status !== 'active' ||
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(parentJob.state || '').toUpperCase())) {
        this.db.exec('COMMIT');
        return { status: 'REJECTED', reason: 'native_runtime_parent_or_task_not_runnable' };
      }
      const success = status === 'SUCCEEDED';
      const ts = now();
      const resultJson = JSON.stringify(result ?? { status, output });
      if (typeof resultJson !== 'string') throw new Error('native specialist result is not serializable');
      const resultId = id('result');
      this.db.prepare('UPDATE m12_native_specialist_runtime SET state=?, result_json=?, updated_at=? WHERE task_id=? AND attempt=? AND state=\'ACTIVE\'')
        .run(success ? 'COMPLETED' : 'FAILED', resultJson, ts, taskId, attempt);
      if (this.db.prepare('SELECT changes() AS n').get().n !== 1) throw new Error('native specialist runtime changed during reconciliation');
      this.db.prepare('INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?,?,?,?,?)')
        .run(resultId, taskId, success ? 'success' : 'failure', JSON.stringify({
          native_session_id: nativeSessionId, run_id: runId, environment_id: runtime.environment_id,
          node_id: runtime.node_id, lease_id: leaseId, owner_epoch: runtime.owner_epoch,
          output: String(output || ''), result: result ?? null,
        }), ts);
      this.completeTaskLease(leaseId, { workerId: lease.worker_id, success, error: success ? null : String(output || 'native specialist failed') });
      const leaseAfter = this.getTaskLease(leaseId);
      if (leaseAfter?.state !== (success ? 'COMPLETED' : 'FAILED')) throw new Error('native specialist lease terminal update was not persisted');
      const taskUpdate = this.db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE task_id=? AND status='running' AND execution_attempt=?")
        .run(success ? 'completed' : 'failed', ts, taskId, attempt);
      if (taskUpdate.changes !== 1) throw new Error('native specialist task terminal update lost its active attempt row');
      this.completeActiveAttempt(taskId, { reason: success ? 'native specialist completed' : 'native specialist failed' });
      this.recordEvent(lease.job_id, success ? 'm12.specialist.completed' : 'm12.specialist.failed', {
        taskId, attempt, nativeSessionId, runId, environmentId: runtime.environment_id,
        nodeId: runtime.node_id, leaseId, ownerEpoch: runtime.owner_epoch, resultId,
      }, `${taskId}|${attempt}|${runId}|terminal`);
      const persistedEvent = this.db.prepare('SELECT job_id, type, payload_json FROM events WHERE event_id=?')
        .get(eventId(lease.job_id, success ? 'm12.specialist.completed' : 'm12.specialist.failed', `${taskId}|${attempt}|${runId}|terminal`));
      if (!persistedEvent || persistedEvent.job_id !== lease.job_id || persistedEvent.type !== (success ? 'm12.specialist.completed' : 'm12.specialist.failed') || !persistedEvent.payload_json.includes(resultId)) {
        throw new Error('native specialist terminal event lineage mismatch');
      }
      const reconciled = { status: success ? 'COMPLETED' : 'FAILED', task: this.getTask(taskId), runtime: this.getM12NativeSpecialistRuntime(taskId, attempt), resultId };
      this.db.exec('COMMIT');
      return reconciled;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  attachTaskRuntime(taskId, { runId = null, sessionKey = null } = {}) {
    const initial = this.getTask(taskId); if (!initial) return null;
    const ts = now();
    this.db.exec('SAVEPOINT attach_runtime_task_transition');
    try {
      // Acquire SQLite's writer reservation before deciding runtime ownership or
      // whether an attempt must be created. Concurrent attachers must not each
      // create a distinct open attempt for the same task/session.
      const lock = this.db.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=? AND job_id=?')
        .run(taskId, initial.job_id);
      if (lock.changes !== 1) throw new Error(`runtime attach lost its task row: ${taskId}`);
      const task = this.getTask(taskId);
      if (!task || task.job_id !== initial.job_id) throw new Error(`runtime attach task identity changed: ${taskId}`);
      const terminal = ['completed', 'failed', 'cancelled'].includes(String(task.status).toLowerCase());
      if (terminal) {
        if ((runId && runId !== task.openclaw_run_id) || (sessionKey && sessionKey !== task.openclaw_session_key)) {
          throw new Error(`cannot attach a new runtime identity to terminal task ${taskId}`);
        }
        this.db.exec('RELEASE SAVEPOINT attach_runtime_task_transition');
        return task;
      }
      const parentJob = this.getJob(task.job_id);
      if (!parentJob || parentJob.status !== 'active' ||
          ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(parentJob.state || '').toUpperCase())) {
        throw new Error(`runtime attach requires an active nonterminal parent Job: ${task.job_id}`);
      }
      if ((runId && task.openclaw_run_id && runId !== task.openclaw_run_id) ||
          (sessionKey && task.openclaw_session_key && sessionKey !== task.openclaw_session_key)) {
        throw new Error(`runtime attach identity conflicts with existing task ownership: ${taskId}`);
      }
      const effectiveRunId = runId || task.openclaw_run_id || null;
      const effectiveSessionKey = sessionKey || task.openclaw_session_key || null;
      let existingSession = effectiveSessionKey ? this.getSessionByOpenClawKey(effectiveSessionKey) : null;
      if (existingSession && existingSession.task_id !== taskId) {
        throw new Error(`OpenClaw session ${effectiveSessionKey} already belongs to task ${existingSession.task_id}`);
      }
      const attempts = this.db.prepare("SELECT attempt_id, status, openclaw_run_id, started_at FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC, rowid DESC")
        .all(taskId);
      if (attempts.length > 1) throw new Error(`runtime attach found multiple open attempts for task ${taskId}`);
      let activeAttempt = attempts[0] || null;
      if (activeAttempt?.openclaw_run_id && effectiveRunId && activeAttempt.openclaw_run_id !== effectiveRunId) {
        throw new Error(`runtime attach run identity conflicts with active attempt for task ${taskId}`);
      }
      this.db.prepare("UPDATE tasks SET openclaw_run_id=?, openclaw_session_key=?, status='running', updated_at=? WHERE task_id=? AND job_id=? AND status IN ('pending','running')")
        .run(effectiveRunId, effectiveSessionKey, ts, taskId, task.job_id);
      if (this.db.prepare('SELECT changes() AS n').get().n !== 1) throw new Error(`runtime attach task state changed for task ${taskId}`);
      let attemptOrdinal = Number(this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(taskId).n) || 0;
      if (activeAttempt) {
        if (!activeAttempt.openclaw_run_id && effectiveRunId) {
          const linked = this.db.prepare("UPDATE attempts SET openclaw_run_id=? WHERE attempt_id=? AND status='started' AND openclaw_run_id IS NULL")
            .run(effectiveRunId, activeAttempt.attempt_id);
          if (linked.changes !== 1) throw new Error(`runtime attach could not bind the run to the active attempt for task ${taskId}`);
          activeAttempt = { ...activeAttempt, openclaw_run_id: effectiveRunId };
        }
      } else {
        const attemptId = id('attempt');
        this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', ?, ?)")
          .run(attemptId, taskId, effectiveRunId, ts);
        activeAttempt = { attempt_id: attemptId, openclaw_run_id: effectiveRunId, status: 'started', started_at: ts };
        attemptOrdinal += 1;
        this.recordEvent(task.job_id, 'attempt.started', {
          attemptId, taskId, openclawRunId: effectiveRunId, sessionKey: effectiveSessionKey, reason: 'runtime attached'
        }, attemptId);
      }
      if (effectiveSessionKey) {
        existingSession = this.getSessionByOpenClawKey(effectiveSessionKey);
        if (existingSession) {
          if (typeof existingSession.attempt !== 'number' || !Number.isSafeInteger(existingSession.attempt) || existingSession.attempt < 1) {
            throw new Error(`runtime attach refuses a malformed durable session attempt: ${existingSession.session_id}`);
          }
          this.updateAgentSession(existingSession.session_id, {
            state: 'ACTIVE', heartbeat: true, attempt: Math.max(existingSession.attempt, attemptOrdinal || 1)
          });
        } else {
          this.createAgentSession(taskId, {
            sessionKey: effectiveSessionKey, role: task.role, state: 'ACTIVE', attempt: Math.max(attemptOrdinal, 1)
          });
        }
      }
      const attachPayload = {
        taskId, runId: effectiveRunId, sessionKey: effectiveSessionKey, attemptId: activeAttempt?.attempt_id || null
      };
      const attachKey = effectiveRunId || effectiveSessionKey || taskId;
      const attachEventId = this.recordEvent(task.job_id, 'task.runtime_attached', attachPayload, attachKey);
      const attachEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(attachEventId);
      const attached = this.getTask(taskId);
      const persistedAttempts = this.db.prepare("SELECT attempt_id, status, openclaw_run_id FROM attempts WHERE task_id=? AND status='started'").all(taskId);
      const persistedSession = effectiveSessionKey ? this.getSessionByOpenClawKey(effectiveSessionKey) : null;
      if (!attachEvent || attachEvent.event_id !== eventId(task.job_id, 'task.runtime_attached', attachKey) ||
          attachEvent.job_id !== task.job_id || attachEvent.type !== 'task.runtime_attached' || attachEvent.payload_json !== JSON.stringify(attachPayload) ||
          attached?.status !== 'running' || attached.openclaw_run_id !== effectiveRunId || attached.openclaw_session_key !== effectiveSessionKey ||
          persistedAttempts.length !== 1 || persistedAttempts[0].attempt_id !== activeAttempt?.attempt_id ||
          persistedAttempts[0].openclaw_run_id !== effectiveRunId ||
          (effectiveSessionKey && (!persistedSession || persistedSession.task_id !== taskId || persistedSession.state !== 'ACTIVE'))) {
        throw new Error(`runtime attach durable task/attempt/session/event readback mismatch: ${taskId}`);
      }
      this.db.exec('RELEASE SAVEPOINT attach_runtime_task_transition');
      return attached;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT attach_runtime_task_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT attach_runtime_task_transition'); } catch {}
      throw error;
    }
  }
  rearmTaskRuntime(taskId, { runId = null, sessionKey = null } = {}) {
    this.db.exec('SAVEPOINT rearm_runtime_task_fenced');
    try {
      const initial = this.getTask(taskId);
      if (!initial) throw new Error(`task not found: ${taskId}`);
      const jobLock = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(initial.job_id);
      const taskLock = this.db.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=? AND job_id=?').run(taskId, initial.job_id);
      if (jobLock.changes !== 1 || taskLock.changes !== 1) throw new Error(`runtime rearm lost Job/task ownership: ${taskId}`);
      const job = this.getJob(initial.job_id);
      const task = this.getTask(taskId);
      if (!job || job.status !== 'active' || job.state !== 'EXECUTING' ||
          !task || !['pending', 'failed', 'running'].includes(String(task.status).toLowerCase())) {
        throw new Error(`runtime rearm requires an active executing Job and nonterminal task: ${taskId}`);
      }
      if ((runId && task.openclaw_run_id && runId !== task.openclaw_run_id) ||
          (sessionKey && task.openclaw_session_key && sessionKey !== task.openclaw_session_key)) {
        throw new Error(`runtime rearm identity conflicts with durable task ownership: ${taskId}`);
      }
      const activeAttempts = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started'").all(taskId);
      if (activeAttempts.length) throw new Error(`runtime rearm refuses an unresolved active attempt: ${taskId}`);
      const nextRunId = runId || task.openclaw_run_id || null;
      const nextSessionKey = sessionKey || task.openclaw_session_key || null;
      const ts = now();
      const update = this.db.prepare("UPDATE tasks SET status='running',openclaw_run_id=?,openclaw_session_key=?,updated_at=? WHERE task_id=? AND job_id=? AND status IN ('pending','failed','running')")
        .run(nextRunId, nextSessionKey, ts, taskId, task.job_id);
      if (update.changes !== 1) throw new Error(`runtime rearm lost task-state CAS: ${taskId}`);
      const attemptId = id('attempt');
      this.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?, ?, 'started', ?, ?)")
        .run(attemptId, taskId, nextRunId, ts);
      const payload = { taskId, runId: nextRunId, sessionKey: nextSessionKey, attemptId };
      const key = `${taskId}|rearm|${attemptId}`;
      const eventIdValue = this.recordEvent(task.job_id, 'task.runtime_rearmed', payload, key);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const persisted = this.getTask(taskId);
      const attempts = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started'").all(taskId);
      if (persisted?.status !== 'running' || persisted.openclaw_run_id !== nextRunId || persisted.openclaw_session_key !== nextSessionKey ||
          attempts.length !== 1 || attempts[0].attempt_id !== attemptId || !event ||
          event.event_id !== eventId(task.job_id, 'task.runtime_rearmed', key) || event.job_id !== task.job_id ||
          event.type !== 'task.runtime_rearmed' || event.payload_json !== JSON.stringify(payload)) {
        throw new Error(`runtime rearm durable readback mismatch: ${taskId}`);
      }
      this.db.exec('RELEASE SAVEPOINT rearm_runtime_task_fenced');
      return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT rearm_runtime_task_fenced'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT rearm_runtime_task_fenced'); } catch {}
      throw error;
    }
  }
  beginRuntimeAttempt(taskId, { runId = null, sessionKey = null, reason = 'runtime retry' } = {}) {
    this.db.exec('SAVEPOINT begin_runtime_attempt_fenced');
    try {
      const initial = this.getTask(taskId);
      if (!initial) throw new Error(`task not found: ${taskId}`);
      const jobLock = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(initial.job_id);
      const taskLock = this.db.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=? AND job_id=?').run(taskId, initial.job_id);
      if (jobLock.changes !== 1 || taskLock.changes !== 1) throw new Error(`runtime attempt lost Job/task ownership: ${taskId}`);
      const task = this.getTask(taskId);
      const job = this.getJob(initial.job_id);
      const legacyIdleRuntime = job && String(job.state || '').toUpperCase() === 'IDLE' && !isSupportedWorkflow(job);
      if (!task || !job || job.status !== 'active' || (job.state !== 'EXECUTING' && !legacyIdleRuntime) ||
          !['pending', 'failed', 'running'].includes(String(task.status).toLowerCase())) {
        throw new Error(`runtime attempt requires an active executing Job and nonterminal task: ${taskId}`);
      }
      if ((runId && task.openclaw_run_id && runId !== task.openclaw_run_id) ||
          (sessionKey && task.openclaw_session_key && sessionKey !== task.openclaw_session_key)) {
        throw new Error(`runtime attempt identity conflicts with durable task ownership: ${taskId}`);
      }
      const active = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC,rowid DESC").all(taskId);
      if (active.length) throw new Error(`task already has active runtime attempt: ${taskId}`);
      const nextRunId = runId || task.openclaw_run_id || null;
      const nextSessionKey = sessionKey || task.openclaw_session_key || null;
      const ts = now();
      const taskUpdate = this.db.prepare("UPDATE tasks SET status='running',openclaw_run_id=?,openclaw_session_key=?,updated_at=? WHERE task_id=? AND job_id=? AND status IN ('pending','failed','running')")
        .run(nextRunId, nextSessionKey, ts, taskId, task.job_id);
      if (taskUpdate.changes !== 1) throw new Error(`runtime attempt lost task-state CAS: ${taskId}`);
      const attemptId = id('attempt');
      this.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?, ?, 'started', ?, ?)")
        .run(attemptId, taskId, nextRunId, ts);
      const payload = { attemptId, taskId, openclawRunId: nextRunId, sessionKey: nextSessionKey, reason };
      const eventIdValue = this.recordEvent(task.job_id, 'attempt.started', payload, attemptId);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const persistedTask = this.getTask(taskId);
      const persistedAttempt = this.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attemptId);
      const openAttempts = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started'").all(taskId);
      if (persistedTask?.status !== 'running' || persistedTask.openclaw_run_id !== nextRunId || persistedTask.openclaw_session_key !== nextSessionKey ||
          !persistedAttempt || persistedAttempt.status !== 'started' || persistedAttempt.openclaw_run_id !== nextRunId ||
          openAttempts.length !== 1 || openAttempts[0].attempt_id !== attemptId || !event ||
          event.event_id !== eventId(task.job_id, 'attempt.started', attemptId) || event.job_id !== task.job_id ||
          event.type !== 'attempt.started' || event.payload_json !== JSON.stringify(payload)) {
        throw new Error(`runtime attempt durable readback mismatch: ${taskId}`);
      }
      this.db.exec('RELEASE SAVEPOINT begin_runtime_attempt_fenced');
      return persistedAttempt;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT begin_runtime_attempt_fenced'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT begin_runtime_attempt_fenced'); } catch {}
      throw error;
    }
  }
  completeActiveAttempt(taskId, { reason = 'runtime phase completed' } = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const activeAttempts = this.db.prepare("SELECT * FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC, rowid DESC").all(taskId);
    if (activeAttempts.length > 1) throw new Error(`cannot complete an ambiguous active-attempt ledger: ${taskId}`);
    const active = activeAttempts[0] || null;
    if (!active) return null;
    const ts = now();
    const update = this.db.prepare("UPDATE attempts SET status='completed', finished_at=? WHERE attempt_id=? AND task_id=? AND status='started'")
      .run(ts, active.attempt_id, taskId);
    if (update.changes !== 1) throw new Error(`attempt completion lost its active-row compare-and-set: ${active.attempt_id}`);
    const payload = { attemptId: active.attempt_id, taskId, reason };
    const eventIdValue = this.recordEvent(task.job_id, 'attempt.completed', payload, active.attempt_id + '|completed');
    const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
    const matching = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='attempt.completed' AND json_extract(payload_json,'$.attemptId')=?")
      .all(task.job_id, active.attempt_id);
    const persisted = this.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(active.attempt_id);
    if (matching.length !== 1 || !event || event.event_id !== eventId(task.job_id, 'attempt.completed', active.attempt_id + '|completed') ||
        event.job_id !== task.job_id || event.type !== 'attempt.completed' || event.payload_json !== JSON.stringify(payload) ||
        persisted?.task_id !== taskId || persisted.status !== 'completed') {
      throw new Error(`attempt completion event/result lineage readback failed: ${active.attempt_id}`);
    }
    return persisted;
  }
  recordSpawn(jobId, { parentTaskId = null, role = 'unknown', description, runId = null, sessionKey = null, dependencies = [], metadata = {} } = {}) {
    this.db.exec('SAVEPOINT record_spawn_atomic');
    try {
      const task = this.createChildTask(jobId, { parentTaskId, role, description, dependencies, metadata });
      this.attachTaskRuntime(task.task_id, { runId, sessionKey });
      const existingAttempts = this.db.prepare("SELECT * FROM attempts WHERE task_id = ? AND status = 'started' ORDER BY started_at DESC, rowid DESC").all(task.task_id);
      if (existingAttempts.length !== 1) throw new Error(`spawn requires exactly one active durable attempt: ${task.task_id}`);
      const persistedTask = this.getTask(task.task_id);
      if (persistedTask?.status !== 'running' || persistedTask.openclaw_run_id !== (runId || task.openclaw_run_id || null) ||
          persistedTask.openclaw_session_key !== (sessionKey || task.openclaw_session_key || null)) {
        throw new Error(`spawn task/runtime readback mismatch: ${task.task_id}`);
      }
      this.db.exec('RELEASE SAVEPOINT record_spawn_atomic');
      return persistedTask;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT record_spawn_atomic'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT record_spawn_atomic'); } catch {}
      throw error;
    }
  }
  completeTaskByRuntime(jobId, { runId = null, sessionKey = null, content = '', outcome = 'success' } = {}) {
    if (Array.isArray(content)) {
      content = content.map(item => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        return JSON.stringify(item || '');
      }).filter(Boolean).join('\n');
    } else if (content && typeof content !== 'string') {
      content = typeof content?.text === 'string' ? content.text : JSON.stringify(content);
    }
    const taskByRunId = runId ? this.db.prepare('SELECT * FROM tasks WHERE job_id = ? AND openclaw_run_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(jobId, runId) : null;
    const taskBySessionKey = sessionKey ? this.db.prepare('SELECT * FROM tasks WHERE job_id = ? AND openclaw_session_key = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(jobId, sessionKey) : null;
    if (taskByRunId && taskBySessionKey && taskByRunId.task_id !== taskBySessionKey.task_id) {
      throw new Error('runtime completion runId and sessionKey resolve to different task owners');
    }
    let task = taskByRunId || taskBySessionKey || null;
    if (!task) return null;
    if ((runId && task.openclaw_run_id !== runId) || (sessionKey && task.openclaw_session_key !== sessionKey)) {
      throw new Error('runtime completion identity does not exactly match its durable task ownership');
    }
    const owningJob = this.getJob(jobId);
    if (!owningJob) return null;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(owningJob.state || '').toUpperCase()) ||
        ['completed', 'failed', 'cancelled'].includes(String(owningJob.status || '').toLowerCase())) {
      // A late runtime callback cannot terminalize a task or append a result
      // after the business job is terminal. RecoveryManager separately settles
      // any still-running task/attempt as cancelled without trusting the callback.
      return task;
    }
    if (['completed','failed','cancelled'].includes(task.status)) {
      const expectedTaskStatus = outcome === 'success' ? 'completed' : outcome === 'failure' || outcome === 'failed' ? 'failed' : null;
      if (!expectedTaskStatus || task.status !== expectedTaskStatus) {
        throw new Error(`runtime completion conflicts with the already-terminal task outcome: ${task.task_id}`);
      }
      const terminalEvents = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type IN ('task.completed','task.failed') AND json_extract(payload_json,'$.taskId')=? ORDER BY rowid ASC")
        .all(jobId, task.task_id);
      if (terminalEvents.length !== 1) throw new Error(`terminal runtime task has ambiguous or missing completion-event lineage: ${task.task_id}`);
      let payload;
      try { payload = parseStrictJson(terminalEvents[0].payload_json, 'terminal runtime completion event'); }
      catch { throw new Error(`terminal runtime task completion event is malformed: ${task.task_id}`); }
      const expectedType = expectedTaskStatus === 'completed' ? 'task.completed' : 'task.failed';
      const expectedOutcome = expectedTaskStatus === 'completed' ? 'success' : 'failure';
      const resultRows = this.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=?').all(payload.resultId);
      const activeAttempts = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started'").all(task.task_id);
      const failureClass = expectedOutcome === 'success' ? null
        : (/timed out|timeout|deadline/i.test(String(resultRows[0]?.content || '')) ? 'NATIVE_RUNTIME_TIMEOUT' : 'NATIVE_RUNTIME_FAILURE');
      const expectedPayload = resultRows.length === 1 ? {
        taskId: task.task_id, resultId: resultRows[0].result_id, runId: task.openclaw_run_id || null,
        sessionKey: task.openclaw_session_key || null, attemptId: payload.attemptId ?? null,
        outcome: expectedOutcome, failureClass
      } : null;
      const attemptRows = payload.attemptId == null ? []
        : this.db.prepare('SELECT * FROM attempts WHERE attempt_id=? AND task_id=?').all(payload.attemptId, task.task_id);
      if (terminalEvents[0].type !== expectedType || terminalEvents[0].job_id !== jobId ||
          terminalEvents[0].event_id !== eventId(jobId, expectedType, `${task.task_id}|${expectedOutcome}|${payload.resultId}`) ||
          !expectedPayload || terminalEvents[0].payload_json !== JSON.stringify(expectedPayload) ||
          resultRows[0].task_id !== task.task_id || resultRows[0].outcome !== expectedOutcome ||
          resultRows[0].content !== String(content || '') || activeAttempts.length !== 0 ||
          (payload.attemptId != null && (attemptRows.length !== 1 || attemptRows[0].status !== expectedTaskStatus ||
            attemptRows[0].openclaw_run_id && task.openclaw_run_id && attemptRows[0].openclaw_run_id !== task.openclaw_run_id))) {
        throw new Error(`terminal runtime task result/attempt/event lineage conflicts with the replay: ${task.task_id}`);
      }
      return task;
    }
    // A CTO task is not terminal merely because its own OpenClaw session
    // emitted a completion-shaped message. Required specialist children are
    // part of the CTO task's execution contract and must settle first.
    if (String(task.role || '').toLowerCase() === 'cto' && outcome === 'success') {
      const children = this.db.prepare('SELECT task_id, role, status FROM tasks WHERE parent_task_id = ?').all(task.task_id);
      const job = this.getJob(jobId);
      const isProductionE2E = isProductionWorkflow(job);
      const isSupportedNativeSynthesis = isSupportedWorkflow(job);
      const plan = isSupportedWorkflow(job) ? this.getExecutionPlan(jobId) : null;
      const requiredRoles = plan?.children?.length ? plan.children.map(item => String(item.role).toLowerCase()) : (isProductionE2E ? ProductionRoles : []);
      const missingRequiredRole = requiredRoles.find(role => !children.some(t => String(t.role).toLowerCase() === role));
      const openChildren = children.filter(t => !['completed', 'failed', 'cancelled'].includes(String(t.status).toLowerCase()));
      const failedChildren = children.filter(t => ['failed', 'cancelled'].includes(String(t.status).toLowerCase()));
      if (missingRequiredRole || openChildren.length || failedChildren.length) {
        console.warn(`[WorkflowStore] Ignoring premature CTO runtime completion job=${jobId} task=${task.task_id} missing=${missingRequiredRole || '-'} open=${openChildren.length} failed=${failedChildren.length}`);
        return task;
      }
      if (isProductionE2E || isSupportedNativeSynthesis) {
        const synthesis = String(content || '');
        const adapterTimeout = '⚠️ Xin lỗi, hệ thống chưa nhận được phản hồi từ nguồn AI trong thời gian cho phép. Vui lòng thử lại ạ.';
        const validSynthesis = Boolean(synthesis.trim()) && synthesis.trim() !== adapterTimeout;
        if (!validSynthesis) {
          console.warn(`[WorkflowStore] Ignoring CTO runtime completion without verified synthesis job=${jobId} task=${task.task_id}`);
          this.recordEvent(jobId, 'workflow.synthesis_validation_blocked', {
            taskId: task.task_id,
            reason: 'supported workflow CTO completion lacked verified synthesis evidence'
          }, `${task.task_id}|synthesis-validation-blocked|${Date.now()}`);
          return task;
        }
      }
    }
    const isRequiredExecutionCheck = /Production E2E acceptance|node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/(?:server\.js|test-tool-turn\.js)/i.test(String(task.description || ''));
    if (outcome === 'success' && isRequiredExecutionCheck && ProductionRoles.includes(String(task.role || '').toLowerCase())) {
      const text = String(content || '');
      const promptDataStart = text.indexOf('<prompt-data>');
      const promptDataEnd = text.indexOf('</prompt-data>');
      const promptData = promptDataStart >= 0 && promptDataEnd > promptDataStart
        ? text.slice(promptDataStart + 12, promptDataEnd).trim()
        : '';
      const refusal = /\b(cannot|unable|no native|no exec|not available|could not)\b|không thể|không có (?:native|exec)|không khả dụng|không cung cấp được/i.test(text);
      const expectedCommand = String(task.description || '').match(/Run (?:the )?exact command(?: immediately)?:\s*(node\s+--check\s+[^\n]+?)(?:\.|$)/i)?.[1]?.trim() || null;
      const normalizeCommand = command => String(command || '').trim().replace(/^node --check ~\/work\/chatgpt-adapter\//i, 'node --check /home/long/work/chatgpt-adapter/');
      // `node --check` is silent on success. Treat its explicit no-output marker
      // as valid process output only when the exact planned command and a
      // successful exit marker are also present; other commands still require
      // non-empty child output.
      const expectedSyntaxCheck = /^node\s+--check\s+\S+$/i.test(normalizeCommand(expectedCommand));
      const hasActualChildOutput = Boolean(promptData) && (promptData.toLowerCase() !== '(no output)' || expectedSyntaxCheck);
      const normalizedPromptData = normalizeCommand(promptData);
      const normalizedExpectedCommand = normalizeCommand(expectedCommand);
      const hasCommand = normalizedExpectedCommand ? normalizedPromptData.includes(normalizedExpectedCommand) : normalizedPromptData.includes('node --check');
      const lowerPromptData = promptData.toLowerCase();
      const hasExitStatus = lowerPromptData.includes('exit status') || lowerPromptData.includes('exit code') || promptData.includes('status: 0');
      if (refusal || !hasActualChildOutput || !hasCommand || !hasExitStatus) {
        outcome = 'failure';
        content = `${text}\n[CoS validation] Specialist result rejected: missing actual child output with verified command/exit-status evidence or contains execution refusal.`;
      }
    }
    const completionJob = this.getJob(jobId);
    const completionPlan = this.getExecutionPlan(jobId);
    const taskPolicy = isSupportedWorkflow(completionJob) && String(task.role || '').toLowerCase() !== 'cto'
      ? this.assertSupportedTaskPlanBinding(task, completionPlan)
      : null;
    if (outcome === 'success' && taskPolicy?.requiresExecutionEvidence) {
      const durableResult = this.db.prepare('SELECT outcome,content FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
        .get(task.task_id);
      // Task status is still RUNNING at this point by design; evaluate the
      // intended terminal state against the latest durable execution result,
      // immutable plan and exact session/attempt/command rather than letting a
      // success-shaped runtime turn substitute for the local execution ledger.
      const validated = validateEvidenceContract({ ...task, status: 'completed' }, durableResult, taskPolicy.plannedExecution);
      const proposed = validateEvidenceContract({ ...task, status: 'completed' }, {
        outcome: 'success', content: String(content || '')
      }, taskPolicy.plannedExecution);
      if (!validated.valid || !proposed.valid) {
        outcome = 'failure';
        const reasons = [
          ...validated.errors.map(error => `durable result: ${error}`),
          ...proposed.errors.map(error => `completion content: ${error}`)
        ];
        content = `${String(content || '')}\n[Workflow validation] Deterministic task rejected: ${reasons.join('; ')}.`;
      }
    }
    const engineeringWorkflow = String(this.getExecutionPlan(jobId)?.workflow_id || '').toLowerCase() === 'engineering';
    if (outcome === 'success' && engineeringWorkflow) {
      let metadata = (() => {
        try { return parseStrictJson(task.metadata_json || '{}'); } catch (_) { return {}; }
      })();
      if (taskPolicy) metadata = taskPolicy.metadata;
      // Deterministic policy comes from the immutable execution plan. Task
      // metadata is compared against that plan above and cannot downgrade a
      // required ExecutionManager task into a host-conversation result.
      const deterministic = taskPolicy
        ? taskPolicy.requiresExecutionEvidence
        : metadata.executor === 'ExecutionManager' || metadata.deterministic === true;
      const text = String(content || '').trim();
      const adapterTimeout = '⚠️ Xin lỗi, hệ thống chưa nhận được phản hồi từ nguồn AI';
      if (deterministic) {
        const refreshed = this.getTask(task.task_id);
        const hasExecution = Boolean(
          refreshed?.execution_session_id
          && refreshed?.execution_status === 'completed'
          && refreshed?.execution_exit_code === 0
        );
        const hasEvidence = /\[ACTUAL (?:TOOL RESULT|EXECUTION BATCH|EXECUTION) EVIDENCE\]/i.test(text);
        if (!hasExecution || !hasEvidence) {
          outcome = 'failure';
          content = text + '\n[Workflow validation] Deterministic task rejected: missing durable ExecutionManager evidence or exit code 0.';
        }
      } else if (!text || text.startsWith(adapterTimeout)) {
        outcome = 'failure';
        content = text + '\n[Workflow validation] Native task rejected: missing verified native result.';
      }
      if (outcome === 'success' && ['architect', 'reviewer'].includes(String(task.role || '').toLowerCase())) {
        const artifact = text.match(/<prompt-data>\s*([\s\S]*?)\s*<\/prompt-data>/i)?.[1]?.trim();
        if (artifact) {
          try {
            parseStrictJson(artifact);
            content = artifact;
          } catch (_) {
            // Keep raw native content; verifier will reject a malformed artifact.
          }
        }
        if (String(task.role || '').toLowerCase() === 'reviewer') {
          const normalizedReviewer = normalizeReviewerArtifact(text);
          if (normalizedReviewer) content = normalizedReviewer;
        }
      }
    }
    const standardWorkflow = String(this.getExecutionPlan(jobId)?.workflow_id || '').toLowerCase() === 'standard-engineering';
    let standardReviewerUpstreamArtifactIds = null;
    let standardCtoReviewArtifactId = null;
    if (outcome === 'success' && standardWorkflow && String(task.role || '').toLowerCase() === 'reviewer') {
      const upstreamTypes = ['requirements', 'architecture', 'implementation', 'security-review', 'qa-report', 'platform-review', 'documentation'];
      const upstream = upstreamTypes.map(type => this.getLatestArtifact(jobId, type));
      const normalized = normalizeReviewerArtifact(content);
      let review = null;
      try { review = normalized ? parseStrictJson(normalized).review : null; } catch (_) { review = null; }
      if (upstream.some(artifact => !artifact)) {
        outcome = 'failure';
        content = `${String(content || '')}\n[Workflow validation] Reviewer rejected: required upstream durable artifacts are missing.`;
      } else if (!review) {
        outcome = 'failure';
        content = `${String(content || '')}\n[Workflow validation] Reviewer rejected: structured review artifact is missing.`;
      } else {
        try { validateArtifactContent('review', review); content = JSON.stringify({ review }); }
        catch (error) {
          outcome = 'failure';
          content = `${String(content || '')}\n[Workflow validation] Reviewer rejected: ${error.message}`;
        }
        if (outcome === 'success') standardReviewerUpstreamArtifactIds = upstream.map(artifact => artifact.artifact_id);
      }
    }
    if (outcome === 'success' && standardWorkflow && String(task.role || '').toLowerCase() === 'cto') {
      const review = this.getLatestArtifact(jobId, 'review');
      let decision = null;
      try { decision = typeof content === 'string' ? parseStrictJson(content) : content; } catch (_) { decision = null; }
      if (!review) {
        outcome = 'failure';
        content = `${String(content || '')}\n[Workflow validation] CTO rejected: durable ReviewArtifact is missing.`;
      } else if (!decision || typeof decision !== 'object') {
        outcome = 'failure';
        content = `${String(content || '')}\n[Workflow validation] CTO rejected: structured CTO decision is missing.`;
      } else {
        try { validateArtifactContent('cto-decision', decision); content = JSON.stringify(decision); }
        catch (error) {
          outcome = 'failure';
          content = `${String(content || '')}\n[Workflow validation] CTO rejected: ${error.message}`;
        }
      }
      if (outcome === 'success') standardCtoReviewArtifactId = review.artifact_id;
    }
    const specialistTypes = Object.freeze({ security: 'security-review', qa: 'qa-report', platform: 'platform-review', writer: 'documentation' });
    const specialistType = specialistTypes[String(task.role || '').toLowerCase()];
    let specialistImplementation = outcome === 'success' && engineeringWorkflow && specialistType
      ? this.getLatestArtifact(jobId, 'implementation')
      : null;
    if (outcome === 'success' && engineeringWorkflow && specialistType && !specialistImplementation) {
      throw new Error(`cannot persist ${specialistType}: implementation artifact is missing`);
    }
    // Runtime completion writes a result, possibly one or more typed artifacts,
    // task/attempt/session state, and a completion event. They form one durable
    // transition: without a savepoint an artifact or event failure after the
    // result INSERT leaves an orphan success result that recovery may mistake
    // for completed work. SAVEPOINT also composes with an outer transaction.
    // A deterministic multi-process interleaving hook for regression tests.
    // Each child reports that preflight has finished, then both wait until the
    // parent releases them to compete for the same durable task transition.
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_RUNTIME_COMPLETION_BARRIER_DIR) {
      const barrierDir = path.resolve(process.env.CHAT_ON_STEROIDS_TEST_RUNTIME_COMPLETION_BARRIER_DIR);
      const readyPath = path.join(barrierDir, `${process.pid}.ready`);
      const barrierPath = path.join(barrierDir, 'release');
      fs.writeFileSync(readyPath, String(task.task_id), { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(barrierPath)) {
        if (Date.now() >= deadline) throw new Error('test runtime-completion barrier timed out before writer transaction');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    this.db.exec('SAVEPOINT complete_runtime_task_transition');
    try {
      // SAVEPOINT is initially deferred. This conditional no-op UPDATE forces
      // SQLite to acquire its writer reservation before reading mutable task,
      // job, attempt, and upstream-artifact state. A second process which
      // passed the same preflight will block here and then observe status no
      // longer running instead of inserting a second successful result.
      const claim = this.db.prepare("UPDATE tasks SET updated_at=updated_at WHERE task_id=? AND job_id=? AND status='running' AND openclaw_run_id IS ? AND openclaw_session_key IS ?")
        .run(task.task_id, jobId, task.openclaw_run_id ?? null, task.openclaw_session_key ?? null);
      if (claim.changes !== 1) throw new Error(`runtime task completion lost its task-state compare-and-set race: ${task.task_id}`);
      const lockedTask = this.getTask(task.task_id);
      const lockedJob = this.getJob(jobId);
      if (!lockedTask || lockedTask.status !== 'running' || lockedTask.job_id !== jobId ||
          lockedJob?.state !== 'EXECUTING' || lockedJob?.status !== 'active' ||
          lockedTask.role !== task.role || lockedTask.description !== task.description ||
          lockedTask.metadata_json !== task.metadata_json ||
          (runId && lockedTask.openclaw_run_id !== runId) || (sessionKey && lockedTask.openclaw_session_key !== sessionKey)) {
        throw new Error(`runtime task completion ownership/state changed during preflight: ${task.task_id}`);
      }
      task = lockedTask;
      if (outcome === 'success' && taskPolicy?.requiresExecutionEvidence) {
        // The preflight success check happens before the writer reservation.
        // Re-read the result under the lock as repair/recovery can append a new
        // result without changing the running task row. A failed or substituted
        // latest result must win over a previously success-shaped transcript.
        const latestExecutionResult = this.db.prepare('SELECT outcome,content FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
          .get(task.task_id);
        const lockedEvidence = validateEvidenceContract({ ...task, status: 'completed' }, latestExecutionResult, taskPolicy.plannedExecution);
        const lockedProposed = validateEvidenceContract({ ...task, status: 'completed' }, {
          outcome: 'success', content: String(content || '')
        }, taskPolicy.plannedExecution);
        if (!lockedEvidence.valid || !lockedProposed.valid) {
          outcome = 'failure';
          const reasons = [
            ...lockedEvidence.errors.map(error => `durable result: ${error}`),
            ...lockedProposed.errors.map(error => `completion content: ${error}`)
          ];
          content = `${String(content || '')}\n[Workflow validation] Deterministic task rejected after write-lock reservation: ${reasons.join('; ')}.`;
        }
      }
      const activeAttempts = this.db.prepare("SELECT attempt_id, openclaw_run_id, status FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC, rowid DESC")
        .all(task.task_id);
      if (activeAttempts.length > 1) throw new Error(`runtime task completion found ambiguous active attempts: ${task.task_id}`);
      const activeAttempt = activeAttempts[0] || null;
      if (isSupportedWorkflow(lockedJob) && !activeAttempt) {
        throw new Error(`supported runtime task completion requires one active durable attempt: ${task.task_id}`);
      }
      if (activeAttempt?.openclaw_run_id && task.openclaw_run_id && activeAttempt.openclaw_run_id !== task.openclaw_run_id) {
        throw new Error(`runtime task completion attempt does not belong to the currently attached run: ${task.task_id}`);
      }
      if (outcome === 'success' && engineeringWorkflow && specialistType) {
        const lockedImplementation = this.getLatestArtifact(jobId, 'implementation');
        if (!lockedImplementation || lockedImplementation.status !== 'active' ||
            lockedImplementation.artifact_id !== specialistImplementation?.artifact_id) {
          throw new Error('implementation artifact changed between runtime completion preflight and persistence');
        }
        specialistImplementation = lockedImplementation;
      }
      if (outcome === 'success' && standardWorkflow && String(task.role || '').toLowerCase() === 'reviewer') {
        const lockedUpstreamTypes = ['requirements', 'architecture', 'implementation', 'security-review', 'qa-report', 'platform-review', 'documentation'];
        const lockedUpstream = lockedUpstreamTypes.map(type => this.getLatestArtifact(jobId, type));
        const lockedUpstreamIds = lockedUpstream.map(artifact => artifact?.artifact_id || null);
        if (lockedUpstream.some(artifact => !artifact || artifact.status !== 'active') || !standardReviewerUpstreamArtifactIds ||
            JSON.stringify(lockedUpstreamIds) !== JSON.stringify(standardReviewerUpstreamArtifactIds)) {
          throw new Error('standard-engineering reviewer inputs changed between validation and durable completion');
        }
      }
      if (outcome === 'success' && standardWorkflow && String(task.role || '').toLowerCase() === 'cto') {
        const lockedReview = this.getLatestArtifact(jobId, 'review');
        if (!lockedReview || lockedReview.status !== 'active' || lockedReview.artifact_id !== standardCtoReviewArtifactId) {
          throw new Error('standard-engineering ReviewArtifact changed between CTO validation and durable completion');
        }
      }
      const resultId = id('result'); const ts = now();
      this.db.prepare('INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, ?, ?, ?)').run(resultId, task.task_id, outcome, content || '', ts);
      // Deterministic crash probe for the exact partial-write window protected
      // by this savepoint. It is inert outside explicit test mode and lets a
      // child-process SIGKILL verify SQLite rollback/reopen behavior.
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_RUNTIME_RESULT_INSERT === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
      if (outcome === 'success' && engineeringWorkflow && specialistType) {
        const contentByType = {
          'security-review': { threats: [], findings: [content || ''], decision: 'accept' },
          'qa-report': { checks: ['native completion'], results: [content || ''], decision: 'accept' },
          'platform-review': { runtime: { status: 'reviewed' }, deployment: { status: 'reviewed' }, recovery: { status: 'reviewed' } },
          documentation: { summary: 'Documentation review completed.', user_facing_changes: [], verification: [content || ''] }
        };
        this.createArtifact({
          artifact_id: `${specialistType}-${resultId}`,
          job_id: jobId,
          task_id: task.task_id,
          type: specialistType,
          producer_role: task.role,
          content: contentByType[specialistType],
          evidence: [resultId, specialistImplementation.artifact_id]
        });
      }
      if (outcome === 'success' && standardWorkflow && String(task.role || '').toLowerCase() === 'reviewer') {
        const upstreamTypes = ['requirements', 'architecture', 'implementation', 'security-review', 'qa-report', 'platform-review', 'documentation'];
        const upstream = upstreamTypes.map(type => this.getLatestArtifact(jobId, type));
        const review = parseStrictJson(String(content)).review;
        this.createArtifact({
          artifact_id: `review-${resultId}`,
          job_id: jobId,
          task_id: task.task_id,
          type: 'review',
          producer_role: 'reviewer',
          content: review,
          evidence: [resultId, ...upstream.map(artifact => artifact.artifact_id)]
        });
      }
      if (outcome === 'success' && standardWorkflow && String(task.role || '').toLowerCase() === 'cto') {
        const review = this.getLatestArtifact(jobId, 'review');
        const decision = parseStrictJson(String(content));
        this.createArtifact({
          artifact_id: `cto-decision-${resultId}`,
          job_id: jobId,
          task_id: task.task_id,
          type: 'cto-decision',
          producer_role: 'cto',
          content: decision,
          evidence: [resultId, review.artifact_id]
        });
      }
      const taskUpdate = this.db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE task_id=? AND job_id=? AND status='running'")
        .run(outcome === 'success' ? 'completed' : 'failed', ts, task.task_id, jobId);
      if (taskUpdate.changes !== 1) throw new Error(`runtime task completion could not terminalize exactly one running task: ${task.task_id}`);
      if (activeAttempt) {
        const attemptUpdate = this.db.prepare("UPDATE attempts SET status=?, finished_at=?, error=? WHERE attempt_id=? AND task_id=? AND status='started'")
          .run(outcome === 'success' ? 'completed' : 'failed', ts, outcome === 'success' ? null : String(content || '').slice(0, 2000), activeAttempt.attempt_id, task.task_id);
        if (attemptUpdate.changes !== 1) throw new Error(`runtime task completion could not settle exactly one active attempt: ${task.task_id}`);
      }
      this.db.prepare("UPDATE agent_sessions SET state = ?, updated_at = ?, last_activity_at = ? WHERE task_id = ? AND state IN ('CREATED','ACTIVE','PAUSED')")
        .run(outcome === 'success' ? 'TERMINATED' : 'FAILED', ts, ts, task.task_id);
      const effectiveRunId = task.openclaw_run_id || null;
      const effectiveSessionKey = task.openclaw_session_key || null;
      const failureClass = outcome === 'success' ? null
        : (/timed out|timeout|deadline/i.test(String(content || '')) ? 'NATIVE_RUNTIME_TIMEOUT' : 'NATIVE_RUNTIME_FAILURE');
      this.recordEvent(jobId, outcome === 'success' ? 'task.completed' : 'task.failed', {
        taskId: task.task_id,
        resultId,
        runId: effectiveRunId,
        sessionKey: effectiveSessionKey,
        attemptId: activeAttempt?.attempt_id || null,
        outcome,
        failureClass
      }, `${task.task_id}|${outcome}|${resultId}`);
      this.db.exec('RELEASE SAVEPOINT complete_runtime_task_transition');
      // Runtime task completion is not business-job completion. The Coordinator/CTO
      // must explicitly complete the durable Job after synthesis and DoD checks.
      return this.getTask(task.task_id);
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT complete_runtime_task_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT complete_runtime_task_transition'); } catch {}
      throw error;
    }
  }
  hasOpenTasks(jobId) {
    return !!this.db.prepare("SELECT 1 FROM tasks WHERE job_id = ? AND status IN ('pending','running') LIMIT 1").get(jobId);
  }
  getSlackThread(jobId) { return this.db.prepare('SELECT * FROM slack_threads WHERE job_id = ?').get(jobId) || null; }
  ensureSlackThread(jobId, { channel = 'slack', target = 'C0C3RJKNKPG', rootMessageId = null } = {}) {
    const existing = this.getSlackThread(jobId);
    if (existing) return existing;
    const ts = now();
    this.db.prepare('INSERT INTO slack_threads(job_id, channel, target, root_message_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)').run(jobId, channel, target, rootMessageId, ts, ts);
    return this.getSlackThread(jobId);
  }
  setSlackRootMessage(jobId, messageId) {
    const ts = now();
    this.db.prepare('UPDATE slack_threads SET root_message_id = ?, updated_at = ? WHERE job_id = ?').run(messageId, ts, jobId);
    return this.getSlackThread(jobId);
  }
  isSlackProjected(eventId) { return !!this.db.prepare('SELECT 1 FROM slack_projections WHERE event_id = ?').get(eventId); }
  beginSlackProjectionSend(eventId, jobId, { channel = 'slack', target = 'C0C3RJKNKPG' } = {}) {
    const event = this.db.prepare('SELECT event_id,job_id FROM events WHERE event_id=? AND job_id=?').get(eventId, jobId);
    if (!event) throw new Error(`cannot begin unknown Slack projection event: ${eventId}`);
    if (this.isSlackProjected(eventId)) return false;
    const result = this.db.prepare(`INSERT OR IGNORE INTO slack_projection_uncertain
      (event_id,job_id,channel,target,error,marked_at) VALUES(?,?,?,?,?,?)`)
      .run(eventId, jobId, channel, target, 'SEND_STARTED_OUTCOME_UNRESOLVED', now());
    if (result.changes !== 1) return false;
    const persisted = this.db.prepare('SELECT event_id,job_id,channel,target,error FROM slack_projection_uncertain WHERE event_id=?').get(eventId);
    if (!persisted || persisted.job_id !== jobId || persisted.channel !== channel || persisted.target !== target || persisted.error !== 'SEND_STARTED_OUTCOME_UNRESOLVED') {
      throw new Error(`Slack projection send claim exact readback failed: ${eventId}`);
    }
    return true;
  }
  releaseSlackProjectionSendClaim(eventId, jobId, { channel = 'slack', target = 'C0C3RJKNKPG' } = {}) {
    // Only the exact pre-send sentinel may be released. Once a remote process
    // started, the sender must convert the row to an uncertainty record and
    // this method can no longer make the event eligible for automatic replay.
    // Acquire SQLite's writer reservation before checking the claim/projection
    // pair so a competing completion or uncertainty transition cannot interleave.
    this.db.exec('SAVEPOINT release_slack_projection_send_claim');
    try {
      const claim = this.db.prepare(`UPDATE slack_projection_uncertain SET marked_at=marked_at
        WHERE event_id=? AND job_id=? AND channel=? AND target=? AND error='SEND_STARTED_OUTCOME_UNRESOLVED'`)
        .run(eventId, jobId, channel, target);
      if (claim.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT release_slack_projection_send_claim');
        return false;
      }
      const event = this.db.prepare('SELECT event_id,job_id FROM events WHERE event_id=? AND job_id=?').get(eventId, jobId);
      if (!event || this.isSlackProjected(eventId)) {
        this.db.exec('RELEASE SAVEPOINT release_slack_projection_send_claim');
        return false;
      }
      const removed = this.db.prepare(`DELETE FROM slack_projection_uncertain
        WHERE event_id=? AND job_id=? AND channel=? AND target=? AND error='SEND_STARTED_OUTCOME_UNRESOLVED'
          AND NOT EXISTS (SELECT 1 FROM slack_projections WHERE event_id=?)`)
        .run(eventId, jobId, channel, target, eventId);
      if (removed.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT release_slack_projection_send_claim');
        return false;
      }
      const remainingClaim = this.db.prepare('SELECT 1 FROM slack_projection_uncertain WHERE event_id=?').get(eventId);
      const projection = this.db.prepare('SELECT 1 FROM slack_projections WHERE event_id=?').get(eventId);
      if (remainingClaim || projection) throw new Error(`Slack projection no-send claim release readback failed: ${eventId}`);
      this.db.exec('RELEASE SAVEPOINT release_slack_projection_send_claim');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT release_slack_projection_send_claim'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT release_slack_projection_send_claim'); } catch {}
      throw error;
    }
  }
  completeSlackProjection(eventId, jobId, { channel = 'slack', target = 'C0C3RJKNKPG', messageId, rootMessageId = null } = {}) {
    if (!(typeof messageId === 'string' && messageId.trim())) throw new Error('cannot complete Slack projection without a destination message identifier');
    this.db.exec('SAVEPOINT complete_slack_projection');
    try {
      const claim = this.db.prepare('SELECT * FROM slack_projection_uncertain WHERE event_id=? AND job_id=?').get(eventId, jobId);
      if (!claim || claim.channel !== channel || claim.target !== target) throw new Error(`Slack projection send ownership is missing or mismatched: ${eventId}`);
      if (claim.error !== 'SEND_STARTED_OUTCOME_UNRESOLVED') throw new Error(`Slack projection outcome is already uncertain and requires explicit reconciliation: ${eventId}`);
      const existing = this.db.prepare('SELECT * FROM slack_projections WHERE event_id=?').get(eventId);
      if (existing && (existing.job_id !== jobId || existing.channel !== channel || existing.target !== target || existing.message_id !== messageId)) {
        throw new Error(`Slack projection completion conflicts with prior receipt: ${eventId}`);
      }
      this.db.prepare('INSERT OR IGNORE INTO slack_projections(event_id,job_id,channel,target,message_id,projected_at) VALUES(?,?,?,?,?,?)')
        .run(eventId, jobId, channel, target, messageId, now());
      const persisted = this.db.prepare('SELECT * FROM slack_projections WHERE event_id=?').get(eventId);
      if (!persisted || persisted.job_id !== jobId || persisted.channel !== channel || persisted.target !== target || persisted.message_id !== messageId) {
        throw new Error(`Slack projection completion exact readback failed: ${eventId}`);
      }
      if (rootMessageId) {
        this.db.prepare('UPDATE slack_threads SET root_message_id=?,updated_at=? WHERE job_id=? AND root_message_id IS NULL')
          .run(rootMessageId, now(), jobId);
        const thread = this.getSlackThread(jobId);
        if (!thread || thread.root_message_id !== rootMessageId) throw new Error(`Slack thread root receipt conflicts with durable thread: ${jobId}`);
      }
      const removed = this.db.prepare('DELETE FROM slack_projection_uncertain WHERE event_id=? AND job_id=? AND channel=? AND target=?')
        .run(eventId, jobId, channel, target);
      if (removed.changes !== 1) throw new Error(`Slack projection send claim was lost before completion: ${eventId}`);
      this.db.exec('RELEASE SAVEPOINT complete_slack_projection');
      return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT complete_slack_projection'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT complete_slack_projection'); } catch {}
      throw error;
    }
  }
  claimSlackProjection(eventId, jobId, { channel = 'slack', target = 'C0C3RJKNKPG', messageId = null } = {}) {
    const ts = now();
    if (this.db.prepare('SELECT 1 FROM slack_projection_uncertain WHERE event_id=?').get(eventId)) {
      throw new Error(`cannot claim an uncertain Slack projection without explicit reconciliation: ${eventId}`);
    }
    const result = this.db.prepare('INSERT OR IGNORE INTO slack_projections(event_id, job_id, channel, target, message_id, projected_at) VALUES(?, ?, ?, ?, ?, ?)').run(eventId, jobId, channel, target, messageId, ts);
    return result.changes === 1;
  }
  markSlackProjectionUncertain(eventId, jobId, { channel = 'slack', target = 'C0C3RJKNKPG', error } = {}) {
    const event = this.db.prepare('SELECT event_id,job_id FROM events WHERE event_id=? AND job_id=?').get(eventId, jobId);
    if (!event) throw new Error(`cannot mark unknown Slack projection event uncertain: ${eventId}`);
    if (this.isSlackProjected(eventId)) throw new Error(`cannot mark an already projected Slack event uncertain: ${eventId}`);
    const message = String(error || 'remote delivery outcome ambiguous').slice(0, 2000);
    const ts = now();
    this.db.prepare('INSERT OR IGNORE INTO slack_projection_uncertain(event_id,job_id,channel,target,error,marked_at) VALUES(?,?,?,?,?,?)')
      .run(eventId, jobId, channel, target, message, ts);
    this.db.prepare("UPDATE slack_projection_uncertain SET error=? WHERE event_id=? AND job_id=? AND channel=? AND target=? AND error='SEND_STARTED_OUTCOME_UNRESOLVED'")
      .run(message, eventId, jobId, channel, target);
    const persisted = this.db.prepare('SELECT event_id,job_id,channel,target,error FROM slack_projection_uncertain WHERE event_id=?').get(eventId);
    if (!persisted || persisted.job_id !== jobId || persisted.channel !== channel || persisted.target !== target || persisted.error !== message) {
      throw new Error(`Slack projection uncertain state conflicts with existing evidence: ${eventId}`);
    }
    return persisted;
  }
  listUncertainSlackProjections(jobId = null) {
    return jobId
      ? this.db.prepare('SELECT * FROM slack_projection_uncertain WHERE job_id=? ORDER BY marked_at,event_id').all(jobId)
      : this.db.prepare('SELECT * FROM slack_projection_uncertain ORDER BY marked_at,event_id').all();
  }
  isSlackProjectionRelevant(event) {
    // High-frequency heartbeats are durable operational telemetry, not a
    // user-facing workflow event. Keep them in the event log but exclude them
    // from the Slack projection contract so a busy session cannot starve
    // business-state notifications.
    return new Set([
      'job.proposal_requested', 'approval.approved', 'task.created', 'task.dispatched',
      'attempt.started', 'task.runtime_attached', 'task.completed', 'task.failed',
      'job.failed', 'provider.admitted', 'provider.waiting', 'report.created',
      'delivery.claimed', 'job.completed'
    ]).has(event?.type);
  }
  listUnprojectedEvents(limit = 50, jobId = null) {
    const relevant = "('job.proposal_requested','approval.approved','task.created','task.dispatched','attempt.started','task.runtime_attached','task.completed','task.failed','job.failed','provider.admitted','provider.waiting','report.created','delivery.claimed','job.completed')";
    const base = "SELECT e.* FROM events e LEFT JOIN slack_projections p ON p.event_id = e.event_id LEFT JOIN slack_projection_uncertain u ON u.event_id = e.event_id WHERE p.event_id IS NULL AND u.event_id IS NULL AND e.type IN " + relevant;
    if (jobId) return this.db.prepare(base + " AND e.job_id = ? ORDER BY e.created_at ASC LIMIT ?").all(jobId, limit);
    return this.db.prepare(base + " ORDER BY e.created_at ASC LIMIT ?").all(limit);
  }
  getSlackProjection(jobId) {
    const thread = this.getSlackThread(jobId);
    const relevant = this.db.prepare('SELECT event_id,type FROM events WHERE job_id = ?').all(jobId).filter(event => this.isSlackProjectionRelevant(event));
    const projectedIds = new Set(this.db.prepare('SELECT event_id FROM slack_projections WHERE job_id = ?').all(jobId).map(row => row.event_id));
    const projected = relevant.filter(event => projectedIds.has(event.event_id)).length;
    const total = relevant.length;
    const pending = total - projected;
    const last = this.db.prepare('SELECT event_id, projected_at, message_id FROM slack_projections WHERE job_id = ? ORDER BY projected_at DESC LIMIT 1').get(jobId) || null;
    const view = this.getSlackJobView(jobId);
    return { jobId, thread, totalEvents: total, projectedEvents: projected, pendingEvents: pending, lastProjected: last, view };
  }
  refreshSlackJobView(jobId, { eventId: lastEventId = null, eventType: lastEventType = null } = {}) {
    const job = this.getJob(jobId);
    if (!job) return null;
    const counts = this.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status IN ('failed','timeout','cancelled') THEN 1 ELSE 0 END) AS failed
      FROM tasks WHERE job_id=?`).get(jobId);
    const ts = now();
    this.db.prepare(`INSERT INTO slack_job_views(job_id,state,status,provider_waiting,provider_retry_at,task_total,task_pending,task_running,task_completed,task_failed,last_event_type,last_event_id,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET state=excluded.state,status=excluded.status,provider_waiting=excluded.provider_waiting,
      provider_retry_at=excluded.provider_retry_at,task_total=excluded.task_total,task_pending=excluded.task_pending,
      task_running=excluded.task_running,task_completed=excluded.task_completed,task_failed=excluded.task_failed,
      last_event_type=excluded.last_event_type,last_event_id=excluded.last_event_id,updated_at=excluded.updated_at`)
      .run(jobId, job.state, job.status, Number(job.provider_waiting) || 0, job.provider_retry_at || null,
        Number(counts?.total) || 0, Number(counts?.pending) || 0, Number(counts?.running) || 0,
        Number(counts?.completed) || 0, Number(counts?.failed) || 0, lastEventType, lastEventId, ts);
    return this.getSlackJobView(jobId);
  }
  getSlackJobView(jobId) { return this.db.prepare('SELECT * FROM slack_job_views WHERE job_id=?').get(jobId) || null; }
  approve(jobId, rawText, actor = 'chat-on-steroids-user', { workspace = process.env.WORKFLOW_WORKSPACE, customWorkflow = null, successContract = undefined, roleProfiles = [] } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.getJob(jobId);
      if (!job) throw new Error('job not found: ' + jobId);
      if (job.status !== 'active' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase())) {
        throw new Error(`cannot approve terminal/inactive Job: ${jobId}`);
      }
      let proposal = this.getCurrentProposal(jobId);
      if (!proposal) {
        this.recordEvent(jobId, 'job.proposal_requested', { task: job.title }, hash(job.title));
        proposal = this.getCurrentProposal(jobId);
      }
      if (job.state === 'APPROVED' && this.isApprovalCurrent(jobId)) {
        this.db.exec('COMMIT');
        return this.getJob(jobId);
      }
      if (!['IDLE', 'PROPOSED', 'DISCUSSING'].includes(String(job.state || '').toUpperCase())) {
        throw new Error(`cannot approve Job from state=${job.state}: ${jobId}`);
      }
      const approvalId = id('approval'); const ts = now();
      this.db.prepare("INSERT INTO approvals(approval_id, job_id, decision, actor, raw_text, proposal_hash, created_at) VALUES(?, ?, 'approved', ?, ?, ?, ?)").run(approvalId, jobId, actor, rawText, proposal.proposalHash, ts);
      const changed = this.db.prepare("UPDATE jobs SET state='APPROVED', approved_at=?, updated_at=? WHERE job_id=? AND state=? AND status='active'")
        .run(ts, ts, jobId, job.state);
      if (changed.changes !== 1) throw new Error(`approval lost Job state compare-and-set: ${jobId}`);
      const runtime = this.getWorkflowRuntimeState(jobId);
      if (runtime?.phase === 'PROPOSED') this.transitionWorkflowPhase(jobId, 'APPROVED', { event: 'workflow.approved', payload: { actor } });
      this.recordEvent(jobId, 'approval.approved', { actor, rawText, proposalHash: proposal.proposalHash }, hash(`${rawText}|${proposal.proposalHash}`));
      if (isSupportedWorkflow(this.getJob(jobId))) this.compileExecutionPlan(jobId, { workspace, customWorkflow, successContract: successContract ?? proposal.payload.success_contract, roleProfiles });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getJob(jobId);
  }
  dispatch(jobId, { role = 'cto', description }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const jobBeforeDispatch = this.getJob(jobId);
      if (!jobBeforeDispatch) throw new Error(`job not found: ${jobId}`);
      const legacyIdleDispatch = String(jobBeforeDispatch.state || '').toUpperCase() === 'IDLE' && !isSupportedWorkflow(jobBeforeDispatch);
      if (jobBeforeDispatch.status !== 'active' || (!legacyIdleDispatch && !['APPROVED', 'EXECUTING'].includes(String(jobBeforeDispatch.state || '').toUpperCase()))) {
        throw new Error(`dispatch requires an active approved Job; state=${jobBeforeDispatch.state} status=${jobBeforeDispatch.status}`);
      }
      if (isSupportedWorkflow(jobBeforeDispatch)) this.assertApprovalCurrent(jobId);
      const task = this.ensureTask(jobId, { role, description }); const ts = now();
      const plan = this.getExecutionPlan(jobId);
      if (plan?.synthesis && String(role).toLowerCase() === 'cto') {
        let metadata = {};
        try { metadata = parseStrictJson(task.metadata_json || '{}'); } catch (_) {}
        metadata.workflow_plan_task_id = plan.synthesis.id;
        this.db.prepare('UPDATE tasks SET metadata_json=?, updated_at=? WHERE task_id=?').run(JSON.stringify(metadata), ts, task.task_id);
      }
      if (!['pending', 'running'].includes(String(task.status || '').toLowerCase())) {
        throw new Error(`cannot dispatch terminal task: ${task.task_id} (${task.status})`);
      }
      this.db.prepare("UPDATE tasks SET status='running', updated_at=? WHERE task_id=? AND status IN ('pending','running')").run(ts, task.task_id);
      if (this.db.prepare('SELECT changes() AS n').get().n !== 1) throw new Error(`dispatch lost task-state compare-and-set: ${task.task_id}`);
      const jobUpdate = this.db.prepare("UPDATE jobs SET state='EXECUTING', updated_at=? WHERE job_id=? AND state=? AND status='active'")
        .run(ts, jobId, jobBeforeDispatch.state);
      if (jobUpdate.changes !== 1) throw new Error(`dispatch lost Job state compare-and-set: ${jobId}`);
      const runtime = this.getWorkflowRuntimeState(jobId);
      if (runtime?.phase === 'APPROVED') this.transitionWorkflowPhase(jobId, 'SPAWN_CTO', { event: 'workflow.cto_spawn_required', payload: { taskId: task.task_id } });
      this.recordEvent(jobId, 'task.dispatched', { taskId: task.task_id, role, description }, task.task_id);
      const persisted = this.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(task.task_id);
      if (persisted?.status !== 'running' || this.getJob(jobId)?.state !== 'EXECUTING') throw new Error(`dispatch durable readback mismatch: ${jobId}`);
      this.db.exec('COMMIT');
      return persisted;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  startAttempt(jobId, { openclawRunId = null } = {}) {
    const job = this.getJob(jobId);
    if (!job?.active_task_id) return null;
    const existing = this.db.prepare("SELECT * FROM attempts WHERE task_id = ? AND status IN ('started') ORDER BY started_at DESC, rowid DESC LIMIT 1").get(job.active_task_id);
    if (existing) return existing;
    const attemptId = id('attempt'); const ts = now();
    this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', ?, ?)").run(attemptId, job.active_task_id, openclawRunId, ts);
    this.recordEvent(jobId, 'attempt.started', { attemptId, taskId: job.active_task_id, openclawRunId }, attemptId);
    return this.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
  }
  attachOpenClawRun(jobId, { runId, sessionKey }) {
    if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('jobId must be a non-empty string');
    if (runId !== null && runId !== undefined && (typeof runId !== 'string' || !runId.trim())) {
      throw new Error('OpenClaw runId must be a non-empty string or null');
    }
    if (sessionKey !== null && sessionKey !== undefined && (typeof sessionKey !== 'string' || !sessionKey.trim())) {
      throw new Error('OpenClaw sessionKey must be a non-empty string or null');
    }
    if (runId == null && sessionKey == null) throw new Error('runtime attachment requires a runId or sessionKey');
    this.db.exec('SAVEPOINT attach_openclaw_run_transition');
    try {
      const jobLock = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(jobId);
      if (jobLock.changes !== 1) throw new Error(`job not found for runtime attachment: ${jobId}`);
      const job = this.getJob(jobId);
      if (!job?.active_task_id || job.status !== 'active' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase())) {
        this.db.exec('RELEASE SAVEPOINT attach_openclaw_run_transition');
        return null;
      }
      const taskLock = this.db.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=? AND job_id=?').run(job.active_task_id, jobId);
      if (taskLock.changes !== 1) throw new Error('active task is missing or belongs to a different job');
      const task = this.getTask(job.active_task_id);
      if (!task || task.status !== 'running') throw new Error(`runtime attachment requires a running task: ${job.active_task_id}`);
      let activeAttempts = this.db.prepare("SELECT * FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC,rowid DESC").all(task.task_id);
      if (activeAttempts.length > 1) throw new Error(`runtime attachment found multiple started attempts for task ${task.task_id}`);
      if (activeAttempts.length === 0) {
        // Older local dispatch paths can set active_task_id without creating an
        // attempts row. Create the first durable attempt here, inside the same
        // savepoint as run/session binding, rather than attaching an external ID
        // to a task that has no attempt lineage.
        const attemptId = id('attempt');
        const attemptStartedAt = now();
        this.db.prepare("INSERT INTO attempts(attempt_id,task_id,status,openclaw_run_id,started_at) VALUES(?,?,'started',NULL,?)")
          .run(attemptId, task.task_id, attemptStartedAt);
        const attemptPayload = { attemptId, taskId: task.task_id, openclawRunId: null };
        const attemptEventId = this.recordEvent(jobId, 'attempt.started', attemptPayload, attemptId);
        const attemptEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(attemptEventId);
        if (!attemptEvent || attemptEvent.event_id !== eventId(jobId, 'attempt.started', attemptId) ||
            attemptEvent.job_id !== jobId || attemptEvent.type !== 'attempt.started' || attemptEvent.payload_json !== JSON.stringify(attemptPayload)) {
          throw new Error('runtime attachment could not establish the initial attempt/event lineage');
        }
        activeAttempts = this.db.prepare("SELECT * FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC,rowid DESC").all(task.task_id);
      }
      if (activeAttempts.length !== 1) throw new Error(`runtime attachment requires exactly one started attempt for task ${task.task_id}`);
      const attempt = activeAttempts[0];
      const attemptOrdinal = this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(task.task_id).n;
      if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 1) throw new Error('runtime attachment has malformed durable attempt count');
      const effectiveRunId = runId ?? attempt.openclaw_run_id ?? null;
      const effectiveSessionKey = sessionKey ?? null;
      if (effectiveRunId && attempt.openclaw_run_id && attempt.openclaw_run_id !== effectiveRunId) {
        throw new Error('runtime attachment runId conflicts with the exact started task attempt');
      }
      if (effectiveRunId) {
        const priorTask = this.db.prepare('SELECT task_id FROM tasks WHERE openclaw_run_id=? AND task_id<>? LIMIT 1').get(effectiveRunId, task.task_id);
        const priorAttempt = this.db.prepare("SELECT attempt_id,status FROM attempts WHERE openclaw_run_id=? AND task_id=? AND status<>'started' LIMIT 1").get(effectiveRunId, task.task_id);
        if (priorTask || priorAttempt) throw new Error('runtime attachment runId is already bound to another task or a terminal prior attempt');
      }
      const existingSession = effectiveSessionKey ? this.getSessionByOpenClawKey(effectiveSessionKey) : null;
      if (existingSession && (existingSession.task_id !== task.task_id || existingSession.job_id !== jobId || existingSession.role !== task.role)) {
        throw new Error(`OpenClaw session ${effectiveSessionKey} already belongs to a different task/session identity`);
      }
      const ts = now();
      const taskUpdate = this.db.prepare(`UPDATE tasks SET openclaw_run_id=?,openclaw_session_key=?,updated_at=?
        WHERE task_id=? AND job_id=? AND status='running'`).run(effectiveRunId, effectiveSessionKey, ts, task.task_id, jobId);
      if (taskUpdate.changes !== 1) throw new Error('runtime attachment lost the active task compare-and-set');
      const attemptUpdate = this.db.prepare("UPDATE attempts SET openclaw_run_id=? WHERE attempt_id=? AND task_id=? AND status='started' AND (openclaw_run_id IS NULL OR openclaw_run_id=?)")
        .run(effectiveRunId, attempt.attempt_id, task.task_id, effectiveRunId);
      if (attemptUpdate.changes !== 1) throw new Error('runtime attachment lost the started attempt compare-and-set');
      if (effectiveSessionKey) {
        if (existingSession) this.updateAgentSession(existingSession.session_id, { state: 'ACTIVE', heartbeat: true, attempt: Math.max(existingSession.attempt, attemptOrdinal) });
        else this.createAgentSession(task.task_id, { sessionKey: effectiveSessionKey, role: task.role, state: 'ACTIVE', attempt: attemptOrdinal });
      }
      const payload = { taskId: task.task_id, runId: effectiveRunId, sessionKey: effectiveSessionKey, attemptId: attempt.attempt_id };
      const eventKey = `${task.task_id}|${attempt.attempt_id}|${effectiveRunId ?? ''}|${effectiveSessionKey ?? ''}`;
      const eventIdValue = this.recordEvent(jobId, 'task.runtime_attached', payload, eventKey);
      const event = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(eventIdValue);
      const persistedTask = this.getTask(task.task_id);
      const persistedAttempt = this.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attempt.attempt_id);
      if (!event || event.event_id !== eventId(jobId, 'task.runtime_attached', eventKey) || event.job_id !== jobId ||
          event.type !== 'task.runtime_attached' || event.payload_json !== JSON.stringify(payload) ||
          persistedTask?.openclaw_run_id !== effectiveRunId || persistedTask?.openclaw_session_key !== effectiveSessionKey ||
          persistedAttempt?.openclaw_run_id !== effectiveRunId || persistedAttempt?.status !== 'started') {
        throw new Error('runtime attachment row/event lineage readback failed');
      }
      this.db.exec('RELEASE SAVEPOINT attach_openclaw_run_transition');
      return persistedTask;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT attach_openclaw_run_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT attach_openclaw_run_transition'); } catch {}
      throw error;
    }
  }
  reconcileRuntimeRefs(jobId, messages = []) {
    const job = this.getJob(jobId);
    // Terminal jobs are durable history, not live workflow state. Runtime
    // transcripts may contain stale spawn receipts; never replay them into
    // business task creation after the Job has reached a terminal status.
    if (!job || ['completed', 'failed', 'cancelled'].includes(String(job.status || '').toLowerCase())) return null;
    if (!job.active_task_id) return null;
    // Durable results outrank replayed runtime receipts. A restart can replay
    // an old spawn receipt after a child already completed; never resurrect it.
    // Never infer terminal task state from a result row alone. Older recovery
    // code used MAX(created_at), which is ambiguous for tied timestamps, and
    // could promote an isolated success result without its attempt/event lineage.
    // Serialize reconciliation and require the result, terminal event and attempt
    // ledger to agree before changing task status.
    this.db.exec('SAVEPOINT reconcile_runtime_result_lineage');
    try {
      const reservation = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=? AND status NOT IN (\'completed\',\'failed\',\'cancelled\')').run(jobId);
      if (reservation.changes === 1) {
        const runningTasks = this.db.prepare("SELECT * FROM tasks WHERE job_id=? AND status='running' ORDER BY created_at,rowid").all(jobId);
        for (const runningTask of runningTasks) {
          const results = this.db.prepare('SELECT result_id,task_id,outcome,content,created_at,rowid AS durable_rowid FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC').all(runningTask.task_id);
          if (!results.length) continue;
          const latest = results[0];
          if (!['success', 'failure'].includes(latest.outcome)) continue;
          const terminalType = latest.outcome === 'success' ? ['task.completed', 'task.local_completed'] : ['task.failed', 'task.local_failed'];
          const eventRows = this.db.prepare(`SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type IN (${terminalType.map(() => '?').join(',')})`)
            .all(jobId, ...terminalType);
          const matchingEvents = [];
          for (const event of eventRows) {
            let payload;
            try { payload = parseStrictJson(event.payload_json); } catch { continue; }
            if (event.payload_json !== JSON.stringify(payload)) continue;
            if (payload?.taskId === runningTask.task_id && payload?.resultId === latest.result_id &&
                (payload?.outcome === undefined || payload.outcome === latest.outcome)) matchingEvents.push({ event, payload });
          }
          const attempts = this.db.prepare('SELECT attempt_id,status FROM attempts WHERE task_id=? ORDER BY started_at,rowid').all(runningTask.task_id);
          const startedAttempts = attempts.filter(attempt => attempt.status === 'started');
          const expectedAttemptStatus = latest.outcome === 'success' ? 'completed' : 'failed';
          const terminalAttempts = attempts.filter(attempt => attempt.status === expectedAttemptStatus);
          const eventAttemptIds = new Set(matchingEvents.map(item => item.payload.attemptId).filter(value => value != null));
          const lineageValid = matchingEvents.length === 1 && startedAttempts.length === 0 &&
            attempts.length > 0 && terminalAttempts.length === 1 &&
            (eventAttemptIds.size === 0 || (eventAttemptIds.size === 1 && eventAttemptIds.has(terminalAttempts[0].attempt_id)));
          if (!lineageValid) {
            const blockedKey = `${runningTask.task_id}|${latest.result_id}|terminal-lineage-incomplete`;
            this.recordEvent(jobId, 'task.result_reconciliation_blocked', {
              taskId: runningTask.task_id,
              resultId: latest.result_id,
              resultOutcome: latest.outcome,
              reason: 'result row lacks exactly matching terminal event and settled attempt lineage; task state was not inferred'
            }, blockedKey);
            continue;
          }
          const terminalStatus = latest.outcome === 'success' ? 'completed' : 'failed';
          const taskUpdate = this.db.prepare("UPDATE tasks SET status=?,updated_at=? WHERE task_id=? AND job_id=? AND status='running'")
            .run(terminalStatus, now(), runningTask.task_id, jobId);
          if (taskUpdate.changes !== 1) throw new Error(`runtime result reconciliation lost task-state CAS: ${runningTask.task_id}`);
          const persisted = this.getTask(runningTask.task_id);
          if (persisted?.status !== terminalStatus) throw new Error(`runtime result reconciliation readback mismatch: ${runningTask.task_id}`);
        }
      }
      this.db.exec('RELEASE SAVEPOINT reconcile_runtime_result_lineage');
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT reconcile_runtime_result_lineage'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT reconcile_runtime_result_lineage'); } catch {}
      throw error;
    }
    let lastAttached = this.getTask(job.active_task_id);
    const turns = Array.isArray(messages) ? messages : [];
    // Coordinator history contains spawn calls from older jobs. Reconcile only
    // the current user turn onward, preventing cross-job graph contamination.
    let startIndex = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]?.role === 'user') { startIndex = i; break; }
    }
    // Spawn receipts/completion events can arrive in later OpenClaw turns.
    // Reconcile the full transcript; pending child tasks remain job-scoped.
    const currentTurns = turns;
    for (let i = 0; i < currentTurns.length; i++) {
      const calls = Array.isArray(currentTurns[i]?.tool_calls) ? currentTurns[i].tool_calls : [];
      for (const call of calls) {
        const name = call?.function?.name || call?.name;
        if (name !== 'sessions_spawn') continue;
        let args = {};
        try { args = typeof call?.function?.arguments === 'string' ? parseStrictJson(call.function.arguments) : (call?.arguments || {}); } catch (_) {}
        const description = String(args.task || '').trim();
        const role = String(args.agentId || args.agent_id || 'unknown');
        const next = currentTurns[i + 1];
        const rawNext = typeof next?.content === 'string' ? next.content : JSON.stringify(next?.content || '');
        const runId = rawNext.match(/(?:runId|run_id)["'\s:=]+([A-Za-z0-9._:-]+)/i)?.[1] || null;
        const sessionKey = rawNext.match(/(?:childSessionKey|child_session_key)["'\s:=]+([A-Za-z0-9._:@/-]+)/i)?.[1] || null;
        if (description && runId && sessionKey && sessionKey.length >= 12 && sessionKey.includes(':')) {
          const parent = this.getTask(job.active_task_id);
          // The first native spawn is the coordinator-created CTO task itself.
          // Subsequent sessions_spawn calls from that CTO become real child tasks.
          if (parent && !parent.openclaw_run_id && !parent.openclaw_session_key && parent.role === role) {
            lastAttached = this.attachOpenClawRun(jobId, { runId, sessionKey }) || lastAttached;
            const attempt = this.db.prepare("SELECT * FROM attempts WHERE task_id = ? AND status = 'started' LIMIT 1").get(parent.task_id);
            if (attempt && !attempt.openclaw_run_id && runId) this.db.prepare('UPDATE attempts SET openclaw_run_id = ? WHERE attempt_id = ?').run(runId, attempt.attempt_id);
            continue;
          }
          // Full-transcript reconciliation is intentionally repeatable. A native
          // spawn receipt can appear in many later turns, so never create a second
          // business task for an already-attached OpenClaw runtime identity.
          const existingRuntime = this.db.prepare(`
            SELECT * FROM tasks
            WHERE job_id = ?
              AND (
                (? IS NOT NULL AND openclaw_run_id = ?)
                OR (? IS NOT NULL AND openclaw_session_key = ?)
              )
            ORDER BY created_at ASC, rowid ASC LIMIT 1
          `).get(jobId, runId, runId, sessionKey, sessionKey);
          if (existingRuntime) {
            if (runId || sessionKey) this.attachTaskRuntime(existingRuntime.task_id, { runId, sessionKey });
            lastAttached = existingRuntime;
            continue;
          }
          const child = this.createChildTask(jobId, { parentTaskId: job.active_task_id, role, description });
          lastAttached = this.attachTaskRuntime(child.task_id, { runId, sessionKey }) || lastAttached;
          const attempt = this.db.prepare("SELECT * FROM attempts WHERE task_id = ? AND status = 'started' LIMIT 1").get(child.task_id);
          if (!attempt) {
            const attemptId = id('attempt'); const ts = now();
            this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', ?, ?)").run(attemptId, child.task_id, runId, ts);
            this.recordEvent(jobId, 'attempt.started', { attemptId, taskId: child.task_id, openclawRunId: runId }, attemptId);
          }
        }
      }
    }
    const raw = currentTurns.map(m => typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '')).join('\n');
    const childPairs = [];
    const childPairRe = /(?:Child session|childSessionKey|child_session_key)\s*[:=\\"]+\s*([A-Za-z0-9._:@/-]+)[\s\S]{0,500}?(?:Run ID|runId|run_id)\s*[:=\\"]+\s*([A-Za-z0-9._:-]+)/gi;
    for (const match of raw.matchAll(childPairRe)) childPairs.push({ sessionKey: match[1], runId: match[2] });
    const receiptRe = /\\"childSessionKey\\"\s*:\s*\\"([^\\"]+)\\"[\s\S]{0,500}?\\"runId\\"\s*:\s*\\"([^\\"]+)\\"/g;
    for (const match of raw.matchAll(receiptRe)) childPairs.push({ sessionKey: match[1], runId: match[2] });
    const plainReceiptRe = /["']childSessionKey["']\s*:\s*["']([^"']+)["'][\s\S]{0,500}?["']runId["']\s*:\s*["']([^"']+)["']/gi;
    for (const match of raw.matchAll(plainReceiptRe)) childPairs.push({ sessionKey: match[1], runId: match[2] });
    const plainReceiptReverseRe = /["']runId["']\s*:\s*["']([^"']+)["'][\s\S]{0,500}?["']childSessionKey["']\s*:\s*["']([^"']+)["']/gi;
    for (const match of raw.matchAll(plainReceiptReverseRe)) childPairs.push({ sessionKey: match[2], runId: match[1] });
    if (childPairs.length) {
      const uniquePairs = [];
      const seenPairs = new Set();
      for (const pair of childPairs) {
        if (!pair.runId || !pair.sessionKey || pair.sessionKey.length < 12 || !pair.sessionKey.includes(':')) continue;
        const key = `${pair.runId || ''}|${pair.sessionKey || ''}`;
        if (!seenPairs.has(key)) { seenPairs.add(key); uniquePairs.push(pair); }
      }
      const pendingChildren = this.db.prepare("SELECT * FROM tasks WHERE job_id = ? AND parent_task_id IS NOT NULL AND status IN ('pending','running') AND openclaw_run_id IS NULL AND openclaw_session_key IS NULL ORDER BY created_at ASC").all(jobId);
      for (let i = 0; i < Math.min(uniquePairs.length, pendingChildren.length); i++) {
        const owner = this.getSessionByOpenClawKey(uniquePairs[i].sessionKey);
        if (owner && owner.task_id !== pendingChildren[i].task_id) continue;
        try { this.attachTaskRuntime(pendingChildren[i].task_id, uniquePairs[i]); }
        catch (error) {
          if (!/already belongs to task/i.test(String(error?.message || error))) throw error;
        }
      }
    }
    // Recover a parent runtime from raw transcript only when the session key
    // explicitly identifies the same parent role. Child receipts must never be
    // allowed to occupy the parent's runtime identity.
    const parent = this.getTask(job.active_task_id);
    if (parent && !parent.openclaw_run_id && !parent.openclaw_session_key) {
      const parentPrefix = `agent:${String(parent.role || '').toLowerCase()}:subagent:`;
      const parentPair = childPairs.find(pair => String(pair.sessionKey || '').toLowerCase().startsWith(parentPrefix));
      if (parentPair) {
        lastAttached = this.attachOpenClawRun(jobId, parentPair) || lastAttached;
        const attempt = this.db.prepare("SELECT * FROM attempts WHERE task_id = ? AND status = 'started' LIMIT 1").get(parent.task_id);
        if (attempt && !attempt.openclaw_run_id && parentPair.runId) {
          this.db.prepare('UPDATE attempts SET openclaw_run_id = ? WHERE attempt_id = ?').run(parentPair.runId, attempt.attempt_id);
        }
      }
    }
    return lastAttached;
  }
  complete(jobId, content, outcome = 'success') {
    // Legacy completion is still used by recovery and older workflow callers.
    // Serialize its read/decision/write sequence so concurrent success/failure
    // callbacks cannot both observe an active job and persist contradictory
    // result/task/job outcomes. The savepoint also rolls back every row/event if
    // a process dies after the job-state update but before the completion event.
    this.db.exec('SAVEPOINT complete_job_transition');
    try {
      const reservation = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(jobId);
      if (reservation.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT complete_job_transition');
        return null;
      }
      const result = this.completeJobTransitionLocked(jobId, content, outcome);
      this.db.exec('RELEASE SAVEPOINT complete_job_transition');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT complete_job_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT complete_job_transition'); } catch {}
      throw error;
    }
  }
  completeJobTransitionLocked(jobId, content, outcome = 'success') {
    const job = this.getJob(jobId); if (!job) return null; const taskId = job.active_task_id; const resultId = id('result'); const ts = now();
    // Late OpenClaw/runtime completions must never overwrite a newer terminal
    // Job result. The Job is the durable authority; stale child events are
    // recorded by their own reconciliation paths but cannot reopen/fail it.
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase()) ||
        ['completed', 'failed', 'cancelled'].includes(String(job.status || '').toLowerCase())) return { ...job, idempotent: true };
    const completionKey = hash(`${taskId || jobId}|${outcome}|${content || ''}`);
    const priorTask = taskId ? this.db.prepare('SELECT status, role, description FROM tasks WHERE task_id = ?').get(taskId) : null;
    if (taskId && outcome === 'success') {
      const activeTask = this.getTask(taskId);
      if (activeTask?.role === 'cto' && /sessions_spawn|specialist|delegat/i.test(activeTask.description || '')) {
        const children = this.db.prepare('SELECT status FROM tasks WHERE parent_task_id = ?').all(taskId);
        if (!children.length) {
          this.db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE task_id = ?").run(ts, taskId);
          this.db.prepare("UPDATE attempts SET status = 'failed', finished_at = ? WHERE task_id = ? AND status = 'started'").run(ts, taskId);
          this.transition(jobId, 'IDLE', 'failed');
          this.recordEvent(jobId, 'job.failed', { reason: 'cto completed without required specialist child task', taskId }, 'CTO completed without required specialist child task');
          return this.getJob(jobId);
        }
        if (children.some(t => ['failed', 'cancelled'].includes(t.status))) {
          this.db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE task_id = ?").run(ts, taskId);
          this.db.prepare("UPDATE attempts SET status = 'failed', finished_at = ? WHERE task_id = ? AND status = 'started'").run(ts, taskId);
          this.transition(jobId, 'IDLE', 'failed');
          this.recordEvent(jobId, 'job.failed', { reason: 'required specialist child failed validation or execution', taskId }, 'required specialist child failed validation or execution');
          return this.getJob(jobId);
        }
        if (children.some(t => !['completed', 'failed', 'cancelled'].includes(t.status))) {
          return this.getJob(jobId);
        }
        const childRows = this.db.prepare('SELECT task_id, role, status, description FROM tasks WHERE parent_task_id = ?').all(taskId);
        const isProductionE2E = isProductionWorkflow(this.getJob(jobId));
        const requiredRoles = isProductionE2E ? ProductionRoles : [];
        const missingRequiredRole = requiredRoles.find(role => !childRows.some(t => String(t.role).toLowerCase() === role));
        if (missingRequiredRole) {
          this.db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE task_id = ?").run(ts, taskId);
          this.db.prepare("UPDATE attempts SET status = 'failed', finished_at = ? WHERE task_id = ? AND status = 'started'").run(ts, taskId);
          this.transition(jobId, 'IDLE', 'failed');
          this.recordEvent(jobId, 'job.failed', { reason: `missing required specialist child: ${missingRequiredRole}`, taskId }, `missing required specialist child:${missingRequiredRole}`);
          return this.getJob(jobId);
        }
        const childResults = childRows.map(t => this.db.prepare('SELECT outcome, content FROM results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(t.task_id));
        const childEvidenceValid = requiredRoles.every(role => {
          const child = childRows.find(t => String(t.role).toLowerCase() === role);
          const result = child ? this.db.prepare('SELECT outcome, content FROM results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(child.task_id) : null;
          if (!result || result.outcome !== 'success') return false;
          const content = String(result.content || '');
          return /<prompt-data>[\s\S]*?<\/prompt-data>/i.test(content)
            && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/(?:server\.js|test-tool-turn\.js)/i.test(content)
            && /exit\s+(?:status|code)\s*:\s*0/i.test(content);
        });
        if (isProductionE2E && (!childEvidenceValid
            || !/node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/server\.js/i.test(String(content || ''))
            || !/node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/test-tool-turn\.js/i.test(String(content || ''))
            || !/exit\s+(?:status|code)\s*:\s*0/i.test(String(content || '')))) {
          this.db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE task_id = ?").run(ts, taskId);
          this.db.prepare("UPDATE attempts SET status = 'failed', finished_at = ? WHERE task_id = ? AND status = 'started'").run(ts, taskId);
          this.transition(jobId, 'IDLE', 'failed');
          this.recordEvent(jobId, 'job.failed', { reason: 'CTO synthesis missing verified actual child evidence for both required checks', taskId }, 'CTO synthesis missing verified actual child evidence');
          return this.getJob(jobId);
        }
      }
    }
    if (priorTask && (priorTask.status === 'completed' || priorTask.status === 'failed')) {
      // A terminal task is not proof that this Job-level completion request is
      // valid. In particular, a late success callback must never promote a
      // failed task (or a completed task with missing result/event lineage) to
      // a completed Job. Job completion requires the dedicated workflow
      // terminalization path, which validates immutable plan, report and
      // delivery evidence before writing the terminal state.
      const taskOutcome = priorTask.status === 'completed' ? 'success' : 'failure';
      if (outcome !== taskOutcome) {
        throw new Error(`cannot complete active Job from contradictory already-terminal task outcome: ${taskId} (${priorTask.status} vs ${outcome})`);
      }
      const latestResult = this.db.prepare('SELECT result_id,task_id,outcome FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(taskId);
      const eventTypes = taskOutcome === 'success' ? ['task.completed', 'task.local_completed'] : ['task.failed', 'task.local_failed'];
      const terminalRows = this.db.prepare(`SELECT event_id,type,payload_json FROM events WHERE job_id=? AND type IN (${eventTypes.map(() => '?').join(',')})`)
        .all(jobId, ...eventTypes);
      const matchingTerminalEvents = [];
      for (const row of terminalRows) {
        let payload;
        try { payload = parseStrictJson(row.payload_json); } catch { continue; }
        if (row.payload_json !== JSON.stringify(payload)) continue;
        if (payload?.taskId === taskId && payload?.resultId === latestResult?.result_id &&
            (payload?.outcome === undefined || payload.outcome === taskOutcome)) matchingTerminalEvents.push({ row, payload });
      }
      const attempts = this.db.prepare('SELECT attempt_id,status FROM attempts WHERE task_id=?').all(taskId);
      const settledAttempts = attempts.filter(attempt => attempt.status === (taskOutcome === 'success' ? 'completed' : 'failed'));
      const activeAttempts = attempts.filter(attempt => attempt.status === 'started');
      const eventAttemptIds = new Set(matchingTerminalEvents.map(item => item.payload.attemptId).filter(value => value != null));
      if (!latestResult || latestResult.outcome !== taskOutcome || matchingTerminalEvents.length !== 1 ||
          attempts.length === 0 || settledAttempts.length !== 1 || activeAttempts.length !== 0 ||
          (eventAttemptIds.size > 0 && (eventAttemptIds.size !== 1 || !eventAttemptIds.has(settledAttempts[0].attempt_id)))) {
        throw new Error(`cannot complete active Job from an already-terminal task with incomplete or conflicting result/event/attempt lineage: ${taskId}`);
      }
      this.transition(jobId, taskOutcome === 'success' ? 'COMPLETED' : 'IDLE', taskOutcome === 'success' ? 'completed' : 'failed');
      return this.getJob(jobId);
    }
    if (taskId) {
      this.db.prepare('INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, ?, ?, ?)').run(resultId, taskId, outcome, content || '', ts);
      this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run(outcome === 'success' ? 'completed' : 'failed', ts, taskId);
      this.db.prepare("UPDATE attempts SET status = ?, finished_at = ? WHERE task_id = ? AND status = 'started'").run(outcome === 'success' ? 'completed' : 'failed', ts, taskId);
    }
    this.transition(jobId, outcome === 'success' ? 'COMPLETED' : 'IDLE', outcome === 'success' ? 'completed' : 'failed');
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_LEGACY_COMPLETE_JOB_UPDATE === 'SIGKILL') {
      process.kill(process.pid, 'SIGKILL');
    }
    this.recordEvent(jobId, outcome === 'success' ? 'task.completed' : 'task.failed', { taskId, resultId, outcome }, completionKey);
    return this.getJob(jobId);
  }
  repairResultEvidence(taskId, content, { outcome = null } = {}) {
    if (!taskId || !content || !/\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(content)) return false;
    if (outcome !== null && !['success', 'failure'].includes(outcome)) {
      throw new Error('repaired result outcome must be exactly success/failure when provided');
    }
    this.db.exec('SAVEPOINT repair_result_evidence_transition');
    try {
      // Acquire SQLite's writer reservation before reading the current task and
      // latest result. This binds the repair decision, successor row, event and
      // readback to one serialized view under concurrent recovery writers.
      const reservation = this.db.prepare('UPDATE tasks SET updated_at=updated_at WHERE task_id=?').run(taskId);
      if (reservation.changes !== 1) {
        this.db.exec('RELEASE SAVEPOINT repair_result_evidence_transition');
        return false;
      }
      const task = this.getTask(taskId);
      if (!task) {
        this.db.exec('RELEASE SAVEPOINT repair_result_evidence_transition');
        return false;
      }
      const metadata = parseStrictJson(task.metadata_json || '{}', 'task metadata for repaired execution evidence');
      const executionBound = Boolean(task.execution_session_id || task.execution_status ||
        metadata.executor === 'ExecutionManager' || metadata.deterministic === true);
      const durableExecutionSuccess = task.execution_status === 'completed' && task.execution_exit_code === 0 &&
        task.status !== 'cancelled' && typeof task.execution_session_id === 'string' && task.execution_session_id.length > 0 &&
        Number.isSafeInteger(task.execution_attempt) && task.execution_attempt > 0;
      const row = this.db.prepare('SELECT result_id, outcome, content FROM results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId);
      // A caller-supplied/runtime outcome must never override the structured local
      // execution ledger. For execution-bound tasks, neither a success-shaped
      // task row alone nor an old success result suffices: the latest durable
      // execution evidence AND the proposed repaired bytes must both satisfy the
      // exact shared contract and immutable plan. This prevents appending a new
      // success row over an older failed/malformed result.
      let executionEvidenceValid = false;
      if (executionBound && durableExecutionSuccess && row?.outcome === 'success') {
        const job = this.getJob(task.job_id);
        const plan = isSupportedWorkflow(job) ? this.getExecutionPlan(task.job_id) : null;
        const taskPolicy = plan && String(task.role || '').toLowerCase() !== 'cto'
          ? this.assertSupportedTaskPlanBinding(task, plan)
          : null;
        const plannedExecution = taskPolicy?.plannedExecution || null;
        const existingEvidence = validateEvidenceContract({ ...task, status: 'completed' }, row, plannedExecution);
        const proposedEvidence = validateEvidenceContract({ ...task, status: 'completed' }, {
          outcome: 'success', content
        }, plannedExecution);
        if (existingEvidence.valid && !proposedEvidence.valid) {
          // Do not let an unrelated runtime transcript append a newer failure
          // row over a valid immutable local-execution result. It is not valid
          // repair material, so leave the original durable success untouched.
          this.db.exec('RELEASE SAVEPOINT repair_result_evidence_transition');
          return false;
        }
        executionEvidenceValid = Boolean(taskPolicy?.requiresExecutionEvidence !== false && existingEvidence.valid && proposedEvidence.valid);
      }
      const repairedOutcome = executionBound
        ? (executionEvidenceValid && outcome !== 'failure' ? 'success' : 'failure')
        : (task.status !== 'cancelled' && outcome !== 'failure' ? 'success' : 'failure');
      if (row && row.outcome === 'success' && repairedOutcome === 'success' && /\[ACTUAL EXECUTION EVIDENCE\]/i.test(row.content || '')) {
        const lines = new Set(String(row.content || '').split(/\r?\n/));
        const expectedCommand = typeof metadata.command === 'string' ? metadata.command : null;
        const lineageMatches = lines.has(`task_id: ${task.task_id}`) &&
          lines.has(`execution_session_id: ${task.execution_session_id}`) &&
          lines.has(`attempt: ${task.execution_attempt}`) &&
          expectedCommand !== null && lines.has(`exact command: ${expectedCommand}`) &&
          lines.has('exit status/code: 0') && lines.has('execution status: completed');
        if (lineageMatches) {
          this.db.exec('RELEASE SAVEPOINT repair_result_evidence_transition');
          return false;
        }
      }
      const resultId = id('result');
      const ts = now();
      this.db.prepare('INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(resultId, taskId, repairedOutcome, content, ts);
      this.recordEvent(task.job_id, 'result.evidence_repaired', {
        taskId, resultId, outcome: repairedOutcome, supersedesResultId: row?.result_id || null
      }, taskId + '|evidence-repaired|' + resultId);
      const persisted = this.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=?').get(resultId);
      const event = this.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='result.evidence_repaired' AND json_extract(payload_json,'$.resultId')=?")
        .all(task.job_id, resultId);
      if (!persisted || persisted.task_id !== taskId || persisted.outcome !== repairedOutcome || persisted.content !== content ||
          event.length !== 1 || parseStrictJson(event[0].payload_json).outcome !== repairedOutcome) {
        throw new Error(`repaired result row/event readback mismatch: ${taskId}`);
      }
      this.db.exec('RELEASE SAVEPOINT repair_result_evidence_transition');
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT repair_result_evidence_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT repair_result_evidence_transition'); } catch {}
      throw error;
    }
    return true;
  }
  reconcileFailedTaskByRuntime(taskId, { content, runId = null, sessionKey = null } = {}) {
    if (!taskId || !content || !/\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(content)) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read ownership/state only after acquiring SQLite's writer lock. A
      // recovery worker that observed FAILED before a concurrent terminal write
      // must not append success evidence after another worker already settled
      // the task.
      const task = this.getTask(taskId);
      if (!task || task.status !== 'failed') {
        this.db.exec('ROLLBACK');
        return null;
      }
      if ((runId && task.openclaw_run_id && runId !== task.openclaw_run_id) ||
          (sessionKey && task.openclaw_session_key && sessionKey !== task.openclaw_session_key)) {
        throw new Error(`runtime success reconciliation identity conflict: ${taskId}`);
      }
      const job = this.getJob(task.job_id);
      const plan = isSupportedWorkflow(job) ? this.getExecutionPlan(task.job_id) : null;
      const taskPolicy = plan && String(task.role || '').toLowerCase() !== 'cto'
        ? this.assertSupportedTaskPlanBinding(task, plan)
        : null;
      let executionBacked = false;
      let resultId = null;
      let executionResult = null;
      let executionCompletion = null;
      if (taskPolicy?.requiresExecutionEvidence) {
        // OpenClaw trajectory text is not a substitute for the deterministic
        // command's durable local result. A transcript-only "success" used to
        // revive a failed deterministic task before ExecutionManager had run,
        // after which retry was impossible because the task was terminal.
        if (task.execution_status !== 'completed' || task.execution_exit_code !== 0 ||
            typeof task.execution_session_id !== 'string' || !task.execution_session_id ||
            !Number.isSafeInteger(task.execution_attempt) || task.execution_attempt < 1) {
          throw new Error(`cannot reconcile deterministic task from runtime transcript without exact durable ExecutionManager success: ${taskId}`);
        }
        const completionRows = this.db.prepare(`SELECT event_id,job_id,type,payload_json FROM events
          WHERE job_id=? AND type='execution.completed' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?`)
          .all(task.job_id, taskId, task.execution_attempt);
        if (completionRows.length !== 1) {
          throw new Error(`cannot reconcile deterministic task without one current execution.completed event: ${taskId}`);
        }
        const completionRow = completionRows[0];
        executionCompletion = parseStrictJson(completionRow.payload_json, 'deterministic execution completion event');
        const expectedCompletionId = eventId(task.job_id, 'execution.completed', `${taskId}|execution-result|${task.execution_attempt}`);
        if (completionRow.event_id !== expectedCompletionId || completionRow.job_id !== task.job_id ||
            completionRow.type !== 'execution.completed' ||
            Object.keys(executionCompletion).sort().join(',') !== 'attempt,attemptId,command,executionSessionId,exitCode,resultId,status,taskId' ||
            executionCompletion.taskId !== taskId || executionCompletion.attempt !== task.execution_attempt ||
            executionCompletion.attemptId == null || executionCompletion.executionSessionId !== task.execution_session_id ||
            executionCompletion.command !== taskPolicy.metadata.command || executionCompletion.exitCode !== 0 ||
            executionCompletion.status !== 'completed' || typeof executionCompletion.resultId !== 'string' || !executionCompletion.resultId) {
          throw new Error(`cannot reconcile deterministic task with mismatched execution completion identity: ${taskId}`);
        }
        executionResult = this.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=? AND task_id=?')
          .get(executionCompletion.resultId, taskId);
        const executionAttemptRow = this.db.prepare('SELECT attempt_id,task_id,status,finished_at FROM attempts WHERE attempt_id=? AND task_id=?')
          .get(executionCompletion.attemptId, taskId);
        if (!executionResult || executionResult.outcome !== 'success' || !executionResult.content ||
            !executionAttemptRow || executionAttemptRow.status !== 'completed' || !executionAttemptRow.finished_at ||
            !validateEvidenceContract({ ...task, status: 'completed' }, executionResult, taskPolicy.plannedExecution).valid) {
          throw new Error(`cannot reconcile deterministic task without exact successful result/attempt/evidence lineage: ${taskId}`);
        }
        executionBacked = true;
        resultId = executionResult.result_id;
      }
      const openAttempts = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started'").all(taskId);
      if (openAttempts.length) throw new Error(`cannot reconcile failed task while a runtime attempt is still open: ${taskId}`);
      const failedAttempt = this.db.prepare("SELECT attempt_id,status,finished_at FROM attempts WHERE task_id=? AND status='failed' ORDER BY started_at DESC,rowid DESC LIMIT 1")
        .get(taskId);
      if (!failedAttempt || !failedAttempt.finished_at) {
        throw new Error(`cannot reconcile failed task without a settled durable failed attempt: ${taskId}`);
      }
      const ts = now();
      if (!executionBacked) resultId = id('result');
      const previous = this.db.prepare('SELECT result_id FROM results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId);
      const nextRunId = runId ?? task.openclaw_run_id;
      const nextSessionKey = sessionKey ?? task.openclaw_session_key;
      if (!executionBacked) {
        this.db.prepare("INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, 'success', ?, ?)")
          .run(resultId, taskId, content, ts);
      }
      const taskUpdate = this.db.prepare("UPDATE tasks SET status = 'completed', openclaw_run_id = ?, openclaw_session_key = ?, updated_at = ? WHERE task_id = ? AND status = 'failed' AND openclaw_run_id IS ? AND openclaw_session_key IS ?")
        .run(nextRunId, nextSessionKey, ts, taskId, task.openclaw_run_id, task.openclaw_session_key);
      if (taskUpdate.changes !== 1) throw new Error(`runtime success reconciliation lost task status/identity ownership: ${taskId}`);
      const attemptUpdate = this.db.prepare("UPDATE attempts SET status = 'completed', finished_at = ? WHERE task_id = ? AND attempt_id = ? AND status = 'failed'")
        .run(ts, taskId, failedAttempt.attempt_id);
      if (attemptUpdate.changes !== 1) throw new Error(`runtime success reconciliation lost failed-attempt ownership: ${taskId}`);
      const result = this.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=?').get(resultId);
      if (!result || result.task_id !== taskId || result.outcome !== 'success' ||
          (executionBacked ? result.content !== executionResult.content : result.content !== content)) {
        throw new Error(`runtime success reconciliation result readback mismatch: ${taskId}`);
      }
      const reconciliationPayload = {
        taskId, runId: nextRunId || null, sessionKey: nextSessionKey || null,
        attemptId: failedAttempt.attempt_id, outcome: 'success', resultId,
        executionBacked
      };
      const reconciliationEventId = this.recordEvent(task.job_id, 'task.runtime_reconciled', reconciliationPayload, taskId + '|runtime-reconciled|' + resultId);
      const reconciliationEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(reconciliationEventId);
      const latestResult = this.db.prepare('SELECT result_id,outcome,content FROM results WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(taskId);
      const persistedTask = this.getTask(taskId);
      const persistedAttempt = this.db.prepare('SELECT status,finished_at FROM attempts WHERE attempt_id=? AND task_id=?').get(failedAttempt.attempt_id, taskId);
      if (!latestResult || latestResult.result_id !== resultId || latestResult.outcome !== 'success' ||
          (executionBacked ? latestResult.content !== executionResult.content : latestResult.content !== content) ||
          !reconciliationEvent || reconciliationEvent.event_id !== eventId(task.job_id, 'task.runtime_reconciled', taskId + '|runtime-reconciled|' + resultId) ||
          reconciliationEvent.job_id !== task.job_id || reconciliationEvent.type !== 'task.runtime_reconciled' ||
          reconciliationEvent.payload_json !== JSON.stringify(reconciliationPayload) ||
          !persistedTask || persistedTask.status !== 'completed' || persistedTask.openclaw_run_id !== nextRunId ||
          persistedTask.openclaw_session_key !== nextSessionKey || persistedAttempt?.status !== 'completed' ||
          persistedAttempt.finished_at !== ts) {
        throw new Error(`runtime success reconciliation task/attempt readback mismatch: ${taskId}`);
      }
      this.db.exec('COMMIT');
      return this.getTask(taskId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  replaceResultEvidence(taskId, content, expectedCommand) {
    if (!taskId || !content || !/\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(content)) return false;
    const row = this.db.prepare('SELECT result_id, content FROM results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId);
    if (!row) return false;
    const markerSection = String(row.content || '').split(/\[ACTUAL TOOL RESULT EVIDENCE\]/i).slice(1).join('\n');
    if (expectedCommand && markerSection.includes(expectedCommand) && /exit status(?:\/code)?:\s*0/i.test(markerSection) && /<prompt-data>[\s\S]*?<\/prompt-data>/i.test(markerSection)) return false;
    this.db.prepare('UPDATE results SET content = ? WHERE result_id = ?').run(content, row.result_id);
    const task = this.getTask(taskId);
    if (task) this.recordEvent(task.job_id, 'result.evidence_replaced', { taskId, resultId: row.result_id, expectedCommand }, `${row.result_id}|evidence-replaced|${expectedCommand || ''}`);
    return true;
  }
  createReport(jobId, kind, content) {
    if (typeof jobId !== 'string' || !jobId || typeof kind !== 'string' || !kind.trim()) {
      throw new Error('report creation requires exact job and non-empty report kind');
    }
    const reportContent = content || '';
    if (typeof reportContent !== 'string') throw new Error('report content must be a string');
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CREATE_REPORT_BARRIER_DIR) {
      const directory = path.resolve(process.env.CHAT_ON_STEROIDS_TEST_CREATE_REPORT_BARRIER_DIR);
      const ready = path.join(directory, `${process.pid}.ready`);
      const release = path.join(directory, 'release');
      fs.writeFileSync(ready, `${jobId}\n`, { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(release)) {
        if (Date.now() > deadline) throw new Error('test create-report barrier timed out before writer reservation');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    this.db.exec('SAVEPOINT create_report_transition');
    try {
      // Reserve the SQLite writer before checking for a pre-existing report or
      // event. This makes insert+event one database transition and serializes
      // simultaneous report retries across independent store processes.
      const reservation = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(jobId);
      if (reservation.changes !== 1) throw new Error(`cannot create report for unknown job: ${jobId}`);
      const existingRows = this.db.prepare('SELECT report_id,job_id,kind,content,created_at FROM reports WHERE job_id=? AND kind=? AND content=? ORDER BY created_at,rowid')
        .all(jobId, kind, reportContent);
      if (existingRows.length > 1) throw new Error('report creation found duplicate durable rows for the same logical report');
      let report = existingRows[0] || null;
      if (report && (report.job_id !== jobId || report.kind !== kind || report.content !== reportContent || !report.report_id)) {
        throw new Error('existing report row conflicts with the requested exact report identity');
      }
      if (!report) {
        const reportId = id('report');
        const createdAt = now();
        this.db.prepare('INSERT INTO reports(report_id,job_id,kind,content,created_at) VALUES(?,?,?,?,?)')
          .run(reportId, jobId, kind, reportContent, createdAt);
        if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_REPORT_ROW_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
        report = this.db.prepare('SELECT report_id,job_id,kind,content,created_at FROM reports WHERE report_id=?').get(reportId);
      }
      const expectedPayload = { reportId: report.report_id, kind };
      const expectedEventId = eventId(jobId, 'report.created', report.report_id);
      const reportEvents = this.db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE job_id=? AND type='report.created'")
        .all(jobId);
      const matching = [];
      for (const row of reportEvents) {
        let payload;
        try { payload = parseStrictJson(row.payload_json); }
        catch (error) {
          throw new Error(`report creation found non-canonical report.created event JSON (malformed strict JSON; refusing to hide corrupt history): ${String(error?.message || error)}`);
        }
        if (row.payload_json !== JSON.stringify(payload)) throw new Error('report creation found non-canonical report.created event JSON');
        if (payload?.reportId === report.report_id) matching.push({ row, payload });
      }
      if (matching.length > 1) throw new Error('report creation found duplicate logical report.created events');
      if (matching.length === 0) {
        // A row written by an earlier, interrupted implementation can be
        // repaired only if the deterministic event key is unused. The repair
        // occurs under the same writer reservation and is validated below.
        const conflictingKey = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(expectedEventId);
        if (conflictingKey) throw new Error('report-created deterministic event ID is occupied by conflicting durable evidence');
        this.recordEvent(jobId, 'report.created', expectedPayload, report.report_id);
        if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_REPORT_EVENT_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
      }
      const persistedReport = this.db.prepare('SELECT report_id,job_id,kind,content,created_at FROM reports WHERE report_id=?').get(report.report_id);
      const persistedEvents = this.db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE job_id=? AND type='report.created'").all(jobId);
      const exactEvents = persistedEvents.filter(row => {
        try { return parseStrictJson(row.payload_json)?.reportId === report.report_id; } catch { return false; }
      });
      const event = exactEvents[0];
      if (!persistedReport || persistedReport.report_id !== report.report_id || persistedReport.job_id !== jobId ||
          persistedReport.kind !== kind || persistedReport.content !== reportContent ||
          persistedReport.created_at !== report.created_at || exactEvents.length !== 1 || !event ||
          event.event_id !== expectedEventId || event.job_id !== jobId || event.type !== 'report.created' ||
          event.payload_json !== JSON.stringify(expectedPayload)) {
        throw new Error('report creation exact report/event readback did not reconcile');
      }
      this.db.exec('RELEASE SAVEPOINT create_report_transition');
      return persistedReport.report_id;
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT create_report_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT create_report_transition'); } catch {}
      throw failure;
    }
  }
  reconcileTerminalWorkflowPhase(jobId, outcome, reportId = null, ts = now()) {
    const runtime = this.getWorkflowRuntimeState(jobId);
    if (!runtime) return false;
    const previousPhase = runtime.phase || null;
    const nextPhase = outcome === 'success'
      ? (['TERMINALIZE', 'PROJECT'].includes(previousPhase) ? previousPhase : 'COMPLETED')
      : 'FAILED';
    if (previousPhase === nextPhase) return false;
    if (typeof runtime.attempt !== 'number' || !Number.isSafeInteger(runtime.attempt) || runtime.attempt < 0) {
      throw new Error(`terminal workflow phase reconciliation refuses a malformed runtime attempt: ${jobId}`);
    }
    const durableReportId = reportId || this.db.prepare('SELECT report_id FROM reports WHERE job_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(jobId)?.report_id || null;
    this.db.prepare('UPDATE workflow_runtime_state SET phase=?, resume_after=NULL, last_error=NULL, updated_at=? WHERE job_id=?')
      .run(nextPhase, ts, jobId);
    this.db.prepare(`INSERT INTO workflow_events(
      workflow_event_id, job_id, from_phase, to_phase, event, attempt, payload_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id('workflow_event'), jobId, previousPhase, nextPhase, 'workflow.terminal_phase_reconciled',
      runtime.attempt, JSON.stringify({ outcome, reportId: durableReportId }), ts
    );
    this.recordEvent(jobId, 'workflow.terminal_phase_reconciled', {
      fromPhase: previousPhase, toPhase: nextPhase, outcome, reportId: durableReportId
    }, `${durableReportId || jobId}|phase-reconciled|${nextPhase}`);
    return true;
  }
  assertSupportedCtoTerminalEvidence(jobId, job = this.getJob(jobId)) {
    const ctoTask = job?.active_task_id ? this.getTask(job.active_task_id) : null;
    if (!job || !isSupportedWorkflow(job) || String(ctoTask?.role || '').toLowerCase() !== 'cto' || ctoTask.status !== 'completed') {
      throw new Error('cannot terminalize supported workflow without a completed active CTO task');
    }
    const results = this.db.prepare("SELECT result_id, task_id, outcome, content, created_at FROM results WHERE task_id=? AND outcome='success' ORDER BY created_at, rowid")
      .all(ctoTask.task_id);
    if (results.length !== 1 || results[0].task_id !== ctoTask.task_id) {
      throw new Error('cannot terminalize supported workflow without exactly one durable successful CTO result');
    }
    const result = results[0];
    // Both the local-tool and host-runtime completion paths are supported, but
    // either must produce one canonical event that points to this exact result
    // and attempt. The host path records attemptId explicitly below.
    const completionRows = this.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type IN ('task.local_completed','task.completed')")
      .all(jobId);
    const completionMatches = [];
    for (const row of completionRows) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('cannot terminalize supported workflow: completion event payload is malformed'); }
      if (payload?.resultId === result.result_id) completionMatches.push({ row, payload });
    }
    if (completionMatches.length !== 1) {
      throw new Error('cannot terminalize supported workflow: CTO result lacks exactly one completion event');
    }
    const { row: completionRow, payload: completion } = completionMatches[0];
    const expectedCompletionId = completionRow.type === 'task.local_completed'
      ? eventId(jobId, 'task.local_completed', result.result_id)
      : eventId(jobId, 'task.completed', `${ctoTask.task_id}|success|${result.result_id}`);
    const attempt = completion.attemptId
      ? this.db.prepare("SELECT attempt_id, task_id, status FROM attempts WHERE attempt_id=? AND task_id=?")
        .get(completion.attemptId, ctoTask.task_id)
      : null;
    const validLocalCompletion = completionRow.type === 'task.local_completed'
      && completion.executor === 'chat-on-steroids-plugin';
    const validRuntimeCompletion = completionRow.type === 'task.completed' && completion.outcome === 'success';
    const completionKeys = Object.keys(completion).sort().join(',');
    const expectedCompletionKeys = completionRow.type === 'task.local_completed'
      ? 'attemptId,executor,resultId,taskId'
      : 'attemptId,failureClass,outcome,resultId,runId,sessionKey,taskId';
    if (completionRow.event_id !== expectedCompletionId || completionRow.job_id !== jobId ||
        completionRow.payload_json !== JSON.stringify(completion) ||
        completion.taskId !== ctoTask.task_id || completion.resultId !== result.result_id ||
        completionKeys !== expectedCompletionKeys || (!validLocalCompletion && !validRuntimeCompletion) || attempt?.status !== 'completed') {
      throw new Error('cannot terminalize supported workflow: CTO completion event/attempt lineage is invalid or non-canonical');
    }
    const artifacts = this.db.prepare("SELECT artifact_id FROM artifacts WHERE job_id=? AND task_id=? AND status='active'")
      .all(jobId, ctoTask.task_id).map(row => this.getArtifact(row.artifact_id));
    const artifact = artifacts.find(item => item?.artifact_id === `cto-decision-${result.result_id}`);
    if (artifacts.length !== 1 || !artifact || artifact.job_id !== jobId || artifact.task_id !== ctoTask.task_id ||
        artifact.type !== 'cto-decision' || artifact.status !== 'active' || artifact.producer_role !== 'cto' ||
        artifact.evidence.filter(value => value === result.result_id).length !== 1 ||
        artifact.evidence.some(value => {
          if (value === result.result_id) return false;
          const reference = this.getArtifact(value);
          return !reference || reference.job_id !== jobId || reference.status !== 'active';
        }) ||
        artifact.content?.decision !== 'approve' || !String(artifact.content?.summary || '').trim()) {
      throw new Error('cannot terminalize supported workflow without an active CTO decision artifact bound to its successful result');
    }
    const artifactEventId = eventId(jobId, 'artifact.created', artifact.artifact_id);
    const artifactEvent = this.db.prepare('SELECT event_id, job_id, type, payload_json FROM events WHERE event_id=?').get(artifactEventId);
    let artifactPayload;
    try { artifactPayload = parseStrictJson(artifactEvent?.payload_json || ''); }
    catch { throw new Error('cannot terminalize supported workflow: CTO artifact creation event is missing or malformed'); }
    if (!artifactEvent || artifactEvent.job_id !== jobId || artifactEvent.type !== 'artifact.created' ||
        artifactEvent.payload_json !== JSON.stringify(artifactPayload) ||
        artifactPayload.artifactId !== artifact.artifact_id || artifactPayload.taskId !== ctoTask.task_id ||
        artifactPayload.type !== 'cto-decision' || artifactPayload.status !== 'active' ||
        artifactPayload.contentHash !== artifact.content_hash || (artifactPayload.supersedes ?? null) !== (artifact.supersedes ?? null) ||
        Object.keys(artifactPayload).sort().join(',') !== 'artifactId,contentHash,status,supersedes,taskId,type') {
      throw new Error('cannot terminalize supported workflow: CTO artifact creation event does not bind its durable bytes');
    }
    return { task: ctoTask, result, artifact, completionEvent: completionRow, attempt };
  }
  assertSupportedTaskPlanBinding(task, plan) {
    if (!task || typeof task.role !== 'string' || !plan || !Array.isArray(plan.children)) {
      throw new Error('cannot validate task execution policy without exact task and immutable plan');
    }
    const roleMatches = plan.children.filter(item => String(item?.role || '').toLowerCase() === String(task.role).toLowerCase());
    if (roleMatches.length !== 1) {
      throw new Error(`cannot validate task execution policy: role has ${roleMatches.length} immutable plan matches: ${task.role}`);
    }
    const plannedTask = roleMatches[0];
    const metadata = parseStrictJson(task.metadata_json || '{}', 'task metadata for immutable-plan validation');
    const metadataPlanId = metadata.workflow_plan_task_id ?? metadata.workflowPlanTaskId ?? null;
    if (metadataPlanId !== plannedTask.id) {
      throw new Error(`cannot validate task execution policy: task plan identity differs from immutable plan for role=${task.role}`);
    }
    assertTaskDependenciesMatchPlan(task, plannedTask, `task ${task.task_id}`);
    const plannedExecution = plannedTask.execution || {};
    for (const key of ['executor', 'deterministic', 'command', 'executable', 'args', 'cwd', 'timeout_ms', 'output_artifact_type']) {
      if (!Object.hasOwn(plannedExecution, key)) continue;
      if (key === 'command' && typeof plannedExecution.command === 'string' &&
          typeof plannedExecution.executable === 'string' && Array.isArray(plannedExecution.args)) {
        const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
        const structuredCommand = [plannedExecution.executable, ...plannedExecution.args].map(shellQuote).join(' ');
        if (metadata.command !== plannedExecution.command && metadata.command !== structuredCommand) {
          throw new Error(`cannot validate task execution policy: metadata ${key} differs from immutable plan for role=${task.role}`);
        }
        continue;
      }
      if (canonicalJson(metadata[key] ?? null) !== canonicalJson(plannedExecution[key] ?? null)) {
        throw new Error(`cannot validate task execution policy: metadata ${key} differs from immutable plan for role=${task.role}`);
      }
    }
    return {
      plannedTask,
      metadata,
      plannedExecution,
      requiresExecutionEvidence: plannedExecution.executor === 'ExecutionManager' || plannedExecution.deterministic === true
    };
  }
  assertSupportedTaskArtifactLineage(jobId, task, plan) {
    if (!task || task.job_id !== jobId || task.status !== 'completed') {
      throw new Error('cannot terminalize supported workflow: required child task is not completed');
    }
    const results = this.db.prepare("SELECT result_id, task_id, outcome, content, created_at FROM results WHERE task_id=? AND outcome='success' ORDER BY created_at, rowid")
      .all(task.task_id);
    if (results.length !== 1 || results[0].task_id !== task.task_id || !String(results[0].content || '').trim()) {
      throw new Error(`cannot terminalize supported workflow: child ${task.task_id} lacks exactly one durable successful result`);
    }
    const result = results[0];
    const completionRows = this.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type IN ('task.local_completed','task.completed','execution.completed')")
      .all(jobId);
    const completionMatches = [];
    for (const row of completionRows) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('cannot terminalize supported workflow: child completion event payload is malformed'); }
      if (payload?.resultId === result.result_id) completionMatches.push({ row, payload });
    }
    if (completionMatches.length !== 1) {
      throw new Error(`cannot terminalize supported workflow: child ${task.task_id} lacks exactly one completion event`);
    }
    const { row: completionRow, payload: completion } = completionMatches[0];
    const expectedCompletionId = completionRow.type === 'task.local_completed'
      ? eventId(jobId, 'task.local_completed', result.result_id)
      : completionRow.type === 'task.completed'
        ? eventId(jobId, 'task.completed', `${task.task_id}|success|${result.result_id}`)
        : eventId(jobId, 'execution.completed', `${task.task_id}|execution-result|${completion.attempt}`);
    const attempt = completion.attemptId
      ? this.db.prepare("SELECT attempt_id, task_id, status, finished_at FROM attempts WHERE attempt_id=? AND task_id=?")
        .get(completion.attemptId, task.task_id)
      : null;
    const completionKeys = Object.keys(completion).sort().join(',');
    const validLocalCompletion = completionRow.type === 'task.local_completed' && completion.executor === 'chat-on-steroids-plugin';
    const validRuntimeCompletion = completionRow.type === 'task.completed' && completion.outcome === 'success';
    let validExecutionCompletion = false;
    if (completionRow.type === 'execution.completed') {
      const executionAttempt = completion.attempt;
      const startKey = `${task.task_id}|execution|${executionAttempt}`;
      const startId = eventId(jobId, 'execution.started', startKey);
      const startRow = this.db.prepare('SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE event_id=?').get(startId);
      let startPayload = null;
      try { startPayload = parseStrictJson(startRow?.payload_json || ''); } catch {}
      const startRows = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?")
        .all(jobId, task.task_id, executionAttempt);
      const metadata = parseStrictJson(task.metadata_json || '{}');
      const boundaryIdentity = metadata.execution_boundary_identity || null;
      const expectedStartPayloadKeys = [
        'attempt', 'attemptId', 'command', 'cwd',
        ...(metadata.execution_batch_claim ? ['executionBatchClaim'] : []),
        ...(boundaryIdentity ? ['executionBoundaryIdentity'] : []),
        'executionSessionId', 'taskId', 'tmuxName'
      ].sort().join(',');
      const boundaryIdentityValid = !boundaryIdentity || (
        boundaryIdentity.schema_version === 1 && boundaryIdentity.task_id === task.task_id &&
        boundaryIdentity.attempt === executionAttempt && boundaryIdentity.command === completion.command &&
        boundaryIdentity.cwd?.requested === path.resolve(String(metadata.cwd || '')) &&
        /^[a-f0-9]{64}$/.test(String(boundaryIdentity.environment_sha256 || '')) &&
        /^[a-f0-9]{64}$/.test(String(boundaryIdentity.executable?.sha256 || '')) &&
        /^[a-f0-9]{64}$/.test(String(boundaryIdentity.tmux?.sha256 || '')) &&
        canonicalJson(boundaryIdentity) === canonicalJson(startPayload?.executionBoundaryIdentity)
      );
      const plannedTask = metadata.workflow_plan_task_id
        ? plan?.children?.find(item => item.id === metadata.workflow_plan_task_id)
        : plan?.children?.find(item => String(item.role).toLowerCase() === String(task.role).toLowerCase());
      const plannedExecution = plannedTask?.execution || null;
      const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
      const plannedStructuredCommand = plannedExecution?.executable && Array.isArray(plannedExecution?.args)
        ? [plannedExecution.executable, ...plannedExecution.args].map(shellQuote).join(' ')
        : null;
      const executionEvidence = String(result.content || '');
      const attemptRows = completion.attemptId
        ? this.db.prepare('SELECT attempt_id,task_id,status,started_at,finished_at,error FROM attempts WHERE attempt_id=? AND task_id=?').all(completion.attemptId, task.task_id)
        : [];
      const terminalExecutionEvents = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type IN ('execution.completed','execution.failed','execution.cancelled') AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?")
        .all(jobId, task.task_id, executionAttempt);
      const exactExecutionEvidence = attemptRows.length === 1 ? executionEvidenceContent({
        taskId: task.task_id, executionSessionId: completion.executionSessionId, attempt: executionAttempt,
        command: completion.command, exitCode: completion.exitCode, status: completion.status,
        stdout: task.execution_stdout || '', stderr: task.execution_stderr || '', error: attemptRows[0].error
      }) : null;
      validExecutionCompletion = typeof completion.attempt === 'number' && Number.isSafeInteger(executionAttempt) && executionAttempt > 0 &&
        completionKeys === 'attempt,attemptId,command,executionSessionId,exitCode,resultId,status,taskId' &&
        completion.status === 'completed' && completionRow.type === 'execution.completed' &&
        completion.taskId === task.task_id && completion.resultId === result.result_id &&
        completion.executionSessionId === task.execution_session_id && typeof completion.executionSessionId === 'string' &&
        typeof task.execution_attempt === 'number' && task.execution_attempt === executionAttempt && task.execution_status === 'completed' &&
        task.execution_exit_code === 0 && completion.exitCode === 0 && task.status === 'completed' &&
        typeof completion.command === 'string' && completion.command.trim() !== '' && metadata.command === completion.command &&
        (!plannedExecution?.command || plannedExecution.command === completion.command || plannedStructuredCommand === completion.command) &&
        (!plannedExecution?.executable || plannedExecution.executable === metadata.executable) &&
        (!plannedExecution?.args || JSON.stringify(plannedExecution.args) === JSON.stringify(metadata.args)) &&
        (!plannedExecution?.cwd || plannedExecution.cwd === metadata.cwd) &&
        startRows.length === 1 && startRow?.event_id === startId && startRow.job_id === jobId && startRow.type === 'execution.started' &&
        startRow?.payload_json === JSON.stringify(startPayload) &&
        startPayload?.taskId === task.task_id && startPayload.executionSessionId === completion.executionSessionId &&
        typeof startPayload.attempt === 'number' && startPayload.attempt === executionAttempt && startPayload.attemptId === completion.attemptId &&
        startPayload.command === completion.command && (startPayload.cwd ?? null) === (metadata.cwd ?? null) &&
        (metadata.execution_batch_claim
          ? canonicalJson(metadata.execution_batch_claim) === canonicalJson(startPayload.executionBatchClaim)
          : !Object.hasOwn(startPayload, 'executionBatchClaim')) &&
        Object.keys(startPayload || {}).sort().join(',') === expectedStartPayloadKeys && boundaryIdentityValid &&
        attemptRows.length === 1 && attemptRows[0].status === 'completed' && Boolean(attemptRows[0].finished_at) &&
        attemptRows[0].started_at <= startRow.created_at && terminalExecutionEvents.length === 1 &&
        result.outcome === 'success' && executionEvidence === exactExecutionEvidence;
    }
    const expectedCompletionKeys = completionRow.type === 'task.local_completed'
      ? 'attemptId,executor,resultId,taskId'
      : completionRow.type === 'task.completed'
        ? 'attemptId,failureClass,outcome,resultId,runId,sessionKey,taskId'
        : 'attempt,attemptId,command,executionSessionId,exitCode,resultId,status,taskId';
    const openAttempts = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started'").all(task.task_id);
    if (completionRow.event_id !== expectedCompletionId || completionRow.job_id !== jobId ||
        completionRow.payload_json !== JSON.stringify(completion) ||
        completion.taskId !== task.task_id || completion.resultId !== result.result_id ||
        completionKeys !== expectedCompletionKeys || (!validLocalCompletion && !validRuntimeCompletion && !validExecutionCompletion) || attempt?.status !== 'completed' || !attempt.finished_at ||
        openAttempts.length !== 0) {
      throw new Error(`cannot terminalize supported workflow: child ${task.task_id} completion/attempt lineage is invalid or non-canonical`);
    }
    const { metadata, plannedTask } = this.assertSupportedTaskPlanBinding(task, plan);
    // The immutable execution plan takes precedence over mutable task metadata;
    // otherwise rewriting output_artifact_type could redefine what counts as
    // valid evidence after approval.
    const expectedType = plannedTask?.execution?.output_artifact_type || metadata.output_artifact_type || getAgentArtifactType(task.role);
    const activeArtifacts = this.db.prepare("SELECT artifact_id FROM artifacts WHERE job_id=? AND task_id=? AND status='active'")
      .all(jobId, task.task_id).map(row => this.getArtifact(row.artifact_id));
    const artifact = activeArtifacts.find(item => item?.artifact_id === `${expectedType}-${result.result_id}`);
    if (activeArtifacts.length !== 1 || !artifact || artifact.job_id !== jobId || artifact.task_id !== task.task_id ||
        artifact.type !== expectedType || artifact.status !== 'active' || artifact.producer_role !== task.role ||
        artifact.evidence.filter(value => value === result.result_id).length !== 1 ||
        artifact.evidence.some(value => {
          if (value === result.result_id) return false;
          if (validExecutionCompletion && value === task.execution_session_id) return false;
          const reference = this.getArtifact(value);
          return !reference || reference.job_id !== jobId || reference.status !== 'active';
        })) {
      throw new Error(`cannot terminalize supported workflow: child ${task.task_id} lacks a typed artifact bound to its result`);
    }
    const artifactEvents = this.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type='artifact.created'").all(jobId);
    const artifactMatches = [];
    for (const row of artifactEvents) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch (error) {
        throw new Error(`cannot terminalize supported workflow: child artifact event does not bind its durable bytes because its payload is malformed: ${String(error?.message || error)}`);
      }
      if (payload?.artifactId === artifact.artifact_id) artifactMatches.push({ row, payload });
    }
    if (artifactMatches.length !== 1 || artifactMatches[0].row.event_id !== eventId(jobId, 'artifact.created', artifact.artifact_id) ||
        artifactMatches[0].row.job_id !== jobId || artifactMatches[0].payload.taskId !== task.task_id ||
        artifactMatches[0].row.payload_json !== JSON.stringify(artifactMatches[0].payload) ||
        artifactMatches[0].payload.type !== expectedType || artifactMatches[0].payload.status !== 'active' ||
        artifactMatches[0].payload.contentHash !== artifact.content_hash ||
        (artifactMatches[0].payload.supersedes ?? null) !== (artifact.supersedes ?? null) ||
        Object.keys(artifactMatches[0].payload).sort().join(',') !== 'artifactId,contentHash,status,supersedes,taskId,type') {
      throw new Error(`cannot terminalize supported workflow: child ${task.task_id} artifact event does not bind its durable bytes`);
    }
    const executionStart = completionRow.type === 'execution.completed'
      ? this.db.prepare('SELECT created_at FROM events WHERE event_id=?').get(eventId(jobId, 'execution.started', `${task.task_id}|execution|${completion.attempt}`))
      : null;
    const times = [executionStart?.created_at ?? result.created_at, result.created_at, artifactMatches[0].row.created_at, completionRow.created_at].map(value => Date.parse(value));
    if (!times.every(Number.isFinite) || times[0] > times[1] || times[1] > times[2] || times[2] > times[3]) {
      throw new Error(`cannot terminalize supported workflow: child ${task.task_id} result/artifact/completion timestamps are invalid`);
    }
    return { task, result, artifact, completionEvent: completionRow, attempt };
  }
  assertSupportedCtoChildEvidence(jobId, job = this.getJob(jobId)) {
    const ctoTask = job?.active_task_id ? this.getTask(job.active_task_id) : null;
    const plan = this.getExecutionPlan(jobId);
    if (!job || !isSupportedWorkflow(job) || String(ctoTask?.role || '').toLowerCase() !== 'cto' || !plan) {
      throw new Error('cannot terminalize supported workflow without its immutable CTO plan');
    }
    const requiredRoles = (plan.children || []).map(item => String(item.role).toLowerCase());
    // created_at has millisecond precision and can tie for a rework task and
    // its predecessor. rowid preserves insertion order, unlike a UUID lexical
    // tie-breaker that can accidentally select stale evidence.
    const children = this.db.prepare('SELECT * FROM tasks WHERE job_id=? AND parent_task_id=? ORDER BY created_at DESC, rowid DESC')
      .all(jobId, ctoTask.task_id);
    const evidence = [];
    for (const role of requiredRoles) {
      const child = children.find(item => String(item.role).toLowerCase() === role);
      if (!child) throw new Error(`cannot terminalize supported workflow: missing required specialist child role=${role}`);
      const durableTask = this.getTask(child.task_id);
      const taskPolicy = this.assertSupportedTaskPlanBinding(durableTask, plan);
      const metadata = taskPolicy.metadata;
      const requiresExecutionEvidence = taskPolicy.requiresExecutionEvidence;
      const hasStructuredExecution = Boolean(durableTask?.execution_session_id && durableTask?.execution_status === 'completed' && durableTask?.execution_exit_code === 0);
      if ((requiresExecutionEvidence && (!hasStructuredExecution || !metadata.executor || (!metadata.command && !metadata.executable) || !metadata.cwd))) {
        throw new Error(`cannot terminalize supported workflow: invalid structured execution evidence for child role=${role}`);
      }
      evidence.push(this.assertSupportedTaskArtifactLineage(jobId, durableTask, plan));
    }
    return evidence;
  }
  assertDurableReportDeliveryClaim(jobId, report, { channel = null, target = null } = {}) {
    if (!report || report.job_id !== jobId || typeof report.report_id !== 'string' || !report.report_id) {
      throw new Error('terminalization requires exact durable report identity');
    }
    const reportRows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='report.created'").all(jobId);
    const reportMatches = [];
    for (const row of reportRows) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('terminalization found malformed report.created evidence'); }
      if (row.payload_json !== JSON.stringify(payload)) throw new Error('terminalization found non-canonical report.created evidence');
      if (payload?.reportId === report.report_id) reportMatches.push({ row, payload });
    }
    const expectedReportPayload = { reportId: report.report_id, kind: report.kind };
    if (reportMatches.length !== 1 || reportMatches[0].row.event_id !== eventId(jobId, 'report.created', report.report_id) ||
        reportMatches[0].row.job_id !== jobId || reportMatches[0].row.type !== 'report.created' ||
        reportMatches[0].row.payload_json !== JSON.stringify(expectedReportPayload)) {
      throw new Error('terminalization requires exactly one exact report.created lineage event');
    }
    const rows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='delivery.claimed'").all(jobId);
    const matches = [];
    for (const row of rows) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('terminalization found malformed delivery.claimed evidence'); }
      if (row.payload_json !== JSON.stringify(payload)) throw new Error('terminalization found non-canonical delivery.claimed evidence');
      if (payload?.reportId !== report.report_id) continue;
      if (typeof payload.channel !== 'string' || !payload.channel.trim() ||
          typeof payload.target !== 'string' || !payload.target.trim() ||
          Object.keys(payload).sort().join(',') !== 'channel,reportId,target' ||
          row.event_id !== eventId(jobId, 'delivery.claimed', hash(`${report.report_id}|${payload.channel}|${payload.target}`)) ||
          row.job_id !== jobId || row.type !== 'delivery.claimed') {
        throw new Error('terminalization found a delivery claim with conflicting deterministic identity');
      }
      if ((channel == null || payload.channel === channel) && (target == null || payload.target === target)) matches.push({ row, payload });
    }
    if (matches.length !== 1 || (channel != null && matches[0].payload.channel !== channel) ||
        (target != null && matches[0].payload.target !== target)) {
      throw new Error(`terminalization requires exactly one exact delivery claim for report=${report.report_id}`);
    }
    return matches[0];
  }
  assertSupportedTerminalReportDelivery(jobId, ctoEvidence, { reportId, deliveryChannel, deliveryTarget, content, terminalEvent = null } = {}) {
    if (!ctoEvidence?.result || typeof reportId !== 'string' || !reportId ||
        typeof deliveryChannel !== 'string' || !deliveryChannel || typeof deliveryTarget !== 'string' || !deliveryTarget) {
      throw new Error('cannot terminalize supported workflow without exact report and delivery identity');
    }
    const report = this.db.prepare('SELECT * FROM reports WHERE report_id=? AND job_id=?').get(reportId, jobId);
    if (!report || report.content !== ctoEvidence.result.content) {
      throw new Error('supported workflow report bytes do not match the durable CTO result');
    }
    if (content !== undefined && String(content || '').slice(0, 1000) !== String(ctoEvidence.result.content || '').slice(0, 1000)) {
      throw new Error('supported workflow terminal content does not match the durable CTO result');
    }
    const reportEvents = this.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type='report.created'").all(jobId);
    const reportMatches = [];
    for (const row of reportEvents) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('supported workflow report-created event payload is malformed'); }
      if (payload?.reportId === reportId) reportMatches.push({ row, payload });
    }
    if (reportMatches.length !== 1 || reportMatches[0].row.event_id !== eventId(jobId, 'report.created', reportId) ||
        reportMatches[0].row.job_id !== jobId || reportMatches[0].payload.kind !== report.kind ||
        reportMatches[0].row.payload_json !== JSON.stringify(reportMatches[0].payload) ||
        Object.keys(reportMatches[0].payload).sort().join(',') !== 'kind,reportId') {
      throw new Error('supported workflow report does not have exactly one canonical report-created event');
    }
    const deliveryRows = this.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type='delivery.claimed'").all(jobId);
    const deliveryMatches = [];
    for (const row of deliveryRows) {
      let payload;
      try { payload = parseStrictJson(row.payload_json); }
      catch { throw new Error('supported workflow delivery event payload is malformed'); }
      if (payload?.reportId === reportId && payload?.channel === deliveryChannel && payload?.target === deliveryTarget) {
        deliveryMatches.push({ row, payload });
      }
    }
    const expectedDeliveryId = eventId(jobId, 'delivery.claimed', hash(`${reportId}|${deliveryChannel}|${deliveryTarget}`));
    if (deliveryMatches.length !== 1 || deliveryMatches[0].row.event_id !== expectedDeliveryId ||
        deliveryMatches[0].row.job_id !== jobId || deliveryMatches[0].row.payload_json !== JSON.stringify(deliveryMatches[0].payload) ||
        Object.keys(deliveryMatches[0].payload).sort().join(',') !== 'channel,reportId,target') {
      throw new Error('supported workflow report lacks exactly one matching canonical delivery claim');
    }
    const reportEvent = reportMatches[0].row;
    const deliveryEvent = deliveryMatches[0].row;
    const times = [ctoEvidence.result.created_at, reportEvent.created_at, deliveryEvent.created_at].map(value => Date.parse(value));
    if (!times.every(Number.isFinite) || times[0] > times[1] || times[1] > times[2]) {
      throw new Error('supported workflow CTO/report/delivery timestamps contradict durable event order');
    }
    if (terminalEvent) {
      let payload;
      try { payload = parseStrictJson(terminalEvent.payload_json); }
      catch { throw new Error('supported workflow terminal event payload is malformed'); }
      const expectedTerminalId = eventId(jobId, 'job.completed', `${reportId}|terminal|success`);
      const terminalTime = Date.parse(terminalEvent.created_at);
      if (terminalEvent.event_id !== expectedTerminalId || terminalEvent.job_id !== jobId || terminalEvent.type !== 'job.completed' ||
          terminalEvent.payload_json !== JSON.stringify(payload) ||
          payload.reportId !== reportId || payload.outcome !== 'success' || payload.deliveryChannel !== deliveryChannel ||
          payload.deliveryTarget !== deliveryTarget || payload.content !== String(ctoEvidence.result.content || '').slice(0, 1000) ||
          Object.keys(payload).sort().join(',') !== 'content,deliveryChannel,deliveryTarget,outcome,reportId' ||
          !Number.isFinite(terminalTime) || terminalTime < times[2]) {
        throw new Error('supported workflow terminal event does not bind exact CTO result/report/delivery lineage');
      }
    }
    return { report, reportEvent, deliveryEvent };
  }
  terminalizeJob(jobId, { outcome = 'success', reportId = null, deliveryChannel = null, deliveryTarget = null, content = '' } = {}) {
    if (!['success', 'failure'].includes(outcome)) throw new Error(`invalid terminal outcome: ${outcome}`);
    const job = this.getJob(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase());
    if (terminal) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.getJob(jobId);
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(current?.state || '').toUpperCase())) {
          // An idempotent success response must not bypass durable lineage
          // verification after post-terminal tampering or partial recovery.
          if (current.state === 'COMPLETED' && isSupportedWorkflow(current)) {
            this.assertSupportedCtoChildEvidence(jobId, current);
            this.assertSupportedCtoTerminalEvidence(jobId, current);
            const terminalEvents = this.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type='job.completed'").all(jobId);
            if (terminalEvents.length !== 1) throw new Error('cannot return idempotent success: terminal completion event cardinality is invalid');
            let terminalPayload;
            try { terminalPayload = parseStrictJson(terminalEvents[0].payload_json); }
            catch { throw new Error('cannot return idempotent success: terminal completion event payload is malformed'); }
            const ctoEvidence = this.assertSupportedCtoTerminalEvidence(jobId, current);
            this.assertSupportedTerminalReportDelivery(jobId, ctoEvidence, {
              reportId: terminalPayload.reportId,
              deliveryChannel: terminalPayload.deliveryChannel,
              deliveryTarget: terminalPayload.deliveryTarget,
              terminalEvent: terminalEvents[0]
            });
          }
          this.reconcileTerminalWorkflowPhase(jobId, current.state === 'COMPLETED' ? 'success' : 'failure', reportId);
        }
        this.db.exec('COMMIT');
        return { job: this.getJob(jobId), idempotent: true };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    if (job.state !== 'EXECUTING') throw new Error(`cannot terminalize job from state=${job.state}`);

    const openTasks = this.db.prepare("SELECT task_id, role, status FROM tasks WHERE job_id=? AND status IN ('pending','running')").all(jobId);
    if (openTasks.length) throw new Error(`cannot terminalize with open tasks: ${openTasks.map(t => t.task_id).join(',')}`);

    const activeSessions = this.db.prepare("SELECT session_id, task_id, role, state FROM agent_sessions WHERE job_id=? AND state IN ('CREATED','ACTIVE','PAUSED')").all(jobId);
    if (activeSessions.length) {
      throw new Error(`cannot terminalize with active agent sessions: ${activeSessions.map(s => s.session_id).join(',')}`);
    }
    const runningExecutions = this.db.prepare("SELECT task_id, execution_session_id FROM tasks WHERE job_id=? AND execution_status='running'").all(jobId);
    if (runningExecutions.length) {
      throw new Error(`cannot terminalize with running executions: ${runningExecutions.map(e => e.execution_session_id || e.task_id).join(',')}`);
    }
    const activeBatches = this.db.prepare("SELECT batch_id, status FROM execution_batches WHERE job_id=? AND status IN ('RUNNING','WAITING')").all(jobId);
    if (activeBatches.length) {
      throw new Error(`cannot terminalize with active execution batches: ${activeBatches.map(b => b.batch_id).join(',')}`);
    }

    const report = reportId
      ? this.db.prepare('SELECT * FROM reports WHERE report_id=? AND job_id=?').get(reportId, jobId)
      : this.db.prepare('SELECT * FROM reports WHERE job_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(jobId);
    if (!report) throw new Error('cannot terminalize without durable report');

    if (outcome === 'success') {
      const failedTasks = this.db.prepare("SELECT task_id, role FROM tasks WHERE job_id=? AND status IN ('failed','cancelled')").all(jobId);
      if (failedTasks.length) throw new Error(`cannot terminalize success with failed tasks: ${failedTasks.map(t => t.task_id).join(',')}`);
      const activeTask = job.active_task_id ? this.getTask(job.active_task_id) : null;
      if (activeTask?.role === 'cto' && isSupportedWorkflow(job)) {
        const plan = this.getExecutionPlan(jobId);
        const requiredRoles = (plan?.children || []).map(item => String(item.role).toLowerCase());
        const children = this.db.prepare('SELECT task_id, role, status FROM tasks WHERE parent_task_id=? ORDER BY created_at DESC, rowid DESC').all(activeTask.task_id);
        const missing = requiredRoles.filter(role => !children.some(t => String(t.role).toLowerCase() === role));
        if (missing.length) throw new Error(`cannot terminalize: missing required specialist children: ${missing.join(',')}`);
        for (const role of requiredRoles) {
          const child = children.find(t => String(t.role).toLowerCase() === role);
          const durableTask = this.getTask(child.task_id);
          const taskPolicy = this.assertSupportedTaskPlanBinding(durableTask, plan);
          const metadata = taskPolicy.metadata;
          const requiresExecutionEvidence = taskPolicy.requiresExecutionEvidence;
          const hasStructuredExecution = Boolean(
            durableTask?.execution_session_id
            && durableTask?.execution_status === 'completed'
            && durableTask?.execution_exit_code === 0
          );
          const result = this.db.prepare('SELECT content FROM results WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(durableTask.task_id);
          if ((requiresExecutionEvidence && (!hasStructuredExecution || !metadata.executor || (!metadata.command && !metadata.executable) || !metadata.cwd))
              || (!requiresExecutionEvidence && !String(result?.content || '').trim())) {
            throw new Error(`cannot terminalize: invalid actual evidence for required child role=${role}`);
          }
        }
      }
    }

    const delivery = deliveryChannel && deliveryTarget
      ? this.db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='delivery.claimed' AND json_extract(payload_json,'$.reportId')=? AND json_extract(payload_json,'$.channel')=? AND json_extract(payload_json,'$.target')=? LIMIT 1").get(jobId, report.report_id, deliveryChannel, deliveryTarget)
      : this.db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='delivery.claimed' AND json_extract(payload_json,'$.reportId')=? LIMIT 1").get(jobId, report.report_id);
    if (!delivery) throw new Error(`cannot terminalize without delivery claim for report=${report.report_id}`);

    const finalState = outcome === 'success' ? 'COMPLETED' : 'FAILED';
    const finalStatus = outcome === 'success' ? 'completed' : 'failed';
    const ts = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getJob(jobId);
      if (current.state !== 'EXECUTING') {
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(current.state || '').toUpperCase())) {
          this.reconcileTerminalWorkflowPhase(jobId, current.state === 'COMPLETED' ? 'success' : 'failure', reportId, ts);
        }
        this.db.exec('COMMIT');
        return { job: this.getJob(jobId), idempotent: true };
      }
      // The preflight checks above are intentionally user-friendly, but they
      // happen before this connection owns SQLite's writer lock. Another
      // process may complete/add work, change delivery evidence, or create a
      // live runtime resource between preflight and BEGIN IMMEDIATE. Recheck
      // every mutable terminalization invariant while holding the writer lock.
      const lockedOpenTasks = this.db.prepare("SELECT task_id FROM tasks WHERE job_id=? AND status IN ('pending','running')").all(jobId);
      if (lockedOpenTasks.length) throw new Error(`cannot terminalize with open tasks: ${lockedOpenTasks.map(t => t.task_id).join(',')}`);
      const lockedSessions = this.db.prepare("SELECT session_id FROM agent_sessions WHERE job_id=? AND state IN ('CREATED','ACTIVE','PAUSED')").all(jobId);
      if (lockedSessions.length) throw new Error(`cannot terminalize with active agent sessions: ${lockedSessions.map(s => s.session_id).join(',')}`);
      const lockedExecutions = this.db.prepare("SELECT task_id, execution_session_id FROM tasks WHERE job_id=? AND execution_status='running'").all(jobId);
      if (lockedExecutions.length) throw new Error(`cannot terminalize with running executions: ${lockedExecutions.map(e => e.execution_session_id || e.task_id).join(',')}`);
      const lockedBatches = this.db.prepare("SELECT batch_id FROM execution_batches WHERE job_id=? AND status IN ('RUNNING','WAITING')").all(jobId);
      if (lockedBatches.length) throw new Error(`cannot terminalize with active execution batches: ${lockedBatches.map(b => b.batch_id).join(',')}`);
      const lockedReport = reportId
        ? this.db.prepare('SELECT * FROM reports WHERE report_id=? AND job_id=?').get(reportId, jobId)
        : this.db.prepare('SELECT * FROM reports WHERE job_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(jobId);
      if (!lockedReport || lockedReport.report_id !== report.report_id || lockedReport.kind !== report.kind || lockedReport.content !== report.content) {
        throw new Error('durable report changed during terminalization preflight');
      }
      const lockedDelivery = deliveryChannel && deliveryTarget
        ? this.db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='delivery.claimed' AND json_extract(payload_json,'$.reportId')=? AND json_extract(payload_json,'$.channel')=? AND json_extract(payload_json,'$.target')=? LIMIT 1").get(jobId, lockedReport.report_id, deliveryChannel, deliveryTarget)
        : this.db.prepare("SELECT 1 FROM events WHERE job_id=? AND type='delivery.claimed' AND json_extract(payload_json,'$.reportId')=? LIMIT 1").get(jobId, lockedReport.report_id);
      if (!lockedDelivery) throw new Error(`cannot terminalize without delivery claim for report=${lockedReport.report_id}`);
      this.assertDurableReportDeliveryClaim(jobId, lockedReport, { channel: deliveryChannel, target: deliveryTarget });
      if (outcome === 'success') {
        const lockedFailedTasks = this.db.prepare("SELECT task_id FROM tasks WHERE job_id=? AND status IN ('failed','cancelled')").all(jobId);
        if (lockedFailedTasks.length) throw new Error(`cannot terminalize success with failed tasks: ${lockedFailedTasks.map(t => t.task_id).join(',')}`);
        const lockedActiveTask = current.active_task_id ? this.getTask(current.active_task_id) : null;
        if (isSupportedWorkflow(current)) {
          if (String(lockedActiveTask?.role || '').toLowerCase() !== 'cto') {
            throw new Error('cannot terminalize supported workflow success without the active CTO synthesis task');
          }
          this.assertSupportedCtoChildEvidence(jobId, current);
          // Bind exact report bytes and the ordered report-created -> delivery
          // claim chain before changing the job to terminal state.
          const ctoEvidence = this.assertSupportedCtoTerminalEvidence(jobId, current);
          this.assertSupportedTerminalReportDelivery(jobId, ctoEvidence, {
            reportId: lockedReport.report_id, deliveryChannel, deliveryTarget, content
          });
        }
      }
      const stateUpdate = this.db.prepare("UPDATE jobs SET state=?, status=?, completed_at=?, updated_at=?, provider_waiting=0, provider_retry_at=NULL WHERE job_id=? AND state='EXECUTING'")
        .run(finalState, finalStatus, ts, ts, jobId);
      if (stateUpdate.changes !== 1) throw new Error('terminalization state compare-and-set did not update exactly one executing job');

      // Keep projection phases intact while reconciling direct terminalization.
      this.reconcileTerminalWorkflowPhase(jobId, outcome, report.report_id, ts);
      const terminalType = outcome === 'success' ? 'job.completed' : 'job.failed';
      const terminalPayload = {
        reportId: report.report_id, outcome, deliveryChannel, deliveryTarget, content: String(content || '').slice(0, 1000)
      };
      const terminalEventId = this.recordEvent(jobId, terminalType, terminalPayload, `${report.report_id}|terminal|${outcome}`);
      const terminalRows = this.db.prepare("SELECT event_id, job_id, type, payload_json FROM events WHERE job_id=? AND type IN ('job.completed','job.failed')").all(jobId);
      const event = this.db.prepare('SELECT event_id, job_id, type, payload_json FROM events WHERE event_id=?').get(terminalEventId);
      let persistedPayload;
      try { persistedPayload = parseStrictJson(event?.payload_json || ''); }
      catch { throw new Error('terminalization event payload is missing or malformed after write'); }
      if (terminalRows.length !== 1 || !event || event.event_id !== eventId(jobId, terminalType, `${report.report_id}|terminal|${outcome}`) ||
          event.job_id !== jobId || event.type !== terminalType ||
          JSON.stringify(persistedPayload) !== JSON.stringify(terminalPayload)) {
        throw new Error('terminalization event conflicts with the exact terminal outcome/report/delivery payload');
      }
      this.db.exec('COMMIT');
      return { job: this.getJob(jobId), idempotent: false };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  claimDelivery(jobId, reportId, channel, target) {
    if (typeof jobId !== 'string' || !jobId || typeof reportId !== 'string' || !reportId ||
        typeof channel !== 'string' || !channel.trim() || typeof target !== 'string' || !target.trim()) {
      throw new Error('delivery claim requires exact job/report/channel/target identity');
    }
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CLAIM_DELIVERY_BARRIER_DIR) {
      const directory = path.resolve(process.env.CHAT_ON_STEROIDS_TEST_CLAIM_DELIVERY_BARRIER_DIR);
      const ready = path.join(directory, `${process.pid}.ready`);
      const release = path.join(directory, 'release');
      fs.writeFileSync(ready, `${jobId}|${reportId}\n`, { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(release)) {
        if (Date.now() > deadline) throw new Error('test claim-delivery barrier timed out before writer reservation');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    this.db.exec('SAVEPOINT claim_delivery_transition');
    try {
      const reservation = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(jobId);
      if (reservation.changes !== 1) throw new Error(`cannot claim delivery for unknown job: ${jobId}`);
      const report = this.db.prepare('SELECT report_id,job_id,kind,content,created_at FROM reports WHERE report_id=? AND job_id=?').get(reportId, jobId);
      if (!report || report.report_id !== reportId || report.job_id !== jobId) throw new Error('delivery claim does not reference a durable report for this job');
      const expectedReportEventId = eventId(jobId, 'report.created', reportId);
      const expectedReportEventPayload = { reportId, kind: report.kind };
      const reportCreatedRows = this.db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE job_id=? AND type='report.created'")
        .all(jobId);
      const matchingReportEvents = [];
      for (const row of reportCreatedRows) {
        let payload;
        try { payload = parseStrictJson(row.payload_json); }
        catch { throw new Error('delivery claim found malformed report.created event evidence'); }
        if (row.payload_json !== JSON.stringify(payload)) throw new Error('delivery claim found non-canonical report.created event JSON');
        if (payload?.reportId === reportId) matchingReportEvents.push({ row, payload });
      }
      if (matchingReportEvents.length !== 1 || matchingReportEvents[0].row.event_id !== expectedReportEventId ||
          matchingReportEvents[0].row.job_id !== jobId || matchingReportEvents[0].row.type !== 'report.created' ||
          matchingReportEvents[0].row.payload_json !== JSON.stringify(expectedReportEventPayload)) {
        throw new Error('delivery claim requires exactly one exact durable report.created lineage event');
      }
      const key = hash(`${reportId}|${channel}|${target}`);
      const expectedEventId = eventId(jobId, 'delivery.claimed', key);
      const expectedPayload = { reportId, channel, target };
      const deliveryRows = this.db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE job_id=? AND type='delivery.claimed'")
        .all(jobId);
      const matching = [];
      for (const row of deliveryRows) {
        let payload;
        try { payload = parseStrictJson(row.payload_json); }
        catch (error) {
          throw new Error(`delivery claim found non-canonical delivery.claimed event JSON (malformed strict JSON): ${String(error?.message || error)}`);
        }
        if (row.payload_json !== JSON.stringify(payload)) throw new Error('delivery claim found non-canonical delivery.claimed event JSON');
        if (payload?.reportId === reportId && payload?.channel === channel && payload?.target === target) matching.push({ row, payload });
      }
      if (matching.length > 1) throw new Error('delivery claim found duplicate logical acknowledgement events for this report/destination');
      let created = false;
      if (matching.length === 1) {
        const { row, payload } = matching[0];
        if (row.event_id !== expectedEventId || row.job_id !== jobId || row.type !== 'delivery.claimed' ||
            row.payload_json !== JSON.stringify(expectedPayload)) {
          throw new Error('existing delivery claim conflicts with its deterministic ID or exact durable payload');
        }
      } else {
        const conflictingKey = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(expectedEventId);
        if (conflictingKey) throw new Error('delivery claim deterministic event ID is occupied by conflicting durable evidence');
        this.recordEvent(jobId, 'delivery.claimed', expectedPayload, key);
        if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_DELIVERY_EVENT_INSERT === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
        created = true;
      }
      const finalRows = this.db.prepare("SELECT event_id,job_id,type,payload_json FROM events WHERE job_id=? AND type='delivery.claimed'").all(jobId);
      const finalMatches = finalRows.filter(row => {
        try { return parseStrictJson(row.payload_json)?.reportId === reportId && parseStrictJson(row.payload_json)?.channel === channel && parseStrictJson(row.payload_json)?.target === target; }
        catch { return false; }
      });
      if (finalMatches.length !== 1 || finalMatches[0].event_id !== expectedEventId || finalMatches[0].job_id !== jobId ||
          finalMatches[0].type !== 'delivery.claimed' || finalMatches[0].payload_json !== JSON.stringify(expectedPayload)) {
        throw new Error('delivery claim exact event readback or cardinality failed');
      }
      this.db.exec('RELEASE SAVEPOINT claim_delivery_transition');
      return created;
    } catch (failure) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT claim_delivery_transition'); } catch {}
      try { this.db.exec('RELEASE SAVEPOINT claim_delivery_transition'); } catch {}
      throw failure;
    }
  }
  reconcileStaleAttempts(maxAgeMs = 15 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.db.prepare("SELECT a.*, t.job_id FROM attempts a JOIN tasks t ON t.task_id = a.task_id WHERE a.status = 'started' AND a.started_at < ?").all(cutoff);
    for (const row of rows) {
      this.db.exec('SAVEPOINT reconcile_stale_attempt_transition');
      try {
        // Acquire the writer reservation before trusting the stale-attempt scan.
        // A terminalizer or runtime completion may have changed job/task/attempt
        // state since the initial query returned this candidate.
        const reservation = this.db.prepare('UPDATE jobs SET updated_at=updated_at WHERE job_id=?').run(row.job_id);
        if (reservation.changes !== 1) {
          this.db.exec('RELEASE SAVEPOINT reconcile_stale_attempt_transition');
          continue;
        }
        const job = this.getJob(row.job_id);
        const attempt = this.db.prepare("SELECT attempt_id,task_id,started_at FROM attempts WHERE attempt_id=? AND task_id=? AND status='started' AND started_at<?")
          .get(row.attempt_id, row.task_id, cutoff);
        const task = this.getTask(row.task_id);
        if (!job || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase()) ||
            ['completed', 'failed', 'cancelled'].includes(String(job.status || '').toLowerCase()) ||
            !attempt || !task || task.job_id !== row.job_id || task.status !== 'running') {
          this.db.exec('RELEASE SAVEPOINT reconcile_stale_attempt_transition');
          continue;
        }
        const openAttempts = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC,rowid DESC")
          .all(row.task_id);
        if (openAttempts.length !== 1 || openAttempts[0].attempt_id !== row.attempt_id) {
          throw new Error(`stale attempt reconciliation found ambiguous active-attempt lineage: ${row.task_id}`);
        }
        const ts = now();
        const attemptUpdate = this.db.prepare("UPDATE attempts SET status='timeout',finished_at=?,error=? WHERE attempt_id=? AND status='started' AND started_at<?")
          .run(ts, 'stale attempt recovered by reconciler', row.attempt_id, cutoff);
        if (attemptUpdate.changes !== 1) throw new Error(`stale attempt recovery lost attempt ownership: ${row.attempt_id}`);
        const timeoutPayload = { attemptId: row.attempt_id, taskId: row.task_id };
        const timeoutEventId = this.recordEvent(row.job_id, 'attempt.timeout', timeoutPayload, row.attempt_id);
        const timeoutEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(timeoutEventId);
        const timeoutEvents = this.db.prepare("SELECT event_id FROM events WHERE job_id=? AND type='attempt.timeout' AND json_extract(payload_json,'$.attemptId')=?")
          .all(row.job_id, row.attempt_id);
        if (timeoutEvents.length !== 1 || !timeoutEvent || timeoutEvent.event_id !== eventId(row.job_id, 'attempt.timeout', row.attempt_id) ||
            timeoutEvent.job_id !== row.job_id || timeoutEvent.type !== 'attempt.timeout' || timeoutEvent.payload_json !== JSON.stringify(timeoutPayload)) {
          throw new Error(`stale attempt timeout event lineage readback failed: ${row.attempt_id}`);
        }
        const isProductionE2E = isProductionWorkflow(job);
        if (isProductionE2E && String(job.state || '').toUpperCase() === 'EXECUTING' && job.status === 'active') {
          // Provider/runtime timeout is recoverable workflow state. RecoveryManager
          // owns WAIT/RESUME and must preserve the same durable task/session.
          const taskUpdate = this.db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE task_id=? AND job_id=? AND status='running'")
            .run(ts, row.task_id, row.job_id);
          if (taskUpdate.changes !== 1) throw new Error(`recoverable stale attempt lost task ownership: ${row.task_id}`);
          const recoverablePayload = {
            taskId: row.task_id,
            attemptId: row.attempt_id,
            reason: 'production-e2e stale attempt; preserve EXECUTING for runtime recovery'
          };
          const recoverableEventId = this.recordEvent(row.job_id, 'task.timeout_recoverable', recoverablePayload, row.attempt_id + '|recoverable');
          const recoverableEvent = this.db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(recoverableEventId);
          if (!recoverableEvent || recoverableEvent.event_id !== eventId(row.job_id, 'task.timeout_recoverable', row.attempt_id + '|recoverable') ||
              recoverableEvent.job_id !== row.job_id || recoverableEvent.type !== 'task.timeout_recoverable' ||
              recoverableEvent.payload_json !== JSON.stringify(recoverablePayload)) {
            throw new Error(`recoverable stale-attempt event lineage readback failed: ${row.attempt_id}`);
          }
          this.db.exec('RELEASE SAVEPOINT reconcile_stale_attempt_transition');
          continue;
        }
        const taskUpdate = this.db.prepare("UPDATE tasks SET status='failed',updated_at=? WHERE task_id=? AND job_id=? AND status='running'")
          .run(ts, row.task_id, row.job_id);
        if (taskUpdate.changes !== 1) throw new Error(`stale attempt recovery lost running task ownership: ${row.task_id}`);
        this.transition(row.job_id, 'IDLE', 'failed');
        this.db.exec('RELEASE SAVEPOINT reconcile_stale_attempt_transition');
      } catch (error) {
        try { this.db.exec('ROLLBACK TO SAVEPOINT reconcile_stale_attempt_transition'); } catch {}
        try { this.db.exec('RELEASE SAVEPOINT reconcile_stale_attempt_transition'); } catch {}
        throw error;
      }
    }
    return rows.length;
  }
  getStats() {
    const jobs = this.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN state IN ('PROPOSED','APPROVED','IDLE') THEN 1 ELSE 0 END) AS awaitingDispatch,
      SUM(CASE WHEN state='EXECUTING' THEN 1 ELSE 0 END) AS executing,
      SUM(CASE WHEN state='COMPLETED' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN state IN ('FAILED','CANCELLED') THEN 1 ELSE 0 END) AS failed
      FROM jobs`).get();
    const phaseMismatches = this.db.prepare(`SELECT COUNT(*) AS count
      FROM jobs j LEFT JOIN workflow_runtime_state r ON r.job_id=j.job_id
      WHERE (j.state='COMPLETED' AND COALESCE(r.phase,'') NOT IN ('COMPLETED','TERMINALIZE','PROJECT'))
         OR (j.state IN ('FAILED','CANCELLED') AND COALESCE(r.phase,'') <> 'FAILED')
         OR (j.state='EXECUTING' AND COALESCE(r.phase,'') IN ('COMPLETED','FAILED'))`).get().count;
    return {
      jobs: Number(jobs.total || 0),
      activeJobs: Number(jobs.active || 0),
      awaitingDispatchJobs: Number(jobs.awaitingDispatch || 0),
      executingJobs: Number(jobs.executing || 0),
      completedJobs: Number(jobs.completed || 0),
      failedJobs: Number(jobs.failed || 0),
      workflowPhaseMismatches: Number(phaseMismatches || 0),
      events: this.db.prepare('SELECT COUNT(*) AS count FROM events').get().count,
      tasks: this.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count
    };
  }
  getObservability({ eventLimit = 50 } = {}) {
    const stats = this.getStats();
    const byState = this.db.prepare('SELECT state, status, COUNT(*) AS count FROM jobs GROUP BY state, status ORDER BY state').all();
    const taskStates = this.db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY status').all();
    const attempts = this.db.prepare('SELECT status, COUNT(*) AS count FROM attempts GROUP BY status ORDER BY status').all();
    const safeLimit = Math.max(1, Math.min(200, Number(eventLimit) || 50));
    const recentEvents = this.db.prepare('SELECT event_id, job_id, type, payload_json, created_at FROM events ORDER BY created_at DESC, rowid DESC LIMIT ?').all(safeLimit).map(sanitizeObservabilityEvent);
    return { schema_version: 1, generated_at: now(), stats, byState, taskStates, attempts, recentEvents };
  }
  getJobTrace(jobId) {
    const job = this.getJob(jobId);
    if (!job) return null;
    const tasks = this.db.prepare('SELECT rowid AS durable_rowid, * FROM tasks WHERE job_id = ? ORDER BY created_at, rowid').all(jobId);
    const taskIds = tasks.map(t => t.task_id);
    const attempts = taskIds.length ? this.db.prepare(`SELECT * FROM attempts WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY started_at, rowid`).all(...taskIds) : [];
    const results = taskIds.length ? this.db.prepare(`SELECT rowid AS durable_rowid, * FROM results WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY created_at, rowid`).all(...taskIds) : [];
    const approvals = this.db.prepare('SELECT * FROM approvals WHERE job_id = ? ORDER BY created_at').all(jobId);
    const reports = this.db.prepare('SELECT report_id, kind, content, delivered_at, created_at FROM reports WHERE job_id = ? ORDER BY created_at').all(jobId);
    const artifacts = this.listArtifacts(jobId);
    const events = this.db.prepare('SELECT event_id, type, payload_json, created_at FROM events WHERE job_id = ? ORDER BY created_at, rowid').all(jobId);
    const sessions = this.db.prepare('SELECT * FROM agent_sessions WHERE job_id = ? ORDER BY created_at, rowid').all(jobId);
    const sessionIds = sessions.map(s => s.session_id);
    const sessionMessages = sessionIds.length
      ? this.db.prepare(`SELECT * FROM session_messages WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY created_at, rowid`).all(...sessionIds)
      : [];
    return { job, tasks, attempts, approvals, results, reports, artifacts, events, sessions, sessionMessages };
  }
  listActiveJobs(limit = 50) {
    return this.db.prepare(`SELECT j.job_id, j.title, j.state, j.status, j.active_task_id,
      r.phase, r.resume_after, r.last_error, j.provider_waiting, j.provider_retry_at,
      j.created_at, j.updated_at
      FROM jobs j LEFT JOIN workflow_runtime_state r ON r.job_id=j.job_id
      WHERE j.status = 'active' ORDER BY j.updated_at DESC LIMIT ?`).all(Math.min(Math.max(Number(limit) || 50, 1), 200));
  }
  listProjectableJobs(limit = 50) {
    return this.db.prepare("SELECT j.job_id, j.title, j.state, j.status, j.active_task_id, j.created_at, j.updated_at FROM jobs j JOIN workflow_runtime_state r ON r.job_id = j.job_id WHERE j.status = 'completed' AND r.phase IN ('TERMINALIZE', 'PROJECT') ORDER BY j.updated_at DESC LIMIT ?").all(Math.min(Math.max(Number(limit) || 50, 1), 200));
  }
}

export const workflowStore = new WorkflowStore();
export const WORKFLOW_DB_PATH = DB_PATH;
