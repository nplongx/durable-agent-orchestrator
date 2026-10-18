import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('openclaw-byte-contract-');
const fakeOpenClaw = path.join(root, 'openclaw');
fs.writeFileSync(fakeOpenClaw, '#!/bin/sh\nprintf \'{"ok":true,"runId":"valid-run","note":"\\377"}\'\n', { flag: 'wx', mode: 0o700 });
fs.chmodSync(fakeOpenClaw, 0o700);
const childCode = `
  const { deliverSessionMessage } = await import(${JSON.stringify(new URL('../src/runtime/session-transport.js', import.meta.url).href)});
  const receipt = await deliverSessionMessage(
    { job_id: 'job-byte-contract', role: 'architect', openclaw_session_key: 'agent:architect:byte-contract' },
    { message_id: 'msg-byte-contract', message_type: 'TASK', sender_role: 'cto', recipient_role: 'architect',
      payload_json: '{"task":"byte test"}', protocol: 'legacy', protocol_version: 0, attempt: 1,
      created_at: '2026-10-14T00:00:00.000Z' },
    { timeoutSeconds: 1 }
  );
  console.log(JSON.stringify({ status: receipt.status, error: receipt.error, runId: receipt.runId }));
`;
const run = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
  env: { ...process.env, OPENCLAW_BIN: fakeOpenClaw }
});
assert.equal(run.status, 0, run.stderr);
const receipt = JSON.parse(run.stdout.trim());
assert.equal(receipt.status, 'ERROR', 'actual spawn command boundary must preserve bytes until fatal UTF-8 decoding');
assert.match(receipt.error, /invalid UTF-8 bytes.*ambiguous/);
assert.equal(receipt.runId, undefined, 'invalid UTF-8 response must not expose a success identity');
console.log('OPENCLAW SPAWN BUFFER / FATAL UTF-8 RECEIPT BOUNDARY PASS');

// Timeout configuration is an execution-boundary input. Coercion could send
// the CLI's 120-second default while setting a 5-second local watchdog, or
// overflow Node's timer for Infinity. Invalid values must fail before spawn.
const invalidTimeoutMarker = path.join(root, 'invalid-timeout-cli-invoked');
const timeoutValidationOpenClaw = path.join(root, 'openclaw-timeout-validation');
fs.writeFileSync(timeoutValidationOpenClaw,
  '#!/bin/sh\nprintf invoked >> "$OPENCLAW_TEST_TIMEOUT_MARKER"\nprintf \'{"ok":true,"runId":"valid-run"}\\n\'\n',
  { flag: 'wx', mode: 0o700 });
fs.chmodSync(timeoutValidationOpenClaw, 0o700);
const timeoutValidationCode = `
  import assert from 'node:assert/strict';
  const { deliverSessionMessage } = await import(${JSON.stringify(new URL('../src/runtime/session-transport.js', import.meta.url).href)});
  const session = { job_id: 'job-timeout-validation', role: 'architect', openclaw_session_key: 'agent:architect:timeout-validation' };
  const message = { message_id: 'msg-timeout-validation', message_type: 'TASK', sender_role: 'cto', recipient_role: 'architect',
    payload_json: '{"task":"timeout validation"}', protocol: 'legacy', protocol_version: 0, attempt: 1,
    created_at: '2026-10-17T00:00:00.000Z' };
  for (const timeoutSeconds of [0, null, NaN, Infinity, -1, 1.5, '1', 'invalid', 2147479, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(() => deliverSessionMessage(session, message, { timeoutSeconds }),
      /timeoutSeconds must be a positive safe integer between 1 and 2147478/,
      'malformed/out-of-range timeout must be rejected before starting an external process');
  }
  console.log('OPENCLAW TIMEOUT INPUT VALIDATION PASS');
`;
const timeoutValidationRun = spawnSync(process.execPath, ['--input-type=module', '-e', timeoutValidationCode], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
  env: { ...process.env, OPENCLAW_BIN: timeoutValidationOpenClaw, OPENCLAW_TEST_TIMEOUT_MARKER: invalidTimeoutMarker }
});
assert.equal(timeoutValidationRun.status, 0, `invalid timeout values must be rejected cleanly: ${timeoutValidationRun.stderr}`);
assert.match(timeoutValidationRun.stdout, /OPENCLAW TIMEOUT INPUT VALIDATION PASS/);
assert.equal(fs.existsSync(invalidTimeoutMarker), false, 'invalid timeout values must not spawn OpenClaw or cross the remote side-effect boundary');

// A timeout must terminate the POSIX process group, not only the CLI leader.
// The background child deliberately inherits the CLI's output pipes; killing
// only the leader leaves delivery waiting and/or leaves a live descendant.
if (process.platform !== 'win32') {
  const timeoutPidFile = path.join(root, 'descendant.pid');
  const timeoutOpenClaw = path.join(root, 'openclaw-timeout');
  fs.writeFileSync(timeoutOpenClaw,
    '#!/bin/sh\nsleep 30 &\necho $! > "$OPENCLAW_TEST_DESCENDANT_PID_FILE"\nwait\n',
    { flag: 'wx', mode: 0o700 });
  fs.chmodSync(timeoutOpenClaw, 0o700);
  const timeoutChildCode = `
    const { deliverSessionMessage } = await import(${JSON.stringify(new URL('../src/runtime/session-transport.js', import.meta.url).href)});
    try {
      await deliverSessionMessage(
        { job_id: 'job-process-group-timeout', role: 'architect', openclaw_session_key: 'agent:architect:timeout' },
        { message_id: 'msg-process-group-timeout', message_type: 'TASK', sender_role: 'cto', recipient_role: 'architect',
          payload_json: '{"task":"timeout boundary"}', protocol: 'legacy', protocol_version: 0, attempt: 1,
          created_at: '2026-10-14T00:00:00.000Z' },
        { timeoutSeconds: 1 }
      );
      process.exitCode = 2;
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, transportCode: error.transportCode, message: error.message }));
    }
  `;
  const timeoutRun = spawnSync(process.execPath, ['--input-type=module', '-e', timeoutChildCode], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 12_000,
    env: { ...process.env, OPENCLAW_BIN: timeoutOpenClaw, OPENCLAW_TEST_DESCENDANT_PID_FILE: timeoutPidFile }
  });
  assert.equal(timeoutRun.status, 0, `process-group timeout fixture must finish cleanly: ${timeoutRun.stderr}`);
  const timeoutReceipt = JSON.parse(timeoutRun.stdout.trim());
  assert.equal(timeoutReceipt.transportCode, 'TIMEOUT', 'CLI timeout must remain an ambiguous transport outcome');
  assert.match(timeoutReceipt.message, /external effects remain uncertain/);
  assert.ok(fs.existsSync(timeoutPidFile), 'fake CLI must have started its background descendant');
  const descendantPid = Number(fs.readFileSync(timeoutPidFile, 'utf8').trim());
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1, 'fixture must record a valid descendant PID');
  // A killed process may briefly remain as a zombie until the container's init
  // reaps it. Only a non-zombie /proc entry counts as a live descendant.
  const deadline = Date.now() + 1500;
  let descendantAlive = true;
  while (Date.now() < deadline) {
    try {
      const stat = fs.readFileSync(`/proc/${descendantPid}/stat`, 'utf8');
      descendantAlive = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch { descendantAlive = false; }
    if (!descendantAlive) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(descendantAlive, false, 'timeout must kill a background process in the CLI process group');
  console.log('OPENCLAW TIMEOUT / PROCESS-GROUP TERMINATION / AMBIGUOUS OUTCOME QUARANTINE PASS');

  // An intentionally escaped descendant keeps the CLI's captured pipe FDs
  // open after the original group is killed. Delivery must return an ambiguous
  // timeout after the local grace period rather than waiting for pipe EOF.
  const escapedPidFile = path.join(root, 'escaped-descendant.pid');
  const escapedOpenClaw = path.join(root, 'openclaw-escaped');
  fs.writeFileSync(escapedOpenClaw,
    `#!/bin/sh\nsetsid sh -c 'echo $$ > "$OPENCLAW_TEST_ESCAPED_PID_FILE"; exec sleep 30' &\nwait\n`,
    { flag: 'wx', mode: 0o700 });
  fs.chmodSync(escapedOpenClaw, 0o700);
  const escapedRun = spawnSync(process.execPath, ['--input-type=module', '-e', timeoutChildCode], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 7000,
    env: { ...process.env, OPENCLAW_BIN: escapedOpenClaw, OPENCLAW_TEST_ESCAPED_PID_FILE: escapedPidFile }
  });
  try {
    assert.equal(escapedRun.status, 0, `escaped pipe descendant must not hang delivery: ${escapedRun.stderr}`);
    const escapedReceipt = JSON.parse(escapedRun.stdout.trim());
    assert.equal(escapedReceipt.transportCode, 'TIMEOUT');
    assert.match(escapedReceipt.message, /external effects remain uncertain/);
    assert.ok(fs.existsSync(escapedPidFile), 'escaped descendant fixture must start before timeout');
  } finally {
    if (fs.existsSync(escapedPidFile)) {
      const escapedPid = Number(fs.readFileSync(escapedPidFile, 'utf8').trim());
      if (Number.isSafeInteger(escapedPid) && escapedPid > 1) { try { process.kill(escapedPid, 'SIGKILL'); } catch {} }
    }
  }
  console.log('OPENCLAW ESCAPED-DESCENDANT PIPE-HANG / AMBIGUOUS TIMEOUT REGRESSION PASS');
}
