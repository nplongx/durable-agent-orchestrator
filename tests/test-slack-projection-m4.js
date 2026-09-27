import assert from 'node:assert/strict';
import fs from 'node:fs';

const dbPath = `/tmp/cos-m4-${process.pid}.db`;
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = '/tmp';

const { WorkflowStore } = await import('../job-store.js');
const store = new WorkflowStore();
const job = store.createJob({ conversationKey: `m4-${process.pid}`, title: 'M4 Slack projection' });
store.dispatch(job.job_id, { role: 'cto', description: 'M4 projection test' });
const task = store.getTask(store.getJob(job.job_id).active_task_id);

// Internal telemetry and unknown implementation events never become Slack control/progress messages.
store.recordEvent(job.job_id, 'session.heartbeat', {});
store.recordEvent(job.job_id, 'session.stale', {});
store.recordEvent(job.job_id, 'internal.debug', { secret: 'must-not-project' });
store.recordEvent(job.job_id, 'task.completed', { taskId: task.task_id });

let projection = store.getSlackProjection(job.job_id);
assert.equal(projection.totalEvents, 2); // task.dispatched + task.completed
assert.equal(projection.pendingEvents, 2);

const pending = store.listUnprojectedEvents(20);
assert.deepEqual(pending.map(e => e.type), ['task.dispatched', 'task.completed']);

for (const event of pending) {
  assert.equal(store.claimSlackProjection(event.event_id, job.job_id, {
    channel: 'slack', target: 'C0C3RJKNKPG', messageId: `m-${event.event_id.slice(0, 8)}`
  }), true);
  store.refreshSlackJobView(job.job_id, { eventId: event.event_id, eventType: event.type });
}

projection = store.getSlackProjection(job.job_id);
assert.equal(projection.pendingEvents, 0);
assert.equal(projection.projectedEvents, 2);
assert.equal(projection.view.state, 'EXECUTING');
assert.equal(projection.view.task_running, 1);
assert.equal(projection.view.task_completed, 0);
assert.equal(store.claimSlackProjection(pending[0].event_id, job.job_id, { messageId: 'duplicate' }), false);

store.setProviderWaiting(job.job_id, 60_000, 'all provider accounts cooling down');
const waiting = store.listUnprojectedEvents(10).find(e => e.type === 'provider.waiting');
assert.ok(waiting);
assert.equal(store.getJob(job.job_id).provider_waiting, 1);
assert.ok(store.getJob(job.job_id).provider_retry_at);
store.claimSlackProjection(waiting.event_id, job.job_id, { channel: 'slack', target: 'C0C3RJKNKPG', messageId: 'provider-wait' });
store.refreshSlackJobView(job.job_id, { eventId: waiting.event_id, eventType: waiting.type });
assert.equal(store.getSlackJobView(job.job_id).provider_waiting, 1);

console.log('M4 SLACK PROJECTION PASS');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
