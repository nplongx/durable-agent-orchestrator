#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildPluginSandboxLaunch } from './scenario-sandbox.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'cos-sandbox-test-'));
const pluginRoot = path.join(root, 'plugin');
const workspace = path.join(root, 'workspace');
const dataDirectory = path.join(root, 'data');
const executionTmpDirectory = path.join(root, 'execution-tmp');
const outsideSentinel = path.join(root, 'outside-sentinel.txt');
for (const dir of [path.join(pluginRoot, 'server'), workspace, dataDirectory, executionTmpDirectory]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
fs.writeFileSync(outsideSentinel, 'outside-sentinel-intact\n', { mode: 0o600 });
fs.symlinkSync(outsideSentinel, path.join(workspace, 'escape-link'));

const listener = net.createServer(socket => socket.end('HOST-LOOPBACK-REACHED\n'));
await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
const hostPort = listener.address().port;
let acceptedConnections = 0;
listener.on('connection', () => acceptedConnections++);

const hostHome = os.homedir();
const sharedRuntimeDb = path.join(hostHome, '.chat-on-steroids', 'agent-orchestrator', 'workflow.db');
const userBusSocket = `/run/user/${process.getuid?.() ?? 1000}/bus`;
const childSource = `const fs=require('node:fs');process.stdout.write(JSON.stringify({hostHomeVisible:fs.existsSync(${JSON.stringify(hostHome)}),pidNamespace:fs.readFileSync('/proc/self/status','utf8').includes('NSpid:')}));`;
const probeSource = `
const fs = require('node:fs');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const hostHome = ${JSON.stringify(hostHome)};
const hostPort = ${hostPort};
let escapeWriteDenied = false;
try { fs.writeFileSync('/case/workspace/escape-link', 'must-not-escape'); }
catch { escapeWriteDenied = true; }
fs.writeFileSync('/case/workspace/inside-write.txt', 'workspace-write-ok\\n');
fs.writeFileSync('/case/data/inside-write.txt', 'data-write-ok\\n');
const network = new Promise(resolve => {
  const socket = net.createConnection({ host: '127.0.0.1', port: hostPort });
  const timer = setTimeout(() => { socket.destroy(); resolve('timeout'); }, 800);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected'); });
  socket.once('error', error => { clearTimeout(timer); resolve(error.code || 'error'); });
});
const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(childSource)}], { encoding: 'utf8', timeout: 3000 });
network.then(networkResult => {
  process.stdout.write(JSON.stringify({
    version: process.version,
    hostHomeVisible: fs.existsSync(hostHome),
    sharedRuntimeDbVisible: fs.existsSync(${JSON.stringify(sharedRuntimeDb)}),
    hostUserBusVisible: fs.existsSync(${JSON.stringify(userBusSocket)}),
    ollamaModelsVisible: fs.existsSync('/usr/share/ollama/.ollama/models'),
    workspaceWritable: fs.readFileSync('/case/workspace/inside-write.txt', 'utf8') === 'workspace-write-ok\\n',
    dataWritable: fs.readFileSync('/case/data/inside-write.txt', 'utf8') === 'data-write-ok\\n',
    escapeWriteDenied,
    networkResult,
    childExitCode: child.status,
    childOutput: child.stdout.trim(),
  }) + '\\n');
});
`;
fs.writeFileSync(path.join(pluginRoot, 'server', 'index.js'), probeSource, { mode: 0o400 });

try {
  const launch = buildPluginSandboxLaunch({ pluginRoot, workspace, dataDirectory,
    executionTmpDirectory, entryPoint: '/plugin/server/index.js' });
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('sandbox probe exceeded 10 seconds')); }, 10000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, `sandbox probe failed: ${stderr}`);
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one probe result; stdout=${stdout}; stderr=${stderr}`);
  const result = JSON.parse(lines[0]);
  assert.equal(result.version, process.version);
  assert.equal(result.hostHomeVisible, false, 'host home must not be mounted');
  assert.equal(result.sharedRuntimeDbVisible, false, 'shared runtime DB must not be visible');
  assert.equal(result.hostUserBusVisible, false, 'host service-control socket must not be visible');
  assert.equal(result.ollamaModelsVisible, false, 'local model store must not be mounted into plugin child');
  assert.equal(result.workspaceWritable, true, 'case workspace must be writable');
  assert.equal(result.dataWritable, true, 'condition-local data directory must be writable');
  assert.equal(result.escapeWriteDenied, true, 'symlink escape to an unmounted host path must fail');
  assert.notEqual(result.networkResult, 'connected', 'plugin sandbox must not reach host loopback');
  assert.equal(result.childExitCode, 0, 'spawned child must run inside sandbox');
  assert.equal(JSON.parse(result.childOutput).hostHomeVisible, false, 'child process must inherit filesystem isolation');
  assert.equal(acceptedConnections, 0, 'host listener must not receive sandbox traffic');
  assert.equal(fs.readFileSync(outsideSentinel, 'utf8'), 'outside-sentinel-intact\n');
  assert.equal(fs.existsSync(path.join(workspace, 'inside-write.txt')), true);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'inside-write.txt')), true);
  console.log(JSON.stringify({ status: 'PASS', sandbox_policy: launch.policy,
    assertions: ['host home hidden', 'shared runtime DB hidden', 'host service-control socket hidden', 'model store hidden', 'workspace/data writable',
      'symlink escape denied', 'host loopback unreachable', 'child inherits isolation',
      'systemd cgroup resource policy accepted', 'outside sentinel unchanged'] }, null, 2));
} finally {
  listener.close();
  rmSync(root, { recursive: true, force: true });
}
