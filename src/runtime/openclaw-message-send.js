import { runOpenClaw } from './session-transport.js';
import { parseOpenClawMessageReceipt } from './openclaw-message-receipt.js';

const MESSAGE_SEND_TIMEOUT_MS = 45_000;
const MESSAGE_SEND_MAX_OUTPUT_BYTES = 1024 * 1024;

// Host-runtime Slack projection sender. Reuse the bounded process-group
// transport used by session delivery instead of execFile's direct-child
// timeout, which may wait indefinitely if a descendant retains pipe handles.
// A non-zero exit after spawn remains ambiguous: the destination may have
// accepted the message before the CLI failed. Only a proven no-spawn error is
// classified as not-sent; the caller must not infer remote delivery semantics
// from a local process exit or a mock response.
export async function sendOpenClawMessage({ channel, target, message, replyTo = null } = {}, {
  timeoutMs = MESSAGE_SEND_TIMEOUT_MS,
  maxOutputBytes = MESSAGE_SEND_MAX_OUTPUT_BYTES
} = {}) {
  for (const [field, value] of [['channel', channel], ['target', target], ['message', message]]) {
    if (typeof value !== 'string' || !value.trim()) {
      const error = new TypeError(`OpenClaw message ${field} must be a non-empty string`);
      error.remoteOutcome = 'NOT_SENT';
      throw error;
    }
  }
  if (replyTo !== null && (typeof replyTo !== 'string' || !replyTo.trim())) {
    const error = new TypeError('OpenClaw message replyTo must be null or a non-empty string');
    error.remoteOutcome = 'NOT_SENT';
    throw error;
  }
  const args = [
    'message', 'send', '--channel', channel, '--target', target,
    '--message', message, '--delivery', JSON.stringify({ queuePolicy: 'best_effort' }), '--json'
  ];
  if (replyTo) args.push('--reply-to', replyTo);

  let result;
  try {
    result = await runOpenClaw(args, { timeoutMs, maxOutputBytes });
  } catch (error) {
    error.remoteOutcome = error.deliveryOutcome === 'not_sent' ? 'NOT_SENT' : 'AMBIGUOUS';
    throw error;
  }
  try {
    return parseOpenClawMessageReceipt(result.stdout);
  } catch (error) {
    error.remoteOutcome = 'AMBIGUOUS';
    throw error;
  }
}
