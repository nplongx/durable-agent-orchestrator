const url = 'http://127.0.0.1:8318/v1/chat/completions';
const directive = 'Production E2E v26. First turn MUST be proposal only. After approval CTO must native sessions_spawn exactly two independent children in parallel: Architect runs node --check /home/long/work/chatgpt-adapter/server.js; QA runs node --check /home/long/work/chatgpt-adapter/test-tool-turn.js. Children return actual command, output, exit status. CTO waits for both, synthesizes actual results, then completes Job. No prose-only success.';
const proposal = 'Đã tiếp nhận yêu cầu Production E2E v26, Boss. Đề xuất kế hoạch hành động: Sau khi Boss duyệt, CTO native sessions_spawn đúng 2 child độc lập, chạy song song. Architect: node --check /home/long/work/chatgpt-adapter/server.js. QA: node --check /home/long/work/chatgpt-adapter/test-tool-turn.js. Mỗi child trả command/output/exit status. CTO chờ cả hai, tổng hợp kết quả thực tế, sau đó hoàn tất Job.';
const body = {
  model: 'chatgpt-coordinator',
  messages: [
    { role: 'system', content: 'Runtime: name=Chief of Staff | agent=coordinator' },
    { role: 'user', content: directive },
    { role: 'assistant', content: proposal },
    { role: 'user', content: 'Duyệt proposal. Bắt đầu execution ngay. Tiếp tục Job đã approved; phát hành native CTO sessions_spawn ngay.' }
  ],
  tools: [{ type: 'function', function: { name: 'sessions_spawn', description: 'Spawn a subagent for a task', parameters: { type: 'object', properties: { agentId: { type: 'string' }, task: { type: 'string' } }, required: ['agentId','task'] } } }],
  stream: false
};
const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
console.log(JSON.stringify(await res.json()));
