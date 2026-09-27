# Durable Agent Orchestrator

A provider-neutral orchestration runtime for approval-gated, durable multi-agent work.

The core idea is simple: **durable state decides what happened; model output only proposes what should happen next.**

## What it provides

- Durable SQLite source of truth for Jobs, Tasks, Results, Reports, delivery claims, and recovery state.
- Approval gate before any execution or child-agent spawning.
- Native child-agent fan-out with parallel specialist work and explicit parent/child correlation.
- Deterministic shell execution through isolated tmux lanes.
- Durable execution evidence: exact command, working directory, timeout, execution session, exit status, and captured output metadata.
- Provider admission control with durable leases, cooldowns, probes, and a global gate.
- Recovery of stale sessions and executions without manufacturing successful results.
- Terminalization guards that require actual child evidence before declaring a Job successful.
- Projection adapters for human-facing channels; projections are not the source of truth.
- COS-AP v1 structured machine protocol for execution, child results, synthesis, and provider status.

## Architecture

```text
APPROVED
   |
   v
SPAWN_CTO
   |
   v
ASSIGN_CHILDREN
   |
   +-------> Architect
   |           |
   |           v
   |       deterministic execution
   |
   +-------> QA
               |
               v
           deterministic execution
               |
               +---- parallel ----+
                                  |
                                  v
                                WAIT
                                  |
                                  v
                         VALIDATE_EVIDENCE
                                  |
                                  v
                             SYNTHESIZE
                                  |
                                  v
                            TERMINALIZE
                                  |
                                  v
                              PROJECT
```

The runtime is intentionally split into durable orchestration, execution, provider admission, recovery, and projection layers. A provider-specific transport can sit underneath the orchestration contract without becoming the product identity.

## Repository layout

```text
.
├── server.js                    # stable HTTP entrypoint
├── test-tool-turn.js            # stable deterministic QA entrypoint
├── debate-engine.js             # optional debate workflow
├── workflow-dashboard.js        # local workflow inspection
├── src/runtime/                 # runtime modules
│   ├── cdp.js                   # browser transport
│   ├── coordinator-workflow.js  # orchestration state machine
│   ├── execution-manager.js     # deterministic execution + evidence
│   ├── job-store.js             # SQLite durable state + terminalization
│   ├── langgraph-orchestrator.js# optional LangGraph integration
│   ├── provider-admission.js     # provider leases / cooldowns / admission
│   ├── recovery-manager.js      # runtime reconciliation + recovery
│   └── session-transport.js     # structured session transport
├── protocol/                    # COS-AP v1 machine protocol + schemas
├── tests/                       # automated regression / acceptance tests
├── scripts/                     # probes, E2E runners, startup/watchdog helpers
├── docs/                        # architecture and design documentation
└── archive/backups/             # ignored historical local snapshots
```

Root keeps only stable absolute execution entrypoints. Runtime implementation lives under
`src/runtime/`; compatibility re-export files preserve existing imports and test paths.

## Requirements

- Node.js 24+
- SQLite support through the Node runtime/dependencies
- `tmux` for deterministic execution lanes
- A compatible model/provider transport for reasoning turns

The repository does **not** require a specific model vendor for its durable state, execution manager, protocol, or recovery concepts.

## Quick start

```bash
npm install
npm start
```

The default local adapter listens on `127.0.0.1:8318`.

## Tests

Focused checks:

```bash
npm run test:protocol
npm run test:execution-manager
npm run test:terminalization
npm run test:production-guards
npm run test:phase5-recovery
```

The full end-to-end harness exercises the real provider transport and therefore depends on the configured provider account/session environment.

## Design guarantees

1. No execution before approval.
2. No successful terminal state without durable evidence.
3. Retries reuse the durable Task/Job identity instead of inventing a new successful result.
4. Provider cooldowns are respected; quota controls are not bypassed.
5. Human-facing projections cannot redefine durable state.
6. Recovery can fail a stale workflow, but cannot manufacture success.

## Protocol

COS-AP v1 is a small JSON protocol for machine-to-machine boundaries. Payloads are schema-validated and correlation-aware. Human-facing summaries are kept separate from machine protocol traffic.

## Status

This repository is an active implementation. The architecture and focused regression suite are usable, while provider-specific E2E coverage depends on the runtime environment.

## License

MIT — see `LICENSE`.
