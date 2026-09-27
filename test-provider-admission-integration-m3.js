import assert from 'node:assert/strict';
import fs from 'node:fs';

const dbPath = `/tmp/cos-m3-int-${process.pid}.db`;
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = '/tmp';

const { WorkflowStore } = await import('./job-store.js');
const { ProviderAdmissionController } = await import('./provider-admission.js');
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

console.log('M3 DURABLE WAIT EVENT PASS');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
