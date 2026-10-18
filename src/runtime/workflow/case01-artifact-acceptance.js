import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseStrictJson } from '../strict-json.js';

export const CASE01_REQUIRED_WORKSPACE_FILES = Object.freeze(['config.json', 'result.json']);

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function mayNameCase01SnapshotReference(content) {
  // JSON permits Unicode escapes inside property names. Decode those escapes
  // before deciding malformed content is unrelated to the snapshot safety
  // boundary; otherwise a broken row can hide workspace_snapshot_id as
  // workspace_snapshot_\\u0069d and be silently omitted from reconciliation.
  return content.replace(/\\u([a-f0-9]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .includes('workspace_snapshot_id');
}

// JSON.parse silently keeps the last value when an object repeats a property
// name. That is unsafe for durable snapshot references: an earlier reference
// can disappear from the parsed object and its snapshot can then be treated as
// an orphan. Scan JSON string tokens and compare decoded property names before
// accepting the parsed row. This intentionally checks the safety-critical key
// rather than attempting to replace the JSON parser for every property.
function hasDuplicateCase01SnapshotReferenceKey(json) {
  const stack = [];
  let index = 0;
  while (index < json.length) {
    const char = json[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '{') {
      stack.push({ type: 'object', expectingKey: true, keys: new Set() });
      index += 1;
      continue;
    }
    if (char === '[') { stack.push({ type: 'array' }); index += 1; continue; }
    if (char === '}' || char === ']') { stack.pop(); index += 1; continue; }
    if (char === ',') {
      const frame = stack.at(-1);
      if (frame?.type === 'object') frame.expectingKey = true;
      index += 1;
      continue;
    }
    if (char === ':') {
      const frame = stack.at(-1);
      if (frame?.type === 'object') frame.expectingKey = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      const start = index++;
      while (index < json.length) {
        if (json[index] === '\\') { index += 2; continue; }
        if (json[index++] === '"') break;
      }
      const token = json.slice(start, index);
      let decoded;
      try { decoded = parseStrictJson(token, 'CASE-01 JSON string token'); } catch { continue; }
      const frame = stack.at(-1);
      if (frame?.type === 'object' && frame.expectingKey) {
        if (decoded === 'workspace_snapshot_id' && frame.keys.has(decoded)) return true;
        frame.keys.add(decoded);
        frame.expectingKey = false;
      }
      continue;
    }
    // Skip a primitive value. Its delimiters are processed on the next pass.
    index += 1;
    while (index < json.length && !/[\s,:}\]]/.test(json[index])) index += 1;
  }
  return false;
}

// Durable reference discovery is a safety boundary: a malformed artifact row
// must never be silently omitted from the protected set, or reconciliation
// could mistake a referenced snapshot for an orphan and delete it.
export function collectCase01SnapshotReferences(artifactRows = []) {
  if (!Array.isArray(artifactRows)) throw new Error('CASE-01 durable artifact rows must be an array');
  const ids = new Set();
  for (const row of artifactRows) {
    let content = row?.content;
    if (typeof content === 'string') {
      if (hasDuplicateCase01SnapshotReferenceKey(content)) {
        throw new Error('cannot reconcile snapshots while a durable artifact repeats workspace_snapshot_id');
      }
      try { content = parseStrictJson(content, 'CASE-01 durable artifact reference'); }
      catch (error) {
        if (mayNameCase01SnapshotReference(content)) {
          throw new Error(`cannot reconcile snapshots while a durable artifact reference is malformed: ${String(error?.message || error)}`);
        }
        continue;
      }
    }
    if (!content || typeof content !== 'object' || Array.isArray(content) || !Object.hasOwn(content, 'workspace_snapshot_id')) continue;
    const snapshotId = content.workspace_snapshot_id;
    if (typeof snapshotId !== 'string' || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
      throw new Error('cannot reconcile snapshots while a durable artifact has an invalid workspace_snapshot_id');
    }
    ids.add(snapshotId);
  }
  return ids;
}

// Recovery must verify the referenced bytes, not merely protect directory
// names from orphan collection. A missing/corrupt snapshot is an integrity
// failure and must stop reconciliation before any cleanup decision is made.
// Rows are supplied from one SQLite read transaction by the caller.
export function validateCase01DurableSnapshotReferences({ artifactRows = [], snapshotBase } = {}) {
  if (typeof snapshotBase !== 'string' || !path.isAbsolute(snapshotBase)) {
    throw new Error('CASE-01 snapshot base must be an absolute path');
  }
  const referenced = collectCase01SnapshotReferences(artifactRows);
  const contents = [];
  for (const row of artifactRows) {
    let content = row?.content;
    if (typeof content === 'string') {
      if (hasDuplicateCase01SnapshotReferenceKey(content)) {
        throw new Error('cannot verify durable snapshot bytes while an artifact repeats workspace_snapshot_id');
      }
      try { content = parseStrictJson(content, 'CASE-01 durable artifact reference'); }
      catch (error) {
        if (mayNameCase01SnapshotReference(content)) {
          throw new Error(`cannot verify durable snapshot bytes while an artifact reference is malformed: ${String(error?.message || error)}`);
        }
        continue;
      }
    }
    if (!content || typeof content !== 'object' || Array.isArray(content) || !Object.hasOwn(content, 'workspace_snapshot_id')) continue;
    contents.push(content);
  }
  // Verify every durable row (including multiple task/CTO artifacts that bind
  // the same snapshot), so divergent hash declarations cannot be hidden by a
  // Set that only retains the snapshot ID.
  for (const content of contents) {
    validateCase01WorkspaceArtifact({
      content,
      snapshotBase,
      snapshotId: content.workspace_snapshot_id,
    });
  }
  return referenced;
}

function assertWorkspaceRootStable(workspace, root, initialStat, resolvedStat) {
  let currentWorkspaceStat;
  let currentRootStat;
  let resolvedWorkspace;
  try {
    currentWorkspaceStat = fs.lstatSync(workspace, { bigint: true });
    currentRootStat = fs.lstatSync(root, { bigint: true });
    resolvedWorkspace = fs.realpathSync(workspace);
  } catch {
    throw new Error('CASE-01 workspace root changed while hashing');
  }
  if (currentWorkspaceStat.isSymbolicLink() || !currentWorkspaceStat.isDirectory() ||
      currentWorkspaceStat.dev !== initialStat.dev || currentWorkspaceStat.ino !== initialStat.ino ||
      !currentRootStat.isDirectory() || currentRootStat.isSymbolicLink() ||
      currentRootStat.dev !== resolvedStat.dev || currentRootStat.ino !== resolvedStat.ino ||
      resolvedWorkspace !== root) {
    throw new Error('CASE-01 workspace root changed while hashing');
  }
}

function readWorkspaceFiles(workspace, { includeBytes = false } = {}) {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('CASE-01 workspace is required');
  const rootStat = fs.lstatSync(workspace, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('CASE-01 workspace root must be a non-symlink directory');
  const root = fs.realpathSync(workspace);
  const rootRealStat = fs.statSync(root, { bigint: true });
  assertWorkspaceRootStable(workspace, root, rootStat, rootRealStat);
  const entries = fs.readdirSync(root, { withFileTypes: true }).map(entry => entry.name).sort();
  const expected = [...CASE01_REQUIRED_WORKSPACE_FILES].sort();
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    throw new Error(`CASE-01 workspace file set mismatch: expected ${expected.join(', ')}, observed ${entries.join(', ')}`);
  }
  const observed = CASE01_REQUIRED_WORKSPACE_FILES.map(relativePath => {
    const target = path.join(root, relativePath);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`CASE-01 workspace path must be a regular non-symlink file: ${relativePath}`);
    const real = fs.realpathSync(target);
    if (path.dirname(real) !== root) throw new Error(`CASE-01 workspace path escaped its root: ${relativePath}`);
    let fd;
    try {
      fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.dev !== BigInt(stat.dev) || before.ino !== BigInt(stat.ino)) {
        throw new Error(`CASE-01 workspace file changed while opening: ${relativePath}`);
      }
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== after.size) {
        throw new Error(`CASE-01 workspace file changed while hashing: ${relativePath}`);
      }
      const entry = { path: relativePath, sha256: sha256(bytes) };
      // When a consumer needs the evidence itself, return the exact buffer that
      // was hashed above. Never make the consumer reopen this mutable path.
      if (includeBytes) entry.bytes = Buffer.from(bytes);
      return entry;
    } catch (error) {
      if (error?.code === 'ELOOP') throw new Error(`CASE-01 workspace path must be a regular non-symlink file: ${relativePath}`);
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
  assertWorkspaceRootStable(workspace, root, rootStat, rootRealStat);
  const entriesAfterRead = fs.readdirSync(root, { withFileTypes: true }).map(entry => entry.name).sort();
  if (entriesAfterRead.length !== entries.length || entriesAfterRead.some((entry, index) => entry !== entries[index])) {
    throw new Error('CASE-01 workspace file set changed while hashing');
  }
  assertWorkspaceRootStable(workspace, root, rootStat, rootRealStat);
  return observed;
}

// Freeze the exact accepted bytes outside the mutable execution workspace. The
// snapshot ID is generated locally and the path is derived from that ID; callers
// cannot choose an arbitrary path. Snapshot hashes, not later workspace reads,
// are the authoritative evidence for task completion and CTO synthesis.
export function createCase01WorkspaceSnapshot({ workspace, content, snapshotBase, snapshotId = crypto.randomUUID() } = {}) {
  if (typeof snapshotBase !== 'string' || !path.isAbsolute(snapshotBase)) {
    throw new Error('CASE-01 snapshot base must be an absolute path');
  }
  if (typeof snapshotId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(snapshotId)) {
    throw new Error('CASE-01 snapshot identity is invalid');
  }
  const base = path.resolve(snapshotBase);
  const baseStat = fs.lstatSync(base, { bigint: true });
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('CASE-01 snapshot base must be a non-symlink directory');
  const baseRealPath = fs.realpathSync(base);
  const assertSnapshotBaseStable = () => {
    let current;
    let realPath;
    try {
      current = fs.lstatSync(base, { bigint: true });
      realPath = fs.realpathSync(base);
    } catch {
      throw new Error('CASE-01 snapshot base changed during finalization');
    }
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== baseStat.dev ||
        current.ino !== baseStat.ino || realPath !== baseRealPath) {
      throw new Error('CASE-01 snapshot base changed during finalization');
    }
  };
  assertSnapshotBaseStable();
  const expected = readWorkspaceFiles(workspace);
  const declared = content?.workspace_artifacts;
  if (!Array.isArray(declared) || declared.length !== expected.length) {
    throw new Error('CASE-01 artifact must declare exactly config.json and result.json in workspace_artifacts');
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (!declared[i] || declared[i].path !== expected[i].path || declared[i].sha256 !== expected[i].sha256) {
      throw new Error(`CASE-01 workspace artifact mismatch for ${expected[i].path}: declared hash must match bytes read for snapshot`);
    }
  }
  const snapshotRoot = path.join(base, snapshotId);
  assertSnapshotBaseStable();
  fs.mkdirSync(snapshotRoot, { mode: 0o700 });
  let snapshotRootStat;
  try {
    assertSnapshotBaseStable();
    snapshotRootStat = fs.lstatSync(snapshotRoot, { bigint: true });
    let snapshotRootRealPath = null;
    try { snapshotRootRealPath = fs.realpathSync(snapshotRoot); } catch {}
    if (!snapshotRootStat.isDirectory() || snapshotRootStat.isSymbolicLink() ||
        snapshotRootRealPath !== path.join(baseRealPath, snapshotId)) {
      throw new Error('CASE-01 snapshot directory escaped its stable base');
    }
    for (const entry of expected) {
      assertSnapshotBaseStable();
      const currentRoot = fs.lstatSync(snapshotRoot, { bigint: true });
      let currentRootRealPath = null;
      try { currentRootRealPath = fs.realpathSync(snapshotRoot); } catch {}
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() ||
          currentRoot.dev !== snapshotRootStat.dev || currentRoot.ino !== snapshotRootStat.ino ||
          currentRootRealPath !== path.join(baseRealPath, snapshotId)) {
        throw new Error('CASE-01 snapshot directory changed during finalization');
      }
      const source = path.join(fs.realpathSync(workspace), entry.path);
      const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let bytes;
      try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile()) throw new Error(`CASE-01 snapshot source is not a regular file: ${entry.path}`);
        bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || sha256(bytes) !== entry.sha256) {
          throw new Error(`CASE-01 workspace changed while creating immutable snapshot: ${entry.path}`);
        }
      } finally { fs.closeSync(fd); }
      fs.writeFileSync(path.join(snapshotRoot, entry.path), bytes, { flag: 'wx', mode: 0o400 });
    }
    assertSnapshotBaseStable();
    fs.chmodSync(snapshotRoot, 0o500);
    assertSnapshotBaseStable();
    const finalizedRoot = fs.lstatSync(snapshotRoot, { bigint: true });
    if (!finalizedRoot.isDirectory() || finalizedRoot.isSymbolicLink() ||
        finalizedRoot.dev !== snapshotRootStat.dev || finalizedRoot.ino !== snapshotRootStat.ino) {
      throw new Error('CASE-01 snapshot directory changed before finalization verification');
    }
    const snapshotEntries = readWorkspaceFiles(snapshotRoot);
    if (JSON.stringify(snapshotEntries) !== JSON.stringify(expected)) throw new Error('CASE-01 snapshot bytes do not match validated workspace bytes');
    return { snapshot_id: snapshotId, workspace_artifacts: snapshotEntries };
  } catch (error) {
    // Reuse the guarded cleanup path. Never chmod/rm through a base that may
    // have been replaced by a symlink while finalization was in progress.
    try {
      assertSnapshotBaseStable();
      removeCase01WorkspaceSnapshot({ snapshotBase: base, snapshotId });
    } catch { /* preserve reservation and partial bytes for conservative recovery */ }
    throw error;
  }
}

// Best-effort compensation for the filesystem side of finalization when the
// corresponding SQLite transaction fails. This is deliberately limited to a
// server-generated UUID child directly beneath the configured snapshot base.
// Callers must first establish that no durable artifact references the ID.
export function removeCase01WorkspaceSnapshot({ snapshotBase, snapshotId } = {}) {
  if (typeof snapshotBase !== 'string' || !path.isAbsolute(snapshotBase) ||
      typeof snapshotId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(snapshotId)) {
    throw new Error('CASE-01 snapshot cleanup identity is invalid');
  }
  const base = path.resolve(snapshotBase);
  const baseStat = fs.lstatSync(base, { bigint: true });
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('CASE-01 snapshot base must be a non-symlink directory');
  const baseRealPath = fs.realpathSync(base);
  const root = path.join(baseRealPath, snapshotId);
  const assertCleanupLocationStable = expectedRootStat => {
    let currentBase;
    let currentRoot;
    try {
      currentBase = fs.lstatSync(base, { bigint: true });
      currentRoot = fs.lstatSync(root, { bigint: true });
      if (fs.realpathSync(base) !== baseRealPath || fs.realpathSync(root) !== root) {
        throw new Error('CASE-01 snapshot cleanup location changed');
      }
    } catch (error) {
      throw new Error(`CASE-01 snapshot cleanup location changed: ${String(error?.message || error)}`);
    }
    if (!currentBase.isDirectory() || currentBase.isSymbolicLink() || currentBase.dev !== baseStat.dev || currentBase.ino !== baseStat.ino ||
        !currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== expectedRootStat.dev || currentRoot.ino !== expectedRootStat.ino) {
      throw new Error('CASE-01 snapshot cleanup location changed');
    }
  };
  let snapshotStat;
  try { snapshotStat = fs.lstatSync(root, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink() || path.dirname(root) !== baseRealPath || fs.realpathSync(root) !== root) {
    throw new Error('CASE-01 cleanup target is not a direct non-symlink snapshot directory');
  }
  assertCleanupLocationStable(snapshotStat);
  const makeWritable = target => {
    const stat = fs.lstatSync(target, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('CASE-01 snapshot cleanup refuses symlinks');
    if (stat.isDirectory()) {
      fs.chmodSync(target, 0o700);
      for (const name of fs.readdirSync(target)) makeWritable(path.join(target, name));
    } else if (stat.isFile()) fs.chmodSync(target, 0o600);
    else throw new Error('CASE-01 snapshot cleanup refuses special files');
  };
  makeWritable(root);
  assertCleanupLocationStable(snapshotStat);
  fs.rmSync(root, { recursive: true, force: false });
  return true;
}

// Conservative reconciliation for snapshots created by older processes or
// left behind by a crash. The caller must pass every durable reference and
// every live reservation observed in SQLite. Untracked directories are only
// eligible after a grace period; reserved IDs are never removed here.
export function reconcileCase01WorkspaceSnapshots({
  snapshotBase, referencedSnapshotIds = [], reservedSnapshotIds = [],
  minOrphanAgeMs = 60 * 60 * 1000, nowMs = Date.now()
} = {}) {
  if (typeof snapshotBase !== 'string' || !path.isAbsolute(snapshotBase)) throw new Error('CASE-01 snapshot base must be an absolute path');
  if (!Number.isFinite(minOrphanAgeMs) || minOrphanAgeMs < 0 || !Number.isFinite(nowMs)) throw new Error('CASE-01 reconciliation time bounds are invalid');
  const base = path.resolve(snapshotBase);
  let baseStat;
  try { baseStat = fs.lstatSync(base, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return { removed: [], preserved: [], errors: [] }; throw error; }
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('CASE-01 snapshot base must be a non-symlink directory');
  const referenced = new Set(referencedSnapshotIds);
  const reserved = new Set(reservedSnapshotIds);
  const removed = [];
  const preserved = [];
  const errors = [];
  for (const name of fs.readdirSync(base).sort()) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(name)) {
      preserved.push({ snapshot_id: name, reason: 'non-snapshot-name' });
      continue;
    }
    const target = path.join(base, name);
    let stat;
    try { stat = fs.lstatSync(target, { bigint: true }); }
    catch (error) { errors.push({ snapshot_id: name, error: String(error?.message || error) }); continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      preserved.push({ snapshot_id: name, reason: 'not-a-plain-directory' });
      continue;
    }
    if (referenced.has(name)) { preserved.push({ snapshot_id: name, reason: 'durable-reference' }); continue; }
    if (reserved.has(name)) { preserved.push({ snapshot_id: name, reason: 'active-reservation' }); continue; }
    const ageMs = nowMs - Number(stat.mtimeMs);
    if (ageMs < minOrphanAgeMs) { preserved.push({ snapshot_id: name, reason: 'inside-orphan-grace-period' }); continue; }
    try {
      if (removeCase01WorkspaceSnapshot({ snapshotBase: base, snapshotId: name })) removed.push(name);
    } catch (error) {
      errors.push({ snapshot_id: name, error: String(error?.message || error) });
    }
  }
  return { removed, preserved, errors };
}

export function validateCase01WorkspaceArtifact({ workspace, content, taskArtifactId = null, snapshotBase = null, snapshotId = null } = {}) {
  let evidenceRoot = workspace;
  let snapshotLocationCheck = null;
  if (snapshotId !== null) {
    if (typeof snapshotId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(snapshotId) || typeof snapshotBase !== 'string' || !path.isAbsolute(snapshotBase)) {
      throw new Error('CASE-01 snapshot identity is invalid');
    }
    const base = path.resolve(snapshotBase);
    const baseStat = fs.lstatSync(base, { bigint: true });
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('CASE-01 snapshot base must be a non-symlink directory');
    const baseRealPath = fs.realpathSync(base);
    evidenceRoot = path.join(baseRealPath, snapshotId);
    const snapshotStat = fs.lstatSync(evidenceRoot, { bigint: true });
    if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink() || fs.realpathSync(evidenceRoot) !== evidenceRoot || (snapshotStat.mode & 0o222n) !== 0n) {
      throw new Error('CASE-01 snapshot must be a read-only non-symlink directory');
    }
    for (const name of CASE01_REQUIRED_WORKSPACE_FILES) {
      const stat = fs.lstatSync(path.join(evidenceRoot, name), { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222n) !== 0n) throw new Error(`CASE-01 snapshot file is not immutable: ${name}`);
    }
    // Check the physical base/root identities after hashing too. Canonicalizing
    // the child path prevents a replaced ancestor symlink from redirecting the
    // acceptance read outside the configured snapshot directory. Same-UID
    // actors can still race filesystem operations; this narrows but does not
    // eliminate that residual TOCTOU boundary.
    const assertSnapshotLocationStable = () => {
      let currentBase;
      let currentRoot;
      try {
        currentBase = fs.lstatSync(base, { bigint: true });
        currentRoot = fs.lstatSync(evidenceRoot, { bigint: true });
        if (fs.realpathSync(base) !== baseRealPath || fs.realpathSync(evidenceRoot) !== evidenceRoot) {
          throw new Error('CASE-01 snapshot location changed during validation');
        }
      } catch (error) {
        throw new Error(`CASE-01 snapshot location changed during validation: ${String(error?.message || error)}`);
      }
      if (!currentBase.isDirectory() || currentBase.isSymbolicLink() || currentBase.dev !== baseStat.dev || currentBase.ino !== baseStat.ino ||
          !currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== snapshotStat.dev || currentRoot.ino !== snapshotStat.ino) {
        throw new Error('CASE-01 snapshot location changed during validation');
      }
    };
    assertSnapshotLocationStable();
    // Store the closure for the post-hash check below without widening the
    // accepted path surface.
    snapshotLocationCheck = assertSnapshotLocationStable;
  }
  const expected = readWorkspaceFiles(evidenceRoot);
  const declared = content?.workspace_artifacts;
  if (!Array.isArray(declared) || declared.length !== expected.length) {
    throw new Error('CASE-01 artifact must declare exactly config.json and result.json in workspace_artifacts');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const entry = declared[index];
    const actual = expected[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).sort().join(',') !== 'path,sha256' ||
        entry.path !== actual.path || entry.sha256 !== actual.sha256 ||
        !/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) {
      throw new Error(`CASE-01 workspace artifact mismatch for ${actual.path}: declared path/hash must match final file bytes and required order`);
    }
  }
  if (snapshotLocationCheck) snapshotLocationCheck();
  if (taskArtifactId !== null) {
    const refs = content?.evidence_refs;
    if (!Array.isArray(refs) || refs.length !== 1 || refs[0] !== taskArtifactId) {
      throw new Error('CASE-01 CTO decision must reference exactly the active task artifact ID');
    }
  }
  return expected;
}

// Return verified snapshot bytes to downstream consumers. Each digest is
// computed from the same buffer returned to the caller, eliminating the
// validate-path-then-reopen-path gap within this read operation. Callers must
// persist the digest/lineage they actually consume; filesystem races by a
// same-UID actor are narrowed by the descriptor and identity checks, not
// universally eliminated.
export function readVerifiedCase01WorkspaceSnapshot({ content, snapshotBase, snapshotId } = {}) {
  if (typeof snapshotId !== 'string' || !SNAPSHOT_ID_PATTERN.test(snapshotId) ||
      typeof snapshotBase !== 'string' || !path.isAbsolute(snapshotBase)) {
    throw new Error('CASE-01 snapshot identity is invalid');
  }
  const base = path.resolve(snapshotBase);
  const baseStat = fs.lstatSync(base, { bigint: true });
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('CASE-01 snapshot base must be a non-symlink directory');
  const baseRealPath = fs.realpathSync(base);
  const root = path.join(baseRealPath, snapshotId);
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root || (rootStat.mode & 0o222n) !== 0n) {
    throw new Error('CASE-01 snapshot must be a read-only non-symlink directory');
  }
  const actual = readWorkspaceFiles(root, { includeBytes: true });
  const declared = content?.workspace_artifacts;
  if (!Array.isArray(declared) || declared.length !== actual.length) {
    throw new Error('CASE-01 artifact must declare exactly config.json and result.json in workspace_artifacts');
  }
  for (let i = 0; i < actual.length; i += 1) {
    if (!declared[i] || declared[i].path !== actual[i].path || declared[i].sha256 !== actual[i].sha256) {
      throw new Error(`CASE-01 workspace artifact mismatch for ${actual[i].path}: consumed bytes must match declared SHA-256`);
    }
  }
  const baseAfter = fs.lstatSync(base, { bigint: true });
  const rootAfter = fs.lstatSync(root, { bigint: true });
  if (baseAfter.dev !== baseStat.dev || baseAfter.ino !== baseStat.ino || baseAfter.isSymbolicLink() ||
      rootAfter.dev !== rootStat.dev || rootAfter.ino !== rootStat.ino || rootAfter.isSymbolicLink() ||
      fs.realpathSync(base) !== baseRealPath || fs.realpathSync(root) !== root) {
    throw new Error('CASE-01 snapshot location changed while reading verified bytes');
  }
  return Object.freeze({
    snapshot_id: snapshotId,
    workspace_artifacts: Object.freeze(actual.map(entry => Object.freeze({
      path: entry.path,
      sha256: entry.sha256,
      // Base64 is an immutable transport representation. A consumer decodes it
      // once and should hash/consume that resulting buffer without reopening a
      // filesystem path.
      bytes_base64: entry.bytes.toString('base64'),
      utf8: entry.bytes.toString('utf8')
    })))
  });
}
