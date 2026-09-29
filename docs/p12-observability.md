# P12 — Observability

P12 makes the existing durable event stream queryable instead of introducing another service.

## Durable timeline

`JobStore.listEvents(jobId)` returns the event timeline. Existing events already carry the important correlation fields: `job_id`, `task_id`, `lease_id`, `attempt`, and `provider_run_id` where applicable.

## Snapshot

`JobStore.getObservabilitySnapshot(jobId)` aggregates:

- event counts by type;
- task counts by status;
- lease counts by state;
- provider run state/conclusion counts;
- provider dispatch/update latency;
- lease lifetime;
- last durable event.

Example:

```js
const snapshot = store.getObservabilitySnapshot(jobId);
```

The snapshot is derived from SQLite, so it survives process restarts and does not depend on an in-memory metrics collector.

## Structured logs

`createStructuredLogger()` emits one JSON object per line with timestamp plus caller-supplied correlation fields. It is intentionally a thin adapter; stdout/stderr remain available for worker evidence and are not replaced.

## P12 boundary

This phase does not claim GitHub Actions queue time or runner startup time from local SQLite data. Those require provider timestamps or a live benchmark. P10 remains the synthetic scheduler-capacity benchmark.
