import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { getJobLivenessDiagnostics } from '../src/runtime/job-liveness.js';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY, title TEXT, state TEXT, status TEXT, provider_waiting INTEGER,
    provider_retry_at TEXT, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE workflow_runtime_state (
    job_id TEXT PRIMARY KEY, phase TEXT, updated_at TEXT, last_error TEXT
  );
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, job_id TEXT, role TEXT, status TEXT, created_at TEXT, updated_at TEXT,
    execution_attempt INTEGER, execution_started_at TEXT, execution_finished_at TEXT
  );
  CREATE TABLE task_leases (
    lease_id TEXT PRIMARY KEY, task_id TEXT, job_id TEXT, attempt INTEGER, state TEXT,
    issued_at TEXT, heartbeat_at TEXT, expires_at TEXT
  );
  CREATE TABLE events (event_id TEXT PRIMARY KEY, job_id TEXT, type TEXT, created_at TEXT);
`);

const now = '2026-10-19T12:00:00.000Z';
const insertJob = db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)');
const insertRuntime = db.prepare('INSERT INTO workflow_runtime_state VALUES(?,?,?,?)');
const insertTask = db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)');
const insertLease = db.prepare('INSERT INTO task_leases VALUES(?,?,?,?,?,?,?,?)');
const insertEvent = db.prepare('INSERT INTO events VALUES(?,?,?,?)');

insertJob.run('job-live', 'Live lease', 'EXECUTING', 'active', 0, null, '2026-10-19T11:00:00.000Z', '2026-10-19T11:50:00.000Z');
insertRuntime.run('job-live', 'EXECUTING', '2026-10-19T11:50:00.000Z', null);
insertTask.run('task-live', 'job-live', 'engineer', 'running', '2026-10-19T11:40:00.000Z', '2026-10-19T11:50:00.000Z', 1, '2026-10-19T11:40:00.000Z', null);
insertLease.run('lease-live', 'task-live', 'job-live', 1, 'ACTIVE', '2026-10-19T11:40:00.000Z', '2026-10-19T11:59:00.000Z', '2026-10-19T12:01:00.000Z');
insertEvent.run('event-live', 'job-live', 'task.lease.acquired', '2026-10-19T11:40:00.000Z');

insertJob.run('job-stale', 'No progress', 'EXECUTING', 'active', 0, null, '2026-10-19T08:00:00.000Z', '2026-10-19T08:30:00.000Z');
insertRuntime.run('job-stale', 'EXECUTING', '2026-10-19T08:30:00.000Z', null);
insertTask.run('task-stale', 'job-stale', 'reviewer', 'running', '2026-10-19T08:10:00.000Z', '2026-10-19T08:30:00.000Z', 1, '2026-10-19T08:10:00.000Z', null);
insertEvent.run('event-stale', 'job-stale', 'task.started', '2026-10-19T08:10:00.000Z');

insertJob.run('job-approval', 'Awaiting user', 'PROPOSED', 'active', 0, null, '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z');
insertRuntime.run('job-approval', 'PROPOSED', '2026-10-18T00:00:00.000Z', null);

insertJob.run('job-retry', 'Provider retry scheduled', 'EXECUTING', 'active', 1, '2026-10-19T12:10:00.000Z', '2026-10-19T10:00:00.000Z', '2026-10-19T10:10:00.000Z');
insertRuntime.run('job-retry', 'EXECUTING', '2026-10-19T10:10:00.000Z', null);

insertJob.run('job-expired', 'Expired lease', 'EXECUTING', 'active', 0, null, '2026-10-19T11:00:00.000Z', '2026-10-19T11:50:00.000Z');
insertRuntime.run('job-expired', 'EXECUTING', '2026-10-19T11:50:00.000Z', null);
insertTask.run('task-expired', 'job-expired', 'engineer', 'running', '2026-10-19T11:40:00.000Z', '2026-10-19T11:50:00.000Z', 1, '2026-10-19T11:40:00.000Z', null);
insertLease.run('lease-expired', 'task-expired', 'job-expired', 1, 'ACTIVE', '2026-10-19T11:40:00.000Z', '2026-10-19T11:45:00.000Z', '2026-10-19T11:46:00.000Z');

insertJob.run('job-stale-heartbeat', 'Old heartbeat, future expiry', 'EXECUTING', 'active', 0, null, '2026-10-19T11:59:00.000Z', '2026-10-19T11:59:30.000Z');
insertRuntime.run('job-stale-heartbeat', 'EXECUTING', '2026-10-19T11:59:30.000Z', null);
insertTask.run('task-stale-heartbeat', 'job-stale-heartbeat', 'engineer', 'running', '2026-10-19T11:40:00.000Z', '2026-10-19T11:59:30.000Z', 1, '2026-10-19T11:40:00.000Z', null);
insertLease.run('lease-stale-heartbeat', 'task-stale-heartbeat', 'job-stale-heartbeat', 1, 'ACTIVE', '2026-10-19T11:40:00.000Z', '2026-10-19T11:40:00.000Z', '2026-10-19T12:30:00.000Z');

const countsBefore = db.prepare('SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM task_leases) AS leases').get();
const result = getJobLivenessDiagnostics(db, { now, staleAfterMs: 15 * 60 * 1000, limit: 25 });
assert.equal(result.read_only, true);
assert.equal(result.considered_jobs, 6);
const byJob = new Map(result.diagnostics.map(item => [item.job_id, item]));
assert.equal(byJob.get('job-live').classification, 'live_lease_heartbeat');
assert.equal(byJob.get('job-live').stale_candidate, false);
assert.equal(byJob.get('job-stale').classification, 'stale_candidate');
assert.equal(byJob.get('job-stale').stale_candidate, true);
assert.equal(byJob.get('job-approval').classification, 'awaiting_proposal_or_approval');
assert.equal(byJob.get('job-approval').stale_candidate, false, 'waiting for approval must not be mislabeled as a stuck worker');
assert.equal(byJob.get('job-retry').classification, 'provider_waiting');
assert.equal(byJob.get('job-retry').stale_candidate, false, 'scheduled provider wait must not be mislabeled as a stuck worker');
assert.equal(byJob.get('job-expired').classification, 'expired_active_lease');
assert.equal(byJob.get('job-expired').stale_candidate, true);
assert.equal(byJob.get('job-stale-heartbeat').classification, 'stale_lease_heartbeat_candidate');
assert.equal(byJob.get('job-stale-heartbeat').stale_candidate, true, 'a recent unrelated job update must not hide an old lease heartbeat');
assert.equal(result.summary.stale_candidates, 3);
const countsAfter = db.prepare('SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM task_leases) AS leases').get();
assert.deepEqual(countsAfter, countsBefore, 'diagnostics must not mutate jobs, events, or leases');
assert.throws(() => getJobLivenessDiagnostics(db, { jobId: 'missing-job', now }), /workflow not found/);
assert.throws(() => getJobLivenessDiagnostics(db, { staleAfterMs: 10, now }), /stale_after_ms/);
db.close();
console.log('JOB LIVENESS DIAGNOSTICS PASS');
