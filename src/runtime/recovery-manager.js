import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const TMUX_BIN = process.env.TMUX_BIN || 'tmux';

async function cli(command, args, timeout = 30000) {
  const { stdout } = await execFileAsync(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}

async function listOpenClawSessions() {
  try {
    const raw = await cli(OPENCLAW_BIN, ['sessions', '--all-agents', '--json', '--limit', 'all'], 45000);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (error) {
    return { error };
  }
}

async function tmuxExists(name) {
  if (!name) return false;
  try { await cli(TMUX_BIN, ['has-session', '-t', name], 5000); return true; }
  catch (_) { return false; }
}

async function exportCompletedTrajectory(sessionKey, timeoutMs = 45000) {
  const output = `recovery-${randomUUID()}`;
  try {
    await cli(OPENCLAW_BIN, [
      'sessions', 'export-trajectory',
      '--session-key', sessionKey,
      '--workspace', '/tmp',
      '--output', output,
      '--json'
    ], timeoutMs);
    const eventsPath = path.join('/tmp', '.openclaw', 'trajectory-exports', output, 'events.jsonl');
    const raw = await fs.readFile(eventsPath, 'utf8');
    const events = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const executionEvidence = extractTrajectoryExecutionEvidence(raw);
    const assistantTexts = [];
    for (const event of events) {
      if (event.type !== 'assistant.message') continue;
      const message = event.data?.message;
      const content = message?.content;
      if (typeof content === 'string' && content.trim()) assistantTexts.push(content.trim());
      else if (Array.isArray(content)) {
        const text = content.filter(x => x?.type === 'text').map(x => x.text || '').join('\n').trim();
        if (text) assistantTexts.push(text);
      }
    }
    if (executionEvidence?.command && executionEvidence?.exitCode !== null) {
      const factual = [
        '<prompt-data>',
        '[ACTUAL TOOL RESULT EVIDENCE]',
        `exact command: ${executionEvidence.command}`,
        `stdout:\n${executionEvidence.stdout || ''}`,
        `stderr:\n${executionEvidence.stderr || ''}`,
        `exit status/code: ${executionEvidence.exitCode}`,
        `execution status: ${executionEvidence.success && executionEvidence.exitCode === 0 ? 'completed' : 'failed'}`,
        '</prompt-data>'
      ].join('\n');
      return `${factual}\n${assistantTexts.at(-1) || ''}`.trim();
    }
    return assistantTexts.at(-1) || null;
  } finally {
    await fs.rm(path.join('/tmp', '.openclaw', 'trajectory-exports', output), { recursive: true, force: true }).catch(() => {});
  }
}

function extractTrajectoryExecutionEvidence(raw) {
  const events = String(raw || '').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const calls = new Map();
  const evidence = [];
  for (const event of events) {
    const data = event.data || {};
    const callId = data.toolCallId;
    if (event.type === 'tool.call' && data.name === 'exec' && callId) {
      calls.set(callId, data.args?.command || null);
      continue;
    }
    if (event.type !== 'tool.result' || !callId || !calls.has(callId)) continue;
    const command = calls.get(callId);
    const details = data.details || data.result?.details || {};
    const text = data.result?.content?.map(x => x?.text || '').join('\n') || data.message?.content?.map(x => x?.text || '').join('\n') || '';
    const stdout = text.trim() === '(no output)' ? '' : text;
    evidence.push({
      command,
      stdout: details.aggregated || stdout || '',
      stderr: details.stderr || '',
      exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null,
      success: data.success === true || data.message?.isError === false
    });
  }
  return evidence.at(-1) || null;
}

function normalizeCommand(command) {
  return String(command || '').trim().replace(
    /^node --check ~\/work\/chatgpt-adapter\//i,
    'node --check /home/long/work/chatgpt-adapter/'
  ).replace(/\.$/, '');
}

function expectedCommandFromTask(task) {
  const description = String(task?.description || '');
  const match = description.match(
    /(?:Run (?:the )?exact command(?: immediately)?|Run immediately|exact command)\s*:\s*(node\s+--check\s+\S+)/i
  );
  return normalizeCommand(match?.[1] || '');
}

function hasVerifiedSuccessfulRuntimeEvidence(task, content) {
  const text = String(content || '');
  const expected = expectedCommandFromTask(task);
  if (!expected || !/\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(text)) return false;
  const normalized = normalizeCommand(text);
  return normalized.includes(expected)
    && /exit status(?:\/code)?\s*:\s*0/i.test(text)
    && /execution status\s*:\s*completed/i.test(text);
}

export class RecoveryManager {
  constructor(store, {
    sessionStaleMs = 5 * 60 * 1000,
    executionStaleMs = 2 * 60 * 1000,
    trajectoryTimeoutMs = 45_000,
    listSessions = listOpenClawSessions,
    exportTrajectory = exportCompletedTrajectory,
    executionManager = null
  } = {}) {
    this.store = store;
    this.sessionStaleMs = sessionStaleMs;
    this.executionStaleMs = executionStaleMs;
    this.trajectoryTimeoutMs = trajectoryTimeoutMs;
    this.listSessions = listSessions;
    this.exportTrajectory = exportTrajectory;
    this.executionManager = executionManager;
  }

  async reconcile({ jobId = null } = {}) {
    const allSessions = this.store.listAgentSessions({ jobId, limit: 500 });
    const sessions = allSessions.filter(s => ['ACTIVE', 'CREATED'].includes(s.state));
    const runtimeSessions = await this.listSessions();
    const runtimeMap = runtimeSessions.error
      ? null
      : new Map(runtimeSessions.map(s => [s.key, s]));
    // Completion reconciliation is task-driven, not session-state-driven.
    // A session may already be STALE when OpenClaw reports it as done; that
    // must never hide a terminal runtime result from the durable task.
    const reconcilableTasks = (jobId
      ? this.store.getJobTrace(jobId)?.tasks || []
      : this.store.db.prepare("SELECT * FROM tasks WHERE status = 'running' AND openclaw_session_key IS NOT NULL").all())
      .filter(t => ['running', 'failed'].includes(String(t.status).toLowerCase())
        && t.openclaw_session_key
        && ['architect', 'qa'].includes(String(t.role || '').toLowerCase())
        && /production e2e/i.test(String(this.store.getJob(t.job_id)?.title || '')));
    for (const task of reconcilableTasks) {
      const runtime = runtimeMap?.get(task.openclaw_session_key);
      const runtimeStatus = String(runtime?.status || '').toLowerCase();
      if (!runtime || !['done', 'failed', 'error'].includes(runtimeStatus)) continue;
      try {
          const completion = await this.exportTrajectory(task.openclaw_session_key, this.trajectoryTimeoutMs);
        if (!completion) continue;
        const outcome = runtimeStatus === 'done' ? 'success' : 'failure';
        let completedTask = task;
        if (task.status === 'running') {
          completedTask = this.store.completeTaskByRuntime(task.job_id, {
            runId: task.openclaw_run_id || runtime.runId || null,
            sessionKey: task.openclaw_session_key,
            content: completion,
            outcome
          });
        } else if (task.status === 'failed' && outcome === 'success'
          && ['architect', 'qa'].includes(String(task.role || '').toLowerCase())
          && /\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(completion)
          && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/(?:server\.js|test-tool-turn\.js)/i.test(completion)
          && hasVerifiedSuccessfulRuntimeEvidence(task, completion)) {
            completedTask = this.store.reconcileFailedTaskByRuntime(task.task_id, {
              content: completion,
              runId: task.openclaw_run_id || runtime.runId || null,
              sessionKey: task.openclaw_session_key
            }) || task;
        }
        if (completedTask?.status === 'completed' || completedTask?.status === 'failed') {
          const session = allSessions.find(s => s.task_id === task.task_id) || this.store.getSessionByOpenClawKey(task.openclaw_session_key);
          if (session) this.store.updateAgentSession(session.session_id, { state: completedTask.status === 'completed' ? 'TERMINATED' : 'FAILED' });
          this.store.recordEvent(task.job_id, 'session.runtime_reconciled', {
            taskId: task.task_id,
            sessionId: session?.session_id || null,
            sessionKey: task.openclaw_session_key,
            runId: task.openclaw_run_id || runtime.runId || null,
            outcome
          }, `${task.task_id}|runtime-reconciled|${outcome}`);
        }
      } catch (error) {
        console.warn(`[RecoveryManager] task trajectory reconciliation failed task=${task.task_id}: ${error.message}`);
      }
    }
    // Native OpenClaw exec can terminalize a deterministic child before the
    // adapter's tool turn persists ExecutionManager evidence. The child is
    // already terminal, so normal running-task recovery cannot see it. Re-enter
    // the SAME durable task through ExecutionManager when actual execution
    // evidence is still absent. Never create a replacement task/session.
    if (this.executionManager) {
      const trace = jobId ? this.store.getJobTrace(jobId) : null;
      const terminalDeterministicTasks = (trace?.tasks || this.store.db.prepare("SELECT t.* FROM tasks t JOIN jobs j ON j.job_id=t.job_id WHERE t.status='completed' AND t.role IN ('architect','qa') AND j.state='EXECUTING'").all())
        .filter(task => ['architect', 'qa'].includes(String(task.role || '').toLowerCase())
          && String(task.status).toLowerCase() === 'completed'
          && /production e2e/i.test(String(this.store.getJob(task.job_id)?.title || ''))
          && !task.execution_session_id
          && !task.execution_status);
      for (const task of terminalDeterministicTasks) {
        try {
          const latest = this.store.db.prepare('SELECT content FROM results WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(task.task_id);
          if (/\[ACTUAL EXECUTION EVIDENCE\]/i.test(String(latest?.content || ''))) continue;
          const command = expectedCommandFromTask(task) || String(JSON.parse(task.metadata_json || '{}').command || '').trim();
          if (!command) continue;
          const result = await this.executionManager.executeTask(task.task_id, { command });
          const evidence = [
            '<prompt-data>',
            '[ACTUAL TOOL RESULT EVIDENCE]',
            '[ACTUAL EXECUTION EVIDENCE]',
            `task_id: ${task.task_id}`,
            `execution_session_id: ${result.execution_session_id || this.store.getTask(task.task_id)?.execution_session_id || 'N/A'}`,
            `attempt: ${result.execution_attempt || this.store.getTask(task.task_id)?.execution_attempt || 'N/A'}`,
            `exact command: ${result.command || command}`,
            `exit status/code: ${result.exitCode == null ? 'N/A' : result.exitCode}`,
            `execution status: ${result.timedOut ? 'timeout' : result.exitCode === 0 ? 'completed' : 'failed'}`,
            `stdout:\n${result.stdout || ''}`,
            `stderr:\n${result.stderr || ''}`,
            '</prompt-data>'
          ].join('\n');
          this.store.repairResultEvidence(task.task_id, evidence);
          this.store.recordEvent(task.job_id, 'execution.evidence_recovered', {
            taskId: task.task_id, role: task.role, command, exitCode: result.exitCode,
            executionSessionId: this.store.getTask(task.task_id)?.execution_session_id || null
          }, `${task.task_id}|execution-evidence-recovered`);
        } catch (error) {
          console.warn(`[RecoveryManager] deterministic evidence recovery failed task=${task.task_id}: ${error.message}`);
        }
      }
    }
    if (jobId) {
      const trace = this.store.getJobTrace(jobId);
      const job = trace?.job;
      const cto = trace?.tasks?.find(t => t.task_id === job?.active_task_id && String(t.role).toLowerCase() === 'cto');
      if (job?.state === 'EXECUTING' && /production e2e/i.test(String(job.title || '')) && cto?.openclaw_session_key) {
        const runtime = runtimeMap?.get(cto.openclaw_session_key);
        const runtimeStatus = String(runtime?.status || '').toLowerCase();
        // The completion event can win the race and mark the durable CTO task
        // completed before recovery gets a chance to inspect the runtime. The
        // Job may still be EXECUTING, so terminal reconciliation must be driven
        // by Job state + OpenClaw runtime state, not by CTO task status.
        if (runtime && ['done', 'timeout', 'failed', 'error'].includes(runtimeStatus)
          && ['completed', 'failed', 'running'].includes(String(cto.status || '').toLowerCase())) {
          try {
            const completion = await this.exportTrajectory(cto.openclaw_session_key, this.trajectoryTimeoutMs);
            const children = (trace.tasks || []).filter(t => t.parent_task_id === cto.task_id);
            const required = ['architect', 'qa'].map(role => children.find(t => String(t.role).toLowerCase() === role));
            const childEvidenceValid = required.every(child => {
              if (!child || child.status !== 'completed') return false;
              const result = this.store.db.prepare('SELECT outcome, content FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(child.task_id);
              return result?.outcome === 'success'
                && /\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(String(result.content || ''))
                && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/(?:server\.js|test-tool-turn\.js)/i.test(String(result.content || ''))
                && /exit\s+(?:status|code)(?:\/code)?\s*(?::|=)?\s*(?:was\s+successful\s*\()?\s*0/i.test(String(result.content || ''));
            });
            const synthesisText = normalizeCommand(completion);
            const synthesisValid = childEvidenceValid
              && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/server\.js/i.test(synthesisText)
              && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/test-tool-turn\.js/i.test(synthesisText)
              && /exit\s+(?:status|code)(?:\/code)?\s*[:=]\s*0/i.test(synthesisText)
              && /(?:dod|dođ|both required child|cả hai child)/i.test(synthesisText);
            if (childEvidenceValid && synthesisValid) {
              this.store.complete(jobId, completion, 'success');
              const session = this.store.getSessionByOpenClawKey(cto.openclaw_session_key);
              if (session) this.store.updateAgentSession(session.session_id, { state: 'TERMINATED' });
              this.store.recordEvent(jobId, 'job.runtime_reconciled', {
                taskId: cto.task_id, sessionKey: cto.openclaw_session_key, runId: cto.openclaw_run_id || runtime.runId || null, outcome: 'success'
              }, `${jobId}|job-runtime-reconciled|success`);
            }
            else if (runtimeStatus === 'done' && required.some(child => !child)) {
              // A terminal CTO runtime with a missing required specialist is a
              // recoverable failure state, not an indefinitely EXECUTING Job.
              // Do not synthesize or replace the missing child; close this Job
              // through the normal durable failure path before any fresh E2E.
              this.store.complete(jobId, [
                '[RECOVERY FAILURE]',
                'CTO runtime completed before all required production E2E specialist children were spawned.',
                completion
              ].join('\n'), 'failure');
              const session = this.store.getSessionByOpenClawKey(cto.openclaw_session_key);
              if (session) this.store.updateAgentSession(session.session_id, { state: 'FAILED' });
              this.store.recordEvent(jobId, 'job.runtime_reconciled', {
                taskId: cto.task_id, sessionKey: cto.openclaw_session_key, runId: cto.openclaw_run_id || runtime.runId || null, outcome: 'failure', reason: 'missing required specialist child'
              }, `${jobId}|job-runtime-reconciled|missing-child`);
            }
            else if (runtimeStatus === 'done'
              && required.every(child => child && ['completed', 'failed', 'cancelled'].includes(String(child.status).toLowerCase()))) {
              // Failure-only recovery: never bypass successful terminalization.
              this.store.complete(jobId, [
                '[RECOVERY FAILURE]',
                'CTO runtime completed, but required production E2E evidence or synthesis was invalid.',
                completion,
                '[ACTUAL CHILD RESULTS]',
                required.map(child => this.store.db.prepare('SELECT content FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(child.task_id)?.content || '').join('\n\n')
              ].join('\n'), 'failure');
              const session = this.store.getSessionByOpenClawKey(cto.openclaw_session_key);
              if (session) this.store.updateAgentSession(session.session_id, { state: 'FAILED' });
              this.store.recordEvent(jobId, 'job.runtime_reconciled', {
                taskId: cto.task_id, sessionKey: cto.openclaw_session_key, runId: cto.openclaw_run_id || runtime.runId || null, outcome: 'failure'
              }, `${jobId}|job-runtime-reconciled|failure`);
            }
          } catch (error) {
            console.warn(`[RecoveryManager] CTO trajectory reconciliation failed job=${jobId}: ${error.message}`);
          }
        }
      }
    }
    const stale = [];
    for (const session of sessions) {
      const runtime = runtimeMap?.get(session.openclaw_session_key);
      const runtimeStatus = String(runtime?.status || '').toLowerCase();
      if (runtime && ['done', 'failed', 'error'].includes(runtimeStatus)) {
        try {
          const completion = await this.exportTrajectory(session.openclaw_session_key, this.trajectoryTimeoutMs);
          if (completion) {
            const task = this.store.getTask(session.task_id);
            if (task && ['pending', 'running'].includes(String(task.status).toLowerCase())) {
              const outcome = runtimeStatus === 'done' ? 'success' : 'failure';
              const completedTask = this.store.completeTaskByRuntime(task.job_id, {
                runId: task.openclaw_run_id || runtime.runId || null,
                sessionKey: session.openclaw_session_key,
                content: completion,
                outcome
              });
              if (completedTask?.status === 'completed' || completedTask?.status === 'failed') {
                this.store.updateAgentSession(session.session_id, {
                  state: completedTask.status === 'completed' ? 'TERMINATED' : 'FAILED'
                });
                this.store.recordEvent(task.job_id, 'session.runtime_reconciled', {
                  taskId: task.task_id,
                  sessionId: session.session_id,
                  sessionKey: session.openclaw_session_key,
                  runId: task.openclaw_run_id || runtime.runId || null,
                  outcome
                }, `${session.session_id}|runtime-reconciled|${outcome}`);
              }
            }
          }
        } catch (error) {
          console.warn(`[RecoveryManager] trajectory reconciliation failed session=${session.openclaw_session_key}: ${error.message}`);
        }
      }
      const runtimeFresh = runtime && !['done', 'failed', 'error', 'archived'].includes(String(runtime.status || '').toLowerCase());
      const dbFresh = Date.now() - new Date(session.last_activity_at).getTime() <= this.sessionStaleMs;
      if (!runtimeFresh && !dbFresh) {
        stale.push(this.store.markAgentSessionStale(session.session_id, {
          reason: runtime ? `OpenClaw status=${runtime.status || 'unknown'}` : runtimeSessions.error ? 'OpenClaw session inventory unavailable and heartbeat stale' : 'OpenClaw session key absent from runtime inventory'
        }));
      }
    }

    const tasks = (jobId ? this.store.getJobTrace(jobId)?.tasks : this.store.db.prepare("SELECT * FROM tasks WHERE execution_status = 'running'").all()) || [];
    const execution = [];
    for (const task of tasks.filter(t => t.execution_status === 'running')) {
      const metadata = JSON.parse(task.metadata_json || '{}');
      const alive = await tmuxExists(metadata.tmuxName);
      const age = Date.now() - new Date(task.execution_started_at || task.updated_at).getTime();
      if (!alive && age > this.executionStaleMs) {
        const ts = new Date().toISOString();
        this.store.db.prepare("UPDATE tasks SET execution_status = 'stale', execution_finished_at = ?, execution_stderr = ?, updated_at = ? WHERE task_id = ? AND execution_status = 'running'")
          .run(ts, 'execution supervisor/session missing; recovery required', ts, task.task_id);
        this.store.recordEvent(task.job_id, 'execution.stale', {
          taskId: task.task_id, executionSessionId: task.execution_session_id, attempt: task.execution_attempt, reason: 'tmux execution session missing'
        }, `${task.task_id}|execution-stale|${task.execution_attempt}`);
        execution.push(this.store.getTask(task.task_id));
      }
    }
    return { staleSessions: stale.filter(Boolean), staleExecutions: execution, openclawInventoryAvailable: !runtimeSessions.error };
  }

  async retryAgentTask(taskId, { actorRole = 'cto', message = null, timeoutSeconds = 120, reason = 'same-task recovery retry' } = {}) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const session = this.store.getSessionByTask(taskId);
    if (!session) throw new Error(`agent session not found for task: ${taskId}`);
    let prepared;
    if (session.state === 'ACTIVE') {
      if (!['failed', 'pending'].includes(String(task.status).toLowerCase())) {
        throw new Error(`same-session retry requires FAILED or PENDING task; got ${task.status}`);
      }
      const nextAttempt = Math.max(1, Number(task.execution_attempt || 0), Number(session.attempt || 0)) + 1;
      const ts = new Date().toISOString();
      this.store.db.prepare("UPDATE agent_sessions SET attempt = ?, updated_at = ?, last_activity_at = ? WHERE session_id = ? AND state = 'ACTIVE'")
        .run(nextAttempt, ts, ts, session.session_id);
      this.store.db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE task_id = ? AND status IN ('failed','pending')")
        .run(ts, taskId);
      const attemptId = `attempt_${randomUUID()}`;
      this.store.db.prepare("INSERT INTO attempts(attempt_id, task_id, status, openclaw_run_id, started_at) VALUES(?, ?, 'started', ?, ?)")
        .run(attemptId, taskId, task.openclaw_run_id || null, ts);
      this.store.recordEvent(task.job_id, 'task.retry_started', {
        taskId, sessionId: session.session_id, actorRole, attempt: nextAttempt, attemptId, reason, mode: 'same-session'
      }, `${taskId}|retry|${nextAttempt}`);
      prepared = {
        task: this.store.getTask(taskId),
        session: this.store.getSession(session.session_id),
        attempt: nextAttempt,
        attemptRecord: this.store.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId)
      };
    } else {
      prepared = this.store.beginAgentRetry(taskId, { actorRole, reason });
    }
    const sessionKey = prepared.session.openclaw_session_key;
    const retryMessage = message || `Retry the SAME durable task now. Do not create a replacement task or session. Execute the exact original scope immediately and return factual execution evidence: exact command, stdout/stderr, and exit status. Durable task: ${taskId}. Attempt: ${prepared.attempt}.`;
    let raw;
    try {
      raw = await cli(OPENCLAW_BIN, ['agent', '--agent', prepared.session.role, '--session-key', sessionKey, '--message', retryMessage, '--json', '--timeout', String(timeoutSeconds)], (timeoutSeconds + 15) * 1000);
    } catch (error) {
      this.store.db.prepare("UPDATE attempts SET status = 'failed', finished_at = ?, error = ? WHERE task_id = ? AND status = 'started' ORDER BY started_at DESC LIMIT 1")
        .run(new Date().toISOString(), error.message, taskId);
      this.store.updateAgentSession(prepared.session.session_id, { state: 'FAILED' });
      this.store.recordEvent(prepared.task.job_id, 'task.retry_failed', { taskId, sessionKey, attempt: prepared.attempt, error: error.message }, `${taskId}|retry-failed|${prepared.attempt}`);
      throw error;
    }
    // A same-session retry gets a new OpenClaw run id. Persist it against the
    // new durable attempt so late completion from the previous run cannot
    // settle the retry, even though both attempts share one session key.
    const rawText = String(raw || '');
    const retryRunId = rawText.match(/(?:^|[,{\s])"?runId"?\s*[:=]\s*"?([A-Za-z0-9._:-]+)/i)?.[1] || null;
    if (retryRunId) {
      const ts = new Date().toISOString();
      this.store.db.prepare('UPDATE attempts SET openclaw_run_id = ? WHERE attempt_id = ? AND status = \'started\'').run(retryRunId, prepared.attemptRecord.attempt_id);
      this.store.db.prepare('UPDATE tasks SET openclaw_run_id = ?, updated_at = ? WHERE task_id = ? AND status = \'running\'').run(retryRunId, ts, taskId);
    }
    this.store.heartbeatAgentSession(prepared.session.session_id);
    this.store.recordEvent(prepared.task.job_id, 'task.retry_dispatched', { taskId, sessionKey, attempt: prepared.attempt }, `${taskId}|retry-dispatched|${prepared.attempt}`);
    return { ...prepared, raw };
  }
}

export { listOpenClawSessions, tmuxExists };
export { extractTrajectoryExecutionEvidence, expectedCommandFromTask, hasVerifiedSuccessfulRuntimeEvidence };
