// test-ram-optimization-e2e.js
// End-to-end trace & verification for "Lập kế hoạch tối ưu RAM"
import assert from 'node:assert';

const ADAPTER_URL = 'http://127.0.0.1:8318/v1/chat/completions';

async function runTest() {
  console.log('======================================================================');
  console.log('🚀 KIỂM THỬ E2E LUỒNG NGHIỆP VỤ: "Lập kế hoạch tối ưu RAM"');
  console.log('======================================================================');

  // STEP 1: Boss sends "Lập kế hoạch tối ưu bộ nhớ RAM" to Coordinator
  console.log('\n[BƯỚC 1] Boss nhắn trên WhatsApp: "Lập kế hoạch tối ưu bộ nhớ RAM"');
  const payloadTurn1 = {
    model: 'chatgpt-coordinator',
    messages: [
      { role: 'system', content: 'Runtime: name=Chief of Staff | agent=coordinator' },
      { role: 'user', content: '[Thu 2026-09-25 00:30 GMT+7] Lập kế hoạch tối ưu bộ nhớ RAM' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'sessions_spawn',
          description: 'Spawn a subagent for an approved task',
          parameters: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              task: { type: 'string' }
            },
            required: ['agentId', 'task']
          }
        }
      }
    ],
    stream: false
  };

  const res1 = await fetch(ADAPTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadTurn1)
  });
  const data1 = await res1.json();
  const choice1 = data1.choices?.[0];
  const msg1 = choice1?.message;

  console.log('-> Phản hồi Turn 1 từ Coordinator:');
  console.log('Finish reason:', choice1?.finish_reason);
  console.log('Nội dung đề xuất kế hoạch:\n', msg1?.content || '(trống)');

  assert.strictEqual(choice1?.finish_reason, 'stop', 'Turn 1 must end with stop (proposal text)');
  assert.ok(!msg1?.tool_calls, 'Turn 1 must NOT spawn any subagent before approval');
  assert.ok((msg1?.content || '').toLowerCase().includes('kế hoạch') || (msg1?.content || '').toLowerCase().includes('ram'), 'Turn 1 must contain plan');
  console.log('✅ BƯỚC 1 ĐẠT: Coordinator đề xuất kế hoạch tối ưu RAM và chờ Boss phê duyệt.');

  // STEP 2: Boss approves: "Duyệt"
  console.log('\n----------------------------------------------------------------------');
  console.log('[BƯỚC 2] Boss nhắn trên WhatsApp: "Duyệt"');
  const payloadTurn2 = {
    model: 'chatgpt-coordinator',
    messages: [
      ...payloadTurn1.messages,
      { role: 'assistant', content: msg1.content },
      { role: 'user', content: '[Thu 2026-09-25 00:31 GMT+7] Duyệt' }
    ],
    tools: payloadTurn1.tools,
    stream: false
  };

  const res2 = await fetch(ADAPTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadTurn2)
  });
  const data2 = await res2.json();
  const choice2 = data2.choices?.[0];
  const msg2 = choice2?.message;

  console.log('-> Phản hồi Turn 2 từ Coordinator:');
  console.log('Finish reason:', choice2?.finish_reason);
  console.log('Tool calls:', JSON.stringify(msg2?.tool_calls, null, 2));

  assert.strictEqual(choice2?.finish_reason, 'tool_calls', 'Turn 2 must trigger tool call sessions_spawn');
  const spawnCall = msg2?.tool_calls?.[0];
  assert.strictEqual(spawnCall?.function?.name, 'sessions_spawn');

  const spawnArgs = JSON.parse(spawnCall?.function?.arguments || '{}');
  console.log('Spawn args:', spawnArgs);
  assert.strictEqual(spawnArgs.agentId, 'cto');
  assert.ok(spawnArgs.task.toLowerCase().includes('ram') || spawnArgs.task.toLowerCase().includes('tối ưu'), 'Subagent task MUST retain RAM optimization context!');
  assert.ok(!spawnArgs.task.includes('chat-on-steroids-debate'), 'Task must NOT mention irrelevant debate repository!');
  console.log('✅ BƯỚC 2 ĐẠT: Coordinator phân công CTO với đầy đủ ngữ cảnh nhiệm vụ tối ưu RAM.');

  // STEP 3: Subagent CTO receives task and executes technical inspection
  console.log('\n----------------------------------------------------------------------');
  console.log('[BƯỚC 3] Subagent CTO nhận nhiệm vụ đo đạc RAM thực tế');
  const payloadTurn3 = {
    model: 'chatgpt-cto',
    messages: [
      { role: 'system', content: 'Runtime: name=CTO / Lead Engineer | agent=cto' },
      { role: 'user', content: `[Subagent Task]\n${spawnArgs.task}\nBegin.` }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec',
          description: 'Execute shell command on host',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
          }
        }
      }
    ],
    stream: false
  };

  const res3 = await fetch(ADAPTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadTurn3)
  });
  const data3 = await res3.json();
  const choice3 = data3.choices?.[0];
  const msg3 = choice3?.message;

  console.log('-> Phản hồi Turn 3 từ CTO:');
  console.log('Finish reason:', choice3?.finish_reason);
  console.log('Tool call hoặc Content:\n', msg3?.tool_calls ? JSON.stringify(msg3.tool_calls) : msg3?.content);

  // STEP 4: Subagent completes and reports back to Coordinator
  console.log('\n----------------------------------------------------------------------');
  console.log('[BƯỚC 4] CTO báo cáo hoàn tất kết quả đo đạc RAM -> Coordinator nhận kết quả');
  const ramReport = `Kết quả kiểm tra RAM hệ thống:
- Tổng RAM: 15.6 GB, Đang dùng: 10.8 GB, Khả dụng: 4.8 GB.
- Tiến trình tiêu thụ RAM cao nhất:
  1. Google Chrome (PID 15414): 260MB
  2. OpenClaw Gateway (PID 1801112): 750MB
  3. DSH Web (PID 1193568): 720MB
- Đề xuất: Giải phóng bộ nhớ đệm cache hệ thống (sync; echo 3 > /proc/sys/vm/drop_caches), đóng bớt tab trình duyệt nhàn rỗi.`;

  const payloadTurn4 = {
    model: 'chatgpt-coordinator',
    messages: [
      ...payloadTurn2.messages,
      { role: 'assistant', tool_calls: msg2.tool_calls },
      {
        role: 'user',
        content: `[Thu 2026-09-25 00:33 GMT+7] A background task completed. Use this result to reply to the user in your normal assistant voice.

source: subagent
session_key: agent:cto:subagent:test-ram-123
task: ${spawnArgs.task}
status: completed; ready for parent review

Child result:
<prompt-data>
${ramReport}
</prompt-data>`
      }
    ],
    tools: payloadTurn1.tools,
    stream: false
  };

  const res4 = await fetch(ADAPTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadTurn4)
  });
  const data4 = await res4.json();
  const choice4 = data4.choices?.[0];
  const msg4 = choice4?.message;

  console.log('-> Phản hồi Turn 4 từ Coordinator (Báo cáo Executive Summary cho Boss trên WhatsApp):');
  console.log('Finish reason:', choice4?.finish_reason);
  console.log('Nội dung báo cáo gửi Boss:\n', msg4?.content || '(trống)');

  assert.strictEqual(choice4?.finish_reason, 'stop', 'Executive summary must finish with stop');
  assert.ok(!msg4?.tool_calls, 'Coordinator must NOT spawn another subagent upon completion!');
  assert.ok((msg4?.content || '').length > 0, 'Executive summary content must not be empty');
  assert.ok(!msg4?.content?.includes('plugin-fix/README.md'), 'Must not contain corrupt debate plugin strings!');
  assert.ok(!msg4?.content?.includes('chat-on-steroids'), 'Must not contain raw package.json rác!');

  console.log('\n======================================================================');
  console.log('🎉 TẤT CẢ 4 BƯỚC E2E NGHIỆP VỤ TỐI ƯU RAM ĐÃ THÀNH CÔNG VƯỢT TRỘI!');
  console.log('======================================================================');
}

runTest().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
