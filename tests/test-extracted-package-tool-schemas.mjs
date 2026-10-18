import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const bundle = process.env.PHASE2_CANDIDATE_BUNDLE;
if (!bundle) throw new Error('PHASE2_CANDIDATE_BUNDLE must name the candidate package to inspect');
const bundlePath = path.resolve(root, bundle);
const allowExternalCandidate = process.env.PHASE2_ALLOW_EXTERNAL_CANDIDATE_BUNDLE === '1';
assert.ok(allowExternalCandidate || bundlePath.startsWith(`${root}${path.sep}`),
  'candidate bundle must remain inside the repository unless the package builder explicitly opts in for its private temporary archive');
const bundleStat = fs.lstatSync(bundlePath);
assert.ok(bundleStat.isFile() && !bundleStat.isSymbolicLink() && fs.realpathSync(bundlePath) === bundlePath,
  'candidate bundle must be a canonical regular file, never a symlink');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-extracted-tool-schemas-'));

try {
  const extracted = path.join(temp, 'runtime');
  fs.mkdirSync(extracted, { mode: 0o700 });
  const unpack = spawnSync('unzip', ['-q', bundlePath, '-d', extracted], { encoding: 'utf8' });
  assert.equal(unpack.status, 0, `candidate extraction failed: ${unpack.stderr}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'));
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(packageMetadata).sort(),
    ['description', 'engines', 'main', 'name', 'scripts', 'type', 'version'].sort(),
    'local-only package metadata must contain only the explicitly reviewed runtime fields');
  assert.equal(packageMetadata.main, 'server/index.js', 'packaged Node entry point must match the manifest');
  assert.equal(packageMetadata.type, 'module');
  assert.equal(packageMetadata.version, manifest.version, 'packaged package.json version must match the MCP manifest');
  assert.equal(packageMetadata.engines?.node, '>=22.13.0', 'packaged runtime must declare its actual built-in node:sqlite requirement');
  assert.equal(Object.hasOwn(packageMetadata, 'dependencies'), false,
    'the local-only package must not declare the LangGraph dependency used only by excluded full-app modules');
  assert.equal(Object.hasOwn(packageMetadata, 'devDependencies'), false,
    'the local-only package must not declare development dependencies outside its extracted runtime closure');
  assert.deepEqual(Object.keys(packageMetadata.scripts || {}).sort(), ['start', 'test'],
    'package scripts must only reference files present in the local runtime closure');
  const request = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase2-schema-contract', version: '1' }
    } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  const runtime = spawnSync(process.execPath, [path.join(extracted, 'server/index.js')], {
    cwd: extracted,
    input: request,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      OPENAI_API_KEY: '',
      CHAT_ON_STERIODS_DATA_DIR: path.join(temp, 'data'),
      CHAT_ON_STERIODS_WORKSPACE: extracted,
      CHAT_ON_STERIODS_DATA_DIR: path.join(temp, 'data'),
      WORKFLOW_DATA_DIR: path.join(temp, 'data'),
      WORKFLOW_DB: path.join(temp, 'data', 'workflow.db')
    }
  });
  assert.equal(runtime.status, 0, `extracted MCP runtime failed: ${runtime.stderr}\n${runtime.stdout}`);
  const lines = runtime.stdout.trim().split(/\r?\n/).map((line, index) => JSON.parse(line, (key, value) => value));
  assert.equal(lines.length, 2, 'extracted MCP runtime must answer initialize and tools/list exactly once');
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result?.serverInfo?.name, manifest.name);
  assert.equal(lines[0].result?.serverInfo?.version, manifest.version,
    'the actual extracted runtime serverInfo version must match both package metadata and manifest');
  assert.equal(lines[1].id, 2);
  const tools = lines[1].result?.tools;
  assert.ok(Array.isArray(tools), 'tools/list must return an array');
  assert.equal(tools.length, manifest.tools.length, 'runtime exposure count must match manifest declarations');
  assert.deepEqual(tools.map(tool => tool.name).sort(), manifest.tools.map(tool => tool.name).sort(),
    'runtime tool names must exactly match package manifest names');

  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.description, 'string');
    const schema = tool.inputSchema;
    assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${tool.name}: inputSchema must be an object`);
    assert.equal(schema.type, 'object', `${tool.name}: inputSchema must describe an object`);
    assert.equal(schema.additionalProperties, false,
      `${tool.name}: all public tool inputs must reject undocumented top-level properties`);
    assert.ok(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties),
      `${tool.name}: inputSchema.properties must be an object`);
    if (schema.required !== undefined) {
      assert.ok(Array.isArray(schema.required), `${tool.name}: inputSchema.required must be an array`);
      assert.equal(new Set(schema.required).size, schema.required.length, `${tool.name}: required fields must be unique`);
      for (const key of schema.required) {
        assert.ok(typeof key === 'string' && Object.hasOwn(schema.properties, key),
          `${tool.name}: required field ${String(key)} must be declared in properties`);
      }
    }
    assert.doesNotThrow(() => JSON.stringify(schema), `${tool.name}: inputSchema must be JSON-serializable`);
  }
  // Shape-only schema checks let a critical tool regress to an empty object
  // schema while still passing. Pin the contract-bearing fields for the
  // highest-impact state-changing tools in the exact extracted archive.
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const schemaFor = name => {
    const tool = byName.get(name);
    assert.ok(tool, `critical tool ${name} must be exposed by the extracted runtime`);
    return tool.inputSchema;
  };
  const assertRequired = (name, required) => {
    assert.deepEqual([...(schemaFor(name).required || [])].sort(), [...required].sort(),
      `${name}: required input contract must not be weakened`);
  };
  const workflowCreate = schemaFor('workflow_create');
  assertRequired('workflow_create', ['title', 'task']);
  assert.equal(workflowCreate.properties.title.type, 'string');
  assert.equal(workflowCreate.properties.title.maxLength, 180);
  assert.equal(workflowCreate.properties.task.type, 'string');
  assert.equal(workflowCreate.properties.task.maxLength, 12000);

  const workflowApprove = schemaFor('workflow_approve');
  assertRequired('workflow_approve', ['job_id', 'confirmation']);
  assert.equal(workflowApprove.properties.job_id.type, 'string');
  assert.equal(workflowApprove.properties.confirmation.minLength, 3);
  assert.equal(workflowApprove.properties.confirmation.maxLength, 2000);

  const executeLocal = schemaFor('task_execute_local');
  assertRequired('task_execute_local', ['task_id']);
  assert.equal(executeLocal.additionalProperties, false,
    'task_execute_local must reject caller-supplied fields outside its approved contract');
  assert.equal(executeLocal.properties.timeout_ms.type, 'integer');
  assert.equal(executeLocal.properties.timeout_ms.minimum, 1000);
  assert.equal(executeLocal.properties.timeout_ms.maximum, 600000);

  const completeTask = schemaFor('workflow_complete_task');
  assertRequired('workflow_complete_task', ['task_id', 'content', 'artifact']);
  assert.equal(completeTask.properties.content.type, 'string');
  assert.equal(completeTask.properties.content.maxLength, 1000000);

  const synthesis = schemaFor('workflow_complete_synthesis');
  assertRequired('workflow_complete_synthesis', ['job_id', 'content', 'artifact']);
  assert.equal(synthesis.properties.consumed_workspace_bytes.type, 'array');
  assert.equal(synthesis.properties.consumed_workspace_bytes.minItems, 2);
  assert.equal(synthesis.properties.consumed_workspace_bytes.maxItems, 2);
  assert.equal(synthesis.properties.consumed_workspace_bytes.items.additionalProperties, false);
  assert.deepEqual([...synthesis.properties.consumed_workspace_bytes.items.required].sort(), ['bytes', 'encoding', 'path', 'sha256'].sort());
  assert.deepEqual([...synthesis.properties.consumed_workspace_bytes.items.properties.path.enum].sort(), ['config.json', 'result.json']);
  assert.equal(synthesis.properties.consumed_workspace_bytes.items.properties.sha256.pattern, '^[a-f0-9]{64}$');
  assert.equal(synthesis.properties.consumed_workspace_bytes.items.properties.encoding.enum[0], 'base64');

  const customApprove = schemaFor('custom_workflow_approve');
  assertRequired('custom_workflow_approve', ['plan_id', 'confirmation']);
  assert.equal(customApprove.additionalProperties, false);
  assert.equal(customApprove.properties.plan_id.maxLength, 120);
  assert.equal(customApprove.properties.confirmation.maxLength, 2000);

  for (const name of ['custom_workflow_create', 'custom_workflow_update', 'custom_workflow_clone']) {
    const taskItems = schemaFor(name).properties.tasks?.items;
    assert.equal(taskItems?.type, 'object', `${name}: custom task list must declare an object schema for every task`);
    assert.equal(taskItems?.additionalProperties, false,
      `${name}: nested custom workflow tasks must reject fields outside the immutable task contract`);
    assert.deepEqual([...(taskItems.required || [])].sort(), ['id', 'role_id'].sort(),
      `${name}: task identity and pinned custom role must remain required`);
  }
  console.log(`EXTRACTED PACKAGE TOOL SCHEMAS PASS: ${tools.length}/${manifest.tools.length} tools; names match manifest and all schemas are valid serializable object contracts.`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
