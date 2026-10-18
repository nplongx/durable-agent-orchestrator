import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-local-plugin-'));
// This suite intentionally creates queue pressure and exercises several full
// SQLite recovery transactions. Keep the protocol harness deadline bounded,
// but avoid false failures when the local host is loaded by independent package
// reproducibility builds that execute this same extracted test concurrently.
const RPC_TIMEOUT_MS = 15_000;
const dataDir = path.join(temp, 'private-data');
const workspace = path.join(temp, 'workspace');
const case01AckBarrierDir = path.join(dataDir, 'case01-ack-lineage-barriers');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(case01AckBarrierDir, { recursive: true, mode: 0o700 });
const env = { ...process.env, NODE_ENV: 'test', CHAT_ON_STEROIDS_DATA_DIR: dataDir, CHAT_ON_STEROIDS_WORKSPACE: workspace,
  CHAT_ON_STEROIDS_WORKFLOW_DB: path.join(dataDir, 'workflow.db'), WORKFLOW_DB: path.join(dataDir, 'workflow.db'),
  CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(dataDir, 'runtime'),
  CHAT_ON_STEROIDS_TEST_CASE01_ACK_LINEAGE_BARRIER_DIR: case01AckBarrierDir,
  CHAT_ON_STEROIDS_TEST_RPC_QUEUE_DELAY_ID: 'queue-cap-blocker' };
delete env.OPENAI_API_KEY;

// On POSIX, a host path such as /proc cannot be chmod'ed private. The plugin
// must reject it before attempting to create/open SQLite rather than silently
// proceeding after a failed chmod and relying on a later database error.
if (process.platform === 'linux') {
  // Protecting CHAT_ON_STEROIDS_DATA_DIR is insufficient if WORKFLOW_DB can
  // redirect SQLite into an unrelated public directory. node:sqlite otherwise
  // creates the database with the ambient umask (commonly 0644), exposing the
  // complete durable workflow ledger to other local users.
  const publicDbParent = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-public-db-parent-'));
  const privateDbData = path.join(temp, 'private-db-override');
  const publicDbPath = path.join(publicDbParent, 'workflow.db');
  fs.mkdirSync(privateDbData, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateDbData, 0o700);
  fs.chmodSync(publicDbParent, 0o777);
  try {
    const publicDbProbe = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'public-db-path-probe', version: '1' } } })}\n`,
      env: { ...env, CHAT_ON_STEROIDS_DATA_DIR: privateDbData, WORKFLOW_DATA_DIR: privateDbData,
        CHAT_ON_STEROIDS_WORKFLOW_DB: '', WORKFLOW_DB: publicDbPath,
        CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(privateDbData, 'runtime') }
    });
    assert.notEqual(publicDbProbe.status, 0,
      `plugin must reject a SQLite database path whose parent is public; observed db mode=${fs.existsSync(publicDbPath) ? (fs.statSync(publicDbPath).mode & 0o777).toString(8) : 'not-created'} stderr=${publicDbProbe.stderr}`);
    assert.match(publicDbProbe.stderr, /workflow database directory is not private/,
      `database path privacy failure must be explicit: ${publicDbProbe.stderr}`);
    assert.equal(fs.existsSync(publicDbPath), false,
      'database file must not be created in a group/world-accessible directory');

    const nestedPrivateParent = path.join(publicDbParent, 'nested-private');
    fs.mkdirSync(nestedPrivateParent, { mode: 0o700 });
    fs.chmodSync(nestedPrivateParent, 0o700);
    const replaceableAncestorDbPath = path.join(nestedPrivateParent, 'workflow.db');
    const ancestorProbe = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'writable-ancestor-db-probe', version: '1' } } })}\n`,
      env: { ...env, CHAT_ON_STEROIDS_DATA_DIR: privateDbData, WORKFLOW_DATA_DIR: privateDbData,
        CHAT_ON_STEROIDS_WORKFLOW_DB: '', WORKFLOW_DB: replaceableAncestorDbPath,
        CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(privateDbData, 'runtime') }
    });
    assert.notEqual(ancestorProbe.status, 0,
      'a private leaf directory below a world-writable non-sticky ancestor is still replaceable and must be rejected');
    assert.match(ancestorProbe.stderr, /workflow database path has a replaceable writable ancestor/);
    assert.equal(fs.existsSync(replaceableAncestorDbPath), false);

    const existingReadableDbPath = path.join(privateDbData, 'existing-readable.db');
    const existingReadableDb = new DatabaseSync(existingReadableDbPath);
    existingReadableDb.exec('CREATE TABLE preserved(value TEXT NOT NULL); INSERT INTO preserved VALUES (\'preserved\');');
    existingReadableDb.close();
    fs.chmodSync(existingReadableDbPath, 0o644);
    const existingDbProbe = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'existing-readable-db-probe', version: '1' } } })}\n`,
      env: { ...env, CHAT_ON_STEROIDS_DATA_DIR: privateDbData, WORKFLOW_DATA_DIR: privateDbData,
        CHAT_ON_STEROIDS_WORKFLOW_DB: '', WORKFLOW_DB: existingReadableDbPath,
        CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(privateDbData, 'runtime') }
    });
    assert.equal(existingDbProbe.status, 0, `owned regular database may be secured in place: ${existingDbProbe.stderr}`);
    assert.equal(fs.statSync(existingReadableDbPath).mode & 0o777, 0o600,
      'an existing owned SQLite database with overly broad file permissions must be tightened before schema use');

    const externalDbPath = path.join(publicDbParent, 'external-workflow.db');
    const externalDb = new DatabaseSync(externalDbPath);
    externalDb.exec('CREATE TABLE protected_sentinel(value TEXT NOT NULL); INSERT INTO protected_sentinel VALUES (\'unchanged\');');
    externalDb.close();
    const externalDbBefore = crypto.createHash('sha256').update(fs.readFileSync(externalDbPath)).digest('hex');
    const linkedDbPath = path.join(privateDbData, 'linked-workflow.db');
    fs.symlinkSync(externalDbPath, linkedDbPath);
    const linkProbe = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'symlink-db-path-probe', version: '1' } } })}\n`,
      env: { ...env, CHAT_ON_STEROIDS_DATA_DIR: privateDbData, WORKFLOW_DATA_DIR: privateDbData,
        CHAT_ON_STEROIDS_WORKFLOW_DB: '', WORKFLOW_DB: linkedDbPath,
        CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(privateDbData, 'runtime') }
    });
    assert.notEqual(linkProbe.status, 0, 'SQLite must refuse a symlinked workflow database path');
    assert.match(linkProbe.stderr, /workflow database path must be a canonical regular file/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(externalDbPath)).digest('hex'), externalDbBefore,
      'SQLite must not initialize or modify the database file behind a rejected symlink');

    const hardLinkedDbPath = path.join(privateDbData, 'hardlinked-workflow.db');
    fs.linkSync(externalDbPath, hardLinkedDbPath);
    const hardLinkProbe = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hardlink-db-path-probe', version: '1' } } })}\n`,
      env: { ...env, CHAT_ON_STEROIDS_DATA_DIR: privateDbData, WORKFLOW_DATA_DIR: privateDbData,
        CHAT_ON_STEROIDS_WORKFLOW_DB: '', WORKFLOW_DB: hardLinkedDbPath,
        CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(privateDbData, 'runtime') }
    });
    assert.notEqual(hardLinkProbe.status, 0, 'SQLite must refuse a workflow database inode shared by hard links');
    assert.match(hardLinkProbe.stderr, /workflow database file has unexpected hard links/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(externalDbPath)).digest('hex'), externalDbBefore,
      'SQLite must not modify a database inode rejected for external hard links');

    const privateDbPath = path.join(privateDbData, 'private-workflow.db');
    const privateDbProbe = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'private-db-path-probe', version: '1' } } })}\n`,
      env: { ...env, CHAT_ON_STEROIDS_DATA_DIR: privateDbData, WORKFLOW_DATA_DIR: privateDbData,
        CHAT_ON_STEROIDS_WORKFLOW_DB: '', WORKFLOW_DB: privateDbPath,
        CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(privateDbData, 'runtime') }
    });
    assert.equal(privateDbProbe.status, 0, `a canonical private database path should start normally: ${privateDbProbe.stderr}`);
    assert.ok(fs.existsSync(privateDbPath), 'a valid private database path must create SQLite state');
    assert.equal(fs.statSync(privateDbPath).mode & 0o777, 0o600,
      'SQLite database file permissions must be explicitly private, independent of the ambient umask');
  } finally {
    fs.rmSync(publicDbParent, { recursive: true, force: true });
  }

  const insecureStorage = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...env, CHAT_ON_STEROIDS_DATA_DIR: '/proc', CHAT_ON_STEROIDS_WORKSPACE: workspace,
      CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(dataDir, 'insecure-storage-probe-runtime') }
  });
  assert.notEqual(insecureStorage.status, 0, 'plugin must not start when its data directory cannot be secured');
  assert.match(insecureStorage.stderr, /local plugin data directory is not private: \/proc .*refusing to open workflow state/,
    `insecure storage must be rejected by the privacy gate before database initialization: ${insecureStorage.stderr}`);
}

// An uncaught exception or unhandled rejection means application invariants may
// already be broken. The production MCP process must fail-stop rather than log
// and continue serving state-changing calls from an unknown SQLite/runtime state.
for (const eventName of ['uncaughtException', 'unhandledRejection']) {
  const fatalDataDir = path.join(temp, `fatal-${eventName}`);
  const injected = `await import(${JSON.stringify(pathToFileURL(path.join(root, 'server/index.js')).href)});` +
    `setImmediate(() => process.emit(${JSON.stringify(eventName)}, new Error('injected-fatal-runtime-failure'), Promise.resolve()));`;
  const fatal = spawnSync(process.execPath, ['--input-type=module', '-e', injected], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...env, CHAT_ON_STEROIDS_DATA_DIR: fatalDataDir, CHAT_ON_STEROIDS_WORKSPACE: workspace,
      CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(fatalDataDir, 'runtime') }
  });
  assert.equal(fatal.status, 1,
    `${eventName} must terminate the MCP process with exit 1, not leave the server alive in a potentially inconsistent state; stdout=${fatal.stdout} stderr=${fatal.stderr}`);
  assert.match(fatal.stderr, /injected-fatal-runtime-failure/,
    `${eventName} must log the fatal cause before fail-stop`);
}

const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
let buffer = '';
const pending = new Map();
let nextId = 1;
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => {
  stdout += chunk;
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let response;
    try { response = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); waiter(response); }
  }
});
child.stderr.on('data', chunk => { stderr += chunk; });

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method} id=${String(id)}\nstdout=${stdout}\nstderr=${stderr}`)); }, RPC_TIMEOUT_MS);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function rawRpc(message, expectedId = Object.hasOwn(message || {}, 'id') ? message.id : null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(expectedId); reject(new Error(`raw RPC timeout: ${String(message?.method)} id=${String(expectedId)}\nstdout=${stdout}\nstderr=${stderr}`)); }, RPC_TIMEOUT_MS);
    pending.set(expectedId, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function rawBytes(bytes, expectedId = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(expectedId); reject(new Error(`raw byte RPC timeout\nstdout=${stdout}\nstderr=${stderr}`)); }, 10000);
    pending.set(expectedId, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(bytes);
  });
}

async function tool(name, args = {}) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, `${name} returned JSON-RPC error: ${JSON.stringify(response.error)}`);
  assert.equal(response.result?.isError, false, `${name} failed: ${response.result?.content?.[0]?.text}`);
  return response.result.structuredContent;
}

// Adversarial protocol/schema probes run against the real packaged entry point
// before any workflow fixtures are created. Client-side schema declarations
// are not a substitute for server-side validation at the stdio boundary.
const wrongVersion = await rawRpc({ jsonrpc: '1.0', id: 'bad-version', method: 'orchestrator_health', params: {} });
assert.equal(wrongVersion.error?.code, -32600, 'non-2.0 JSON-RPC envelopes must be rejected before tool dispatch');
const malformedNoId = await rawRpc({ jsonrpc: '2.0', method: 7, params: {} }, null);
assert.equal(malformedNoId.error?.code, -32600, 'malformed JSON-RPC messages without an ID must return Invalid Request with id null, not be silently dropped');
assert.equal(malformedNoId.id, null);
const invalidId = await rawRpc({ jsonrpc: '2.0', id: { attacker: true }, method: 'orchestrator_health', params: {} }, null);
assert.equal(invalidId.error?.code, -32600, 'object-valued JSON-RPC IDs must be rejected rather than echoed as valid correlation identities');
assert.equal(invalidId.id, null, 'invalid request IDs must not be reflected into an invalid JSON-RPC response envelope');
const arrayParams = await rawRpc({ jsonrpc: '2.0', id: 'array-params', method: 'tools/call', params: [] });
assert.equal(arrayParams.error?.code, -32600, 'MCP request params must be an object, not an array');
const arrayArguments = await rawRpc({ jsonrpc: '2.0', id: 'array-arguments', method: 'tools/call', params: { name: 'orchestrator_health', arguments: [] } });
assert.equal(arrayArguments.error?.code, -32602, 'tools/call arguments must be an object');
const schemaViolation = await rawRpc({ jsonrpc: '2.0', id: 'schema-limit', method: 'tools/call', params: { name: 'workflow_list', arguments: { limit: 101 } } });
assert.equal(schemaViolation.result?.isError, true, 'the server must enforce advertised tool inputSchema bounds');
assert.match(schemaViolation.result?.content?.[0]?.text || '', /invalid arguments for workflow_list.*exceeds 100/);
const coercedInteger = await rawRpc({ jsonrpc: '2.0', id: 'schema-type', method: 'tools/call', params: { name: 'workflow_list', arguments: { limit: '10' } } });
assert.equal(coercedInteger.result?.isError, true, 'schema integer fields must reject coercible strings instead of relying on handler coercion');
assert.match(coercedInteger.result?.content?.[0]?.text || '', /workflow_list arguments\.limit must be integer/);
const unknownToolField = await rawRpc({ jsonrpc: '2.0', id: 'schema-extra-field', method: 'tools/call', params: { name: 'workflow_list', arguments: { limit: 10, bypassApproval: true } } });
assert.equal(unknownToolField.result?.isError, true, 'tool arguments must reject undocumented top-level fields rather than silently ignore them');
assert.match(unknownToolField.result?.content?.[0]?.text || '', /not allowed/);
const exposedToolSchemas = await rpc('tools/list', {});
assert.ok(exposedToolSchemas.result.tools.every(tool => tool.inputSchema?.type !== 'object' || tool.inputSchema.additionalProperties === false),
  'all public object tool schemas must publish the same closed top-level boundary enforced by the runtime');
const nestedSchemaViolation = await rawRpc({ jsonrpc: '2.0', id: 'schema-nested-extra-field', method: 'tools/call', params: { name: 'custom_workflow_create', arguments: {
  workflow_id: 'schema-negative', name: 'Schema negative test', description: 'Must be rejected before persistence.',
  input_contract: ['job.request'], tasks: [{ id: 'stage-one', role_id: 'schema-negative-role', undocumentedExecutionMode: 'shell' }]
} } });
assert.equal(nestedSchemaViolation.result?.isError, true,
  'nested task objects must reject undocumented execution-shaped fields at the MCP runtime schema gate');
assert.match(nestedSchemaViolation.result?.content?.[0]?.text || '', /tasks\[0\]\.undocumentedExecutionMode is not allowed/);
const schemaNegativeWorkflows = await tool('custom_workflow_list', { limit: 200 });
assert.ok(!schemaNegativeWorkflows.workflows.some(item => item.workflow_id === 'schema-negative'),
  'a nested-schema-rejected tool call must not persist any custom workflow version');
const nullIdPing = await rawRpc({ jsonrpc: '2.0', id: null, method: 'ping', params: {} }, null);
assert.equal(nullIdPing.id, null, 'an explicit null ID is still an ID-bearing request, not a notification');
const beforeUncorrelatedCall = new DatabaseSync(path.join(dataDir, 'workflow.db'));
const jobCountBeforeUncorrelatedCall = beforeUncorrelatedCall.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'workflow_create', arguments: {
  title: 'must not execute as an uncorrelated notification', task: 'This request lacks an ID and must not mutate durable workflow state.', workflow: 'engineering', workspace
} } })}\n`);
const notificationBarrier = await rpc('ping', {});
assert.deepEqual(notificationBarrier.result, {});
const jobCountAfterUncorrelatedCall = beforeUncorrelatedCall.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;
beforeUncorrelatedCall.close();
assert.equal(jobCountAfterUncorrelatedCall, jobCountBeforeUncorrelatedCall,
  'tools/call without an ID must be dropped as a notification without executing a state-changing tool');
console.log('MCP JSON-RPC envelope and executable tool-schema boundary PASS');

// The stdio frame parser must reject invalid UTF-8 at the byte boundary. A
// StringDecoder replacement character can otherwise turn malformed bytes
// into a different, valid JSON request before strict JSON validation runs.
const invalidUtf8Request = Buffer.concat([
  Buffer.from('{"jsonrpc":"2.0","id":"invalid-utf8","method":"ping","params":{"note":"'),
  Buffer.from([0xc3, 0x28]),
  Buffer.from('"}}\n')
]);
const invalidUtf8Response = await rawBytes(invalidUtf8Request);
assert.equal(invalidUtf8Response.error?.code, -32700,
  'invalid UTF-8 bytes must produce a parse error rather than a replacement-decoded request');
assert.equal(invalidUtf8Response.id, null);

// An unterminated oversized frame must be discarded with bounded retained
// state, and the parser must resynchronize at the next newline without losing
// a subsequent valid request.
const oversizedFrame = Buffer.alloc(8 * 1024 * 1024 + 1, 0x20);
const afterOversizeId = 'after-oversized-frame';
const afterOversizeResponse = new Promise((resolve, reject) => {
  const timer = setTimeout(() => { pending.delete(afterOversizeId); reject(new Error(`frame parser did not resynchronize\n${stderr}`)); }, 10000);
  pending.set(afterOversizeId, response => { clearTimeout(timer); resolve(response); });
});
child.stdin.write(oversizedFrame);
child.stdin.write(Buffer.from(`\n${JSON.stringify({ jsonrpc: '2.0', id: afterOversizeId, method: 'ping', params: {} })}\n`));
const oversizeParseError = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { pending.delete(null); reject(new Error(`oversized frame was not rejected\n${stderr}`)); }, 10000);
  pending.set(null, response => { clearTimeout(timer); resolve(response); });
});
assert.equal(oversizeParseError.error?.code, -32700, 'oversized frames must fail closed');
assert.match(oversizeParseError.error?.message || '', /request line exceeds/);
const afterOversizeResponseValue = await afterOversizeResponse;
assert.equal(afterOversizeResponseValue.id, afterOversizeId);
assert.deepEqual(afterOversizeResponseValue.result, {}, 'valid frames after an oversized line must still be handled');

// Enqueue limits must be enforced before the serialized handler queue grows
// without bound. Over-cap requests receive explicit overload errors and are
// not dispatched; IDs remain correlated even when responses arrive out of order.
const burst = Array.from({ length: 140 }, (_, index) => ({
  jsonrpc: '2.0', id: index === 0 ? 'queue-cap-blocker' : `queue-cap-${index}`, method: 'ping', params: {}
}));
const burstResponsesPromise = Promise.all(burst.map(message => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { pending.delete(message.id); reject(new Error(`queue-cap RPC timeout for ${message.id}`)); }, 10000);
  pending.set(message.id, response => { clearTimeout(timer); resolve(response); });
})));
child.stdin.write(Buffer.from(burst.map(message => JSON.stringify(message)).join('\n') + '\n'));
const burstResponses = await burstResponsesPromise;
assert.equal(burstResponses.length, burst.length);
assert.ok(burstResponses.some(response => response.error?.code === -32000 && /server overloaded/.test(response.error.message)),
  'a burst beyond the queue cap must be rejected instead of growing the pending queue without bound');
assert.ok(burstResponses.every(response => response.id !== null), 'overload errors must preserve each valid request ID');
console.log('MCP stdio framing bounds, strict UTF-8, and bounded request queue PASS');

function artifactFor(role) {
  const values = {
    'product-owner': { scope: 'Define the local plugin workflow acceptance scope.', acceptance_criteria: ['Approval required', 'Durable results'], non_goals: ['Cloud execution'] },
    researcher: { findings: ['MCP stdio is sufficient for local tool integration.'], sources: ['repository inspection'], limitations: ['Host conversation performs reasoning.'] },
    architect: { components: ['MCP stdio server', 'SQLite store', 'local execution manager'], interfaces: ['tools/list', 'tools/call'], failure_modes: ['SQLite lock', 'invalid artifact'], implementation_boundary: 'No cloud runner or HTTP adapter.' },
    engineer: { summary: 'Implemented the local plugin test fixture.', files_changed: [], verification: ['Plugin E2E test process ran.'], execution: { mode: 'chat-on-steroids-local-tools', exit_code: null, session_id: null, evidence_refs: ['test:chat-on-steroids-plugin'] } },
    security: { threats: ['Unapproved execution', 'secret leakage'], findings: ['Approval gate and output redaction are present.'], decision: 'accept' },
    qa: { checks: ['stdio protocol', 'approval gate', 'DAG ordering'], results: ['all assertions passed'], decision: 'accept' },
    platform: { runtime: { mode: 'local stdio' }, deployment: { package: 'mcpb' }, recovery: { state: 'SQLite durable state' } },
    writer: { summary: 'Local plugin workflow instructions are documented.', user_facing_changes: ['MCP tools'], verification: ['README reviewed'] },
    reviewer: { requirementsSatisfied: true, architectureConformant: true, securityAccepted: true, qaAccepted: true, platformAccepted: true, documentationAccepted: true, implementationIssues: [], evidenceIssues: [], securityIssues: [], blockingIssues: [], decision: 'accept' },
    cto: { decision: 'approve', summary: 'Local plugin acceptance test completed.', accepted_requirements: ['local-only orchestration'], unresolved_risks: [], follow_up_actions: [], evidence_refs: ['test:chat-on-steroids-plugin'] }
  };
  return values[role];
}

async function testCase01ConsumptionAckSigkillRecovery(crashBoundary = 'after-ack') {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'case01-consumption-sigkill-'));
  const isolatedData = path.join(isolatedRoot, 'data');
  const isolatedWorkspace = path.join(isolatedRoot, 'workspace');
  fs.mkdirSync(isolatedWorkspace, { recursive: true });
  const launch = crashAt => {
    const childProcess = spawn(process.execPath, [path.join(root, 'server/index.js')], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test', CHAT_ON_STEROIDS_DATA_DIR: isolatedData,
        CHAT_ON_STEROIDS_WORKSPACE: isolatedWorkspace, CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: path.join(isolatedData, 'runtime'),
        ...(crashAt === 'after-ack' ? { CHAT_ON_STEROIDS_TEST_CRASH_AFTER_CASE01_ACK: 'SIGKILL' } : {}),
        ...(crashAt === 'before-ack' ? { CHAT_ON_STEROIDS_TEST_CRASH_BEFORE_CASE01_ACK: 'SIGKILL' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let buffer = '';
    let stdoutText = '';
    let stderrText = '';
    let requestId = 1;
    const pendingCalls = new Map();
    const exitPromise = new Promise(resolve => childProcess.once('exit', (code, signal) => resolve({ code, signal })));
    childProcess.stdout.setEncoding('utf8');
    childProcess.stderr.setEncoding('utf8');
    childProcess.stdout.on('data', chunk => {
      stdoutText += chunk; buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message; try { message = JSON.parse(line); } catch { continue; }
        const waiter = pendingCalls.get(message.id);
        if (waiter) { pendingCalls.delete(message.id); waiter.resolve(message); }
      }
    });
    childProcess.stderr.on('data', chunk => { stderrText += chunk; });
    childProcess.on('exit', (_code, signal) => {
      for (const [id, waiter] of pendingCalls) {
        clearTimeout(waiter.timer); waiter.reject(new Error(`isolated MCP process exited (${signal || 'no signal'}): ${stderrText}\n${stdoutText}`)); pendingCalls.delete(id);
      }
    });
    const rpcCall = (method, params = {}) => {
      const id = requestId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pendingCalls.delete(id); reject(new Error(`isolated MCP RPC timeout: ${method}\n${stderrText}\n${stdoutText}`)); }, 5000);
        pendingCalls.set(id, { timer, resolve: message => { clearTimeout(timer); resolve(message); }, reject });
        childProcess.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    };
    const callTool = async (name, args = {}) => {
      const response = await rpcCall('tools/call', { name, arguments: args });
      assert.equal(response.error, undefined, `${name}: ${JSON.stringify(response.error)}`);
      assert.equal(response.result?.isError, false, `${name}: ${response.result?.content?.[0]?.text}`);
      return response.result.structuredContent;
    };
    return { childProcess, rpcCall, callTool, exitPromise, getOutput: () => ({ stdoutText, stderrText }) };
  };
  let serverProcess = null;
  let inspectionDb = null;
  const shutdown = async current => {
    if (!current) return;
    if (current.childProcess.exitCode === null && current.childProcess.signalCode === null) {
      current.childProcess.kill('SIGTERM');
      await current.exitPromise;
    }
  };
  try {
    serverProcess = launch(crashBoundary);
    const initialized = await serverProcess.rpcCall('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'case01-ack-crash-test', version: '1' } });
    assert.equal(initialized.result?.serverInfo?.name, 'chat-on-steroids-local-orchestrator');
    await serverProcess.rpcCall('tools/list');
    await serverProcess.callTool('custom_role_create', {
      role_id: 'ack-crash-requirements', name: 'Ack crash requirements', description: 'Isolated crash/recovery fixture.',
      system_prompt: 'Use exact bytes and never invent hashes.', input_contract: ['job.request'], output_artifact_type: 'requirements',
      allowed_capabilities: ['product.requirements'], permissions: ['workspace.read', 'artifact.create']
    });
    await serverProcess.callTool('custom_workflow_create', {
      workflow_id: 'case01-artifact-lineage', name: 'Ack crash lineage', description: 'Isolated SIGKILL boundary fixture.', input_contract: ['job.request'],
      tasks: [{ id: 'validate-bytes', role_id: 'ack-crash-requirements', role_version: 1, input_contract: ['job.request'], output_artifact_type: 'requirements', depends_on: [] }]
    });
    const preview = await serverProcess.callTool('custom_workflow_preview', { workflow_id: 'case01-artifact-lineage' });
    await serverProcess.callTool('custom_workflow_approve', { plan_id: preview.plan.plan_id, confirmation: 'Approve isolated SIGKILL recovery fixture only.' });
    const run = await serverProcess.callTool('custom_workflow_run_create', { plan_id: preview.plan.plan_id, title: 'Ack crash boundary', request: 'Test acknowledgement recovery after actual process death.', workspace: isolatedWorkspace });
    await serverProcess.callTool('workflow_approve', { job_id: run.job_id, confirmation: 'Approve isolated test fixture.' });
    await serverProcess.callTool('workflow_dispatch', { job_id: run.job_id });
    await serverProcess.callTool('workflow_prepare_tasks', { job_id: run.job_id });
    const next = await serverProcess.callTool('workflow_next_task', { job_id: run.job_id });
    assert.equal(next.stage, 'task');
    const config = Buffer.from('{"service":"ack-crash","port":43127}', 'utf8');
    const resultBytes = Buffer.from('{"validated":true,"service":"ack-crash"}', 'utf8');
    fs.writeFileSync(path.join(isolatedWorkspace, 'config.json'), config);
    fs.writeFileSync(path.join(isolatedWorkspace, 'result.json'), resultBytes);
    const hashes = [
      { path: 'config.json', sha256: crypto.createHash('sha256').update(config).digest('hex') },
      { path: 'result.json', sha256: crypto.createHash('sha256').update(resultBytes).digest('hex') }
    ];
    const completed = await serverProcess.callTool('workflow_complete_task', { task_id: next.task.task_id, content: 'Validated exact fixture bytes.', artifact: {
      scope: 'isolated consumption crash test', acceptance_criteria: ['snapshot digest exact'], non_goals: ['no pilot'], workspace_artifacts: hashes
    } });
    const synthesis = await serverProcess.callTool('workflow_next_task', { job_id: run.job_id });
    assert.equal(synthesis.stage, 'synthesis');
    const consumed = synthesis.completed_results.find(item => item.task_id === next.task.task_id)?.verified_workspace_bytes?.workspace_artifacts;
    assert.ok(Array.isArray(consumed) && consumed.length === 2);
    const taskArtifact = (await serverProcess.callTool('workflow_artifacts', { job_id: run.job_id })).artifacts.find(item => item.task_id === next.task.task_id && item.type === 'requirements');
    const synthesisArgs = { job_id: run.job_id, content: 'Crash-boundary CTO synthesis.', consumed_workspace_bytes: consumed, artifact: {
      decision: 'approve', summary: 'Exact-byte crash-boundary synthesis', accepted_requirements: ['snapshot bytes and consumer digest match'],
      unresolved_risks: ['model cognitive use is not independently observable'], follow_up_actions: [], evidence_refs: [taskArtifact.artifact_id],
      workspace_snapshot_id: JSON.parse(taskArtifact.content).workspace_snapshot_id, workspace_artifacts: JSON.parse(taskArtifact.content).workspace_artifacts
    } };
    const pendingSynthesis = serverProcess.rpcCall('tools/call', { name: 'workflow_complete_synthesis', arguments: synthesisArgs });
    await assert.rejects(pendingSynthesis, /exited \(SIGKILL\)/, 'the child process must be killed after the durable acknowledgement commits');
    const died = await serverProcess.exitPromise;
    assert.equal(died.signal, 'SIGKILL', 'the crash boundary uses real OS-level process termination');

    inspectionDb = new DatabaseSync(path.join(isolatedData, 'workflow.db'));
    const durableAck = inspectionDb.prepare('SELECT * FROM case01_consumption_acks WHERE job_id=?').get(run.job_id);
    if (crashBoundary === 'after-ack') {
      assert.ok(durableAck, 'acknowledgement must survive SIGKILL after its SQLite commit');
      assert.equal(durableAck.source_result_id, completed.result_id);
    } else {
      assert.equal(durableAck, undefined, 'SIGKILL before acknowledgement transaction must leave no acknowledgement row');
      assert.equal(inspectionDb.prepare("SELECT COUNT(*) AS n FROM results WHERE task_id=(SELECT task_id FROM tasks WHERE job_id=? AND role='cto') AND outcome='success'").get(run.job_id).n, 1,
        'CTO result must be durable before the pre-ack crash boundary');
      assert.equal(inspectionDb.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='case01.snapshot_consumption_acknowledged'").get(run.job_id).n, 0);
    }
    assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS n FROM reports WHERE job_id=? AND kind=\'final\'').get(run.job_id).n, 0,
      'crash occurs before report creation, so recovery must not infer terminal success');
    assert.equal(inspectionDb.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='job.completed'").get(run.job_id).n, 0);
    inspectionDb.close(); inspectionDb = null;

    serverProcess = launch(false);
    const restartedInit = await serverProcess.rpcCall('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'case01-ack-restart-test', version: '1' } });
    assert.equal(restartedInit.result?.serverInfo?.name, 'chat-on-steroids-local-orchestrator');
    const interrupted = await serverProcess.callTool('workflow_recovery_verify', { job_id: run.job_id });
    assert.equal(interrupted.status, 'NEEDS_ATTENTION', 'fresh process must report the persisted CTO-to-report crash window');
    assert.equal(interrupted.checks.find(check => check.name === 'case01_durable_consumption_ack_binds_actual_bytes_and_full_lineage')?.pass,
      crashBoundary === 'after-ack', 'fresh process must distinguish a durable acknowledgement from a pre-ack incomplete transition');
    const resumed = await serverProcess.callTool('workflow_complete_synthesis', synthesisArgs);
    assert.equal(resumed.terminalized, true, 'idempotent synthesis retry must finish report/delivery/terminal state');
    const recovered = await serverProcess.callTool('workflow_recovery_verify', { job_id: run.job_id });
    assert.equal(recovered.status, 'PASS', JSON.stringify(recovered.checks));
    inspectionDb = new DatabaseSync(path.join(isolatedData, 'workflow.db'));
    assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS n FROM case01_consumption_acks WHERE job_id=?').get(run.job_id).n, 1,
      'recovery retry must not duplicate the consumption acknowledgement');
    assert.equal(inspectionDb.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='case01.snapshot_consumption_acknowledged'").get(run.job_id).n, 1,
      'recovery retry must preserve one logical acknowledgement event');
    assert.equal(inspectionDb.prepare("SELECT COUNT(*) AS n FROM reports WHERE job_id=? AND kind='final'").get(run.job_id).n, 1);
    console.log(`CASE-01 SIGKILL/restart (${crashBoundary}): PASS (independent SQLite inspection; no false terminal success; idempotent retry/recovery)`);
  } finally {
    if (inspectionDb) inspectionDb.close();
    await shutdown(serverProcess);
    const makeWritable = target => {
      let stat; try { stat = fs.lstatSync(target); } catch { return; }
      if (stat.isDirectory() && !stat.isSymbolicLink()) { fs.chmodSync(target, 0o700); for (const name of fs.readdirSync(target)) makeWritable(path.join(target, name)); }
      else if (stat.isFile() && !stat.isSymbolicLink()) { try { fs.chmodSync(target, 0o600); } catch {} }
    };
    makeWritable(isolatedRoot);
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result?.serverInfo?.name, 'chat-on-steroids-local-orchestrator');
  const listed = await rpc('tools/list');
  assert.equal(listed.result.tools.length, 33);
  for (const name of ['workflow_e2e_run', 'workflow_recovery_verify', 'workflow_record_intervention', 'workflow_interventions', 'workflow_validate_artifact', 'workflow_access_diagnostics']) assert(listed.result.tools.some(tool => tool.name === name), `missing exposed tool ${name}`);
  for (const name of ['custom_role_create', 'custom_role_update', 'custom_role_get', 'custom_role_list', 'custom_role_clone']) assert(listed.result.tools.some(tool => tool.name === name), `missing exposed tool ${name}`);
  for (const name of ['custom_workflow_create', 'custom_workflow_update', 'custom_workflow_get', 'custom_workflow_list', 'custom_workflow_clone', 'custom_workflow_preview', 'custom_workflow_approve', 'custom_workflow_run_create']) assert(listed.result.tools.some(tool => tool.name === name), `missing exposed tool ${name}`);
  assert.ok(listed.result.tools.some(item => item.name === 'workflow_create'));

  const health = await tool('orchestrator_health');
  assert.equal(health.mode, 'local-only-mcp');
  assert.equal(health.cloud_execution, false);
  assert.equal(health.github_actions_dispatch, false);
  assert.equal(health.external_model_api, false);
  assert.ok(fs.statSync(dataDir).mode & 0o700);
  const intervention = await tool('workflow_record_intervention', { reason: 'Test fixture required a manual fallback.', workaround: 'Used the explicit local MCP test path.', proposed_automation: 'Add a deterministic regression test.' });
  assert.equal(intervention.recorded, true);
  assert.equal((await tool('workflow_interventions', { limit: 10 })).interventions.some(item => item.intervention_id === intervention.intervention.intervention_id), true);
  assert.equal((await tool('workflow_access_diagnostics')).read_only, true);
  const artifactValidation = await tool('workflow_validate_artifact', { artifact_type: 'qa-report', role: 'qa', artifact: { checks: ['fixture'], results: ['pass'], decision: 'accept' } });
  assert.equal(artifactValidation.valid, true);
  const malformedArtifactValidation = await tool('workflow_validate_artifact', { artifact_type: 'qa-report', role: 'qa', artifact: { checks: 'not-an-array', results: ['pass'], decision: 'accept' } });
  assert.equal(malformedArtifactValidation.valid, false, 'preflight must reject semantically invalid content instead of checking required field presence only');
  assert.match(malformedArtifactValidation.semantic_error, /invalid fields/i);
  const mismatchedArtifactValidation = await tool('workflow_validate_artifact', { artifact_type: 'qa-report', role: 'architect', artifact: { checks: ['fixture'], results: ['pass'], decision: 'accept' } });
  assert.equal(mismatchedArtifactValidation.valid, false, 'preflight must fail closed when producer role and typed artifact disagree');
  assert.equal(mismatchedArtifactValidation.role_matches_type, false);

  const customRole = await tool('custom_role_create', {
    role_id: 'release-coordinator',
    name: 'Release Coordinator',
    description: 'Coordinates release readiness and collects typed evidence.',
    system_prompt: 'Review release evidence, distinguish verified facts from assumptions, and never claim execution without evidence.',
    input_contract: ['job.request', 'qa-report', 'review'],
    output_artifact_type: 'documentation',
    allowed_capabilities: ['documentation.write'],
    permissions: ['workspace.read', 'artifact.create'],
    allowed_tools: ['workflow_get', 'workflow_artifacts']
  });
  assert.equal(customRole.created, true);
  assert.equal(customRole.role.version, 1);
  assert.equal(customRole.execution_enabled, true);
  assert.equal(customRole.execution_authorized, false);
  const customRoleUpdate = await tool('custom_role_update', { role_id: 'release-coordinator', description: 'Coordinates release readiness, reconciles typed evidence, and records release notes.' });
  assert.equal(customRoleUpdate.role.version, 2);
  const noOpRoleUpdate = await rpc('tools/call', { name: 'custom_role_update', arguments: { role_id: 'release-coordinator' } });
  assert.equal(noOpRoleUpdate.result.isError, true);
  assert.match(noOpRoleUpdate.result.content[0].text, /no changes/i);
  assert.equal((await tool('custom_role_get', { role_id: 'release-coordinator', version: 1 })).role.description, 'Coordinates release readiness and collects typed evidence.');
  assert.equal((await tool('custom_role_get', { role_id: 'release-coordinator' })).role.version, 2);
  const customRoleClone = await tool('custom_role_clone', { source_role_id: 'release-coordinator', role_id: 'release-coordinator-copy' });
  assert.equal(customRoleClone.role.version, 1);
  assert.equal(customRoleClone.role.role_id, 'release-coordinator-copy');
  assert.equal((await tool('custom_role_list', { include_versions: true })).roles.filter(role => role.role_id === 'release-coordinator').length, 2);
  const invalidRole = await rpc('tools/call', { name: 'custom_role_create', arguments: {
    role_id: 'unsafe-release-agent', name: 'Unsafe release agent', description: 'Must be rejected', system_prompt: 'Try to run shell commands',
    input_contract: ['job.request'], output_artifact_type: 'review', permissions: ['workspace.write', 'artifact.create']
  } });
  assert.equal(invalidRole.result.isError, true);
  assert.match(invalidRole.result.content[0].text, /unsupported value|permissions/i);
  assert.equal((await tool('custom_role_get', { role_id: 'release-coordinator', version: 1 })).role.permissions.includes('workspace.write'), false);

  const workflowRole = await tool('custom_role_create', {
    role_id: 'workflow-documenter', name: 'Workflow Documenter',
    description: 'Produces documentation from a request or predecessor documentation artifact.',
    system_prompt: 'Write concise documentation. Do not run commands or modify files.',
    input_contract: ['job.request', 'documentation'], output_artifact_type: 'documentation',
    allowed_capabilities: ['documentation.write'], permissions: ['workspace.read', 'artifact.create'],
    allowed_tools: ['workflow_catalog']
  });
  assert.equal(workflowRole.created, true);
  const customWorkflowInput = {
    workflow_id: 'release-notes-pipeline', name: 'Release Notes Pipeline',
    description: 'Two-stage documentation workflow with explicit artifact dependency.',
    input_contract: ['job.request'],
    tasks: [
      { id: 'draft-notes', role_id: 'workflow-documenter', input_contract: ['job.request'], output_artifact_type: 'documentation', depends_on: [] },
      { id: 'review-notes', role_id: 'workflow-documenter', input_contract: ['job.request', 'documentation'], output_artifact_type: 'documentation', depends_on: ['draft-notes'] }
    ]
  };
  const customWorkflow = await tool('custom_workflow_create', customWorkflowInput);
  assert.equal(customWorkflow.created, true);
  assert.equal(customWorkflow.workflow.version, 1);
  assert.equal(customWorkflow.execution_enabled, true);
  assert.equal(customWorkflow.execution_authorized, false);
  assert.equal(customWorkflow.workflow.tasks[1].role_version, 1, 'role version must be pinned at definition creation');
  const badCycle = await rpc('tools/call', { name: 'custom_workflow_create', arguments: { ...customWorkflowInput, workflow_id: 'cycle-pipeline', tasks: [
    { id: 'draft-notes', role_id: 'workflow-documenter', input_contract: ['job.request', 'documentation'], output_artifact_type: 'documentation', depends_on: ['review-notes'] },
    { id: 'review-notes', role_id: 'workflow-documenter', input_contract: ['job.request', 'documentation'], output_artifact_type: 'documentation', depends_on: ['draft-notes'] }
  ] } });
  assert.equal(badCycle.result.isError, true);
  assert.match(badCycle.result.content[0].text, /cycle detected/i);
  const badDependency = await rpc('tools/call', { name: 'custom_workflow_create', arguments: { ...customWorkflowInput, workflow_id: 'missing-dependency-pipeline', tasks: [
    { id: 'draft-notes', role_id: 'workflow-documenter', input_contract: ['job.request'], output_artifact_type: 'documentation', depends_on: ['missing-task'] }
  ] } });
  assert.equal(badDependency.result.isError, true);
  assert.match(badDependency.result.content[0].text, /unknown task/i);
  const preview = await tool('custom_workflow_preview', { workflow_id: 'release-notes-pipeline' });
  assert.equal(preview.previewed, true);
  assert.equal(preview.plan.requires_explicit_approval, true);
  assert.equal(preview.plan.execution_enabled, true, 'Phase 3 engine capability is enabled even while this plan is not approved');
  assert.equal(preview.plan.plan_approved, false);
  assert.equal(preview.plan.execution_authorized, false, 'preview alone must not authorize execution');
  assert.equal(preview.plan.tasks.length, 2);
  assert.equal(preview.plan.tasks[1].depends_on[0], 'draft-notes');
  assert.match(preview.plan.plan_hash, /^[a-f0-9]{64}$/);
  const unapprovedRun = await rpc('tools/call', { name: 'custom_workflow_run_create', arguments: { plan_id: preview.plan.plan_id, title: 'Should be blocked', request: 'Must not be runnable before plan approval.', workspace } });
  assert.equal(unapprovedRun.result.isError, true, 'an unapproved preview cannot create an execution proposal');
  assert.match(unapprovedRun.result.content[0].text, /requires explicit plan approval/i);
  const updatedRole = await tool('custom_role_update', { role_id: 'workflow-documenter', system_prompt: 'Updated role instructions for version 2 only. Do not run commands.' });
  assert.equal(updatedRole.role.version, 2);
  const updatedWorkflow = await tool('custom_workflow_update', { ...customWorkflowInput, description: 'Updated release notes pipeline definition.' });
  assert.equal(updatedWorkflow.workflow.version, 2);
  assert.equal(updatedWorkflow.workflow.tasks[0].role_version, 2, 'new workflow version pins the latest role version');
  assert.equal((await tool('custom_workflow_get', { workflow_id: 'release-notes-pipeline', version: 1 })).workflow.description, customWorkflowInput.description);
  const approvedPreview = await tool('custom_workflow_approve', { plan_id: preview.plan.plan_id, confirmation: 'I approve this immutable plan preview for design review only.' });
  assert.equal(approvedPreview.approved, true);
  assert.equal(approvedPreview.plan.plan_hash, preview.plan.plan_hash);
  assert.equal(approvedPreview.execution_enabled, true);
  assert.equal(approvedPreview.plan.plan_approved, true);
  assert.equal(approvedPreview.execution_authorized, false, 'plan approval must not replace separate workflow execution approval');
  const repeatedPlanApproval = await tool('custom_workflow_approve', { plan_id: preview.plan.plan_id, confirmation: 'Repeat the same approval to verify idempotent status metadata.' });
  assert.equal(repeatedPlanApproval.idempotent, true);
  assert.equal(repeatedPlanApproval.execution_enabled, true);
  assert.equal(repeatedPlanApproval.plan.plan_approved, true);
  assert.equal(repeatedPlanApproval.execution_authorized, false);
  const customRun = await tool('custom_workflow_run_create', {
    plan_id: preview.plan.plan_id,
    title: 'Custom workflow runtime integration',
    request: 'Create concise release notes and then review the draft using the configured custom role.' ,
    workspace
  });
  assert.equal(customRun.created, true);
  assert.equal(customRun.requires_separate_execution_approval, true);
  assert.equal(customRun.execution_enabled, true);
  assert.equal(customRun.execution_authorized, false);
  assert.equal(customRun.workflow_version, 1, 'execution proposal must remain bound to the approved workflow version');
  const customPreapprovalDispatch = await rpc('tools/call', { name: 'workflow_dispatch', arguments: { job_id: customRun.job_id } });
  assert.equal(customPreapprovalDispatch.result.isError, true, 'custom workflow must not dispatch before execution approval');
  const customExecutionApproval = await tool('workflow_approve', { job_id: customRun.job_id, confirmation: 'Explicitly approve this pinned custom workflow for local host-conversation task execution.' });
  assert.equal(customExecutionApproval.approved, true);
  assert.equal(customExecutionApproval.execution_enabled, true);
  assert.equal(customExecutionApproval.execution_authorized, true);
  assert.equal(customExecutionApproval.plan.custom_workflow, true);
  assert.equal(customExecutionApproval.plan.children.length, 2);
  assert.equal(customExecutionApproval.plan.children[0].execution.custom_role_id, 'workflow-documenter');
  assert.equal(customExecutionApproval.plan.children[0].execution.custom_role_version, 1);
  assert.match(customExecutionApproval.plan.children[0].execution.custom_role_system_prompt, /Write concise documentation/);
  assert.equal(customExecutionApproval.plan.children[0].execution.deterministic, false);
  const customDispatched = await tool('workflow_dispatch', { job_id: customRun.job_id });
  assert.equal(customDispatched.dispatched, true);
  assert.equal(customDispatched.execution_authorized, true);
  const customPrepared = await tool('workflow_prepare_tasks', { job_id: customRun.job_id });
  assert.equal(customPrepared.count, 2);
  let customNext = await tool('workflow_next_task', { job_id: customRun.job_id });
  assert.equal(customNext.stage, 'task');
  assert.match(customNext.task.description, /Workflow Documenter/);
  assert.match(customNext.task.description, /Write concise documentation/);
  assert.equal(customNext.expected_artifact.type, 'documentation');
  const draftTaskId = customNext.task.task_id;
  await tool('workflow_complete_task', { task_id: draftTaskId, content: 'Drafted release notes from the request; no files or commands were changed.', artifact: { summary: 'Draft release notes', user_facing_changes: ['Summarize the release'], verification: ['Reviewed the supplied request'] } });
  customNext = await tool('workflow_next_task', { job_id: customRun.job_id });
  assert.equal(customNext.stage, 'task');
  assert.equal(customNext.task.plan_task_id, 'review-notes');
  assert.ok(customNext.completed_results.some(item => item.task_id === draftTaskId));
  await tool('workflow_complete_task', { task_id: customNext.task.task_id, content: 'Reviewed the draft against the request; no commands were run.', artifact: { summary: 'Reviewed release notes', user_facing_changes: ['Confirmed the release summary'], verification: ['Compared draft with predecessor artifact'] } });
  customNext = await tool('workflow_next_task', { job_id: customRun.job_id });
  assert.equal(customNext.stage, 'synthesis');
  const customTerminal = await tool('workflow_complete_synthesis', {
    job_id: customRun.job_id,
    content: 'Custom workflow completed with two dependency-ordered documentation tasks and typed artifacts.',
    artifact: { decision: 'approve', summary: 'Custom workflow task chain passed', accepted_requirements: ['Two tasks completed in dependency order'], unresolved_risks: [], follow_up_actions: [], evidence_refs: [draftTaskId, customNext.completed_results[0]?.task_id || 'review-notes'] }
  });
  assert.equal(customTerminal.terminalized, true, 'custom workflow should terminalize through the shared engine');
  assert.equal((await tool('workflow_get', { job_id: customRun.job_id })).job.status, 'completed');
  const workflowClone = await tool('custom_workflow_clone', { source_workflow_id: 'release-notes-pipeline', workflow_id: 'release-notes-pipeline-copy' });
  assert.equal(workflowClone.workflow.version, 1);
  assert.equal(workflowClone.workflow.tasks[0].role_version, 2);
  assert.ok((await tool('custom_workflow_list', { include_versions: true })).workflows.filter(item => item.workflow_id === 'release-notes-pipeline').length === 2);

  // Full local MCP acceptance chain for CASE-01: task completion must bind the
  // typed artifact to a durable snapshot, and CTO synthesis must reuse that
  // exact snapshot identity/hash set before terminalization.
  const case01Role = await tool('custom_role_create', {
    role_id: 'case01-requirements', name: 'CASE-01 Requirements',
    description: 'Validates the exact final config/result bytes for the local acceptance fixture.',
    system_prompt: 'Validate the exact supplied config and result evidence; never invent hashes.',
    input_contract: ['job.request'], output_artifact_type: 'requirements',
    allowed_capabilities: ['product.requirements'], permissions: ['workspace.read', 'artifact.create']
  });
  assert.equal(case01Role.created, true);
  const case01Definition = await tool('custom_workflow_create', {
    workflow_id: 'case01-artifact-lineage', name: 'CASE-01 Artifact Lineage',
    description: 'One task followed by snapshot-bound CTO synthesis.', input_contract: ['job.request'],
    tasks: [{ id: 'create-validate', role_id: 'case01-requirements', role_version: 1, input_contract: ['job.request'], output_artifact_type: 'requirements', depends_on: [] }]
  });
  assert.equal(case01Definition.created, true);
  const case01Preview = await tool('custom_workflow_preview', { workflow_id: 'case01-artifact-lineage' });
  assert.equal(case01Preview.plan.workflow_id, 'case01-artifact-lineage');
  await tool('custom_workflow_approve', { plan_id: case01Preview.plan.plan_id, confirmation: 'Approve the isolated local CASE-01 snapshot-lineage test fixture.' });
  const case01Run = await tool('custom_workflow_run_create', {
    plan_id: case01Preview.plan.plan_id, title: 'CASE-01 immutable artifact lineage',
    request: 'Bind validated config/result bytes to a durable task artifact and CTO synthesis.', workspace
  });
  await tool('workflow_approve', { job_id: case01Run.job_id, confirmation: 'Approve only the local deterministic fixture used by this automated regression.' });
  await tool('workflow_dispatch', { job_id: case01Run.job_id });
  await tool('workflow_prepare_tasks', { job_id: case01Run.job_id });
  const case01Next = await tool('workflow_next_task', { job_id: case01Run.job_id });
  assert.equal(case01Next.stage, 'task');
  assert.equal(case01Next.expected_artifact.type, 'requirements');
  const configBytes = Buffer.from('{"service":"demo","port":43127}', 'utf8');
  const resultBytes = Buffer.from('{"validated":true,"service":"demo"}', 'utf8');
  fs.writeFileSync(path.join(workspace, 'config.json'), configBytes);
  fs.writeFileSync(path.join(workspace, 'result.json'), resultBytes);
  const case01Hashes = [
    { path: 'config.json', sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(workspace, 'config.json'))).digest('hex') },
    { path: 'result.json', sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(workspace, 'result.json'))).digest('hex') }
  ];
  const case01TaskCompletion = await tool('workflow_complete_task', {
    task_id: case01Next.task.task_id, content: 'Validated exact config.json and result.json final bytes.',
    artifact: { scope: 'CASE-01 exact-byte acceptance', acceptance_criteria: ['config.json and result.json hashes match exact final bytes'], non_goals: ['No paired benchmark or pilot claim'], workspace_artifacts: case01Hashes }
  });
  const case01Artifacts = await tool('workflow_artifacts', { job_id: case01Run.job_id });
  const taskArtifact = case01Artifacts.artifacts.find(item => item.task_id === case01Next.task.task_id && item.type === 'requirements' && item.status === 'active');
  assert.ok(taskArtifact, 'typed requirements artifact must be durable');
  assert.deepEqual(taskArtifact.evidence, [case01TaskCompletion.result_id], 'typed artifact must reference its exact durable task result');
  const taskContent = JSON.parse(taskArtifact.content);
  assert.match(taskContent.workspace_snapshot_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(taskContent.workspace_artifacts, case01Hashes);
  const snapshotDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  try {
    assert.equal(snapshotDb.prepare('SELECT COUNT(*) AS count FROM case01_snapshot_reservations WHERE snapshot_id=?').get(taskContent.workspace_snapshot_id).count, 0,
      'durable task artifact commit must resolve its in-flight snapshot reservation');
    const persistedTaskArtifact = snapshotDb.prepare('SELECT content, evidence_json FROM artifacts WHERE artifact_id=?').get(taskArtifact.artifact_id);
    assert.ok(persistedTaskArtifact);
    assert.equal(JSON.parse(persistedTaskArtifact.content).workspace_snapshot_id, taskContent.workspace_snapshot_id);
    assert.deepEqual(JSON.parse(persistedTaskArtifact.evidence_json), [case01TaskCompletion.result_id]);
  } finally { snapshotDb.close(); }
  const finalizedSnapshotRoot = path.join(dataDir, 'case01-snapshots', taskContent.workspace_snapshot_id);
  assert.deepEqual(taskContent.workspace_artifacts.map(item => ({ path: item.path, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(finalizedSnapshotRoot, item.path))).digest('hex') })), taskContent.workspace_artifacts,
    'persisted hashes must match exact bytes read back from the finalized snapshot');
  const case01Synthesis = await tool('workflow_next_task', { job_id: case01Run.job_id });
  assert.equal(case01Synthesis.stage, 'synthesis');
  const case01ConsumedBytes = case01Synthesis.completed_results.find(item => item.task_id === case01Next.task.task_id)?.verified_workspace_bytes?.workspace_artifacts;
  assert.ok(Array.isArray(case01ConsumedBytes) && case01ConsumedBytes.length === 2,
    'synthesis input must include the exact immutable snapshot bytes, not only paths and hash metadata');
  // Mutate the execution workspace after task finalization: CTO acceptance must
  // still use the immutable snapshot and the task artifact's exact hash pairs.
  fs.writeFileSync(path.join(workspace, 'config.json'), '{"service":"late-writer","port":43127}');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(finalizedSnapshotRoot, 'config.json'))).digest('hex'), case01Hashes[0].sha256,
    'late writes to the live workspace must not mutate finalized snapshot bytes');
  const case01SynthesisArgs = {
    job_id: case01Run.job_id, content: 'CTO accepted the snapshot-bound CASE-01 task artifact and exact bytes.',
    artifact: {
      decision: 'approve', summary: 'CASE-01 exact-byte lineage verified',
      accepted_requirements: ['Typed artifact and CTO synthesis share exact snapshot identity and hashes'],
      unresolved_risks: ['Local fixture is not an authorized paired pilot'], follow_up_actions: [],
      evidence_refs: [taskArtifact.artifact_id], workspace_snapshot_id: taskContent.workspace_snapshot_id,
      workspace_artifacts: taskContent.workspace_artifacts
    }
  };
  const substitutedConsumedBytes = case01ConsumedBytes.map(entry => ({ ...entry }));
  substitutedConsumedBytes[0].bytes = Buffer.from('{"service":"substituted"}', 'utf8').toString('base64');
  const rejectedConsumedBytes = await rpc('tools/call', { name: 'workflow_complete_synthesis', arguments: { ...case01SynthesisArgs, consumed_workspace_bytes: substitutedConsumedBytes } });
  assert.equal(rejectedConsumedBytes.result?.isError, true, 'a consumer-submitted buffer different from the verified snapshot must be rejected');
  assert.match(rejectedConsumedBytes.result?.content?.[0]?.text || '', /consumed bytes do not match the verified snapshot/);
  // Deterministically pause after the lineage bytes have been read. The
  // acknowledgement already holds BEGIN IMMEDIATE, so an independent SQLite
  // writer cannot alter a source result between digest calculation and commit.
  const ackArmPath = path.join(case01AckBarrierDir, `${case01Run.job_id}.arm`);
  const ackReadyPath = path.join(case01AckBarrierDir, `${case01Run.job_id}.lineage-ready`);
  const ackReleasePath = path.join(case01AckBarrierDir, `${case01Run.job_id}.release`);
  for (const p of [ackArmPath, ackReadyPath, ackReleasePath]) assert.equal(fs.existsSync(p), false, `unique ack race barrier path already exists: ${p}`);
  const sourceResultBeforeAck = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  let exactSourceResultContent;
  try {
    exactSourceResultContent = sourceResultBeforeAck.prepare('SELECT content FROM results WHERE result_id=?').get(case01TaskCompletion.result_id)?.content;
    assert.equal(typeof exactSourceResultContent, 'string');
  } finally { sourceResultBeforeAck.close(); }
  fs.writeFileSync(ackArmPath, 'arm exact CASE-01 acknowledgement race fixture\n', { flag: 'wx', mode: 0o600 });
  const pendingCase01Terminal = tool('workflow_complete_synthesis', { ...case01SynthesisArgs, consumed_workspace_bytes: case01ConsumedBytes });
  const ackBarrierDeadline = Date.now() + 10000;
  while (!fs.existsSync(ackReadyPath)) {
    if (Date.now() > ackBarrierDeadline) throw new Error('CASE-01 acknowledgement lineage hook did not reach its deterministic barrier');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  const concurrentResultWriter = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  let preLockMutationError = null;
  try {
    try {
      const mutation = concurrentResultWriter.prepare('UPDATE results SET content=? WHERE result_id=?')
        .run(`${exactSourceResultContent}\ninterleaved-after-lineage-read`, case01TaskCompletion.result_id);
      assert.equal(mutation.changes, 1);
    } catch (error) { preLockMutationError = error; }
  } finally { concurrentResultWriter.close(); }
  fs.writeFileSync(ackReleasePath, 'release ack writer\n', { flag: 'wx', mode: 0o600 });
  const case01Terminal = await pendingCase01Terminal;
  assert.equal(case01Terminal.terminalized, true);
  assert.ok(preLockMutationError, 'the writer reservation must block a concurrent source-result mutation while acknowledgement lineage is being persisted');
  assert.match(`${preLockMutationError.code || ''} ${preLockMutationError.message || preLockMutationError}`, /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i);
  const lockedReadback = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  try {
    assert.equal(lockedReadback.prepare('SELECT content FROM results WHERE result_id=?').get(case01TaskCompletion.result_id).content,
      exactSourceResultContent, 'rejected concurrent writer must not mutate acknowledged result bytes');
  } finally { lockedReadback.close(); }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS', 'writer-serialized acknowledgement must recover with exact result bytes');
  console.log('CASE-01 acknowledgement writer-reservation race rejection: PASS');
  const case01Trace = await tool('workflow_get', { job_id: case01Run.job_id });
  assert.equal(case01Trace.job.status, 'completed');
  const ctoArtifact = (await tool('workflow_artifacts', { job_id: case01Run.job_id })).artifacts.find(item => item.type === 'cto-decision' && item.status === 'active');
  assert.ok(ctoArtifact);
  assert.deepEqual(ctoArtifact.evidence, [case01Terminal.synthesis_result_id], 'CTO artifact must reference its exact durable synthesis result');
  const ctoContent = JSON.parse(ctoArtifact.content);
  assert.equal(ctoContent.workspace_snapshot_id, taskContent.workspace_snapshot_id);
  assert.deepEqual(ctoContent.workspace_artifacts, taskContent.workspace_artifacts);
  const consumptionDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  try {
    const consumptionAck = consumptionDb.prepare('SELECT * FROM case01_consumption_acks WHERE job_id=?').get(case01Run.job_id);
    assert.ok(consumptionAck, 'successful synthesis must durably acknowledge the exact bytes supplied by its consumer');
    assert.equal(consumptionAck.snapshot_id, taskContent.workspace_snapshot_id);
    assert.equal(consumptionAck.source_result_id, case01TaskCompletion.result_id);
    assert.equal(consumptionAck.cto_result_id, case01Terminal.synthesis_result_id);
    assert.equal(consumptionAck.verified_manifest_sha256, consumptionAck.consumed_manifest_sha256,
      'verified and consumer-submitted byte manifests must have identical digests');
    const consumptionLineage = JSON.parse(consumptionAck.lineage_json);
    assert.equal(consumptionLineage.source_artifact_id, taskArtifact.artifact_id);
    assert.equal(consumptionLineage.cto_artifact_id, ctoArtifact.artifact_id);
    assert.ok(consumptionLineage.source_attempt_id && consumptionLineage.cto_attempt_id);
    assert.ok(consumptionLineage.source_completion_event_id && consumptionLineage.cto_completion_event_id);
  } finally { consumptionDb.close(); }
  const case01Events = await tool('workflow_events', { job_id: case01Run.job_id, limit: 200 });
  assert.ok(case01Events.events.some(event => event.type === 'task.local_completed'));
  assert.ok(case01Events.events.some(event => event.type === 'artifact.created'));
  assert.ok(case01Events.events.some(event => event.type === 'case01.snapshot_consumption_acknowledged'));
  assert.ok(case01Events.events.some(event => event.type === 'job.completed' || event.type === 'workflow.completed'));
  const case01Recovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
  assert.equal(case01Recovery.status, 'PASS', JSON.stringify(case01Recovery.checks));
  assert.deepEqual(taskContent.workspace_artifacts.map(item => ({ path: item.path, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(finalizedSnapshotRoot, item.path))).digest('hex') })), taskContent.workspace_artifacts,
    'snapshot bytes and persisted hashes must still reconcile after fresh-process recovery verification');

  // Bind the acknowledgement to exact UTF-8 bytes in both successful result
  // rows; matching identities/events alone must not hide post-ack substitution.
  for (const resultIdentity of [
    { label: 'source', resultId: case01TaskCompletion.result_id },
    { label: 'CTO', resultId: case01Terminal.synthesis_result_id }
  ]) {
    const resultTamperDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    let originalResult;
    try {
      originalResult = resultTamperDb.prepare('SELECT result_id,task_id,outcome,content FROM results WHERE result_id=?').get(resultIdentity.resultId);
      assert.ok(originalResult, `${resultIdentity.label} result must exist before content-tamper fixture`);
      resultTamperDb.prepare('UPDATE results SET content=? WHERE result_id=?').run(`${originalResult.content}\npost-ack-substitution`, resultIdentity.resultId);
    } finally { resultTamperDb.close(); }
    try {
      const tamperedResultRecovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
      assert.equal(tamperedResultRecovery.status, 'NEEDS_ATTENTION', `${resultIdentity.label} result byte substitution after ack must fail closed`);
      assert.equal(tamperedResultRecovery.checks.find(check => check.name === 'case01_durable_consumption_ack_binds_actual_bytes_and_full_lineage')?.pass, false,
        `${resultIdentity.label} result byte substitution must fail the exact consumption lineage check`);
    } finally {
      const restoreResultDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
      try { restoreResultDb.prepare('UPDATE results SET content=? WHERE result_id=?').run(originalResult.content, resultIdentity.resultId); }
      finally { restoreResultDb.close(); }
    }
    assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS',
      `restoring exact ${resultIdentity.label} result bytes must restore recovery PASS`);
  }
  console.log('CASE-01 acknowledgement actual result-byte binding regression: PASS');

  // Semantic JSON.parse equality is insufficient for durable authority rows:
  // duplicate decoded keys can preserve the last-wins object while changing
  // the exact serialized evidence. Both row and event must remain canonical.
  const duplicateLineageDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  let canonicalLineageJson;
  try {
    const ackRow = duplicateLineageDb.prepare('SELECT lineage_json FROM case01_consumption_acks WHERE job_id=?').get(case01Run.job_id);
    assert.ok(ackRow);
    canonicalLineageJson = ackRow.lineage_json;
    const duplicateKeyLineage = canonicalLineageJson.replace('"source_task_id":', '"source_task_id":"detached-first-value","source_task_id":');
    assert.notEqual(duplicateKeyLineage, canonicalLineageJson);
    assert.deepEqual(JSON.parse(duplicateKeyLineage), JSON.parse(canonicalLineageJson), 'duplicate key fixture must parse to the same last-wins value');
    duplicateLineageDb.prepare('UPDATE case01_consumption_acks SET lineage_json=? WHERE job_id=?').run(duplicateKeyLineage, case01Run.job_id);
  } finally { duplicateLineageDb.close(); }
  try {
    const duplicateLineageRecovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(duplicateLineageRecovery.status, 'NEEDS_ATTENTION', 'recovery must reject duplicate decoded keys in acknowledgement row JSON');
    assert.equal(duplicateLineageRecovery.checks.find(check => check.name === 'case01_durable_consumption_ack_binds_actual_bytes_and_full_lineage')?.pass, false);
  } finally {
    const restoreLineageDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    try { restoreLineageDb.prepare('UPDATE case01_consumption_acks SET lineage_json=? WHERE job_id=?').run(canonicalLineageJson, case01Run.job_id); }
    finally { restoreLineageDb.close(); }
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS', 'restoring canonical acknowledgement row JSON must restore recovery');

  const duplicateEventDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  let canonicalAckEvent;
  try {
    canonicalAckEvent = duplicateEventDb.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='case01.snapshot_consumption_acknowledged'").get(case01Run.job_id);
    assert.ok(canonicalAckEvent);
    const duplicateKeyPayload = canonicalAckEvent.payload_json.replace('"source_task_id":', '"source_task_id":"detached-first-value","source_task_id":');
    assert.notEqual(duplicateKeyPayload, canonicalAckEvent.payload_json);
    assert.deepEqual(JSON.parse(duplicateKeyPayload), JSON.parse(canonicalAckEvent.payload_json), 'duplicate event key fixture must parse to the same last-wins value');
    duplicateEventDb.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(duplicateKeyPayload, canonicalAckEvent.event_id);
  } finally { duplicateEventDb.close(); }
  try {
    const duplicateEventRecovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(duplicateEventRecovery.status, 'NEEDS_ATTENTION', 'recovery must reject duplicate decoded keys in acknowledgement event JSON');
    assert.equal(duplicateEventRecovery.checks.find(check => check.name === 'case01_durable_consumption_ack_binds_actual_bytes_and_full_lineage')?.pass, false);
  } finally {
    const restoreDuplicateEventDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    try { restoreDuplicateEventDb.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonicalAckEvent.payload_json, canonicalAckEvent.event_id); }
    finally { restoreDuplicateEventDb.close(); }
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS', 'restoring canonical acknowledgement event JSON must restore recovery');
  console.log('CASE-01 duplicate-decoded-key acknowledgement row/event rejection: PASS');

  // Recovery independently re-hashes snapshot bytes and checks the durable
  // consumption acknowledgement. Restore the exact original row even if an
  // assertion fails; this database belongs only to this isolated fixture.
  const ackTamperDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  const originalAckDigest = ackTamperDb.prepare('SELECT consumed_manifest_sha256 FROM case01_consumption_acks WHERE job_id=?').get(case01Run.job_id).consumed_manifest_sha256;
  try {
    ackTamperDb.prepare('UPDATE case01_consumption_acks SET consumed_manifest_sha256=? WHERE job_id=?').run('0'.repeat(64), case01Run.job_id);
    const ackTamperedRecovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(ackTamperedRecovery.status, 'NEEDS_ATTENTION', 'recovery must reject a self-consistent workflow with a corrupted consumption digest');
    assert.equal(ackTamperedRecovery.checks.find(check => check.name === 'case01_durable_consumption_ack_binds_actual_bytes_and_full_lineage')?.pass, false);
  } finally {
    ackTamperDb.prepare('UPDATE case01_consumption_acks SET consumed_manifest_sha256=? WHERE job_id=?').run(originalAckDigest, case01Run.job_id);
    ackTamperDb.close();
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS', 'restored consumption acknowledgement must recover cleanly');

  // The acknowledgement trace is itself part of the durable trust chain. A
  // row with the right digest but altered attempt/artifact-event lineage, or an
  // additional logical acknowledgement under another event ID, must not pass.
  const ackEventDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  let originalAckEvent;
  try {
    originalAckEvent = ackEventDb.prepare("SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type='case01.snapshot_consumption_acknowledged'").get(case01Run.job_id);
    assert.ok(originalAckEvent);
    const corruptPayload = { ...JSON.parse(originalAckEvent.payload_json), cto_attempt_id: 'detached-attempt-id' };
    ackEventDb.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(corruptPayload), originalAckEvent.event_id);
  } finally { ackEventDb.close(); }
  try {
    const detachedAckEvent = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(detachedAckEvent.status, 'NEEDS_ATTENTION', 'recovery must reject acknowledgement-event lineage detached from the durable attempt');
    assert.equal(detachedAckEvent.checks.find(check => check.name === 'case01_durable_consumption_ack_binds_actual_bytes_and_full_lineage')?.pass, false);
  } finally {
    const restoreAckEventDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    try { restoreAckEventDb.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(originalAckEvent.payload_json, originalAckEvent.event_id); }
    finally { restoreAckEventDb.close(); }
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS', 'restoring exact acknowledgement event payload must restore recovery');

  const duplicateAckEventId = `duplicate-case01-ack-${case01Run.job_id}`;
  const duplicateAckDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  try {
    assert.equal(duplicateAckDb.prepare('SELECT COUNT(*) AS n FROM events WHERE event_id=?').get(duplicateAckEventId).n, 0,
      'duplicate acknowledgement event fixture ID must be unused');
    duplicateAckDb.prepare('INSERT INTO events(event_id, job_id, type, payload_json, created_at) VALUES(?,?,?,?,?)')
      .run(duplicateAckEventId, originalAckEvent.job_id, originalAckEvent.type, originalAckEvent.payload_json, originalAckEvent.created_at);
  } finally { duplicateAckDb.close(); }
  try {
    const duplicateAckRecovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(duplicateAckRecovery.status, 'NEEDS_ATTENTION', 'recovery must reject duplicate logical consumption acknowledgement events');
    assert.equal(duplicateAckRecovery.checks.find(check => check.name === 'case01_durable_consumption_ack_binds_actual_bytes_and_full_lineage')?.pass, false);
  } finally {
    const restoreDuplicateAckDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    try { restoreDuplicateAckDb.prepare('DELETE FROM events WHERE event_id=?').run(duplicateAckEventId); }
    finally { restoreDuplicateAckDb.close(); }
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS', 'removing duplicate acknowledgement fixture must restore recovery');

  // The recovery tool itself must fail closed if a durable snapshot is tampered
  // after terminal success; generic SQLite row consistency alone is not enough.
  const recoveryTamperPath = path.join(finalizedSnapshotRoot, 'config.json');
  const recoveryOriginalBytes = fs.readFileSync(recoveryTamperPath);
  try {
    fs.chmodSync(recoveryTamperPath, 0o600);
    fs.writeFileSync(recoveryTamperPath, '{"tampered_after_terminal_success":true}');
    fs.chmodSync(recoveryTamperPath, 0o400);
    const tamperedRecovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(tamperedRecovery.status, 'NEEDS_ATTENTION', 'recovery must not report PASS when authoritative snapshot bytes no longer match persisted SHA-256');
    assert.equal(tamperedRecovery.checks.find(check => check.name === 'case01_snapshot_bytes_match_persisted_sha256')?.pass, false);
  } finally {
    fs.chmodSync(recoveryTamperPath, 0o600);
    fs.writeFileSync(recoveryTamperPath, recoveryOriginalBytes);
    fs.chmodSync(recoveryTamperPath, 0o400);
  }
  const restoredRecovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
  assert.equal(restoredRecovery.status, 'PASS', JSON.stringify(restoredRecovery.checks));
  await testCase01ConsumptionAckSigkillRecovery('after-ack');
  await testCase01ConsumptionAckSigkillRecovery('before-ack');

  // A trace with the right event *types* but the wrong lineage must not pass.
  // Mutate one event at a time through a second SQLite connection, verify the
  // actual recovery consumer rejects it, then restore the exact original bytes.
  const mutateAndCheckTraceEvent = async (type, dedupeKey, corruptPayload) => {
    const eventId = crypto.createHash('sha256').update(`${case01Run.job_id}|${type}|${dedupeKey}`).digest('hex');
    const eventDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    let originalPayload;
    try {
      const row = eventDb.prepare('SELECT payload_json FROM events WHERE event_id=? AND job_id=? AND type=?').get(eventId, case01Run.job_id, type);
      assert.ok(row, `expected durable ${type} event for trace tamper fixture`);
      originalPayload = row.payload_json;
      eventDb.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(corruptPayload(JSON.parse(originalPayload))), eventId);
    } finally { eventDb.close(); }
    try {
      const corrupted = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
      assert.equal(corrupted.status, 'NEEDS_ATTENTION', `${type} payload conflict must fail closed`);
      assert.equal(corrupted.checks.find(check => check.name === 'case01_trace_contains_completion_artifact_and_terminal_events')?.pass, false,
        `${type} payload conflict must fail the exact trace-lineage check`);
    } finally {
      const restoreDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
      try { restoreDb.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(originalPayload, eventId); }
      finally { restoreDb.close(); }
    }
    assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS',
      `restoring exact ${type} payload should restore trace verification`);
  };
  await mutateAndCheckTraceEvent('task.local_completed', case01TaskCompletion.result_id,
    payload => ({ ...payload, resultId: 'conflicting-result-id' }));
  await mutateAndCheckTraceEvent('artifact.created', taskArtifact.artifact_id,
    payload => ({ ...payload, taskId: 'conflicting-task-id' }));
  await mutateAndCheckTraceEvent('artifact.created', ctoArtifact.artifact_id,
    payload => ({ ...payload, type: 'requirements' }));
  await mutateAndCheckTraceEvent('task.local_completed', case01Terminal.synthesis_result_id,
    payload => ({ ...payload, resultId: 'conflicting-synthesis-result-id' }));
  await mutateAndCheckTraceEvent('job.completed', `${case01Terminal.report_id}|terminal|success`,
    payload => ({ ...payload, reportId: 'conflicting-report-id' }));
  const case01DeliveryKey = crypto.createHash('sha256').update(`${case01Terminal.report_id}|chat-on-steroids-plugin|local`).digest('hex');
  await mutateAndCheckTraceEvent('delivery.claimed', case01DeliveryKey,
    payload => ({ ...payload, target: 'unapproved-remote-destination' }));

  // Duplicate decoded keys can be semantically invisible to JSON.parse. The
  // actual recovery consumer must reject canonical-byte substitution for each
  // downstream ledger edge, even when both decoded values are identical.
  const mutateWithDuplicateDecodedKey = async (type, dedupeKey, key) => {
    const expectedId = crypto.createHash('sha256').update(`${case01Run.job_id}|${type}|${dedupeKey}`).digest('hex');
    const eventDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    let originalPayload;
    try {
      const row = eventDb.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(expectedId);
      assert.ok(row, `canonical ${type} event must exist for duplicate-key fixture`);
      assert.equal(row.job_id, case01Run.job_id);
      assert.equal(row.type, type);
      originalPayload = row.payload_json;
      const parsed = JSON.parse(originalPayload);
      const value = JSON.stringify(parsed[key]);
      const exactMember = `${JSON.stringify(key)}:${value}`;
      assert.ok(originalPayload.includes(exactMember), `${type} fixture must contain the expected canonical ${key} member`);
      const duplicatePayload = originalPayload.replace(exactMember, `${exactMember},${exactMember}`);
      assert.notEqual(duplicatePayload, originalPayload);
      assert.deepEqual(JSON.parse(duplicatePayload), parsed,
        `${type} duplicate-key fixture should preserve the identical last-wins parsed value`);
      eventDb.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(duplicatePayload, expectedId);
    } finally { eventDb.close(); }
    try {
      const corrupted = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
      assert.equal(corrupted.status, 'NEEDS_ATTENTION', `${type} duplicate decoded key must fail recovery`);
      assert.equal(corrupted.checks.find(check => check.name === 'case01_trace_contains_completion_artifact_and_terminal_events')?.pass, false,
        `${type} duplicate decoded key must fail CASE-01 trace-lineage validation`);
      if (['report.created','delivery.claimed','job.completed'].includes(type)) {
        assert.equal(corrupted.checks.find(check => check.name === 'completed_cto_has_durable_delivery_and_terminal_event')?.pass, false,
          `${type} duplicate decoded key must fail generic terminal report/delivery validation`);
      }
    } finally {
      const restoreDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
      try { restoreDb.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(originalPayload, expectedId); }
      finally { restoreDb.close(); }
    }
    assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS',
      `restoring canonical ${type} event bytes must restore recovery`);
  };
  await mutateWithDuplicateDecodedKey('task.local_completed', case01TaskCompletion.result_id, 'resultId');
  await mutateWithDuplicateDecodedKey('artifact.created', ctoArtifact.artifact_id, 'contentHash');
  await mutateWithDuplicateDecodedKey('report.created', case01Terminal.report_id, 'reportId');
  await mutateWithDuplicateDecodedKey('delivery.claimed', case01DeliveryKey, 'channel');
  await mutateWithDuplicateDecodedKey('job.completed', `${case01Terminal.report_id}|terminal|success`, 'reportId');
  console.log('CASE-01 terminal/report/delivery recovery duplicate-decoded-key rejection: PASS');

  // The expected deterministic event ID is not sufficient if a second row
  // carries the same logical transition under another primary key. Exercise
  // the actual recovery consumer against duplicate durable completion rows.
  const duplicateSourceEventId = crypto.createHash('sha256').update(`${case01Run.job_id}|task.local_completed|${case01TaskCompletion.result_id}`).digest('hex');
  const duplicateEventId = `duplicate-case01-completion-${case01Run.job_id}`;
  const duplicateDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  let duplicateSourceEvent;
  try {
    duplicateSourceEvent = duplicateDb.prepare('SELECT job_id, type, payload_json, created_at FROM events WHERE event_id=?').get(duplicateSourceEventId);
    assert.ok(duplicateSourceEvent, 'completion event fixture must exist before duplicate insertion');
    assert.equal(duplicateDb.prepare('SELECT COUNT(*) AS n FROM events WHERE event_id=?').get(duplicateEventId).n, 0,
      'duplicate-event fixture ID must be unused');
    duplicateDb.prepare('INSERT INTO events(event_id, job_id, type, payload_json, created_at) VALUES(?,?,?,?,?)')
      .run(duplicateEventId, duplicateSourceEvent.job_id, duplicateSourceEvent.type, duplicateSourceEvent.payload_json, duplicateSourceEvent.created_at);
  } finally { duplicateDb.close(); }
  try {
    const duplicateRecovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(duplicateRecovery.status, 'NEEDS_ATTENTION', 'duplicate logical completion event must fail closed even when the deterministic event remains intact');
    assert.equal(duplicateRecovery.checks.find(check => check.name === 'case01_trace_contains_completion_artifact_and_terminal_events')?.pass, false);
  } finally {
    const restoreDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    try { restoreDb.prepare('DELETE FROM events WHERE event_id=?').run(duplicateEventId); }
    finally { restoreDb.close(); }
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS',
    'removing the isolated duplicate fixture must restore trace verification');

  const malformedDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  try {
    malformedDb.prepare('INSERT INTO events(event_id, job_id, type, payload_json, created_at) VALUES(?,?,?,?,?)')
      .run(duplicateEventId, case01Run.job_id, 'task.local_completed', '{malformed-json', duplicateSourceEvent.created_at);
  } finally { malformedDb.close(); }
  try {
    const malformedRecovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(malformedRecovery.status, 'NEEDS_ATTENTION', 'malformed relevant transition event must not be ignored during recovery');
    assert.equal(malformedRecovery.checks.find(check => check.name === 'case01_trace_contains_completion_artifact_and_terminal_events')?.pass, false);
  } finally {
    const restoreDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    try { restoreDb.prepare('DELETE FROM events WHERE event_id=?').run(duplicateEventId); }
    finally { restoreDb.close(); }
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS',
    'removing the isolated malformed fixture must restore trace verification');

  // The final report is downstream consumption of the synthesis result. A
  // self-consistent terminal event must not hide report-content substitution.
  const reportDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  let originalReportContent;
  try {
    originalReportContent = reportDb.prepare('SELECT content FROM reports WHERE report_id=? AND job_id=?').get(case01Terminal.report_id, case01Run.job_id)?.content;
    assert.equal(typeof originalReportContent, 'string');
    reportDb.prepare('UPDATE reports SET content=? WHERE report_id=? AND job_id=?').run('substituted downstream report content', case01Terminal.report_id, case01Run.job_id);
  } finally { reportDb.close(); }
  try {
    const corruptedReport = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(corruptedReport.status, 'NEEDS_ATTENTION', 'recovery must reject a final report whose content differs from the exact synthesis result');
    assert.equal(corruptedReport.checks.find(check => check.name === 'case01_trace_contains_completion_artifact_and_terminal_events')?.pass, false);
  } finally {
    const restoreDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    try { restoreDb.prepare('UPDATE reports SET content=? WHERE report_id=? AND job_id=?').run(originalReportContent, case01Terminal.report_id, case01Run.job_id); }
    finally { restoreDb.close(); }
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS', 'restoring exact final report content must restore trace verification');

  // Timestamp order is part of the durable trace contract, not merely event
  // presence. Shift the child completion after synthesis and require rejection.
  const childCompletionEventId = crypto.createHash('sha256').update(`${case01Run.job_id}|task.local_completed|${case01TaskCompletion.result_id}`).digest('hex');
  const orderDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  let originalCompletionTimestamp;
  try {
    originalCompletionTimestamp = orderDb.prepare('SELECT created_at FROM events WHERE event_id=?').get(childCompletionEventId)?.created_at;
    assert.equal(typeof originalCompletionTimestamp, 'string');
    orderDb.prepare('UPDATE events SET created_at=? WHERE event_id=?').run('2999-01-01T00:00:00.000Z', childCompletionEventId);
  } finally { orderDb.close(); }
  try {
    const reorderedTrace = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(reorderedTrace.status, 'NEEDS_ATTENTION', 'recovery must reject timestamps that contradict child-before-synthesis ordering');
  } finally {
    const restoreDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    try { restoreDb.prepare('UPDATE events SET created_at=? WHERE event_id=?').run(originalCompletionTimestamp, childCompletionEventId); }
    finally { restoreDb.close(); }
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS', 'restoring exact event timestamp must restore trace verification');
  console.log('CASE-01 trace integrity regression: PASS (child + CTO completion, typed artifact events, ordered timestamps, exact downstream report content, delivery claim, and terminal event are cross-bound)');

  // Missing finalized bytes are a distinct crash/recovery failure mode from
  // byte tampering: the durable identity must not degrade to workspace reads.
  const temporarilyMissingSnapshotRoot = `${finalizedSnapshotRoot}.temporarily-missing`;
  fs.renameSync(finalizedSnapshotRoot, temporarilyMissingSnapshotRoot);
  try {
    const missingSnapshotRecovery = await tool('workflow_recovery_verify', { job_id: case01Run.job_id });
    assert.equal(missingSnapshotRecovery.status, 'NEEDS_ATTENTION', 'recovery must fail closed when the referenced snapshot directory is missing');
    assert.equal(missingSnapshotRecovery.checks.find(check => check.name === 'case01_snapshot_bytes_match_persisted_sha256')?.pass, false,
      'missing snapshot bytes must fail the exact-byte recovery check');
  } finally {
    fs.renameSync(temporarilyMissingSnapshotRoot, finalizedSnapshotRoot);
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: case01Run.job_id })).status, 'PASS', 'restoring exact snapshot bytes must restore recovery PASS');

  // Simulate the crash window after snapshot directory creation but before
  // artifact/SQLite commit: durable reservation exists, owner PID is gone, and
  // the next process must collect the orphan while preserving referenced bytes.
  const orphanSnapshotId = crypto.randomUUID();
  const orphanSnapshotRoot = path.join(dataDir, 'case01-snapshots', orphanSnapshotId);
  fs.mkdirSync(orphanSnapshotRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(orphanSnapshotRoot, 'partial.tmp'), 'interrupted snapshot creation');
  let deadPid = 5_000_000;
  while (deadPid < 5_001_000) {
    try { process.kill(deadPid, 0); deadPid += 1; }
    catch (error) { if (error?.code === 'ESRCH') break; deadPid += 1; }
  }
  assert.ok(deadPid < 5_001_000, 'fixture must find a non-existent owner PID');
  const reservationDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  try {
    reservationDb.prepare('INSERT INTO case01_snapshot_reservations(snapshot_id, owner_pid, created_at) VALUES(?, ?, ?)')
      .run(orphanSnapshotId, deadPid, new Date(Date.now() - 120_000).toISOString());
    reservationDb.prepare('INSERT INTO case01_snapshot_reservations(snapshot_id, owner_pid, created_at) VALUES(?, ?, ?)')
      .run(taskContent.workspace_snapshot_id, deadPid, new Date(Date.now() - 120_000).toISOString());
  } finally { reservationDb.close(); }
  const restarted = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000,
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'snapshot-recovery-test', version: '1' } } })}\n`
  });
  assert.equal(restarted.status, 0, `restart recovery process should exit cleanly: ${restarted.stderr}`);
  assert.match(restarted.stdout, /"serverInfo"/);
  assert.equal(fs.existsSync(orphanSnapshotRoot), false, 'restart reconciliation must remove a partial orphan snapshot');
  assert.equal(fs.existsSync(finalizedSnapshotRoot), true, 'restart reconciliation must preserve snapshot bytes referenced by a durable artifact');
  const postRestartDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  try {
    assert.equal(postRestartDb.prepare('SELECT COUNT(*) AS count FROM case01_snapshot_reservations WHERE snapshot_id=?').get(orphanSnapshotId).count, 0,
      'stale orphan reservation must be retired after cleanup');
    assert.equal(postRestartDb.prepare('SELECT COUNT(*) AS count FROM case01_snapshot_reservations WHERE snapshot_id=?').get(taskContent.workspace_snapshot_id).count, 0);
  } finally { postRestartDb.close(); }
  assert.deepEqual(taskContent.workspace_artifacts.map(item => ({ path: item.path, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(finalizedSnapshotRoot, item.path))).digest('hex') })), taskContent.workspace_artifacts,
    'restart recovery must preserve exact referenced snapshot bytes and SHA-256');
  console.log('CASE-01 crash/restart reconciliation: PASS (orphan reservation collected; durable referenced snapshot retained and rehashed)');
  console.log('CASE-01 MCP snapshot-lineage E2E: PASS (task result → typed artifact → CTO synthesis → durable trace, exact snapshot identity and SHA-256; late workspace writer isolated)');

  const created = await tool('workflow_create', { title: 'plugin e2e', task: 'Verify the local-only plugin workflow', workflow: 'standard-engineering', workspace });
  assert.equal(created.created, true);
  assert.equal(created.requires_explicit_approval, true);
  assert.equal(created.workspace, workspace);

  const preapprovalDispatch = await rpc('tools/call', { name: 'workflow_dispatch', arguments: { job_id: created.job_id } });
  assert.equal(preapprovalDispatch.result.isError, true);
  assert.match(preapprovalDispatch.result.content[0].text, /approval is not current/i);

  const approved = await tool('workflow_approve', { job_id: created.job_id, confirmation: 'I explicitly approve local execution for this workspace.' });
  assert.equal(approved.state, 'APPROVED');
  assert.equal(approved.plan.workflow_id, 'standard-engineering');
  assert.equal(approved.plan.children.length, 9);
  assert.ok(approved.plan.children.every(item => !String(item.execution.runtime_owner || '').includes('github')));

  const dispatched = await tool('workflow_dispatch', { job_id: created.job_id });
  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.target, 'local');
  assert.equal(dispatched.task.openclaw_session_key, undefined);
  const prematureSynthesis = await rpc('tools/call', { name: 'workflow_complete_synthesis', arguments: { job_id: created.job_id, content: 'Must not complete before specialist work.', artifact: artifactFor('cto') } });
  assert.equal(prematureSynthesis.result.isError, true);
  assert.match(prematureSynthesis.result.content[0].text, /cannot synthesize before every planned child task exists/i);
  const prepared = await tool('workflow_prepare_tasks', { job_id: created.job_id });
  assert.equal(prepared.count, 9);
  assert.equal(new Set(prepared.tasks.map(item => item.description)).size, 9, 'each specialist must receive a distinct role contract');
  assert.match(prepared.tasks.find(item => item.role === 'security').description, /security\.audit/);
  assert.match(prepared.tasks.find(item => item.role === 'reviewer').description, /all_required_evidence_reconciled/);

  const completedRoles = [];
  for (let index = 0; index < 9; index += 1) {
    const next = await tool('workflow_next_task', { job_id: created.job_id });
    assert.equal(next.stage, 'task');
    assert.ok(next.task.task_id);
    assert.ok(Array.isArray(next.completed_results));
    if (index > 0) {
      assert.ok(next.completed_results.length > 0);
      assert.ok(next.completed_results.some(item => Array.isArray(item.artifacts) && item.artifacts.length > 0), 'dependent tasks must receive predecessor typed artifact evidence');
    }
    if (index === 0) {
      const missingArtifact = await rpc('tools/call', { name: 'workflow_complete_task', arguments: { task_id: next.task.task_id, content: 'This result has no typed artifact.' } });
      assert.equal(missingArtifact.result.isError, true);
      assert.match(missingArtifact.result.content[0].text, /artifact is required/i);
      const malformedArtifact = await rpc('tools/call', { name: 'workflow_complete_task', arguments: {
        task_id: next.task.task_id, content: 'This result has an empty artifact.', artifact: {}
      } });
      assert.equal(malformedArtifact.result.isError, true);
      assert.match(malformedArtifact.result.content[0].text, /artifact content missing scope/i,
        'schema-valid artifact objects must still pass the deeper typed-artifact semantic validator');
    }
    const result = await tool('workflow_complete_task', {
      task_id: next.task.task_id,
      content: `Actual local host reasoning result for ${next.task.role}: inspected the assigned scope and recorded the outcome.`,
      artifact: artifactFor(next.task.role)
    });
    assert.equal(result.completed, true);
    completedRoles.push(next.task.role);
  }
  assert.equal(new Set(completedRoles).size, 9);
  assert.deepEqual(completedRoles.slice(0, 3), ['product-owner', 'researcher', 'architect']);

  const synthesisReady = await tool('workflow_next_task', { job_id: created.job_id });
  assert.equal(synthesisReady.stage, 'synthesis');
  assert.equal(synthesisReady.completed_results.length, 9);

  // Fault-inject a durable report write failure after the CTO result/artifact
  // commits. The Job must stay EXECUTING, and replay must finish without
  // duplicating the already-durable synthesis result or artifact.
  const testDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  testDb.exec(`CREATE TRIGGER fail_synthesis_report_insert BEFORE INSERT ON reports
    WHEN NEW.job_id = '${created.job_id}' AND NEW.kind = 'final'
    BEGIN SELECT RAISE(ABORT, 'injected synthesis report failure'); END;`);
  const synthesisArgs = { job_id: created.job_id, content: 'Synthesis with all nine child results reconciled.', artifact: artifactFor('cto') };
  const injectedFailure = await rpc('tools/call', { name: 'workflow_complete_synthesis', arguments: synthesisArgs });
  assert.equal(injectedFailure.result.isError, true, 'injected report failure must be surfaced');
  assert.match(injectedFailure.result.content[0].text, /injected synthesis report failure/i);
  const afterFailure = testDb.prepare('SELECT state, status FROM jobs WHERE job_id=?').get(created.job_id);
  assert.equal(afterFailure.state, 'EXECUTING', 'report failure must not terminalize the Job');
  assert.equal(testDb.prepare("SELECT COUNT(*) AS n FROM results r JOIN tasks t ON t.task_id=r.task_id WHERE t.job_id=? AND t.role='cto' AND r.outcome='success'").get(created.job_id).n, 1);
  assert.equal(testDb.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=? AND kind='cto-decision'").get(created.job_id).n, 1);
  assert.equal(testDb.prepare("SELECT COUNT(*) AS n FROM reports WHERE job_id=? AND kind='final'").get(created.job_id).n, 0);
  const incompleteSynthesisRecovery = await tool('workflow_recovery_verify', { job_id: created.job_id });
  assert.equal(incompleteSynthesisRecovery.status, 'NEEDS_ATTENTION',
    'durable CTO synthesis without its final report must not be reported as recovered PASS');
  assert.equal(incompleteSynthesisRecovery.checks.find(check => check.name === 'completed_cto_has_terminal_report')?.pass, false);
  // Open a separate real MCP server process against the same isolated SQLite
  // database. Startup/recovery must preserve the incomplete durable state and
  // the independent consumer must still refuse to call it recovered.
  const restartedRecovery = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000,
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 701, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthesis-crash-recovery-test', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 702, method: 'tools/call', params: { name: 'workflow_recovery_verify', arguments: { job_id: created.job_id } } })
    ].join('\n') + '\n'
  });
  assert.equal(restartedRecovery.status, 0, 'fresh recovery process must exit cleanly: ' + restartedRecovery.stderr);
  const restartedMessages = restartedRecovery.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const restartedResult = restartedMessages.find(message => message.id === 702)?.result?.structuredContent;
  assert.equal(restartedResult?.status, 'NEEDS_ATTENTION', 'fresh process must detect incomplete CTO-to-report transition');
  assert.equal(restartedResult?.checks.find(check => check.name === 'completed_cto_has_terminal_report')?.pass, false);
  testDb.exec('DROP TRIGGER fail_synthesis_report_insert');
  testDb.exec(`CREATE TRIGGER fail_synthesis_delivery BEFORE INSERT ON events
    WHEN NEW.job_id = '${created.job_id}' AND NEW.type = 'delivery.claimed'
    BEGIN SELECT RAISE(ABORT, 'injected synthesis delivery failure'); END;`);
  const deliveryFailure = await rpc('tools/call', { name: 'workflow_complete_synthesis', arguments: synthesisArgs });
  assert.equal(deliveryFailure.result.isError, true, 'injected delivery failure must be surfaced');
  assert.match(deliveryFailure.result.content[0].text, /injected synthesis delivery failure/i);
  assert.equal(testDb.prepare('SELECT state FROM jobs WHERE job_id=?').get(created.job_id).state, 'EXECUTING');
  assert.equal(testDb.prepare("SELECT COUNT(*) AS n FROM reports WHERE job_id=? AND kind='final'").get(created.job_id).n, 1, 'report should survive a later delivery failure');
  assert.equal(testDb.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='delivery.claimed'").get(created.job_id).n, 0);
  testDb.exec('DROP TRIGGER fail_synthesis_delivery');
  testDb.exec(`CREATE TRIGGER fail_synthesis_terminalization BEFORE UPDATE OF state ON jobs
    WHEN NEW.job_id = '${created.job_id}' AND NEW.state = 'COMPLETED'
    BEGIN SELECT RAISE(ABORT, 'injected synthesis terminalization failure'); END;`);
  const terminalizationFailure = await rpc('tools/call', { name: 'workflow_complete_synthesis', arguments: synthesisArgs });
  assert.equal(terminalizationFailure.result.isError, true, 'injected terminalization failure must be surfaced');
  assert.match(terminalizationFailure.result.content[0].text, /injected synthesis terminalization failure/i);
  assert.equal(testDb.prepare('SELECT state FROM jobs WHERE job_id=?').get(created.job_id).state, 'EXECUTING');
  assert.equal(testDb.prepare("SELECT COUNT(*) AS n FROM events WHERE job_id=? AND type='delivery.claimed'").get(created.job_id).n, 1, 'delivery claim should survive a later terminalization failure');
  testDb.exec('DROP TRIGGER fail_synthesis_terminalization');
  const recoveredSynthesis = await rpc('tools/call', { name: 'workflow_complete_synthesis', arguments: synthesisArgs });
  assert.equal(recoveredSynthesis.result.isError, false, recoveredSynthesis.result.content?.[0]?.text);
  assert.equal(recoveredSynthesis.result.structuredContent.terminalized, true);
  assert.equal(testDb.prepare("SELECT COUNT(*) AS n FROM results r JOIN tasks t ON t.task_id=r.task_id WHERE t.job_id=? AND t.role='cto' AND r.outcome='success'").get(created.job_id).n, 1, 'retry must not duplicate the CTO result');
  assert.equal(testDb.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE job_id=? AND kind='cto-decision'").get(created.job_id).n, 1, 'retry must not duplicate the CTO artifact');
  assert.equal(testDb.prepare("SELECT COUNT(*) AS n FROM reports WHERE job_id=? AND kind='final'").get(created.job_id).n, 1, 'retry must create one final report');
  const completedSynthesisRecovery = await tool('workflow_recovery_verify', { job_id: created.job_id });
  assert.equal(completedSynthesisRecovery.status, 'PASS', 'recovery must pass once the report/delivery/terminal chain is durably completed');
  assert.equal(completedSynthesisRecovery.checks.find(check => check.name === 'completed_cto_has_terminal_report')?.pass, true);
  assert.equal(completedSynthesisRecovery.checks.find(check => check.name === 'completed_cto_has_durable_delivery_and_terminal_event')?.pass, true);

  // Adversarially remove each downstream event using a separate SQLite
  // connection. A completed projection/report must not hide a missing durable
  // delivery or terminal event. Restore the exact original rows even if an
  // assertion fails so this isolated fixture cannot contaminate later tests.
  for (const eventType of ['report.created', 'delivery.claimed', 'job.completed']) {
    const rows = testDb.prepare('SELECT event_id, job_id, type, payload_json, created_at FROM events WHERE job_id=? AND type=?').all(created.job_id, eventType);
    assert.equal(rows.length, 1, `fixture must have exactly one ${eventType} row before tampering`);
    try {
      testDb.prepare('DELETE FROM events WHERE event_id=?').run(rows[0].event_id);
      const tamperedRecovery = await tool('workflow_recovery_verify', { job_id: created.job_id });
      assert.equal(tamperedRecovery.status, 'NEEDS_ATTENTION', `recovery must reject a missing ${eventType} after terminal projection`);
      assert.equal(tamperedRecovery.checks.find(check => check.name === 'completed_cto_has_durable_delivery_and_terminal_event')?.pass, false,
        `generic recovery check must detect missing ${eventType}`);
    } finally {
      testDb.prepare('INSERT OR REPLACE INTO events(event_id, job_id, type, payload_json, created_at) VALUES(?, ?, ?, ?, ?)')
        .run(rows[0].event_id, rows[0].job_id, rows[0].type, rows[0].payload_json, rows[0].created_at);
    }
    assert.equal((await tool('workflow_recovery_verify', { job_id: created.job_id })).status, 'PASS', `restored ${eventType} must restore recovery PASS`);
  }
  // Generic workflows must bind the completed CTO result to its typed artifact,
  // completed attempt, and exact task.local_completed event. These checks are
  // exercised through a second SQLite connection, and fixtures are restored even
  // if recovery assertions fail.
  const genericCtoTask = testDb.prepare("SELECT task_id FROM tasks WHERE job_id=? AND role='cto' ORDER BY created_at DESC LIMIT 1").get(created.job_id);
  assert.ok(genericCtoTask, 'generic terminal workflow must have a CTO task');
  const genericCtoResult = testDb.prepare("SELECT result_id FROM results WHERE task_id=? AND outcome='success'").get(genericCtoTask.task_id);
  assert.ok(genericCtoResult, 'generic CTO task must have one successful result');
  const genericCtoArtifact = testDb.prepare("SELECT artifact_id, evidence_json FROM artifacts WHERE job_id=? AND task_id=? AND kind='cto-decision' AND status='active'").get(created.job_id, genericCtoTask.task_id);
  assert.ok(genericCtoArtifact, 'generic CTO task must have an active typed decision artifact');
  const mutateGenericDurableRow = async ({ selectSql, selectParams, updateSql, updateParams, label, expectedCheck }) => {
    const tamperDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    let original;
    try {
      original = tamperDb.prepare(selectSql).get(...selectParams);
      assert.ok(original, `${label} fixture row must exist`);
      tamperDb.prepare(updateSql).run(...updateParams(original));
    } finally { tamperDb.close(); }
    try {
      const recovery = await tool('workflow_recovery_verify', { job_id: created.job_id });
      assert.equal(recovery.status, 'NEEDS_ATTENTION', `${label} tampering must fail closed`);
      assert.equal(recovery.checks.find(check => check.name === expectedCheck)?.pass, false, `${label} must fail ${expectedCheck}`);
      const restarted = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
        cwd: root, env, encoding: 'utf8', timeout: 15_000,
        input: [
          JSON.stringify({ jsonrpc: '2.0', id: 801, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'generic-lineage-recovery-test', version: '1' } } }),
          JSON.stringify({ jsonrpc: '2.0', id: 802, method: 'tools/call', params: { name: 'workflow_recovery_verify', arguments: { job_id: created.job_id } } })
        ].join('\n') + '\n'
      });
      assert.equal(restarted.status, 0, `${label}: fresh MCP process must exit cleanly: ${restarted.stderr}`);
      const restartedMessages = restarted.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      const restartedRecovery = restartedMessages.find(message => message.id === 802)?.result?.structuredContent;
      assert.equal(restartedRecovery?.status, 'NEEDS_ATTENTION', `${label}: fresh MCP process must independently reject the tampered durable state`);
      assert.equal(restartedRecovery?.checks.find(check => check.name === expectedCheck)?.pass, false, `${label}: restarted process must fail ${expectedCheck}`);
    } finally {
      const restoreDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
      try { restoreDb.prepare(updateSql).run(...updateParams(original, true)); }
      finally { restoreDb.close(); }
    }
    assert.equal((await tool('workflow_recovery_verify', { job_id: created.job_id })).status, 'PASS', `restoring ${label} must restore recovery PASS`);
  };
  await mutateGenericDurableRow({
    selectSql: 'SELECT evidence_json FROM artifacts WHERE artifact_id=?', selectParams: [genericCtoArtifact.artifact_id],
    updateSql: 'UPDATE artifacts SET evidence_json=? WHERE artifact_id=?',
    updateParams: (row, restore=false) => [restore ? row.evidence_json : JSON.stringify(['substituted-result-reference', ...JSON.parse(row.evidence_json).filter(value => value !== genericCtoResult.result_id)]), genericCtoArtifact.artifact_id],
    label: 'generic CTO artifact evidence substitution', expectedCheck: 'completed_cto_binds_result_artifact_attempt_and_completion_event'
  });
  await mutateGenericDurableRow({
    selectSql: 'SELECT content, content_hash FROM artifacts WHERE artifact_id=?', selectParams: [genericCtoArtifact.artifact_id],
    updateSql: 'UPDATE artifacts SET content=?, content_hash=? WHERE artifact_id=?',
    updateParams: (row, restore=false) => {
      if (restore) return [row.content, row.content_hash, genericCtoArtifact.artifact_id];
      const substituted = { ...JSON.parse(row.content), summary: 'substituted CTO synthesis artifact bytes' };
      const serialized = JSON.stringify(substituted);
      return [serialized, crypto.createHash('sha256').update(serialized).digest('hex'), genericCtoArtifact.artifact_id];
    },
    label: 'generic CTO artifact content/hash substitution without event update', expectedCheck: 'completed_cto_binds_result_artifact_attempt_and_completion_event'
  });
  const genericCompletionId = crypto.createHash('sha256').update(`${created.job_id}|task.local_completed|${genericCtoResult.result_id}`).digest('hex');
  await mutateGenericDurableRow({
    selectSql: "SELECT payload_json FROM events WHERE event_id=? AND type='task.local_completed'", selectParams: [genericCompletionId],
    updateSql: 'UPDATE events SET payload_json=? WHERE event_id=?',
    updateParams: (row, restore=false) => [restore ? row.payload_json : JSON.stringify({ ...JSON.parse(row.payload_json), attemptId: 'substituted-attempt' }), genericCompletionId],
    label: 'generic CTO completion attempt substitution', expectedCheck: 'completed_cto_binds_result_artifact_attempt_and_completion_event'
  });
  const genericArtifactEventId = crypto.createHash('sha256').update(`${created.job_id}|artifact.created|${genericCtoArtifact.artifact_id}`).digest('hex');
  const genericArtifactEventDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  let genericArtifactEvent;
  const duplicateGenericArtifactEventId = `duplicate-generic-cto-artifact-event-${created.job_id}`;
  try {
    genericArtifactEvent = genericArtifactEventDb.prepare('SELECT job_id, type, payload_json, created_at FROM events WHERE event_id=?').get(genericArtifactEventId);
    assert.ok(genericArtifactEvent, 'generic CTO artifact creation event must exist');
    genericArtifactEventDb.prepare('INSERT INTO events(event_id,job_id,type,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(duplicateGenericArtifactEventId, genericArtifactEvent.job_id, genericArtifactEvent.type, genericArtifactEvent.payload_json, genericArtifactEvent.created_at);
  } finally { genericArtifactEventDb.close(); }
  try {
    const duplicateArtifactRecovery = await tool('workflow_recovery_verify', { job_id: created.job_id });
    assert.equal(duplicateArtifactRecovery.status, 'NEEDS_ATTENTION', 'duplicate CTO artifact-created semantic event must fail closed');
    assert.equal(duplicateArtifactRecovery.checks.find(check => check.name === 'completed_cto_binds_result_artifact_attempt_and_completion_event')?.pass, false);
    const restarted = spawnSync(process.execPath, [path.join(root, 'server/index.js')], {
      cwd: root, env, encoding: 'utf8', timeout: 15_000,
      input: [
        JSON.stringify({ jsonrpc: '2.0', id: 811, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'generic-duplicate-event-test', version: '1' } } }),
        JSON.stringify({ jsonrpc: '2.0', id: 812, method: 'tools/call', params: { name: 'workflow_recovery_verify', arguments: { job_id: created.job_id } } })
      ].join('\n') + '\n'
    });
    assert.equal(restarted.status, 0, `duplicate artifact event fresh process must exit cleanly: ${restarted.stderr}`);
    const restartedMessages = restarted.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    const restartedRecovery = restartedMessages.find(message => message.id === 812)?.result?.structuredContent;
    assert.equal(restartedRecovery?.status, 'NEEDS_ATTENTION', 'fresh process must reject duplicate CTO artifact event');
  } finally {
    const restoreDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
    try { restoreDb.prepare('DELETE FROM events WHERE event_id=?').run(duplicateGenericArtifactEventId); }
    finally { restoreDb.close(); }
  }
  assert.equal((await tool('workflow_recovery_verify', { job_id: created.job_id })).status, 'PASS', 'removing duplicate CTO artifact event must restore recovery PASS');
  testDb.close();

  const workflow = await tool('workflow_get', { job_id: created.job_id });
  assert.equal(workflow.job.status, 'completed');
  assert.equal(workflow.job.state, 'COMPLETED');
  assert.equal(workflow.tasks.filter(task => task.status === 'completed').length, 10);
  assert.equal(workflow.approvals.length, 1);

  const events = await tool('workflow_events', { job_id: created.job_id });
  assert.ok(events.events.some(event => event.type === 'task.local_completed'));
  assert.ok(events.events.some(event => event.type === 'job.completed'));

  const handoff = await tool('workflow_create', { title: 'post reinstall handoff smoke test', task: 'Verify role handoff via typed artifacts only; no workspace file changes or shell execution.', workflow: 'engineering', workspace });
  await tool('workflow_approve', { job_id: handoff.job_id, confirmation: 'Approve compile and local artifact-only workflow test in isolated workspace.' });
  const handoffPlan = (await tool('workflow_get', { job_id: handoff.job_id })).plan;
  for (const task of handoffPlan.children) {
    assert.equal(task.execution.deterministic, false, `${task.role} must not run a deterministic command`);
    assert.equal(task.execution.execution_mode, 'host-conversation', `${task.role} must use host-conversation handoff`);
    assert.equal(task.execution.executor, 'ChatOnSteroidsHost');
    assert.ok(!task.execution.command, `${task.role} must not embed a shell command`);
  }
  await tool('workflow_dispatch', { job_id: handoff.job_id });
  await tool('workflow_prepare_tasks', { job_id: handoff.job_id });
  for (const role of ['product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer']) {
    const next = await tool('workflow_next_task', { job_id: handoff.job_id });
    assert.equal(next.stage, 'task');
    assert.equal(next.task.role, role);
    const content = role === 'architect'
      ? 'Contract: preserve marker POSTINSTALL-HANDOFF-20261010; QA must verify exact marker in engineer evidence.'
      : role === 'engineer'
        ? 'Implementation evidence: marker POSTINSTALL-HANDOFF-20261010 preserved; no files changed.'
        : role === 'qa'
          ? 'PASS: engineer evidence contains exact marker POSTINSTALL-HANDOFF-20261010 and matches architect contract.'
          : 'ACCEPTED: architect contract and engineer/QA typed evidence are consistent.';
    const artifact = artifactFor(role);
    if (role === 'reviewer') artifact.decision = 'accept';
    await tool('workflow_complete_task', { task_id: next.task.task_id, content, artifact });
  }
  const handoffSynthesis = await tool('workflow_next_task', { job_id: handoff.job_id });
  assert.equal(handoffSynthesis.stage, 'synthesis');
  assert.equal((await tool('workflow_complete_synthesis', { job_id: handoff.job_id, content: 'Artifact-only handoff smoke test passed; no shell commands or workspace files were used.', artifact: artifactFor('cto') })).terminalized, true);
  assert.equal(fs.existsSync(path.join(workspace, '.m4-engineer-proof.js')), false);

  fs.writeFileSync(path.join(workspace, 'server.js'), 'export const localServerSyntaxProof = true;\n');
  fs.writeFileSync(path.join(workspace, 'test-tool-turn.js'), 'export const localToolSyntaxProof = true;\n');
  await assert.rejects(() => tool('workflow_create', {
    title: 'implicit production workspace must be rejected',
    task: 'Do not inspect the user home directory implicitly.',
    workflow: 'production'
  }), /production workflow requires an explicit workspace/,
  'production syntax checks must not silently target the default home directory');
  const production = await tool('workflow_create', { title: 'local production checks', task: 'Run the approved local syntax checks and record their limits', workflow: 'production', workspace });
  await tool('workflow_approve', { job_id: production.job_id, confirmation: 'I approve local syntax checks in the isolated test workspace.' });
  await tool('workflow_dispatch', { job_id: production.job_id });
  await tool('workflow_prepare_tasks', { job_id: production.job_id });
  for (const role of ['architect', 'qa']) {
    const next = await tool('workflow_next_task', { job_id: production.job_id });
    assert.equal(next.stage, 'local_execution');
    assert.equal(next.task.role, role);
    const execution = await tool('task_execute_local', { task_id: next.task.task_id });
    assert.equal(execution.executed_locally, true);
    assert.equal(execution.exit_code, 0);
    if (role === 'qa') {
      for (const marker of [
        'PRODUCTION QA MCP INITIALIZE/33-TOOL DISCOVERY PASS',
        'PRODUCTION QA BEHAVIORAL ARTIFACT VALIDATION PASS',
        'PRODUCTION QA APPROVAL/DISPATCH/IMMUTABLE-PLAN NEXT-TASK PASS'
      ]) assert.ok(execution.stdout.includes(marker), `packaged behavioral QA output missing marker: ${marker}`);
    }
  }
  const productionSynthesis = await tool('workflow_next_task', { job_id: production.job_id });
  assert.equal(productionSynthesis.stage, 'synthesis');
  assert.equal(productionSynthesis.completed_results.length, 2);
  const productionTerminal = await tool('workflow_complete_synthesis', {
    job_id: production.job_id,
    content: 'The architecture syntax check and exact packaged local behavioral QA contract passed in isolated SQLite/workspace environments. No model API, network, remote workflow or external provider was contacted.',
    artifact: artifactFor('cto')
  });
  assert.equal(productionTerminal.terminalized, true, 'production workflow should synthesize only after packaged behavioral QA evidence passes');
  const productionComplete = await tool('workflow_get', { job_id: production.job_id });
  assert.equal(productionComplete.job.state, 'COMPLETED');
  const productionDb = new DatabaseSync(path.join(dataDir, 'workflow.db'), { readOnly: true });
  try {
    const qaRow = productionDb.prepare("SELECT content FROM artifacts WHERE job_id=? AND kind='qa-report' AND status='active' ORDER BY created_at DESC LIMIT 1").get(production.job_id);
    assert.ok(qaRow, 'packaged behavioral QA evidence must be durable before synthesis');
    const qaArtifact = JSON.parse(qaRow.content);
    assert.equal(qaArtifact.decision, 'accept', `only exact-plan packaged behavioral QA may be accepted; artifact=${JSON.stringify(qaArtifact)}`);
    assert.ok(qaArtifact.results.includes('execution_scope=packaged-behavioral-e2e'));
    for (const marker of [
      'PRODUCTION QA MCP INITIALIZE/33-TOOL DISCOVERY PASS',
      'PRODUCTION QA BEHAVIORAL ARTIFACT VALIDATION PASS',
      'PRODUCTION QA APPROVAL/DISPATCH/IMMUTABLE-PLAN NEXT-TASK PASS'
    ]) assert.ok(qaArtifact.results.includes(`pass_marker=${marker}`), `durable QA artifact missing marker: ${marker}`);
  } finally {
    productionDb.close();
  }
  const recovery = await tool('workflow_recovery_verify', { job_id: production.job_id });
  assert.equal(recovery.status, 'PASS', JSON.stringify(recovery.checks));

  const evidenceGuard = await tool('workflow_create', { title: 'review evidence provenance guard', task: 'Reject reviewer issuance when a required upstream artifact no longer binds its producer result; restore evidence and complete the full lifecycle.', workflow: 'standard-engineering', workspace });
  await tool('workflow_approve', { job_id: evidenceGuard.job_id, confirmation: 'Approve isolated local workflow evidence-provenance regression test.' });
  await tool('workflow_dispatch', { job_id: evidenceGuard.job_id });
  await tool('workflow_prepare_tasks', { job_id: evidenceGuard.job_id });
  for (const role of ['product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer']) {
    const next = await tool('workflow_next_task', { job_id: evidenceGuard.job_id });
    assert.equal(next.stage, 'task', `expected dependency-ready ${role}: ${JSON.stringify(next)}`);
    assert.equal(next.task.role, role);
    await tool('workflow_complete_task', { task_id: next.task.task_id, content: `Verified typed evidence for ${role}.`, artifact: artifactFor(role) });
  }
  const evidenceGuardDb = new DatabaseSync(path.join(dataDir, 'workflow.db'));
  const implementationEvidenceRow = evidenceGuardDb.prepare("SELECT artifact_id,evidence_json FROM artifacts WHERE job_id=? AND kind='implementation' AND status='active'").get(evidenceGuard.job_id);
  assert.ok(implementationEvidenceRow, 'implementation artifact must exist before reviewer issuance');
  try {
    evidenceGuardDb.prepare('UPDATE artifacts SET evidence_json=? WHERE artifact_id=?').run(JSON.stringify(['substituted-result-id']), implementationEvidenceRow.artifact_id);
    const invalidEvidenceNext = await tool('workflow_next_task', { job_id: evidenceGuard.job_id });
    assert.equal(invalidEvidenceNext.stage, 'blocked', 'reviewer must not be issued when a required artifact loses producer-result provenance');
    assert.ok(invalidEvidenceNext.evidence_errors.some(error => /does not bind its successful producer result/.test(error)),
      `reviewer evidence blocker must name provenance failure: ${JSON.stringify(invalidEvidenceNext.evidence_errors)}`);
  } finally {
    evidenceGuardDb.prepare('UPDATE artifacts SET evidence_json=? WHERE artifact_id=?').run(implementationEvidenceRow.evidence_json, implementationEvidenceRow.artifact_id);
    evidenceGuardDb.close();
  }
  const restoredReviewer = await tool('workflow_next_task', { job_id: evidenceGuard.job_id });
  assert.equal(restoredReviewer.stage, 'task');
  assert.equal(restoredReviewer.task.role, 'reviewer');
  await tool('workflow_complete_task', { task_id: restoredReviewer.task.task_id, content: 'Accepted all seven dependency-bound typed artifacts after validating their successful result provenance and required scope.', artifact: artifactFor('reviewer') });
  const evidenceSynthesis = await tool('workflow_next_task', { job_id: evidenceGuard.job_id });
  assert.equal(evidenceSynthesis.stage, 'synthesis');
  const evidenceTerminal = await tool('workflow_complete_synthesis', { job_id: evidenceGuard.job_id, content: 'All required role evidence passed schema, producer-result provenance, reviewer acceptance and terminalization gates.', artifact: artifactFor('cto') });
  assert.equal(evidenceTerminal.terminalized, true);
  const evidenceRecovery = await tool('workflow_recovery_verify', { job_id: evidenceGuard.job_id });
  assert.equal(evidenceRecovery.status, 'PASS', JSON.stringify(evidenceRecovery.checks));
  assert.equal(evidenceRecovery.checks.find(check => check.name === 'reviewer_evidence_bound_to_dependency_producers')?.pass, true);

  const rejectedReview = await tool('workflow_create', { title: 'review rejection guard', task: 'Verify synthesis refuses a reviewer artifact with blocking findings', workflow: 'standard-engineering', workspace });
  await tool('workflow_approve', { job_id: rejectedReview.job_id, confirmation: 'I approve local execution for the reviewer guard test.' });
  await tool('workflow_dispatch', { job_id: rejectedReview.job_id });
  await tool('workflow_prepare_tasks', { job_id: rejectedReview.job_id });
  for (let index = 0; index < 9; index += 1) {
    const next = await tool('workflow_next_task', { job_id: rejectedReview.job_id });
    const artifact = artifactFor(next.task.role);
    if (next.task.role === 'reviewer') {
      artifact.decision = 'needs_changes';
      artifact.blockingIssues = ['Release gate must remain blocked.'];
    }
    await tool('workflow_complete_task', { task_id: next.task.task_id, content: `Recorded test evidence for ${next.task.role}.`, artifact });
  }
  const rejectedReviewNext = await tool('workflow_next_task', { job_id: rejectedReview.job_id });
  assert.equal(rejectedReviewNext.stage, 'blocked');
  assert.match(rejectedReviewNext.reason, /reviewer has not accepted/i);
  assert.equal(rejectedReviewNext.terminalized, false);
  const rejectedSynthesis = await rpc('tools/call', { name: 'workflow_complete_synthesis', arguments: { job_id: rejectedReview.job_id, content: 'This synthesis must be rejected by the reviewer gate.', artifact: artifactFor('cto') } });
  assert.equal(rejectedSynthesis.result.isError, true);
  assert.match(rejectedSynthesis.result.content[0].text, /reviewer artifact has not accepted/i);
  const stillBlocked = await tool('workflow_get', { job_id: rejectedReview.job_id });
  assert.equal(stillBlocked.job.status, 'active');
  assert.equal(stillBlocked.job.state, 'EXECUTING');

  console.log('chat-on-steroids local plugin E2E: PASS (stdio MCP, approval, versioned custom-role CRUD/clone/validation, custom-workflow CRUD/clone/version pinning, DAG contract/cycle validation, immutable plan preview/approval, separate execution approval, custom workflow DAG execution and typed artifacts, 9-task built-in DAG, evidence-provenance rejection/restoration, deterministic local execution, production checks, reviewer rejection guard, failure terminalization, synthesis, terminalization; no cloud/API key)');
} finally {
  child.stdin.end();
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 1500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  const makeWritable = target => {
    let stat;
    try { stat = fs.lstatSync(target); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(target, 0o700);
      for (const name of fs.readdirSync(target)) makeWritable(path.join(target, name));
    } else if (stat.isFile()) fs.chmodSync(target, 0o600);
  };
  makeWritable(temp);
  fs.rmSync(temp, { recursive: true, force: true });
}
