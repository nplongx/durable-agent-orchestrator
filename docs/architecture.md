# Architecture

Durable Agent Orchestrator is a local MCP service. Chat On Steroids remains the reasoning host; the plugin owns workflow state, approval records, dependency scheduling, deterministic local execution contracts, and runtime checks on durable evidence.

## Runtime overview

```mermaid
flowchart TD
    Host[Chat On Steroids] <-->|MCP over stdio| Entry[Plugin entrypoint]
    Entry --> Contracts[Workflow and policy contracts]
    Entry <--> Store[(SQLite source of truth)]
    Contracts --> Approval[Explicit approval and immutable plan]
    Approval --> Queue[Dependency-aware task lifecycle]
    Queue --> Reasoning[Host-conversation specialist tasks]
    Queue --> Exec[Plan-bound deterministic local execution]
    Reasoning --> Evidence[Results and typed artifacts]
    Exec --> Evidence
    Evidence --> Gates[Independent evidence and synthesis gates]
    Gates --> State[Durable terminal state]
    Store --> Dashboard[Separate read-only dashboard]
```

The dashboard reads the existing database and does not participate in the workflow's decision or mutation path. The [architecture illustrations](diagrams/README.md) show a static overview of these relationships; the boundaries below are the normative explanation.

## Trust and state boundaries

### MCP entrypoint

The shipped entrypoint is `server/index.js`. It uses newline-delimited JSON-RPC over stdin/stdout and does not open an HTTP listener. Diagnostic output belongs on stderr so it does not corrupt the MCP transport.

### Proposal, approval, and plan

`workflow_create` records a proposal. It does not authorize execution. Explicit approval compiles an immutable plan whose task IDs, dependencies, role contracts, supported success predicates, and any pinned policy/role snapshots constrain later execution. Changing the intended topology or pinned snapshots requires a new proposal rather than in-place edits to an approved plan.

### Durable store

SQLite is the source of truth for workflow state, tasks, approvals, results, artifacts, execution records, and audit events. A UI projection or model-generated narrative does not replace these durable records. Integrity hashes detect content mismatch; they are not proof that content is correct or that a local database is tamper-proof against an actor with unrestricted filesystem access.

### Reasoning and deterministic execution

Reasoning tasks are handled by the host assistant with role-specific instructions and input evidence. Deterministic local commands are available only through a plan-bound execution contract. Callers cannot turn a reasoning task into an arbitrary shell command by supplying executable details to the execution tool. Execution results and task artifacts are persisted and checked against the planned contract.

### Completion gates

Completion is not a free-form model decision. The runtime checks task state, typed artifact validity, successful producer lineage, reviewer/QA requirements, and declared success predicates where applicable. The success assessment supplied at synthesis is evidence for evaluation, not authority to override it. Missing or mismatched evidence leaves the workflow blocked or failed.

### Dashboard

The optional dashboard is a separate loopback-only process. It opens the workflow database read-only and offers inspection, not approval, dispatch, retry, or mutation. Loopback binding reduces network exposure but is not user authentication; this is not a remote admin console.

## Recovery model

Recovery reconciles durable intent and result records with actual task/execution state. Stale work may be diagnosed, retried through an authorized recovery path, or left blocked. A retry must preserve the immutable plan and relevant provenance. Recovery must not fabricate a successful result, erase historical evidence, or infer that an external side effect happened exactly once because a local task completed.

## Scope and non-goals

- The shipped plugin is local-first; the plugin entrypoint does not dispatch to a cloud worker or remote runner.
- The dashboard is a local read-only observer, not a second workflow engine.
- Structured execution and workspace checks are defense-in-depth, not an OS/container sandbox.
- Passing tests does not by itself establish production readiness, autonomous specialist quality, live Gateway integration, or exactly-once external delivery.
- Distributed-worker and M12 experiments elsewhere in the repository must be read as separate implementation work unless the shipped entrypoint and tests prove they are enabled here.

## Implementation starting points

| Concern | Starting point |
|---|---|
| MCP tool surface | `server/index.js` |
| Runtime lifecycle and persistence | `src/runtime/` |
| Workflow contracts and artifact schemas | `src/runtime/workflow/` |
| Structured execution protocol | `protocol/` |
| Plugin packaging | `scripts/package-chat-on-steroids-plugin.sh` |
| Regression and acceptance evidence | `tests/` |

Use the [documentation index](README.md) for user guides and [known issues](KNOWN_ISSUES.md) for current limits and release blockers.
