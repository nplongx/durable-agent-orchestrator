# P6 — Parallel Distributed Scheduler

P6 adds the control-plane scheduler that fans pending tasks out to GitHub
Actions workers.

## Guarantees

- scheduler capacity is bounded by `maxParallel`;
- only `pending` tasks without an ACTIVE task lease are candidates;
- lease acquisition happens before provider dispatch;
- every provider request receives a unique `lease_id` and attempt;
- provider dispatches are launched concurrently after leases are fenced;
- dispatch failure expires the lease so the task can be recovered;
- rerunning the scheduler cannot dispatch an already-leased task.

The scheduler does not treat a provider run as success. P4 evidence verification
remains the success authority.

## Current boundary

P6 supplies `inputCommit` explicitly to `dispatchPending()`. The next control-
plane phase will derive that commit and task payload from the durable job/task
state, then reconcile provider runs, heartbeats and verified results.
