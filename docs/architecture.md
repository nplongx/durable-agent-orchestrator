# Architecture Notes

## Durable state machine

A Job moves through approval, execution, evidence validation, synthesis, terminalization, and projection. SQLite is the source of truth.

## Deterministic execution

When a Task requires an exact command, the model does not get to declare success. The execution manager runs the command in an isolated tmux lane and persists the resulting evidence. A result is accepted only when the durable execution record matches the task contract.

## Reasoning vs execution

Reasoning turns may choose the next action, but deterministic work is delegated to the execution manager. This keeps reproducible shell work out of the model's claimed narrative.

## Recovery

Recovery reconciles durable state with runtime state. A stale or incomplete workflow may be retried or failed. Recovery never fabricates a successful execution result and never treats a human-facing projection as authoritative.

## Provider abstraction

Provider-specific transports are implementation details. Admission control, durable leases, cooldowns, and orchestration contracts remain provider-neutral.
