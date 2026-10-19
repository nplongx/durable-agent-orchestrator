import path from 'node:path';
import { StandardEngineeringTaskId as T } from '../definitions/standard-engineering.js';
import { standardEngineeringTaskSpecs } from './standard-engineering.js';

export const HybridEngineeringTaskId = Object.freeze({
  SERVER_SYNTAX_CHECK: 'hybrid-server-syntax-check',
  WORKFLOW_COMPILER_SYNTAX_CHECK: 'hybrid-workflow-compiler-syntax-check'
});

function deterministicSyntaxCheck({ id, role, workspace, file }) {
  const cwd = path.resolve(workspace || process.cwd());
  const executable = 'node';
  const args = Object.freeze(['--check', path.resolve(cwd, file)]);
  return {
    id,
    role,
    capability: null,
    dependencies: [T.ENGINEER],
    execution: Object.freeze({
      executor: 'ExecutionManager',
      executable,
      args,
      command: [executable, ...args].join(' '),
      cwd,
      timeout_ms: 120_000,
      deterministic: true,
      output_artifact_type: 'documentation'
    })
  };
}

export function hybridEngineeringDeterministicTaskSpecs(workspace = process.env.WORKFLOW_WORKSPACE || process.cwd()) {
  return [
    deterministicSyntaxCheck({
      id: HybridEngineeringTaskId.SERVER_SYNTAX_CHECK,
      role: 'hybrid-server-syntax-check',
      workspace,
      file: 'server/index.js'
    }),
    deterministicSyntaxCheck({
      id: HybridEngineeringTaskId.WORKFLOW_COMPILER_SYNTAX_CHECK,
      role: 'hybrid-workflow-compiler-syntax-check',
      workspace,
      file: 'src/runtime/workflow/compiler.js'
    })
  ];
}

export function hybridEngineeringTaskSpecs(workspace = process.env.WORKFLOW_WORKSPACE || process.cwd()) {
  const deterministicIds = [
    HybridEngineeringTaskId.SERVER_SYNTAX_CHECK,
    HybridEngineeringTaskId.WORKFLOW_COMPILER_SYNTAX_CHECK
  ];
  const hostTasks = standardEngineeringTaskSpecs(workspace).map(task => {
    if (![T.SECURITY, T.QA, T.PLATFORM, T.WRITER, T.REVIEWER].includes(task.id)) return task;
    return {
      ...task,
      dependencies: [...new Set([...task.dependencies, ...deterministicIds])]
    };
  });
  return [...hostTasks, ...hybridEngineeringDeterministicTaskSpecs(workspace)];
}
