import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WORKSPACE = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const PRODUCTION_QA_SUCCESS_MARKERS = Object.freeze([
  'PRODUCTION QA MCP INITIALIZE/50-TOOL DISCOVERY PASS',
  'PRODUCTION QA BEHAVIORAL ARTIFACT VALIDATION PASS',
  'PRODUCTION QA APPROVAL/DISPATCH/IMMUTABLE-PLAN NEXT-TASK PASS'
]);
// Deliberately checked in, not computed-and-trusted from the current bytes.
// Update this pin only alongside a reviewed source change and successor package.
export const PRODUCTION_QA_HARNESS_SHA256 = '4b0d3489b7ebd70e927ba21daeca501c4143c634ca9fcf3a95dbcf0f099b795f';

function resolvePluginRoot() {
  // Source checkout layout: src/runtime/workflow/catalog -> repository root
  // Packaged layout: runtime/workflow/catalog -> MCP bundle root.
  for (const relative of ['../../../', '../../../../']) {
    const root = path.resolve(MODULE_DIR, relative);
    const serverPath = path.join(root, 'server', 'index.js');
    const testPath = path.join(root, 'tests', 'test-production-behavioral-qa.js');
    const serverStat = fs.lstatSync(serverPath, { throwIfNoEntry: false });
    const testStat = fs.lstatSync(testPath, { throwIfNoEntry: false });
    if (serverStat?.isFile() && !serverStat.isSymbolicLink() && testStat?.isFile() && !testStat.isSymbolicLink() &&
        fs.realpathSync(serverPath) === serverPath && fs.realpathSync(testPath) === testPath) return root;
  }
  throw new Error('production behavioral QA harness is missing from the local plugin source/package');
}

const PLUGIN_ROOT = resolvePluginRoot();

function readQaHarnessBytes() {
  const file = path.join(PLUGIN_ROOT, 'tests', 'test-production-behavioral-qa.js');
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(handle, { bigint: true });
    if (!before.isFile() || before.size > 256n * 1024n) throw new Error('production behavioral QA harness is not a bounded regular file');
    const bytes = fs.readFileSync(handle);
    const after = fs.fstatSync(handle, { bigint: true });
    const entry = fs.lstatSync(file, { bigint: true });
    if (entry.isSymbolicLink() || fs.realpathSync(file) !== file || !entry.isFile() ||
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        entry.dev !== after.dev || entry.ino !== after.ino || BigInt(bytes.length) !== after.size) {
      throw new Error('production behavioral QA harness changed during identity-anchored read');
    }
    return bytes;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function currentQaHarnessSha256() {
  return crypto.createHash('sha256').update(readQaHarnessBytes()).digest('hex');
}

function assertQaHarnessIntegrity() {
  const actual = currentQaHarnessSha256();
  if (!/^[a-f0-9]{64}$/.test(PRODUCTION_QA_HARNESS_SHA256) || actual !== PRODUCTION_QA_HARNESS_SHA256) {
    throw new Error(`production behavioral QA harness SHA-256 mismatch: actual=${actual}; expected=${PRODUCTION_QA_HARNESS_SHA256}`);
  }
  return actual;
}

export const ProductionTaskId = Object.freeze({
  ARCHITECT_CHECK: 'architect-check',
  QA_CHECK: 'qa-check',
  CTO_SYNTHESIS: 'cto-synthesis'
});

export const ProductionRoles = Object.freeze([
  'architect',
  'qa'
]);

function nodeCheckExecution(workspace, file) {
  const executable = 'node';
  const args = Object.freeze(['--check', path.join(workspace, file)]);
  return Object.freeze({
    executor: 'ExecutionManager',
    executable,
    args,
    command: [executable, ...args].join(' '),
    cwd: workspace,
    timeout_ms: 120000,
    deterministic: true
  });
}

function packagedBehavioralQaExecution() {
  const harnessSha256 = assertQaHarnessIntegrity();
  const executable = 'node';
  const args = Object.freeze([path.join(PLUGIN_ROOT, 'tests', 'test-production-behavioral-qa.js')]);
  return Object.freeze({
    executor: 'ExecutionManager',
    executable,
    args,
    command: [executable, ...args].join(' '),
    cwd: PLUGIN_ROOT,
    timeout_ms: 300000,
    deterministic: true,
    trusted_plugin_e2e: true,
    trusted_plugin_e2e_sha256: harnessSha256,
    required_success_markers: PRODUCTION_QA_SUCCESS_MARKERS
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function canonicalStructuredCommand(executable, args) {
  return [executable, ...args].map(shellQuote).join(' ');
}

export function assessProductionQaExecution({ plan, taskPlanId, metadata, stdout } = {}) {
  const planned = plan?.children?.find(item => item.id === taskPlanId);
  const expected = planned?.execution;
  const required_markers = Array.isArray(expected?.required_success_markers) ? [...expected.required_success_markers] : [];
  let runtimeHarnessIntegrity = false;
  try { runtimeHarnessIntegrity = currentQaHarnessSha256() === PRODUCTION_QA_HARNESS_SHA256; } catch {}
  const allowedCommands = Array.isArray(expected?.args)
    ? [expected.command, canonicalStructuredCommand(expected.executable, expected.args)]
    : [];
  const exactContract = plan?.workflow_id === 'production' && planned?.id === ProductionTaskId.QA_CHECK && planned?.role === 'qa' &&
    expected?.trusted_plugin_e2e === true && metadata?.trusted_plugin_e2e === true &&
    runtimeHarnessIntegrity && expected?.trusted_plugin_e2e_sha256 === PRODUCTION_QA_HARNESS_SHA256 &&
    metadata?.trusted_plugin_e2e_sha256 === expected.trusted_plugin_e2e_sha256 &&
    metadata?.workflow_plan_task_id === planned.id && metadata?.executor === 'ExecutionManager' &&
    metadata?.deterministic === true && metadata?.executable === expected.executable && allowedCommands.includes(metadata?.command) &&
    Array.isArray(metadata?.args) && JSON.stringify(metadata.args) === JSON.stringify(expected.args) &&
    path.resolve(String(metadata?.cwd || '')) === path.resolve(String(expected.cwd || '')) &&
    metadata?.timeout_ms === expected.timeout_ms &&
    JSON.stringify(metadata?.required_success_markers) === JSON.stringify(required_markers) &&
    required_markers.length === PRODUCTION_QA_SUCCESS_MARKERS.length &&
    required_markers.every((marker, index) => marker === PRODUCTION_QA_SUCCESS_MARKERS[index]);
  const output = typeof stdout === 'string' ? stdout : '';
  const observed_markers = required_markers.filter(marker => output.includes(marker));
  const missing_markers = required_markers.filter(marker => !output.includes(marker));
  return Object.freeze({
    trusted: exactContract,
    passed: exactContract && missing_markers.length === 0,
    required_markers,
    observed_markers,
    missing_markers
  });
}

export function productionTaskSpec(taskId, { workspace = process.env.WORKFLOW_WORKSPACE || DEFAULT_WORKSPACE } = {}) {
  if (!workspace) throw new Error(`workspace is required for task ${taskId}`);

  switch (taskId) {
    case ProductionTaskId.ARCHITECT_CHECK:
      return {
        id: taskId,
        role: 'architect',
        execution: nodeCheckExecution(workspace, 'server.js')
      };
    case ProductionTaskId.QA_CHECK:
      return {
        id: taskId,
        role: 'qa',
        // Do not run test-tool-turn.js here: it calls a live local HTTP service
        // and executes a returned shell command. QA instead executes the
        // bundled, isolated, no-network behavioral harness and only reports
        // acceptance when every required output marker is observed.
        execution: packagedBehavioralQaExecution()
      };
    case ProductionTaskId.CTO_SYNTHESIS:
      return {
        id: taskId,
        role: 'cto',
        execution: {
          executor: 'ChatOnSteroids',
          deterministic: false
        }
      };
    default:
      throw new Error(`unknown production task: ${taskId}`);
  }
}

export function productionChildTaskSpecs(workspace) {
  return ProductionRoles.map(role => {
    const taskId = role === 'architect'
      ? ProductionTaskId.ARCHITECT_CHECK
      : ProductionTaskId.QA_CHECK;
    return productionTaskSpec(taskId, { workspace });
  });
}
