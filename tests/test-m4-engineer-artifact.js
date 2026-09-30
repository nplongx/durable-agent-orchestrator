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
console.log('M4 ENGINEER ARTIFACT PASS');
