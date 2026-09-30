import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GitHubOidcVerifier, RunnerAdmissionBroker } from '../src/runtime/runner-admission-broker.js';
import { GatewayRunnerAdmissionService } from '../src/runtime/gateway-runner-admission.js';

const now = Date.parse('2026-09-30T06:00:00Z');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
publicJwk.kid = 'phase1-kid';
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';

const claims = {
  iss: 'https://token.actions.githubusercontent.com',
  aud: 'https://runner-broker.example',
  repository: 'example/repo',
  workflow: 'P3 Distributed Worker',
  workflow_ref: 'example/repo/.github/workflows/p3-worker.yml@refs/heads/main',
  run_id: 'run-1',
  run_attempt: '1',
  jti: 'phase1-jti',
  iat: Math.floor(now / 1000) - 10,
  exp: Math.floor(now / 1000) + 300,
};

const sign = (overrides = {}) => {
  const payload = { ...claims, ...overrides };
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = { alg: 'RS256', typ: 'JWT', kid: 'phase1-kid' };
  const input = `${b64(header)}.${b64(payload)}`;
  const signature = crypto.createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
};

const verifier = new GitHubOidcVerifier({
  audience: claims.aud,
  now: () => now,
  fetchImpl: async (url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify({
        issuer: claims.iss,
        jwks_uri: `${claims.iss}/keys`,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
  },
});

let nativeProvisionCalls = 0;
const gateway = new GatewayRunnerAdmissionService({
  now: () => now,
  provisioner: {
    async provision(input) {
      nativeProvisionCalls++;
      assert.deepEqual(input.requiredBootstrapProfile, {
        roles: ['node'],
        scopes: [],
        purpose: 'cloud-worker',
      });
      assert.equal(input.binding.lease_id, 'lease-1');
      return {
        schema_version: 1,
        admission_id: 'admission-1',
        environment_id: 'env-1',
        node_setup_id: 'setup-1',
        owner_epoch: 9,
        lease_id: 'lease-1',
        expires_at: '2026-09-30T06:04:00Z',
        bootstrap: {
          target: 'wss://gateway.example',
          credential: 'short-lived-node-credential',
        },
        operator_admin_token: 'must-not-escape',
      };
    },
  },
});

const broker = new RunnerAdmissionBroker({
  oidcVerifier: verifier,
  gateway,
  repository: claims.repository,
  workflow: claims.workflow,
  workflowRef: claims.workflow_ref,
  audience: claims.aud,
  now: () => now,
  authorizeBinding: async (binding) => ({
    allowed: binding.task_id === 'task-1' && binding.lease_id === 'lease-1' && binding.attempt === 1,
  }),
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
  expires_at: '2026-09-30T06:04:00Z',
};

const first = await broker.admit({ token: sign(), request });
assert.deepEqual(first, {
  schema_version: 1,
  admission_id: 'admission-1',
  environment_id: 'env-1',
  node_setup_id: 'setup-1',
  owner_epoch: 9,
  lease_id: 'lease-1',
  expires_at: '2026-09-30T06:04:00.000Z',
  bootstrap: {
    target: 'wss://gateway.example',
    credential: 'short-lived-node-credential',
  },
});
assert.equal(nativeProvisionCalls, 1);
assert.equal('operator_admin_token' in first, false);
assert.equal('role' in first, false);
assert.equal('scopes' in first, false);
assert.equal('purpose' in first, false);

const replay = await broker.admit({ token: sign(), request });
assert.deepEqual(replay, first);
assert.equal(nativeProvisionCalls, 1);

await assert.rejects(
  broker.admit({ token: sign({ jti: 'different-task-jti' }), request: { ...request, task_id: 'task-2' } }),
  (error) => error.code === 'ADMISSION_BINDING_DENIED',
);

await assert.rejects(
  broker.admit({
    token: sign({ jti: 'different-lease-jti' }),
    request: { ...request, lease_id: 'lease-2' },
  }),
  (error) => error.code === 'ADMISSION_BINDING_DENIED',
);

console.log('M12 Phase1 end-to-end contract PASS');
