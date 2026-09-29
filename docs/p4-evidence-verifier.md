# P4 — Deterministic Evidence Verifier

P4 makes worker evidence a separate success authority. A worker's
`status: SUCCEEDED` is only a claim; the control plane accepts it only after
the complete evidence bundle passes deterministic checks.

## Checks

The verifier checks:

1. P0 `TaskExecutionResult` schema.
2. Required evidence references are actually present in the artifact.
3. `task-payload.json` correlation: job/task/lease/attempt.
4. `execution.json` correlation: task ID, exit code and timeout state.
5. Successful execution has exit code `0` and an output commit.
6. Successful execution contains stdout/stderr and Git-status evidence.
7. The evidence bundle gets a deterministic SHA-256 digest for audit storage.

`GitHubActionsProvider.collectResult()` now rejects the provider result when
this verifier fails. Therefore provider completion is not workflow completion.

P4 deliberately does not declare the whole LangGraph workflow `DONE` yet;
that integration belongs to the control-plane/lease phase after worker
recovery semantics exist.
