# P2 — GitHubActionsProvider

P2 adds the control-plane adapter for GitHub Actions. It is provider-specific and does not change the provider-neutral execution contract.

## API

```js
provider.dispatch(request)
provider.getStatus(providerRunId)
provider.collectResult(providerRunId)
provider.cancel(providerRunId)
```

`dispatch()` validates the P0 request, sends `workflow_dispatch` with `job_id`, `task_id`, `lease_id`, `attempt`, and `input_commit`, then persists the `workflow_run_id`. GitHub normally returns HTTP `204` for `workflow_dispatch`, so the provider reconciles the dispatch intent by polling the workflow run list using the unique `dispatch_key`. If the run has been accepted but is not yet visible, the durable intent remains `DISPATCHING` and is reconciled by the control loop rather than being treated as a failed dispatch.

GitHub's workflow-dispatch REST endpoint requires Actions repository write permission for a fine-grained token or GitHub App installation token. Read-only status/artifact endpoints require Actions read permission. citeturn0search0turn0search1

## P2 smoke

`p2-provider-smoke.yml` validates correlation and emits a P0-compatible result artifact. It intentionally does not execute OpenClaw; real worker execution belongs to P3.

Flow:

```text
TaskExecutionRequest
  -> GitHubActionsProvider.dispatch()
  -> workflow_run_id
  -> getStatus()
  -> collectResult()
  -> TaskExecutionResult
```

The provider stores run metadata in the control-plane SQLite DB when a store is supplied.

## Security

- Control-plane token is never sent to the worker.
- Worker receives only task correlation fields and input commit.
- Worker token is read-only in the P2 smoke workflow.
- Dispatch token needs Actions write; polling/collection can use Actions read. citeturn0search0turn0search1
