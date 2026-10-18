import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';

const root = tempDir('github-actions-dispatch-intent-config-binding-');
process.env.WORKFLOW_DB = path.join(root, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = root;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';
const { WorkflowStore } = await import('../src/runtime/job-store.js');
const { GitHubActionsProvider } = await import('../src/runtime/github-actions-provider.js');
const { DistributedScheduler } = await import('../src/runtime/distributed-scheduler.js');
const { canonicalProviderDispatchRequest, createProviderDispatchIdentity, providerDispatchConfig, providerDispatchKey } = await import('../src/runtime/provider-dispatch-identity.js');
const store = new WorkflowStore();
process.on('exit', () => {
  try { store.db.close(); } catch {}
});

function ensureFixtureLease(request) {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  store.db.prepare(`INSERT OR IGNORE INTO jobs
    (job_id,conversation_key,title,state,status,created_at,updated_at)
    VALUES(?,?,?,'active','active',?,?)`)
    .run(request.job_id, `fixture-${request.job_id}`, 'dispatch identity lease fixture', now, now);
  store.db.prepare(`INSERT OR IGNORE INTO tasks
    (task_id,job_id,role,description,status,dependency_json,metadata_json,created_at,updated_at)
    VALUES(?,?,?,'dispatch identity lease fixture','running','[]','{}',?,?)`)
    .run(request.task_id, request.job_id, request.role || 'engineer', now, now);
  store.db.prepare(`INSERT OR IGNORE INTO task_leases
    (lease_id,task_id,job_id,attempt,worker_id,owner_epoch,state,issued_at,heartbeat_at,expires_at)
    VALUES(?,?,?,?,?,?,'ACTIVE',?,?,?)`)
    .run(request.lease_id, request.task_id, request.job_id, request.attempt, 'dispatch-identity-fixture',
      request.owner_epoch, now, now, expires);
}
const input = {
  schema_version: 1,
  job_id: 'job-cross-config',
  task_id: 'task-cross-config',
  lease_id: 'lease-cross-config',
  attempt: 2,
  owner_epoch: 7,
  role: 'engineer',
  input_commit: 'ee24280441c2cf2d8ae4d706a295c90f8fef7bd6',
  task_payload_ref: 'task://cross-config',
  workspace: 'ephemeral',
  required_evidence: ['result.json']
};
ensureFixtureLease(input);
const reservedConfig = {
  provider: 'github-actions', api_base: 'https://api.github.com', workflow: 'p3-worker.yml', repository: 'example/repo',
  event: 'workflow_dispatch', ref: 'main'
};
const reservedIdentity = createProviderDispatchIdentity(input, reservedConfig);
const dispatchKey = providerDispatchKey(reservedIdentity);
const createdAt = new Date().toISOString();

// Every field in the durable execution-request contract participates in the
// request digest. Semantically different complete requests must not collapse
// onto one dispatch key even when their job/lease tuple is otherwise shared.
for (const [field, value] of [
  ['schema_version', 2],
  ['job_id', `${input.job_id}-different`],
  ['task_id', `${input.task_id}-different`],
  ['lease_id', `${input.lease_id}-different`],
  ['attempt', input.attempt + 1],
  ['owner_epoch', input.owner_epoch + 1],
  ['role', 'reviewer'],
  ['input_commit', 'aa24280441c2cf2d8ae4d706a295c90f8fef7bd6'],
  ['task_payload_ref', 'task://different-payload'],
  ['workspace', 'different-workspace'],
  ['required_evidence', ['different-evidence.json']],
  ['task_payload_inline', { schema_version: 1, command: 'different-command' }]
]) {
  assert.notEqual(providerDispatchKey(createProviderDispatchIdentity({ ...input, [field]: value }, reservedConfig)), dispatchKey,
    `complete execution request field ${field} must affect the dispatch key`);
}

// Model a durable, fully bound intent created by a scheduler configured for
// p3-worker.yml. A second provider configured for a different workflow must
// reject this identity before any network call.
new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async () => { throw new Error('schema bootstrap must not dispatch'); }
});
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
  .run(dispatchKey, input.job_id, input.task_id, input.lease_id, input.attempt, input.owner_epoch, 'github-actions', input.input_commit,
    reservedIdentity.request_sha256, canonicalProviderDispatchRequest(input), reservedConfig.api_base, reservedConfig.workflow, reservedConfig.repository, reservedConfig.event, reservedConfig.ref, createdAt, createdAt);

let remoteDispatchCalls = 0;
const differentlyConfiguredProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker-alternate.yml', ref: 'main', store,
  fetchImpl: async (url, options = {}) => {
    remoteDispatchCalls++;
    if (url.endsWith('/dispatches') && options.method === 'POST') {
      return new Response(JSON.stringify({ workflow_run_id: 88991 }), { status: 200 });
    }
    if (url.endsWith('/actions/runs/88991')) {
      return new Response(JSON.stringify({
        id: 88991,
        status: 'in_progress',
        conclusion: null,
        run_attempt: 1,
        head_sha: input.input_commit,
        path: '.github/workflows/p3-worker-alternate.yml@refs/heads/main',
        event: 'workflow_dispatch',
        head_branch: 'main',
        repository: { full_name: 'example/repo' },
        display_title: `P3 worker ${dispatchKey}`,
        created_at: createdAt,
        html_url: 'https://github.com/example/repo/actions/runs/88991'
      }), { status: 200 });
    }
    throw new Error(`unexpected mocked provider request ${url}`);
  }
});

await assert.rejects(
  () => differentlyConfiguredProvider.dispatch({ ...input, dispatch_key: dispatchKey }),
  /durable provider dispatch intent does not match exact workflow binding/i,
  'an intent reserved for p3-worker.yml must not authorize dispatch through p3-worker-alternate.yml'
);
assert.equal(remoteDispatchCalls, 0, 'provider configuration mismatch must be detected before the remote dispatch boundary');

// The resolved commit is normalized to lowercase for GitHub, but the immutable
// request digest must remain bound to the original canonical request bytes.
// This local 422 response proves identity validation reaches the intended
// pre-send boundary without treating normalization as request substitution.
const uppercaseRequest = {
  ...input,
  job_id: `${input.job_id}-uppercase-commit`,
  task_id: `${input.task_id}-uppercase-commit`,
  lease_id: `${input.lease_id}-uppercase-commit`,
  input_commit: input.input_commit.toUpperCase()
};
const uppercaseIdentity = createProviderDispatchIdentity(uppercaseRequest, reservedConfig);
const uppercaseKey = providerDispatchKey(uppercaseIdentity);
ensureFixtureLease(uppercaseRequest);
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
  .run(uppercaseKey, uppercaseIdentity.job_id, uppercaseIdentity.task_id, uppercaseIdentity.lease_id,
    uppercaseIdentity.attempt, uppercaseIdentity.owner_epoch, uppercaseIdentity.provider, uppercaseIdentity.input_commit,
    uppercaseIdentity.request_sha256, canonicalProviderDispatchRequest(uppercaseRequest), uppercaseIdentity.api_base,
    uppercaseIdentity.workflow, uppercaseIdentity.repository, uppercaseIdentity.event, uppercaseIdentity.ref, createdAt, createdAt);
let uppercasePostCalls = 0;
let uppercasePostBody;
const uppercaseProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async (url, options = {}) => {
    if (String(url).endsWith('/dispatches') && options.method === 'POST') {
      uppercasePostCalls++;
      uppercasePostBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ message: 'local pre-send rejection fixture' }), { status: 422 });
    }
    throw new Error(`unexpected uppercase-commit fixture request ${url}`);
  }
});
await assert.rejects(() => uppercaseProvider.dispatch({ ...uppercaseRequest, dispatch_key: uppercaseKey }), /GitHub API 422/,
  'uppercase but valid commit IDs must preserve the original request digest through dispatch identity checks');
assert.equal(uppercasePostCalls, 1, 'the uppercase-commit fixture must reach only its local mocked POST');
assert.equal(uppercasePostBody.inputs.input_commit, uppercaseRequest.input_commit.toLowerCase(),
  'the remote execution input uses canonical lowercase commit bytes');
const uppercaseDurable = store.db.prepare('SELECT dispatch_claim_id,request_sha256,request_json FROM provider_dispatch_intents WHERE dispatch_key=?').get(uppercaseKey);
assert.equal(uppercaseDurable.dispatch_claim_id, null, 'a definite mocked pre-send rejection may release its own send claim');
assert.equal(uppercaseDurable.request_sha256, uppercaseIdentity.request_sha256, 'request digest remains immutable after normalized commit resolution');
assert.equal(uppercaseDurable.request_json, canonicalProviderDispatchRequest(uppercaseRequest), 'durable request bytes remain unchanged after pre-send rejection');

// The request object is caller-owned and can be mutated while commit
// resolution is pending. The provider must snapshot its exact canonical bytes
// synchronously, then send only that snapshot after validating the durable
// intent. This fixture uses a local fetch mock and never reaches GitHub.
let releaseCommitResolution;
const commitResolutionGate = new Promise(resolve => { releaseCommitResolution = resolve; });
let capturedDispatchBody = null;
let mutationFetchCalls = 0;
const mutationProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async (url, options = {}) => {
    mutationFetchCalls++;
    if (url.endsWith('/dispatches') && options.method === 'POST') {
      capturedDispatchBody = JSON.parse(options.body);
    }
    throw new Error('isolated mutation fixture: transport result intentionally ambiguous');
  }
});
mutationProvider.resolveCommit = async commit => { await commitResolutionGate; return commit.toLowerCase(); };
const mutableRequest = { ...input, dispatch_key: dispatchKey };
const mutationDispatch = mutationProvider.dispatch(mutableRequest);
mutableRequest.role = 'architect';
releaseCommitResolution();
const mutationOutcome = await mutationDispatch;
assert.ok(mutationFetchCalls >= 1, 'the canonical original request should reach the local provider mock');
assert.equal(capturedDispatchBody?.inputs?.role, 'engineer',
  'mutation during asynchronous commit resolution must not substitute the authorized role in the sent body');
assert.equal(mutationOutcome?.pending_reconciliation, true,
  'an ambiguous mocked provider effect remains reconciliation-only rather than being replayed');

// A provider-owned/injected callback can mutate destination configuration
// after the first durable-intent check. The final pre-send boundary must
// detect this substitution, release only its not-sent claim, and never call
// the mocked transport.
const destinationRaceInput = {
  ...input,
  job_id: 'job-destination-callback-race',
  task_id: 'task-destination-callback-race',
  lease_id: 'lease-destination-callback-race'
};
const destinationRaceIdentity = createProviderDispatchIdentity(destinationRaceInput, reservedConfig);
const destinationRaceKey = providerDispatchKey(destinationRaceIdentity);
ensureFixtureLease(destinationRaceInput);
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
  .run(destinationRaceKey, destinationRaceInput.job_id, destinationRaceInput.task_id, destinationRaceInput.lease_id,
    destinationRaceInput.attempt, destinationRaceInput.owner_epoch, 'github-actions', destinationRaceInput.input_commit,
    destinationRaceIdentity.request_sha256, canonicalProviderDispatchRequest(destinationRaceInput), reservedConfig.api_base,
    reservedConfig.workflow, reservedConfig.repository, reservedConfig.event, reservedConfig.ref, createdAt, createdAt);
let destinationRaceProvider;
let destinationRaceNowCalls = 0;
let destinationRaceFetchCalls = 0;
destinationRaceProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  now: () => {
    destinationRaceNowCalls++;
    if (destinationRaceNowCalls === 1) destinationRaceProvider.ref = 'release';
    return Date.now();
  },
  fetchImpl: async () => {
    destinationRaceFetchCalls++;
    throw new Error('destination mutation crossed the external boundary');
  }
});
await assert.rejects(
  () => destinationRaceProvider.dispatch({ ...destinationRaceInput, dispatch_key: destinationRaceKey }),
  /durable provider dispatch intent does not match exact ref binding/,
  'destination mutation after claim timestamp generation must be caught at the last pre-send boundary'
);
assert.equal(destinationRaceFetchCalls, 0, 'destination substitution must not invoke fetch even once');
const destinationRaceDurable = store.db.prepare('SELECT state,provider_run_id,dispatch_claim_id,dispatch_claimed_at FROM provider_dispatch_intents WHERE dispatch_key=?').get(destinationRaceKey);
assert.equal(destinationRaceDurable.state, 'DISPATCHING');
assert.equal(destinationRaceDurable.provider_run_id, null);
assert.equal(destinationRaceDurable.dispatch_claim_id, null,
  'a verified pre-send configuration mismatch may release only the claim it just created');
assert.equal(destinationRaceDurable.dispatch_claimed_at, null,
  'the released not-sent claim must not leave a misleading remote-send timestamp');

// A callback can mutate provider destination while the final lease timestamp
// is being sampled. That callback must run before the last identity check,
// never between the check and the POST. This is distinct from mutation during
// claim timestamp creation above: it targets the final pre-send clock call.
const finalClockRaceInput = {
  ...input,
  job_id: 'job-final-clock-callback-race',
  task_id: 'task-final-clock-callback-race',
  lease_id: 'lease-final-clock-callback-race'
};
const finalClockRaceIdentity = createProviderDispatchIdentity(finalClockRaceInput, reservedConfig);
const finalClockRaceKey = providerDispatchKey(finalClockRaceIdentity);
ensureFixtureLease(finalClockRaceInput);
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
  .run(finalClockRaceKey, finalClockRaceInput.job_id, finalClockRaceInput.task_id, finalClockRaceInput.lease_id,
    finalClockRaceInput.attempt, finalClockRaceInput.owner_epoch, 'github-actions', finalClockRaceInput.input_commit,
    finalClockRaceIdentity.request_sha256, canonicalProviderDispatchRequest(finalClockRaceInput), reservedConfig.api_base,
    reservedConfig.workflow, reservedConfig.repository, reservedConfig.event, reservedConfig.ref, createdAt, createdAt);
let finalClockRaceProvider;
let finalClockCalls = 0;
let finalClockFetchCalls = 0;
finalClockRaceProvider = new GitHubActionsProvider({
  token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
  now: () => {
    finalClockCalls++;
    // First call timestamps the durable claim; second call is the last
    // pre-send lease check. Mutate exactly in that second callback.
    if (finalClockCalls === 2) finalClockRaceProvider.repo = 'substituted';
    return Date.now();
  },
  fetchImpl: async () => {
    finalClockFetchCalls++;
    throw new Error('final clock destination mutation crossed the transport boundary');
  }
});
await assert.rejects(
  () => finalClockRaceProvider.dispatch({ ...finalClockRaceInput, dispatch_key: finalClockRaceKey }),
  /durable provider dispatch intent does not match exact repository binding/,
  'destination mutation inside the final lease-clock callback must be caught before transport'
);
assert.equal(finalClockFetchCalls, 0, 'the final lease-clock callback must not substitute the dispatch destination');
const finalClockRaceDurable = store.db.prepare('SELECT dispatch_claim_id,dispatch_claimed_at,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(finalClockRaceKey);
assert.equal(finalClockRaceDurable.dispatch_claim_id, null, 'verified not-sent destination mutation releases only its own claim');
assert.equal(finalClockRaceDurable.dispatch_claimed_at, null, 'verified not-sent destination mutation clears its claim timestamp');
assert.equal(finalClockRaceDurable.provider_run_id, null, 'destination mutation must not bind a provider run');

for (const changedBoundary of ['token', 'fetch', 'request', 'headers']) {
  const requestForRace = {
    ...input,
    job_id: `job-dispatch-${changedBoundary}-race`,
    task_id: `task-dispatch-${changedBoundary}-race`,
    lease_id: `lease-dispatch-${changedBoundary}-race`
  };
  const raceIdentity = createProviderDispatchIdentity(requestForRace, reservedConfig);
  const raceKey = providerDispatchKey(raceIdentity);
  ensureFixtureLease(requestForRace);
  store.db.prepare(`INSERT INTO provider_dispatch_intents
    (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?)`)
    .run(raceKey, requestForRace.job_id, requestForRace.task_id, requestForRace.lease_id, requestForRace.attempt,
      requestForRace.owner_epoch, 'github-actions', requestForRace.input_commit, raceIdentity.request_sha256,
      canonicalProviderDispatchRequest(requestForRace), reservedConfig.api_base, reservedConfig.workflow,
      reservedConfig.repository, reservedConfig.event, reservedConfig.ref, createdAt, createdAt);
  let raceProvider;
  let originalTransportCalls = 0;
  let substitutedTransportCalls = 0;
  let mutationApplied = false;
  raceProvider = new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
    now: () => {
      if (!mutationApplied) {
        mutationApplied = true;
        if (changedBoundary === 'token') raceProvider.token = 'substituted-authentication-principal';
        else if (changedBoundary === 'fetch') raceProvider.fetch = async () => { substitutedTransportCalls++; throw new Error('substituted transport reached'); };
        else if (changedBoundary === 'request') raceProvider.request = async () => { substitutedTransportCalls++; throw new Error('substituted request pipeline reached'); };
        else raceProvider.headers = () => { substitutedTransportCalls++; return { authorization: 'Bearer substituted' }; };
      }
      return Date.now();
    },
    fetchImpl: async () => { originalTransportCalls++; throw new Error('original transport must not be invoked'); }
  });
  await assert.rejects(
    () => raceProvider.dispatch({ ...requestForRace, dispatch_key: raceKey }),
    /authentication credential, request pipeline, or transport changed/,
    `${changedBoundary} substitution after durable claim creation must fail before fetch`
  );
  assert.equal(originalTransportCalls, 0, `original transport must not be called for ${changedBoundary} substitution`);
  assert.equal(substitutedTransportCalls, 0, `substituted transport must not be called for ${changedBoundary} substitution`);
  const raceRow = store.db.prepare('SELECT dispatch_claim_id,dispatch_claimed_at,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(raceKey);
  assert.equal(raceRow.dispatch_claim_id, null, `proven not-sent ${changedBoundary} substitution must release its own claim`);
  assert.equal(raceRow.dispatch_claimed_at, null, `proven not-sent ${changedBoundary} substitution must clear its claim timestamp`);
  assert.equal(raceRow.provider_run_id, null, `no run may be bound for not-sent ${changedBoundary} substitution`);
}

const modifiedRequest = {
  ...input,
  role: 'architect',
  task_payload_ref: 'task://substituted-payload',
  required_evidence: ['unapproved.txt'],
  task_payload_inline: {
    schema_version: 1, job_id: input.job_id, task_id: input.task_id, role: 'architect',
    required_evidence: ['execution.json'], command: 'true', instructions: 'different authorized work'
  }
};
const modifiedIdentity = createProviderDispatchIdentity(modifiedRequest, reservedConfig);
assert.notEqual(providerDispatchKey(modifiedIdentity), dispatchKey,
  'dispatch identity/key must include the canonical complete execution request, not only task/lease/commit');
assert.throws(() => store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,provider,input_commit,request_sha256,api_base,workflow,repository,event,ref,state,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',?,?)`).run(
    providerDispatchKey(modifiedIdentity), modifiedIdentity.job_id, modifiedIdentity.task_id, modifiedIdentity.lease_id,
    modifiedIdentity.attempt, modifiedIdentity.provider, modifiedIdentity.input_commit, modifiedIdentity.request_sha256,
    modifiedIdentity.api_base, modifiedIdentity.workflow, modifiedIdentity.repository, modifiedIdentity.event, modifiedIdentity.ref,
    createdAt, createdAt), /UNIQUE constraint failed/,
  'SQLite must prevent a competing intent key for the same immutable task/lease/attempt tuple');
assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM provider_dispatch_intents WHERE job_id=? AND task_id=? AND lease_id=? AND attempt=? AND provider=?')
  .get(input.job_id, input.task_id, input.lease_id, input.attempt, 'github-actions').n, 1);
for (const [field, value] of [
  ['owner_epoch', input.owner_epoch + 1],
  ['role', 'reviewer'],
  ['task_payload_ref', 'task://different-reference'],
  ['workspace', 'different-workspace'],
  ['required_evidence', ['different-result.json']],
  ['task_payload_inline', { instructions: 'other instructions', role: 'architect' }]
]) {
  assert.notEqual(providerDispatchKey(createProviderDispatchIdentity({ ...input, [field]: value }, reservedConfig)), dispatchKey,
    `${field} changes must alter the dispatch identity independently`);
}
const reorderedEquivalent = Object.fromEntries(Object.entries(modifiedRequest).reverse());
reorderedEquivalent.task_payload_inline = Object.fromEntries(Object.entries(modifiedRequest.task_payload_inline).reverse());
assert.equal(providerDispatchKey(createProviderDispatchIdentity(reorderedEquivalent, reservedConfig)), providerDispatchKey(modifiedIdentity),
  'canonical request identity must not depend on object insertion order, including nested objects');
for (const attempt of ['2', true, 2n, -0, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => createProviderDispatchIdentity({ ...input, attempt }, reservedConfig), /invalid attempt/,
    `attempt identity must require a positive safe integer number, got ${String(attempt)}`);
}
assert.throws(() => createProviderDispatchIdentity({ ...input, input_commit: 123 }, reservedConfig), /invalid input_commit/,
  'input commit identity must not coerce non-string values');
const sparseEvidence = ['result.json'];
sparseEvidence.length = 2;
assert.throws(() => canonicalProviderDispatchRequest({ ...input, required_evidence: sparseEvidence }), /sparse array entry/,
  'sparse arrays must not canonicalize to malformed or ambiguous JSON bytes');
const undefinedEvidence = ['result.json', undefined];
assert.throws(() => canonicalProviderDispatchRequest({ ...input, required_evidence: undefinedEvidence }), /not JSON-safe/,
  'undefined array values must not disappear from canonical identity bytes');
const accessorRequest = { ...input };
Object.defineProperty(accessorRequest, 'role', { enumerable: true, get() { throw new Error('accessor executed'); } });
assert.throws(() => canonicalProviderDispatchRequest(accessorRequest), /not an enumerable data property/,
  'identity canonicalization must reject accessors without invoking them');
let identityGetterCalls = 0;
const identityAccessorRequest = { ...input };
Object.defineProperty(identityAccessorRequest, 'job_id', {
  enumerable: true,
  get() { identityGetterCalls++; return input.job_id; }
});
assert.throws(() => createProviderDispatchIdentity(identityAccessorRequest, reservedConfig), /not an enumerable data property/,
  'identity construction must canonicalize before reading identity-bearing request fields');
assert.equal(identityGetterCalls, 0, 'request accessors must never run while constructing a dispatch identity');
let configGetterCalls = 0;
const accessorConfig = { ...reservedConfig };
Object.defineProperty(accessorConfig, 'workflow', {
  enumerable: true,
  get() { configGetterCalls++; return reservedConfig.workflow; }
});
assert.throws(() => providerDispatchConfig(accessorConfig), /workflow must be an enumerable data property/,
  'provider destination configuration must reject accessor-backed identity fields');
assert.equal(configGetterCalls, 0, 'provider configuration accessors must never execute during identity binding');
assert.throws(() => createProviderDispatchIdentity(input, accessorConfig), /workflow must be an enumerable data property/,
  'direct identity construction must also reject accessor-backed destination fields');
assert.equal(configGetterCalls, 0, 'direct identity construction must not execute configuration accessors');
const symbolRequest = { ...input, [Symbol('hidden')]: 'unbound' };
assert.throws(() => canonicalProviderDispatchRequest(symbolRequest), /symbol-keyed properties/,
  'symbol-keyed identity fields must not be silently ignored');
await assert.rejects(
  () => new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
    fetchImpl: async () => { remoteDispatchCalls++; throw new Error('modified execution request reached the remote boundary'); }
  }).dispatch({ ...modifiedRequest, dispatch_key: dispatchKey }),
  /request_sha256|required_evidence must exactly match/,
  'a payload/role/evidence substitution must not reuse the original durable intent'
);
assert.equal(remoteDispatchCalls, 0, 'request binding mismatch must be rejected before fetch');
await assert.rejects(
  () => new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
    fetchImpl: async () => { remoteDispatchCalls++; throw new Error('unsupported field reached remote boundary'); }
  }).dispatch({ ...input, dispatch_key: 'f'.repeat(64), unbound_security_field: true }),
  /unsupported field unbound_security_field/,
  'the dispatcher must reject unknown request properties before hashing or sending'
);
assert.equal(remoteDispatchCalls, 0, 'unknown request properties must not reach the remote boundary');

for (const scenario of [
  { field: 'provider', mutate: provider => { provider.providerName = 'another-provider'; } },
  { field: 'repository', mutate: provider => { provider.owner = 'another-owner'; } },
  { field: 'api_base', mutate: provider => { provider.apiBase = 'https://enterprise.example/api/v3'; } },
  { field: 'event', mutate: provider => { provider.event = 'push'; } },
  { field: 'ref', mutate: provider => { provider.ref = 'release'; } }
]) {
  let scenarioCalls = 0;
  const provider = new GitHubActionsProvider({
    token: 'test-token', owner: 'example', repo: 'repo', workflow: 'p3-worker.yml', ref: 'main', store,
    fetchImpl: async () => { scenarioCalls++; return new Response(null, { status: 204 }); }
  });
  scenario.mutate(provider);
  await assert.rejects(
    () => provider.dispatch({ ...input, dispatch_key: dispatchKey }),
    new RegExp(`durable provider dispatch intent does not match exact ${scenario.field} binding`),
    `intent must bind exact ${scenario.field} configuration`
  );
  assert.equal(scenarioCalls, 0, `${scenario.field} mismatch must fail before fetch`);
}

// Recovery of a claimed intent is lookup-only, but lookup still sends the
// bearer token. A restarted provider with a changed API origin must fail
// closed before issuing any authenticated request to that origin.
const recoveryDriftInput = {
  ...input,
  job_id: 'job-claimed-recovery-origin-drift',
  task_id: 'task-claimed-recovery-origin-drift',
  lease_id: 'lease-claimed-recovery-origin-drift'
};
ensureFixtureLease(recoveryDriftInput);
const recoveryDriftIdentity = createProviderDispatchIdentity(recoveryDriftInput, reservedConfig);
const recoveryDriftKey = providerDispatchKey(recoveryDriftIdentity);
const recoveryClaimedAt = new Date().toISOString();
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,dispatch_claim_id,dispatch_claimed_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',NULL,?,?,?,?)`)
  .run(recoveryDriftKey, recoveryDriftInput.job_id, recoveryDriftInput.task_id, recoveryDriftInput.lease_id,
    recoveryDriftInput.attempt, recoveryDriftInput.owner_epoch, 'github-actions', recoveryDriftInput.input_commit,
    recoveryDriftIdentity.request_sha256, canonicalProviderDispatchRequest(recoveryDriftInput), reservedConfig.api_base,
    reservedConfig.workflow, reservedConfig.repository, reservedConfig.event, reservedConfig.ref,
    `claim-${recoveryDriftKey.slice(0, 12)}`, recoveryClaimedAt, recoveryClaimedAt, recoveryClaimedAt);
let recoveryDriftFetchCalls = 0;
const driftedRecoveryProvider = new GitHubActionsProvider({
  token: 'test-token-must-not-leak', owner: 'example', repo: 'repo',
  apiBase: 'https://attacker.example/api/v3', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async (url, options = {}) => {
    recoveryDriftFetchCalls++;
    throw new Error(`unexpected authenticated recovery request to ${url} with ${options.headers?.authorization}`);
  }
});
const driftRecoveryResults = await new DistributedScheduler({ store, provider: driftedRecoveryProvider })
  .reconcileProviderDispatches();
const driftRecovery = driftRecoveryResults.find(item => item.dispatchKey === recoveryDriftKey);
assert.equal(driftRecovery?.status, 'RECONCILIATION_ERROR');
assert.match(driftRecovery?.error || '', /exact api_base binding/);
assert.equal(recoveryDriftFetchCalls, 0,
  'claimed-intent recovery must not send the bearer token to a substituted API origin');

// A valid DISPATCHED ledger must also bind authenticated status polling to the
// original API origin. Checking run metadata after the GET is too late: a
// restarted provider configured for another origin would already disclose its
// bearer token. Exercise getStatus against the real SQLite ledger boundary.
const statusDriftInput = {
  ...input,
  job_id: 'job-status-origin-drift',
  task_id: 'task-status-origin-drift',
  lease_id: 'lease-status-origin-drift'
};
ensureFixtureLease(statusDriftInput);
const statusDriftIdentity = createProviderDispatchIdentity(statusDriftInput, reservedConfig);
const statusDriftKey = providerDispatchKey(statusDriftIdentity);
const statusDriftRunId = '918273645';
const statusDriftAt = new Date().toISOString();
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,dispatch_claim_id,dispatch_claimed_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHED',?,?,?,?,?)`)
  .run(statusDriftKey, statusDriftInput.job_id, statusDriftInput.task_id, statusDriftInput.lease_id,
    statusDriftInput.attempt, statusDriftInput.owner_epoch, 'github-actions', statusDriftInput.input_commit,
    statusDriftIdentity.request_sha256, canonicalProviderDispatchRequest(statusDriftInput), reservedConfig.api_base,
    reservedConfig.workflow, reservedConfig.repository, reservedConfig.event, reservedConfig.ref,
    statusDriftRunId, `claim-${statusDriftKey.slice(0, 12)}`, statusDriftAt, statusDriftAt, statusDriftAt);
store.db.prepare(`INSERT INTO provider_runs
  (provider_run_id,provider,job_id,task_id,lease_id,attempt,owner_epoch,input_commit,dispatch_key,request_sha256,workflow,ref,state,conclusion,html_url,artifact_id,output_commit,run_attempt,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'RUNNING',NULL,NULL,NULL,NULL,1,?,?)`)
  .run(statusDriftRunId, 'github-actions', statusDriftInput.job_id, statusDriftInput.task_id, statusDriftInput.lease_id,
    statusDriftInput.attempt, statusDriftInput.owner_epoch, statusDriftInput.input_commit, statusDriftKey,
    statusDriftIdentity.request_sha256, reservedConfig.workflow, reservedConfig.ref, statusDriftAt, statusDriftAt);
let statusDriftFetchCalls = 0;
const driftedStatusProvider = new GitHubActionsProvider({
  token: 'test-token-must-not-leak-from-status-poll', owner: 'example', repo: 'repo',
  apiBase: 'https://attacker.example/api/v3', workflow: 'p3-worker.yml', ref: 'main', store,
  fetchImpl: async url => {
    statusDriftFetchCalls++;
    throw new Error(`unexpected authenticated status request to ${url}`);
  }
});
await assert.rejects(() => driftedStatusProvider.getStatus(statusDriftRunId), /exact api_base binding/,
  'P3 status polling must reject a substituted authenticated API origin before the first GET');
assert.equal(statusDriftFetchCalls, 0,
  'P3 status polling must not disclose the bearer token to a destination different from the durable dispatch intent');

// The first authenticated status fetch may itself be awaited while provider
// configuration is modified by a competing callback/operator. collectResult
// then performs artifact-list and archive requests; the old one-time guard in
// getStatus did not cover those later boundaries. Simulate origin drift after
// the valid status response and prove the artifact request is stopped before a
// bearer-bearing fetch is issued to the substituted host.
const collectDriftInput = {
  ...input,
  job_id: 'job-collect-origin-drift',
  task_id: 'task-collect-origin-drift',
  lease_id: 'lease-collect-origin-drift'
};
ensureFixtureLease(collectDriftInput);
const collectDriftIdentity = createProviderDispatchIdentity(collectDriftInput, reservedConfig);
const collectDriftKey = providerDispatchKey(collectDriftIdentity);
const collectDriftRunId = '918273646';
const collectDriftAt = new Date().toISOString();
store.db.prepare(`INSERT INTO provider_dispatch_intents
  (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,provider_run_id,dispatch_claim_id,dispatch_claimed_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHED',?,?,?,?,?)`)
  .run(collectDriftKey, collectDriftInput.job_id, collectDriftInput.task_id, collectDriftInput.lease_id,
    collectDriftInput.attempt, collectDriftInput.owner_epoch, 'github-actions', collectDriftInput.input_commit,
    collectDriftIdentity.request_sha256, canonicalProviderDispatchRequest(collectDriftInput), reservedConfig.api_base,
    reservedConfig.workflow, reservedConfig.repository, reservedConfig.event, reservedConfig.ref,
    collectDriftRunId, `claim-${collectDriftKey.slice(0, 12)}`, collectDriftAt, collectDriftAt, collectDriftAt);
store.db.prepare(`INSERT INTO provider_runs
  (provider_run_id,provider,job_id,task_id,lease_id,attempt,owner_epoch,input_commit,dispatch_key,request_sha256,workflow,ref,state,conclusion,html_url,artifact_id,output_commit,run_attempt,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'RUNNING',NULL,NULL,NULL,NULL,1,?,?)`)
  .run(collectDriftRunId, 'github-actions', collectDriftInput.job_id, collectDriftInput.task_id, collectDriftInput.lease_id,
    collectDriftInput.attempt, collectDriftInput.owner_epoch, collectDriftInput.input_commit, collectDriftKey,
    collectDriftIdentity.request_sha256, reservedConfig.workflow, reservedConfig.ref, collectDriftAt, collectDriftAt);
const collectDriftFetchUrls = [];
let collectDriftProvider;
collectDriftProvider = new GitHubActionsProvider({
  token: 'collection-token-must-not-leak', owner: 'example', repo: 'repo', apiBase: reservedConfig.api_base,
  workflow: reservedConfig.workflow, ref: reservedConfig.ref, store,
  fetchImpl: async url => {
    collectDriftFetchUrls.push(String(url));
    if (String(url).endsWith(`/actions/runs/${collectDriftRunId}`)) {
      // Mutate configuration before resolving the in-flight response. The
      // following artifact-list request must independently rebind its origin.
      collectDriftProvider.apiBase = 'https://attacker.example/api/v3';
      return new Response(JSON.stringify({
        id: Number(collectDriftRunId), status: 'completed', conclusion: 'failure', run_attempt: 1,
        head_sha: collectDriftInput.input_commit, path: '.github/workflows/p3-worker.yml@refs/heads/main',
        event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'example/repo' },
        display_title: `P3 worker ${collectDriftKey}`, created_at: collectDriftAt,
        html_url: `https://github.com/example/repo/actions/runs/${collectDriftRunId}`
      }), { status: 200 });
    }
    throw new Error(`unexpected authenticated collection fetch ${url}`);
  }
});
await assert.rejects(() => collectDriftProvider.collectResult(collectDriftRunId), /exact api_base binding/,
  'collectResult must reject API-origin drift after status polling and before artifact listing');
assert.equal(collectDriftFetchUrls.length, 1, 'no second fetch may be issued after the legitimate status response');
assert.match(collectDriftFetchUrls[0], /^https:\/\/api\.github\.com\/repos\/example\/repo\/actions\/runs\//);
assert.ok(collectDriftFetchUrls.every(url => !url.startsWith('https://attacker.example/')),
  'collection must never send the bearer token to the substituted API origin');

// The same guard must execute on every page, not just at collection entry. A
// first page of exactly 100 rows forces the pagination loop to request page 2;
// mutation of apiBase in the page-1 response must stop page 2 before fetch.
const paginatedFetchUrls = [];
let paginatedProvider;
paginatedProvider = new GitHubActionsProvider({
  token: 'pagination-token-must-not-leak', owner: 'example', repo: 'repo', apiBase: reservedConfig.api_base,
  workflow: reservedConfig.workflow, ref: reservedConfig.ref, store,
  fetchImpl: async url => {
    paginatedFetchUrls.push(String(url));
    paginatedProvider.apiBase = 'https://attacker.example/api/v3';
    return new Response(JSON.stringify({ workflow_runs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) }), { status: 200 });
  }
});
await assert.rejects(() => paginatedProvider.requestAllPages('/repos/example/repo/actions/workflows/p3-worker.yml/runs', 'workflow_runs', {
  dispatchIntent: collectDriftIdentity ? store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(collectDriftKey) : null
}), /exact api_base binding/,
  'every authenticated pagination page must revalidate the durable destination, not just page 1');
assert.equal(paginatedFetchUrls.length, 1);
assert.match(paginatedFetchUrls[0], /^https:\/\/api\.github\.com\//);
assert.ok(paginatedFetchUrls.every(url => !url.startsWith('https://attacker.example/')));
console.log('github-actions dispatch intent exact-config binding: PASS');
