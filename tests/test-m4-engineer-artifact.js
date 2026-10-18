import assert from 'node:assert/strict';
import { artifactSchemaForType, validateArtifactContent } from '../src/runtime/workflow/artifacts.js';
import { getAgentContract, getAgentInputArtifactTypes } from '../src/runtime/workflow/agent-contracts.js';

assert.deepEqual(artifactSchemaForType('implementation').required_content_fields, [
  'summary', 'files_changed', 'verification', 'execution'
]);
assert.deepEqual(getAgentInputArtifactTypes('engineer'), ['requirements', 'architecture']);
assert.equal(getAgentContract('engineer').outputs[0], 'implementation');
assert.equal(validateArtifactContent('implementation', {
  summary: 'implemented', files_changed: ['src/example.js'], verification: ['test:pass'], execution: { session_id: 'exec_1', exit_code: 0 }
}), true);
assert.throws(() => validateArtifactContent('implementation', {
  summary: 'implemented', files_changed: [], verification: [], execution: { session_id: 'exec_1', exit_code: 1 }
}), /invalid fields/);
for (const exit_code of [null, '0', false]) {
  assert.throws(() => validateArtifactContent('implementation', {
    summary: 'implemented', files_changed: ['src/example.js'], verification: ['test:pass'],
    execution: { session_id: 'exec_1', exit_code }
  }), /invalid fields/,
  `implementation evidence must require exact numeric exit_code 0, not ${String(exit_code)}`);
}
assert.equal(validateArtifactContent('implementation', {
  summary: 'implemented from local tool evidence', files_changed: [], verification: ['typed artifact check'],
  execution: { mode: 'chat-on-steroids-local-tools', exit_code: null, session_id: null, evidence_refs: ['test:local-tool-result'] }
}), true, 'non-ExecutionManager local-tool evidence remains valid only under its explicit separate contract');
console.log('M4 ENGINEER ARTIFACT PASS');
