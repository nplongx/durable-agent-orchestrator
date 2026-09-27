import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-phase5d-'));
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');
const { workflowStore } = await import('./job-store.js');

const job = workflowStore.createJob({ conversationKey: 'phase5d-slack', title: 'slack projection idempotency' });
workflowStore.dispatch(job.job_id, { role: 'cto', description: 'slack test task' });
const events = workflowStore.listUnprojectedEvents(10);
assert.ok(events.length >= 1);
const event = events.at(-1);

const firstThread = workflowStore.ensureSlackThread(job.job_id, {
  channel: 'slack',
  target: 'C_TEST',
});
const secondThread = workflowStore.ensureSlackThread(job.job_id, {
  channel: 'slack',
  target: 'C_OTHER',
});
assert.equal(firstThread.job_id, secondThread.job_id);
assert.equal(firstThread.channel, secondThread.channel);
assert.equal(firstThread.target, secondThread.target);
assert.equal(workflowStore.getSlackThread(job.job_id).target, 'C_TEST');

assert.equal(workflowStore.isSlackProjected(event.event_id), false);
assert.equal(workflowStore.claimSlackProjection(event.event_id, job.job_id, {
  channel: 'slack',
  target: 'C_TEST',
  messageId: 'msg-1',
}), true);
assert.equal(workflowStore.isSlackProjected(event.event_id), true);
assert.equal(workflowStore.claimSlackProjection(event.event_id, job.job_id, {
  channel: 'slack',
  target: 'C_TEST',
  messageId: 'msg-duplicate',
}), false);
assert.equal(workflowStore.db.prepare('SELECT COUNT(*) n FROM slack_projections WHERE event_id = ?').get(event.event_id).n, 1);
assert.equal(workflowStore.listUnprojectedEvents(100).some(e => e.event_id === event.event_id), false);

const telemetryJob = workflowStore.createJob({ conversationKey: 'phase5d-telemetry', title: 'slack telemetry relevance' });
workflowStore.recordEvent(telemetryJob.job_id, 'session.heartbeat', { sessionId: 'session-test' }, 'heartbeat-test');
workflowStore.recordEvent(telemetryJob.job_id, 'session.stale', { sessionId: 'session-test', reason: 'test' }, 'stale-test');
const telemetryProjection = workflowStore.getSlackProjection(telemetryJob.job_id);
assert.equal(telemetryProjection.totalEvents, 0);
assert.equal(telemetryProjection.pendingEvents, 0);
assert.equal(workflowStore.listUnprojectedEvents(100).some(e => e.job_id === telemetryJob.job_id), false);
workflowStore.recordEvent(telemetryJob.job_id, 'report.created', { reportId: 'report-test' }, 'business-test');
const businessProjection = workflowStore.getSlackProjection(telemetryJob.job_id);
assert.equal(businessProjection.totalEvents, 1);
assert.equal(businessProjection.pendingEvents, 1);
assert.equal(workflowStore.listUnprojectedEvents(100).some(e => e.job_id === telemetryJob.job_id && e.type === 'report.created'), true);

console.log('phase5d Slack idempotency tests: PASS');
