import { execFile } from 'node:child_process';
import { validateEnvelope, validatePayload } from './protocol/cos-ap-v1/index.js';

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';

function runOpenClaw(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(OPENCLAW_BIN, args, { timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(stderr?.trim() || error.message);
        err.code = error.code;
        err.stdout = stdout || '';
        err.stderr = stderr || '';
        reject(err);
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

export function parseOpenClawAgentReceipt(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return { raw: '', status: 'EMPTY' };
  try {
    const parsed = JSON.parse(raw);
    return {
      raw,
      status: 'OK',
      runId: parsed.runId || parsed.run_id || parsed.id || null,
      sessionKey: parsed.sessionKey || parsed.session_key || parsed.childSessionKey || null,
      result: parsed.result ?? parsed.response ?? parsed.output ?? null,
      payload: parsed
    };
  } catch (_) {
    return { raw, status: 'NON_JSON', result: raw };
  }
}

export function buildDurableWireEnvelope(session, message) {
  if (!session?.job_id) throw new Error('Session has no durable job_id');
  if (!message?.message_id) throw new Error('Message has no message_id');
  let payload = {};
  try { payload = JSON.parse(message.payload_json || '{}'); } catch (_) { payload = { raw: message.payload_json }; }
  let protocolEnvelope = null;
  if (message.protocol === 'cos-ap' && Number(message.protocol_version) === 1) {
    protocolEnvelope = validateEnvelope({
      protocol: message.protocol,
      version: Number(message.protocol_version),
      message_id: message.message_id,
      message_type: message.message_type,
      job_id: session.job_id,
      task_id: session.task_id || null,
      attempt: Math.max(1, Number(message.attempt) || 1),
      sender: message.sender_role,
      recipient: message.recipient_role,
      correlation_id: message.correlation_id || null,
      created_at: message.created_at,
      payload
    });
    validatePayload(protocolEnvelope.message_type, protocolEnvelope.payload);
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
  const wireEnvelope = buildDurableWireEnvelope(session, message);
  const args = [
    'agent', '--agent', String(session.role), '--session-key', session.openclaw_session_key,
    '--message', wireEnvelope, '--json', '--timeout', String(Math.max(1, Number(timeoutSeconds) || 120))
  ];
  const startedAt = new Date().toISOString();
  const result = await runOpenClaw(args, { timeoutMs: Math.max(5_000, Number(timeoutSeconds) * 1000 + 5_000) });
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
