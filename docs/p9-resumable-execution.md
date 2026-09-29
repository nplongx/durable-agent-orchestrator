# P9 — Resumable Long-Running Execution

P9 changes timeout recovery from **retry from scratch** to **checkpoint + resume**.

```text
attempt N
  -> worker executes
  -> timeout
  -> .worker/checkpoint.json exists
  -> worker commits checkpoint
  -> result TIMED_OUT + checkpoint_commit
  -> verifier validates checkpoint evidence
  -> durable store records checkpoint
  -> task returns to pending
  -> attempt N+1
  -> scheduler uses checkpoint_commit as input_commit
```

## Checkpoint contract

Workers may maintain `.worker/checkpoint.json`. On a timeout, the worker publishes that file as a Git commit on:

`p9-checkpoint/<task_id>/<provider_run_id>`

The execution result carries `checkpoint_commit` and `checkpoint_ref`. The checkpoint is not treated as task success. It only establishes a resumable boundary.

The durable store records checkpoints in `task_checkpoints` and updates task metadata with `resume_input_commit`. A later lease/attempt therefore starts from the checkpoint revision while preserving the original attempt as immutable history.

## Safety

- Old leases cannot complete a new attempt because lease/task/attempt correlation is checked.
- A checkpointed timeout leaves the task `pending`, not `completed`.
- The deterministic verifier remains the success authority.
- No filesystem is copied between workers.
- Git remains the checkpoint/code synchronization boundary.
- A checkpoint without valid evidence is not accepted as resumable state.

## Worker requirement

Long-running task code must write a self-consistent `.worker/checkpoint.json` before the provider timeout. The checkpoint should contain enough application-specific state for the next attempt to continue rather than repeat completed work.

## Validation

```bash
npm run test:execution-contract
npm run test:p9-resume
node --check scripts/run-worker-task.js
node --check src/runtime/job-store.js
git diff --check
```
