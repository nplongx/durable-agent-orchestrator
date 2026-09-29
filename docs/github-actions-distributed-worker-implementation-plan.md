# GitHub Actions Distributed Worker — Implementation Plan

> Implementation plan for the `$0` execution-provider architecture. This document is intentionally kept in the repository working tree but is **not added to Git** by this implementation.

## Target

```text
WhatsApp
  -> LangGraph control plane
  -> durable SQLite task state
  -> Scheduler / Lease / Provider Admission / Recovery / Verifier
  -> GitHubActionsProvider
  -> ephemeral GitHub-hosted runner
  -> Docker + Chrome/Xvfb + OpenClaw + ExecutionManager
  -> Git commit + evidence artifact
  -> GitHub API polling
  -> deterministic verifier
  -> next DAG task / DONE
```

GitHub Actions is an execution provider only. It is not the workflow controller and does not own durable workflow state.

## Phase order

### P0 — Contract

- Lock `TaskExecutionRequest` and `TaskExecutionResult`.
- Define job/task/lease/attempt/input-commit correlation.
- Define output commit and evidence requirements.
- Reject unknown fields and invalid revisions.
- Keep the contract provider-neutral.

Acceptance: request/result validators and negative tests pass. No GitHub-specific state enters the generic contract.

### P1 — Runner smoke test

Prove on a fresh GitHub-hosted runner:

```text
checkout -> Docker -> Xvfb/Chrome -> OpenClaw -> ExecutionManager -> test -> commit -> artifact
```

Acceptance: one trivial task completes and its commit/evidence can be fetched by the control plane.

### P2 — GitHubActionsProvider

Implement:

```js
provider.dispatch(request)
provider.getStatus(providerRunId)
provider.collectResult(providerRunId)
provider.cancel(providerRunId)
```

Dispatch with `job_id`, `task_id`, `lease_id`, `attempt`, and `input_commit`. Persist provider run metadata in the control plane.

Acceptance: `Task -> Lease -> dispatch -> workflow_run_id -> RUNNING` works without marking the task DONE.

### P3 — Worker protocol

Workflow:

```text
checkout input_commit
-> prepare workspace
-> install/restore dependencies
-> start browser runtime if required
-> run ExecutionManager
-> local checks
-> commit/push
-> write result.json
-> upload evidence
```

Worker returns execution evidence; it never mutates workflow state directly.

### P4 — Evidence and verifier

Verify:

1. task/lease/attempt identity;
2. input commit;
3. output commit existence;
4. exit code;
5. required evidence;
6. dependency state;
7. provider run identity.

Negative cases must include stale lease, wrong commit, duplicate result, missing artifact, non-zero exit, and cancelled run.

### P5 — Lease / heartbeat / recovery

```text
QUEUED -> LEASED -> DISPATCHED -> RUNNING -> VERIFIED
                              \-> STALLED -> RECOVERY -> REQUEUE
```

Worker failure must expire/release the lease and permit a new attempt. Retryable infrastructure failures are separate from deterministic task failures. Retry count is bounded.

### P6 — Parallel workers

Provider Admission controls logical capacity. GitHub concurrency is only physical capacity.

Acceptance: independent tasks execute concurrently without duplicate claims, result overwrites, or cross-task evidence.

### P7 — LangGraph integration

Keep the existing workflow authority:

```text
Architect -> Engineer DAG -> QA -> Reviewer -> CTO
```

Do not introduce a second Coordinator/Planner controller. Scheduler executes ready tasks; LangGraph owns workflow transitions.

### P8 — Full autonomous delivery

Target:

```text
WhatsApp request
-> Architect requirements/architecture
-> Engineer DAG
-> parallel GitHub workers
-> QA
-> Reviewer
-> CTO
-> durable report
-> WhatsApp
```

Ambiguous requirements become clarification work rather than silent guesses.

### P9 — Long-running task handling

Do not depend on a runner filesystem surviving a job boundary. Use Git commits, artifacts, and durable control-plane state as checkpoints. Long work is split into resumable attempts.

### P10 — Capacity benchmark

Measure runner startup, Docker/browser/OpenClaw startup, dependency installation, tests, artifact upload, disk/RAM/CPU, and practical parallelism at 1/2/4/8/16 workers.

### P11 — Security hardening

- Minimum GitHub token permissions.
- No credentials in commits/images.
- Treat repository/task execution as untrusted.
- Validate artifacts before consuming them.
- Keep control-plane credentials away from workers unless strictly required.

### P12 — Observability

Correlate:

```text
job_id task_id lease_id attempt provider_run_id input_commit output_commit
```

Track queue depth, running/stalled tasks, retries, provider failures, dispatch latency, execution time, verification failures, and artifact failures.

### P13 — Failure injection

Test GitHub API failures, workflow startup/cancellation, worker/Docker/Chrome/OpenClaw crashes, disk/network failures, Git push rejection, control-plane restart, duplicate polling, duplicate result, and lease expiry.

### P14 — Idempotency audit

`dispatch`, `poll`, `collect`, `record result`, `verify`, `retry`, and `recover` must be safe across control-plane restarts and duplicate observations.

## Definition of Done

The final E2E must demonstrate:

```text
WhatsApp
 -> LangGraph
 -> Architect
 -> parallel Engineer workers
 -> intentionally killed worker
 -> lease expiry
 -> requeue/new attempt
 -> all tasks verified
 -> QA
 -> Reviewer
 -> CTO
 -> durable report
 -> WhatsApp
```

The verifier must prove correct input/output commits, attempt and lease identity, evidence, tests, dependencies, zero pending tasks, and no stale active leases.

## Hard rules

- GitHub Actions is not the control plane.
- SQLite is not copied to workers.
- Git worktrees are isolation, not synchronization.
- OpenClaw never declares workflow success.
- ExecutionManager remains the execution authority.
- Verifier is the success authority.
- No inbound callback to the laptop in the bootstrap design; poll GitHub API instead.
- No infinite retries.
- No single job is assumed to run forever.

## First milestone

Before multi-worker/recovery/LangGraph integration, prove:

```text
control plane
 -> workflow_dispatch
 -> fresh GitHub runner
 -> ExecutionManager
 -> output commit + evidence artifact
 -> GitHub API polling
 -> deterministic verification
```
