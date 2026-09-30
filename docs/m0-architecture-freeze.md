# M0 — Architecture Freeze

Status: **implemented**

M0 freezes the current orchestration boundaries before the agent-team redesign. It is a baseline, not a behavior change.

## Runtime boundaries

```text
HTTP / server.js
    |
    v
JobStore (durable state, tasks, results, events, leases, execution batches)
    |
    +--> workflow definition -> compiler -> immutable execution plan
    |
    +--> LangGraph control loop -> phase/action decision
    |
    +--> OpenClaw / CDP provider runtime -> native agent execution
    |
    +--> ExecutionManager -> deterministic command execution
    |
    +--> verifier / evidence contract -> terminal acceptance gates
```

## Workflow boundary

Three workflow definitions are currently supported:

| Workflow | Match | Children | Synthesis | Purpose |
|---|---|---|---|---|
| `production` | `production e2e` | Architect check, QA check | CTO | Production acceptance path |
| `engineering` | `engineering m4` | Architect, Engineer, QA, Reviewer | CTO | Existing M4 acceptance path |
| `standard-engineering` | Engineering Standard / Software Delivery / Software Development | Product Owner, Researcher, Architect, Engineer, Security, QA, Platform, Writer, Reviewer | CTO | New multi-role team path |

`engineering` remains the M4 compatibility path. M0 does not migrate or remove it.

## Role registry baseline

The canonical roles are:

`product-owner`, `researcher`, `architect`, `engineer`, `security`, `qa`, `platform`, `writer`, `reviewer`, `cto`.

Each role currently maps to one capability, OpenClaw as its native executor, and an explicit permission set in `src/runtime/workflow/roles.js`.

## Execution boundary

- OpenClaw roles are non-deterministic native-agent work.
- Deterministic commands use `ExecutionManager`.
- Workflow plans carry role, capability, dependencies, executor and execution metadata.
- Non-production workflows require an immutable compiled execution plan before the LangGraph control loop can proceed.
- Durable task/result/event state remains owned by `JobStore`.

## M0 invariants

1. Existing `production` and `engineering` workflow IDs and versions remain unchanged.
2. Existing `engineering m4` title matching remains unchanged.
3. Existing M4 task dependency order remains Architect -> Engineer -> QA -> Reviewer -> CTO.
4. Standard engineering is additive and does not replace M4.
5. Every registered workflow role resolves to a canonical role contract.
6. Every workflow plan has deterministic content hashing (`plan_hash`).
7. LangGraph blocks non-production execution when the immutable plan is missing.
8. M0 does not change database schema, provider behavior, Chrome/CDP lifecycle, or OpenClaw persistent state.

## Change rule after M0

M1+ may extend contracts and durable artifacts, but changes to the invariants above require an explicit milestone change and regression coverage. Do not silently repurpose the M4 path.

