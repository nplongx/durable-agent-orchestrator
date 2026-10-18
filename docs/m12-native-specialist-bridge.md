# M12 native specialist bridge

`src/runtime/m12-native-specialist-bridge.js` is the durable adapter boundary for the fork's node-scoped `m12.specialist.start` and `m12.specialist.wait` RPCs.

## Ownership

- OpenClaw Gateway owns admission validation, native session creation, worker placement, native run execution, and runtime IDs.
- The runner must supply an already-authenticated Gateway client with `role: 'node'` and no `operator.*` scopes.
- The adapter's SQLite `WorkflowStore` owns task leases, persisted native identity bindings, results, and reconciliation events.
- The bridge never fabricates session/run IDs and never creates local sessions.

## Crash recovery

The bridge persists Gateway-returned `sessionId`, session key, `runId`, environment, node, lease, and owner epoch immediately after `m12.specialist.start` returns. If the process restarts while the record remains active, it calls `m12.specialist.wait` for the persisted `runId`; it does not start a replacement turn. Terminal results are reconciled idempotently through `WorkflowStore.reconcileM12NativeSpecialistResult`.

## Current integration boundary

The bridge and contract tests are implemented, but the installable MCPB plugin remains local-first and does not instantiate a node-role Gateway client. Production use requires wiring this bridge into the admitted runner process that owns that client. Do not call the node-only RPC using operator credentials or expose it as an operator-facing plugin tool. The isolated real-Gateway E2E remains a separate acceptance gate; unit tests are not proof of a real native worker run.
