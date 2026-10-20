const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const MAX_DIAGNOSTIC_JOBS = 100;

function timestampMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const valueMs = Date.parse(value);
  return Number.isFinite(valueMs) ? valueMs : null;
}

function ageMs(value, nowMs) {
  const parsed = timestampMs(value);
  return parsed == null ? null : Math.max(0, nowMs - parsed);
}

function newestTimestamp(entries) {
  return entries
    .map(entry => ({ value: entry?.value, ms: timestampMs(entry?.value) }))
    .filter(entry => entry.ms != null)
    .sort((left, right) => right.ms - left.ms)[0]?.value || null;
}

function classifyJob({ job, runningTasks, activeLeases, lastActivityAt, activityAgeMs, staleAfterMs, nowMs }) {
  const state = String(job.state || '').toUpperCase();
  const status = String(job.status || '').toLowerCase();
  const terminal = status !== 'active' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(state);
  if (terminal) return { classification: 'terminal_or_inactive', stale_candidate: false, attention_required: false };

  if (state === 'PROPOSED' || state === 'IDLE') {
    return { classification: 'awaiting_proposal_or_approval', stale_candidate: false, attention_required: false };
  }
  if (state === 'APPROVED') {
    return { classification: 'awaiting_dispatch', stale_candidate: false, attention_required: false };
  }
  if (Number(job.provider_waiting) === 1) {
    const retryAtMs = timestampMs(job.provider_retry_at);
    const due = retryAtMs != null && retryAtMs <= nowMs;
    return {
      classification: due ? 'provider_retry_due' : 'provider_waiting',
      stale_candidate: false,
      attention_required: due,
      next_action: due
        ? 'Inspect the provider/run state and its retry contract; diagnostics do not dispatch or retry it.'
        : 'Wait for the recorded provider retry time or inspect provider status; diagnostics do not dispatch or retry it.'
    };
  }

  const runningTaskById = new Map(runningTasks.map(task => [task.task_id, task]));
  const expiredLeases = activeLeases.filter(lease => {
    const expiry = timestampMs(lease.expires_at);
    return expiry == null || expiry <= nowMs;
  });
  const orphanedLeases = activeLeases.filter(lease => {
    const task = runningTaskById.get(lease.task_id);
    return !task || !Number.isSafeInteger(lease.attempt) || !Number.isSafeInteger(task.execution_attempt) || lease.attempt !== task.execution_attempt;
  });
  const staleHeartbeats = activeLeases.filter(lease => {
    const heartbeatAge = ageMs(lease.heartbeat_at, nowMs);
    return heartbeatAge == null || heartbeatAge >= staleAfterMs;
  });
  const freshLeases = activeLeases.filter(lease => {
    const task = runningTaskById.get(lease.task_id);
    const expiryAge = ageMs(lease.expires_at, nowMs);
    const heartbeatAge = ageMs(lease.heartbeat_at, nowMs);
    const attemptMatches = !Number.isSafeInteger(lease.attempt) || !Number.isSafeInteger(task?.execution_attempt) || lease.attempt === task.execution_attempt;
    return task && attemptMatches && expiryAge === 0 && heartbeatAge != null && heartbeatAge < staleAfterMs;
  });

  if (state !== 'EXECUTING') {
    return { classification: 'active_non_executing_state', stale_candidate: false, attention_required: false };
  }
  if (orphanedLeases.length) {
    return {
      classification: 'orphaned_active_lease', stale_candidate: true, attention_required: true,
      next_action: 'Inspect task/lease attempt identity and recovery evidence before any intervention; do not blindly retry.'
    };
  }
  if (expiredLeases.length) {
    return {
      classification: 'expired_active_lease', stale_candidate: true, attention_required: true,
      next_action: 'Inspect the expired lease, current task attempt, and recovery trace before intervening; this tool does not expire or reacquire leases.'
    };
  }
  if (staleHeartbeats.length) {
    return {
      classification: 'stale_lease_heartbeat_candidate', stale_candidate: true, attention_required: true,
      next_action: 'The lease is still recorded ACTIVE but its heartbeat is missing or old. Verify worker liveness, lease expiry and attempt fencing before intervention; no lease is changed here.'
    };
  }
  if (freshLeases.length) {
    return {
      classification: 'live_lease_heartbeat', stale_candidate: false, attention_required: false,
      next_action: 'A current task has a non-expired lease and a recent heartbeat; re-check if progress stops.'
    };
  }
  if (activityAgeMs == null) {
    return {
      classification: 'activity_timestamp_unavailable', stale_candidate: false, attention_required: true,
      next_action: 'Inspect durable job/task/event timestamps; liveness cannot be inferred without a valid timestamp.'
    };
  }
  if (activityAgeMs >= staleAfterMs) {
    return {
      classification: 'stale_candidate', stale_candidate: true, attention_required: true,
      next_action: 'Inspect workflow_get, workflow_events, and workflow_diagnose plus host-side task progress. Lack of local activity is a signal, not proof that the worker is dead.'
    };
  }
  return {
    classification: runningTasks.length ? 'executing_without_live_lease_recent_activity' : 'executing_idle_recent_activity',
    stale_candidate: false,
    attention_required: false,
    next_action: 'No stale signal yet; compare host-side reasoning progress and durable events if the task appears blocked.'
  };
}

function summarizeJob(db, job, { nowMs, staleAfterMs }) {
  const runningTasks = db.prepare(`SELECT task_id, role, status, created_at, updated_at, execution_attempt,
      execution_started_at, execution_finished_at
    FROM tasks WHERE job_id=? AND status='running' ORDER BY updated_at DESC, created_at DESC LIMIT 20`).all(job.job_id);
  const activeLeases = db.prepare(`SELECT lease_id, task_id, attempt, state, issued_at, heartbeat_at, expires_at
    FROM task_leases WHERE job_id=? AND state='ACTIVE' ORDER BY heartbeat_at DESC, rowid DESC LIMIT 20`).all(job.job_id);
  const latestEvent = db.prepare(`SELECT type, created_at FROM events WHERE job_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(job.job_id) || null;
  const latestTaskActivity = runningTasks[0]?.updated_at || null;
  const lastActivityAt = newestTimestamp([
    { value: job.updated_at },
    { value: job.runtime_updated_at },
    { value: latestEvent?.created_at },
    { value: latestTaskActivity },
    ...activeLeases.map(lease => ({ value: lease.heartbeat_at }))
  ]);
  const activityAge = ageMs(lastActivityAt, nowMs);
  const classified = classifyJob({
    job, runningTasks, activeLeases, lastActivityAt, activityAgeMs: activityAge,
    staleAfterMs, nowMs
  });
  const leases = activeLeases.map(lease => ({
    lease_id: lease.lease_id,
    task_id: lease.task_id,
    attempt: lease.attempt,
    heartbeat_at: lease.heartbeat_at,
    heartbeat_age_ms: ageMs(lease.heartbeat_at, nowMs),
    expires_at: lease.expires_at,
    expired: timestampMs(lease.expires_at) == null || timestampMs(lease.expires_at) <= nowMs
  }));
  const tasks = runningTasks.map(task => ({
    task_id: task.task_id,
    role: task.role,
    status: task.status,
    updated_at: task.updated_at,
    age_since_update_ms: ageMs(task.updated_at, nowMs),
    execution_attempt: task.execution_attempt ?? null,
    execution_started_at: task.execution_started_at ?? null
  }));
  return {
    job_id: job.job_id,
    title: job.title,
    state: job.state,
    status: job.status,
    phase: job.runtime_phase || null,
    created_at: job.created_at,
    updated_at: job.updated_at,
    last_activity_at: lastActivityAt,
    activity_age_ms: activityAge,
    stale_after_ms: staleAfterMs,
    provider_waiting: Number(job.provider_waiting) === 1,
    provider_retry_at: job.provider_retry_at || null,
    running_task_count: runningTasks.length,
    running_tasks: tasks,
    active_lease_count: activeLeases.length,
    active_leases: leases,
    latest_event: latestEvent,
    has_runtime_error: Boolean(job.runtime_last_error),
    ...classified
  };
}

/**
 * Read-only job liveness snapshot. It intentionally diagnoses only; it never
 * writes timestamps, expires leases, changes states, or retries work.
 */
export function getJobLivenessDiagnostics(db, {
  jobId = null,
  limit = 25,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  now = new Date().toISOString()
} = {}) {
  if (jobId != null && (typeof jobId !== 'string' || !jobId.trim() || jobId.length > 200)) {
    throw new Error('job_id must be a non-empty string up to 200 characters');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DIAGNOSTIC_JOBS) {
    throw new Error(`limit must be an integer from 1 to ${MAX_DIAGNOSTIC_JOBS}`);
  }
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000 || staleAfterMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('stale_after_ms must be an integer from 60000 to 604800000');
  }
  const nowMs = timestampMs(now);
  if (nowMs == null) throw new Error('now must be a valid ISO timestamp');

  const selectJobs = `SELECT j.*, r.phase AS runtime_phase, r.updated_at AS runtime_updated_at,
      r.last_error AS runtime_last_error
    FROM jobs j LEFT JOIN workflow_runtime_state r ON r.job_id=j.job_id`;
  let jobs;
  if (jobId) {
    jobs = db.prepare(`${selectJobs} WHERE j.job_id=? LIMIT 1`).all(jobId);
    if (!jobs.length) throw new Error(`workflow not found: ${jobId}`);
  } else {
    jobs = db.prepare(`${selectJobs} WHERE j.status='active'
      ORDER BY COALESCE(j.updated_at, j.created_at) ASC LIMIT ?`).all(limit);
  }

  const diagnostics = jobs.map(job => summarizeJob(db, job, { nowMs, staleAfterMs }));
  const countBy = key => diagnostics.reduce((counts, item) => {
    counts[item[key]] = (counts[item[key]] || 0) + 1;
    return counts;
  }, {});
  return {
    read_only: true,
    generated_at: new Date(nowMs).toISOString(),
    scope: jobId ? 'single_job' : 'active_jobs',
    stale_after_ms: staleAfterMs,
    considered_jobs: diagnostics.length,
    summary: {
      by_classification: countBy('classification'),
      stale_candidates: diagnostics.filter(item => item.stale_candidate).length,
      attention_required: diagnostics.filter(item => item.attention_required).length,
      active_leases: diagnostics.reduce((total, item) => total + item.active_lease_count, 0)
    },
    diagnostics
  };
}
