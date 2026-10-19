# M12 Phase 3 — Native specialist session implementation plan

> **Document type:** Historical milestone record. It captures design, implementation, or validation context for that milestone; it is not by itself proof of current deployment or release readiness.

## Goal

Move M12 from Phase 2 (real ephemeral OpenClaw node admission/bootstrap/reclaim) to a real native specialist execution lifecycle:

GitHub task -> Gateway admission -> ephemeral node -> native session -> native worker turn -> native result -> local reconciliation.

The Phase 3 gate is real OpenClaw session/run identity evidence. The adapter must not create specialist sessions through local sessions_spawn, fabricate session/run IDs, or own the worker execution lifecycle.

## Frozen constraints

- Do not modify M0-M10 or legacy provider/execution paths.
- Do not touch production OpenClaw Gateway/state/processes.
- Do not introduce OpenAI Platform API, OPENAI_API_KEY, Anthropic API keys, or openai/gpt-*.
- Runner remains role=node, scopes=[], purpose=cloud-worker.
- Runner never receives operator.admin or provider credentials.
- The Phase 1 broker contract remains unchanged.
- The Phase 2 ephemeral bootstrap contract remains unchanged.
- New development/E2E state must remain isolated.

## Native runtime contract

Use OpenClaw 2026.9.5 native Gateway/session machinery already present in the isolated source:

1. Create a real session with the Gateway's session creation service.
2. Admit the session to a cloud worker through the existing sessions.dispatch / worker-placement runtime.
3. Start a native worker turn through the existing worker-turn launcher/execution path.
4. Reconcile the native run/session result and artifacts into the adapter's durable task state.

Do not reimplement worker placement or worker execution in the adapter.

## Ownership

### Gateway

- environment/node identity
- session creation
- worker placement
- worker turn execution
- native session/run identity
- lease/node/owner-epoch fencing
- teardown/reclaim

### Runner

- owns the admitted task
- requests native specialist session creation through a node-scoped Gateway capability
- supplies task/role/prompt/attempt identity
- observes native session/run result
- produces/collects task artifacts

### Adapter

- durable task state
- dispatch/reconcile relay
- artifact indexing
- terminal-state reconciliation

The adapter must not use local sessions_spawn or create fake specialist runtime identities.

## Implementation sequence

### P3.1 — Freeze native execution contract

- Trace sessions.create, sessions.dispatch, sessions.send and the worker-turn runtime in OpenClaw 2026.9.5.
- Record the exact native sessionId, session key, runId, placement nodeId, environment ID, owner epoch and terminal result fields.
- Confirm the existing worker-turn path is the execution authority.

### P3.2 — Add node-scoped specialist admission

Add a hidden core Gateway method for the already-authenticated node connection. It must:

- require connect.role === node;
- derive caller node identity from client.connect.device.id;
- bind request to environmentId, nodeId, leaseId, ownerEpoch, taskId, attempt, role;
- reject stale/expired/mismatched ownership;
- create the native OpenClaw session using the existing session creation service;
- dispatch the session using the existing worker-placement dispatch service;
- return the native session identity and active placement;
- never expose operator scopes or credentials.

The method must be internal/hidden and must not be advertised as an operator API.

### P3.3 — Native dispatch

After session creation:

- bind exactly one placement to the session;
- use the existing worker-turn execution mode;
- preserve task/lease/node/epoch identity;
- enforce duplicate-dispatch idempotency by taskId + attempt;
- reject wrong node/environment/lease/epoch;
- never call local sessions_spawn.

### P3.4 — Native result

Capture the native:

- session ID/key;
- run ID;
- node ID;
- environment ID;
- owner epoch;
- terminal status;
- error/result;
- artifact references.

All IDs must originate from OpenClaw runtime responses/events.

### P3.5 — Adapter reconciliation

Persist native identity immediately after admission/dispatch and reconcile terminal native results idempotently:

admitted -> session_created -> running -> result_available -> reconciled -> terminal.

Adapter restart must query/reconcile the existing native identity rather than creating a replacement session.

### P3.6 — Negative/security coverage

Cover:

- duplicate taskId + attempt;
- expired lease;
- wrong lease;
- wrong node;
- wrong environment;
- stale owner epoch;
- fenced/disconnected node;
- runner crash;
- adapter crash/restart;
- no provider credential leakage;
- no operator.admin on runner.

### P3.7 — Isolated real E2E

Run one real specialist task against an isolated OpenClaw Gateway:

1. Phase 1 admission.
2. Phase 2 ephemeral node connection.
3. Node requests specialist session.
4. Gateway creates native session.
5. Gateway dispatches native worker turn.
6. Native worker completes.
7. Real artifact is produced.
8. Adapter reconciles the result.
9. Verify exact native sessionId and runId.
10. Verify all ownership bindings.
11. Verify teardown after runner termination.

## Required Phase 3 evidence

The final evidence must contain:

- admission_id
- environment_id
- node_setup_id
- owner_epoch
- lease_id
- node_id
- task_id
- role
- native session_id
- native session key
- native run_id
- terminal status
- artifact path/reference
- reconciliation event

The following equalities must hold:

session.nodeId == admitted nodeId

session.environmentId == admission.environmentId

session.leaseId == admission.leaseId

session.ownerEpoch == current owner epoch

session.taskId == original taskId

session.role == requested role

## Acceptance gate

Phase 3 is PASS only when one isolated real execution proves:

GitHub task -> admission -> real ephemeral node -> real native session -> real native run -> real native worker -> real result/artifact -> durable reconciliation -> terminal state.

Unit/integration tests may support the gate but cannot replace the real E2E.

## Git policy

This document and all implementation changes remain uncommitted and unstaged unless the user explicitly asks to commit them.
