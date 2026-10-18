import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-jsonrpc-no-id-regression-'));
const dataDir = path.join(temp, 'data');
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

try {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    CHAT_ON_STEROIDS_DATA_DIR: dataDir,
    CHAT_ON_STEROIDS_WORKSPACE: workspace,
    CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(dataDir, 'runtime')
  };
  delete env.OPENAI_API_KEY;
  const input = [
    // Missing ID does not make a malformed envelope a valid notification.
    JSON.stringify({ jsonrpc: '2.0', method: 7, params: {} }),
    // A valid no-ID tool call is a notification and must not dispatch.
    JSON.stringify({
      jsonrpc: '2.0', method: 'tools/call', params: {
        name: 'workflow_create', arguments: {
          title: 'must remain undispatched',
          task: 'Regression probe: valid notification must not mutate state.',
          workflow: 'engineering', workspace
        }
      }
    }),
    JSON.stringify({ jsonrpc: '2.0', id: 'barrier', method: 'ping', params: {} })
  ].join('\n') + '\n';
  const run = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
    cwd: root, env, encoding: 'utf8', input, timeout: 15000
  });
  assert.equal(run.status, 0, `server must exit cleanly: ${run.stderr}`);
  const responses = run.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(responses.length, 2, 'only malformed request and correlated ping should produce responses');
  assert.equal(responses[0].jsonrpc, '2.0');
  assert.equal(responses[0].id, null, 'malformed no-ID envelope response must use id:null');
  assert.equal(responses[0].error?.code, -32600, 'malformed no-ID envelope must return Invalid Request');
  assert.equal(responses[1].id, 'barrier', 'later correlated request must still receive its response');
  assert.deepEqual(responses[1].result, {});

  const db = new DatabaseSync(path.join(dataDir, 'workflow.db'), { readOnly: true });
  try {
    const jobs = db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;
    assert.equal(jobs, 0, 'valid no-ID tools/call notification must not dispatch workflow_create');
  } finally {
    db.close();
  }
  console.log('JSON-RPC malformed no-ID vs valid notification regression: PASS');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
