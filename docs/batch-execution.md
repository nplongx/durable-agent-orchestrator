# Mandatory durable batch execution

Runalith's mandatory batch policy applies to deterministic local task contracts whose immutable plan selects `executor: "ExecutionManager"`. It is a runtime route requirement, not a prompt convention and not another success predicate. It does not turn specialist reasoning tasks into shell commands.

## Policy pinned in the plan

New schema-v2 plans pin a versioned `batch_execution_policy` into the canonical immutable plan hash. Its fields separate these decisions:

- `mode`: `required` or `exempt`.
- `scope`: `deterministic-local`.
- `route`: `batch-required` when applicable.
- `grouping`: `ready-compatible`.
- `evidence`: durable batch, item and execution-ledger evidence.
- `validation_task_ids`: immutable deterministic validation contracts for workspace-writing plans.
- `workspace_fingerprint_required`: whether successful validation needs a source/test fingerprint.
- `exemption_reason`: required and non-empty only for an explicitly exempt plan.

An exemption is only valid where no deterministic local task and no workspace-write operation are in scope. A missing policy is not an exemption. Schema-v1 plans keep their original stored bytes and plan hash; legacy deterministic tasks resolve to a fail-closed batch route. This compatibility rule does not migrate completed direct-execution history into batch history.

## Lifecycle and decision table

| Stage | Runtime rule | Operator action |
|---|---|---|
| Create / preflight | Validate the plan policy. A new workspace-writing plan must include exact deterministic validation command contracts rather than a prose promise to test. | Fix missing task contracts before approval. |
| Approval | Policy, commands, arguments, working directories, dependencies, and policy version are pinned by the plan hash. | Inspect the plan, then explicitly approve it. |
| Ready-task scheduling | Select only pending deterministic tasks whose plan dependencies are complete. Group compatible items with the same working directory and no conflicting declared resource locks, up to 32 items. | A one-item eligible set still uses `execute_batch`. |
| Dispatch | Each requested ID must be a prepared task under the active approved coordinator. Commands, argv, cwd, role, environment, and timeout come from the immutable plan, never from the caller. | Call `execute_batch` with IDs only. |
| Single-task call | A task covered by the batch-required policy must not run through `task_execute_local`, direct `ExecutionManager` calls, or direct specialist completion. | Do not switch execution APIs to get around a rejected batch. |
| Completion / synthesis | Verify task state, item linkage, session/attempt/exit status, exact command/cwd/timeout, and batch terminal evidence. Validation evidence must still match the recorded workspace fingerprint. | If blocked, inspect the durable ledger and diagnose; never fabricate evidence. |

## Call `execute_batch`

The MCP input is deliberately small:

```json
{
  "job_id": "<approved-active-job-id>",
  "task_ids": ["<prepared-task-id-1>", "<prepared-task-id-2>"]
}
```

The array accepts 1–32 unique prepared task IDs. The caller cannot inject executable paths, commands, arguments, working directories, timeouts, environment variables, roles, parent IDs, or batch IDs. Every item must be dependency-ready, still pending, bound to the immutable plan, and have no existing execution/batch history before its first reservation.

## Durable evidence and recovery

A batch result preview alone is not proof of successful completion. Inspect durable batch and item rows plus the linked task execution record and terminal events. Batch reservation is atomic and concurrent duplicate requests must not create a second execution history for the same task. Do not create a new batch for a task with prior execution history.

Recovery must distinguish a rejection before spawn from a failed item and from an ambiguous/possibly-spawned process. Continue using the same authorized batch/recovery path to reconcile durable session, process and attempt evidence. Do not blindly replay unresolved side effects. A local successful execution is not an exactly-once guarantee for external effects.

## Workspace freshness

For validation contracts listed in `validation_task_ids`, the runtime records a fingerprint before the validation batch runs and checks it again before synthesis. A mismatch blocks the claim that the tests validate the current workspace.

**Current coverage:** the implementation fingerprints `server/`, `src/`, `tests/`, `protocol/`, root-level `.js`/`.mjs`/`.cjs`/`.json` modules, and root package manifests using sorted, framed path/content hashing. Symlinked inputs and inputs that change while being read fail closed. The E2E drift fixture now changes staged root `job-store.js` after validation and restores exact bytes in `finally`. This regression is authored but unexecuted.

## Legacy plans and release boundary

Do not rewrite an approved schema-v1 plan or its hash in place. If a schema-v1 deterministic task has prior direct-execution/attempt history without a genuine batch item, runtime guards now block new batch side effects and synthesis with `migration-required` guidance. Start a fresh, separately approved schema-v2 workflow; do not fabricate batch rows or replay the old task.

The synthesis verifier validates the initial creation attempt separately, checks contiguous `execution.batch.retry_started` events and each attempt's terminal outcome, and accepts completed earlier-attempt items when durable records match. The unit regression uses real durable batch rows and negative controls. The hybrid MCP E2E fixture now fails one item in a two-item batch, restores the staged source, retries the same durable batch ID, checks attempts/events, and proceeds through the actual `workflow_complete_synthesis` route. This full-flow regression is authored but unexecuted.

## Verification status for this change

The active approved implementation plan is schema-v1 and contains no deterministic validation command contracts. The drift regex is corrected, `workflow_complete_task` now fails closed for missing or mismatched child-to-plan binding, and regression fixtures cover root input drift, denial audit idempotency, and full synthesis after a same-batch retry. These are source/test changes only; none of the tests has run. Do not treat the worktree as release-ready. A separate immutable plan with exact test, syntax and docs commands must be inspected and explicitly approved before execution through `execute_batch`. Generated `docs/MCP_REFERENCE.md` remains pending and must not be edited by hand.

For tool schemas and registered MCP names, consult the generated [MCP tool reference](MCP_REFERENCE.md); this guide describes lifecycle policy and operational safety. For plan boundaries and persistence, see [Architecture](architecture.md).