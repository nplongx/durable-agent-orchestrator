import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { validateExecutionBatch, validateExecutionResult } from '../../protocol/cos-ap-v1/index.js';

const TMUX_BIN = process.env.TMUX_BIN || 'tmux';
const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.EXECUTION_TIMEOUT_MS) || 120000);

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function structuredCommand(executable, args = []) {
  return [executable, ...args].map(shellQuote).join(' ');
}

function run(command, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timer;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (timeoutMs > 0) timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error(`command timeout: ${command}`), { code: 'TIMEOUT' })); }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code, signal) => { if (timer) clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

export class ExecutionManager {
  constructor(store, { tmuxBin = TMUX_BIN, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.store = store;
    this.tmuxBin = tmuxBin;
    this.timeoutMs = timeoutMs;
  }

  getTask(taskId) { return this.store.getTask(taskId); }

  async cleanupOrphanedArtifacts() {
    const active = new Set(
      this.store.db.prepare("SELECT execution_session_id FROM tasks WHERE execution_status = 'running' AND execution_session_id IS NOT NULL")
        .all().map(row => `cos-exec-${String(row.execution_session_id).replace(/[^A-Za-z0-9_-]/g, '_')}`)
    );
    const entries = await fs.readdir('/tmp').catch(() => []);
    const stale = entries.filter(name => /^cos-exec-exec_[A-Za-z0-9_-]+\.(stdout|stderr|exit)$/.test(name));
    await Promise.all(stale.map(name => {
      const tmuxName = name.replace(/\.(stdout|stderr|exit)$/, '');
      return active.has(tmuxName) ? Promise.resolve() : fs.rm(`/tmp/${name}`, { force: true });
    }));
    return stale.filter(name => !active.has(name.replace(/\.(stdout|stderr|exit)$/, ''))).length;
  }

  async executeBatch(batchId, { timeoutMs = this.timeoutMs, cwd, env } = {}) {
    const batch = this.store.getExecutionBatch(batchId);
    if (!batch) throw new Error(`execution batch not found: ${batchId}`);
    if (['COMPLETED', 'CANCELLED'].includes(batch.status)) return { ...batch, items: this.store.listExecutionBatchItems(batchId) };
    if (batch.status === 'FAILED') this.store.prepareExecutionBatchRetry(batchId);
    const items = this.store.listExecutionBatchItems(batchId);
    if (!items.length) throw new Error(`execution batch has no items: ${batchId}`);
    validateExecutionBatch({
      batch_id: batchId,
      wait: 'all',
      tasks: items.map(item => ({ id: item.item_id, task_id: item.task_id, command: item.command, ...(item.cwd ? { cwd: item.cwd } : {}), ...(item.timeout_ms ? { timeout_ms: Number(item.timeout_ms) } : {}) }))
    });

    const runs = items.filter(item => item.status !== 'COMPLETED').map(async item => {
      this.store.markExecutionBatchItemRunning(batchId, item.item_id);
      try {
        const result = await this.executeTask(item.task_id, {
          command: item.command,
          timeoutMs: item.timeout_ms == null ? timeoutMs : Number(item.timeout_ms),
          cwd: cwd || item.cwd || process.cwd(),
          env
        });
        const task = this.getTask(item.task_id);
        const status = result.timedOut ? 'TIMEOUT' : result.exitCode === 0 ? 'COMPLETED' : 'FAILED';
        this.store.finishExecutionBatchItem(batchId, item.item_id, {
          executionSessionId: task?.execution_session_id || null,
          executionPid: task?.execution_pid || null,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          status,
          error: result.timedOut ? 'execution timeout' : result.exitCode === 0 ? null : `exit status ${result.exitCode}`
        });
        return result;
      } catch (error) {
        this.store.finishExecutionBatchItem(batchId, item.item_id, { status: 'FAILED', error: error.message });
        return { exitCode: null, stdout: '', stderr: error.message, timedOut: false, failedToStart: true };
      }
    });
    this.store.markExecutionBatchWaiting(batchId);
    await Promise.all(runs);
    const finalItems = this.store.listExecutionBatchItems(batchId);
    const resultItems = finalItems.map(i => ({
      id: i.item_id,
      task_id: i.task_id,
      command: i.command,
      status: i.status,
      exit_code: i.exit_code == null ? null : Number(i.exit_code),
      execution_session_id: i.execution_session_id || null,
      stdout: i.stdout || '',
      stderr: i.stderr || '',
      error: i.error || null
    }));
    const passed = resultItems.filter(i => i.status === 'COMPLETED' && i.exit_code === 0).length;
    const failed = resultItems.length - passed;
    const resultPayload = {
      batch_id: batchId,
      status: failed === 0 ? 'completed' : passed === 0 ? 'failed' : 'partial',
      summary: { total: resultItems.length, passed, failed },
      items: resultItems
    };
    validateExecutionResult(resultPayload);
    const aggregateContent = [
      '[ACTUAL EXECUTION BATCH EVIDENCE]',
      `batch_id: ${batchId}`,
      `status: ${resultPayload.status.toUpperCase()}`,
      `summary: total=${resultPayload.summary.total} passed=${resultPayload.summary.passed} failed=${resultPayload.summary.failed}`,
      `protocol_result_json: ${JSON.stringify(resultPayload)}`,
      ...resultItems.map(i => [
        `item_id: ${i.id}`,
        `task_id: ${i.task_id}`,
        `exact command: ${i.command}`,
        `execution_session_id: ${i.execution_session_id || 'N/A'}`,
        `exit status/code: ${i.exit_code == null ? 'N/A' : i.exit_code}`,
        `stdout:\n${i.stdout || ''}`,
        `stderr:\n${i.stderr || ''}`
      ].join('\n'))
    ].join('\n');
    return this.store.finishExecutionBatch(batchId, {
      status: resultPayload.status === 'completed' ? 'COMPLETED' : 'FAILED',
      aggregateContent
    });
  }

  async executeAuthorizedTask(taskId, { timeoutMs = this.timeoutMs, cwd, env } = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const metadata = JSON.parse(task.metadata_json || '{}');
    if (metadata.deterministic && metadata.executable) {
      if (metadata.executor !== 'ExecutionManager') throw new Error(`deterministic task ${taskId} has invalid executor`);
      if (!metadata.executable || !Array.isArray(metadata.args)) throw new Error(`structured execution contract required for task ${taskId}`);
      return this.executeStructuredTask(taskId, {
        executable: metadata.executable,
        args: metadata.args,
        timeoutMs,
        cwd: cwd || metadata.cwd || process.cwd(),
        env
      });
    }
    const command = String(metadata.command || task.description || '').trim();
    if (!command) throw new Error(`task ${taskId} has no execution command`);
    return this.executeTask(taskId, { command, timeoutMs, cwd: cwd || metadata.cwd || process.cwd(), env });
  }

  async executeStructuredTask(taskId, { executable, args = [], timeoutMs = this.timeoutMs, cwd = process.cwd(), env = {} } = {}) {
    const exactExecutable = String(executable || '').trim();
    if (!exactExecutable || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
      throw new Error(`invalid structured execution contract for task ${taskId}`);
    }
    const command = structuredCommand(exactExecutable, args);
    if (!/^[A-Za-z0-9_.+-]+$/.test(exactExecutable)) throw new Error(`unsupported deterministic executable: ${exactExecutable}`);
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.execution_status === 'running') throw new Error(`task already executing: ${taskId}`);
    if (task.execution_status === 'completed' && task.execution_exit_code === 0) return task;
    const nextAttempt = Number(task.execution_attempt || 0) + 1;
    const executionSessionId = id('exec');
    const tmuxName = `cos-exec-${executionSessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const startedAt = new Date().toISOString();
    this.store.prepareExecution(taskId, { executionSessionId, attempt: nextAttempt, command, cwd, startedAt, tmuxName });
    const script = `cd ${shellQuote(cwd)} && env ${Object.entries(env).map(([k,v]) => `${shellQuote(k)}=${shellQuote(v)}`).join(' ')} ${command} > ${shellQuote(`/tmp/${tmuxName}.stdout`)} 2> ${shellQuote(`/tmp/${tmuxName}.stderr`)}; printf '%s' $? > ${shellQuote(`/tmp/${tmuxName}.exit`)}`;
    try {
      await run(this.tmuxBin, ['new-session', '-d', '-s', tmuxName, 'bash', '-lc', script], { timeoutMs: 10000 });
      const pid = await run(this.tmuxBin, ['display-message', '-p', '-t', `${tmuxName}:0`, '#{pane_pid}'], { timeoutMs: 5000 });
      if (/^\d+$/.test(pid.stdout.trim())) this.store.setExecutionPid(taskId, Number(pid.stdout.trim()));
      const started = Date.now();
      let exitCode = null;
      while (Date.now() - started < timeoutMs) {
        const value = await fs.readFile(`/tmp/${tmuxName}.exit`, 'utf8').catch(() => '');
        if (/^-?\d+$/.test(value.trim())) { exitCode = Number(value.trim()); break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (exitCode === null) {
        await run(this.tmuxBin, ['kill-session', '-t', tmuxName], { timeoutMs: 5000 }).catch(() => {});
        return await this.collect(taskId, { executionSessionId, attempt: nextAttempt, command, exitCode: null, timeout: true });
      }
      await run(this.tmuxBin, ['kill-session', '-t', tmuxName], { timeoutMs: 5000 }).catch(() => {});
      return await this.collect(taskId, { executionSessionId, attempt: nextAttempt, command, exitCode, timeout: false });
    } catch (error) {
      this.store.finishExecution(taskId, { executionSessionId, attempt: nextAttempt, command, exitCode: null, stdout: '', stderr: error.message, status: 'failed', error: error.message });
      throw error;
    }
  }

  async executeTask(taskId, { command, timeoutMs = this.timeoutMs, attempt = null, cwd = process.cwd(), env = {} } = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const exactCommand = String(command || task.metadata_json && JSON.parse(task.metadata_json || '{}').command || '').trim();
    if (!exactCommand) throw new Error(`deterministic command required for task ${taskId}`);
    if (!/^(?:node|npm|npx|git|python(?:3)?|bash|sh|pnpm|yarn)\b/.test(exactCommand)) throw new Error(`unsupported deterministic command: ${exactCommand}`);
    if (task.execution_status === 'running') throw new Error(`task already executing: ${taskId}`);
    if (['completed'].includes(task.execution_status) && task.execution_exit_code === 0) return task;

    const nextAttempt = attempt == null ? Number(task.execution_attempt || 0) + 1 : Number(attempt);
    const executionSessionId = id('exec');
    const tmuxName = `cos-exec-${executionSessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const startedAt = new Date().toISOString();
    this.store.prepareExecution(taskId, { executionSessionId, attempt: nextAttempt, command: exactCommand, cwd, startedAt, tmuxName });
    const script = `cd ${shellQuote(cwd)} && env ${Object.entries(env).map(([k,v]) => `${shellQuote(k)}=${shellQuote(v)}`).join(' ')} ${exactCommand} > ${shellQuote(`/tmp/${tmuxName}.stdout`)} 2> ${shellQuote(`/tmp/${tmuxName}.stderr`)}; printf '%s' $? > ${shellQuote(`/tmp/${tmuxName}.exit`)}`;
    try {
      await run(this.tmuxBin, ['new-session', '-d', '-s', tmuxName, 'bash', '-lc', script], { timeoutMs: 10000 });
      const pid = await run(this.tmuxBin, ['display-message', '-p', '-t', `${tmuxName}:0`, '#{pane_pid}'], { timeoutMs: 5000 });
      if (/^\d+$/.test(pid.stdout.trim())) this.store.setExecutionPid(taskId, Number(pid.stdout.trim()));
      const started = Date.now();
      let exitCode = null;
      while (Date.now() - started < timeoutMs) {
        const value = await fs.readFile(`/tmp/${tmuxName}.exit`, 'utf8').catch(() => '');
        if (/^-?\d+$/.test(value.trim())) { exitCode = Number(value.trim()); break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (exitCode === null) {
        await run(this.tmuxBin, ['kill-session', '-t', tmuxName], { timeoutMs: 5000 }).catch(() => {});
        const timeout = await this.collect(taskId, { executionSessionId, attempt: nextAttempt, command: exactCommand, timeout: true });
        return timeout;
      }
      await run(this.tmuxBin, ['kill-session', '-t', tmuxName], { timeoutMs: 5000 }).catch(() => {});
      return await this.collect(taskId, { executionSessionId, attempt: nextAttempt, command: exactCommand, exitCode, timeout: false });
    } catch (error) {
      this.store.finishExecution(taskId, { executionSessionId, attempt: nextAttempt, command: exactCommand, exitCode: null, stdout: '', stderr: error.message, status: 'failed', error: error.message });
      throw error;
    }
  }

  async collect(taskId, { executionSessionId, attempt, command, exitCode = null, timeout = false }) {
    const tmuxName = `cos-exec-${executionSessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const [stdoutText, stderrText] = await Promise.all([
      fs.readFile(`/tmp/${tmuxName}.stdout`, 'utf8').catch(() => ''),
      fs.readFile(`/tmp/${tmuxName}.stderr`, 'utf8').catch(() => '')
    ]);
    const result = this.store.finishExecution(taskId, {
      executionSessionId, attempt, command, exitCode,
      stdout: stdoutText, stderr: stderrText,
      status: timeout ? 'timeout' : exitCode === 0 ? 'completed' : 'failed',
      error: timeout ? 'execution timeout' : null
    });
    await Promise.all([
      fs.rm(`/tmp/${tmuxName}.stdout`, { force: true }),
      fs.rm(`/tmp/${tmuxName}.stderr`, { force: true }),
      fs.rm(`/tmp/${tmuxName}.exit`, { force: true })
    ]);
    return { ...result, command, exitCode, stdout: stdoutText, stderr: stderrText, timedOut: timeout };
  }
}

export { shellQuote };
