import path from 'node:path';
import { StandardEngineeringTaskId as T } from '../definitions/standard-engineering.js';
import { getRoleContract } from '../roles.js';

const S = Object.freeze([
  { id: T.PRODUCT_OWNER, role: 'product-owner', dependencies: [] },
  { id: T.RESEARCHER, role: 'researcher', dependencies: [T.PRODUCT_OWNER] },
  { id: T.ARCHITECT, role: 'architect', dependencies: [T.PRODUCT_OWNER, T.RESEARCHER] },
  { id: T.ENGINEER, role: 'engineer', dependencies: [T.ARCHITECT] },
  { id: T.SECURITY, role: 'security', dependencies: [T.ENGINEER] },
  { id: T.QA, role: 'qa', dependencies: [T.ENGINEER] },
  { id: T.PLATFORM, role: 'platform', dependencies: [T.ENGINEER] },
  { id: T.WRITER, role: 'writer', dependencies: [T.ENGINEER] },
  { id: T.REVIEWER, role: 'reviewer', dependencies: [T.SECURITY, T.QA, T.PLATFORM, T.WRITER] }
]);

function taskSpec(spec, workspace) {
  const contract = getRoleContract(spec.role);
  return {
    id: spec.id,
    role: spec.role,
    capability: contract.capability,
    dependencies: [...spec.dependencies],
    execution: { executor: 'ChatOnSteroidsHost', deterministic: false, runtime_owner: 'chat-on-steroids-plugin', execution_mode: 'host-conversation', cwd: workspace || null, timeout_ms: 300_000 }
  };
}

const BATCH_VALIDATION_TASKS = Object.freeze([
  { id: 'standard-batch-test-execution-batch', role: 'batch-test-execution-batch', file: 'tests/test-execution-batch.js' },
  { id: 'standard-batch-test-execution-concurrency', role: 'batch-test-execution-concurrency', file: 'tests/test-execution-batch-concurrency.js' },
  { id: 'standard-batch-test-terminal-recovery', role: 'batch-test-terminal-recovery', file: 'tests/test-execution-batch-terminal-recovery.js' },
  { id: 'standard-batch-test-success-contract', role: 'batch-test-success-contract', file: 'tests/test-execution-success-contract.js' },
  { id: 'standard-batch-test-phase5-recovery', role: 'batch-test-phase5-recovery', file: 'tests/test-phase5-recovery.js' },
  { id: 'standard-batch-test-agent-tool-guidance', role: 'batch-test-agent-tool-guidance', file: 'tests/test-agent-tool-guidance.js' },
  { id: 'standard-batch-test-process-boundary', role: 'batch-test-process-boundary', file: 'tests/test-execution-control-process-boundary.js' },
  { id: 'standard-batch-test-package-no-overwrite', role: 'batch-test-package-no-overwrite', file: 'tests/test-package-no-overwrite.js' },
  { id: 'standard-batch-test-package-reproducibility', role: 'batch-test-package-reproducibility', file: 'tests/test-package-reproducibility.js' },
  { id: 'standard-batch-test-verified-result-atomicity', role: 'batch-test-verified-result-atomicity', file: 'tests/test-verified-execution-result-atomicity.js' },
  { id: 'standard-batch-test-standard-engineering-planner', role: 'batch-test-standard-engineering-planner', file: 'tests/test-standard-engineering-workflow.js' }
]);

export function standardEngineeringValidationTaskSpecs(workspace = process.env.WORKFLOW_WORKSPACE || process.cwd()) {
  const cwd = path.resolve(workspace || process.cwd());
  return BATCH_VALIDATION_TASKS.map(spec => {
    const args = ['--test', path.resolve(cwd, spec.file)];
    return {
      id: spec.id, role: spec.role, capability: null, dependencies: [T.ENGINEER],
      execution: {
        executor: 'ExecutionManager', executable: 'node', args, command: ['node', ...args].join(' '),
        cwd, timeout_ms: 300_000, deterministic: true, batch_validation_task: true, output_artifact_type: 'qa-report'
      }
    };
  });
}

export function standardEngineeringTaskSpecs(workspace = process.env.WORKFLOW_WORKSPACE || process.cwd(), { includeBatchValidation = false, validationTasks = null } = {}) {
  if (validationTasks != null && includeBatchValidation) throw new Error('explicit validation profile tasks cannot be combined with the legacy batch validation set');
  const selectedValidationTasks = validationTasks == null
    ? (includeBatchValidation ? standardEngineeringValidationTaskSpecs(workspace) : [])
    : validationTasks;
  const validationIds = selectedValidationTasks.map(task => task.id);
  const specialistTasks = S.map(spec => {
    const needsBatchValidation = [T.SECURITY, T.QA, T.PLATFORM, T.WRITER].includes(spec.id);
    const dependencies = [...spec.dependencies, ...(needsBatchValidation ? validationIds : [])];
    return taskSpec({ ...spec, dependencies }, workspace);
  });
  return [...specialistTasks, ...selectedValidationTasks];
}

export function standardEngineeringTaskSpec(taskId, { workspace = process.env.WORKFLOW_WORKSPACE || process.cwd() } = {}) {
  if (taskId === T.CTO_SYNTHESIS) {
    const contract = getRoleContract('cto');
    return { id: taskId, role: 'cto', capability: contract.capability, dependencies: [T.REVIEWER], execution: { executor: 'ChatOnSteroidsHost', deterministic: false, runtime_owner: 'chat-on-steroids-plugin', execution_mode: 'host-conversation', cwd: workspace || null } };
  }
  const spec = standardEngineeringTaskSpecs(workspace).find(item => item.id === taskId);
  if (!spec) throw new Error(`unknown standard engineering task: ${taskId}`);
  return spec;
}

export const StandardEngineeringRoles = Object.freeze(S.map(spec => spec.role));
