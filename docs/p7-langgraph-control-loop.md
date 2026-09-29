# P7 — LangGraph Control Loop

P7 connects the durable LangGraph controller to the distributed scheduler and
provider lifecycle without making the worker its own controller.

## Tick order

1. Reap expired task leases.
2. Reconcile active GitHub provider runs.
3. Download and deterministically verify completed evidence through P4.
4. Apply only correlation-matching, active-attempt results to durable task state.
5. Invoke LangGraph against fresh durable job/task/result state.
6. If LangGraph says `RUN_CHILDREN`, scheduler claims leases and dispatches
   runnable tasks in parallel.

Provider completion is not task completion. `applyVerifiedExecutionResult()` is
the durable boundary that turns verified evidence into `task.status=completed`.

Late/stale attempts are fenced by `lease_id`, task ID, job ID and attempt number.

The existing M4 LangGraph graph remains the policy/controller; P7 adds an
adapter around it rather than introducing a second workflow controller.
