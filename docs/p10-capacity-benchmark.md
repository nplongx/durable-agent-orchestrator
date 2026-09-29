# P10 — Capacity Benchmark

P10 measures the control-plane dispatch boundary without spending GitHub Actions minutes.

## Metrics

- `maxParallel`: scheduler concurrency ceiling.
- `peakProviderConcurrency`: observed concurrent provider dispatches.
- `throughputTasksPerSec`: completed provider dispatches per elapsed second.
- `dispatchP50Ms` / `dispatchP95Ms`: batch dispatch latency.
- `medianThroughputTasksPerSec`: median across benchmark rounds.

Run:

```bash
npm run test:p10-capacity
npm run benchmark:p10
```

Optional environment variables:

```text
P10_MAX_PARALLEL=8
P10_TASKS=64
P10_PROVIDER_DELAY_MS=10
P10_ROUNDS=5
```

The benchmark uses a deterministic in-process provider delay. It measures scheduler/control-plane capacity, **not GitHub Actions runner startup, queue delay, VM capacity, or GitHub API rate limits**. Those require a separate small live-provider experiment and should not be inferred from this benchmark.

The scheduler's hard ceiling is `maxParallel`; measured peak concurrency must never exceed it. Capacity should be selected from observed production-like runs rather than from an arbitrary default.
