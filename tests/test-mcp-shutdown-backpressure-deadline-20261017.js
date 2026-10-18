import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-shutdown-backpressure-'));
const dataDir = path.join(temp, 'private-data');
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const child = spawn(process.execPath, [path.join(root, 'server/index.js')], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    CHAT_ON_STEROIDS_DATA_DIR: dataDir,
    CHAT_ON_STEROIDS_WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
    WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
    CHAT_ON_STEROIDS_WORKSPACE: workspace,
    CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(dataDir, 'runtime'),
    CHAT_ON_STEROIDS_TEST_SHUTDOWN_DRAIN_TIMEOUT_MS: '150',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
let initBuffer = '';
let exited = false;
let exitCode;
let exitSignal;
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });
child.on('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });

try {
  const initialized = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`initialize timed out: ${stderr}`)), 3000);
    const onData = chunk => {
      initBuffer += chunk;
      const newline = initBuffer.indexOf('\n');
      if (newline < 0) return;
      const frame = JSON.parse(initBuffer.slice(0, newline));
      if (frame.id !== 'init') return;
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      resolve(frame);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'shutdown-backpressure-test', version: '1' },
    } })}\n`);
  });
  assert.ok((await initialized).result, 'server initialization must succeed before stdout reader is paused');
  child.stdout.pause();

  // Stop reading stdout so a large tools/list response hits the Writable
  // backpressure boundary. The server must fail-stop on the bounded shutdown
  // deadline rather than hang forever waiting for a host that no longer reads.
  child.stdin.write(Array.from({ length: 100 }, (_, index) => JSON.stringify({
    jsonrpc: '2.0', id: `blocked-list-${index}`, method: 'tools/list', params: {},
  })).join('\n') + '\n');
  const backpressureReached = new Promise((resolve, reject) => {
    if (stderr.includes('test stdout backpressure entered')) return resolve();
    const startedAt = Date.now();
    const poll = () => {
      if (stderr.includes('test stdout backpressure entered')) return resolve();
      if (Date.now() - startedAt > 3000) return reject(new Error(`stdout backpressure was not reached: ${stderr}`));
      setTimeout(poll, 10);
    };
    poll();
  });
  await backpressureReached;
  child.kill('SIGTERM');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`shutdown did not honor drain deadline: ${stderr}`)), 3000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      exited = true; exitCode = code; exitSignal = signal;
      resolve();
    });
  });
  assert.equal(exitSignal, null, 'bounded shutdown must exit by explicit fail-stop, not default signal termination');
  assert.equal(exitCode, 1, 'undrainable stdout must not be reported as successful shutdown');
  assert.match(stderr, /shutdown drain exceeded 150ms/);
  console.log('MCP shutdown stdout-backpressure deadline and fail-stop PASS');
} finally {
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
