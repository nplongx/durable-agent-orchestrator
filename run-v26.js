const url = 'http://127.0.0.1:8318/v1/chat/completions';
const tools = [{
  type: 'function',
  function: {
    name: 'sessions_spawn',
    description: 'Spawn a subagent for a task',
    parameters: {
      type: 'object',
      properties: { agentId: { type: 'string' }, task: { type: 'string' } },
      required: ['agentId', 'task']
    }
  }
}];
const directive = 'Production E2E v26. First turn MUST be proposal only. After approval CTO must native sessions_spawn exactly two independent children in parallel: Architect runs node --check /home/long/work/chatgpt-adapter/server.js; QA runs node --check /home/long/work/chatgpt-adapter/test-tool-turn.js. Children return actual command, output, exit status. CTO waits for both, synthesizes actual results, then completes Job. No prose-only success.';
const base = { model: 'chatgpt-coordinator', tools, stream: false };
const first = await (await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...base, messages: [
    { role: 'system', content: 'Runtime: name=Chief of Staff | agent=coordinator' },
    { role: 'user', content: directive }
  ] })
})).json();
const proposal = first.choices?.[0]?.message;
console.log('TURN1', JSON.stringify(proposal));
if (proposal?.tool_calls?.some(x => x.function?.name === 'sessions_spawn')) throw new Error('proposal spawned');
const second = await (await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...base, messages: [
    { role: 'system', content: 'Runtime: name=Chief of Staff | agent=coordinator' },
    { role: 'user', content: directive },
    proposal,
    { role: 'user', content: 'Duyệt proposal. Bắt đầu execution ngay.' }
  ] })
})).json();
console.log('TURN2', JSON.stringify(second.choices?.[0]?.message));
