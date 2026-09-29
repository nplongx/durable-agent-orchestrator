# P8 — Autonomous Delivery Runner

P8 closes the durable control-loop boundary around the P2–P7 primitives.

```text
durable Job
  -> LangGraphControlLoop.tick()
  -> reconcile provider runs
  -> LangGraph decision
  -> DistributedScheduler leases + dispatch
  -> GitHub Actions worker
  -> ExecutionManager
  -> evidence verifier
  -> durable task result
  -> next control tick
```

`AutonomousDeliveryRunner` owns repeated ticks. It heartbeats active leases before each tick, lets the control loop reap expired leases, and stops only on a durable terminal job state or terminal workflow phase. A bounded `maxTicks` prevents an infinite controller loop.

The runner accepts the existing LangGraph lifecycle hooks (`spawnCto`, `assignChildren`, `synthesize`, `terminalize`, `project`) without creating a second controller. `LangGraphControlLoop` passes those hooks into the existing graph implementation.

## Authority

- LangGraph + durable DB: control-plane authority.
- DistributedScheduler: lease/dispatch authority.
- GitHubActionsProvider: execution-provider boundary.
- ExecutionManager: worker execution authority.
- Execution verifier: success/evidence authority.
- AutonomousDeliveryRunner: bounded polling/orchestration loop only; it does not decide success.

## Validation

```bash
npm run test:execution-contract
npm run test:execution-verifier
npm run test:github-actions-provider
npm run test:task-lease-manager
npm run test:distributed-scheduler
npm run test:langgraph-control-loop
npm run test:autonomous-delivery
git diff --check
```
