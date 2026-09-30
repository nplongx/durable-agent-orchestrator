import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CLOUD_WORKER_PROFILE, GatewayRunnerAdmissionService } from '../src/runtime/gateway-runner-admission.js';

const now = Date.parse('2026-09-30T05:00:00Z');
const binding = {
  repository: 'example/repo', workflow: 'P3 Distributed Worker', workflow_ref: 'example/repo/.github/workflows/p3-worker.yml@main',
  run_id: '123', run_attempt: 1, job_id: 'job-1', task_id: 'task-1', lease_id: 'lease-1', attempt: 1,
  input_commit: 'a'.repeat(40), role: 'researcher'
};

const hash = value => crypto.createHash('sha256').update(JSON.stringify(
  Object.fromEntries(['repository','workflow','workflow_ref','run_id','run_attempt','job_id','task_id','lease_id','attempt','input_commit','role'].map(k => [k, value[k]]))
)).digest('hex');

let calls = 0;
const service = new GatewayRunnerAdmissionService({
  now: () => now,
  provisioner: {
    async provision(input) {
      calls++;
      assert.deepEqual(input.requiredBootstrapProfile, CLOUD_WORKER_PROFILE);
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        admission_id: 'admission-1', environment_id: 'env-1', node_setup_id: 'setup-1', owner_epoch: 4,
        lease_id: 'lease-1', expires_at: '2026-09-30T05:04:00Z',
        bootstrap: { target: 'gateway', credential: 'short-lived' }
      };
    }
  }
});

const idempotencyKey = hash(binding);
const [a, b] = await Promise.all([
  service.provisionCloudWorkerAdmission({ binding, expiresAt: '2026-09-30T05:04:30Z', idempotencyKey }),
  service.provisionCloudWorkerAdmission({ binding, expiresAt: '2026-09-30T05:04:30Z', idempotencyKey })
]);
assert.deepEqual(a, b);
assert.equal(calls, 1);
assert.equal(a.bootstrap.credential, 'short-lived');

await assert.rejects(
  service.provisionCloudWorkerAdmission({ binding: { ...binding, role: 'node' }, expiresAt: '2026-09-30T05:04:30Z', idempotencyKey: hash({ ...binding, role: 'node' }) }),
  error => error.code === 'ADMISSION_ROLE_CONFLICT'
);
await assert.rejects(
  service.provisionCloudWorkerAdmission({ binding, expiresAt: '2026-09-30T05:04:30Z', idempotencyKey: 'wrong' }),
  error => error.code === 'ADMISSION_IDEMPOTENCY_MISMATCH'
);

console.log('gateway-runner-admission Phase1b PASS');
