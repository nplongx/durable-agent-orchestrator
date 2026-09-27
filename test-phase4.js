import assert from 'node:assert';
import fs from 'node:fs';
import crypto from 'node:crypto';

const dbPath = `/home/long/work/chatgpt-adapter/data/test-phase4-${crypto.randomUUID()}.db`;
process.env.WORKFLOW_DB = dbPath;
const { WorkflowStore } = await import('./job-store.js');
const store = new WorkflowStore();

const job = store.createJob({ conversationKey: 'obs', title: 'observability test' });
store.transition(job.job_id, 'PROPOSED');
store.approve(job.job_id, 'approved');
store.dispatch(job.job_id, { role: 'cto', description: 'trace me' });
store.startAttempt(job.job_id, { openclawRunId: 'run-obs' });
store.attachOpenClawRun(job.job_id, { runId: 'run-obs', sessionKey: 'agent:cto:subagent:obs' });
store.complete(job.job_id, 'PASS', 'success');
const report = store.createReport(job.job_id, 'executive_summary', 'PASS');
store.claimDelivery(job.job_id, report, 'whatsapp', 'boss');

const trace = store.getJobTrace(job.job_id);
assert.strictEqual(trace.job.job_id, job.job_id);
assert.strictEqual(trace.tasks.length, 1);
assert.strictEqual(trace.attempts.length, 1);
assert.strictEqual(trace.results.length, 1);
assert.strictEqual(trace.reports.length, 1);
assert.ok(trace.events.length >= 6);
assert.strictEqual(trace.tasks[0].openclaw_run_id, 'run-obs');

const overview = store.getObservability();
assert.strictEqual(overview.stats.jobs, 1);
assert.ok(overview.recentEvents.length >= 6);

fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
console.log('PASS: Phase 4 trace, metrics and workflow observability');
