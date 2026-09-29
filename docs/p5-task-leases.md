# P5 — Durable Task Lease / Heartbeat / Recovery

P5 adds task ownership leases to the control-plane SQLite database.

## Semantics

- A task has at most one `ACTIVE` task lease.
- A lease belongs to exactly one `worker_id` and one attempt.
- Heartbeats extend `expires_at` only for the owning worker.
- A different worker is fenced from heartbeat/complete operations.
- Expired leases become `EXPIRED` and the matching running task is returned to
  `pending` only when the execution attempt still matches.
- The next worker acquires a new lease and increments the attempt.
- Every lease transition emits a durable event.

This lease is intentionally separate from `ProviderAdmission`'s capacity lease.
The latter controls provider concurrency; this lease controls task ownership.

## Recovery invariant

Worker death is not inferred from GitHub's UI or from a process-local timer.
The durable control plane can call `reapExpiredTaskLeases()` after restart and
recover tasks whose heartbeat deadline passed.

Late workers cannot complete a newer attempt because lease completion is fenced
by both `lease_id` and `worker_id`, and the old lease is no longer ACTIVE.
