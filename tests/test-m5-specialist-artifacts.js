import assert from 'node:assert/strict';
import { artifactSchemaForType, validateArtifactContent } from '../src/runtime/workflow/artifacts.js';
import { getAgentContract, getAgentInputArtifactTypes } from '../src/runtime/workflow/agent-contracts.js';

for (const [role, type, inputs] of [
  ['security', 'security-review', ['requirements', 'architecture', 'implementation']],
  ['qa', 'qa-report', ['requirements', 'architecture', 'implementation']],
  ['platform', 'platform-review', ['architecture', 'implementation']],
  ['writer', 'documentation', ['requirements', 'implementation']]
]) {
  assert.equal(getAgentContract(role).outputs[0], type);
  assert.deepEqual(getAgentInputArtifactTypes(role), inputs);
  assert.ok(artifactSchemaForType(type).required_content_fields.length >= 3);
}

assert.equal(validateArtifactContent('security-review', { threats: [], findings: [], decision: 'accept' }), true);
assert.equal(validateArtifactContent('qa-report', { checks: [], results: [], decision: 'accept' }), true);
assert.equal(validateArtifactContent('platform-review', { runtime: {}, deployment: {}, recovery: {} }), true);
assert.equal(validateArtifactContent('documentation', { summary: 'done', user_facing_changes: [], verification: [] }), true);
assert.throws(() => validateArtifactContent('security-review', { threats: [], findings: [], decision: 'bad' }), /invalid fields/);
console.log('M5 SPECIALIST ARTIFACTS PASS');
