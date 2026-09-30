import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const port = 8327;
const dbPath = `/tmp/chatgpt-adapter-http-failure-${process.pid}.db`;
const logPath = `/tmp/chatgpt-adapter-http-failure-${process.pid}.log`;
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, logPath]) fs.rmSync(p, { force: true });

const child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), WORKFLOW_DB: dbPath, LANGGRAPH_ORCHESTRATOR: 'off', PREWARM_ALL_ACCOUNTS: 'false', BRIDGE_ASK_TIMEOUT_MS: '1000', ADAPTER_TEST_PARTIAL_UPSTREAM_FAILURE: 'true' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const log = fs.createWriteStream(logPath);
child.stdout.pipe(log); child.stderr.pipe(log);

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('isolated server did not start')), 15000);
  const onData = chunk => {
    if (String(chunk).includes(`listening on http://127.0.0.1:${port}/v1`)) { clearTimeout(timer); child.stdout.off('data', onData); resolve(); }
  };
  child.stdout.on('data', onData);
  child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited: ${code}`)); });
});

try {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt-free', messages: [{ role: 'user', content: 'failure-contract-probe' }] })
  });
  const body = await response.json();
  assert.equal(response.status, 504, `expected upstream timeout, got ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(body.error.type, 'upstream_timeout');
  assert.equal(body.choices, undefined);

  const streamResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt-free', stream: true, messages: [{ role: 'user', content: 'stream-failure-contract-probe' }] })
  });
  const streamBody = await streamResponse.text();
  assert.equal(streamResponse.status, 200);
  assert.match(streamBody, /"type":"upstream_timeout"/);
  assert.match(streamBody, /data: \[DONE\]/);
  assert.doesNotMatch(streamBody, /"finish_reason":"stop"/);

  const partial = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt-free', stream: true, messages: [{ role: 'user', content: 'partial failure regression' }] })
  });
  const partialBody = await partial.text();
  assert.equal(partial.status, 200);
  assert.match(partialBody, /partial upstream output/);
  assert.match(partialBody, /"type":"upstream_timeout"/);
  assert.equal((partialBody.match(/data: \[DONE\]/g) || []).length, 1);
  assert.equal((partialBody.match(/"type":"upstream_timeout"/g) || []).length, 1);
  assert.doesNotMatch(partialBody, /"finish_reason":"stop"/);
  console.log('HTTP failure contract PASS');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  log.end();
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, logPath]) fs.rmSync(p, { force: true });
}
