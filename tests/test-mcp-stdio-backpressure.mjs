import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-backpressure-'));
const dataDir = path.join(root, 'data');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: repo,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    CHAT_ON_STEROIDS_DATA_DIR: dataDir,
    CHAT_ON_STEROIDS_WORKSPACE: root,
    WORKFLOW_DATA_DIR: dataDir,
    WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
    EXECUTION_TMP_DIR: path.join(dataDir, 'runtime')
  },
  stdio: ['pipe', 'pipe', 'pipe']
});

let stderr = '';
let stdinError = null;
let malformedChild = null;
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdin.on('error', error => { stdinError = error; });

try {
  await delay(400);
  assert.equal(child.exitCode, null, `MCP server failed during startup: ${stderr}`);

  // server/discover has a much larger response than its request. Leave stdout
  // unread and send more input than the OS pipe can hold. A correct server must
  // stop consuming stdin when stdout backpressure reaches its high-water mark.
  const frame = index => `${JSON.stringify({ jsonrpc: '2.0', id: index, method: 'server/discover', params: {} })}\n`;
  const payload = Buffer.from(Array.from({ length: 30000 }, (_, index) => frame(index + 1)).join(''));
  let offset = 0;
  let observedInputStall = false;
  while (offset < payload.length) {
    const end = Math.min(payload.length, offset + 1024);
    let accepted;
    try { accepted = child.stdin.write(payload.subarray(offset, end)); }
    catch (error) { throw new Error(`MCP server stopped accepting input: ${error.message}; stderr=${stderr}`); }
    offset = end;
    if (!accepted) {
      const result = await Promise.race([
        once(child.stdin, 'drain').then(() => 'drained'),
        delay(300).then(() => 'stalled')
      ]);
      if (result === 'stalled') {
        observedInputStall = true;
        break;
      }
    }
    assert.equal(child.exitCode, null, `MCP server exited while flooding requests: ${stderr}; stdinError=${stdinError?.message || 'none'}`);
  }
  assert.equal(observedInputStall, true,
    'server must propagate stdout backpressure to stdin instead of buffering unlimited responses');

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdout.resume();
  await Promise.race([
    (async () => {
      while (!stdout.includes('"jsonrpc":"2.0"')) await delay(10);
    })(),
    delay(2000).then(() => { throw new Error(`server did not resume output after stdout drained: ${stderr}`); })
  ]);
  assert.equal(child.exitCode, null, 'server should remain alive after backpressure clears');

  // Malformed requests are protocol errors too. They must use the same bounded
  // writer path; otherwise a flood of invalid JSON can enqueue parse-error
  // promises without awaiting stdout drain even though valid responses pause
  // stdin correctly.
  const malformedDataDir = path.join(root, 'malformed-data');
  malformedChild = spawn(process.execPath, ['server/index.js'], {
    cwd: repo,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT_ON_STEROIDS_DATA_DIR: malformedDataDir,
      CHAT_ON_STEROIDS_WORKSPACE: root,
      WORKFLOW_DATA_DIR: malformedDataDir,
      WORKFLOW_DB: path.join(malformedDataDir, 'workflow.db'),
      EXECUTION_TMP_DIR: path.join(malformedDataDir, 'runtime')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let malformedStderr = '';
  let malformedStdout = '';
  malformedChild.stderr.setEncoding('utf8');
  malformedChild.stderr.on('data', chunk => { malformedStderr += chunk; });
  malformedChild.stdin.on('error', error => { stdinError = error; });
  await delay(300);
  assert.equal(malformedChild.exitCode, null, `malformed-flood server failed during startup: ${malformedStderr}`);
  const malformedRequestCount = 200000;
  const malformedPayload = Buffer.from('{bad}\n'.repeat(malformedRequestCount));
  let malformedOffset = 0;
  let malformedInputStalled = false;
  while (malformedOffset < malformedPayload.length) {
    const end = Math.min(malformedPayload.length, malformedOffset + 1024);
    let accepted;
    try { accepted = malformedChild.stdin.write(malformedPayload.subarray(malformedOffset, end)); }
    catch (error) { throw new Error(`malformed-flood server stopped accepting input: ${error.message}; stderr=${malformedStderr}`); }
    malformedOffset = end;
    if (!accepted) {
      const result = await Promise.race([
        once(malformedChild.stdin, 'drain').then(() => 'drained'),
        delay(300).then(() => 'stalled')
      ]);
      if (result === 'stalled') { malformedInputStalled = true; break; }
    }
    assert.equal(malformedChild.exitCode, null, `server exited during malformed flood: ${malformedStderr}`);
  }
  assert.equal(malformedInputStalled, true,
    'malformed JSON responses must propagate stdout backpressure to stdin');
  malformedChild.stdout.setEncoding('utf8');
  malformedChild.stdout.on('data', chunk => { malformedStdout += chunk; });
  malformedChild.stdout.resume();
  while (malformedOffset < malformedPayload.length) {
    const end = Math.min(malformedPayload.length, malformedOffset + 1024);
    const accepted = malformedChild.stdin.write(malformedPayload.subarray(malformedOffset, end));
    malformedOffset = end;
    if (!accepted) {
      await Promise.race([
        once(malformedChild.stdin, 'drain'),
        delay(5000).then(() => { throw new Error(`malformed-flood stdin did not resume after stdout drain: ${malformedStderr}`); })
      ]);
    }
  }
  malformedChild.stdin.end();
  const malformedExit = await Promise.race([
    once(malformedChild, 'close').then(([code, signal]) => ({ code, signal })),
    delay(15000).then(() => { throw new Error(`malformed-flood server did not finish after drain: ${malformedStderr}`); })
  ]);
  assert.equal(malformedExit.code, 0, `malformed-flood server failed: ${malformedStderr}`);
  const malformedResponses = malformedStdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(malformedResponses.length, malformedRequestCount, 'every malformed request must produce one parse-error response');
  assert.ok(malformedResponses.every(response => response.id === null && response.error?.code === -32700),
    'malformed flood responses must retain JSON-RPC parse-error semantics');
  console.log('MALFORMED-JSON FLOOD / OUTPUT BACKPRESSURE / DRAIN RECOVERY PASS');

  // Independently exercise the current source runtime's MCP framing contract:
  // notifications have no response, malformed JSON gets a parse error, unknown
  // methods get method-not-found, and exposed tools match the package manifest.
  const protocolDataDir = path.join(root, 'protocol-data');
  const requests = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'method-that-does-not-exist', params: {} }),
    '{malformed-json'
  ].join('\n') + '\n';
  const smoke = spawnSync(process.execPath, ['server/index.js'], {
    cwd: repo,
    input: requests,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CHAT_ON_STEROIDS_DATA_DIR: protocolDataDir,
      CHAT_ON_STEROIDS_WORKSPACE: root,
      WORKFLOW_DATA_DIR: protocolDataDir,
      WORKFLOW_DB: path.join(protocolDataDir, 'workflow.db'),
      EXECUTION_TMP_DIR: path.join(protocolDataDir, 'runtime')
    }
  });
  assert.equal(smoke.status, 0, `current MCP runtime smoke failed: ${smoke.stderr}`);
  const responses = smoke.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(responses.length, 4, 'notifications must not emit responses');
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.serverInfo.name, 'chat-on-steroids-local-orchestrator');
  assert.equal(responses[1].id, 2);
  const manifestPath = fs.existsSync(path.join(repo, 'plugin/manifest.json'))
    ? path.join(repo, 'plugin/manifest.json')
    : path.join(repo, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(responses[1].result.tools.map(tool => tool.name).sort(), manifest.tools.map(tool => tool.name).sort(),
    'current source runtime tool exposure must match the declared package manifest');
  assert.equal(responses[2].id, 3);
  assert.equal(responses[2].error.code, -32601);
  assert.equal(responses[3].id, null);
  assert.equal(responses[3].error.code, -32700);
  console.log('MCP STDIO OUTPUT BACKPRESSURE / INPUT PAUSE / DRAIN RECOVERY PASS');
  console.log('CURRENT SOURCE MCP TOOL-MANIFEST BOUNDARY / NOTIFICATION / PARSE-ERROR SEMANTICS PASS');
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (malformedChild && malformedChild.exitCode === null && malformedChild.signalCode === null) malformedChild.kill('SIGKILL');
  await Promise.race([once(child, 'close').catch(() => {}), delay(1000)]);
  try { child.stdin.destroy(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
