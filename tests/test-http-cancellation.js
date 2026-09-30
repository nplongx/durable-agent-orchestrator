import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const port = 8326;
const dbPath = `/tmp/chatgpt-adapter-http-cancel-${process.pid}.db`;
const logPath = `/tmp/chatgpt-adapter-http-cancel-${process.pid}.log`;

fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });

const child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    WORKFLOW_DB: dbPath,
    LANGGRAPH_ORCHESTRATOR: 'off',
    PREWARM_ALL_ACCOUNTS: 'false',
    BRIDGE_ASK_TIMEOUT_MS: '10000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

const logStream = fs.createWriteStream(logPath);
child.stdout.pipe(logStream);
child.stderr.pipe(logStream);

function waitForListening() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('isolated server did not start')), 15000);
    const onData = chunk => {
      if (String(chunk).includes(`listening on http://127.0.0.1:${port}/v1`)) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`isolated server exited before listening: ${code}`));
    });
  });
}

try {
  await waitForListening();
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      model: 'chatgpt-free',
      messages: [{ role: 'user', content: 'Reply with exactly: HTTP_CANCEL_REGRESSION' }]
    })
  });

  setTimeout(() => controller.abort(), 300);
  await assert.rejects(request, error => error?.name === 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 700));

  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /\[Adapter:HTTP\] Aborting request:/);
  const abortAt = log.lastIndexOf('[Adapter:HTTP] Aborting request:');
  const afterAbort = log.slice(abortAt);
  assert.doesNotMatch(afterAbort, /\[CDP:coordinator\] -> sendRaw Runtime\.evaluate/);
  assert.doesNotMatch(afterAbort, /Retrying prompt once after transient error/);

  console.log('HTTP cancellation PASS');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  logStream.end();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.rmSync(logPath, { force: true });
}
