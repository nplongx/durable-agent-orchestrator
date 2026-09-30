# M11 — Runner-owned native 9-agent E2E

M11 moves `standard-engineering` specialist lifecycle ownership off the local OpenClaw account and onto the worker boundary.

## Ownership contract

```text
LOCAL ADAPTER
  proposal / approval / DAG / governance / durable state
  dispatch runner task
  reconcile runner result
  synthesize terminal Job state

GITHUB RUNNER
  lease-owned task execution
  runner-owned agent session identity
  artifact/evidence production
  terminal result

LOCAL MUST NOT create specialist OpenClaw sessions for standard-engineering.
```

Legacy `engineering` remains unchanged.

## Standard-engineering path

```text
product-owner
  -> researcher
  -> architect
  -> engineer
       -> security
       -> qa
       -> platform
       -> writer
  -> reviewer
  -> CTO synthesis
```

The CTO is a durable coordinator task. It does not own specialist `sessions_spawn` lifecycle.

## Runner protocol

`DistributedScheduler` owns the durable lease and dispatch intent. Runner requests carry the immutable input commit and can carry an inline task payload, so a worker does not require an uncommitted `.worker/tasks/*` file.

GitHub Actions uses `.github/workflows/p3-worker.yml`. `scripts/run-worker-task.js` accepts runner-owned agent tasks through `runtime_owner=github-runner` / `execution_mode=agent`. A real deployment must provide the runner's agent runtime; M11's test provider is deterministic and does not contact ChatGPT/OpenClaw.

Provider result reconciliation is durable: provider run -> status -> result artifact -> verified result -> lease completion -> workflow advance.

## M11 safety mode

`npm run test:m11-native-e2e` runs with:

- temporary DB/workspace;
- `WORKFLOW_WORKER_PROVIDER=mock`;
- `M11_RUNNER_MODE=mock`;
- no OpenClaw gateway;
- no copied OpenClaw credentials/browser state;
- no production Chrome profile;
- no production ports `8318` / `9010`.

The mock runner still exercises the real adapter ingress, approval gate, immutable plan, LangGraph phases, scheduler, leases, provider reconciliation, artifact persistence, reviewer gate, CTO decision, and terminalization.

Acceptance checks require:

- exactly 10 durable tasks: 9 standard roles + CTO;
- all tasks terminal-success;
- 10 durable artifacts: requirements, research, architecture, implementation, security review, QA, platform, documentation, review, CTO decision;
- zero `openclaw_session_key` / `openclaw_run_id` on runner-owned tasks;
- 10 runner dispatches and 10 verified execution events;
- Job state `COMPLETED`.

## Production configuration

For real GitHub Actions dispatch, set `WORKFLOW_WORKER_PROVIDER=github-actions` and provide the existing GitHub provider credentials/repository environment. The local adapter must not provide ChatGPT/OpenClaw account credentials to that worker path.

No production gateway restart, DB reset, Chrome profile reset, or destructive OpenClaw state cleanup is part of M11.
