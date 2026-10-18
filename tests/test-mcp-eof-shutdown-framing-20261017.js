import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const tempRoots = [];

function startChild(label, extraEnv = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `cos-eof-${label}-`));
  tempRoots.push(temp);
  const dataDir = path.join(temp, 'data');
  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [path.join(repo, 'server/index.js')], {
    cwd: repo,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT_ON_STEROIDS_DATA_DIR: dataDir,
      CHAT_ON_STEROIDS_WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
      WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
      CHAT_ON_STEROIDS_WORKSPACE: workspace,
      CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(dataDir, 'runtime'),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function waitFor(test, description, ms = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (test()) return resolve();
      if (Date.now() - started >= ms) return reject(new Error(`${description} timed out`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForExit(child, ms = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return Promise.race([
    new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
    delay(ms).then(() => null),
  ]);
}

function initialize(child) {
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eof-shutdown-regression', version: '1' } },
  })}\n`);
}

const children = [];
try {
  // EOF while stdout is backpressured must use the same bounded fail-stop
  // deadline as signal-driven shutdown, not hang or become an unhandled reject.
  {
    try {
    const run = startChild('eof-backpressure', { CHAT_ON_STEROIDS_TEST_SHUTDOWN_DRAIN_TIMEOUT_MS: '150' });
    children.push(run.child);
    initialize(run.child);
    await waitFor(() => run.stdout.includes('"id":"init"'), 'initialize response');
    run.child.stdout.pause();
    run.child.stdin.write(Array.from({ length: 100 }, (_, i) => JSON.stringify({
      jsonrpc: '2.0', id: `eof-blocked-${i}`, method: 'tools/list', params: {},
    })).join('\n') + '\n');
    await waitFor(() => run.stderr.includes('test stdout backpressure entered'), 'stdout backpressure marker');
    run.child.stdin.end();
    const exit = await waitForExit(run.child, 2500);
    assert.ok(exit, `EOF/backpressure shutdown did not exit within bound; stderr=${run.stderr}`);
    assert.equal(exit.signal, null, `EOF/backpressure should fail-stop explicitly; stderr=${run.stderr}`);
    assert.equal(exit.code, 1, `EOF/backpressure must not report success; stderr=${run.stderr}`);
    assert.match(run.stderr, /shutdown drain exceeded 150ms|fatal unhandled rejection/i,
      `EOF/backpressure should report a bounded drain failure; stderr=${run.stderr}`);
    const diagnostic = run.stderr.split(/\r?\n/).find(line => /fatal unhandled rejection|shutdown drain exceeded/i.test(line)) || run.stderr.trim().split(/\r?\n/).at(-1);
    console.log(`EOF/backpressure observed exit=${exit.code}, signal=${exit.signal}; diagnostic=${diagnostic}`);
    } catch (error) { failures.push(`EOF/backpressure: ${error instanceof Error ? error.message : String(error)}`); }
  }

  // EOF with an unterminated final JSON-RPC frame must not silently discard it:
  // either parse/process it or explicitly report a framing/parse error.
  {
    try {
    const run = startChild('unterminated-frame');
    children.push(run.child);
    run.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'final-no-newline', method: 'ping', params: {} }));
    run.child.stdin.end();
    const exit = await waitForExit(run.child, 2500);
    assert.ok(exit, `unterminated-frame child did not exit; stderr=${run.stderr}`);
    const frames = run.stdout.split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const answered = frames.some(frame => frame.id === 'final-no-newline');
    const explicitlyRejected = /unterminated|incomplete frame|parse error|framing error/i.test(run.stderr) ||
      frames.some(frame => frame.id === null && frame.error?.code === -32700);
    assert.ok(answered || explicitlyRejected,
      `EOF silently discarded the unterminated JSON-RPC frame (exit=${exit.code}, stdout=${run.stdout}, stderr=${run.stderr})`);
    console.log(`unterminated-frame observed exit=${exit.code}, answered=${answered}, explicitlyRejected=${explicitlyRejected}`);
    } catch (error) { failures.push(`unterminated-frame: ${error instanceof Error ? error.message : String(error)}`); }
  }

  // A signal arriving after the EOF drain has settled must still close streams;
  // it must not reuse an already-settled promise and leave the child alive.
  {
    try {
    const run = startChild('signal-after-eof', { CHAT_ON_STEROIDS_TEST_EOF_DRAIN_SETTLED_MARKER: '1' });
    children.push(run.child);
    initialize(run.child);
    await waitFor(() => run.stdout.includes('"id":"init"'), 'race initialize response');
    run.child.stdin.end();
    await waitFor(() => run.stderr.includes('test stdin EOF drain settled'), 'EOF drain settled marker');
    // The EOF drain has actually settled before the signal is delivered.
    run.child.kill('SIGTERM');
    const exit = await waitForExit(run.child, 1200);
    assert.ok(exit, `SIGTERM after EOF drain left child alive; stdout=${run.stdout}; stderr=${run.stderr}`);
    assert.equal(exit.signal, null, `signal-after-EOF should close gracefully; stderr=${run.stderr}`);
    assert.equal(exit.code, 0, `signal-after-EOF must finish a successful drain, not merely fail-stop; stderr=${run.stderr}`);
    console.log(`signal-after-EOF observed exit=${exit.code}, signal=${exit.signal}`);
    } catch (error) { failures.push(`signal-after-EOF: ${error instanceof Error ? error.message : String(error)}`); }
  }

  // SIGINT must upgrade an already-settled EOF drain exactly as SIGTERM does.
  {
    try {
    const run = startChild('sigint-after-eof', { CHAT_ON_STEROIDS_TEST_EOF_DRAIN_SETTLED_MARKER: '1' });
    children.push(run.child);
    initialize(run.child);
    await waitFor(() => run.stdout.includes('"id":"init"'), 'SIGINT initialize response');
    run.child.stdin.end();
    await waitFor(() => run.stderr.includes('test stdin EOF drain settled'), 'SIGINT EOF drain settled marker');
    run.child.kill('SIGINT');
    const exit = await waitForExit(run.child, 1200);
    assert.ok(exit, `SIGINT after EOF drain left child alive; stdout=${run.stdout}; stderr=${run.stderr}`);
    assert.equal(exit.signal, null, `SIGINT after EOF should close gracefully; stderr=${run.stderr}`);
    assert.equal(exit.code, 0, `SIGINT-after-EOF must finish a successful drain, not merely fail-stop; stderr=${run.stderr}`);
    console.log(`SIGINT-after-EOF observed exit=${exit.code}, signal=${exit.signal}`);
    } catch (error) { failures.push(`SIGINT-after-EOF: ${error instanceof Error ? error.message : String(error)}`); }
  }

  // If the host closes its read end after a request is accepted, asynchronous
  // EPIPE must fail-stop instead of being swallowed by a later successful
  // write or by the EOF drain.
  {
    try {
    const run = startChild('stdout-error');
    children.push(run.child);
    initialize(run.child);
    await waitFor(() => run.stdout.includes('"id":"init"'), 'stdout-error initialize response');
    run.child.stdout.destroy();
    run.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'stdout-error-list', method: 'tools/list', params: {} })}\n`);
    run.child.stdin.end();
    const exit = await waitForExit(run.child, 2500);
    assert.ok(exit, `stdout EPIPE left process alive; stderr=${run.stderr}`);
    assert.equal(exit.signal, null, `stdout EPIPE must be an explicit fail-stop; stderr=${run.stderr}`);
    assert.equal(exit.code, 1, `stdout EPIPE must not be reported as successful output drain; stderr=${run.stderr}`);
    assert.match(run.stderr, /stdout write failure|EPIPE|broken pipe/i,
      `stdout EPIPE should leave an explicit diagnostic; stderr=${run.stderr}`);
    const diagnostic = run.stderr.split(/\r?\n/).find(line => /stdout write failure|EPIPE|broken pipe/i.test(line)) || run.stderr.trim().split(/\r?\n/).at(-1);
    console.log(`stdout-error observed exit=${exit.code}, signal=${exit.signal}; diagnostic=${diagnostic}`);
    } catch (error) { failures.push(`stdout-error: ${error instanceof Error ? error.message : String(error)}`); }
  }

} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
    setTimeout(resolve, 500).unref();
  })));
  for (const temp of tempRoots) fs.rmSync(temp, { recursive: true, force: true });
}

if (failures.length) {
  for (const failure of failures) console.error(`REGRESSION FAILURE: ${failure}`);
  process.exitCode = 1;
} else {
  console.log('MCP EOF / bounded backpressure / final-frame framing / signal-after-EOF regressions PASS');
}
