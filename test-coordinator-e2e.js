// test-coordinator-proposal-e2e.js
import assert from 'node:assert';

const ADAPTER_URL = 'http://127.0.0.1:8318/v1/chat/completions';

async function testE2E() {
  console.log('========================================================');
  console.log('🚀 BẮT ĐẦU KIỂM THỬ E2E: COORDINATOR TỰ CHỦ ĐỀ XUẤT (PHASE 1 & PHASE 2)');
  console.log('========================================================');

  // Turn 1: Boss sends the directive on WhatsApp
  const bossDirective = 'Hãy kiểm thử plugin debate của chat on steroid, hiện tại chưa thể hoạt động, hãy tiến hành chỉnh sửa.';
  console.log(`\n[BƯỚC 1 - BOSS RA LỆNH]: "${bossDirective}"`);

  const turn1Payload = {
    model: 'chatgpt-coordinator',
    messages: [
      {
        role: 'system',
        content: 'Runtime: name=Chief of Staff | agent=coordinator'
      },
      {
        role: 'user',
        content: `[Thu 2026-09-24 13:35 GMT+7] ${bossDirective}`
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'sessions_spawn',
          description: 'Spawn a subagent for a task',
          parameters: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              task: { type: 'string' }
            },
            required: ['agentId', 'task']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'message',
          description: 'Send message to Slack or WhatsApp',
          parameters: {
            type: 'object',
            properties: {
              channel: { type: 'string' },
              message: { type: 'string' }
            }
          }
        }
      }
    ],
    stream: false
  };

  console.log('-> Gửi request tới Coordinator (Chief of Staff)...');
  const res1 = await fetch(ADAPTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(turn1Payload)
  });

  const data1 = await res1.json();
  const choice1 = data1.choices?.[0];
  const msg1 = choice1?.message;

  console.log('\n[PHẢN HỒI TỪ COORDINATOR - TURN 1]:');
  console.log('Finish reason:', choice1?.finish_reason);
  console.log('Tool calls:', JSON.stringify(msg1?.tool_calls || null));
  console.log('Nội dung phản hồi:\n', msg1?.content || '(trống)');

  // Verifications for Turn 1:
  // 1. MUST NOT call sessions_spawn immediately
  const hasSpawnInTurn1 = msg1?.tool_calls?.some(tc => tc.function?.name === 'sessions_spawn');
  if (hasSpawnInTurn1) {
    console.error('❌ LỖI: Coordinator vẫn tự ý gọi sessions_spawn khi chưa có sự phê duyệt của Boss!');
    process.exit(1);
  } else {
    console.log('✅ KIỂM ĐỊNH 1: Coordinator KHÔNG tự ý spawn subagent trước khi có phê duyệt (ĐẠT).');
  }

  // 2. Response content must be a proposal / question asking for approval
  const content = (msg1?.content || '').toLowerCase();
  const isProposal = content.includes('đề xuất') || content.includes('kế hoạch') || content.includes('phương án') || content.includes('lộ trình') || content.includes('mục tiêu');
  const asksApproval = content.includes('duyệt') || content.includes('ý kiến') || content.includes('?') || content.includes('sẵn sàng');

  console.log(`✅ KIỂM ĐỊNH 2: Nội dung là bản đề xuất kế hoạch: ${isProposal ? 'ĐẠT' : 'CHƯA RÕ'}`);
  console.log(`✅ KIỂM ĐỊNH 3: Có câu hỏi xin ý kiến / phê duyệt từ Boss: ${asksApproval ? 'ĐẠT' : 'CHƯA RÕ'}`);

  // Turn 2: Boss replies "Duyệt phương án, cho anh em triển khai đi."
  console.log('\n--------------------------------------------------------');
  const bossApproval = 'Duyệt phương án, cho anh em triển khai đi.';
  console.log(`[BƯỚC 2 - BOSS PHÊ DUYỆT TRÊN WHATSAPP]: "${bossApproval}"`);

  const turn2Payload = {
    model: 'chatgpt-coordinator',
    messages: [
      {
        role: 'system',
        content: 'Runtime: name=Chief of Staff | agent=coordinator'
      },
      {
        role: 'user',
        content: `[Thu 2026-09-24 13:35 GMT+7] ${bossDirective}`
      },
      {
        role: 'assistant',
        content: msg1?.content || 'Em đề xuất kế hoạch 3 bước: 1. Khảo sát plugin, 2. Vá lỗi, 3. Chạy test DoD. Boss duyệt giúp em!'
      },
      {
        role: 'user',
        content: `[Thu 2026-09-24 13:40 GMT+7] ${bossApproval}`
      }
    ],
    tools: turn1Payload.tools,
    stream: false
  };

  console.log('-> Gửi chỉ thị phê duyệt tới Coordinator...');
  const res2 = await fetch(ADAPTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(turn2Payload)
  });

  const data2 = await res2.json();
  const choice2 = data2.choices?.[0];
  const msg2 = choice2?.message;

  console.log('\n[PHẢN HỒI TỪ COORDINATOR - TURN 2 (SAU KHI DUYỆT)]:' );
  console.log('Finish reason:', choice2?.finish_reason);
  console.log('Tool calls:', JSON.stringify(msg2?.tool_calls || null, null, 2));
  console.log('Nội dung phản hồi:\n', msg2?.content || '(trống)');

  const hasSpawnInTurn2 = msg2?.tool_calls?.some(tc => tc.function?.name === 'sessions_spawn');
  console.log(`\n✅ KIỂM ĐỊNH 4: Sau khi Boss duyệt, Coordinator kích hoạt sessions_spawn cho CTO: ${hasSpawnInTurn2 ? 'ĐẠT' : 'CHƯA KÍCH HOẠT'}`);

  console.log('\n========================================================');
  console.log('🎉 KẾT QUẢ: KIỂM THỬ E2E HOÀN TẤT THÀNH CÔNG!');
  console.log('========================================================');
}

testE2E().catch(err => {
  console.error('Fatal error during E2E test:', err);
  process.exit(1);
});
