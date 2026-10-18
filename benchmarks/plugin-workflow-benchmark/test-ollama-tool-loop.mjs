#!/usr/bin/env node
// Offline unit tests for the bounded model/tool loop; no model, plugin, or scenario is started.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchOllamaHttp, runOllamaToolLoop } from './ollama-tool-loop.mjs';

const tools = [{ type: 'function', function: { name: 'read_fixture', description: 'read fixture', parameters: { type: 'object', properties: {}, required: [] } } }];
function fakeFetchFactory(responses) {
  const pending = [...responses];
  return async (_url, options) => {
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    const next = pending.shift();
    assert.ok(next, 'unexpected extra model request');
    if (next.assertBody) next.assertBody(body);
    return { ok: true, status: 200, text: async () => JSON.stringify(next.response) };
  };
}
const modelResponse = message => ({ model: 'qwen3:4b-instruct', message, done: true });

{
  // Exercise the real default transport against loopback only. This guards
  // against reintroducing Undici's fixed 300 s response-header deadline.
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      assert.equal(request.method, 'POST');
      assert.equal(JSON.parse(body).model, 'qwen3:4b-instruct');
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(modelResponse({ role: 'assistant', content: 'loopback transport ok' })));
      }, 75);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const result = await runOllamaToolLoop({ endpoint: `http://127.0.0.1:${address.port}/api/chat`,
      messages: [{ role: 'user', content: 'loopback transport test' }], tools, allowedTools: ['read_fixture'],
      executeTool: async () => ({}), timeoutMs: 1000, maxElapsedMs: 3000 });
    assert.equal(result.finalMessage.content, 'loopback transport ok');
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(typeof fetchOllamaHttp, 'function');
}

{
  let called = 0;
  let observedCallId = null;
  const result = await runOllamaToolLoop({ messages: [{ role: 'user', content: 'read fixture' }], tools,
    allowedTools: ['read_fixture'], contextTokens: 8192, maxPredictTokens: 1024, executeTool: async (name, args, context) => { called++; observedCallId = context.modelCallId; assert.equal(name, 'read_fixture'); assert.deepEqual(args, {}); return { status: 'ready' }; },
    fetchImpl: fakeFetchFactory([
      { assertBody: body => { assert.equal(body.options.num_ctx, 8192); assert.equal(body.options.num_predict, 1024); }, response: modelResponse({ role: 'assistant', content: '', tool_calls: [{ id: 'native-call-1', function: { name: 'read_fixture', arguments: {} } }] }) },
      { assertBody: body => assert.equal(body.messages.at(-1).role, 'tool'), response: modelResponse({ role: 'assistant', content: 'Status is ready.' }) },
    ]) });
  assert.equal(called, 1);
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.finalMessage.content, 'Status is ready.');
  assert.equal(observedCallId, 'native-call-1');
  assert.ok(result.events.some(e => e.kind === 'model_tool_call' && e.native));
  assert.ok(result.events.some(e => e.kind === 'tool_result' && e.native));
  const requestEvent = result.events.find(e => e.kind === 'model_request');
  assert.ok(requestEvent.request_bytes > requestEvent.tool_schema_bytes);
  assert.deepEqual(requestEvent.offered_tools, ['read_fixture']);
  assert.deepEqual(requestEvent.effective_allowed_tools, ['read_fixture']);
  assert.match(requestEvent.tool_schema_sha256, /^[a-f0-9]{64}$/);
  assert.equal(requestEvent.timeout_ms, 240_000);
}

{
  const requestErrors = [];
  await assert.rejects(() => runOllamaToolLoop({ messages: [{ role: 'user', content: 'timeout test' }], tools,
    allowedTools: ['read_fixture'], executeTool: async () => ({}), timeoutMs: 25,
    onEvent: event => requestErrors.push(event),
    fetchImpl: async () => { throw Object.assign(new Error('simulated request timeout'), { name: 'TimeoutError' }); } }),
    error => error?.name === 'TimeoutError');
  const failure = requestErrors.find(event => event.kind === 'model_request_error');
  assert.ok(failure, 'request timeout must be recorded as a terminal model-request event');
  assert.equal(failure.timeout_ms, 25);
  assert.ok(failure.request_bytes > 0 && failure.tool_schema_bytes > 0);
  assert.ok(failure.elapsed_ms >= 0);
}

{
  const requestErrors = [];
  const cause = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
  await assert.rejects(() => runOllamaToolLoop({ messages: [{ role: 'user', content: 'transport diagnostic test' }], tools,
    allowedTools: ['read_fixture'], executeTool: async () => ({}),
    onEvent: event => requestErrors.push(event),
    fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause }); } }), /fetch failed/);
  const failure = requestErrors.find(event => event.kind === 'model_request_error');
  assert.equal(failure.cause_code, 'ECONNRESET');
  assert.equal(failure.cause_message, 'socket closed');
}

{
  const responseErrors = [];
  await assert.rejects(() => runOllamaToolLoop({ messages: [{ role: 'user', content: 'HTTP diagnostic test' }], tools,
    allowedTools: ['read_fixture'], executeTool: async () => ({}),
    onEvent: event => responseErrors.push(event),
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'synthetic server failure' }) }), /Ollama HTTP 500/);
  const failure = responseErrors.find(event => event.kind === 'model_response_error');
  assert.equal(failure.status, 500);
  assert.equal(failure.response_excerpt, 'synthetic server failure');
  assert.equal(failure.response_bytes, Buffer.byteLength('synthetic server failure'));
  assert.match(failure.response_sha256, /^[a-f0-9]{64}$/);
}

{
  const requestEvents = [];
  let calls = 0;
  let executions = 0;
  await assert.rejects(() => runOllamaToolLoop({ messages: [{ role: 'user', content: 'deadline test' }], tools,
    allowedTools: ['read_fixture'], executeTool: async () => { executions++; return {}; }, timeoutMs: 240_000, maxElapsedMs: 10,
    onEvent: event => requestEvents.push(event),
    fetchImpl: async () => { calls++; if (calls === 1) await new Promise(resolve => setTimeout(resolve, 20));
      return { ok: true, status: 200, text: async () => JSON.stringify(modelResponse({ role: 'assistant', content: '',
        tool_calls: [{ id: 'deadline-call', function: { name: 'read_fixture', arguments: {} } }] })) }; } }),
    /condition elapsed-time budget exceeded/);
  assert.equal(calls, 1, 'no additional model request may start after the overall condition budget is exhausted');
  assert.equal(executions, 0, 'a late model response must not trigger a tool side effect after the condition budget expires');
  assert.ok(requestEvents.some(event => event.kind === 'model_response_over_budget' && event.tool_execution_skipped),
    'late responses must be recorded and their tool calls skipped');
}

{
  let executions = 0;
  const events = [];
  await assert.rejects(() => runOllamaToolLoop({ messages: [{ role: 'user', content: 'side effect deadline test' }], tools,
    allowedTools: ['read_fixture'], executeTool: async () => { executions++; return {}; }, timeoutMs: 1000, maxElapsedMs: 1000,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: 'qwen3:4b-instruct', message: {
      role: 'assistant', tool_calls: [{ id: 'late-call', function: { name: 'read_fixture', arguments: {} } }],
    } }) }),
    onEvent: event => { events.push(event); if (event.kind === 'model_tool_call') { const until = Date.now() + 1010; while (Date.now() < until) {} } },
  }), /condition elapsed-time budget exceeded/);
  assert.equal(executions, 0, 'tool execution must not begin if the budget expires after the tool-call event');
  assert.ok(events.some(event => event.kind === 'condition_budget_exhausted' && event.phase === 'before_tool_execution'),
    'pre-side-effect deadline exhaustion must be observable');
}

{
  const observedTimeouts = [];
  await runOllamaToolLoop({ messages: [{ role: 'user', content: 'remaining budget test' }], tools,
    allowedTools: ['read_fixture'], executeTool: async () => ({}), timeoutMs: 240_000, maxElapsedMs: 10_000,
    onEvent: event => { if (event.kind === 'model_request') observedTimeouts.push(event.timeout_ms); },
    fetchImpl: fakeFetchFactory([{ response: modelResponse({ role: 'assistant', content: 'done' }) }]) });
  assert.equal(observedTimeouts.length, 1);
  assert.ok(observedTimeouts[0] <= 10_000, 'request timeout must not exceed remaining condition budget');
}

const deniedEvents = [];
await assert.rejects(() => runOllamaToolLoop({ messages: [{ role: 'user', content: 'x' }], tools,
  allowedTools: ['read_fixture'], executeTool: async () => ({}),
  onEvent: event => deniedEvents.push(event),
  fetchImpl: fakeFetchFactory([{ response: modelResponse({ role: 'assistant', content: '', tool_calls: [{ id: 'forbidden-call-1', function: { name: 'workflow_dispatch', arguments: { job_id: 'fake' } } }] }) }]) }),
  /outside the effective allowlist/);
assert.ok(deniedEvents.some(event => event.kind === 'tool_policy_decision' && event.disposition === 'denied' && event.tool_name === 'workflow_dispatch'),
  'forbidden tool attempts must have a durable policy-denial event before the loop fails closed');

const executionErrorEvents = [];
await assert.rejects(() => runOllamaToolLoop({ messages: [{ role: 'user', content: 'try a forbidden path' }], tools,
  allowedTools: ['read_fixture'], executeTool: async () => { throw new Error('policy denied path escape'); },
  onEvent: event => executionErrorEvents.push(event),
  fetchImpl: fakeFetchFactory([{ response: modelResponse({ role: 'assistant', content: '', tool_calls: [{ id: 'path-call-1', function: { name: 'read_fixture', arguments: { path: '../outside' } } }] }) }]) }),
  /policy denied path escape/);
assert.ok(executionErrorEvents.some(event => event.kind === 'tool_execution_error' && event.disposition === 'error' && event.model_call_id === 'path-call-1'),
  'executor errors must produce a terminal error event before the loop fails closed');

await assert.rejects(() => runOllamaToolLoop({ messages: [{ role: 'user', content: 'x' }], tools,
  allowedTools: ['read_fixture'], executeTool: async () => ({}), maxTurns: 1,
  fetchImpl: fakeFetchFactory([{ response: modelResponse({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_fixture', arguments: {} } }] }) }]) }),
  /model-turn limit exceeded/);

await assert.rejects(() => runOllamaToolLoop({ messages: [{ role: 'user', content: 'x' }], tools,
  allowedTools: ['read_fixture', 'write_file'], executeTool: async () => ({}), fetchImpl: fakeFetchFactory([]) }),
  /effective tool write_file is not actually offered/);

{
  const events = [];
  let executions = 0;
  const result = await runOllamaToolLoop({ messages: [{ role: 'user', content: 'read safely, one tool at a time' }], tools,
    allowedTools: ['read_fixture'], executeTool: async () => { executions++; return { status: 'read' }; }, onEvent: event => events.push(event),
    fetchImpl: fakeFetchFactory([
      { response: modelResponse({ role: 'assistant', content: '', tool_calls: [
        { id: 'batch-1', function: { name: 'read_fixture', arguments: {} } },
        { id: 'batch-2', function: { name: 'read_fixture', arguments: {} } },
      ] }) },
      { assertBody: body => {
        assert.equal(body.parallel_tool_calls, false);
        assert.equal(body.messages.at(-2).role, 'tool');
        assert.equal(body.messages.at(-1).role, 'tool');
        assert.match(body.messages.at(-1).content, /only one tool call/i);
      }, response: modelResponse({ role: 'assistant', content: '', tool_calls: [{ id: 'single-after-denial', function: { name: 'read_fixture', arguments: {} } }] }) },
      { response: modelResponse({ role: 'assistant', content: 'Recovered and finished.' }) },
    ]) });
  assert.equal(executions, 1, 'none of the calls from the rejected batch may execute');
  assert.equal(result.toolCallCount, 3, 'rejected attempts remain inside the bounded tool-call budget');
  assert.equal(result.finalMessage.content, 'Recovered and finished.');
  assert.equal(events.filter(event => event.kind === 'tool_policy_decision' && event.disposition === 'denied').length, 2);
  assert.ok(events.some(event => event.kind === 'parallel_tool_turn_rejected' && event.no_side_effects));
}

{
  let dynamicTools = [...tools];
  let dynamicAllowed = ['read_fixture'];
  let turns = 0;
  const result = await runOllamaToolLoop({ messages: [{ role: 'user', content: 'read, then write when offered' }],
    tools: () => dynamicTools, allowedTools: () => dynamicAllowed,
    executeTool: async name => ({ tool: name }),
    afterToolCall: async ({ name }) => { if (name === 'read_fixture') {
      dynamicTools = [...tools, { type: 'function', function: { name: 'write_fixture', description: 'write fixture', parameters: { type: 'object', properties: {}, required: [] } } }];
      dynamicAllowed = ['read_fixture', 'write_fixture'];
    } return null; },
    fetchImpl: fakeFetchFactory([
      { response: modelResponse({ role: 'assistant', content: '', tool_calls: [{ id: 'dynamic-read', function: { name: 'read_fixture', arguments: {} } }] }) },
      { assertBody: body => assert.ok(body.tools.some(item => item.function.name === 'write_fixture'), 'tool provider must expose newly permitted tool on the next turn'),
        response: modelResponse({ role: 'assistant', content: '', tool_calls: [{ id: 'dynamic-write', function: { name: 'write_fixture', arguments: {} } }] }) },
      { response: modelResponse({ role: 'assistant', content: 'Dynamic tool update worked.' }) },
    ]) });
  assert.equal(result.toolCallCount, 2);
  assert.equal(result.finalMessage.content, 'Dynamic tool update worked.');
  assert.equal(turns, 0);
  const snapshots = result.events.filter(event => event.kind === 'model_request');
  assert.deepEqual(snapshots[0].offered_tools, ['read_fixture']);
  assert.deepEqual(snapshots[0].effective_allowed_tools, ['read_fixture']);
  assert.deepEqual(snapshots[1].offered_tools, ['read_fixture', 'write_fixture']);
  assert.deepEqual(snapshots[1].effective_allowed_tools, ['read_fixture', 'write_fixture']);
  assert.notEqual(snapshots[0].tool_schema_sha256, snapshots[1].tool_schema_sha256,
    'schema digest must change when the offered tool set changes');
}

console.log('PASS: native tool/result round-trip, model-call ID propagation, durable deny event, elapsed-time deadline, bounded turn limit, and offered/effective allowlist equality');
console.log('PASS: rejected multi-call turns execute no side effects and can recover with one tool call per turn');
console.log('PASS: tool/allowlist providers support fail-closed dynamic tool availability as workflow state changes');
console.log('PASS: no model, plugin, or benchmark scenario executed');
