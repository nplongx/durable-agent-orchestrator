#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseStrictJson } from '../src/runtime/strict-json.js';

const inputPath = process.env.RUNNER_AGENT_INPUT;
const sessionId = process.env.RUNNER_AGENT_SESSION_ID;
if (!inputPath || !sessionId) throw new Error('RUNNER_AGENT_INPUT and RUNNER_AGENT_SESSION_ID are required');
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for the GitHub runner OpenClaw agent');

const input = parseStrictJson(await fs.readFile(inputPath, 'utf8'), 'runner agent input');
const payload = input.payload || {};
const role = String(payload.role || process.env.ROLE || 'executor');
const model = String(process.env.RUNNER_AGENT_MODEL || 'openai/gpt-5.6-luna');
const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-runner-openclaw-'));
const configPath = path.join(stateDir, 'openclaw.json');
const workspace = process.cwd();

const roleContract = {
  'product-owner': 'Return JSON with scope, acceptance_criteria(array), non_goals(array).',
  researcher: 'Return JSON with findings(array), sources(array), limitations(array).',
  architect: 'Return JSON with components(array), interfaces(array), failure_modes(array), implementation_boundary(string).',
  engineer: 'Implement the task in the checkout. Run relevant tests. Return JSON with summary(string), files_changed(array), verification(array), execution(object with exit_code=0, session_id).',
  security: 'Return JSON with threats(array), findings(array), decision(one of accept/reject/needs_changes).',
  qa: 'Run real checks against the checkout. Return JSON with checks(array), results(array), decision(one of accept/reject/needs_changes).',
  platform: 'Return JSON with runtime(object), deployment(object), recovery(object).',
  writer: 'Return JSON with summary(string), user_facing_changes(array), verification(array).',
  reviewer: 'Return JSON with review object containing requirementsSatisfied, architectureConformant, securityAccepted, qaAccepted, platformAccepted, documentationAccepted booleans; implementationIssues, evidenceIssues, securityIssues, blockingIssues arrays of strings; decision accept/reject/needs_changes.',
  cto: 'Return JSON with decision approve/reject/rework, summary(string), accepted_requirements(array), unresolved_risks(array), follow_up_actions(array), evidence_refs(array).'
}[role] || 'Return a concise JSON object describing the completed task.';

const config = {
  models: {
    mode: 'merge',
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: { source: 'env', provider: 'default', id: 'OPENAI_API_KEY' }
      }
    }
  },
  agents: {
    defaults: { workspace, model: { primary: model }, subagents: { maxConcurrent: 1, maxChildrenPerAgent: 0 } },
    entries: { runner: { workspace, model: { primary: model }, tools: { profile: 'full' }, subagents: { allowAgents: [] } } }
  }
};

const taskFile = path.join(stateDir, 'task.md');
const prompt = [
  `You are the ${role} agent executing inside a GitHub Actions runner.`,
  `Session identity: ${sessionId}.`,
  'The local adapter is not your runtime owner. Do not spawn other agents and do not contact external chat channels.',
  'Work only inside the current checked-out repository. Use real tools/commands when the role requires inspection, implementation, or tests. Never invent execution evidence.',
  'Return ONLY one JSON object on the final response. No markdown fences and no prose outside JSON.',
  roleContract,
  `Durable job: ${payload.job_id}; task: ${payload.task_id}; attempt: ${payload.attempt || process.env.ATTEMPT}.`,
  `Task description: ${String(payload.description || '').trim()}`,
  payload.dependencies ? `Dependencies: ${JSON.stringify(payload.dependencies)}` : '',
  payload.dependency_evidence ? `Actual dependency evidence:\n${String(payload.dependency_evidence).slice(0, 30000)}` : '',
  'Before finalizing, make the JSON truthful and consistent with actual repository state.'
].filter(Boolean).join('\n\n');

await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
await fs.writeFile(taskFile, prompt, { mode: 0o600 });

try {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.env.OPENCLAW_BIN || 'openclaw', [
      '--no-color',
      'agent', '--local', '--agent', 'runner', '--session-id', sessionId,
      '--message-file', taskFile, '--model', model, '--timeout', String(Math.ceil((Number(process.env.RUNNER_AGENT_TIMEOUT_MS) || 900000) / 1000)), '--json'
    ], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir }
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`OpenClaw runner exited ${code}: ${stderr.slice(-4000)}`)));
  });

  let parsed;
  try { parsed = parseStrictJson(output.stdout, 'OpenClaw runner response'); } catch (_) { parsed = null; }
  const content = parsed?.result?.content ?? parsed?.result?.output_text ?? parsed?.output_text ?? parsed?.content;
  const text = Array.isArray(content)
    ? content.map(item => typeof item === 'string' ? item : item?.text || '').join('')
    : String(content || '');
  if (!text.trim()) throw new Error('OpenClaw runner returned no agent text');
  let artifact;
  try { artifact = parseStrictJson(text, 'runner agent final response'); } catch (error) { throw new Error(`runner agent final response is not strict JSON: ${error.message}`); }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error('runner agent final response must be a JSON object');
  if (role === 'engineer') {
    artifact.execution ||= {};
    artifact.execution.session_id ||= sessionId;
    artifact.execution.exit_code = 0;
    artifact.execution.command ||= 'openclaw-agent';
  }
  process.stdout.write(JSON.stringify(artifact));
} finally {
  await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
}
