// Bounded, fail-closed Ollama native-tool loop used by the future scenario host.
// This module is inert on import and has no dependency on the live orchestrator.
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const isoNow = () => new Date().toISOString();

// Node's global fetch/Undici applies a fixed 300 s headers timeout even when
// AbortSignal.timeout is configured for 600 s. Local CPU inference can spend
// longer than that evaluating a large tool prompt. Use the core HTTP client so
// the reviewed AbortSignal is the effective absolute deadline; this transport
// still targets only the caller-supplied endpoint and adds no retry behavior.
export function fetchOllamaHttp(endpoint, init = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(endpoint); } catch (error) { reject(error); return; }
    const client = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!client) { reject(new TypeError('unsupported Ollama URL protocol')); return; }
    const request = client.request(url, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      signal: init.signal,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, text: async () => body });
      });
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

export async function runOllamaToolLoop({
  model = 'qwen3:4b-instruct',
  messages,
  tools,
  allowedTools,
  executeTool,
  maxTurns = 12,
  maxToolCalls = 20,
  timeoutMs = 240_000,
  maxElapsedMs = 300_000,
  contextTokens = 4096,
  maxPredictTokens = 256,
  endpoint = 'http://127.0.0.1:11434/api/chat',
  fetchImpl = fetchOllamaHttp,
  onEvent = () => {},
  afterToolCall = async () => null,
}) {
  if (!Array.isArray(messages) || !messages.length) throw new TypeError('messages must be a non-empty array');
  if (typeof tools !== 'function' && (!Array.isArray(tools) || !tools.length)) throw new TypeError('tools must be a non-empty array or provider');
  if (typeof allowedTools !== 'function' && (!Array.isArray(allowedTools) || !allowedTools.length)) throw new TypeError('allowedTools must be a non-empty array or provider');
  if (typeof executeTool !== 'function') throw new TypeError('executeTool callback is required');
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) throw new RangeError('maxTurns must be 1..20');
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 30) throw new RangeError('maxToolCalls must be 1..30');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer');
  if (!Number.isInteger(maxElapsedMs) || maxElapsedMs < 1) throw new RangeError('maxElapsedMs must be a positive integer');
  if (!Number.isInteger(contextTokens) || contextTokens < 2048 || contextTokens > 32768) throw new RangeError('contextTokens must be 2048..32768');
  if (!Number.isInteger(maxPredictTokens) || maxPredictTokens < 128 || maxPredictTokens > 8192) throw new RangeError('maxPredictTokens must be 128..8192');

  const currentTools = () => typeof tools === 'function' ? tools() : tools;
  const currentAllowedTools = () => typeof allowedTools === 'function' ? allowedTools() : allowedTools;
  const validateToolSet = (toolList, allowedList) => {
    if (!Array.isArray(toolList) || !toolList.length) throw new TypeError('tools must resolve to a non-empty array');
    if (!Array.isArray(allowedList) || !allowedList.length) throw new TypeError('allowedTools must resolve to a non-empty array');
    const allowedSet = new Set(allowedList);
    const offeredSet = new Set(toolList.map(item => item?.function?.name).filter(Boolean));
    if (offeredSet.size !== toolList.length) throw new Error('each tool must have a unique function.name');
    for (const name of offeredSet) if (!allowedSet.has(name)) throw new Error(`tool ${name} is offered but not in the effective allowlist`);
    for (const name of allowedSet) if (!offeredSet.has(name)) throw new Error(`effective tool ${name} is not actually offered to the model`);
    return { allowed: allowedSet, offered: offeredSet };
  };
  validateToolSet(currentTools(), currentAllowedTools());

  const conversation = structuredClone(messages);
  const events = [];
  const emit = event => { const full = { timestamp: isoNow(), ...event }; events.push(full); onEvent(full); };
  let toolCalls = 0;
  const startedAt = Date.now();
  const assertWithinBudget = (turn, phase) => {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs < maxElapsedMs) return;
    emit({ kind: 'condition_budget_exhausted', turn, phase, max_elapsed_ms: maxElapsedMs,
      elapsed_ms: elapsedMs, tool_execution_skipped: phase === 'before_tool_execution' });
    throw new Error(`condition elapsed-time budget exceeded (${maxElapsedMs}ms)`);
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    const toolList = currentTools();
    const { allowed, offered } = validateToolSet(toolList, currentAllowedTools());
    const remainingMs = maxElapsedMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      emit({ kind: 'model_request_skipped', turn, reason: 'condition elapsed-time budget exhausted',
        max_elapsed_ms: maxElapsedMs, elapsed_ms: Date.now() - startedAt });
      throw new Error(`condition elapsed-time budget exceeded (${maxElapsedMs}ms)`);
    }
    const effectiveTimeoutMs = Math.min(timeoutMs, remainingMs);
    const requestBody = { model, stream: false, think: false, parallel_tool_calls: false,
      options: { temperature: 0, num_ctx: contextTokens, num_predict: maxPredictTokens },
      messages: conversation, tools: toolList };
    const requestJson = JSON.stringify(requestBody);
    const requestStartedAt = Date.now();
    const toolSchemaJson = JSON.stringify(toolList);
    const permissionSnapshot = [...allowed].sort();
    emit({ kind: 'model_request', turn, request_sha256: sha256(requestJson),
      request_bytes: Buffer.byteLength(requestJson), tool_schema_bytes: Buffer.byteLength(toolSchemaJson),
      tool_schema_sha256: sha256(toolSchemaJson), timeout_ms: effectiveTimeoutMs,
      messages: structuredClone(conversation), offered_tools: [...offered].sort(),
      effective_allowed_tools: permissionSnapshot });
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: requestJson, signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } catch (error) {
      const cause = error?.cause;
      emit({ kind: 'model_request_error', turn, elapsed_ms: Date.now() - requestStartedAt,
        timeout_ms: effectiveTimeoutMs, request_bytes: Buffer.byteLength(requestJson),
        tool_schema_bytes: Buffer.byteLength(JSON.stringify(toolList)),
        error_name: String(error?.name ?? 'Error'),
        error: String(error?.message ?? error).replaceAll(endpoint, '[ollama-endpoint]').slice(0, 300),
        cause_name: cause?.name ? String(cause.name).slice(0, 100) : null,
        cause_code: cause?.code ? String(cause.code).slice(0, 100) : null,
        cause_message: cause?.message ? String(cause.message).replaceAll(endpoint, '[ollama-endpoint]').slice(0, 300) : null });
      throw error;
    }
    const rawText = await response.text();
    if (!response.ok) {
      emit({ kind: 'model_response_error', turn, status: response.status,
        response_bytes: Buffer.byteLength(rawText), response_sha256: sha256(rawText),
        response_excerpt: rawText.slice(0, 300), elapsed_ms: Date.now() - requestStartedAt });
      throw new Error(`Ollama HTTP ${response.status}: ${rawText.slice(0, 500)}`);
    }
    let parsed;
    try { parsed = JSON.parse(rawText); } catch { throw new Error('Ollama returned invalid JSON'); }
    if (parsed.model !== model) throw new Error(`model identity mismatch: expected ${model}, observed ${String(parsed.model)}`);
    const elapsedAfterResponse = Date.now() - startedAt;
    if (elapsedAfterResponse >= maxElapsedMs) {
      emit({ kind: 'model_response_over_budget', turn, max_elapsed_ms: maxElapsedMs,
        elapsed_ms: elapsedAfterResponse, tool_execution_skipped: true });
      throw new Error(`condition elapsed-time budget exceeded (${maxElapsedMs}ms)`);
    }
    const message = parsed.message;
    if (!message || message.role !== 'assistant') throw new Error('Ollama response did not contain an assistant message');
    emit({ kind: 'model_response', turn, response: parsed });
    conversation.push(message);
    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls)) throw new Error('model tool_calls must be an array when present');
    if (!calls.length) {
      return { model, finalMessage: message, messages: conversation, events,
        toolCallCount: toolCalls, modelTurnCount: turn, elapsedMs: Date.now() - startedAt,
        finalResponse: parsed };
    }
    if (calls.length > 1) {
      const firstOrdinal = toolCalls + 1;
      for (const [index, requested] of calls.entries()) emit({ kind: 'tool_policy_decision', turn, native: true, disposition: 'denied',
        tool_name: requested?.function?.name ?? null, model_call_id: requested?.id ?? null,
        call_index: firstOrdinal + index,
        arguments_sha256: sha256(JSON.stringify(requested?.function?.arguments ?? {})),
        reason: 'parallel/multiple tool calls in one assistant turn are denied; no call was executed, reissue exactly one call and wait for its result' });
      toolCalls += calls.length;
      if (toolCalls > maxToolCalls) throw new Error(`tool-call limit exceeded (${maxToolCalls}) after rejecting a multi-call turn`);
      for (const requested of calls) conversation.push({ role: 'tool', tool_name: requested?.function?.name ?? 'unknown',
        tool_call_id: requested?.id ?? null,
        content: JSON.stringify({ error: 'Policy denial: only one tool call is permitted per assistant turn. No requested tool was executed. Reissue exactly one tool call and wait for its result before deciding the next action.' }) });
      emit({ kind: 'parallel_tool_turn_rejected', turn, denied_calls: calls.length,
        call_ids: calls.map(item => item?.id ?? null), no_side_effects: true });
      continue;
    }
    toolCalls++;
    const call = calls[0];
    const name = call?.function?.name;
    const args = call?.function?.arguments ?? {};
    if (toolCalls > maxToolCalls) {
      emit({ kind: 'tool_policy_decision', turn, native: true, disposition: 'denied',
        tool_name: typeof name === 'string' ? name : null, model_call_id: call?.id ?? null,
        call_index: toolCalls,
        arguments_sha256: sha256(JSON.stringify(args)),
        reason: `tool-call limit exceeded (${maxToolCalls})` });
      throw new Error(`tool-call limit exceeded (${maxToolCalls})`);
    }
    if (typeof name !== 'string' || !allowed.has(name)) {
      emit({ kind: 'tool_policy_decision', turn, native: true, disposition: 'denied',
        tool_name: typeof name === 'string' ? name : null, model_call_id: call?.id ?? null,
        call_index: toolCalls,
        arguments_sha256: sha256(JSON.stringify(args)),
        reason: 'tool is outside the effective allowlist' });
      throw new Error(`model requested a tool outside the effective allowlist: ${String(name)}`);
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      emit({ kind: 'tool_policy_decision', turn, native: true, disposition: 'denied', tool_name: name,
        model_call_id: call?.id ?? null, call_index: toolCalls, arguments_sha256: sha256(JSON.stringify(args)),
        reason: 'tool arguments must be an object' });
      throw new Error(`tool arguments for ${name} must be an object`);
    }
    emit({ kind: 'model_tool_call', turn, native: true, tool_name: name, arguments: structuredClone(args),
      arguments_sha256: sha256(JSON.stringify(args)), call_index: toolCalls, model_call_id: call.id ?? null });
    assertWithinBudget(turn, 'before_tool_execution');
    let result;
    try {
      result = await executeTool(name, structuredClone(args), { turn, callIndex: toolCalls,
        modelCallId: call.id ?? null, model, conversation: structuredClone(conversation) });
    } catch (error) {
      const messageText = String(error?.message ?? error);
      emit({ kind: 'tool_execution_error', turn, native: true, disposition: 'error', tool_name: name,
        model_call_id: call.id ?? null, call_index: toolCalls,
        arguments_sha256: sha256(JSON.stringify(args)), error: messageText,
        recoverable_policy_denial: error?.recoverableToolDenial === true });
      if (error?.recoverableToolDenial === true) {
        conversation.push({ role: 'tool', tool_name: name, tool_call_id: call?.id ?? null,
          content: JSON.stringify({ error: messageText, policy_denial: true, recoverable: true }) });
        emit({ kind: 'tool_policy_feedback', turn, tool_name: name, call_index: toolCalls, message: messageText });
        continue;
      }
      throw error;
    }
    const resultText = typeof result === 'string' ? result : JSON.stringify(result);
    emit({ kind: 'tool_result', turn, native: true, disposition: 'executed', tool_name: name,
      model_call_id: call.id ?? null, call_index: toolCalls,
      arguments_sha256: sha256(JSON.stringify(args)), result_sha256: sha256(resultText), result: structuredClone(result) });
    conversation.push({ role: 'tool', tool_name: name, content: resultText });
    assertWithinBudget(turn, 'before_after_tool_call');
    const injected = await afterToolCall({ name, args: structuredClone(args), result: structuredClone(result), turn, callIndex: toolCalls, conversation: structuredClone(conversation) });
    if (injected !== null && injected !== undefined) {
      const content = typeof injected === 'string' ? injected : JSON.stringify(injected);
      conversation.push({ role: 'user', content });
      emit({ kind: 'harness_injected_user_event', turn, after_tool_call_index: toolCalls, content });
    }
  }
  throw new Error(`model-turn limit exceeded (${maxTurns}) without a final answer; elapsed_ms=${Date.now() - startedAt}`);
}

export { sha256 as sha256ForToolLoop };
