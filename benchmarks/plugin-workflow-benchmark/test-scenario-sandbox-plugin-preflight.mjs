#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildPluginSandboxLaunch } from './scenario-sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const bundle = path.join(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb');
const expectedBundleHash = '413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa';
const sha256 = value => createHash('sha256').update(value).digest('hex');
if (!fs.existsSync(bundle)) {
  console.error(`BLOCKED: sandbox plugin preflight requires ${path.relative(repo, bundle)}, which is missing; required SHA-256 ${expectedBundleHash}. No temporary workspace was created. Restore the exact frozen artifact or complete the formal re-freeze/review process; candidate packages are not substitutes.`);
  process.exit(2);
}
const outputArg = process.argv.indexOf('--output');
const outputPath = outputArg >= 0 ? path.resolve(process.argv[outputArg + 1]) : null;
if (outputArg >= 0 && !process.argv[outputArg + 1]) throw new Error('--output requires a path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-sandbox-plugin-preflight-'));
const extracted = path.join(root, 'plugin-bundle');
const workspace = path.join(root, 'workspace');
const dataDirectory = path.join(root, 'data');
const executionTmpDirectory = path.join(root, 'execution-tmp');
for (const dir of [extracted, workspace, dataDirectory, executionTmpDirectory]) fs.mkdirSync(dir, { mode: 0o700 });
let child;

function rpcFactory(processHandle) {
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  processHandle.stdout.setEncoding('utf8');
  processHandle.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    }
  });
  processHandle.on('exit', code => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`sandbox plugin exited ${code}`)); }
    pending.clear();
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP preflight timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  assert.equal(sha256(fs.readFileSync(bundle)), expectedBundleHash, 'frozen bundle hash mismatch');
  const unpack = spawnSync('/usr/bin/unzip', ['-q', bundle, '-d', extracted], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC' }, timeout: 10000,
  });
  assert.equal(unpack.status, 0, `bundle extraction failed: ${unpack.stderr}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.8');
  const sandbox = buildPluginSandboxLaunch({ pluginRoot: extracted, workspace, dataDirectory,
    executionTmpDirectory, entryPoint: path.posix.join('/plugin', manifest.server.entry_point) });
  child = spawn(sandbox.command, sandbox.args, { env: sandbox.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
  const rpc = rpcFactory(child);
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'cos-sandbox-plugin-preflight', version: '1' } });
  assert.ok(!initialized.error, `MCP initialize failed: ${JSON.stringify(initialized.error)}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const listing = await rpc('tools/list');
  const tools = listing.result?.tools;
  assert.ok(Array.isArray(tools), `MCP tools/list failed: ${JSON.stringify(listing.error)}`);
  assert.equal(tools.length, 33);
  assert.ok(tools.some(tool => tool.name === 'orchestrator_health'));
  const healthCall = await rpc('tools/call', { name: 'orchestrator_health', arguments: {} });
  assert.ok(!healthCall.error && !healthCall.result?.isError, `read-only health call failed: ${JSON.stringify(healthCall)}`);
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('sandbox plugin did not exit after stdin close')); }, 3000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, `sandbox plugin exited ${exitCode}: ${stderr}`);

  const dbPath = path.join(dataDirectory, 'workflow.db');
  assert.ok(fs.existsSync(dbPath), 'condition-local database was not created at the sandboxed path');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let counts;
  try {
    counts = {
      jobs: Number(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n),
      tasks: Number(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n),
      approvals: Number(db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n),
      events: Number(db.prepare('SELECT COUNT(*) AS n FROM events').get().n),
      workflow_events: Number(db.prepare('SELECT COUNT(*) AS n FROM workflow_events').get().n),
    };
  } finally { db.close(); }
  assert.deepEqual(counts, { jobs: 0, tasks: 0, approvals: 0, events: 0, workflow_events: 0 },
    'read-only health preflight must not create workflows or approvals');
  const evidence = {
    protocol: 'cos-sandbox-plugin-preflight-v1', status: 'PASS', captured_at: new Date().toISOString(),
    bundle: { version: manifest.version, sha256: expectedBundleHash },
    mcp: { initialized: true, tool_count: tools.length, tool_names: tools.map(tool => tool.name).sort(),
      read_only_health_call_succeeded: true },
    sandbox_policy: sandbox.policy,
    condition_database: { path_is_case_local: true, counts, no_workflow_or_approval_mutation: true },
    benchmark_scenarios_executed: false,
    limitations: ['This is an isolated startup/read-only health preflight, not a benchmark scenario or an A/B score.',
      'It does not establish that plugin DB state causally produces synthetic workspace artifacts.'],
  };
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
  }
  fs.rmSync(root, { recursive: true, force: true });
}
