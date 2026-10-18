import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './test-temp-dir.js';

const dataDir = tempDir('openclaw-runtime-attach-atomicity-');
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_DB = path.join(dataDir, 'workflow.db');
process.env.NODE_ENV = 'test';
const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/runtime/job-store.js');
const { WorkflowStore } = await import(pathToFileURL(modulePath));
const store = new WorkflowStore();

function prepareJob(label) {
  const job = store.createJob({ conversationKey: `runtime-attach-${label}-${process.pid}`, title: `Runtime attach ${label}` });
  store.transition(job.job_id, 'PROPOSED');
  store.approve(job.job_id, 'local regression authorization');
  const task = store.dispatch(job.job_id, { role: 'cto', description: `runtime attach ${label}` });
  return { job, task };
}

const first = prepareJob('first');
const firstAttached = store.attachOpenClawRun(first.job.job_id, {
  runId: `runtime-run-first-${process.pid}`,
  sessionKey: `agent:cto:subagent:runtime-shared-${process.pid}`
});
assert.equal(firstAttached.openclaw_run_id, `runtime-run-first-${process.pid}`);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(first.task.task_id).n, 1);

const second = prepareJob('second');
const sharedKey = firstAttached.openclaw_session_key;
assert.throws(() => store.attachOpenClawRun(second.job.job_id, {
  runId: `runtime-run-second-${process.pid}`, sessionKey: sharedKey
}), /already belongs to a different task\/session identity/,
'a session key owned by another task must be rejected before durable attachment');
assert.equal(store.getTask(second.task.task_id).openclaw_run_id, null);
assert.equal(store.getTask(second.task.task_id).openclaw_session_key, null);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(second.task.task_id).n, 0,
  'a rejected session identity must roll back any initial attempt row');
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type IN ('attempt.started','task.runtime_attached')")
  .get(second.job.job_id).n, 0);

// Inject a late audit failure after the task and session rows would ordinarily
// have been attached. The single outer savepoint must restore all those writes.
const eventsBeforeFault = store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(second.job.job_id).n;
const originalRecordEvent = store.recordEvent.bind(store);
store.recordEvent = (jobId, type, payload, key) => {
  if (jobId === second.job.job_id && type === 'task.runtime_attached') {
    throw new Error('injected runtime attach event persistence failure');
  }
  return originalRecordEvent(jobId, type, payload, key);
};
try {
  assert.throws(() => store.attachOpenClawRun(second.job.job_id, {
    runId: `runtime-run-second-${process.pid}`, sessionKey: `agent:cto:subagent:runtime-second-${process.pid}`
  }), /injected runtime attach event persistence failure/);
} finally { store.recordEvent = originalRecordEvent; }
assert.equal(store.getTask(second.task.task_id).openclaw_run_id, null);
assert.equal(store.getTask(second.task.task_id).openclaw_session_key, null);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(second.task.task_id).n, 0);
assert.equal(store.getSessionByOpenClawKey(`agent:cto:subagent:runtime-second-${process.pid}`), null);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE job_id=?').get(second.job.job_id).n, eventsBeforeFault,
  'the rollback must preserve only the pre-existing job lifecycle event and remove attach lineage');

assert.throws(() => store.attachOpenClawRun(second.job.job_id, { runId: 42, sessionKey: 'agent:cto:bad-run' }),
  /runId must be a non-empty string or null/);
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id=?').get(second.task.task_id).n, 0,
  'coerced run identity rejection must not create an attempt');

const recovered = store.attachOpenClawRun(second.job.job_id, {
  runId: `runtime-run-second-${process.pid}`, sessionKey: `agent:cto:subagent:runtime-second-${process.pid}`
});
assert.equal(recovered.openclaw_run_id, `runtime-run-second-${process.pid}`);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE task_id=? AND status='started'").get(second.task.task_id).n, 1);
assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='task.runtime_attached'").get(second.job.job_id).n, 1);

store.db.close();
console.log('OPENCLAW RUNTIME ATTACH CROSS-TASK FENCE / EVENT-WRITE ROLLBACK / RETRY PASS');
