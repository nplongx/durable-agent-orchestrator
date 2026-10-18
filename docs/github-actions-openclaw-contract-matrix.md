# GitHub Actions ↔ OpenClaw worker contract matrix

Status: **research/implementation boundary only — not an OpenClaw `WorkerProvider`**.

This document records the boundary between the existing GitHub Actions executor and the OpenClaw Cloud Workers lifecycle. The adapter can dispatch workflow jobs and collect artifacts, but it must not be treated as an OpenClaw cloud worker until every required row below is proven against the Gateway-owned placement lifecycle.

| Contract | Existing GitHub Actions adapter | Required for native OpenClaw worker | Current result |
|---|---|---|---|
| Start execution | `workflow_dispatch` via GitHub API | Provider allocation tied to Gateway lease/operation ID | Partial; workflow dispatch only |
| Dispatch response lost | Reconcile run using `dispatch_key` in workflow run name | One run must be bound to one Gateway-owned lease; ambiguous results remain pending | Partial; no result on zero/multiple matches |
| Lease ownership | `DistributedScheduler` creates `task_leases` | Gateway must remain the only placement/lease authority | **Incompatible if scheduler is inserted into M12** |
| Node identity | Adapter records workflow run ID and runner-generated session labels | Return the actual enrolled OpenClaw node/device ID | Missing |
| Native session/run IDs | Artifact can contain runner task identifiers | IDs must originate from native OpenClaw execution and be verified at Gateway | Unproven |
| Enrollment | No implementation of Crabbox's `beginNodeEnrollment`/`waitForDeviceId` contract | Short-lived scoped enrollment; wait for Gateway-confirmed node identity | Missing |
| Readiness/inspect | GitHub workflow status | Provider `inspect` must reconcile run, lease, and actual node state | Partial; workflow status only |
| Cancellation | `cancel(runId)` calls GitHub API and reads status | Gateway revokes old owner authority; node execution must be fenced; then teardown is reconciled | Missing; cancellation is not fencing evidence |
| Teardown | Workflow job ends and runner is reclaimed by GitHub | `destroy` must provide safe idempotent semantics under Gateway lifecycle | Partial; no provider `destroy` contract |
| Artifact collection | Download result artifact and validate execution evidence | Reconcile artifacts with native task/session/run/lease identity before synthesis | Partial; native identity linkage unproven |
| Model/provider boundary | Workflow can run an external agent command | Gateway owns provider selection and credentials; no Platform API key in runner | Unproven |
| Public connectivity | No configured public TLS Gateway endpoint in the isolated config | Runner must establish authenticated WSS/TLS to isolated Gateway | Blocked |
| Cost boundary | Public repository standard hosted runners can be free | No larger runners, paid services, or unverified storage/network costs | Conditional |

## Invariants for any future integration

1. Do not use `DistributedScheduler` or `task_leases` as a second M12 lease authority.
2. Never synthesize a node `deviceId`, native `sessionId`, or native `runId` from a workflow run ID or artifact field.
3. A successful dispatch response, a completed workflow, or an uploaded artifact is not proof of enrollment, fencing, or teardown.
4. Reconcile ambiguous dispatch by stable operation/dispatch identity. Zero or multiple candidate runs must remain unresolved; do not guess.
5. Revoke/fence the Gateway owner before attempting remote cancellation. Do not report teardown complete unless the provider lifecycle can prove it.
6. Keep Gateway/provider credentials out of runner inputs, logs, artifacts, and repository checkpoints.
7. Never run live dispatch as part of local tests. All contract tests use an injected fake `fetch` implementation.

## Decision

GitHub Actions is currently an **executor candidate**, not a drop-in Crabbox provider. A native provider implementation would be a separately scoped architecture change and must first demonstrate enrollment, inspect, idempotent destroy, stale-owner fencing, and Gateway-native execution without introducing another lease authority.
