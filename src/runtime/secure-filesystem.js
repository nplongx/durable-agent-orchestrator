import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

function procPath(directoryFd, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
      name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('secure filesystem operation requires one safe path component');
  }
  return `/proc/self/fd/${directoryFd}/${name}`;
}

export function resolveWithinRoot(root, candidate, label = 'path') {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) {
    throw new Error(`${label} must be a non-empty path`);
  }
  const canonicalRoot = fs.realpathSync(root);
  const resolved = path.resolve(canonicalRoot, candidate);
  const relative = path.relative(canonicalRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the canonical workspace root`);
  }
  return resolved;
}

// Keep directory handles open while walking each component. O_NOFOLLOW applies
// to every component, and subsequent operations are anchored to the held file
// descriptor rather than resolving the caller's original path again.
export function openDirectoryWithin(root, candidate = '.', { create = false, mode = 0o700 } = {}) {
  const canonicalRoot = fs.realpathSync(root);
  const resolved = resolveWithinRoot(canonicalRoot, candidate, 'directory path');
  const relative = path.relative(canonicalRoot, resolved);
  const parts = relative ? relative.split(path.sep) : [];
  const handles = [];
  try {
    let currentFd = fs.openSync(canonicalRoot, DIRECTORY_FLAGS);
    handles.push(currentFd);
    for (const part of parts) {
      const componentPath = procPath(currentFd, part);
      if (create) {
        try { fs.mkdirSync(componentPath, { mode }); }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
      }
      const nextFd = fs.openSync(componentPath, DIRECTORY_FLAGS);
      if (!fs.fstatSync(nextFd).isDirectory()) {
        fs.closeSync(nextFd);
        throw new Error(`secure filesystem path component is not a directory: ${part}`);
      }
      handles.push(nextFd);
      currentFd = nextFd;
    }
    return {
      fd: currentFd,
      absolutePath: resolved,
      relativePath: relative,
      close() {
        for (const fd of handles.reverse()) {
          try { fs.closeSync(fd); } catch {}
        }
      }
    };
  } catch (error) {
    for (const fd of handles.reverse()) {
      try { fs.closeSync(fd); } catch {}
    }
    const wrapped = new Error(`secure directory open refused ${JSON.stringify(resolved)}: ${error?.message || error}`, { cause: error });
    if (error?.code) wrapped.code = error.code;
    throw wrapped;
  }
}

export function writeFileAtDirectory(directoryFd, name, contents, { mode = 0o600 } = {}) {
  const target = procPath(directoryFd, name);
  const fd = fs.openSync(target, CREATE_FLAGS, mode);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('secure filesystem output is not a regular file');
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Persist the new directory entry as well as the file bytes where supported.
  fs.fsyncSync(directoryFd);
}

export function readFileAtDirectory(directoryFd, name) {
  const fd = fs.openSync(procPath(directoryFd, name), READ_FLAGS);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('secure filesystem input is not a regular file');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function lstatAtDirectory(directoryFd, name) {
  return fs.lstatSync(procPath(directoryFd, name));
}

export function readlinkAtDirectory(directoryFd, name) {
  return fs.readlinkSync(procPath(directoryFd, name));
}

export function readFileWithin(root, candidate) {
  const resolved = resolveWithinRoot(root, candidate, 'file path');
  const relative = path.relative(fs.realpathSync(root), resolved);
  if (!relative) throw new Error('secure filesystem input must name a file, not the workspace root');
  const parts = relative.split(path.sep);
  const name = parts.pop();
  const parent = openDirectoryWithin(root, parts.join(path.sep) || '.');
  try { return readFileAtDirectory(parent.fd, name); }
  finally { parent.close(); }
}

export function lstatWithin(root, candidate) {
  const resolved = resolveWithinRoot(root, candidate, 'filesystem entry');
  const relative = path.relative(fs.realpathSync(root), resolved);
  if (!relative) return fs.lstatSync(fs.realpathSync(root));
  const parts = relative.split(path.sep);
  const name = parts.pop();
  const parent = openDirectoryWithin(root, parts.join(path.sep) || '.');
  try { return lstatAtDirectory(parent.fd, name); }
  finally { parent.close(); }
}

export function readlinkWithin(root, candidate) {
  const resolved = resolveWithinRoot(root, candidate, 'symlink path');
  const relative = path.relative(fs.realpathSync(root), resolved);
  if (!relative) throw new Error('workspace root cannot be a symlink entry');
  const parts = relative.split(path.sep);
  const name = parts.pop();
  const parent = openDirectoryWithin(root, parts.join(path.sep) || '.');
  try {
    if (!lstatAtDirectory(parent.fd, name).isSymbolicLink()) throw new Error('filesystem entry is not a symlink');
    return readlinkAtDirectory(parent.fd, name);
  } finally { parent.close(); }
}

export function writeFileWithin(root, candidate, contents, { mode = 0o600, createParents = false } = {}) {
  const resolved = resolveWithinRoot(root, candidate, 'output path');
  const relative = path.relative(fs.realpathSync(root), resolved);
  if (!relative) throw new Error('secure filesystem output must name a file, not the workspace root');
  const parts = relative.split(path.sep);
  const name = parts.pop();
  const parent = openDirectoryWithin(root, parts.join(path.sep) || '.', { create: createParents });
  try { writeFileAtDirectory(parent.fd, name, contents, { mode }); }
  finally { parent.close(); }
}

// Replace one regular workspace file using a same-directory temporary file and
// descriptor-anchored operations. This is deliberately not a multi-file
// transaction: callers receive per-file evidence and must report partial
// application if a later file fails. expectedSha256 is a compare-before-write
// fence; O_NOFOLLOW and the held parent descriptor prevent symlink traversal.
export function replaceFileWithin(root, candidate, contents, { expectedSha256, maxBytes = 2_000_000 } = {}) {
  if (typeof candidate !== 'string' || !candidate.trim() || path.isAbsolute(candidate) ||
      candidate.includes('\\') || candidate.includes('\0') || candidate.split('/').includes('..')) {
    throw new Error('secure filesystem replacement requires a normalized workspace-relative file path');
  }
  if (typeof contents !== 'string' && !Buffer.isBuffer(contents)) {
    throw new Error('secure filesystem replacement contents must be a string or Buffer');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('secure filesystem replacement maxBytes is invalid');
  const bytes = Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, 'utf8');
  if (bytes.length > maxBytes) throw new Error(`secure filesystem replacement exceeds ${maxBytes} bytes`);
  if (expectedSha256 !== 'ABSENT' && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))) {
    throw new Error('secure filesystem replacement expectedSha256 must be a lowercase SHA-256 digest or ABSENT');
  }
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const resolved = resolveWithinRoot(root, candidate, 'replacement path');
  const relative = path.relative(fs.realpathSync(root), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('secure filesystem replacement must name a file inside the workspace');
  }
  const parts = relative.split(path.sep);
  const name = parts.pop();
  const parent = openDirectoryWithin(root, parts.join(path.sep) || '.');
  const targetPath = procPath(parent.fd, name);
  const temporaryName = `.runalith-write-${crypto.randomUUID()}.tmp`;
  const temporaryPath = procPath(parent.fd, temporaryName);
  let temporaryCreated = false;
  try {
    let before = null;
    let beforeStat = null;
    try { beforeStat = lstatAtDirectory(parent.fd, name); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (beforeStat) {
      if (beforeStat.isSymbolicLink() || !beforeStat.isFile() || beforeStat.nlink !== 1) {
        throw new Error('secure filesystem replacement target must be a regular, non-symlink, single-link file');
      }
      before = readFileAtDirectory(parent.fd, name);
    }
    const beforeHash = before == null ? null : digest(before);
    const afterHash = digest(bytes);

    // A retry after a file rename but before its durable receipt may observe
    // the intended bytes. Report this as already present, never as a new write.
    if (beforeHash === afterHash) {
      return { changed: false, outcome: 'already_present', path: relative.split(path.sep).join('/'), before_sha256: beforeHash, after_sha256: afterHash, size_bytes: bytes.length };
    }
    if (expectedSha256 === 'ABSENT' ? before != null : beforeHash !== expectedSha256) {
      const error = new Error(`workspace file base hash mismatch: expected ${expectedSha256}, observed ${beforeHash || 'ABSENT'}`);
      error.code = 'WORKSPACE_WRITE_BASE_HASH_MISMATCH';
      error.expected_sha256 = expectedSha256;
      error.observed_sha256 = beforeHash || 'ABSENT';
      throw error;
    }

    const mode = beforeStat ? (beforeStat.mode & 0o777) : 0o600;
    writeFileAtDirectory(parent.fd, temporaryName, bytes, { mode });
    temporaryCreated = true;

    // Re-read immediately before replace, and compare the same base again.
    // The caller additionally holds the SQLite writer reservation while the
    // change/receipt commits, serializing this plugin's own writer operations.
    let currentStat = null;
    try { currentStat = lstatAtDirectory(parent.fd, name); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (beforeStat) {
      if (!currentStat || currentStat.isSymbolicLink() || !currentStat.isFile() || currentStat.nlink !== 1 ||
          currentStat.dev !== beforeStat.dev || currentStat.ino !== beforeStat.ino) {
        const error = new Error('workspace target identity changed before atomic replacement');
        error.code = 'WORKSPACE_WRITE_TARGET_CHANGED';
        throw error;
      }
      const latest = readFileAtDirectory(parent.fd, name);
      if (digest(latest) !== beforeHash) {
        const error = new Error('workspace file base hash mismatch at replacement fence');
        error.code = 'WORKSPACE_WRITE_BASE_HASH_MISMATCH';
        error.expected_sha256 = beforeHash;
        error.observed_sha256 = digest(latest);
        throw error;
      }
      // POSIX rename atomically replaces the directory entry. The path remains
      // rooted at the opened parent descriptor and never follows a final link.
      fs.renameSync(temporaryPath, targetPath);
    } else {
      if (currentStat) {
        const error = new Error('workspace target was created before exclusive file creation');
        error.code = 'WORKSPACE_WRITE_TARGET_CHANGED';
        throw error;
      }
      // link is exclusive: an external creator cannot be silently overwritten
      // when the expected base was ABSENT.
      fs.linkSync(temporaryPath, targetPath);
      fs.unlinkSync(temporaryPath);
    }
    temporaryCreated = false;
    fs.fsyncSync(parent.fd);
    const afterStat = lstatAtDirectory(parent.fd, name);
    if (!afterStat.isFile() || afterStat.isSymbolicLink() || afterStat.nlink !== 1) {
      throw new Error('secure filesystem replacement readback is not a regular single-link file');
    }
    const persisted = readFileAtDirectory(parent.fd, name);
    if (digest(persisted) !== afterHash || !persisted.equals(bytes)) {
      throw new Error('secure filesystem replacement readback hash mismatch');
    }
    return { changed: true, outcome: beforeStat ? 'replaced' : 'created', path: relative.split(path.sep).join('/'), before_sha256: beforeHash || 'ABSENT', after_sha256: afterHash, size_bytes: bytes.length };
  } finally {
    if (temporaryCreated) {
      try { fs.unlinkSync(temporaryPath); } catch {}
    }
    parent.close();
  }
}
