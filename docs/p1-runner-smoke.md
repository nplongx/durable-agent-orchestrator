# P1 — GitHub Runner Smoke Test

Workflow: `.github/workflows/p1-runner-smoke.yml`

## What this proves

The workflow is intentionally independent of the production M4 workflow. It proves the physical execution path:

```text
workflow_dispatch
  -> fresh GitHub-hosted runner
  -> checkout exact input_commit
  -> Docker build
  -> container runtime
  -> Node / tmux / Chrome / OpenClaw availability
  -> ExecutionManager test
  -> execution-contract test
  -> Xvfb + Chrome smoke
  -> machine-readable evidence
  -> git commit
  -> git push
  -> artifact upload
```

## Why OpenClaw is only version-smoked here

The smoke runner must not require a real OpenClaw provider credential or ChatGPT account. P1 proves the worker image contains the execution runtime. Provider/session authentication belongs to the later worker protocol and production execution phases.

## Inputs

- `task_id`: logical smoke task identifier.
- `input_commit`: exact revision the worker must execute.

The workflow validates that `HEAD == input_commit` before running.

## Git boundary

The worker creates a branch:

```text
p1-smoke/<task_id>/<workflow_run_id>
```

and pushes only its smoke evidence/marker files. This proves that the Actions `GITHUB_TOKEN` can act as the worker's Git credential with `contents: write`.

## Evidence

The workflow uploads `.p1-smoke/result.json` as an artifact. The result records task ID, input commit, provider, runner, workflow run ID, attempt, repository, and status.

## Safety

This workflow does not modify the M4 production DAG and does not mutate the durable workflow database.

It is a smoke test, not yet `GitHubActionsProvider`. P2 will move dispatch/status/result collection into the control plane.
