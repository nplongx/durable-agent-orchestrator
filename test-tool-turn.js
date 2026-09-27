import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function main() {
  console.log("1. Sending task requiring 'exec' tool...");
  const res1 = await fetch('http://127.0.0.1:8318/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'chatgpt-cto',
      messages: [
        { role: 'user', content: 'Dùng công cụ exec ngay. Chỉ xuất đúng MỘT JSON object, không prose, không markdown: {"name":"exec","arguments":{"command":"pwd && ls -la /home/long/work/chatgpt-adapter"}}. Không trả lời mô tả.' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec',
            description: 'Run bash command',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command']
            }
          }
        }
      ]
    })
  });

  const data1 = await res1.json();
  console.log("Response 1:", JSON.stringify(data1, null, 2));

  const toolCall = data1.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    throw new Error("No tool call returned");
  }

  const args = JSON.parse(toolCall.function.arguments || '{}');
  if (typeof args.command !== 'string' || !args.command.trim()) {
    throw new Error(`Invalid exec arguments: ${toolCall.function.arguments}`);
  }

  console.log("\n2. Executing returned tool command on the real host...");
  const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', args.command], {
    cwd: '/home/long/work/chatgpt-adapter',
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  console.log("Command:", args.command);
  console.log("stdout:", stdout.trim());
  if (stderr.trim()) console.log("stderr:", stderr.trim());
  console.log("\nPASS: adapter returned a native exec tool call and the command executed successfully.");
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
