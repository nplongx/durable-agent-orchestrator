import { spawn } from 'node:child_process';
import { validateEnvelope, validatePayload } from '../../protocol/cos-ap-v1/index.js';
import { parseStrictJson } from './strict-json.js';

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Keep the CLI's timeout and the adapter's kill timer within the platform's
// supported timer range. Otherwise coercible values like 0, null, or NaN make
// the CLI default to 120 seconds while the adapter aborts after five seconds;
// Infinity overflows Node's timer and can collapse to an immediate timeout.
const MAX_OPENCLAW_TIMEOUT_SECONDS = Math.floor((MAX_TIMER_DELAY_MS - 5_000) / 1_000);
// A correlated run ID proves which invocation a receipt refers to; it does not
// turn an unknown or malformed status into a successful delivery receipt.
// Older OpenClaw builds omit status, so absence remains backward compatible,
// but any supplied status must be an explicitly recognized non-failure state.
const OPENCLAW_ACCEPTED_RECEIPT_STATUSES = new Set([
  'ok', 'success', 'accepted', 'completed', 'queued', 'running', 'in_progress'
]);
const OPENCLAW_RUN_ID_FIELDS = ['runId', 'run_id', 'id'];
const OPENCLAW_SESSION_KEY_FIELDS = ['sessionKey', 'session_key', 'childSessionKey'];

function consistentReceiptAliases(parsed, fields, label, { optional = false, normalize = value => value } = {}) {
  const supplied = fields.filter(field => Object.prototype.hasOwnProperty.call(parsed, field));
  if (!supplied.length) return optional ? { value: null } : { error: `OpenClaw --json receipt has no ${label}` };
  const values = [];
  for (const field of supplied) {
    const value = parsed[field];
    if (typeof value !== 'string' || !value.trim()) {
      return { error: `OpenClaw --json receipt has an invalid ${label} field (${field}); remote outcome is ambiguous` };
    }
    values.push(normalize(value));
  }
  if (values.some(value => value !== values[0])) {
    return { error: `OpenClaw --json receipt has conflicting ${label} aliases; remote outcome is ambiguous` };
  }
  return { value: parsed[supplied[0]] };
}

function diagnosticText(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return new TextDecoder('utf-8').decode(value);
  return String(value || '');
}

export function runOpenClaw(args, { timeoutMs = 120_000, maxOutputBytes = 8 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    return Promise.reject(new RangeError(`OpenClaw timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`));
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 64 * 1024 * 1024) {
    return Promise.reject(new RangeError('OpenClaw maxOutputBytes must be a positive safe integer no greater than 67108864'));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      // On POSIX, isolate the CLI in its own process group. execFile's built-in
      // timeout signals only the direct child; a shell/CLI descendant holding
      // stdout open can survive and keep the callback pending indefinitely.
      child = spawn(OPENCLAW_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    } catch (error) {
      // A synchronous spawn failure means no CLI process existed to send the
      // request. Preserve that distinction for the durable delivery state
      // machine; timeouts and failures after a child has a PID remain ambiguous.
      error.deliveryOutcome = 'not_sent';
      error.externalSideEffectCommitted = false;
      error.transportCode = error.code || 'SPAWN_ERROR';
      reject(error);
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let totalBytes = 0;
    let abortReason = null;
    let killSent = false;
    let closeInfo = null;
    let settled = false;
    let timeoutTimer;
    let killTimer;
    const signalGroup = signal => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          try { child.kill(signal); } catch {}
        }
      }
    };
    const stdout = () => Buffer.concat(stdoutChunks, stdoutBytes);
    const stderr = () => Buffer.concat(stderrChunks, stderrBytes);
    const finishAbort = () => {
      // Do not wait for `close`: a descendant outside the original process
      // group may retain inherited stdout/stderr descriptors indefinitely.
      // The local delivery result is already ambiguous at this point; close
      // our pipe ends and return without claiming the descendant was stopped.
      if (!abortReason || !killSent || settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      const out = stdout();
      const err = stderr();
      child.stdout?.destroy();
      child.stderr?.destroy();
      const error = new Error(`${abortReason}; termination signals were sent to the CLI process group where supported; external effects remain uncertain`);
      error.code = abortReason === 'OpenClaw transport timed out' ? 'ETIMEDOUT' : 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      error.transportCode = abortReason === 'OpenClaw transport timed out' ? 'TIMEOUT' : 'OUTPUT_LIMIT';
      error.stdout = out;
      error.stderr = diagnosticText(err).trim();
      reject(error);
    };
    const abort = reason => {
      if (abortReason || settled) return;
      abortReason = reason;
      signalGroup('SIGTERM');
      // Always send SIGKILL after the grace interval, even if the group leader
      // closes first: descendants may have inherited neither pipe and outlive it.
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        killSent = true;
        finishAbort();
      }, 300);
    };
    const collect = (chunks, which, chunk) => {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;
      const remaining = Math.max(0, maxOutputBytes - (stdoutBytes + stderrBytes));
      if (remaining > 0) {
        const accepted = bytes.subarray(0, remaining);
        chunks.push(Buffer.from(accepted));
        if (which === 'stdout') stdoutBytes += accepted.length;
        else stderrBytes += accepted.length;
      }
      if (totalBytes > maxOutputBytes) abort(`OpenClaw transport exceeded ${maxOutputBytes} combined stdout/stderr bytes`);
    };
    child.stdout.on('data', chunk => collect(stdoutChunks, 'stdout', chunk));
    child.stderr.on('data', chunk => collect(stderrChunks, 'stderr', chunk));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      // Node emits `error` for spawn failures such as ENOENT/EACCES before a
      // child PID exists. That is a known local no-send outcome; once a PID
      // exists, conservatively preserve ambiguity because the CLI may already
      // have crossed its remote side-effect boundary.
      if (child.pid == null) {
        error.deliveryOutcome = 'not_sent';
        error.externalSideEffectCommitted = false;
        error.transportCode = error.code || 'SPAWN_ERROR';
      }
      reject(error);
    });
    child.once('close', (code, signal) => {
      closeInfo = { code, signal };
      if (abortReason) { finishAbort(); return; }
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      const out = stdout();
      const err = diagnosticText(stderr()).trim();
      if (code !== 0) {
        const error = new Error(err || `OpenClaw CLI exited ${signal ? `on ${signal}` : `with status ${code}`}`);
        error.code = code === null ? (signal || 'TRANSPORT_ERROR') : code;
        error.transportCode = 'TRANSPORT_ERROR';
        error.stdout = out;
        error.stderr = err;
        reject(error);
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
    timeoutTimer = setTimeout(() => abort('OpenClaw transport timed out'), timeoutMs);
  });
}

function findNestedReceiptError(value, depth = 0) {
  if (value === null || typeof value !== 'object') return null;
  if (depth > 32) return 'receipt wrapper nesting exceeds the supported depth';
  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedError = findNestedReceiptError(item, depth + 1);
      if (nestedError) return nestedError;
    }
    return null;
  }

  const statuses = [];
  for (const field of ['status', 'state']) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (typeof value[field] !== 'string' || !value[field].trim()) return 'malformed nested ' + field + ' field';
    statuses.push(value[field].trim().toLowerCase());
  }
  if (statuses.length === 2 && statuses[0] !== statuses[1]) return 'conflicting nested status/state fields';
  const status = statuses[0] || '';
  if (['error', 'failed', 'failure', 'rejected'].includes(status)) return 'nested receipt reported ' + status;
  if (status && !OPENCLAW_ACCEPTED_RECEIPT_STATUSES.has(status)) return 'unsupported nested status/state value: ' + status;

  if (Object.prototype.hasOwnProperty.call(value, 'ok') && typeof value.ok !== 'boolean') return 'malformed nested ok field';
  if (value.ok === false) return 'nested receipt reported ok=false';
  for (const field of ['error', 'errorMessage', 'error_message', 'failure']) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const errorValue = value[field];
    if (errorValue !== null && typeof errorValue !== 'string') return 'malformed nested ' + field + ' field';
    if (typeof errorValue === 'string' && errorValue.trim()) return 'nested receipt reported ' + field;
  }

  // Only inspect known OpenClaw response wrappers. Do not recursively treat
  // arbitrary user result fields as transport metadata. Arrays under a known
  // wrapper are checked item-by-item; unknown states fail closed.
  for (const key of ['result', 'response', 'output', 'payload']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const nestedError = findNestedReceiptError(value[key], depth + 1);
    if (nestedError) return nestedError;
  }
  return null;
}

export function parseOpenClawAgentReceipt(stdout) {
  let raw;
  if (Buffer.isBuffer(stdout) || stdout instanceof Uint8Array) {
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout).trim(); }
    catch { return { raw: '<invalid UTF-8 receipt bytes>', status: 'ERROR', error: 'OpenClaw --json returned invalid UTF-8 bytes; remote outcome is ambiguous' }; }
  } else raw = String(stdout || '').trim();
  if (!raw) return { raw: '', status: 'EMPTY' };
  try {
    const parsed = parseStrictJson(raw, 'OpenClaw agent receipt');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { raw, status: 'ERROR', error: 'OpenClaw returned a JSON receipt that is not an object', payload: parsed };
    }
    const hasStatus = Object.prototype.hasOwnProperty.call(parsed, 'status');
    const hasState = Object.prototype.hasOwnProperty.call(parsed, 'state');
    const statusValues = [];
    for (const field of ['status', 'state']) {
      if (!Object.prototype.hasOwnProperty.call(parsed, field)) continue;
      if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
        return { raw, status: 'ERROR', error: `OpenClaw --json receipt has a malformed ${field}; remote outcome is ambiguous`, payload: parsed };
      }
      statusValues.push(parsed[field].trim().toLowerCase());
    }
    if (statusValues.length === 2 && statusValues[0] !== statusValues[1]) {
      return { raw, status: 'ERROR', error: 'OpenClaw --json receipt has conflicting status/state fields; remote outcome is ambiguous', payload: parsed };
    }
    const rawStatus = hasStatus ? parsed.status : hasState ? parsed.state : undefined;
    const reportedStatus = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
    if (Object.prototype.hasOwnProperty.call(parsed, 'ok') && typeof parsed.ok !== 'boolean') {
      return { raw, status: 'ERROR', error: 'OpenClaw --json receipt has a malformed ok field; remote outcome is ambiguous', payload: parsed };
    }
    // Do not let a blank/falsy preferred alias hide a populated alternate
    // error field (for example {error:"", errorMessage:"rejected"}). These
    // aliases are remote-controlled receipt data, so inspect all of them and
    // fail closed on type coercion instead of relying on nullish precedence.
    let reportedError = null;
    for (const field of ['error', 'errorMessage', 'error_message', 'failure']) {
      if (!Object.prototype.hasOwnProperty.call(parsed, field)) continue;
      const value = parsed[field];
      if (value !== null && typeof value !== 'string') {
        return { raw, status: 'ERROR', error: `OpenClaw --json receipt has a malformed ${field} field; remote outcome is ambiguous`, payload: parsed };
      }
      if (typeof value === 'string' && value.trim() && reportedError === null) reportedError = value;
    }
    if (parsed.ok === false || reportedError || ['error', 'failed', 'failure', 'rejected'].includes(reportedStatus)) {
      return {
        raw,
        status: 'ERROR',
        runId: parsed.runId || parsed.run_id || parsed.id || null,
        sessionKey: parsed.sessionKey || parsed.session_key || parsed.childSessionKey || null,
        error: String(reportedError || parsed.message || `OpenClaw reported ${reportedStatus || 'ok=false'}`),
        payload: parsed
      };
    }
    if (rawStatus !== undefined && rawStatus !== null &&
        (typeof rawStatus !== 'string' || !OPENCLAW_ACCEPTED_RECEIPT_STATUSES.has(reportedStatus))) {
      return { raw, status: 'ERROR',
        error: 'OpenClaw --json receipt has an unsupported or malformed status; remote outcome is ambiguous', payload: parsed };
    }
    // The outer CLI envelope can report completion while its nested execution
    // receipt reports a failure or an unknown state. A correlated run ID does
    // not override contradictory remote outcome metadata; inspect known wrappers
    // before ACKing the durable session message.
    for (const field of ['result', 'response', 'output', 'payload']) {
      if (!Object.prototype.hasOwnProperty.call(parsed, field)) continue;
      const nestedError = findNestedReceiptError(parsed[field]);
      if (nestedError) {
        return { raw, status: 'ERROR',
          error: 'OpenClaw --json nested receipt is not a verified success (' + nestedError + '); remote outcome is ambiguous',
          payload: parsed };
      }
    }
    // Aliases are accepted for CLI compatibility, but if multiple aliases are
    // present they must agree exactly. Otherwise a later consumer could bind
    // the receipt to a different invocation than this parser did.
    const runIdentity = consistentReceiptAliases(parsed, OPENCLAW_RUN_ID_FIELDS, 'valid string runId');
    if (runIdentity.error) return { raw, status: 'ERROR', error: runIdentity.error, payload: parsed };
    const sessionIdentity = consistentReceiptAliases(parsed, OPENCLAW_SESSION_KEY_FIELDS, 'sessionKey', { optional: true });
    if (sessionIdentity.error) return { raw, status: 'ERROR', runId: runIdentity.value, error: sessionIdentity.error, payload: parsed };
    const runId = runIdentity.value;
    const sessionKey = sessionIdentity.value;
    const result = parsed.result ?? parsed.response ?? parsed.output ?? parsed.payload ?? null;
    return {
      raw,
      status: 'OK',
      runId,
      sessionKey,
      result,
      payload: parsed
    };
  } catch (error) {
    // This transport always invokes `openclaw agent --json`. Plain text is not
    // a weaker success receipt: it is a malformed response whose remote side
    // effect may already have occurred. The managed sender must quarantine it
    // instead of ACKing or automatically replaying the message.
    const ambiguousJson = /duplicate decoded object key/.test(String(error?.message || ''));
    return { raw, status: 'ERROR', error: ambiguousJson
      ? 'OpenClaw --json returned an ambiguous JSON receipt with duplicate decoded keys; remote outcome is ambiguous'
      : 'OpenClaw --json returned a non-JSON receipt; remote outcome is ambiguous' };
  }
}

export function buildDurableWireEnvelope(session, message) {
  if (!session?.job_id) throw new Error('Session has no durable job_id');
  if (!message?.message_id) throw new Error('Message has no message_id');
  // A corrupt or ambiguous durable payload must never be transformed into a
  // different message and sent remotely. Strict parsing rejects duplicate
  // decoded keys and unsafe identity-like numbers instead of silently choosing
  // a last value or rounding it.
  const payload = parseStrictJson(message.payload_json, 'durable session message payload');
  let protocolEnvelope = null;
  if (message.protocol === 'cos-ap') {
    // Persisted protocol metadata is part of the delivery contract. Never
    // silently downgrade a corrupt/unsupported COS-AP message to legacy wire
    // format: doing so would erase its version and attempt identity at the
    // external boundary. SQLite values are durable but not inherently trusted.
    if (message.protocol_version !== 1) {
      throw new Error(`unsupported or malformed durable session protocol version: ${String(message.protocol_version)}`);
    }
    if (!Number.isSafeInteger(message.attempt) || message.attempt < 1) {
      throw new Error('durable COS-AP session message attempt must be a positive safe integer');
    }
    protocolEnvelope = validateEnvelope({
      protocol: message.protocol,
      version: message.protocol_version,
      message_id: message.message_id,
      message_type: message.message_type,
      job_id: session.job_id,
      task_id: session.task_id || null,
      attempt: message.attempt,
      sender: message.sender_role,
      recipient: message.recipient_role,
      correlation_id: message.correlation_id || null,
      created_at: message.created_at,
      payload
    });
    validatePayload(protocolEnvelope.message_type, protocolEnvelope.payload);
  } else if (message.protocol !== 'legacy' || message.protocol_version !== 0) {
    throw new Error(`unsupported or malformed durable session protocol: ${String(message.protocol)} v${String(message.protocol_version)}`);
  }
  return [
    '[DURABLE SESSION MESSAGE]',
    protocolEnvelope ? JSON.stringify(protocolEnvelope) : JSON.stringify({
      message_id: message.message_id,
      message_type: message.message_type,
      sender_role: message.sender_role,
      recipient_role: message.recipient_role,
      correlation_id: message.correlation_id || null,
      payload
    }),
    '',
    'Process this message in the existing session. Do not create a replacement session.'
  ].filter(Boolean).join('\n');
}

export async function deliverSessionMessage(session, message, { timeoutSeconds = 120 } = {}) {
  if (!session?.openclaw_session_key) throw new Error('Session has no durable openclaw_session_key');
  if (!message?.message_id) throw new Error('Message has no message_id');
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_OPENCLAW_TIMEOUT_SECONDS) {
    throw new RangeError(`timeoutSeconds must be a positive safe integer between 1 and ${MAX_OPENCLAW_TIMEOUT_SECONDS}`);
  }
  const wireEnvelope = buildDurableWireEnvelope(session, message);
  const args = [
    'agent', '--agent', String(session.role), '--session-key', session.openclaw_session_key,
    '--message', wireEnvelope, '--json', '--timeout', String(timeoutSeconds)
  ];
  const startedAt = new Date().toISOString();
  const result = await runOpenClaw(args, { timeoutMs: timeoutSeconds * 1000 + 5_000 });
  const finishedAt = new Date().toISOString();
  return { startedAt, finishedAt, ...parseOpenClawAgentReceipt(result.stdout), stderr: result.stderr };
}

export function classifyTransportError(error) {
  const text = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase();
  if (/timeout|timed out|deadline/.test(text)) return 'TIMEOUT';
  if (/rate.?limit|429|too many requests/.test(text)) return 'RATE_LIMIT';
  if (/session.*not found|unknown session|invalid session/.test(text)) return 'SESSION_NOT_FOUND';
  return 'TRANSPORT_ERROR';
}
