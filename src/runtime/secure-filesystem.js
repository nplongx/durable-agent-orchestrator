import fs from 'node:fs';
import path from 'node:path';

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
