import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runExecutionControlCommand } from '../src/runtime/execution-manager.js';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('execution-control-process-boundary-');
const success = await runExecutionControlCommand(process.execPath, ['-e', "process.stdout.write('CONTROL_OK'); process.stderr.write('CONTROL_ERR')"], {
  timeoutMs: 2000, maxOutputBytes: 1024
});
assert.equal(success.code, 0);
assert.equal(success.stdout, 'CONTROL_OK');
assert.equal(success.stderr, 'CONTROL_ERR');

await assert.rejects(
  () => runExecutionControlCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000)"], {
    timeoutMs: 5000, maxOutputBytes: 1024
  }),
    error => {
      assert.equal(error.code, 'OUTPUT_LIMIT');
      assert.match(error.message, /exceeded 1024 combined stdout\/stderr bytes/);
      assert.ok(Buffer.byteLength(error.stdout) <= 1024, 'captured output must never exceed the configured memory bound');
      assert.ok(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr) <= 1024,
        'the combined retained stdout/stderr buffers must remain within the configured bound');
      return true;
    }
  );

await assert.rejects(
  () => runExecutionControlCommand(process.execPath, ['-e', "process.stdout.write('o'.repeat(700)); process.stderr.write('e'.repeat(700)); setInterval(() => {}, 1000)"], {
    timeoutMs: 5000, maxOutputBytes: 1024
  }),
  error => error.code === 'OUTPUT_LIMIT' &&
    Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr) <= 1024,
  'stdout and stderr share one strict output budget rather than separate per-stream allowances'
);

if (process.platform !== 'win32') {
  const pidFile = path.join(root, 'descendant.pid');
  const command = `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`;
  await assert.rejects(
    () => runExecutionControlCommand('/bin/sh', ['-c', command], {
      timeoutMs: 150, maxOutputBytes: 1024, env: { PATH: '/usr/bin:/bin' }
    }),
    error => error.code === 'TIMEOUT' && /command timeout/.test(error.message)
  );
  assert.ok(fs.existsSync(pidFile), 'fixture must start a child process before timeout');
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const deadline = Date.now() + 1500;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      alive = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch { alive = false; }
    if (!alive) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(alive, false, 'timeout must signal the child process group, not only its shell leader');

  // A descendant that deliberately creates a new session escapes the original
  // process group. The control call must still return on timeout even when the
  // escaped process holds inherited stdout/stderr open; it must not claim that
  // the escaped process was stopped. The test explicitly kills its own fixture
  // after demonstrating the containment limit.
  const escapedPidFile = path.join(root, 'escaped-descendant.pid');
  const escapedCommand = `setsid /bin/sh -c 'echo $$ > ${JSON.stringify(escapedPidFile)}; exec sleep 30' & exit 0`;
  const escapedStartedAt = Date.now();
  await assert.rejects(
    () => runExecutionControlCommand('/bin/sh', ['-c', escapedCommand], {
      timeoutMs: 120, maxOutputBytes: 1024, env: { PATH: '/usr/bin:/bin' }
    }),
    error => error.code === 'TIMEOUT' && /command timeout/.test(error.message)
  );
  assert.ok(Date.now() - escapedStartedAt < 1500,
    'an escaped descendant holding inherited pipes must not keep the caller blocked after timeout');
  assert.ok(fs.existsSync(escapedPidFile), 'the fixture must have started the escaped descendant');
  const escapedPid = Number(fs.readFileSync(escapedPidFile, 'utf8').trim());
  assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 1);
  let escapedAlive = false;
  try { process.kill(escapedPid, 0); escapedAlive = true; } catch {}
  assert.equal(escapedAlive, true,
    'the escaped descendant is outside the original process group and cannot be claimed terminated by local group signalling');
  try { process.kill(-escapedPid, 'SIGKILL'); } catch {}
  const escapedDeadline = Date.now() + 1000;
  while (Date.now() < escapedDeadline) {
    try { process.kill(escapedPid, 0); } catch { escapedAlive = false; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(escapedAlive, false, 'the test must clean up its escaped descendant after asserting the limitation');
}

const controller = new AbortController();
const aborted = runExecutionControlCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  timeoutMs: 5000, signal: controller.signal, maxOutputBytes: 1024
});
setTimeout(() => controller.abort(), 75);
await assert.rejects(aborted, error => error.code === 'ABORT_ERR' && /Request aborted by caller/.test(error.message));

const alreadyAborted = new AbortController();
alreadyAborted.abort();
const preAbortedStartedAt = Date.now();
await assert.rejects(
  () => runExecutionControlCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 5000, signal: alreadyAborted.signal, maxOutputBytes: 1024
  }),
  error => error.code === 'ABORT_ERR' && /Request aborted by caller/.test(error.message),
  'a signal already aborted before the call must reject before creating any child process'
);
assert.ok(Date.now() - preAbortedStartedAt < 100,
  'pre-aborted requests must not wait for post-spawn termination grace periods');

await assert.rejects(
  () => runExecutionControlCommand(path.join(root, 'missing-executable'), [], { timeoutMs: 1000, maxOutputBytes: 1024 }),
  error => error.code === 'ENOENT',
  'a definite initial spawn failure must reject with its original error rather than an ambiguous timeout'
);
await assert.rejects(
  () => runExecutionControlCommand(process.execPath, ['-e', 'process.exit(0)'], { maxOutputBytes: 0 }),
  /output limit must be a positive safe integer/
);
for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
  await assert.rejects(
    () => runExecutionControlCommand(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs }),
    /timeout must be a positive safe integer/,
    `invalid timeout ${String(timeoutMs)} must not disable or distort the execution deadline`
  );
}

console.log('EXECUTION CONTROL PROCESS GROUP / OUTPUT BOUND / TIMEOUT / ABORT REGRESSIONS PASS');
