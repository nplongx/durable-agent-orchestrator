import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deliverSessionMessage } from './session-transport.js';
import { isProductionWorkflow } from './workflow/definitions/production.js';
import { isSupportedWorkflow } from './workflow/definitions/index.js';
import { ProductionRoles } from './workflow/catalog/production.js';

const execFileAsync = promisify(execFile);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const TMUX_BIN = process.env.TMUX_BIN || 'tmux';
const WORKFLOW_DATA_DIR = process.env.WORKFLOW_DATA_DIR || '/tmp';
const TRAJECTORY_ROOT = path.join(WORKFLOW_DATA_DIR, '.openclaw', 'trajectory-exports');

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
      '--workspace', WORKFLOW_DATA_DIR,
      '--output', output,
      '--json'
    ], timeoutMs);
    const eventsPath = path.join(TRAJECTORY_ROOT, output, 'events.jsonl');
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
      const verifiedSynthesis = [...assistantTexts].reverse().find(text =>
        /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/server\.js/i.test(text)
        && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/test-tool-turn\.js/i.test(text)
        && /exit\s+(?:status(?:\/code)?|code)\s*[:=]\s*0/i.test(text)
      );
      return `${factual}\n${verifiedSynthesis || assistantTexts.at(-1) || ''}`.trim();
    }
    const verifiedSynthesis = [...assistantTexts].reverse().find(text =>
      /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/server\.js/i.test(text)
      && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/test-tool-turn\.js/i.test(text)
      && /exit\s+(?:status(?:\/code)?|code)\s*[:=]\s*0/i.test(text)
    );
    return verifiedSynthesis || assistantTexts.at(-1) || null;
  } finally {
    await fs.rm(path.join(TRAJECTORY_ROOT, output), { recursive: true, force: true }).catch(() => {});
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
  return String(command || '').trim()
    .replace(/~\/work\/chatgpt-adapter\//gi, '/home/long/work/chatgpt-adapter/')
    .replace(/\.$/, '');
}

function expectedCommandFromTask(task) {
  try {
    const metadata = JSON.parse(task?.metadata_json || '{}');
    if (metadata.executor !== 'ExecutionManager') return '';
    return normalizeCommand(metadata.command || '');
  } catch (_) {
    return '';
  }
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
    jobStaleMs = 30 * 60 * 1000,
    trajectoryTimeoutMs = 45_000,
    listSessions = listOpenClawSessions,
    exportTrajectory = exportCompletedTrajectory,
    executionManager = null,
    providerAdmission = null
  } = {}) {
    this.store = store;
    this.sessionStaleMs = sessionStaleMs;
    this.executionStaleMs = executionStaleMs;
    this.jobStaleMs = jobStaleMs;
    this.trajectoryTimeoutMs = trajectoryTimeoutMs;
    this.listSessions = listSessions;
    this.exportTrajectory = exportTrajectory;
    this.executionManager = executionManager;
    this.providerAdmission = providerAdmission;
  }

  async reconcile({ jobId = null } = {}) {
    const allSessions = this.store.listAgentSessions({ jobId, limit: 500 });
    const sessions = allSessions.filter(s => ['ACTIVE', 'CREATED'].includes(s.state));
    const runtimeSessions = await this.listSessions();
    const runtimeMap = runtimeSessions.error
      ? null
      : new Map(runtimeSessions.map(s => [s.key, s]));

    if (this.providerAdmission && runtimeMap) {
      const liveTaskIds = new Set();
      const sessionRows = this.store.db.prepare("SELECT task_id, openclaw_session_key, status FROM tasks WHERE openclaw_session_key IS NOT NULL").all();
      for (const task of sessionRows) {
        const runtime = runtimeMap.get(task.openclaw_session_key);
        const runtimeStatus = String(runtime?.status || '').toLowerCase();
        if (runtime && ['active', 'running', 'working', 'queued'].includes(runtimeStatus)) liveTaskIds.add(task.task_id);
      }
      const releasedLeases = this.providerAdmission.reconcileOrphanLeases({ liveTaskIds, graceMs: this.sessionStaleMs });
      if (releasedLeases) console.warn(`[RecoveryManager] reconciled ${releasedLeases} orphan provider lease(s)`);
    }

    // A durable EXECUTING Job with no live OpenClaw runtime must not remain
    // eligible forever. These orphaned jobs otherwise look runnable to the
    // scheduler and can accumulate retry pressure after provider failures.
    // Fail closed only when the runtime inventory is authoritative, the job is
    // well past the normal execution window, and none of its task sessions is
    // alive. Never mutate a fresh/active Job or one whose runtime is merely
    // temporarily unavailable.
    if (runtimeMap) {
      const staleJobs = (jobId
        ? [this.store.getJob(jobId)].filter(Boolean)
        : this.store.db.prepare("SELECT * FROM jobs WHERE state='EXECUTING'").all())
        .filter(job => Date.now() - Date.parse(job.updated_at || 0) > this.jobStaleMs);
      for (const job of staleJobs) {
        const tasks = this.store.db.prepare('SELECT * FROM tasks WHERE job_id=?').all(job.job_id);
        const liveRuntime = tasks.some(task => {
          if (!task.openclaw_session_key) return false;
          const runtime = runtimeMap.get(task.openclaw_session_key);
          const status = String(runtime?.status || '').toLowerCase();
          return ['active', 'running', 'working', 'queued'].includes(status);
        });
        if (liveRuntime) continue;
        try {
          this.store.complete(job.job_id, [
            '[RECOVERY FAILURE]',
            `Job was EXECUTING for more than ${Math.round(this.jobStaleMs / 60000)} minutes, but no corresponding live OpenClaw runtime session remains.`,
            'Recovery closed the orphaned Job without spawning replacement work.'
          ].join('\n'), 'failure');
          this.store.recordEvent(job.job_id, 'job.runtime_reconciled', {
            outcome: 'failure',
            reason: 'stale_job_without_live_runtime',
            staleMs: Date.now() - Date.parse(job.updated_at || 0)
          }, `${job.job_id}|stale-job-without-live-runtime`);
        } catch (error) {
          console.warn(`[RecoveryManager] stale Job reconciliation failed job=${job.job_id}: ${error.message}`);
        }
      }

      const terminalRunningTasks = this.store.db.prepare(`
        SELECT t.task_id, t.openclaw_session_key
        FROM tasks t
        JOIN jobs j ON j.job_id = t.job_id
        WHERE t.status='running' AND j.status IN ('completed','failed','cancelled')
      `).all();
      for (const task of terminalRunningTasks) {
        const runtime = task.openclaw_session_key ? runtimeMap.get(task.openclaw_session_key) : null;
        const runtimeStatus = String(runtime?.status || '').toLowerCase();
        if (runtime && ['active', 'running', 'working', 'queued'].includes(runtimeStatus)) continue;
        try {
          this.store.reconcileRunningTaskForTerminalJob(task.task_id, 'parent job is already terminal and no live runtime session remains');
        } catch (error) {
          console.warn(`[RecoveryManager] terminal task reconciliation failed task=${task.task_id}: ${error.message}`);
        }
      }
    }
    // Completion reconciliation is task-driven, not session-state-driven.
    // A session may already be STALE when OpenClaw reports it as done; that
    // must never hide a terminal runtime result from the durable task.
    const reconcilableTasks = (jobId
      ? this.store.getJobTrace(jobId)?.tasks || []
      : this.store.db.prepare("SELECT * FROM tasks WHERE status = 'running' AND openclaw_session_key IS NOT NULL").all())
      .filter(t => ['running', 'failed'].includes(String(t.status).toLowerCase())
        && t.openclaw_session_key
        && isSupportedWorkflow(this.store.getJob(t.job_id)));
    for (const task of reconcilableTasks) {
      const runtime = runtimeMap?.get(task.openclaw_session_key);
      const runtimeStatus = String(runtime?.status || '').toLowerCase();
      if (!runtime || !['done', 'timeout', 'failed', 'error'].includes(runtimeStatus)) continue;
      try {
        if (runtimeStatus === 'timeout') {
          const completedTask = task.status === 'running'
            ? this.store.completeTaskByRuntime(task.job_id, {
              runId: task.openclaw_run_id || runtime.runId || null,
              sessionKey: task.openclaw_session_key,
              content: '[RECOVERY FAILURE]\nOpenClaw runtime session timed out before delivering a terminal result.',
              outcome: 'failure'
            })
            : task;
          const session = allSessions.find(s => s.task_id === task.task_id) || this.store.getSessionByOpenClawKey(task.openclaw_session_key);
          if (session) this.store.updateAgentSession(session.session_id, { state: 'FAILED' });
          this.store.recordEvent(task.job_id, 'session.runtime_reconciled', {
            taskId: task.task_id,
            sessionId: session?.session_id || null,
            sessionKey: task.openclaw_session_key,
            runId: task.openclaw_run_id || runtime.runId || null,
            outcome: 'failure',
            reason: 'openclaw_runtime_timeout'
          }, `${task.job_id}|${task.task_id}|runtime-timeout`);
          continue;
        }
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
          && ProductionRoles.includes(String(task.role || '').toLowerCase())
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
      const terminalDeterministicTasks = (trace?.tasks || this.store.db.prepare("SELECT t.* FROM tasks t JOIN jobs j ON j.job_id=t.job_id WHERE t.status IN ('completed','failed') AND t.role IN ('architect','qa') AND j.state='EXECUTING'").all())
        .filter(task => ProductionRoles.includes(String(task.role || '').toLowerCase())
          && ['completed', 'failed'].includes(String(task.status).toLowerCase())
          && isProductionWorkflow(this.store.getJob(task.job_id))
          && !task.execution_session_id
          && !task.execution_status);
      for (const task of terminalDeterministicTasks) {
        try {
          const latest = this.store.db.prepare('SELECT content FROM results WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(task.task_id);
          const latestContent = String(latest?.content || '');
          if (/\[ACTUAL EXECUTION EVIDENCE\]/i.test(latestContent)
            && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/(?:server\.js|test-tool-turn\.js)/i.test(latestContent)
            && /exit status\/code\s*:\s*0/i.test(latestContent)
            && /execution status\s*:\s*completed/i.test(latestContent)) continue;
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
          if (this.store.getTask(task.task_id)?.status === 'failed') {
            this.store.reconcileFailedTaskByRuntime(task.task_id, {
              content: evidence,
              runId: task.openclaw_run_id || null,
              sessionKey: task.openclaw_session_key || null
            });
          }
          this.store.recordEvent(task.job_id, 'execution.evidence_recovered', {
            taskId: task.task_id, role: task.role, command, exitCode: result.exitCode,
            executionSessionId: this.store.getTask(task.task_id)?.execution_session_id || null
          }, `${task.task_id}|execution-evidence-recovered`);
        } catch (error) {
          console.warn(`[RecoveryManager] deterministic evidence recovery failed task=${task.task_id}: ${error.message}`);
        }
      }
    }
    // A provider/runtime failure on a required specialist is retryable only on
    // the SAME durable task/session. Admission happens before dispatch so a
    // failed child cannot create a burst or consume a healthy account outside
    // the durable provider gate. Cap recovery to one retry per task here.
    // Business workflow advancement belongs to LangGraph. RecoveryManager
    // performs only runtime/orphan reconciliation here.
    if (jobId) {
      const trace = this.store.getJobTrace(jobId);
      const job = trace?.job;
      const cto = trace?.tasks?.find(t => t.task_id === job?.active_task_id && String(t.role).toLowerCase() === 'cto');
      if (job?.state === 'EXECUTING' && isProductionWorkflow(job) && cto?.openclaw_session_key) {
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
            if (/rate[_ -]?limit|too many requests|chưa nhận được phản hồi từ nguồn AI/i.test(String(completion || ''))) {
              const cooldown = this.store.db.prepare("SELECT MIN(cooldown_until) AS retry_at FROM provider_admission WHERE provider_id <> 'chatgpt:global' AND state='COOLDOWN' AND cooldown_until IS NOT NULL").get();
              const retryAt = cooldown?.retry_at ? Date.parse(cooldown.retry_at) : Date.now() + 60_000;
              const healthyProvider = this.providerAdmission?.all?.().some(row =>
                row.provider_id !== 'chatgpt:global'
                && ['READY', 'PROBE'].includes(row.state)
                && Number(row.in_flight || 0) === 0
              );
              if (!healthyProvider) {
                this.store.setProviderWaiting(jobId, Math.max(0, retryAt - Date.now()), 'CTO runtime hit provider rate limit; preserve same durable session');
                this.store.recordEvent(jobId, 'provider.waiting', {
                  role: 'cto', taskId: cto.task_id, sessionKey: cto.openclaw_session_key,
                  retryAt: new Date(retryAt).toISOString(), reason: 'cto_runtime_rate_limit'
                }, jobId + '|cto-rate-limit|' + new Date(retryAt).toISOString());
                return { staleSessions: [], staleExecutions: [], providerWaiting: true };
              }
              this.store.clearProviderWaiting(jobId);
            }
            const children = (trace.tasks || []).filter(t => t.parent_task_id === cto.task_id);
            const required = ProductionRoles.map(role => children.find(t => String(t.role).toLowerCase() === role));
            const childEvidenceValid = required.every(child => {
              if (!child || child.status !== 'completed') return false;
              const result = this.store.db.prepare('SELECT outcome, content FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(child.task_id);
              return result?.outcome === 'success'
                && /\[ACTUAL TOOL RESULT EVIDENCE\]/i.test(String(result.content || ''))
                && /node\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/(?:server\.js|test-tool-turn\.js)/i.test(String(result.content || ''))
                && /exit\s+(?:status|code)(?:\/code)?\s*(?::|=)?\s*(?:was\s+successful\s*\()?\s*0/i.test(String(result.content || ''));
            });
            const synthesisValid = childEvidenceValid && Boolean(String(completion || '').trim());
            if (childEvidenceValid && synthesisValid) {
              this.store.completeTaskByRuntime(jobId, {
                runId: cto.openclaw_run_id || runtime.runId || null,
                sessionKey: cto.openclaw_session_key,
                content: completion,
                outcome: 'success'
              });
              const reportId = this.store.createReport(jobId, 'executive_summary', completion);
              const deliveryChannel = 'slack';
              const deliveryTarget = process.env.SLACK_WAR_ROOM || 'C0C3RJKNKPG';
              this.store.claimDelivery(jobId, reportId, deliveryChannel, deliveryTarget);
              this.store.terminalizeJob(jobId, {
                outcome: 'success',
                reportId,
                deliveryChannel,
                deliveryTarget,
                content: completion
              });
              const session = this.store.getSessionByOpenClawKey(cto.openclaw_session_key);
              if (session) this.store.updateAgentSession(session.session_id, { state: 'TERMINATED' });
              this.store.recordEvent(jobId, 'job.runtime_reconciled', {
                taskId: cto.task_id, sessionKey: cto.openclaw_session_key, runId: cto.openclaw_run_id || runtime.runId || null, outcome: 'success'
              }, `${jobId}|job-runtime-reconciled|success`);
            }
            else if (runtimeStatus === 'done' && required.some(child => !child)) {
              // Missing specialist is a resumable graph state. Do not convert a
              // terminal model turn into business-job failure: LangGraph will
              // resume the SAME CTO session and request only the missing child.
              this.store.recordEvent(jobId, 'job.runtime_reconciled', {
                taskId: cto.task_id, sessionKey: cto.openclaw_session_key, runId: cto.openclaw_run_id || runtime.runId || null,
                outcome: 'waiting', reason: 'missing required specialist child'
              }, jobId + '|job-runtime-reconciled|missing-child|waiting');
            }
            else if (runtimeStatus === 'done'
              && required.every(child => child && ['completed', 'failed', 'cancelled'].includes(String(child.status).toLowerCase()))) {
              // Terminal model turn is not terminal business state. Keep the
              // Job open until deterministic evidence/synthesis gates pass.
              this.store.recordEvent(jobId, 'job.runtime_reconciled', {
                taskId: cto.task_id, sessionKey: cto.openclaw_session_key, runId: cto.openclaw_run_id || runtime.runId || null,
                outcome: 'waiting', reason: 'required child evidence or CTO synthesis not yet valid'
              }, `${jobId}|job-runtime-reconciled|evidence-waiting`);
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

}

export { listOpenClawSessions, tmuxExists };
export { extractTrajectoryExecutionEvidence, expectedCommandFromTask, hasVerifiedSuccessfulRuntimeEvidence };
