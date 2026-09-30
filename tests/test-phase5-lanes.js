import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGPTBrowserBridge, MultiAccountChatGPTBridge, TabWorker } from '../cdp.js';

test('each browser tab is a serialized execution lane', async () => {
  const bridge = new ChatGPTBrowserBridge({ singleTabMode: false });
  const calls = [];
  const worker = new TabWorker('engineer', bridge, { id: 'lane-1', webSocketDebuggerUrl: 'ws://unused' });
  worker._executePrompt = async (prompt) => {
    calls.push(`start:${prompt}`);
    assert.equal(worker.processing, true);
    await new Promise(r => setTimeout(r, 40));
    calls.push(`end:${prompt}`);
    return prompt;
  };
  const results = await Promise.all([worker.ask('A'), worker.ask('B')]);
  assert.deepEqual(results, ['A', 'B']);
  assert.deepEqual(calls, ['start:A', 'end:A', 'start:B', 'end:B']);
  assert.equal(worker.processing, false);
  assert.equal(worker.queue.length, 0);
});

test('multi-tab bridge keeps agent roles on separate lanes', async () => {
  const bridge = new ChatGPTBrowserBridge({ singleTabMode: false });
  let next = 0;
  bridge.getTargets = async () => [];
  bridge.createNewTab = async () => ({ id: `lane-${++next}`, webSocketDebuggerUrl: 'ws://unused' });
  const workers = await Promise.all([
    bridge.getWorker('architect'),
    bridge.getWorker('engineer'),
    bridge.getWorker('security'),
    bridge.getWorker('qa')
  ]);
  assert.equal(new Set(workers.map(w => w.targetId)).size, 4);
  assert.deepEqual([...bridge.workers.keys()].sort(), ['architect', 'engineer', 'qa', 'security']);
});

test('role normalization no longer collapses specialist agents into CTO/reviewer', () => {
  const bridge = new ChatGPTBrowserBridge({ singleTabMode: false });
  assert.equal(bridge.normalizeRole('architect'), 'architect');
  assert.equal(bridge.normalizeRole('engineer'), 'engineer');
  assert.equal(bridge.normalizeRole('platform'), 'platform');
  assert.equal(bridge.normalizeRole('security'), 'security');
  assert.equal(bridge.normalizeRole('qa'), 'qa');
  assert.equal(bridge.normalizeRole('product-owner'), 'product-owner');
  assert.equal(bridge.normalizeRole('cto'), 'cto');
});

test('ChatGPTBrowserBridge forwards request AbortSignal to TabWorker', async () => {
  const bridge = new ChatGPTBrowserBridge({ singleTabMode: false });
  let receivedSignal = null;
  bridge.getWorker = async () => ({
    ask: async (...args) => {
      receivedSignal = args.at(-1);
      return 'ok';
    }
  });
  const controller = new AbortController();
  const result = await bridge.ask('signal-test', null, 1000, 'engineer', 2, controller.signal);
  assert.equal(result, 'ok');
  assert.equal(receivedSignal, controller.signal);
});

test('queued TabWorker request is removed and rejected on abort', async () => {
  const bridge = new ChatGPTBrowserBridge({ singleTabMode: false });
  const worker = new TabWorker('engineer', bridge, { id: 'cancel-lane', webSocketDebuggerUrl: 'ws://unused' });
  worker._executePrompt = async (prompt, onChunk, timeoutMs, signal) => {
    if (signal) assert.equal(signal.aborted, false);
    await new Promise(r => setTimeout(r, 100));
    return prompt;
  };
  const first = worker.ask('first');
  const controller = new AbortController();
  const second = worker.ask('second', null, 1000, 2, 'engineer', controller.signal);
  controller.abort();
  await assert.rejects(second, /Request aborted by caller/);
  assert.equal(worker.queue.length, 0);
  await first;
  assert.equal(worker.processing, false);
});

test('active TabWorker request resets its CDP connection immediately on abort', async () => {
  const bridge = new ChatGPTBrowserBridge({ singleTabMode: false });
  const worker = new TabWorker('engineer', bridge, { id: 'active-cancel-lane', webSocketDebuggerUrl: 'ws://unused' });
  let resetReason = null;
  worker.resetConnection = reason => { resetReason = reason; };
  worker._executePrompt = async (prompt, onChunk, timeoutMs, signal) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Request aborted by caller'));
      }, { once: true });
    });
    return prompt;
  };
  const controller = new AbortController();
  const request = worker.ask('active-cancel', null, 5000, 2, 'engineer', controller.signal);
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(request, /Request aborted by caller/);
  assert.equal(resetReason, 'request aborted by caller');
  assert.equal(worker.processing, false);
  assert.equal(worker.queue.length, 0);
});

test('CDP WebSocket connect aborts immediately instead of waiting for the 10s connect timeout', async () => {
  const originalWebSocket = globalThis.WebSocket;
  class HangingWebSocket {
    static OPEN = 1;
    readyState = 0;
    closeCalls = 0;
    constructor() {
      HangingWebSocket.instance = this;
    }
    close() {
      this.closeCalls++;
      this.readyState = 3;
      this.onclose?.();
    }
  }

  globalThis.WebSocket = HangingWebSocket;
  try {
    const bridge = new ChatGPTBrowserBridge({ singleTabMode: false });
    bridge.getTargets = async () => [{ id: 'abort-connect', webSocketDebuggerUrl: 'ws://unused' }];
    const worker = new TabWorker('engineer', bridge, { id: 'abort-connect', webSocketDebuggerUrl: 'ws://unused' });
    const controller = new AbortController();
    const startedAt = Date.now();
    const request = worker.ensureConnected(controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(request, /Request aborted by caller/);
    assert.ok(Date.now() - startedAt < 1000, 'connect abort should not wait for the 10s timeout');
    assert.equal(HangingWebSocket.instance.closeCalls, 1);
    assert.equal(worker.ready, false);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test('browser startup waiter honors caller abort while shared startup continues', async () => {
  const bridge = new ChatGPTBrowserBridge({ singleTabMode: false });
  bridge.isCdpAvailable = async () => false;
  let startupFinished = false;
  bridge._startBrowser = async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
    startupFinished = true;
  };
  const controller = new AbortController();
  const startedAt = Date.now();
  const request = bridge.ensureBrowserRunning(controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(request, /Request aborted by caller/);
  assert.ok(Date.now() - startedAt < 100, 'caller should not wait for shared browser startup');
  assert.equal(startupFinished, false);
  await new Promise(resolve => setTimeout(resolve, 170));
  assert.equal(startupFinished, true);
  assert.equal(bridge.browserStartPromise, null);
});

test('existing shared TabWorker connection honors caller abort without cancelling the shared connect', async () => {
  const bridge = new ChatGPTBrowserBridge({ singleTabMode: false });
  const worker = new TabWorker('engineer', bridge, { id: 'shared-connect', webSocketDebuggerUrl: 'ws://unused' });
  let resolveConnect;
  worker.connectingPromise = new Promise(resolve => { resolveConnect = resolve; });
  const controller = new AbortController();
  const request = worker.ensureConnected(controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(request, /Request aborted by caller/);
  assert.ok(worker.connectingPromise, 'shared connection must remain owned by the background operation');
  resolveConnect();
  await worker.connectingPromise;
});

test('stale connection cleanup cannot clear a newer shared connection attempt', () => {
  const bridge = new ChatGPTBrowserBridge({ singleTabMode: false });
  const worker = new TabWorker('engineer', bridge, { id: 'generation-race', webSocketDebuggerUrl: 'ws://unused' });
  const oldAttempt = Promise.resolve();
  const newAttempt = Promise.resolve();
  worker.connectingPromise = newAttempt;
  worker.resetConnection('old attempt failed', oldAttempt);
  assert.equal(worker.connectingPromise, newAttempt);
});

test('forceRefreshTarget closes an uncommitted fresh tab when cancellation happens mid-recycle', async () => {
  const originalFetch = globalThis.fetch;
  const closed = [];
  const controller = new AbortController();
  let targetProbeCount = 0;
  const bridge = {
    cdpBaseUrl: 'http://127.0.0.1:9021',
    async createNewTab() { return { id: 'fresh-uncommitted', webSocketDebuggerUrl: 'ws://fresh' }; },
    async getTargets() {
      targetProbeCount += 1;
      if (targetProbeCount === 1) {
        setTimeout(() => controller.abort(), 10);
      }
      return [{ id: 'old-wedged' }];
    }
  };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/json/close/')) closed.push(String(url).split('/').pop());
    return { ok: true, json: async () => ({}) };
  };
  try {
    const worker = new TabWorker('engineer', bridge, { id: 'old-wedged', webSocketDebuggerUrl: 'ws://old' });
    await assert.rejects(worker.forceRefreshTarget(controller.signal), /Request aborted by caller/);
    assert.ok(closed.includes('fresh-uncommitted'), 'fresh tab must be closed when ownership was never committed');
    assert.equal(worker.targetId, 'old-wedged');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('aborting account selection releases its reservation', async () => {
  const bridge = new MultiAccountChatGPTBridge({ singleTabMode: false, cooldownMs: 1000 });
  const account = bridge.accounts[0];
  account.lastCompletedAt = Date.now();
  bridge.getAvailableAccounts = async () => [{ acc: account, isRunning: true }];
  const controller = new AbortController();
  const request = bridge.pickAccount(2, 'engineer', controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(request, /Request aborted by caller/);
  assert.equal(account.reservedRequests, 0);
});
