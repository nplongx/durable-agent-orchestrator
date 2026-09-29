import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tempDirAsync } from './test-temp-dir.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const script = path.join(root, 'scripts', 'run-worker-task.js');

async function run(payload, { cwd = root, inputCommit = 'a'.repeat(40) } = {}) {
  const dir = await tempDirAsync('p11-worker-');
  const payloadFile = path.join(root, `.p11-security-payload-${process.pid}.json`);
  await fs.writeFile(payloadFile, JSON.stringify(payload));
  const env = {
    ...process.env, JOB_ID: 'job', TASK_ID: 'task', LEASE_ID: 'lease', ATTEMPT: '1',
    INPUT_COMMIT: inputCommit, TASK_PAYLOAD_REF: path.relative(cwd, payloadFile), ROLE: 'executor',
    PROVIDER_RUN_ID: 'p11', EVIDENCE_DIR: dir
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { err += x; });
    child.on('close', code => resolve({ code, out, err, dir, payloadFile }));
    child.on('error', reject);
  });
}

const base = { schema_version: 1, job_id: 'job', task_id: 'task', lease_id: 'lease', attempt: 1, role: 'executor', required_evidence: ['execution.json'], command: 'node --version' };
const badEvidence = await run({ ...base, required_evidence: ['../../secret'] });
assert.notEqual(badEvidence.code, 0);
const badCwd = await run({ ...base, cwd: '/tmp' });
assert.notEqual(badCwd.code, 0);
const payloadPathTraversal = path.join(root, `.p11-security-payload-${process.pid}.json`);
await fs.rm(payloadPathTraversal, { force: true });
console.log('p11-security P11 PASS payload/evidence/cwd guards');
