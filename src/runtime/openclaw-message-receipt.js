import { parseStrictJson } from './strict-json.js';

const ACCEPTED_MESSAGE_RECEIPT_STATUSES = new Set([
  'ok', 'success', 'accepted', 'completed', 'sent', 'delivered'
]);
const FAILURE_MESSAGE_RECEIPT_STATUSES = new Set(['error', 'failed', 'failure', 'rejected']);

// A successful CLI exit is not proof that a destination message was accepted.
// Slack projection state is committed only when OpenClaw returns a parseable,
// non-error receipt carrying a destination message identifier.
export function parseOpenClawMessageReceipt(stdout) {
  let raw;
  if (Buffer.isBuffer(stdout) || stdout instanceof Uint8Array) {
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout).trim(); }
    catch { throw new Error('OpenClaw message send returned invalid UTF-8 receipt bytes; remote outcome is ambiguous'); }
  } else raw = String(stdout ?? '').trim();
  if (!raw) throw new Error('OpenClaw message send returned an empty receipt');

  let parsed;
  try { parsed = parseStrictJson(raw, 'OpenClaw message send receipt'); }
  catch (error) {
    const ambiguousJson = /duplicate decoded object key/.test(String(error?.message || ''));
    throw new Error(ambiguousJson
      ? 'OpenClaw message send returned an ambiguous JSON receipt with duplicate decoded keys; remote outcome is ambiguous'
      : 'OpenClaw message send returned a non-JSON receipt; remote outcome is ambiguous');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenClaw message send returned a non-object receipt');
  }

  const findError = (value, depth = 0) => {
    if (!value || typeof value !== 'object') return null;
    // Receipts are untrusted JSON. Do not let an error hidden one wrapper
    // deeper than the old search limit coexist with a top-level message ID
    // and get misclassified as a successful delivery. Follow only known
    // response-wrapper keys, but fail closed if that chain is pathologically
    // deep rather than silently treating the uninspected tail as success.
    if (depth > 32) return 'receipt wrapper nesting exceeds the supported depth';
    // Inspect every supplied alias. Precedence/nullish-coalescing must not
    // hide malformed or conflicting status/identity metadata in a success-
    // shaped receipt.
    const hasStatus = Object.prototype.hasOwnProperty.call(value, 'status');
    const hasState = Object.prototype.hasOwnProperty.call(value, 'state');
    const statuses = [];
    for (const field of ['status', 'state']) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
      if (typeof value[field] !== 'string' || !value[field].trim()) return `malformed ${field} field`;
      statuses.push(value[field].trim().toLowerCase());
    }
    if (hasStatus && hasState && statuses[0] !== statuses[1]) return 'conflicting status/state fields';
    if (statuses.some(status => FAILURE_MESSAGE_RECEIPT_STATUSES.has(status))) {
      return `reported ${statuses[0]} status`;
    }
    const unknownStatus = statuses.find(status => !ACCEPTED_MESSAGE_RECEIPT_STATUSES.has(status));
    if (unknownStatus) return `unsupported status/state value: ${unknownStatus}`;
    if (Object.prototype.hasOwnProperty.call(value, 'ok') && typeof value.ok !== 'boolean') return 'malformed ok field';
    const idFields = ['messageId', 'message_id', 'ts'];
    if (value.type === 'message' && Object.prototype.hasOwnProperty.call(value, 'id')) idFields.push('id');
    const suppliedIds = idFields.filter(field => Object.prototype.hasOwnProperty.call(value, field));
    const ids = [];
    for (const field of suppliedIds) {
      if (typeof value[field] !== 'string' || !value[field].trim()) return `malformed ${field} destination message identifier`;
      ids.push(value[field]);
    }
    if (ids.some(id => id !== ids[0])) return 'conflicting destination message identifier aliases';
    if (value.ok === false) return value.error ?? value.message ?? 'ok=false';
    for (const key of ['error', 'errorMessage', 'error_message', 'failure']) {
      if (value[key] != null && value[key] !== '') return value[key];
    }
    for (const key of ['result', 'data', 'response', 'payload', 'message']) {
      const nested = value[key];
      // Some CLI/API versions wrap a single send receipt in a list (for
      // example, a batch-shaped `result`). Arrays are still untrusted receipt
      // structure: inspecting only object wrappers lets a top-level messageId
      // mask a nested rejection, unknown state, or conflicting alias.
      if (Array.isArray(nested)) {
        for (const item of nested) {
          const error = findError(item, depth + 1);
          if (error) return error;
        }
      } else {
        const error = findError(nested, depth + 1);
        if (error) return error;
      }
    }
    return null;
  };
  const reportedError = findError(parsed);
  const status = String(parsed.status ?? parsed.state ?? '').trim().toLowerCase();
  if (reportedError || FAILURE_MESSAGE_RECEIPT_STATUSES.has(status)) {
    throw new Error(`OpenClaw message send reported failure: ${String(reportedError ?? status)}`);
  }

  const collectMessageIds = (value, depth = 0, ids = []) => {
    if (!value || typeof value !== 'object') return ids;
    if (depth > 32) throw new Error('OpenClaw message send receipt wrapper nesting exceeds supported depth');
    if (Array.isArray(value)) {
      for (const item of value) collectMessageIds(item, depth + 1, ids);
      return ids;
    }
    for (const key of ['messageId', 'message_id', 'ts']) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const id = value[key];
      // Destination IDs (notably Slack `ts`) are opaque strings. Coercing a JSON
      // number can silently change decimal timestamp IDs or collapse precision.
      if (typeof id !== 'string' || !id.trim()) {
        throw new Error(`OpenClaw message send receipt has malformed ${key} destination message identifier; remote outcome is ambiguous`);
      }
      ids.push(id);
    }
    // A generic `id` is accepted only on an object that looks like a message
    // receipt, avoiding accidentally treating a request/run identifier as a
    // Slack message timestamp.
    if (value.type === 'message' && Object.prototype.hasOwnProperty.call(value, 'id')) {
      if (typeof value.id !== 'string' || !value.id.trim()) {
        throw new Error('OpenClaw message send receipt has malformed message.id destination identifier; remote outcome is ambiguous');
      }
      ids.push(value.id);
    }
    for (const key of ['result', 'data', 'response', 'payload', 'message']) {
      collectMessageIds(value[key], depth + 1, ids);
    }
    return ids;
  };
  const messageIds = collectMessageIds(parsed);
  if (messageIds.some(id => id !== messageIds[0])) {
    throw new Error('OpenClaw message send receipt contains conflicting destination message identifiers across wrappers; remote outcome is ambiguous');
  }
  const messageId = messageIds[0] || null;
  if (!messageId) throw new Error('OpenClaw message send receipt has no destination message identifier; remote outcome is ambiguous');
  return { ...parsed, messageId };
}
