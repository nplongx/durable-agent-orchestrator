import { EngineeringTaskId } from '../definitions/engineering.js';
import { getRoleContract } from '../roles.js';

const SPECS = Object.freeze([
  Object.freeze({ id: EngineeringTaskId.ARCHITECT, role: 'architect', dependencies: [] }),
  Object.freeze({ id: EngineeringTaskId.ENGINEER, role: 'engineer', dependencies: [EngineeringTaskId.ARCHITECT] }),
  Object.freeze({ id: EngineeringTaskId.QA, role: 'qa', dependencies: [EngineeringTaskId.ENGINEER] }),
  Object.freeze({ id: EngineeringTaskId.REVIEWER, role: 'reviewer', dependencies: [EngineeringTaskId.QA] })
]);

function taskSpec(spec, workspace) {
  const contract = getRoleContract(spec.role);
  const nativeTimeoutMs = Math.max(30_000, Number(process.env.OPENCLAW_NATIVE_CHILD_TIMEOUT_MS) || 300_000);
  const baseExecution = {
    executor: contract.executor,
    deterministic: false,
    cwd: workspace || null,
    timeout_ms: nativeTimeoutMs
  };
  if (spec.role === 'engineer') {
    return {
      id: spec.id,
      role: spec.role,
      capability: contract.capability,
      dependencies: [...spec.dependencies],
      execution: {
        executor: 'ExecutionManager',
        deterministic: true,
        executable: 'node',
        args: ['--input-type=module', '-e', "import fs from 'node:fs'; fs.writeFileSync('.m4-engineer-proof.js', 'export const m4EngineerProof = true;\\n');"],
        command: "node --input-type=module -e \"import fs from 'node:fs'; fs.writeFileSync('.m4-engineer-proof.js', 'export const m4EngineerProof = true;\\n');\"",
        cwd: workspace || null,
        timeout_ms: 120000
      }
    };
  }
  if (spec.role === 'qa') {
    return {
      id: spec.id,
      role: spec.role,
      capability: contract.capability,
      dependencies: [...spec.dependencies],
      execution: {
        executor: 'ExecutionManager',
        deterministic: true,
        executable: 'node',
        args: ['--input-type=module', '-e', "import fs from 'node:fs'; const expected = 'export const m4EngineerProof = true;\\n'; if (fs.readFileSync('.m4-engineer-proof.js', 'utf8') !== expected) process.exit(1);"],
        command: "node --input-type=module -e \"import fs from 'node:fs'; const expected = 'export const m4EngineerProof = true;\\n'; if (fs.readFileSync('.m4-engineer-proof.js', 'utf8') !== expected) process.exit(1);\"",
        cwd: workspace || null,
        timeout_ms: 120000
      }
    };
  }
  return {
    id: spec.id,
    role: spec.role,
    capability: contract.capability,
    dependencies: [...spec.dependencies],
    execution: baseExecution
  };
}

const DEFAULT_WORKSPACE = process.env.WORKFLOW_WORKSPACE || null;

export function engineeringTaskSpecs(workspace = DEFAULT_WORKSPACE) {
  return SPECS.map(spec => taskSpec(spec, workspace));
}

export function engineeringTaskSpec(taskId, { workspace = DEFAULT_WORKSPACE } = {}) {
  if (taskId === EngineeringTaskId.CTO_SYNTHESIS) {
    const contract = getRoleContract('cto');
    return {
      id: taskId,
      role: 'cto',
      capability: contract.capability,
      dependencies: [EngineeringTaskId.REVIEWER],
      execution: { executor: contract.executor, deterministic: false, cwd: workspace || null }
    };
  }
  const spec = engineeringTaskSpecs(workspace).find(item => item.id === taskId);
  if (!spec) throw new Error(`unknown engineering task: ${taskId}`);
  return spec;
}

export const EngineeringRoles = Object.freeze(SPECS.map(spec => spec.role));
