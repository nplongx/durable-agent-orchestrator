# M4 — Engineer

M4 makes Engineer completion produce a durable `implementation` artifact when the Engineer task is part of the native `engineering` workflow and has verified ExecutionManager evidence.

## Implementation artifact

The artifact contains:

- `summary`
- `files_changed`
- `verification`
- `execution.session_id`
- `execution.exit_code`
- `execution.command`
- `execution.verified_at`

The artifact is accepted only with execution exit code `0` and a non-empty execution session ID.

## Boundary

The ExecutionManager remains responsible only for deterministic execution and execution evidence. `WorkflowStore.completeTaskByRuntime()` converts successful Engineer completion into the durable business artifact. This keeps execution state and artifact state separate.

The existing M4 deterministic proof remains unchanged: Engineer creates `.m4-engineer-proof.js`, and QA verifies its exact content.

## Compatibility

Only native `engineering` workflow Engineer completions get this automatic artifact emission. Production workflow execution, provider behavior, Chrome/CDP state, and OpenClaw state are unchanged.
