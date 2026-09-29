import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const dbPath = path.join(tempDir('cos-m3-int-'), 'workflow.db');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = path.dirname(dbPath);

const { WorkflowStore } = await import('../job-store.js');
const { ProviderAdmissionController } = await import('../provider-admission.js');
const store = new WorkflowStore();
const admission = new ProviderAdmissionController(store, { hardBlockMs: 60_000, leaseMs: 30_000 });
const job = store.createJob({ conversationKey: `m3-int-${process.pid}`, title: 'M3 integration' });
const providers = ['chatgpt:account:1', 'chatgpt:account:2'];
admission.syncProviders(providers);

for (const provider of providers) admission.markRateLimited(provider, 'integration', 60_000);
let blocked = false;
try { admission.admit({ providerIds: providers, jobId: job.job_id, role: 'cto' }); }
catch (error) { blocked = error.code === 'PROVIDER_UNAVAILABLE'; }
assert.equal(blocked, true);
const waitingEvent = store.recordEvent(job.job_id, 'provider.waiting', { retryAfterMs: 60000 }, 'm3');
assert.ok(waitingEvent);
const event = store.db.prepare("SELECT type,payload_json FROM events WHERE event_id=?").get(waitingEvent);
assert.equal(event.type, 'provider.waiting');
assert.match(event.payload_json, /retryAfterMs/);

store.setWorkflowRuntimeState(job.job_id, 'ASSIGN_CHILDREN', {
  resumeAfter: new Date(Date.now() + 60_000).toISOString(),
  lastError: 'provider unavailable'
});
store.setProviderWaiting(job.job_id, 60_000, 'provider unavailable');
const waitingState = store.getWorkflowRuntimeState(job.job_id);
assert.ok(Date.parse(waitingState.resume_after) > Date.now());
assert.equal(store.getJob(job.job_id).provider_waiting, 1);
store.clearProviderWaiting(job.job_id);
assert.equal(store.getJob(job.job_id).provider_waiting, 0);
assert.equal(store.getWorkflowRuntimeState(job.job_id).resume_after, null);
assert.equal(store.getWorkflowRuntimeState(job.job_id).last_error, null);

const singleFlightJob = store.createJob({ conversationKey: 'm3-single-' + process.pid, title: 'M3 single flight' });
const singleFlight = new ProviderAdmissionController(store, { hardBlockMs: 60_000, leaseMs: 30_000 });
singleFlight.syncProviders(['chatgpt:single']);
const firstLease = singleFlight.admit({ providerIds: ['chatgpt:single'], jobId: singleFlightJob.job_id, role: 'architect' });
assert.throws(
  () => singleFlight.admit({ providerIds: ['chatgpt:single'], jobId: singleFlightJob.job_id, role: 'qa' }),
  error => error.code === 'PROVIDER_UNAVAILABLE'
);
singleFlight.release(firstLease.leaseId);
const secondLease = singleFlight.admit({ providerIds: ['chatgpt:single'], jobId: singleFlightJob.job_id, role: 'qa' });
assert.equal(secondLease.providerId, 'chatgpt:single');
singleFlight.release(secondLease.leaseId);

console.log('M3 DURABLE WAIT EVENT PASS');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
