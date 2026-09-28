import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WORKSPACE = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

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
        execution: nodeCheckExecution(workspace, 'test-tool-turn.js')
      };
    case ProductionTaskId.CTO_SYNTHESIS:
      return {
        id: taskId,
        role: 'cto',
        execution: {
          executor: 'OpenClaw',
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
