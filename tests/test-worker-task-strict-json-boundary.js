import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-strict-json-boundary-'));
const evidence = path.join(root, 'evidence');
fs.mkdirSync(evidence, { recursive: true });
const inputCommit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const env = {
  ...process.env,
  JOB_ID: 'job-strict-json-fixture', TASK_ID: 'task-strict-json-fixture',
  LEASE_ID: 'lease-strict-json-fixture', ATTEMPT: '1', OWNER_EPOCH: '1', INPUT_COMMIT: inputCommit,
  ROLE: 'engineer', PROVIDER_RUN_ID: 'local-fixture-run', GITHUB_RUN_ATTEMPT: '1', EVIDENCE_DIR: evidence,
  TASK_PAYLOAD_JSON: '{"job_id":"job-strict-json-fixture","\\u006aob_id":"substituted","task_id":"task-strict-json-fixture"}'
};
const result = spawnSync(process.execPath, ['scripts/run-worker-task.js'], {
  cwd: process.cwd(), env, encoding: 'utf8', timeout: 15000
});
assert.equal(result.status, 1, `malformed payload must fail closed (stdout=${result.stdout}, stderr=${result.stderr})`);
const durable = JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'), 'utf8'));
assert.equal(durable.status, 'FAILED');
assert.match(durable.error, /duplicate decoded object key/);
assert.equal(fs.existsSync(path.join(evidence, 'runner-agent-input.json')), false,
  'strict request validation must fail before any agent subprocess is prepared');
assert.equal(fs.existsSync(path.join(evidence, 'execution.json')), false,
  'invalid payload must not produce execution evidence');

// Attempt tokens are durable identity, not free-form numbers. Reject
// non-canonical decimal forms and unsafe integers before creating evidence or
// launching any task process; otherwise distinct source tokens can collapse
// to the same JavaScript Number and later appear to be the same attempt.
for (const [field, value] of [
  ['ATTEMPT', '01'], ['ATTEMPT', '1.0'], ['ATTEMPT', '9007199254740992'],
  ['GITHUB_RUN_ATTEMPT', '01'], ['GITHUB_RUN_ATTEMPT', '1e0'], ['GITHUB_RUN_ATTEMPT', '9007199254740992']
]) {
  const caseEvidence = path.join(root, `invalid-${field.toLowerCase()}-${value.replace(/[^a-z0-9]/gi, '_')}`);
  const commandSentinel = path.join(root, `must-not-run-${field}-${value.replace(/[^a-z0-9]/gi, '_')}`);
  const validPayload = JSON.stringify({ schema_version: 1, job_id: env.JOB_ID, task_id: env.TASK_ID,
    lease_id: env.LEASE_ID, attempt: 1, owner_epoch: 1, role: 'engineer', command: `node -e "require('node:fs').writeFileSync(${JSON.stringify(commandSentinel)}, 'bad')"`,
    required_evidence: ['execution.json'] });
  const invalid = spawnSync(process.execPath, ['scripts/run-worker-task.js'], {
    cwd: process.cwd(), env: { ...env, [field]: value, EVIDENCE_DIR: caseEvidence, TASK_PAYLOAD_JSON: validPayload },
    encoding: 'utf8', timeout: 15000
  });
  assert.equal(invalid.status, 1, `${field}=${value} must be rejected before worker startup: ${invalid.stderr}`);
  assert.match(invalid.stderr, new RegExp(`${field} must be a positive safe integer in canonical decimal form`));
  assert.equal(fs.existsSync(caseEvidence), false, `${field}=${value} must fail before creating execution evidence`);
  assert.equal(fs.existsSync(commandSentinel), false, `${field}=${value} must fail before task process creation`);
}
fs.rmSync(root, { recursive: true, force: true });
console.log('worker task payload strict JSON and canonical attempt identity reject ambiguity before execution: PASS');
