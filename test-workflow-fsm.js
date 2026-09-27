// test-workflow-fsm.js
import assert from 'node:assert';
import { States, Intents, Actions, IntentClassifier, CoordinatorSessionStateMachine } from './coordinator-workflow.js';

console.log('====================================================');
console.log('🧪 BẮT ĐẦU TEST FSM & STRATEGY ENGINE (COORDINATOR WORKFLOW)');
console.log('====================================================');

// Test 1: New Directive from Boss in IDLE
const fsm = new CoordinatorSessionStateMachine();

const turn1Messages = [
  { role: 'user', content: 'Hãy kiểm thử plugin debate của chat on steroid, hiện tại chưa thể hoạt động, hãy tiến hành chỉnh sửa.' }
];

const step1 = fsm.processTurn(turn1Messages);
console.log('\n[TEST 1] Boss gửi yêu cầu ban đầu:');
console.log('  -> Intent:', step1.intent);
console.log('  -> Prev State:', step1.previousState);
console.log('  -> Current State:', step1.currentState);
console.log('  -> Action:', step1.action);

assert.strictEqual(step1.intent, Intents.NEW_REQUEST);
assert.strictEqual(step1.previousState, States.IDLE);
assert.strictEqual(step1.currentState, States.PROPOSED);
assert.strictEqual(step1.action, Actions.GENERATE_PROPOSAL);
console.log('✅ TEST 1 ĐẠT: Yêu cầu ban đầu tạo Proposal, KHÔNG dispatch task!');

// Test 2: Directive that starts with "Hãy tiến hành..." (The bug that caused the spam loop earlier!)
const trickyTurnMessages = [
  { role: 'user', content: 'Hãy tiến hành kiểm thử và test E2E plugin debate của chat on steroid.' }
];
const stepTricky = fsm.processTurn(trickyTurnMessages);
console.log('\n[TEST 2] Boss gửi "Hãy tiến hành kiểm thử..." trong trạng thái IDLE:');
console.log('  -> Intent:', stepTricky.intent);
console.log('  -> Current State:', stepTricky.currentState);
console.log('  -> Action:', stepTricky.action);

assert.strictEqual(stepTricky.intent, Intents.NEW_REQUEST);
assert.strictEqual(stepTricky.currentState, States.PROPOSED);
assert.strictEqual(stepTricky.action, Actions.GENERATE_PROPOSAL);
console.log('✅ TEST 2 ĐẠT: "Hãy tiến hành kiểm thử..." KHÔNG bị nhầm thành Approval trong trạng thái IDLE!');

// Test 3: Discussion / Question before approval
const turn2Messages = [
  ...turn1Messages,
  { role: 'assistant', content: 'Dạ em đề xuất kế hoạch: 1. CTO rà soát, 2. Vá lỗi, 3. Chạy test DoD. Boss duyệt giúp em!' },
  { role: 'user', content: 'Tại sao lại cần chạy test DoD trước?' }
];

const step2 = fsm.processTurn(turn2Messages);
console.log('\n[TEST 3] Boss đặt câu hỏi thảo luận:');
console.log('  -> Intent:', step2.intent);
console.log('  -> Current State:', step2.currentState);
console.log('  -> Action:', step2.action);

assert.strictEqual(step2.intent, Intents.DISCUSSION);
assert.strictEqual(step2.currentState, States.DISCUSSING);
assert.strictEqual(step2.action, Actions.REFINE_PROPOSAL);
console.log('✅ TEST 3 ĐẠT: Thảo luận chuyển sang DISCUSSING, KHÔNG dispatch task!');

// Test 4: Approval from Boss
const turn3Messages = [
  ...turn2Messages,
  { role: 'assistant', content: 'Dạ vì test DoD đảm bảo 4 cổng chất lượng ạ.' },
  { role: 'user', content: 'Duyệt, triển khai đi.' }
];

const step3 = fsm.processTurn(turn3Messages);
console.log('\n[TEST 4] Boss phê duyệt:');
console.log('  -> Intent:', step3.intent);
console.log('  -> Current State:', step3.currentState);
console.log('  -> Action:', step3.action);

assert.strictEqual(step3.intent, Intents.APPROVAL);
assert.strictEqual(step3.currentState, States.EXECUTING);
assert.strictEqual(step3.action, Actions.DISPATCH_TASK);
console.log('✅ TEST 4 ĐẠT: Phê duyệt từ Boss kích hoạt DISPATCH_TASK đúng 1 lần!');

// Test 5: Subagent Completion Event arriving in EXECUTING state
const turn4Messages = [
  ...turn3Messages,
  { role: 'assistant', tool_calls: [{ function: { name: 'sessions_spawn', arguments: '{"agentId":"cto"}' } }] },
  { role: 'user', content: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]\nsource: subagent\nsession_key: agent:cto:subagent:123\nChild result: <prompt-data>E2E Test PASS 100%</prompt-data>' }
];

const step4 = fsm.processTurn(turn4Messages);
console.log('\n[TEST 5] Subagent báo cáo hoàn thành:');
console.log('  -> Intent:', step4.intent);
console.log('  -> Current State:', step4.currentState);
console.log('  -> Action:', step4.action);

assert.strictEqual(step4.intent, Intents.SUBAGENT_COMPLETION);
assert.strictEqual(step4.currentState, States.IDLE);
assert.strictEqual(step4.action, Actions.REPORT_EXECUTIVE_SUMMARY);
console.log('✅ TEST 5 ĐẠT: Subagent hoàn tất kích hoạt REPORT_EXECUTIVE_SUMMARY và reset về IDLE, KHÔNG spawn lại!');

// Test 6: Anti-Loop test — Even with 50 previous turns, history derivation keeps state correct
const longMessages = [];
for (let i = 0; i < 50; i++) {
  longMessages.push({ role: 'user', content: 'Old user message ' + i });
  longMessages.push({ role: 'assistant', content: 'Old reply ' + i });
}
longMessages.push({ role: 'user', content: 'Dự án mới: Hãy tối ưu database PostgreSQL.' });

const step6 = fsm.processTurn(longMessages);
assert.strictEqual(step6.currentState, States.PROPOSED);
assert.strictEqual(step6.action, Actions.GENERATE_PROPOSAL);
console.log('✅ TEST 6 ĐẠT: Ngay cả với lịch sử dài, state machine nhận diện đúng yêu cầu mới!');

console.log('\n====================================================');
console.log('🎉 TẤT CẢ 6/6 TEST CASES CỦA FSM ĐÃ PASS 100%!');
console.log('====================================================\n');
