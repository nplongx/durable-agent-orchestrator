import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateExecutionRequest, validateExecutionResult } from './execution-contract.js';

const API_VERSION = '2026-03-10';
const DEFAULT_API = 'https://api.github.com';
const DEFAULT_WORKFLOW = 'p2-provider-smoke.yml';
const DEFAULT_REF = 'main';

function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`GitHubActionsProvider: ${field} is required`);
  return value;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function run(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

export class GitHubActionsProvider {
  constructor({
    token = process.env.GITHUB_ACTIONS_TOKEN || process.env.GITHUB_TOKEN,
    owner = process.env.GITHUB_REPOSITORY_OWNER,
    repo = process.env.GITHUB_REPOSITORY_NAME,
    repository = process.env.GITHUB_REPOSITORY,
    apiBase = DEFAULT_API,
    workflow = DEFAULT_WORKFLOW,
    ref = DEFAULT_REF,
    fetchImpl = globalThis.fetch,
    store = null,
    artifactDownloader = null,
    now = () => Date.now()
  } = {}) {
    this.token = token;
    const [repoOwner, repoName] = String(repository || '').split('/');
    this.owner = owner || repoOwner;
    this.repo = repo || repoName;
    this.apiBase = String(apiBase).replace(/\/$/, '');
    this.workflow = workflow;
    this.ref = ref;
    this.fetch = fetchImpl;
    this.store = store;
    this.artifactDownloader = artifactDownloader;
    this.now = now;
    if (!this.fetch) throw new Error('GitHubActionsProvider: fetch is unavailable');
    required(this.owner, 'owner');
    required(this.repo, 'repo');
    required(this.token, 'token');
    this.ensureSchema();
  }

  ensureSchema() {
    this.store?.db?.exec(`
      CREATE TABLE IF NOT EXISTS provider_runs (
        provider_run_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        input_commit TEXT NOT NULL,
        workflow TEXT NOT NULL,
        ref TEXT NOT NULL,
        state TEXT NOT NULL,
        conclusion TEXT,
        html_url TEXT,
        artifact_id TEXT,
        output_commit TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_runs_task ON provider_runs(task_id, attempt);
    `);
  }

  headers() {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': API_VERSION,
      'user-agent': 'durable-agent-orchestrator/github-actions-provider'
    };
  }

  async request(method, pathname, body = undefined) {
    const response = await this.fetch(`${this.apiBase}${pathname}`, {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!response.ok) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      const error = new Error(`GitHub API ${response.status}: ${detail}`);
      error.status = response.status;
      error.response = data;
      throw error;
    }
    return data;
  }

  _persist(run) {
    if (!this.store?.db) return;
    const ts = new Date(this.now()).toISOString();
    this.store.db.prepare(`INSERT INTO provider_runs
      (provider_run_id,provider,job_id,task_id,lease_id,attempt,input_commit,workflow,ref,state,conclusion,html_url,artifact_id,output_commit,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider_run_id) DO UPDATE SET state=excluded.state, conclusion=excluded.conclusion,
      html_url=excluded.html_url, artifact_id=excluded.artifact_id, output_commit=excluded.output_commit, updated_at=excluded.updated_at`)
      .run(run.provider_run_id, 'github-actions', run.job_id, run.task_id, run.lease_id, run.attempt, run.input_commit,
        run.workflow, run.ref, run.state, run.conclusion || null, run.html_url || null, run.artifact_id || null,
        run.output_commit || null, run.created_at || ts, ts);
  }

  _getPersisted(providerRunId) {
    return this.store?.db?.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(String(providerRunId)) || null;
  }

  async dispatch(request) {
    validateExecutionRequest(request);
    const body = {
      ref: this.ref,
      inputs: {
        job_id: request.job_id,
        task_id: request.task_id,
        lease_id: request.lease_id,
        attempt: String(request.attempt),
        input_commit: request.input_commit
      }
    };
    const data = await this.request('POST', `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/workflows/${encodeURIComponent(this.workflow)}/dispatches`, body);
    if (!data?.workflow_run_id) {
      throw new Error('GitHub dispatch succeeded but response did not include workflow_run_id');
    }
    const run = {
      provider_run_id: String(data.workflow_run_id), job_id: request.job_id, task_id: request.task_id,
      lease_id: request.lease_id, attempt: request.attempt, input_commit: request.input_commit,
      workflow: this.workflow, ref: this.ref, state: 'QUEUED', conclusion: null,
      html_url: data.html_url || data.run_url || null, created_at: new Date(this.now()).toISOString()
    };
    this._persist(run);
    return run;
  }

  async getStatus(providerRunId) {
    required(providerRunId, 'providerRunId');
    const data = await this.request('GET', `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/runs/${encodeURIComponent(providerRunId)}`);
    const state = data.status === 'completed' ? 'COMPLETED' : 'RUNNING';
    const normalized = {
      provider_run_id: String(data.id), state,
      conclusion: data.conclusion || null,
      status: data.status,
      html_url: data.html_url || null,
      head_sha: data.head_sha || null,
      run_attempt: data.run_attempt || 1,
      created_at: data.created_at || null,
      started_at: data.run_started_at || null,
      updated_at: data.updated_at || null
    };
    const persisted = this._getPersisted(providerRunId);
    this._persist({ ...(persisted || {}), provider_run_id: String(data.id), job_id: persisted?.job_id || '', task_id: persisted?.task_id || '', lease_id: persisted?.lease_id || '', attempt: persisted?.attempt || Number(data.run_attempt || 1), input_commit: persisted?.input_commit || data.head_sha || '', workflow: persisted?.workflow || this.workflow, ref: persisted?.ref || this.ref, state, conclusion: normalized.conclusion, html_url: normalized.html_url, created_at: persisted?.created_at || data.created_at });
    return normalized;
  }

  async _downloadArtifact(artifact) {
    if (this.artifactDownloader) return this.artifactDownloader(artifact, this.headers());
    const response = await this.fetch(artifact.archive_download_url, { headers: this.headers() });
    if (!response.ok) throw new Error(`GitHub artifact download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gha-artifact-'));
    const zip = path.join(dir, 'artifact.zip');
    await fs.writeFile(zip, buffer);
    try {
      const result = await run('unzip', ['-o', zip, '-d', dir]);
      if (result.code !== 0) throw new Error(`unzip failed: ${result.stderr || result.stdout}`);
      const candidates = [path.join(dir, 'result.json'), path.join(dir, '.p2-provider', 'result.json'), path.join(dir, '.p1-smoke', 'result.json')];
      for (const file of candidates) {
        try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
      }
      throw new Error('provider artifact does not contain result.json');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async collectResult(providerRunId) {
    const status = await this.getStatus(providerRunId);
    if (status.state !== 'COMPLETED') throw new Error(`provider run ${providerRunId} is not completed: ${status.status}`);
    const artifacts = await this.request('GET', `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/runs/${encodeURIComponent(providerRunId)}/artifacts?per_page=100`);
    const artifact = artifacts?.artifacts?.find(item => !item.expired && /^p2-provider-/.test(item.name))
      || artifacts?.artifacts?.find(item => !item.expired && /result/.test(item.name));
    if (!artifact) throw new Error(`provider run ${providerRunId} has no result artifact`);
    const raw = await this._downloadArtifact(artifact);
    const persisted = this._getPersisted(providerRunId);
    const result = {
      ...raw,
      provider_run_id: String(providerRunId),
      job_id: raw.job_id || persisted?.job_id,
      task_id: raw.task_id || persisted?.task_id,
      lease_id: raw.lease_id || persisted?.lease_id,
      attempt: raw.attempt || persisted?.attempt,
      input_commit: raw.input_commit || persisted?.input_commit,
      evidence_artifact: raw.evidence_artifact || artifact.name,
      evidence_refs: Array.isArray(raw.evidence_refs) ? raw.evidence_refs : [artifact.archive_download_url]
    };
    validateExecutionResult(result);
    this._persist({ ...(persisted || {}), provider_run_id: String(providerRunId), job_id: result.job_id, task_id: result.task_id, lease_id: result.lease_id, attempt: result.attempt, input_commit: result.input_commit, workflow: persisted?.workflow || this.workflow, ref: persisted?.ref || this.ref, state: 'COMPLETED', conclusion: status.conclusion, html_url: status.html_url, artifact_id: String(artifact.id), output_commit: result.output_commit || null, created_at: persisted?.created_at || status.created_at });
    return result;
  }

  async cancel(providerRunId) {
    required(providerRunId, 'providerRunId');
    await this.request('POST', `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/runs/${encodeURIComponent(providerRunId)}/cancel`);
    return this.getStatus(providerRunId);
  }

  async wait(providerRunId, { intervalMs = 2000, timeoutMs = 300000 } = {}) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const status = await this.getStatus(providerRunId);
      if (status.state === 'COMPLETED') return status;
      await sleep(intervalMs);
    }
    throw new Error(`provider run ${providerRunId} status polling timed out`);
  }
}
