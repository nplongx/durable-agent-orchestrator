import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './test-temp-dir.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = tempDir('github-actions-dispatch-concurrency-');
const markerDir = path.join(root, 'markers');
fs.mkdirSync(markerDir, { recursive: true });
process.env.WORKFLOW_DB = path.join(root, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';

const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { GitHubActionsProvider } = await import('../src/runtime/github-actions-provider.js');
const { canonicalProviderDispatchRequest, createProviderDispatchIdentity, providerDispatchKey } = await import('../src/runtime/provider-dispatch-identity.js');

const input = {
  schema_version: 1,
  job_id: 'job-dispatch-concurrency',
  task_id: 'task-dispatch-concurrency',
  lease_id: 'lease-dispatch-concurrency',
  attempt: 1,
  owner_epoch: 4,
  role: 'executor',
  input_commit: 'ee24280441c2cf2d8ae4d706a295c90f8fef7bd6',
  task_payload_ref: 'task://dispatch-concurrency',
  workspace: 'ephemeral',
  required_evidence: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt']
};
const config = {
  provider: 'github-actions', api_base: 'https://api.github.com', workflow: 'p3-worker.yml', repository: 'example/repo',
  event: 'workflow_dispatch', ref: 'main'
};
const identity = createProviderDispatchIdentity(input, config);
const dispatchKey = providerDispatchKey(identity);
const createdAt = new Date().toISOString();

const store = new WorkflowStore();
function ensureFixtureLease(request) {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  store.db.prepare(`INSERT OR IGNORE INTO jobs
    (job_id,conversation_key,title,state,status,created_at,updated_at)
    VALUES(?,?,?,'active','active',?,?)`)
    .run(request.job_id, `fixture-${request.job_id}`, 'dispatch concurrency lease fixture', now, now);
  store.db.prepare(`INSERT OR IGNORE INTO tasks
    (task_id,job_id,role,description,status,dependency_json,metadata_json,created_at,updated_at)
    VALUES(?,?,?,'dispatch concurrency lease fixture','running','[]','{}',?,?)`)
    .run(request.task_id, request.job_id, request.role || 'executor', now, now);
  store.db.prepare(`INSERT OR IGNORE INTO task_leases
    (lease_id,task_id,job_id,attempt,worker_id,owner_epoch,state,issued_at,heartbeat_at,expires_at)
    VALUES(?,?,?,?,?,?,'ACTIVE',?,?,?)`)
    .run(request.lease_id, request.task_id, request.job_id, request.attempt, 'dispatch-concurrency-fixture',
      request.owner_epoch, now, now, expires);
}
ensureFixtureLease(input);
new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async () => { throw new Error('schema initialization must not make network requests'); }
});
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
  .run(dispatchKey, input.job_id, input.task_id, input.lease_id, input.attempt, input.owner_epoch, config.provider, input.input_commit,
    identity.request_sha256, canonicalProviderDispatchRequest(input), config.api_base, config.workflow, config.repository, config.event, config.ref, createdAt, createdAt);

// Each process opens its own real SQLite connection to the same WAL database.
// Both report ready before the parent opens the dispatch barrier, ensuring the
// race is at the durable dispatch boundary rather than process initialization.
const workerSource = `
  import fs from 'node:fs';
  import path from 'node:path';
  import { setTimeout as sleep } from 'node:timers/promises';
  import { WorkflowStore } from ${JSON.stringify(path.join(projectRoot, 'src/runtime/job-store.js'))};
  import { GitHubActionsProvider } from ${JSON.stringify(path.join(projectRoot, 'src/runtime/github-actions-provider.js'))};
  const markerDir = process.env.PHASE2_MARKER_DIR;
  const dispatchKey = process.env.PHASE2_DISPATCH_KEY;
  const createdAt = process.env.PHASE2_CREATED_AT;
  const input = JSON.parse(process.env.PHASE2_EXECUTION_REQUEST);
  const store = new WorkflowStore();
  const provider = new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/dispatches') && options.method === 'POST') {
        fs.writeFileSync(path.join(markerDir, 'post-' + process.pid), 'remote POST');
        if (process.env.PHASE2_PRE_FIX_SYNCHRONIZED_DISPATCH_REPRO === '1') {
          const deadline = Date.now() + 5000;
          while (fs.readdirSync(markerDir).filter(name => name.startsWith('post-')).length < 2 && Date.now() < deadline) await sleep(5);
        }
        return new Response(JSON.stringify({ workflow_run_id: 700000 + process.pid }), { status: 200 });
      }
      const match = /actions\\/runs\\/(\\d+)$/.exec(url);
      if (match) return new Response(JSON.stringify({
        id: Number(match[1]), status: 'in_progress', conclusion: null, run_attempt: 1,
        head_sha: input.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main',
        event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' },
        display_title: 'P3 worker ' + dispatchKey, created_at: createdAt
      }), { status: 200 });
      if (url.includes('/actions/workflows/p3-worker.yml/runs?')) {
        return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
      }
      throw new Error('unexpected mocked URL: ' + url);
    }
  });
  fs.writeFileSync(path.join(markerDir, 'ready-' + process.pid), 'ready');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(markerDir, 'START')) && Date.now() < deadline) await sleep(5);
  if (!fs.existsSync(path.join(markerDir, 'START'))) throw new Error('parent did not release dispatch barrier');
  try {
    const result = await provider.dispatch({ ...input, dispatch_key: dispatchKey });
    process.stdout.write(JSON.stringify({ pid: process.pid, result: {
      provider_run_id: result.provider_run_id || null, state: result.state || null,
      pending_reconciliation: result.pending_reconciliation === true
    } }) + '\\n');
  } finally { store.db.close(); }
`;

function runWorker() {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource], {
    cwd: projectRoot,
    env: {
      ...process.env,
      WORKFLOW_DB: process.env.WORKFLOW_DB,
      WORKFLOW_DATA_DIR: root,
      WORKFLOW_WORKSPACE: root,
      NODE_ENV: 'test',
      PHASE2_MARKER_DIR: markerDir,
      PHASE2_DISPATCH_KEY: dispatchKey,
      PHASE2_CREATED_AT: createdAt,
      PHASE2_EXECUTION_REQUEST: JSON.stringify(input)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`dispatcher process failed: code=${code} signal=${signal}\nstdout=${stdout}\nstderr=${stderr}`));
      else {
        const lines = stdout.trim().split(/\r?\n/);
        try { resolve(JSON.parse(lines.at(-1))); }
        catch (error) { reject(new Error(`invalid dispatcher output: ${stdout}\n${stderr}\n${error.message}`)); }
      }
    });
  });
}

try {
  const first = runWorker();
  const second = runWorker();
  const readyDeadline = Date.now() + 15000;
  while (fs.readdirSync(markerDir).filter(name => name.startsWith('ready-')).length < 2 && Date.now() < readyDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.readdirSync(markerDir).filter(name => name.startsWith('ready-')).length, 2,
    'both independent dispatcher processes must open the same durable database before racing');
  fs.writeFileSync(path.join(markerDir, 'START'), 'go');
  const results = await Promise.all([first, second]);
  const postCount = fs.readdirSync(markerDir).filter(name => name.startsWith('post-')).length;
  assert.equal(postCount, 1,
    `two independent dispatchers for one durable intent must issue exactly one remote workflow_dispatch POST; observed ${postCount}; results=${JSON.stringify(results)}`);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatch_intents WHERE dispatch_key=?').get(dispatchKey).n, 1);
const durable = store.db.prepare('SELECT state,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
  assert.ok(['DISPATCHING', 'DISPATCHED'].includes(durable.state));
  assert.ok(durable.state === 'DISPATCHING' || /^\d+$/.test(String(durable.provider_run_id)));

  // Crash immediately after the durable send claim, before calling fetch. On
  // restart the claim is intentionally not cleared: local state cannot prove
  // whether an arbitrarily timed crash occurred before or after the remote
  // acceptance boundary, so recovery must reconcile and must not re-POST.
  const crashInput = { ...input, job_id: 'job-dispatch-claim-crash', task_id: 'task-dispatch-claim-crash', lease_id: 'lease-dispatch-claim-crash' };
  ensureFixtureLease(crashInput);
  const crashIdentity = createProviderDispatchIdentity(crashInput, config);
  const crashKey = providerDispatchKey(crashIdentity);
  const crashCreatedAt = new Date().toISOString();
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
    .run(crashKey, crashInput.job_id, crashInput.task_id, crashInput.lease_id, crashInput.attempt, crashInput.owner_epoch, config.provider, crashInput.input_commit,
      crashIdentity.request_sha256, canonicalProviderDispatchRequest(crashInput), config.api_base, config.workflow, config.repository, config.event, config.ref, crashCreatedAt, crashCreatedAt);
  const crashMarker = path.join(root, 'claim-crash-fetch-marker');
  const storeModuleUrl = new URL('../src/runtime/job-store.js', import.meta.url).href;
  const providerModuleUrl = new URL('../src/runtime/github-actions-provider.js', import.meta.url).href;
  const crashSource = `
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const { GitHubActionsProvider } = await import(${JSON.stringify(providerModuleUrl)});
    const s = new WorkflowStore();
    const p = new GitHubActionsProvider({ token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: s,
      fetchImpl: async url => { require('node:fs').writeFileSync(${JSON.stringify(crashMarker)}, url); throw new Error('unexpected fetch before crash claim'); } });
    await p.dispatch({ ...${JSON.stringify(crashInput)}, dispatch_key: ${JSON.stringify(crashKey)} });
  `;
  const crashedBeforeSend = spawnSync(process.execPath, ['--input-type=module', '-e', crashSource], {
    cwd: projectRoot, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: process.env.WORKFLOW_DB, WORKFLOW_DATA_DIR: root,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_CRASH_AFTER_PROVIDER_SEND_CLAIM: 'SIGKILL' }
  });
  assert.equal(crashedBeforeSend.signal, 'SIGKILL', `claim-crash child must die after durable claim: ${crashedBeforeSend.stderr}`);
  assert.equal(fs.existsSync(crashMarker), false, 'no HTTP boundary may be crossed before the durable claim crash');
  const claimedAfterCrash = store.db.prepare('SELECT state,provider_run_id,dispatch_claim_id,dispatch_claimed_at FROM provider_dispatch_intents WHERE dispatch_key=?').get(crashKey);
  assert.equal(claimedAfterCrash.state, 'DISPATCHING');
  assert.equal(claimedAfterCrash.provider_run_id, null);
  assert.ok(claimedAfterCrash.dispatch_claim_id, 'the one-way claim must survive process death');
  assert.ok(claimedAfterCrash.dispatch_claimed_at, 'the durable claim must preserve the actual send-attempt time for future reconciliation');
  let recoveryPosts = 0;
  const recoveryProvider = new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/dispatches') && options.method === 'POST') { recoveryPosts++; return new Response(null, { status: 204 }); }
      if (url.includes('/actions/workflows/p3-worker.yml/runs?')) return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
      throw new Error('unexpected recovery URL: ' + url);
    }
  });
  const afterCrashRecovery = await recoveryProvider.dispatch({ ...crashInput, dispatch_key: crashKey });
  assert.equal(afterCrashRecovery.pending_reconciliation, true);
  assert.equal(recoveryPosts, 0, 'a claimed-but-unresolved intent must never be silently replayed after restart');

  // Kill after a successful mock HTTP response but before the provider can
  // inspect or bind workflow_run_id. The process has crossed the acceptance
  // boundary, but durable state still contains only the claim. Recovery must
  // find the run and bind it without posting a second dispatch.
  const responseCrashInput = { ...input, job_id: 'job-dispatch-response-crash', task_id: 'task-dispatch-response-crash', lease_id: 'lease-dispatch-response-crash' };
  ensureFixtureLease(responseCrashInput);
  const responseCrashIdentity = createProviderDispatchIdentity(responseCrashInput, config);
  const responseCrashKey = providerDispatchKey(responseCrashIdentity);
  const responseCrashCreatedAt = new Date().toISOString();
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
    .run(responseCrashKey, responseCrashInput.job_id, responseCrashInput.task_id, responseCrashInput.lease_id,
      responseCrashInput.attempt, responseCrashInput.owner_epoch, config.provider, responseCrashInput.input_commit, responseCrashIdentity.request_sha256,
      canonicalProviderDispatchRequest(responseCrashInput), config.api_base, config.workflow, config.repository, config.event, config.ref,
      responseCrashCreatedAt, responseCrashCreatedAt);
  const acceptedMarker = path.join(root, 'response-crash-remote-accepted');
  const responseCrashSource = `
    const fs = await import('node:fs');
    const { WorkflowStore } = await import(${JSON.stringify(storeModuleUrl)});
    const { GitHubActionsProvider } = await import(${JSON.stringify(providerModuleUrl)});
    const s = new WorkflowStore();
    const p = new GitHubActionsProvider({ token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store: s,
      fetchImpl: async (url, options = {}) => {
        if (url.endsWith('/dispatches') && options.method === 'POST') {
          fs.writeFileSync(${JSON.stringify(acceptedMarker)}, 'remote acceptance mocked');
          return new Response(JSON.stringify({ workflow_run_id: 780078 }), { status: 200 });
        }
        throw new Error('unexpected request before response crash: ' + url);
      }
    });
    await p.dispatch({ ...${JSON.stringify(responseCrashInput)}, dispatch_key: ${JSON.stringify(responseCrashKey)} });
  `;
  const crashedAfterResponse = spawnSync(process.execPath, ['--input-type=module', '-e', responseCrashSource], {
    cwd: projectRoot, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WORKFLOW_DB: process.env.WORKFLOW_DB, WORKFLOW_DATA_DIR: root,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_CRASH_AFTER_PROVIDER_DISPATCH_RESPONSE: 'SIGKILL' }
  });
  assert.equal(crashedAfterResponse.signal, 'SIGKILL', `response-crash child must die before durable result binding: ${crashedAfterResponse.stderr}`);
  assert.equal(fs.existsSync(acceptedMarker), true, 'the mock remote must have accepted the dispatch before process death');
  const afterResponseCrash = store.db.prepare('SELECT state,provider_run_id,dispatch_claim_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(responseCrashKey);
  assert.equal(afterResponseCrash.state, 'DISPATCHING');
  assert.equal(afterResponseCrash.provider_run_id, null);
  assert.ok(afterResponseCrash.dispatch_claim_id);
  let replayedAcceptedPost = 0;
  const responseRecoveryProvider = new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/dispatches') && options.method === 'POST') { replayedAcceptedPost++; return new Response(null, { status: 204 }); }
      if (url.includes('/actions/workflows/p3-worker.yml/runs?')) return new Response(JSON.stringify({ workflow_runs: [{
        id: 780078, display_title: `P3 worker ${responseCrashKey}`, name: 'P3 worker', status: 'in_progress', conclusion: null,
        html_url: 'https://github.com/example/repo/actions/runs/780078', created_at: responseCrashCreatedAt,
        path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
        repository: { full_name: 'example/repo' }, head_sha: responseCrashInput.input_commit, run_attempt: 1
      }] }), { status: 200 });
      throw new Error('unexpected response-crash recovery URL: ' + url);
    }
  });
  const responseCrashRecovery = await responseRecoveryProvider.dispatch({ ...responseCrashInput, dispatch_key: responseCrashKey });
  assert.equal(responseCrashRecovery.provider_run_id, '780078');
  assert.equal(replayedAcceptedPost, 0, 'response-lost recovery must reconcile instead of issuing a duplicate dispatch');

  // Simulate a remote accepted request whose response is lost. The actual
  // provider call records a POST at the mock boundary, then throws; recovery
  // must find the uniquely matching run and atomically bind it in real SQLite.
  const acceptedInput = { ...input, job_id: 'job-dispatch-accepted-timeout', task_id: 'task-dispatch-accepted-timeout', lease_id: 'lease-dispatch-accepted-timeout' };
  ensureFixtureLease(acceptedInput);
  const acceptedIdentity = createProviderDispatchIdentity(acceptedInput, config);
  const acceptedKey = providerDispatchKey(acceptedIdentity);
  const acceptedCreatedAt = new Date().toISOString();
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
    .run(acceptedKey, acceptedInput.job_id, acceptedInput.task_id, acceptedInput.lease_id, acceptedInput.attempt, acceptedInput.owner_epoch, config.provider, acceptedInput.input_commit,
      acceptedIdentity.request_sha256, canonicalProviderDispatchRequest(acceptedInput), config.api_base, config.workflow, config.repository, config.event, config.ref, acceptedCreatedAt, acceptedCreatedAt);
  let acceptedPosts = 0;
  const acceptedProvider = new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/dispatches') && options.method === 'POST') {
        acceptedPosts++;
        throw new TypeError('simulated connection reset after the mock remote accepted the request');
      }
      if (url.includes('/actions/workflows/p3-worker.yml/runs?')) return new Response(JSON.stringify({ workflow_runs: [{
        id: 770077, display_title: `P3 worker ${acceptedKey}`, name: 'P3 worker', status: 'in_progress', conclusion: null,
        html_url: 'https://github.com/example/repo/actions/runs/770077', created_at: acceptedCreatedAt,
        path: '.github/workflows/p3-worker.yml@refs/heads/main', event: 'workflow_dispatch', head_branch: 'main',
        repository: { full_name: 'example/repo' }, head_sha: acceptedInput.input_commit, run_attempt: 1
      }] }), { status: 200 });
      throw new Error('unexpected accepted-timeout URL: ' + url);
    }
  });
  const acceptedTimeoutRecovery = await acceptedProvider.dispatch({ ...acceptedInput, dispatch_key: acceptedKey });
  assert.equal(acceptedPosts, 1, 'the simulated remote acceptance boundary is crossed once');
  assert.equal(acceptedTimeoutRecovery.provider_run_id, '770077', 'unique reconciliation should bind the remotely accepted run');
  const acceptedDurable = store.db.prepare('SELECT state,provider_run_id,dispatch_claim_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(acceptedKey);
  assert.equal(acceptedDurable.state, 'DISPATCHED');
  assert.equal(acceptedDurable.provider_run_id, '770077');
  assert.ok(acceptedDurable.dispatch_claim_id);

  // HTTP status class alone is not enough to prove a mutating request did not
  // happen. A 429, 408, or 409 must not free a claimed intent for blind replay.
  const limitedInput = { ...input, job_id: 'job-dispatch-429-ambiguous', task_id: 'task-dispatch-429-ambiguous', lease_id: 'lease-dispatch-429-ambiguous' };
  ensureFixtureLease(limitedInput);
  const limitedIdentity = createProviderDispatchIdentity(limitedInput, config);
  const limitedKey = providerDispatchKey(limitedIdentity);
  const limitedCreatedAt = new Date().toISOString();
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
    .run(limitedKey, limitedInput.job_id, limitedInput.task_id, limitedInput.lease_id, limitedInput.attempt, limitedInput.owner_epoch, config.provider, limitedInput.input_commit,
      limitedIdentity.request_sha256, canonicalProviderDispatchRequest(limitedInput), config.api_base, config.workflow, config.repository, config.event, config.ref, limitedCreatedAt, limitedCreatedAt);
  let limitedPosts = 0;
  const limitedProvider = new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/dispatches') && options.method === 'POST') { limitedPosts++; return new Response('rate limited', { status: 429 }); }
      if (url.includes('/actions/workflows/p3-worker.yml/runs?')) return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
      throw new Error('unexpected rate-limit recovery URL: ' + url);
    }
  });
  await assert.rejects(() => limitedProvider.dispatch({ ...limitedInput, dispatch_key: limitedKey }), /GitHub API 429/);
  const limitedDurable = store.db.prepare('SELECT state,provider_run_id,dispatch_claim_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(limitedKey);
  assert.equal(limitedDurable.state, 'DISPATCHING');
  assert.equal(limitedDurable.provider_run_id, null);
  assert.ok(limitedDurable.dispatch_claim_id, '429 must not release the conservative send claim');
  const limitedRecovery = await limitedProvider.dispatch({ ...limitedInput, dispatch_key: limitedKey });
  assert.equal(limitedRecovery.pending_reconciliation, true);
  assert.equal(limitedPosts, 1, 'rate-limited/ambiguous dispatch must not be replayed on the next call');

  // A network call that never reaches response headers must not hang provider
  // reconciliation indefinitely. The deadline is not proof that workflow_dispatch
  // was rejected, so its durable one-way claim must survive both the timeout and
  // the next dispatch() invocation.
  const timeoutInput = { ...input, job_id: 'job-dispatch-deadline', task_id: 'task-dispatch-deadline', lease_id: 'lease-dispatch-deadline' };
  ensureFixtureLease(timeoutInput);
  const timeoutIdentity = createProviderDispatchIdentity(timeoutInput, config);
  const timeoutKey = providerDispatchKey(timeoutIdentity);
  const timeoutCreatedAt = new Date().toISOString();
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
    .run(timeoutKey, timeoutInput.job_id, timeoutInput.task_id, timeoutInput.lease_id, timeoutInput.attempt,
      timeoutInput.owner_epoch, config.provider, timeoutInput.input_commit, timeoutIdentity.request_sha256,
      canonicalProviderDispatchRequest(timeoutInput), config.api_base, config.workflow, config.repository, config.event,
      config.ref, timeoutCreatedAt, timeoutCreatedAt);
  let timeoutPosts = 0;
  let timeoutLookups = 0;
  const deadlineProvider = new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main',
    store, requestTimeoutMs: 25,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/dispatches') && options.method === 'POST') {
        timeoutPosts++;
        return new Promise(() => {}); // ignore AbortSignal to prove the provider-level race bounds caller wait
      }
      if (url.includes('/actions/workflows/p3-worker.yml/runs?')) {
        timeoutLookups++;
        return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
      }
      throw new Error('unexpected deadline regression URL: ' + url);
    }
  });
  const deadlineStartedAt = Date.now();
  const timeoutResult = await deadlineProvider.dispatch({ ...timeoutInput, dispatch_key: timeoutKey });
  assert.ok(Date.now() - deadlineStartedAt < 6000, 'stalled dispatch must return control to the durable reconciliation loop');
  assert.equal(timeoutResult.pending_reconciliation, true);
  assert.equal(timeoutPosts, 1, 'timed out POST must not be repeated during its internal reconciliation loop');
  assert.ok(timeoutLookups >= 1, 'timeout path should attempt read-only remote reconciliation');
  const timeoutIntent = store.db.prepare('SELECT state,provider_run_id,dispatch_claim_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(timeoutKey);
  assert.equal(timeoutIntent.state, 'DISPATCHING');
  assert.equal(timeoutIntent.provider_run_id, null);
  assert.ok(timeoutIntent.dispatch_claim_id, 'timeout must preserve the one-way send claim because remote acceptance is uncertain');
  const timeoutAgain = await deadlineProvider.dispatch({ ...timeoutInput, dispatch_key: timeoutKey });
  assert.equal(timeoutAgain.pending_reconciliation, true);
  assert.equal(timeoutPosts, 1, 'a later call after timeout must reconcile only and never replay the POST');
  console.log('github-actions cross-process dispatch single-send CAS: PASS');
  store.db.close();
} catch (error) {
  try { store.db.close(); } catch {}
  throw error;
}
