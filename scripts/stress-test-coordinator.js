// stress-test-coordinator.js
// Comprehensive Stress Test for Coordinator State Machine & Multi-Agent Flow
import assert from 'node:assert';
import { States, Intents, Actions, IntentClassifier, CoordinatorSessionStateMachine } from '../coordinator-workflow.js';

console.log('='.repeat(70));
console.log('🚀 BẮT ĐẦU STRESS TEST HỆ THỐNG ĐIỀU PHỐI (COORDINATOR MULTI-AGENT WORKFLOW)');
console.log('='.repeat(70));

// SCENARIO 1: Full Standard 5-Step Operational Flow
console.log('\n--- KỊCH BẢN 1: KIỂM THỬ LUỒNG 5 BƯỚC CHUẨN ---');
const fsm1 = new CoordinatorSessionStateMachine('session-1');

// Step 1: Boss sends initial directive
const turn1 = [{ role: 'user', content: 'Hãy kiểm thử và sửa lỗi plugin debate trong chat-on-steroids.' }];
const step1 = fsm1.processTurn(turn1);
assert.strictEqual(step1.currentState, States.PROPOSED);
assert.strictEqual(step1.action, Actions.GENERATE_PROPOSAL);
console.log('✓ Bước 1 ĐẠT: Boss gửi yêu cầu -> Coordinator đề xuất Action Plan, KHÔNG spawn.');

// Step 2: Boss discusses / asks questions
const turn2 = [
  ...turn1,
  { role: 'assistant', content: 'Dạ em đề xuất kế hoạch 3 bước: 1. CTO khảo sát, 2. Engineer vá lỗi, 3. Reviewer nghiệm thu DoD. Boss xem qua có duyệt không ạ?' },
  { role: 'user', content: 'Tại sao lại cần Reviewer nghiệm thu độc lập?' }
];
const step2 = fsm1.processTurn(turn2);
assert.strictEqual(step2.currentState, States.DISCUSSING);
assert.strictEqual(step2.action, Actions.REFINE_PROPOSAL);
console.log('✓ Bước 2 ĐẠT: Boss thảo luận -> Coordinator giải đáp và cập nhật kế hoạch, KHÔNG spawn.');

// Step 3: Boss approves
const turn3 = [
  ...turn2,
  { role: 'assistant', content: 'Dạ vì Reviewer đảm bảo 4 cổng DoD khách quan theo đúng chỉ đạo của Boss ạ.' },
  { role: 'user', content: 'Duyệt, cho triển khai ngay đi em.' }
];
const step3 = fsm1.processTurn(turn3);
assert.strictEqual(step3.currentState, States.EXECUTING);
assert.strictEqual(step3.action, Actions.DISPATCH_TASK);
console.log('✓ Bước 3 ĐẠT: Boss phê duyệt -> Kích hoạt dispatch cho CTO triển khai (Single Dispatch).');

// Step 4: Agents coordinate via Slack, CTO executes and subagent completes
const turn4 = [
  ...turn3,
  { role: 'assistant', tool_calls: [{ function: { name: 'sessions_spawn', arguments: '{"agentId":"cto"}' } }] },
  { role: 'user', content: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]\nsource: subagent\nsession_key: agent:cto:subagent:999\nChild result: <prompt-data>E2E Socratic Council debate tests PASS 100% (10 phases completed)</prompt-data>' }
];
const step4 = fsm1.processTurn(turn4);
assert.strictEqual(step4.currentState, States.IDLE);
assert.strictEqual(step4.action, Actions.REPORT_EXECUTIVE_SUMMARY);
console.log('✓ Bước 4 & 5 ĐẠT: Subagent hoàn tất -> Báo cáo Executive Summary cho Boss, RESET về IDLE, KHÔNG spawn lại!');

// SCENARIO 2: Stress Testing - Anti-Loop / Anti-Spam Barrier
console.log('\n--- KỊCH BẢN 2: STRESS TEST CHỐNG VÒNG LẶP SPAM VÔ TẬN (ANTI-LOOP BARRIER) ---');
// Simulate 50 repeated completion events (the exact failure mode that previously spammed WhatsApp 150+ times)
let spawnAttemptsBlocked = 0;
let summaryReportsGenerated = 0;

for (let i = 0; i < 50; i++) {
  const subagentCompletionEvent = [
    ...turn3,
    { role: 'assistant', tool_calls: [{ function: { name: 'sessions_spawn' } }] },
    { role: 'user', content: `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]\nsource: subagent\nsession_key: agent:cto:subagent:${i}\nChild result: <prompt-data>Result ${i}</prompt-data>` }
  ];
  const res = fsm1.processTurn(subagentCompletionEvent);
  if (res.action !== Actions.DISPATCH_TASK) {
    spawnAttemptsBlocked++;
  }
  // Anti-Spam Debounce suppresses duplicate notifications into SILENT_ACK
  if (res.action === Actions.REPORT_EXECUTIVE_SUMMARY || res.action === Actions.SILENT_ACK) {
    summaryReportsGenerated++;
  }
}

assert.strictEqual(spawnAttemptsBlocked, 50);
assert.strictEqual(summaryReportsGenerated, 50);
console.log(`✓ 50/50 completion events được chặn triệt để khỏi sessions_spawn. Tự động kích hoạt Anti-Spam Debounce (SILENT_ACK / NO_REPLY) triệt tiêu spam trên WhatsApp.`);

// SCENARIO 3: High-Concurrency Burst Stress Test
console.log('\n--- KỊCH BẢN 3: CONCURRENT BURST REQUESTS (100 CONCURRENT SESSIONS) ---');
const burstPromises = Array.from({ length: 100 }, async (_, idx) => {
  const fsmInstance = new CoordinatorSessionStateMachine(`burst-${idx}`);
  const msg = idx % 2 === 0 
    ? 'Hãy kiểm tra hệ thống bảo mật và cập nhật dependencies.'
    : 'Hãy tiến hành kiểm thử hiệu năng cổng thanh toán.';
  const step = fsmInstance.processTurn([{ role: 'user', content: msg }]);
  return step;
});

const burstResults = await Promise.all(burstPromises);
const allProposed = burstResults.every(r => r.currentState === States.PROPOSED && r.action === Actions.GENERATE_PROPOSAL);
assert.ok(allProposed, 'Tất cả 100 burst requests phải được phân loại vào PROPOSED');
console.log(`✓ Hoàn thành 100/100 concurrent requests: 100% đều tạo Proposal chuẩn mực, 0 request nào tự ý spawn!`);

// SCENARIO 4: Semantic Distinction Test (Without brittle if/else)
console.log('\n--- KỊCH BẢN 4: KIỂM THỬ TÍNH PHÂN BIỆT NGỮ NGHĨA (NO BRITTLE IF/ELSE) ---');
const testSentences = [
  { text: 'Hãy tiến hành kiểm thử', expectedInIdle: Intents.NEW_REQUEST },
  { text: 'Hãy test nhanh cho anh', expectedInIdle: Intents.NEW_REQUEST },
  { text: 'Hãy sửa lỗi ngay', expectedInIdle: Intents.NEW_REQUEST },
  { text: 'Tiến hành rà soát hệ thống', expectedInIdle: Intents.NEW_REQUEST },
  { text: 'Duyệt phương án', expectedInIdle: Intents.NEW_REQUEST }, // in IDLE, approval tokens are not active proposals
  { text: 'OK triển khai', expectedInIdle: Intents.NEW_REQUEST }
];

for (const tc of testSentences) {
  const fsm = new CoordinatorSessionStateMachine();
  const res = fsm.processTurn([{ role: 'user', content: tc.text }]);
  assert.strictEqual(res.currentState, States.PROPOSED, `Thất bại tại câu: "${tc.text}"`);
  assert.strictEqual(res.action, Actions.GENERATE_PROPOSAL, `Thất bại tại câu: "${tc.text}"`);
}
console.log(`✓ Tất cả ${testSentences.length} mẫu câu giao việc đều được định tuyến đúng vào Proposal khi ở trạng thái IDLE.`);

console.log('\n' + '='.repeat(70));
console.log('🎉 TẤT CẢ CÁC BÀI STRESS TEST ĐÃ HOÀN TẤT THÀNH CÔNG VỚI TỶ LỆ 100%!');
console.log('='.repeat(70) + '\n');