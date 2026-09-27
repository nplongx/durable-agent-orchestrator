import assert from 'node:assert/strict';
import fs from 'node:fs';

const dbPath = `/tmp/cos-m3-${process.pid}.db`;
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = '/tmp';

const { WorkflowStore } = await import('../job-store.js');
const { ProviderAdmissionController, ProviderStates } = await import('../provider-admission.js');
const store = new WorkflowStore();
const admission = new ProviderAdmissionController(store, { hardBlockMs: 60_000, leaseMs: 30_000 });
const providers = ['chatgpt:account:1', 'chatgpt:account:2', 'chatgpt:account:3', 'chatgpt:account:4'];
admission.syncProviders(providers);

const job = store.createJob({ conversationKey: `m3-${process.pid}`, title: 'M3 admission test' });
const lease = admission.admit({ providerIds: providers, jobId: job.job_id, role: 'cto' });
assert.equal(typeof lease.leaseId, 'string');
assert.ok(admission.status(lease.providerId).in_flight >= 1);
admission.release(lease.leaseId);
assert.equal(admission.status(lease.providerId).state, ProviderStates.READY);

for (const provider of providers) admission.markRateLimited(provider, 'test-hard-block', 60_000);
assert.throws(
  () => admission.admit({ providerIds: providers, jobId: job.job_id, role: 'architect' }),
  error => error.code === 'PROVIDER_UNAVAILABLE' && error.retryAfterMs > 0
);
assert.equal(admission.all().every(p => p.state === ProviderStates.COOLDOWN), true);

admission.syncProviders(['chatgpt:global']);
admission.markRateLimited('chatgpt:global', 'global-quota', 60_000);
assert.throws(
  () => admission.admit({ providerIds: ['chatgpt:global', ...providers], jobId: job.job_id, role: 'cto' }),
  error => error.code === 'PROVIDER_UNAVAILABLE'
);

const probeProvider = providers[0];
store.db.prepare("UPDATE provider_admission SET cooldown_until=?, probe_after=? WHERE provider_id=?")
  .run(new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1000).toISOString(), probeProvider);
const probeLease = admission.admit({ providerIds: providers, jobId: job.job_id, role: 'qa' });
assert.equal(probeLease.providerId, probeProvider);
admission.release(probeLease.leaseId);

console.log('M3 PROVIDER ADMISSION PASS');
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(p, { force: true });
