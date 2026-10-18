import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-projection-uncertain-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';
const modulePath = path.resolve(process.env.PHASE2_TEST_JOB_STORE_MODULE || fileURLToPath(new URL('../src/runtime/job-store.js', import.meta.url)));
const { WorkflowStore } = await import(pathToFileURL(modulePath).href);
const store = new WorkflowStore();
try {
  const job = store.createJob({ conversationKey: `slack-uncertain-${process.pid}`, title: 'Slack ambiguous delivery fixture' });
  const eventId = store.recordEvent(job.job_id, 'task.completed', { taskId: 'fixture-task' }, 'slack-uncertain-fixture');
  assert.ok(store.listUnprojectedEvents(10, job.job_id).some(event => event.event_id === eventId));

  assert.equal(store.beginSlackProjectionSend(eventId, job.job_id, { channel: 'slack', target: 'C-test' }), true);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { WorkflowStore } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    const childStore = new WorkflowStore();
    try { console.log(JSON.stringify({ acquired: childStore.beginSlackProjectionSend(${JSON.stringify(eventId)}, ${JSON.stringify(job.job_id)}, { channel: 'slack', target: 'C-test' }) })); }
    finally { childStore.db.close(); }
  `], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, WORKFLOW_DB: process.env.WORKFLOW_DB, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: root, NODE_ENV: 'test' } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { acquired: false }, 'a second process cannot obtain the durable send claim');
  assert.equal(store.listUnprojectedEvents(10, job.job_id).some(event => event.event_id === eventId), false,
    'a restart must not automatically replay an in-flight remote effect');

  const uncertain = store.markSlackProjectionUncertain(eventId, job.job_id, {
    channel: 'slack', target: 'C-test', error: 'timeout after remote acceptance may have occurred'
  });
  assert.equal(uncertain.event_id, eventId);
  assert.equal(store.listUnprojectedEvents(10, job.job_id).some(event => event.event_id === eventId), false,
    'ambiguous remote sends must not be automatically replayed after restart');
  assert.equal(store.listUncertainSlackProjections(job.job_id).length, 1);
  assert.throws(() => store.claimSlackProjection(eventId, job.job_id, { channel: 'slack', target: 'C-test', messageId: 'fake' }), /uncertain Slack projection/);
  assert.throws(() => store.markSlackProjectionUncertain(eventId, job.job_id, {
    channel: 'slack', target: 'C-test', error: 'different competing explanation'
  }), /conflicts with existing evidence/);
  assert.throws(() => store.completeSlackProjection(eventId, job.job_id, {
    channel: 'slack', target: 'C-test', messageId: 'm-uncertain'
  }), /send ownership is missing|conflicts with prior receipt|already uncertain/);

  const certain = store.recordEvent(job.job_id, 'task.failed', { taskId: 'other-task' }, 'certain-fixture');
  assert.equal(store.listUnprojectedEvents(10, job.job_id).some(event => event.event_id === certain), true,
    'events with no remote send attempt remain retryable');

  const knownNoSend = store.recordEvent(job.job_id, 'task.created', { taskId: 'known-no-send' }, 'known-no-send-fixture');
  assert.equal(store.beginSlackProjectionSend(knownNoSend, job.job_id, { channel: 'slack', target: 'C-test' }), true);
  assert.equal(store.listUnprojectedEvents(10, job.job_id).some(event => event.event_id === knownNoSend), false,
    'a committed send claim suppresses replay while transport outcome is unknown');
  assert.equal(store.releaseSlackProjectionSendClaim(knownNoSend, job.job_id, { channel: 'slack', target: 'C-test' }), true,
    'only a caller with independently proven not-sent outcome may release the exact unresolved pre-send sentinel');
  assert.equal(store.listUnprojectedEvents(10, job.job_id).some(event => event.event_id === knownNoSend), true,
    'a known no-send may become retryable without claiming remote idempotency');
  assert.equal(store.releaseSlackProjectionSendClaim(knownNoSend, job.job_id, { channel: 'slack', target: 'C-test' }), false,
    'claim release must be one-shot and compare-and-set guarded');
  assert.equal(store.beginSlackProjectionSend(knownNoSend, job.job_id, { channel: 'slack', target: 'C-test' }), true);
  store.markSlackProjectionUncertain(knownNoSend, job.job_id, {
    channel: 'slack', target: 'C-test', error: 'second attempt may have reached the destination'
  });
  assert.equal(store.releaseSlackProjectionSendClaim(knownNoSend, job.job_id, { channel: 'slack', target: 'C-test' }), false,
    'release must never clear a durable uncertain remote outcome');
  assert.equal(store.listUnprojectedEvents(10, job.job_id).some(event => event.event_id === knownNoSend), false,
    'uncertain sends remain quarantined after release attempts');

  const delivered = store.recordEvent(job.job_id, 'report.created', { reportId: 'fixture-report' }, 'successful-projection-fixture');
  store.ensureSlackThread(job.job_id, { channel: 'slack', target: 'C-test' });
  assert.equal(store.beginSlackProjectionSend(delivered, job.job_id, { channel: 'slack', target: 'C-test' }), true);
  const projection = store.completeSlackProjection(delivered, job.job_id, {
    channel: 'slack', target: 'C-test', messageId: '171234.0003', rootMessageId: '171234.0003'
  });
  assert.equal(projection.message_id, '171234.0003');
  assert.equal(store.isSlackProjected(delivered), true);
  const uncertainEvents = store.listUncertainSlackProjections(job.job_id).map(item => item.event_id);
  assert.equal(uncertainEvents.filter(id => id === eventId).length, 1, 'the original unresolved event remains quarantined');
  assert.equal(uncertainEvents.filter(id => id === knownNoSend).length, 1, 'the second attempt becomes quarantined once its remote outcome is uncertain');
  assert.equal(store.getSlackThread(job.job_id).root_message_id, '171234.0003');
  console.log('test-slack-projection-uncertain: PASS');
} finally {
  try { store.db.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
