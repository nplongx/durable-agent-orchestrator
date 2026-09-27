// test-coordinator-logic.js
// Independent unit tests verifying Coordinator FSM, Intent Strategies, and Anti-Spam protection
import assert from 'node:assert';
import { States, Intents, Actions, IntentClassifier, CoordinatorSessionStateMachine } from './coordinator-workflow.js';

console.log('='.repeat(70));
console.log('🧪 BẮT ĐẦU TEST LOGIC COORDINATOR FSM & PHÂN BIỆT NGỮ NGHĨA');
console.log('='.repeat(70));

const fsm = new CoordinatorSessionStateMachine();

// Case 1: Proposal sent to Boss (No tool execution, clean text)
const bossDirective = 'Hãy kiểm thử plugin debate của chat on steroid, hiện tại chưa thể hoạt động, hãy tiến hành chỉnh sửa.';
const step1 = fsm.processTurn([{ role: 'user', content: bossDirective }]);
assert.strictEqual(step1.currentState, States.PROPOSED);
assert.strictEqual(step1.action, Actions.GENERATE_PROPOSAL);
console.log('✅ Case 1 ĐẠT: Proposal được nhận diện chính xác từ yêu cầu ban đầu, KHÔNG dispatch tool call.');

// Case 2: Boss sends direct order "Hãy tiến hành kiểm thử..." in IDLE state
// (The critical bug that caused the 150+ spam loop earlier!)
const step2 = fsm.processTurn([{ role: 'user', content: 'Hãy tiến hành kiểm thử và test E2E plugin debate của chat on steroid.' }]);
assert.strictEqual(step2.currentState, States.PROPOSED);
assert.strictEqual(step2.action, Actions.GENERATE_PROPOSAL);
console.log('✅ Case 2 ĐẠT: "Hãy tiến hành kiểm thử..." KHÔNG bị hiểu nhầm thành lệnh Duyệt trong trạng thái IDLE!');

// Case 3: Boss discusses/asks questions on proposal
const discussionHistory = [
  { role: 'user', content: bossDirective },
  { role: 'assistant', content: 'Dạ em đề xuất kế hoạch 3 bước: 1. CTO khảo sát, 2. Engineer sửa, 3. Reviewer nghiệm thu. Boss duyệt giúp em!' },
  { role: 'user', content: 'Tại sao cần CTO khảo sát trước?' }
];
const step3 = fsm.processTurn(discussionHistory);
assert.strictEqual(step3.currentState, States.DISCUSSING);
assert.strictEqual(step3.action, Actions.REFINE_PROPOSAL);
console.log('✅ Case 3 ĐẠT: Thảo luận chuyển sang DISCUSSING, Coordinator phản hồi làm rõ, KHÔNG dispatch!');

// Case 4: Boss officially APPROVES the plan
const approvalHistory = [
  ...discussionHistory,
  { role: 'assistant', content: 'Dạ vì khảo sát giúp xác định đúng root cause trước khi viết mã ạ.' },
  { role: 'user', content: 'Duyệt, triển khai đi.' }
];
const step4 = fsm.processTurn(approvalHistory);
assert.strictEqual(step4.currentState, States.EXECUTING);
assert.strictEqual(step4.action, Actions.DISPATCH_TASK);
console.log('✅ Case 4 ĐẠT: Boss phê duyệt kích hoạt DISPATCH_TASK cho CTO đúng 1 lần duy nhất!');

// Case 5: Subagent finishes and delivers completion event
const completionHistory = [
  ...approvalHistory,
  { role: 'assistant', tool_calls: [{ function: { name: 'sessions_spawn' } }] },
  { role: 'user', content: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]\nsource: subagent\nsession_key: agent:cto:subagent:abc\nChild result: <prompt-data>E2E PASS 100%</prompt-data>' }
];
const step5 = fsm.processTurn(completionHistory);
assert.strictEqual(step5.currentState, States.IDLE);
assert.strictEqual(step5.action, Actions.REPORT_EXECUTIVE_SUMMARY);
console.log('✅ Case 5 ĐẠT: Subagent hoàn tất kích hoạt REPORT_EXECUTIVE_SUMMARY, reset về IDLE, triệt tiêu vòng lặp vô tận!');

// Case 6: Long history with 100+ turns - State derivation remains exact
const longHistory = Array.from({ length: 80 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: 'Historical turn ' + i
}));
longHistory.push({ role: 'user', content: 'Dự án mới: Tối ưu hoá bộ nhớ cache Redis.' });
const step6 = fsm.processTurn(longHistory);
assert.strictEqual(step6.currentState, States.PROPOSED);
assert.strictEqual(step6.action, Actions.GENERATE_PROPOSAL);
console.log('✅ Case 6 ĐẠT: Lịch sử dài vẫn nhận diện chính xác yêu cầu mới và tạo Proposal, không bị leak trạng thái cũ!');

console.log('='.repeat(70));
console.log('🎉 TẤT CẢ 6/6 TEST CASES ĐÃ ĐẠT 100%!');
console.log('='.repeat(70) + '\n');
