#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectStoredWorkflowPolicyRow } from '../src/runtime/workflow/policy-contract.js';

function defaultDataDirectory(homeDir) {
  const current = path.join(homeDir, '.runalith', 'agent-orchestrator');
  const legacy = path.join(homeDir, '.chat-on-steroids', 'agent-orchestrator');
  return fs.existsSync(legacy) && !fs.existsSync(current) ? legacy : current;
}
const DEFAULT_DATA_DIR = path.resolve(process.env.RUNALITH_DATA_DIR || process.env.CHAT_ON_STEROIDS_DATA_DIR || process.env.WORKFLOW_DATA_DIR || defaultDataDirectory(os.homedir()));
const DEFAULT_DB_PATH = path.resolve(process.env.RUNALITH_WORKFLOW_DB || process.env.CHAT_ON_STEROIDS_WORKFLOW_DB || process.env.WORKFLOW_DB || path.join(DEFAULT_DATA_DIR, 'workflow.db'));
const MAX_LIST = 200;
const MAX_PREVIEW_CHARS = 48_000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_URL_BYTES = 4096;
const MAX_JSON_RESPONSE_BYTES = 1_500_000;
const SAFE_TEXT_EXTENSIONS = new Set(['.log', '.txt', '.md', '.json', '.jsonl', '.ndjson', '.out', '.err', '.stdout', '.stderr', '.csv', '.yaml', '.yml', '.toml']);
const FORBIDDEN_FILE_RE = /(?:\.db(?:-(?:wal|shm))?|\.sqlite(?:-\w+)?|\.sqlite3?|\.mcpb|\.exe|\.dll|\.so(?:\.\d+)*|\.dylib|\.bin|\.wasm|\.zip|\.gz|\.tar|\.png|\.jpe?g|\.gif|\.webp|\.pdf)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function redactSensitiveText(value, { redactLocalSkillPaths = true } = {}) {
  const redacted = String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/(["']?)(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\1(\s*[:=]\s*)(["']?)([^\s"'&,;]{6,})(["']?)/gi,
      (_match, quote, key, separator, valueQuote, _value, endQuote) => `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${endQuote}`)
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, '-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----');
  if (!redactLocalSkillPaths) return redacted;
  return redacted.replace(/(^|[\s"'`=()\[\]{}:,])((?:\/(?!\/)[^\s"'`<>()[\]{};,]+|[A-Za-z]:[\\/][^\s"'`<>()[\]{};,]+|\\\\[^\s"'`<>()[\]{};,]+))/g, (match, prefix, candidate) => {
    const normalized = candidate.replace(/[.,:!?]+$/, '');
    return /(?:^|[\\/])(?:\.agents|skills?(?:\.[\w-]+)?|[^\\/]*-skills?)(?:[\\/]|$)/i.test(normalized)
      ? `${prefix}[LOCAL SKILL PATH REDACTED]${candidate.slice(normalized.length)}`
      : match;
  });
}
function boundedText(value, max = 8_000) {
  if (value == null) return '';
  const text = redactSensitiveText(value);
  return text.length > max ? text.slice(0, max) : text;
}
function parseJson(value, max = 24_000, options = {}) {
  if (typeof value !== 'string' || !value) return { value: null, malformed: false, truncated: false };
  const safe = redactSensitiveText(value, options);
  if (safe.length > max) return { value: safe.slice(0, max), malformed: true, truncated: true };
  try { return { value: JSON.parse(safe), malformed: false, truncated: false }; }
  catch { return { value: safe.slice(0, max), malformed: true, truncated: safe.length > max }; }
}
function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function onlyLoopback(host) { return host === '127.0.0.1' || host === '::1'; }
function resolveDataDir(value) {
  const root = path.resolve(value || DEFAULT_DATA_DIR);
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory()) throw new Error('data root is not a directory');
  return real;
}
function isWithin(root, candidate) { return candidate === root || candidate.startsWith(root + path.sep); }
function noStoreHeaders() {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  };
}
function sendJson(res, status, payload) {
  let body = JSON.stringify(payload);
  let responseStatus = status;
  if (Buffer.byteLength(body) > MAX_JSON_RESPONSE_BYTES) {
    responseStatus = 413;
    body = JSON.stringify({error:'response exceeds dashboard size limit',limit_bytes:MAX_JSON_RESPONSE_BYTES});
  }
  res.writeHead(responseStatus, { ...noStoreHeaders(), 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function queryRows(db, sql, params = []) { return db.prepare(sql).all(...params); }
function queryOne(db, sql, params = []) { return db.prepare(sql).get(...params) || null; }
function dbHasTable(db, name) {
  return Boolean(queryOne(db, "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", [name]));
}
function tableCount(db, table) {
  if (!dbHasTable(db, table)) return 0;
  return Number(queryOne(db, `SELECT count(*) AS n FROM ${table}`)?.n || 0);
}
function mapEvent(row) {
  const payload = parseJson(row.payload_json, 10_000);
  return { event_id: row.event_id || row.workflow_event_id, source: row.source || 'event', job_id: row.job_id, type: row.type || row.event, from_phase: row.from_phase ?? null, to_phase: row.to_phase ?? null, attempt: row.attempt ?? null, created_at: row.created_at, payload: payload.value, payload_malformed: payload.malformed, payload_truncated: payload.truncated || Number(row.payload_size || 0) > 10_000 };
}
function mapArtifact(row, includeContent = false) {
  const metadata = parseJson(row.metadata_json, 4_000);
  const evidence = parseJson(row.evidence_json, 8_000);
  const producerMetadata = parseJson(row.producer_task_metadata_json, 4_000).value;
  const producerRoleIdCandidate = typeof row.producer_custom_role_id === 'string' ? row.producer_custom_role_id : producerMetadata?.custom_role_id;
  const producerRoleId = typeof producerRoleIdCandidate === 'string' && producerRoleIdCandidate.length <= 80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(producerRoleIdCandidate)
    ? producerRoleIdCandidate : null;
  const producerRoleVersionCandidate = row.producer_custom_role_version ?? producerMetadata?.custom_role_version;
  const parsedProducerRoleVersion = Number(producerRoleVersionCandidate);
  const producerRoleVersion = Number.isSafeInteger(parsedProducerRoleVersion) && parsedProducerRoleVersion >= 1 ? parsedProducerRoleVersion : null;
  const producerRoleName = row.producer_custom_role_name || producerMetadata?.custom_role_name;
  const customRole = producerRoleId && producerRoleVersion !== null
    ? `${boundedText(producerRoleName || producerRoleId, 120)} (${producerRoleId}@${producerRoleVersion})`
    : null;
  const content = boundedText(row.content, MAX_PREVIEW_CHARS);
  const out = {
    artifact_id: row.artifact_id, job_id: row.job_id, task_id: row.task_id, type: row.kind, producer_role: customRole || row.producer_role,
    status: row.status, schema_version: row.schema_version, uri: boundedText(row.uri, 1_000), metadata: metadata.value,
    evidence: evidence.value, content_hash: row.content_hash, supersedes: row.supersedes, created_at: row.created_at,
    content_length: Number(row.content_size ?? row.content_length_db ?? String(row.content || '').length), content_truncated: Number(row.content_size ?? row.content_length_db ?? String(row.content || '').length) > MAX_PREVIEW_CHARS
  };
  if (includeContent) {
    const parsed = parseJson(content, MAX_PREVIEW_CHARS);
    out.content = parsed.malformed ? undefined : parsed.value;
    out.content_is_json = !parsed.malformed;
    out.content_malformed = parsed.malformed;
    out.content_preview = parsed.malformed ? boundedText(content, MAX_PREVIEW_CHARS) : undefined;
  }
  return out;
}
function safeTask(row) {
  const metadataParsed = parseJson(row.metadata_json, 4_000, { redactLocalSkillPaths: false });
  const metadataSize = Number(row.metadata_size || String(row.metadata_json || '').length);
  const metadataTooLarge = metadataSize > 4_000 || metadataParsed.truncated;
  const rawMetadata = !metadataTooLarge && metadataParsed.value && typeof metadataParsed.value === 'object' && !Array.isArray(metadataParsed.value)
    ? metadataParsed.value : null;
  const roleIdCandidate = typeof row.custom_role_id === 'string' ? row.custom_role_id : rawMetadata?.custom_role_id;
  const roleId = typeof roleIdCandidate === 'string' && roleIdCandidate.length <= 80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(roleIdCandidate)
    ? roleIdCandidate : null;
  const roleVersionCandidate = row.custom_role_version ?? rawMetadata?.custom_role_version;
  const parsedRoleVersion = Number(roleVersionCandidate);
  const roleVersion = Number.isSafeInteger(parsedRoleVersion) && parsedRoleVersion >= 1 ? parsedRoleVersion : null;
  const roleName = typeof row.custom_role_name === 'string' ? row.custom_role_name : rawMetadata?.custom_role_name;
  const customRole = roleId && roleVersion !== null
    ? { role_id: roleId, version: roleVersion, name: boundedText(roleName || roleId, 120) }
    : null;
  const metadataMalformed = !metadataTooLarge && metadataParsed.malformed;
  const metadata = metadataTooLarge || metadataMalformed || !rawMetadata
    ? {
      available: false,
      ...(metadataTooLarge ? { truncated: true } : {}),
      ...(metadataMalformed ? { malformed: true } : {}),
      ...(typeof row.workflow_plan_task_id === 'string' ? { workflow_plan_task_id: boundedText(row.workflow_plan_task_id, 100) } : {}),
      ...(customRole ? { custom_role_id: customRole.role_id, custom_role_version: customRole.version, custom_role_name: customRole.name } : {})
    }
    : {
      available: true,
      ...(typeof row.workflow_plan_task_id === 'string' ? { workflow_plan_task_id: boundedText(row.workflow_plan_task_id, 100) } : {}),
      ...(customRole ? { custom_role_id: customRole.role_id, custom_role_version: customRole.version, custom_role_name: customRole.name } : {}),
      ...(typeof rawMetadata.deterministic === 'boolean' ? { deterministic: rawMetadata.deterministic } : {}),
      ...(typeof rawMetadata.execution_mode === 'string' ? { execution_mode: boundedText(rawMetadata.execution_mode, 80) } : {}),
      ...(Number.isFinite(rawMetadata.timeout_ms) ? { timeout_ms: Math.max(0, Math.min(rawMetadata.timeout_ms, 600_000)) } : {}),
      ...(Array.isArray(rawMetadata.custom_role_skills) ? {
        custom_role_skills: rawMetadata.custom_role_skills.slice(0, 8).map(safeTaskSkill).filter(Boolean),
        custom_role_skills_truncated: rawMetadata.custom_role_skills.length > 8
      } : {})
    };
  const {
    metadata_json: _storedMetadataJson,
    metadata_size: _storedMetadataSize,
    workflow_plan_task_id: _storedWorkflowPlanTaskId,
    custom_role_id: _storedCustomRoleId,
    custom_role_version: _storedCustomRoleVersion,
    custom_role_name: _storedCustomRoleName,
    ...safeRow
  } = row;
  return {
    ...safeRow,
    description: boundedText(row.description, 5_000),
    dependency: parseJson(row.dependency_json, 4_000).value,
    dependency_malformed: parseJson(row.dependency_json, 4_000).malformed,
    metadata,
    metadata_available: Boolean(metadata.available),
    metadata_malformed: Boolean(metadata.malformed),
    metadata_truncated: Boolean(metadata.truncated),
    custom_role: customRole,
    role_display: customRole ? `${customRole.name} (${customRole.role_id}@${customRole.version ?? '?'})` : row.role,
    execution_stdout: boundedText(row.execution_stdout, 6_000),
    execution_stderr: boundedText(row.execution_stderr, 6_000)
  };
}
function safeTaskSkill(skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return null;
  const rawFiles = Array.isArray(skill.files) ? skill.files : [];
  const instructions = typeof skill.instructions === 'string' ? skill.instructions : '';
  return {
    name: boundedText(skill.name || 'unnamed-skill', 80),
    description: boundedText(skill.description || '', 500),
    source: { kind: skill.source?.kind === 'local' ? 'local' : 'external', label: skillSourceLabel(skill.source) },
    sha256: typeof skill.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(skill.sha256) ? skill.sha256 : null,
    instruction_chars: instructions.length,
    instructions_preview: boundedText(instructions, 1_200),
    instructions_truncated: instructions.length > 1_200,
    supporting_files: rawFiles.length,
    files_truncated: rawFiles.length > 12,
    files: rawFiles.slice(0, 12).map(file => ({
      path: safeSkillFilePath(file?.path),
      sha256: typeof file?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(file.sha256) ? file.sha256 : null,
      size_bytes: Number.isFinite(Number(file?.size_bytes)) ? Math.max(0, Math.min(Number(file.size_bytes), 10_000_000)) : 0
    }))
  };
}
function getJobs(db, params) {
  const q = boundedText(params.get('q') || '', 160).trim();
  const status = boundedText(params.get('status') || '', 40);
  const phase = boundedText(params.get('phase') || '', 80);
  const limit = clampInt(params.get('limit'), 50, 1, MAX_LIST);
  const offset = clampInt(params.get('offset'), 0, 0, 100_000);
  const where = [];
  const values = [];
  if (q) { where.push("(j.title LIKE ? OR j.job_id LIKE ? OR j.state LIKE ?)"); values.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('j.status=?'); values.push(status); }
  if (phase) { where.push('COALESCE(w.phase, j.state)=?'); values.push(phase); }
  const sql = `SELECT j.job_id,j.title,j.state,j.status,j.active_task_id,j.provider_waiting,j.provider_retry_at,j.created_at,j.updated_at,j.approved_at,j.completed_at,
      COALESCE(w.phase,j.state) AS phase, w.attempt AS phase_attempt, w.last_error AS phase_error,
      (SELECT count(*) FROM tasks t WHERE t.job_id=j.job_id) AS task_total,
      (SELECT count(*) FROM tasks t WHERE t.job_id=j.job_id AND t.status='running') AS task_running,
      (SELECT count(*) FROM tasks t WHERE t.job_id=j.job_id AND t.status='completed') AS task_completed,
      (SELECT count(*) FROM tasks t WHERE t.job_id=j.job_id AND t.status='failed') AS task_failed,
      (SELECT count(*) FROM events e WHERE e.job_id=j.job_id) AS event_total,
      (SELECT count(*) FROM artifacts a WHERE a.job_id=j.job_id AND COALESCE(a.status,'active')='active') AS artifact_total
    FROM jobs j LEFT JOIN workflow_runtime_state w ON w.job_id=j.job_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(j.updated_at,j.created_at) DESC LIMIT ? OFFSET ?`;
  const rows = queryRows(db, sql, [...values, limit, offset]);
  const countSql = `SELECT count(*) AS n FROM jobs j LEFT JOIN workflow_runtime_state w ON w.job_id=j.job_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const total = Number(queryOne(db, countSql, values)?.n || 0);
  return { items: rows, total, limit, offset };
}
function getOverview(db) {
  const jobStatuses = queryRows(db, 'SELECT status, count(*) AS count FROM jobs GROUP BY status ORDER BY status');
  const taskStatuses = queryRows(db, 'SELECT status, count(*) AS count FROM tasks GROUP BY status ORDER BY status');
  const phases = queryRows(db, 'SELECT phase AS name, count(*) AS count FROM workflow_runtime_state GROUP BY phase ORDER BY count DESC, phase');
  const recent = queryRows(db, `SELECT event_id,job_id,type,substr(payload_json,1,10001) AS payload_json,length(payload_json) AS payload_size,created_at,source,from_phase,to_phase,attempt FROM (
      SELECT event_id,job_id,type,payload_json,created_at,'event' AS source,NULL AS from_phase,NULL AS to_phase,NULL AS attempt FROM events
      UNION ALL SELECT workflow_event_id AS event_id,job_id,event AS type,payload_json,created_at,'workflow' AS source,from_phase,to_phase,attempt FROM workflow_events
    ) ORDER BY created_at DESC LIMIT 10`).map(mapEvent);
  const activity = queryRows(db, `SELECT substr(created_at,1,10) AS day, count(*) AS count FROM events WHERE created_at >= datetime('now','-13 days') GROUP BY substr(created_at,1,10) ORDER BY day`);
  return {
    generated_at: new Date().toISOString(),
    counts: {
      jobs: tableCount(db,'jobs'), tasks: tableCount(db,'tasks'), events: tableCount(db,'events'), workflow_events: tableCount(db,'workflow_events'), artifacts: tableCount(db,'artifacts'), results: tableCount(db,'results'), reports: tableCount(db,'reports'), approvals: tableCount(db,'approvals'), attempts: tableCount(db,'attempts'), batches: tableCount(db,'execution_batches'),
      custom_profiles: dbHasTable(db,'custom_role_versions') ? Number(queryOne(db,'SELECT COUNT(DISTINCT role_id) n FROM custom_role_versions')?.n || 0) : 0,
      role_versions: tableCount(db,'custom_role_versions'),
      custom_workflows: dbHasTable(db,'custom_workflow_versions') ? Number(queryOne(db,'SELECT COUNT(DISTINCT workflow_id) n FROM custom_workflow_versions')?.n || 0) : 0,
      individual_executions: Number(queryOne(db,'SELECT COUNT(*) n FROM tasks WHERE execution_status IS NOT NULL OR execution_session_id IS NOT NULL')?.n || 0)
    },
    job_statuses: jobStatuses, task_statuses: taskStatuses, phases,
    activity: activity.map(x => ({ day: x.day, count: Number(x.count) })),
    recent_events: recent
  };
}
function safeJsonArray(value, max = 24_000, options = {}) {
  const parsed = parseJson(value, max, options);
  return Array.isArray(parsed.value) ? parsed.value : [];
}
function skillSourceLabel(source) {
  if (!source || typeof source !== 'object') return 'Unknown source';
  if (source.kind === 'local') return `Local skill · ${path.posix.basename(String(source.location || 'skill').replaceAll('\\', '/'))}`;
  try {
    const url = new URL(String(source.location || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return 'External source';
    return `${url.hostname}${url.pathname}`.slice(0, 240);
  } catch { return 'External source'; }
}
function safeSkillFilePath(value) {
  const raw = String(value || '').slice(0, 240).replaceAll('\\', '/');
  if (!raw) return 'supporting-file';
  if (raw.startsWith('/') || raw.startsWith('~') || /^[a-z]:\//i.test(raw) || /^https?:\/\//i.test(raw)) {
    return path.posix.basename(raw) || 'local-file';
  }
  const segments = raw.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return path.posix.basename(raw) || 'supporting-file';
  return raw;
}
function getRoles(db, params) {
  const q = boundedText(params.get('q') || '', 160).trim();
  const includeVersions = params.get('versions') === 'all';
  const limit = clampInt(params.get('limit'), 20, 1, 25);
  const builtinRoles = queryRows(db, `SELECT t.role,COUNT(*) AS task_count,COUNT(DISTINCT t.job_id) AS job_count
    FROM tasks t WHERE t.role NOT LIKE 'custom-task-%'
    GROUP BY t.role ORDER BY t.role`);

  let customRoles = [];
  if (dbHasTable(db, 'custom_role_versions')) {
    const filters = [];
    const values = [];
    if (q) {
      filters.push('(role_id LIKE ? OR name LIKE ? OR description LIKE ? OR skills_json LIKE ?)');
      values.push(...Array(4).fill(`%${q}%`));
    }
    const filter = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = includeVersions
      ? `SELECT * FROM custom_role_versions ${filter} ORDER BY role_id,version DESC LIMIT ?`
      : `SELECT v.* FROM custom_role_versions v JOIN (
          SELECT role_id,MAX(version) AS version FROM custom_role_versions GROUP BY role_id
        ) latest ON latest.role_id=v.role_id AND latest.version=v.version ${filter.replaceAll('role_id','v.role_id').replaceAll('name','v.name').replaceAll('description','v.description')} ORDER BY v.role_id LIMIT ?`;
    customRoles = queryRows(db, sql, [...values, limit]).map(row => {
      const skills = safeJsonArray(row.skills_json, 180_000, { redactLocalSkillPaths: false }).map(skill => ({
        name: boundedText(skill.name || 'unnamed-skill', 80),
        description: boundedText(skill.description || '', 1_000),
        source: skillSourceLabel(skill.source),
        sha256: typeof skill.sha256 === 'string' ? skill.sha256 : null,
        supporting_files: Array.isArray(skill.files) ? skill.files.length : 0,
        instruction_chars: typeof skill.instructions === 'string' ? skill.instructions.length : 0,
        instructions_preview: boundedText(skill.instructions || '', 1_200),
        instructions_truncated: typeof skill.instructions === 'string' && skill.instructions.length > 1_200,
        files_truncated: Array.isArray(skill.files) && skill.files.length > 12,
        files: Array.isArray(skill.files) ? skill.files.slice(0, 12).map(file => ({
          path: safeSkillFilePath(file.path), sha256: typeof file.sha256 === 'string' ? file.sha256 : null,
          size_bytes: Number(file.size_bytes) || 0
        })) : []
      }));
      return {
        role_id: row.role_id, version: row.version, name: boundedText(row.name, 120),
        description: boundedText(row.description, 2_000), system_prompt: boundedText(row.system_prompt, 6_000),
        input_contract: safeJsonArray(row.input_contract_json), output_artifact_type: row.output_artifact_type,
        allowed_capabilities: safeJsonArray(row.allowed_capabilities_json), permissions: safeJsonArray(row.permissions_json),
        allowed_tools: safeJsonArray(row.allowed_tools_json), skills, created_at: row.created_at, created_by: boundedText(row.created_by, 200)
      };
    });
  }

  let customWorkflows = [];
  if (dbHasTable(db, 'custom_workflow_versions')) {
    const filters = [];
    const values = [];
    if (q) { filters.push('(workflow_id LIKE ? OR name LIKE ? OR description LIKE ? OR tasks_json LIKE ?)'); values.push(...Array(4).fill(`%${q}%`)); }
    const filter = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = includeVersions
      ? `SELECT * FROM custom_workflow_versions ${filter} ORDER BY workflow_id,version DESC LIMIT ?`
      : `SELECT v.* FROM custom_workflow_versions v JOIN (
          SELECT workflow_id,MAX(version) AS version FROM custom_workflow_versions GROUP BY workflow_id
        ) latest ON latest.workflow_id=v.workflow_id AND latest.version=v.version ${filter.replaceAll('workflow_id','v.workflow_id').replaceAll('name','v.name').replaceAll('description','v.description')} ORDER BY v.workflow_id LIMIT ?`;
    customWorkflows = queryRows(db, sql, [...values, limit]).map(row => {
      const tasks = safeJsonArray(row.tasks_json, 64_000).map(task => {
        const role = dbHasTable(db, 'custom_role_versions')
          ? queryOne(db, 'SELECT role_id,version,name,output_artifact_type,skills_json FROM custom_role_versions WHERE role_id=? AND version=?', [task.role_id, task.role_version])
          : null;
        const skills = safeJsonArray(role?.skills_json, 180_000, { redactLocalSkillPaths: false }).map(skill => boundedText(skill.name || 'unnamed-skill', 80));
        return { task_id: boundedText(task.id, 80), role_id: boundedText(task.role_id, 80), role_version: Number.isSafeInteger(task.role_version) && task.role_version > 0 ? task.role_version : null,
          role_name: boundedText(role?.name || task.role_id || 'Unknown role', 120),
          output_artifact_type: boundedText(task.output_artifact_type || '', 80), input_contract: Array.isArray(task.input_contract) ? task.input_contract.slice(0, 32).map(x => boundedText(x, 80)) : [],
          depends_on: Array.isArray(task.depends_on) ? task.depends_on.slice(0, 32).map(x => boundedText(x, 80)) : [], skills };
      });
      return { workflow_id: row.workflow_id, version: row.version, name: boundedText(row.name, 120),
        description: boundedText(row.description, 2_000), input_contract: safeJsonArray(row.input_contract_json), task_count: tasks.length,
        tasks, created_at: row.created_at, created_by: boundedText(row.created_by, 200) };
    });
  }

  // Built-in role overlays are pinned by the immutable workflow proposal
  // event, not inferred from whichever custom-role version is newest.
  const builtinRoleProfilePins = [];
  if (dbHasTable(db, 'events') && dbHasTable(db, 'jobs') && dbHasTable(db, 'custom_role_versions')) {
    const proposalRows = queryRows(db, `SELECT e.job_id,j.title,j.status AS workflow_status,e.payload_json,e.created_at
      FROM events e JOIN jobs j ON j.job_id=e.job_id
      WHERE e.type IN ('job.proposal_requested','job.proposal_refined')
        AND e.rowid=(SELECT p.rowid FROM events p WHERE p.job_id=e.job_id
          AND p.type IN ('job.proposal_requested','job.proposal_refined') ORDER BY p.created_at DESC,p.rowid DESC LIMIT 1)
      ORDER BY e.created_at DESC LIMIT 500`);
    for (const row of proposalRows) {
      const parsed = parseJson(row.payload_json, 64_000);
      if (parsed.malformed || !Array.isArray(parsed.value?.role_profile_bindings)) continue;
      for (const binding of parsed.value.role_profile_bindings) {
        if (!binding || typeof binding.role !== 'string' || typeof binding.custom_role_id !== 'string' ||
            !Number.isSafeInteger(binding.custom_role_version) || binding.custom_role_version < 1) continue;
        const role = queryOne(db, 'SELECT name,output_artifact_type,skills_json FROM custom_role_versions WHERE role_id=? AND version=?', [binding.custom_role_id, binding.custom_role_version]);
        const skills = safeJsonArray(role?.skills_json, 180_000, { redactLocalSkillPaths: false }).map(skill => boundedText(skill.name || 'unnamed-skill', 80));
        const item = {
          job_id: boundedText(row.job_id, 200), workflow_name: boundedText(row.title || row.job_id, 500),
          workflow_status: boundedText(row.workflow_status || 'unknown', 40),
          workflow_id: boundedText(parsed.value.workflowId || 'standard-engineering', 80),
          built_in_role: boundedText(binding.role, 80), task_id: boundedText(`standard-${binding.role}`, 100),
          role_id: boundedText(binding.custom_role_id, 80), role_version: binding.custom_role_version,
          role_name: boundedText(role?.name || binding.custom_role_id, 120),
          output_artifact_type: boundedText(role?.output_artifact_type || '', 80), skills,
          profile_hash: /^[a-f0-9]{64}$/.test(binding.profile_hash || '') ? binding.profile_hash : null,
          created_at: row.created_at
        };
        if (!q || [item.job_id,item.workflow_name,item.workflow_id,item.built_in_role,item.role_id,item.role_name,...skills].some(value => String(value).toLowerCase().includes(q.toLowerCase()))) {
          builtinRoleProfilePins.push(item);
        }
      }
    }
  }
  const latestRoles = dbHasTable(db, 'custom_role_versions')
    ? queryRows(db, 'SELECT skills_json FROM custom_role_versions v WHERE version=(SELECT MAX(x.version) FROM custom_role_versions x WHERE x.role_id=v.role_id)')
    : [];
  return {
    mode: 'read-only registry snapshot', generated_at: new Date().toISOString(), include_versions: includeVersions,
    summary: {
      built_in_role_ids: builtinRoles.length,
      custom_profiles: dbHasTable(db, 'custom_role_versions') ? Number(queryOne(db, 'SELECT COUNT(DISTINCT role_id) n FROM custom_role_versions')?.n || 0) : 0,
      custom_role_versions: tableCount(db, 'custom_role_versions'),
      attached_skills: latestRoles.reduce((sum, row) => sum + safeJsonArray(row.skills_json, 180_000).length, 0),
      custom_workflows: dbHasTable(db, 'custom_workflow_versions') ? Number(queryOne(db, 'SELECT COUNT(DISTINCT workflow_id) n FROM custom_workflow_versions')?.n || 0) : 0,
      builtin_profile_pins: builtinRoleProfilePins.length
    },
    builtin_roles: builtinRoles.map(row => ({ role: row.role, task_count: Number(row.task_count), job_count: Number(row.job_count) })),
    custom_roles: customRoles,
    custom_workflows: customWorkflows,
    builtin_role_profile_pins: builtinRoleProfilePins,
    edit_note: 'This dashboard is deliberately GET-only. Use custom_role_create/update and custom_workflow_create/update tools to change definitions; run approval flow before execution.'
  };
}
function getBatches(db, params) {
  const q = boundedText(params.get('q') || '', 160).trim();
  const status = boundedText(params.get('status') || '', 40).trim().toUpperCase();
  const jobId = boundedText(params.get('jobId') || '', 200).trim();
  const limit = clampInt(params.get('limit'), 10, 1, 10);
  const offset = clampInt(params.get('offset'), 0, 0, 100_000);
  const executionLimit = clampInt(params.get('executionLimit'), 50, 1, 50);
  const executionOffset = clampInt(params.get('executionOffset'), 0, 0, 100_000);
  const where = [];
  const values = [];
  if (q) { where.push('(b.batch_id LIKE ? OR b.role LIKE ? OR b.job_id LIKE ? OR j.title LIKE ?)'); values.push(...Array(4).fill(`%${q}%`)); }
  if (status) { where.push('UPPER(b.status)=?'); values.push(status); }
  if (jobId) { where.push('b.job_id=?'); values.push(jobId); }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const join = 'FROM execution_batches b LEFT JOIN jobs j ON j.job_id=b.job_id';
  const rows = queryRows(db, `SELECT b.batch_id,b.job_id,b.parent_task_id,b.role,b.status,b.attempt,b.created_at,b.started_at,b.finished_at,
      substr(b.aggregate_content,1,5001) AS aggregate_content,length(b.aggregate_content) AS aggregate_size,
      j.title AS job_title,(SELECT COUNT(*) FROM execution_batch_items i WHERE i.batch_id=b.batch_id) AS item_count,
      (SELECT COUNT(*) FROM execution_batch_items i WHERE i.batch_id=b.batch_id AND UPPER(i.status)='COMPLETED') AS completed_items,
      (SELECT COUNT(*) FROM execution_batch_items i WHERE i.batch_id=b.batch_id AND UPPER(i.status)='FAILED') AS failed_items
    ${join} ${filter} ORDER BY COALESCE(b.created_at,b.started_at) DESC LIMIT ? OFFSET ?`, [...values, limit, offset]);
  const total = Number(queryOne(db, `SELECT COUNT(*) AS n ${join} ${filter}`, values)?.n || 0);
  const items = rows.map(batch => {
    const batchItems = queryRows(db, `SELECT item_id,task_id,substr(command,1,1001) AS command,substr(cwd,1,501) AS cwd,timeout_ms,attempt,status,execution_session_id,execution_pid,exit_code,
        substr(stdout,1,1501) AS stdout,length(stdout) AS stdout_size,substr(stderr,1,1501) AS stderr,length(stderr) AS stderr_size,started_at,finished_at,substr(error,1,1001) AS error
      FROM execution_batch_items WHERE batch_id=? ORDER BY item_id LIMIT 20`, [batch.batch_id]).map(item => ({
        ...item, command: boundedText(item.command, 1_000), cwd: boundedText(item.cwd, 500), stdout: boundedText(item.stdout, 1_500),
        stderr: boundedText(item.stderr, 1_500), error: boundedText(item.error, 1_000),
        stdout_truncated: Number(item.stdout_size || 0) > 1_500, stderr_truncated: Number(item.stderr_size || 0) > 1_500
      }));
    return {
      ...batch, batch_id: boundedText(batch.batch_id, 200), job_id: boundedText(batch.job_id, 200),
      parent_task_id: boundedText(batch.parent_task_id, 200), role: boundedText(batch.role, 120), status: boundedText(batch.status, 40),
      job_title: boundedText(batch.job_title || batch.job_id, 1_000), aggregate_content: boundedText(batch.aggregate_content, 2_000),
      items_total: Number(batch.item_count || 0), items_truncated: Number(batch.item_count || 0) > batchItems.length, items: batchItems
    };
  });
  const statuses = dbHasTable(db, 'execution_batches') ? queryRows(db, 'SELECT UPPER(status) AS status,COUNT(*) AS count FROM execution_batches GROUP BY UPPER(status) ORDER BY status') : [];
  const individualWhere = ['(t.execution_status IS NOT NULL OR t.execution_session_id IS NOT NULL)'];
  const individualValues = [];
  if (q) {
    individualWhere.push('(t.task_id LIKE ? OR t.job_id LIKE ? OR t.role LIKE ? OR j.title LIKE ? OR CASE WHEN json_valid(t.metadata_json) THEN CAST(json_extract(t.metadata_json,\'$.custom_role_id\') AS TEXT) ELSE \'\' END LIKE ? OR CASE WHEN json_valid(t.metadata_json) THEN CAST(json_extract(t.metadata_json,\'$.custom_role_name\') AS TEXT) ELSE \'\' END LIKE ?)');
    individualValues.push(...Array(6).fill(`%${q}%`));
  }
  if (status) { individualWhere.push('UPPER(t.execution_status)=?'); individualValues.push(status); }
  if (jobId) { individualWhere.push('t.job_id=?'); individualValues.push(jobId); }
  const individualFilter = `WHERE ${individualWhere.join(' AND ')}`;
  const individualJoin = 'FROM tasks t LEFT JOIN jobs j ON j.job_id=t.job_id';
  const individualRows = queryRows(db, `SELECT t.task_id,t.job_id,t.role,t.status AS task_status,t.execution_status,t.execution_attempt,t.execution_exit_code,
      t.execution_session_id,t.execution_pid,t.execution_started_at,t.execution_finished_at,
      substr(t.execution_stdout,1,6001) AS stdout,length(t.execution_stdout) AS stdout_size,
      substr(t.execution_stderr,1,6001) AS stderr,length(t.execution_stderr) AS stderr_size,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_id') END AS custom_role_id,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_version') END AS custom_role_version,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_name') END AS custom_role_name,
      j.title AS job_title
    ${individualJoin} ${individualFilter} ORDER BY COALESCE(t.execution_started_at,t.updated_at,t.created_at) DESC LIMIT ? OFFSET ?`, [...individualValues, executionLimit, executionOffset]);
  const individualTotal = Number(queryOne(db, `SELECT COUNT(*) AS n ${individualJoin} ${individualFilter}`, individualValues)?.n || 0);
  const individualItems = individualRows.map(row => {
    const roleId = typeof row.custom_role_id === 'string' && row.custom_role_id.length <= 80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(row.custom_role_id)
      ? row.custom_role_id : null;
    const parsedRoleVersion = Number(row.custom_role_version);
    const roleVersion = Number.isSafeInteger(parsedRoleVersion) && parsedRoleVersion >= 1 ? parsedRoleVersion : null;
    const customRole = roleId && roleVersion !== null;
    const roleDisplay = customRole
      ? `${boundedText(row.custom_role_name || roleId, 120)} (${roleId}@${roleVersion})`
      : row.role;
    const { custom_role_id: _customRoleId, custom_role_version: _customRoleVersion, custom_role_name: _customRoleName, ...safeRow } = row;
    return { ...safeRow, role_display: roleDisplay, job_title: boundedText(row.job_title || row.job_id, 1_000),
      stdout: boundedText(row.stdout, 6_000), stderr: boundedText(row.stderr, 6_000),
      stdout_truncated: Number(row.stdout_size || 0) > 6_000, stderr_truncated: Number(row.stderr_size || 0) > 6_000 };
  });
  const individualStatuses = dbHasTable(db, 'tasks')
    ? queryRows(db, "SELECT UPPER(execution_status) AS status,COUNT(*) AS count FROM tasks WHERE execution_status IS NOT NULL OR execution_session_id IS NOT NULL GROUP BY UPPER(execution_status) ORDER BY status")
    : [];
  return {
    items, total, limit, offset, statuses,
    individual_items: individualItems, individual_total: individualTotal, individual_limit: executionLimit, individual_offset: executionOffset, individual_statuses: individualStatuses,
    summary: { batches: tableCount(db, 'execution_batches'), items: tableCount(db, 'execution_batch_items'), individual_executions: Number(queryOne(db, 'SELECT COUNT(*) AS n FROM tasks WHERE execution_status IS NOT NULL OR execution_session_id IS NOT NULL')?.n || 0) },
    empty_explanation: 'A batch is created only when the durable execute_batch path groups approved deterministic local task IDs. Standard specialist workflow tasks are normally recorded individually, so task count does not imply batch count.'
  };
}
function getJobDetail(db, jobId) {
  const job = queryOne(db, `SELECT j.*, COALESCE(w.phase,j.state) AS phase, w.attempt AS phase_attempt, w.resume_after, w.last_error AS phase_error, w.updated_at AS phase_updated_at
    FROM jobs j LEFT JOIN workflow_runtime_state w ON w.job_id=j.job_id WHERE j.job_id=?`, [jobId]);
  if (!job) return null;
  const tasks = queryRows(db, `SELECT task_id,job_id,role,substr(description,1,5001) AS description,status,openclaw_run_id,openclaw_session_key,parent_task_id,substr(dependency_json,1,4001) AS dependency_json,substr(metadata_json,1,4001) AS metadata_json,length(metadata_json) AS metadata_size,
      CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.workflow_plan_task_id') END AS workflow_plan_task_id,
      CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.custom_role_id') END AS custom_role_id,
      CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.custom_role_version') END AS custom_role_version,
      CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.custom_role_name') END AS custom_role_name,
      created_at,updated_at,execution_session_id,execution_status,execution_attempt,execution_pid,execution_exit_code,execution_started_at,execution_finished_at,substr(execution_stdout,1,6001) AS execution_stdout,substr(execution_stderr,1,6001) AS execution_stderr,length(execution_stdout) AS execution_stdout_size,length(execution_stderr) AS execution_stderr_size FROM tasks WHERE job_id=? ORDER BY created_at ASC LIMIT 300`, [jobId]).map(safeTask);
  const taskIds = tasks.map(t => t.task_id);
  const taskSet = new Set(taskIds);
  const attempts = queryRows(db, `SELECT a.attempt_id,a.task_id,a.status,a.openclaw_run_id,a.started_at,a.finished_at,substr(a.error,1,4001) AS error,t.role FROM attempts a JOIN tasks t ON t.task_id=a.task_id WHERE t.job_id=? ORDER BY a.started_at DESC LIMIT 150`, [jobId]).map(x=>({...x,error:boundedText(x.error,4000)}));
  const results = queryRows(db, `SELECT r.result_id,r.task_id,r.outcome,substr(r.content,1,6001) AS content,length(r.content) AS content_size,r.created_at,t.role FROM results r JOIN tasks t ON t.task_id=r.task_id WHERE t.job_id=? ORDER BY r.created_at DESC LIMIT 120`, [jobId]).map(x=>({...x,content:boundedText(x.content,6000),content_length:Number(x.content_size||0),content_truncated:Number(x.content_size||0)>6000}));
  const approvals = queryRows(db, 'SELECT approval_id,job_id,decision,actor,substr(raw_text,1,5001) AS raw_text,proposal_hash,created_at FROM approvals WHERE job_id=? ORDER BY created_at DESC LIMIT 50', [jobId]).map(x=>({...x,raw_text:boundedText(x.raw_text,5000)}));
  const artifacts = queryRows(db, `SELECT a.artifact_id,a.job_id,a.task_id,a.kind,a.uri,substr(a.metadata_json,1,4001) AS metadata_json,a.created_at,a.schema_version,a.producer_role,length(a.content) AS content_size,substr(a.evidence_json,1,8001) AS evidence_json,a.status,a.supersedes,a.content_hash,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_id') END AS producer_custom_role_id,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_version') END AS producer_custom_role_version,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_name') END AS producer_custom_role_name FROM artifacts a LEFT JOIN tasks t ON t.task_id=a.task_id WHERE a.job_id=? ORDER BY a.created_at DESC LIMIT 200`, [jobId]).map(x=>mapArtifact(x,false));
  const reports = queryRows(db, 'SELECT report_id,job_id,kind,substr(content,1,8001) AS content,length(content) AS content_size,delivered_at,created_at FROM reports WHERE job_id=? ORDER BY created_at DESC LIMIT 50', [jobId]).map(x=>({...x,content:boundedText(x.content,8000),content_length:Number(x.content_size||0),content_truncated:Number(x.content_size||0)>8000}));
  const events = queryRows(db, 'SELECT event_id,job_id,type,substr(payload_json,1,10001) AS payload_json,length(payload_json) AS payload_size,created_at FROM events WHERE job_id=? ORDER BY created_at DESC LIMIT 120', [jobId]).map(mapEvent);
  const transitions = queryRows(db, 'SELECT workflow_event_id,job_id,from_phase,to_phase,event,attempt,substr(payload_json,1,10001) AS payload_json,length(payload_json) AS payload_size,created_at FROM workflow_events WHERE job_id=? ORDER BY created_at DESC LIMIT 120', [jobId]).map(mapEvent);
  const batches = queryRows(db, 'SELECT batch_id,job_id,parent_task_id,role,status,attempt,created_at,started_at,finished_at,substr(aggregate_content,1,5001) AS aggregate_content,length(aggregate_content) AS aggregate_size FROM execution_batches WHERE job_id=? ORDER BY created_at DESC LIMIT 50', [jobId]).map(batch=>({
    ...batch, aggregate_content: boundedText(batch.aggregate_content,5000), items: queryRows(db, 'SELECT item_id,task_id,substr(command,1,2001) AS command,substr(cwd,1,1001) AS cwd,timeout_ms,attempt,status,execution_session_id,execution_pid,exit_code,substr(stdout,1,6001) AS stdout,length(stdout) AS stdout_size,substr(stderr,1,6001) AS stderr,length(stderr) AS stderr_size,started_at,finished_at,substr(error,1,4001) AS error FROM execution_batch_items WHERE batch_id=? ORDER BY item_id LIMIT 100',[batch.batch_id]).map(item=>({...item,command:boundedText(item.command,2000),cwd:boundedText(item.cwd,1000),stdout:boundedText(item.stdout,6000),stderr:boundedText(item.stderr,6000),error:boundedText(item.error,4000)}))
  }));
  return { job: {...job, title: boundedText(job.title,1000), conversation_key: boundedText(job.conversation_key,1000), phase_error: boundedText(job.phase_error,4000)}, tasks, orphan_results_count: results.filter(x=>!taskSet.has(x.task_id)).length, approvals, attempts, results, artifacts, reports, events, transitions, batches };
}
function getEvents(db, params) {
  const q = boundedText(params.get('q') || '', 160).trim();
  const type = boundedText(params.get('type') || '', 120);
  const jobId = boundedText(params.get('jobId') || '', 200);
  const limit = clampInt(params.get('limit'), 80, 1, MAX_LIST);
  const offset = clampInt(params.get('offset'), 0, 0, 100_000);
  const where=[]; const values=[];
  if(q){where.push('(e.type LIKE ? OR e.job_id LIKE ? OR e.payload_json LIKE ? OR e.from_phase LIKE ? OR e.to_phase LIKE ?)'); values.push(...Array(5).fill(`%${q}%`));}
  if(type){where.push('e.type=?');values.push(type);}
  if(jobId){where.push('e.job_id=?');values.push(jobId);}
  const filter = where.length?`WHERE ${where.join(' AND ')}`:'';
  const unionSql = `SELECT event_id,job_id,type,payload_json,created_at,'event' AS source,NULL AS from_phase,NULL AS to_phase,NULL AS attempt FROM events
    UNION ALL SELECT workflow_event_id AS event_id,job_id,event AS type,payload_json,created_at,'workflow' AS source,from_phase,to_phase,attempt FROM workflow_events`;
  const items=queryRows(db,`SELECT e.event_id,e.job_id,e.type,e.source,e.from_phase,e.to_phase,e.attempt,substr(e.payload_json,1,10001) AS payload_json,length(e.payload_json) AS payload_size,e.created_at FROM (${unionSql}) e ${filter} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,[...values,limit,offset]).map(mapEvent);
  const total=Number(queryOne(db,`SELECT count(*) AS n FROM (${unionSql}) e ${filter}`,values)?.n||0);
  return {items,total,limit,offset};
}
function getArtifacts(db, params) {
  const q=boundedText(params.get('q')||'',160).trim();const jobId=boundedText(params.get('jobId')||'',200);const type=boundedText(params.get('type')||'',100);
  const limit=clampInt(params.get('limit'),80,1,MAX_LIST);const offset=clampInt(params.get('offset'),0,0,100_000);
  const where=[];const values=[];
  if(q){where.push('(a.artifact_id LIKE ? OR a.job_id LIKE ? OR a.kind LIKE ? OR a.producer_role LIKE ? OR a.content_hash LIKE ?)');values.push(...Array(5).fill(`%${q}%`));}
  if(jobId){where.push('a.job_id=?');values.push(jobId);} if(type){where.push('a.kind=?');values.push(type);}
  const filter=where.length?`WHERE ${where.join(' AND ')}`:'';
  const rows=queryRows(db,`SELECT a.artifact_id,a.job_id,a.task_id,a.kind,a.uri,substr(a.metadata_json,1,4001) AS metadata_json,a.created_at,a.schema_version,a.producer_role,length(a.content) AS content_size,substr(a.evidence_json,1,8001) AS evidence_json,a.status,a.supersedes,a.content_hash,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_id') END AS producer_custom_role_id,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_version') END AS producer_custom_role_version,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_name') END AS producer_custom_role_name FROM artifacts a LEFT JOIN tasks t ON t.task_id=a.task_id ${filter} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,[...values,limit,offset]);
  const total=Number(queryOne(db,`SELECT count(*) AS n FROM artifacts a ${filter}`,values)?.n||0);
  return {items:rows.map(x=>mapArtifact(x,false)),total,limit,offset};
}
function allowedSegments(relative) {
  if (typeof relative !== 'string' || relative.length > 1024 || relative.includes('\\') || relative.startsWith('/') || relative.includes('\0')) throw new Error('invalid relative path');
  if (!relative) return [];
  const segments=relative.split('/');
  if (segments.some(s=>!s || s==='.' || s==='..' || s.startsWith('.') || s.length>200 || !/^[\w .@()+,-]+$/.test(s))) throw new Error('invalid path segment');
  return segments;
}
function checkSafeEntry(root, relative, wantDirectory = false) {
  const segments=allowedSegments(relative);
  let candidate=root;
  for (const segment of segments) {
    candidate=path.join(candidate,segment);
    const info=fs.lstatSync(candidate);
    if (info.isSymbolicLink()) throw new Error('symbolic links are not browsable');
    if (!(info.isDirectory() || info.isFile())) throw new Error('unsupported file type');
    if (info.isFile() && FORBIDDEN_FILE_RE.test(segment)) throw new Error('file type is not allowed');
  }
  const real=fs.realpathSync(candidate);
  if (!isWithin(root,real)) throw new Error('path escapes data root');
  const stat=fs.statSync(real);
  if (wantDirectory && !stat.isDirectory()) throw new Error('not a directory');
  return { path: real, stat, segments };
}
function listFiles(dataRoot, relative) {
  const checked=checkSafeEntry(dataRoot,relative,true);
  const entries=fs.readdirSync(checked.path,{withFileTypes:true}).slice(0,1000).map(entry=>{
    if(entry.name.startsWith('.') || !/^[\w .@()+,-]+$/.test(entry.name)) return null;
    const full=path.join(checked.path,entry.name);
    let stat; try { stat=fs.lstatSync(full); } catch { return null; }
    if(stat.isSymbolicLink()) return null;
    if(stat.isDirectory()) return {name:entry.name,path:[relative,entry.name].filter(Boolean).join('/'),kind:'directory',size:0,modified_at:stat.mtime.toISOString()};
    if(!stat.isFile() || FORBIDDEN_FILE_RE.test(entry.name) || !SAFE_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return null;
    return {name:entry.name,path:[relative,entry.name].filter(Boolean).join('/'),kind:'file',size:stat.size,modified_at:stat.mtime.toISOString()};
  }).filter(Boolean).sort((a,b)=>a.kind===b.kind?a.name.localeCompare(b.name):(a.kind==='directory'?-1:1)).slice(0,200);
  return {path:relative||'',root_label:path.basename(dataRoot),parent:relative?relative.split('/').slice(0,-1).join('/'):null,entries,truncated:entries.length>=200};
}
function previewFile(dataRoot, relative) {
  const checked=checkSafeEntry(dataRoot,relative,false);
  if(!checked.stat.isFile()) throw new Error('preview target is not a file');
  const ext=path.extname(checked.path).toLowerCase();
  if(!SAFE_TEXT_EXTENSIONS.has(ext) || FORBIDDEN_FILE_RE.test(checked.path)) throw new Error('file type is not allowed');
  const flags=fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd=fs.openSync(checked.path,flags);
  try {
    const info=fs.fstatSync(fd);
    if(!info.isFile() || info.dev !== checked.stat.dev || info.ino !== checked.stat.ino) throw new Error('file changed while being checked');
    if(info.size > 50 * 1024 * 1024) throw new Error('file exceeds maximum browse size');
    const buffer=Buffer.alloc(Math.min(info.size,MAX_FILE_BYTES));
    const read=fs.readSync(fd,buffer,0,buffer.length,0);
    const bytes=buffer.subarray(0,read);
    if(bytes.includes(0)) throw new Error('binary files cannot be previewed');
    const text=bytes.toString('utf8');
    if(text.includes('\uFFFD') && !text.startsWith('\uFEFF')) throw new Error('file is not valid UTF-8 text');
    return {path:relative,size:info.size,preview:boundedText(text,MAX_FILE_BYTES),truncated:info.size>read,limit:MAX_FILE_BYTES,modified_at:info.mtime.toISOString()};
  } finally { fs.closeSync(fd); }
}
function getPolicies(db, params) {
  const q = boundedText(params.get('q') || '', 120).trim();
  const includeVersions = params.get('versions') === 'all';
  const limit = clampInt(params.get('limit'), 100, 1, 200);
  const hasVersions = dbHasTable(db, 'workflow_policy_versions');
  const hasAttachments = dbHasTable(db, 'workflow_policy_attachments');
  const hasEvents = dbHasTable(db, 'workflow_policy_events');
  if (!hasVersions) return {
    mode: 'read-only registry snapshot', generated_at: new Date().toISOString(), include_versions: includeVersions,
    summary: { policy_count: 0, policy_versions: 0, attachments: 0, audit_events: 0 },
    policies: [], attachments: [], events: [],
    note: 'Policy registry has not been initialized by the MCP runtime yet.'
  };
  const rows = includeVersions
    ? queryRows(db, `SELECT * FROM workflow_policy_versions WHERE (?='' OR instr(lower(policy_id),lower(?))>0 OR instr(lower(name),lower(?))>0 OR instr(lower(description),lower(?))>0) ORDER BY policy_id,version DESC LIMIT ?`, [q, q, q, q, limit])
    : queryRows(db, `SELECT v.* FROM workflow_policy_versions v JOIN (SELECT policy_id,MAX(version) AS version FROM workflow_policy_versions GROUP BY policy_id) latest ON latest.policy_id=v.policy_id AND latest.version=v.version WHERE (?='' OR instr(lower(v.policy_id),lower(?))>0 OR instr(lower(v.name),lower(?))>0 OR instr(lower(v.description),lower(?))>0) ORDER BY v.name COLLATE NOCASE,v.policy_id LIMIT ?`, [q, q, q, q, limit]);
  const policies = rows.map(row => {
    const parsed = parseJson(row.definition_json, 20_000);
    const definition = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : {};
    const integrity = inspectStoredWorkflowPolicyRow(row);
    const safeRule = rule => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
      const result = {};
      for (const key of ['id','type','description','artifact_type','producer_role','field','task_id','role']) {
        if (typeof rule[key] === 'string') result[key] = redactSensitiveText(boundedText(rule[key], key === 'description' ? 1000 : 100));
      }
      if (['string','number','boolean'].includes(typeof rule.expected)) result.expected = typeof rule.expected === 'string' ? redactSensitiveText(boundedText(rule.expected, 500)) : rule.expected;
      return result;
    };
    const constraints = Array.isArray(definition.constraints) ? definition.constraints.slice(0, 32).map(safeRule).filter(Boolean) : [];
    const successCriteria = Array.isArray(definition.success_criteria) ? definition.success_criteria.slice(0, 32).map(safeRule).filter(Boolean) : [];
    return {
      policy_id: boundedText(row.policy_id, 80), version: Math.max(1, Number(row.version) || 1),
      name: redactSensitiveText(boundedText(row.name, 120)), description: redactSensitiveText(boundedText(row.description, 2000)),
      content_hash: typeof row.content_hash === 'string' && /^[a-f0-9]{64}$/.test(row.content_hash) ? row.content_hash : null,
      created_at: row.created_at, created_by: boundedText(row.created_by, 120),
      schema_version: definition.schema_version === 1 ? 1 : null,
      constraints, success_criteria: successCriteria,
      constraint_count: constraints.length, success_criteria_count: successCriteria.length,
      definition_truncated: parsed.truncated || parsed.malformed,
      validation_status: integrity.validation_status,
      validation_reason: integrity.valid ? null : redactSensitiveText(integrity.reason),
      violation_count: null
    };
  });
  const violationCounts = hasEvents ? queryRows(db,
    "SELECT policy_id,version,COUNT(*) AS n FROM workflow_policy_events WHERE event_type='violation_detected' GROUP BY policy_id,version", []).reduce((result, row) => {
      result[`${row.policy_id}@${row.version}`] = Number(row.n) || 0;
      return result;
    }, Object.create(null)) : Object.create(null);
  for (const policy of policies) policy.violation_count = violationCounts[`${policy.policy_id}@${policy.version}`] || 0;
  let attachments = [];
  if (hasAttachments) {
    const sql = `SELECT a.job_id,a.policy_id,a.version,a.content_hash,a.attached_at,a.attached_by,j.title AS job_title,j.state AS job_state,j.status AS job_status,
      v.policy_id AS version_policy_id,v.version AS stored_policy_version,v.name AS policy_name,v.description AS policy_description,
      v.definition_json AS policy_definition_json,v.content_hash AS policy_version_content_hash,v.created_at AS policy_created_at,v.created_by AS policy_created_by
      FROM workflow_policy_attachments a LEFT JOIN jobs j ON j.job_id=a.job_id
      LEFT JOIN workflow_policy_versions v ON v.policy_id=a.policy_id AND v.version=a.version
      WHERE (?='' OR instr(lower(a.policy_id),lower(?))>0 OR instr(lower(v.name),lower(?))>0 OR instr(lower(j.title),lower(?))>0 OR instr(lower(a.job_id),lower(?))>0)
      ORDER BY a.attached_at DESC,a.job_id LIMIT ?`;
    attachments = queryRows(db, sql, [q, q, q, q, q, limit]).map(row => {
      const integrity = row.version_policy_id ? inspectStoredWorkflowPolicyRow({
        policy_id: row.version_policy_id, version: row.stored_policy_version, name: row.policy_name,
        description: row.policy_description, definition_json: row.policy_definition_json,
        content_hash: row.policy_version_content_hash, created_at: row.policy_created_at, created_by: row.policy_created_by
      }) : { valid: false, validation_status: 'invalid', reason: 'pinned policy version is missing' };
      const pinMatches = integrity.valid && row.content_hash === row.policy_version_content_hash;
      return {
        job_id: boundedText(row.job_id, 200), policy_id: boundedText(row.policy_id, 80), version: Math.max(1, Number(row.version) || 1),
        content_hash: typeof row.content_hash === 'string' && /^[a-f0-9]{64}$/.test(row.content_hash) ? row.content_hash : null,
        name: redactSensitiveText(boundedText(row.policy_name || row.policy_id, 120)), attached_at: row.attached_at, attached_by: boundedText(row.attached_by, 120),
        job_title: redactSensitiveText(boundedText(row.job_title || row.job_id, 180)), job_state: boundedText(row.job_state || 'unknown', 40), job_status: boundedText(row.job_status || 'unknown', 40),
        validation_status: pinMatches ? 'valid' : 'invalid',
        validation_reason: pinMatches ? null : redactSensitiveText(integrity.reason || 'attachment hash does not match its pinned policy version')
      };
    });
  }
  const events = hasEvents ? queryRows(db,
    `SELECT event_id,policy_id,version,event_type,payload_json,created_at,created_by FROM workflow_policy_events
      WHERE (?='' OR instr(lower(policy_id),lower(?))>0) ORDER BY created_at DESC LIMIT ?`, [q, q, Math.min(limit, 100)]).map(row => ({
        event_id: boundedText(row.event_id, 80), policy_id: boundedText(row.policy_id, 80), version: Number.isSafeInteger(Number(row.version)) ? Number(row.version) : null,
        event_type: boundedText(row.event_type, 80), payload: redactPolicyEventPayload(parseJson(row.payload_json, 3000).value),
        created_at: row.created_at, created_by: boundedText(row.created_by, 120)
      })) : [];
  return {
    mode: 'read-only registry snapshot', generated_at: new Date().toISOString(), include_versions: includeVersions,
    summary: {
      policy_count: Number(queryOne(db, 'SELECT COUNT(DISTINCT policy_id) n FROM workflow_policy_versions')?.n || 0),
      policy_versions: tableCount(db, 'workflow_policy_versions'),
      attachments: tableCount(db, 'workflow_policy_attachments'),
      audit_events: tableCount(db, 'workflow_policy_events'),
      recorded_violations: hasEvents
        ? Number(queryOne(db, "SELECT COUNT(*) AS n FROM workflow_policy_events WHERE event_type='violation_detected'")?.n || 0)
        : 0
    },
    policies, attachments, events,
    enforcement_note: 'Stored rules use a closed JSON predicate catalog. Runtime enforcement is independent at immutable-plan validation and synthesis/terminalization; this dashboard is read-only and does not validate or change rules.'
  };
}
function redactPolicyEventPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['job_id','policy_id','policy_version','version','content_hash','policy_content_hash','plan_hash','predicate_id','predicate_type','reason','previous_version']) {
    const item = value[key];
    if (typeof item === 'string') result[key] = redactSensitiveText(boundedText(item, key === 'reason' ? 1000 : 200));
    else if (typeof item === 'number' && Number.isSafeInteger(item)) result[key] = item;
  }
  return result;
}
function requestHostOk(req, expectedHost, port) {
  const host = req.headers.host || '';
  if (host.toLowerCase() !== expectedHost.toLowerCase()) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const originHost = parsed.hostname.replace(/^\[|\]$/g, '');
      if (parsed.protocol !== 'http:' || !onlyLoopback(originHost) || Number(parsed.port || 80) !== Number(port) || parsed.username || parsed.password) return false;
    } catch { return false; }
  }
  return true;
}

export function createDashboardServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!onlyLoopback(host)) throw new Error('dashboard host must be 127.0.0.1 or ::1');
  const port = options.port ?? clampInt(process.env.RUNALITH_DASHBOARD_PORT || process.env.CHAT_ON_STEROIDS_DASHBOARD_PORT, 8318, 1, 65535);
  const dataRoot = resolveDataDir(options.dataDir || DEFAULT_DATA_DIR);
  const dbPath = path.resolve(options.dbPath || DEFAULT_DB_PATH);
  let db = null;
  let dbError = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: true });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  } catch (error) { dbError = boundedText(error?.message || error, 600); }
  const publicRoot = path.resolve(options.publicDir || path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'));
  const expectedHost = host.includes(':') ? `[${host}]` : host;
  const server = http.createServer((req,res)=>{
    const headers = noStoreHeaders();
    for(const [key,value] of Object.entries(headers)) res.setHeader(key,value);
    if (Buffer.byteLength(req.url || '') > MAX_URL_BYTES) return sendJson(res,414,{error:'request URL too long'});
    const actualPort = server.address()?.port || port;
    if (!requestHostOk(req, `${expectedHost}:${actualPort}`, actualPort)) return sendJson(res,403,{error:'untrusted host or origin'});
    if (req.method !== 'GET') return sendJson(res,405,{error:'read-only dashboard accepts GET only'});
    let url; try { url = new URL(req.url || '/', `http://${expectedHost}:${actualPort}`); } catch { return sendJson(res,400,{error:'invalid URL'}); }
    const route = url.pathname;
    if (route.startsWith('/api/')) {
      if (!db) return sendJson(res,503,{error:'workflow database is unavailable',details:dbError,read_only:true});
      try {
        let payload;
        if (route === '/api/health') payload = { status:'ok', database:'connected', database_path:path.basename(dbPath), data_root:path.basename(dataRoot), mode:'local-read-only', read_only:true, host, port:server.address()?.port || port };
        else if (route === '/api/overview') payload = getOverview(db);
        else if (route === '/api/roles') payload = getRoles(db,url.searchParams);
        else if (route === '/api/policies') payload = getPolicies(db,url.searchParams);
        else if (route === '/api/batches') payload = getBatches(db,url.searchParams);
        else if (route === '/api/jobs') payload = getJobs(db,url.searchParams);
        else if (route.startsWith('/api/jobs/')) {
          const id = decodeURIComponent(route.slice('/api/jobs/'.length));
          if (!id || id.includes('/')) return sendJson(res,400,{error:'invalid job id'});
          payload = getJobDetail(db,id); if (!payload) return sendJson(res,404,{error:'job not found'});
        } else if (route === '/api/events') payload = getEvents(db,url.searchParams);
        else if (route === '/api/artifacts') payload = getArtifacts(db,url.searchParams);
        else if (route.startsWith('/api/artifacts/')) {
          const id=decodeURIComponent(route.slice('/api/artifacts/'.length));
          const row=queryOne(db,"SELECT a.artifact_id,a.job_id,a.task_id,a.kind,a.uri,substr(a.metadata_json,1,4001) AS metadata_json,a.created_at,a.schema_version,a.producer_role,substr(a.content,1,48001) AS content,length(a.content) AS content_size,substr(a.evidence_json,1,8001) AS evidence_json,a.status,a.supersedes,a.content_hash,CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_id') END AS producer_custom_role_id,CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_version') END AS producer_custom_role_version,CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.custom_role_name') END AS producer_custom_role_name FROM artifacts a LEFT JOIN tasks t ON t.task_id=a.task_id WHERE a.artifact_id=?",[id]);
          if(!row) return sendJson(res,404,{error:'artifact not found'}); payload=mapArtifact(row,true);
        } else if (route === '/api/files') {
          try { payload=listFiles(dataRoot,url.searchParams.get('path')||''); }
          catch(error) { return sendJson(res,400,{error:'directory cannot be browsed',details:boundedText(error.message,300)}); }
        } else if (route === '/api/files/preview') {
          try { const filePath=url.searchParams.get('path')||''; if(!filePath) return sendJson(res,400,{error:'path is required'}); payload=previewFile(dataRoot,filePath); }
          catch(error) { return sendJson(res,403,{error:'file preview denied',details:boundedText(error.message,300)}); }
        } else return sendJson(res,404,{error:'API route not found'});
        return sendJson(res,200,payload);
      } catch (error) {
        return sendJson(res,500,{error:'dashboard query failed',details:boundedText(error?.message||error,300)});
      }
    }
    const assets = new Map([['/','index.html'],['/index.html','index.html'],['/styles.css','styles.css'],['/ux-overrides.css','ux-overrides.css'],['/app.js','app.js']]);
    const asset = assets.get(route);
    if (!asset) return sendJson(res,404,{error:'not found'});
    try {
      const filePath=path.join(publicRoot,asset); const real=fs.realpathSync(filePath);
      if(!isWithin(publicRoot,real) || !fs.statSync(real).isFile()) return sendJson(res,404,{error:'not found'});
      const body=fs.readFileSync(real);
      res.writeHead(200,{...headers,'content-type':MIME[path.extname(real)]||'application/octet-stream','content-length':body.length});
      return res.end(req.method==='HEAD'?undefined:body);
    } catch { return sendJson(res,500,{error:'dashboard asset unavailable'}); }
  });
  return {
    server, dbPath, dataRoot, host, port,
    listen:()=>new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(port,host,()=>{server.off('error',reject);resolve(server.address());});
    }),
    close:()=>new Promise(resolve=>{
      const done=()=>{try{db?.close();}catch{} resolve();};
      if(server.listening) server.close(done); else done();
    })
  };
}

async function main() {
  const rawHost=process.env.RUNALITH_DASHBOARD_HOST || process.env.CHAT_ON_STEROIDS_DASHBOARD_HOST || '127.0.0.1';
  if(!onlyLoopback(rawHost)) throw new Error('RUNALITH_DASHBOARD_HOST must be 127.0.0.1 or ::1; non-loopback dashboards are disabled');
  const app=createDashboardServer({host:rawHost});
  const address=await app.listen();
  const shownHost=rawHost.includes(':')?`[${rawHost}]`:rawHost;
  console.log(`Runalith Dashboard: http://${shownHost}:${address.port}`);
  console.log(`Database: ${app.dbPath}`);
  console.log('Mode: read-only; loopback only. Press Ctrl+C to stop.');
  const stop=async()=>{await app.close();process.exit(0);};
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(`dashboard startup failed: ${error.message}`);process.exitCode=1;});
}
