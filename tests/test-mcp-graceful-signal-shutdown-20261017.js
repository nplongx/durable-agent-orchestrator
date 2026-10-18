import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-signal-shutdown-'));
const dataDir = path.join(temp, 'private-data');
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  NODE_ENV: 'test',
  CHAT_ON_STEROIDS_DATA_DIR: dataDir,
  CHAT_ON_STEROIDS_WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
  WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
  CHAT_ON_STEROIDS_WORKSPACE: workspace,
  CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(dataDir, 'runtime'),
  CHAT_ON_STEROIDS_TEST_RPC_QUEUE_DELAY_ID: 'shutdown-hold',
};
delete env.OPENAI_API_KEY;

const child = spawn(process.execPath, [path.join(root, 'server/index.js')], {
  cwd: root,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
const responses = new Map();
const waiters = new Map();
let exited = false;
let exitCode;
let exitSignal;
let resolveDelayStarted;
const delayStarted = new Promise(resolve => { resolveDelayStarted = resolve; });
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => {
  stdout += chunk;
  for (;;) {
    const newline = stdout.indexOf('\n');
    if (newline < 0) break;
    const line = stdout.slice(0, newline);
    stdout = stdout.slice(newline + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    responses.set(frame.id, frame);
    waiters.get(frame.id)?.(frame);
    waiters.delete(frame.id);
  }
});
child.stderr.on('data', chunk => {
  stderr += chunk;
  if (stderr.includes('test RPC queue delay entered: shutdown-hold')) resolveDelayStarted();
});
child.on('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });

function rpc(id, method, params = {}) {
  if (responses.has(id)) return Promise.resolve(responses.get(id));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`RPC ${id} timed out; stdout=${stdout}; stderr=${stderr}`));
    }, 3000);
    waiters.set(id, frame => { clearTimeout(timeout); resolve(frame); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  const initialized = await rpc('init', 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'graceful-signal-shutdown-test', version: '1' },
  });
  assert.equal(initialized.id, 'init');
  assert.ok(initialized.result, `server initialization failed: ${JSON.stringify(initialized)}`);

  child.stdin.write([
    JSON.stringify({ jsonrpc: '2.0', id: 'shutdown-hold', method: 'ping', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 'shutdown-after-held-request', method: 'ping', params: {} }),
    '',
  ].join('\n'));
  // Wait for an explicit server-side marker proving the first request reached
  // the in-flight queue seam before signaling; avoid a timing-only sleep.
  await Promise.race([
    delayStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`queue delay was not entered; stderr=${stderr}`)), 1500)),
  ]);
  child.kill('SIGTERM');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SIGTERM shutdown timed out; stderr=${stderr}`)), 4000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      exited = true; exitCode = code; exitSignal = signal;
      resolve();
    });
  });

  assert.equal(exitSignal, null, `SIGTERM must use graceful shutdown, not default signal exit; stderr=${stderr}`);
  assert.equal(exitCode, 0, `graceful shutdown must exit successfully; stderr=${stderr}`);
  assert.ok(responses.has('shutdown-hold'), `in-flight request response was lost; stderr=${stderr}`);
  assert.ok(responses.has('shutdown-after-held-request'), `queued request response was lost; stderr=${stderr}`);
  assert.deepEqual(responses.get('shutdown-hold').result, {});
  assert.deepEqual(responses.get('shutdown-after-held-request').result, {});
  const reopened = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  try { assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
  finally { reopened.close(); }
  console.log('MCP SIGTERM graceful drain, correlated responses, and SQLite reopen integrity PASS');
} finally {
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
