# P3 — GitHub Actions Worker Protocol

P3 turns the P2 provider lifecycle into an actual worker contract.

## Protocol

The control plane dispatches only correlation data plus `task_payload_ref` and
the immutable `input_commit`. The payload itself lives in Git at that commit.
The worker therefore does not accept an arbitrary command from a workflow
dispatch input.

The payload contains:

- `schema_version`
- `job_id`
- `task_id`
- `lease_id`
- `attempt`
- `role`
- one deterministic execution definition: `command` or `executable` + `args`
- optional `cwd` / `timeout_ms`
- `required_evidence`

The worker verifies the checkout SHA and all correlation fields before running
anything.

## Execution authority

`scripts/run-worker-task.js` creates a local worker-side durable store entry and
hands execution to `ExecutionManager.executeAuthorizedTask()`. The worker
script never calls `spawn()` for the task itself. This preserves the rule that
ExecutionManager is the sole execution authority.

ExecutionManager records the attempt, exit code, stdout/stderr and execution
evidence. The worker then records the Git output revision and packages the
result envelope plus evidence as a GitHub Actions artifact.

## Evidence

`p3-worker-<run_id>` contains:

- `result.json`
- `task-payload.json`
- `execution.json`
- `stdout.txt`
- `stderr.txt`
- `git-status.txt`
- worker-local durable state

`result.json` is validated against the P0 provider-neutral execution contract
before the workflow finishes.

## Security boundary

The P3 workflow has `contents: read`. No GitHub token is exposed to the task.
P3 does not yet push task output branches; that belongs to the workspace/output
integration in the next phase. The immutable input revision remains the source
of the worker's task definition.
