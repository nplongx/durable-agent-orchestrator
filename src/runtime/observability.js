const safeMs = (a, b) => {
  const x = Date.parse(a); const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && y >= x ? y - x : null;
};

const REDACT_KEYS = /(?:token|secret|password|authorization|cookie|rawtext|content|stdout|stderr|prompt|message)/i;

function safeEvent(event) {
  let payload = {};
  try { payload = JSON.parse(event?.payload_json || '{}'); } catch (_) {}
  const redact = (value, key = '', depth = 0) => {
    if (REDACT_KEYS.test(key)) return '[REDACTED]';
    if (depth > 5) return '[TRUNCATED]';
    if (Array.isArray(value)) return value.map(item => redact(item, '', depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey, depth + 1)]));
    }
    return value;
  };
  const safePayload = redact(payload);
  return {
    event_id: event?.event_id || null,
    job_id: event?.job_id || null,
    type: event?.type || null,
    created_at: event?.created_at || null,
    payload: safePayload
  };
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows || []) {
    const value = row?.[key] == null || row?.[key] === '' ? 'unknown' : String(row[key]);
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

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
  const taskLatency = tasks.map(task => safeMs(task.execution_started_at, task.execution_finished_at)).filter(v => v != null);
  const roleCounts = countBy(tasks, 'role');
  const taskLatencyByRole = {};
  for (const task of tasks) {
    const latency = safeMs(task.execution_started_at, task.execution_finished_at);
    if (latency == null) continue;
    const role = task.role || 'unknown';
    (taskLatencyByRole[role] ||= []).push(latency);
  }
  const taskLatencySummary = Object.fromEntries(Object.entries(taskLatencyByRole).map(([role, values]) => [role, {
    count: values.length, avg: avg(values), max: Math.max(...values)
  }]));
  return {
    schema_version: 1,
    event_counts: eventCounts,
    task_counts: taskCounts,
    task_role_counts: roleCounts,
    lease_counts: leaseCounts,
    provider_counts: providerCounts,
    task_latency_ms: { count: taskLatency.length, avg: avg(taskLatency), max: taskLatency.length ? Math.max(...taskLatency) : null },
    task_latency_by_role_ms: taskLatencySummary,
    provider_latency_ms: { count: providerLatency.length, avg: avg(providerLatency), max: providerLatency.length ? Math.max(...providerLatency) : null },
    lease_lifetime_ms: { count: leaseLifetimes.length, avg: avg(leaseLifetimes), max: leaseLifetimes.length ? Math.max(...leaseLifetimes) : null },
    last_event: events.at(-1) ? safeEvent(events.at(-1)) : null
  };
}

export function sanitizeObservabilityEvent(event) {
  return safeEvent(event);
}

export function createStructuredLogger({ sink = console, base = {} } = {}) {
  return (level, message, fields = {}) => {
    const record = { ts: new Date().toISOString(), level, message, ...base, ...fields };
    const line = JSON.stringify(record);
    (sink[level] || sink.info || console.log)(line);
    return record;
  };
}
