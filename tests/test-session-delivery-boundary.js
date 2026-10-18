import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-delivery-boundary-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const dbPath = path.join(dataDir, 'workflow.db');
process.env.WORKFLOW_DB = dbPath;
process.env.WORKFLOW_DATA_DIR = dataDir;
process.env.WORKFLOW_WORKSPACE = root;
process.env.NODE_ENV = 'test';
const storeModulePath = path.resolve(process.env.PHASE2_TEST_JOB_STORE_MODULE || fileURLToPath(new URL('../src/runtime/job-store.js', import.meta.url)));
const storeModuleUrl = pathToFileURL(storeModulePath).href;
const { WorkflowStore } = await import(storeModuleUrl);
const store = new WorkflowStore();
process.on('exit', () => {
  try { store.db.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

function makeRecipientSession(label) {
  const job = store.createJob({ conversationKey: `session-delivery-${label}-${process.pid}`, title: `Isolated session delivery ${label}` });
  store.transition(job.job_id, 'PROPOSED');
  store.approve(job.job_id, 'isolated local delivery-boundary test', 'test-fixture', { workspace: root });
  const cto = store.dispatch(job.job_id, { role: 'cto', description: `delivery fixture ${label}` });
  store.attachOpenClawRun(job.job_id, { runId: `delivery-run-${label}-${process.pid}`, sessionKey: `agent:cto:subagent:${label}-${process.pid}` });
  const session = store.getSessionByTask(cto.task_id);
  assert.ok(session);
  store.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'MESSAGE', grantedBy: 'cto' });
  return { job, cto, session };
}

function inspectMessage(messageId) {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    return {
      message: db.prepare('SELECT message_id,session_id,recipient_role,status,attempt,available_at,lease_until,delivered_at,acked_at,last_error FROM session_messages WHERE message_id=?').get(messageId),
      deliveredEvents: db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE type='session.message_delivered' AND json_extract(payload_json,'$.messageId')=? ORDER BY rowid").all(messageId),
      ackEvents: db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE type='session.message_acked' AND json_extract(payload_json,'$.messageId')=? ORDER BY rowid").all(messageId),
      uncertainEvents: db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE type='session.message_delivery_uncertain' AND json_extract(payload_json,'$.messageId')=? ORDER BY rowid").all(messageId),
      receipts: db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE type='session.message_receipt' AND json_extract(payload_json,'$.messageId')=? ORDER BY rowid").all(messageId),
      retries: db.prepare("SELECT event_id,job_id,type,payload_json,created_at FROM events WHERE type='session.message_retry' AND json_extract(payload_json,'$.messageId')=? ORDER BY rowid").all(messageId)
    };
  } finally { db.close(); }
}

async function claimRaceRegression() {
  const { job, session } = makeRecipientSession('claim-race');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'one external delivery only' },
    dedupeKey: 'claim-race-once'
  });
  const barrier = path.join(root, 'claim-race-barrier');
  fs.mkdirSync(barrier, { mode: 0o700 });
  const claimSource = `
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    try {
      const result=s.claimSessionMessage(${JSON.stringify(message.message_id)},{recipientRole:'architect',leaseMs:60000});
      console.log(JSON.stringify({status:result?.status,attempt:result?.attempt,claimAcquired:result?.claimAcquired===true,leaseUntil:result?.lease_until}));
    } finally { s.db.close(); }
  `;
  const children = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', claimSource], {
      cwd: process.cwd(),
      env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir, WORKFLOW_WORKSPACE: root,
        NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_SESSION_CLAIM_BARRIER_DIR: barrier },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; });
    child.stderr.on('data', text => { stderr += text; });
    return { child, done: new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))) };
  });
  try {
    const readyPaths = children.map(({ child }) => path.join(barrier, `${child.pid}.ready`));
    const deadline = Date.now() + 15000;
    while (!readyPaths.every(file => fs.existsSync(file))) {
      if (Date.now() > deadline) throw new Error('both competing session delivery claimants did not reach the pre-update barrier');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    const readyStates = readyPaths.map(file => fs.readFileSync(file, 'utf8'));
    assert.ok(readyStates.every(state => state.includes('|QUEUED|0')),
      `both claimants must have read the same queued attempt before release; ready states=${JSON.stringify(readyStates)}`);
    fs.writeFileSync(path.join(barrier, 'release'), 'release\n', { flag: 'wx', mode: 0o600 });
    const outcomes = await Promise.all(children.map(child => child.done));
    assert.ok(outcomes.every(result => result.code === 0), JSON.stringify(outcomes));
    const claims = outcomes.map(result => JSON.parse(result.stdout.trim()));
    const state = inspectMessage(message.message_id);
    assert.equal(state.message.status, 'DELIVERED');
    assert.equal(state.message.attempt, 1, 'competing claimants must increment the attempt counter exactly once');
    assert.equal(state.deliveredEvents.length, 1, 'competing claimants must persist exactly one delivery-claimed event');
    assert.equal(claims.filter(claim => claim.claimAcquired).length, 1, JSON.stringify(claims));
    assert.equal(claims.filter(claim => !claim.claimAcquired).length, 1, JSON.stringify(claims));
    const transportedEffects = [];
    for (const claim of claims) if (claim.claimAcquired) transportedEffects.push(claim.attempt);
    assert.deepEqual(transportedEffects, [1]);
    console.log('SESSION MESSAGE TWO-PROCESS LEASE/CAS OWNERSHIP RACE PASS');
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function productionDispatchBoundaryRegression() {
  const { session } = makeRecipientSession('production-dispatch-boundary');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'production dispatcher must not pre-claim' },
    dedupeKey: 'production-dispatch-boundary-once'
  });
  let transportCalls = 0;
  const result = await store.deliverNextSessionMessage(session.session_id, {
    recipientRole: 'architect',
    transport: async (_session, delivered, context) => {
      transportCalls++;
      assert.equal(delivered.message_id, message.message_id);
      assert.equal(context.idempotencyKey, message.message_id);
      return { status: 'OK', runId: 'production-dispatch-boundary-run', sessionKey: session.openclaw_session_key, result: 'accepted' };
    },
    deliveryOptions: { timeoutSeconds: 1, retryDelayMs: 0 }
  });
  assert.equal(transportCalls, 1, 'the production dispatch helper must invoke the transport after exactly one claim');
  assert.equal(result.status, 'ACKED');
  assert.equal(store.getSessionMessage(message.message_id).status, 'ACKED');
  const noMore = await store.deliverNextSessionMessage(session.session_id, {
    recipientRole: 'architect', transport: async () => { transportCalls++; return { status: 'OK' }; }
  });
  assert.equal(noMore, null, 'an empty queue must not invoke the transport');
  assert.equal(transportCalls, 1);
  console.log('PRODUCTION SESSION DISPATCH / SINGLE CLAIM / ACTUAL TRANSPORT INVOCATION PASS');
}

async function liveTransportMustOutlastRecoveryLeaseRegression() {
  const { session } = makeRecipientSession('live-transport-lease-deadline');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'a transport running until its configured deadline must not be reaped early' },
    dedupeKey: 'live-transport-lease-deadline-once'
  });
  const transportStarted = path.join(root, 'live-transport-lease-deadline.started');
  const childSource = `
    import fs from 'node:fs';
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    try {
      const result=await s.deliverSessionMessage(${JSON.stringify(message.message_id)}, async (_session, delivered, context) => {
        requireMarker(${JSON.stringify(transportStarted)}, delivered.message_id, context.idempotencyKey);
        await new Promise(resolve=>setTimeout(resolve,5500));
        return {status:'OK',runId:'lease-deadline-valid-receipt',sessionKey:${JSON.stringify(session.openclaw_session_key)},result:'accepted after the configured transport timeout boundary'};
      }, {timeoutSeconds:1,retryDelayMs:0});
      console.log('FINAL_STATUS:'+result.status);
    } finally { s.db.close(); }
    function requireMarker(file,messageId,idempotencyKey) {
      if(messageId!==idempotencyKey) throw new Error('unstable idempotency key');
      fs.writeFileSync(file,'transport-awaiting-valid-receipt',{flag:'wx',mode:0o600});
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const completed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(transportStarted)) {
      if (Date.now() >= deadline) throw new Error(`transport did not cross the durable start boundary: ${stderr}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    // timeoutSeconds=1 still has a 5-second minimum lease, while runOpenClaw's
    // actual timeout is max(5s, timeoutSeconds*1s+5s). Reap just after the
    // shorter lease but before the still-running transport returns its receipt.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5100);
    const reaped = store.retryExpiredSessionMessages({ sessionId: session.session_id, baseDelayMs: 0 });
    assert.equal(reaped, 0, 'a transport still inside its configured timeout must retain a live lease');
    const outcome = await completed;
    assert.equal(outcome.code, 0, `${stderr}\n${stdout}`);
    assert.match(stdout, /FINAL_STATUS:ACKED/);
    const state = inspectMessage(message.message_id);
    assert.equal(state.message.status, 'ACKED');
    assert.equal(state.uncertainEvents.length, 0, 'valid in-deadline receipt must not be quarantined by early lease expiry');
    assert.equal(state.receipts.length, 1);
    assert.equal(state.ackEvents.length, 1);
    console.log('SESSION LIVE TRANSPORT DEADLINE VS CROSS-PROCESS LEASE REAPER PASS');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

async function nonSuccessReceiptMustNotAckRegression() {
  const cases = [
    { label: 'error', receipt: { status: 'ERROR', error: 'remote tool failure' }, expectedStatus: 'ERROR' },
    { label: 'empty', receipt: { status: 'EMPTY' }, expectedStatus: 'EMPTY' },
    { label: 'non-json', receipt: { status: 'NON_JSON', raw: 'plain text without a JSON receipt' }, expectedStatus: 'ERROR' },
    { label: 'null', receipt: null, expectedStatus: 'ERROR' },
    { label: 'missing-status', receipt: {}, expectedStatus: 'ERROR' },
    { label: 'unknown-status', receipt: { status: 'SUCCESS' }, expectedStatus: 'ERROR' }
    ,{ label: 'uncorrelated-success', receipt: { status: 'OK', result: 'looks successful but has no destination identity' }, expectedStatus: 'ERROR' }
    ,{ label: 'session-key-only', receipt: { status: 'OK', sessionKey: 'agent:architect:receipt-only' }, expectedStatus: 'ERROR' }
    ,{ label: 'wrong-session', receipt: { status: 'OK', runId: 'wrong-session-run', sessionKey: 'agent:architect:other-session' }, expectedStatus: 'ERROR' }
    ,{ label: 'numeric-run-id', receipt: { status: 'OK', runId: 73 }, expectedStatus: 'ERROR' }
    ,{ label: 'object-run-id', receipt: { status: 'OK', runId: {} }, expectedStatus: 'ERROR' }
    ,{ label: 'array-run-id', receipt: { status: 'OK', runId: [] }, expectedStatus: 'ERROR' }
    ,{ label: 'blank-run-id', receipt: { status: 'OK', runId: '   ' }, expectedStatus: 'ERROR' }
    ,{ label: 'object-session-key', receipt: { status: 'OK', runId: 'valid-looking-run', sessionKey: {} }, expectedStatus: 'ERROR' }
    ,{ label: 'numeric-session-key', receipt: { status: 'OK', runId: 'valid-looking-run', sessionKey: 17 }, expectedStatus: 'ERROR' }
    ,{ label: 'unknown-status-with-run-id', receipt: { status: 'maybe-success', runId: 'untrusted-status-run' }, expectedStatus: 'ERROR' }
    ,{ label: 'object-status-with-run-id', receipt: { status: { value: 'completed' }, runId: 'object-status-run' }, expectedStatus: 'ERROR' }
  ];
  for (const item of cases) {
    const { session } = makeRecipientSession(`non-success-receipt-${item.label}`);
    const message = store.enqueueSessionMessage(session.session_id, {
      senderRole: 'cto', recipientRole: 'architect', payload: { task: `reject ${item.label} as a success receipt` },
      dedupeKey: `non-success-receipt-${item.label}-once`
    });
    let transportCalls = 0;
    const result = await store.deliverNextSessionMessage(session.session_id, {
      recipientRole: 'architect',
      transport: async () => { transportCalls++; return item.receipt; },
      deliveryOptions: { timeoutSeconds: 1, retryDelayMs: 0 }
    });
    assert.equal(result.status, 'FAILED', `${item.label} receipt must fail closed instead of ACKing the message`);
    assert.match(result.last_error, /^DELIVERY_UNCERTAIN:/);
    assert.equal(transportCalls, 1);
    const state = inspectMessage(message.message_id);
    assert.equal(state.message.status, 'FAILED');
    assert.equal(state.ackEvents.length, 0, `${item.label} receipt must never produce a durable ACK event`);
    assert.equal(state.uncertainEvents.length, 1);
    assert.equal(state.retries.length, 0, 'ambiguous remote outcome must not be automatically replayed');
    assert.equal(state.receipts.length, 1);
    assert.equal(JSON.parse(state.receipts[0].payload_json).status, item.expectedStatus);
    const second = await store.deliverNextSessionMessage(session.session_id, {
      recipientRole: 'architect', transport: async () => { transportCalls++; return { status: 'OK', result: 'unexpected replay' }; }
    });
    assert.equal(second, null, 'uncertain messages are terminal to automatic queue dispatch');
    assert.equal(transportCalls, 1);
  }
  const { session: directSession } = makeRecipientSession('direct-invalid-receipt-contract');
  const directMessage = store.enqueueSessionMessage(directSession.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'exercise the durable receipt API directly' },
    dedupeKey: 'direct-invalid-receipt-contract-once'
  });
  const directClaim = store.claimSessionMessage(directMessage.message_id, { recipientRole: 'architect', leaseMs: 60000 });
  assert.equal(directClaim.claimAcquired, true);
  assert.throws(() => store.recordSessionDeliveryReceipt(directMessage.message_id, {
    attempt: directClaim.attempt, status: 'OK', runId: 73, sessionKey: directSession.openclaw_session_key
  }), /non-empty string runId/, 'the durable receipt writer must reject numeric IDs even if callers bypass the transport parser');
  assert.throws(() => store.recordSessionDeliveryReceipt(directMessage.message_id, {
    attempt: directClaim.attempt, status: 'OK', runId: 'valid-looking-run', sessionKey: {}
  }), /sessionKey must be a non-empty opaque string/, 'the durable receipt writer must reject malformed session identity values');
  store.markSessionMessageDeliveryUncertain(directMessage.message_id, {
    attempt: directClaim.attempt, leaseUntil: directClaim.lease_until, phase: 'direct_invalid_receipt_contract_test',
    error: 'local regression: the transport was not invoked and no successful receipt was persisted'
  });
  console.log('SESSION ERROR/EMPTY/MISSING/MALFORMED RECEIPTS / NO FALSE ACK / NO AUTOMATIC REPLAY PASS');
}

async function replayedRunReceiptMustNotAckAnotherMessageRegression() {
  const { session } = makeRecipientSession('replayed-run-receipt');
  const first = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'first correlated remote turn' }, dedupeKey: 'replayed-run-first'
  });
  const firstResult = await store.deliverSessionMessage(first.message_id, async () => ({
    status: 'OK', runId: 'same-replayed-openclaw-run', sessionKey: session.openclaw_session_key, result: 'accepted'
  }), { retryDelayMs: 0 });
  assert.equal(firstResult.status, 'ACKED');

  const second = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'must not accept replayed remote receipt' }, dedupeKey: 'replayed-run-second'
  });
  const secondResult = await store.deliverSessionMessage(second.message_id, async () => ({
    status: 'OK', runId: 'same-replayed-openclaw-run', sessionKey: session.openclaw_session_key, result: 'replayed prior receipt'
  }), { retryDelayMs: 0 });
  assert.equal(secondResult.status, 'FAILED');
  assert.match(secondResult.last_error, /^DELIVERY_UNCERTAIN:/);
  const state = inspectMessage(second.message_id);
  assert.equal(state.ackEvents.length, 0, 'a run ID already bound to another message cannot ACK this message');
  assert.equal(state.uncertainEvents.length, 1);
  assert.equal(state.retries.length, 0);
  console.log('SESSION REPLAYED OPENCLAW RUN RECEIPT REJECTED / NO FALSE ACK PASS');
}

async function receiptFailureRegression() {
  const { session } = makeRecipientSession('receipt-failure');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'receipt persistence failure after external success' },
    dedupeKey: 'receipt-failure-once'
  });
  const originalReceipt = store.recordSessionDeliveryReceipt.bind(store);
  let failSuccessReceiptOnce = true;
  store.recordSessionDeliveryReceipt = (messageId, receipt) => {
    if (messageId === message.message_id && receipt.status === 'OK' && failSuccessReceiptOnce) {
      failSuccessReceiptOnce = false;
      throw new Error('injected post-transport success receipt persistence failure');
    }
    return originalReceipt(messageId, receipt);
  };
  let externalEffects = 0;
  const idempotencyKeys = [];
  try {
    const first = await store.deliverSessionMessage(message.message_id, async (_session, delivered, context) => {
      externalEffects++;
      idempotencyKeys.push(context?.idempotencyKey ?? null);
      return { status: 'OK', runId: `receipt-side-effect-${externalEffects}`, result: `accepted ${delivered.message_id}` };
    }, { retryDelayMs: 0, maxAttempts: 5 });
    assert.equal(first.status, 'FAILED', 'post-side-effect receipt persistence failure must be explicit and not requeued as a transport failure');
    assert.match(first.last_error, /^DELIVERY_UNCERTAIN:/);
    assert.deepEqual(idempotencyKeys, [message.message_id], 'transport must receive a stable external idempotency key, independent of attempt number');
    assert.equal(externalEffects, 1, 'receipt persistence failure must not cause an immediate automatic second external effect');
    const state = inspectMessage(message.message_id);
    assert.equal(state.message.status, 'FAILED');
    assert.equal(state.uncertainEvents.length, 1);
    assert.equal(state.retries.length, 0, 'an unknown external side-effect outcome must not be automatically retried');
    const second = await store.deliverSessionMessage(message.message_id, async () => {
      externalEffects++;
      return { status: 'OK' };
    }, { retryDelayMs: 0 });
    assert.equal(second.status, 'FAILED');
    assert.equal(externalEffects, 1, 'subsequent delivery calls must not replay uncertain side effects by default');
    console.log('SESSION DELIVERY SUCCESS / RECEIPT-FAILURE UNCERTAIN OUTCOME / NO AUTOMATIC REPLAY PASS');
  } finally { store.recordSessionDeliveryReceipt = originalReceipt; }
}

async function acknowledgementFailureRegression() {
  const { session } = makeRecipientSession('ack-failure');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'ack persistence failure after external success' },
    dedupeKey: 'ack-failure-once'
  });
  const originalAck = store.ackSessionMessage.bind(store);
  let failAckOnce = true;
  store.ackSessionMessage = (messageId, options) => {
    if (messageId === message.message_id && failAckOnce) {
      failAckOnce = false;
      throw new Error('injected ACK persistence failure after external success');
    }
    return originalAck(messageId, options);
  };
  let externalEffects = 0;
  const idempotencyKeys = [];
  try {
    const first = await store.deliverSessionMessage(message.message_id, async (_session, delivered, context) => {
      externalEffects++;
      idempotencyKeys.push(context?.idempotencyKey ?? null);
      return { status: 'OK', runId: `ack-side-effect-${externalEffects}` };
    }, { retryDelayMs: 0 });
    assert.equal(first.status, 'FAILED');
    assert.match(first.last_error, /^DELIVERY_UNCERTAIN:/);
    assert.deepEqual(idempotencyKeys, [message.message_id]);
    assert.equal(externalEffects, 1);
    const state = inspectMessage(message.message_id);
    assert.equal(state.message.status, 'FAILED');
    assert.equal(state.uncertainEvents.length, 1);
    assert.equal(state.ackEvents.length, 0, 'failed ACK write must not leave an ACK event behind');
    assert.equal(state.retries.length, 0);
    assert.equal((await store.deliverSessionMessage(message.message_id, async () => { externalEffects++; return { status: 'OK' }; }, { retryDelayMs: 0 })).status, 'FAILED');
    assert.equal(externalEffects, 1);
    console.log('SESSION DELIVERY SUCCESS / ACK-FAILURE UNCERTAIN OUTCOME / NO AUTOMATIC REPLAY PASS');
  } finally { store.ackSessionMessage = originalAck; }
}

async function claimCrashRollbackRegression() {
  const { session } = makeRecipientSession('claim-crash');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'crash while claim transaction is open' },
    dedupeKey: 'claim-crash-once'
  });
  const childSource = `
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    s.claimSessionMessage(${JSON.stringify(message.message_id)},{recipientRole:'architect',leaseMs:60000});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_CLAIM_EVENT: 'SIGKILL' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL', `claim process must be killed inside its uncommitted savepoint: ${stderr}`);
  const after = inspectMessage(message.message_id);
  assert.equal(after.message.status, 'QUEUED');
  assert.equal(after.message.attempt, 0);
  assert.equal(after.deliveredEvents.length, 0);
  const retried = store.claimSessionMessage(message.message_id, { recipientRole: 'architect', leaseMs: 60000 });
  assert.equal(retried.claimAcquired, true);
  assert.equal(retried.attempt, 1);
  console.log('SESSION MESSAGE CLAIM SIGKILL / SAVEPOINT ROLLBACK / SAFE RETRY PASS');
}

async function uncertainLeaseExpiryRegression() {
  const { session } = makeRecipientSession('external-side-effect-crash');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'remote endpoint accepted but local receipt did not persist' },
    dedupeKey: 'external-side-effect-crash-once'
  });
  const sideEffectPath = path.join(root, 'simulated-external-accepted.txt');
  const childSource = `
    import fs from 'node:fs';
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    await s.deliverSessionMessage(${JSON.stringify(message.message_id)}, async (_session, delivered, context) => {
      if (context.idempotencyKey !== delivered.message_id) throw new Error('unstable external idempotency key');
      fs.writeFileSync(${JSON.stringify(sideEffectPath)}, delivered.message_id, {flag:'wx',mode:0o600});
      process.kill(process.pid, 'SIGKILL');
      return {status:'OK'};
    }, {timeoutSeconds:1});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL', `transport simulation should die after writing the external-side-effect sentinel: ${stderr}`);
  assert.equal(fs.readFileSync(sideEffectPath, 'utf8'), message.message_id,
    'fixture must prove the external side effect happened before local receipt/ACK persistence');
  let state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'DELIVERED');
  assert.equal(state.message.attempt, 1);
  assert.equal(state.deliveredEvents.length, 1);
  assert.equal(state.receipts.length, 0);
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    db.prepare('UPDATE session_messages SET lease_until=? WHERE message_id=?')
      .run(new Date(Date.now() - 1000).toISOString(), message.message_id);
  } finally { db.close(); }
  assert.equal(store.retryExpiredSessionMessages({ sessionId: session.session_id, baseDelayMs: 0 }), 1);
  state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'FAILED', 'expired lease after durable transport-start marker must become uncertain, not queued');
  assert.match(state.message.last_error, /^DELIVERY_UNCERTAIN:/);
  assert.equal(state.uncertainEvents.length, 1);
  assert.equal(state.retries.length, 0, 'unknown external outcome must not become an automatic retry');
  let replayedEffects = 0;
  const recovered = await store.deliverSessionMessage(message.message_id, async () => { replayedEffects++; return { status: 'OK' }; }, { retryDelayMs: 0 });
  assert.equal(recovered.status, 'FAILED');
  assert.equal(replayedEffects, 0, 'recovery must not replay a side effect whose first outcome is unknown');
  assert.equal(fs.readFileSync(sideEffectPath, 'utf8'), message.message_id);
  console.log('SESSION MESSAGE SIGKILL AFTER EXTERNAL EFFECT / UNCERTAIN LEASE RECOVERY / NO DUPLICATE SIDE EFFECT PASS');
}

async function noDirectReclaimAfterTransportStartRegression() {
  const { session } = makeRecipientSession('no-direct-reclaim-after-start');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'direct claimant must honor transport start marker' },
    dedupeKey: 'no-direct-reclaim-after-start-once'
  });
  const sideEffectPath = path.join(root, 'simulated-external-accepted-direct-reclaim.txt');
  const childSource = `
    import fs from 'node:fs';
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    await s.deliverSessionMessage(${JSON.stringify(message.message_id)}, async (_session, delivered) => {
      fs.writeFileSync(${JSON.stringify(sideEffectPath)}, delivered.message_id, {flag:'wx',mode:0o600});
      process.kill(process.pid, 'SIGKILL');
      return {status:'OK'};
    }, {timeoutSeconds:1});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test' }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL', `side-effecting transport must be killed before local receipt: ${stderr}`);
  assert.equal(fs.readFileSync(sideEffectPath, 'utf8'), message.message_id);
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try { db.prepare('UPDATE session_messages SET lease_until=? WHERE message_id=?').run(new Date(Date.now() - 1000).toISOString(), message.message_id); }
  finally { db.close(); }
  const attemptedReclaim = store.claimSessionMessage(message.message_id, { recipientRole: 'architect', leaseMs: 60000 });
  assert.equal(attemptedReclaim.status, 'FAILED', 'a direct claimant must not bypass uncertainty detection and dispatch another external request');
  assert.equal(attemptedReclaim.claimAcquired, false);
  assert.match(attemptedReclaim.last_error, /^DELIVERY_UNCERTAIN:/);
  const state = inspectMessage(message.message_id);
  assert.equal(state.uncertainEvents.length, 1);
  let replayedEffects = 0;
  await store.deliverSessionMessage(message.message_id, async () => { replayedEffects++; return { status: 'OK' }; }, { retryDelayMs: 0 });
  assert.equal(replayedEffects, 0);
  assert.equal(fs.readFileSync(sideEffectPath, 'utf8'), message.message_id);
  console.log('SESSION EXPIRED LEASE DIRECT RECLAIM REFUSED AFTER TRANSPORT START / NO DUPLICATE SIDE EFFECT PASS');
}

async function successfulReceiptCrashRecoveryRegression() {
  const { session } = makeRecipientSession('receipt-commit-crash');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'success receipt persisted before process dies, ACK not yet written' },
    dedupeKey: 'receipt-commit-crash-once'
  });
  const sideEffectPath = path.join(root, 'simulated-external-accepted-receipt-commit.txt');
  const childSource = `
    import fs from 'node:fs';
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    await s.deliverSessionMessage(${JSON.stringify(message.message_id)}, async (_session, delivered, context) => {
      fs.writeFileSync(${JSON.stringify(sideEffectPath)}, JSON.stringify({messageId:delivered.message_id,idempotencyKey:context.idempotencyKey}), {flag:'wx',mode:0o600});
      return {status:'OK',runId:'durable-success-receipt-run',sessionKey:${JSON.stringify(session.openclaw_session_key)},result:'external side effect accepted'};
    }, {timeoutSeconds:1});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RECEIPT_COMMIT: 'SIGKILL' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL', `worker must die after durable success receipt and before ACK: ${stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(sideEffectPath, 'utf8')),
    { messageId: message.message_id, idempotencyKey: message.message_id });
  let state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'DELIVERED');
  assert.equal(state.receipts.length, 1, 'successful receipt must survive the process crash');
  assert.equal(state.ackEvents.length, 0, 'ACK must not be assumed to have committed before the process was killed');
  const pastLease = new Date(Date.now() - 1000).toISOString();
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const startEvent = db.prepare("SELECT event_id,payload_json FROM events WHERE type='session.message_delivery_started' AND json_extract(payload_json,'$.messageId')=?").get(message.message_id);
    assert.ok(startEvent);
    const payload = JSON.parse(startEvent.payload_json);
    payload.leaseUntil = pastLease;
    db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(payload), startEvent.event_id);
    db.prepare('UPDATE session_messages SET lease_until=? WHERE message_id=?').run(pastLease, message.message_id);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
  assert.equal(store.retryExpiredSessionMessages({ sessionId: session.session_id, baseDelayMs: 0 }), 1);
  state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'ACKED', `exact durable successful receipt may complete the ACK locally without re-sending the external request: ${JSON.stringify(state)}`);
  assert.equal(state.ackEvents.length, 1);
  assert.equal(state.uncertainEvents.length, 0);
  let replayCalls = 0;
  const recovered = await store.deliverSessionMessage(message.message_id, async () => { replayCalls++; return { status: 'OK' }; });
  assert.equal(recovered.status, 'ACKED');
  assert.equal(replayCalls, 0);
  assert.equal(fs.readFileSync(sideEffectPath, 'utf8'), JSON.stringify({messageId:message.message_id,idempotencyKey:message.message_id}));
  console.log('SESSION DURABLE SUCCESS RECEIPT / SIGKILL BEFORE ACK / LOCAL ACK RECOVERY WITHOUT REPLAY PASS');
}

async function acknowledgementSavepointCrashRegression(hook) {
  const { session } = makeRecipientSession(`ack-savepoint-crash-${hook}`);
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'external success receipt survives ACK savepoint crash' },
    dedupeKey: `ack-savepoint-crash-${hook}-once`
  });
  const effectPath = path.join(root, `external-effect-${hook}.json`);
  const childSource = `
    import fs from 'node:fs';
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    await s.deliverSessionMessage(${JSON.stringify(message.message_id)}, async (_session, delivered, context) => {
      fs.writeFileSync(${JSON.stringify(effectPath)}, JSON.stringify({messageId:delivered.message_id,idempotencyKey:context.idempotencyKey}), {flag:'wx',mode:0o600});
      return {status:'OK',runId:'ack-savepoint-crash-run',sessionKey:${JSON.stringify(session.openclaw_session_key)},result:'remote side effect durably accepted'};
    }, {timeoutSeconds:1});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', [hook]: 'SIGKILL' }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL', `${hook}: process must die inside the uncommitted ACK savepoint: ${stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(effectPath, 'utf8')),
    { messageId: message.message_id, idempotencyKey: message.message_id });
  let state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'DELIVERED', `${hook}: interrupted ACK row must roll back to leased delivery`);
  assert.equal(state.receipts.length, 1, `${hook}: separately committed successful receipt must survive ACK rollback`);
  assert.equal(state.ackEvents.length, 0, `${hook}: uncommitted ACK event must be absent after process death`);
  assert.equal(state.uncertainEvents.length, 0);

  const pastLease = new Date(Date.now() - 1000).toISOString();
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const start = db.prepare("SELECT event_id,payload_json FROM events WHERE type='session.message_delivery_started' AND json_extract(payload_json,'$.messageId')=?")
      .get(message.message_id);
    assert.ok(start);
    const payload = JSON.parse(start.payload_json);
    payload.leaseUntil = pastLease;
    db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(payload), start.event_id);
    db.prepare('UPDATE session_messages SET lease_until=? WHERE message_id=?').run(pastLease, message.message_id);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }

  assert.equal(store.retryExpiredSessionMessages({ sessionId: session.session_id }), 1);
  state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'ACKED', `${hook}: recovery should use the exact durable success receipt to finish ACK locally`);
  assert.equal(state.ackEvents.length, 1);
  assert.equal(state.uncertainEvents.length, 0);
  let replayCalls = 0;
  assert.equal((await store.deliverSessionMessage(message.message_id, async () => { replayCalls++; return { status: 'OK' }; })).status, 'ACKED');
  assert.equal(replayCalls, 0, `${hook}: recovered ACK must not reissue the external transport`);
  assert.equal(fs.readFileSync(effectPath, 'utf8'), JSON.stringify({messageId:message.message_id,idempotencyKey:message.message_id}));
  console.log(`SESSION ACK SAVEPOINT ${hook.toUpperCase()} / RECEIPT-BASED LOCAL RECOVERY / NO REPLAY PASS`);
}

async function expiredLeaseBeforeTransportStartRegression() {
  const { session } = makeRecipientSession('pre-transport-crash');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'crash before transport-start marker' },
    dedupeKey: 'pre-transport-crash-once'
  });
  const childSource = `
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    const claim=s.claimSessionMessage(${JSON.stringify(message.message_id)},{recipientRole:'architect',leaseMs:60000});
    if (!claim?.claimAcquired) process.exit(4);
    s.recordSessionDeliveryStarted(${JSON.stringify(message.message_id)},{attempt:claim.attempt,leaseUntil:claim.lease_until});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_DELIVERY_STARTED_EVENT: 'SIGKILL' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL', `transport-start writer must die before transport call: ${stderr}`);
  let state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'DELIVERED');
  assert.equal(state.deliveredEvents.length, 1);
  assert.equal(state.ackEvents.length, 0);
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try { db.prepare('UPDATE session_messages SET lease_until=? WHERE message_id=?').run(new Date(Date.now() - 1000).toISOString(), message.message_id); }
  finally { db.close(); }
  store.retryExpiredSessionMessages({ sessionId: session.session_id, baseDelayMs: 0 });
  state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'QUEUED', 'uncommitted start marker proves this managed path had not crossed the transport boundary');
  assert.equal(state.message.attempt, 1);
  assert.equal(state.uncertainEvents.length, 0);
  console.log('SESSION MESSAGE SIGKILL BEFORE TRANSPORT EFFECT / LEASE RECOVERY SAFE RETRY PASS');
}

async function committedClaimCrashBeforeTransportStartRegression() {
  const { session } = makeRecipientSession('committed-claim-before-start-crash');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'worker dies after lease claim commits but before transport-start intent' },
    dedupeKey: 'committed-claim-before-start-crash-once'
  });
  const externalEffectPath = path.join(root, 'must-not-exist-before-transport-start.txt');
  const childSource = `
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    const claimed=s.claimSessionMessage(${JSON.stringify(message.message_id)},{recipientRole:'architect',leaseMs:60000});
    if (!claimed?.claimAcquired) process.exit(6);
    // Simulate a real process death after the claim transaction has committed,
    // but before the managed delivery method writes session.message_delivery_started
    // or calls the external transport.
    process.kill(process.pid,'SIGKILL');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test' }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL', `worker must die after committed lease claim and before transport: ${stderr}`);
  assert.equal(fs.existsSync(externalEffectPath), false, 'fixture must not have crossed the external side-effect boundary');
  let state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'DELIVERED');
  assert.equal(state.message.attempt, 1);
  assert.equal(state.deliveredEvents.length, 1);
  assert.equal(state.receipts.length, 0);
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try { db.prepare('UPDATE session_messages SET lease_until=? WHERE message_id=?').run(new Date(Date.now() - 1000).toISOString(), message.message_id); }
  finally { db.close(); }
  assert.equal(store.retryExpiredSessionMessages({ sessionId: session.session_id, baseDelayMs: 0 }), 1);
  state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'QUEUED', 'a committed lease without a transport-start marker is safely requeued');
  assert.equal(state.message.attempt, 1, 'retrying queue state does not pretend the worker performed a second external attempt');
  assert.equal(state.retries.length, 1);
  assert.equal(state.uncertainEvents.length, 0);
  let deliveredSideEffects = 0;
  const retried = await store.deliverSessionMessage(message.message_id, async () => {
    deliveredSideEffects++;
    return { status: 'OK', runId: 'safe-retry-after-claim-crash', sessionKey: session.openclaw_session_key };
  }, { timeoutSeconds: 1 });
  assert.equal(retried.status, 'ACKED');
  assert.equal(deliveredSideEffects, 1, 'safe pre-transport recovery executes exactly one fixture-side external effect');
  assert.equal(inspectMessage(message.message_id).ackEvents.length, 1);
  console.log('SESSION COMMITTED CLAIM / SIGKILL BEFORE TRANSPORT-START MARKER / SAFE RECOVERY PASS');
}

async function retryEventAtomicityRegression() {
  const { session } = makeRecipientSession('retry-event-atomicity');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'safe retry after explicitly known non-send' },
    dedupeKey: 'retry-event-atomicity-once'
  });
  assert.equal(store.claimSessionMessage(message.message_id, { recipientRole: 'architect', leaseMs: 60000 }).claimAcquired, true);
  assert.equal(inspectMessage(message.message_id).message.status, 'DELIVERED');
  const originalRecordEvent = store.recordEvent.bind(store);
  store.recordEvent = (jobId, type, payload, dedupeKey) => {
    if (type === 'session.message_retry' && payload?.messageId === message.message_id) {
      throw new Error('injected session.message_retry event persistence failure');
    }
    return originalRecordEvent(jobId, type, payload, dedupeKey);
  };
  try {
    assert.throws(() => store.retrySessionMessage(message.message_id, { error: 'known transport not-sent fixture', delayMs: 0 }),
      /injected session\.message_retry event persistence failure/);
  } finally { store.recordEvent = originalRecordEvent; }
  const afterFailure = inspectMessage(message.message_id);
  assert.equal(afterFailure.message.status, 'DELIVERED',
    'retry row-state change must roll back when its durable retry event cannot be persisted');
  assert.equal(afterFailure.retries.length, 0);
  assert.equal(store.retrySessionMessage(message.message_id, { error: 'known transport not-sent fixture', delayMs: 0 }).status, 'QUEUED');
  const afterRetry = inspectMessage(message.message_id);
  assert.equal(afterRetry.message.status, 'QUEUED');
  assert.equal(afterRetry.retries.length, 1);
  const secondClaim = store.claimSessionMessage(message.message_id, { recipientRole: 'architect', leaseMs: 60000 });
  assert.equal(secondClaim.claimAcquired, true);
  assert.equal(secondClaim.attempt, 2);
  assert.equal(store.retrySessionMessage(message.message_id, { error: 'second known transport not-sent fixture', delayMs: 0 }).status, 'QUEUED');
  const afterSecondRetry = inspectMessage(message.message_id);
  assert.equal(afterSecondRetry.message.status, 'QUEUED');
  assert.equal(afterSecondRetry.retries.length, 2, 'retry event cardinality must account for multiple exact attempts, not dedupe only by message ID');
  console.log('SESSION MESSAGE RETRY ROW/EVENT ATOMICITY / FAILURE ROLLBACK / RETRY PASS');
}

async function malformedDurableAttemptMustFailClosedRegression() {
  const { session } = makeRecipientSession('malformed-attempt');

  const queued = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'malformed attempt cannot be claimed' },
    dedupeKey: 'malformed-attempt-claim-once'
  });
  store.db.prepare("UPDATE session_messages SET attempt='1x' WHERE message_id=?").run(queued.message_id);
  assert.equal(typeof store.getSessionMessage(queued.message_id).attempt, 'string',
    'the adversarial fixture must store a nonnumeric durable attempt, not a coercible integer');
  assert.throws(() => store.claimSessionMessage(queued.message_id, { recipientRole: 'architect', leaseMs: 60000 }),
    /malformed durable attempt/,
    'claim must reject a corrupt persisted attempt instead of converting it to a delivery identity');
  assert.equal(store.getSessionMessage(queued.message_id).status, 'QUEUED');
  assert.equal(inspectMessage(queued.message_id).deliveredEvents.length, 0,
    'a malformed attempt must not publish a delivery claim event');

  const retry = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'malformed attempt cannot retry' },
    dedupeKey: 'malformed-attempt-retry-once'
  });
  assert.equal(store.claimSessionMessage(retry.message_id, { recipientRole: 'architect', leaseMs: 60000 }).claimAcquired, true);
  store.db.prepare("UPDATE session_messages SET attempt='2x' WHERE message_id=?").run(retry.message_id);
  const retryRowsBefore = inspectMessage(retry.message_id).retries.length;
  assert.throws(() => store.retrySessionMessage(retry.message_id, { error: 'test malformed attempt', delayMs: 0 }),
    /malformed durable delivery attempt/,
    'retry must not normalize a malformed attempt and put an ambiguously identified message back in queue');
  assert.equal(store.getSessionMessage(retry.message_id).status, 'DELIVERED');
  assert.equal(inspectMessage(retry.message_id).retries.length, retryRowsBefore,
    'rejected malformed retry must not write a retry event');

  const ack = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'malformed attempt cannot ACK' },
    dedupeKey: 'malformed-attempt-ack-once'
  });
  assert.equal(store.claimSessionMessage(ack.message_id, { recipientRole: 'architect', leaseMs: 60000 }).claimAcquired, true);
  store.db.prepare("UPDATE session_messages SET attempt='3x' WHERE message_id=?").run(ack.message_id);
  assert.throws(() => store.ackSessionMessage(ack.message_id, { recipientRole: 'architect' }),
    /malformed durable attempt/,
    'ACK must not convert malformed persisted attempt data into a successful receipt');
  assert.equal(store.getSessionMessage(ack.message_id).status, 'DELIVERED');
  assert.equal(inspectMessage(ack.message_id).ackEvents.length, 0,
    'rejected malformed ACK must not publish a session.message_acked event');
  console.log('MALFORMED DURABLE SESSION ATTEMPT / CLAIM / RETRY / ACK FAIL-CLOSED PASS');
}

async function ackRequiresExactSuccessfulReceiptRegression() {
  const { session } = makeRecipientSession('ack-requires-exact-receipt');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'ACK must be backed by exact receipt lineage' },
    dedupeKey: 'ack-requires-exact-receipt-once'
  });
  const claimed = store.claimSessionMessage(message.message_id, { recipientRole: 'architect', leaseMs: 60000 });
  assert.equal(claimed.claimAcquired, true);
  assert.throws(() => store.ackSessionMessage(message.message_id, {
    recipientRole: 'architect', expectedAttempt: claimed.attempt, expectedLeaseUntil: claimed.lease_until
  }), /successful receipt requires exactly one durable receipt|transport-start lineage/,
  'a live lease must not allow a direct ACK without durable transport-start and success receipt evidence');
  assert.equal(store.getSessionMessage(message.message_id).status, 'DELIVERED');
  assert.equal(inspectMessage(message.message_id).ackEvents.length, 0);

  store.recordSessionDeliveryStarted(message.message_id, { attempt: claimed.attempt, leaseUntil: claimed.lease_until });
  store.recordSessionDeliveryReceipt(message.message_id, {
    attempt: claimed.attempt, status: 'OK', runId: 'exact-ack-receipt-run',
    sessionKey: session.openclaw_session_key, response: { accepted: true }, error: null
  });
  const receiptEvent = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='session.message_receipt'")
    .get(session.job_id);
  const canonicalReceipt = receiptEvent.payload_json;
  const tamperedReceipt = { ...JSON.parse(canonicalReceipt), sessionKey: 'substituted-session-key' };
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(tamperedReceipt), receiptEvent.event_id);
  assert.throws(() => store.ackSessionMessage(message.message_id, {
    recipientRole: 'architect', expectedAttempt: claimed.attempt, expectedLeaseUntil: claimed.lease_until
  }), /session success receipt does not bind exact message\/session\/attempt/,
  'ACK must reject a tampered receipt even while the original delivery lease is live');
  assert.equal(store.getSessionMessage(message.message_id).status, 'DELIVERED');
  assert.equal(inspectMessage(message.message_id).ackEvents.length, 0);
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonicalReceipt, receiptEvent.event_id);
  assert.equal(store.ackSessionMessage(message.message_id, {
    recipientRole: 'architect', expectedAttempt: claimed.attempt, expectedLeaseUntil: claimed.lease_until
  }).status, 'ACKED');
  assert.equal(inspectMessage(message.message_id).ackEvents.length, 1);
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(JSON.stringify(tamperedReceipt), receiptEvent.event_id);
  assert.throws(() => store.ackSessionMessage(message.message_id, { recipientRole: 'architect' }),
    /session success receipt does not bind exact message\/session\/attempt/,
    'an idempotent ACK must not accept a terminal message after its receipt lineage is tampered');
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonicalReceipt, receiptEvent.event_id);
  assert.equal(store.ackSessionMessage(message.message_id, { recipientRole: 'architect' }).ackAcquired, false,
    'a repeated ACK is an exact verified no-op only while both receipt and ACK lineage remain intact');
  const ackEvent = store.db.prepare("SELECT event_id,payload_json FROM events WHERE job_id=? AND type='session.message_acked'").get(session.job_id);
  const canonicalAck = ackEvent.payload_json;
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?')
    .run(canonicalAck.replace('"attempt":1', '"attempt":2'), ackEvent.event_id);
  assert.throws(() => store.retrySessionMessage(message.message_id, { error: 'late retry callback', delayMs: 0 }),
    /idempotent ACK readback is missing or conflicts/,
    'a stale retry callback must not treat corrupted ACK lineage as an ordinary terminal no-op');
  assert.throws(() => store.markSessionMessageDeliveryUncertain(message.message_id, {
    attempt: claimed.attempt, phase: 'late-callback', error: 'late transport uncertainty callback'
  }), /idempotent ACK readback is missing or conflicts/,
  'a late uncertainty callback must verify terminal ACK evidence before returning a no-op');
  store.db.prepare('UPDATE events SET payload_json=? WHERE event_id=?').run(canonicalAck, ackEvent.event_id);
  assert.equal(store.retrySessionMessage(message.message_id, { error: 'late retry callback', delayMs: 0 }).status, 'ACKED');
  assert.equal(store.markSessionMessageDeliveryUncertain(message.message_id, {
    attempt: claimed.attempt, phase: 'late-callback', error: 'late transport uncertainty callback'
  }).status, 'ACKED');
  console.log('SESSION ACK REQUIRES EXACT SUCCESS RECEIPT FOR LIVE LEASE / TAMPERED RECEIPT REJECTED PASS');
}

async function retryCrashAtomicityRegression(hook) {
  const { session } = makeRecipientSession(`retry-crash-${hook}`);
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'retry write crash boundary' },
    dedupeKey: `retry-crash-${hook}-once`
  });
  assert.equal(store.claimSessionMessage(message.message_id, { recipientRole: 'architect', leaseMs: 60000 }).claimAcquired, true);
  const childSource = `
    const {WorkflowStore}=await import(${JSON.stringify(storeModuleUrl)});
    const s=new WorkflowStore();
    s.retrySessionMessage(${JSON.stringify(message.message_id)},{error:'known-not-sent retry crash fixture',delayMs:0});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env, WORKFLOW_DB: dbPath, WORKFLOW_DATA_DIR: dataDir,
      WORKFLOW_WORKSPACE: root, NODE_ENV: 'test', [hook]: 'SIGKILL' }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const killed = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  assert.equal(killed.signal, 'SIGKILL', `${hook}: retry process should be killed inside its savepoint: ${stderr}`);
  let state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'DELIVERED', `${hook}: row status must rollback with the retry event`);
  assert.equal(state.retries.length, 0, `${hook}: retry event must rollback with the row status`);
  const retried = store.retrySessionMessage(message.message_id, { error: 'known-not-sent retry crash fixture', delayMs: 0 });
  assert.equal(retried.status, 'QUEUED');
  state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'QUEUED');
  assert.equal(state.retries.length, 1);
  console.log(`SESSION MESSAGE RETRY SIGKILL ${hook} / FRESH REOPEN / ROW+EVENT ATOMIC RECOVERY PASS`);
}

async function actualNestedReceiptFailureMustNotAckRegression() {
  const { session } = makeRecipientSession('actual-nested-receipt-failure');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'outer success must not hide nested failure' },
    dedupeKey: 'actual-nested-receipt-failure-once'
  });
  const fakeOpenClaw = path.join(root, 'openclaw-nested-failure-' + process.pid);
  const nestedReceipt = JSON.stringify({
    status: 'completed', runId: 'nested-run-' + process.pid, sessionKey: session.openclaw_session_key,
    result: { status: 'failed', error: 'nested execution rejected' }
  });
  const fakeScript = ['#!/bin/sh', 'printf "%s" ' + JSON.stringify(nestedReceipt), ''].join('\n');
  fs.writeFileSync(fakeOpenClaw, fakeScript, { flag: 'wx', mode: 0o700 });
  fs.chmodSync(fakeOpenClaw, 0o700);
  const previous = process.env.OPENCLAW_BIN;
  process.env.OPENCLAW_BIN = fakeOpenClaw;
  let openClawTransport;
  try {
    const url = pathToFileURL(path.resolve(fileURLToPath(new URL('../src/runtime/session-transport.js', import.meta.url))));
    url.searchParams.set('phase2', 'nested-receipt-' + process.pid);
    ({ deliverSessionMessage: openClawTransport } = await import(url.href));
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_BIN;
    else process.env.OPENCLAW_BIN = previous;
  }
  const result = await store.deliverSessionMessage(message.message_id,
    (targetSession, claimed, context) => openClawTransport(targetSession, claimed, { timeoutSeconds: context.timeoutSeconds }),
    { maxAttempts: 3, retryDelayMs: 0, timeoutSeconds: 1 });
  assert.equal(result.status, 'FAILED', 'nested failure in actual OpenClaw receipt must quarantine rather than ACK');
  assert.match(result.last_error, /^DELIVERY_UNCERTAIN:/);
  const state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'FAILED');
  assert.equal(state.ackEvents.length, 0, 'nested remote failure must never produce an ACK event');
  assert.equal(state.uncertainEvents.length, 1, 'nested remote failure must be durably quarantined');
  assert.equal(state.retries.length, 0, 'remote outcome ambiguity must not trigger automatic replay');
  assert.equal(state.receipts.length, 1);
  assert.equal(JSON.parse(state.receipts[0].payload_json).status, 'ERROR');
  const second = await store.deliverNextSessionMessage(session.session_id, {
    recipientRole: 'architect', transport: async () => { throw new Error('quarantined message must not be redispatched'); }
  });
  assert.equal(second, null, 'durably quarantined message must be excluded from automatic queue dispatch');
  console.log('ACTUAL OPENCLAW NESTED FAILURE RECEIPT -> DURABLE UNCERTAINTY / NO ACK / NO REPLAY PASS');
}

async function actualSpawnFailureManagedRetryRegression() {
  const { session } = makeRecipientSession('actual-openclaw-spawn-failure');
  const message = store.enqueueSessionMessage(session.session_id, {
    senderRole: 'cto', recipientRole: 'architect', payload: { task: 'known local spawn failure must be safely retryable' },
    dedupeKey: 'actual-openclaw-spawn-failure-once'
  });
  const missingExecutable = path.join(root, `openclaw-does-not-exist-${process.pid}`);
  const previous = process.env.OPENCLAW_BIN;
  process.env.OPENCLAW_BIN = missingExecutable;
  let openClawTransport;
  try {
    ({ deliverSessionMessage: openClawTransport } = await import(pathToFileURL(
      path.resolve(fileURLToPath(new URL('../src/runtime/session-transport.js', import.meta.url)))
    ).href));
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_BIN;
    else process.env.OPENCLAW_BIN = previous;
  }
  const result = await store.deliverSessionMessage(message.message_id,
    (targetSession, claimed, context) => openClawTransport(targetSession, claimed, { timeoutSeconds: context.timeoutSeconds }),
    { maxAttempts: 3, retryDelayMs: 0, timeoutSeconds: 1 });
  assert.equal(result.status, 'QUEUED', 'ENOENT before a child PID exists must use the managed safe-retry transition');
  const state = inspectMessage(message.message_id);
  assert.equal(state.message.status, 'QUEUED');
  assert.equal(state.message.attempt, 1, 'a no-send retry must not pretend another transport attempt occurred');
  assert.equal(state.retries.length, 1, 'the managed retry transition must be durably recorded exactly once');
  assert.equal(state.uncertainEvents.length, 0, 'known local spawn failure must not be quarantined as an ambiguous remote effect');
  assert.equal(state.ackEvents.length, 0, 'a local spawn failure must never ACK');
  assert.equal(state.deliveredEvents.length, 1, 'only the original claim may be recorded');
  assert.equal(state.receipts.length, 1, 'the classified local failure receipt should be durably recorded');
  const receipt = JSON.parse(state.receipts[0].payload_json);
  assert.equal(receipt.status, 'ERROR');
  assert.equal(receipt.error?.includes('ENOENT'), true);
  console.log('ACTUAL OPENCLAW ENOENT -> MANAGED SAFE RETRY / NO AMBIGUOUS QUARANTINE PASS');
}

try {
  await liveTransportMustOutlastRecoveryLeaseRegression();
  await productionDispatchBoundaryRegression();
await nonSuccessReceiptMustNotAckRegression();
await replayedRunReceiptMustNotAckAnotherMessageRegression();
  if (process.env.PHASE2_SESSION_DELIVERY_ONLY_RETRY_ATOMICITY === '1') await retryEventAtomicityRegression();
  await claimCrashRollbackRegression();
  await committedClaimCrashBeforeTransportStartRegression();
  await expiredLeaseBeforeTransportStartRegression();
  await uncertainLeaseExpiryRegression();
  await noDirectReclaimAfterTransportStartRegression();
  await successfulReceiptCrashRecoveryRegression();
  await acknowledgementSavepointCrashRegression('CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_ACK_UPDATE');
  await acknowledgementSavepointCrashRegression('CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_ACK_EVENT');
  if (process.env.PHASE2_SESSION_DELIVERY_ONLY_CLAIM_RACE !== '1') {
    await receiptFailureRegression();
    await acknowledgementFailureRegression();
  }
  if (process.env.PHASE2_SESSION_DELIVERY_ONLY_RETRY_ATOMICITY !== '1') await retryEventAtomicityRegression();
  if (process.env.PHASE2_SESSION_DELIVERY_ONLY_RETRY_ATOMICITY !== '1') {
    await retryCrashAtomicityRegression('CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RETRY_STATE_UPDATE');
    await retryCrashAtomicityRegression('CHAT_ON_STEROIDS_TEST_CRASH_AFTER_SESSION_RETRY_EVENT_INSERT');
  }
  await actualNestedReceiptFailureMustNotAckRegression();
  await actualSpawnFailureManagedRetryRegression();
  await claimRaceRegression();
  await malformedDurableAttemptMustFailClosedRegression();
  await ackRequiresExactSuccessfulReceiptRegression();
  console.log('test-session-delivery-boundary: PASS');
} finally {
  try { store.db.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
