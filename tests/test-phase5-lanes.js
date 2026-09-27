import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGPTBrowserBridge, TabWorker } from '../cdp.js';

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
