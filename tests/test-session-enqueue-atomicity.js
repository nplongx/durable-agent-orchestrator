import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-enqueue-atomicity-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const dbPath = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';
const storeModulePath = path.resolve(process.env.PHASE2_TEST_JOB_STORE_MODULE || fileURLToPath(new URL('../src/runtime/job-store.js', import.meta.url)));
const storeModuleUrl = pathToFileURL(storeModulePath).href;
const { WorkflowStore } = await import(storeModuleUrl);
const store = new WorkflowStore();
process.on('exit', () => {
  try { store.db.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

function createSession(label) {
  const job = store.createJob({ conversationKey: `session-enqueue-${label}-${process.pid}`, title: `Isolated session enqueue ${label}` });
  store.transition(job.job_id, 'PROPOSED');
  store.approve(job.job_id, 'local-only queue atomicity fixture', 'test-fixture', { workspace: root });
  const cto = store.dispatch(job.job_id, { role: 'cto', description: `enqueue fixture ${label}` });
  store.attachOpenClawRun(job.job_id, { runId: `enqueue-run-${label}-${process.pid}`, sessionKey: `agent:cto:subagent:enqueue-${label}-${process.pid}` });
  return { job, session: store.getSessionByTask(cto.task_id) };
}

function state(sessionId, dedupeKey) {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    const messages = db.prepare('SELECT * FROM session_messages WHERE session_id=? AND dedupe_key=? ORDER BY rowid').all(sessionId, dedupeKey);
    const events = db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE type='session.message_queued' ORDER BY rowid").all()
      .filter(row => { try { return JSON.parse(row.payload_json)?.dedupeKey === dedupeKey; } catch { return true; } });
    return { messages, events };
  } finally { db.close(); }
}

function childCall(sessionId, options, env = {}) {
  const script = `
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    try { const row=s.enqueueSessionMessage(${JSON.stringify(sessionId)},${JSON.stringify(options)}); console.log(JSON.stringify({message_id:row.message_id,payload_json:row.payload_json,sender_role:row.sender_role,recipient_role:row.recipient_role})); }
    finally { s.db.close(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}

async function dedupePayloadSubstitutionRegression() {
  const { session } = createSession('dedupe-substitution');
  const first = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', messageType: 'session.message',
    payload: { command: 'node --check approved.js', purpose: 'approved-task' },
    correlationId: 'correlation-approved', dedupeKey: 'same-logical-message'
  });
  assert.equal(first.status, 'QUEUED');
  assert.throws(() => store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'qa', messageType: 'session.message',
    payload: { command: 'rm -rf /', purpose: 'different-recipient-and-command' },
    correlationId: 'correlation-substituted', dedupeKey: 'same-logical-message'
  }), /dedupe key conflicts with existing durable message payload|idempotent enqueue payload mismatch/i,
  'reusing a dedupe key for different recipient/payload must be rejected, not silently return the prior row');
  const saved = state(session.session_id, 'same-logical-message');
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].message_id, first.message_id);
  assert.equal(saved.messages[0].recipient_role, 'architect');
  assert.equal(JSON.parse(saved.messages[0].payload_json).command, 'node --check approved.js');
  assert.equal(saved.events.length, 1);
  console.log('SESSION ENQUEUE DEDUPE-KEY PAYLOAD/RECIPIENT SUBSTITUTION REJECTION PASS');
}

async function sameRequestIdempotencyRegression() {
  const { session } = createSession('same-request-idempotency');
  const input = { senderRole: 'cto', recipientRole: 'architect', messageType: 'session.message',
    payload: { command: 'node --check same.js', tag: 'identical' }, correlationId: 'same-correlation', dedupeKey: 'same-request' };
  const first = store.enqueueSessionMessage(session.session_id, input);
  const second = store.enqueueSessionMessage(session.session_id, input);
  assert.equal(second.message_id, first.message_id);
  const saved = state(session.session_id, 'same-request');
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.events.length, 1);
  console.log('SESSION ENQUEUE IDENTICAL REQUEST FULL-LINEAGE IDEMPOTENCY PASS');
}

async function concurrentEnqueueRegression() {
  const { session } = createSession('concurrent-enqueue');
  const barrier = path.join(root, 'enqueue-concurrency-barrier');
  fs.mkdirSync(barrier, { mode: 0o700 });
  const input = { senderRole: 'cto', recipientRole: 'architect', messageType: 'session.message',
    payload: { command: 'node --check concurrent.js', tag: 'two independent writers' },
    correlationId: 'concurrent-correlation', dedupeKey: 'concurrent-one-logical-message' };
  const children = [childCall(session.session_id, input, { CHAT_ON_STEROIDS_TEST_SESSION_ENQUEUE_BARRIER_DIR: barrier }),
    childCall(session.session_id, input, { CHAT_ON_STEROIDS_TEST_SESSION_ENQUEUE_BARRIER_DIR: barrier })];
  try {
    const ready = children.map(({ child }) => path.join(barrier, `${child.pid}.ready`));
    const deadline = Date.now() + 15000;
    while (!ready.every(candidate => fs.existsSync(candidate))) {
      if (Date.now() > deadline) throw new Error('competing enqueue writers did not reach the barrier');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    fs.writeFileSync(path.join(barrier, 'release'), 'release\n', { flag: 'wx', mode: 0o600 });
    const results = await Promise.all(children.map(item => item.done));
    assert.ok(results.every(item => item.code === 0), JSON.stringify(results));
    const ids = results.map(item => JSON.parse(item.stdout.trim()).message_id);
    assert.equal(new Set(ids).size, 1, 'same dedupe key must converge across processes on one durable message identity');
    const saved = state(session.session_id, 'concurrent-one-logical-message');
    assert.equal(saved.messages.length, 1);
    assert.equal(saved.events.length, 1);
    console.log('SESSION ENQUEUE TWO-PROCESS DEDUPE-ID RACE PASS');
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function crashRollbackRegression(hook) {
  const { session } = createSession(`crash-${hook}`);
  const dedupeKey = `crash-${hook}-unique`;
  const input = { senderRole: 'cto', recipientRole: 'architect', payload: { command: 'node --check crash.js' }, dedupeKey };
  const script = `
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    s.enqueueSessionMessage(${JSON.stringify(session.session_id)},${JSON.stringify(input)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', [hook]: 'SIGKILL' }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL', `enqueue process should die at ${hook}: ${stderr}`);
  let saved = state(session.session_id, dedupeKey);
  assert.equal(saved.messages.length, 0, `${hook}: message row must roll back with uncommitted event`);
  assert.equal(saved.events.length, 0, `${hook}: queue event must roll back with its message row`);
  const retried = store.enqueueSessionMessage(session.session_id, input);
  saved = state(session.session_id, dedupeKey);
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.messages[0].message_id, retried.message_id);
  console.log(`SESSION ENQUEUE SIGKILL ${hook} / INDEPENDENT REOPEN / ATOMIC RETRY PASS`);
}

try {
  await dedupePayloadSubstitutionRegression();
  await sameRequestIdempotencyRegression();
  await concurrentEnqueueRegression();
  await crashRollbackRegression('CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_MESSAGE_INSERT');
  await crashRollbackRegression('CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_MESSAGE_EVENT_INSERT');
  console.log('test-session-enqueue-atomicity: PASS');
} finally {
  try { store.db.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
