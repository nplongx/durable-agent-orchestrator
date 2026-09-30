# M10 — Observability

M10 extends the existing workflow observability surface without changing legacy workflow behavior.

## Contract

- `summarizeObservability()` returns `schema_version: 1`.
- Metrics include task status, task role, provider runs, lease state, task execution latency, provider latency, and lease lifetime.
- Task execution latency is derived only from durable `execution_started_at` / `execution_finished_at` timestamps.
- `last_event` is a sanitized projection. Sensitive fields such as raw text, content, prompts, messages, credentials, and process output are replaced with `[REDACTED]`.
- Redaction is recursive for nested event payloads and bounded to prevent pathological payload depth.
- The global metrics endpoint accepts `?limit=` and clamps the recent-event projection to 1–200 entries.
- Legacy databases without the later `provider_runs` table return empty provider metrics instead of failing observability reads.
- `getObservabilitySnapshot(jobId)` remains read-only and does not mutate workflow state.
- Existing `/v1/workflow/metrics` and trace endpoints remain compatible; the additional metric fields are additive.

## Operational invariants

- No agent execution is triggered by an observability read.
- No approval, artifact, task, lease, or workflow state is modified by metrics collection.
- Observability must not expose raw user/model content through the event summary.
- Missing timestamps produce `null` latency metrics instead of fabricated durations.

## Verification

`tests/test-observability.js` covers schema versioning, role counts, latency shape, and sensitive-event redaction.
