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

export function productionTaskSpec(taskId, { workspace = process.env.WORKFLOW_WORKSPACE || DEFAULT_WORKSPACE } = {}) {
  if (!workspace) throw new Error(`workspace is required for task ${taskId}`);

  switch (taskId) {
    case ProductionTaskId.ARCHITECT_CHECK:
      return {
        id: taskId,
        role: 'architect',
        execution: {
          executor: 'ExecutionManager',
          command: `node --check ${path.join(workspace, 'server.js')}`,
          cwd: workspace,
          timeout_ms: 120000,
          deterministic: true
        }
      };
    case ProductionTaskId.QA_CHECK:
      return {
        id: taskId,
        role: 'qa',
        execution: {
          executor: 'ExecutionManager',
          command: `node --check ${path.join(workspace, 'test-tool-turn.js')}`,
          cwd: workspace,
          timeout_ms: 120000,
          deterministic: true
        }
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
