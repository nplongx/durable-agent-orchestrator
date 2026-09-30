import assert from 'node:assert/strict';
import { getRoleContract } from '../src/runtime/workflow/roles.js';
import { getAgentContract, listAgentContracts, validateAgentContract } from '../src/runtime/workflow/agent-contracts.js';

const roles = ['product-owner', 'researcher', 'architect', 'engineer', 'security', 'qa', 'platform', 'writer', 'reviewer', 'cto'];

assert.equal(listAgentContracts().length, roles.length);
for (const role of roles) {
  const contract = getAgentContract(role);
  assert.equal(contract.role, role);
  assert.match(contract.id, /^agent\./);
  assert.equal(contract.version, 1);
  assert.equal(contract.executor, 'OpenClaw');
  assert.ok(contract.capability);
  for (const field of ['inputs', 'outputs', 'permissions', 'allowedTools', 'completionCriteria']) assert.ok(Array.isArray(contract[field]));
  assert.equal(validateAgentContract(contract), true);
  assert.equal(getRoleContract(role).id, contract.id);
}

assert.equal(getRoleContract('productowner').id, 'agent.product-owner');
assert.throws(() => getAgentContract('does-not-exist'), /unknown agent contract/);
assert.throws(() => validateAgentContract({ id: 'bad', role: 'x', version: 1, capability: 'x', executor: 'OpenClaw' }), /agent contract inputs must be an array/);

const engineer = getAgentContract('engineer');
assert.ok(Object.isFrozen(engineer));
assert.ok(Object.isFrozen(engineer.permissions));
assert.ok(engineer.permissions.includes('workspace.write'));
assert.ok(engineer.completionCriteria.includes('approved_scope_implemented'));

console.log('M1 AGENT CONTRACTS PASS');

