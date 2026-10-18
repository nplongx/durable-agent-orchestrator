import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('openclaw-message-send-boundary-');
const helperUrl = pathToFileURL(path.resolve('src/runtime/openclaw-message-send.js')).href;
const childBase = `
  const { sendOpenClawMessage } = await import(${JSON.stringify(helperUrl)});
  const request = { channel: 'slack', target: 'C-test', message: 'bounded transport fixture', replyTo: null };
`;
function writeExecutable(name, source) {
  const file = path.join(root, name);
  fs.writeFileSync(file, source, { flag: 'wx', mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}
function run(code, command, env = {}, timeout = 8000) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(), encoding: 'utf8', timeout,
    env: { ...process.env, OPENCLAW_BIN: command, ...env }
  });
}

const validCommand = writeExecutable('openclaw-valid', '#!/bin/sh\nprintf \'{"status":"sent","messageId":"171234.0007"}\\n\'\n');
const valid = run(`${childBase}\nconsole.log(JSON.stringify(await sendOpenClawMessage(request)));`, validCommand);
assert.equal(valid.status, 0, valid.stderr);
assert.equal(JSON.parse(valid.stdout.trim()).messageId, '171234.0007');

const missingCommand = path.join(root, 'openclaw-missing');
const missing = run(`${childBase}\ntry { await sendOpenClawMessage(request); process.exitCode = 3; } catch (e) { console.log(JSON.stringify({remoteOutcome:e.remoteOutcome, deliveryOutcome:e.deliveryOutcome, code:e.code})); }`, missingCommand);
assert.equal(missing.status, 0, missing.stderr);
const missingResult = JSON.parse(missing.stdout.trim());
assert.equal(missingResult.remoteOutcome, 'NOT_SENT');
assert.equal(missingResult.deliveryOutcome, 'not_sent');
assert.equal(missingResult.code, 'ENOENT');

const failedCommand = writeExecutable('openclaw-nonzero', '#!/bin/sh\nprintf \'remote response uncertain\\n\' >&2\nprintf \'{"status":"sent","messageId":"maybe-sent"}\\n\'\nexit 7\n');
const failed = run(`${childBase}\ntry { await sendOpenClawMessage(request); process.exitCode = 3; } catch (e) { console.log(JSON.stringify({remoteOutcome:e.remoteOutcome, transportCode:e.transportCode, code:e.code})); }`, failedCommand);
assert.equal(failed.status, 0, failed.stderr);
assert.equal(JSON.parse(failed.stdout.trim()).remoteOutcome, 'AMBIGUOUS', 'post-spawn nonzero exit cannot prove message was not accepted');

const invalidInputMarker = path.join(root, 'invalid-input-was-spawned');
const markerCommand = writeExecutable('openclaw-marker', '#!/bin/sh\nprintf invoked >> "$OPENCLAW_TEST_MARKER"\n');
const invalidInput = run(`${childBase}\ntry { await sendOpenClawMessage({...request, target: 42}); process.exitCode = 3; } catch (e) { console.log(JSON.stringify({remoteOutcome:e.remoteOutcome, message:e.message})); }`, markerCommand, { OPENCLAW_TEST_MARKER: invalidInputMarker });
assert.equal(invalidInput.status, 0, invalidInput.stderr);
assert.equal(JSON.parse(invalidInput.stdout.trim()).remoteOutcome, 'NOT_SENT');
assert.equal(fs.existsSync(invalidInputMarker), false, 'malformed destination args must not invoke OpenClaw');

const outputCommand = writeExecutable('openclaw-output-limit', '#!/bin/sh\nhead -c 4096 /dev/zero\nwait\n');
const outputBounded = run(`${childBase}\ntry { await sendOpenClawMessage(request, {timeoutMs:5000, maxOutputBytes:128}); process.exitCode = 3; } catch (e) { console.log(JSON.stringify({remoteOutcome:e.remoteOutcome, transportCode:e.transportCode, message:e.message})); }`, outputCommand);
assert.equal(outputBounded.status, 0, outputBounded.stderr);
const outputResult = JSON.parse(outputBounded.stdout.trim());
assert.equal(outputResult.remoteOutcome, 'AMBIGUOUS');
assert.equal(outputResult.transportCode, 'OUTPUT_LIMIT');
assert.match(outputResult.message, /128 combined stdout\/stderr bytes/);

if (process.platform !== 'win32') {
  const escapedPidFile = path.join(root, 'escaped.pid');
  const escapedCommand = writeExecutable('openclaw-escaped', `#!/bin/sh\nsetsid sh -c 'echo $$ > "$OPENCLAW_TEST_ESCAPED_PID_FILE"; exec sleep 30' &\nwait\n`);
  const timed = run(`${childBase}\ntry { await sendOpenClawMessage(request, {timeoutMs:250}); process.exitCode = 3; } catch (e) { console.log(JSON.stringify({remoteOutcome:e.remoteOutcome, transportCode:e.transportCode, message:e.message})); }`, escapedCommand, { OPENCLAW_TEST_ESCAPED_PID_FILE: escapedPidFile }, 5000);
  try {
    assert.equal(timed.status, 0, timed.stderr);
    const timeoutResult = JSON.parse(timed.stdout.trim());
    assert.equal(timeoutResult.remoteOutcome, 'AMBIGUOUS');
    assert.equal(timeoutResult.transportCode, 'TIMEOUT');
    assert.match(timeoutResult.message, /external effects remain uncertain/);
    assert.ok(fs.existsSync(escapedPidFile), 'escaped pipe-holder fixture must have started');
  } finally {
    if (fs.existsSync(escapedPidFile)) {
      const pid = Number(fs.readFileSync(escapedPidFile, 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }
}

console.log('OPENCLAW MESSAGE SEND: process-group timeout, bounded output, receipt and remote-outcome classification PASS');
