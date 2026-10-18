import assert from 'node:assert/strict';
import { parseOpenClawMessageReceipt } from '../src/runtime/openclaw-message-receipt.js';

for (const [name, raw] of [
  ['empty', ''],
  ['whitespace', '  \n '],
  ['non-json', 'sent'],
  ['null', 'null'],
  ['array', '[]'],
  ['empty object', '{}'],
  ['status only', '{"status":"completed"}'],
  ['explicit false', '{"ok":false,"messageId":"123"}'],
  ['duplicate success override', '{"ok":false,"ok":true,"messageId":"123"}'],
  ['escaped duplicate error override', '{"ok":false,"ok\\u005f":true,"messageId":"123"}'],
  ['top-level error', '{"error":"rate limited","messageId":"123"}'],
  ['nested error', '{"result":{"error":"rejected","messageId":"123"}}'],
  ['nested message error', '{"message":{"ok":false,"messageId":"123"}}'],
  ['array-wrapped failed status masked by top-level ID', '{"messageId":"looks-delivered","result":[{"status":"failed"}]}'],
  ['array-wrapped nested error masked by top-level ID', '{"messageId":"looks-delivered","data":[{"error":"destination rejected"}]}'],
  ['array-wrapped unknown state masked by top-level ID', '{"messageId":"looks-delivered","response":[{"state":"pending-ish"}]}'],
  ['array-wrapped conflicting aliases masked by top-level ID', '{"messageId":"looks-delivered","payload":[{"status":"completed","state":"rejected"}]}'],
  ['array-wrapped conflicting destination IDs', '{"result":[{"messageId":"m-1"},{"message_id":"m-2"}]}'],
  ['error hidden beyond the former wrapper-depth limit', (() => {
    let nested = { error: 'destination rejected' };
    for (const key of ['message', 'payload', 'response', 'data', 'result']) nested = { [key]: nested };
    return JSON.stringify({ messageId: 'looks-delivered', result: nested });
  })()],
  ['pathologically deep error wrapper', (() => {
    let nested = { error: 'destination rejected' };
    for (let index = 0; index < 34; index++) nested = { result: nested };
    return JSON.stringify({ messageId: 'looks-delivered', result: nested });
  })()],
  ['failed status', '{"status":"failed","messageId":"123"}'],
  ['unknown top-level status', '{"status":"pending-ish","messageId":"123"}'],
  ['queued is not a delivered message receipt', '{"status":"queued","messageId":"123"}'],
  ['running is not a delivered message receipt', '{"status":"running","messageId":"123"}'],
  ['in progress is not a delivered message receipt', '{"status":"in_progress","messageId":"123"}'],
  ['unknown state alias', '{"state":"sent-to-maybe","ts":"171234.0001"}'],
  ['unknown status hidden in nested result', '{"status":"completed","result":{"status":"pending-ish"},"messageId":"123"}'],
  ['unknown state hidden in nested data', '{"data":{"state":"accepted-ish","message_id":"123"}}'],
  ['conflicting status state aliases', '{"status":"completed","state":"failed","messageId":"123"}'],
  ['null status hidden by state', '{"status":null,"state":"completed","messageId":"123"}'],
  ['blank status hidden by state', '{"status":"  ","state":"completed","messageId":"123"}'],
  ['non-boolean ok field', '{"ok":"true","messageId":"123"}'],
  ['conflicting destination ID aliases', '{"messageId":"123","message_id":"124"}'],
  ['conflicting destination IDs across success wrappers', '{"messageId":"root-message","result":{"message_id":"nested-message"}}'],
  ['conflicting destination IDs across data and message wrappers', '{"data":{"ts":"171234.0001"},"message":{"ts":"171235.0002"}}'],
  ['malformed destination ID hidden by alias', '{"messageId":123,"ts":"171234.0001"}'],
  ['nested conflicting status aliases', '{"result":{"status":"completed","state":"rejected"},"messageId":"123"}'],
  ['nested malformed ok field', '{"data":{"ok":"false"},"messageId":"123"}'],
  ['nested conflicting destination IDs', '{"result":{"messageId":"123","ts":"124"}}'],
]) {
  assert.throws(() => parseOpenClawMessageReceipt(raw), undefined, `${name} must not be accepted as delivery proof`);
}
assert.throws(() => parseOpenClawMessageReceipt(Buffer.from([0x7b,0x22,0x6f,0x6b,0x22,0x3a,0x74,0x72,0x75,0x65,0x2c,0x22,0x6d,0x65,0x73,0x73,0x61,0x67,0x65,0x49,0x64,0x22,0x3a,0x22,0xff,0x22,0x7d])), /invalid UTF-8/);

assert.equal(parseOpenClawMessageReceipt('{"messageId":"171234.0001"}').messageId, '171234.0001');
assert.equal(parseOpenClawMessageReceipt('{"result":{"message_id":"m-2"}}').messageId, 'm-2');
assert.equal(parseOpenClawMessageReceipt('{"result":[{"message_id":"m-array"}]}').messageId, 'm-array',
  'a single unambiguous destination receipt wrapped in an array must remain supported');
assert.equal(parseOpenClawMessageReceipt('{"data":{"message":{"ts":"171235.0002"}}}').messageId, '171235.0002');
assert.equal(parseOpenClawMessageReceipt('{"type":"message","id":"m-3"}').messageId, 'm-3');
assert.throws(() => parseOpenClawMessageReceipt('{"runId":"agent-run-1"}'), /no destination message identifier/);
assert.throws(() => parseOpenClawMessageReceipt('{"messageId":171234.0003}'), /destination message identifier/,
  'numeric destination timestamps must not be coerced after JSON number rounding');
assert.throws(() => parseOpenClawMessageReceipt('{"type":"message","id":9007199254740991}'), /destination message identifier/,
  'numeric message IDs must remain untrusted even when representable as safe integers');
console.log('test-openclaw-message-receipt: PASS');
