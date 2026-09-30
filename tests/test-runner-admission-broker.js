import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GitHubOidcVerifier, RunnerAdmissionBroker } from '../src/runtime/runner-admission-broker.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
publicJwk.kid = 'test-kid';
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';

const now = Date.parse('2026-09-30T04:00:00Z');
const claims = {
  iss: 'https://token.actions.githubusercontent.com',
  aud: 'https://broker.example',
  sub: 'repo:example/repo:ref:refs/heads/main',
  repository: 'example/repo',
  workflow: 'P3 Distributed Worker',
  workflow_ref: 'example/repo/.github/workflows/p3-worker.yml@refs/heads/main',
  run_id: '123',
  run_attempt: '1',
  jti: 'jti-1',
  iat: Math.floor(now / 1000) - 30,
  exp: Math.floor(now / 1000) + 300
};

function sign(overrides = {}) {
  const payload = { ...claims, ...overrides };
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-kid' };
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${b64(header)}.${b64(payload)}`;
  const signature = crypto.createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}

const verifier = new GitHubOidcVerifier({
  audience: 'https://broker.example',
  now: () => now,
  fetchImpl: async url => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify({
        issuer: 'https://token.actions.githubusercontent.com',
        jwks_uri: 'https://token.actions.githubusercontent.com/keys'
      }), { status: 200 });
    }
    if (url.endsWith('/keys')) return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    throw new Error(`unexpected OIDC URL ${url}`);
  }
});

const gatewayCalls = [];
const gateway = {
  async provisionCloudWorkerAdmission(input) {
    gatewayCalls.push(input);
    return {
      admission_id: 'admission-1',
      environment_id: 'env-1',
      node_setup_id: 'setup-1',
      owner_epoch: 7,
      lease_id: 'lease-1',
      expires_at: '2026-09-30T04:04:00Z',
      bootstrap: { target: 'gateway', credential: 'short-lived-test' }
    };
  }
};

const broker = new RunnerAdmissionBroker({
  oidcVerifier: verifier,
  gateway,
  repository: 'example/repo',
  workflow: 'P3 Distributed Worker',
  workflowRef: claims.workflow_ref,
  audience: 'https://broker.example',
  now: () => now,
  authorizeBinding: async input => ({
    allowed: input.task_id === 'task-1' && input.lease_id === 'lease-1' && input.attempt === 1
  })
});

const request = {
  repository: claims.repository,
  workflow: claims.workflow,
  workflow_ref: claims.workflow_ref,
  run_id: claims.run_id,
  run_attempt: 1,
  job_id: 'job-1',
  task_id: 'task-1',
  lease_id: 'lease-1',
  attempt: 1,
  input_commit: 'a'.repeat(40),
  role: 'researcher',
  expires_at: '2026-09-30T04:04:00Z'
};

const first = await broker.admit({ token: sign(), request });
assert.equal(first.environment_id, 'env-1');
assert.equal(gatewayCalls.length, 1);
const second = await broker.admit({ token: sign(), request });
assert.deepEqual(second, first);
assert.equal(gatewayCalls.length, 1, 'same OIDC/task admission must be idempotent');

let concurrentCalls = 0;
const concurrentGateway = {
  async provisionCloudWorkerAdmission() {
    concurrentCalls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return {
      admission_id: 'admission-concurrent',
      environment_id: 'env-concurrent',
      node_setup_id: 'setup-concurrent',
      owner_epoch: 8,
      lease_id: 'lease-1',
      expires_at: '2026-09-30T04:04:00Z',
      bootstrap: { target: 'gateway', credential: 'short-lived-test' }
    };
  }
};
const concurrentBroker = new RunnerAdmissionBroker({
  oidcVerifier: verifier, gateway: concurrentGateway, repository: claims.repository,
  workflow: claims.workflow, workflowRef: claims.workflow_ref, audience: claims.aud,
  now: () => now, authorizeBinding: async () => ({ allowed: true })
});
const concurrent = await Promise.all([
  concurrentBroker.admit({ token: sign({ jti: 'jti-concurrent' }), request }),
  concurrentBroker.admit({ token: sign({ jti: 'jti-concurrent' }), request })
]);
assert.deepEqual(concurrent[0], concurrent[1]);
assert.equal(concurrentCalls, 1, 'concurrent admission must single-flight');

await assert.rejects(
  broker.admit({ token: sign({ workflow: 'other' }), request }),
  error => error.code === 'ADMISSION_BINDING_MISMATCH'
);
await assert.rejects(
  broker.admit({ token: sign({ exp: Math.floor(now / 1000) - 60 }), request }),
  error => error.code === 'OIDC_EXPIRED'
);
await assert.rejects(
  broker.admit({ token: sign({ jti: 'jti-1' }), request: { ...request, task_id: 'task-2' } }),
  error => error.code === 'OIDC_REPLAY'
);
await assert.rejects(
  broker.admit({ token: sign({ jti: 'jti-wrong-lease' }), request: { ...request, lease_id: 'wrong-lease' } }),
  error => error.code === 'ADMISSION_BINDING_DENIED'
);

const unsafeGateway = {
  async provisionCloudWorkerAdmission() {
    return { admission_id: 'x', environment_id: 'e', node_setup_id: 's', owner_epoch: 1, lease_id: 'lease-1', expires_at: request.expires_at, bootstrap: {} };
  }
};
const unsafeBroker = new RunnerAdmissionBroker({
  oidcVerifier: verifier, gateway: unsafeGateway, repository: claims.repository,
  workflow: claims.workflow, workflowRef: claims.workflow_ref, audience: claims.aud,
  now: () => now, authorizeBinding: async () => ({ allowed: true })
});
await assert.rejects(unsafeBroker.admit({ token: sign(), request }), error => error.code === 'INVALID_REQUEST');

const invalidExpiryGateway = {
  async provisionCloudWorkerAdmission() {
    return {
      admission_id: 'x', environment_id: 'e', node_setup_id: 's', owner_epoch: 1,
      lease_id: 'lease-1', expires_at: '2026-09-30T04:05:00Z',
      bootstrap: { target: 'gateway', credential: 'short-lived-test' }
    };
  }
};
const invalidExpiryBroker = new RunnerAdmissionBroker({
  oidcVerifier: verifier, gateway: invalidExpiryGateway, repository: claims.repository,
  workflow: claims.workflow, workflowRef: claims.workflow_ref, audience: claims.aud,
  now: () => now, authorizeBinding: async () => ({ allowed: true })
});
await assert.rejects(
  invalidExpiryBroker.admit({ token: sign({ jti: 'jti-expiry' }), request }),
  error => error.code === 'GATEWAY_ADMISSION_INVALID'
);

console.log('runner-admission-broker Phase1 PASS');
