import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const ADAPTER = process.env.CHATGPT_ADAPTER_URL || 'http://127.0.0.1:8318';

export default definePluginEntry({
  id: 'chatgpt-adapter-workflow-guard',
  name: 'ChatGPT Adapter Workflow Guard',
  description: 'Blocks duplicate CTO child spawns after durable workflow assignment.',
  register(api) {
    api.on('before_tool_call', async event => {
      if (event.toolName !== 'sessions_spawn') return;
      const params = event.params || {};
      const role = String(params.agentId || params.agent_id || '').toLowerCase();
      if (!['architect', 'qa'].includes(role)) return;
      if (String(params.taskName || '').startsWith('cos-')) return;
      if (String(event?.ctx?.agentId || '').toLowerCase() !== 'cto') return;

      const task = String(params.task || '');
      const jobId = task.match(/\bjob_[0-9a-f-]{20,}\b/i)?.[0];
      if (!jobId) return;
      let response;
      try {
        response = await fetch(`${ADAPTER}/v1/workflow/jobs/${encodeURIComponent(jobId)}`);
      } catch (_) {
        return { block: true, blockReason: 'workflow guard unavailable' };
      }
      if (!response.ok) return { block: true, blockReason: 'durable workflow job unavailable' };
      const snapshot = await response.json();
      if (!/production e2e/i.test(String(snapshot?.job?.title || ''))) return;
      const assigned = (snapshot.tasks || []).some(t =>
        t.parent_task_id && String(t.role).toLowerCase() === role &&
        !['failed', 'cancelled'].includes(String(t.status).toLowerCase())
      );
      if (assigned) return { block: true, blockReason: `durable child already assigned: ${role}` };
    }, { matcher: ['sessions_spawn'], priority: 100 });
  }
});
