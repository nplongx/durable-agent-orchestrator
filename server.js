// server.js — OpenAI-compatible API server for ChatGPT Web with Tool Calling support
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { ChatGPTBrowserBridge, MultiAccountChatGPTBridge } from './cdp.js';
import { States, Intents, Actions, IntentClassifier, CoordinatorSessionStateMachine } from './coordinator-workflow.js';
import { workflowStore, conversationKeyFromMessages, WORKFLOW_DB_PATH } from './job-store.js';
import { evaluateLangGraph, LangGraphActions } from './langgraph-orchestrator.js';
import { deliverSessionMessage } from './session-transport.js';
import { ExecutionManager } from './execution-manager.js';
import { RecoveryManager } from './recovery-manager.js';
import { validateExecutionBatch, validateExecutionResult } from './protocol/cos-ap-v1/index.js';
import { ProviderAdmissionController, ProviderStates, isProviderRateLimitError } from './provider-admission.js';
import { isProductionWorkflow } from './src/runtime/workflow/definitions/production.js';
import { ProductionRoles } from './src/runtime/workflow/catalog/production.js';
import { getWorkflowDefinition, isEngineeringWorkflow, isStandardEngineeringWorkflow } from './src/runtime/workflow/definitions/index.js';
import { verifyWorkflowCompletion } from './src/runtime/workflow/verifier.js';
import { enforceTmpInodeGuard } from './src/runtime/tmp-pressure.js';
import { DistributedScheduler } from './src/runtime/distributed-scheduler.js';
import { GitHubActionsProvider } from './src/runtime/github-actions-provider.js';
import { M11RunnerProvider } from './src/runtime/m11-runner-provider.js';

const LANGGRAPH_ORCHESTRATOR_MODE = process.env.LANGGRAPH_ORCHESTRATOR || 'shadow';
const SESSION_TRANSPORT_MODE = process.env.SESSION_TRANSPORT || 'shadow';
const SESSION_TRANSPORT_MAX_ATTEMPTS = Math.max(1, Number(process.env.SESSION_TRANSPORT_MAX_ATTEMPTS) || 5);
const SESSION_TRANSPORT_RETRY_BASE_MS = Math.max(0, Number(process.env.SESSION_TRANSPORT_RETRY_BASE_MS) || 2000);
const SESSION_TRANSPORT_RETRY_MAX_MS = Math.max(SESSION_TRANSPORT_RETRY_BASE_MS, Number(process.env.SESSION_TRANSPORT_RETRY_MAX_MS) || 60_000);
const SESSION_TRANSPORT_LEASE_MS = Math.max(5_000, Number(process.env.SESSION_TRANSPORT_LEASE_MS) || 120_000);
let sessionTransportBusy = false;
const executionManager = new ExecutionManager(workflowStore);
const providerAdmission = new ProviderAdmissionController(workflowStore);
const WORKER_PROVIDER_MODE = String(process.env.WORKFLOW_WORKER_PROVIDER || '').toLowerCase();
let workflowWorkerProvider = null;
if (WORKER_PROVIDER_MODE === 'mock' || process.env.M11_RUNNER_MODE === 'mock') {
  workflowWorkerProvider = new M11RunnerProvider({ runnerId: process.env.M11_RUNNER_ID || 'm11-mock-runner', store: workflowStore });
} else if (WORKER_PROVIDER_MODE === 'github-actions') {
  workflowWorkerProvider = new GitHubActionsProvider({ store: workflowStore });
}
const workflowWorkerScheduler = workflowWorkerProvider
  ? new DistributedScheduler({
      store: workflowStore,
      provider: workflowWorkerProvider,
      maxParallel: Math.max(1, Number(process.env.WORKFLOW_WORKER_MAX_PARALLEL) || 4),
      leaseTtlMs: Math.max(30_000, Number(process.env.WORKFLOW_WORKER_LEASE_TTL_MS) || 10 * 60_000),
      workerId: process.env.WORKFLOW_WORKER_ID || `workflow-worker-${process.pid}`
    })
  : null;

const TMP_INODE_WARN_PERCENT = Math.min(99, Math.max(1, Number(process.env.TMP_INODE_WARN_PERCENT) || 70));
const TMP_INODE_CLEANUP_PERCENT = Math.min(99, Math.max(TMP_INODE_WARN_PERCENT, Number(process.env.TMP_INODE_CLEANUP_PERCENT) || 85));
const TMP_INODE_CRITICAL_PERCENT = Math.min(100, Math.max(TMP_INODE_CLEANUP_PERCENT, Number(process.env.TMP_INODE_CRITICAL_PERCENT) || 95));
const TMP_INODE_CHECK_INTERVAL_MS = Math.max(10_000, Number(process.env.TMP_INODE_CHECK_INTERVAL_MS) || 60_000);
let tmpInodeHealth = null;
function refreshTmpInodeHealth() {
  try {
    tmpInodeHealth = enforceTmpInodeGuard({
      warnPercent: TMP_INODE_WARN_PERCENT,
      cleanupPercent: TMP_INODE_CLEANUP_PERCENT,
      criticalPercent: TMP_INODE_CRITICAL_PERCENT
    });
    if (tmpInodeHealth.warning) console.warn(`[Adapter:Tmp] inode usage ${tmpInodeHealth.usedPercent.toFixed(1)}% (${tmpInodeHealth.used}/${tmpInodeHealth.total}); cleanup=${tmpInodeHealth.cleanupTriggered ? 'yes' : 'no'} critical=${tmpInodeHealth.critical ? 'yes' : 'no'}`);
    if (tmpInodeHealth.cleanup?.removed) console.log(`[Adapter:Tmp] removed ${tmpInodeHealth.cleanup.removed} stale OpenClaw plugin build dir(s)`);
  } catch (error) {
    tmpInodeHealth = { warning: true, critical: false, error: error.message };
    console.warn(`[Adapter:Tmp] inode check failed: ${error.message}`);
  }
  return tmpInodeHealth;
}
refreshTmpInodeHealth();
const tmpInodeHealthTimer = setInterval(refreshTmpInodeHealth, TMP_INODE_CHECK_INTERVAL_MS);
tmpInodeHealthTimer.unref?.();
executionManager.cleanupOrphanedArtifacts().then(count => {
  if (count) console.log(`[Adapter:Execution] cleaned ${count} orphaned batch/execution artifact(s)`);
}).catch(error => console.warn(`[Adapter:Execution] artifact cleanup skipped: ${error.message}`));
const recoveryManager = new RecoveryManager(workflowStore, {
  sessionStaleMs: Math.max(30_000, Number(process.env.RECOVERY_SESSION_STALE_MS) || 5 * 60 * 1000),
  executionStaleMs: Math.max(10_000, Number(process.env.RECOVERY_EXECUTION_STALE_MS) || 2 * 60 * 1000),
  executionManager,
  providerAdmission
});

function providerIdsFromBridge() {
  return ['chatgpt:global', ...bridge.accounts.map(account => `chatgpt:account:${account.id}`)];
}

function syncProviderAdmissionFromBridge() {
  const ids = providerIdsFromBridge();
  providerAdmission.syncProviders(ids);
  const status = bridge.getStatus();
  const limitedAccounts = (status.accounts || []).filter(account => account.isRateLimited);
  if (limitedAccounts.length === (status.accounts || []).length && limitedAccounts.length > 0) {
    const remaining = Math.min(...limitedAccounts.map(account => Number(account.rateLimitRemainingMs) || 0));
    const existing = providerAdmission.status('chatgpt:global');
    if (!(existing?.state === ProviderStates.COOLDOWN && existing.cooldownRemainingMs > 0)) {
      providerAdmission.markRateLimited('chatgpt:global', 'all_accounts_rate_limited', Math.max(60_000, remaining));
    }
  }
  for (const account of status.accounts || []) {
    if (account.isRateLimited) {
      const providerId = `chatgpt:account:${account.id}`;
      const existing = providerAdmission.status(providerId);
      if (!(existing?.state === ProviderStates.COOLDOWN && existing.cooldownRemainingMs > 0)) {
        providerAdmission.markRateLimited(providerId, 'bridge_rate_limit', Math.max(60_000, account.rateLimitRemainingMs || 0));
      }
    }
  }
  return providerAdmission.all();
}

function reconcileBridgeRateLimitForJob(jobId, error) {
  const states = syncProviderAdmissionFromBridge();
  const accounts = states.filter(s => s.provider_id !== 'chatgpt:global');
  const limited = accounts.filter(s => s.state === ProviderStates.COOLDOWN);
  if (!accounts.length || limited.length !== accounts.length) return null;
  const retryAfterMs = Math.max(60_000, Math.min(...limited.map(s => s.cooldownRemainingMs || 0).filter(Number.isFinite)) || 0);
  providerAdmission.markRateLimited('chatgpt:global', 'bridge_all_accounts_rate_limited', retryAfterMs);
  if (jobId) {
    workflowStore.setProviderWaiting(jobId, retryAfterMs, error?.message || 'bridge_all_accounts_rate_limited');
    const leases = workflowStore.db.prepare("SELECT lease_id FROM provider_admission_leases WHERE state='ACTIVE' AND job_id=?").all(jobId);
    for (const lease of leases) providerAdmission.release(lease.lease_id, { success: false, reason: 'bridge provider rate limit' });
  }
  return retryAfterMs;
}

function admitNativeSpawn({ jobId, taskId, role }) {
  const states = syncProviderAdmissionFromBridge();
  const admission = providerAdmission.admit({
    providerIds: states.map(s => s.provider_id),
    jobId,
    taskId,
    role
  });
  workflowStore.recordEvent(jobId, 'provider.admitted', {
    providerId: admission.providerId,
    leaseId: admission.leaseId,
    role,
    expiresAt: admission.expiresAt
  }, `${admission.leaseId}|admitted`);
  return admission;
}

function runtimeCompletionFailed(rawCompletion) {
  // Completion status is runtime-generated metadata. Never infer workflow
  // failure from arbitrary child-result prose.
  return /^status\s*:\s*(?:failed|error|timed out|timeout)\b/im.test(String(rawCompletion || ''));
}

function isRuntimeCompletionEnvelopeOnly(rawCompletion) {
  const text = String(rawCompletion || '');
  if (!/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>|\[Internal task completion event\]|A background task completed/i.test(text)) return false;
  // OpenClaw can announce completion before the child result is delivered.
  // That announcement is transport metadata, not a durable task artifact.
  if (/\[ACTUAL (?:TOOL RESULT|EXECUTION BATCH|EXECUTION) EVIDENCE\]/i.test(text)) return false;
  const promptData = text.match(/<prompt-data>\s*([\s\S]*?)\s*<\/prompt-data>/i)?.[1]?.trim();
  if (promptData && !/^\(no output\)$/i.test(promptData)) return false;
  return true;
}

async function executeDurableDeterministicToolCall(toolCall, messages, targetRole, signal = null) {
  if (signal?.aborted) throw new Error('Request aborted by caller');
  if (!toolCall || !['exec', 'execute_batch'].includes(toolCall.name)) return null;
  const role = String(targetRole || '').toLowerCase();
  if (!ProductionRoles.includes(role)) return null;
  const jobId = workflowStore.findJobIdFromMessages(messages || []);
  if (!jobId) return null;
  const job = workflowStore.getJob(jobId);
  if (!job || job.state !== States.EXECUTING) return null;
  let args = {};
  try { args = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : (toolCall.arguments || {}); } catch (_) { return null; }
  if (toolCall.name === 'execute_batch' || (toolCall.name === 'exec' && Array.isArray(args.tasks))) {
    const requestedItems = Array.isArray(args.tasks) ? args.tasks : [];
    const batchId = String(args.batch_id || '').trim();
    if (batchId) {
      const batch = workflowStore.getExecutionBatch(batchId);
      if (!batch || batch.job_id !== jobId || String(batch.role).toLowerCase() !== role) return null;
      const result = await executionManager.executeBatch(batchId, { signal });
      if (signal?.aborted) throw new Error('Request aborted by caller');
      return { ...result, content: `<prompt-data>\n[ACTUAL TOOL RESULT EVIDENCE]\n${result.aggregate_content}\n</prompt-data>`, durableBatchId: batchId };
    }
    if (!requestedItems.length) return null;
    const trace = workflowStore.getJobTrace(jobId);
    const parentTaskId = String(args.parent_task_id || workflowStore.getJob(jobId)?.active_task_id || '').trim() || null;
    const items = requestedItems.map(item => ({ taskId: String(item?.task_id || item?.taskId || '').trim(), command: String(item?.command || '').trim() }));
    const seen = new Set();
    for (const item of items) {
      const normalizedBatchCommand = item.command.replace(/^node\s+--check\s+~\/work\/chatgpt-adapter\//i, 'node --check /home/long/work/chatgpt-adapter/');
      item.command = normalizedBatchCommand;
      const task = item.taskId
        ? trace?.tasks?.find(t => t.task_id === item.taskId)
        : workflowStore.findDeterministicTask(jobId, { role, command: normalizedBatchCommand });
      item.taskId = task?.task_id || item.taskId;
      if (!item.taskId || seen.has(item.taskId)) return null;
      seen.add(item.taskId);
      if (!task || String(task.role).toLowerCase() !== role || (parentTaskId && task.parent_task_id !== parentTaskId)) return null;
      const metadata = JSON.parse(task.metadata_json || '{}');
      const expectedCommand = String(metadata.command || '').trim();
      if (metadata.executor !== 'ExecutionManager') return null;
      if (!expectedCommand || expectedCommand !== item.command) return null;
    }
    const protocolBatch = {
      batch_id: batchId || `pending_${jobId}`,
      wait: 'all',
      tasks: items.map((item, index) => ({ id: `requested_${index + 1}`, task_id: item.taskId, command: item.command }))
    };
    validateExecutionBatch(protocolBatch);
    const batch = workflowStore.createExecutionBatch(jobId, { parentTaskId, role, items });
    const result = await executionManager.executeBatch(batch.batch_id, { signal });
    if (signal?.aborted) throw new Error('Request aborted by caller');
    const resultLine = String(result.aggregate_content || '').match(/protocol_result_json:\s*(\{.*\})/);
    if (!resultLine) throw new Error(`execution batch ${batch.batch_id} returned no protocol result`);
    validateExecutionResult(JSON.parse(resultLine[1]));
    return { ...result, content: `<prompt-data>\n[ACTUAL TOOL RESULT EVIDENCE]\n${result.aggregate_content}\n</prompt-data>`, durableBatchId: batch.batch_id };
  }
  const command = String(args.command || '').trim();
  if (!/^(?:node|npm|npx|git|python(?:3)?|bash|sh|pnpm|yarn)\b/.test(command)) return null;
  const normalizedCommand = command.replace(/^node\s+--check\s+~\/work\/chatgpt-adapter\//i, 'node --check /home/long/work/chatgpt-adapter/');
  let task = workflowStore.findDeterministicTask(jobId, { role, command: normalizedCommand });
  if (!task) {
    // Completion can race the adapter tool turn. If the durable child already
    // exists but lacks ExecutionManager evidence, select that exact child even
    // when its OpenClaw status is terminal. Never revive a child that already
    // has verified durable execution evidence.
    const trace = workflowStore.getJobTrace(jobId);
    task = (trace?.tasks || []).find(candidate => {
      if (String(candidate.role || '').toLowerCase() !== role) return false;
      const description = String(candidate.description || '');
      if (!description.includes(normalizedCommand)) return false;
      if (candidate.execution_status || candidate.execution_session_id) return false;
      // A native OpenClaw exec result is transport evidence only. It may exist
      // before ExecutionManager claims the durable task and must not suppress
      // deterministic recovery. Only ACTUAL EXECUTION EVIDENCE is authoritative.
      const latest = workflowStore.db.prepare('SELECT content FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(candidate.task_id);
      return !/\[ACTUAL EXECUTION EVIDENCE\]/i.test(String(latest?.content || ''));
    }) || null;
  }
  if (!task) return null;
  const metadata = JSON.parse(task.metadata_json || '{}');
  const expectedCommand = String(metadata.command || '').trim() || null;
  if (metadata.executor !== 'ExecutionManager') return null;
  if (!expectedCommand || expectedCommand !== normalizedCommand) return null;
  workflowStore.recordEvent(jobId, 'execution.manager_claimed', { taskId: task.task_id, role, command: normalizedCommand, requestedCommand: command }, `${task.task_id}|claimed`);
  const result = await executionManager.executeTask(task.task_id, { command: normalizedCommand, signal });
  if (signal?.aborted) throw new Error('Request aborted by caller');
  const evidence = [
    '<prompt-data>',
    `[ACTUAL TOOL RESULT EVIDENCE]`,
    `exact command: ${result.command}`,
    `stdout:\n${result.stdout || ''}`,
    `stderr:\n${result.stderr || ''}`,
    `exit status/code: ${result.exitCode == null ? 'N/A' : result.exitCode}`,
    `execution status: ${result.timedOut ? 'timeout' : result.exitCode === 0 ? 'completed' : 'failed'}`,
    '</prompt-data>'
  ].join('\n');
  // ExecutionManager is the durable execution authority. Preserve its actual
  // evidence even if OpenClaw already terminalized the child on a race.
  workflowStore.repairResultEvidence(task.task_id, evidence);
  if (workflowStore.getTask(task.task_id)?.status === 'failed') {
    workflowStore.reconcileFailedTaskByRuntime(task.task_id, {
      content: evidence,
      runId: task.openclaw_run_id || null,
      sessionKey: task.openclaw_session_key || null
    });
  }
  return { ...result, content: evidence, durableTaskId: task.task_id };
}

function reconcileSessionDelivery() {
  const recovered = workflowStore.reconcileSessionDelivery({
    maxAttempts: SESSION_TRANSPORT_MAX_ATTEMPTS,
    baseDelayMs: SESSION_TRANSPORT_RETRY_BASE_MS,
    maxDelayMs: SESSION_TRANSPORT_RETRY_MAX_MS
  });
  if (recovered) console.warn(`[Adapter:SessionTransport] Recovered ${recovered} expired delivery lease(s).`);
  return recovered;
}

async function executeWorkflowTask(task, signal = null) {
  if (signal?.aborted) throw new Error('Request aborted by caller');
  const result = await executionManager.executeAuthorizedTask(task.task_id, { signal });
  if (signal?.aborted) throw new Error('Request aborted by caller');
  const evidence = [
    '<prompt-data>',
    '[ACTUAL TOOL RESULT EVIDENCE]',
    `exact command: ${result.command || JSON.parse(task.metadata_json || '{}').command || '(structured execution)'}`,
    `exit status/code: ${result.exitCode == null ? 'N/A' : result.exitCode}`,
    `stdout:\n${result.stdout || ''}`,
    `stderr:\n${result.stderr || ''}`,
    '</prompt-data>'
  ].join('\n');
  workflowStore.completeTaskByRuntime(task.job_id, {
    runId: task.openclaw_run_id || null,
    sessionKey: task.openclaw_session_key || null,
    content: evidence,
    outcome: result.exitCode === 0 && !result.timedOut ? 'success' : 'failure'
  });
  return result;
}

async function evaluateRequestLangGraph(messages, signal = null) {
  if (signal?.aborted) throw new Error('Request aborted by caller');
  if (LANGGRAPH_ORCHESTRATOR_MODE === 'off') return null;
  const jobId = workflowStore.findJobIdFromMessages(messages || []);
  if (!jobId) return null;
  const job = workflowStore.getJob(jobId);
  if (!job) return null;
  // Provider/model turns are execution runtime, not workflow-control events.
  // Once the durable job is EXECUTING, only the workflow controller may advance
  // orchestration; re-entering LangGraph from provider requests can race
  // synthesis/child assignment.
  if (String(job.state).toUpperCase() === 'EXECUTING') return null;
  const trace = workflowStore.getJobTrace(jobId);
  const plan = workflowStore.getExecutionPlan(jobId);
  const decision = await evaluateLangGraph({
    job,
    tasks: trace?.tasks || [],
    results: trace?.results || [],
    plan,
    event: 'adapter_turn',
    persist: true,
    store: workflowStore,
    spawnCto: ({ job, tasks, store }) => spawnWorkflowCto(job, tasks, store),
    executeTask: executeWorkflowTask,
    assignChildren: ({ job, tasks }) => assignWorkflowChildren(job, tasks),
    synthesize: ({ job, tasks, results, store }) => dispatchCtoSynthesis(job, tasks, results, store),
    terminalize: ({ job, tasks, results, store }) => terminalizeFromCtoResult(job, tasks, results, store),
    project: ({ job, store }) => projectTerminalJob(job, store),
    signal
  });
  if (signal?.aborted) throw new Error('Request aborted by caller');
  console.log(`[Adapter:LangGraph:${LANGGRAPH_ORCHESTRATOR_MODE}] job=${jobId} state=${job.state} action=${decision.action} reason=${decision.reason}`);
  return decision;
}

const workflowControllerJobsInFlight = new Set();
async function reconcileWorkflowRunner(jobId) {
  if (!workflowWorkerProvider) return [];
  if (typeof workflowWorkerScheduler?.reconcileProviderDispatches === 'function') await workflowWorkerScheduler.reconcileProviderDispatches();
  const runs = workflowStore.db.prepare(`SELECT pr.*, l.lease_id, l.attempt AS lease_attempt
    FROM provider_runs pr JOIN task_leases l ON l.lease_id=pr.lease_id
    WHERE pr.job_id=? AND l.state='ACTIVE'`).all(jobId);
  const reconciled = [];
  for (const run of runs) {
    let status;
    try { status = await workflowWorkerProvider.getStatus(run.provider_run_id); } catch (error) { reconciled.push({ taskId: run.task_id, status: 'STATUS_ERROR', error: error.message }); continue; }
    if (status.state !== 'COMPLETED' && String(status.status || '').toUpperCase() !== 'COMPLETED') continue;
    try {
      const result = await workflowWorkerProvider.collectResult(run.provider_run_id);
      reconciled.push({ taskId: run.task_id, status: workflowStore.applyVerifiedExecutionResult(result).status });
    } catch (error) {
      workflowStore.expireTaskLease(run.lease_id, { reason: `runner_evidence_rejected: ${error.message}` });
      reconciled.push({ taskId: run.task_id, status: 'REJECTED', error: error.message });
    }
  }
  return reconciled;
}

async function runWorkflowControllerTick() {
  if (LANGGRAPH_ORCHESTRATOR_MODE === 'off') return;
  const jobs = [
    ...workflowStore.listActiveJobs(100),
    ...workflowStore.listProjectableJobs(100)
  ];
  const seen = new Set();
  for (const job of jobs) {
    if (seen.has(job.job_id) || workflowControllerJobsInFlight.has(job.job_id)) continue;
    seen.add(job.job_id);
    if (!getWorkflowDefinition(job)) continue;
    const runtime = workflowStore.getWorkflowRuntimeState(job.job_id);
    if (!runtime || ['COMPLETED', 'FAILED'].includes(runtime.phase)) continue;
    if (runtime.resume_after && Date.parse(runtime.resume_after) > Date.now()) continue;
    if (job.provider_waiting && job.provider_retry_at && Date.parse(job.provider_retry_at) > Date.now()) continue;
    workflowControllerJobsInFlight.add(job.job_id);
    void (async () => {
      try {
        const trace = workflowStore.getJobTrace(job.job_id);
        await reconcileWorkflowRunner(job.job_id);
        if (runtime.phase === 'APPROVED' && !workflowStore.getExecutionPlan(job.job_id)) {
          const reason = `immutable execution plan missing: ${job.job_id}`;
          workflowStore.transitionWorkflowPhase(job.job_id, 'FAILED', {
            lastError: reason,
            event: 'workflow.failed',
            payload: { reason }
          });
          workflowStore.transition(job.job_id, 'FAILED', 'failed');
          return;
        }
        if (runtime.phase === 'SYNTHESIZE') await reconcileCtoSynthesis(job, trace?.tasks || [], trace?.results || []);
        const runtimeAfterReconcile = workflowStore.getWorkflowRuntimeState(job.job_id);
        if (runtimeAfterReconcile?.resume_after && Date.parse(runtimeAfterReconcile.resume_after) > Date.now()) return;
        const refreshed = workflowStore.getJobTrace(job.job_id);
        const plan = workflowStore.getExecutionPlan(job.job_id);
        const decision = await evaluateLangGraph({
          job,
          tasks: refreshed?.tasks || [],
          results: refreshed?.results || [],
          plan,
          event: 'workflow_controller_tick',
          persist: true,
          store: workflowStore,
          spawnCto: ({ job, tasks, store }) => spawnWorkflowCto(job, tasks, store),
          executeTask: executeWorkflowTask,
          assignChildren: ({ job, tasks }) => assignWorkflowChildren(job, tasks),
          synthesize: ({ job, tasks, results, store }) => dispatchCtoSynthesis(job, tasks, results, store),
          terminalize: ({ job, tasks, results, store }) => terminalizeFromCtoResult(job, tasks, results, store),
          project: ({ job, store }) => projectTerminalJob(job, store)
        });
        if (decision.action !== LangGraphActions.NOOP) console.log(`[Adapter:WorkflowController] job=${job.job_id} phase=${runtime.phase} action=${decision.action} reason=${decision.reason}`);
      } catch (error) {
        console.warn(`[Adapter:WorkflowController] job=${job.job_id} tick failed: ${error.message}`);
      } finally {
        workflowControllerJobsInFlight.delete(job.job_id);
      }
    })();
  }
}

async function gatewayJson(method, params) {
  const encoded = JSON.stringify(params);
  return new Promise((resolve, reject) => {
    execFile(OPENCLAW_BIN, ['gateway', 'call', method, '--timeout', '10000', '--params', encoded], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message));
      const start = stdout.indexOf('{');
      if (start < 0) return reject(new Error(`invalid ${method} response`));
      try { resolve(JSON.parse(stdout.slice(start))); } catch (_) { reject(new Error(`invalid ${method} response`)); }
    });
  });
}

async function reconcileCtoSynthesis(job, tasks) {
  const cto = tasks.find(t => t.task_id === job.active_task_id && String(t.role).toLowerCase() === 'cto');
  if (!cto) return;
  const synthesisKey = cto.openclaw_session_key;
  if (!synthesisKey || !synthesisKey.startsWith(`agent:cto:synthesis:${job.job_id}:attempt:`)) return;
  let described;
  try { described = await gatewayJson('sessions.describe', { key: synthesisKey }); } catch (_) { return; }
  if (!described?.session) return;
  const active = await gatewayJson('sessions.list', { activeOnly: true, limit: 100 }).catch(() => ({ sessions: [] }));
  if ((active.sessions || []).some(s => s.key === synthesisKey && s.hasActiveRun)) return;
  const preview = await gatewayJson('sessions.preview', { keys: [synthesisKey] }).catch(() => null);
  const items = preview?.previews?.[0]?.items || [];
  const assistant = [...items].reverse().find(item => item.role === 'assistant' && String(item.text || '').trim());
  if (!assistant) return;
  const content = String(assistant.text || '').trim();
  const adapterTimeout = '⚠️ Xin lỗi, hệ thống chưa nhận được phản hồi từ nguồn AI trong thời gian cho phép. Vui lòng thử lại ạ.';
  const synthesisValid = Boolean(content) && content !== adapterTimeout;
  if (!synthesisValid) {
    workflowStore.completeTaskByRuntime(job.job_id, {
      sessionKey: synthesisKey,
      content,
      outcome: 'failure'
    });
    if (isEngineeringWorkflow(job)) {
      const reason = 'CTO synthesis runtime failed without verified native completion';
      workflowStore.transitionWorkflowPhase(job.job_id, 'FAILED', {
        lastError: reason,
        event: 'workflow.failed',
        payload: { reason, taskId: cto.task_id, sessionKey: synthesisKey }
      });
      workflowStore.transition(job.job_id, 'FAILED', 'failed');
      return;
    }
    const current = workflowStore.getWorkflowRuntimeState(job.job_id);
    const attempt = Math.max(1, Number(current?.attempt || 1));
    const resumeAfter = new Date(Date.now() + WORKFLOW_PROVIDER_RETRY_DELAY_MS).toISOString();
    workflowStore.setWorkflowRuntimeState(job.job_id, 'SYNTHESIZE', {
      attempt,
      resumeAfter,
      lastError: 'CTO synthesis runtime completed without required verified evidence'
    });
    workflowStore.setProviderWaiting?.(job.job_id, WORKFLOW_PROVIDER_RETRY_DELAY_MS, 'CTO synthesis provider cooldown');
    workflowStore.recordEvent(job.job_id, 'workflow.synthesis_attempt_failed', {
      taskId: cto.task_id,
      sessionKey: synthesisKey,
      attempt,
      reason: 'runtime completed without required verified synthesis evidence'
    }, `${job.job_id}:synthesis-attempt-failed:${attempt}`);
    return;
  }
  workflowStore.recordEvent(job.job_id, 'workflow.synthesis_completed', {
    taskId: cto.task_id, sessionKey: synthesisKey
  }, `${job.job_id}:synthesis-completed:${synthesisKey}`);
  workflowStore.completeTaskByRuntime(job.job_id, { sessionKey: synthesisKey, content, outcome: 'success' });
}

async function spawnWorkflowCto(job, tasks, store) {
  const definition = getWorkflowDefinition(job);
  if (!definition) return;
  let cto = tasks.find(t => t.task_id === job.active_task_id && String(t.role).toLowerCase() === 'cto');
  if (definition.id === 'standard-engineering') {
    if (!cto) {
      cto = store.dispatch(job.job_id, { role: 'cto', description: String(job.title || '').trim() });
      store.startAttempt(job.job_id);
    }
    const synthesisSpec = store.getExecutionPlan(job.job_id)?.synthesis;
    if (synthesisSpec) {
      let metadata = {}; try { metadata = JSON.parse(cto.metadata_json || '{}'); } catch (_) {}
      metadata = { ...metadata, ...(synthesisSpec.execution || {}), workflow_plan_task_id: synthesisSpec.id, runtime_owner: 'github-runner', execution_mode: 'agent' };
      store.db.prepare('UPDATE tasks SET metadata_json=?, updated_at=? WHERE task_id=?').run(JSON.stringify(metadata), new Date().toISOString(), cto.task_id);
    }
    store.recordEvent(job.job_id, 'workflow.cto_coordinator_ready', {
      taskId: cto.task_id, owner: 'local-coordinator', runtimeOwner: 'github-runner'
    }, `${job.job_id}:cto-coordinator-ready`);
    return;
  }
  if (!cto) {
    const description = String(job.title || '').trim();
    cto = store.dispatch(job.job_id, { role: 'cto', description });
    store.startAttempt(job.job_id);
  }
  if (cto.openclaw_session_key || cto.openclaw_run_id) return;
  const existingLease = store.db.prepare("SELECT lease_id, provider_id, expires_at FROM provider_admission_leases WHERE job_id=? AND task_id=? AND role='cto' AND state='ACTIVE' ORDER BY created_at DESC LIMIT 1").get(job.job_id, cto.task_id);
  const admission = existingLease || admitNativeSpawn({ jobId: job.job_id, taskId: cto.task_id, role: 'cto' });
  try {
    const proposalEvent = store.getJobTrace(job.job_id)?.events?.find(e => e.type === 'job.proposal_requested');
    let scope = String(cto.description || '').trim();
    if (proposalEvent?.payload_json) {
      try {
        const proposal = JSON.parse(proposalEvent.payload_json);
        if (typeof proposal.task === 'string' && proposal.task.trim()) scope = proposal.task.trim();
      } catch (_) {}
    }
    const roles = definition.requiredChildren.map(taskId => {
      const plan = store.getExecutionPlan(job.job_id);
      return plan?.children?.find(item => item.id === taskId)?.role || taskId;
    });
    const message = 'Durable Job ID: ' + job.job_id + '.\nBoss đã phê duyệt. Bắt đầu execution NOW.\n\n' + scope + '\n\nBạn là CTO/technical lead. LangGraph là workflow authority. Không tự spawn/retry theo ý mình. Runtime sẽ phân công specialist bằng native OpenClaw và xác minh durable evidence. Required roles: ' + roles.join(', ') + '.';
    const key = 'agent:cto:lead:' + job.job_id;
    const payload = await gatewayJson('sessions.create', { key, agentId: 'cto', message });
    if (!payload?.ok || !payload?.key) throw new Error('sessions.create not started: ' + JSON.stringify(payload));
    store.attachOpenClawRun(job.job_id, { runId: payload.runId || null, sessionKey: payload.key });
    store.clearProviderWaiting(job.job_id);
  } catch (error) {
    try { providerAdmission.release(admission.leaseId, { reason: 'native CTO spawn failed' }); } catch (_) {}
    throw error;
  }
}

async function dispatchStandardEngineeringTask(task, spec, job) {
  if (!workflowWorkerScheduler) throw new Error('standard-engineering runner provider is not configured; set WORKFLOW_WORKER_PROVIDER=github-actions');
  const payload = {
    schema_version: 1,
    job_id: job.job_id,
    task_id: task.task_id,
    role: spec.role,
    description: task.description,
    required_evidence: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'],
    runtime_owner: 'github-runner', execution_mode: 'agent',
    cwd: spec.execution?.cwd || null, timeout_ms: spec.execution?.timeout_ms || 300000
  };
  const inputCommit = process.env.WORKFLOW_INPUT_COMMIT || null;
  if (!inputCommit) throw new Error('WORKFLOW_INPUT_COMMIT is required for runner dispatch');
  const dispatched = await workflowWorkerScheduler.dispatchTask(task, {
    inputCommit, role: spec.role, taskPayloadInline: payload, requiredEvidence: payload.required_evidence
  });
  workflowStore.recordEvent(job.job_id, 'workflow.runner_task_dispatched', {
    taskId: task.task_id, role: spec.role, providerRunId: dispatched.run?.provider_run_id || null,
    runnerOwner: 'github-runner', workerId: workflowWorkerScheduler.workerId
  }, `${job.job_id}:runner-dispatch:${task.task_id}:${dispatched.lease?.attempt || 1}`);
  return dispatched;
}

async function assignWorkflowChildren(job, tasks) {
  const definition = getWorkflowDefinition(job);
  if (!definition) return;
  const cto = tasks.find(t => t.task_id === job.active_task_id && String(t.role).toLowerCase() === 'cto');
  if (definition.id !== 'standard-engineering' && !cto?.openclaw_session_key) throw new Error('CTO native session is required before ASSIGN_CHILDREN');
  const plan = workflowStore.getExecutionPlan(job.job_id);
  if (!plan) throw new Error('immutable execution plan missing before ASSIGN_CHILDREN: ' + job.job_id);
  const required = plan.children;
  const trace = workflowStore.getJobTrace(job.job_id);
  if (definition.id === 'standard-engineering') {
    const parentTaskId = cto?.task_id || null;
    const existing = new Map((trace?.tasks || [])
      .filter(t => t.parent_task_id === parentTaskId)
      .map(t => { let metadata = {}; try { metadata = JSON.parse(t.metadata_json || '{}'); } catch (_) {} return [metadata.workflow_plan_task_id || metadata.workflowPlanTaskId || String(t.role).toLowerCase(), t]; }));
    const completedPlanIds = new Set(required.filter(spec => String(existing.get(spec.id)?.status || '').toLowerCase() === 'completed').map(spec => spec.id));
    const ready = required.filter(spec => (spec.dependencies || []).every(dep => completedPlanIds.has(dep) || !required.some(candidate => candidate.id === dep)));
    for (const spec of ready) {
      const current = existing.get(spec.id);
      const task = current || workflowStore.createChildTask(job.job_id, {
        parentTaskId, role: spec.role, description: `Runner-owned ${spec.role} task for ${job.job_id}.`,
        metadata: { ...spec.execution, workflow_plan_task_id: spec.id, capability: spec.capability || null, dependencies: spec.dependencies || [], runtime_owner: 'github-runner', execution_mode: 'agent' }
      });
      if (['completed', 'failed', 'cancelled'].includes(String(task.status).toLowerCase())) continue;
      if (task.openclaw_session_key || task.openclaw_run_id) throw new Error(`standard-engineering task ${task.task_id} unexpectedly has local OpenClaw runtime`);
      await dispatchStandardEngineeringTask(task, spec, job);
    }
    return;
  }
  const existing = new Map((trace?.tasks || [])
    .filter(t => t.parent_task_id === cto.task_id)
    .map(t => {
      let metadata = {};
      try { metadata = JSON.parse(t.metadata_json || '{}'); } catch (_) {}
      return [metadata.workflow_plan_task_id || metadata.workflowPlanTaskId || String(t.role).toLowerCase(), t];
    }));
  const taskByPlanId = new Map();
  for (const [planId, task] of existing) taskByPlanId.set(planId, task);
  const completedPlanIds = new Set(
    required
      .filter(spec => taskByPlanId.get(spec.id))
      .filter(spec => String(taskByPlanId.get(spec.id).status).toLowerCase() === 'completed')
      .map(spec => spec.id)
  );
  const ready = required.filter(spec => (spec.dependencies || []).every(dep => completedPlanIds.has(dep) || !required.some(candidate => candidate.id === dep)));
  await Promise.all(ready.map(async spec => {
    const current = existing.get(spec.id);
    const task = current || workflowStore.createChildTask(job.job_id, {
      parentTaskId: cto.task_id,
      role: spec.role,
      description: `Execute deterministic runtime task for ${job.job_id}.`,
      metadata: {
        ...spec.execution,
        workflow_plan_task_id: spec.id,
        capability: spec.capability || null,
        dependencies: spec.dependencies || []
      }
    });
    if (['completed', 'failed', 'cancelled'].includes(String(task.status).toLowerCase())) return;
    if (task.openclaw_session_key || task.openclaw_run_id) return;
    const deterministic = spec.execution?.executor === 'ExecutionManager' && spec.execution?.deterministic === true;
    if (deterministic) {
      workflowStore.recordEvent(job.job_id, 'workflow.deterministic_child_assigned', {
        taskId: task.task_id,
        role: spec.role,
        capability: spec.capability || null,
        command: spec.execution.command,
        executor: 'ExecutionManager'
      }, `${job.job_id}:deterministic-child-assigned:${spec.role}`);
      return;
    }
    const token = JSON.parse(fs.readFileSync(path.join(process.env.HOME || '/home/long', '.openclaw/openclaw.json'), 'utf8'))?.gateway?.auth?.token;
    if (!token) throw new Error('OpenClaw gateway token unavailable');
    const admission = admitNativeSpawn({ jobId: job.job_id, taskId: task.task_id, role: spec.role });
    try {
      const evidenceTaskIds = spec.role === 'reviewer'
        ? required.filter(item => item.id !== spec.id).map(item => item.id)
        : (spec.dependencies || []);
      const dependencyEvidence = evidenceTaskIds.map(depId => {
        const depSpec = required.find(item => item.id === depId);
        const depTask = depSpec ? [...(trace?.tasks || [])]
          .filter(item => item.parent_task_id === cto.task_id && (() => { try { const metadata = JSON.parse(item.metadata_json || '{}'); return (metadata.workflow_plan_task_id || metadata.workflowPlanTaskId) === depId; } catch (_) { return false; } })())
          .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] : null;
        const depResult = depTask ? (trace?.results || []).find(item => item.task_id === depTask.task_id) : null;
        let evidence = String(depResult?.content || '(missing)');
        if (depSpec?.role === 'architect') {
          const match = evidence.match(/<prompt-data>\s*([\s\S]*?)\s*<\/prompt-data>/i);
          if (match?.[1]) evidence = match[1].trim();
        }
        return `DEPENDENCY=${depId}\nSTATUS=${depTask?.status || 'missing'}\nEVIDENCE=${evidence.slice(0, 12000)}`;
      }).join('\n\n');
      const roleGuidance = {
        'product-owner': 'Product contract: turn the Boss request into explicit user outcomes, scope, non-goals, acceptance criteria, and measurable Definition of Done. Do not implement code.',
        researcher: 'Research contract: investigate relevant code, existing patterns, dependencies, and external technical constraints. Return cited/factual findings and concrete recommendations. Do not modify production code.',
        architect: 'Architecture contract: define components, interfaces, data flow, boundaries, failure modes, and the smallest implementation plan. Respect actual repository conventions.',
        engineer: 'Implementation contract: implement the approved design only. Keep the diff focused, run relevant tests, and return exact changed files plus test evidence.',
        security: 'Security contract: threat-model the proposed change and inspect code/dependencies for concrete security issues, secrets, auth flaws, injection, unsafe filesystem/process behavior, and supply-chain risk. Return severity + evidence + remediation.',
        qa: 'QA contract: derive acceptance tests from requirements and architecture, exercise the real changed behavior, and return exact commands, outputs, and failures. Do not claim success from static inspection alone.',
        platform: 'Platform contract: inspect deployment/runtime/CI/observability implications, resource limits, rollback/recovery, and operational failure modes. Return concrete checks and required changes.',
        writer: 'Documentation contract: update or propose accurate user/developer documentation matching the implemented behavior, including configuration, operations, and examples where relevant.',
        reviewer: 'Review contract: independently reconcile requirements, architecture, implementation, security, QA, platform, and documentation evidence. Block unsupported claims; return structured findings and a clear acceptance decision.'
      }[spec.role];
      const taskInstruction = [
        `Durable Job ID: ${job.job_id}.`,
        `Capability=${spec.capability || 'legacy'}.`,
        `Workflow scope: ${String(job.title || '').trim()}`,
        spec.execution.command ? `Authorized exact command: ${spec.execution.command}` : 'No deterministic command; produce the role artifact.',
        roleGuidance || '',
        spec.role === 'architect' && /engineering m4/i.test(String(job.title || ''))
          ? 'M4 compatibility contract: the exact target artifact is .m4-engineer-proof.js with exactly one line: export const m4EngineerProof = true; followed by a newline.'
          : '',
        spec.role === 'reviewer'
          ? 'Review contract: the acceptance scope is exactly the minimal .m4-engineer-proof.js change stated above, not a request to implement the whole adapter. Treat actual Engineer/QA ExecutionManager evidence plus Architect architecture evidence as the required evidence. If those gates pass, output this exact one-line JSON literal and nothing else: {"review":{"requirementsSatisfied":true,"architectureConformant":true,"implementationIssues":[],"evidenceIssues":[],"blockingIssues":[]}}. If a gate fails, output the same schema with truthful false/issues values. Never truncate, wrap, or explain the JSON.'
          : '',
        'Execute only through the durable workflow contract. Do not spawn or retry other roles.',
        dependencyEvidence ? `Actual dependency evidence:\n${dependencyEvidence}` : ''
      ].filter(Boolean).join('\n');
      const response = await fetch('http://127.0.0.1:9010/tools/invoke', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          tool: 'sessions_spawn',
          sessionKey: cto.openclaw_session_key,
          idempotencyKey: `${job.job_id}:spawn:${spec.role}`,
          args: { agentId: spec.role, taskName: `cos-${spec.role}-${job.job_id.slice(-12)}`, task: taskInstruction, cwd: spec.execution.cwd, runTimeoutSeconds: Math.ceil((spec.execution.timeout_ms || 120000) / 1000), expectsCompletionMessage: true, context: 'isolated' }
        })
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error?.message || `sessions_spawn HTTP ${response.status}`);
      let receipt = payload?.result || payload;
      if (!receipt?.runId || !receipt?.childSessionKey) {
        const textReceipt = receipt?.content?.find(item => item?.type === 'text')?.text;
        if (textReceipt) {
          try { receipt = JSON.parse(textReceipt); } catch (_) {}
        }
      }
      if (!receipt?.runId || !receipt?.childSessionKey) {
        const retryAfterMs = Number(receipt?.retryAfterMs || payload?.retryAfterMs || 0);
        if (receipt?.blockedByProviderAdmission || payload?.blockedByProviderAdmission || retryAfterMs > 0) {
          throw new Error(`PROVIDER_UNAVAILABLE: native sessions_spawn admission blocked; retry after ${Math.ceil(retryAfterMs / 1000)}s`);
        }
        throw new Error(`sessions_spawn returned no durable runtime receipt: ${JSON.stringify(payload).slice(0, 1000)}`);
      }
      workflowStore.attachTaskRuntime(task.task_id, { runId: receipt.runId, sessionKey: receipt.childSessionKey });
      workflowStore.recordEvent(job.job_id, 'workflow.child_assigned', { taskId: task.task_id, role: spec.role, capability: spec.capability || null, runId: receipt.runId, sessionKey: receipt.childSessionKey, command: spec.execution.command || null }, `${job.job_id}:child-assigned:${spec.role}`);
    } catch (error) {
      try { providerAdmission.release(admission.leaseId, { reason: 'native child spawn failed' }); } catch (_) {}
      throw error;
    }
  }));
}

async function spawnProductionCto(job, tasks, store) {
  return spawnWorkflowCto(job, tasks, store);
}

async function assignProductionChildren(job, tasks) {
  return assignWorkflowChildren(job, tasks);
}

async function dispatchCtoSynthesis(job, tasks, results, store) {
  const cto = tasks.find(t => t.task_id === job.active_task_id && String(t.role).toLowerCase() === 'cto');
  if (isStandardEngineeringWorkflow(job)) {
    if (!workflowWorkerScheduler) throw new Error('standard-engineering runner provider is not configured; set WORKFLOW_WORKER_PROVIDER=github-actions');
    if (!cto) throw new Error('standard-engineering CTO task is missing');
    if (cto.openclaw_session_key || cto.openclaw_run_id) throw new Error('standard-engineering CTO must not use local OpenClaw runtime');
    const plan = store.getExecutionPlan(job.job_id);
    const payload = {
      schema_version: 1, job_id: job.job_id, task_id: cto.task_id, role: 'cto',
      description: `Runner-owned CTO synthesis for ${job.job_id}.`,
      required_evidence: ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'],
      runtime_owner: 'github-runner', execution_mode: 'agent', cwd: plan?.synthesis?.execution?.cwd || null,
      timeout_ms: plan?.synthesis?.execution?.timeout_ms || 300000
    };
    await dispatchStandardEngineeringTask(cto, { role: 'cto', execution: payload, capability: 'synthesis.approve' }, job);
    store.recordEvent(job.job_id, 'workflow.synthesis_dispatched', { taskId: cto.task_id, runnerOwner: 'github-runner' }, `${job.job_id}:runner-synthesis:${cto.task_id}:${cto.execution_attempt || 1}`);
    return;
  }
  if (!cto?.openclaw_session_key) throw new Error('CTO native session unavailable for synthesis');
  if (String(cto.status).toLowerCase() === 'running' && cto.openclaw_session_key.startsWith(`agent:cto:synthesis:${job.job_id}:attempt:`)) return;
  const evidence = tasks
    .filter(t => t.parent_task_id === cto.task_id)
    .map(t => {
      const result = results.find(r => r.task_id === t.task_id);
      const spec = JSON.parse(t.metadata_json || '{}');
      return `ROLE=${t.role}\nTASK=${t.task_id}\nSTATUS=${t.status}\nCOMMAND=${spec.command}\nCWD=${spec.cwd}\nEXECUTION_STATUS=${t.execution_status}\nEXIT_CODE=${t.execution_exit_code}\nRESULT=${String(result?.content || '').slice(0, 12000)}`;
    }).join('\n\n');
  const runtime = store.getWorkflowRuntimeState(job.job_id);
  const attempt = Math.max(1, Number(runtime?.attempt || 0) + 1);
  const synthesisKey = `agent:cto:synthesis:${job.job_id}:attempt:${attempt}`;
  const params = JSON.stringify({
    key: synthesisKey,
    agentId: 'cto',
    message: `[DURABLE SYNTHESIS]\nJob=${job.job_id}\nUse ONLY the following actual ExecutionManager evidence. Return concise factual synthesis for terminal report. Do not spawn children.\n\n${evidence.slice(0, 14000)}`
  });
  const payload = await new Promise((resolve, reject) => {
    execFile(OPENCLAW_BIN, ['gateway', 'call', 'sessions.create', '--timeout', '10000', '--params', params], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message));
      try { resolve(JSON.parse(stdout.slice(stdout.indexOf('{')))); } catch (_) { reject(new Error(`invalid sessions.create response: ${stdout.slice(0, 500)}`)); }
    });
  });
  if (!payload?.ok || !payload?.key) throw new Error(`sessions.create not started: ${JSON.stringify(payload)}`);
  store.completeActiveAttempt(cto.task_id, { reason: 'CTO lead phase completed; synthesis phase starting' });
  store.beginRuntimeAttempt(cto.task_id, {
    runId: payload.runId || null,
    sessionKey: payload.key,
    reason: String(cto.status).toLowerCase() === 'failed'
      ? 'retry failed synthesis runtime'
      : 'initial CTO synthesis runtime'
  });
  store.attachTaskRuntime(cto.task_id, { runId: payload.runId || null, sessionKey: payload.key });
  store.setWorkflowRuntimeState(job.job_id, 'SYNTHESIZE', { attempt });
  store.recordEvent(job.job_id, 'workflow.synthesis_dispatched', {
    taskId: cto.task_id, sessionKey: payload.key, runId: payload.runId || null, attempt
  }, `${job.job_id}:synthesis:${attempt}`);
}

async function terminalizeFromCtoResult(job, tasks, results, store) {
  if (job.state === 'COMPLETED') return;
  const cto = tasks.find(t => t.task_id === job.active_task_id && String(t.role).toLowerCase() === 'cto');
  if (!cto || !['completed'].includes(String(cto.status).toLowerCase())) throw new Error('CTO synthesis is not terminal-success');
  const result = [...results].reverse().find(r => r.task_id === cto.task_id);
  const content = String(result?.content || '').trim();
  const adapterTimeout = '⚠️ Xin lỗi, hệ thống chưa nhận được phản hồi từ nguồn AI trong thời gian cho phép. Vui lòng thử lại ạ.';
  if (!content || content === adapterTimeout) throw new Error('CTO synthesis result is not a native completion');
  const plan = store.getExecutionPlan(job.job_id);
  if (!plan) throw new Error('immutable execution plan missing before terminalization: ' + job.job_id);
  const reportId = store.createReport(job.job_id, 'executive_summary', content);
  const traceBeforeTerminal = store.getJobTrace(job.job_id);
  if (plan) {
  const verification = verifyWorkflowCompletion({
      plan,
      tasks: traceBeforeTerminal.tasks,
      results: traceBeforeTerminal.results,
      reports: traceBeforeTerminal.reports.map(report => ({ kind: report.kind, content: report.content })),
      projection: null
  });
  if (!verification.valid) {
    const reason = `workflow verification failed: ${verification.errors.join('; ')}`;
    store.transitionWorkflowPhase(job.job_id, 'FAILED', {
      lastError: reason,
      event: 'workflow.failed',
      payload: { reason, errors: verification.errors }
    });
    store.transition(job.job_id, 'FAILED', 'failed');
    return;
  }
  }
  store.claimDelivery(job.job_id, reportId, 'slack', SLACK_WAR_ROOM);
  store.terminalizeJob(job.job_id, {
    outcome: 'success',
    reportId,
    deliveryChannel: 'slack',
    deliveryTarget: SLACK_WAR_ROOM,
    content
  });
}

async function projectTerminalJob(job, store) {
  if (String(process.env.SLACK_PROJECTION_GLOBAL || '').toLowerCase() !== 'true') return;
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    await projectWorkflowEvents(job.job_id);
    const projection = store.getSlackProjection(job.job_id);
    if (projection && Number(projection.pendingEvents || 0) === 0) {
      const trace = store.getJobTrace(job.job_id);
      const plan = store.getExecutionPlan(job.job_id);
      const verification = verifyWorkflowCompletion({
        plan,
        tasks: trace?.tasks || [],
        results: trace?.results || [],
        reports: trace?.reports || [],
        projection
      });
      if (!verification.valid) throw new Error(`workflow postcondition verification failed: ${verification.errors.join('; ')}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const projection = store.getSlackProjection(job.job_id);
  if (Number(projection?.pendingEvents || 0) !== 0) throw new Error(`UNPROJECTED=${projection?.pendingEvents ?? 'unknown'}`);
}

function dispatchProgressMessage({ text, channel = 'slack', target = 'C0C3RJKNKPG' }) {
  console.log(`[Adapter:ProgressLog] (${channel}:${target}) ${(text || '').slice(0, 100)}`);
}

const SLACK_WAR_ROOM = process.env.SLACK_WAR_ROOM || 'C0C3RJKNKPG';
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const WORKFLOW_PROVIDER_RETRY_DELAY_MS = Math.max(30_000, Number(process.env.WORKFLOW_PROVIDER_RETRY_DELAY_MS) || 180_000);
const slackProjectionInFlight = new Set();
const slackProjectionJobsInFlight = new Set();
let slackProjectionBusy = false;

export function openclawMessageSend({ channel, target, message, replyTo = null }) {
  return new Promise((resolve, reject) => {
    const args = ['message', 'send', '--channel', channel, '--target', target, '--message', message, '--delivery', JSON.stringify({ queuePolicy: 'best_effort' }), '--json'];
    if (replyTo) args.push('--reply-to', replyTo);
    execFile(OPENCLAW_BIN, args, { timeout: 45000, killSignal: 'SIGTERM' }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr?.trim() || error.message));
      try { resolve(JSON.parse(stdout)); } catch (_) { resolve({ raw: stdout.trim() }); }
    });
  });
}

function formatSlackProjection(event) {
  const p = JSON.parse(event.payload_json || '{}');
  const taskId = p.taskId || null;
  const task = taskId ? workflowStore.getTask(taskId) : null;
  const label = {
    'job.proposal_requested': 'PROPOSAL',
    'approval.approved': 'APPROVED',
    'task.created': 'TASK ASSIGNED',
    'task.dispatched': 'TASK DISPATCHED',
    'attempt.started': 'TASK STARTED',
    'task.runtime_attached': 'RUNTIME ATTACHED',
    'task.completed': 'TASK COMPLETED',
    'task.failed': 'TASK FAILED',
    'report.created': 'REPORT READY',
    'delivery.claimed': 'DELIVERY CLAIMED'
  }[event.type] || event.type.toUpperCase();
  const view = workflowStore.refreshSlackJobView(event.job_id, { eventId: event.event_id, eventType: event.type });
  const details = Object.entries(p)
    .filter(([k]) => !['content','rawText','description'].includes(k))
    .map(([k,v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' | ');
  const progress = view
    ? `state=${view.state} | tasks=${view.task_completed}/${view.task_total} done | running=${view.task_running} | failed=${view.task_failed}`
      + (view.provider_waiting ? ` | provider=WAITING${view.provider_retry_at ? ` until=${view.provider_retry_at}` : ''}` : '')
    : '';
  const taskContext = task ? ` | role=${task.role} | task=${task.task_id}` : '';
  return `[Job ${event.job_id}] ${label} | ${progress}${taskContext}${details ? ` | ${details}` : ''}`;
}

export async function projectWorkflowEvents(jobId = null) {
  if (jobId) {
    if (slackProjectionJobsInFlight.has(jobId)) return;
    slackProjectionJobsInFlight.add(jobId);
  } else {
    if (slackProjectionBusy) return;
    slackProjectionBusy = true;
  }
  const events = workflowStore.listUnprojectedEvents(25, jobId);
  if (events.length) console.log(`[Adapter:SlackProjection] pending=${events.length}`);
  try {
    // Serialize external sends. OpenClaw may cold-open its agent DB and Slack
    // delivery should not fan out dozens of concurrent CLI calls.
    const event = events[0];
    if (!event) return;
    if (slackProjectionInFlight.has(event.event_id)) return;
    slackProjectionInFlight.add(event.event_id);
    try {
      let thread = workflowStore.getSlackThread(event.job_id);
      if (!thread) thread = workflowStore.ensureSlackThread(event.job_id, { channel: 'slack', target: SLACK_WAR_ROOM });
      const message = formatSlackProjection(event);
      const sent = await openclawMessageSend({
        channel: 'slack',
        target: thread.target,
        message,
        replyTo: thread.root_message_id || null
      });
      const messageId = sent?.messageId || sent?.message_id || sent?.id || sent?.ts || null;
      if (!thread.root_message_id && messageId) workflowStore.setSlackRootMessage(event.job_id, messageId);
      workflowStore.claimSlackProjection(event.event_id, event.job_id, { channel: 'slack', target: thread.target, messageId });
      workflowStore.refreshSlackJobView(event.job_id, { eventId: event.event_id, eventType: event.type });
    } catch (err) {
      console.error(`[Adapter:SlackProjection] event ${event.event_id}: ${err.message}`);
    } finally {
      slackProjectionInFlight.delete(event.event_id);
    }
  } finally {
    if (jobId) slackProjectionJobsInFlight.delete(jobId);
    else slackProjectionBusy = false;
  }
}

async function drainSessionInbox() {
  if (SESSION_TRANSPORT_MODE !== 'active' || sessionTransportBusy) return;
  sessionTransportBusy = true;
  try {
    const sessions = workflowStore.listAgentSessions({ limit: 200 })
      .filter(s => ['ACTIVE', 'CREATED'].includes(s.state));
    for (const session of sessions) {
      const message = workflowStore.claimNextSessionMessage(session.session_id, {
        recipientRole: session.role,
        leaseMs: 125_000
      });
      if (!message) continue;
      const result = await workflowStore.deliverSessionMessage(message.message_id, deliverSessionMessage, {
        maxAttempts: SESSION_TRANSPORT_MAX_ATTEMPTS,
        retryDelayMs: SESSION_TRANSPORT_RETRY_BASE_MS,
        retryMaxDelayMs: SESSION_TRANSPORT_RETRY_MAX_MS,
        timeoutSeconds: Math.ceil(SESSION_TRANSPORT_LEASE_MS / 1000)
      });
      console.log(`[Adapter:SessionTransport] message=${message.message_id} role=${session.role} status=${result?.status || 'unknown'} attempt=${result?.attempt || message.attempt}`);
    }
  } catch (error) {
    console.error('[Adapter:SessionTransport] drain:', error.message);
  } finally {
    sessionTransportBusy = false;
  }
}

const PORT = parseInt(process.env.PORT || '8318', 10);
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const HTTP_HOST = process.env.HTTP_HOST || '127.0.0.1';
const ACCOUNT_COUNT = Math.min(4, Math.max(1, parseInt(process.env.ACCOUNT_COUNT || '4', 10)));
const BRIDGE_ASK_TIMEOUT_MS = Number(process.env.BRIDGE_ASK_TIMEOUT_MS) || 300000;

const bridge = new MultiAccountChatGPTBridge({
  cdpHost: CDP_HOST,
  // Account-level admission serializes model requests per browser account.
  // Parallelism is only allowed across genuinely independent account profiles.
  singleTabMode: process.env.SINGLE_TAB_MODE === 'true',
  cooldownMs: parseInt(process.env.COOLDOWN_MS || '10000', 10), // 10s pacing cooldown
  maxConcurrentRequestsPerAccount: parseInt(process.env.MAX_CONCURRENT_REQUESTS_PER_ACCOUNT || '1', 10),
  rateLimitCooldownMs: parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || String(3 * 60 * 1000), 10),
  rateLimitMaxCooldownMs: parseInt(process.env.RATE_LIMIT_MAX_COOLDOWN_MS || String(20 * 60 * 1000), 10),
  accounts: process.env.M11_RUNNER_MODE === 'mock' ? [
    { id: 1, name: 'M11 Mock Account', port: 0, dataDir: process.env.WORKFLOW_DATA_DIR || '/tmp/cos-m11-mock' }
  ] : [
    { id: 1, name: 'Account 1', port: 9021, dataDir: '/home/long/.config/google-chrome-chatgpt' },
    { id: 2, name: 'Account 2', port: 9022, dataDir: '/home/long/.config/google-chrome-chatgpt-2' },
    { id: 3, name: 'Account 3', port: 9023, dataDir: '/home/long/.config/google-chrome-chatgpt-3' },
    { id: 4, name: 'Account 4', port: 9024, dataDir: '/home/long/.config/google-chrome-chatgpt-4' }
  ].slice(0, ACCOUNT_COUNT)
});

// Rate-limit state must survive an adapter restart. Otherwise a restart during
// an active ChatGPT block would immediately forget the cooldown and resend the
// request, creating exactly the retry storm we are trying to prevent.
bridge.restoreRateLimits(providerAdmission.all());

// Deterministic HTTP streaming-failure fixture for adapter contract tests only.
// It is deliberately opt-in and keyed to a unique probe phrase so production
// behavior is unchanged unless a test explicitly enables it.
if (process.env.ADAPTER_TEST_PARTIAL_UPSTREAM_FAILURE === 'true') {
  const originalBridgeAsk = bridge.ask.bind(bridge);
  bridge.ask = async (prompt, onChunk, ...rest) => {
    if (String(prompt).includes('partial failure regression')) {
      if (typeof onChunk === 'function') onChunk('partial upstream output');
      throw new Error('Timeout waiting for ChatGPT response after 1000ms');
    }
    return originalBridgeAsk(prompt, onChunk, ...rest);
  };
}

function cleanMessageContent(content) {
  if (!content) return '';
  if (typeof content !== 'string') {
    if (Array.isArray(content)) {
      const texts = content
        .map(c => typeof c === 'string' ? c : (c.text || ''))
        .filter(t => !t.includes('[OpenClaw heartbeat poll]'));
      content = texts.join('\n').trim();
    } else {
      content = JSON.stringify(content);
    }
  }

  // Strip OpenClaw internal contexts, heartbeat noise, and instructions meant for background polling
  content = content.replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, '');
  content = content.replace(/\[\[OPENCLAW_INTERNAL_CONTEXT_BEGIN\]\][\s\S]*?\[\[OPENCLAW_INTERNAL_CONTEXT_END\]\]/g, '');
  content = content.replace(/\[OpenClaw heartbeat poll\]/g, '');
  content = content.replace(/Follow the heartbeat monitor scratch context[\s\S]*?reply NO_REPLY\./gi, '');

  // Strip OpenClaw internal subagent context and completion noise
  content = content.replace(/\[Subagent Context\][^\n]*/gi, '');
  content = content.replace(/Child completion results:[\s\S]*?(?=(Người dùng|Boss|Chủ tịch|$))/gi, '');
  content = content.replace(/\[Internal task completion event\][\s\S]*?(?=(Người dùng|Boss|Chủ tịch|$))/gi, '');
  content = content.replace(/A background task completed[\s\S]*?(?=(Người dùng|Boss|Chủ tịch|$))/gi, '');
  content = content.replace(/\[Inter-session message\][^\n]*/gi, '');
  content = content.replace(/This content was routed by OpenClaw[^\n]*/gi, '');

  // Strip adapter bridge errors from historical messages
  content = content.replace(/⚠️\s*\[ChatGPT Bridge\][^\n]*/gi, '');

  // Strip DSH internal graph memory metadata and system-reminders from user messages
  content = content.replace(/<graph-memory-archive>[\s\S]*?<\/graph-memory-archive>/gi, '');
  content = content.replace(/<graph-memory-trace[^>]*>[\s\S]*?<\/graph-memory-trace>/gi, '');
  content = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
  content = content.replace(/Current runtime context[\s\S]*?fails closed\./gi, '');

  return content.trim();
}

export function formatMessagesToPrompt(messages, tools, explicitModel = '', workflowMetadata = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  // Special handling for session title generation requests from DSH
  const isTitleRequest = messages.some(m => typeof m.content === 'string' && m.content.includes('Create a concise title'));
  if (isTitleRequest) {
    const lastMsg = messages[messages.length - 1];
    const rawTxt = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content || '');
    return {
      prompt: `Tạo một tiêu đề ngắn gọn (khoảng 3-5 từ) mô tả nội dung sau:\n${rawTxt}\nChỉ trả về duy nhất tiêu đề.`,
      agentRole: 'coordinator',
      agentName: 'Title Generator'
    };
  }

  // Detect which agent is speaking from messages first (search backwards and check metadata)
  let agentName = '';
  let agentRole = '';

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    
    // Check Runtime: name=... | agent=...
    const agentMatch = text.match(/\bagent=([a-zA-Z0-9_-]+)/);
    const nameMatch = text.match(/Runtime:.*?\bname=([^|\n\r]+)/) || text.match(/\|\s*name=([^|\n\r]+)/);
    if (agentMatch && !agentRole) {
      agentRole = agentMatch[1].trim().toLowerCase();
    }
    if (nameMatch && !agentName) {
      const n = nameMatch[1].trim();
      if (!n.includes('"') && !n.includes('<') && !n.includes('>')) {
        agentName = n;
      }
    }

    // Check IDENTITY.md or Creature match
    if (!agentRole) {
      const creatureMatch = text.match(/Creature:\s*([a-zA-Z0-9_-]+)\s+assistant/i);
      if (creatureMatch) agentRole = creatureMatch[1].trim().toLowerCase();
    }
    if (!agentName) {
      const identityNameMatch = text.match(/-\s*\*\*Name:\*\*\s*([^\n\r]+)/);
      if (identityNameMatch) {
        const n = identityNameMatch[1].trim();
        if (!n.includes('"') && !n.includes('<') && !n.includes('>')) {
          agentName = n;
        }
      }
    }

    if (agentRole && agentName) break;
  }

  // Model fallback if role was not determined from messages
  if (!agentRole) {
    if (explicitModel.includes('cto') || explicitModel.includes('dto')) {
      agentRole = 'cto';
      agentName = 'CTO / Lead Engineer';
    } else if (explicitModel.includes('reviewer')) {
      agentRole = 'reviewer';
      agentName = 'Reviewer';
    } else if (explicitModel.includes('coordinator')) {
      agentRole = 'coordinator';
      agentName = 'Chief of Staff';
    } else if (explicitModel.includes('researcher')) {
      agentRole = 'researcher';
      agentName = 'Researcher';
    } else if (explicitModel.includes('writer')) {
      agentRole = 'writer';
      agentName = 'Writer';
    }
  }

  // Native Engineering M4 enters through the CTO runtime directly. Persist the
  // proposal/approval boundary here, but never let CTO become the controller.
  let directEngineeringJob = null;
  if (agentRole === 'cto') {
    const latestUserText = [...(messages || [])].reverse()
      .find(m => m?.role === 'user' && typeof m.content === 'string' && !String(m.content).includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') && !String(m.content).includes('[Subagent Context]'))
      ?.content?.trim() || '';
    const approvalText = latestUserText.replace(/^\[[^\]]+\]\s*/, '').trim();
    const explicitMessageJobId = latestUserText.match(/job_[0-9a-f-]{20,}/i)?.[0] || null;
    if (isEngineeringWorkflow({ title: latestUserText }) || isStandardEngineeringWorkflow({ title: latestUserText })) {
      console.log(`[Adapter:Workflow] CTO native ingress matched workflow title=${latestUserText.slice(0, 120)}`);
      const conversationKey = conversationKeyFromMessages(messages);
      directEngineeringJob = workflowStore.getActiveJob(conversationKey);
      if (!directEngineeringJob) {
        directEngineeringJob = workflowStore.createJob({ conversationKey, title: latestUserText.slice(0, 500) });
        workflowStore.transition(directEngineeringJob.job_id, States.PROPOSED);
        workflowStore.recordEvent(directEngineeringJob.job_id, 'job.proposal_requested', { task: latestUserText }, latestUserText);
      }
    }
    if (!directEngineeringJob && explicitMessageJobId) {
      const candidate = workflowStore.getJob(explicitMessageJobId);
      if (candidate?.state === States.PROPOSED && (isEngineeringWorkflow(candidate) || isStandardEngineeringWorkflow(candidate))) directEngineeringJob = candidate;
    }
    if (!directEngineeringJob) {
      const conversationKey = conversationKeyFromMessages(messages);
      const candidate = workflowStore.getActiveJob(conversationKey);
      if (candidate && (isEngineeringWorkflow(candidate) || isStandardEngineeringWorkflow(candidate))) directEngineeringJob = candidate;
    }
    const isApproval = /^(?:duyệt|approve|approved|đồng ý|triển khai(?: ngay)?|chốt)(?:\s+(?:Job\s+)?job_[0-9a-f-]{20,})(?:[.!\s].*)?$/i.test(approvalText);
    if (directEngineeringJob?.state === States.PROPOSED && isApproval) {
      workflowStore.approve(directEngineeringJob.job_id, approvalText);
      directEngineeringJob = workflowStore.getJob(directEngineeringJob.job_id);
    }
  }

  // Fallback if not detected
  const toolNamesList = Array.isArray(tools) ? tools.map(t => (t.function?.name || t.name || '')) : [];
  const hasSessionsSpawn = toolNamesList.some(n => n.includes('sessions_spawn'));
  const isCodingOrDsh = toolNamesList.some(n => ['bash', 'glob', 'grep', 'todo_write', 'ralph', 'present'].includes(n));

  if (!agentRole) {
    if (hasSessionsSpawn) {
      agentRole = 'coordinator';
    } else if (isCodingOrDsh) {
      agentRole = 'cto';
    } else {
      agentRole = 'coordinator';
    }
  }

  if (!agentName) {
    if (agentRole === 'coordinator') agentName = 'Chief of Staff';
    else if (agentRole === 'cto') agentName = 'CTO / Lead Engineer';
    else if (agentRole === 'reviewer') agentName = 'Reviewer';
    else if (agentRole === 'researcher') agentName = 'Researcher';
    else if (agentRole === 'writer') agentName = 'Writer';
    else if (agentRole === 'engineer') agentName = 'Senior Software Engineer';
    else if (agentRole === 'architect') agentName = 'Solution Architect';
    else if (agentRole === 'qa') agentName = 'QA Engineer';
    else if (agentRole === 'platform') agentName = 'Platform / DevOps Engineer';
    else if (agentRole === 'security') agentName = 'Security Engineer';
    else if (agentRole === 'product-owner') agentName = 'Product Owner';
    else agentName = agentRole;
  }

  // Reconcile child completion events before constructing the CTO prompt.
  // Otherwise a terminal child can still look "running" during this turn and
  // the generic FSM may inject a premature reporting instruction.
  if (agentRole !== 'coordinator') {
    const referencedJobId = workflowMetadata.job_id || workflowMetadata.jobId || workflowStore.findJobIdFromMessages(messages);
    const durableJob = referencedJobId
      ? workflowStore.getJob(referencedJobId)
      : workflowStore.getActiveJob(conversationKeyFromMessages(messages));
    if (durableJob) {
      workflowStore.reconcileRuntimeRefs(durableJob.job_id, messages);
      for (const completionTurn of (messages || []).filter(m => {
        const c = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
        return /\[Internal task completion event\]|A background task completed/i.test(c);
      })) {
        const rawCompletion = typeof completionTurn?.content === 'string'
          ? completionTurn.content
          : JSON.stringify(completionTurn?.content || '');
        const childRunIds = [...rawCompletion.matchAll(/(?:childRunId|child_run_id)["'\s:=]+([A-Za-z0-9._:-]+)/gi)].map(m => m[1]);
        const runIds = [...rawCompletion.matchAll(/(?:runId|run_id)["'\s:=]+([A-Za-z0-9._:-]+)/gi)].map(m => m[1]);
        const childSessionKeys = [...rawCompletion.matchAll(/(?:childSessionKey|child_session_key)["'\s:=]+([A-Za-z0-9._:@/-]+)/gi)].map(m => m[1]);
        const sessionKeys = [...rawCompletion.matchAll(/(?:session_key)["'\s:=]+([A-Za-z0-9._:@/-]+)/gi)].map(m => m[1]);
        const runId = childRunIds.at(-1) || runIds.at(-1) || null;
        const sessionKey = childSessionKeys.at(-1) || sessionKeys.at(-1) || null;
        if ((runId || sessionKey) && !isRuntimeCompletionEnvelopeOnly(rawCompletion)) {
          workflowStore.completeTaskByRuntime(durableJob.job_id, {
            runId,
            sessionKey,
            content: rawCompletion,
            outcome: runtimeCompletionFailed(rawCompletion) ? 'failure' : 'success'
          });
        } else if (runId || sessionKey) {
          console.log(`[Adapter:Workflow] Ignoring completion envelope without child artifact job=${durableJob.job_id} run=${runId || '-'} session=${sessionKey || '-'}`);
        }
      }
    }
  }

  let prompt = '';

  // 1. OPENCLAW ROLES MUST BE HANDLED FIRST BY EXACT IDENTITY:
  if (agentRole === 'coordinator') {
    const conversationKey = workflowMetadata.job_id || workflowMetadata.jobId || conversationKeyFromMessages(messages);
    const job = workflowStore.getOrCreateJob({
      conversationKey,
      title: (() => {
        const u = [...(messages || [])].reverse().find(m => m?.role === 'user' && typeof m.content === 'string');
        return (u?.content || 'Boss request').replace(/^\[[^\]]+\]\s*/, '').trim().slice(0, 180) || 'Boss request';
      })()
    });
    const fsm = new CoordinatorSessionStateMachine();
    const turnStep = fsm.processTurn(messages, tools, {
      state: job.state,
      activeTask: job.active_task_id ? workflowStore.getJob(job.job_id)?.title : null
    });

    // Persist only safe pre-model transitions. Dispatch/completion are committed in extractToolCall,
    // after the model has produced the corresponding OpenClaw-native action.
    if (turnStep.action === Actions.GENERATE_PROPOSAL) {
      workflowStore.transition(job.job_id, States.PROPOSED);
      workflowStore.recordEvent(job.job_id, 'job.proposal_requested', { task: turnStep.activeTask || job.title }, turnStep.activeTask || job.title);
    } else if (turnStep.action === Actions.REFINE_PROPOSAL) {
      workflowStore.transition(job.job_id, States.DISCUSSING);
      workflowStore.recordEvent(job.job_id, 'job.proposal_refined', { task: turnStep.activeTask || job.title }, turnStep.activeTask || job.title);
    }

    let stageGuidance = '';
    if (turnStep.action === Actions.SILENT_ACK) {
      stageGuidance = `
TRẠNG THÁI HIỆN TẠI: BÁO CÁO TỔNG KẾT ĐÃ ĐƯỢC GỬI CHO BOSS TRƯỚC ĐÓ.
QUY TẮC BẮT BUỘC:
Trả lời DUY NHẤT một từ: NO_REPLY (OpenClaw sẽ tự động hủy việc gửi lặp tin nhắn thừa về WhatsApp của Boss).`;
    } else if (turnStep.action === Actions.GENERATE_PROPOSAL) {
      stageGuidance = `
TRẠNG THÁI HIỆN TẠI: TIẾP NHẬN YÊU CẦU MỚI TỪ BOSS -> ĐỀ XUẤT KẾ HOẠCH & THẢO LUẬN.
QUY TẮC BẮT BUỘC:
1. Bạn CHƯA ĐƯỢC PHÉP thực thi hay spawn subagent! Tuyệt đối không xuất JSON hay gọi sessions_spawn!
2. Hãy phản hồi Boss trên WhatsApp:
   - Xác nhận đã tiếp nhận yêu cầu.
   - Soạn Đề xuất Kế hoạch Hành động (Action Plan): Mục tiêu, Hướng giải quyết, Phân công (CTO kỹ thuật, Reviewer/QA nghiệm thu DoD).
   - Đặt câu hỏi xin ý kiến phê duyệt từ Boss: "Boss xem qua phương án này có duyệt để em chỉ đạo anh em triển khai không ạ?".
3. Xuất toàn bộ phản hồi dưới dạng văn bản thuần túy lịch sự, chuyên nghiệp.`;
      // broadcast suppressed
    } else if (turnStep.action === Actions.REFINE_PROPOSAL) {
      stageGuidance = `
TRẠNG THÁI HIỆN TẠI: ĐANG THẢO LUẬN / ĐIỀU CHỈNH KẾ HOẠCH VỚI BOSS.
QUY TẮC BẮT BUỘC:
1. Phản hồi thắc mắc, giải thích hoặc cập nhật kế hoạch theo ý kiến của Boss.
2. Tiếp tục xin ý kiến Boss xem đã duyệt kế hoạch sau điều chỉnh chưa.
3. TUYỆT ĐỐI KHÔNG xuất mã JSON gọi sessions_spawn!`;
    } else if (turnStep.action === Actions.DISPATCH_TASK) {
      const taskDescription = (turnStep.activeTask || fsm.activeTask || 'Yêu cầu từ Boss').replace(/"/g, '\\"');
      stageGuidance = `
TRẠNG THÁI HIỆN TẠI: BOSS ĐÃ PHÊ DUYỆT KẾ HOẠCH!
QUY TẮC BẮT BUỘC:
1. LẬP TỨC kích hoạt CTO qua OpenClaw native sessions_spawn. Adapter chỉ chuyển native tool call; không gọi CoS agents.
2. CTO là technical lead, KHÔNG phải universal worker. CTO phải phân rã task thành team nhỏ nhất cần thiết và spawn specialist phù hợp (architect, engineer, researcher, security, platform, qa, reviewer, writer).
3. Các task độc lập phải được CTO spawn mà không chờ nhau để OpenClaw chạy song song. Dependency thật mới chạy tuần tự.
4. OpenClaw quản lý completion/delivery; child agents báo cáo về parent. Không yêu cầu child tự báo cáo Boss.
5. Khi cần gọi công cụ, xuất đúng một JSON tool call mỗi lượt; CTO có thể tiếp tục các lượt sau để spawn các specialist còn lại.`;
    } else if (turnStep.action === Actions.REPORT_EXECUTIVE_SUMMARY) {
      stageGuidance = `
TRẠNG THÁI HIỆN TẠI: TIỂU BAN KỸ THUẬT ĐÃ HOÀN TẤT NHIỆM VỤ / BÁO CÁO KẾT QUẢ.
QUY TẮC BẮT BUỘC:
1. Tổng hợp bản Báo cáo Tổng kết (Executive Summary) súc tích, chuyên nghiệp gửi Boss trên WhatsApp:
   - Tóm tắt kết quả đo đạc/triển khai thực tế và các hành động đã thực hiện.
   - Đối chiếu các tiêu chí DoD.
2. BẮT BUỘC xuất khối JSON gọi công cụ 'message':
   {"name":"message","arguments":{"action":"send","channel":"whatsapp","target":"+84374877794","message":"<Nội dung Báo cáo Tổng kết>"}}
3. Tuyệt đối KHÔNG gọi sessions_spawn nữa!`;
    } else if (turnStep.action === Actions.REPORT_FAILURE) {
      stageGuidance = `
TRẠNG THÁI HIỆN TẠI: TIỂU BAN KỸ THUẬT BÁO SỰ CỐ / BLOCKER.
QUY TẮC BẮT BUỘC:
1. Báo cáo trung thực tình trạng sự cố cho Boss trên WhatsApp một cách lịch sự, dễ hiểu:
   Ví dụ: "Dạ thưa Boss, CTO và đội ngũ kỹ thuật báo cáo đang gặp vướng mắc: [nguyên nhân ngắn gọn]. Nhờ Boss cho hướng chỉ đạo tiếp theo ạ."
2. TUYỆT ĐỐI KHÔNG copy paste log nội bộ, không in ra JSON.
3. TUYỆT ĐỐI KHÔNG gọi sessions_spawn!`;
    }

      prompt = `[CHỈ DẪN HỆ THỐNG - CHIEF OF STAFF / COORDINATOR]
Bạn là ${agentName} (coordinator) - Cố vấn trưởng & Giám đốc Điều hành (Chief of Staff / COO), người cánh tay phải đắc lực trực tiếp nhận chỉ đạo từ Chủ tịch (Boss / Founder trên WhatsApp).
Các bộ phận chuyên môn dưới quyền: cto (kỹ thuật, code, bug, test, audit), architect (kiến trúc), engineer (mã nguồn), qa (kiểm thử), reviewer (nghiệm thu DoD), security, researcher, writer.
Runtime orchestration: OpenClaw native sessions_spawn. CoS chỉ cung cấp governance/policy; không spawn worker, không sở hữu session, không sở hữu delivery.
Durable business Job ID: ${job.job_id}. Business state is stored durably in SQLite at ${WORKFLOW_DB_PATH}; OpenClaw session/run IDs are runtime references only.

${stageGuidance}

Khi không gọi công cụ: Trả lời trực tiếp bằng tiếng Việt chuyên nghiệp, không kèm mã JSON rác.
Khi cần gọi công cụ: BẮT BUỘC chỉ xuất ĐÚNG MỘT khối JSON: {"name":"...","arguments":{...}}.\n\n`;
  } else if (agentRole === 'cto') {
    prompt = `[CHỈ DẪN HỆ THỐNG - CTO / LEAD ENGINEER]
Bạn là ${agentName} (cto) - nhóm trưởng kỹ thuật phụ trách hệ thống và mã nguồn.
Môi trường làm việc: Máy chủ Ubuntu Linux (thư mục mặc định: /home/long).
Công cụ khả dụng để thao tác trên máy tính:
- exec: Thực thi lệnh bash, shell, npm, git, node, công cụ hệ thống (free, ps, top, systemctl, df...) trực tiếp trên máy tính.
  Cú pháp JSON BẮT BUỘC:
  {"name": "exec", "arguments": {"command": "lệnh cần chạy"}}
- debate: Kích hoạt plugin Socratic Debate Engine nội bộ (Zero-Tunnel) để khởi tạo/tham gia phiên tranh biện.
  Cú pháp JSON:
  {"name": "debate", "arguments": {"action": "run-cycle", "topic": "chủ đề cần debate"}}
- read, write, edit: Thao tác đọc và sửa đổi file mã nguồn.
- Slack: KHÔNG phải control plane và KHÔNG phải tool điều phối. Progress được adapter tự động project từ SQLite durable event log.
- sessions_spawn: chỉ dùng OpenClaw native để phân công cấp dưới khi Coordinator đã được Boss phê duyệt. Completion quay về parent.
  Wire schema: {"name":"sessions_spawn","arguments":{"agentId":"architect|engineer|qa|security|platform|researcher|reviewer|writer","task":"full concrete task"}}

QUY TẮC BẮT BUỘC & PHÒNG CHỐNG ẢO GIÁC SHELL:
1. Bạn ĐANG CÓ công cụ 'exec' và 'debate' để thực thi trực tiếp trên máy chủ Linux. TUYỆT ĐỐI KHÔNG NÓI thiếu terminal hay công cụ!
2. Máy chủ CÓ đầy đủ thư mục /home/long và mã nguồn. KHÔNG BAO GIỜ chạy lệnh 'cd' trần trụi. Lệnh 'cd /path' thành công theo chuẩn POSIX sẽ không có output (no output), TUYỆT ĐỐI KHÔNG SUY DIỄN rằng thư mục không tồn tại!
3. Mọi lệnh cần chạy phải dùng đường dẫn tuyệt đối hoặc chuỗi lệnh có output:
   - Chạy debate cycle: node /home/long/work/chatgpt-adapter/debate-engine.js run-cycle "<topic>"
   - Chạy vitest: cd /home/long/work/chat-on-steroids-debate && npx vitest run test/debate-plugin.test.ts
4. Nếu nghi ngờ thư mục tồn tại hay không, BẮT BUỘC dùng 'ls -la <path>' để xác minh thực tế, KHÔNG ĐƯỢC suy đoán!
5. Tuyệt đối KHÔNG báo cáo BLOCKED hay thất bại khi bản thân chưa hề chạy lệnh thực tế!
6. Phối hợp với Architect, Engineer, QA, Reviewer bằng OpenClaw/session protocol và durable Job state; KHÔNG dùng Slack để điều phối.
7. Sau khi có kết quả thực thi lệnh, phân tích số liệu thực tế rõ ràng và báo cáo kết quả hoàn chỉnh.
8. Adapter này là lớp serialization giữa ChatGPT Web và OpenClaw. Khi cần delegation, JSON dưới đây KHÔNG phải giả lập hay mô tả tool; nó là wire-format chính thức mà adapter sẽ chuyển nguyên vẹn thành OpenClaw native tool call:
   {"name":"sessions_spawn","arguments":{"agentId":"architect|engineer|qa|security|platform|researcher|reviewer|writer","task":"full concrete task"}}
   Vì vậy không được trả lời rằng sessions_spawn không được expose, không khả dụng, hoặc không thể gọi. Không thêm markdown, prose, code fence hay field khác.
9. Mỗi lượt chỉ một tool call. Spawn task độc lập bằng các lượt liên tiếp, không chờ dependency không cần thiết.
10. Không được nói "đã spawn" nếu chưa phát hành JSON tool call tương ứng.\n\n`;
    if (directEngineeringJob) {
      const approved = [States.APPROVED, States.EXECUTING].includes(directEngineeringJob.state);
      prompt += approved
        ? `\nDurable Engineering M4 Job ${directEngineeringJob.job_id} is approved. LangGraph is the sole workflow controller. Do NOT call sessions_spawn, agents_wait, or orchestrate children from CTO. Wait for native controller/runtime instructions.\n`
        : `\nDurable Engineering M4 Job ${directEngineeringJob.job_id} is in PROPOSED phase. This turn is proposal-only. Do NOT call sessions_spawn, agents_wait, exec, or mutate workflow state. Return the proposed Engineering M4 DAG and ask for approval.\n`;
    }
    const ctoJobId = workflowStore.findJobIdFromMessages(messages);
    const ctoJob = ctoJobId ? workflowStore.getJob(ctoJobId) : null;
    const ctoTask = ctoJob?.active_task_id ? workflowStore.getTask(ctoJob.active_task_id) : null;
    if (ctoJob?.job_id && !directEngineeringJob) {
      prompt += 'Durable business Job ID: ' + ctoJob.job_id + ';';
      if (ctoTask?.description) {
        const children = workflowStore.getJobTrace(ctoJob.job_id)?.tasks?.filter(t => t.parent_task_id === ctoTask.task_id) || [];
        const requiredRoles = ProductionRoles;
        const missingRoles = requiredRoles.filter(role => !children.some(t => String(t.role).toLowerCase() === role));
        const failedChildren = children.filter(t => ['failed', 'timeout'].includes(String(t.status).toLowerCase()));
        const openChildren = children.filter(t => !['completed', 'failed', 'cancelled'].includes(String(t.status).toLowerCase()));
        const waitRunIds = children.map(t => t.openclaw_run_id).filter(Boolean);
        if (failedChildren.length) {
          const child = failedChildren[0];
          prompt = '[OPENCLAW CHILD RETRY TURN]\n'
            + 'Role: CTO / technical lead.\n'
            + 'A required child run failed/timed out. Do NOT spawn a replacement child. Continue the SAME existing child session with sessions_send and rerun its exact original command now.\n'
            + 'Emit exactly one JSON object: {"name":"sessions_send","arguments":{"sessionKey":"' + child.openclaw_session_key + '","message":"Retry execution NOW. Run the exact original command immediately. Return exact command, stdout/stderr, and exit status only.","timeoutSeconds":0}}\n'
            + 'Do not report success until the retry produces actual command evidence.\n'
            + 'Durable Job ID: ' + ctoJob.job_id;
        } else if (missingRoles.length) {
          prompt = '[OPENCLAW NATIVE DELEGATION TURN]\n'
            + 'Role: CTO / technical lead.\n'
            + 'This response is parsed directly by the OpenClaw adapter as a native tool call.\n'
            + 'Do NOT discuss tool availability. Do NOT say blocked. Do NOT execute specialist work yourself.\n'
            + 'Emit exactly ONE JSON object and nothing else.\n'
            + 'Schema: {"name":"sessions_spawn","arguments":{"agentId":"architect|engineer|qa|security|platform|researcher|reviewer|writer","task":"full concrete task"}}\n'
            + 'Spawn only the missing required specialist role(s): ' + missingRoles.join(', ') + '.\n'
            + 'Child task is EXECUTION NOW. Never copy parent proposal-phase instructions.\n'
            + 'For this verification, each required child must receive the exact command and run it immediately, then return factual evidence.\n'
            + 'Durable Job ID: ' + ctoJob.job_id + '\n'
            + 'Durable CTO task: ' + ctoTask.description;
        } else if (openChildren.length) {
          prompt = '[OPENCLAW CHILD WAIT TURN]\n'
            + 'Role: CTO / technical lead.\n'
            + 'Required Architect and QA child tasks already exist. Do NOT spawn duplicates. Do NOT report success/failure yet.\n'
            + 'Review child completion data as evidence only. If required child work remains active, wait for its completion event.\n'
            + 'BẮT BUỘC gọi native agents_wait, không gọi sessions_yield. Emit exactly one native tool call with ALL known child run IDs: {"name":"agents_wait","arguments":{"ids":[' + waitRunIds.map(id => JSON.stringify(id)).join(',') + '],"timeoutSeconds":300}}.\n'
            + 'Do not substitute prose-only success for child completion.\n'
            + 'Durable Job ID: ' + ctoJob.job_id;
        } else {
          prompt = '[OPENCLAW CTO SYNTHESIS TURN]\n'
            + 'Role: CTO / technical lead.\n'
            + 'Both required child tasks are terminal. Do NOT spawn again.\n'
            + 'Synthesize only actual child results, including exact commands, outputs, and exit statuses.\n'
            + 'If any child failed or timed out, do not claim success; report the factual failure.\n'
            + 'The child evidence below is authoritative runtime data. Quote its factual command/output/exit-status fields in your synthesis; do not replace them with a generic statement that evidence is missing.\n'
            + 'CHILD RUNTIME EVIDENCE:\n'
            + (() => {
              const trace = workflowStore.getJobTrace(ctoJob.job_id);
              const childTasks = (trace?.tasks || []).filter(t => t.parent_task_id === ctoTask.task_id);
              const byTask = new Map((trace?.results || []).map(r => [r.task_id, r]));
              return childTasks.map(t => {
                const r = byTask.get(t.task_id);
                return `ROLE=${t.role} TASK=${t.task_id} STATUS=${t.status}\nRESULT:\n${String(r?.content || '(no durable result)').slice(0, 12000)}`;
              }).join('\n\n');
            })() + '\n'
            + 'Return the synthesis for durable Job completion.\n'
            + 'Durable Job ID: ' + ctoJob.job_id;
        }
      }
    }
  } else if (agentRole === 'engineer') {
    prompt = `[CHỈ DẪN HỆ THỐNG - SENIOR SOFTWARE ENGINEER]
Bạn là ${agentName} (engineer) - kỹ sư phần mềm chủ lực.
Môi trường làm việc: Máy chủ Ubuntu Linux (thư mục mặc định: /home/long).
Công cụ khả dụng: exec (chạy lệnh bash, npm, git, test), read (đọc file), write, edit (sửa file). Slack progress do adapter project tự động.
Quy tắc:
1) Kiểm tra kỹ mã nguồn và kiến trúc trước khi thay đổi file.
2) Dùng công cụ 'exec' để chạy test suite và build trên máy thật.
3) Hoàn tất + test PASS: bàn giao QA/Reviewer nghiệm thu kèm bằng chứng rõ ràng.
Khi cần gọi công cụ, BẮT BUỘC chỉ xuất ĐÚNG MỘT khối JSON không kèm lời thừa: {"name":"...","arguments":{...}}.\n\n`;
  } else if (agentRole === 'architect') {
    prompt = `[CHỈ DẪN HỆ THỐNG - SOLUTION ARCHITECT]
Bạn là ${agentName} (architect) - kiến trúc sư giải pháp.
      Công cụ khả dụng: read, exec, sessions_spawn (OpenClaw native). Slack progress do adapter project tự động. Completion phải quay về parent; không tự gửi báo cáo Boss.
Nhiệm vụ: Thiết kế giải pháp kiến trúc tinh gọn, định nghĩa rõ ràng boundaries, contracts (APIs/Schemas/Events).
      Nếu task từ parent là execution task có command cụ thể, BẮT BUỘC dùng OpenClaw native exec ngay trong turn đầu, đúng một lần, với exact command byte-for-byte từ parent. Không đổi sang ~/, relative path, batch-shaped arguments, hoặc command tương đương. Sau khi nhận tool result, KHÔNG gọi lại cùng command; trả factual result chứa exact command, stdout/stderr và exit status. Không suy diễn, không mô phỏng kết quả.
Sau khi nhận tool result, trả đúng một factual sentence theo yêu cầu parent.\n\n`;
  } else if (agentRole === 'reviewer') {
    prompt = `[CHỈ DẪN HỆ THỐNG - REVIEWER / QA LEAD]
Bạn là ${agentName} (reviewer) - nhóm trưởng QA, nghiệm thu độc lập công việc của CTO/Engineer theo 4 cổng DoD trước khi báo Chủ tịch.
Môi trường làm việc: Máy chủ Ubuntu Linux (thư mục mặc định: /home/long).
Công cụ KHÔNG dùng để điều phối hoặc tự quyết execution. Reviewer chỉ đọc durable requirements, architecture và actual ExecutionManager evidence được cung cấp trong task context.
Không tự spawn, không retry, không dùng agents_wait, không tự chạy command thay ExecutionManager.
Trả đúng một JSON artifact, không markdown, schema:
{"review":{"requirementsSatisfied":true,"architectureConformant":true,"implementationIssues":[],"evidenceIssues":[],"blockingIssues":[]}}
Chỉ đặt requirementsSatisfied=true khi evidence thực tế đủ; không suy diễn từ prose hoặc task status.\n\n`;
  } else if (agentRole === 'qa') {
    prompt = `[CHỈ DẪN HỆ THỐNG - QA ENGINEER]
Bạn là ${agentName} (qa) - kỹ sư kiểm thử chất lượng hành vi (Gate Q).
Môi trường làm việc: Máy chủ Ubuntu Linux (thư mục mặc định: /home/long).
      Công cụ: exec (chạy command trên máy thật), read (đọc file), Slack progress do adapter project tự động.
Nhiệm vụ: Độc lập kiểm tra hành vi hệ thống theo Acceptance Criteria. Cung cấp bằng chứng kiểm thử (test evidence) xác thực bằng 'exec'.
      Nếu task từ parent là execution task có command cụ thể, BẮT BUỘC dùng OpenClaw native exec ngay trong turn đầu, đúng một lần, với exact command byte-for-byte từ parent. Không đổi sang ~/, relative path, batch-shaped arguments, hoặc command tương đương. Sau khi nhận tool result, KHÔNG gọi lại cùng command; trả factual result chứa exact command, stdout/stderr và exit status. Không suy diễn, không mô phỏng kết quả.
Sau khi nhận tool result, trả đúng một factual sentence theo yêu cầu parent.\n\n`;
  } else if (agentRole === 'platform') {
    prompt = `[CHỈ DẪN HỆ THỐNG - PLATFORM / DEVOPS ENGINEER]
Bạn là ${agentName} (platform) - kỹ sư nền tảng & DevOps.
Công cụ: exec (CI/CD, kiểm tra tiến trình, service health, build scripts, deploy automation), Slack progress do adapter project tự động.
Nhiệm vụ: Duy trì hạ tầng bàn giao ổn định, tự động hóa pipeline, thiết lập giám sát observability và kịch bản rollback khôi phục sự cố.
Khi cần gọi công cụ, BẮT BUỘC chỉ xuất ĐÚNG MỘT khối JSON không kèm lời thừa: {"name":"...","arguments":{...}}.\n\n`;
  } else if (agentRole === 'security') {
    prompt = `[CHỈ DẪN HỆ THỐNG - SECURITY ENGINEER]
Bạn là ${agentName} (security) - kỹ sư an ninh hệ thống (Gate S).
Công cụ: exec (quét mã nguồn, audit dependencies/CVE), read, Slack progress do adapter project tự động.
Nhiệm vụ: Threat modeling, rà soát bí mật/tokens, bảo vệ chuỗi cung ứng mã nguồn, đánh giá rủi ro và đề xuất giải pháp vá lỗi bảo mật cụ thể.
Khi cần gọi công cụ, BẮT BUỘC chỉ xuất ĐÚNG MỘT khối JSON không kèm lời thừa: {"name":"...","arguments":{...}}.\n\n`;
  } else if (agentRole === 'product-owner') {
    prompt = `[CHỈ DẪN HỆ THỐNG - PRODUCT OWNER]
Bạn là ${agentName} (product-owner) - giám đốc sản phẩm.
Công cụ: sessions_spawn (OpenClaw native). Slack progress do adapter project tự động. Completion phải quay về parent.
Nhiệm vụ: Xác định bài toán cốt lõi, phạm vi nghiệp vụ, phân rã backlog và thiết lập Acceptance Criteria rõ ràng cho từng tính năng.
Khi cần gọi công cụ, BẮT BUỘC chỉ xuất ĐÚNG MỘT khối JSON không kèm lời thừa: {"name":"...","arguments":{...}}.\n\n`;
  } else if (agentRole === 'researcher') {
    prompt = `[CHỈ DẪN HỆ THỐNG - RESEARCHER]
Bạn là ${agentName} (Mã vai trò: researcher) trong bộ máy điều hành của Chủ tịch.
Nhiệm vụ: Thu thập thông tin, nghiên cứu thị trường/công nghệ, so sánh các giải pháp và đưa ra bản tóm tắt có căn cứ, số liệu rõ ràng.\n\n`;
  } else if (agentRole === 'writer') {
    prompt = `[CHỈ DẪN HỆ THỐNG - WRITER]
Bạn là ${agentName} (Mã vai trò: writer) trong bộ máy điều hành của Chủ tịch.
Nhiệm vụ: Soạn thảo văn bản, tài liệu, bài viết, thông điệp truyền thông chỉn chu, đúng văn phong và đối tượng mục tiêu.\n\n`;
  } else if (isCodingOrDsh) {
    const compactToolNames = toolNamesList.filter(Boolean);
    prompt = `[CHỈ DẪN HỆ THỐNG - CODING AGENT / DEEPSEEK HARNESS]
Bạn là kỹ sư phần mềm chuyên nghiệp sử dụng công cụ để giải quyết nhiệm vụ lập trình trên máy tính.
Công cụ khả dụng: ${compactToolNames.join(', ')}

QUY TẮC SỬ DỤNG CÔNG CỤ:
1. Khi cần gọi công cụ: BẮT BUỘC chỉ trả về DUY NHẤT một khối JSON theo đúng định dạng:
{"name": "<tên_công_cụ>", "arguments": { ... }}
Tuyệt đối không kèm theo lời chào hay giải thích trước/sau JSON.
2. Khi không cần gọi công cụ hoặc khi đã có kết quả: Hãy trả lời trực tiếp nội dung kết quả cho người dùng.\n\n`;
  } else {
    prompt = `[CHỈ DẪN HỆ THỐNG]
Bạn là ${agentName} (Mã vai trò: ${agentRole}) trong bộ máy điều hành của Chủ tịch.
Nhiệm vụ: Giải quyết yêu cầu của Chủ tịch nhanh chóng, chính xác, chuyên nghiệp.\n\n`;
  }

  function getMsgText(c) {
    if (!c) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(item => typeof item === 'string' ? item : (item.text || '')).join('\n');
    }
    return JSON.stringify(c);
  }

  const chatMessages = messages.filter(m => m.role !== 'system');

  // Filter out hallucinated tool refusal messages from assistant history so they do not poison future turns
  const filteredMessages = chatMessages.filter(m => {
    if (m.role === 'assistant') {
      const txt = getMsgText(m.content);
      if (
        txt.includes('không thể phát hành lệnh spawn') ||
        txt.includes('lệnh spawn giả') ||
        txt.includes('sử_ re_o_') ||
        txt.includes('[ChatGPT Bridge]')
      ) {
        return false;
      }
    }
    return true;
  });

  // =========================================================================
  // OPENCLAW TURN HORIZON & PENDING SUFFIX ARCHITECTURE
  // =========================================================================
  // In OpenClaw, the conversation transcript is append-only.
  // 1. Any message before the last assistant turn is SETTLED HISTORY.
  // 2. Only events occurring AFTER the last assistant turn are ACTIVE / PENDING.
  // 3. If the user sent a new message, that new message is the SOLE active task.
  //    Past subagent completions that already had an assistant response must NEVER
  //    hijack a new turn from the user!
  // =========================================================================

  let lastAssistantIdx = -1;
  for (let i = filteredMessages.length - 1; i >= 0; i--) {
    if (filteredMessages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  let lastUserMsgIndex = -1;
  let activeUserTask = '';
  let subagentCompletionSummary = '';

  // Step 1: Check pending messages (after last assistant turn)
  const pendingTurns = lastAssistantIdx !== -1 
    ? filteredMessages.slice(lastAssistantIdx + 1) 
    : filteredMessages;

  for (let i = pendingTurns.length - 1; i >= 0; i--) {
    const m = pendingTurns[i];
    const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    const isSubagentContext = raw.includes('[Subagent Context]');
    const isInternalCompletion = raw.includes('[Internal task completion event]') ||
      raw.includes('A background task completed') ||
      raw.includes('Child completion results') ||
      raw.includes('Child results awaiting delivery');
    const cleaned = cleanMessageContent(m.content);

    if (m.role === 'user') {
      if (isSubagentContext) {
        const taskMatch = raw.match(/\[Subagent Task\]([\s\S]*?)(?=(Begin\.|Runtime:|$))/i);
        activeUserTask = taskMatch ? taskMatch[1].trim() : (cleaned || raw);
        lastUserMsgIndex = filteredMessages.indexOf(m);
        break;
      }

      if (isInternalCompletion) {
        if (!subagentCompletionSummary) {
          const match = raw.match(/Child result[^:]*:\s*<prompt-data>([\s\S]*?)<\/prompt-data>/i) ||
            raw.match(/status:\s*(?:completed|ok)[\s\S]*?<prompt-data>([\s\S]*?)<\/prompt-data>/i) ||
            raw.match(/<prompt-data>([\s\S]*?)<\/prompt-data>/i);
          if (match) {
            subagentCompletionSummary = match[1].trim();
          } else {
            subagentCompletionSummary = cleaned.slice(0, 500);
          }
          if (subagentCompletionSummary.length > 1500) {
            subagentCompletionSummary = subagentCompletionSummary.slice(0, 800) + "\n... [ket qua rut gon] ...\n" + subagentCompletionSummary.slice(-500);
          }
        }
        continue;
      }

      if (cleaned.length > 0 && !activeUserTask) {
        activeUserTask = cleaned;
        lastUserMsgIndex = filteredMessages.indexOf(m);
      }
    }
  }

  // Step 2: Fallback if activeUserTask not found in pending turns (e.g. initial turn or continuation)
  if (!activeUserTask && !subagentCompletionSummary) {
    for (let i = filteredMessages.length - 1; i >= 0; i--) {
      if (filteredMessages[i].role === 'user') {
        const raw = typeof filteredMessages[i].content === 'string' ? filteredMessages[i].content : JSON.stringify(filteredMessages[i].content || '');
        const isInternalCompletion = raw.includes('[Internal task completion event]') ||
          raw.includes('A background task completed') ||
          raw.includes('Child completion results') ||
          raw.includes('Child results awaiting delivery');
        if (!isInternalCompletion) {
          const cleaned = cleanMessageContent(filteredMessages[i].content);
          if (cleaned.length > 0) {
            activeUserTask = cleaned;
            lastUserMsgIndex = i;
            break;
          }
        }
      }
    }
  }

  // OpenClaw child sessions can receive the parent sessions_spawn call as the
  // active task context instead of a normal user message. Recover that exact
  // task so the CTO does not see an empty "Hãy trả lời hoặc thực hiện ngay:" turn.
  if (!activeUserTask && agentRole === 'cto') {
    for (let i = filteredMessages.length - 1; i >= 0; i--) {
      const m = filteredMessages[i];
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (let j = m.tool_calls.length - 1; j >= 0; j--) {
        const call = m.tool_calls[j];
        const name = call.function?.name || call.name;
        if (name !== 'sessions_spawn') continue;
        try {
          const args = typeof call.function?.arguments === 'string'
            ? JSON.parse(call.function.arguments)
            : (call.function?.arguments || call.arguments || {});
          if (args.agentId === 'cto' && typeof args.task === 'string' && args.task.trim()) {
            activeUserTask = args.task.trim();
            break;
          }
        } catch {}
      }
      if (activeUserTask) break;
    }
  }

  if (!activeUserTask && agentRole === 'cto') {
    const serializedTurn = JSON.stringify(messages || []);
    const jobMatch = serializedTurn.match(/Durable Job ID[^A-Za-z0-9_-]*([A-Za-z0-9_-]+)/i);
    if (jobMatch) {
      const durableJob = workflowStore.getJob(jobMatch[1]);
      const task = durableJob?.active_task_id ? workflowStore.getTask(durableJob.active_task_id) : null;
      if (task?.description) activeUserTask = task.description;
    }
  }

  // Circuit Breaker detection: ONLY count autonomous subagent loops occurring AFTER the last human message!
  let subagentRunCount = 0;
  let hasSubagentFailure = false;
  if (lastUserMsgIndex !== -1 && Array.isArray(messages)) {
    for (let i = lastUserMsgIndex + 1; i < messages.length; i++) {
      const m = messages[i];
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (raw.includes('[Subagent Context]') || raw.includes('Child results awaiting delivery') || raw.includes('Child completion results')) {
        subagentRunCount++;
      }
      if (raw.includes('Timeout waiting for ChatGPT response') || raw.includes('rate_limit_hard_block') || raw.includes('Rate Limit') || raw.includes('Forbidden - agentId is not allowed')) {
        hasSubagentFailure = true;
      }
      if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.some(tc => (tc.function?.name || tc.name) === 'sessions_spawn')) {
        subagentRunCount++;
      }
    }
  }
  const isCircuitBreakerTripped = (subagentRunCount >= 3) || hasSubagentFailure;

  // If there is a subagent completion summary, it ALWAYS takes priority as the active task/context for this turn:
  if (subagentCompletionSummary) {
    if (isCircuitBreakerTripped) {
      activeUserTask = `[CẢNH BÁO CIRCUIT BREAKER - DỪNG TỰ ĐỘNG SPAWN]:
Tiểu ban kỹ thuật đã chạy ${subagentRunCount} lượt hoặc phát hiện sự cố (Timeout/Rate Limit/Lỗi).
Nội dung ghi nhận: ${subagentCompletionSummary.slice(0, 500)}
YÊU CẦU:
1. TUYỆT ĐỐI KHÔNG gọi sessions_spawn nữa (bảo vệ quota, tránh vòng lặp vô tận).
2. Hãy lập tức tổng hợp kết quả, báo cáo tình hình cụ thể gửi Chủ tịch trên WhatsApp (+84374877794) và Slack War Room (C0C3RJKNKPG), xin ý kiến chỉ đạo trực tiếp từ Boss.`;
    } else {
      activeUserTask = `[BÁO CÁO KẾT QUẢ THỰC TẾ TỪ TIỂU BAN KỸ THUẬT / SUBAGENT]:
${subagentCompletionSummary}

YÊU CẦU BẮT BUỘC CHO CHIEF OF STAFF:
1. Bạn ĐÃ NHẬN ĐƯỢC TOÀN BỘ KẾT QUẢ THỰC TẾ ở trên từ CTO. Hãy lập tức tổng hợp bản Báo cáo Nghiệm thu hoàn chỉnh (Executive Summary) gửi Boss trên WhatsApp và Slack War Room (C0C3RJKNKPG).
2. Trình bày chi tiết, chuyên nghiệp theo cấu trúc:
   - Mục tiêu & chủ đề đã thực hiện.
   - Luồng dữ liệu thực tế (Trace Data Flow): Input -> Plugin -> Xử lý tranh biện -> Output.
   - Kết quả đo đạc thực tế (Vitest tests, số lượt tranh biện, bằng chứng cụ thể).
   - Đánh giá lỗi/vấn đề kỹ thuật (nếu có).
   - Nghiệm thu đối chiếu DoD.
3. BẮT BUỘC dùng công cụ 'message' gửi bản Báo cáo Nghiệm thu hoàn chỉnh này tới Boss trên WhatsApp (+84374877794) và Slack War Room (C0C3RJKNKPG). TUYỆT ĐỐI KHÔNG gọi sessions_spawn nữa (task đã hoàn tất, không lặp lại)!`;
    }
  }

  // History messages before the last user message (keep up to 2 turns for context)
  const historyMessages = lastUserMsgIndex > 0 
    ? filteredMessages.slice(Math.max(0, lastUserMsgIndex - 2), lastUserMsgIndex) 
    : [];

  for (const m of historyMessages) {
    if (m.role === 'user') {
      const content = cleanMessageContent(m.content);
      if (content) {
        prompt += `Người dùng trước: ${content.slice(0, 400)}\n\n`;
      }
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        // Skip raw sessions_spawn tool calls in prompt history if we are in a fresh turn
        const nonSpawnCalls = m.tool_calls.filter(call => (call.function?.name || call.name) !== 'sessions_spawn');
        for (const call of nonSpawnCalls) {
          const callArgs = (call.function?.arguments || '{}').slice(0, 200);
          prompt += `Trợ lý: [Đã gọi công cụ: ${call.function?.name || 'tool'} với tham số: ${callArgs}]\n\n`;
        }
      } else if (m.content) {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        prompt += `Trợ lý: ${content.slice(0, 400)}\n\n`;
      }
    } else if (m.role === 'tool') {
      // Skip raw sessions_spawn status: accepted results which mislead ChatGPT into thinking CTO is still in-flight
      if ((m.name === 'sessions_spawn' || m.tool_name === 'sessions_spawn')) {
        continue;
      }
      let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (content.includes('childSessionKey') || content.includes('expectsCompletionMessage')) {
        continue;
      }
      if (content.length > 600) {
        content = content.slice(0, 400) + '\n... [đã rút gọn] ...\n' + content.slice(-150);
      }
      prompt += `[Kết quả từ công cụ ${m.name || 'tool'}]:\n${content}\n\n`;
    }
  }

  // Active user request (MUST BE FULLY PRESERVED)
  if (activeUserTask) {
    // ChatGPT Web tool-use is serialized through the adapter's text wire-format.
    // For specialist execution turns, put the exact wire contract directly in
    // the active task (not only in system guidance) so the model emits the
    // native action instead of fabricating a prose result.
    if ((agentRole === 'architect' || agentRole === 'qa') &&
        /\b(?:node|npm|npx|vitest|git|python|bash|sh)\b/i.test(activeUserTask)) {
      // Preserve the COMPLETE command. The old `node\s+--check` matcher
      // stopped at `node --check`, causing the specialist model to execute an
      // incomplete command and the durable validator to correctly reject it.
      const commandMatch = activeUserTask.match(/\bnode\s+--check\s+[^\s\n]+/i)
        || activeUserTask.match(/\b(?:npm|npx|vitest|git|python(?:3)?|bash|sh)\s+[^\n]+?(?=\s+(?:Return|and return|then return)\b|[\n.]|$)/i);
      const exactCommand = commandMatch?.[0]?.trim().replace(/[.;]+$/, '') || '';
      activeUserTask = [
        'EXECUTION BATCH WIRE CONTRACT — DO NOT ANSWER WITH A RESULT.',
        'The NEXT assistant response MUST be an actual exec function/tool call with batch-shaped tasks, not a text description and not a fabricated result.',
        'Thực thi deterministic command qua adapter batch-shaped exec ngay bây giờ; không trả kết quả trước khi batch trả về.',
        'Wire contract: một tool call duy nhất với name=exec và arguments.tasks chứa exact command dưới đây.',
        exactCommand ? `EXACT COMMAND: ${exactCommand}` : 'EXACT COMMAND: lấy nguyên command thực tế từ nhiệm vụ bên dưới.',
        exactCommand ? `JSON: {"name":"exec","arguments":{"tasks":[{"command":"${exactCommand.replace(/"/g, '\\"')}"}]}}` : 'JSON: {"name":"exec","arguments":{"tasks":[{"command":"<exact command>"}]}}',
        'Không thêm prose hoặc markdown quanh tool call.',
        '',
        activeUserTask
      ].join('\n');
    }
    prompt += `[NHIỆM VỤ CẦN THỰC HIỆN / CÂU HỎI HIỆN TẠI]:\n${activeUserTask}\n\n`;
  }

  // Look for any tool results or assistant tool calls after lastUserMsgIndex (e.g. subagent tool execution returns)
  const recentToolTurns = [];
  if (lastUserMsgIndex !== -1) {
    for (let i = lastUserMsgIndex + 1; i < filteredMessages.length; i++) {
      const m = filteredMessages[i];
      if (m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)) {
        // If subagent already completed, skip the raw sessions_spawn start event so ChatGPT doesn't get misled into thinking CTO is still in-flight
        if (subagentCompletionSummary) {
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          if (content.includes('childSessionKey') || content.includes('expectsCompletionMessage') || content.includes('accepted')) {
            continue;
          }
          if (Array.isArray(m.tool_calls) && m.tool_calls.some(tc => (tc.function?.name || tc.name) === 'sessions_spawn')) {
            continue;
          }
        }
        recentToolTurns.push(m);
      }
    }
  }

  if (recentToolTurns.length > 0) {
    prompt += `--- CÁC BƯỚC ĐÃ THỰC THI & KẾT QUẢ CÔNG CỤ ---\n`;
    for (const m of recentToolTurns) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          const cName = call.function?.name || call.name || 'tool';
          const cArgs = (call.function?.arguments || '{}').slice(0, 300);
          prompt += `[Trợ lý đã gọi công cụ]: ${cName} với tham số: ${cArgs}\n\n`;
        }
      } else if (m.role === 'tool') {
        let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        if (content.length > 1500) {
          content = content.slice(0, 1000) + '\n... [đã rút gọn] ...\n' + content.slice(-400);
        }
        prompt += `[KẾT QUẢ THỰC THI CÔNG CỤ ${m.name || 'tool'}]:\n${content}\n\n`;
      }
    }
    prompt += `[CHỈ DẪN TIẾP THEO]:\nĐã nhận kết quả thực tế từ công cụ ở trên. Hãy dựa vào kết quả này để phân tích, kết luận và hoàn tất báo cáo (hoặc gọi công cụ tiếp theo nếu cần):\n`;
  } else {
    prompt += `Hãy trả lời hoặc thực hiện ngay:`;
  }

  // Safety cap to avoid overloading #prompt-textarea (max ~3500 chars)
  // Ensure system guidance (head) AND the active task (tail) are preserved!
  let finalPrompt = prompt.trim();
  if (finalPrompt.length > 3500) {
    finalPrompt = finalPrompt.slice(0, 1200) + '\n... [Đã lược bớt ngữ cảnh cũ] ...\n' + finalPrompt.slice(-2000);
  }

  return {
    prompt: finalPrompt,
    agentRole,
    agentName
  };
}

export function toolsForSpecialistPrompt(tools = [], agentRole = '') {
  if (!Array.isArray(tools)) return [];
  if (!ProductionRoles.includes(String(agentRole || '').toLowerCase())) return tools;
  return tools.filter(t => (t.function?.name || t.name) !== 'exec');
}

export function extractToolCall(text, tools = [], messages = [], targetRole = 'coordinator', deliveryMetadata = {}) {
  if (!text || typeof text !== 'string') return null;

  let toolName = null;
  let toolArgs = null;
  let matchedJsonString = null;
  const isCoordinator = (targetRole === 'coordinator');
  const langGraphDecision = deliveryMetadata?.langGraphDecision || null;

  // M4 approval is sent through the native CTO session. The Coordinator role
  // is not part of the durable workflow, so approval must be correlated here
  // without turning CTO into a workflow controller. Only an explicit Job id
  // plus the narrow approval command may perform this durable transition.
  if (!isCoordinator && targetRole === 'cto') {
    const latestUserText = [...(messages || [])].reverse()
      .find(m => m?.role === 'user' && typeof m.content === 'string')?.content?.trim() || '';
    const approvalJobId = latestUserText.match(/job_[0-9a-f-]{20,}/i)?.[0] || null;
    const approvalText = latestUserText.replace(/^\[[^\]]+\]\s*/, '').trim();
    const explicitApproval = /^Duyệt\s+Job\s+job_[0-9a-f-]{20,}(?:[.,!\s].*)?$/i.test(approvalText);
    if (approvalJobId && explicitApproval) {
      const candidate = workflowStore.getJob(approvalJobId);
      const conversationKey = conversationKeyFromMessages(messages);
      if (candidate?.state === States.PROPOSED && candidate.conversation_key === conversationKey) {
        workflowStore.approve(candidate.job_id, approvalText, 'boss');
        console.log(`[Adapter:ApprovalCorrelation] Native CTO approval matched PROPOSED Job ${candidate.job_id}.`);
      }
    }
  }

  // Active POC gate: LangGraph may block a CTO turn that attempts to advance
  // an executing Production E2E job while required children are still open or
  // lack actual evidence. It never creates sessions and never mutates SQLite.
  if (
    LANGGRAPH_ORCHESTRATOR_MODE === 'active' &&
    targetRole === 'cto' &&
    langGraphDecision &&
    [LangGraphActions.WAIT_CHILDREN, LangGraphActions.BLOCK].includes(langGraphDecision.action)
  ) {
    console.warn(`[Adapter:LangGraphGate] Blocked CTO advancement: action=${langGraphDecision.action} reason=${langGraphDecision.reason}`);
    return null;
  }

  // Child completion events are delivered to the CTO parent session first.
  // Reconcile those runtime refs here, before Coordinator later consumes the
  // synthesized completion. This keeps child success/failure durable.
  if (!isCoordinator) {
    const referencedJobId = workflowStore.findJobIdFromMessages(messages);
    const durableJob = referencedJobId
      ? workflowStore.getJob(referencedJobId)
      : workflowStore.getActiveJob(conversationKeyFromMessages(messages));
    if (durableJob) {
      workflowStore.reconcileRuntimeRefs(durableJob.job_id, messages);
      const completionTurns = messages.filter(m => {
        const c = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
        return /\[Internal task completion event\]|A background task completed/i.test(c);
      });
      for (const completionTurn of completionTurns) {
        const rawCompletion = typeof completionTurn?.content === 'string'
          ? completionTurn.content
          : JSON.stringify(completionTurn?.content || '');
        const childRunIds = [...rawCompletion.matchAll(/(?:childRunId|child_run_id)["'\s:=]+([A-Za-z0-9._:-]+)/gi)].map(m => m[1]);
        const runIds = [...rawCompletion.matchAll(/(?:runId|run_id)["'\s:=]+([A-Za-z0-9._:-]+)/gi)].map(m => m[1]);
        const childSessionKeys = [...rawCompletion.matchAll(/(?:childSessionKey|child_session_key)["'\s:=]+([A-Za-z0-9._:@/-]+)/gi)].map(m => m[1]);
        const sessionKeys = [...rawCompletion.matchAll(/(?:session_key)["'\s:=]+([A-Za-z0-9._:@/-]+)/gi)].map(m => m[1]);
        const runId = childRunIds.at(-1) || runIds.at(-1) || null;
        const sessionKey = childSessionKeys.at(-1) || sessionKeys.at(-1) || null;
        if (runId || sessionKey) {
          const actualToolEvidence = messages
            .filter(m => m?.role === 'tool' && m?.name !== 'sessions_spawn' && m?.tool_name !== 'sessions_spawn')
            .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))
            .filter(Boolean)
            .filter(c => /\[ACTUAL TOOL RESULT EVIDENCE\]|(?:exact command|exit status|exitCode)/i.test(c))
            .slice(-8)
            .join('\n\n');
          const completionEvidence = rawCompletion.match(/<prompt-data>[\s\S]*?<\/prompt-data>/i)?.[0] || null;
          const existingTask = workflowStore.getJobTrace(durableJob.job_id)?.tasks?.find(t =>
            (runId && t.openclaw_run_id === runId) || (sessionKey && t.openclaw_session_key === sessionKey)
          );
          let normalizedContent = completionEvidence
            ? `${rawCompletion}\n[ACTUAL TOOL RESULT EVIDENCE]\n${completionEvidence}`
            : actualToolEvidence
              ? `${rawCompletion}\n[ACTUAL TOOL RESULT EVIDENCE]\n${actualToolEvidence}`
              : rawCompletion;
          if (existingTask?.role === 'reviewer' || existingTask?.role === 'architect') {
            const artifact = completionEvidence?.match(/<prompt-data>\s*([\s\S]*?)\s*<\/prompt-data>/i)?.[1]?.trim();
            if (artifact) normalizedContent = artifact;
          }
          if (existingTask) workflowStore.repairResultEvidence(existingTask.task_id, normalizedContent);
          workflowStore.completeTaskByRuntime(durableJob.job_id, {
            runId,
            sessionKey,
            content: normalizedContent,
            outcome: runtimeCompletionFailed(rawCompletion) ? 'failure' : 'success'
          });
        }
      }
    }
  }

  const validToolNames = new Set(Array.isArray(tools) ? tools.map(t => t.function?.name || t.name).filter(Boolean) : []);
  ['exec', 'execute_batch', 'read', 'write', 'edit', 'message', 'sessions_spawn', 'sessions_send', 'sessions_yield', 'subagents', 'debate'].forEach(n => validToolNames.add(n));

  function isLikelyToolCall(obj) {
    if (!obj || typeof obj !== 'object' || !obj.name || typeof obj.name !== 'string') return false;
    // Must either have arguments/parameters object or the name must match a recognized tool
    if (obj.arguments !== undefined || obj.parameters !== undefined) return true;
    if (validToolNames.has(obj.name)) return true;
    return false;
  }

  // 1. Try parsing entire trimmed text as JSON
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (isLikelyToolCall(parsed)) {
      toolName = parsed.name;
      toolArgs = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || parsed.parameters || {});
      matchedJsonString = trimmed;
    }
  } catch (e) {}

  // ChatGPT Web can occasionally emit a shell command containing raw double
  // quotes inside JSON, e.g. {"command":"ls "$(pwd)""}. That text is not
  // valid JSON, but the tool-call envelope is still unambiguous. Recover the
  // exec command without weakening the normal JSON parser above.
  if (!toolName) {
    const malformedExec = text.match(/\{\s*"name"\s*:\s*"exec"\s*,\s*"arguments"\s*:\s*\{\s*"command"\s*:\s*"([\s\S]*)"\s*\}\s*\}\s*$/i);
    if (malformedExec) {
      toolName = 'exec';
      toolArgs = JSON.stringify({ command: malformedExec[1] });
      matchedJsonString = text.trim();
    }
  }

  // 2. Look for ```json or ```tool_call blocks
  if (!toolName) {
    const blockMatch = text.match(/```(?:tool_call|json)?\s*([\s\S]*?)\s*```/i);
    if (blockMatch) {
      try {
        const parsed = JSON.parse(blockMatch[1].trim());
        if (isLikelyToolCall(parsed)) {
          toolName = parsed.name;
          toolArgs = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || parsed.parameters || {});
          matchedJsonString = blockMatch[0];
        }
      } catch (e) {}
    }
  }

  // 3. Balanced brace JSON search for {"name": ...}
  if (!toolName) {
    const startMatch = text.match(/\{\s*"name"\s*:/);
    if (startMatch && typeof startMatch.index === 'number') {
      const startIdx = startMatch.index;
      let depth = 0;
      let inString = false;
      let escape = false;
      let endIdx = -1;

      for (let i = startIdx; i < text.length; i++) {
        const char = text[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\\') {
          escape = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === '{') depth++;
          else if (char === '}') {
            depth--;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }
      }

      if (endIdx !== -1) {
        try {
          const jsonSub = text.substring(startIdx, endIdx + 1);
          const parsed = JSON.parse(jsonSub);
          if (isLikelyToolCall(parsed)) {
            toolName = parsed.name;
            toolArgs = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || parsed.parameters || {});
            matchedJsonString = jsonSub;
          }
        } catch (e) {}
      }
    }
  }

  // Find the LAST human user message
  let lastUserMsg = '';
  let lastUserIndex = -1;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const cleaned = cleanMessageContent(messages[i].content);
        if (cleaned && !cleaned.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') && !cleaned.startsWith('[Subagent Context]')) {
          lastUserMsg = cleaned.trim();
          lastUserIndex = i;
          break;
        }
      }
    }
  }

  // Circuit Breaker: Count autonomous subagent loops occurring AFTER the last human message!
  let autonomousSubagentCount = 0;
  let hasFailureTrace = false;
  if (lastUserIndex !== -1 && Array.isArray(messages)) {
    for (let i = lastUserIndex + 1; i < messages.length; i++) {
      const m = messages[i];
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (raw.includes('[Subagent Context]') || raw.includes('Child results awaiting delivery') || raw.includes('Child completion results')) {
        autonomousSubagentCount++;
      }
      if (raw.includes('Timeout waiting for ChatGPT response') || raw.includes('rate_limit_hard_block') || raw.includes('Rate Limit') || raw.includes('Forbidden - agentId is not allowed')) {
        hasFailureTrace = true;
      }
      if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.some(tc => (tc.function?.name || tc.name) === 'sessions_spawn')) {
        autonomousSubagentCount++;
      }
    }
  }

  const isCircuitBreakerTripped = autonomousSubagentCount >= 3;
  if (toolName === 'sessions_spawn' && isCircuitBreakerTripped) {
    console.warn(`[Adapter:CircuitBreaker] Autonomous subagents reached ${autonomousSubagentCount} runs without human. Blocking sessions_spawn!`);
    return {
      blockedByCircuitBreaker: true,
      messageToBoss: `⚠️ [Chief of Staff] Kính báo Boss: Hệ thống ghi nhận tiểu ban kỹ thuật đã chạy ${autonomousSubagentCount} lượt tự động mà chưa hoàn tất hoặc gặp sự cố nghẽn. Em xin tạm dừng điều phối để bảo vệ tài nguyên và báo cáo Boss chỉ đạo.`
    };
  }

  let accompanyingText = null;

  // FSM-Driven Coordinator Workflow (Eliminates fragile if/else hardcoding):
  // ONLY Coordinator (Chief of Staff) runs the proposal/dispatch FSM.
  // Specialized agents (cto, engineer, qa, etc.) execute their assigned tools (exec, read, write) directly!
  if (isCoordinator) {
    const conversationKey = conversationKeyFromMessages(messages);
    const latestUserText = [...(messages || [])].reverse().find(m => m?.role === 'user' && typeof m.content === 'string')?.content?.trim() || '';
    const approvalToken = latestUserText.replace(/^\[[^\]]+\]\s*/, '').trim();
    const explicitMessageJobId = latestUserText.match(/job_[0-9a-f-]{20,}/i)?.[0] || null;
    const isBareApproval = /^(ok|duyệt|đồng ý|triển khai đi|tiến hành đi|chốt|chốt phương án|duyệt kế hoạch|duyệt phương án|cho làm đi|triển khai ngay|tiến hành ngay|ok em|ok triển khai|làm đi|làm luôn|cho triển khai)(?:[.,!\s].*)?$/i.test(approvalToken);

    // Durable workflow is created at the first real Coordinator proposal.
    // Never create a new Job merely because an approval arrived on a different
    // OpenClaw session/channel; correlate approval to an existing PROPOSED Job first.
    const firstUser = (messages || []).find(m => m?.role === 'user' && typeof m.content === 'string' && !String(m.content).includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') && !String(m.content).includes('[Subagent Context]'));
    const jobTitle = firstUser?.content?.trim() || 'Boss request';
    let durableJob = null;
    if (explicitMessageJobId) {
      const candidate = workflowStore.getJob(explicitMessageJobId) || null;
      // An arbitrary job id copied into a replayed/approval transcript must not
      // steal a fresh PROPOSED job. Explicit ids are accepted only when they
      // still belong to this conversation and are awaiting approval.
      if (candidate && candidate.state === 'PROPOSED' && candidate.conversation_key === conversationKey) {
        durableJob = candidate;
        console.log(`[Adapter:JobCorrelation] Explicit PROPOSED Job ${explicitMessageJobId} selected from current conversation.`);
      } else if (candidate) {
        console.warn(`[Adapter:JobCorrelation] Ignoring stale/non-proposed Job ${explicitMessageJobId} during approval; state=${candidate.state} conversationMatch=${candidate.conversation_key === conversationKey}`);
      }
    }
    if (!durableJob && isBareApproval) {
      durableJob = workflowStore.getActiveJob(conversationKey);
      if (durableJob?.state !== 'PROPOSED') durableJob = null;
      if (durableJob) console.log(`[Adapter:ApprovalCorrelation] ${approvalToken} matched PROPOSED Job ${durableJob.job_id} in the same conversation.`);
    }
    if (!durableJob) {
      durableJob = workflowStore.getOrCreateJob({
        conversationKey,
        title: jobTitle.slice(0, 500)
      });
    }

    if (isBareApproval) {
      if (!durableJob) console.warn(`[Adapter:ApprovalCorrelation] No PROPOSED Job found in conversation ${conversationKey}; approval will not borrow an unrelated global Job.`);
    }
    if (durableJob) workflowStore.reconcileRuntimeRefs(durableJob.job_id, messages);
    const fsm = new CoordinatorSessionStateMachine();
    const turnStep = fsm.processTurn(messages, tools, durableJob ? {
      state: durableJob.state,
      activeTask: durableJob.title
    } : null);

    // Approval is a durable business transition, not legacy dispatch. The
    // authoritative Production E2E controller must observe APPROVED itself;
    // otherwise the legacy DISPATCH_TASK guard would leave the Job PROPOSED.
    if (turnStep.action === Actions.DISPATCH_TASK && durableJob?.state === States.PROPOSED) {
      workflowStore.approve(durableJob.job_id, latestUserText || 'approved');
      durableJob = workflowStore.getJob(durableJob.job_id);
    }

    if (turnStep.action === Actions.GENERATE_PROPOSAL || turnStep.action === Actions.REFINE_PROPOSAL) {
      // In Proposal or Discussion phase: CANNOT SPAWN!
      let cleanProposalText = text;
      if (matchedJsonString) {
        cleanProposalText = cleanProposalText.replace(matchedJsonString, '').trim();
      }
      cleanProposalText = cleanProposalText.replace(/```(?:tool_call|json)?\s*```/g, '').trim();
      return {
        isProposal: true,
        cleanText: cleanProposalText || text
      };
    }
    if (turnStep.action === Actions.SILENT_ACK) {
      // Duplicate summary suppressed to stop WhatsApp spam loop
      return {
        isProposal: true,
        cleanText: 'NO_REPLY'
      };
    }


    if (turnStep.action === Actions.REPORT_EXECUTIVE_SUMMARY || turnStep.action === Actions.REPORT_FAILURE) {
      // Reporting phase: CANNOT SPAWN!
      if (durableJob?.state === States.EXECUTING) {
        const trace = workflowStore.getJobTrace(durableJob.job_id);
        const parentTask = trace?.tasks?.find(t => t.task_id === durableJob.active_task_id) || null;
        const children = parentTask ? (trace?.tasks || []).filter(t => t.parent_task_id === parentTask.task_id) : [];
        const requiredRoles = isProductionWorkflow(durableJob) ? ProductionRoles : [];
        const missingRequiredRole = requiredRoles.some(role => !children.some(t => String(t.role).toLowerCase() === role));
        const openRequired = requiredRoles.some(role => {
          const child = children.find(t => String(t.role).toLowerCase() === role);
          return child && !['completed', 'failed', 'cancelled'].includes(String(child.status).toLowerCase());
        });
        if (missingRequiredRole || openRequired) {
          console.warn(`[Adapter:ReportGuard] Suppressed coordinator report for executing Job ${durableJob.job_id}: missingRequired=${missingRequiredRole} openRequired=${openRequired}`);
          return { isProposal: true, cleanText: 'NO_REPLY' };
        }
      }
      let cleanReportText = text;
      if (matchedJsonString) {
        cleanReportText = cleanReportText.replace(matchedJsonString, '').trim();
      }
      cleanReportText = cleanReportText.replace(/```(?:tool_call|json)?\s*```/g, '').trim();

      // Clean hallucinated delivery error notes if present
      cleanReportText = cleanReportText
        .replace(/Kênh gửi:\s*lần gọi message trước đã thất bại[\s\S]*?(?=(\$))/gi, '')
        .replace(/Ghi chú vận hành:\s*hiện tại không có công cụ Slack\/WhatsApp[\s\S]*?(?=(\$))/gi, '')
        .trim();

      const finalReport = cleanReportText || text;

      if (durableJob) {
        const completionTurns = messages.filter(m => {
          const c = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
          return /\[Internal task completion event\]|A background task completed/i.test(c);
        });
        const rawCompletion = completionTurns.length ? (typeof completionTurns[completionTurns.length - 1]?.content === 'string' ? completionTurns[completionTurns.length - 1].content : JSON.stringify(completionTurns[completionTurns.length - 1]?.content || '')) : '';
        const runIds = [...rawCompletion.matchAll(/(?:runId|run_id)["'\s:=]+([A-Za-z0-9._:-]+)/gi)].map(m => m[1]);
        const sessionKeys = [...rawCompletion.matchAll(/(?:session_key|childSessionKey|child_session_key)["'\s:=]+([A-Za-z0-9._:@/-]+)/gi)].map(m => m[1]);
        const runId = runIds.at(-1) || null;
        const sessionKey = sessionKeys.at(-1) || null;
        if (runId || sessionKey) {
          workflowStore.completeTaskByRuntime(durableJob.job_id, {
            runId,
            sessionKey,
            content: finalReport,
            outcome: turnStep.action === Actions.REPORT_FAILURE ? 'failure' : 'success'
          });
          if (workflowStore.hasOpenTasks(durableJob.job_id)) {
            return { isProposal: true, cleanText: 'NO_REPLY' };
          }
        }
      }

      // 1. Mirror to Slack War Room (anti-duplicate debounce protected)
      // broadcast suppressed

      // 2. WhatsApp Delivery via Canonical Native Tool Call
      const hasMessageTool = Array.isArray(tools) && tools.some(t => (t.function?.name || t.name) === 'message');
        if (hasMessageTool) {
        // MANDATORY: 'action': 'send' is required by OpenClaw Runtime message tool schema!
        toolName = 'message';
        const deliveryChannel = deliveryMetadata?.channel || deliveryMetadata?.delivery?.channel || 'whatsapp';
        const deliveryTarget = deliveryMetadata?.target || deliveryMetadata?.delivery?.target || '+84374877794';
        toolArgs = JSON.stringify({
          action: 'send',
          channel: deliveryChannel,
          target: deliveryTarget,
          message: finalReport
        });
        if (durableJob) {
          const reportKind = turnStep.action === Actions.REPORT_FAILURE ? 'failure' : 'executive_summary';
          const reportId = workflowStore.createReport(durableJob.job_id, reportKind, finalReport);
          const deliveryClaimed = workflowStore.claimDelivery(durableJob.job_id, reportId, deliveryChannel, deliveryTarget);
          if (!deliveryClaimed) console.log(`[Adapter:Phase3] Existing ${deliveryChannel} delivery claim reused for job ${durableJob.job_id}`);
          try {
            workflowStore.terminalizeJob(durableJob.job_id, {
              outcome: turnStep.action === Actions.REPORT_FAILURE ? 'failure' : 'success',
              reportId,
              deliveryChannel,
              deliveryTarget,
              content: finalReport
            });
          } catch (error) {
            console.error(`[Adapter:TerminalizeGuard] Job ${durableJob.job_id} not terminalized: ${error.message}`);
            return { isProposal: true, cleanText: 'NO_REPLY' };
          }
        }
        accompanyingText = null;
      } else {
        return {
          isProposal: true,
          cleanText: finalReport
        };
      }
    }

    if (turnStep.action === Actions.DISPATCH_TASK && !isCircuitBreakerTripped && !isProductionWorkflow(durableJob) && !directEngineeringJob) {
      // Approved: CTO is the technical lead, not the universal worker.
      // CTO must build the smallest useful team and delegate independent work
      // through OpenClaw native sessions_spawn. The browser adapter provides
      // separate execution lanes so those child sessions can run concurrently.
      let taskDescription = turnStep.activeTask || fsm.activeTask || lastUserMsg || 'Nhiệm vụ Boss đã phê duyệt';
      if (durableJob) {
        // Use the first proposal event as the original Boss request. Do not use
        // the last proposal event: a timed-out/replayed approval turn may have
        // recorded its own user text as a proposal event. Job title is display-
        // truncated and is not sufficient to reconstruct execution scope.
        const originalProposal = workflowStore.getJobTrace(durableJob.job_id)?.events
          ?.find(e => e.type === 'job.proposal_requested');
        if (originalProposal?.payload_json) {
          try {
            const proposal = JSON.parse(originalProposal.payload_json);
            if (typeof proposal.task === 'string' && proposal.task.trim()) taskDescription = proposal.task.trim();
          } catch (_) {}
        }
      }
      // Never copy proposal-phase prohibitions into approved execution.
      // Keep the original proposal in the event log; CTO receives only the
      // post-approval execution scope.
      let executionTaskDescription = taskDescription;
      const afterApproval = executionTaskDescription.match(/after\s+approval\s*:\s*([\s\S]*)/i);
      if (afterApproval?.[1]) executionTaskDescription = afterApproval[1].trim();
      executionTaskDescription = executionTaskDescription
        .replace(/\bdo not claim execution now\.?[\s\S]*$/i, '')
        .replace(/\breturn the proposal and ask Boss approval\.?[\s\S]*$/i, '')
        .replace(/\bchưa execution\.?/gi, '')
        .replace(/\bfirst turn only\b[^.]*\.?/gi, '')
        .trim();
      if (!executionTaskDescription) executionTaskDescription = taskDescription;

      let ctoTask = `Durable Job ID: ${durableJob?.job_id || 'unknown'}.
Boss đã phê duyệt. Bắt đầu execution NOW. Scope đã được tách khỏi proposal phase: "${executionTaskDescription}".

      Bạn là technical lead. KHÔNG mặc định tự làm toàn bộ nhiệm vụ.
      OpenClaw native tool 'sessions_spawn' là execution primitive được cấp cho bạn trong turn này. Khi task yêu cầu delegate, hãy gọi tool trực tiếp; không mô tả việc spawn bằng prose, không nói tool không tồn tại/không khả dụng.
      Trước khi thực thi, hãy phân rã thành task graph tối thiểu và chọn đúng specialist:
- architect: architecture/contracts/trade-offs
- engineer: implementation/debugging
- researcher: fact-finding/comparison khi cần
- security: threat model/security review khi cần
- platform: infrastructure/deployment khi cần
- qa: behavioral tests/regression
- reviewer: independent DoD review
- writer: documentation/communication khi cần

      Các task độc lập PHẢI được spawn qua OpenClaw native sessions_spawn mà không chờ nhau; để OpenClaw chạy chúng song song. Chỉ giữ các dependency thực sự cần thiết tuần tự.
      Với mỗi specialist task, BẮT BUỘC dùng sessions_spawn native. Không dùng collector mode; runtime Job Store sở hữu durable WAIT/RESUME và biết chính xác child run/session nào phải chờ. SAU KHI đã spawn đủ các task độc lập hiện có, không cần tự quản lý agents_wait; có thể kết thúc turn sau khi native spawn được accepted. Runtime sẽ chờ child terminal rồi resume SAME CTO session khi đủ evidence.
Argument task của sessions_spawn PHẢI chứa scope kiểm tra cụ thể được Boss yêu cầu; không dùng mô tả role-only như “Specialist role: qa”. Nếu Boss request có command/path/acceptance criterion cụ thể, copy nguyên scope đó vào child task để child có đủ context thực thi và trả evidence.
      Sau khi child agents hoàn tất, tổng hợp artifact/result của chúng, giải quyết conflict và báo cáo Coordinator. Không được tuyên bố hoàn tất dựa trên việc sessions_spawn trả về accepted; chỉ coi child hoàn tất khi có completion/terminal evidence thực tế từ OpenClaw và Job Store.
Mọi progress/decision quan trọng có thể cập nhật vào Slack War Room, nhưng Job Store/OpenClaw mới là source of truth. Không tự giả lập việc đã gửi Slack.

      Bắt đầu bằng team decomposition và delegation phù hợp, không chỉ giao lại cho chính mình.`;
      if (durableJob) {
        const existingChildren = workflowStore.getJobTrace(durableJob.job_id)?.tasks
          ?.filter(t => t.parent_task_id)
          ?.map(t => `- ${t.role}: status=${t.status}, taskId=${t.task_id}, runId=${t.openclaw_run_id || 'pending'}`)
          ?.join('\n');
        if (existingChildren) {
          ctoTask += `\n\nDURABLE CHILD STATE (source of truth; do not duplicate):\n${existingChildren}\nNếu specialist role/scope đã có task trong Job Store, TUYỆT ĐỐI KHÔNG spawn lại role đó. Chờ task hiện có hoàn tất rồi tổng hợp kết quả. Không tạo task thay thế chỉ vì completion event đến ở turn mới.`;
        }
      }
      if (executionTaskDescription.toLowerCase().includes('debate')) {
        ctoTask += `\nLưu ý kỹ thuật: Sử dụng công cụ 'exec' để:
1. Chạy phiên tranh biện thực tế và thu thập trace luồng dữ liệu end-to-end:
   'node /home/long/work/chatgpt-adapter/debate-engine.js run-cycle "${executionTaskDescription}"'
2. Chạy kiểm thử tự động toàn bộ test suite của plugin:
   'cd /home/long/work/chat-on-steroids-debate && npx vitest run test/debate-plugin.test.ts'
(Lưu ý: Không chạy lệnh 'cd' trần trụi. Kiểm tra file bằng lệnh đầy đủ hoặc 'ls -la').
Báo cáo lại đầy đủ kết quả: Chủ đề, Trace luồng dữ liệu (Input -> Plugin -> Xử lý tranh biện -> Output), Kết quả Vitest, và nghiệm thu đối chiếu DoD.`;
      }
      toolName = 'sessions_spawn';
      toolArgs = JSON.stringify({
        agentId: 'cto',
        task: ctoTask
      });
      if (durableJob) {
        if (durableJob.state !== States.EXECUTING) {
          workflowStore.approve(durableJob.job_id, lastUserMsg || 'approved');
        }
        const activeCto = workflowStore.getTask(durableJob.active_task_id);
        if (!(activeCto && String(activeCto.role).toLowerCase() === 'cto' && ['running', 'pending'].includes(activeCto.status))) {
          workflowStore.dispatch(durableJob.job_id, { role: 'cto', description: executionTaskDescription });
          workflowStore.startAttempt(durableJob.job_id);
        } else if (durableJob.state !== States.EXECUTING) {
          workflowStore.transition(durableJob.job_id, States.EXECUTING, 'approved execution continuation');
        }
      }
      accompanyingText = `Dạ Boss, kế hoạch "${taskDescription}" đã được duyệt. Em phân công CTO @cto bắt đầu triển khai ngay. Chi tiết tiến độ sẽ liên tục cập nhật trên Slack War Room ạ!`;
      // broadcast suppressed
    }
  }

  // 4b. CTO delegation fallback: some ChatGPT Web turns describe specialist
  // delegation in prose instead of emitting native sessions_spawn JSON.
  // Convert only explicit approved CTO delegation intent into one native
  // OpenClaw tool call. OpenClaw remains the execution authority.
  if (!toolName && targetRole === 'cto' && text) {
    const referencedJobId = workflowStore.findJobIdFromMessages(messages);
    const durableJob = referencedJobId
      ? workflowStore.getJob(referencedJobId)
      : workflowStore.getActiveJob(conversationKeyFromMessages(messages));
    if (durableJob && durableJob.state === States.EXECUTING && !isProductionWorkflow(durableJob) && !isEngineeringWorkflow(durableJob) && !isStandardEngineeringWorkflow(durableJob)) {
      const trace = workflowStore.getJobTrace(durableJob.job_id);
      const existingRoles = new Set((trace?.tasks || []).filter(t => t.parent_task_id).map(t => t.role));
      const lower = text.toLowerCase();
      const hasSignal = ['spawn', 'phân công', 'delegate', 'specialist', 'độc lập', 'song song'].some(x => lower.includes(x));
      const explicitRefusal = ['không thể', 'không gọi', 'do not', 'cannot', 'unable'].some(x => lower.includes(x));
      const specialist = ['architect', 'engineer', 'qa', 'security', 'platform', 'researcher', 'reviewer', 'writer']
        .find(x => lower.includes(x) && !existingRoles.has(x));
      if (hasSignal && !explicitRefusal && specialist) {
        const parentTaskId = durableJob.active_task_id || trace?.tasks?.find(t => !t.parent_task_id)?.task_id || null;
        const task = `Durable Job ID: ${durableJob.job_id}. Specialist role: ${specialist}. Execute independently and return concise findings to CTO. Read-only verification; do not modify production code.`;
        if (parentTaskId) {
          workflowStore.createChildTask(durableJob.job_id, {
            parentTaskId,
            role: specialist,
            description: task
          });
        }
        toolName = 'sessions_spawn';
        toolArgs = JSON.stringify({
          agentId: specialist,
          task
        });
        console.log(`[Adapter:CTODelegationFallback] native sessions_spawn role=${specialist} job=${durableJob.job_id}`);
      }
    }
  }

  // Lifecycle invariant: native worker spawn is legal only while the durable
  // business Job is EXECUTING. Fall back to conversation identity because the
  // current tool-call text may not yet contain the generated Durable Job ID.
  if (toolName === 'sessions_spawn') {
    let explicitJobId = null;
    try {
      const parsedSpawnArgs = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : (toolArgs || {});
      const spawnText = JSON.stringify(parsedSpawnArgs);
      explicitJobId = spawnText.match(/job_[0-9a-f-]{20,}/i)?.[0] || null;
    } catch (_) {}
    const referencedJobId = explicitJobId || workflowStore.findJobIdFromMessages(messages);
    const durableJob = referencedJobId
      ? workflowStore.getJob(referencedJobId)
      : workflowStore.getActiveJob(conversationKeyFromMessages(messages));
    if (durableJob && durableJob.state !== States.EXECUTING) {
      console.warn(`[Adapter:LifecycleGuard] Blocked sessions_spawn for Job ${durableJob.job_id} state=${durableJob.state}`);
      return null;
    }
    if (durableJob && isEngineeringWorkflow(durableJob)) {
      console.warn(`[Adapter:LifecycleGuard] Blocked CTO-originated sessions_spawn for Engineering Job ${durableJob.job_id}; LangGraph owns child assignment.`);
      return null;
    }
    if (durableJob && isStandardEngineeringWorkflow(durableJob)) {
      console.warn(`[Adapter:LifecycleGuard] Blocked local sessions_spawn for standard-engineering Job ${durableJob.job_id}; GitHub Runner owns agent lifecycle.`);
      return null;
    }
    let spawnArgs = {};
    try { spawnArgs = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : (toolArgs || {}); } catch (_) {}
    const role = String(spawnArgs.agentId || spawnArgs.agent_id || '').toLowerCase();

    // Duplicate detection MUST precede provider admission. Otherwise a repeated
    // native sessions_spawn for an already durable child consumes a provider
    // lease before the lifecycle guard rejects the duplicate, leaking capacity
    // and eventually tripping the global cooldown.
    if (durableJob && role && role !== 'cto') {
      const trace = workflowStore.getJobTrace(durableJob.job_id);
      const duplicate = trace?.tasks?.find(t => t.parent_task_id && String(t.role).toLowerCase() === role &&
        !['failed', 'cancelled'].includes(String(t.status).toLowerCase()) &&
        (isProductionWorkflow(durableJob) || /EXECUTION NOW|Durable Job ID|exactly this command|exact command/i.test(t.description || '')));
      if (duplicate) {
        console.warn(`[Adapter:LifecycleGuard] Blocked duplicate ${role} sessions_spawn for Job ${durableJob.job_id}; existing task=${duplicate.task_id} status=${duplicate.status}`);
        return null;
      }
    }

    if (durableJob) {
      try {
        const admission = admitNativeSpawn({ jobId: durableJob.job_id, taskId: durableJob.active_task_id, role });
        workflowStore.clearProviderWaiting(durableJob.job_id);
        console.log(`[Adapter:ProviderAdmission] admitted sessions_spawn role=${role} job=${durableJob.job_id} provider=${admission.providerId} lease=${admission.leaseId}`);
      } catch (error) {
        if (error?.code === 'PROVIDER_UNAVAILABLE') {
          workflowStore.setProviderWaiting(durableJob.job_id, error.retryAfterMs || 0, error.message);
          console.warn(`[Adapter:ProviderAdmission] BLOCKED sessions_spawn job=${durableJob.job_id}: ${error.message}`);
          return {
            blockedByProviderAdmission: true,
            retryAfterMs: error.retryAfterMs || 0,
            messageToBoss: `Provider đang cooldown. Không spawn child lúc này. Job ${durableJob.job_id} được giữ nguyên; thử lại sau khoảng ${Math.ceil((error.retryAfterMs || 0) / 60000)} phút.`
          };
        }
        throw error;
      }
    }
  }

  // 4c. Match CoS native UI call (e.g. "Chat On Steroids Core \n Exec command \n cmd: ...")
  if (!toolName && text.includes('Exec command') && text.includes('cmd:')) {
    const cmdMatch = text.match(/cmd:\s*["']?([\s\S]*?)["']?\s*,\s*workdir:/i) || text.match(/cmd:\s*([^\n]+)/i);
    if (cmdMatch) {
      let rawCmd = cmdMatch[1].trim();
      if (rawCmd.startsWith('"') && rawCmd.endsWith('"')) rawCmd = rawCmd.slice(1, -1);
      toolName = 'exec';
      toolArgs = JSON.stringify({ command: rawCmd });
    }
  }

  // 5. Fallback dispatch for OpenClaw technical execution tools (exec)
  // Specialist execution turns are handled by recoverSpecialistExecToolCall
  // below. Do not infer a second exec call from post-tool prose such as
  // "node --check ... completed with exit status 0", which can become a
  // malformed shell command on the next child turn.
  if (!toolName && Array.isArray(tools) && !ProductionRoles.includes(String(targetRole || '').toLowerCase())) {
    const execTool = tools.find(t => {
      const n = (t.function?.name || t.name || '');
      return n === 'exec' || n.includes('exec');
    });
    if (execTool) {
      const actualExecName = execTool.function?.name || execTool.name;
      // Check for code blocks
      const codeBlockMatch = text.match(/```(?:bash|sh)?\s*([\s\S]*?)\s*```/i);
      if (codeBlockMatch) {
        toolName = actualExecName;
        toolArgs = JSON.stringify({ command: codeBlockMatch[1].trim() });
      } else {
        // Extract command lines from text, joining multiline commands with continuation (&&, \)
        const cmdKeywords = ['cd ', 'npm ', 'npx ', 'git ', 'node ', 'cat ', 'find ', 'free ', 'ps ', 'df ', 'uptime', 'vmstat', 'grep ', 'ls ', 'systemctl ', 'vitest '];
        const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const matchedLines = [];
        let capturing = false;

        for (const line of rawLines) {
          if (!capturing && cmdKeywords.some(k => line.startsWith(k))) {
            capturing = true;
            matchedLines.push(line);
          } else if (capturing) {
            const prev = matchedLines[matchedLines.length - 1];
            if (prev.endsWith('&&') || prev.endsWith('\\') || prev.endsWith('|') || prev.endsWith(';')) {
              matchedLines.push(line);
            } else if (cmdKeywords.some(k => line.startsWith(k))) {
              matchedLines.push(line);
            } else {
              break;
            }
          }
        }

        if (matchedLines.length > 0) {
          toolName = actualExecName;
          toolArgs = JSON.stringify({ command: matchedLines.join(' ') });
        }
      }
    }
  }

  if (!toolName) return null;

  // Phase 1 invariant: CoS is governance-only. Never dispatch worker lifecycle
  // through a Chat on Steroids Core MCP tool; OpenClaw owns sessions_spawn.
  if (toolName === 'chat_on_steroids_core__agents' || toolName === 'chat-on-steroids-core__agents' || toolName === 'agents') {
    const normalizedArgs = String(toolArgs || '').toLowerCase();
    if (normalizedArgs.includes('spawn') || normalizedArgs.includes('message') || normalizedArgs.includes('finish')) {
      console.warn('[Adapter:Phase1] Blocked CoS worker lifecycle call; use OpenClaw native sessions_spawn/completion.');
      return null;
    }
  }

  // Map toolName to exact available tool name in OpenClaw (e.g. exec)
  if (Array.isArray(tools) && tools.length > 0) {
    const exactMatch = tools.find(t => (t.function?.name || t.name) === toolName);
    if (exactMatch) {
      toolName = exactMatch.function?.name || exactMatch.name;
    } else {
      const partialMatch = tools.find(t => {
        const n = (t.function?.name || t.name || '');
        return n.includes(toolName) || toolName.includes(n);
      });
      if (partialMatch) {
        toolName = partialMatch.function?.name || partialMatch.name;
      }
    }
  }

  // Extract accompanying text for Boss (if any)
  let cleanAssistantText = '';
  if (matchedJsonString) {
    cleanAssistantText = text
      .replace(matchedJsonString, '')
      .replace(/```(?:tool_call|json)?\s*```/g, '')
      .replace(/^\[Chief of Staff\]\s*/i, '')
      .replace(/^\[Coordinator\]\s*/i, '')
      .replace(/^\[CTO\]\s*/i, '')
      .trim();
  }

  // Canonical Schema Guard: Ensure required fields are always present to avoid OpenClaw validation rejection
  if (toolName === 'message') {
    try {
      const parsedArgs = JSON.parse(toolArgs || '{}');
      if (!parsedArgs.action) {
        parsedArgs.action = 'send';
        toolArgs = JSON.stringify(parsedArgs);
      }
    } catch (_) {}
  }

  return {
    name: toolName,
    arguments: toolArgs || '{}',
    accompanyingText: accompanyingText || (cleanAssistantText.length > 5 ? cleanAssistantText : null)
  };
}

// Specialist execution reliability guard: when an explicit child task contains
// an actionable syntax-check command but the web model returns prose instead of
// a function call, translate that already-authorized task into the real OpenClaw
// exec tool call. This is NOT orchestration: sessions_spawn still owns the child
// session; this only recovers the tool-use wire format inside that child turn.
export function recoverSpecialistExecToolCall(text, tools = [], messages = [], targetRole = 'coordinator') {
  if (!ProductionRoles.includes(String(targetRole || '').toLowerCase())) return null;
  if (!Array.isArray(tools) || !tools.some(t => (t.function?.name || t.name) === 'exec')) return null;
  // OpenClaw may already have a native exec result in the transcript. That
  // result is not durable ExecutionManager evidence, so it must not suppress
  // recovery when the durable child still lacks execution evidence.
  const raw = messages.map(m => typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '')).join('\n');
  if (!/\b(?:Subagent Task|execution now|Run immediately)\b/i.test(raw)) return null;
  const match = raw.match(/\bnode\s+--check\s+\/home\/long\/work\/chatgpt-adapter\/[A-Za-z0-9._/-]+/i);
  if (!match) return null;
  const command = match[0].trim();
  console.warn(`[Adapter:SpecialistExecRecovery] ${targetRole} model omitted exec tool call; recovering explicit task command: ${command}`);
  return { name: 'exec', arguments: JSON.stringify({ command }), accompanyingText: null, recovered: true };
}

export function normalizeSpecialistExecToolCall(toolCall, messages = [], targetRole = 'coordinator') {
  if (!toolCall || toolCall.name !== 'exec') return toolCall;
  if (!ProductionRoles.includes(String(targetRole || '').toLowerCase())) return toolCall;
  const raw = messages.map(m => typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '')).join('\n');
  const expectedFile = String(targetRole).toLowerCase() === 'qa' ? 'test-tool-turn.js' : 'server.js';
  const expected = raw.match(new RegExp(`\\bnode\\s+--check\\s+\\/home\\/long\\/work\\/chatgpt-adapter\\/${expectedFile.replace('.', '\\.') }\\b`, 'i'))?.[0];
  if (!expected) return toolCall;
  try {
    const args = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : (toolCall.arguments || {});
   const command = typeof args.command === 'string' ? args.command.trim() : '';
   if (command && command !== expected && command.startsWith(expected)) {
     console.warn(`[Adapter:SpecialistExecNormalize] ${targetRole} normalized model-tainted exec command to exact authorized command: ${expected}`);
     return { ...toolCall, arguments: JSON.stringify({ command: expected }), normalized: true };
   }
    const canonicalCommand = command.replace(/^node\s+--check\s+~\/work\/chatgpt-adapter\//i, 'node --check /home/long/work/chatgpt-adapter/');
    if (canonicalCommand && canonicalCommand !== command && canonicalCommand === expected) {
      console.warn(`[Adapter:SpecialistExecNormalize] ${targetRole} canonicalized workspace-relative exec command to exact authorized command: ${expected}`);
      return { ...toolCall, arguments: JSON.stringify({ command: expected }), normalized: true };
    }
  } catch (_) {}
  return toolCall;
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  // Health check
  if (url.pathname === '/health' || url.pathname === '/') {
    try {
      const status = bridge.getStatus();
      const targets = await bridge.getTargets();
      const hasChatGpt = targets.some(t => t.url?.includes('chatgpt.com'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const workflow = workflowStore.getStats();
      res.end(JSON.stringify({
        status: 'ok',
        browserConnected: true,
        targetsCount: targets.length,
        hasChatGpt,
        accountPool: status,
        providerAdmission: syncProviderAdmissionFromBridge(),
        providerMetrics: providerAdmission.getMetrics(),
        tmpInode: refreshTmpInodeHealth(),
        workflow
      }, null, 2));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'error',
        browserConnected: false,
        error: err.message
      }));
    }
    return;
  }

  // Phase 4 observability: safe local read-only workflow endpoints.
  if (url.pathname === '/v1/workflow/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(workflowStore.getObservability({ eventLimit: url.searchParams.get('limit') }), null, 2));
    return;
  }
  if (url.pathname === '/v1/workflow/jobs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(workflowStore.listActiveJobs(url.searchParams.get('limit')), null, 2));
    return;
  }
  if (url.pathname.startsWith('/v1/workflow/jobs/') && url.pathname.endsWith('/slack') && req.method === 'GET') {
    const jobId = decodeURIComponent(url.pathname.slice('/v1/workflow/jobs/'.length, -'/slack'.length));
    const projection = workflowStore.getSlackProjection(jobId);
    const exists = workflowStore.getJob(jobId);
    res.writeHead(exists ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(exists ? projection : { error: 'job_not_found', jobId }, null, 2));
    return;
  }
  if (url.pathname.startsWith('/v1/workflow/jobs/') && url.pathname.endsWith('/trace') && req.method === 'GET') {
    const jobId = decodeURIComponent(url.pathname.slice('/v1/workflow/jobs/'.length, -'/trace'.length));
    const trace = workflowStore.getJobTrace(jobId);
    res.writeHead(trace ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(trace || { error: 'job_not_found', jobId }, null, 2));
    return;
  }
  if (url.pathname.startsWith('/v1/workflow/jobs/') && req.method === 'GET') {
    const jobId = decodeURIComponent(url.pathname.slice('/v1/workflow/jobs/'.length));
    const trace = workflowStore.getJobTrace(jobId);
    if (!trace?.job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'job not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ job: trace.job, tasks: trace.tasks || [] }));
    return;
  }

  // Reset limits endpoint
  if (url.pathname === '/reset-limits' || url.pathname === '/v1/reset-limits') {
    bridge.resetRateLimits();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'All account rate limits reset' }));
    return;
  }

  // Account status check
  if (url.pathname === '/v1/accounts' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(bridge.getStatus(), null, 2));
    return;
  }

  if (url.pathname === '/v1/provider-admission' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ providers: syncProviderAdmissionFromBridge() }, null, 2));
    return;
  }

  // List models
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        {
          id: 'chatgpt-free',
          object: 'model',
          created: 1700000000,
          owned_by: 'chatgpt-web-adapter'
        },
        {
          id: 'chatgpt-coordinator',
          object: 'model',
          created: 1700000000,
          owned_by: 'chatgpt-web-adapter'
        },
        {
          id: 'chatgpt-cto',
          object: 'model',
          created: 1700000000,
          owned_by: 'chatgpt-web-adapter'
        },
        {
          id: 'chatgpt-reviewer',
          object: 'model',
          created: 1700000000,
          owned_by: 'chatgpt-web-adapter'
        },
        {
          id: 'chatgpt-4o',
          object: 'model',
          created: 1700000000,
          owned_by: 'chatgpt-web-adapter'
        },
        {
          id: 'chatgpt-thinking',
          object: 'model',
          created: 1700000000,
          owned_by: 'chatgpt-web-adapter'
        }
      ]
    }));
    return;
  }

  // Restart server
  if (url.pathname === '/restart' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'restarting' }));
    setTimeout(() => process.exit(0), 200);
    return;
  }


function isImmediateSilentRequest(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;

  // 1. Check if the pending turn contains OpenClaw internal background triggers
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 3); i--) {
    const m = messages[i];
    const raw = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
    if (
      raw.includes('Skill review') ||
      raw.includes('Distill new durable learning') ||
      raw.includes('Continue the current task from the existing transcript') ||
      raw.includes('Follow the heartbeat monitor') ||
      raw.includes('[OpenClaw heartbeat poll]') ||
      raw.includes('Skill Workshop')
    ) {
      return true;
    }
  }

  // 2. Check if the latest action was a tool result from message tool delivery
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool' || m.role === 'toolResult') {
      const toolName = m.name || m.toolName || '';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (toolName === 'message' || content.includes('"channel": "whatsapp"') || content.includes('"channel": "slack"') || content.includes('"messageId":')) {
        return true;
      }
    } else if (m.role === 'assistant') {
      break;
    } else if (m.role === 'user') {
      const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (!raw.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') && !raw.includes('[Subagent Context]')) {
        break;
      }
    }
  }

  return false;
}

  // Chat completions
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const requestAbort = new AbortController();
    const abortRequest = (reason = 'client disconnected') => {
      if (!requestAbort.signal.aborted) {
        console.warn(`[Adapter:HTTP] Aborting request: ${reason}`);
        requestAbort.abort(new Error(reason));
      }
    };
    const onRequestAborted = () => abortRequest('request body aborted');
    const onRequestError = error => abortRequest(`request socket error: ${error?.message || 'unknown error'}`);
    const onResponseClose = () => {
      if (!res.writableEnded && !res.writableFinished) abortRequest('response closed before completion');
    };
    const onSocketClose = () => {
      if (!res.writableEnded && !res.writableFinished) abortRequest('request socket closed before response completion');
    };
    const cleanupRequestLifecycle = () => {
      req.off('aborted', onRequestAborted);
      req.off('error', onRequestError);
      res.off('close', onResponseClose);
      req.socket?.off('close', onSocketClose);
      req.socket?.off('error', onRequestError);
    };
    req.once('aborted', onRequestAborted);
    req.once('error', onRequestError);
    res.once('close', onResponseClose);
    req.socket?.once('close', onSocketClose);
    req.socket?.once('error', onRequestError);

    let bodyText = '';
    req.on('data', chunk => bodyText += chunk);
    req.on('end', async () => {
      if (requestAbort.signal.aborted) {
        cleanupRequestLifecycle();
        if (!res.writableEnded) res.end();
        return;
      }
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch (err) {
        cleanupRequestLifecycle();
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
        return;
      }

      const model = body.model || 'chatgpt-free';
      const tools = body.tools || [];
      const isStream = Boolean(body.stream);
      const completionId = `chatcmpl-${Date.now()}`;
      const createdTime = Math.floor(Date.now() / 1000);

      // Check for Immediate Silent Replies (OpenClaw background tasks, heartbeat, or message toolResult)
      if (isImmediateSilentRequest(body.messages)) {
        cleanupRequestLifecycle();
        console.log(`[Adapter:SilentAck] Detected background task or toolResult from message delivery. Replying NO_REPLY instantly.`);
        if (isStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          const textChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTime,
            model,
            choices: [{
              index: 0,
              delta: { content: 'NO_REPLY' },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
          const finalStopChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTime,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }]
          };
          res.write(`data: ${JSON.stringify(finalStopChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: completionId,
            object: 'chat.completion',
            created: createdTime,
            model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'NO_REPLY'
              },
              finish_reason: 'stop'
            }]
          }));
          return;
        }
      }

      let formatted = formatMessagesToPrompt(body.messages, tools, model, body.metadata || {});
      // Deterministic specialist execution belongs to ExecutionManager. Do not
      // advertise native `exec` to Architect/QA: the web model may otherwise
      // execute the command itself and loop on a transport-only `(no output)`
      // result before the adapter can persist durable evidence.
      if (ProductionRoles.includes(String(formatted.agentRole || '').toLowerCase())) {
        const specialistTools = toolsForSpecialistPrompt(tools, formatted.agentRole);
        formatted = formatMessagesToPrompt(body.messages, specialistTools, model, body.metadata || {});
      }
      let { prompt, agentRole, agentName } = formatted;
      try {
        fs.appendFileSync('/home/long/work/chatgpt-adapter/adapter.log',
          `\n[${new Date().toISOString()}] model=${model} role=${agentRole} messagesCount=${body.messages?.length} toolsCount=${tools?.length} promptLength=${prompt.length}\n`
        );
      } catch (e) {}
// declarations already moved up

      // Determine target role for Multi-Tab routing
      let targetRole = req.headers['x-agent-role'] || req.headers['x-agent-id'] || agentRole || 'coordinator';
      if (agentRole) {
        targetRole = agentRole;
      } else if (model.includes('cto') || model.includes('dto')) {
        targetRole = 'cto';
      } else if (model.includes('reviewer') || model.includes('qa')) {
        targetRole = 'reviewer';
      } else if (model.includes('coordinator')) {
        targetRole = 'coordinator';
      } else if (model.includes('researcher')) {
        targetRole = 'researcher';
      } else if (model.includes('writer')) {
        targetRole = 'writer';
      }

      targetRole = bridge.normalizeRole(targetRole);
      if (targetRole === 'cto') {
        const referencedJobId = workflowStore.findJobIdFromMessages(body.messages || []);
        const durableJob = referencedJobId ? workflowStore.getJob(referencedJobId) : null;
        if (durableJob?.state === States.EXECUTING && isProductionWorkflow(durableJob)) {
          const trace = workflowStore.getJobTrace(durableJob.job_id);
          const parentTask = trace?.tasks?.find(t => t.task_id === durableJob.active_task_id) || null;
          const children = parentTask ? (trace.tasks || []).filter(t => t.parent_task_id === parentTask.task_id) : [];
          const required = ProductionRoles.map(role => children.find(t => String(t.role).toLowerCase() === role));
          const terminal = required.every(t => t && ['completed', 'failed', 'cancelled'].includes(String(t.status).toLowerCase()));
          if (terminal) {
            const evidence = required.map(t => {
              const result = workflowStore.db.prepare('SELECT content FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(t.task_id);
              return '### ' + String(t.role).toUpperCase() + ' DURABLE RESULT\n' + (result?.content || '(missing result)');
            }).join('\n\n');
            prompt += '\n\n[DURABLE CTO SYNTHESIS EVIDENCE — SOURCE OF TRUTH]\nThe required Architect and QA child tasks are terminal. Use these durable child results directly. Do not infer missing evidence from status alone. Synthesize the actual command, output, and exit status from the evidence below. If both are successful and the evidence is complete, state that the DoD passes and complete the Job. Do not spawn replacement children.\n\n' + evidence + '\n[/DURABLE CTO SYNTHESIS EVIDENCE]';
          }
        }
      }
      const explicitPriority = body.priority !== undefined ? Number(body.priority) : (req.headers['x-priority'] !== undefined ? Number(req.headers['x-priority']) : null);

      const toolNames = tools.map(t => t.function?.name || t.name).join(', ');
      console.log(`[Adapter] Incoming request: model=${model}, role=${targetRole} (${agentName || targetRole}), priority=${explicitPriority !== null ? explicitPriority : 'auto'}, stream=${isStream}, tools=[${toolNames}], promptLength=${prompt.length}`);
      console.log(`[Adapter] Prompt metadata: length=${prompt.length}`);

      if (!prompt) {
        cleanupRequestLifecycle();
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Prompt/messages cannot be empty' } }));
        return;
      }

      if (process.env.M11_RUNNER_MODE === 'mock' && targetRole === 'cto') {
        await runWorkflowControllerTick();
        const jobId = workflowStore.findJobIdFromMessages(body.messages || []);
        const job = jobId ? workflowStore.getJob(jobId) : workflowStore.getActiveJob(conversationKeyFromMessages(body.messages || []));
        const content = job?.state === States.PROPOSED
          ? `M11 proposal recorded for ${job.job_id}. Awaiting approval.`
          : `M11 runner-owned workflow accepted for ${job?.job_id || 'unknown job'}.`;
        cleanupRequestLifecycle();
        const message = { role: 'assistant', content };
        if (isStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: createdTime, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: createdTime, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n'); res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: completionId, object: 'chat.completion', created: createdTime, model, choices: [{ index: 0, message, finish_reason: 'stop' }] }));
        }
        return;
      }

      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        let streamTerminated = false;

        try {
          let bufferedText = '';
          let streamedLiveText = false;

          const replyText = await bridge.ask(prompt, (chunk) => {
            bufferedText += chunk;

            if (requestAbort.signal.aborted || res.destroyed || res.writableEnded || streamTerminated) return;

            // When tools are supplied by the caller (OpenClaw / agent system):
            // We hold buffering during generation to prevent raw tool JSON fragments
            // or unapproved drafts from leaking into chat streams (e.g. WhatsApp).
            if (Array.isArray(tools) && tools.length > 0) {
              return;
            }

            // Normal chat without tools: stream chunks live
            if (chunk) streamedLiveText = true;
            const data = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: createdTime,
              model,
              choices: [{
                index: 0,
                delta: { content: chunk },
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }, BRIDGE_ASK_TIMEOUT_MS, targetRole, explicitPriority, requestAbort.signal);

          // Evaluate the complete reply
          const langGraphDecision = await evaluateRequestLangGraph(body.messages, requestAbort.signal);
          const langGraphMetadata = langGraphDecision
            ? { ...(body.metadata || {}), langGraphDecision }
            : (body.metadata || {});
          let toolCall = normalizeSpecialistExecToolCall(
            extractToolCall(replyText, tools, body.messages, targetRole, langGraphMetadata) ||
              recoverSpecialistExecToolCall(replyText, tools, body.messages, targetRole),
            body.messages,
            targetRole
          );
          const guardedWorkflowJob = workflowStore.getJob(workflowStore.findJobIdFromMessages(body.messages || []) || '');
          if (langGraphDecision && getWorkflowDefinition(guardedWorkflowJob) &&
              ['sessions_spawn', 'agents_wait'].includes(String(toolCall?.name || ''))) {
            console.warn(`[Adapter:LangGraphGuard] Suppressed ${toolCall.name} for durable workflow; LangGraph owns workflow orchestration.`);
            toolCall = null;
          }
          let durableExecutionResult = null;
          if (requestAbort.signal.aborted) throw new Error('Request aborted by caller');
          if (['exec', 'execute_batch'].includes(toolCall?.name)) {
              try { durableExecutionResult = await executeDurableDeterministicToolCall(toolCall, body.messages, targetRole, requestAbort.signal); }
              catch (error) {
                if (requestAbort.signal.aborted) throw error;
                durableExecutionResult = { content: `<prompt-data>\n[ACTUAL TOOL RESULT EVIDENCE]\nexecution manager error: ${error.message}\nexit status/code: N/A\n</prompt-data>`, exitCode: null, durableTaskId: null };
              }
          }

          if (toolCall?.blockedByCircuitBreaker) {
            console.log(`[Adapter] Circuit breaker triggered, sending polite message to Boss.`);
            const textChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: createdTime,
              model,
              choices: [{
                index: 0,
                delta: { content: toolCall.messageToBoss },
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
            const finalStopChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: createdTime,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            };
            res.write(`data: ${JSON.stringify(finalStopChunk)}\n\n`);
          } else if (durableExecutionResult) {
            console.log(`[Adapter:ExecutionManager] Durable deterministic task executed task=${durableExecutionResult.durableTaskId || '-'} exit=${durableExecutionResult.exitCode ?? 'N/A'}`);
            const textChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: createdTime,
              model,
              choices: [{ index: 0, delta: { content: durableExecutionResult.content }, finish_reason: null }]
            };
            res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
            const finalStopChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: createdTime,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            };
            res.write(`data: ${JSON.stringify(finalStopChunk)}\n\n`);
          } else if (toolCall?.isProposal) {
            console.log(`[Adapter] Sending clean proposal text to Boss.`);
            if (!streamedLiveText) {
              const textChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model,
                choices: [{
                  index: 0,
                  delta: { content: toolCall.cleanText },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
            }
            const finalStopChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: createdTime,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            };
            res.write(`data: ${JSON.stringify(finalStopChunk)}\n\n`);
          } else if (toolCall && toolCall.name) {
            const hasExactTool = tools.some(t => (t.function?.name || t.name) === toolCall.name);

            if (toolCall.name === 'message' && !hasExactTool) {
              let msgText = '';
              let destChannel = 'slack';
              let destTarget = 'C0C3RJKNKPG';
              try {
                const parsed = JSON.parse(toolCall.arguments);
                msgText = parsed.message || parsed.text || parsed.content || '';
                if (parsed.channel) destChannel = parsed.channel.toLowerCase();
                if (parsed.to) destTarget = parsed.to;
                if (parsed.target) destTarget = parsed.target;
              } catch (e) {
                msgText = toolCall.arguments;
              }
              if (msgText) {
                console.log(`[Adapter] Subagent called 'message' -> Dispatching to ${destChannel}:${destTarget} (payload redacted).`);
                dispatchProgressMessage({ text: msgText, channel: destChannel, target: destTarget });
              }
              const textChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model,
                choices: [{
                  index: 0,
                  delta: { content: msgText || replyText },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
              const finalStopChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop'
                }]
              };
              res.write(`data: ${JSON.stringify(finalStopChunk)}\n\n`);
            } else if (toolCall.name === 'debate' && !hasExactTool) {
              // Direct Zero-Tunnel Debate Execution Interceptor!
              console.log(`[Adapter:ZeroTunnel] Intercepted 'debate' tool call for role ${targetRole}. Executing locally...`);
              let debateArgs = {};
              try {
                debateArgs = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : (toolCall.arguments || {});
              } catch (_) {}

              let executionOutput = '';
              try {
                const { runFullDebate } = await import('./debate-engine.js');
                const topic = debateArgs.topic || 'Kiểm thử Debate Zero-Tunnel';
                const debateRes = await runFullDebate({ topic });
                executionOutput = `[Debate Engine Thành Công] Phiên tranh biện nhóm ${debateRes.groupId} về chủ đề "${debateRes.topic}" đã hoàn tất Socratic Cycle. Trạng thái: ${debateRes.status?.phase || 'OPENING'}, Tổng thành viên: ${debateRes.status?.members?.length || 3}.`;
                console.log(`[Adapter:ZeroTunnel] Debate execution finished: ${executionOutput}`);
              } catch (debErr) {
                console.error(`[Adapter:ZeroTunnel] Debate execution error:`, debErr.message);
                executionOutput = `[Debate Engine Gặp Lỗi]: ${debErr.message}`;
              }

              // Return execution result directly as completion so subagent/coordinator can report to Boss!
              const textChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model,
                choices: [{
                  index: 0,
                  delta: { content: executionOutput },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
              const finalStopChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop'
                }]
              };
              res.write(`data: ${JSON.stringify(finalStopChunk)}\n\n`);
            } else if (!hasExactTool) {
              console.warn(`[Adapter] Tool '${toolCall.name}' is not in available tools [${toolNames}]. Returning as text completion.`);
              const textChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model,
                choices: [{
                  index: 0,
                  delta: { content: replyText },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
              const finalStopChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop'
                }]
              };
              res.write(`data: ${JSON.stringify(finalStopChunk)}\n\n`);
            } else {
              console.log(`[Adapter] Detected tool call: ${toolCall.name} (arguments redacted).`);
              const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

              // If there was accompanying text for Boss:
              if (toolCall.accompanyingText) {
                const textChunk = {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: createdTime,
                  model,
                  choices: [{
                    index: 0,
                    delta: { content: toolCall.accompanyingText },
                    finish_reason: null
                  }]
                };
                res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
              }

              const toolChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: callId,
                      type: 'function',
                      function: {
                        name: toolCall.name,
                        arguments: toolCall.arguments
                      }
                    }]
                  },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);

              const finalStopChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'tool_calls'
                }]
              };
              res.write(`data: ${JSON.stringify(finalStopChunk)}\n\n`);
            }
          } else {
            // Normal prose reply (when tools were present but not called)
            if (Array.isArray(tools) && tools.length > 0) {
              const cleanReply = replyText
                .replace(/^\[Chief of Staff\]\s*/i, '')
                .replace(/^\[Coordinator\]\s*/i, '');
              const flushData = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model,
                choices: [{
                  index: 0,
                  delta: { content: cleanReply },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(flushData)}\n\n`);
            }

            const finalStopChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: createdTime,
              model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop'
              }]
            };
            res.write(`data: ${JSON.stringify(finalStopChunk)}\n\n`);
            streamTerminated = true;
          }

          if (!streamTerminated) res.write('data: [DONE]\n\n');
          cleanupRequestLifecycle();
          res.end();
        } catch (err) {
          console.error('[Adapter] Stream error:', err);
          if (isProviderRateLimitError(err) && err.accountId) {
            syncProviderAdmissionFromBridge();
          }
          if (requestAbort.signal.aborted) {
            cleanupRequestLifecycle();
            if (!res.writableEnded) res.end();
            return;
          }
          const errorType = isProviderRateLimitError(err)
            ? 'rate_limit_error'
            : /timeout/i.test(String(err?.message || '')) ? 'upstream_timeout' : 'upstream_error';
          const errorChunk = {
            id: completionId,
            object: 'error',
            created: createdTime,
            model,
            error: { message: err?.message || 'Upstream provider request failed', type: errorType }
          };
          if (!res.destroyed && !res.writableEnded && !streamTerminated) {
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            streamTerminated = true;
            res.write('data: [DONE]\n\n');
          }
          cleanupRequestLifecycle();
          res.end();
        }
      } else {
        // Non-streaming response
        try {
          const replyText = await bridge.ask(prompt, null, BRIDGE_ASK_TIMEOUT_MS, targetRole, explicitPriority, requestAbort.signal);
          const langGraphDecision = await evaluateRequestLangGraph(body.messages, requestAbort.signal);
          const langGraphMetadata = langGraphDecision
            ? { ...(body.metadata || {}), langGraphDecision }
            : (body.metadata || {});
          let toolCall = normalizeSpecialistExecToolCall(
            extractToolCall(replyText, tools, body.messages, targetRole, langGraphMetadata) ||
              recoverSpecialistExecToolCall(replyText, tools, body.messages, targetRole),
            body.messages,
            targetRole
          );
          if (langGraphDecision && isProductionWorkflow(workflowStore.getJob(workflowStore.findJobIdFromMessages(body.messages || []) || '')) &&
              ['sessions_spawn', 'agents_wait'].includes(String(toolCall?.name || ''))) {
            console.warn(`[Adapter:LangGraphGuard] Suppressed coordinator ${toolCall.name} for Production E2E; LangGraph owns workflow orchestration.`);
            toolCall = null;
          }
          let durableExecutionResult = null;
          if (['exec', 'execute_batch'].includes(toolCall?.name)) {
            try { durableExecutionResult = await executeDurableDeterministicToolCall(toolCall, body.messages, targetRole, requestAbort.signal); }
            catch (error) {
              if (requestAbort.signal.aborted) throw error;
              durableExecutionResult = { content: `<prompt-data>\n[ACTUAL TOOL RESULT EVIDENCE]\nexecution manager error: ${error.message}\nexit status/code: N/A\n</prompt-data>`, exitCode: null, durableTaskId: null };
            }
          }

          let messagePayload;
          let finishReason;

          if (toolCall?.blockedByCircuitBreaker) {
            messagePayload = {
              role: 'assistant',
              content: toolCall.messageToBoss
            };
            finishReason = 'stop';
          } else if (toolCall?.blockedByProviderAdmission) {
            messagePayload = {
              role: 'assistant',
              content: toolCall.messageToBoss
            };
            finishReason = 'stop';
          } else if (durableExecutionResult) {
            messagePayload = {
              role: 'assistant',
              content: durableExecutionResult.content
            };
            finishReason = 'stop';
          } else if (toolCall?.isProposal) {
            messagePayload = {
              role: 'assistant',
              content: toolCall.cleanText
            };
            finishReason = 'stop';
          } else if (toolCall && toolCall.name) {
            const hasExactTool = tools.some(t => (t.function?.name || t.name) === toolCall.name);

            if (toolCall.name === 'message' && !hasExactTool) {
              let msgText = '';
              let destChannel = 'slack';
              let destTarget = 'C0C3RJKNKPG';
              try {
                const parsed = JSON.parse(toolCall.arguments);
                msgText = parsed.message || parsed.text || parsed.content || '';
                if (parsed.channel) destChannel = parsed.channel.toLowerCase();
                if (parsed.to) destTarget = parsed.to;
                if (parsed.target) destTarget = parsed.target;
              } catch (e) {
                msgText = toolCall.arguments;
              }
              if (msgText) {
                console.log(`[Adapter] Subagent called non-stream 'message'. Dispatching to ${destChannel}:${destTarget} (payload redacted).`);
                dispatchProgressMessage({ text: msgText, channel: destChannel, target: destTarget });
              }
              messagePayload = {
                role: 'assistant',
                content: msgText || replyText
              };
              finishReason = 'stop';
            } else if (toolCall.name === 'debate' && !hasExactTool) {
              console.log(`[Adapter:ZeroTunnel] Intercepted non-stream 'debate' tool call for role ${targetRole}. Executing locally...`);
              let debateArgs = {};
              try {
                debateArgs = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : (toolCall.arguments || {});
              } catch (_) {}

              let executionOutput = '';
              try {
                const { runFullDebate } = await import('./debate-engine.js');
                const topic = debateArgs.topic || 'Kiểm thử Debate Zero-Tunnel';
                const debateRes = await runFullDebate({ topic });
                executionOutput = `[Debate Engine Thành Công] Phiên tranh biện nhóm ${debateRes.groupId} về chủ đề "${debateRes.topic}" đã hoàn tất Socratic Cycle. Trạng thái: ${debateRes.status?.phase || 'OPENING'}, Tổng thành viên: ${debateRes.status?.members?.length || 3}.`;
                console.log(`[Adapter:ZeroTunnel] Debate execution finished: ${executionOutput}`);
              } catch (debErr) {
                console.error(`[Adapter:ZeroTunnel] Debate execution error:`, debErr.message);
                executionOutput = `[Debate Engine Gặp Lỗi]: ${debErr.message}`;
              }

              messagePayload = {
                role: 'assistant',
                content: executionOutput
              };
              finishReason = 'stop';
            } else if (!hasExactTool) {
              console.warn(`[Adapter] Non-stream tool '${toolCall.name}' not in available tools [${toolNames}]. Returning as text.`);
              messagePayload = {
                role: 'assistant',
                content: replyText
              };
              finishReason = 'stop';
            } else {
              console.log(`[Adapter] Detected non-stream tool call: ${toolCall.name} (arguments redacted).`);
              const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              messagePayload = {
                role: 'assistant',
                content: toolCall.accompanyingText || null,
                tool_calls: [{
                  id: callId,
                  type: 'function',
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments
                  }
                }]
              };
              finishReason = 'tool_calls';
            }
          } else {
            const cleanReply = replyText
              .replace(/^\[Chief of Staff\]\s*/i, '')
              .replace(/^\[Coordinator\]\s*/i, '');
            messagePayload = {
              role: 'assistant',
              content: cleanReply
            };
            finishReason = 'stop';
          }

          const responsePayload = {
            id: completionId,
            object: 'chat.completion',
            created: createdTime,
            model,
            choices: [{
              index: 0,
              message: messagePayload,
              finish_reason: finishReason
            }],
            usage: {
              prompt_tokens: Math.ceil(prompt.length / 4),
              completion_tokens: Math.ceil((replyText || '').length / 4),
              total_tokens: Math.ceil((prompt.length + (replyText || '').length) / 4)
            }
          };

          res.writeHead(200, { 'Content-Type': 'application/json' });
          cleanupRequestLifecycle();
          res.end(JSON.stringify(responsePayload));
        } catch (err) {
          console.error('[Adapter] Error:', err);
          if (isProviderRateLimitError(err) && err.accountId) {
            syncProviderAdmissionFromBridge();
          }
          if (isProviderRateLimitError(err)) {
            const referencedJobId = workflowStore.findJobIdFromMessages(body.messages || []);
            reconcileBridgeRateLimitForJob(referencedJobId, err);
          }
          if (requestAbort.signal.aborted) {
            cleanupRequestLifecycle();
            if (!res.writableEnded) res.end();
            return;
          }
          cleanupRequestLifecycle();
          const statusCode = isProviderRateLimitError(err)
            ? 429
            : /timeout/i.test(String(err?.message || '')) ? 504 : 502;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: err?.message || 'Upstream provider request failed',
              type: isProviderRateLimitError(err) ? 'rate_limit_error' : /timeout/i.test(String(err?.message || '')) ? 'upstream_timeout' : 'upstream_error'
            }
          }));
        }
      }
    });
    return;
  }

  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found' } }));
});

const isMainModule = process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('server.js'));
if (isMainModule) {
    const recovered = workflowStore.reconcileStaleAttempts();
    if (recovered) console.warn(`[Adapter:Phase3] Reconciled ${recovered} stale attempt(s) during startup.`);
  recoveryManager.reconcile().then(report => {
    if (report.staleSessions.length || report.staleExecutions.length) {
      console.warn(`[Adapter:Phase5] startup recovery: staleSessions=${report.staleSessions.length} staleExecutions=${report.staleExecutions.length}`);
    }
  }).catch(err => console.error('[Adapter:Phase5] startup reconcile:', err.message));
  setInterval(() => { void runWorkflowControllerTick(); }, 1000).unref();
  server.listen(PORT, HTTP_HOST, () => {
    console.log(`🦞 ChatGPT Web Multi-Account Adapter listening on http://${HTTP_HOST}:${PORT}/v1`);
    console.log(`   Account Pool: ${ACCOUNT_COUNT} account(s) (Ports 9021-${9020 + ACCOUNT_COUNT})`);
    if (process.env.M11_RUNNER_MODE !== 'mock') bridge.prewarm().catch(err => {
      console.error('[CDP] Pre-warm failed:', err.message);
    });
    // Slack is a read-only operational projection of the durable event log.
    // It never drives workflow state or task scheduling.
    if (process.env.M11_RUNNER_MODE !== 'mock' && process.env.SLACK_PROJECTION_GLOBAL !== 'false') {
      projectWorkflowEvents().catch(err => console.error('[Adapter:SlackProjection] startup:', err.message));
      setInterval(() => projectWorkflowEvents().catch(err => console.error('[Adapter:SlackProjection] loop:', err.message)), 2000).unref();
    }
    setInterval(() => recoveryManager.reconcile().catch(err => console.error('[Adapter:Phase5] reconcile:', err.message)), 60_000).unref();
    if (SESSION_TRANSPORT_MODE === 'active') {
      console.log('[Adapter:SessionTransport] ACTIVE — durable inbox delivery enabled.');
      reconcileSessionDelivery();
      drainSessionInbox().catch(err => console.error('[Adapter:SessionTransport] startup:', err.message));
      setInterval(() => {
        reconcileSessionDelivery();
        drainSessionInbox().catch(err => console.error('[Adapter:SessionTransport] loop:', err.message));
      }, 1000).unref();
    } else {
      console.log(`[Adapter:SessionTransport] ${SESSION_TRANSPORT_MODE} — no external session delivery.`);
    }
  });
}
