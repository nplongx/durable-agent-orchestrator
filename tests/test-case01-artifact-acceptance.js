import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectCase01SnapshotReferences, createCase01WorkspaceSnapshot, reconcileCase01WorkspaceSnapshots, removeCase01WorkspaceSnapshot, validateCase01WorkspaceArtifact, readVerifiedCase01WorkspaceSnapshot } from '../src/runtime/workflow/case01-artifact-acceptance.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case01-artifact-acceptance-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
const configBytes = Buffer.from('{"service":"demo","port":43127}', 'utf8');
const resultBytes = Buffer.from('{"validated":true,"service":"demo"}', 'utf8');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeRequiredFiles = () => {
  fs.writeFileSync(path.join(workspace, 'config.json'), configBytes);
  fs.writeFileSync(path.join(workspace, 'result.json'), resultBytes);
};
const expectedEntries = () => [
  { path: 'config.json', sha256: hash(fs.readFileSync(path.join(workspace, 'config.json'))) },
  { path: 'result.json', sha256: hash(fs.readFileSync(path.join(workspace, 'result.json'))) }
];

try {
  const durableReferenceId = crypto.randomUUID();
  assert.deepEqual(collectCase01SnapshotReferences([
    { content: JSON.stringify({ summary: 'non-snapshot artifact' }) },
    { content: JSON.stringify({ workspace_snapshot_id: durableReferenceId }) },
    { content: { workspace_snapshot_id: durableReferenceId } }
  ]), new Set([durableReferenceId]), 'durable snapshot references are collected from string and object rows');
  assert.throws(() => collectCase01SnapshotReferences([
    { content: JSON.stringify({ workspace_snapshot_id: 7 }) }
  ]), /invalid workspace_snapshot_id/, 'a malformed typed reference must stop orphan reconciliation');
  assert.throws(() => collectCase01SnapshotReferences([
    { content: '{"workspace_snapshot_id":' }
  ]), /durable artifact reference is malformed/, 'malformed JSON that names a snapshot must fail closed');
  assert.throws(() => collectCase01SnapshotReferences([
    { content: '{"workspace_snapshot_\\u0069d":' }
  ]), /durable artifact reference is malformed/, 'malformed JSON must not evade reference detection through a Unicode-escaped snapshot key');
  assert.doesNotThrow(() => collectCase01SnapshotReferences([
    { content: '{"ordinary":"historical malformed row"' }
  ]), 'malformed unrelated historical artifact content does not invent a snapshot reference');

  writeRequiredFiles();
  const content = { scope: 'CASE-01 requirements', acceptance_criteria: ['validate config before result'], non_goals: [], workspace_artifacts: expectedEntries() };
  assert.deepEqual(validateCase01WorkspaceArtifact({ workspace, content }), expectedEntries());
  const snapshotBase = path.join(root, 'snapshots');
  fs.mkdirSync(snapshotBase, { mode: 0o700 });
  const snapshot = createCase01WorkspaceSnapshot({ workspace, content, snapshotBase });
  const snapshotContent = { ...content, workspace_snapshot_id: snapshot.snapshot_id, workspace_artifacts: snapshot.workspace_artifacts };
  assert.deepEqual(validateCase01WorkspaceArtifact({ workspace, content: snapshotContent, snapshotBase, snapshotId: snapshot.snapshot_id }), snapshot.workspace_artifacts);
  const consumedSnapshot = readVerifiedCase01WorkspaceSnapshot({ content: snapshotContent, snapshotBase, snapshotId: snapshot.snapshot_id });
  assert.equal(consumedSnapshot.snapshot_id, snapshot.snapshot_id);
  assert.deepEqual(consumedSnapshot.workspace_artifacts.map(({ path, sha256 }) => ({ path, sha256 })), snapshot.workspace_artifacts);
  for (const entry of consumedSnapshot.workspace_artifacts) {
    const consumerBuffer = Buffer.from(entry.bytes_base64, 'base64');
    assert.equal(hash(consumerBuffer), entry.sha256, 'consumer hashes the exact decoded buffer it will consume');
    assert.equal(consumerBuffer.toString('base64'), entry.bytes_base64, 'downstream base64 transport preserves the verified bytes');
  }
  assert.equal(consumedSnapshot.workspace_artifacts.find(entry => entry.path === 'config.json').utf8, configBytes.toString('utf8'));

  // Deterministic base-replacement interleaving: replace the snapshot base
  // immediately after mkdir but before the first payload write. Finalization
  // must detect the changed base and must not write through the replacement
  // symlink or chmod/delete an object in the external target.
  const raceBase = path.join(root, 'race-snapshots');
  const displacedRaceBase = path.join(root, 'race-snapshots-displaced');
  const externalRaceTarget = path.join(root, 'external-race-target');
  const raceId = crypto.randomUUID();
  fs.mkdirSync(raceBase, { mode: 0o700 });
  fs.mkdirSync(externalRaceTarget, { mode: 0o700 });
  const originalLstatForBaseRace = fs.lstatSync;
  let baseReplaced = false;
  try {
    fs.lstatSync = function (target, ...args) {
      const result = originalLstatForBaseRace.call(fs, target, ...args);
      if (!baseReplaced && path.resolve(String(target)) === path.join(raceBase, raceId)) {
        baseReplaced = true;
        fs.renameSync(raceBase, displacedRaceBase);
        fs.symlinkSync(externalRaceTarget, raceBase, 'dir');
      }
      return result;
    };
    assert.throws(() => createCase01WorkspaceSnapshot({ workspace, content, snapshotBase: raceBase, snapshotId: raceId }), /snapshot base changed|snapshot directory escaped/);
  } finally {
    fs.lstatSync = originalLstatForBaseRace;
  }
  assert.equal(baseReplaced, true, 'interleaving hook replaced the base after snapshot directory creation');
  assert.equal(fs.readdirSync(externalRaceTarget).length, 0, 'no snapshot payload was written through the replacement symlink');
  assert.equal(fs.lstatSync(raceBase).isSymbolicLink(), true, 'replacement symlink is not followed by cleanup');
  fs.unlinkSync(raceBase);
  fs.rmSync(displacedRaceBase, { recursive: true, force: true });
  fs.rmSync(externalRaceTarget, { recursive: true, force: true });

  const cleanupSnapshot = createCase01WorkspaceSnapshot({ workspace, content: { ...content, workspace_artifacts: expectedEntries() }, snapshotBase });
  assert.equal(removeCase01WorkspaceSnapshot({ snapshotBase, snapshotId: cleanupSnapshot.snapshot_id }), true);
  assert.equal(fs.existsSync(path.join(snapshotBase, cleanupSnapshot.snapshot_id)), false, 'failed-transaction compensation removes only its unreferenced UUID snapshot');
  assert.equal(removeCase01WorkspaceSnapshot({ snapshotBase, snapshotId: cleanupSnapshot.snapshot_id }), false, 'cleanup is idempotent when the snapshot is already absent');
  assert.throws(() => removeCase01WorkspaceSnapshot({ snapshotBase, snapshotId: '../outside' }), /cleanup identity is invalid/);

  // Crash recovery may collect only snapshots that are neither durably
  // referenced nor reserved by a live completion. Old untracked directories
  // are eligible after the configured grace period; symlinks are preserved.
  const makeOldSnapshot = () => {
    const made = createCase01WorkspaceSnapshot({ workspace, content: { workspace_artifacts: expectedEntries() }, snapshotBase });
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(snapshotBase, made.snapshot_id), old, old);
    return made.snapshot_id;
  };
  const referencedSnapshotId = makeOldSnapshot();
  const reservedSnapshotId = makeOldSnapshot();
  const orphanSnapshotId = makeOldSnapshot();
  const outsideSnapshotTarget = path.join(root, 'outside-snapshot-target');
  fs.mkdirSync(outsideSnapshotTarget);
  const linkedSnapshotId = crypto.randomUUID();
  fs.symlinkSync(outsideSnapshotTarget, path.join(snapshotBase, linkedSnapshotId), 'dir');
  const reconciled = reconcileCase01WorkspaceSnapshots({
    snapshotBase, referencedSnapshotIds: [referencedSnapshotId], reservedSnapshotIds: [reservedSnapshotId],
    minOrphanAgeMs: 1_000, nowMs: Date.now()
  });
  assert.deepEqual(reconciled.removed, [orphanSnapshotId]);
  assert.equal(fs.existsSync(path.join(snapshotBase, referencedSnapshotId)), true, 'durable reference prevents orphan collection');
  assert.equal(fs.existsSync(path.join(snapshotBase, reservedSnapshotId)), true, 'active reservation prevents collection');
  assert.equal(fs.lstatSync(path.join(snapshotBase, linkedSnapshotId)).isSymbolicLink(), true, 'reconciliation refuses to follow snapshot symlinks');
  assert.equal(fs.existsSync(outsideSnapshotTarget), true, 'symlink target remains untouched');
  assert.equal(reconciled.errors.length, 0);
  // A writer may still change the live workspace after finalization. Acceptance
  // remains bound to the immutable snapshot, not a second read of mutable bytes.
  fs.writeFileSync(path.join(workspace, 'config.json'), Buffer.from('{"service":"late-write","port":43127}', 'utf8'));
  assert.deepEqual(validateCase01WorkspaceArtifact({ workspace, content: snapshotContent, snapshotBase, snapshotId: snapshot.snapshot_id }), snapshot.workspace_artifacts);
  // Even privileged tampering with a nominally read-only snapshot is detected
  // by the persisted SHA-256 comparison rather than trusted on mode bits alone.
  const snapshotConfig = path.join(snapshotBase, snapshot.snapshot_id, 'config.json');
  fs.chmodSync(snapshotConfig, 0o600);
  fs.writeFileSync(snapshotConfig, '{"tampered":true}');
  fs.chmodSync(snapshotConfig, 0o400);
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content: snapshotContent, snapshotBase, snapshotId: snapshot.snapshot_id }), /workspace artifact mismatch/);
  assert.throws(() => readVerifiedCase01WorkspaceSnapshot({ content: snapshotContent, snapshotBase, snapshotId: snapshot.snapshot_id }), /workspace artifact mismatch/,
    'downstream byte delivery refuses substituted snapshot bytes even if filesystem metadata is otherwise readable');
  fs.chmodSync(path.join(snapshotBase, snapshot.snapshot_id), 0o700);
  fs.writeFileSync(path.join(workspace, 'config.json'), configBytes);
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content: { ...content, workspace_artifacts: [...content.workspace_artifacts].reverse() } }), /workspace artifact mismatch/);
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content: { ...content, workspace_artifacts: [{ path: '../outside.json', sha256: content.workspace_artifacts[0].sha256 }, content.workspace_artifacts[1]] } }), /workspace artifact mismatch/);
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content: { ...content, workspace_artifacts: [{ ...content.workspace_artifacts[0], sha256: '0'.repeat(64) }, content.workspace_artifacts[1]] } }), /workspace artifact mismatch/);
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content: { ...content, workspace_artifacts: [...content.workspace_artifacts, content.workspace_artifacts[0]] } }), /exactly config.json and result.json/);
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content: { ...content, workspace_artifacts: [{ ...content.workspace_artifacts[0], extra: true }, content.workspace_artifacts[1]] } }), /workspace artifact mismatch/);

  const cto = { decision: 'approve', summary: 'Accepted', accepted_requirements: [], unresolved_risks: [], follow_up_actions: [], evidence_refs: ['requirements-result-1'], workspace_artifacts: expectedEntries() };
  assert.deepEqual(validateCase01WorkspaceArtifact({ workspace, content: cto, taskArtifactId: 'requirements-result-1' }), expectedEntries());
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content: cto, taskArtifactId: 'requirements-result-other' }), /exactly the active task artifact ID/);

  fs.writeFileSync(path.join(workspace, 'extra.txt'), 'unexpected');
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content }), /file set mismatch/);
  fs.unlinkSync(path.join(workspace, 'extra.txt'));

  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, configBytes);
  fs.unlinkSync(path.join(workspace, 'result.json'));
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content }), /file set mismatch/);
  fs.writeFileSync(path.join(workspace, 'result.json'), resultBytes);
  fs.unlinkSync(path.join(workspace, 'config.json'));
  fs.symlinkSync(outside, path.join(workspace, 'config.json'));
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content }), /regular non-symlink file/);
  fs.unlinkSync(path.join(workspace, 'config.json'));
  fs.writeFileSync(path.join(workspace, 'config.json'), configBytes);

  const originalReadFileSync = fs.readFileSync;
  try {
    fs.readFileSync = function (file, ...args) {
      const bytes = originalReadFileSync.call(fs, file, ...args);
      if (typeof file === 'number') {
        fs.writeFileSync(path.join(workspace, 'config.json'), Buffer.from('{"service":"evil","port":43127}', 'utf8'));
      }
      return bytes;
    };
    assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content }), /changed while hashing/);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync(path.join(workspace, 'config.json'), configBytes);
  }

  const externalWorkspace = path.join(root, 'external-workspace');
  fs.mkdirSync(externalWorkspace);
  fs.writeFileSync(path.join(externalWorkspace, 'config.json'), configBytes);
  fs.writeFileSync(path.join(externalWorkspace, 'result.json'), resultBytes);
  const displacedWorkspace = path.join(root, 'workspace-displaced');
  let workspaceReplaced = false;
  const originalReadForRootSwap = fs.readFileSync;
  try {
    fs.readFileSync = function (file, ...args) {
      const bytes = originalReadForRootSwap.call(fs, file, ...args);
      if (typeof file === 'number' && !workspaceReplaced) {
        fs.renameSync(workspace, displacedWorkspace);
        fs.renameSync(externalWorkspace, workspace);
        workspaceReplaced = true;
      }
      return bytes;
    };
    assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content }), /workspace root changed while hashing/);
  } finally {
    fs.readFileSync = originalReadForRootSwap;
    if (workspaceReplaced) {
      fs.renameSync(workspace, externalWorkspace);
      fs.renameSync(displacedWorkspace, workspace);
    }
  }

  const linkedWorkspace = path.join(root, 'workspace-link');
  fs.symlinkSync(workspace, linkedWorkspace, 'dir');
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace: linkedWorkspace, content }), /workspace root must be a non-symlink directory/);

  fs.writeFileSync(path.join(workspace, 'result.json'), Buffer.from('{"validated":false,"service":"demo"}', 'utf8'));
  assert.throws(() => validateCase01WorkspaceArtifact({ workspace, content }), /workspace artifact mismatch/);
  console.log('PASS: CASE-01 artifact acceptance checks final bytes, exact file set, path type, ordering, and CTO task-artifact reference');
  console.log('PASS: immutable CASE-01 snapshot remains authoritative after a late workspace write and rejects post-finalization tampering');
} finally {
  const makeWritable = target => {
    let stat;
    try { stat = fs.lstatSync(target); } catch { return; }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.chmodSync(target, 0o700);
      for (const name of fs.readdirSync(target)) makeWritable(path.join(target, name));
    }
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}
