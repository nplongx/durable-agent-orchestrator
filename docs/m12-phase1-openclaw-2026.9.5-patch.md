# M12 Phase 1 — OpenClaw 2026.9.5 core patch contract

> **Document type:** Historical milestone record. Status labels and claims describe the original milestone scope and time only; they have not been independently revalidated against today's source/runtime as a whole and do not certify current deployment or release readiness. Verify current behavior against source and tests before relying on it.

This file freezes the source-level change required in OpenClaw `2026.9.5`.
It is intentionally a patch specification, not a live installation change.

Validated source checkout: OpenClaw `2026.9.5`, tag `v2026.9.5`, commit `ec9c1a13db8938e5a3eaa51fca2e981cde2395a9`. The checkout was isolated under `/tmp`; the installed Gateway was not modified.

## Scope

Only the Gateway-internal worker-environment service gains a narrow admission
method. No runner credential, model credential, or Gateway operator token is
returned.

The current OpenClaw runtime already creates the cloud-worker bootstrap using
`CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE` and binds enrollment to
`environmentId`, `nodeSetupId`, `provisionOperationId`, and `ownerEpoch`.
The missing operation is exposing the resulting short-lived connect capability
to the Gateway-side broker boundary. `createWithProfile()` closes the enrollment operation
after provisioning, so the capability cannot be tied only to the enrollment closure.
The Gateway needs a process-local capability record fenced by environment, lease,
`nodeSetupId`, `ownerEpoch`, and expiry, with teardown invalidation inside the Gateway trust boundary.

## Exact integration points in 2026.9.5

1. `dist/server-worker-environment-startup-*.mjs`
   - `createWorkerNodeEnrollmentManager({...})` already exposes `begin`.
   - Add an internal callback `onBootstrapCapability` to the manager options.
   - Invoke it only after `enrollment` is fully constructed and immediately
     before `return enrollment`.
   - The callback must receive the environment identity and the enrollment
     object/capability by process-local reference; do not serialize it.
   - For `mode: "connect"`, the callback records the setup code as the short-lived
     node admission credential and the decoded pairing URL as its target.
   - `mode: "resume"` is not a new cloud-worker bootstrap and must not mint a new
     runner-facing credential.

2. `dist/server-worker-environment-startup-*.mjs`
   - Pass the callback from `createGatewayWorkerEnvironmentRuntime()` into the
     enrollment manager.
   - Store the capability in a process-local map keyed by
     `environmentId + nodeSetupId + ownerEpoch`.
   - Delete it on destroy/reclaim, abort, expiry, setup replacement, or owner-epoch
     change. Enrollment-operation closure alone must not delete a still-valid
     admission capability, because normal provisioning closes that operation before
     the runner consumes the bootstrap.

3. `dist/service-*.mjs`
   - Add an internal `admitCloudWorker(input)` method to the object returned by
     `createWorkerEnvironmentService()`.
   - Resolve the configured profile internally.
   - Require `requiresNodeEnrollment === true`.
   - Create/resume through the existing `providerLifecycle.createWithProfile`
     path using the exact admission idempotency key and lease binding.
   - Retrieve the process-local capability created by native `begin()` and require
     its environment, setup, epoch, lease, and expiry to match the durable record.
   - Wait for native node enrollment and return only:

```js
{
  environmentId,
  nodeSetupId,
  ownerEpoch,
  leaseId,
  expiresAtMs,
  bootstrap: { target, credential }
}
```

4. The Gateway RPC/plugin method calls only this service method. It must verify
   the configured broker identity and keep `operator.admin` entirely inside
   the Gateway trust boundary.

## Security invariants

- Bootstrap profile is fixed to `roles=["node"]`, `scopes=[]`,
  `purpose="cloud-worker"`.
- Caller cannot select provider, role, scopes, credential, or setup profile.
- `leaseId` must match the durable environment lease.
- `expiresAtMs` must be within the environment/admission fence.
- A stale `ownerEpoch` or replaced `nodeSetupId` fails closed.
- Destroy/reclaim invalidates the capability before node-role retirement.
- No `operator.admin`, Gateway token, ChatGPT Web credential, or model/provider
  credential is serialized into the runner response.

## Verification

The adapter repository contains `tests/test-m12-phase1-core-hook.js`, an
isolated no-cloud fixture covering capability origin, lease binding, epoch
fencing, destroy invalidation, and runner-response minimization.

It does **not** claim that the installed Gateway has been patched. Applying the
patch to the production installation remains a separate controlled rollout
step and must not be done during Phase 1 research/contract validation.

## Isolated source implementation

An isolated OpenClaw `2026.9.5` checkout at commit `ec9c1a13db8938e5a3eaa51fca2e981cde2395a9` now contains the Phase 1 core implementation:

- `createWorkerNodeEnrollmentManager` accepts `onBootstrapCapability`.
- Native `begin()` publishes the freshly constructed connect enrollment before returning it.
- Gateway startup retains capability only inside the Gateway process and binds it to `environmentId`, `nodeSetupId`, and `ownerEpoch`.
- `createWorkerEnvironmentService()` exposes internal `admitCloudWorker()`.
- Admission resolves the configured profile internally, requires `requiresNodeEnrollment`, creates through existing provider lifecycle, verifies the native capability binding, and returns only the frozen bootstrap response shape.
- No runner/operator/model credential is introduced.

Exact source diff is preserved in:

```text
docs/m12-phase1-openclaw-2026.9.5-implementation.patch
```

This isolated checkout has **not** been installed over the live OpenClaw package. The Gateway was not restarted and no real node enrollment was performed.

## Phase 1 contract gate closure

The adapter-side Phase 1 gate is now covered end-to-end:

```text
GitHub OIDC RS256
  -> repository/workflow/ref/run/run_attempt binding
  -> job/task/lease/attempt/input_commit/role binding
  -> bounded expiry + token expiry fence
  -> replay/idempotency protection
  -> Gateway-owned node bootstrap profile (role=node, scopes=[], purpose=cloud-worker)
  -> native enrollment capability binding (environment/nodeSetup/ownerEpoch)
  -> frozen runner response only
```

The contract harness also verifies that operator-admin material and bootstrap-internal fields do not escape the Gateway boundary.
