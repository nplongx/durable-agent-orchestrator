const safeMs = (a, b) => {
  const x = Date.parse(a); const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && y >= x ? y - x : null;
};

export function summarizeObservability({ events = [], tasks = [], leases = [], providerRuns = [] } = {}) {
  const eventCounts = {};
  for (const event of events) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
  const providerLatency = providerRuns.map(run => safeMs(run.created_at, run.updated_at)).filter(v => v != null);
  const leaseLifetimes = leases.map(lease => safeMs(lease.issued_at, lease.released_at || lease.expires_at)).filter(v => v != null);
  const taskCounts = {};
  for (const task of tasks) taskCounts[task.status] = (taskCounts[task.status] || 0) + 1;
  const leaseCounts = {};
  for (const lease of leases) leaseCounts[lease.state] = (leaseCounts[lease.state] || 0) + 1;
  const providerCounts = {};
  for (const run of providerRuns) providerCounts[`${run.state}:${run.conclusion || 'none'}`] = (providerCounts[`${run.state}:${run.conclusion || 'none'}`] || 0) + 1;
  const avg = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  return {
    event_counts: eventCounts,
    task_counts: taskCounts,
    lease_counts: leaseCounts,
    provider_counts: providerCounts,
    provider_latency_ms: { count: providerLatency.length, avg: avg(providerLatency), max: providerLatency.length ? Math.max(...providerLatency) : null },
    lease_lifetime_ms: { count: leaseLifetimes.length, avg: avg(leaseLifetimes), max: leaseLifetimes.length ? Math.max(...leaseLifetimes) : null },
    last_event: events.at(-1) || null
  };
}

export function createStructuredLogger({ sink = console, base = {} } = {}) {
  return (level, message, fields = {}) => {
    const record = { ts: new Date().toISOString(), level, message, ...base, ...fields };
    const line = JSON.stringify(record);
    (sink[level] || sink.info || console.log)(line);
    return record;
  };
}
