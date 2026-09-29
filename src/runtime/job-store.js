import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createEnvelope, validateEnvelope, validatePayload } from '../../protocol/cos-ap-v1/index.js';
import { isProductionWorkflow } from './workflow/definitions/production.js';
import { isSupportedWorkflow } from './workflow/definitions/index.js';
import { ProductionRoles } from './workflow/catalog/production.js';
import { compileWorkflowPlan } from './workflow/compiler.js';
import { canonicalJson } from './workflow/plan.js';

const DATA_DIR = process.env.WORKFLOW_DATA_DIR || '/home/long/work/chatgpt-adapter/data';
const DB_PATH = process.env.WORKFLOW_DB || path.join(DATA_DIR, 'workflow.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(DB_PATH, { timeout: 5000, enableForeignKeyConstraints: true });

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
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')), actor TEXT NOT NULL, raw_text TEXT NOT NULL, created_at TEXT NOT NULL
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
  SYNTHESIZE: new Set(['TERMINALIZE', 'FAILED']),
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
  constructor(database = db) { this.db = database; }
  getActiveJob(conversationKey) {
    return this.db.prepare("SELECT * FROM jobs WHERE conversation_key = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1").get(conversationKey) || null;
  }

  getLatestProposedJob() {
    return this.db.prepare("SELECT * FROM jobs WHERE status = 'active' AND state = 'PROPOSED' ORDER BY updated_at DESC LIMIT 1").get() || null;
  }
  getJob(jobId) { return this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) || null; }
  getWorkflowRuntimeState(jobId) {
    return this.db.prepare('SELECT * FROM workflow_runtime_state WHERE job_id = ?').get(jobId) || null;
  }
  getExecutionPlan(jobId) {
    const row = this.db.prepare('SELECT * FROM workflow_plans WHERE job_id = ?').get(jobId);
    if (!row) return null;
    return { ...JSON.parse(row.plan_json), plan_hash: row.plan_hash, compiled_at: row.compiled_at, approved_at: row.approved_at };
  }
  compileExecutionPlan(jobId, { workspace = process.env.WORKFLOW_WORKSPACE } = {}) {
    const job = this.getJob(jobId);
    if (!job) throw new Error('job not found: ' + jobId);
    const existing = this.getExecutionPlan(jobId);
    const plan = compileWorkflowPlan(job, { workspace });
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
    const nextAttempt = attempt == null ? Number(current?.attempt || 0) : Number(attempt);
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
    this.db.prepare(`INSERT OR IGNORE INTO workflow_events(
      workflow_event_id, job_id, from_phase, to_phase, event, attempt, payload_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id('workflow_event'), jobId, fromPhase, toPhase, event, Number(next.attempt || 0), JSON.stringify(payload), now());
    this.recordEvent(jobId, event, { fromPhase, toPhase, ...payload }, `${fromPhase}|${toPhase}|${attempt ?? next.attempt}`);
    return next;
  }
  transition(jobId, state, status = 'active') {
    const ts = now();
    this.db.prepare("UPDATE jobs SET state = ?, status = ?, updated_at = ?, completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE completed_at END WHERE job_id = ?").run(state, status, ts, status, ts, jobId);
    return this.getJob(jobId);
  }
  ensureTask(jobId, { role = 'cto', description }) {
    const existing = this.db.prepare("SELECT * FROM tasks WHERE job_id = ? AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1").get(jobId);
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
    if (!leaseId || !workerId) throw new Error('leaseId and workerId are required');
    const task = this.getTask(taskId); if (!task) throw new Error(`task not found: ${taskId}`);
    const nextAttempt = attempt == null ? Math.max(1, Number(task.execution_attempt || 0) + 1) : Number(attempt);
    if (!Number.isInteger(nextAttempt) || nextAttempt < 1) throw new Error('invalid lease attempt');
    const nowTs = new Date().toISOString();
    const expires = new Date(Date.now() + Math.max(1000, Number(ttlMs) || 60000)).toISOString();
    const tx = this.db.transaction(() => {
      const active = this.db.prepare("SELECT * FROM task_leases WHERE task_id=? AND state='ACTIVE'").get(taskId);
      if (active) throw new Error(`task already leased: ${taskId}`);
      const current = this.getTask(taskId);
      if (['completed','cancelled'].includes(String(current.status))) throw new Error(`cannot lease terminal task: ${taskId}`);
      this.db.prepare(`INSERT INTO task_leases(lease_id,task_id,job_id,attempt,worker_id,state,issued_at,heartbeat_at,expires_at)
        VALUES(?,?,?,?,?,'ACTIVE',?,?,?)`).run(leaseId, taskId, task.job_id, nextAttempt, workerId, nowTs, nowTs, expires);
      this.db.prepare("UPDATE tasks SET status='running', execution_attempt=?, updated_at=? WHERE task_id=? AND status IN ('pending','failed','running')")
        .run(nextAttempt, nowTs, taskId);
      this.recordEvent(task.job_id, 'task.lease.acquired', { taskId, leaseId, workerId, attempt: nextAttempt, expiresAt: expires }, leaseId);
    });
    tx();
    return this.getTaskLease(leaseId);
  }

  getTaskLease(leaseId) { return this.db.prepare('SELECT * FROM task_leases WHERE lease_id=?').get(leaseId) || null; }

  heartbeatTaskLease(leaseId, { workerId, ttlMs = 60000 } = {}) {
    const lease = this.getTaskLease(leaseId);
    if (!lease || lease.state !== 'ACTIVE') return { ok: false, reason: 'lease_not_active' };
    if (lease.worker_id !== workerId) return { ok: false, reason: 'worker_fenced' };
    if (Date.parse(lease.expires_at) <= Date.now()) {
      this.expireTaskLease(leaseId, { reason: 'heartbeat_after_expiry' });
      return { ok: false, reason: 'lease_expired' };
    }
    const nowTs = new Date().toISOString();
    const expires = new Date(Date.now() + Math.max(1000, Number(ttlMs) || 60000)).toISOString();
    this.db.prepare("UPDATE task_leases SET heartbeat_at=?, expires_at=? WHERE lease_id=? AND state='ACTIVE' AND worker_id=?")
      .run(nowTs, expires, leaseId, workerId);
    return { ok: true, lease: this.getTaskLease(leaseId) };
  }

  completeTaskLease(leaseId, { workerId, success = true, error = null } = {}) {
    const lease = this.getTaskLease(leaseId);
    if (!lease || lease.state !== 'ACTIVE') return { ok: false, reason: 'lease_not_active' };
    if (lease.worker_id !== workerId) return { ok: false, reason: 'worker_fenced' };
    const state = success ? 'COMPLETED' : 'FAILED';
    const ts = new Date().toISOString();
    this.db.prepare('UPDATE task_leases SET state=?, released_at=?, last_error=? WHERE lease_id=? AND state=\'ACTIVE\' AND worker_id=?')
      .run(state, ts, error, leaseId, workerId);
    this.recordEvent(lease.job_id, 'task.lease.completed', { taskId: lease.task_id, leaseId, attempt: lease.attempt, success, error }, leaseId);
    return { ok: true, lease: this.getTaskLease(leaseId) };
  }

  expireTaskLease(leaseId, { reason = 'lease_expired' } = {}) {
    const lease = this.getTaskLease(leaseId);
    if (!lease || lease.state !== 'ACTIVE') return null;
    const ts = new Date().toISOString();
    this.db.prepare("UPDATE task_leases SET state='EXPIRED', released_at=?, last_error=? WHERE lease_id=? AND state='ACTIVE'")
      .run(ts, reason, leaseId);
    this.db.prepare("UPDATE tasks SET status='pending', updated_at=? WHERE task_id=? AND status='running' AND execution_attempt=?")
      .run(ts, lease.task_id, lease.attempt);
    this.recordEvent(lease.job_id, 'task.lease.expired', { taskId: lease.task_id, leaseId, attempt: lease.attempt, reason }, leaseId);
    return this.getTaskLease(leaseId);
  }

  reapExpiredTaskLeases({ now = Date.now(), jobId = null } = {}) {
    const rows = this.db.prepare(`SELECT lease_id FROM task_leases WHERE state='ACTIVE' AND expires_at <= ?${jobId ? ' AND job_id=?' : ''}`)
      .all(new Date(now).toISOString(), ...(jobId ? [jobId] : []));
    let expired = 0;
    for (const row of rows) if (this.expireTaskLease(row.lease_id)) expired++;
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
    const lease = this.getTaskLease(result.lease_id);
    if (!lease) return { status: 'REJECTED', reason: 'lease_not_found' };
    if (lease.state !== 'ACTIVE') return { status: 'REJECTED', reason: 'lease_not_active' };
    if (lease.task_id !== result.task_id || lease.job_id !== result.job_id || lease.attempt !== result.attempt) {
      return { status: 'REJECTED', reason: 'stale_attempt_or_correlation_mismatch' };
    }
    const task = this.getTask(result.task_id);
    if (!task || Number(task.execution_attempt) !== Number(result.attempt)) return { status: 'REJECTED', reason: 'task_attempt_mismatch' };
    const ts = now();
    const success = result.status === 'SUCCEEDED' && Number(result.exit_code) === 0;
    this.db.prepare(`INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, ?, ?, ?)`)
      .run(id('result'), result.task_id, success ? 'success' : 'failure', JSON.stringify({
        provider_run_id: result.provider_run_id, output_commit: result.output_commit,
        evidence_artifact: result.evidence_artifact, evidence_refs: result.evidence_refs,
        evidence_verification: result.evidence_verification || null, error: result.error || null
      }), ts);
    this.db.prepare(`UPDATE tasks SET status=?, execution_status=?, execution_exit_code=?, execution_finished_at=?, updated_at=?
      WHERE task_id=? AND status='running' AND execution_attempt=?`)
      .run(success ? 'completed' : 'failed', success ? 'completed' : 'failed', result.exit_code ?? null, result.finished_at || ts, ts, result.task_id, result.attempt);
    this.completeTaskLease(result.lease_id, { workerId: lease.worker_id, success, error: result.error || null });
    this.recordEvent(result.job_id, success ? 'task.execution.verified' : 'task.execution.rejected', {
      taskId: result.task_id, leaseId: result.lease_id, attempt: result.attempt,
      providerRunId: result.provider_run_id, outputCommit: result.output_commit,
      evidenceHash: result.evidence_verification?.evidence_hash || null
    }, `${result.lease_id}|verified|${result.attempt}`);
    return { status: success ? 'VERIFIED' : 'REJECTED', task: this.getTask(result.task_id) };
  }
  getExecutionBatch(batchId) { return this.db.prepare('SELECT * FROM execution_batches WHERE batch_id = ?').get(batchId) || null; }
  listExecutionBatchItems(batchId) { return this.db.prepare('SELECT * FROM execution_batch_items WHERE batch_id = ? ORDER BY rowid ASC').all(batchId); }
  createExecutionBatch(jobId, { parentTaskId = null, role = 'executor', items = [], attempt = 1 } = {}) {
    if (!items.length) throw new Error('execution batch requires at least one item');
    const job = this.getJob(jobId);
    if (!job || job.state !== 'EXECUTING') throw new Error(`execution batch requires EXECUTING job: ${jobId}`);
    const normalized = items.map(item => {
      const task = this.getTask(item.taskId);
      if (!task || task.job_id !== jobId) throw new Error(`batch task not found in Job: ${item.taskId}`);
      const metadata = JSON.parse(task.metadata_json || '{}');
      const command = String(item.command || metadata.command || '').trim();
      if (!metadata.deterministic || !metadata.command || !command || metadata.command !== command || (metadata.executor && metadata.executor !== 'ExecutionManager')) {
        throw new Error(`batch task is not an exact deterministic task: ${item.taskId}`);
      }
      const cwd = String(item.cwd || metadata.cwd || '').trim() || null;
      const timeoutMs = item.timeout_ms == null ? null : Math.max(1, Number(item.timeout_ms) || 0);
      return { taskId: task.task_id, command, cwd, timeoutMs };
    });
    const batchId = id('batch'); const ts = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO execution_batches(batch_id, job_id, parent_task_id, role, status, attempt, created_at, started_at)
        VALUES(?, ?, ?, ?, 'RUNNING', ?, ?, ?)`).run(batchId, jobId, parentTaskId, role, Number(attempt), ts, ts);
      for (const item of normalized) {
        const itemId = id('batch_item');
        this.db.prepare(`INSERT INTO execution_batch_items(batch_id, item_id, task_id, command, cwd, timeout_ms, status)
          VALUES(?, ?, ?, ?, ?, ?, 'PENDING')`).run(batchId, itemId, item.taskId, item.command, item.cwd, item.timeoutMs);
      }
      this.recordEvent(jobId, 'execution.batch.created', {
        batchId, parentTaskId, role, attempt: Number(attempt), taskIds: normalized.map(x => x.taskId), commands: normalized.map(x => x.command), items: normalized
      }, batchId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getExecutionBatch(batchId);
  }
  markExecutionBatchItemRunning(batchId, itemId, { startedAt = now() } = {}) {
    this.db.prepare("UPDATE execution_batch_items SET status='RUNNING', started_at=? WHERE batch_id=? AND item_id=? AND status='PENDING'").run(startedAt, batchId, itemId);
    return this.db.prepare('SELECT * FROM execution_batch_items WHERE batch_id = ? AND item_id = ?').get(batchId, itemId) || null;
  }
  prepareExecutionBatchRetry(batchId) {
    const batch = this.getExecutionBatch(batchId); if (!batch) throw new Error(`execution batch not found: ${batchId}`);
    if (batch.status !== 'FAILED') return batch;
    const nextAttempt = Number(batch.attempt || 1) + 1; const ts = now();
    this.db.prepare("UPDATE execution_batches SET status='RUNNING', attempt=?, started_at=?, finished_at=NULL WHERE batch_id=?").run(nextAttempt, ts, batchId);
    this.db.prepare("UPDATE execution_batch_items SET status='PENDING', attempt=attempt+1, execution_session_id=NULL, execution_pid=NULL, exit_code=NULL, stdout='', stderr='', error=NULL, started_at=NULL, finished_at=NULL WHERE batch_id=? AND status <> 'COMPLETED'").run(batchId);
    this.recordEvent(batch.job_id, 'execution.batch.retry_started', { batchId, attempt: nextAttempt }, `${batchId}|retry|${nextAttempt}`);
    return this.getExecutionBatch(batchId);
  }
  finishExecutionBatchItem(batchId, itemId, { executionSessionId = null, executionPid = null, exitCode = null, stdout = '', stderr = '', status = 'FAILED', error = null, finishedAt = now() } = {}) {
    this.db.prepare(`UPDATE execution_batch_items SET status=?, execution_session_id=?, execution_pid=?, exit_code=?, stdout=?, stderr=?, error=?, finished_at=?
      WHERE batch_id=? AND item_id=?`).run(status, executionSessionId, executionPid, exitCode, stdout || '', stderr || '', error, finishedAt, batchId, itemId);
    return this.db.prepare('SELECT * FROM execution_batch_items WHERE batch_id = ? AND item_id = ?').get(batchId, itemId) || null;
  }
  markExecutionBatchWaiting(batchId) {
    this.db.prepare("UPDATE execution_batches SET status='WAITING' WHERE batch_id=? AND status='RUNNING'").run(batchId);
    return this.getExecutionBatch(batchId);
  }
  finishExecutionBatch(batchId, { status = null, aggregateContent = '' } = {}) {
    const items = this.listExecutionBatchItems(batchId);
    const finalStatus = status || (items.every(i => i.status === 'COMPLETED') ? 'COMPLETED' : 'FAILED');
    const ts = now();
    const batch = this.getExecutionBatch(batchId); if (!batch) throw new Error(`execution batch not found: ${batchId}`);
    this.db.prepare("UPDATE execution_batches SET status=?, finished_at=?, aggregate_content=? WHERE batch_id=?").run(finalStatus, ts, aggregateContent, batchId);
    this.recordEvent(batch.job_id, finalStatus === 'COMPLETED' ? 'execution.batch.completed' : 'execution.batch.failed', {
      batchId, status: finalStatus, itemCount: items.length, failedCount: items.filter(i => i.status !== 'COMPLETED').length
    }, `${batchId}|terminal`);
    return { ...this.getExecutionBatch(batchId), items: this.listExecutionBatchItems(batchId) };
  }
  findDeterministicTask(jobId, { role = null, command = null } = {}) {
    // Same-task recovery must be able to re-enter the deterministic executor
    // after a prior agent attempt failed. Prefer live work, then the newest
    // failed matching task; never select a terminal successful task.
    const rows = this.db.prepare("SELECT * FROM tasks WHERE job_id = ? AND status IN ('pending','running','failed','completed') ORDER BY CASE WHEN status IN ('pending','running') THEN 0 WHEN status = 'failed' THEN 1 ELSE 2 END, created_at DESC").all(jobId);
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
      const metadata = JSON.parse(task.metadata_json || '{}');
      return metadata.deterministic === true || description.includes(command) || new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(description);
    }) || null;
  }
  prepareExecution(taskId, { executionSessionId, attempt, command, cwd = null, startedAt = now(), tmuxName = null } = {}) {
    const task = this.getTask(taskId); if (!task) throw new Error(`task not found: ${taskId}`);
    const metadata = { ...(JSON.parse(task.metadata_json || '{}')), command, cwd, tmuxName };
    this.db.prepare(`UPDATE tasks SET execution_session_id = ?, execution_status = 'running', execution_attempt = ?, execution_pid = NULL,
      execution_exit_code = NULL, execution_started_at = ?, execution_finished_at = NULL, execution_stdout = '', execution_stderr = ?, metadata_json = ?, updated_at = ?
      WHERE task_id = ?`).run(executionSessionId, attempt, startedAt, '', JSON.stringify(metadata), startedAt, taskId);
    this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', NULL, ?)")
      .run(id('attempt'), taskId, startedAt);
    this.recordEvent(task.job_id, 'execution.started', { taskId, executionSessionId, attempt, command, cwd, tmuxName }, `${taskId}|execution|${attempt}`);
    return this.getTask(taskId);
  }
  setExecutionPid(taskId, pid) {
    const ts = now();
    this.db.prepare('UPDATE tasks SET execution_pid = ?, updated_at = ? WHERE task_id = ?').run(pid == null ? null : Number(pid), ts, taskId);
    return this.getTask(taskId);
  }
  finishExecution(taskId, { executionSessionId, attempt, command, exitCode = null, stdout = '', stderr = '', status = 'failed', error = null } = {}) {
    const task = this.getTask(taskId); if (!task) throw new Error(`task not found: ${taskId}`);
    const terminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(status) ? status : 'failed';
    const outcome = terminal === 'completed' && exitCode === 0 ? 'success' : 'failure';
    const ts = now();
    const evidence = [
      '[ACTUAL TOOL RESULT EVIDENCE]',
      '[ACTUAL EXECUTION EVIDENCE]',
      `task_id: ${taskId}`,
      `execution_session_id: ${executionSessionId}`,
      `attempt: ${attempt}`,
      `exact command: ${command}`,
      `exit status/code: ${exitCode == null ? 'N/A' : exitCode}`,
      `execution status: ${terminal}`,
      `stdout:\n${stdout || ''}`,
      `stderr:\n${stderr || ''}`,
      error ? `error: ${error}` : ''
    ].filter(Boolean).join('\n');
    const resultId = id('result');
    this.db.prepare('INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, ?, ?, ?)').run(resultId, taskId, outcome, evidence, ts);
    this.db.prepare(`UPDATE tasks SET execution_status = ?, execution_exit_code = ?, execution_finished_at = ?, execution_stdout = ?, execution_stderr = ?,
      status = ?, updated_at = ? WHERE task_id = ?`).run(terminal, exitCode, ts, stdout || '', stderr || '', outcome === 'success' ? 'completed' : 'failed', ts, taskId);
    const attemptStatus = terminal === 'completed' ? 'completed' : terminal === 'timeout' ? 'timeout' : 'failed';
    const existingAttempt = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id = ? AND status = 'started' AND openclaw_run_id IS NULL ORDER BY started_at DESC LIMIT 1").get(taskId);
    if (existingAttempt) this.db.prepare('UPDATE attempts SET status = ?, finished_at = ?, error = ? WHERE attempt_id = ?').run(attemptStatus, ts, error || (exitCode !== 0 ? `exit status ${exitCode}` : null), existingAttempt.attempt_id);
    else this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, started_at, finished_at, error) VALUES(?, ?, ?, ?, ?, ?)").run(id('attempt'), taskId, attemptStatus, task.execution_started_at || ts, ts, error || null);
    this.recordEvent(task.job_id, terminal === 'completed' ? 'execution.completed' : 'execution.failed', {
      taskId, executionSessionId, attempt, command, exitCode, status: terminal, resultId
    }, `${taskId}|execution-result|${attempt}`);
    return this.getTask(taskId);
  }
  getSession(sessionId) { return this.db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sessionId) || null; }
  getSessionByOpenClawKey(sessionKey) { return this.db.prepare('SELECT * FROM agent_sessions WHERE openclaw_session_key = ?').get(sessionKey) || null; }
  getSessionByTask(taskId) { return this.db.prepare('SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId) || null; }
  createAgentSession(taskId, { sessionKey, role = null, parentSessionKey = null, attempt = 1, state = 'CREATED', currentTurnId = null } = {}) {
    if (!sessionKey) throw new Error('openclaw session key is required');
    const task = this.getTask(taskId); if (!task) return null;
    const existing = this.getSessionByOpenClawKey(sessionKey);
    if (existing) return existing;
    const sessionId = id('session'); const ts = now();
    this.db.prepare(`INSERT INTO agent_sessions(
      session_id, job_id, task_id, role, openclaw_session_key, parent_session_key,
      state, current_turn_id, attempt, created_at, updated_at, last_activity_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, task.job_id, task.task_id, role || task.role || 'unknown', sessionKey,
        parentSessionKey, state, currentTurnId, Math.max(1, Number(attempt) || 1), ts, ts, ts);
    this.recordEvent(task.job_id, 'session.created', {
      sessionId, taskId: task.task_id, role: role || task.role || 'unknown', sessionKey,
      parentSessionKey, state, attempt: Math.max(1, Number(attempt) || 1)
    }, sessionId);
    return this.getSession(sessionId);
  }
  updateAgentSession(sessionId, { state, currentTurnId, heartbeat = false, attempt, parentSessionKey } = {}) {
    const existing = this.getSession(sessionId); if (!existing) return null;
    const ts = now();
    const nextState = state || existing.state;
    const nextTurn = currentTurnId === undefined ? existing.current_turn_id : currentTurnId;
    const nextAttempt = attempt === undefined ? existing.attempt : Math.max(1, Number(attempt) || 1);
    const nextParent = parentSessionKey === undefined ? existing.parent_session_key : parentSessionKey;
    this.db.prepare(`UPDATE agent_sessions
      SET state = ?, current_turn_id = ?, attempt = ?, parent_session_key = ?,
          updated_at = ?, last_activity_at = CASE WHEN ? THEN ? ELSE last_activity_at END
      WHERE session_id = ?`)
      .run(nextState, nextTurn, nextAttempt, nextParent, ts, heartbeat ? 1 : 0, ts, sessionId);
    if (state && state !== existing.state) {
      this.recordEvent(existing.job_id, 'session.state_changed', {
        sessionId, taskId: existing.task_id, from: existing.state, to: state
      }, `${sessionId}|${state}`);
    } else if (heartbeat) {
      this.recordEvent(existing.job_id, 'session.heartbeat', {
        sessionId, taskId: existing.task_id, state: nextState, currentTurnId: nextTurn
      }, `${sessionId}|${ts}`);
    }
    return this.getSession(sessionId);
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
    return this.db.prepare(`SELECT * FROM agent_sessions ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...params);
  }
  getSessionAccess(accessId) {
    return this.db.prepare('SELECT * FROM session_access WHERE access_id = ?').get(accessId) || null;
  }
  listSessionAccess(sessionId, { includeRevoked = false } = {}) {
    return this.db.prepare(`SELECT * FROM session_access WHERE session_id = ? ${includeRevoked ? '' : 'AND revoked_at IS NULL'} ORDER BY created_at`).all(sessionId);
  }
  grantSessionAccess(sessionId, { accessorRole, permission = 'OBSERVE', grantedBy = 'system', expiresAt = null } = {}) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Unknown agent session: ${sessionId}`);
    const role = String(accessorRole || '').trim();
    const perm = String(permission || '').toUpperCase();
    if (!role) throw new Error('accessorRole is required');
    if (!['OBSERVE', 'MESSAGE', 'EXECUTE', 'TAKEOVER'].includes(perm)) throw new Error(`Invalid session permission: ${perm}`);
    const existing = this.db.prepare(`SELECT * FROM session_access
      WHERE session_id = ? AND accessor_role = ? AND permission = ? AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`).get(sessionId, role, perm);
    if (existing) {
      this.db.prepare('UPDATE session_access SET granted_by = ?, expires_at = ? WHERE access_id = ?').run(grantedBy, expiresAt, existing.access_id);
      return this.getSessionAccess(existing.access_id);
    }
    const accessId = id('access'); const ts = now();
    this.db.prepare(`INSERT INTO session_access(access_id, session_id, accessor_role, permission, granted_by, expires_at, created_at, revoked_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, NULL)`).run(accessId, sessionId, role, perm, grantedBy, expiresAt, ts);
    this.recordEvent(session.job_id, 'session.access_granted', {
      accessId, sessionId, taskId: session.task_id, accessorRole: role, permission: perm, grantedBy, expiresAt
    }, accessId);
    return this.getSessionAccess(accessId);
  }
  revokeSessionAccess(accessId, { actor = 'system' } = {}) {
    const access = this.getSessionAccess(accessId); if (!access) return null;
    if (access.revoked_at) return access;
    const session = this.getSession(access.session_id); const ts = now();
    this.db.prepare('UPDATE session_access SET revoked_at = ? WHERE access_id = ? AND revoked_at IS NULL').run(ts, accessId);
    if (session) this.recordEvent(session.job_id, 'session.access_revoked', {
      accessId, sessionId: session.session_id, accessorRole: access.accessor_role, permission: access.permission, actor
    }, accessId);
    return this.getSessionAccess(accessId);
  }
  hasSessionPermission(sessionId, accessorRole, permission, { at = new Date().toISOString() } = {}) {
    const session = this.getSession(sessionId); if (!session) return false;
    const role = String(accessorRole || '').trim(); const perm = String(permission || '').toUpperCase();
    // Owner has implicit OBSERVE/MESSAGE/EXECUTE access. TAKEOVER is deliberately
    // never implicit: it changes ownership and requires an explicit grant.
    if (role === session.role && ['OBSERVE', 'MESSAGE', 'EXECUTE'].includes(perm)) return true;
    const row = this.db.prepare(`SELECT 1 FROM session_access
      WHERE session_id = ? AND accessor_role = ? AND permission = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      LIMIT 1`).get(sessionId, role, perm, at);
    return !!row;
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
    const session = this.assertSessionPermission(sessionId, actorRole, 'TAKEOVER');
    if (session.role === actorRole) throw new Error('Session owner cannot takeover its own session');
    if (!['STALE', 'FAILED', 'PAUSED'].includes(session.state)) {
      throw new Error(`Session takeover requires PAUSED, STALE, or FAILED state; got ${session.state}`);
    }
    const updated = this.updateAgentSession(sessionId, { state: 'ACTIVE', heartbeat: true });
    this.recordEvent(session.job_id, 'session.takeover', {
      sessionId, taskId: session.task_id, fromRole: session.role, actorRole, reason
    }, `${sessionId}|${actorRole}|takeover`);
    return updated;
  }
  enqueueSessionMessage(sessionId, { senderRole, recipientRole, payload = {}, messageType = 'session.message', correlationId = null, dedupeKey = null, availableAt = null } = {}) {
    const session = this.assertSessionPermission(sessionId, senderRole, 'MESSAGE');
    const recipient = String(recipientRole || '').trim();
    if (!recipient) throw new Error('recipientRole is required');
    const type = String(messageType || 'session.message').trim();
    if (!type) throw new Error('messageType is required');
    const existing = dedupeKey
      ? this.db.prepare('SELECT * FROM session_messages WHERE session_id = ? AND dedupe_key = ? LIMIT 1').get(sessionId, dedupeKey)
      : null;
    if (existing) return existing;
    const messageId = id('msg'); const ts = now();
    const envelope = createEnvelope({
      messageId,
      messageType: type,
      jobId: session.job_id,
      taskId: session.task_id || null,
      attempt: 1,
      sender: String(senderRole),
      recipient,
      correlationId,
      payload,
      createdAt: ts
    });
    validateEnvelope(envelope);
    validatePayload(type, payload);
    const readyAt = availableAt || ts;
    this.db.prepare(`INSERT INTO session_messages(
      message_id, session_id, sender_role, recipient_role, protocol, protocol_version, message_type, payload_json,
      correlation_id, dedupe_key, status, attempt, available_at, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?, ?)`)
      .run(messageId, sessionId, senderRole, recipient, envelope.protocol, envelope.version, envelope.message_type, JSON.stringify(envelope.payload), correlationId, dedupeKey, readyAt, ts, ts);
    this.recordEvent(session.job_id, 'session.message_queued', {
      messageId, sessionId, taskId: session.task_id, senderRole, recipientRole: recipient,
      messageType: type, correlationId, dedupeKey
    }, messageId);
    return this.getSessionMessage(messageId);
  }
  getSessionMessage(messageId) {
    return this.db.prepare('SELECT * FROM session_messages WHERE message_id = ?').get(messageId) || null;
  }
  listSessionMessages(sessionId, { recipientRole = null, status = null, limit = 100 } = {}) {
    const clauses = ['session_id = ?']; const params = [sessionId];
    if (recipientRole) { clauses.push('recipient_role = ?'); params.push(recipientRole); }
    if (status) { clauses.push('status = ?'); params.push(String(status).toUpperCase()); }
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return this.db.prepare(`SELECT * FROM session_messages WHERE ${clauses.join(' AND ')} ORDER BY created_at LIMIT ?`).all(...params);
  }
  claimSessionMessage(messageId, { recipientRole, leaseMs = 60_000 } = {}) {
    const message = this.getSessionMessage(messageId);
    if (!message) return null;
    this.assertSessionPermission(message.session_id, recipientRole, 'MESSAGE');
    if (message.recipient_role !== recipientRole) throw new Error(`Message recipient mismatch: expected=${message.recipient_role} got=${recipientRole}`);
    const ts = now();
    if (message.status === 'ACKED') return message;
    if (message.status === 'DELIVERED' && message.lease_until && message.lease_until > ts) return message;
    if (!['QUEUED', 'DELIVERED'].includes(message.status) || message.available_at > ts) return message;
    const leaseUntil = new Date(Date.now() + Math.max(1, Number(leaseMs) || 60_000)).toISOString();
    this.db.prepare(`UPDATE session_messages
      SET status = 'DELIVERED', attempt = attempt + 1, delivered_at = ?, lease_until = ?, updated_at = ?
      WHERE message_id = ? AND status IN ('QUEUED','DELIVERED') AND available_at <= ?`)
      .run(ts, leaseUntil, ts, messageId, ts);
    const updated = this.getSessionMessage(messageId);
    const session = this.getSession(message.session_id);
    if (session) this.recordEvent(session.job_id, 'session.message_delivered', {
      messageId, sessionId: message.session_id, recipientRole, attempt: updated.attempt, leaseUntil
    }, `${messageId}|${updated.attempt}`);
    return updated;
  }
  claimNextSessionMessage(sessionId, { recipientRole, leaseMs = 60_000 } = {}) {
    this.assertSessionPermission(sessionId, recipientRole, 'MESSAGE');
    const ts = now();
    const message = this.db.prepare(`SELECT * FROM session_messages
      WHERE session_id = ? AND recipient_role = ? AND status IN ('QUEUED','DELIVERED')
        AND available_at <= ? AND (status = 'QUEUED' OR lease_until IS NULL OR lease_until <= ?)
      ORDER BY created_at ASC LIMIT 1`).get(sessionId, recipientRole, ts, ts);
    return message ? this.claimSessionMessage(message.message_id, { recipientRole, leaseMs }) : null;
  }
  ackSessionMessage(messageId, { recipientRole, correlationId = null } = {}) {
    const message = this.getSessionMessage(messageId);
    if (!message) return null;
    this.assertSessionPermission(message.session_id, recipientRole, 'MESSAGE');
    if (message.recipient_role !== recipientRole) throw new Error(`Message recipient mismatch: expected=${message.recipient_role} got=${recipientRole}`);
    if (message.status === 'ACKED') return message;
    if (message.status !== 'DELIVERED') throw new Error(`Message cannot be ACKed from state ${message.status}`);
    const ts = now();
    this.db.prepare(`UPDATE session_messages SET status = 'ACKED', acked_at = ?, lease_until = NULL, updated_at = ? WHERE message_id = ? AND status = 'DELIVERED'`)
      .run(ts, ts, messageId);
    const updated = this.getSessionMessage(messageId);
    const session = this.getSession(message.session_id);
    if (session) this.recordEvent(session.job_id, 'session.message_acked', {
      messageId, sessionId: message.session_id, recipientRole, correlationId: correlationId || message.correlation_id
    }, messageId);
    return updated;
  }
  retrySessionMessage(messageId, { error = 'delivery lease expired', delayMs = null, maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 60_000 } = {}) {
    const message = this.getSessionMessage(messageId);
    if (!message || message.status === 'ACKED') return message;
    if (message.attempt >= Math.max(1, Number(maxAttempts) || 5)) {
      const ts = now();
      this.db.prepare("UPDATE session_messages SET status = 'FAILED', last_error = ?, lease_until = NULL, updated_at = ? WHERE message_id = ? AND status <> 'ACKED'")
        .run(error, ts, messageId);
      const session = this.getSession(message.session_id);
      if (session) this.recordEvent(session.job_id, 'session.message_failed', { messageId, sessionId: message.session_id, attempt: message.attempt, error }, `${messageId}|${message.attempt}`);
      return this.getSessionMessage(messageId);
    }
    const ts = now();
    const attempt = Math.max(1, Number(message.attempt) || 1);
    const explicitDelay = delayMs === null || delayMs === undefined ? null : Math.max(0, Number(delayMs) || 0);
    const base = Math.max(0, Number(baseDelayMs) || 0);
    const cap = Math.max(base, Number(maxDelayMs) || 60_000);
    const retryDelay = explicitDelay === null ? Math.min(cap, base * (2 ** Math.max(0, attempt - 1))) : explicitDelay;
    const availableAt = new Date(Date.now() + retryDelay).toISOString();
    this.db.prepare(`UPDATE session_messages
      SET status = 'QUEUED', available_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
      WHERE message_id = ? AND status IN ('DELIVERED','FAILED')`).run(availableAt, error, ts, messageId);
    const updated = this.getSessionMessage(messageId);
    const session = this.getSession(message.session_id);
    if (session) this.recordEvent(session.job_id, 'session.message_retry', { messageId, sessionId: message.session_id, attempt: updated.attempt, availableAt, error }, `${messageId}|${updated.attempt}|${availableAt}`);
    return updated;
  }
  retryExpiredSessionMessages({ sessionId = null, maxAttempts = 5, baseDelayMs = 0, maxDelayMs = 60_000 } = {}) {
    const ts = now();
    const rows = this.db.prepare(`SELECT message_id FROM session_messages
      WHERE status = 'DELIVERED' AND lease_until IS NOT NULL AND lease_until <= ? ${sessionId ? 'AND session_id = ?' : ''}
      ORDER BY updated_at`).all(...(sessionId ? [ts, sessionId] : [ts]));
    for (const row of rows) this.retrySessionMessage(row.message_id, { error: 'delivery lease expired', maxAttempts, baseDelayMs, maxDelayMs });
    return rows.length;
  }
  reconcileSessionDelivery({ sessionId = null, maxAttempts = 5, baseDelayMs = 0, maxDelayMs = 60_000 } = {}) {
    return this.retryExpiredSessionMessages({ sessionId, maxAttempts, baseDelayMs, maxDelayMs });
  }
  recordSessionDeliveryReceipt(messageId, { attempt, status, runId = null, sessionKey = null, response = null, error = null } = {}) {
    const message = this.getSessionMessage(messageId);
    if (!message) return null;
    const session = this.getSession(message.session_id);
    if (!session) return null;
    const receipt = { messageId, attempt: Number(attempt || message.attempt), status, runId, sessionKey, response, error, recordedAt: now() };
    this.recordEvent(session.job_id, 'session.message_receipt', receipt, `${messageId}|${receipt.attempt}|${status}`);
    return receipt;
  }
  deliverSessionMessage(messageId, transport, { maxAttempts = 5, retryDelayMs = 1000, retryMaxDelayMs = 60_000, timeoutSeconds = 120 } = {}) {
    const message = this.getSessionMessage(messageId);
    if (!message) return Promise.resolve(null);
    const session = this.getSession(message.session_id);
    if (!session) return Promise.reject(new Error(`Session not found: ${message.session_id}`));
    const recipientRole = message.recipient_role;
    const claimed = this.claimSessionMessage(messageId, { recipientRole, leaseMs: Math.max(5_000, timeoutSeconds * 1000) });
    if (!claimed || claimed.status !== 'DELIVERED') return Promise.resolve(claimed);
    return Promise.resolve().then(() => transport(session, claimed, { timeoutSeconds })).then(receipt => {
      this.recordSessionDeliveryReceipt(messageId, {
        attempt: claimed.attempt,
        status: receipt?.status || 'OK',
        runId: receipt?.runId || null,
        sessionKey: receipt?.sessionKey || session.openclaw_session_key,
        response: receipt?.result ?? receipt?.payload ?? receipt?.raw ?? null
      });
      return this.ackSessionMessage(messageId, { recipientRole });
    }).catch(error => {
      const transportCode = error?.transportCode || error?.code || 'TRANSPORT_ERROR';
      this.recordSessionDeliveryReceipt(messageId, { attempt: claimed.attempt, status: 'ERROR', sessionKey: session.openclaw_session_key, error: `${transportCode}: ${error?.message || error}` });
      return this.retrySessionMessage(messageId, {
        error: `${transportCode}: ${error?.message || error}`,
        maxAttempts,
        baseDelayMs: retryDelayMs,
        maxDelayMs: retryMaxDelayMs
      });
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
    const task = this.getTask(taskId); if (!task) throw new Error(`task not found: ${taskId}`);
    const job = this.getJob(task.job_id);
    if (!job || job.state !== 'EXECUTING') throw new Error(`task retry requires EXECUTING job: ${task.job_id}`);
    const session = this.getSessionByTask(taskId);
    if (!session) throw new Error(`agent session not found for task: ${taskId}`);
    this.assertSessionPermission(session.session_id, actorRole, 'TAKEOVER');
    if (!['STALE', 'FAILED', 'PAUSED'].includes(session.state)) {
      throw new Error(`same-task retry requires STALE, FAILED, or PAUSED session; got ${session.state}`);
    }
    const nextAttempt = Math.max(1, Number(task.execution_attempt || session.attempt || 0) + 1);
    const ts = now();
    this.takeoverAgentSession(session.session_id, { actorRole, reason });
    this.db.prepare("UPDATE agent_sessions SET attempt = ?, updated_at = ?, last_activity_at = ? WHERE session_id = ?")
      .run(nextAttempt, ts, ts, session.session_id);
    this.db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE task_id = ? AND status IN ('failed','pending','running')")
      .run(ts, taskId);
    const attemptId = id('attempt');
    this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', ?, ?)")
      .run(attemptId, taskId, task.openclaw_run_id || null, ts);
    this.recordEvent(task.job_id, 'task.retry_started', {
      taskId, sessionId: session.session_id, actorRole, attempt: nextAttempt, attemptId, reason
    }, `${taskId}|retry|${nextAttempt}`);
    return {
      task: this.getTask(taskId),
      session: this.getSession(session.session_id),
      attempt: nextAttempt,
      attemptRecord: this.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId)
    };
  }
  createChildTask(jobId, { parentTaskId = null, role = 'unknown', description, dependencies = [], metadata = {} } = {}) {
    if (!description) throw new Error('child task description is required');
    const existing = this.db.prepare("SELECT * FROM tasks WHERE job_id = ? AND parent_task_id = ? AND role = ? AND description = ? AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1").get(jobId, parentTaskId, role, description);
    if (existing) return existing;
    const job = this.getJob(jobId);
    const normalizedRole = String(role).toLowerCase();
    const supportedWorkflow = isSupportedWorkflow(job);
    const plan = supportedWorkflow ? this.getExecutionPlan(jobId) : null;
    if (supportedWorkflow && !plan) {
      throw new Error('immutable execution plan missing before production task creation: ' + jobId);
    }
    const plannedTask = plan?.children?.find(item => String(item.role).toLowerCase() === normalizedRole) || null;
    if (supportedWorkflow && !plannedTask && String(role).toLowerCase() !== 'cto') {
      throw new Error('workflow role is absent from immutable execution plan: ' + normalizedRole);
    }
    const productionTask = plannedTask || null;
    const productionExecution = productionTask?.execution || null;
    const durableMetadata = productionExecution ? { ...productionExecution, ...metadata } : metadata;
    const taskId = id('task'); const ts = now();
    this.db.prepare("INSERT INTO tasks(task_id, job_id, role, description, status, parent_task_id, dependency_json, metadata_json, created_at, updated_at) VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)").run(taskId, jobId, role, description, parentTaskId, JSON.stringify(dependencies), JSON.stringify(durableMetadata), ts, ts);
    this.recordEvent(jobId, 'task.created', { taskId, parentTaskId, role, description, dependencies }, taskId);
    return this.getTask(taskId);
  }
  attachTaskRuntime(taskId, { runId = null, sessionKey = null } = {}) {
    const task = this.getTask(taskId); if (!task) return null; const ts = now();
    if (sessionKey) {
      const existingSession = this.getSessionByOpenClawKey(sessionKey);
      if (existingSession && existingSession.task_id !== taskId) {
        throw new Error(`OpenClaw session ${sessionKey} already belongs to task ${existingSession.task_id}`);
      }
      if (existingSession) {
        this.updateAgentSession(existingSession.session_id, { state: 'ACTIVE', heartbeat: true });
      } else {
        this.createAgentSession(taskId, {
          sessionKey,
          role: task.role,
          state: 'ACTIVE',
          attempt: 1
        });
      }
    }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      this.db.prepare('UPDATE tasks SET openclaw_run_id = ?, openclaw_session_key = ?, updated_at = ? WHERE task_id = ?').run(runId || task.openclaw_run_id || null, sessionKey || task.openclaw_session_key || null, ts, taskId);
      return this.getTask(taskId);
    }
    this.db.prepare('UPDATE tasks SET openclaw_run_id = ?, openclaw_session_key = ?, status = ?, updated_at = ? WHERE task_id = ?').run(runId || null, sessionKey || null, 'running', ts, taskId);
    this.recordEvent(task.job_id, 'task.runtime_attached', { taskId, runId, sessionKey }, runId || sessionKey || taskId);
    return this.getTask(taskId);
  }
  rearmTaskRuntime(taskId, { runId = null, sessionKey = null } = {}) {
    const task = this.getTask(taskId); if (!task) return null;
    const ts = now();
    this.db.prepare("UPDATE tasks SET status='running', openclaw_run_id=?, openclaw_session_key=?, updated_at=? WHERE task_id=?").run(runId || task.openclaw_run_id || null, sessionKey || task.openclaw_session_key || null, ts, taskId);
    const failedAttempt = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='failed' ORDER BY started_at DESC LIMIT 1").get(taskId);
    if (failedAttempt) this.db.prepare("UPDATE attempts SET status='started', openclaw_run_id=?, finished_at=NULL WHERE attempt_id=?").run(runId || task.openclaw_run_id || null, failedAttempt.attempt_id);
    else this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', ?, ?)").run(id('attempt'), taskId, runId || task.openclaw_run_id || null, ts);
    this.recordEvent(task.job_id, 'task.runtime_rearmed', { taskId, runId, sessionKey }, `${taskId}|rearm|${runId || sessionKey || ts}`);
    return this.getTask(taskId);
  }
  beginRuntimeAttempt(taskId, { runId = null, sessionKey = null, reason = 'runtime retry' } = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const ts = now();
    const active = this.db.prepare("SELECT attempt_id FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC LIMIT 1").get(taskId);
    if (active) throw new Error(`task already has active runtime attempt: ${taskId}`);
    const attemptId = id('attempt');
    this.db.prepare("UPDATE tasks SET status='running', openclaw_run_id=?, openclaw_session_key=?, updated_at=? WHERE task_id=?")
      .run(runId, sessionKey, ts, taskId);
    this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', ?, ?)")
      .run(attemptId, taskId, runId, ts);
    this.recordEvent(task.job_id, 'attempt.started', {
      attemptId, taskId, openclawRunId: runId, sessionKey, reason
    }, attemptId);
    return this.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attemptId);
  }
  completeActiveAttempt(taskId, { reason = 'runtime phase completed' } = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const active = this.db.prepare("SELECT * FROM attempts WHERE task_id=? AND status='started' ORDER BY started_at DESC LIMIT 1").get(taskId);
    if (!active) return null;
    const ts = now();
    this.db.prepare("UPDATE attempts SET status='completed', finished_at=? WHERE attempt_id=?").run(ts, active.attempt_id);
    this.recordEvent(task.job_id, 'attempt.completed', { attemptId: active.attempt_id, taskId, reason }, active.attempt_id + '|completed');
    return this.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(active.attempt_id);
  }
  recordSpawn(jobId, { parentTaskId = null, role = 'unknown', description, runId = null, sessionKey = null, dependencies = [], metadata = {} } = {}) {
    const task = this.createChildTask(jobId, { parentTaskId, role, description, dependencies, metadata });
    this.attachTaskRuntime(task.task_id, { runId, sessionKey });
    const existingAttempt = this.db.prepare("SELECT * FROM attempts WHERE task_id = ? AND status = 'started' ORDER BY started_at DESC LIMIT 1").get(task.task_id);
    if (!existingAttempt) {
      const attemptId = id('attempt'); const ts = now();
      this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', ?, ?)").run(attemptId, task.task_id, runId || null, ts);
      this.recordEvent(jobId, 'attempt.started', { attemptId, taskId: task.task_id, openclawRunId: runId }, attemptId);
    }
    return this.getTask(task.task_id);
  }
  completeTaskByRuntime(jobId, { runId = null, sessionKey = null, content = '', outcome = 'success' } = {}) {
    let task = runId ? this.db.prepare('SELECT * FROM tasks WHERE job_id = ? AND openclaw_run_id = ? ORDER BY updated_at DESC LIMIT 1').get(jobId, runId) : null;
    if (!task && sessionKey) task = this.db.prepare('SELECT * FROM tasks WHERE job_id = ? AND openclaw_session_key = ? ORDER BY updated_at DESC LIMIT 1').get(jobId, sessionKey);
    if (!task) return null;
    if (['completed','failed','cancelled'].includes(task.status)) return task;
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
      const hasActualChildOutput = Boolean(promptData) && promptData.toLowerCase() !== '(no output)';
      const refusal = /\b(cannot|unable|no native|no exec|not available|could not)\b|không thể|không có (?:native|exec)|không khả dụng|không cung cấp được/i.test(text);
      const expectedCommand = String(task.description || '').match(/Run (?:the )?exact command(?: immediately)?:\s*(node\s+--check\s+[^\n]+?)(?:\.|$)/i)?.[1]?.trim() || null;
      const normalizeCommand = command => String(command || '').trim().replace(/^node --check ~\/work\/chatgpt-adapter\//i, 'node --check /home/long/work/chatgpt-adapter/');
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
    const engineeringWorkflow = String(this.getExecutionPlan(jobId)?.workflow_id || '').toLowerCase() === 'engineering';
    if (outcome === 'success' && engineeringWorkflow) {
      const metadata = (() => {
        try { return JSON.parse(task.metadata_json || '{}'); } catch (_) { return {}; }
      })();
      const deterministic = metadata.executor === 'ExecutionManager' || metadata.deterministic === true;
      const text = String(content || '').trim();
      const adapterTimeout = '⚠️ Xin lỗi, hệ thống chưa nhận được phản hồi từ nguồn AI';
      if (deterministic) {
        const refreshed = this.getTask(task.task_id);
        const hasExecution = Boolean(
          refreshed?.execution_session_id
          && refreshed?.execution_status === 'completed'
          && Number(refreshed?.execution_exit_code) === 0
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
    }
    const resultId = id('result'); const ts = now();
    this.db.prepare('INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, ?, ?, ?)').run(resultId, task.task_id, outcome, content || '', ts);
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run(outcome === 'success' ? 'completed' : 'failed', ts, task.task_id);
    this.db.prepare("UPDATE attempts SET status = ?, finished_at = ? WHERE task_id = ? AND status = 'started'").run(outcome === 'success' ? 'completed' : 'failed', ts, task.task_id);
    this.recordEvent(jobId, outcome === 'success' ? 'task.completed' : 'task.failed', { taskId: task.task_id, resultId, runId, sessionKey, outcome }, `${task.task_id}|${outcome}|${resultId}`);
    // Runtime task completion is not business-job completion. The Coordinator/CTO
    // must explicitly complete the durable Job after synthesis and DoD checks.
    return this.getTask(task.task_id);
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
  claimSlackProjection(eventId, jobId, { channel = 'slack', target = 'C0C3RJKNKPG', messageId = null } = {}) {
    const ts = now();
    const result = this.db.prepare('INSERT OR IGNORE INTO slack_projections(event_id, job_id, channel, target, message_id, projected_at) VALUES(?, ?, ?, ?, ?, ?)').run(eventId, jobId, channel, target, messageId, ts);
    return result.changes === 1;
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
    const base = "SELECT e.* FROM events e LEFT JOIN slack_projections p ON p.event_id = e.event_id WHERE p.event_id IS NULL AND e.type IN " + relevant;
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
  approve(jobId, rawText, actor = 'boss') {
    const job = this.getJob(jobId);
    if (!job) throw new Error('job not found: ' + jobId);
    const approvalId = id('approval'); const ts = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO approvals(approval_id, job_id, decision, actor, raw_text, created_at) VALUES(?, ?, 'approved', ?, ?, ?)").run(approvalId, jobId, actor, rawText, ts);
      this.db.prepare('UPDATE jobs SET state = ?, approved_at = ?, updated_at = ? WHERE job_id = ?').run('APPROVED', ts, ts, jobId);
      const runtime = this.getWorkflowRuntimeState(jobId);
      if (runtime?.phase === 'PROPOSED') this.transitionWorkflowPhase(jobId, 'APPROVED', { event: 'workflow.approved', payload: { actor } });
      this.recordEvent(jobId, 'approval.approved', { actor, rawText }, hash(rawText));
      if (isSupportedWorkflow(this.getJob(jobId))) this.compileExecutionPlan(jobId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getJob(jobId);
  }
  dispatch(jobId, { role = 'cto', description }) {
    const task = this.ensureTask(jobId, { role, description }); const ts = now();
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run('running', ts, task.task_id);
    this.db.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE job_id = ?').run('EXECUTING', ts, jobId);
    const runtime = this.getWorkflowRuntimeState(jobId);
    if (runtime?.phase === 'APPROVED') this.transitionWorkflowPhase(jobId, 'SPAWN_CTO', { event: 'workflow.cto_spawn_required', payload: { taskId: task.task_id } });
    this.recordEvent(jobId, 'task.dispatched', { taskId: task.task_id, role, description }, task.task_id);
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(task.task_id);
  }
  startAttempt(jobId, { openclawRunId = null } = {}) {
    const job = this.getJob(jobId);
    if (!job?.active_task_id) return null;
    const existing = this.db.prepare("SELECT * FROM attempts WHERE task_id = ? AND status IN ('started') ORDER BY started_at DESC LIMIT 1").get(job.active_task_id);
    if (existing) return existing;
    const attemptId = id('attempt'); const ts = now();
    this.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', ?, ?)").run(attemptId, job.active_task_id, openclawRunId, ts);
    this.recordEvent(jobId, 'attempt.started', { attemptId, taskId: job.active_task_id, openclawRunId }, attemptId);
    return this.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
  }
  attachOpenClawRun(jobId, { runId, sessionKey }) {
    const job = this.getJob(jobId); if (!job?.active_task_id) return null; const ts = now();
    this.db.prepare('UPDATE tasks SET openclaw_run_id = ?, openclaw_session_key = ?, updated_at = ? WHERE task_id = ?').run(runId || null, sessionKey || null, ts, job.active_task_id);
    this.db.prepare("UPDATE attempts SET openclaw_run_id = ? WHERE attempt_id = (SELECT attempt_id FROM attempts WHERE task_id = ? AND status = 'started' ORDER BY started_at DESC LIMIT 1)").run(runId || null, job.active_task_id);
    if (sessionKey) {
      const existingSession = this.getSessionByOpenClawKey(sessionKey);
      if (existingSession && existingSession.task_id !== job.active_task_id) {
        throw new Error(`OpenClaw session ${sessionKey} already belongs to task ${existingSession.task_id}`);
      }
      if (existingSession) {
        this.updateAgentSession(existingSession.session_id, { state: 'ACTIVE', heartbeat: true });
      } else {
        const task = this.getTask(job.active_task_id);
        this.createAgentSession(job.active_task_id, { sessionKey, role: task?.role, state: 'ACTIVE' });
      }
    }
    this.recordEvent(jobId, 'task.runtime_attached', { runId, sessionKey }, runId || sessionKey || job.active_task_id);
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(job.active_task_id);
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
    const terminalTasks = this.db.prepare("SELECT t.task_id, r.outcome FROM tasks t JOIN (SELECT task_id, outcome, MAX(created_at) AS created_at FROM results GROUP BY task_id) r ON r.task_id = t.task_id WHERE t.job_id = ? AND t.status = 'running' AND r.outcome IN ('success', 'failure')").all(jobId);
    for (const row of terminalTasks) {
      const terminalStatus = row.outcome === 'success' ? 'completed' : 'failed';
      this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ? AND status = 'running'").run(terminalStatus, now(), row.task_id);
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
        try { args = typeof call?.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : (call?.arguments || {}); } catch (_) {}
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
            ORDER BY created_at ASC LIMIT 1
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
    const job = this.getJob(jobId); if (!job) return null; const taskId = job.active_task_id; const resultId = id('result'); const ts = now();
    // Late OpenClaw/runtime completions must never overwrite a newer terminal
    // Job result. The Job is the durable authority; stale child events are
    // recorded by their own reconciliation paths but cannot reopen/fail it.
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase())) return { ...job, idempotent: true };
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
        const childResults = childRows.map(t => this.db.prepare('SELECT outcome, content FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(t.task_id));
        const childEvidenceValid = requiredRoles.every(role => {
          const child = childRows.find(t => String(t.role).toLowerCase() === role);
          const result = child ? this.db.prepare('SELECT outcome, content FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(child.task_id) : null;
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
      this.transition(jobId, outcome === 'success' ? 'COMPLETED' : 'IDLE', outcome === 'success' ? 'completed' : 'failed');
      return this.getJob(jobId);
    }
    if (taskId) {
      this.db.prepare('INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, ?, ?, ?)').run(resultId, taskId, outcome, content || '', ts);
      this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run(outcome === 'success' ? 'completed' : 'failed', ts, taskId);
      this.db.prepare("UPDATE attempts SET status = ?, finished_at = ? WHERE task_id = ? AND status = 'started'").run(outcome === 'success' ? 'completed' : 'failed', ts, taskId);
    }
    this.transition(jobId, outcome === 'success' ? 'COMPLETED' : 'IDLE', outcome === 'success' ? 'completed' : 'failed');
    this.recordEvent(jobId, outcome === 'success' ? 'task.completed' : 'task.failed', { taskId, resultId, outcome }, completionKey);
    return this.getJob(jobId);
  }
  repairResultEvidence(taskId, content) {
    if (!taskId || !content || !/\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(content)) return false;
    const task = this.getTask(taskId);
    if (!task) return false;
    const row = this.db.prepare('SELECT result_id, outcome, content FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId);
    if (row && row.outcome === 'success' && /\[ACTUAL EXECUTION EVIDENCE\]/i.test(row.content || '')) return false;
    const resultId = id('result');
    this.db.prepare("INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, 'success', ?, ?)").run(resultId, taskId, content, now());
    this.recordEvent(task.job_id, 'result.evidence_repaired', { taskId, resultId, supersedesResultId: row?.result_id || null }, taskId + '|evidence-repaired|' + resultId);
    return true;
  }
  reconcileFailedTaskByRuntime(taskId, { content, runId = null, sessionKey = null } = {}) {
    if (!taskId || !content || !/\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(content)) return null;
    const task = this.getTask(taskId);
    if (!task || task.status !== 'failed') return null;
    const ts = now();
    const resultId = id('result');
    const previous = this.db.prepare('SELECT result_id FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO results(result_id, task_id, outcome, content, created_at) VALUES(?, ?, 'success', ?, ?)")
        .run(resultId, taskId, content, ts);
      this.db.prepare("UPDATE tasks SET status = 'completed', openclaw_run_id = COALESCE(?, openclaw_run_id), openclaw_session_key = COALESCE(?, openclaw_session_key), updated_at = ? WHERE task_id = ? AND status = 'failed'")
        .run(runId, sessionKey, ts, taskId);
      this.db.prepare("UPDATE attempts SET status = 'completed', finished_at = ? WHERE task_id = ? AND status = 'failed' AND attempt_id = (SELECT attempt_id FROM attempts WHERE task_id = ? AND status = 'failed' ORDER BY started_at DESC LIMIT 1)")
        .run(ts, taskId, taskId);
      this.recordEvent(task.job_id, 'result.evidence_repaired', {
        taskId, resultId, supersedesResultId: previous?.result_id || null
      }, taskId + '|runtime-repaired|' + resultId);
      this.recordEvent(task.job_id, 'task.runtime_reconciled', {
        taskId, runId, sessionKey, outcome: 'success'
      }, taskId + '|runtime-reconciled|success');
      this.db.exec('COMMIT');
      return this.getTask(taskId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  replaceResultEvidence(taskId, content, expectedCommand) {
    if (!taskId || !content || !/\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(content)) return false;
    const row = this.db.prepare('SELECT result_id, content FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId);
    if (!row) return false;
    const markerSection = String(row.content || '').split(/\[ACTUAL TOOL RESULT EVIDENCE\]/i).slice(1).join('\n');
    if (expectedCommand && markerSection.includes(expectedCommand) && /exit status(?:\/code)?:\s*0/i.test(markerSection) && /<prompt-data>[\s\S]*?<\/prompt-data>/i.test(markerSection)) return false;
    this.db.prepare('UPDATE results SET content = ? WHERE result_id = ?').run(content, row.result_id);
    const task = this.getTask(taskId);
    if (task) this.recordEvent(task.job_id, 'result.evidence_replaced', { taskId, resultId: row.result_id, expectedCommand }, `${row.result_id}|evidence-replaced|${expectedCommand || ''}`);
    return true;
  }
  createReport(jobId, kind, content) {
    const dedupe = hash(`${kind}|${content || ''}`);
    const existing = this.db.prepare('SELECT report_id FROM reports WHERE job_id = ? AND kind = ? AND content = ? LIMIT 1').get(jobId, kind, content || '');
    if (existing) return existing.report_id;
    const reportId = id('report'); const ts = now();
    this.db.prepare('INSERT INTO reports(report_id, job_id, kind, content, created_at) VALUES(?, ?, ?, ?, ?)').run(reportId, jobId, kind, content || '', ts);
    this.recordEvent(jobId, 'report.created', { reportId, kind }, reportId); return reportId;
  }
  terminalizeJob(jobId, { outcome = 'success', reportId = null, deliveryChannel = null, deliveryTarget = null, content = '' } = {}) {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase());
    if (terminal) return { job: this.getJob(jobId), idempotent: true };
    if (job.state !== 'EXECUTING') throw new Error(`cannot terminalize job from state=${job.state}`);

    const openTasks = this.db.prepare("SELECT task_id, role, status FROM tasks WHERE job_id=? AND status IN ('pending','running')").all(jobId);
    if (openTasks.length) throw new Error(`cannot terminalize with open tasks: ${openTasks.map(t => t.task_id).join(',')}`);

    const report = reportId
      ? this.db.prepare('SELECT * FROM reports WHERE report_id=? AND job_id=?').get(reportId, jobId)
      : this.db.prepare('SELECT * FROM reports WHERE job_id=? ORDER BY created_at DESC LIMIT 1').get(jobId);
    if (!report) throw new Error('cannot terminalize without durable report');

    if (outcome === 'success') {
      const failedTasks = this.db.prepare("SELECT task_id, role FROM tasks WHERE job_id=? AND status IN ('failed','cancelled')").all(jobId);
      if (failedTasks.length) throw new Error(`cannot terminalize success with failed tasks: ${failedTasks.map(t => t.task_id).join(',')}`);
      const activeTask = job.active_task_id ? this.getTask(job.active_task_id) : null;
      if (activeTask?.role === 'cto' && isSupportedWorkflow(job)) {
        const plan = this.getExecutionPlan(jobId);
        const requiredRoles = (plan?.children || []).map(item => String(item.role).toLowerCase());
        const children = this.db.prepare('SELECT task_id, role, status FROM tasks WHERE parent_task_id=?').all(activeTask.task_id);
        const missing = requiredRoles.filter(role => !children.some(t => String(t.role).toLowerCase() === role));
        if (missing.length) throw new Error(`cannot terminalize: missing required specialist children: ${missing.join(',')}`);
        for (const role of requiredRoles) {
          const child = children.find(t => String(t.role).toLowerCase() === role);
          const durableTask = this.getTask(child.task_id);
          const metadata = JSON.parse(durableTask?.metadata_json || '{}');
          const requiresExecutionEvidence = metadata.executor === 'ExecutionManager' || metadata.deterministic === true;
          const hasStructuredExecution = Boolean(
            durableTask?.execution_session_id
            && durableTask?.execution_status === 'completed'
            && Number(durableTask?.execution_exit_code) === 0
          );
          const result = this.db.prepare('SELECT content FROM results WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(durableTask.task_id);
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

    const finalState = outcome === 'success' ? 'COMPLETED' : 'IDLE';
    const finalStatus = outcome === 'success' ? 'completed' : 'failed';
    const ts = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getJob(jobId);
      if (current.state !== 'EXECUTING') { this.db.exec('COMMIT'); return { job: current, idempotent: true }; }
      this.db.prepare('UPDATE jobs SET state=?, status=?, completed_at=?, updated_at=?, provider_waiting=0, provider_retry_at=NULL WHERE job_id=? AND state=\'EXECUTING\'')
        .run(finalState, finalStatus, ts, ts, jobId);
      this.recordEvent(jobId, outcome === 'success' ? 'job.completed' : 'job.failed', {
        reportId: report.report_id, outcome, deliveryChannel, deliveryTarget, content: String(content || '').slice(0, 1000)
      }, `${report.report_id}|terminal|${outcome}`);
      this.db.exec('COMMIT');
      return { job: this.getJob(jobId), idempotent: false };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  claimDelivery(jobId, reportId, channel, target) {
    const key = hash(`${reportId}|${channel}|${target}`);
    const existing = this.db.prepare('SELECT event_id FROM events WHERE event_id = ?').get(eventId(jobId, 'delivery.claimed', key));
    if (existing) return false;
    this.recordEvent(jobId, 'delivery.claimed', { reportId, channel, target }, key);
    return true;
  }
  reconcileStaleAttempts(maxAgeMs = 15 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.db.prepare("SELECT a.*, t.job_id FROM attempts a JOIN tasks t ON t.task_id = a.task_id WHERE a.status = 'started' AND a.started_at < ?").all(cutoff);
    for (const row of rows) {
      const job = this.getJob(row.job_id);
      if (!job || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(job.state || '').toUpperCase())) continue;
      const ts = now();
      this.db.prepare("UPDATE attempts SET status = 'timeout', finished_at = ?, error = ? WHERE attempt_id = ? AND status = 'started'").run(ts, 'stale attempt recovered by reconciler', row.attempt_id);
      this.recordEvent(row.job_id, 'attempt.timeout', { attemptId: row.attempt_id, taskId: row.task_id }, row.attempt_id);
      const isProductionE2E = isProductionWorkflow(job);
      if (isProductionE2E && String(job.state || '').toUpperCase() === 'EXECUTING') {
        // Provider/runtime timeout is recoverable workflow state. RecoveryManager
        // owns WAIT/RESUME and must preserve the same durable task/session.
        this.db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE task_id = ?").run(ts, row.task_id);
        this.recordEvent(row.job_id, 'task.timeout_recoverable', {
          taskId: row.task_id,
          attemptId: row.attempt_id,
          reason: 'production-e2e stale attempt; preserve EXECUTING for runtime recovery'
        }, row.attempt_id + '|recoverable');
        continue;
      }
      this.db.prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE task_id = ? AND status = 'running'").run(ts, row.task_id);
      this.transition(row.job_id, 'IDLE', 'failed');
    }
    return rows.length;
  }
  getStats() {
    return {
      jobs: this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count,
      activeJobs: this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'active'").get().count,
      events: this.db.prepare('SELECT COUNT(*) AS count FROM events').get().count,
      tasks: this.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count
    };
  }
  getObservability() {
    const stats = this.getStats();
    const byState = this.db.prepare('SELECT state, status, COUNT(*) AS count FROM jobs GROUP BY state, status ORDER BY state').all();
    const taskStates = this.db.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY status').all();
    const attempts = this.db.prepare('SELECT status, COUNT(*) AS count FROM attempts GROUP BY status ORDER BY status').all();
    const recentEvents = this.db.prepare('SELECT event_id, job_id, type, payload_json, created_at FROM events ORDER BY created_at DESC LIMIT 50').all();
    return { dbPath: DB_PATH, stats, byState, taskStates, attempts, recentEvents };
  }
  getJobTrace(jobId) {
    const job = this.getJob(jobId);
    if (!job) return null;
    const tasks = this.db.prepare('SELECT * FROM tasks WHERE job_id = ? ORDER BY created_at').all(jobId);
    const taskIds = tasks.map(t => t.task_id);
    const attempts = taskIds.length ? this.db.prepare(`SELECT * FROM attempts WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY started_at`).all(...taskIds) : [];
    const results = taskIds.length ? this.db.prepare(`SELECT * FROM results WHERE task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY created_at`).all(...taskIds) : [];
    const approvals = this.db.prepare('SELECT * FROM approvals WHERE job_id = ? ORDER BY created_at').all(jobId);
    const reports = this.db.prepare('SELECT report_id, kind, content, delivered_at, created_at FROM reports WHERE job_id = ? ORDER BY created_at').all(jobId);
    const events = this.db.prepare('SELECT event_id, type, payload_json, created_at FROM events WHERE job_id = ? ORDER BY created_at').all(jobId);
    const sessions = this.db.prepare('SELECT * FROM agent_sessions WHERE job_id = ? ORDER BY created_at').all(jobId);
    const sessionIds = sessions.map(s => s.session_id);
    const sessionMessages = sessionIds.length
      ? this.db.prepare(`SELECT * FROM session_messages WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY created_at`).all(...sessionIds)
      : [];
    return { job, tasks, attempts, approvals, results, reports, events, sessions, sessionMessages };
  }
  listActiveJobs(limit = 50) {
    return this.db.prepare("SELECT job_id, title, state, status, active_task_id, created_at, updated_at FROM jobs WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?").all(Math.min(Math.max(Number(limit) || 50, 1), 200));
  }
  listProjectableJobs(limit = 50) {
    return this.db.prepare("SELECT j.job_id, j.title, j.state, j.status, j.active_task_id, j.created_at, j.updated_at FROM jobs j JOIN workflow_runtime_state r ON r.job_id = j.job_id WHERE j.status = 'completed' AND r.phase IN ('TERMINALIZE', 'PROJECT') ORDER BY j.updated_at DESC LIMIT ?").all(Math.min(Math.max(Number(limit) || 50, 1), 200));
  }
}

export const workflowStore = new WorkflowStore();
export const WORKFLOW_DB_PATH = DB_PATH;
