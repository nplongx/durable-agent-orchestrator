import assert from 'node:assert/strict';

// Isolated contract fixture for the OpenClaw 2026.9.5 core hook.
// This deliberately does not import or mutate the live Gateway installation.

const now = Date.parse('2026-09-30T05:00:00Z');
const admissionTtlMs = 15 * 60 * 1000;

function createFixture() {
  const state = {
    environmentId: 'env-1',
    nodeSetupId: 'setup-1',
    ownerEpoch: 7,
    leaseId: 'lease-1',
    expiresAtMs: now + 4 * 60 * 1000,
    state: 'provisioning',
    destroyRequestedAtMs: null,
    nodeDeviceId: null,
  };
  let beginCalls = 0;
  let closed = 0;
  let destroyed = false;
  let aborted = false;
  let capability;

  const enrollment = {
    mode: 'connect',
    setupId: state.nodeSetupId,
    nodeBootstrap: { url: 'wss://gateway.example', token: 'short-lived-artifact-token' },
    signal: new AbortController().signal,
    setupCode: 'short-lived-node-setup-code',
    waitForDeviceId: async () => {
      assertCapabilityCurrent();
      state.nodeDeviceId = 'node-1';
      return state.nodeDeviceId;
    },
    close: () => {
      closed++;
      aborted = true;
    },
  };

  function assertCapabilityCurrent() {
    if (
      aborted ||
      state.state !== 'provisioning' ||
      state.destroyRequestedAtMs !== null ||
      capability === undefined ||
      capability.nodeSetupId !== state.nodeSetupId ||
      capability.ownerEpoch !== state.ownerEpoch ||
      capability.expiresAtMs <= now
    ) {
      throw new Error('capability fenced');
    }
  }

  async function admitCloudWorker({ leaseId, expiresAtMs, idempotencyKey }) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) throw new Error('idempotency required');
    if (leaseId !== state.leaseId) throw new Error('lease mismatch');
    if (expiresAtMs <= now || expiresAtMs > now + admissionTtlMs) {
      throw new Error('invalid admission expiry');
    }
    if (expiresAtMs > state.expiresAtMs) throw new Error('expiry escaped environment fence');
    if (state.destroyRequestedAtMs !== null || state.state !== 'provisioning') {
      throw new Error('environment not admissible');
    }
    beginCalls++;
    nativeBegin();
    capability.expiresAtMs = Math.min(expiresAtMs, state.expiresAtMs);
    return {
      environmentId: capability.environmentId,
      nodeSetupId: capability.nodeSetupId,
      ownerEpoch: capability.ownerEpoch,
      leaseId: capability.leaseId,
      expiresAtMs: capability.expiresAtMs,
      bootstrap: { target: capability.target, credential: capability.credential },
    };
  }

  function nativeBegin() {
    if (capability === undefined) {
      capability = {
        target: enrollment.nodeBootstrap.url,
        credential: enrollment.setupCode,
        environmentId: state.environmentId,
        nodeSetupId: state.nodeSetupId,
        ownerEpoch: state.ownerEpoch,
        leaseId: state.leaseId,
        expiresAtMs: state.expiresAtMs,
      };
    }
    assertCapabilityCurrent();
    return enrollment;
  }

  function replaceSetup() {
    state.nodeSetupId = 'setup-2';
    enrollment.setupId = state.nodeSetupId;
    enrollment.setupCode = 'short-lived-node-setup-code-2';
    capability = undefined;
  }

  function advanceExpiry() {
    capability.expiresAtMs = now;
  }

  function abort() {
    aborted = true;
    capability = undefined;
  }

  function destroy() {
    destroyed = true;
    state.destroyRequestedAtMs = now + 1;
    state.state = 'destroying';
    capability = undefined;
    enrollment.close();
  }

  return {
    state,
    enrollment,
    get beginCalls() { return beginCalls; },
    get closed() { return closed; },
    get destroyed() { return destroyed; },
    admitCloudWorker,
    nativeBegin,
    replaceSetup,
    advanceExpiry,
    abort,
    destroy,
  };
}

const fixture = createFixture();
const first = await fixture.admitCloudWorker({
  idempotencyKey: 'admission-1',
  leaseId: 'lease-1',
  expiresAtMs: now + 3 * 60 * 1000,
});
assert.deepEqual(first, {
  environmentId: 'env-1',
  nodeSetupId: 'setup-1',
  ownerEpoch: 7,
  leaseId: 'lease-1',
  expiresAtMs: now + 3 * 60 * 1000,
  bootstrap: { target: 'wss://gateway.example', credential: 'short-lived-node-setup-code' },
});

// The native begin path is the sole producer of the connect capability.
const native = fixture.nativeBegin();
assert.equal(native.setupId, first.nodeSetupId);
assert.equal(native.setupCode, first.bootstrap.credential);
assert.equal(fixture.beginCalls, 1);

// Idempotent replay returns the same binding/capability, not a second credential.
const replay = await fixture.admitCloudWorker({
  idempotencyKey: 'admission-1',
  leaseId: 'lease-1',
  expiresAtMs: now + 2 * 60 * 1000,
});
assert.deepEqual(replay.bootstrap, first.bootstrap);
assert.equal(fixture.beginCalls, 2);

// Wrong lease and invalid expiry fail closed.
await assert.rejects(
  fixture.admitCloudWorker({ idempotencyKey: 'bad-lease', leaseId: 'lease-2', expiresAtMs: now + 60_000 }),
  /lease mismatch/,
);
await assert.rejects(
  fixture.admitCloudWorker({ idempotencyKey: 'bad-expiry', leaseId: 'lease-1', expiresAtMs: now + 16 * 60_000 }),
  /invalid admission expiry/,
);

// Epoch fencing invalidates a capability before use.
fixture.state.ownerEpoch = 8;
assert.throws(() => fixture.nativeBegin(), /capability fenced/);
fixture.state.ownerEpoch = 7;

// Node setup replacement invalidates the old capability.
fixture.replaceSetup();

// Re-admission after setup replacement must not return the stale setup identity.
const replacement = await fixture.admitCloudWorker({
  idempotencyKey: 'replacement-setup',
  leaseId: 'lease-1',
  expiresAtMs: now + 60_000,
});
assert.equal(replacement.nodeSetupId, 'setup-2');
assert.notEqual(replacement.bootstrap.credential, first.bootstrap.credential);

// Fresh fixture: abort and expiry both fence the capability.
const aborted = createFixture();
await aborted.admitCloudWorker({ idempotencyKey: 'abort', leaseId: 'lease-1', expiresAtMs: now + 60_000 });
aborted.abort();
assert.throws(() => aborted.nativeBegin(), /capability fenced/);

const expired = createFixture();
await expired.admitCloudWorker({ idempotencyKey: 'expiry', leaseId: 'lease-1', expiresAtMs: now + 60_000 });
expired.advanceExpiry();
assert.throws(() => expired.nativeBegin(), /capability fenced/);

// Destroy closes native enrollment and removes the capability; no arbitrary node removal API exists.
const destroyed = createFixture();
await destroyed.admitCloudWorker({ idempotencyKey: 'destroy', leaseId: 'lease-1', expiresAtMs: now + 60_000 });
destroyed.destroy();
assert.equal(destroyed.destroyed, true);
assert.equal(destroyed.closed, 1);
assert.throws(() => destroyed.nativeBegin(), /capability fenced/);

// Runner-facing object contains no Gateway/admin/model credential or setup internals.
assert.deepEqual(Object.keys(first).sort(), [
  'bootstrap', 'environmentId', 'expiresAtMs', 'leaseId', 'nodeSetupId', 'ownerEpoch',
]);
assert.deepEqual(Object.keys(first.bootstrap).sort(), ['credential', 'target']);
assert.equal('setupId' in first.bootstrap, false);
assert.equal('adminToken' in first.bootstrap, false);
assert.equal('modelCredential' in first.bootstrap, false);

console.log('M12 Phase1 core-hook fixture PASS');
