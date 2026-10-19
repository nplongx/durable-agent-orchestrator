# M12 — JIT Runner Admission Broker Architecture

> **Document type:** Historical milestone record. It captures design, implementation, or validation context for that milestone; it is not by itself proof of current deployment or release readiness.

Status: FROZEN

This document freezes the M12 broker boundary before implementation. It is an architecture contract, not an implementation.

## 1. Goal

Allow a GitHub Actions runner to become a short-lived native OpenClaw session host for exactly one lease-owned task, without:
- `operator.admin`;
- long-lived Gateway tokens;
- specialist OpenClaw session creation in the local adapter;
- ChatGPT Web credentials on the runner;
- OpenAI Platform API;
- changing ChatGPT Free Web provider.

## 2. Ownership

```
LOCAL ADAPTER
  proposal / approval / DAG / governance / durable state
  dispatch task / reconcile result / synthesize Job

GITHUB ACTIONS
  owns task process
  owns runner-side node process
  owns task artifacts
  does not own durable OpenClaw pairing

ADMISSION BROKER
  verifies GitHub OIDC
  binds repo/run/task/lease/expiry
  obtains Gateway-owned JIT node admission
  returns only short-lived node bootstrap material
  does not create specialist sessions

OPENCLAW GATEWAY
  owns node enrollment
  owns environment/session identity
  owns worker execution
  owns provider/model resolution
  owns fencing and teardown

CHATGPT WEB ADAPTER
  remains provider bridge
  127.0.0.1:8318
  chatgpt-web/chatgpt-free
```

## 3. Trust boundary

```
GitHub OIDC
    |
    v
ADMISSION BROKER
    |
    | short-lived, task-bound node capability
    v
OPENCLAW GATEWAY
    |
    | native session/worker APIs
    v
EPHEMERAL NODE HOST
    |
    | native worker turn
    v
Gateway provider
    |
    v
chatgpt-web/chatgpt-free
    |
    v
127.0.0.1:8318/v1
```

The broker is the only component allowed to translate GitHub workflow identity into OpenClaw admission capability.

## 4. Frozen broker request

Conceptual interface:

```
POST /v1/runner-admissions
Authorization: Bearer <GitHub OIDC JWT>
```

Request:

```json
{
  "repository": "OWNER/REPO",
  "workflow": "P3 Distributed Worker",
  "workflow_ref": "OWNER/REPO/.github/workflows/p3-worker.yml@REF",
  "run_id": "github-run-id",
  "run_attempt": 1,
  "job_id": "job-id",
  "task_id": "task-id",
  "lease_id": "lease-id",
  "attempt": 1,
  "input_commit": "40-hex-sha",
  "role": "researcher",
  "expires_at": "RFC3339"
}
```

The broker MUST derive or verify identity fields from OIDC claims and trusted server-side configuration. Caller-supplied identity is not trusted merely because it is present.

## 5. Frozen broker response

```json
{
  "schema_version": 1,
  "admission_id": "opaque-id",
  "environment_id": "opaque-id",
  "node_setup_id": "opaque-id",
  "owner_epoch": 1,
  "lease_id": "lease-id",
  "expires_at": "RFC3339",
  "bootstrap": {
    "target": "gateway-admission-target",
    "credential": "short-lived-secret"
  }
}
```

Response MUST NOT contain:
```
operator.admin
operator.approvals
OpenAI API credentials
ChatGPT Web credentials
long-lived Gateway tokens
```

Bootstrap MUST represent `role=node`, `scopes=[]`, `purpose=cloud-worker`, or an equivalent Gateway-native capability with equal or stronger restriction.

## 6. Admission invariants

Every admission is bound to:
```
repository
workflow
workflow_ref
run_id
run_attempt
job_id
task_id
lease_id
attempt
input_commit
expiry
```

Reject repository/workflow/ref mismatch, expired JWT/admission, task/lease or attempt mismatch, replay, and missing required claims.

The broker MUST NOT accept an arbitrary identity header as proof of GitHub OIDC identity.

## 7. Session ownership

Local adapter MUST NOT call `sessions.create`, `sessions.spawn`, or `sessions.dispatch` for `standard-engineering` specialist execution.

Runner owns execution-side lifecycle:
```
admission
  -> node host
  -> sessions.create
  -> native worker dispatch
  -> result
  -> reclaim/termination
```

Gateway remains durable owner of OpenClaw session and node-enrollment records.

## 8. Placement

M12 MUST NOT rely on unconstrained `sessions.dispatch(autoDevice=true)` for cross-task isolation unless selected device is proven bound to current environment/admission.

Preferred invariant:
```
admission.environment_id
  == session.environment_id
  == node_setup.environment_id
  == lease.environment_id
```

If OpenClaw cannot enforce this binding natively, server-side placement binding is required. Runner MUST NOT implement its own global node-selection policy.

## 9. Lifecycle

```
REQUESTED -> ADMITTED -> BOOTSTRAPPING -> CONNECTED -> RUNNING
                                      |              |
                                      +-> FAILED <---+
                                                     |
                                                     v
                                                 RECLAIMING
                                                     |
                                                     v
                                                 DESTROYED
```

Gateway owns durable OpenClaw environment/node transitions.

Runner process exit is not authoritative teardown. Gateway environment destruction is authoritative.

## 10. Fencing

Gateway MUST fence admission when lease expires, task reaches terminal state, environment destroy is requested, ownerEpoch changes, node setup is replaced, admission expires, or runner/session is irrecoverably disconnected.

Operations using old `environment_id`, `node_setup_id`, `owner_epoch`, or `lease_id` MUST fail closed.

Runner MUST NOT remove arbitrary OpenClaw node pairings.

## 11. Crash semantics

```
runner disappears
  -> Gateway detects node/session failure
  -> environment reconciliation
  -> destroy/reclaim
  -> node role fenced/removed when environment-owned
```

Runner-side cleanup is best-effort only.

## 12. Provider boundary

Runner receives no model/provider credential.

```
native worker
  -> modelRef
  -> Gateway model/provider resolution
  -> chatgpt-web/chatgpt-free
  -> http://127.0.0.1:8318/v1
  -> ChatGPT Web
```

`openai-completions` is only wire/API compatibility where required by the ChatGPT Web adapter; it is not an OpenAI Platform provider.

Forbidden: `OPENAI_API_KEY`, `openai/gpt-*`, OpenAI Platform API.

## 13. Broker non-goals

Broker MUST NOT:
- create specialist sessions;
- execute task prompts;
- proxy model traffic;
- store ChatGPT Web credentials;
- become durable workflow state;
- replace local adapter governance;
- replace Gateway environment lifecycle;
- grant `operator.admin` to runners.

## 14. Required native primitive

Implementation is blocked until one of these exists.

Preferred: existing OpenClaw Gateway API allowing trusted server-side creation of an environment-owned cloud-worker bootstrap capability with `roles=["node"]`, `scopes=[]`, `purpose="cloud-worker"`, environment binding, lease binding, and expiry, without exposing `operator.admin` to runner.

Fallback: narrow Gateway-side admission integration that internally uses Gateway admin authority but exposes only the restricted capability. Admin authority remains server-side.

## 15. Acceptance gates

M12 cannot be claimed until:
1. GitHub OIDC is cryptographically verified.
2. Admission is bound to exact run/task/lease.
3. Runner receives only short-lived node capability.
4. Runner never receives `operator.admin`.
5. Local adapter never creates specialist OpenClaw sessions.
6. Runner owns execution-side session lifecycle.
7. Native OpenClaw worker executes specialist task.
8. Worker uses `chatgpt-web/chatgpt-free`.
9. Provider credentials remain Gateway-side.
10. Environment/node lifecycle is Gateway-owned.
11. Runner crash triggers eventual fencing.
12. Stale admission cannot execute a later task.
13. Cross-task node selection is impossible or server-side constrained.
14. Ten durable specialist tasks complete through native execution.
15. M0–M10 and legacy `engineering` remain unchanged.

Until all gates pass:
```
M12 = NOT PROVEN
```
