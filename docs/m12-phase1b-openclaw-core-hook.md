# M12 Phase 1b — OpenClaw core hook

> **Document type:** Historical milestone record. It captures design, implementation, or validation context for that milestone; it is not by itself proof of current deployment or release readiness.

This is the final OpenClaw-side integration required to turn the already-tested
Gateway admission contract into a native cloud-worker admission primitive.

## Why a core hook is required

OpenClaw `2026.9.5` exposes `GatewayRequestContext.workerEnvironmentService` to
Gateway request handlers, including plugin gateway methods. The public worker
environment contract exposes `create`, `destroy`, and related lifecycle APIs,
but not the private `nodeEnrollment.begin()` capability.

The native enrollment implementation is already correct: it persists the
environment-owned `nodeSetupId`, creates the cloud-worker bootstrap profile
with `roles=["node"]`, `scopes=[]`, `purpose="cloud-worker"`, and fences the
bootstrap with `environmentId`, `provisionOperationId`, `ownerEpoch`, and the
environment state.

The missing seam is therefore only an internal handoff of the short-lived
bootstrap capability.

## Required core hook

Add an internal-only method to the worker environment service:

```ts
admitCloudWorker(input: {
  profileId: string;
  idempotencyKey: string;
  executionMode?: "worker-turn" | "remote-exec";
  expiresAtMs: number;
  leaseId: string;
  signal?: AbortSignal;
}): Promise<{
  environmentId: string;
  nodeSetupId: string;
  ownerEpoch: number;
  leaseId: string;
  expiresAtMs: number;
  bootstrap: {
    target: string;
    credential: string;
  };
}>;
```

### Implementation invariants

1. Resolve the configured worker profile internally; callers cannot supply a
   provider, credential, role, scope, or bootstrap profile.
2. Require a provider with `requiresNodeEnrollment === true`.
3. Create/resume the environment through the existing
   `createFromProfileSnapshot` / provider lifecycle path.
4. During `nodeEnrollment.begin()`, capture the generated connect capability
   for the exact `environmentId + nodeSetupId + ownerEpoch`.
5. Return only the short-lived connect capability; never return the Gateway
   auth token or pairing-admin authority.
6. The captured capability must be invalidated on abort, destroy, owner-epoch
   change, setup replacement, or expiry.
7. The lease id supplied by the admission broker must be the same lease id
   persisted by the resulting environment. If the provider has not yet
   allocated the lease, the method must wait for the native provisioning
   transition rather than fabricating a lease.
8. Existing `nodeEnrollment.retire()` remains the sole teardown authority.

## Recommended internal implementation seam

Inside `createWorkerNodeEnrollmentManager`, add an optional callback such as:

```ts
onBootstrapCapability(environmentId, capability)
```

and invoke it immediately after `begin()` constructs its `enrollment` object
and before returning it. The callback receives the exact connect setup payload
already produced by the native enrollment manager. It must be process-local,
non-serializable, and scoped by `environmentId`.

Then `createWorkerEnvironmentService` can expose `admitCloudWorker()` as a
narrow wrapper around the existing provider lifecycle and the callback-backed
capability store.

## Gateway RPC/plugin boundary

Expose only a narrow method such as:

```text
runner.admission.provision
```

The handler must:

- require `operator.admin` internally at the Gateway boundary;
- accept only the frozen admission binding;
- verify the caller is the configured broker identity/proxy, not an arbitrary
  Gateway operator;
- call `context.workerEnvironmentService.admitCloudWorker()`;
- return only the Phase 1 broker response shape;
- never expose `operator.admin` or a reusable Gateway token to the GitHub
  runner.

The GitHub runner continues to authenticate with GitHub OIDC to the local
admission broker. It does not receive Gateway operator credentials.

## Acceptance test

An isolated Gateway fixture must prove, without a real cloud allocation:

```text
OIDC JWT
  -> broker
  -> runner.admission.provision
  -> workerEnvironmentService.admitCloudWorker
  -> native nodeEnrollment.begin
  -> node-only cloud-worker bootstrap
  -> exact environment/nodeSetup/ownerEpoch/lease binding
```

Then test:

- same admission twice => one environment/provision operation;
- concurrent same admission => one provision operation;
- altered task/lease => denied;
- altered repository/run => denied;
- expired admission => denied/fenced;
- owner epoch change => bootstrap rejected;
- destroy => bootstrap capability invalidated;
- unsafe role/scopes/purpose => impossible;
- no admin/Gateway/model credential appears in the runner response.

## Production gate

Do not enable the RPC or restart the production Gateway until the isolated
fixture passes every check above. Once enabled, this hook becomes the only
Gateway-side path used by the M12 broker for JIT cloud-worker admission.
