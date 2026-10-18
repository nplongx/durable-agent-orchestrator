import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-delivery-atomicity-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const dbPath = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';
const modulePath = path.resolve(process.env.PHASE2_TEST_WORKFLOW_STORE_MODULE || fileURLToPath(new URL('../src/runtime/job-store.js', import.meta.url)));
const moduleUrl = pathToFileURL(modulePath).href;
const { WorkflowStore } = await import(moduleUrl);
const store = new WorkflowStore();
process.on('exit', () => {
  try { store.db.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const makeJob = label => store.createJob({ conversationKey: `report-delivery-${label}-${process.pid}`, title: `Report delivery ${label}` });
const eventId = (jobId, type, key) => store.db.prepare('SELECT event_id FROM events WHERE job_id=? AND type=? AND json_extract(payload_json,\'$.reportId\')=?')
  .get(jobId, type, key)?.event_id;
const count = (sql, ...params) => store.db.prepare(sql).get(...params).n;

function spawnStore(code, env = {}, timeout = 15000) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(), encoding: 'utf8', timeout,
    env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', ...env }
  });
}

function inspectJob(jobId) {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    return {
      reports: db.prepare('SELECT report_id,job_id,kind,content,created_at FROM reports WHERE job_id=? ORDER BY rowid').all(jobId),
      reportEvents: db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE job_id=? AND type='report.created' ORDER BY rowid").all(jobId),
      deliveryEvents: db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE job_id=? AND type='delivery.claimed' ORDER BY rowid").all(jobId)
    };
  } finally { db.close(); }
}

// Report row and report.created event are one savepoint; a JavaScript error
// after the event INSERT must roll back both and preserve the original failure.
{
  const job = makeJob('report-fault');
  const original = store.recordEvent.bind(store);
  let injected = false;
  store.recordEvent = (jobId, type, payload, dedupeKey) => {
    const id = original(jobId, type, payload, dedupeKey);
    if (!injected && jobId === job.job_id && type === 'report.created') { injected = true; throw new Error('injected post-report-event fault'); }
    return id;
  };
  try {
    assert.throws(() => store.createReport(job.job_id, 'final', 'fault fixture'), /injected post-report-event fault/);
  } finally { store.recordEvent = original; }
  assert.equal(injected, true);
  let state = inspectJob(job.job_id);
  assert.equal(state.reports.length, 0, 'report row must roll back when report.created persistence reports failure');
  assert.equal(state.reportEvents.length, 0, 'report event must roll back with the report row');
  const reportId = store.createReport(job.job_id, 'final', 'fault fixture');
  assert.ok(reportId);
  assert.equal(store.createReport(job.job_id, 'final', 'fault fixture'), reportId, 'same report retry must retain the exact durable report identity');
  state = inspectJob(job.job_id);
  assert.equal(state.reports.length, 1);
  assert.equal(state.reportEvents.length, 1);
  assert.equal(state.reportEvents[0].event_id, store.db.prepare('SELECT event_id FROM events WHERE job_id=? AND type=\'report.created\'').get(job.job_id).event_id);
  console.log('REPORT ROW/EVENT POST-INSERT FAILURE ROLLBACK / RETRY / IDEMPOTENCY PASS');
}

// Savepoints must compose with a caller-owned transaction rather than commit
// report or delivery state behind the caller's back.
{
  const job = makeJob('outer-transaction');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.createReport(job.job_id, 'final', 'outer transaction report');
    assert.equal(count('SELECT COUNT(*) AS n FROM reports WHERE job_id=?', job.job_id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='report.created'", job.job_id), 1);
    store.db.exec('ROLLBACK');
  } catch (error) {
    try { store.db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  assert.equal(inspectJob(job.job_id).reports.length, 0);
  assert.equal(inspectJob(job.job_id).reportEvents.length, 0);
  const reportId = store.createReport(job.job_id, 'final', 'outer transaction report');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(store.claimDelivery(job.job_id, reportId, 'local', 'outer-target'), true);
    assert.equal(count("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='delivery.claimed'", job.job_id), 1);
    store.db.exec('ROLLBACK');
  } catch (error) {
    try { store.db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  assert.equal(inspectJob(job.job_id).deliveryEvents.length, 0);
  assert.equal(store.claimDelivery(job.job_id, reportId, 'local', 'outer-target'), true);
  console.log('REPORT/DELIVERY NESTED SAVEPOINT / OUTER ROLLBACK PASS');
}

// Actual SIGKILL at both uncommitted report boundaries must expose no orphan
// row/event on an independent connection; fresh writer retries one coherent row.
for (const [label, hook] of [
  ['after-row-insert', 'CHAT_ON_STEROIDS_TEST_CRASH_AFTER_REPORT_ROW_INSERT'],
  ['after-event-insert', 'CHAT_ON_STEROIDS_TEST_CRASH_AFTER_REPORT_EVENT_INSERT']
]) {
  const job = makeJob(`sigkill-report-${label}`);
  const source = `
    const { WorkflowStore } = await import(${JSON.stringify(moduleUrl)});
    const store = new WorkflowStore();
    store.createReport(${JSON.stringify(job.job_id)}, 'final', ${JSON.stringify(`SIGKILL report ${label}`)});
  `;
  const child = spawnStore(source, { [hook]: 'SIGKILL' });
  assert.equal(child.signal, 'SIGKILL', `report writer should die at ${label}: ${child.stderr}`);
  let state = inspectJob(job.job_id);
  assert.equal(state.reports.length, 0, `${label}: no orphan report row should survive rollback`);
  assert.equal(state.reportEvents.length, 0, `${label}: no orphan report event should survive rollback`);
  const retry = store.createReport(job.job_id, 'final', `SIGKILL report ${label}`);
  assert.ok(retry);
  state = inspectJob(job.job_id);
  assert.equal(state.reports.length, 1);
  assert.equal(state.reportEvents.length, 1);
  console.log(`REPORT SIGKILL ${label.toUpperCase()} / INDEPENDENT REOPEN / RETRY PASS`);
}

// A legacy interrupted report row with no event can be reconciled only by
// publishing its exact deterministic event under writer serialization.
{
  const job = makeJob('orphan-report-repair');
  const reportId = store.createReport(job.job_id, 'final', 'orphan report fixture');
  store.db.prepare("DELETE FROM events WHERE job_id=? AND type='report.created'").run(job.job_id);
  assert.equal(inspectJob(job.job_id).reports.length, 1);
  assert.equal(inspectJob(job.job_id).reportEvents.length, 0);
  assert.equal(store.createReport(job.job_id, 'final', 'orphan report fixture'), reportId);
  const repaired = inspectJob(job.job_id);
  assert.equal(repaired.reports.length, 1);
  assert.equal(repaired.reportEvents.length, 1);
  assert.equal(JSON.parse(repaired.reportEvents[0].payload_json).reportId, reportId);
  console.log('REPORT ORPHAN-ROW DETERMINISTIC EVENT RECONCILIATION PASS');
}

// A delivery claim must be rooted in one exact durable report-created event;
// otherwise the ledger can acknowledge delivery for a detached report row.
{
  const job = makeJob('detached-report-delivery');
  const reportId = store.createReport(job.job_id, 'final', 'detached report fixture');
  store.db.prepare("DELETE FROM events WHERE job_id=? AND type='report.created'").run(job.job_id);
  assert.throws(() => store.claimDelivery(job.job_id, reportId, 'local', 'detached-target'),
    /exact durable report.created lineage/i,
    'claimDelivery must reject a report row whose report.created event is missing');
  assert.equal(inspectJob(job.job_id).deliveryEvents.length, 0, 'a detached report must not gain a delivery acknowledgement');
  assert.equal(store.createReport(job.job_id, 'final', 'detached report fixture'), reportId,
    'report retry should repair its missing deterministic event before delivery');
  assert.equal(store.claimDelivery(job.job_id, reportId, 'local', 'detached-target'), true);
  assert.equal(inspectJob(job.job_id).reportEvents.length, 1);
  assert.equal(inspectJob(job.job_id).deliveryEvents.length, 1);
  console.log('DELIVERY CLAIM DETACHED REPORT ROW / EVENT LINEAGE REJECTION PASS');
}

// Report event duplicate keys and replay rows cannot be hidden by JSON.parse.
{
  const job = makeJob('report-adversarial-events');
  const reportId = store.createReport(job.job_id, 'final', 'canonical report');
  const row = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='report.created'").get(job.job_id);
  const canonical = row.payload_json;
  const duplicateKey = canonical.replace('"reportId":', '"reportId":"detached","reportId":');
  assert.deepEqual(JSON.parse(duplicateKey), JSON.parse(canonical));
  try {
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(duplicateKey, row.event_id);
    assert.throws(() => store.createReport(job.job_id, 'final', 'canonical report'), /non-canonical report.created event JSON/);
  } finally { store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonical, row.event_id); }
  const duplicateId = `duplicate-report-event-${process.pid}`;
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE event_id=?').get(duplicateId).n, 0);
  store.db.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
    .run(duplicateId, job.job_id, 'report.created', canonical, new Date().toISOString());
  try { assert.throws(() => store.createReport(job.job_id, 'final', 'canonical report'), /duplicate logical report.created events/); }
  finally { store.db.prepare('DELETE FROM events WHERE event_id=?').run(duplicateId); }
  assert.equal(store.createReport(job.job_id, 'final', 'canonical report'), reportId);
  console.log('REPORT DUPLICATE-DECODED-KEY / DUPLICATE-EVENT REJECTION PASS');
}

// Delivery claim persistence has the same row/event-style atomicity requirement.
// A failure after INSERT and SIGKILL before savepoint release both roll back the
// claim; the report itself remains durable and retry creates one exact claim.
{
  const job = makeJob('delivery-fault');
  const reportId = store.createReport(job.job_id, 'final', 'delivery fault fixture');
  const original = store.recordEvent.bind(store);
  let injected = false;
  store.recordEvent = (jobId, type, payload, dedupeKey) => {
    const id = original(jobId, type, payload, dedupeKey);
    if (!injected && jobId === job.job_id && type === 'delivery.claimed') { injected = true; throw new Error('injected post-delivery-event fault'); }
    return id;
  };
  try { assert.throws(() => store.claimDelivery(job.job_id, reportId, 'local', 'fault-target'), /injected post-delivery-event fault/); }
  finally { store.recordEvent = original; }
  assert.equal(inspectJob(job.job_id).deliveryEvents.length, 0);
  assert.equal(store.claimDelivery(job.job_id, reportId, 'local', 'fault-target'), true);
  assert.equal(store.claimDelivery(job.job_id, reportId, 'local', 'fault-target'), false);
  assert.equal(inspectJob(job.job_id).deliveryEvents.length, 1);
  console.log('DELIVERY CLAIM POST-INSERT FAILURE ROLLBACK / IDEMPOTENCY PASS');
}

{
  const job = makeJob('sigkill-delivery');
  const reportId = store.createReport(job.job_id, 'final', 'SIGKILL delivery fixture');
  const source = `
    const { WorkflowStore } = await import(${JSON.stringify(moduleUrl)});
    const store = new WorkflowStore();
    store.claimDelivery(${JSON.stringify(job.job_id)}, ${JSON.stringify(reportId)}, 'local', 'SIGKILL-target');
  `;
  const child = spawnStore(source, { CHAT_ON_STEROIDS_TEST_CRASH_AFTER_DELIVERY_EVENT_INSERT: 'SIGKILL' });
  assert.equal(child.signal, 'SIGKILL', `delivery claim writer should die after event INSERT: ${child.stderr}`);
  assert.equal(inspectJob(job.job_id).reports.length, 1, 'report is committed independently before delivery claim');
  assert.equal(inspectJob(job.job_id).deliveryEvents.length, 0, 'unreleased delivery savepoint must roll back event insertion');
  assert.equal(store.claimDelivery(job.job_id, reportId, 'local', 'SIGKILL-target'), true);
  assert.equal(store.claimDelivery(job.job_id, reportId, 'local', 'SIGKILL-target'), false);
  assert.equal(inspectJob(job.job_id).deliveryEvents.length, 1);
  console.log('DELIVERY CLAIM SIGKILL / INDEPENDENT REOPEN / RETRY PASS');
}

// Same-request concurrent report and delivery writers serialize to one logical
// row/event. Conflicting duplicate payloads must fail rather than return false.
async function runTwoProcessBarrier({ label, barrierEnv, sourceCodeFactory, readyContents, releaseContent = 'release\n' }) {
  const directory = path.join(root, `${label}-barrier`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const children = Array.from({ length: 2 }, () => {
    const code = sourceCodeFactory();
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
        WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', [barrierEnv]: directory }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
    return { proc, done: new Promise(resolve => proc.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))) };
  });
  try {
    const ready = children.map(({ proc }) => path.join(directory, `${proc.pid}.ready`));
    const deadline = Date.now() + 15000;
    while (!ready.every(file => fs.existsSync(file))) {
      if (Date.now() > deadline) throw new Error(`${label}: both writer processes did not reach barrier`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    if (readyContents) for (const file of ready) assert.equal(fs.readFileSync(file, 'utf8'), readyContents);
    fs.writeFileSync(path.join(directory, 'release'), releaseContent, { flag: 'wx', mode: 0o600 });
    return await Promise.all(children.map(child => child.done));
  } finally {
    for (const { proc } of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
}

{
  const job = makeJob('report-concurrency');
  const content = 'concurrent exact report';
  const outcomes = await runTwoProcessBarrier({ label: 'concurrent-create-report', barrierEnv: 'CHAT_ON_STEROIDS_TEST_CREATE_REPORT_BARRIER_DIR',
    sourceCodeFactory: () => `const {WorkflowStore}=await import(${JSON.stringify(moduleUrl)});const s=new WorkflowStore();try{console.log('REPORT_ID:'+s.createReport(${JSON.stringify(job.job_id)},'final',${JSON.stringify(content)}))}finally{s.db.close()}`,
    readyContents: `${job.job_id}\n` });
  assert.ok(outcomes.every(item => item.code === 0 && item.stdout.includes('REPORT_ID:')), JSON.stringify(outcomes));
  const ids = outcomes.map(item => item.stdout.match(/REPORT_ID:(\S+)/)?.[1]);
  assert.equal(new Set(ids).size, 1, 'competing idempotent report writers must converge on one report ID');
  assert.equal(inspectJob(job.job_id).reports.length, 1);
  assert.equal(inspectJob(job.job_id).reportEvents.length, 1);
  console.log('REPORT TWO-PROCESS IDENTICAL REQUEST RACE PASS');
}

{
  const job = makeJob('delivery-concurrency');
  const reportId = store.createReport(job.job_id, 'final', 'concurrent delivery report');
  const outcomes = await runTwoProcessBarrier({ label: 'concurrent-claim-delivery', barrierEnv: 'CHAT_ON_STEROIDS_TEST_CLAIM_DELIVERY_BARRIER_DIR',
    sourceCodeFactory: () => `const {WorkflowStore}=await import(${JSON.stringify(moduleUrl)});const s=new WorkflowStore();try{console.log('CLAIM:'+s.claimDelivery(${JSON.stringify(job.job_id)},${JSON.stringify(reportId)},'local','race-target'))}finally{s.db.close()}`,
    readyContents: `${job.job_id}|${reportId}\n` });
  assert.ok(outcomes.every(item => item.code === 0 && /CLAIM:(true|false)/.test(item.stdout)), JSON.stringify(outcomes));
  assert.deepEqual(outcomes.map(item => item.stdout.match(/CLAIM:(true|false)/)?.[1]).sort(), ['false', 'true']);
  assert.equal(inspectJob(job.job_id).deliveryEvents.length, 1);
  console.log('DELIVERY CLAIM TWO-PROCESS IDENTICAL REQUEST RACE PASS');
}

// An existing deterministic primary key with altered or duplicate-key payload
// is corruption, not evidence that delivery has already been claimed.
{
  const job = makeJob('delivery-adversarial');
  const reportId = store.createReport(job.job_id, 'final', 'delivery adversarial report');
  assert.equal(store.claimDelivery(job.job_id, reportId, 'local', 'canonical-target'), true);
  const row = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='delivery.claimed'").get(job.job_id);
  const canonical = row.payload_json;
  const duplicateKey = canonical.replace('"channel":', '"channel":"detached","channel":');
  assert.deepEqual(JSON.parse(duplicateKey), JSON.parse(canonical));
  try {
    store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(duplicateKey, row.event_id);
    assert.throws(() => store.claimDelivery(job.job_id, reportId, 'local', 'canonical-target'), /non-canonical delivery.claimed event JSON/);
  } finally { store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonical, row.event_id); }
  const expectedId = row.event_id;
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run('{"reportId":"different","channel":"local","target":"canonical-target"}', expectedId);
  try { assert.throws(() => store.claimDelivery(job.job_id, reportId, 'local', 'canonical-target'), /conflicting durable evidence/); }
  finally { store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonical, expectedId); }
  assert.equal(store.claimDelivery(job.job_id, reportId, 'local', 'canonical-target'), false);
  console.log('DELIVERY CLAIM CORRUPTED / DUPLICATE-KEY EVENT REJECTION PASS');
}

console.log('test-report-delivery-atomicity: PASS');
