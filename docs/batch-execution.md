# Durable batch execution

`execute_batch` runs a set of already planned deterministic tasks as one durable batch through the shipped MCP runtime. It reuses the existing workflow store, execution manager, task contracts, lease/fencing protections, and result validation. It is not a way to submit arbitrary shell commands or to combine unrelated historical executions.

## Preconditions

Before calling `execute_batch`, verify that:

- the workflow was explicitly approved and dispatched;
- its current state is `EXECUTING` and the expected coordinator is active;
- requested tasks are prepared child tasks of that workflow;
- task IDs are unique, pending, and dependency-ready;
- none of the requested tasks already has execution or batch history;
- the approved plan contains a valid deterministic local execution contract for every requested task.

If any item fails validation, the runtime rejects the batch before creating its durable batch rows. Do not alter task IDs or retry by supplying command details; diagnose the workflow and follow its authorized recovery path instead.

## Call the tool

The tool accepts only `job_id` and `task_ids`:

```json
{
  "job_id": "<approved-active-job-id>",
  "task_ids": ["<prepared-task-id-1>", "<prepared-task-id-2>"]
}
```

`task_ids` must refer to exact prepared child-task IDs returned by the workflow runtime. The caller cannot supply executables, commands, arguments, working directories, environment variables, timeouts, roles, parent IDs, or batch IDs. Those details are resolved and checked against the immutable plan and task records.

## Inspect the result

The result includes the durable batch ID, status and attempt, protocol summary, per-item task role/status/exit code/execution session, bounded redacted output previews, and an aggregate preview. Inspect the batch and task records after the call; do not infer success from a partial preview.

Batch execution preserves the existing approval, immutable-command verification, claim/lease and spawn fencing, recovery, output bounds, durable terminal state, and typed-artifact requirements. Every task still needs its own valid result and artifact contract. The batch initiator is recorded as `system-workflow-coordinator`; task roles remain bound to their individual planned contracts.

## Limits

- The tool does not approve or dispatch a workflow.
- It does not accept arbitrary host-conversation tasks as shell commands.
- It does not combine or backfill previous individual executions into a new batch.
- It does not add a remote runner, external provider, or cancellation API.
- A local successful batch does not prove exactly-once external side effects or production readiness.

For the combined specialist-plus-deterministic plan, see [Hybrid engineering workflow](hybrid-engineering-workflow.md). For the broader approval and completion lifecycle, see the [Quickstart](quickstart.md) and [architecture explanation](architecture.md).
