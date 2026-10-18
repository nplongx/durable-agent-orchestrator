#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MAX_STRICT_JSON_BYTES, parseStrictJson } from '../src/runtime/strict-json.js';

const packageMetadata = parseStrictJson(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'), 'plugin package metadata');
const PLUGIN_VERSION = packageMetadata.version;
const SERVER_INFO = { name: 'chat-on-steroids-local-orchestrator', version: PLUGIN_VERSION };
const SERVER_INSTRUCTIONS = [
  'This is the local-only Durable Agent Orchestrator plugin for Chat On Steroids.',
  'All workflow state is stored in local SQLite. Deterministic commands execute on this computer only through the task’s immutable structured execution contract.',
  'There is no cloud runner, GitHub Actions dispatch, remote worker, external model API, or HTTP service in this plugin.',
  'Create a workflow, review its proposal, explicitly approve it, dispatch it, prepare the planned tasks, then use workflow_next_task to follow dependencies.',
  'For each task, follow its role-specific description, inspect the completed predecessor results and typed artifacts returned by workflow_next_task, and produce only the assigned role output. Do not treat different role labels as a substitute for different work.',
  'After completing a reasoning task with workflow_complete_task or a deterministic task with task_execute_local, call workflow_next_task again. Continue until it returns synthesis, blocked, or a terminal state. If synthesis is returned, reconcile every result and artifact before calling workflow_complete_synthesis. Never claim workflow completion unless the tool confirms terminalization.',
  'This plugin is tool-driven, not an autonomous background agent runner: durable task creation/completion records do not prove independent model execution. Reasoning is performed by the host conversation; deterministic tasks run locally under their approved execution contract.',
  'Custom workflows require an approved immutable preview and a separate workflow execution approval. Their tasks use the same local dependency-aware engine and typed artifact checks as built-in workflows; custom roles do not grant shell or workspace-write permissions.',
  'Do not claim native OpenClaw session/run IDs: local plugin tasks have no OpenClaw identity.'
].join(' ');

const home = os.homedir();
const dataDir = path.resolve(process.env.CHAT_ON_STEROIDS_DATA_DIR || process.env.WORKFLOW_DATA_DIR || path.join(home, '.chat-on-steroids', 'agent-orchestrator'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
let dataDirChmodError = null;
try { fs.chmodSync(dataDir, 0o700); } catch (error) { dataDirChmodError = error; }
const dataDirStat = fs.statSync(dataDir);
if (!dataDirStat.isDirectory()) throw new Error(`local plugin data path is not a directory: ${dataDir}`);
// `mkdir({mode:0700})` does not tighten an existing directory. Ignoring a
// chmod failure then opening SQLite can silently expose workflow content and
// execution evidence through group/world-readable files. Continue only when
// the actual POSIX directory mode is private; Windows ACLs are managed by the
// operating system and do not expose POSIX permission bits with equivalent
// semantics through Node's stat mode.
if (process.platform !== 'win32' && (dataDirStat.mode & 0o077) !== 0) {
  const mode = (dataDirStat.mode & 0o777).toString(8).padStart(3, '0');
  const chmodDetail = dataDirChmodError ? `; chmod failed: ${dataDirChmodError.message}` : '';
  throw new Error(`local plugin data directory is not private: ${dataDir} mode=0${mode}; expected no group/world permissions${chmodDetail}; refusing to open workflow state`);
}
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_DB = path.resolve(process.env.CHAT_ON_STEROIDS_WORKFLOW_DB || process.env.WORKFLOW_DB || path.join(dataDir, 'workflow.db'));
process.env.EXECUTION_TMP_DIR = path.resolve(process.env.CHAT_ON_STEROIDS_EXECUTION_TMP_DIR || process.env.EXECUTION_TMP_DIR || path.join(dataDir, 'runtime'));
process.env.WORKFLOW_WORKSPACE = path.resolve(process.env.CHAT_ON_STEROIDS_WORKSPACE || process.env.WORKFLOW_WORKSPACE || home);

const runtimePrefix = fs.existsSync(new URL('./runtime/job-store.js', import.meta.url)) ? './runtime' : '../src/runtime';
const [{ workflowStore, WORKFLOW_DB_PATH }, { ExecutionManager, isVerifiedSuccessfulLocalExecution, isSuccessfulLocalExecutionSummary }] = await Promise.all([
  import(`${runtimePrefix}/job-store.js`),
  import(`${runtimePrefix}/execution-manager.js`)
]);
const [{ artifactSchemaForType, validateArtifact, validateArtifactContent }, { getAgentArtifactType, getAgentInputArtifactTypes, getAgentContract }] = await Promise.all([
  import(`${runtimePrefix}/workflow/artifacts.js`),
  import(`${runtimePrefix}/workflow/agent-contracts.js`)
]);
const { assessProductionQaExecution } = await import(`${runtimePrefix}/workflow/catalog/production.js`);
const { createCase01WorkspaceSnapshot, removeCase01WorkspaceSnapshot, reconcileCase01WorkspaceSnapshots, validateCase01WorkspaceArtifact, readVerifiedCase01WorkspaceSnapshot, collectCase01SnapshotReferences, validateCase01DurableSnapshotReferences } = await import(`${runtimePrefix}/workflow/case01-artifact-acceptance.js`);
const customRoles = await import(`${runtimePrefix}/workflow/custom-roles.js`);
customRoles.initializeCustomRoleStore(workflowStore.db);
const customWorkflows = await import(`${runtimePrefix}/workflow/custom-workflows.js`);
customWorkflows.initializeCustomWorkflowStore(workflowStore.db);

const CASE01_SNAPSHOT_BASE = path.join(dataDir, 'case01-snapshots');
workflowStore.db.exec(`CREATE TABLE IF NOT EXISTS case01_snapshot_reservations (
  snapshot_id TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  created_at TEXT NOT NULL
);`);
workflowStore.db.exec(`CREATE TABLE IF NOT EXISTS case01_consumption_acks (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
  source_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  source_result_id TEXT NOT NULL REFERENCES results(result_id),
  source_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  source_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  snapshot_id TEXT NOT NULL,
  cto_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  cto_result_id TEXT NOT NULL REFERENCES results(result_id),
  cto_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  cto_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  verified_manifest_sha256 TEXT NOT NULL CHECK(length(verified_manifest_sha256)=64),
  consumed_manifest_sha256 TEXT NOT NULL CHECK(length(consumed_manifest_sha256)=64),
  lineage_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, snapshot_id, cto_result_id)
);`);

function case01CompletionEvent(jobId, resultId) {
  const rows = workflowStore.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type='task.local_completed'").all(jobId);
  const matches = [];
  for (const row of rows) {
    let payload;
    try { payload = parseStrictJson(row.payload_json); } catch { throw new Error('CASE-01 completion trace contains malformed task.local_completed payload'); }
    if (payload?.resultId === resultId) matches.push({ row, payload });
  }
  if (matches.length !== 1) throw new Error('CASE-01 requires exactly one completion event for each consumed result');
  const { row, payload } = matches[0];
  const expectedId = createHash('sha256').update(`${jobId}|task.local_completed|${resultId}`).digest('hex');
  if (row.event_id !== expectedId || row.job_id !== jobId || row.type !== 'task.local_completed' ||
      row.payload_json !== JSON.stringify(payload) ||
      Object.keys(payload).sort().join(',') !== 'attemptId,executor,resultId,taskId') {
    throw new Error('CASE-01 completion event must have exact deterministic identity and canonical payload bytes');
  }
  return matches[0];
}

function case01ArtifactEvent(jobId, artifact) {
  const rows = workflowStore.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type='artifact.created'").all(jobId);
  const matches = [];
  for (const row of rows) {
    let payload;
    try { payload = parseStrictJson(row.payload_json); } catch { throw new Error('CASE-01 artifact trace contains malformed artifact.created payload'); }
    if (payload?.artifactId === artifact.artifact_id) matches.push({ row, payload });
  }
  if (matches.length !== 1) throw new Error('CASE-01 requires exactly one artifact.created event for each consumed artifact');
  const { row, payload } = matches[0];
  const expectedId = createHash('sha256').update(`${jobId}|artifact.created|${artifact.artifact_id}`).digest('hex');
  if (row.event_id !== expectedId || row.job_id !== jobId || row.type !== 'artifact.created' ||
      row.payload_json !== JSON.stringify(payload) || Object.keys(payload).sort().join(',') !== 'artifactId,contentHash,status,supersedes,taskId,type' ||
      payload.taskId !== artifact.task_id || payload.type !== artifact.type || payload.status !== artifact.status ||
      payload.contentHash !== artifact.content_hash || (payload.supersedes ?? null) !== (artifact.supersedes ?? null)) {
    throw new Error('CASE-01 artifact.created event conflicts with durable artifact metadata');
  }
  return matches[0];
}

function recordCase01ConsumptionAck({ jobId, taskArtifact, ctoArtifact, synthesisResultId, consumedWorkspaceBytes }) {
  if (!Array.isArray(consumedWorkspaceBytes) || consumedWorkspaceBytes.length !== 2) {
    throw new Error('CASE-01 synthesis must provide the exact workspace bytes it consumed');
  }
  const db = workflowStore.db;
  // Serialize all authority reads, content hashes and acknowledgement writes
  // behind one writer reservation. Computing lineage before BEGIN IMMEDIATE
  // allowed a second connection to change a result row after hashing it but
  // before the acknowledgement transaction started.
  db.exec('BEGIN IMMEDIATE');
  try {
  const lockedSourceArtifact = workflowStore.getArtifact(taskArtifact.artifact_id);
  const lockedCtoArtifact = workflowStore.getArtifact(ctoArtifact.artifact_id);
  const sameArtifactSnapshot = (actual, supplied) => actual && supplied &&
    actual.artifact_id === supplied.artifact_id && actual.job_id === supplied.job_id && actual.task_id === supplied.task_id &&
    actual.type === supplied.type && actual.status === supplied.status && actual.content_hash === supplied.content_hash &&
    JSON.stringify(actual.content) === JSON.stringify(supplied.content) &&
    JSON.stringify(actual.evidence) === JSON.stringify(supplied.evidence);
  if (!sameArtifactSnapshot(lockedSourceArtifact, taskArtifact) || !sameArtifactSnapshot(lockedCtoArtifact, ctoArtifact) ||
      lockedSourceArtifact.job_id !== jobId || lockedSourceArtifact.status !== 'active' ||
      lockedSourceArtifact.type !== 'requirements' || lockedSourceArtifact.evidence.length !== 1 ||
      lockedCtoArtifact.job_id !== jobId || lockedCtoArtifact.status !== 'active' || lockedCtoArtifact.type !== 'cto-decision' ||
      lockedCtoArtifact.evidence.length !== 1 || lockedCtoArtifact.evidence[0] !== synthesisResultId) {
    throw new Error('CASE-01 acknowledgement source/CTO artifacts changed or lost exact active result binding before the writer reservation');
  }
  const sourceTaskState = db.prepare('SELECT task_id,job_id,status FROM tasks WHERE task_id=?').get(lockedSourceArtifact.task_id);
  const ctoTaskState = db.prepare('SELECT task_id,job_id,status FROM tasks WHERE task_id=?').get(lockedCtoArtifact.task_id);
  if (!sourceTaskState || sourceTaskState.job_id !== jobId || sourceTaskState.status !== 'completed' ||
      !ctoTaskState || ctoTaskState.job_id !== jobId || ctoTaskState.status !== 'completed') {
    throw new Error('CASE-01 acknowledgement requires both source and CTO tasks to remain durably completed under the writer reservation');
  }
  const verified = readVerifiedCase01WorkspaceSnapshot({
    content: taskArtifact.content, snapshotBase: CASE01_SNAPSHOT_BASE,
    snapshotId: taskArtifact.content.workspace_snapshot_id
  });
  const consumed = consumedWorkspaceBytes.map((entry, index) => {
    const expected = verified.workspace_artifacts[index];
    if (!entry || entry.path !== expected.path || entry.encoding !== 'base64' || typeof entry.bytes !== 'string' ||
        entry.bytes !== expected.bytes_base64 || entry.sha256 !== expected.sha256 ||
        Buffer.from(entry.bytes, 'base64').toString('base64') !== entry.bytes) {
      throw new Error(`CASE-01 consumed bytes do not match the verified snapshot at ${expected.path}`);
    }
    const bytes = Buffer.from(entry.bytes, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.sha256) throw new Error(`CASE-01 consumer buffer digest mismatch at ${entry.path}`);
    return { path: entry.path, sha256: digest, size_bytes: bytes.length };
  });
  const manifest = JSON.stringify(consumed);
  const consumedDigest = createHash('sha256').update(manifest).digest('hex');
  const verifiedManifest = JSON.stringify(verified.workspace_artifacts.map(entry => ({
    path: entry.path, sha256: entry.sha256, size_bytes: Buffer.from(entry.bytes_base64, 'base64').length
  })));
  const verifiedDigest = createHash('sha256').update(verifiedManifest).digest('hex');
  if (verifiedDigest !== consumedDigest) throw new Error('CASE-01 consumed manifest differs from the independently re-read verified snapshot manifest');

  const sourceResultId = taskArtifact.evidence?.length === 1 ? taskArtifact.evidence[0] : null;
  const sourceResult = sourceResultId
    ? workflowStore.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=?').get(sourceResultId)
    : null;
  const ctoResult = workflowStore.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=?').get(synthesisResultId);
  if (!sourceResult || sourceResult.task_id !== taskArtifact.task_id || sourceResult.outcome !== 'success' ||
      typeof sourceResult.content !== 'string' || !sourceResult.content.trim() || !ctoResult ||
      ctoResult.task_id !== ctoArtifact.task_id || ctoResult.outcome !== 'success' ||
      typeof ctoResult.content !== 'string' || !ctoResult.content.trim()) {
    throw new Error('CASE-01 downstream acknowledgement requires both exact successful source and CTO result rows');
  }
  const sourceCompletion = sourceResultId ? case01CompletionEvent(jobId, sourceResultId) : null;
  const ctoCompletion = case01CompletionEvent(jobId, synthesisResultId);
  const sourceAttempt = sourceCompletion?.payload?.attemptId
    ? workflowStore.db.prepare("SELECT attempt_id, task_id, status FROM attempts WHERE attempt_id=? AND task_id=?").get(sourceCompletion.payload.attemptId, taskArtifact.task_id) : null;
  const ctoAttempt = ctoCompletion?.payload?.attemptId
    ? workflowStore.db.prepare("SELECT attempt_id, task_id, status FROM attempts WHERE attempt_id=? AND task_id=?").get(ctoCompletion.payload.attemptId, ctoArtifact.task_id) : null;
  const sourceArtifactEvent = case01ArtifactEvent(jobId, taskArtifact);
  const ctoArtifactEvent = case01ArtifactEvent(jobId, ctoArtifact);
  if (!sourceCompletion || !ctoCompletion || sourceCompletion.payload.taskId !== taskArtifact.task_id ||
      ctoCompletion.payload.taskId !== ctoArtifact.task_id || sourceCompletion.payload.executor !== 'chat-on-steroids-plugin' ||
      ctoCompletion.payload.executor !== 'chat-on-steroids-plugin' || sourceAttempt?.status !== 'completed' || ctoAttempt?.status !== 'completed') {
    throw new Error('CASE-01 consumed bytes lack exact source/CTO task, result, attempt and completion-event lineage');
  }
  const lineage = {
    source_task_id: taskArtifact.task_id, source_result_id: sourceResultId, source_artifact_id: taskArtifact.artifact_id,
    source_attempt_id: sourceAttempt.attempt_id, source_completion_event_id: sourceCompletion.row.event_id,
    source_artifact_event_id: sourceArtifactEvent.row.event_id, snapshot_id: verified.snapshot_id,
    cto_task_id: ctoArtifact.task_id, cto_result_id: synthesisResultId, cto_artifact_id: ctoArtifact.artifact_id,
    cto_attempt_id: ctoAttempt.attempt_id, cto_completion_event_id: ctoCompletion.row.event_id,
    cto_artifact_event_id: ctoArtifactEvent.row.event_id, verified_manifest_sha256: verifiedDigest,
    consumed_manifest_sha256: consumedDigest,
    source_result_content_sha256: createHash('sha256').update(Buffer.from(sourceResult.content, 'utf8')).digest('hex'),
    cto_result_content_sha256: createHash('sha256').update(Buffer.from(ctoResult.content, 'utf8')).digest('hex'),
    consumed_files: consumed
  };
  if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CASE01_ACK_LINEAGE_BARRIER_DIR) {
    const barrierDir = path.resolve(process.env.CHAT_ON_STEROIDS_TEST_CASE01_ACK_LINEAGE_BARRIER_DIR);
    const armPath = path.join(barrierDir, `${jobId}.arm`);
    if (fs.existsSync(armPath)) {
      const readyPath = path.join(barrierDir, `${jobId}.lineage-ready`);
      const releasePath = path.join(barrierDir, `${jobId}.release`);
      fs.writeFileSync(readyPath, 'lineage computed before acknowledgement transaction', { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(releasePath)) {
        if (Date.now() >= deadline) throw new Error('test CASE-01 acknowledgement lineage barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }
  const createdAt = new Date().toISOString();
    const prior = db.prepare('SELECT * FROM case01_consumption_acks WHERE job_id=?').get(jobId);
    if (prior) {
      const expected = {
        source_task_id: lineage.source_task_id, source_result_id: lineage.source_result_id,
        source_artifact_id: lineage.source_artifact_id, source_attempt_id: lineage.source_attempt_id,
        snapshot_id: lineage.snapshot_id, cto_task_id: lineage.cto_task_id, cto_result_id: lineage.cto_result_id,
        cto_artifact_id: lineage.cto_artifact_id, cto_attempt_id: lineage.cto_attempt_id,
        verified_manifest_sha256: verifiedDigest, consumed_manifest_sha256: consumedDigest,
        lineage_json: JSON.stringify(lineage)
      };
      for (const [key, value] of Object.entries(expected)) {
        if (prior[key] !== value) throw new Error(`CASE-01 idempotent consumption acknowledgement conflicts at ${key}`);
      }
    } else {
      db.prepare(`INSERT INTO case01_consumption_acks(job_id,source_task_id,source_result_id,source_artifact_id,source_attempt_id,snapshot_id,cto_task_id,cto_result_id,cto_artifact_id,cto_attempt_id,verified_manifest_sha256,consumed_manifest_sha256,lineage_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId, lineage.source_task_id, lineage.source_result_id, lineage.source_artifact_id, lineage.source_attempt_id,
        lineage.snapshot_id, lineage.cto_task_id, lineage.cto_result_id, lineage.cto_artifact_id, lineage.cto_attempt_id, verifiedDigest, consumedDigest, JSON.stringify(lineage), createdAt);
    }
    const payload = { ...lineage, acknowledgement: 'runtime-verified-synthesis-input-bytes', claim_scope: 'submitted bytes match immutable snapshot; does not prove unobservable model cognition' };
    const expectedEventId = createHash('sha256').update(`${jobId}|case01.snapshot_consumption_acknowledged|${synthesisResultId}`).digest('hex');
    const eventId = workflowStore.recordEvent(jobId, 'case01.snapshot_consumption_acknowledged', payload, synthesisResultId);
    const event = db.prepare('SELECT event_id, job_id, type, payload_json FROM events WHERE event_id=?').get(eventId);
    if (eventId !== expectedEventId || !event || event.event_id !== expectedEventId || event.job_id !== jobId ||
        event.type !== 'case01.snapshot_consumption_acknowledged' || event.payload_json !== JSON.stringify(payload)) {
      throw new Error('CASE-01 consumption acknowledgement event identity or exact durable payload conflicts with its lineage');
    }
    db.exec('COMMIT');
    return { snapshot_id: verified.snapshot_id, consumed_manifest_sha256: consumedDigest, acknowledgement: 'durable' };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function validateCase01ConsumptionAck(jobId) {
  const ack = workflowStore.db.prepare('SELECT * FROM case01_consumption_acks WHERE job_id=?').get(jobId);
  if (!ack) throw new Error('durable CASE-01 downstream consumption acknowledgement is missing');
  const source = workflowStore.getArtifact(ack.source_artifact_id);
  const cto = workflowStore.getArtifact(ack.cto_artifact_id);
  if (!source || !cto || source.job_id !== jobId || cto.job_id !== jobId || source.status !== 'active' || cto.status !== 'active' ||
      source.task_id !== ack.source_task_id || cto.task_id !== ack.cto_task_id || source.type !== 'requirements' || cto.type !== 'cto-decision' ||
      source.content?.workspace_snapshot_id !== ack.snapshot_id || cto.content?.workspace_snapshot_id !== ack.snapshot_id ||
      JSON.stringify(source.content?.workspace_artifacts) !== JSON.stringify(cto.content?.workspace_artifacts)) {
    throw new Error('durable CASE-01 consumption acknowledgement no longer matches source/CTO artifacts');
  }
  const verified = readVerifiedCase01WorkspaceSnapshot({ content: source.content, snapshotBase: CASE01_SNAPSHOT_BASE, snapshotId: ack.snapshot_id });
  const files = verified.workspace_artifacts.map(entry => ({
    path: entry.path, sha256: createHash('sha256').update(Buffer.from(entry.bytes_base64, 'base64')).digest('hex'),
    size_bytes: Buffer.from(entry.bytes_base64, 'base64').length
  }));
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  if (digest !== ack.verified_manifest_sha256 || digest !== ack.consumed_manifest_sha256) {
    throw new Error('durable CASE-01 consumption digest does not match actual recovered snapshot bytes');
  }
  const lineage = parseStrictJson(ack.lineage_json);
  if (ack.lineage_json !== JSON.stringify(lineage)) {
    throw new Error('durable CASE-01 consumption acknowledgement lineage JSON is non-canonical or contains duplicate decoded keys');
  }
  const expectedLineageKeys = 'consumed_files,consumed_manifest_sha256,cto_artifact_event_id,cto_artifact_id,cto_attempt_id,cto_completion_event_id,cto_result_content_sha256,cto_result_id,cto_task_id,snapshot_id,source_artifact_event_id,source_artifact_id,source_attempt_id,source_completion_event_id,source_result_content_sha256,source_result_id,source_task_id,verified_manifest_sha256';
  if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage) || Object.keys(lineage).sort().join(',') !== expectedLineageKeys ||
      !/^[a-f0-9]{64}$/.test(lineage.source_result_content_sha256 || '') || !/^[a-f0-9]{64}$/.test(lineage.cto_result_content_sha256 || '')) {
    throw new Error('durable CASE-01 consumption acknowledgement lineage schema or result-byte digests are invalid');
  }
  const sourceResult = workflowStore.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=?').get(ack.source_result_id);
  const ctoResult = workflowStore.db.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=?').get(ack.cto_result_id);
  if (!sourceResult || sourceResult.result_id !== ack.source_result_id || sourceResult.task_id !== ack.source_task_id ||
      sourceResult.outcome !== 'success' || typeof sourceResult.content !== 'string' || !sourceResult.content.trim() ||
      !ctoResult || ctoResult.result_id !== ack.cto_result_id || ctoResult.task_id !== ack.cto_task_id ||
      ctoResult.outcome !== 'success' || typeof ctoResult.content !== 'string' || !ctoResult.content.trim() ||
      lineage.source_result_content_sha256 !== createHash('sha256').update(Buffer.from(sourceResult.content, 'utf8')).digest('hex') ||
      lineage.cto_result_content_sha256 !== createHash('sha256').update(Buffer.from(ctoResult.content, 'utf8')).digest('hex')) {
    throw new Error('durable CASE-01 consumption acknowledgement no longer matches exact successful source/CTO result bytes');
  }
  const exact = {
    source_task_id: ack.source_task_id, source_result_id: ack.source_result_id, source_artifact_id: ack.source_artifact_id,
    source_attempt_id: ack.source_attempt_id, snapshot_id: ack.snapshot_id, cto_task_id: ack.cto_task_id,
    cto_result_id: ack.cto_result_id, cto_artifact_id: ack.cto_artifact_id, cto_attempt_id: ack.cto_attempt_id,
    verified_manifest_sha256: ack.verified_manifest_sha256, consumed_manifest_sha256: ack.consumed_manifest_sha256
  };
  for (const [key, value] of Object.entries(exact)) if (lineage[key] !== value) throw new Error(`durable CASE-01 consumption lineage mismatch at ${key}`);
  if (JSON.stringify(lineage.consumed_files) !== JSON.stringify(files)) throw new Error('durable CASE-01 consumed file manifest differs from recovered bytes');
  const sourceCompletion = case01CompletionEvent(jobId, ack.source_result_id);
  const ctoCompletion = case01CompletionEvent(jobId, ack.cto_result_id);
  const sourceAttempt = workflowStore.db.prepare("SELECT attempt_id, task_id, status FROM attempts WHERE attempt_id=? AND task_id=?").get(ack.source_attempt_id, ack.source_task_id);
  const ctoAttempt = workflowStore.db.prepare("SELECT attempt_id, task_id, status FROM attempts WHERE attempt_id=? AND task_id=?").get(ack.cto_attempt_id, ack.cto_task_id);
  if (sourceCompletion.row.event_id !== lineage.source_completion_event_id || ctoCompletion.row.event_id !== lineage.cto_completion_event_id ||
      sourceCompletion.payload.taskId !== ack.source_task_id || ctoCompletion.payload.taskId !== ack.cto_task_id ||
      sourceCompletion.payload.executor !== 'chat-on-steroids-plugin' || ctoCompletion.payload.executor !== 'chat-on-steroids-plugin' ||
      sourceCompletion.payload.attemptId !== ack.source_attempt_id || ctoCompletion.payload.attemptId !== ack.cto_attempt_id ||
      sourceAttempt?.status !== 'completed' || ctoAttempt?.status !== 'completed') {
    throw new Error('durable CASE-01 consumption acknowledgement completion-event or attempt lineage is invalid');
  }
  const sourceArtifactEvent = case01ArtifactEvent(jobId, source);
  const ctoArtifactEvent = case01ArtifactEvent(jobId, cto);
  if (sourceArtifactEvent.row.event_id !== lineage.source_artifact_event_id || ctoArtifactEvent.row.event_id !== lineage.cto_artifact_event_id) {
    throw new Error('durable CASE-01 consumption acknowledgement artifact-event lineage is invalid');
  }
  const ackRows = workflowStore.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type='case01.snapshot_consumption_acknowledged'").all(jobId);
  if (ackRows.length !== 1) throw new Error('CASE-01 consumption trace must contain exactly one acknowledgement event for the workflow');
  const ackEvent = ackRows[0];
  let payload;
  try { payload = parseStrictJson(ackEvent.payload_json); } catch { throw new Error('CASE-01 consumption trace contains malformed acknowledgement payload'); }
  const expectedPayload = {
    ...lineage,
    acknowledgement: 'runtime-verified-synthesis-input-bytes',
    claim_scope: 'submitted bytes match immutable snapshot; does not prove unobservable model cognition'
  };
  if (Object.keys(payload).sort().join(',') !== Object.keys(expectedPayload).sort().join(',')) {
    throw new Error('CASE-01 acknowledgement event contains missing or unknown lineage fields');
  }
  const expectedEventId = createHash('sha256').update(`${jobId}|case01.snapshot_consumption_acknowledged|${ack.cto_result_id}`).digest('hex');
  if (ackEvent.event_id !== expectedEventId || ackEvent.job_id !== jobId || ackEvent.type !== 'case01.snapshot_consumption_acknowledged' ||
      ackEvent.payload_json !== JSON.stringify(expectedPayload)) {
    throw new Error('CASE-01 consumption acknowledgement event does not exactly match durable acknowledgement lineage');
  }
  return true;
}

function case01ReferencedSnapshotIds() {
  return collectCase01SnapshotReferences(workflowStore.db.prepare('SELECT content FROM artifacts').all());
}

// Serialize the durable-reference decision and filesystem compensation with
// every other SQLite writer. A plain SELECT followed by unlink is not safe:
// another writer could publish a reference after the SELECT and before the
// snapshot is removed. SQLite cannot make the filesystem atomic, but holding
// the writer reservation closes that database interleaving window. If the
// reference set cannot be read or cleanup fails, leave the reservation and
// bytes in place for conservative restart reconciliation.
function compensateCase01SnapshotIfUnreferenced(snapshotBase, snapshotId) {
  workflowStore.db.exec('BEGIN IMMEDIATE');
  try {
    const referenced = case01ReferencedSnapshotIds();
    if (referenced.has(snapshotId)) {
      workflowStore.db.prepare('DELETE FROM case01_snapshot_reservations WHERE snapshot_id=?').run(snapshotId);
      workflowStore.db.exec('COMMIT');
      return { removed: false, referenced: true };
    }
    removeCase01WorkspaceSnapshot({ snapshotBase, snapshotId });
    workflowStore.db.prepare('DELETE FROM case01_snapshot_reservations WHERE snapshot_id=?').run(snapshotId);
    workflowStore.db.exec('COMMIT');
    return { removed: true, referenced: false };
  } catch (error) {
    try { workflowStore.db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) < 1) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function reconcileCase01SnapshotStore() {
  // Serialize durable reference/reservation reads with SQLite writers. Without
  // this transaction, reconciliation could read no reference, then observe a
  // reservation already deleted by a just-committed completion, and collect a
  // now-referenced directory using the stale reference set. BEGIN IMMEDIATE
  // prevents completion from committing between the reads and filesystem sweep.
  workflowStore.db.exec('BEGIN IMMEDIATE');
  try {
    const artifactRows = workflowStore.db.prepare('SELECT content FROM artifacts').all();
    // A durable artifact reference is a promise that its finalized snapshot
    // still exists and hashes correctly. Verify that promise before recovery
    // can collect anything; missing or tampered bytes fail closed, even when
    // the snapshot base itself has disappeared.
    const referenced = validateCase01DurableSnapshotReferences({
      artifactRows,
      snapshotBase: CASE01_SNAPSHOT_BASE,
    });
    let baseExists = true;
    try { fs.lstatSync(CASE01_SNAPSHOT_BASE); }
    catch (error) { if (error?.code === 'ENOENT') baseExists = false; else throw error; }
    if (!baseExists) {
      workflowStore.db.exec('COMMIT');
      return { removed: [], preserved: [], errors: [] };
    }

    const reservations = workflowStore.db.prepare('SELECT snapshot_id, owner_pid, created_at FROM case01_snapshot_reservations').all();
    const now = Date.now();
    for (const reservation of reservations) {
      const createdAt = Date.parse(reservation.created_at);
      const staleEnough = Number.isFinite(createdAt) && now - createdAt >= 60_000;
      if (processIsAlive(reservation.owner_pid) || !staleEnough) continue;
      if (referenced.has(reservation.snapshot_id)) {
        workflowStore.db.prepare('DELETE FROM case01_snapshot_reservations WHERE snapshot_id=?').run(reservation.snapshot_id);
        continue;
      }
      try {
        removeCase01WorkspaceSnapshot({ snapshotBase: CASE01_SNAPSHOT_BASE, snapshotId: reservation.snapshot_id });
        workflowStore.db.prepare('DELETE FROM case01_snapshot_reservations WHERE snapshot_id=?').run(reservation.snapshot_id);
      } catch (error) {
        process.stderr.write(`[case01-snapshot-recovery] preserved ${reservation.snapshot_id}: ${String(error?.message || error)}\n`);
      }
    }
    const liveReservations = workflowStore.db.prepare('SELECT snapshot_id FROM case01_snapshot_reservations').all().map(row => row.snapshot_id);
    const result = reconcileCase01WorkspaceSnapshots({
      snapshotBase: CASE01_SNAPSHOT_BASE,
      referencedSnapshotIds: [...referenced],
      reservedSnapshotIds: liveReservations,
      minOrphanAgeMs: 60 * 60 * 1000
    });
    for (const failure of result.errors) process.stderr.write(`[case01-snapshot-recovery] cleanup failed for ${failure.snapshot_id}: ${failure.error}\n`);
    workflowStore.db.exec('COMMIT');
    return result;
  } catch (error) {
    try { workflowStore.db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

// Reservations are committed before any snapshot bytes are created. A crash
// therefore leaves either a discoverable reservation or an untracked legacy
// directory subject to the conservative orphan grace period.
reconcileCase01SnapshotStore();
const case01SnapshotRecoveryTimer = setInterval(() => {
  try { reconcileCase01SnapshotStore(); }
  catch (error) { process.stderr.write(`[case01-snapshot-recovery] reconciliation failed: ${String(error?.message || error)}\n`); }
}, 60_000);
case01SnapshotRecoveryTimer.unref?.();

const executionManager = new ExecutionManager(workflowStore, {
  executionTmpDir: process.env.EXECUTION_TMP_DIR
});

const WORKFLOWS = Object.freeze({
  'standard-engineering': { titlePrefix: 'Software Development', description: 'Local software delivery with product, research, architecture, implementation, security, QA, platform, writing, and review tasks.' },
  engineering: { titlePrefix: 'Engineering M4', description: 'Local engineering workflow with requirements, research, architecture, implementation, security, QA, platform, documentation, and evidence-bound review.' },
  production: { titlePrefix: 'Production E2E', description: 'Local production acceptance workflow. Does not provision or dispatch any remote runner.' }
});

const TOOL_DEFS = [
  { name: 'orchestrator_health', description: 'Check local plugin, SQLite storage, active workflow counts, and local execution readiness. Never probes a remote service.', inputSchema: { type: 'object', properties: {} } },
  { name: 'workflow_catalog', description: 'List supported local workflow templates and their purposes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'workflow_create', description: 'Create a durable local workflow proposal. Creation does not approve or execute it.', inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 180 }, task: { type: 'string', minLength: 1, maxLength: 12000 }, workflow: { type: 'string', enum: Object.keys(WORKFLOWS), default: 'standard-engineering' }, workspace: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['title', 'task'] } },
  { name: 'workflow_list', description: 'List active workflows from local SQLite.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
  { name: 'workflow_get', description: 'Inspect a local workflow, immutable plan, task states, artifact metadata, and current phase without exposing full stored result bodies.', inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 } }, required: ['job_id'] } },
  { name: 'workflow_approve', description: 'Explicitly approve the current immutable local workflow proposal and compile its plan. This is a state-changing approval.', inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 }, confirmation: { type: 'string', minLength: 3, maxLength: 2000 } }, required: ['job_id', 'confirmation'] } },
  { name: 'workflow_dispatch', description: 'Start the approved workflow in the local orchestrator and create its durable CTO task. Does not contact a cloud provider or spawn remote workers.', inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 } }, required: ['job_id'] } },
  { name: 'workflow_prepare_tasks', description: 'Create or recover the immutable plan’s local child tasks under the dispatched workflow. Safe to repeat.', inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 } }, required: ['job_id'] } },
  { name: 'workflow_next_task', description: 'Return the next dependency-ready task, its role-specific contract, and completed predecessor results with typed artifact evidence. After completing that task, call this tool again. A blocked stage requires investigation/rework; do not report success. Non-deterministic tasks are marked running durably; deterministic tasks must use task_execute_local.', inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 } }, required: ['job_id'] } },
  { name: 'workflow_complete_task', description: 'Persist the real result and typed artifact of a non-deterministic local specialist task. Requires that the task was issued by workflow_next_task; deterministic tasks must use task_execute_local.', inputSchema: { type: 'object', properties: { task_id: { type: 'string', minLength: 1 }, content: { type: 'string', minLength: 1, maxLength: 1000000 }, artifact: { type: 'object' }, outcome: { type: 'string', enum: ['success', 'failed'], default: 'success' } }, required: ['task_id', 'content', 'artifact'] } },
  { name: 'task_execute_local', description: 'Execute an immutable deterministic task locally using its approved structured executable/arguments and workspace. No arbitrary command or remote execution is accepted.', inputSchema: { type: 'object', additionalProperties: false, properties: { task_id: { type: 'string', minLength: 1 }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 } }, required: ['task_id'] } },
  { name: 'workflow_complete_synthesis', description: 'Record the final synthesis and typed CTO decision artifact, then terminalize a local workflow only after every required child has durable successful evidence. CASE-01 also requires the exact base64 workspace bytes consumed by synthesis.', inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 }, content: { type: 'string', minLength: 1, maxLength: 1000000 }, artifact: { type: 'object' }, consumed_workspace_bytes: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', enum: ['config.json', 'result.json'] }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, encoding: { type: 'string', enum: ['base64'] }, bytes: { type: 'string', maxLength: 2000000 } }, required: ['path', 'sha256', 'encoding', 'bytes'] } } }, required: ['job_id', 'content', 'artifact'] } },
  { name: 'workflow_events', description: 'Read a workflow’s durable event history and observability summary.', inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['job_id'] } },
  { name: 'workflow_artifacts', description: 'List durable artifacts for a local workflow. Content is redacted and bounded for safe context delivery.', inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 } }, required: ['job_id'] } },
  { name: 'workflow_e2e_run', description: 'Advance an already-approved local workflow through safe deterministic tasks only. Never approves, fabricates specialist results, or self-approves synthesis.', inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 }, max_tasks: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['job_id'] } },
  { name: 'workflow_recovery_verify', description: 'Verify persisted workflow invariants and independently read the same SQLite database from a fresh Node process. Does not prove runtime correctness or supervisor restart.', inputSchema: { type: 'object', properties: { job_id: { type: 'string', minLength: 1 } }, required: ['job_id'] } },
  { name: 'workflow_record_intervention', description: 'Durably record a manual intervention/workaround to inform future automation. Does not alter workflow approval or security policy.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, task_id: { type: 'string' }, actor: { type: 'string' }, reason: { type: 'string', minLength: 1 }, workaround: { type: 'string', minLength: 1 }, proposed_automation: { type: 'string' }, duration_minutes: { type: 'number', minimum: 0 } }, required: ['reason', 'workaround'] } },
  { name: 'workflow_interventions', description: 'List recorded manual interventions, optionally filtered by workflow.', inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } } },
  { name: 'workflow_validate_artifact', description: 'Validate an artifact against the typed schema for a known artifact type and optionally a task role.', inputSchema: { type: 'object', properties: { artifact_type: { type: 'string', minLength: 1 }, artifact: { type: 'object' }, role: { type: 'string' } }, required: ['artifact_type', 'artifact'] } },
  { name: 'workflow_access_diagnostics', description: 'Read-only diagnostics for local trust/config clues relevant to CHAT_NOT_TRUSTED. Never bypasses or changes trust policy.', inputSchema: { type: 'object', properties: {} } },
  { name: 'custom_role_create', description: 'Create version 1 of a durable custom role definition. Definitions do not alter workflow execution or grant runtime permissions.', inputSchema: { type: 'object', additionalProperties: false, properties: { role_id: customRoles.customRoleSchema().role_id, name: customRoles.customRoleSchema().name, description: customRoles.customRoleSchema().description, system_prompt: customRoles.customRoleSchema().system_prompt, input_contract: customRoles.customRoleSchema().input_contract, output_artifact_type: customRoles.customRoleSchema().output_artifact_type, allowed_capabilities: customRoles.customRoleSchema().allowed_capabilities, permissions: customRoles.customRoleSchema().permissions, allowed_tools: customRoles.customRoleSchema().allowed_tools }, required: ['role_id', 'name', 'description', 'system_prompt', 'input_contract', 'output_artifact_type'] } },
  { name: 'custom_role_update', description: 'Create a new immutable version of an existing custom role; omitted fields retain the latest values.', inputSchema: { type: 'object', additionalProperties: false, properties: { role_id: customRoles.customRoleSchema().role_id, name: customRoles.customRoleSchema().name, description: customRoles.customRoleSchema().description, system_prompt: customRoles.customRoleSchema().system_prompt, input_contract: customRoles.customRoleSchema().input_contract, output_artifact_type: customRoles.customRoleSchema().output_artifact_type, allowed_capabilities: customRoles.customRoleSchema().allowed_capabilities, permissions: customRoles.customRoleSchema().permissions, allowed_tools: customRoles.customRoleSchema().allowed_tools }, required: ['role_id'] } },
  { name: 'custom_role_get', description: 'Read the latest or a specific immutable version of a custom role.', inputSchema: { type: 'object', additionalProperties: false, properties: { role_id: customRoles.customRoleSchema().role_id, version: { type: 'integer', minimum: 1 } }, required: ['role_id'] } },
  { name: 'custom_role_list', description: 'List latest custom role definitions or all stored versions.', inputSchema: { type: 'object', additionalProperties: false, properties: { include_versions: { type: 'boolean', default: false }, limit: { type: 'integer', minimum: 1, maximum: 200 } } } },
  { name: 'custom_role_clone', description: 'Clone a custom role into a new role ID, creating version 1 with independently stored fields.', inputSchema: { type: 'object', additionalProperties: false, properties: { source_role_id: customRoles.customRoleSchema().role_id, role_id: customRoles.customRoleSchema().role_id, name: customRoles.customRoleSchema().name, description: customRoles.customRoleSchema().description, system_prompt: customRoles.customRoleSchema().system_prompt, input_contract: customRoles.customRoleSchema().input_contract, output_artifact_type: customRoles.customRoleSchema().output_artifact_type, allowed_capabilities: customRoles.customRoleSchema().allowed_capabilities, permissions: customRoles.customRoleSchema().permissions, allowed_tools: customRoles.customRoleSchema().allowed_tools }, required: ['source_role_id', 'role_id'] } },
  { name: 'custom_workflow_create', description: 'Create version 1 of a validated custom workflow definition. Does not execute it.', inputSchema: { type: 'object', additionalProperties: false, properties: { workflow_id: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 80 }, name: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string', minLength: 1, maxLength: 2000 }, input_contract: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', enum: ['job.request', ...customRoles.CUSTOM_ROLE_ARTIFACT_TYPES] } }, tasks: { type: 'array', minItems: 1, maxItems: 32, items: customWorkflows.customWorkflowTaskSchema() } }, required: ['workflow_id', 'name', 'description', 'input_contract', 'tasks'] } },
  { name: 'custom_workflow_update', description: 'Create a new immutable version of a custom workflow definition; provide the complete new definition.', inputSchema: { type: 'object', additionalProperties: false, properties: { workflow_id: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 80 }, name: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string', minLength: 1, maxLength: 2000 }, input_contract: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', enum: ['job.request', ...customRoles.CUSTOM_ROLE_ARTIFACT_TYPES] } }, tasks: { type: 'array', minItems: 1, maxItems: 32, items: customWorkflows.customWorkflowTaskSchema() } }, required: ['workflow_id', 'name', 'description', 'input_contract', 'tasks'] } },
  { name: 'custom_workflow_get', description: 'Read the latest or a specific immutable version of a custom workflow definition.', inputSchema: { type: 'object', additionalProperties: false, properties: { workflow_id: { type: 'string', maxLength: 80 }, version: { type: 'integer', minimum: 1 } }, required: ['workflow_id'] } },
  { name: 'custom_workflow_list', description: 'List custom workflow definitions, optionally including all versions.', inputSchema: { type: 'object', additionalProperties: false, properties: { include_versions: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 200 } } } },
  { name: 'custom_workflow_clone', description: 'Clone a custom workflow into a new workflow ID. Cloned tasks retain pinned custom-role versions.', inputSchema: { type: 'object', additionalProperties: false, properties: { source_workflow_id: { type: 'string', maxLength: 80 }, workflow_id: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$', maxLength: 80 }, name: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string', minLength: 1, maxLength: 2000 }, input_contract: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', enum: ['job.request', ...customRoles.CUSTOM_ROLE_ARTIFACT_TYPES] } }, tasks: { type: 'array', minItems: 1, maxItems: 32, items: customWorkflows.customWorkflowTaskSchema() } }, required: ['source_workflow_id', 'workflow_id'] } },
  { name: 'custom_workflow_preview', description: 'Build and persist an immutable custom workflow plan preview with pinned role versions, validated dependencies, and a hash. Does not execute.', inputSchema: { type: 'object', additionalProperties: false, properties: { workflow_id: { type: 'string', maxLength: 80 }, version: { type: 'integer', minimum: 1 } }, required: ['workflow_id'] } },
  { name: 'custom_workflow_approve', description: 'Record explicit approval for a specific immutable custom workflow preview. A separate workflow_approve call is required before execution.', inputSchema: { type: 'object', additionalProperties: false, properties: { plan_id: { type: 'string', minLength: 1, maxLength: 120 }, confirmation: { type: 'string', minLength: 3, maxLength: 2000 } }, required: ['plan_id', 'confirmation'] } },
  { name: 'custom_workflow_run_create', description: 'Create a local execution proposal from an already-approved immutable custom workflow preview. A separate workflow_approve call is still required before dispatch.', inputSchema: { type: 'object', additionalProperties: false, properties: { plan_id: { type: 'string', minLength: 1, maxLength: 120 }, title: { type: 'string', minLength: 1, maxLength: 180 }, request: { type: 'string', minLength: 1, maxLength: 12000 }, workspace: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['plan_id', 'title', 'request'] } }
];

// Every public tool input is a versioned contract. Unless a root-level schema
// explicitly opts into extension fields, publish and enforce a closed object
// boundary. Nested free-form artifact payloads remain open where their own
// schema says `type: object`; this closes only undocumented top-level tool args.
for (const tool of TOOL_DEFS) {
  if (tool.inputSchema?.type === 'object' && !Object.hasOwn(tool.inputSchema, 'additionalProperties')) {
    tool.inputSchema.additionalProperties = false;
  }
}

workflowStore.db.exec(`CREATE TABLE IF NOT EXISTS manual_interventions (
  intervention_id TEXT PRIMARY KEY, job_id TEXT, task_id TEXT, actor TEXT NOT NULL,
  reason TEXT NOT NULL, workaround TEXT NOT NULL, proposed_automation TEXT,
  duration_minutes REAL, created_at TEXT NOT NULL
); CREATE INDEX IF NOT EXISTS idx_manual_interventions_job_created ON manual_interventions(job_id, created_at);`);

function assertString(value, field, max = 12000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return value.trim();
}

function assertOnlyKeys(value, allowed, label) {
  const unsupported = Object.keys(value || {}).filter(key => !allowed.includes(key));
  if (unsupported.length) throw new Error(`${label} contains unsupported input fields: ${unsupported.join(', ')}`);
}

function isPlainRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

// The published MCP inputSchema is an executable boundary contract, not merely
// documentation for a client-side validator. Enforce the JSON Schema subset
// used by TOOL_DEFS before any handler can coerce or persist caller values.
function validateSchemaValue(value, schema, label, errors) {
  const type = schema?.type;
  const typeMatches = type === undefined ||
    (type === 'object' && isPlainRecord(value)) ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) ||
    (type === 'number' && typeof value === 'number' && Number.isFinite(value));
  if (!typeMatches) {
    errors.push(`${label} must be ${type || 'a valid value'}`);
    return;
  }
  if (schema.enum && !schema.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) {
    errors.push(`${label} must be one of the declared enum values`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${label} is shorter than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${label} exceeds ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern)).test(value)) errors.push(`${label} does not match the required pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${label} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${label} exceeds ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${label} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${label} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => validateSchemaValue(item, schema.items, `${label}[${index}]`, errors));
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${label} has fewer than ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${label} has more than ${schema.maxProperties} properties`);
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`${label}.${required} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) validateSchemaValue(value[key], child, `${label}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of keys) if (!Object.hasOwn(schema.properties || {}, key)) errors.push(`${label}.${key} is not allowed`);
    }
  }
}

function validateToolArguments(name, args) {
  const definition = TOOL_DEFS.find(tool => tool.name === name);
  if (!definition) throw new Error(`unknown tool: ${name}`);
  if (!isPlainRecord(args)) throw new Error(`${name} arguments must be an object`);
  const errors = [];
  const inputSchema = definition.inputSchema || {};
  validateSchemaValue(args, { ...inputSchema, type: inputSchema.type || 'object' }, `${name} arguments`, errors);
  if (errors.length) throw new Error(`invalid arguments for ${name}: ${errors[0]}`);
}

function terminalizeFailedWorkflow(jobId, failedTasks) {
  const job = workflowStore.getJob(jobId);
  if (!job || job.state !== 'EXECUTING') return { terminalized: false, reason: 'workflow is not executing' };
  const trace = workflowStore.getJobTrace(jobId);
  const tasks = trace?.tasks || [];
  const activeCto = tasks.find(task => task.task_id === job.active_task_id && task.role === 'cto');
  const runningChildren = tasks.filter(task => task.parent_task_id === activeCto?.task_id && task.status === 'running');
  if (runningChildren.length) return { terminalized: false, reason: 'other specialist tasks are still running' };
  const activeSessions = workflowStore.db.prepare("SELECT session_id, task_id FROM agent_sessions WHERE job_id=? AND state IN ('CREATED','ACTIVE','PAUSED')").all(jobId);
  const runningExecutions = tasks.filter(task => task.execution_status === 'running');
  const activeBatches = workflowStore.db.prepare("SELECT batch_id FROM execution_batches WHERE job_id=? AND status IN ('RUNNING','WAITING')").all(jobId);
  if (activeSessions.length || runningExecutions.length || activeBatches.length) {
    return { terminalized: false, reason: 'live runtime resources must settle before failure terminalization' };
  }
  const ts = new Date().toISOString();
  workflowStore.db.prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE job_id=? AND status='pending'").run(ts, jobId);
  if (activeCto && ['pending', 'running'].includes(activeCto.status)) {
    workflowStore.db.prepare("UPDATE tasks SET status='failed', updated_at=? WHERE task_id=? AND status IN ('pending','running')").run(ts, activeCto.task_id);
  }
  const runtime = workflowStore.getWorkflowRuntimeState(jobId);
  if (runtime && runtime.phase !== 'FAILED') {
    workflowStore.transitionWorkflowPhase(jobId, 'FAILED', {
      event: 'workflow.failed', lastError: 'required specialist task failed',
      payload: { failedTaskIds: failedTasks.map(task => task.task_id) }
    });
  }
  const summary = `Workflow failed because required specialist task(s) failed: ${failedTasks.map(task => `${task.role} (${task.task_id})`).join(', ')}. Pending tasks were cancelled; no successful synthesis was recorded.`;
  const reportId = workflowStore.createReport(jobId, 'failure', summary);
  workflowStore.claimDelivery(jobId, reportId, 'chat-on-steroids-plugin', 'local');
  const terminal = workflowStore.terminalizeJob(jobId, {
    outcome: 'failure', reportId, deliveryChannel: 'chat-on-steroids-plugin', deliveryTarget: 'local', content: summary
  });
  return { terminalized: terminal.job?.status === 'failed', job: terminal.job, report_id: reportId };
}

function jsonObject(raw, field) {
  try { return parseStrictJson(raw || '{}'); } catch { throw new Error(`invalid stored ${field}`); }
}

function redactText(value) {
  return String(value ?? '')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client_secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  return value;
}

function taskArtifactType(task) {
  const metadata = taskMetadata(task);
  if (metadata.output_artifact_type) return metadata.output_artifact_type;
  const plan = workflowStore.getExecutionPlan(task.job_id);
  const spec = plan?.children?.find(item => item.id === metadata.workflow_plan_task_id);
  return spec?.execution?.output_artifact_type || getAgentArtifactType(task.role);
}

function expectedArtifact(task) {
  const type = taskArtifactType(task);
  const schema = artifactSchemaForType(type);
  return { type, schema_version: schema.schema_version, required_content_fields: schema.required_content_fields };
}

function validateReviewerEvidence(jobId, plan, children, reviewerTask = null) {
  const errors = [];
  const reviewerSpec = plan?.children?.find(spec => String(spec.role).toLowerCase() === 'reviewer');
  if (!reviewerSpec) return errors;
  const specsById = new Map(plan.children.map(spec => [spec.id, spec]));
  const ancestors = new Set();
  const collectAncestors = taskId => {
    if (ancestors.has(taskId)) return;
    ancestors.add(taskId);
    const spec = specsById.get(taskId);
    if (!spec) return;
    for (const dependency of spec.dependencies) collectAncestors(dependency);
  };
  for (const dependency of reviewerSpec.dependencies) collectAncestors(dependency);

  const trace = workflowStore.getJobTrace(jobId);
  const requiredArtifactIds = [];
  for (const type of getAgentInputArtifactTypes('reviewer')) {
    const producerSpec = plan.children.find(spec => getAgentArtifactType(spec.role) === type);
    if (!producerSpec) {
      errors.push(`missing planned producer for reviewer input ${type}`);
      continue;
    }
    if (!ancestors.has(producerSpec.id)) {
      errors.push(`reviewer input ${type} producer is not a dependency ancestor (${producerSpec.id})`);
      continue;
    }
    const producer = children.find(task => {
      try { return taskMetadata(task).workflow_plan_task_id === producerSpec.id; }
      catch { return false; }
    });
    if (!producer || producer.status !== 'completed' || producer.role !== producerSpec.role) {
      errors.push(`reviewer input ${type} producer task is not durably completed (${producerSpec.id})`);
      continue;
    }
    const successfulResults = trace.results.filter(result => result.task_id === producer.task_id && result.outcome === 'success');
    if (successfulResults.length !== 1) {
      errors.push(`reviewer input ${type} requires exactly one successful durable result (${producerSpec.id})`);
      continue;
    }
    const result = successfulResults[0];
    const artifacts = workflowStore.listArtifacts(jobId, { taskId: producer.task_id, activeOnly: true, type });
    if (artifacts.length !== 1) {
      errors.push(`reviewer input ${type} requires exactly one active typed artifact (${producerSpec.id})`);
      continue;
    }
    const artifact = artifacts[0];
    try { validateArtifact(artifact); }
    catch (error) {
      errors.push(`reviewer input ${type} artifact failed schema/hash validation (${producerSpec.id}): ${String(error?.message || error).slice(0, 240)}`);
      continue;
    }
    if (artifact.job_id !== jobId || artifact.task_id !== producer.task_id || artifact.producer_role !== producerSpec.role ||
        !Array.isArray(artifact.evidence) || !artifact.evidence.includes(result.result_id)) {
      errors.push(`reviewer input ${type} artifact provenance does not bind its successful producer result (${producerSpec.id})`);
      continue;
    }
    requiredArtifactIds.push(artifact.artifact_id);
  }

  if (reviewerTask?.status === 'completed') {
    const reviewerResults = trace.results.filter(result => result.task_id === reviewerTask.task_id && result.outcome === 'success');
    const reviewArtifacts = workflowStore.listArtifacts(jobId, { taskId: reviewerTask.task_id, activeOnly: true, type: 'review' });
    if (reviewerResults.length !== 1 || reviewArtifacts.length !== 1) {
      errors.push('completed reviewer requires exactly one successful result and one active review artifact');
    } else {
      const reviewArtifact = reviewArtifacts[0];
      try { validateArtifact(reviewArtifact); }
      catch (error) { errors.push(`review artifact failed schema/hash validation: ${String(error?.message || error).slice(0, 240)}`); }
      const requiredEvidence = plan.workflow_version >= 2
        ? [...requiredArtifactIds, reviewerResults[0].result_id]
        : [reviewerResults[0].result_id];
      if (reviewArtifact.job_id !== jobId || reviewArtifact.task_id !== reviewerTask.task_id || reviewArtifact.producer_role !== 'reviewer' ||
          !Array.isArray(reviewArtifact.evidence) || requiredEvidence.some(resultId => !reviewArtifact.evidence.includes(resultId))) {
        errors.push('review artifact evidence does not bind every required producer result and its own successful result');
      }
    }
  }
  return errors;
}

function proposalFor(jobId) {
  const proposal = workflowStore.getCurrentProposal(jobId);
  if (!proposal) throw new Error(`workflow proposal not found: ${jobId}`);
  return proposal.payload || {};
}

function isCase01ArtifactLineage(jobId) {
  return workflowStore.getExecutionPlan(jobId)?.workflow_id === 'custom-case01-artifact-lineage';
}

function validateCase01TaskEvidence(jobId, taskId, artifactContent, artifactId, resultId) {
  const proposal = proposalFor(jobId);
  if (typeof artifactContent?.workspace_snapshot_id !== 'string') throw new Error('CASE-01 task artifact is missing its immutable workspace snapshot identity');
  validateCase01WorkspaceArtifact({ workspace: proposal.workspace, content: artifactContent, snapshotBase: path.join(dataDir, 'case01-snapshots'), snapshotId: artifactContent?.workspace_snapshot_id });
  const artifact = artifactId ? workflowStore.getArtifact(artifactId) : null;
  const task = workflowStore.getTask(taskId);
  const result = workflowStore.db.prepare('SELECT result_id, task_id, outcome FROM results WHERE result_id=?').get(resultId);
  if (!task || task.job_id !== jobId || task.status !== 'completed' || !artifact || artifact.status !== 'active' || artifact.job_id !== jobId || artifact.task_id !== taskId || artifact.type !== 'requirements' ||
      artifact.artifact_id !== `requirements-${resultId}` || artifact.evidence.length !== 1 || artifact.evidence[0] !== resultId ||
      artifact.content?.workspace_snapshot_id !== artifactContent.workspace_snapshot_id ||
      JSON.stringify(artifact.content?.workspace_artifacts) !== JSON.stringify(artifactContent.workspace_artifacts) ||
      !result || result.task_id !== taskId || result.outcome !== 'success') {
    throw new Error('CASE-01 task artifact is not bound to its durable successful task result');
  }
}

function validateCase01SynthesisEvidence(jobId, ctoContent, taskArtifact) {
  const proposal = proposalFor(jobId);
  if (typeof taskArtifact.content?.workspace_snapshot_id !== 'string') throw new Error('CASE-01 task artifact is missing its immutable workspace snapshot identity');
  validateCase01WorkspaceArtifact({ workspace: proposal.workspace, content: ctoContent, taskArtifactId: taskArtifact.artifact_id, snapshotBase: path.join(dataDir, 'case01-snapshots'), snapshotId: taskArtifact.content?.workspace_snapshot_id });
  if (ctoContent?.workspace_snapshot_id !== taskArtifact.content?.workspace_snapshot_id) {
    throw new Error('CASE-01 CTO snapshot identity must exactly match the active task artifact');
  }
  const persistedPairs = taskArtifact.content?.workspace_artifacts;
  if (JSON.stringify(persistedPairs) !== JSON.stringify(ctoContent.workspace_artifacts)) {
    throw new Error('CASE-01 CTO workspace hashes must exactly match the active task artifact');
  }
  const task = workflowStore.getTask(taskArtifact.task_id);
  const resultRefs = taskArtifact.evidence.filter(value => workflowStore.db.prepare('SELECT 1 FROM results WHERE result_id=? AND task_id=? AND outcome=\'success\'').get(value, taskArtifact.task_id));
  const resultId = resultRefs.length === 1 ? resultRefs[0] : null;
  const result = resultId ? workflowStore.db.prepare('SELECT result_id, task_id, outcome FROM results WHERE result_id=?').get(resultId) : null;
  if (taskArtifact.status !== 'active' || taskArtifact.type !== 'requirements' || taskArtifact.job_id !== jobId ||
      taskArtifact.artifact_id !== `requirements-${resultId}` || taskArtifact.evidence.length !== 1 ||
      !task || task.job_id !== jobId || task.status !== 'completed' || !result || result.task_id !== task.task_id || result.outcome !== 'success') {
    throw new Error('CASE-01 synthesis requires a completed task and its durable successful result');
  }
}

function getTasks(jobId) {
  const trace = workflowStore.getJobTrace(jobId);
  if (!trace) throw new Error(`workflow not found: ${jobId}`);
  return trace.tasks;
}

function taskMetadata(task) { return jsonObject(task.metadata_json, 'task metadata'); }

function completedPlanIds(tasks) {
  return new Set(tasks.filter(task => task.status === 'completed').map(task => taskMetadata(task).workflow_plan_task_id).filter(Boolean));
}

function assertDependenciesCompleted(task, tasks) {
  const deps = jsonObject(task.dependency_json, 'task dependencies');
  const done = completedPlanIds(tasks);
  const missing = deps.filter(dependency => !done.has(dependency));
  if (missing.length) throw new Error(`task dependencies are not complete: ${missing.join(', ')}`);
}

function taskSummary(task) {
  const metadata = taskMetadata(task);
  return {
    task_id: task.task_id,
    job_id: task.job_id,
    parent_task_id: task.parent_task_id || null,
    role: task.role,
    description: redactText(task.description),
    status: task.status,
    execution_status: task.execution_status || null,
    execution_exit_code: task.execution_exit_code ?? null,
    execution_session_id: task.execution_session_id ?? null,
    execution_attempt: task.execution_attempt ?? null,
    plan_task_id: metadata.workflow_plan_task_id || null,
    deterministic: metadata.deterministic === true,
    executor: metadata.executor || null,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}

function getWorkflow(jobId) {
  const trace = workflowStore.getJobTrace(jobId);
  if (!trace) throw new Error(`workflow not found: ${jobId}`);
  return {
    job: { ...trace.job, title: redactText(trace.job.title) },
    proposal: redactValue(proposalFor(jobId)),
    runtime: workflowStore.getWorkflowRuntimeState(jobId),
    plan: workflowStore.getExecutionPlan(jobId),
    tasks: trace.tasks.map(taskSummary),
    approvals: trace.approvals.map(row => ({ approval_id: row.approval_id, decision: row.decision, actor: row.actor, proposal_hash: row.proposal_hash, created_at: row.created_at })),
    artifacts: trace.artifacts.map(item => ({ artifact_id: item.artifact_id, task_id: item.task_id, type: item.type, producer_role: item.producer_role, status: item.status, created_at: item.created_at, content_hash: item.content_hash })),
    result_count: trace.results.length,
    event_count: trace.events.length,
    db_path: WORKFLOW_DB_PATH
  };
}

async function callTool(name, args) {
  validateToolArguments(name, args);
  switch (name) {
    case 'orchestrator_health': {
      const stats = workflowStore.getStats();
      return { status: 'ok', mode: 'local-only-mcp', plugin: SERVER_INFO, database: WORKFLOW_DB_PATH, data_directory: dataDir, workspace_default: path.resolve(process.env.WORKFLOW_WORKSPACE), stats, cloud_execution: false, github_actions_dispatch: false, external_model_api: false };
    }
    case 'workflow_catalog':
      return { workflows: Object.entries(WORKFLOWS).map(([id, value]) => ({ id, ...value })) };
    case 'custom_role_create': {
      assertOnlyKeys(args, ['role_id', 'name', 'description', 'system_prompt', 'input_contract', 'output_artifact_type', 'allowed_capabilities', 'permissions', 'allowed_tools'], name);
      const role = customRoles.createCustomRole(workflowStore.db, args);
      return { created: true, role, execution_enabled: true, execution_authorized: false, note: 'Stored definition only; it can be pinned into a custom workflow. Each run still requires explicit plan and workflow approval.' };
    }
    case 'custom_role_update': {
      assertOnlyKeys(args, ['role_id', 'name', 'description', 'system_prompt', 'input_contract', 'output_artifact_type', 'allowed_capabilities', 'permissions', 'allowed_tools'], name);
      const roleId = assertString(args.role_id, 'role_id', 80);
      const role = customRoles.updateCustomRole(workflowStore.db, roleId, args);
      return { updated: true, role, previous_versions_immutable: true, execution_enabled: true, execution_authorized: false, note: 'A new version was stored; earlier versions remain available. Each run still requires explicit plan and workflow approval.' };
    }
    case 'custom_role_get': {
      assertOnlyKeys(args, ['role_id', 'version'], name);
      return { role: customRoles.getCustomRole(workflowStore.db, args.role_id, args.version) };
    }
    case 'custom_role_list': {
      assertOnlyKeys(args, ['include_versions', 'limit'], name);
      if (args.include_versions != null && typeof args.include_versions !== 'boolean') throw new Error('include_versions must be a boolean');
      return { roles: customRoles.listCustomRoles(workflowStore.db, { includeVersions: args.include_versions === true, limit: args.limit }), execution_enabled: true, execution_authorized: false };
    }
    case 'custom_role_clone': {
      assertOnlyKeys(args, ['source_role_id', 'role_id', 'name', 'description', 'system_prompt', 'input_contract', 'output_artifact_type', 'allowed_capabilities', 'permissions', 'allowed_tools'], name);
      const role = customRoles.cloneCustomRole(workflowStore.db, args.source_role_id, args);
      return { cloned: true, role, execution_enabled: true, execution_authorized: false, note: 'Clone is a separate role definition; source versions are unchanged. Each run still requires explicit plan and workflow approval.' };
    }
    case 'custom_workflow_create': {
      assertOnlyKeys(args, ['workflow_id', 'name', 'description', 'input_contract', 'tasks'], name);
      const workflow = customWorkflows.createCustomWorkflow(workflowStore.db, args);
      return { created: true, workflow, execution_enabled: true, execution_authorized: false, note: 'Stored definition only; the Phase 3 execution engine is available after immutable plan approval and separate workflow approval.' };
    }
    case 'custom_workflow_update': {
      assertOnlyKeys(args, ['workflow_id', 'name', 'description', 'input_contract', 'tasks'], name);
      const workflow = customWorkflows.updateCustomWorkflow(workflowStore.db, args.workflow_id, args);
      return { updated: true, workflow, previous_versions_immutable: true, execution_enabled: true, execution_authorized: false };
    }
    case 'custom_workflow_get': {
      assertOnlyKeys(args, ['workflow_id', 'version'], name);
      return { workflow: customWorkflows.getCustomWorkflow(workflowStore.db, args.workflow_id, args.version) };
    }
    case 'custom_workflow_list': {
      assertOnlyKeys(args, ['include_versions', 'limit'], name);
      if (args.include_versions != null && typeof args.include_versions !== 'boolean') throw new Error('include_versions must be a boolean');
      return { workflows: customWorkflows.listCustomWorkflows(workflowStore.db, { includeVersions: args.include_versions === true, limit: args.limit }), execution_enabled: true, execution_authorized: false };
    }
    case 'custom_workflow_clone': {
      assertOnlyKeys(args, ['source_workflow_id', 'workflow_id', 'name', 'description', 'input_contract', 'tasks'], name);
      const workflow = customWorkflows.cloneCustomWorkflow(workflowStore.db, args.source_workflow_id, args);
      return { cloned: true, workflow, execution_enabled: true, execution_authorized: false, note: 'Clone is a separate definition; referenced role versions remain pinned. Each run still requires explicit plan and workflow approval.' };
    }
    case 'custom_workflow_preview': {
      assertOnlyKeys(args, ['workflow_id', 'version'], name);
      const plan = customWorkflows.previewCustomWorkflow(workflowStore.db, args.workflow_id, args.version);
      return { previewed: true, plan, execution_enabled: true, execution_authorized: false, requires_explicit_plan_approval: true };
    }
    case 'custom_workflow_approve': {
      assertOnlyKeys(args, ['plan_id', 'confirmation'], name);
      const confirmation = assertString(args.confirmation, 'confirmation', 2000);
      return customWorkflows.approveCustomWorkflowPlan(workflowStore.db, args.plan_id, confirmation, { approvedBy: 'chat-on-steroids-user' });
    }
    case 'custom_workflow_run_create': {
      assertOnlyKeys(args, ['plan_id', 'title', 'request', 'workspace'], name);
      const planId = assertString(args.plan_id, 'plan_id', 120);
      const title = assertString(args.title, 'title', 180);
      const request = assertString(args.request, 'request', 12000);
      const approvedSpec = customWorkflows.getApprovedCustomWorkflowExecutionSpec(workflowStore.db, planId);
      const workspace = path.resolve(assertString(args.workspace || process.env.WORKFLOW_WORKSPACE || process.cwd(), 'workspace', 2000));
      if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`workspace is not an existing local directory: ${workspace}`);
      const job = workflowStore.createJob({ conversationKey: `chat-on-steroids:custom:${randomUUID()}`, title: `Engineering M4: Custom Workflow: ${title}` });
      workflowStore.recordEvent(job.job_id, 'job.proposal_requested', {
        task: request, workspace, workflowId: 'engineering', executionTarget: 'local',
        customWorkflow: true, customWorkflowPlanId: approvedSpec.plan_id,
        customWorkflowId: approvedSpec.workflow.workflow_id, customWorkflowVersion: approvedSpec.workflow.version,
        customWorkflowPlanHash: approvedSpec.plan_hash
      }, job.job_id);
      return { created: true, job_id: job.job_id, title: job.title, state: job.state, status: job.status, workflow_id: approvedSpec.workflow.workflow_id, workflow_version: approvedSpec.workflow.version, custom_workflow_plan_id: approvedSpec.plan_id, custom_workflow_plan_hash: approvedSpec.plan_hash, workspace, requires_separate_execution_approval: true, execution_enabled: true, execution_authorized: false };
    }
    case 'workflow_create': {
      const title = assertString(args.title, 'title', 180);
      const task = assertString(args.task, 'task', 12000);
      const workflow = String(args.workflow || 'standard-engineering');
      const template = WORKFLOWS[workflow];
      if (!template) throw new Error(`unsupported local workflow: ${workflow}`);
      if (workflow === 'production' && (typeof args.workspace !== 'string' || !args.workspace.trim())) {
        throw new Error('production workflow requires an explicit workspace; the default home directory is not an implicit test target');
      }
      const workspace = path.resolve(assertString(args.workspace || process.env.WORKFLOW_WORKSPACE || process.cwd(), 'workspace', 2000));
      const stat = fs.statSync(workspace, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) throw new Error(`workspace is not an existing local directory: ${workspace}`);
      const job = workflowStore.createJob({ conversationKey: `chat-on-steroids:${randomUUID()}`, title: `${template.titlePrefix}: ${title}` });
      workflowStore.recordEvent(job.job_id, 'job.proposal_requested', { task, workspace, workflowId: workflow, executionTarget: 'local' }, job.job_id);
      return { created: true, job_id: job.job_id, title: job.title, state: job.state, status: job.status, workflow, workspace, requires_explicit_approval: true };
    }
    case 'workflow_list':
      return { workflows: workflowStore.listActiveJobs(args.limit || 50).map(job => ({ ...job, title: redactText(job.title) })), stats: workflowStore.getStats() };
    case 'workflow_get':
      return getWorkflow(assertString(args.job_id, 'job_id', 200));
    case 'workflow_approve': {
      const jobId = assertString(args.job_id, 'job_id', 200);
      const confirmation = assertString(args.confirmation, 'confirmation', 2000);
      const proposal = proposalFor(jobId);
      if (!proposal.workspace || !proposal.workflowId) throw new Error('workflow proposal is missing local workspace metadata');
      const customWorkflow = proposal.customWorkflowPlanId
        ? customWorkflows.getApprovedCustomWorkflowExecutionSpec(workflowStore.db, proposal.customWorkflowPlanId)
        : null;
      if (customWorkflow && (customWorkflow.workflow.workflow_id !== proposal.customWorkflowId || customWorkflow.workflow.version !== proposal.customWorkflowVersion || customWorkflow.plan_hash !== proposal.customWorkflowPlanHash)) {
        throw new Error('approved custom workflow preview no longer matches the execution proposal');
      }
      const job = workflowStore.approve(jobId, confirmation, 'chat-on-steroids-user', { workspace: proposal.workspace, customWorkflow });
      return { approved: true, job_id: jobId, state: job.state, plan: workflowStore.getExecutionPlan(jobId), phase: workflowStore.getWorkflowRuntimeState(jobId)?.phase, execution_enabled: true, execution_authorized: true };
    }
    case 'workflow_dispatch': {
      const jobId = assertString(args.job_id, 'job_id', 200);
      workflowStore.assertApprovalCurrent(jobId);
      const proposal = proposalFor(jobId);
      const task = workflowStore.dispatch(jobId, { role: 'cto', description: proposal.task });
      const attempt = workflowStore.startAttempt(jobId);
      return { dispatched: true, target: 'local', job_id: jobId, task: taskSummary(task), attempt_id: attempt?.attempt_id || null, phase: workflowStore.getWorkflowRuntimeState(jobId)?.phase, next: 'workflow_prepare_tasks', execution_enabled: true, execution_authorized: true };
    }
    case 'workflow_prepare_tasks': {
      const jobId = assertString(args.job_id, 'job_id', 200);
      workflowStore.assertApprovalCurrent(jobId);
      const job = workflowStore.getJob(jobId);
      if (!job || job.state !== 'EXECUTING') throw new Error('workflow must be dispatched before preparing tasks');
      const plan = workflowStore.getExecutionPlan(jobId);
      if (!plan) throw new Error('approved immutable workflow plan is missing');
      const parent = workflowStore.getTask(job.active_task_id);
      if (!parent || String(parent.role).toLowerCase() !== 'cto') throw new Error('active local workflow coordinator task is missing');
      const proposal = proposalFor(jobId);
      const existingTrace = workflowStore.getJobTrace(jobId);
      const tasks = plan.children.map(spec => {
        const existing = existingTrace.tasks.find(task => task.parent_task_id === parent.task_id && taskMetadata(task).workflow_plan_task_id === spec.id);
        if (existing) return existing;
        return workflowStore.createChildTask(jobId, {
          parentTaskId: parent.task_id,
          role: spec.role,
          description: buildRoleTaskDescription(spec, proposal.task),
          dependencies: spec.dependencies,
          metadata: { ...(spec.execution || {}), executionTarget: 'local', capability: spec.capability || null, workflow_plan_task_id: spec.id }
        });
      });
      return { prepared: true, target: 'local', job_id: jobId, parent_task_id: parent.task_id, tasks: tasks.map(taskSummary), count: tasks.length, plan_hash: plan.plan_hash };
    }
    case 'workflow_next_task': {
      const jobId = assertString(args.job_id, 'job_id', 200);
      workflowStore.assertApprovalCurrent(jobId);
      const job = workflowStore.getJob(jobId);
      if (!job || job.state !== 'EXECUTING') throw new Error('workflow is not executing');
      const plan = workflowStore.getExecutionPlan(jobId);
      if (!plan) throw new Error('immutable workflow plan is missing');
      const allTasks = getTasks(jobId);
      const parent = allTasks.find(task => task.task_id === job.active_task_id && task.role === 'cto');
      if (!parent) throw new Error('local coordinator task is missing');
      const children = allTasks.filter(task => task.parent_task_id === parent.task_id);
      if (children.length !== plan.children.length) throw new Error('planned child tasks have not all been prepared; call workflow_prepare_tasks');
      const failed = children.filter(task => ['failed', 'cancelled'].includes(task.status));
      if (failed.length) {
        const terminal = terminalizeFailedWorkflow(jobId, failed);
        return { stage: 'blocked', job_id: jobId, reason: 'one or more specialist tasks failed', failed_tasks: failed.map(taskSummary), terminalized: terminal.terminalized, terminal_reason: terminal.reason || null, job: terminal.job || null, report_id: terminal.report_id || null };
      }
      const running = children.find(task => task.status === 'running' && !task.execution_status);
      if (running) return { stage: 'task', task: taskSummary(running), expected_artifact: expectedArtifact(running), idempotent: true, completed_results: collectCompletedResults(jobId, children, running) };
      const doneIds = completedPlanIds(children);
      const ready = children.find(task => {
        if (task.status !== 'pending') return false;
        const metadata = taskMetadata(task);
        const spec = plan.children.find(item => item.id === metadata.workflow_plan_task_id);
        return spec && spec.dependencies.every(dep => doneIds.has(dep));
      });
      if (ready) {
        if (String(ready.role).toLowerCase() === 'reviewer') {
          const evidenceErrors = validateReviewerEvidence(jobId, plan, children);
          if (evidenceErrors.length) {
            return { stage: 'blocked', job_id: jobId, reason: 'reviewer cannot start because required evidence is missing, invalid, or outside its dependency scope', evidence_errors: evidenceErrors, terminalized: false };
          }
        }
        const metadata = taskMetadata(ready);
        if (metadata.deterministic) {
          if (ready.execution_status === 'running') return { stage: 'blocked', job_id: jobId, reason: 'a prior deterministic local execution is unresolved; inspect durable execution evidence before retrying', task: taskSummary(ready) };
          return { stage: 'local_execution', job_id: jobId, task: taskSummary(ready), execution: { executable: metadata.executable, args: metadata.args, cwd: metadata.cwd, timeout_ms: metadata.timeout_ms }, completed_results: collectCompletedResults(jobId, children, ready), next: 'task_execute_local' };
        }
        const begun = workflowStore.beginLocalTask(ready.task_id);
        return { stage: 'task', job_id: jobId, task: taskSummary(begun.task), expected_artifact: expectedArtifact(begun.task), attempt_id: begun.attempt?.attempt_id || null, completed_results: collectCompletedResults(jobId, children, ready), execution_target: 'local-chat-on-steroids' };
      }
      if (children.every(task => task.status === 'completed')) {
        const reviewerTask = children.find(task => task.role === 'reviewer');
        if (reviewerTask) {
          const evidenceErrors = validateReviewerEvidence(jobId, plan, children, reviewerTask);
          if (evidenceErrors.length) {
            return { stage: 'blocked', job_id: jobId, reason: 'reviewer evidence provenance is incomplete or invalid; CTO synthesis is not permitted', evidence_errors: evidenceErrors, reviewer_task: taskSummary(reviewerTask), terminalized: false };
          }
          const review = workflowStore.listArtifacts(jobId, { taskId: reviewerTask.task_id, activeOnly: true }).find(item => item.type === 'review')?.content;
          const accepted = review?.decision === 'accept' &&
            ['requirementsSatisfied', 'architectureConformant', 'securityAccepted', 'qaAccepted', 'platformAccepted', 'documentationAccepted'].every(field => review[field] === true) &&
            ['implementationIssues', 'evidenceIssues', 'securityIssues', 'blockingIssues'].every(field => Array.isArray(review[field]) && review[field].length === 0);
          if (!accepted) {
            return { stage: 'blocked', job_id: jobId, reason: 'reviewer has not accepted all required evidence; resolve findings and rerun review before CTO synthesis', reviewer_task: taskSummary(reviewerTask), reviewer_artifact: review ? redactValue(review) : null, terminalized: false };
          }
        }
        return { stage: 'synthesis', job_id: jobId, task: taskSummary(parent), expected_artifact: expectedArtifact(parent), required_roles: plan.required_children, completed_results: collectCompletedResults(jobId, children, null), next: 'workflow_complete_synthesis' };
      }
      return { stage: 'blocked', job_id: jobId, reason: 'no dependency-ready task is available', tasks: children.map(taskSummary) };
    }
    case 'workflow_complete_task': {
      const taskId = assertString(args.task_id, 'task_id', 200);
      const content = assertString(args.content, 'content', 1_000_000);
      const task = workflowStore.getTask(taskId);
      if (!task || !task.parent_task_id) throw new Error('task is not a planned local child task');
      const job = workflowStore.getJob(task.job_id);
      if (!job || job.state !== 'EXECUTING') throw new Error('task workflow is not executing');
      workflowStore.assertApprovalCurrent(task.job_id);
      const tasks = getTasks(task.job_id);
      assertDependenciesCompleted(task, tasks);
      let artifactContent = redactValue(args.artifact);
      const outcome = args.outcome || 'success';
      const case01 = isCase01ArtifactLineage(task.job_id) && outcome === 'success';
      let newlyCreatedSnapshotId = null;
      let case01SnapshotBase = null;
      if (case01) {
        const existing = workflowStore.listArtifacts(task.job_id, { taskId, activeOnly: true, type: 'requirements' }).at(-1);
        if (task.status === 'completed' && existing) {
          // Idempotent retries must validate the already persisted immutable snapshot,
          // not create a second snapshot with a different identity.
          artifactContent = existing.content;
        } else {
          case01SnapshotBase = CASE01_SNAPSHOT_BASE;
          try { fs.lstatSync(case01SnapshotBase); }
          catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            fs.mkdirSync(case01SnapshotBase, { mode: 0o700 });
          }
          const snapshotBaseStat = fs.lstatSync(case01SnapshotBase);
          if (!snapshotBaseStat.isDirectory() || snapshotBaseStat.isSymbolicLink()) {
            throw new Error('CASE-01 snapshot base must be a non-symlink directory');
          }
          const stableSnapshotBaseStat = fs.lstatSync(case01SnapshotBase);
          if (!stableSnapshotBaseStat.isDirectory() || stableSnapshotBaseStat.isSymbolicLink() ||
              stableSnapshotBaseStat.dev !== snapshotBaseStat.dev || stableSnapshotBaseStat.ino !== snapshotBaseStat.ino) {
            throw new Error('CASE-01 snapshot base changed during initialization');
          }
          if ((stableSnapshotBaseStat.mode & 0o077) !== 0) {
            throw new Error('CASE-01 snapshot base permissions are too broad; refusing to chmod a path that may be concurrently replaced');
          }
          const snapshotId = randomUUID();
          workflowStore.db.prepare('INSERT INTO case01_snapshot_reservations(snapshot_id, owner_pid, created_at) VALUES(?, ?, ?)')
            .run(snapshotId, process.pid, new Date().toISOString());
          let snapshot;
          try {
            snapshot = createCase01WorkspaceSnapshot({ workspace: proposalFor(task.job_id).workspace, content: artifactContent, snapshotBase: case01SnapshotBase, snapshotId });
          } catch (error) {
            // The reservation predates directory creation. Resolve it only if
            // the helper successfully removed any partial directory; otherwise
            // leave it for crash recovery to retry after this process exits.
            try { compensateCase01SnapshotIfUnreferenced(case01SnapshotBase, snapshotId); }
            catch { /* retain reservation and original creation error */ }
            throw error;
          }
          newlyCreatedSnapshotId = snapshot.snapshot_id;
          artifactContent = { ...artifactContent, workspace_snapshot_id: snapshot.snapshot_id, workspace_artifacts: snapshot.workspace_artifacts };
        }
      }
      let result;
      try {
        result = workflowStore.completeLocalTask(taskId, {
          content: redactText(content), artifact: artifactContent, outcome,
          validateBeforeCommit: case01 ? ({ resultId, artifactId }) => validateCase01TaskEvidence(task.job_id, taskId, artifactContent, artifactId, resultId) : null
        });
      } catch (error) {
        // Filesystem creation precedes SQLite COMMIT, so compensate if the DB
        // transaction rejects. Never delete a snapshot that any durable typed
        // artifact already references (including a commit-then-throw failure).
        if (newlyCreatedSnapshotId) {
          try {
            compensateCase01SnapshotIfUnreferenced(case01SnapshotBase, newlyCreatedSnapshotId);
          } catch (cleanupError) {
            try {
              workflowStore.recordEvent(task.job_id, 'case01.snapshot_cleanup_failed', {
                taskId, snapshotId: newlyCreatedSnapshotId, error: String(cleanupError?.message || cleanupError).slice(0, 500)
              }, `${taskId}|snapshot-cleanup-failed|${newlyCreatedSnapshotId}`);
            } catch { /* preserve the original task failure if the DB is also unavailable */ }
          }
        }
        throw error;
      }
      if (newlyCreatedSnapshotId) {
        // The artifact is now durable. Removing a stale reservation cannot make
        // the snapshot collectible because reconciliation also checks durable
        // artifact references. A failed delete is safe and self-healing.
        try { workflowStore.db.prepare('DELETE FROM case01_snapshot_reservations WHERE snapshot_id=?').run(newlyCreatedSnapshotId); } catch {}
      }
      return { completed: result.task.status === 'completed', task: taskSummary(result.task), result_id: result.resultId || null, idempotent: result.idempotent };
    }
    case 'task_execute_local': {
      assertOnlyKeys(args, ['task_id', 'timeout_ms'], 'task_execute_local');
      const taskId = assertString(args.task_id, 'task_id', 200);
      const task = workflowStore.getTask(taskId);
      if (!task || !task.parent_task_id) throw new Error('task is not a planned local child task');
      const job = workflowStore.getJob(task.job_id);
      if (!job || job.state !== 'EXECUTING') throw new Error('task workflow is not executing');
      workflowStore.assertApprovalCurrent(task.job_id);
      const proposal = proposalFor(task.job_id);
      const tasks = getTasks(task.job_id);
      assertDependenciesCompleted(task, tasks);
      const metadata = taskMetadata(task);
      const plan = workflowStore.getExecutionPlan(task.job_id);
      if (metadata.deterministic !== true || metadata.executor !== 'ExecutionManager' || !metadata.executable || !Array.isArray(metadata.args)) {
        throw new Error('task does not have an approved deterministic structured execution contract');
      }
      const trustedProductionQa = plan?.workflow_id === 'production' && String(task.role).toLowerCase() === 'qa' &&
        assessProductionQaExecution({ plan, taskPlanId: metadata.workflow_plan_task_id, metadata, stdout: '' }).trusted;
      const approvedWorkspace = path.resolve(proposal.workspace);
      const executionCwd = path.resolve(metadata.cwd || '');
      if (executionCwd !== approvedWorkspace && !trustedProductionQa) throw new Error('task working directory does not match the approved local workspace');
      if (!fs.statSync(proposal.workspace, { throwIfNoEntry: false })?.isDirectory()) throw new Error('approved local workspace is no longer available');
      if (!fs.statSync(executionCwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('approved execution working directory is no longer available');
      const timeoutMs = args.timeout_ms == null ? Math.min(600000, Math.max(1000, Number(metadata.timeout_ms) || 120000)) : Math.min(600000, Math.max(1000, Number(args.timeout_ms) || 1000));
      const result = await executionManager.executeAuthorizedTask(taskId, { timeoutMs, cwd: executionCwd });
      const latest = workflowStore.getTask(taskId);
      if (isVerifiedSuccessfulLocalExecution(result, taskId) &&
          latest?.status === 'completed' && latest?.execution_status === 'completed' && latest?.execution_exit_code === 0 &&
          plan?.workflow_id === 'production') {
        const expectedType = getAgentArtifactType(task.role);
        const existingArtifact = workflowStore.listArtifacts(task.job_id, { taskId, activeOnly: true }).find(item => item.type === expectedType);
        if (!existingArtifact) {
          const trace = workflowStore.getJobTrace(task.job_id);
          const resultRow = trace?.results.filter(item => item.task_id === taskId).at(-1);
          const command = [metadata.executable, ...metadata.args].join(' ');
          const contentByType = {
            architecture: {
              components: [`Static syntax check executed: ${command}`],
              interfaces: ['Local Node.js syntax-check interface'],
              failure_modes: ['Syntax validation does not establish runtime correctness.'],
              implementation_boundary: 'This artifact records the exact static check only; it does not claim a broader architecture review.'
            },
            'qa-report': {
              checks: [command, ...(assessProductionQaExecution({ plan, taskPlanId: metadata.workflow_plan_task_id, metadata, stdout: latest.execution_stdout || '' }).required_markers)],
              results: [
                `execution_scope=${metadata.args.includes('--check') ? 'static-syntax-only' : trustedProductionQa ? 'packaged-behavioral-e2e' : 'command-executed'}`,
                `exit_code=${latest.execution_exit_code}`,
                `execution_session_id=${latest.execution_session_id || 'unavailable'}`,
                ...assessProductionQaExecution({ plan, taskPlanId: metadata.workflow_plan_task_id, metadata, stdout: latest.execution_stdout || '' }).observed_markers.map(marker => `pass_marker=${marker}`),
                ...assessProductionQaExecution({ plan, taskPlanId: metadata.workflow_plan_task_id, metadata, stdout: latest.execution_stdout || '' }).missing_markers.map(marker => `missing_marker=${marker}`)
              ],
              // Syntax validity is not behavioral QA. Never turn a successful
              // `node --check` into an acceptance decision; production synthesis
              // separately rejects syntax-only QA plans even if an artifact is
              // later edited to look success-shaped.
              decision: metadata.args.includes('--check') || (trustedProductionQa &&
                !assessProductionQaExecution({ plan, taskPlanId: metadata.workflow_plan_task_id, metadata, stdout: latest.execution_stdout || '' }).passed) ||
                (!trustedProductionQa && String(task.role).toLowerCase() === 'qa') ? 'needs_changes' : 'accept'
            }
          };
          const artifactContent = contentByType[expectedType];
          if (!artifactContent || !resultRow) throw new Error(`cannot reconcile production execution artifact for ${taskId}`);
          workflowStore.createArtifact({ artifact_id: `${expectedType}-${resultRow.result_id}`, job_id: task.job_id, task_id: taskId, type: expectedType, producer_role: task.role, content: artifactContent, evidence: [resultRow.result_id, latest.execution_session_id].filter(Boolean) });
        }
      }
      return { executed_locally: true, task: taskSummary(latest), execution_session_id: latest.execution_session_id ?? null, exit_code: latest.execution_exit_code ?? null, execution_status: latest.execution_status || null, stdout: redactText(latest.execution_stdout || '').slice(0, 20000), stderr: redactText(latest.execution_stderr || '').slice(0, 10000), returned_task_id: result?.task_id || taskId };
    }
    case 'workflow_complete_synthesis': {
      const jobId = assertString(args.job_id, 'job_id', 200);
      const content = assertString(args.content, 'content', 1_000_000);
      workflowStore.assertApprovalCurrent(jobId);
      const job = workflowStore.getJob(jobId);
      if (!job || job.state !== 'EXECUTING') throw new Error('workflow is not executing');
      const plan = workflowStore.getExecutionPlan(jobId);
      const trace = workflowStore.getJobTrace(jobId);
      const parent = trace?.tasks.find(task => task.task_id === job.active_task_id && task.role === 'cto');
      if (!parent || !plan) throw new Error('workflow coordinator or immutable plan is missing');
      const children = trace.tasks.filter(task => task.parent_task_id === parent.task_id);
      if (children.length !== plan.children.length) throw new Error('cannot synthesize before every planned child task exists');
      const incomplete = children.filter(task => task.status !== 'completed');
      if (incomplete.length) throw new Error(`cannot synthesize while tasks remain unsettled: ${incomplete.map(task => `${task.role}:${task.status}`).join(', ')}`);
      const missingArtifacts = children.filter(task => {
        const expectedType = taskArtifactType(task);
        return !workflowStore.listArtifacts(jobId, { taskId: task.task_id, activeOnly: true }).some(item => item.type === expectedType);
      });
      if (missingArtifacts.length) throw new Error(`cannot synthesize while required typed artifacts are missing: ${missingArtifacts.map(task => task.role).join(', ')}`);
      if (plan.workflow_id === 'production') {
        const qaSpec = plan.children.find(spec => String(spec.role).toLowerCase() === 'qa');
        const qaTask = children.find(task => String(task.role).toLowerCase() === 'qa');
        const qaArtifact = qaTask && workflowStore.listArtifacts(jobId, { taskId: qaTask.task_id, activeOnly: true })
          .find(item => item.type === 'qa-report')?.content;
        const syntaxOnly = Array.isArray(qaSpec?.execution?.args) && qaSpec.execution.args.includes('--check');
        const qaMetadata = qaTask ? taskMetadata(qaTask) : null;
        const qaAssessment = qaTask && qaSpec
          ? assessProductionQaExecution({ plan, taskPlanId: qaSpec.id, metadata: qaMetadata, stdout: qaTask.execution_stdout || '' })
          : { trusted: false, passed: false, required_markers: [], observed_markers: [], missing_markers: [] };
        if (!qaSpec || !qaTask || !qaArtifact || qaArtifact.decision !== 'accept' || syntaxOnly || !qaAssessment.trusted || !qaAssessment.passed) {
          throw new Error('cannot synthesize production workflow: QA acceptance requires a passing behavioral-test execution; static syntax checks are insufficient');
        }
        const qaResult = trace.results.filter(result => result.task_id === qaTask.task_id).at(-1);
        if (!qaResult || qaResult.outcome !== 'success' ||
            !Array.isArray(qaArtifact.checks) || !qaArtifact.checks.length ||
            !Array.isArray(qaArtifact.results) ||
            !qaArtifact.results.includes(`execution_session_id=${qaTask.execution_session_id || 'unavailable'}`) ||
            !qaAssessment.required_markers.every(marker => qaArtifact.results.includes(`pass_marker=${marker}`)) ||
            !workflowStore.listArtifacts(jobId, { taskId: qaTask.task_id, activeOnly: true })
              .some(item => item.type === 'qa-report' && Array.isArray(item.evidence) && item.evidence.includes(qaResult.result_id))) {
          throw new Error('cannot synthesize production workflow: QA acceptance evidence is not bound to the exact durable execution result/session');
        }
      }
      const reviewerTask = children.find(task => task.role === 'reviewer');
      if (reviewerTask) {
        const evidenceErrors = validateReviewerEvidence(jobId, plan, children, reviewerTask);
        if (evidenceErrors.length) {
          throw new Error(`cannot synthesize: reviewer evidence provenance is incomplete or invalid: ${evidenceErrors.join('; ')}`);
        }
        const review = workflowStore.listArtifacts(jobId, { taskId: reviewerTask.task_id, activeOnly: true }).find(item => item.type === 'review')?.content;
        if (!review || review.decision !== 'accept' || !['requirementsSatisfied', 'architectureConformant', 'securityAccepted', 'qaAccepted', 'platformAccepted', 'documentationAccepted'].every(field => review[field] === true) || ['implementationIssues', 'evidenceIssues', 'securityIssues', 'blockingIssues'].some(field => !Array.isArray(review[field]) || review[field].length > 0)) {
          throw new Error('cannot synthesize: reviewer artifact has not accepted all required evidence without blocking findings');
        }
      }
      const ctoArtifact = redactValue(args.artifact);
      if (ctoArtifact?.decision !== 'approve') throw new Error('successful terminalization requires an explicit CTO decision of approve');
      const case01 = plan.workflow_id === 'custom-case01-artifact-lineage';
      if (case01 && !Array.isArray(args.consumed_workspace_bytes)) {
        throw new Error('CASE-01 synthesis requires consumed_workspace_bytes copied from the verified_workspace_bytes input supplied to the synthesis task');
      }
      const case01TaskArtifacts = case01
        ? workflowStore.listArtifacts(jobId, { activeOnly: true, type: 'requirements' }).filter(item => children.some(child => child.task_id === item.task_id))
        : [];
      if (case01 && case01TaskArtifacts.length !== 1) throw new Error('CASE-01 synthesis requires exactly one active requirements task artifact');
      const case01TaskArtifact = case01 ? case01TaskArtifacts[0] : null;
      if (case01) {
        if (ctoArtifact.workspace_snapshot_id !== case01TaskArtifact.content?.workspace_snapshot_id ||
            JSON.stringify(ctoArtifact.workspace_artifacts) !== JSON.stringify(case01TaskArtifact.content?.workspace_artifacts)) {
          throw new Error('CASE-01 CTO input must explicitly bind the exact task snapshot ID and workspace artifact hashes');
        }
        validateCase01SynthesisEvidence(jobId, ctoArtifact, case01TaskArtifact);
      }
      const result = workflowStore.completeLocalTask(parent.task_id, {
        content: redactText(content), artifact: ctoArtifact, outcome: 'success',
        validateBeforeCommit: case01 ? ({ resultId, artifactId }) => {
          validateCase01SynthesisEvidence(jobId, ctoArtifact, case01TaskArtifact);
          const artifactRow = artifactId ? workflowStore.getArtifact(artifactId) : null;
          const resultRow = workflowStore.db.prepare('SELECT result_id, task_id, outcome FROM results WHERE result_id=?').get(resultId);
          if (!artifactRow || artifactRow.status !== 'active' || artifactRow.type !== 'cto-decision' || artifactRow.job_id !== jobId ||
              artifactRow.artifact_id !== `cto-decision-${resultId}` || artifactRow.task_id !== parent.task_id ||
              artifactRow.evidence.length !== 1 || artifactRow.evidence[0] !== resultId || !resultRow ||
              resultRow.task_id !== parent.task_id || resultRow.outcome !== 'success') {
            throw new Error('CASE-01 CTO artifact is not bound to its durable successful synthesis result');
          }
        } : null
      });
      // Deterministic test-only crash boundary after the CTO result/artifact,
      // task completion, attempt and completion event commit, but before the
      // separate consumption-acknowledgement transaction begins.
      if (case01 && process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_BEFORE_CASE01_ACK === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
      if (case01) {
        const persistedCto = workflowStore.listArtifacts(jobId, { taskId: parent.task_id, activeOnly: true, type: 'cto-decision' }).at(-1);
        validateCase01SynthesisEvidence(jobId, persistedCto?.content, case01TaskArtifact);
        const synthesisResultId = result.resultId || persistedCto?.evidence?.find(value => workflowStore.db.prepare('SELECT 1 FROM results WHERE result_id=? AND task_id=? AND outcome=\'success\'').get(value, parent.task_id));
        const synthesisResult = synthesisResultId ? workflowStore.db.prepare('SELECT result_id, task_id, outcome FROM results WHERE result_id=?').get(synthesisResultId) : null;
        if (!persistedCto || persistedCto.artifact_id !== `cto-decision-${synthesisResultId}` || persistedCto.evidence.length !== 1 ||
            persistedCto.evidence[0] !== synthesisResultId || !synthesisResult || synthesisResult.task_id !== parent.task_id || synthesisResult.outcome !== 'success') {
          throw new Error('CASE-01 terminalization requires the exact successful synthesis result/artifact link');
        }
        recordCase01ConsumptionAck({ jobId, taskArtifact: case01TaskArtifact, ctoArtifact: persistedCto,
          synthesisResultId, consumedWorkspaceBytes: args.consumed_workspace_bytes });
        // Deterministic child-process crash probe for the integration suite.
        // It is inert unless the process is explicitly running as NODE_ENV=test.
        if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_CASE01_ACK === 'SIGKILL') {
          process.kill(process.pid, 'SIGKILL');
        }
      }
      const reportId = workflowStore.createReport(jobId, 'final', redactText(content));
      workflowStore.claimDelivery(jobId, reportId, 'chat-on-steroids-plugin', 'local');
      const terminal = workflowStore.terminalizeJob(jobId, { outcome: 'success', reportId, deliveryChannel: 'chat-on-steroids-plugin', deliveryTarget: 'local', content: redactText(content).slice(0, 1000) });
      return { terminalized: terminal.job?.status === 'completed', job: terminal.job, report_id: reportId, synthesis_result_id: result.resultId || null, idempotent: terminal.idempotent === true };
    }
    case 'workflow_events': {
      const jobId = assertString(args.job_id, 'job_id', 200);
      if (!workflowStore.getJob(jobId)) throw new Error(`workflow not found: ${jobId}`);
      const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));
      const events = workflowStore.listEvents(jobId, { limit }).map(event => ({ event_id: event.event_id, type: event.type, payload: redactText(event.payload_json).slice(0, 4000), created_at: event.created_at }));
      return { job_id: jobId, events, observability: redactValue(workflowStore.getObservabilitySnapshot(jobId, { eventLimit: limit })) };
    }
    case 'workflow_artifacts': {
      const jobId = assertString(args.job_id, 'job_id', 200);
      if (!workflowStore.getJob(jobId)) throw new Error(`workflow not found: ${jobId}`);
      return { job_id: jobId, artifacts: workflowStore.listArtifacts(jobId).map(item => ({ artifact_id: item.artifact_id, task_id: item.task_id, type: item.type, producer_role: item.producer_role, status: item.status, created_at: item.created_at, content_hash: item.content_hash, content: redactText(JSON.stringify(redactValue(item.content))).slice(0, 12000), evidence: redactValue(item.evidence) })) };
    }
    case 'workflow_record_intervention': {
      const reason = assertString(args.reason, 'reason', 4000);
      const workaround = assertString(args.workaround, 'workaround', 8000);
      const jobId = args.job_id ? assertString(args.job_id, 'job_id', 200) : null;
      if (jobId && !workflowStore.getJob(jobId)) throw new Error(`workflow not found: ${jobId}`);
      const intervention = { intervention_id: randomUUID(), job_id: jobId, task_id: args.task_id || null, actor: String(args.actor || 'user').slice(0, 200), reason: redactText(reason), workaround: redactText(workaround), proposed_automation: args.proposed_automation ? redactText(String(args.proposed_automation)).slice(0, 8000) : null, duration_minutes: args.duration_minutes == null ? null : Math.max(0, Number(args.duration_minutes)), created_at: new Date().toISOString() };
      workflowStore.db.prepare('INSERT INTO manual_interventions (intervention_id,job_id,task_id,actor,reason,workaround,proposed_automation,duration_minutes,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(intervention.intervention_id, intervention.job_id, intervention.task_id, intervention.actor, intervention.reason, intervention.workaround, intervention.proposed_automation, intervention.duration_minutes, intervention.created_at);
      if (jobId) workflowStore.recordEvent(jobId, 'manual_intervention.recorded', { intervention_id: intervention.intervention_id, reason: intervention.reason, proposed_automation: intervention.proposed_automation }, intervention.task_id || jobId);
      return { recorded: true, intervention };
    }
    case 'workflow_interventions': {
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
      const rows = args.job_id ? workflowStore.db.prepare('SELECT * FROM manual_interventions WHERE job_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(assertString(args.job_id, 'job_id', 200), limit) : workflowStore.db.prepare('SELECT * FROM manual_interventions ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
      return { interventions: rows };
    }
    case 'workflow_validate_artifact': {
      const type = assertString(args.artifact_type, 'artifact_type', 100);
      const schema = artifactSchemaForType(type);
      if (!schema) throw new Error(`unknown artifact type: ${type}`);
      const artifact = args.artifact;
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('artifact must be an object');
      const required = schema.required_content_fields || [];
      // This tool is an acceptance boundary, not a field-presence hint. Match
      // the same own-property and semantic validation used by durable artifact
      // creation so callers cannot get a green preflight for content that the
      // persistence path will later reject.
      const missing = required.filter(key => !Object.hasOwn(artifact, key));
      const roleType = args.role ? getAgentArtifactType(assertString(args.role, 'role', 100)) : null;
      let semanticError = null;
      if (missing.length === 0) {
        try { validateArtifactContent(type, artifact); }
        catch (error) { semanticError = String(error?.message || error).slice(0, 500); }
      }
      return {
        valid: missing.length === 0 && semanticError === null && (!roleType || roleType === type),
        artifact_type: type,
        schema_version: schema.schema_version,
        missing_fields: missing,
        semantic_error: semanticError,
        expected_type_for_role: roleType,
        role_matches_type: !roleType || roleType === type
      };
    }
    case 'workflow_recovery_verify': {
      const jobId = assertString(args.job_id, 'job_id', 200);
      const trace = workflowStore.getJobTrace(jobId);
      if (!trace) throw new Error(`workflow not found: ${jobId}`);
      const plan = workflowStore.getExecutionPlan(jobId);
      const runtime = workflowStore.getWorkflowRuntimeState(jobId);
      const parent = trace.tasks.find(t => t.task_id === trace.job.active_task_id && t.role === 'cto');
      const children = parent ? trace.tasks.filter(t => t.parent_task_id === parent.task_id) : [];
      const checks = [
        { name: 'approved_plan_hash', pass: Boolean(plan?.plan_hash) },
        { name: 'child_count_matches_plan', pass: Boolean(plan) && children.length === plan.children.length },
        // Custom workflow children use internal role labels (`custom-task-N`);
        // resolve their pinned output type from task metadata/plan rather than
        // passing that synthetic label to the built-in agent contract registry.
        { name: 'completed_tasks_have_result_and_typed_artifact', pass: children.filter(t => t.status === 'completed').every(t => trace.results.some(r => r.task_id === t.task_id) && workflowStore.listArtifacts(jobId, { taskId: t.task_id, activeOnly: true }).some(a => a.type === taskArtifactType(t))) },
        { name: 'reviewer_evidence_bound_to_dependency_producers', pass: (() => {
          const reviewerSpec = plan?.children?.find(spec => String(spec.role).toLowerCase() === 'reviewer');
          if (!reviewerSpec) return true;
          const reviewerTask = children.find(task => task.role === 'reviewer');
          if (!reviewerTask || reviewerTask.status !== 'completed') return trace.job.status !== 'completed';
          try { return validateReviewerEvidence(jobId, plan, children, reviewerTask).length === 0; }
          catch { return false; }
        })() },
        { name: 'terminal_state_phase_consistent', pass: trace.job.status !== 'completed' && trace.job.status !== 'failed' || runtime?.phase === (trace.job.status === 'completed' ? 'COMPLETED' : 'FAILED') },
        { name: 'terminal_report_exists', pass: !['completed', 'failed'].includes(trace.job.status) || Boolean(trace.job.report_id || workflowStore.db.prepare('SELECT report_id FROM reports WHERE job_id=? LIMIT 1').get(jobId)) },
        // A successful CTO task is a durable transition toward business-job
        // terminalization, not a terminal state by itself. A crash after the
        // synthesis result/artifact commits but before report/delivery/job
        // completion must not be reported as recovered PASS merely because
        // the Job projection still says EXECUTING.
        { name: 'completed_cto_has_terminal_report', pass: !trace.tasks.some(task => task.role === 'cto' && task.status === 'completed') ||
          (['completed', 'failed'].includes(trace.job.status) && Boolean(trace.job.report_id || workflowStore.db.prepare('SELECT report_id FROM reports WHERE job_id=? LIMIT 1').get(jobId))) },
        // A terminal Job projection and report row do not prove that delivery
        // and terminalization events committed. Apply this check to all
        // workflows; CASE-01 adds the stronger workspace-byte/attempt checks.
        { name: 'completed_cto_has_durable_delivery_and_terminal_event', pass: (() => {
          if (!trace.tasks.some(task => task.role === 'cto' && task.status === 'completed')) return true;
          if (trace.job.state !== 'COMPLETED' || trace.job.status !== 'completed') return false;
          const reports = workflowStore.db.prepare("SELECT report_id, job_id, kind, content FROM reports WHERE job_id=? AND kind='final'").all(jobId);
          if (reports.length !== 1 || reports[0].job_id !== jobId) return false;
          const report = reports[0];
          const terminalRows = workflowStore.db.prepare("SELECT event_id, payload_json, created_at FROM events WHERE job_id=? AND type='job.completed'").all(jobId);
          const deliveryRows = workflowStore.db.prepare("SELECT event_id, payload_json, created_at FROM events WHERE job_id=? AND type='delivery.claimed'").all(jobId);
          const reportEvents = workflowStore.db.prepare("SELECT event_id, payload_json, created_at FROM events WHERE job_id=? AND type='report.created'").all(jobId);
          const ctoTask = trace.tasks.find(task => task.role === 'cto' && task.status === 'completed');
          const ctoResults = ctoTask ? workflowStore.db.prepare("SELECT result_id, content FROM results WHERE task_id=? AND outcome='success'").all(ctoTask.task_id) : [];
          if (terminalRows.length !== 1 || deliveryRows.length !== 1 || reportEvents.length !== 1 || ctoResults.length !== 1) return false;
          let terminal; let delivery; let reportCreated;
          try {
            terminal = parseStrictJson(terminalRows[0].payload_json);
            delivery = parseStrictJson(deliveryRows[0].payload_json);
            reportCreated = parseStrictJson(reportEvents[0].payload_json);
          } catch { return false; }
          const deliveryKey = createHash('sha256').update(`${report.report_id}|chat-on-steroids-plugin|local`).digest('hex');
          const terminalId = createHash('sha256').update(`${jobId}|job.completed|${report.report_id}|terminal|success`).digest('hex');
          const deliveryId = createHash('sha256').update(`${jobId}|delivery.claimed|${deliveryKey}`).digest('hex');
          const reportCreatedId = createHash('sha256').update(`${jobId}|report.created|${report.report_id}`).digest('hex');
          const orderedTimes = [reportEvents[0].created_at, deliveryRows[0].created_at, terminalRows[0].created_at].map(value => Date.parse(value));
          return report.content === redactText(ctoResults[0].content) &&
            reportEvents[0].payload_json === JSON.stringify(reportCreated) &&
            deliveryRows[0].payload_json === JSON.stringify(delivery) &&
            terminalRows[0].payload_json === JSON.stringify(terminal) &&
            reportEvents[0].event_id === reportCreatedId && reportCreated.reportId === report.report_id && reportCreated.kind === 'final' &&
            terminalRows[0].event_id === terminalId && terminal.reportId === report.report_id && terminal.outcome === 'success' &&
            terminal.deliveryChannel === 'chat-on-steroids-plugin' && terminal.deliveryTarget === 'local' &&
            deliveryRows[0].event_id === deliveryId && delivery.reportId === report.report_id &&
            delivery.channel === 'chat-on-steroids-plugin' && delivery.target === 'local' &&
            orderedTimes.every(Number.isFinite) && orderedTimes[0] <= orderedTimes[1] && orderedTimes[1] <= orderedTimes[2] &&
            (trace.job.report_id == null || trace.job.report_id === report.report_id);
        })() },
        // Generic workflows need the same result→typed CTO artifact→attempt→completion-event
        // binding as CASE-01, even when there is no workspace snapshot to validate. The terminal
        // report chain alone can otherwise remain self-consistent after CTO provenance is replaced.
        { name: 'completed_cto_binds_result_artifact_attempt_and_completion_event', pass: (() => {
          const completedCtoTasks = trace.tasks.filter(task => task.role === 'cto' && task.status === 'completed');
          if (completedCtoTasks.length === 0) return true;
          if (!parent || parent.status !== 'completed' || !completedCtoTasks.some(task => task.task_id === parent.task_id)) return false;
          const results = workflowStore.db.prepare("SELECT result_id, task_id, outcome, created_at FROM results WHERE task_id=? AND outcome='success'").all(parent.task_id);
          if (results.length !== 1 || results[0].task_id !== parent.task_id) return false;
          const result = results[0];
          const artifacts = workflowStore.listArtifacts(jobId, { taskId: parent.task_id, activeOnly: true, type: 'cto-decision' });
          if (artifacts.length !== 1) return false;
          const artifact = artifacts[0];
          if (artifact.artifact_id !== `cto-decision-${result.result_id}` || artifact.job_id !== jobId || artifact.task_id !== parent.task_id ||
              artifact.status !== 'active' || artifact.evidence.filter(value => value === result.result_id).length !== 1) return false;
          const artifactEventId = createHash('sha256').update(`${jobId}|artifact.created|${artifact.artifact_id}`).digest('hex');
          const artifactEventRows = workflowStore.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type='artifact.created'").all(jobId);
          const artifactEventMatches = [];
          for (const row of artifactEventRows) {
            let payload; try { payload = parseStrictJson(row.payload_json); } catch { continue; }
            if (payload?.artifactId === artifact.artifact_id) artifactEventMatches.push({ row, payload });
          }
          if (artifactEventMatches.length !== 1 || artifactEventMatches[0].row.event_id !== artifactEventId) return false;
          const { row: artifactEvent, payload: artifactPayload } = artifactEventMatches[0];
          if (artifactEvent.payload_json !== JSON.stringify(artifactPayload) ||
              artifactPayload.taskId !== parent.task_id || artifactPayload.type !== 'cto-decision' || artifactPayload.status !== artifact.status ||
              (artifactPayload.supersedes ?? null) !== (artifact.supersedes ?? null) ||
              artifactPayload.contentHash !== artifact.content_hash) return false;
          const completionRows = workflowStore.db.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type='task.local_completed'").all(jobId);
          const completionMatches = [];
          for (const row of completionRows) {
            let payload; try { payload = parseStrictJson(row.payload_json); } catch { return false; }
            if (payload?.resultId === result.result_id) completionMatches.push({ row, payload });
          }
          if (completionMatches.length !== 1) return false;
          const { row: completion, payload } = completionMatches[0];
          const expectedCompletionId = createHash('sha256').update(`${jobId}|task.local_completed|${result.result_id}`).digest('hex');
          if (completion.payload_json !== JSON.stringify(payload) || completion.event_id !== expectedCompletionId ||
              payload.taskId !== parent.task_id || payload.resultId !== result.result_id ||
              payload.executor !== 'chat-on-steroids-plugin' || typeof payload.attemptId !== 'string') return false;
          const attempts = workflowStore.db.prepare("SELECT attempt_id, task_id, status, finished_at FROM attempts WHERE attempt_id=? AND task_id=?").all(payload.attemptId, parent.task_id);
          if (attempts.length !== 1 || attempts[0].status !== 'completed' || !attempts[0].finished_at) return false;
          const times = [result.created_at, artifactEvent.created_at, completion.created_at].map(value => Date.parse(value));
          return times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2];
        })() },
        { name: 'terminal_has_no_unsettled_children', pass: !['completed', 'failed'].includes(trace.job.status) || children.every(t => ['completed', 'failed', 'cancelled'].includes(t.status)) }
      ];
      if (plan?.workflow_id === 'custom-case01-artifact-lineage') {
        const addCase01Check = (name, fn) => {
          try {
            const result = fn();
            checks.push({ name, pass: result === true, ...(result === true ? {} : { detail: typeof result === 'string' ? result : 'CASE-01 invariant did not hold' }) });
          } catch (error) {
            checks.push({ name, pass: false, detail: String(error?.message || error).slice(0, 500) });
          }
        };
        const taskArtifacts = workflowStore.listArtifacts(jobId, { activeOnly: true, type: 'requirements' })
          .filter(artifact => children.some(child => child.task_id === artifact.task_id));
        addCase01Check('case01_exactly_one_active_task_snapshot_artifact', () => taskArtifacts.length === 1);
        const taskArtifact = taskArtifacts.length === 1 ? taskArtifacts[0] : null;
        if (taskArtifact) {
          addCase01Check('case01_snapshot_bytes_match_persisted_sha256', () => {
            validateCase01WorkspaceArtifact({ workspace: proposalFor(jobId).workspace, content: taskArtifact.content,
              snapshotBase: CASE01_SNAPSHOT_BASE, snapshotId: taskArtifact.content?.workspace_snapshot_id });
            return true;
          });
          addCase01Check('case01_task_artifact_binds_exact_successful_result', () => {
            const refs = taskArtifact.evidence || [];
            if (refs.length !== 1 || taskArtifact.artifact_id !== `requirements-${refs[0]}` || taskArtifact.status !== 'active') return false;
            const result = workflowStore.db.prepare('SELECT result_id, task_id, outcome FROM results WHERE result_id=?').get(refs[0]);
            const task = workflowStore.getTask(taskArtifact.task_id);
            return Boolean(result && result.result_id === refs[0] && result.task_id === taskArtifact.task_id && result.outcome === 'success' &&
              task?.status === 'completed' && task.job_id === jobId && taskArtifact.job_id === jobId);
          });
          const ctoArtifacts = workflowStore.listArtifacts(jobId, { taskId: parent?.task_id, activeOnly: true, type: 'cto-decision' });
          addCase01Check('case01_exactly_one_active_cto_snapshot_artifact', () => ctoArtifacts.length === 1);
          const ctoArtifact = ctoArtifacts.length === 1 ? ctoArtifacts[0] : null;
          if (ctoArtifact) {
            addCase01Check('case01_cto_snapshot_identity_hash_and_task_reference_match', () => {
              validateCase01WorkspaceArtifact({ workspace: proposalFor(jobId).workspace, content: ctoArtifact.content,
                taskArtifactId: taskArtifact.artifact_id, snapshotBase: CASE01_SNAPSHOT_BASE,
                snapshotId: taskArtifact.content?.workspace_snapshot_id });
              return ctoArtifact.content?.decision === 'approve' &&
                ctoArtifact.content?.workspace_snapshot_id === taskArtifact.content?.workspace_snapshot_id &&
                JSON.stringify(ctoArtifact.content?.workspace_artifacts) === JSON.stringify(taskArtifact.content?.workspace_artifacts);
            });
            addCase01Check('case01_cto_artifact_binds_exact_successful_synthesis_result', () => {
              const refs = ctoArtifact.evidence || [];
              if (refs.length !== 1 || ctoArtifact.artifact_id !== `cto-decision-${refs[0]}` || ctoArtifact.task_id !== parent?.task_id) return false;
              const result = workflowStore.db.prepare('SELECT result_id, task_id, outcome FROM results WHERE result_id=?').get(refs[0]);
              return Boolean(result && result.result_id === refs[0] && result.task_id === parent?.task_id && result.outcome === 'success');
            });
          }
        }
        addCase01Check('case01_durable_consumption_ack_binds_actual_bytes_and_full_lineage', () => {
          const completedCto = trace.tasks.some(task => task.role === 'cto' && task.status === 'completed');
          if (!completedCto) return !workflowStore.db.prepare('SELECT 1 FROM case01_consumption_acks WHERE job_id=?').get(jobId);
          return validateCase01ConsumptionAck(jobId) === true;
        });
        addCase01Check('case01_trace_contains_completion_artifact_and_terminal_events', () => {
          // Presence of event *types* is insufficient: unrelated or conflicting
          // rows could otherwise make a corrupted CASE-01 trace appear valid.
          // Resolve each event through its deterministic identity and verify the
          // payload against the exact durable result/artifact/report lineage.
          const eventIdFor = (type, key) => createHash('sha256').update(`${jobId}|${type}|${key}`).digest('hex');
          const readEvent = (type, key) => {
            // A deterministic primary key proves the expected row exists, but
            // does not prove it is the only row describing that same logical
            // transition. SQLite permits a second event_id with a duplicated
            // payload, which older recovery checks silently ignored.
            const rows = workflowStore.db.prepare('SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type=?').all(jobId, type);
            const matches = [];
            for (const row of rows) {
              let payload;
              // A malformed row of a relevant transition type is itself an
              // integrity failure; skipping it could conceal a duplicate or
              // contradictory event beside the expected deterministic row.
              try { payload = parseStrictJson(row.payload_json); } catch { return null; }
              let rowKey = null;
              if (type === 'task.local_completed') rowKey = payload.resultId;
              else if (type === 'artifact.created') rowKey = payload.artifactId;
              else if (type === 'report.created') rowKey = payload.reportId;
              else if (type === 'job.completed') rowKey = payload.reportId && payload.outcome === 'success'
                ? `${payload.reportId}|terminal|success` : null;
              else if (type === 'delivery.claimed' && payload.reportId && payload.channel && payload.target) {
                rowKey = createHash('sha256').update(`${payload.reportId}|${payload.channel}|${payload.target}`).digest('hex');
              }
              if (rowKey === key) matches.push({ row, payload });
            }
            if (matches.length !== 1 || matches[0].row.event_id !== eventIdFor(type, key) ||
                matches[0].row.payload_json !== JSON.stringify(matches[0].payload)) return null;
            const { row, payload } = matches[0];
            return row.job_id === jobId && row.type === type ? { row, payload } : null;
          };
          const assertEventOrder = ordered => {
            const times = ordered.map(event => Date.parse(event?.row?.created_at));
            if (times.some(value => !Number.isFinite(value))) throw new Error('trace contains an event with an invalid timestamp');
            for (let index = 1; index < times.length; index += 1) {
              if (times[index] < times[index - 1]) throw new Error('trace event timestamps contradict the required durable workflow order');
            }
          };
          const taskRefs = taskArtifact.evidence || [];
          const taskResultId = taskRefs.length === 1 ? taskRefs[0] : null;
          const taskCompletion = taskResultId ? readEvent('task.local_completed', taskResultId) : null;
          const taskAttempt = taskCompletion?.payload?.attemptId
            ? trace.attempts.find(attempt => attempt.attempt_id === taskCompletion.payload.attemptId && attempt.task_id === taskArtifact.task_id && attempt.status === 'completed')
            : null;
          if (!taskCompletion) throw new Error('exact task.local_completed event is missing or malformed');
          if (!taskAttempt) throw new Error('completed task attempt is missing from durable trace');
          if (taskCompletion.payload.taskId !== taskArtifact.task_id || taskCompletion.payload.resultId !== taskResultId ||
              taskCompletion.payload.attemptId !== taskAttempt.attempt_id || taskCompletion.payload.executor !== 'chat-on-steroids-plugin') {
            throw new Error('task.local_completed payload does not bind the exact task, result, attempt and executor');
          }

          const artifactEventFor = artifact => {
            const event = readEvent('artifact.created', artifact.artifact_id);
            return event && event.payload.artifactId === artifact.artifact_id &&
              event.payload.taskId === artifact.task_id && event.payload.type === artifact.type &&
              event.payload.status === artifact.status && (event.payload.supersedes ?? null) === (artifact.supersedes ?? null)
              ? event : null;
          };
          const taskArtifactCreated = artifactEventFor(taskArtifact);
          if (!taskArtifactCreated) throw new Error('task artifact creation event does not bind its durable artifact lineage');
          const ctoArtifacts = workflowStore.listArtifacts(jobId, { taskId: parent?.task_id, activeOnly: true, type: 'cto-decision' });
          const ctoArtifact = ctoArtifacts.length === 1 ? ctoArtifacts[0] : null;
          const ctoArtifactCreated = ctoArtifact ? artifactEventFor(ctoArtifact) : null;
          if (!ctoArtifact || !ctoArtifactCreated) throw new Error('CTO artifact creation event does not bind its durable artifact lineage');

          // Verify the synthesis task's own result/attempt/event, not just the
          // child task completion and CTO artifact. Without this edge, deleting
          // or substituting the terminal synthesis completion event could leave
          // a superficially consistent artifact/report trace.
          const ctoRefs = ctoArtifact.evidence || [];
          const synthesisResultId = ctoRefs.length === 1 ? ctoRefs[0] : null;
          const synthesisResult = synthesisResultId
            ? workflowStore.db.prepare('SELECT result_id, task_id, outcome, content FROM results WHERE result_id=?').get(synthesisResultId)
            : null;
          const synthesisCompletion = synthesisResultId ? readEvent('task.local_completed', synthesisResultId) : null;
          const synthesisAttempt = synthesisCompletion?.payload?.attemptId
            ? trace.attempts.find(attempt => attempt.attempt_id === synthesisCompletion.payload.attemptId && attempt.task_id === parent?.task_id && attempt.status === 'completed')
            : null;
          if (!synthesisResult || synthesisResult.task_id !== parent?.task_id || synthesisResult.outcome !== 'success' ||
              parent?.status !== 'completed' || !synthesisCompletion || !synthesisAttempt ||
              synthesisCompletion.payload.taskId !== parent.task_id || synthesisCompletion.payload.resultId !== synthesisResultId ||
              synthesisCompletion.payload.attemptId !== synthesisAttempt.attempt_id || synthesisCompletion.payload.executor !== 'chat-on-steroids-plugin') {
            throw new Error('CTO synthesis is not bound to its exact successful result, completed attempt and task.local_completed event');
          }
          assertEventOrder([taskArtifactCreated, taskCompletion, ctoArtifactCreated, synthesisCompletion]);

          if (trace.job.status === 'completed') {
            // The report ID is authoritative in the terminal event on older DB
            // schemas; do not assume a nullable jobs.report_id projection exists.
            const terminalRows = workflowStore.db.prepare("SELECT event_id, payload_json, created_at FROM events WHERE job_id=? AND type='job.completed'").all(jobId);
            if (terminalRows.length !== 1) throw new Error('expected exactly one durable job.completed event');
            let terminalPayload;
            try { terminalPayload = parseStrictJson(terminalRows[0].payload_json); } catch { throw new Error('job.completed payload is malformed'); }
            const reportId = terminalPayload.reportId;
            const terminal = reportId ? readEvent('job.completed', `${reportId}|terminal|success`) : null;
            const report = reportId ? workflowStore.db.prepare('SELECT report_id, job_id, kind, content FROM reports WHERE report_id=?').get(reportId) : null;
            const deliveryKey = reportId ? createHash('sha256').update(`${reportId}|chat-on-steroids-plugin|local`).digest('hex') : null;
            const delivery = deliveryKey ? readEvent('delivery.claimed', deliveryKey) : null;
            const reportCreated = reportId ? readEvent('report.created', reportId) : null;
            if (!report || report.job_id !== jobId || report.kind !== 'final') throw new Error('terminal report lineage is missing or conflicting');
            if (report.content !== synthesisResult.content) throw new Error('final report bytes/content do not match the exact successful CTO synthesis result');
            if (!reportCreated || reportCreated.payload.reportId !== reportId || reportCreated.payload.kind !== 'final') {
              throw new Error('report.created event does not bind the exact final report');
            }
            if (terminalRows[0].event_id !== eventIdFor('job.completed', `${reportId}|terminal|success`) || !terminal || terminal.payload.reportId !== reportId || terminal.payload.outcome !== 'success') {
              throw new Error('job.completed event does not bind the exact final report');
            }
            if (!delivery || delivery.payload.reportId !== reportId || delivery.payload.channel !== 'chat-on-steroids-plugin' || delivery.payload.target !== 'local') {
              throw new Error('delivery.claimed event does not bind the exact report and local destination');
            }
            assertEventOrder([taskArtifactCreated, taskCompletion, ctoArtifactCreated, synthesisCompletion, reportCreated, delivery, terminal]);
            return true;
          }
          return !['failed', 'cancelled'].includes(trace.job.status);
        });
      }
      const script = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(WORKFLOW_DB_PATH)},{readOnly:true});const j=d.prepare('SELECT job_id,status FROM jobs WHERE job_id=?').get(${JSON.stringify(jobId)});const p=d.prepare('SELECT COUNT(*) n FROM workflow_plans WHERE job_id=?').get(${JSON.stringify(jobId)});console.log(JSON.stringify({job:j||null,plan_rows:p?.n??0}));d.close();`;
      const fresh = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000, env: { ...process.env } });
      let freshRead = null;
      try { freshRead = parseStrictJson(fresh.stdout.trim()); } catch {}
      checks.push({ name: 'fresh_process_sqlite_readback', pass: fresh.status === 0 && freshRead?.job?.job_id === jobId });
      return { status: checks.every(c => c.pass) ? 'PASS' : 'NEEDS_ATTENTION', job_id: jobId, job_status: trace.job.status, runtime_phase: runtime?.phase || null, plan_hash: plan?.plan_hash || null, task_count: children.length, result_count: trace.results.length, artifact_count: trace.artifacts.length, checks, scope_note: 'Stored-state consistency and fresh-process SQLite readback only; does not prove runtime correctness or host supervisor restart.' };
    }
    case 'workflow_access_diagnostics': {
      const candidates = [path.join(home, '.config', 'chat-on-steroids', 'config.json'), path.join(home, '.config', 'chat-on-steroids', 'settings.json')];
      const found = [];
      for (const file of candidates) {
        try {
          const parsed = parseStrictJson(fs.readFileSync(file, 'utf8'));
          const walk = (value, prefix = '$') => { if (!value || typeof value !== 'object') return; for (const [key, item] of Object.entries(value)) { if (/strictChatAllowlist/i.test(key) && typeof item === 'boolean') found.push({ file, path: `${prefix}.${key}`, value: item }); else if (item && typeof item === 'object') walk(item, `${prefix}.${key}`); } };
          walk(parsed);
        } catch {}
      }
      return { read_only: true, error_context: 'CHAT_NOT_TRUSTED may originate from host/bridge caller attribution or another trust policy; this diagnostic does not identify the cause by itself.', strict_chat_allowlist_values: found, recommendations: ['Capture the host/bridge log around the failing tool call and identify which component emits CHAT_NOT_TRUSTED.', 'Do not disable trust checks or alter policy as a diagnostic workaround.'] };
    }
    case 'workflow_e2e_run': {
      const jobId = assertString(args.job_id, 'job_id', 200);
      const maxTasks = Math.min(20, Math.max(1, Number(args.max_tasks) || 5));
      const job = workflowStore.getJob(jobId);
      if (!job) throw new Error(`workflow not found: ${jobId}`);
      workflowStore.assertApprovalCurrent(jobId);
      if (job.state !== 'EXECUTING') throw new Error('workflow must already be explicitly approved and dispatched; runner will not approve or dispatch it');
      let prepared = false;
      try { await callTool('workflow_prepare_tasks', { job_id: jobId }); prepared = true; } catch (error) { if (!/already|prepared|state/i.test(String(error.message))) throw error; }
      const actions = [];
      for (let i = 0; i < maxTasks; i++) {
        const next = await callTool('workflow_next_task', { job_id: jobId });
        if (next.stage === 'local_execution') {
          const result = await callTool('task_execute_local', { task_id: next.task.task_id });
          actions.push({ stage: next.stage, task_id: next.task.task_id, exit_code: result.exit_code, execution_status: result.execution_status });
          if (!isSuccessfulLocalExecutionSummary(result, next.task.task_id)) {
            return {
              status: 'BLOCKED', job_id: jobId, prepared, actions,
              stop_reason: 'local deterministic task failed or did not produce verified durable success'
            };
          }
          continue;
        }
        return { status: next.stage === 'synthesis' ? 'SYNTHESIS_READY' : next.stage === 'blocked' ? 'BLOCKED' : 'WAITING_FOR_HOST_EVIDENCE', job_id: jobId, prepared, actions, next, note: 'Runner stops rather than inventing specialist evidence or approving synthesis.' };
      }
      return { status: 'TASK_BUDGET_REACHED', job_id: jobId, prepared, actions, max_tasks: maxTasks };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function collectCompletedResults(jobId, children, currentTask) {
  const trace = workflowStore.getJobTrace(jobId);
  return children.filter(task => task.status === 'completed' && task.task_id !== currentTask?.task_id).map(task => {
    const row = trace?.results.filter(result => result.task_id === task.task_id).at(-1);
    const artifacts = workflowStore.listArtifacts(jobId, { taskId: task.task_id, activeOnly: true }).map(item => ({
      type: item.type,
      producer_role: item.producer_role,
      content: redactValue(item.content),
      evidence: redactValue(item.evidence || []),
      content_hash: item.content_hash
    }));
    const snapshotArtifact = artifacts.find(item => item.type === 'requirements' && typeof item.content?.workspace_snapshot_id === 'string');
    const verifiedWorkspaceBytes = snapshotArtifact
      ? readVerifiedCase01WorkspaceSnapshot({ content: snapshotArtifact.content, snapshotBase: CASE01_SNAPSHOT_BASE, snapshotId: snapshotArtifact.content.workspace_snapshot_id })
      : null;
    return {
      task_id: task.task_id, role: task.role, outcome: row?.outcome || null, result_id: row?.result_id || null,
      content: redactText(row?.content || '').slice(0, 12000), artifacts,
      ...(verifiedWorkspaceBytes ? { verified_workspace_bytes: {
        snapshot_id: verifiedWorkspaceBytes.snapshot_id,
        workspace_artifacts: verifiedWorkspaceBytes.workspace_artifacts.map(entry => ({
          path: entry.path, sha256: entry.sha256, encoding: 'base64', bytes: entry.bytes_base64
        }))
      } } : {}),
      created_at: row?.created_at || null
    };
  });
}

function buildRoleTaskDescription(spec, request) {
  if (spec.execution?.custom_role_id) {
    const execution = spec.execution;
    return [
      `Custom role: ${execution.custom_role_name} (${execution.custom_role_id}@${execution.custom_role_version}).`,
      `Configured role instructions: ${execution.custom_role_system_prompt}`,
      `Declared capabilities: ${(execution.custom_role_capabilities || []).join(', ') || 'none'}.`,
      `Declared permissions: ${(execution.custom_role_permissions || []).join(', ') || 'none'}. These declarations do not grant additional tool/runtime access.`,
      `Allowed read-only tools: ${(execution.custom_role_allowed_tools || []).join(', ') || 'none'}.`,
      `Project request: ${String(request || '').trim()}`,
      `Accepted inputs: ${(execution.input_contract || []).join(', ')}. Use only predecessor results and typed artifacts supplied by the orchestrator; state explicitly when required evidence is absent.`,
      `Required output artifact type: ${execution.output_artifact_type}.`,
      'Work only within this assigned role. Distinguish verified facts from assumptions, record concrete evidence where applicable, and do not claim commands/tests ran without execution evidence.'
    ].join('\n');
  }
  const contract = getAgentContract(spec.role);
  return [
    `Assigned role: ${contract.role} (${contract.capability}).`,
    `Project request: ${String(request || '').trim()}`,
    `Your inputs: ${contract.inputs.join(', ')}. Use predecessor results and their typed artifacts supplied by the orchestrator; state explicitly when required evidence is absent.`,
    `Required output: ${contract.outputs.join(', ')}; artifact type: ${getAgentArtifactType(contract.role)}.`,
    `Completion criteria: ${contract.completionCriteria.join('; ')}.`,
    'Work only within this role. Record concrete evidence and source/file references where applicable, distinguish verified facts from assumptions, and report limitations. Do not claim commands/tests ran unless execution evidence is available.'
  ].join('\n');
}

function rpc(id, result) { return JSON.stringify({ jsonrpc: '2.0', id, result }); }
function rpcError(id, code, message) { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }); }
function toolError(id, message) { return rpc(id, { content: [{ type: 'text', text: message }], isError: true }); }

async function handle(message) {
  const hasId = isPlainRecord(message) && Object.hasOwn(message, 'id');
  const suppliedId = hasId ? message.id : undefined;
  const validId = !hasId || suppliedId === null || typeof suppliedId === 'string' ||
    (typeof suppliedId === 'number' && Number.isSafeInteger(suppliedId));
  const id = validId && hasId ? suppliedId : null;
  // Validate the envelope before applying notification suppression. A missing
  // ID is valid only for an otherwise-valid notification; malformed requests
  // still require an Invalid Request response with id:null.
  const malformedEnvelope = !isPlainRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      !message.method.trim() || !validId ||
      (Object.hasOwn(message, 'params') && !isPlainRecord(message.params));
  if (malformedEnvelope) {
    return rpcError(id, -32600, 'Invalid Request: expected a JSON-RPC 2.0 object with a string method, valid id, and object params');
  }
  const method = message.method;
  // JSON-RPC notifications have no correlation ID and must never trigger
  // request-only handlers such as tools/call. In particular, executing a
  // mutating tool and emitting an unmatchable response with an omitted `id`
  // can desynchronize clients and make the mutation's outcome untraceable.
  if (method.startsWith('notifications/')) {
    return hasId ? rpcError(id, -32600, 'JSON-RPC notifications must not include an id') : null;
  }
  if (!hasId) return null;
  if (method === 'server/discover') return rpc(id, { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS, ttlMs: 3600000, cacheScope: 'public', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } });
  if (method === 'initialize') return rpc(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS });
  if (method === 'ping') return rpc(id, {});
  if (method === 'tools/list') return rpc(id, { resultType: 'complete', tools: TOOL_DEFS });
  if (method === 'resources/list') return rpc(id, { resources: [] });
  if (method === 'prompts/list') return rpc(id, { prompts: [] });
  if (method === 'logging/setLevel') return rpc(id, {});
  if (method === 'tools/call') {
    if (!isPlainRecord(message.params) || typeof message.params.name !== 'string' || !message.params.name.trim() ||
        (Object.hasOwn(message.params, 'arguments') && !isPlainRecord(message.params.arguments))) {
      return rpcError(id, -32602, 'Invalid params: tools/call requires a non-empty name and object arguments');
    }
    try {
      const result = await callTool(message.params.name, message.params.arguments === undefined ? {} : message.params.arguments);
      return rpc(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
    } catch (error) {
      return toolError(id, error instanceof Error ? error.message : String(error));
    }
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

// MCP stdio is a trust boundary too. Do not let a peer grow an unterminated
// line or enqueue an unbounded number of requests while SQLite/tool handlers
// are busy. Frame bytes before UTF-8 decoding so invalid UTF-8 cannot be
// silently replaced by Node's StringDecoder and then accepted as valid JSON.
const MAX_RPC_LINE_BYTES = Math.min(MAX_STRICT_JSON_BYTES, 8 * 1024 * 1024);
const MAX_QUEUED_RPC_REQUESTS = 128;
const MAX_QUEUED_RPC_BYTES = 16 * 1024 * 1024;
let partialLine = Buffer.alloc(0);
let discardingOversizedLine = false;
let queue = Promise.resolve();
let outputQueue = Promise.resolve();
let inputQueue = Promise.resolve();
let queuedRequests = 0;
let queuedBytes = 0;
let stdoutBlocked = false;
let inputProcessing = false;
let shutdownPromise = null;
let shutdownCloseStreamsRequested = false;
let shutdownStreamsClosed = false;
let workflowStoreClosed = false;
let outputFailure = null;
let testEofDrainKeepalive = null;

// The request queue is bounded, but a response (notably tools/list or a large
// durable query) can be much larger than its request. Serialize every frame and
// honor Writable backpressure so a peer that stops reading stdout cannot turn
// successful request processing into unbounded memory growth.
function writeRpcFrame(frame) {
  const write = async () => {
    if (outputFailure) throw outputFailure;
    if (process.stdout.write(`${frame}\n`)) return;
    stdoutBlocked = true;
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_SHUTDOWN_DRAIN_TIMEOUT_MS) {
      process.stderr.write('[local-orchestrator] test stdout backpressure entered\n');
    }
    process.stdin.pause();
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        process.stdout.removeListener('drain', onDrain);
        process.stdout.removeListener('error', onError);
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      process.stdout.once('drain', onDrain);
      process.stdout.once('error', onError);
    });
    stdoutBlocked = false;
    if (!inputProcessing && !shutdownPromise) process.stdin.resume();
  };
  // Do not recover the serialized output chain after a failed write. A later
  // successful frame cannot make an earlier correlated response delivered.
  outputQueue = outputQueue.then(write).catch(error => {
    outputFailure ||= error;
    throw error;
  });
  return outputQueue;
}

async function writeParseError(message = 'parse error') {
  await writeRpcFrame(rpcError(null, -32700, message));
}

async function rejectOverloadedLine(line) {
  let message;
  try { message = parseStrictJson(line, 'overloaded MCP request'); }
  catch { await writeParseError(); return; }
  if (!isPlainRecord(message) || !Object.hasOwn(message, 'id')) return; // JSON-RPC notifications have no response.
  const suppliedId = message.id;
  const validId = suppliedId === null || typeof suppliedId === 'string' ||
    (typeof suppliedId === 'number' && Number.isSafeInteger(suppliedId));
  await writeRpcFrame(rpcError(validId ? suppliedId : null, validId ? -32000 : -32600,
    validId ? 'server overloaded; retry this request later' : 'Invalid Request: invalid JSON-RPC id'));
}

async function enqueueRpcLine(line) {
  if (!line.length || line.every(byte => byte === 0x20 || byte === 0x09 || byte === 0x0d)) return;
  if (queuedRequests >= MAX_QUEUED_RPC_REQUESTS || queuedBytes + line.length > MAX_QUEUED_RPC_BYTES) {
    await rejectOverloadedLine(line);
    return;
  }
  queuedRequests++;
  queuedBytes += line.length;
  queue = queue.then(async () => {
    let message;
    try { message = parseStrictJson(line); }
    catch { await writeParseError(); return; }
    // Deterministically hold one explicitly named request in the test harness
    // so queue-overflow regressions can prove the request counter is bounded.
    // The hook is inert outside NODE_ENV=test and has no general delay switch.
    if (process.env.NODE_ENV === 'test' && message?.id === process.env.CHAT_ON_STEROIDS_TEST_RPC_QUEUE_DELAY_ID) {
      process.stderr.write(`[local-orchestrator] test RPC queue delay entered: ${String(message.id)}\n`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    try {
      const response = await handle(message);
      if (response) await writeRpcFrame(response);
    } catch (error) {
      process.stderr.write(`[local-orchestrator] ${error?.stack || error}\n`);
      if (isPlainRecord(message) && Object.hasOwn(message, 'id')) {
        const suppliedId = message.id;
        const validId = suppliedId === null || typeof suppliedId === 'string' ||
          (typeof suppliedId === 'number' && Number.isSafeInteger(suppliedId));
        await writeRpcFrame(rpcError(validId ? suppliedId : null, -32000, 'internal plugin error'));
      }
    }
  }).catch(error => {
    process.stderr.write(`[local-orchestrator] request queue failure: ${error?.stack || error}\n`);
  }).finally(() => {
    queuedRequests--;
    queuedBytes -= line.length;
  });
}

async function consumeLineSegment(segment, terminated) {
  if (discardingOversizedLine) {
    if (terminated) {
      discardingOversizedLine = false;
      await writeParseError(`request line exceeds ${MAX_RPC_LINE_BYTES} bytes`);
    }
    return;
  }
  const size = partialLine.length + segment.length;
  if (size > MAX_RPC_LINE_BYTES) {
    partialLine = Buffer.alloc(0);
    if (terminated) await writeParseError(`request line exceeds ${MAX_RPC_LINE_BYTES} bytes`);
    else discardingOversizedLine = true;
    return;
  }
  const line = partialLine.length ? Buffer.concat([partialLine, segment], size) : Buffer.from(segment);
  partialLine = Buffer.alloc(0);
  if (terminated) await enqueueRpcLine(line);
  else partialLine = line;
}

function handleInputChunk(chunk) {
  if (shutdownPromise) return;
  // Pause at each stream chunk while framing it. If output blocks during an
  // overload/parse response, this retains at most the current bounded stream
  // chunk and resumes only after stdout drains.
  process.stdin.pause();
  inputProcessing = true;
  inputQueue = inputQueue.then(async () => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline < 0) {
        await consumeLineSegment(chunk.subarray(start), false);
        break;
      }
      await consumeLineSegment(chunk.subarray(start, newline), true);
      start = newline + 1;
    }
  }).catch(error => {
    process.stderr.write(`[local-orchestrator] input framing failure: ${error?.stack || error}\n`);
  }).finally(() => {
    inputProcessing = false;
    if (!stdoutBlocked && !shutdownPromise) process.stdin.resume();
  });
}
process.stdin.on('data', handleInputChunk);

async function closeRequestedStreams() {
  if (!shutdownCloseStreamsRequested || shutdownStreamsClosed) return;
  shutdownStreamsClosed = true;
  process.stdin.destroy();
  if (!process.stdout.writableEnded && !process.stdout.destroyed) {
    await new Promise(resolve => process.stdout.end(resolve));
  }
}

function drainRuntime({ closeStreams = false } = {}) {
  if (closeStreams) {
    shutdownCloseStreamsRequested = true;
    // Stop accepting new chunks, but retain any chunk already accepted by the
    // framing handler. The ordered input/request/output queues below drain it.
    process.stdin.pause();
    process.stdin.removeListener('data', handleInputChunk);
  }
  // A signal can arrive after an EOF-started drain has already completed its
  // first close-stream check. Upgrade the existing drain instead of returning
  // a settled promise that will never observe the new close request.
  if (shutdownPromise) return closeStreams
    ? shutdownPromise.then(() => closeRequestedStreams())
    : shutdownPromise;
  shutdownPromise = (async () => {
    const drain = async () => {
      await inputQueue.catch(() => {});
      await queue.catch(() => {});
      // A failed stdout write means correlated responses were not delivered to
      // the host. Do not silently report successful shutdown in that case.
      await outputQueue.catch(error => { process.exitCode = 1; throw error; });
    };
    let deadline;
    const configuredTestTimeout = process.env.NODE_ENV === 'test'
      ? Number(process.env.CHAT_ON_STEROIDS_TEST_SHUTDOWN_DRAIN_TIMEOUT_MS) : NaN;
    const drainTimeoutMs = Number.isSafeInteger(configuredTestTimeout) && configuredTestTimeout >= 50 && configuredTestTimeout <= 30000
      ? configuredTestTimeout : 30000;
    try {
      await Promise.race([
        drain(),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`shutdown drain exceeded ${drainTimeoutMs}ms`)), drainTimeoutMs); }),
      ]);
    } finally { clearTimeout(deadline); }
    if (!workflowStoreClosed) {
      workflowStoreClosed = true;
      try { workflowStore.db.close(); }
      catch (error) {
        process.exitCode = 1;
        try { fs.writeSync(2, `[local-orchestrator] workflow store close failed during shutdown: ${error?.stack || error}\n`); } catch {}
      }
    }
    await closeRequestedStreams();
  })();
  return shutdownPromise;
}

function failStopOnShutdownError(origin, error) {
  try { fs.writeSync(2, `[local-orchestrator] ${origin} shutdown failed; stopping MCP runtime: ${error?.stack || error}\n`); } catch {}
  process.exitCode = 1;
  process.stdin.destroy();
  process.stdout.destroy();
  process.exit(1);
}

process.stdin.on('end', () => {
  // JSON-lines framing requires a terminating LF. Do not silently discard an
  // accepted but incomplete final frame; report a bounded JSON-RPC parse error.
  inputQueue = inputQueue.then(async () => {
    if (partialLine.length > 0) {
      partialLine = Buffer.alloc(0);
      await writeParseError('unterminated JSON-RPC frame at end of input');
    } else if (discardingOversizedLine) {
      discardingOversizedLine = false;
      await writeParseError(`request line exceeds ${MAX_RPC_LINE_BYTES} bytes before end of input`);
    }
  });
  void drainRuntime().then(() => {
    if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_EOF_DRAIN_SETTLED_MARKER === '1') {
      // Keep the child alive long enough for a deterministic post-EOF signal
      // regression. The signal handler clears this test-only keepalive.
      testEofDrainKeepalive = setInterval(() => {}, 1000);
      process.stderr.write('[local-orchestrator] test stdin EOF drain settled\n');
    }
  }).catch(error => failStopOnShutdownError('stdin EOF', error));
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    if (testEofDrainKeepalive) clearInterval(testEofDrainKeepalive);
    void drainRuntime({ closeStreams: true }).catch(error => {
      // A failed drain must fail-stop rather than leave a signal-handling
      // process alive indefinitely with an uncertain response/SQLite boundary.
      failStopOnShutdownError(`graceful ${signal}`, error);
    });
  });
}
process.stdout.on('error', error => {
  // A write that originally returned true can still fail asynchronously (for
  // example EPIPE after the host closes its reader). Treat it as a permanent
  // delivery failure; never let a later frame or EOF report success.
  outputFailure ||= error;
  failStopOnFatalRuntimeError('stdout write failure', error);
});
function failStopOnFatalRuntimeError(kind, reason) {
  // A long-lived MCP process cannot safely continue serving state changes after
  // an uncaught exception or rejected promise: a transaction, lease, in-memory
  // invariant, or response queue may have been left half-updated. Installing a
  // logging-only listener suppresses Node's default fatal behavior, so make the
  // failure explicitly fatal and emit diagnostics synchronously before exit.
  let detail = '<fatal reason could not be rendered>';
  try {
    if (reason instanceof Error) detail = reason.stack || reason.message || String(reason);
    else detail = String(reason);
  } catch {}
  try { fs.writeSync(2, `[local-orchestrator] fatal ${kind}; stopping MCP runtime: ${detail}\n`); } catch {}
  process.exit(1);
}

process.on('uncaughtException', error => failStopOnFatalRuntimeError('uncaught exception', error));
process.on('unhandledRejection', reason => failStopOnFatalRuntimeError('unhandled rejection', reason));
