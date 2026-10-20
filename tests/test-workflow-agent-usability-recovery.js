import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './test-temp-dir.js';
import { replaceFileWithin } from '../src/runtime/secure-filesystem.js';
import {
  normalizeWorkspaceWriteContract,
  pathIsWithinWorkspaceWriteScope
} from '../src/runtime/workflow/workspace-write-contract.js';
import { classifyReviewRecovery } from '../src/runtime/workflow/recovery-compatibility.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const root = tempDir('workflow-agent-usability-');
const source = path.join(root, 'src');
const outside = tempDir('workflow-agent-usability-outside-');
try {
  fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(path.join(source, 'entry.js'), 'const before = true;\n', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(outside, 'secret.js'), 'outside must remain unchanged\n', { mode: 0o600, flag: 'wx' });

  // Atomic compare-before-replace and absent-only creation are the filesystem
  // primitive required by the scoped workspace-write MCP operation.
  const before = 'const before = true;\n';
  const after = 'const after = true;\n';
  const changed = replaceFileWithin(root, 'src/entry.js', after, { expectedSha256: sha256(before) });
  assert.equal(changed.outcome, 'replaced');
  assert.equal(changed.before_sha256, sha256(before));
  assert.equal(changed.after_sha256, sha256(after));
  assert.equal(fs.readFileSync(path.join(source, 'entry.js'), 'utf8'), after);
  const repeated = replaceFileWithin(root, 'src/entry.js', after, { expectedSha256: sha256(before) });
  assert.equal(repeated.outcome, 'already_present');
  assert.equal(repeated.changed, false);
  assert.throws(() => replaceFileWithin(root, 'src/entry.js', 'stale overwrite\n', { expectedSha256: sha256(before) }), /base hash mismatch/i);
  assert.throws(() => replaceFileWithin(root, 'src/new.js', 'create\n', { expectedSha256: sha256(before) }), /base hash mismatch|does not exist/i);
  const created = replaceFileWithin(root, 'src/new.js', 'new file\n', { expectedSha256: 'ABSENT' });
  assert.equal(created.outcome, 'created');
  assert.throws(() => replaceFileWithin(root, 'src/new.js', 'overwrite without base\n', { expectedSha256: 'ABSENT' }), /base hash mismatch/i);
  assert.throws(() => replaceFileWithin(root, '../workflow-agent-usability-outside/secret.js', 'escape\n', { expectedSha256: sha256('outside must remain unchanged\n') }), /normalized workspace-relative file path/i);
  fs.symlinkSync(path.join(outside, 'secret.js'), path.join(root, 'escape.js'));
  assert.throws(() => replaceFileWithin(root, 'escape.js', 'no follow\n', { expectedSha256: sha256('outside must remain unchanged\n') }), /ELOOP|symlink|secure filesystem/i);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.js'), 'utf8'), 'outside must remain unchanged\n');

  const base = { workflowId: 'standard-engineering', workflowVersion: 3, workspace: root };
  const contract = normalizeWorkspaceWriteContract({
    ...base,
    requiredOperations: ['workspace.write'],
    scopes: [{ role: 'engineer', paths: [{ path: 'src', kind: 'directory' }] }]
  });
  assert.deepEqual(contract.required_operations, ['workspace.write']);
  assert.equal(pathIsWithinWorkspaceWriteScope('src/entry.js', contract.scopes[0]), true);
  assert.equal(pathIsWithinWorkspaceWriteScope('src/new.js', contract.scopes[0]), true);
  assert.equal(pathIsWithinWorkspaceWriteScope('tests/entry.js', contract.scopes[0]), false);
  assert.equal(pathIsWithinWorkspaceWriteScope('src/../outside.js', contract.scopes[0]), false);
  assert.throws(() => normalizeWorkspaceWriteContract({
    ...base, requiredOperations: ['workspace.write'], scopes: []
  }), error => error.code === 'WORKSPACE_WRITE_SCOPE_MISSING');
  assert.throws(() => normalizeWorkspaceWriteContract({
    ...base, requiredOperations: [], scopes: [{ role: 'writer', paths: [{ path: 'src', kind: 'directory' }] }]
  }), error => error.code === 'WORKSPACE_SCOPE_WITHOUT_OPERATION');
  assert.throws(() => normalizeWorkspaceWriteContract({
    ...base, workflowId: 'engineering', requiredOperations: ['workspace.write'],
    scopes: [{ role: 'engineer', paths: [{ path: 'src', kind: 'directory' }] }]
  }), error => error.code === 'WORKSPACE_WRITE_UNSUPPORTED_WORKFLOW');
  assert.throws(() => normalizeWorkspaceWriteContract({
    ...base, requiredOperations: ['workspace.write'],
    scopes: [{ role: 'reviewer', paths: [{ path: 'src', kind: 'directory' }] }]
  }), error => error.code === 'WORKSPACE_WRITE_ROLE_NOT_AUTHORIZED');
  assert.throws(() => normalizeWorkspaceWriteContract({
    ...base, requiredOperations: ['workspace.write'],
    scopes: [{ role: 'engineer', paths: [{ path: '../outside', kind: 'directory' }] }]
  }), error => error.code === 'WORKSPACE_WRITE_SCOPE_INVALID');

  assert.equal(classifyReviewRecovery({ plan: { workflow_id: 'standard-engineering', workflow_version: 2 }, job: { state: 'EXECUTING', status: 'active' } }).supported, true);
  const unsupported = classifyReviewRecovery({ plan: { workflow_id: 'engineering', workflow_version: 2 }, job: { state: 'EXECUTING', status: 'active' } });
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.code, 'WORKFLOW_REWORK_UNSUPPORTED');
  assert.equal(unsupported.retryable, false);
  assert.equal(unsupported.next_action.tool, 'workflow_create');
  assert.equal(classifyReviewRecovery({ plan: { workflow_id: 'standard-engineering', workflow_version: 2 }, job: { state: 'COMPLETED', status: 'completed' } }).code, 'WORKFLOW_NOT_EXECUTING');

  console.log('WORKFLOW AGENT USABILITY & RECOVERY: hash-fenced workspace writes, plan-scoped capabilities, and version-aware recovery compatibility PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
