#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(repoRoot, 'docs', 'MCP_REFERENCE.md');
const checkOnly = process.argv.includes('--check');
const childTimeoutMs = 15_000;

function escMarkdown(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').trim();
}

function typeName(schema = {}) {
  if (schema.type) return schema.type;
  if (Array.isArray(schema.enum)) return 'enum';
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) return 'union';
  if (schema.$ref) return schema.$ref;
  return 'any';
}

function schemaConstraints(schema = {}) {
  const parts = [];
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'format']) {
    if (schema[key] !== undefined) parts.push(`${key}: \`${escMarkdown(schema[key])}\``);
  }
  if (schema.enum) parts.push(`enum: ${schema.enum.map((item) => `\`${escMarkdown(item)}\``).join(', ')}`);
  if (schema.default !== undefined) parts.push(`default: \`${escMarkdown(JSON.stringify(schema.default))}\``);
  if (schema.uniqueItems === true) parts.push('unique items');
  if (schema.additionalProperties === false) parts.push('no additional properties');
  if (schema.items) parts.push(`items: ${typeName(schema.items)}`);
  if (schema.required?.length) parts.push(`required fields: ${schema.required.map((item) => `\`${escMarkdown(item)}\``).join(', ')}`);
  return parts.join('; ') || '—';
}

function renderReference(mcp) {
  const tools = mcp?.result?.tools;
  const version = mcp?.initialize?.result?.serverInfo?.version ?? 'unknown';
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('MCP tools/list returned no tools');

  const names = new Set();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || names.has(tool.name)) {
      throw new Error('MCP tools/list returned a malformed or duplicate tool name');
    }
    names.add(tool.name);
    if (!tool.inputSchema || tool.inputSchema.type !== 'object') {
      throw new Error(`Tool ${tool.name} does not expose an object input schema`);
    }
  }

  const lines = [
    '# MCP tool reference',
    '',
    'This page is generated from the shipped stdio MCP server by the documentation generator. It describes registered tool names and input schemas returned by `tools/list`; it does not claim that every tool is safe in every workflow state. Follow the linked guides for lifecycle preconditions, permissions, evidence rules, and limitations.',
    '',
    '- Source: `server/index.js` and its runtime schema definitions.',
    '- Server identity reported by the checked-out source: `' + escMarkdown(mcp.initialize.result.serverInfo.name) + '`.',
    '- Source package version reported at generation time: `' + escMarkdown(version) + '`. This is source-runtime metadata, not proof of which bundle is installed in a client.',
    `- Registered tools: **${tools.length}**.`,
    '',
    '## Choosing the right operation',
    '',
    '- Use `workflow_catalog` to discover available built-in templates.',
    '- Use `workflow_create` to make a proposal; it does not authorize execution.',
    '- Explicitly approve the inspected proposal with `workflow_approve` before dispatch.',
    '- Use `workflow_get`, `workflow_events`, `workflow_artifacts`, and `workflow_diagnose` to inspect durable state and investigate blocked work.',
    '- The local dashboard is read-only; use MCP workflow tools for approved mutations.',
    '- Tool schema validity is not permission to bypass approval, immutable-plan, artifact-provenance, or success-evaluation gates.',
    '',
    '## Tool index',
    '',
    '| Tool | Purpose | Required inputs |',
    '|---|---|---|',
  ];

  for (const tool of tools) {
    const schema = tool.inputSchema;
    const required = new Set(schema.required ?? []);
    const requiredInputs = [...required].map((name) => `\`${name}\``).join(', ') || 'None';
    lines.push(`| [\`${escMarkdown(tool.name)}\`](#${tool.name.toLowerCase().replace(/[^a-z0-9_\s-]/g, '').replace(/\s+/g, '-')}) | ${escMarkdown(tool.description || 'No description provided by the server schema.')} | ${requiredInputs} |`);
  }

  lines.push('', '## Tool schemas', '', 'The expandable schema block under each tool contains the exact JSON Schema returned by the server. Input schemas describe shape and constraints; runtime state, authorization, and evidence checks are enforced separately.', '');

  for (const tool of tools) {
    const schema = tool.inputSchema;
    const required = new Set(schema.required ?? []);
    const properties = schema.properties ?? {};
    lines.push(`### \`${tool.name}\``, '', escMarkdown(tool.description || 'No description provided by the server schema.'), '');

    if (Object.keys(properties).length > 0) {
      lines.push('| Input | Type | Required | Description | Constraints |', '|---|---|---|---|---|');
      for (const [name, propertySchema] of Object.entries(properties)) {
        lines.push(`| \`${escMarkdown(name)}\` | \`${escMarkdown(typeName(propertySchema))}\` | ${required.has(name) ? 'Yes' : 'No'} | ${escMarkdown(propertySchema.description || '—')} | ${schemaConstraints(propertySchema)} |`);
      }
      lines.push('');
    } else {
      lines.push('This tool accepts no named input properties.', '');
    }

    lines.push('<details>', '<summary>Full input schema (JSON)</summary>', '', '```json', JSON.stringify(schema, null, 2), '```', '', '</details>', '');
  }

  lines.push(
    '## Related guides',
    '',
    '- [Quickstart](quickstart.md)',
    '- [Durable batch execution](batch-execution.md)',
    '- [Workflow policy packs](workflow-policies.md)',
    '- [Agent Skills](agent-skills.md)',
    '- [Local dashboard](local-dashboard.md)',
    '- [Architecture](architecture.md)',
    '- [Terminology and compatibility exceptions](TERMINOLOGY.md)',
    ''
  );
  // Keep exactly one terminal newline even though individual Markdown sections
  // are separated by blank lines in the `lines` array.
  return `${lines.join('\n').replace(/\n+$/g, '')}\n`;
}

async function readToolList() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'orchestrator-docs-mcp-'));
  const entrypoint = path.join(repoRoot, 'server', 'index.js');
  const payload = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'docs-reference-generator', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';

  try {
    const childOutput = await new Promise((resolve, reject) => {
      const isolatedDbPath = path.join(dataDir, 'workflow.db');
      const isolatedWorkspace = path.join(dataDir, 'workspace');
      const isolatedExecutionTmp = path.join(dataDir, 'execution-tmp');
      const child = spawn(process.execPath, [entrypoint], {
        cwd: repoRoot,
        // Explicitly override both current and compatibility environment names.
        // A developer/CI shell may already point these variables at a real local
        // database or workspace; spreading process.env without replacing each
        // override could initialize or mutate that unrelated database during a
        // documentation check.
        env: {
          ...process.env,
          CHAT_ON_STEROIDS_DATA_DIR: dataDir,
          WORKFLOW_DATA_DIR: dataDir,
          CHAT_ON_STEROIDS_WORKFLOW_DB: isolatedDbPath,
          WORKFLOW_DB: isolatedDbPath,
          CHAT_ON_STEROIDS_WORKSPACE: isolatedWorkspace,
          WORKFLOW_WORKSPACE: isolatedWorkspace,
          CHAT_ON_STEROIDS_EXECUTION_TMP_DIR: isolatedExecutionTmp,
          EXECUTION_TMP_DIR: isolatedExecutionTmp,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`MCP reference generator timed out after ${childTimeoutMs} ms`));
      }, childTimeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`MCP server exited ${code ?? signal}: ${stderr.slice(-3000)}`));
          return;
        }
        resolve(stdout);
      });
      child.stdin.end(payload);
    });

    const messages = childOutput.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (error) {
        throw new Error(`MCP server emitted a non-JSON stdout frame: ${String(error)}; output=${line.slice(0, 300)}`);
      }
    });
    const initialize = messages.find((message) => message.id === 1 && message.result);
    const list = messages.find((message) => message.id === 2 && message.result);
    if (!initialize || !list) throw new Error('MCP server did not return initialize and tools/list responses');
    return { initialize, result: list.result };
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const mcp = await readToolList();
  const expected = renderReference(mcp);

  if (checkOnly) {
    let actual;
    try { actual = await readFile(outputPath, 'utf8'); } catch {
      throw new Error('docs/MCP_REFERENCE.md is missing; run npm run docs:generate-reference');
    }
    if (actual !== expected) {
      throw new Error('docs/MCP_REFERENCE.md is stale versus the shipped MCP tools/list output; run npm run docs:generate-reference and review the diff');
    }
    console.log(`MCP reference check passed: ${mcp.result.tools.length} registered tools match docs/MCP_REFERENCE.md (source package ${mcp.initialize.result.serverInfo.version}).`);
    return;
  }

  await writeFile(outputPath, expected, 'utf8');
  console.log(`Wrote ${path.relative(repoRoot, outputPath)} from ${mcp.result.tools.length} registered MCP tools (source package ${mcp.initialize.result.serverInfo.version}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
