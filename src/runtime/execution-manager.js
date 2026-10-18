import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateExecutionBatch, validateExecutionResult, MAX_EXECUTION_COMMAND_CHARS, MAX_EXECUTION_TIMEOUT_MS } from '../../protocol/cos-ap-v1/index.js';
import { parseStrictJson } from './strict-json.js';
import { assertTaskDependenciesMatchPlan } from './workflow/plan.js';

const TMUX_BIN = process.env.TMUX_BIN || 'tmux';
const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.EXECUTION_TIMEOUT_MS) || 120000);
// Execution output is persisted into SQLite and returned to workflow callers.
// The supervisor drains both pipes but only writes the first 4 MiB of each to
// disk, so a noisy task cannot exhaust the execution filesystem or collector.
const MAX_EXECUTION_OUTPUT_BYTES_PER_STREAM = 4 * 1024 * 1024;
// The batch contract may retain up to 32 durable items, but do not turn that
// into 32 simultaneous Node/shell processes. Bound local CPU/memory/file-descriptor
// pressure independently from the wire-level batch-size limit.
const MAX_CONCURRENT_EXECUTION_BATCH_LANES = 8;

// A zero OS exit code alone is not the durable success contract. In
// particular, the bounded-output collector deliberately records execution as
// failed when either captured stream is truncated, while retaining the real
// process exit code for diagnostics. Every production caller that can create
// accepted artifacts or advance a workflow must use this predicate rather
// than re-deriving success from exitCode alone.
export function isVerifiedSuccessfulLocalExecution(result, expectedTaskId) {
  return Boolean(typeof expectedTaskId === 'string' && expectedTaskId.length > 0 &&
    result && typeof result === 'object' && !Array.isArray(result) &&
    result.task_id === expectedTaskId &&
    result.status === 'completed' && result.execution_status === 'completed' &&
    result.execution_exit_code === 0 && (result.exitCode === undefined || result.exitCode === 0) &&
    typeof result.execution_session_id === 'string' && result.execution_session_id.length > 0 &&
    Number.isSafeInteger(result.execution_attempt) && result.execution_attempt > 0 &&
    (result.timedOut === undefined || result.timedOut === false) &&
    (result.outputLimited === undefined || result.outputLimited === false));
}

// MCP tool responses intentionally project only the status and exit code, so
// callers driving workflow loops must validate that exact response contract.
export function isSuccessfulLocalExecutionSummary(result, expectedTaskId) {
  return Boolean(typeof expectedTaskId === 'string' && expectedTaskId.length > 0 &&
    result && typeof result === 'object' && !Array.isArray(result) &&
    result.executed_locally === true && result.execution_status === 'completed' && result.exit_code === 0 &&
    result.returned_task_id === expectedTaskId &&
    typeof result.execution_session_id === 'string' && result.execution_session_id.length > 0 &&
    result.task && typeof result.task === 'object' && result.task.task_id === expectedTaskId && result.task.status === 'completed' &&
    result.task.execution_status === 'completed' && result.task.execution_exit_code === 0 &&
    result.task.execution_session_id === result.execution_session_id &&
    Number.isSafeInteger(result.task.execution_attempt) && result.task.execution_attempt > 0);
}
const EXECUTION_OUTPUT_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const spec = JSON.parse(process.argv[1]);
const limit = spec.maxOutputBytesPerStream;
const stdoutFd = fs.openSync(spec.stdoutPath, 'wx', 0o600);
const stderrFd = fs.openSync(spec.stderrPath, 'wx', 0o600);
let stdoutBytes = 0, stderrBytes = 0, outputLimited = false, spawnFailed = false, finalized = false;
function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (count <= 0) throw new Error('short execution-output write');
    offset += count;
  }
}
function capture(stream, fd, key) {
  stream.on('data', chunk => {
    const used = key === 'stdout' ? stdoutBytes : stderrBytes;
    const accepted = chunk.subarray(0, Math.max(0, limit - used));
    if (accepted.length) {
      try { writeAll(fd, accepted); }
      catch { outputLimited = true; }
    }
    if (key === 'stdout') stdoutBytes += accepted.length;
    else stderrBytes += accepted.length;
    if (chunk.length > accepted.length) outputLimited = true;
  });
}
function finalize(code) {
  if (finalized) return;
  finalized = true;
  try { fs.fsyncSync(stdoutFd); } finally { fs.closeSync(stdoutFd); }
  try { fs.fsyncSync(stderrFd); } finally { fs.closeSync(stderrFd); }
  if (outputLimited) fs.writeFileSync(spec.outputLimitPath, 'truncated', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(spec.exitPath, String(code), { flag: 'wx', mode: 0o600 });
  process.exitCode = code;
}
let child;
try {
  child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
} catch (error) {
  writeAll(stderrFd, Buffer.from(String(error?.message || error).slice(0, limit)));
  outputLimited = Buffer.byteLength(String(error?.message || error)) > limit;
  finalize(127);
}
if (child) {
  capture(child.stdout, stdoutFd, 'stdout');
  capture(child.stderr, stderrFd, 'stderr');
  child.once('error', error => {
    spawnFailed = true;
    const bytes = Buffer.from(String(error?.message || error));
    const accepted = bytes.subarray(0, Math.max(0, limit - stderrBytes));
    if (accepted.length) { try { writeAll(stderrFd, accepted); stderrBytes += accepted.length; } catch { outputLimited = true; } }
    if (bytes.length > accepted.length) outputLimited = true;
  });
  child.once('close', (code, signal) => finalize(spawnFailed ? 127 : code === null ? 128 : code));
}
`;

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
export function parseCanonicalExecutionExitMarker(marker, label = 'execution exit marker') {
  if (typeof marker !== 'string' || marker.length === 0) return null;
  // The supervisor writes String(code) without padding or a trailing newline.
  // Accept only that exact representation: Number() would otherwise turn -0,
  // leading-zero tokens, whitespace, and unsafe integer strings into plausible
  // numeric observations before the durable terminal contract can inspect them.
  if (!/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(marker)) {
    throw new Error(`${label} is malformed; preserve the open attempt for reconciliation`);
  }
  const code = Number(marker);
  if (!Number.isSafeInteger(code) || Object.is(code, -0)) {
    throw new Error(`${label} is not a canonical safe integer; preserve the open attempt for reconciliation`);
  }
  return code;
}
export async function readCanonicalExecutionExitMarkerFile(exitPath, label = 'execution exit marker') {
  let handle;
  try {
    handle = await fs.open(exitPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 64n) {
      throw new Error(`${label} is not a bounded regular file; preserve the open attempt for reconciliation`);
    }
    if (before.size === 0n) return null;
    const buffer = Buffer.alloc(65);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        bytesRead !== Number(after.size) || bytesRead > 64) {
      throw new Error(`${label} changed during bounded read; preserve the open attempt for reconciliation`);
    }
    return parseCanonicalExecutionExitMarker(buffer.subarray(0, bytesRead).toString('utf8'), label);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}
function structuredCommand(executable, args = []) {
  return [executable, ...args].map(shellQuote).join(' ');
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
const executableDigestCache = new Map();
const pinnedExecutableDigestCache = new Map();
const pinnedExecutableCreationPromises = new Map();

function parseSafeCommandLine(command) {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('execution command is empty or malformed');
  const args = [];
  let token = '';
  let tokenStarted = false;
  let quote = null;
  let escaped = false;
  const flush = () => {
    if (tokenStarted) args.push(token);
    token = '';
    tokenStarted = false;
  };
  for (const character of command) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') escaped = true;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    // This compatibility entry point accepts a single executable plus argv,
    // not shell programs. Operators and expansion syntax outside quotes are
    // rejected rather than interpreted by /bin/bash. Quoted script/source text
    // remains a literal argument, so node -e "...; ..." still works safely.
    if (/[;|&<>`$(){}*?\[\]\n\r]/.test(character)) {
      throw new Error(`execution command contains unsupported shell syntax outside quotes: ${character}`);
    }
    token += character;
    tokenStarted = true;
  }
  if (escaped || quote !== null) throw new Error('execution command contains an unterminated quote or escape');
  flush();
  if (!args.length || !args[0]) throw new Error('execution command has no executable token');
  return args;
}

async function resolveExecutableIdentity(executable, searchPath) {
  if (typeof executable !== 'string' || !executable || executable.includes('\0')) throw new Error('execution executable identity is invalid');
  let candidate = null;
  if (executable.includes('/')) {
    candidate = path.resolve(executable);
  } else {
    for (const directory of String(searchPath || '').split(path.delimiter)) {
      if (!directory || !path.isAbsolute(directory)) continue;
      const possible = path.join(directory, executable);
      try { await fs.access(possible); candidate = possible; break; } catch {}
    }
  }
  if (!candidate) throw new Error(`execution executable cannot be resolved in the isolated PATH: ${executable}`);
  const realpath = await fs.realpath(candidate);
  const stat = await fs.stat(realpath, { bigint: true });
  if (!stat.isFile() || (stat.mode & 0o111n) === 0n) throw new Error(`execution executable is not a regular executable file: ${executable}`);
  const fingerprint = [realpath, stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeNs, stat.ctimeNs].join('|');
  let digestPromise = executableDigestCache.get(fingerprint);
  if (!digestPromise) {
    digestPromise = (async () => {
      const bytes = await fs.readFile(realpath);
      const after = await fs.stat(realpath, { bigint: true });
      if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs ||
          stat.ctimeNs !== after.ctimeNs || bytes.length !== Number(stat.size)) {
        throw new Error(`execution executable changed while its identity was captured: ${executable}`);
      }
      return sha256(bytes);
    })();
    executableDigestCache.set(fingerprint, digestPromise);
    digestPromise.catch(() => executableDigestCache.delete(fingerprint));
  }
  const digest = await digestPromise;
  return {
    requested: executable, realpath,
    dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), uid: String(stat.uid), gid: String(stat.gid),
    size_bytes: String(stat.size), mtime_ns: String(stat.mtimeNs), ctime_ns: String(stat.ctimeNs), sha256: digest
  };
}

async function resolveDirectoryIdentity(cwd) {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw new Error('execution cwd identity is invalid');
  const requested = path.resolve(cwd);
  const realpath = await fs.realpath(requested);
  if (realpath !== requested) throw new Error(`execution cwd resolves through a symlink or non-canonical path: ${requested}`);
  const linkStat = await fs.lstat(requested, { bigint: true });
  const stat = await fs.stat(requested, { bigint: true });
  if (linkStat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`execution cwd must be a real directory: ${requested}`);
  return {
    requested, realpath, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    uid: String(stat.uid), gid: String(stat.gid), mtime_ns: String(stat.mtimeNs)
  };
}

function validatedExplicitEnvironment(env = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new TypeError('execution environment must be an object');
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new TypeError(`invalid explicit execution environment entry: ${key}`);
    }
    // These variables alter code loading, dynamic linking, shell startup, or
    // executable/module resolution outside the immutable command contract.
    // They are never accepted even as per-call overrides.
    const upperKey = key.toUpperCase();
    if (['PATH', 'HOME', 'SHELL', 'BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
      'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'SHELLOPTS', 'BASHOPTS',
      'PYTHONPATH', 'PYTHONHOME', 'RUBYOPT', 'PERL5OPT', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
      'ELECTRON_RUN_AS_NODE', 'GIT_EXEC_PATH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS'].includes(upperKey) ||
        upperKey.startsWith('GIT_CONFIG_') || upperKey.startsWith('NPM_CONFIG_')) {
      throw new Error(`execution environment cannot override protected variable ${key}`);
    }
    out[key] = value;
  }
  return out;
}

function baseExecutionEnvironment({ homeDir = '/tmp', tmpDir = '/tmp' } = {}) {
  // Do not inherit process.env. In particular, ambient NODE_OPTIONS,
  // NODE_PATH, BASH_ENV, LD_PRELOAD, exported shell functions, proxy settings,
  // or a prepended PATH must not change execution under an immutable plan.
  const runtimeBin = path.dirname(process.execPath);
  const pathValue = [...new Set([runtimeBin, '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'])].join(':');
  return {
    PATH: pathValue,
    HOME: homeDir,
    TMPDIR: tmpDir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    NPM_CONFIG_GLOBALCONFIG: '/dev/null'
  };
}

async function ensurePrivateExecutionDirectory(directory, label) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const linkStat = await fs.lstat(directory, { bigint: true });
  if (!linkStat.isDirectory() || linkStat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink or special file`);
  }
  if (typeof process.getuid === 'function' && linkStat.uid !== BigInt(process.getuid())) {
    throw new Error(`${label} must be owned by the execution service user`);
  }
  const canonical = await fs.realpath(directory);
  if (canonical !== directory) throw new Error(`${label} must not resolve through a symlink`);
  // mkdir(mode) does not change permissions on an existing directory. Repair
  // an existing service-owned directory before placing shell-redirection files
  // inside it, so another local user cannot swap output paths for symlinks.
  await fs.chmod(directory, 0o700);
  const stat = await fs.stat(directory, { bigint: true });
  if ((stat.mode & 0o077n) !== 0n) throw new Error(`${label} is accessible to group or other users`);
}

async function readBoundedExecutionOutput(filePath, maxBytes = MAX_EXECUTION_OUTPUT_BYTES_PER_STREAM) {
  let handle;
  try { handle = await fs.open(filePath, 'r'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { text: '', truncated: false };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`execution output is not a regular file: ${filePath}`);
    const length = Math.min(Number(stat.size), maxBytes);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return { text: bytes.subarray(0, offset).toString('utf8'), truncated: Number(stat.size) > maxBytes };
  } finally {
    await handle.close();
  }
}

async function pinExecutableIdentity(identity, directory) {
  await ensurePrivateExecutionDirectory(directory, 'pinned executable directory');
  const destination = path.join(directory, `${identity.sha256}.bin`);
  let source;
  try {
    source = await fs.open(identity.realpath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await source.stat({ bigint: true });
    if (!stat.isFile() || String(stat.dev) !== identity.dev || String(stat.ino) !== identity.ino ||
        String(stat.size) !== identity.size_bytes || String(stat.mtimeNs) !== identity.mtime_ns ||
        String(stat.ctimeNs) !== identity.ctime_ns) {
      throw new Error(`execution executable changed before it could be pinned: ${identity.requested}`);
    }
    let destinationExists = true;
    try { await fs.lstat(destination); }
    catch (error) { if (error?.code === 'ENOENT') destinationExists = false; else throw error; }
    if (!destinationExists) {
      // Batch lanes can pin identical large executables at once. Share only
      // the in-flight copy operation; every caller still independently checks
      // its source identity and verifies the final destination below.
      let createPromise = pinnedExecutableCreationPromises.get(destination);
      if (!createPromise) {
        createPromise = (async () => {
          const bytes = await source.readFile();
          if (bytes.length !== Number(identity.size_bytes) || sha256(bytes) !== identity.sha256) {
            throw new Error(`execution executable bytes changed before they could be pinned: ${identity.requested}`);
          }
          const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
          let output;
          try {
            output = await fs.open(temporary, 'wx', 0o600);
            await output.writeFile(bytes);
            await output.sync();
            await output.chmod(0o500);
            await output.close();
            output = null;
            try { await fs.link(temporary, destination); }
            catch (error) { if (error?.code !== 'EEXIST') throw error; }
          } finally {
            if (output) await output.close().catch(() => {});
            await fs.rm(temporary, { force: true }).catch(() => {});
          }
        })();
        pinnedExecutableCreationPromises.set(destination, createPromise);
        createPromise.then(() => {
          if (pinnedExecutableCreationPromises.get(destination) === createPromise) pinnedExecutableCreationPromises.delete(destination);
        }, () => {
          if (pinnedExecutableCreationPromises.get(destination) === createPromise) pinnedExecutableCreationPromises.delete(destination);
        });
      }
      await createPromise;
    }
    await source.close();
    source = null;

    const linkStat = await fs.lstat(destination, { bigint: true });
    if (!linkStat.isFile() || linkStat.isSymbolicLink() ||
        (typeof process.getuid === 'function' && linkStat.uid !== BigInt(process.getuid())) ||
        (linkStat.mode & 0o222n) !== 0n || String(linkStat.size) !== identity.size_bytes) {
      throw new Error(`pinned executable is not a private immutable regular file: ${identity.requested}`);
    }
    const canonical = await fs.realpath(destination);
    if (canonical !== destination) throw new Error(`pinned executable path is not canonical: ${identity.requested}`);
    const fingerprint = [linkStat.dev, linkStat.ino, linkStat.mode, linkStat.uid, linkStat.gid,
      linkStat.size, linkStat.mtimeNs, linkStat.ctimeNs].join('|');
    let pinnedDigestPromise = pinnedExecutableDigestCache.get(fingerprint);
    if (!pinnedDigestPromise) {
      pinnedDigestPromise = fs.readFile(destination).then(bytes => sha256(bytes));
      pinnedExecutableDigestCache.set(fingerprint, pinnedDigestPromise);
      pinnedDigestPromise.catch(() => pinnedExecutableDigestCache.delete(fingerprint));
    }
    if (await pinnedDigestPromise !== identity.sha256) {
      pinnedExecutableDigestCache.delete(fingerprint);
      throw new Error(`pinned executable bytes failed identity verification: ${identity.requested}`);
    }
    return {
      ...identity,
      source_realpath: identity.realpath,
      source_identity: {
        realpath: identity.realpath, dev: identity.dev, ino: identity.ino, mode: identity.mode,
        uid: identity.uid, gid: identity.gid, size_bytes: identity.size_bytes,
        mtime_ns: identity.mtime_ns, ctime_ns: identity.ctime_ns
      },
      realpath: destination,
      dev: String(linkStat.dev), ino: String(linkStat.ino), mode: String(linkStat.mode),
      uid: String(linkStat.uid), gid: String(linkStat.gid),
      size_bytes: String(linkStat.size), mtime_ns: String(linkStat.mtimeNs), ctime_ns: String(linkStat.ctimeNs),
      pinned: true
    };
  } finally {
    if (source) await source.close().catch(() => {});
  }
}

async function assertPinnedExecutableUnchanged(identity) {
  if (!identity || identity.pinned !== true || typeof identity.realpath !== 'string' ||
      !path.isAbsolute(identity.realpath) || path.resolve(identity.realpath) !== identity.realpath) {
    throw new Error('execution boundary does not name a canonical pinned executable');
  }
  const linkStat = await fs.lstat(identity.realpath, { bigint: true });
  if (!linkStat.isFile() || linkStat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && linkStat.uid !== BigInt(process.getuid())) ||
      (linkStat.mode & 0o222n) !== 0n || String(linkStat.dev) !== identity.dev || String(linkStat.ino) !== identity.ino ||
      String(linkStat.mode) !== identity.mode || String(linkStat.size) !== identity.size_bytes ||
      String(linkStat.mtimeNs) !== identity.mtime_ns || String(linkStat.ctimeNs) !== identity.ctime_ns ||
      await fs.realpath(identity.realpath) !== identity.realpath) {
    throw new Error(`pinned executable filesystem identity changed: ${identity.requested}`);
  }
  let handle;
  try {
    handle = await fs.open(identity.realpath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || String(before.dev) !== identity.dev || String(before.ino) !== identity.ino ||
        String(before.mode) !== identity.mode || String(before.size) !== identity.size_bytes ||
        String(before.mtimeNs) !== identity.mtime_ns || String(before.ctimeNs) !== identity.ctime_ns) {
      throw new Error(`pinned executable changed before descriptor verification: ${identity.requested}`);
    }
    const fingerprint = [before.dev, before.ino, before.mode, before.uid, before.gid,
      before.size, before.mtimeNs, before.ctimeNs].join('|');
    let digestPromise = pinnedExecutableDigestCache.get(fingerprint);
    if (!digestPromise) {
      digestPromise = handle.readFile().then(bytes => sha256(bytes));
      pinnedExecutableDigestCache.set(fingerprint, digestPromise);
      digestPromise.catch(() => pinnedExecutableDigestCache.delete(fingerprint));
    }
    const digest = await digestPromise;
    const after = await handle.stat({ bigint: true });
    const afterPath = await fs.lstat(identity.realpath, { bigint: true });
    if (digest !== identity.sha256 || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        afterPath.isSymbolicLink() || afterPath.dev !== after.dev || afterPath.ino !== after.ino ||
        afterPath.size !== after.size || afterPath.mtimeNs !== after.mtimeNs || afterPath.ctimeNs !== after.ctimeNs) {
      pinnedExecutableDigestCache.delete(fingerprint);
      throw new Error(`pinned executable bytes or path changed after preparation: ${identity.requested}`);
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function assertExecutableSourceUnchanged(identity) {
  const expected = identity?.source_identity;
  const sourcePath = identity?.source_realpath;
  if (!expected || typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || path.resolve(sourcePath) !== sourcePath) {
    throw new Error('execution boundary is missing its canonical original executable identity');
  }
  const link = await fs.lstat(sourcePath, { bigint: true });
  const actual = await fs.stat(sourcePath, { bigint: true });
  if (link.isSymbolicLink() || !actual.isFile() || await fs.realpath(sourcePath) !== sourcePath ||
      String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino ||
      String(actual.mode) !== expected.mode || String(actual.uid) !== expected.uid ||
      String(actual.gid) !== expected.gid || String(actual.size) !== expected.size_bytes ||
      String(actual.mtimeNs) !== expected.mtime_ns || String(actual.ctimeNs) !== expected.ctime_ns) {
    throw new Error(`execution original executable source identity changed after preparation: ${identity.requested}`);
  }
}

function envAssignments(env) {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function assertImmutablePlannedExecution(store, task, { executable = null, args = null, command = null, cwd, timeoutMs, env = {} } = {}) {
  const metadata = parseStrictJson(task.metadata_json || '{}');
  const plan = store.getExecutionPlan(task.job_id);
  const role = String(task.role || '').toLowerCase();
  const plannedByRole = plan?.children?.find(item => String(item.role || '').toLowerCase() === role) || null;
  const requiresPlanBinding = Boolean(metadata.workflow_plan_task_id) || Boolean(plan && task.parent_task_id) || Boolean(plannedByRole);
  if (!requiresPlanBinding) return null;
  if (!plan) throw new Error(`immutable execution plan is missing for planned task ${task.task_id}`);
  const plannedById = metadata.workflow_plan_task_id
    ? plan.children.find(item => item.id === metadata.workflow_plan_task_id)
    : null;
  if (!metadata.workflow_plan_task_id || !plannedById || !plannedByRole || plannedById.id !== plannedByRole.id) {
    throw new Error(`immutable plan task identity/role binding is invalid for ${task.task_id}`);
  }
  assertTaskDependenciesMatchPlan(task, plannedById, `task ${task.task_id}`);
  const specification = plannedById.execution;
  if (!specification || specification.deterministic !== true || specification.executor !== 'ExecutionManager' ||
      typeof specification.executable !== 'string' || !Array.isArray(specification.args) ||
      typeof specification.cwd !== 'string' || !Number.isSafeInteger(Number(specification.timeout_ms)) || Number(specification.timeout_ms) < 1) {
    throw new Error(`immutable plan does not authorize deterministic execution for ${task.task_id}`);
  }
  if (metadata.deterministic !== true || metadata.executor !== specification.executor ||
      metadata.executable !== specification.executable || JSON.stringify(metadata.args) !== JSON.stringify(specification.args) ||
      path.resolve(String(metadata.cwd || '')) !== path.resolve(specification.cwd) ||
      Number(metadata.timeout_ms) !== Number(specification.timeout_ms)) {
    throw new Error(`task metadata differs from the immutable approved execution plan for ${task.task_id}`);
  }

  // Recompile from the currently approved proposal workspace and built-in
  // workflow definition. Comparing only the stored plan row and its adjacent
  // hash/event would let a database writer rewrite all three together.
  const proposal = store.getCurrentProposal(task.job_id);
  if (!proposal?.payload || typeof proposal.payload.workspace !== 'string' || !proposal.payload.workspace) {
    throw new Error(`approved proposal workspace is missing for immutable plan ${task.job_id}`);
  }
  store.assertApprovalCurrent(task.job_id);
  const recompiled = store.compileExecutionPlan(task.job_id, { workspace: proposal.payload.workspace });
  if (!recompiled || recompiled.plan_hash !== plan.plan_hash || recompiled.plan_hash !== store.getExecutionPlan(task.job_id)?.plan_hash) {
    throw new Error(`immutable execution plan no longer matches the approved source plan for ${task.job_id}`);
  }

  if (executable !== null && executable !== specification.executable) {
    throw new Error(`requested executable differs from the immutable approved plan for ${task.task_id}`);
  }
  if (args !== null && JSON.stringify(args) !== JSON.stringify(specification.args)) {
    throw new Error(`requested arguments differ from the immutable approved plan for ${task.task_id}`);
  }
  const expectedCommand = structuredCommand(specification.executable, specification.args);
  if (command !== null && command !== expectedCommand) {
    throw new Error(`requested command differs from the immutable approved plan for ${task.task_id}`);
  }
  if (path.resolve(String(cwd || '')) !== path.resolve(specification.cwd)) {
    throw new Error(`requested working directory differs from the immutable approved plan for ${task.task_id}`);
  }
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) < 1 || Number(timeoutMs) > Number(specification.timeout_ms)) {
    throw new Error(`requested timeout exceeds or invalidates the immutable approved plan for ${task.task_id}`);
  }
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length !== 0) {
    throw new Error(`environment overrides are not authorized by the immutable plan for ${task.task_id}`);
  }
  return specification;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('Request aborted by caller');
}

function delay(ms, signal = null) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new Error('Request aborted by caller'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Request aborted by caller'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const MAX_EXECUTION_CONTROL_OUTPUT_BYTES = 8 * 1024 * 1024;

// The tmux control client is part of the authorization-to-OS-spawn boundary.
// Bound its output and terminate its POSIX process group on timeout/cancellation
// instead of killing only the direct client while descendants can keep pipes
// open. This does not prove that daemonized descendants or the tmux server have
// no effects; callers must retain the existing possibly_spawned quarantine.
export function runExecutionControlCommand(command, args, {
  timeoutMs = 30000, signal = null, env = baseExecutionEnvironment(),
  maxOutputBytes = MAX_EXECUTION_CONTROL_OUTPUT_BYTES, executableFd = null
} = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      reject(new Error('execution control timeout must be a positive safe integer'));
      return;
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      reject(new Error('execution control output limit must be a positive safe integer'));
      return;
    }
    // A pre-aborted request is an authorization/cancellation decision made
    // before the OS boundary. Reject it before spawn(), rather than briefly
    // creating a process and only then noticing the cancelled signal.
    if (signal?.aborted) {
      reject(Object.assign(new Error('Request aborted by caller'), { code: 'ABORT_ERR', spawned: false }));
      return;
    }
    let child;
    try {
      if (executableFd !== null && (!Number.isSafeInteger(executableFd) || executableFd < 0)) {
        reject(new Error('execution control executable descriptor must be a non-negative file descriptor'));
        return;
      }
      // On Linux, an open descriptor prevents a pathname replacement between
      // the final identity check and exec. The descriptor is deliberately
      // inherited as child fd 3 before /proc/self/fd/3 is resolved by execve.
      // This closes path-substitution races; it does not protect against a
      // hostile process with the same service UID modifying the open inode.
      const spawnPath = executableFd === null ? command : '/proc/self/fd/3';
      child = spawn(spawnPath, args, {
        stdio: executableFd === null ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', executableFd], env,
        detached: process.platform !== 'win32', windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdoutChunks = []; const stderrChunks = [];
    let stdoutBytes = 0; let stderrBytes = 0; let totalBytes = 0;
    let timer; let killTimer;
    let settled = false;
    let abortReason = null;
    const removeAbortHandler = () => signal?.removeEventListener('abort', onAbort);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      removeAbortHandler();
    };
    const stdoutBuffer = () => Buffer.concat(stdoutChunks, stdoutBytes);
    const stderrBuffer = () => Buffer.concat(stderrChunks, stderrBytes);
    const signalGroup = name => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) {
        if (error?.code !== 'ESRCH') { try { child.kill(name); } catch {} }
      }
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error.stdout ??= stdoutBuffer().toString('utf8');
      error.stderr ??= stderrBuffer().toString('utf8');
      reject(error);
    };
    const abort = (reason, code) => {
      if (abortReason || settled) return;
      abortReason = reason;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        // Send SIGKILL even if the leader closed first: a descendant may have
        // inherited no output pipe and can outlive the client. Destroy our
        // pipe ends after the grace period so an escaped descendant holding a
        // pipe cannot keep this control operation pending forever.
        signalGroup('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        const error = Object.assign(new Error(reason), { code, spawned: true });
        finishReject(error);
      }, 300);
    };
    const onAbort = () => {
      abort('Request aborted by caller', 'ABORT_ERR');
    };
    const collect = (chunks, stream, chunk) => {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;
      const remaining = Math.max(0, maxOutputBytes - (stdoutBytes + stderrBytes));
      if (remaining > 0) {
        const accepted = Buffer.from(bytes.subarray(0, remaining));
        chunks.push(accepted);
        if (stream === 'stdout') stdoutBytes += accepted.length;
        else stderrBytes += accepted.length;
      }
      if (totalBytes > maxOutputBytes) abort(`execution control command exceeded ${maxOutputBytes} combined stdout/stderr bytes`, 'OUTPUT_LIMIT');
    };
    child.stdout.on('data', chunk => collect(stdoutChunks, 'stdout', chunk));
    child.stderr.on('data', chunk => collect(stderrChunks, 'stderr', chunk));
    if (timeoutMs > 0) timer = setTimeout(() => abort(`command timeout: ${command}`, 'TIMEOUT'), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => {
      if (!child.pid && !abortReason) finishReject(error);
      else abort(`execution control child error after spawn: ${error.message}`, 'CHILD_PROCESS_ERROR');
    });
    child.on('close', (code, childSignal) => {
      if (settled) return;
      if (abortReason) return;
      settled = true;
      cleanup();
      resolve({ code, signal: childSignal, stdout: stdoutBuffer().toString('utf8'), stderr: stderrBuffer().toString('utf8') });
    });
  });
}

const run = runExecutionControlCommand;

async function runPinnedExecutionControlCommand(identity, args, options = {}) {
  let handle;
  let spawnAttempted = false;
  try {
    if (process.platform !== 'linux') {
      // Other platforms retain the final pathname/hash verification, but do
      // not have the Linux /proc/self/fd execution mechanism.
      const current = await fs.readFile(identity.realpath);
      if (sha256(current) !== identity.sha256) throw new Error('pinned execution-control executable bytes changed before invocation');
      spawnAttempted = true;
      return await run(identity.realpath, args, options);
    }
    handle = await fs.open(identity.realpath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || String(stat.dev) !== identity.dev || String(stat.ino) !== identity.ino ||
        String(stat.mode) !== identity.mode || String(stat.uid) !== identity.uid || String(stat.gid) !== identity.gid ||
        String(stat.size) !== identity.size_bytes || String(stat.mtimeNs) !== identity.mtime_ns ||
        String(stat.ctimeNs) !== identity.ctime_ns) {
      throw new Error('pinned execution-control executable filesystem identity changed before invocation');
    }
    const bytes = await handle.readFile();
    if (sha256(bytes) !== identity.sha256) throw new Error('pinned execution-control executable bytes changed before invocation');
    spawnAttempted = true;
    return await run(identity.realpath, args, { ...options, executableFd: handle.fd });
  } catch (error) {
    if (!spawnAttempted) error.spawned = false;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class ExecutionManager {
  constructor(store, { tmuxBin = TMUX_BIN, timeoutMs = DEFAULT_TIMEOUT_MS, executionTmpDir = process.env.EXECUTION_TMP_DIR || path.join(process.env.WORKFLOW_DATA_DIR || '/tmp', 'runtime') } = {}) {
    this.store = store;
    this.tmuxBin = tmuxBin;
    this.timeoutMs = timeoutMs;
    this.executionTmpDir = path.resolve(executionTmpDir);
    this.executionHomeDir = path.join(this.executionTmpDir, '.execution-home');
  }

  async _executionSessionAbsent(boundaryIdentity, tmuxName) {
    const env = baseExecutionEnvironment({ homeDir: this.executionHomeDir, tmpDir: this.executionTmpDir });
    try {
      await runPinnedExecutionControlCommand(boundaryIdentity.tmux, ['kill-session', '-t', tmuxName], {
        timeoutMs: 5000, env
      });
    } catch { /* verify the exact session independently below */ }
    try {
      const probe = await runPinnedExecutionControlCommand(boundaryIdentity.tmux, ['has-session', '-t', tmuxName], {
        timeoutMs: 5000, env
      });
      if (probe.code === 0) return false;
      const diagnostic = `${probe.stdout || ''}\n${probe.stderr || ''}`.toLowerCase();
      // A generic non-zero response is not proof of absence (the tmux client
      // itself may be broken or its executable identity may have changed).
      return /can't find session|no server running|session not found|can't find current session/.test(diagnostic);
    } catch {
      return false;
    }
  }

  async _retainAmbiguousSpawn(taskId, executionSessionId, attempt, command, tmuxName, boundaryIdentity, error, signal) {
    const sessionAbsent = await this._executionSessionAbsent(boundaryIdentity, tmuxName);
    if (signal?.aborted && sessionAbsent) {
      // Explicit cancellation plus verified absence of the exact tmux session
      // is the narrow case where the local execution can be terminalized as
      // cancelled. If cleanup cannot be verified, preserve the open attempt.
      this.store.finishExecution(taskId, {
        executionSessionId, attempt, command,
        exitCode: null, stdout: '', stderr: error.message, status: 'cancelled', error: error.message
      });
      return { terminalized: true, sessionAbsent };
    }
    const task = this.getTask(taskId);
    try {
      this.store.recordEvent(task?.job_id, 'execution.spawn_reconciliation_required', {
        taskId, executionSessionId, attempt, tmuxName, sessionAbsent,
        reason: String(error?.message || error),
        classification: 'post-spawn-control-failure; result is not verified; do not retry automatically'
      }, `${taskId}|spawn-reconciliation-required|${attempt}`);
    } catch { /* preserve original control error and the still-open durable attempt */ }
    error.executionSpawnOutcome = 'possibly_spawned';
    error.message = `execution process was accepted by tmux but its outcome is not verified; durable attempt remains running for reconciliation (tmux_session_absent=${sessionAbsent}): ${error.message}`;
    return { terminalized: false, sessionAbsent };
  }

  async _collectExistingExecutionFromExitMarker(task, { command, batchClaim = null } = {}) {
    // Safe crash recovery for the interval after the supervisor durably writes
    // its exit marker but before the original manager commits the task ledger.
    // Never re-run work based only on a stale RUNNING flag. Require the exact
    // prepared task/session/attempt, immutable command/boundary, canonical
    // execution.started event, and (for a batch lane) the exact durable claim.
    if (!task || task.execution_status !== 'running' || task.status !== 'running') return null;
    const taskId = task.task_id;
    const executionSessionId = task.execution_session_id;
    if (typeof task.execution_attempt !== 'number' || !Number.isSafeInteger(task.execution_attempt) || task.execution_attempt < 1) return null;
    const attempt = task.execution_attempt;
    if (typeof taskId !== 'string' || !taskId || typeof executionSessionId !== 'string' || !executionSessionId ||
        !Number.isSafeInteger(attempt) || attempt < 1) return null;
    const metadata = parseStrictJson(task.metadata_json || '{}', 'durable task metadata during execution recovery');
    if (typeof command !== 'string' || metadata.command !== command || metadata.tmuxName !== `cos-exec-${executionSessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`) return null;
    if (batchClaim && (typeof batchClaim.batchAttempt !== 'number' || !Number.isSafeInteger(batchClaim.batchAttempt) || batchClaim.batchAttempt < 1 ||
        typeof batchClaim.itemAttempt !== 'number' || !Number.isSafeInteger(batchClaim.itemAttempt) || batchClaim.itemAttempt < 1)) return null;
    const expectedClaim = batchClaim ? {
      batchId: batchClaim.batchId,
      itemId: batchClaim.itemId,
      batchAttempt: batchClaim.batchAttempt,
      itemAttempt: batchClaim.itemAttempt
    } : null;
    if (expectedClaim) {
      if (!metadata.execution_batch_claim || canonicalJson(metadata.execution_batch_claim) !== canonicalJson(expectedClaim)) return null;
    } else if (metadata.execution_batch_claim) {
      // A generic task caller must not collect a batch-owned lane behind its
      // batch aggregate's back. The batch reconciler supplies its exact claim.
      return null;
    }
    const boundary = metadata.execution_boundary_identity;
    if (!boundary || boundary.schema_version !== 1 || boundary.task_id !== taskId ||
        boundary.attempt !== attempt || boundary.command !== command ||
        boundary.cwd?.requested !== path.resolve(String(metadata.cwd || '')) ||
        !/^[a-f0-9]{64}$/.test(String(boundary.environment_sha256 || '')) ||
        !/^[a-f0-9]{64}$/.test(String(boundary.executable?.sha256 || '')) ||
        !/^[a-f0-9]{64}$/.test(String(boundary.tmux?.sha256 || ''))) return null;

    const startRows = this.store.db.prepare(`SELECT event_id,job_id,type,payload_json FROM events
      WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?`)
      .all(task.job_id, taskId, attempt);
    if (startRows.length !== 1) return null;
    const startEvent = startRows[0];
    let payload;
    try { payload = parseStrictJson(startEvent.payload_json, 'durable execution.started recovery event'); }
    catch { return null; }
    const expectedKeys = [
      'attempt', 'attemptId', 'command', 'cwd',
      ...(expectedClaim ? ['executionBatchClaim'] : []),
      'executionBoundaryIdentity', 'executionSessionId', 'taskId', 'tmuxName'
    ].sort().join(',');
    if (startEvent.job_id !== task.job_id || startEvent.type !== 'execution.started' ||
        startEvent.payload_json !== JSON.stringify(payload) || payload.taskId !== taskId ||
        payload.executionSessionId !== executionSessionId || typeof payload.attempt !== 'number' || payload.attempt !== attempt ||
        payload.command !== command || payload.tmuxName !== metadata.tmuxName ||
        typeof payload.attemptId !== 'string' || !payload.attemptId ||
        Object.keys(payload).sort().join(',') !== expectedKeys ||
        canonicalJson(payload.executionBoundaryIdentity) !== canonicalJson(boundary) ||
        (expectedClaim && canonicalJson(payload.executionBatchClaim) !== canonicalJson(expectedClaim))) return null;

    const exitPath = path.join(this.executionTmpDir, `${metadata.tmuxName}.exit`);
    const exitCode = await readCanonicalExecutionExitMarkerFile(exitPath,
      `existing execution exit marker for ${taskId}/${attempt}`);
    if (exitCode === null) return null;
    return this.collect(taskId, { executionSessionId, attempt, command, exitCode, timeout: false });
  }

  async _prepareExecutionEnvironment(env = {}) {
    const explicit = validatedExplicitEnvironment(env);
    await ensurePrivateExecutionDirectory(this.executionTmpDir, 'execution temporary directory');
    await fs.mkdir(this.executionHomeDir, { recursive: true, mode: 0o700 });
    const homeStat = await fs.lstat(this.executionHomeDir);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
      throw new Error('isolated execution HOME must be a real directory, not a symlink or special file');
    }
    await fs.chmod(this.executionHomeDir, 0o700);
    return { ...baseExecutionEnvironment({ homeDir: this.executionHomeDir, tmpDir: this.executionTmpDir }), ...explicit };
  }

  async _captureExecutionBoundary(taskId, { attempt, command, cwd, env, executable, executionLease = null }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found while binding OS execution boundary: ${taskId}`);
    const metadata = parseStrictJson(task.metadata_json || '{}');
    const plan = this.store.getExecutionPlan(task.job_id);
    const proposal = this.store.getCurrentProposal(task.job_id);
    const approval = this.store.getLatestApproval(task.job_id);
    if (plan) {
      this.store.assertApprovalCurrent(task.job_id);
      if (!approval || approval.decision !== 'approved' || !proposal || approval.proposal_hash !== proposal.proposalHash) {
        throw new Error(`current approval identity is unavailable for OS execution boundary: ${task.job_id}`);
      }
    }
    const requestedLeaseId = executionLease?.leaseId ?? task.lease_id ?? metadata.lease_id ?? metadata.task_lease_id ?? null;
    const requestedLeaseExpiry = task.lease_expires_at ?? metadata.lease_expires_at ?? metadata.lease_until ?? null;
    const activeLease = this.store.db.prepare("SELECT * FROM task_leases WHERE task_id=? AND state='ACTIVE'").get(taskId) || null;
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 ||
        typeof task.execution_attempt !== 'number' || !Number.isSafeInteger(task.execution_attempt) || task.execution_attempt < 0) {
      throw new Error(`task execution attempt is not an exact safe integer at OS boundary capture: ${taskId}`);
    }
    let leaseIdentity = { lease_id: null, state: null, attempt: null, worker_id: null, owner_epoch: null, expires_at: null };
    if (requestedLeaseId || requestedLeaseExpiry || activeLease || executionLease) {
      const lease = requestedLeaseId ? this.store.getTaskLease(requestedLeaseId) : activeLease;
      if (lease?.state === 'ACTIVE' && Date.parse(lease.expires_at) > Date.now() && !executionLease) {
        throw new Error(`active task lease is not bound to this OS execution owner; local spawn is refused: ${taskId}`);
      }
      if (!lease || lease.state !== 'ACTIVE' || lease.task_id !== taskId || lease.job_id !== task.job_id ||
          !activeLease || activeLease.lease_id !== lease.lease_id ||
          !Number.isFinite(Date.parse(lease.expires_at)) || Date.parse(lease.expires_at) <= Date.now() ||
          typeof lease.attempt !== 'number' || !Number.isSafeInteger(lease.attempt) || lease.attempt !== task.execution_attempt ||
          !executionLease || typeof executionLease.workerId !== 'string' || !executionLease.workerId ||
          executionLease.leaseId !== lease.lease_id || executionLease.workerId !== lease.worker_id ||
          !Number.isSafeInteger(executionLease.ownerEpoch) || executionLease.ownerEpoch < 1 ||
          typeof lease.owner_epoch !== 'number' || lease.owner_epoch !== executionLease.ownerEpoch ||
          typeof executionLease.attempt !== 'number' || executionLease.attempt !== lease.attempt || attempt !== lease.attempt) {
        throw new Error(`task lease is absent, stale, expired, substituted, or detached from this execution attempt: ${taskId}`);
      }
      leaseIdentity = {
        lease_id: lease.lease_id, state: lease.state, attempt: lease.attempt,
        worker_id: lease.worker_id, owner_epoch: lease.owner_epoch, expires_at: lease.expires_at
      };
    }
    const controlEnv = baseExecutionEnvironment({ homeDir: this.executionHomeDir, tmpDir: this.executionTmpDir });
    const [cwdIdentity, resolvedExecutableIdentity, resolvedTmuxIdentity, resolvedSupervisorIdentity] = await Promise.all([
      resolveDirectoryIdentity(cwd),
      resolveExecutableIdentity(executable, env.PATH),
      resolveExecutableIdentity(this.tmuxBin, controlEnv.PATH),
      resolveExecutableIdentity(process.execPath, controlEnv.PATH)
    ]);
    // Hashing a pathname and then executing that same pathname still leaves a
    // replacement race after the final authorization check. Execute a private,
    // content-addressed copy instead; the exact bytes used for the shell and
    // task executable are now the bytes bound into the durable boundary.
    const pinnedDirectory = path.join(this.executionTmpDir, '.pinned-executables');
    const executableIdentity = await pinExecutableIdentity(resolvedExecutableIdentity, pinnedDirectory);
    const tmuxIdentity = await pinExecutableIdentity(resolvedTmuxIdentity, pinnedDirectory);
    const supervisorIdentity = await pinExecutableIdentity(resolvedSupervisorIdentity, pinnedDirectory);
    return {
      schema_version: 1,
      task_id: taskId,
      job_id: task.job_id,
      attempt,
      command,
      plan_hash: plan?.plan_hash || null,
      approval: approval ? {
        approval_id: approval.approval_id,
        decision: approval.decision,
        proposal_hash: approval.proposal_hash || null,
        current_proposal_hash: proposal?.proposalHash || null
      } : null,
      lease: leaseIdentity,
      cwd: cwdIdentity,
      executable: executableIdentity,
      tmux: tmuxIdentity,
      supervisor: supervisorIdentity,
      output_capture: { schema_version: 1, max_bytes_per_stream: MAX_EXECUTION_OUTPUT_BYTES_PER_STREAM,
        supervisor_sha256: sha256(EXECUTION_OUTPUT_SUPERVISOR_SOURCE) },
      environment_sha256: sha256(canonicalJson(env))
    };
  }

  async _assertExecutionBoundaryUnchanged(taskId, expected, { attempt, command, cwd, env, executable, executionLease = null }) {
    const task = this.getTask(taskId);
    if (!task || task.job_id !== expected.job_id || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 ||
        typeof task.execution_attempt !== 'number' || !Number.isSafeInteger(task.execution_attempt) || task.execution_attempt !== attempt ||
        task.execution_status !== 'running' || task.status !== 'running' || task.execution_session_id == null) {
      throw new Error(`execution task/session/attempt ownership changed before OS spawn: ${taskId}`);
    }
    const persisted = parseStrictJson(task.metadata_json || '{}').execution_boundary_identity;
    if (!persisted || canonicalJson(persisted) !== canonicalJson(expected)) {
      throw new Error(`durable execution OS-boundary identity is missing or substituted: ${taskId}`);
    }
    // The exact executable, tmux binary, and supervisor were already resolved,
    // hashed, and copied into private content-addressed files before the durable
    // execution.started event. Re-resolving and re-copying those source binaries
    // here adds several 100-MB reads per batch lane without improving the bytes
    // that will execute; instead revalidate the pinned descriptors, cwd identity,
    // immutable plan/approval, and exact active lease at the launch boundary.
    const currentCwd = await resolveDirectoryIdentity(cwd);
    if (canonicalJson(currentCwd) !== canonicalJson(expected.cwd) ||
        sha256(canonicalJson(env)) !== expected.environment_sha256 ||
        expected.task_id !== taskId || expected.attempt !== attempt || expected.command !== command ||
        expected.executable?.requested !== executable) {
      throw new Error(`execution cwd/environment/task/command identity changed after preparation: ${taskId}`);
    }
    await Promise.all([
      assertExecutableSourceUnchanged(expected.executable),
      assertExecutableSourceUnchanged(expected.tmux),
      assertExecutableSourceUnchanged(expected.supervisor),
      assertPinnedExecutableUnchanged(expected.executable),
      assertPinnedExecutableUnchanged(expected.tmux),
      assertPinnedExecutableUnchanged(expected.supervisor)
    ]);
    const started = this.store.db.prepare("SELECT payload_json FROM events WHERE job_id=? AND type='execution.started' ORDER BY created_at DESC,rowid DESC LIMIT 1000")
      .all(task.job_id);
    const payload = started.map(row => {
      try { return parseStrictJson(row.payload_json); } catch { return null; }
    }).find(value => value && value.taskId === taskId && value.attempt === attempt);
    if (!payload) throw new Error(`durable execution.started evidence is missing before OS spawn: ${taskId}`);
    if (canonicalJson(payload.executionBoundaryIdentity) !== canonicalJson(expected)) {
      throw new Error(`durable execution.started boundary evidence does not match current attempt: ${taskId}`);
    }
    // The caller will synchronously recheck approval/plan and lease under its
    // own short writer reservation before emitting execution.spawn_authorized.
    return expected;
  }

  async _spawnUnderAuthorizationWriteLock({ taskId, boundaryIdentity, attempt, command, cwd, env,
    explicitEnv = {}, timeoutMs, executable, args = null, executionLease = null, tmuxName, script, signal }) {
    // Complete the slow filesystem/pinned-executable recheck before opening a
    // SQLite transaction. Holding a DatabaseSync writer transaction across an
    // `await` lets sibling batch lanes accidentally nest their task/attempt
    // writes into that transaction; it also makes a process crash roll back
    // unrelated executions. The short durable spawn-authorization claim below
    // is the linearization point: revocation before it blocks launch, while a
    // later revocation is ordered after an already-authorized spawn intent.
    const db = this.store.db;
    const currentBoundary = await this._assertExecutionBoundaryUnchanged(taskId, boundaryIdentity, {
      attempt, command, cwd, env, executable, executionLease
    });
    throwIfAborted(signal);
    let authorizationCommitted = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      assertImmutablePlannedExecution(this.store, this.getTask(taskId), {
        ...(args ? { executable, args, command } : { command }), cwd, timeoutMs, env: explicitEnv
      });
      const task = this.getTask(taskId);
      const metadata = parseStrictJson(task?.metadata_json || '{}', 'durable task metadata before OS spawn');
      if (!task || task.job_id !== boundaryIdentity.job_id || task.status !== 'running' || task.execution_status !== 'running' ||
          typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 ||
          typeof task.execution_attempt !== 'number' || !Number.isSafeInteger(task.execution_attempt) || task.execution_attempt !== attempt ||
          metadata.command !== command || canonicalJson(metadata.execution_boundary_identity) !== canonicalJson(boundaryIdentity)) {
        throw new Error(`execution task/session/attempt/boundary changed before spawn authorization: ${taskId}`);
      }
      if (metadata.execution_batch_claim) {
        const claim = metadata.execution_batch_claim;
        const durableClaim = db.prepare(`SELECT b.batch_id,b.job_id,b.status AS batch_status,b.attempt AS batch_attempt,
            i.item_id,i.task_id,i.command,i.status AS item_status,i.attempt AS item_attempt,
            j.state AS job_state,j.status AS job_status
          FROM execution_batches b JOIN execution_batch_items i ON i.batch_id=b.batch_id
          JOIN jobs j ON j.job_id=b.job_id
          WHERE b.batch_id=? AND i.item_id=? AND i.task_id=?`).get(claim.batchId, claim.itemId, taskId);
        if (!durableClaim || durableClaim.job_id !== task.job_id || durableClaim.batch_status !== 'WAITING' && durableClaim.batch_status !== 'RUNNING' ||
            durableClaim.batch_attempt !== attempt || durableClaim.item_attempt !== attempt || durableClaim.item_status !== 'RUNNING' ||
            durableClaim.command !== command || durableClaim.job_status !== 'active' || durableClaim.job_state !== 'EXECUTING' ||
            claim.batchAttempt !== attempt || claim.itemAttempt !== attempt) {
          throw new Error(`execution batch/job claim lost before OS spawn authorization: ${taskId}`);
        }
      }
      const approval = this.store.getLatestApproval(task.job_id);
      const proposal = this.store.getCurrentProposal(task.job_id);
      const approvalIdentity = approval ? {
        approval_id: approval.approval_id, decision: approval.decision,
        proposal_hash: approval.proposal_hash || null, current_proposal_hash: proposal?.proposalHash || null
      } : null;
      if (canonicalJson(approvalIdentity) !== canonicalJson(boundaryIdentity.approval)) {
        throw new Error(`execution approval/proposal identity changed before spawn authorization: ${taskId}`);
      }
      const activeLeases = db.prepare("SELECT * FROM task_leases WHERE task_id=? AND state='ACTIVE'").all(taskId);
      const lease = boundaryIdentity.lease?.lease_id
        ? activeLeases.find(candidate => candidate.lease_id === boundaryIdentity.lease.lease_id)
        : null;
      if (boundaryIdentity.lease?.lease_id) {
        const expiry = Date.parse(lease?.expires_at || '');
        if (!lease || activeLeases.length !== 1 || lease.job_id !== task.job_id || lease.task_id !== taskId ||
            lease.worker_id !== boundaryIdentity.lease.worker_id || typeof lease.owner_epoch !== 'number' ||
            lease.owner_epoch !== boundaryIdentity.lease.owner_epoch || typeof lease.attempt !== 'number' ||
            lease.attempt !== attempt || !Number.isFinite(expiry) || expiry <= Date.now()) {
          throw new Error(`execution lease owner/epoch/attempt expired or changed before spawn authorization: ${taskId}`);
        }
      } else if (activeLeases.some(candidate => Date.parse(candidate.expires_at || '') > Date.now())) {
        throw new Error(`execution acquired an unbound active task lease before local spawn authorization: ${taskId}`);
      }
      const startedEvent = db.prepare("SELECT event_id,job_id,payload_json FROM events WHERE job_id=? AND type='execution.started' AND json_extract(payload_json,'$.taskId')=? AND json_extract(payload_json,'$.attempt')=?")
        .all(task.job_id, taskId, attempt);
      if (startedEvent.length !== 1) throw new Error(`exact durable execution.started event missing before spawn authorization: ${taskId}`);
      const startedPayload = parseStrictJson(startedEvent[0].payload_json, 'durable execution.started payload');
      if (startedEvent[0].job_id !== task.job_id || startedPayload.executionSessionId !== task.execution_session_id ||
          canonicalJson(startedPayload.executionBoundaryIdentity) !== canonicalJson(boundaryIdentity)) {
        throw new Error(`durable execution.started event does not bind the current spawn authorization: ${taskId}`);
      }
      const spawnAuthorization = {
        taskId, executionSessionId: task.execution_session_id, attempt, command,
        approvalId: boundaryIdentity.approval?.approval_id || null,
        proposalHash: boundaryIdentity.approval?.proposal_hash || null,
        environmentSha256: boundaryIdentity.environment_sha256,
        executableSha256: boundaryIdentity.executable?.sha256,
        tmuxSha256: boundaryIdentity.tmux?.sha256,
        leaseId: lease?.lease_id || null,
        ownerEpoch: lease ? lease.owner_epoch : null,
        authorizedAt: new Date().toISOString()
      };
      const dedupeKey = `${taskId}|execution-spawn|${attempt}`;
      const authorizedEventId = this.store.recordEvent(task.job_id, 'execution.spawn_authorized', spawnAuthorization, dedupeKey);
      const authorizedEvent = db.prepare('SELECT event_id,job_id,type,payload_json FROM events WHERE event_id=?').get(authorizedEventId);
      if (!authorizedEvent || authorizedEvent.job_id !== task.job_id || authorizedEvent.type !== 'execution.spawn_authorized' ||
          authorizedEvent.payload_json !== JSON.stringify(spawnAuthorization)) {
        throw new Error(`durable execution spawn-authorization event readback mismatch: ${taskId}`);
      }
      db.exec('COMMIT');
      authorizationCommitted = true;
    } catch (error) {
      if (!authorizationCommitted) { try { db.exec('ROLLBACK'); } catch {} }
      throw error;
    }

    const controlEnv = baseExecutionEnvironment({ homeDir: this.executionHomeDir, tmpDir: this.executionTmpDir });
    let spawnBoundaryEntered = false;
    try {
      // The authorization event is the linearization point. Cancellation that
      // won before the synchronous claim above is rejected; after commit, the
      // caller has a durable authorization record and a spawn error is
      // classified by the transport boundary (definite no-spawn vs ambiguous).
      // Build argv before declaring that boundary entered: a local argument or
      // environment-construction exception cannot have created an OS process
      // and must not strand the attempt as an ambiguous possible spawn.
      const spawnArguments = this._tmuxExecutionArgs(tmuxName, script, env);
      throwIfAborted(signal);
      spawnBoundaryEntered = true;
      const result = await runPinnedExecutionControlCommand(currentBoundary.tmux, spawnArguments, {
        timeoutMs: 10000, signal, env: controlEnv
      });
      if (result.code !== 0) {
        const error = new Error(`tmux new-session returned exit code ${result.code}; OS process creation outcome is ambiguous${result.stderr ? `: ${result.stderr}` : ''}`);
        error.executionSpawnOutcome = 'possibly_spawned';
        throw error;
      }
      return { currentBoundary, result };
    } catch (error) {
      const definitelyNotSpawned = ['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(error?.code || '')) || error?.spawned === false;
      if (spawnBoundaryEntered && !definitelyNotSpawned) {
        error.executionSpawnOutcome = 'possibly_spawned';
        if (!/outcome is ambiguous|may have succeeded/i.test(String(error.message || ''))) {
          error.message = `OS process creation outcome is ambiguous; task remains running for reconciliation: ${error.message}`;
        }
      }
      throw error;
    }
  }

  _absoluteLaunchCommand(command, executableIdentity, args = null) {
    if (args) return structuredCommand(executableIdentity.realpath, args);
    const match = /^([A-Za-z0-9_.+\/-]+)(?=\s|$)/.exec(command);
    if (!match) throw new Error('execution command must begin with a resolvable executable token');
    return `${shellQuote(executableIdentity.realpath)}${command.slice(match[1].length)}`;
  }

  _tmuxExecutionArgs(tmuxName, script, environment) {
    // tmux servers retain their own environment; clear dangerous loader/shell
    // variables at the session boundary too, then start env -i and a non-login,
    // non-interactive shell. This prevents a login profile or BASH_ENV from
    // injecting code before the approved command starts.
    const args = ['new-session', '-d', '-s', tmuxName];
    for (const key of ['LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS']) {
      args.push('-e', `${key}=`);
    }
    args.push('/usr/bin/env', '-i', ...envAssignments(environment), '/bin/bash', '--noprofile', '--norc', '-c', script);
    return args;
  }

  getTask(taskId) { return this.store.getTask(taskId); }

  async cleanupOrphanedArtifacts() {
    const active = new Set(
      this.store.db.prepare("SELECT execution_session_id FROM tasks WHERE execution_status = 'running' AND execution_session_id IS NOT NULL")
        .all().map(row => `cos-exec-${String(row.execution_session_id).replace(/[^A-Za-z0-9_-]/g, '_')}`)
    );
    await ensurePrivateExecutionDirectory(this.executionTmpDir, 'execution temporary directory');
    const entries = await fs.readdir(this.executionTmpDir).catch(() => []);
    // The output-limit marker is part of the same per-execution artifact set
    // as stdout/stderr/exit. A supervisor crash before collect() can leave it
    // behind, so orphan cleanup must account for it too.
    const stale = entries.filter(name => /^cos-exec-exec_[A-Za-z0-9_-]+\.(stdout|stderr|exit|output-limit)$/.test(name));
    await Promise.all(stale.map(name => {
      // Strip every recognized artifact suffix before checking the durable
      // active-session set. In particular, output-limit markers belong to a
      // live execution too and must not be swept while collect() is pending.
      const tmuxName = name.replace(/\.(stdout|stderr|exit|output-limit)$/, '');
      return active.has(tmuxName) ? Promise.resolve() : fs.rm(path.join(this.executionTmpDir, name), { force: true });
    }));
    return stale.filter(name => !active.has(name.replace(/\.(stdout|stderr|exit|output-limit)$/, ''))).length;
  }

  async executeBatch(batchId, { timeoutMs = this.timeoutMs, cwd, env, signal = null } = {}) {
    throwIfAborted(signal);
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXECUTION_TIMEOUT_MS) {
      throw new Error(`execution batch timeoutMs must be a safe integer in 1..${MAX_EXECUTION_TIMEOUT_MS}`);
    }
    // Reconcile an old item claim that survived a worker crash before
    // prepareExecution created a durable task attempt/session. This method is
    // in the shipped local MCP runtime; recovery-manager.js is not. The store
    // checks age and durable task/attempt state under SQLite writer locking.
    if (typeof this.store.recoverUnstartedExecutionBatchClaims === 'function') {
      this.store.recoverUnstartedExecutionBatchClaims({
        staleBefore: new Date(Date.now() - Math.max(2 * 60 * 1000, timeoutMs)).toISOString()
      });
    }
    let batch = this.store.getExecutionBatch(batchId);
    if (!batch) throw new Error(`execution batch not found: ${batchId}`);
    if (typeof batch.attempt !== 'number' || !Number.isSafeInteger(batch.attempt) || batch.attempt < 1) {
      throw new Error(`execution batch has a malformed durable attempt: ${batchId}`);
    }
    if (batch.status === 'COMPLETED') {
      if (typeof this.store.verifyCompletedExecutionBatch === 'function') return this.store.verifyCompletedExecutionBatch(batchId);
      return { ...batch, items: this.store.listExecutionBatchItems(batchId) };
    }
    if (batch.status === 'CANCELLED') return { ...batch, items: this.store.listExecutionBatchItems(batchId) };
    const parentJob = this.store.getJob(batch.job_id);
    if (!parentJob || parentJob.status !== 'active' || parentJob.state !== 'EXECUTING') {
      const parentItems = this.store.listExecutionBatchItems(batchId);
      if (parentItems.some(item => item.status === 'RUNNING')) {
        throw new Error(`execution batch has a live item claim but its parent Job is no longer active/EXECUTING; recovery required: ${batchId}`);
      }
      if (batch.status === 'FAILED') return { ...batch, items: parentItems };
      if (parentItems.length && parentItems.every(item => ['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(item.status))) {
        return this._finishExecutionBatchFromItems(batch, parentItems);
      }
      return this.store.cancelExecutionBatch(batchId, 'parent Job terminalized before remaining batch items could start');
    }
    if (batch.status === 'FAILED') batch = this.store.prepareExecutionBatchRetry(batchId);
    batch = this.store.getExecutionBatch(batchId);
    if (!batch) return null;
    if (batch.status === 'COMPLETED') {
      if (typeof this.store.verifyCompletedExecutionBatch === 'function') return this.store.verifyCompletedExecutionBatch(batchId);
      return { ...batch, items: this.store.listExecutionBatchItems(batchId) };
    }
    if (batch.status === 'CANCELLED') {
      return { ...batch, items: this.store.listExecutionBatchItems(batchId) };
    }
    let existingItems = this.store.listExecutionBatchItems(batchId);
    for (const item of existingItems) {
      if (typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1 ||
          (item.status !== 'COMPLETED' && item.attempt !== batch.attempt) || item.attempt > batch.attempt) {
        throw new Error(`execution batch item attempt does not bind its current batch state: ${batchId}/${item.item_id}`);
      }
      if (item.timeout_ms !== null && item.timeout_ms !== undefined &&
          (typeof item.timeout_ms !== 'number' || !Number.isSafeInteger(item.timeout_ms) || item.timeout_ms < 1 || item.timeout_ms > MAX_EXECUTION_TIMEOUT_MS)) {
        throw new Error(`execution batch item has a malformed durable timeout: ${batchId}/${item.item_id}`);
      }
    }
    // A worker may crash after the task's full terminal ledger commits but
    // before the batch-item terminal write. Reconcile only from the exact
    // execution.started batch-claim binding and the store's terminal-ledger
    // validator; a still-running/ambiguous task remains fenced as RUNNING.
    if (typeof this.store.recoverTerminalExecutionBatchItemFromTask === 'function') {
      for (const item of existingItems.filter(candidate => candidate.status === 'RUNNING')) {
        const task = this.getTask(item.task_id);
        if (task?.execution_status === 'running') {
          await this._collectExistingExecutionFromExitMarker(task, {
            command: item.command,
            batchClaim: {
              batchId,
              itemId: item.item_id,
              batchAttempt: batch.attempt,
              itemAttempt: item.attempt
            }
          });
        }
        this.store.recoverTerminalExecutionBatchItemFromTask(batchId, item.item_id, {
          expectedBatchAttempt: batch.attempt,
          expectedItemAttempt: item.attempt
        });
      }
      existingItems = this.store.listExecutionBatchItems(batchId);
    }
    if (existingItems.some(item => item.status === 'RUNNING')) {
      throw new Error(`execution batch already has active item attempts; duplicate batch execution refused: ${batchId}`);
    }
    const items = existingItems.filter(item => item.status === 'PENDING');
    if (!items.length) {
      if (existingItems.length && existingItems.every(item => ['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(item.status))) {
        // Crash/restart can happen after the final item row commits but before
        // the aggregate batch row/event. Reconstruct the aggregate only from
        // durable item evidence; never spawn a second copy of terminal work.
        return this._finishExecutionBatchFromItems(batch, existingItems);
      }
      throw new Error(`execution batch has no runnable or fully terminal items: ${batchId}`);
    }
    validateExecutionBatch({
      batch_id: batchId,
      wait: 'all',
      tasks: items.map(item => ({ id: item.item_id, task_id: item.task_id, command: item.command, ...(item.cwd ? { cwd: item.cwd } : {}), ...(item.timeout_ms ? { timeout_ms: item.timeout_ms } : {}) }))
    });

    const runItem = async item => {
      const claimed = this.store.markExecutionBatchItemRunning(batchId, item.item_id, {
        expectedAttempt: item.attempt
      });
      // Another process can win after our item snapshot but before this CAS.
      // A lost claim is not permission to execute or write a failure over the
      // winning owner's terminal state.
      if (!claimed) return { skipped: true, itemId: item.item_id };
      let result;
      const taskBeforeExecution = this.getTask(item.task_id);
      const priorTaskAttempt = taskBeforeExecution?.execution_attempt == null ? 0 : taskBeforeExecution.execution_attempt;
      if (!Number.isSafeInteger(priorTaskAttempt) || priorTaskAttempt < 0 ||
          (taskBeforeExecution?.execution_attempt != null && typeof taskBeforeExecution.execution_attempt !== 'number')) {
        throw new Error(`execution batch task has a malformed prior execution attempt: ${item.task_id}`);
      }
      try {
        result = await this.executeTask(item.task_id, {
          command: item.command,
          timeoutMs: item.timeout_ms == null ? timeoutMs : Number(item.timeout_ms),
          cwd: cwd || item.cwd || process.cwd(),
          env,
          signal,
          batchClaim: {
            batchId,
            itemId: item.item_id,
            batchAttempt: batch.attempt,
            itemAttempt: item.attempt
          }
        });
      } catch (error) {
        // A claim recovered or superseded during async preflight is no longer
        // this caller's property. Never write a failure over the newer owner's
        // state; surface the fencing error and let the durable batch state drive
        // the next recovery/retry decision.
        if (error?.code === 'ERR_EXECUTION_BATCH_CLAIM_LOST' || error?.code === 'ERR_EXECUTION_ATTEMPT_UNRESOLVED') throw error;
        const taskAfterFailure = this.getTask(item.task_id);
        const unresolvedTaskAttempt = taskAfterFailure?.execution_status === 'running' &&
          Boolean(taskAfterFailure.execution_session_id) && typeof taskAfterFailure.execution_attempt === 'number' &&
          Number.isSafeInteger(taskAfterFailure.execution_attempt) && taskAfterFailure.execution_attempt > priorTaskAttempt;
        if (error?.executionSpawnOutcome === 'possibly_spawned' || unresolvedTaskAttempt) {
          // executeTask deliberately keeps an accepted-but-unverified OS session
          // open for reconciliation. Marking this item FAILED would permit a
          // false terminal aggregate (and lose the live attempt from retry
          // accounting). Preserve RUNNING ownership until task terminal evidence
          // or exact-session absence is durably reconciled.
          throw error;
        }
        const settledAttempt = taskAfterFailure && typeof taskAfterFailure.execution_attempt === 'number' &&
          Number.isSafeInteger(taskAfterFailure.execution_attempt) && taskAfterFailure.execution_attempt > priorTaskAttempt &&
          ['failed', 'timeout', 'cancelled'].includes(taskAfterFailure.execution_status) &&
          typeof taskAfterFailure.execution_finished_at === 'string' && taskAfterFailure.execution_finished_at;
        if (settledAttempt) {
          const terminalStatus = taskAfterFailure.execution_status === 'timeout' ? 'TIMEOUT'
            : taskAfterFailure.execution_status === 'cancelled' ? 'CANCELLED' : 'FAILED';
          this.store.finishExecutionBatchItem(batchId, item.item_id, {
            expectedAttempt: item.attempt,
            executionSessionId: taskAfterFailure.execution_session_id || null,
            executionPid: taskAfterFailure.execution_pid || null,
            exitCode: taskAfterFailure.execution_exit_code,
            stdout: taskAfterFailure.execution_stdout || '',
            stderr: taskAfterFailure.execution_stderr || '',
            status: terminalStatus,
            error: (taskAfterFailure.execution_stderr || '').trim() || error.message,
            finishedAt: new Date().toISOString()
          });
          if (signal?.aborted) throw error;
          return { exitCode: taskAfterFailure.execution_exit_code, stdout: taskAfterFailure.execution_stdout || '',
            stderr: taskAfterFailure.execution_stderr || '', execution_status: taskAfterFailure.execution_status,
            timedOut: taskAfterFailure.execution_status === 'timeout', failedToStart: true, error: error.message };
        }
        this.store.finishExecutionBatchItem(batchId, item.item_id, {
          expectedAttempt: item.attempt,
          status: signal?.aborted ? 'CANCELLED' : 'FAILED', error: error.message
        });
        if (signal?.aborted) throw error;
        return { exitCode: null, stdout: '', stderr: error.message, timedOut: false, failedToStart: true };
      }
      const task = this.getTask(item.task_id);
      // Exit code 0 is necessary but not sufficient for batch success. The
      // task's durable terminal state also represents evidence policy (for
      // example, output truncation deliberately makes a zero-exit process
      // FAILED). Trusting only the in-memory process code here would overwrite
      // that decision with a success-shaped batch item and aggregate.
      const timedOut = result?.timedOut === true || result?.execution_status === 'timeout';
      const outputLimited = result?.outputLimited === true;
      const completed = result?.execution_status === 'completed' && result?.execution_exit_code === 0 &&
        result?.exitCode === 0 && !timedOut && !outputLimited;
      const status = timedOut ? 'TIMEOUT' : completed ? 'COMPLETED' : 'FAILED';
      const failureReason = timedOut ? 'execution timeout'
        : outputLimited ? 'execution output was truncated; complete success evidence is unavailable'
          : completed ? null
            : (typeof result?.error === 'string' && result.error.trim()) ? result.error
              : (typeof result?.execution_stderr === 'string' && result.execution_stderr.trim()) ? result.execution_stderr
                : (typeof result?.stderr === 'string' && result.stderr.trim()) ? result.stderr
                  : `execution did not produce a durable completed result (exit status ${String(result?.exitCode)})`;
      // Persistence errors intentionally do not enter the execution-error
      // catch above: retrying a failed terminal write as FAILED would let a
      // stale/lost owner overwrite a legitimate COMPLETED attempt.
      this.store.finishExecutionBatchItem(batchId, item.item_id, {
        expectedAttempt: item.attempt,
        executionSessionId: task?.execution_session_id || null,
        executionPid: task?.execution_pid || null,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        status,
        error: failureReason
      });
      return result;
    };
    // Use a bounded worker pool rather than one Promise per item. A failure
    // stops workers from claiming further queued items, while already-started
    // lanes still settle through Promise.allSettled below. This caps actual
    // process fan-out even when a valid durable batch contains many items.
    const runnableItems = items.filter(item => item.status !== 'COMPLETED');
    let nextItemIndex = 0;
    let laneFailure = null;
    const laneCount = Math.min(MAX_CONCURRENT_EXECUTION_BATCH_LANES, runnableItems.length);
    const runs = Array.from({ length: laneCount }, async () => {
      while (!laneFailure) {
        throwIfAborted(signal);
        const index = nextItemIndex++;
        if (index >= runnableItems.length) return;
        try {
          await runItem(runnableItems[index]);
        } catch (error) {
          laneFailure ||= error;
          throw error;
        }
      }
    });
    this.store.markExecutionBatchWaiting(batchId);
    // Promise.all rejects on the first aborted lane, but sibling executeTask
    // calls may still be terminating tmux/process groups and committing their
    // task/attempt terminal ledgers. Cancelling the batch at that point marks
    // their RUNNING item rows terminal before their owners finish cleanup; the
    // caller can return while a child process is still unwinding and the late
    // owner then loses its item CAS. Drain every lane first, then terminalize
    // the aggregate. This is a local cleanup barrier, not a claim that a remote
    // provider side effect can be synchronously cancelled.
    const settledRuns = await Promise.allSettled(runs);
    const rejectedRun = settledRuns.find(result => result.status === 'rejected');
    if (rejectedRun) {
      if (signal?.aborted) this.store.cancelExecutionBatch(batchId, rejectedRun.reason?.message || 'execution request cancelled');
      throw rejectedRun.reason;
    }
    const finalItems = this.store.listExecutionBatchItems(batchId);
    if (finalItems.some(item => ['PENDING', 'RUNNING'].includes(item.status))) {
      throw new Error(`execution batch still has items owned by another attempt; aggregate/finalization deferred: ${batchId}`);
    }
    return this._finishExecutionBatchFromItems(this.store.getExecutionBatch(batchId), finalItems);
  }

  _finishExecutionBatchFromItems(batch, finalItems) {
    if (!batch) throw new Error('execution batch disappeared before aggregate finalization');
    if (!finalItems.length || finalItems.some(item => !['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(item.status))) {
      throw new Error(`execution batch aggregate requires only durable terminal item states: ${batch.batch_id}`);
    }
    const batchId = batch.batch_id;
    const resultItems = finalItems.map(i => ({
      id: i.item_id,
      task_id: i.task_id,
      command: i.command,
      status: i.status,
      exit_code: i.exit_code == null ? null : i.exit_code,
      execution_session_id: i.execution_session_id || null,
      stdout: i.stdout || '',
      stderr: i.stderr || '',
      error: i.error || null
    }));
    const passed = resultItems.filter(i => i.status === 'COMPLETED' && i.exit_code === 0).length;
    const failed = resultItems.length - passed;
    const resultPayload = {
      batch_id: batchId,
      status: failed === 0 ? 'completed' : passed === 0 ? 'failed' : 'partial',
      summary: { total: resultItems.length, passed, failed },
      items: resultItems
    };
    validateExecutionResult(resultPayload);
    const aggregateContent = [
      '[ACTUAL EXECUTION BATCH EVIDENCE]',
      `batch_id: ${batchId}`,
      `status: ${resultPayload.status.toUpperCase()}`,
      `summary: total=${resultPayload.summary.total} passed=${resultPayload.summary.passed} failed=${resultPayload.summary.failed}`,
      `protocol_result_json: ${JSON.stringify(resultPayload)}`,
      ...resultItems.map(i => [
        `item_id: ${i.id}`,
        `task_id: ${i.task_id}`,
        `exact command: ${i.command}`,
        `execution_session_id: ${i.execution_session_id || 'N/A'}`,
        `exit status/code: ${i.exit_code == null ? 'N/A' : i.exit_code}`,
        `stdout:\n${i.stdout || ''}`,
        `stderr:\n${i.stderr || ''}`
      ].join('\n'))
    ].join('\n');
    return this.store.finishExecutionBatch(batchId, {
      status: resultPayload.status === 'completed' ? 'COMPLETED' : 'FAILED',
      aggregateContent,
      expectedAttempt: batch.attempt
    });
  }

  async executeAuthorizedTask(taskId, { timeoutMs = this.timeoutMs, cwd, env, signal = null, executionLease = null } = {}) {
    throwIfAborted(signal);
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const metadata = parseStrictJson(task.metadata_json || '{}');
    if (metadata.deterministic && metadata.executable) {
      if (metadata.executor !== 'ExecutionManager') throw new Error(`deterministic task ${taskId} has invalid executor`);
      if (!metadata.executable || !Array.isArray(metadata.args)) throw new Error(`structured execution contract required for task ${taskId}`);
      return this.executeStructuredTask(taskId, {
        executable: metadata.executable,
        args: metadata.args,
        timeoutMs,
        cwd: cwd || metadata.cwd || process.cwd(),
        env,
        signal,
        executionLease
      });
    }
    const command = String(metadata.command || task.description || '').trim();
    if (!command) throw new Error(`task ${taskId} has no execution command`);
    return this.executeTask(taskId, { command, timeoutMs, cwd: cwd || metadata.cwd || process.cwd(), env, signal, executionLease });
  }

  async executeStructuredTask(taskId, { executable, args = [], timeoutMs = this.timeoutMs, cwd = process.cwd(), env = {}, signal = null, executionLease = null } = {}) {
    throwIfAborted(signal);
    const exactExecutable = String(executable || '').trim();
    if (!exactExecutable || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > MAX_EXECUTION_COMMAND_CHARS)) {
      throw new Error(`invalid structured execution contract for task ${taskId}`);
    }
    const command = structuredCommand(exactExecutable, args);
    if (command.length > MAX_EXECUTION_COMMAND_CHARS) throw new Error(`structured execution command exceeds ${MAX_EXECUTION_COMMAND_CHARS} characters`);
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXECUTION_TIMEOUT_MS) {
      throw new Error(`execution timeoutMs must be a safe integer in 1..${MAX_EXECUTION_TIMEOUT_MS}`);
    }
    if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 4096) throw new Error('execution cwd must be a non-empty string up to 4096 characters');
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('execution env must be an object of explicit string overrides');
    if (!/^[A-Za-z0-9_.+-]+$/.test(exactExecutable)) throw new Error(`unsupported deterministic executable: ${exactExecutable}`);
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    assertImmutablePlannedExecution(this.store, task, { executable: exactExecutable, args, command, cwd, timeoutMs, env });
    const priorAttempt = task.execution_attempt == null ? 0 : task.execution_attempt;
    if (typeof priorAttempt !== 'number' || !Number.isSafeInteger(priorAttempt) || priorAttempt < 0) {
      throw new Error(`task has a malformed durable execution attempt: ${taskId}`);
    }
    if (task.execution_status === 'running') {
      const recovered = await this._collectExistingExecutionFromExitMarker(task, { command });
      if (recovered) return recovered;
      const error = new Error(`task already executing or prior attempt unresolved; no exit marker proves completion, automatic replay refused: ${taskId}`);
      error.code = 'ERR_EXECUTION_ATTEMPT_UNRESOLVED';
      throw error;
    }
    if (task.execution_status === 'completed') {
      if (task.status !== 'completed' || task.execution_exit_code !== 0 ||
          typeof task.execution_session_id !== 'string' || !task.execution_session_id || priorAttempt < 1) {
        throw new Error(`completed execution has contradictory durable task/session/attempt/exit state: ${taskId}`);
      }
      return this.store.finishExecution(taskId, {
        executionSessionId: task.execution_session_id, attempt: priorAttempt, command: task.metadata_json ? parseStrictJson(task.metadata_json).command : command,
        exitCode: task.execution_exit_code, stdout: task.execution_stdout || '', stderr: task.execution_stderr || '',
        status: 'completed', error: null
      });
    }
    if (executionLease && (typeof executionLease.attempt !== 'number' || !Number.isSafeInteger(executionLease.attempt) || executionLease.attempt < 1)) {
      throw new Error(`execution lease attempt is malformed: ${taskId}`);
    }
    const nextAttempt = executionLease ? executionLease.attempt : priorAttempt + 1;
    if (!Number.isSafeInteger(nextAttempt) || nextAttempt < 1) throw new Error('execution lease attempt is invalid');
    const executionSessionId = id('exec');
    const tmuxName = `cos-exec-${executionSessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const startedAt = new Date().toISOString();
    await fs.mkdir(this.executionTmpDir, { recursive: true, mode: 0o700 });
    const stdoutPath = path.join(this.executionTmpDir, `${tmuxName}.stdout`);
    const stderrPath = path.join(this.executionTmpDir, `${tmuxName}.stderr`);
    const exitPath = path.join(this.executionTmpDir, `${tmuxName}.exit`);
    const executionEnv = await this._prepareExecutionEnvironment(env);
    const boundaryIdentity = await this._captureExecutionBoundary(taskId, {
      attempt: nextAttempt, command, cwd, env: executionEnv, executable: exactExecutable, executionLease
    });
    const outputLimitPath = path.join(this.executionTmpDir, `${tmuxName}.output-limit`);
    const supervisorSpec = {
      executable: boundaryIdentity.executable.realpath, args, cwd: boundaryIdentity.cwd.realpath,
      env: executionEnv, stdoutPath, stderrPath, exitPath, outputLimitPath,
      maxOutputBytesPerStream: MAX_EXECUTION_OUTPUT_BYTES_PER_STREAM
    };
    const supervisorCommand = structuredCommand(boundaryIdentity.supervisor.realpath,
      ['-e', EXECUTION_OUTPUT_SUPERVISOR_SOURCE, JSON.stringify(supervisorSpec)]);
    this.store.prepareExecution(taskId, { executionSessionId, attempt: nextAttempt, command, cwd, startedAt, tmuxName, boundaryIdentity });
    const script = `exec ${supervisorCommand}`;
    let spawnAccepted = false;
    let executionExitObserved = false;
    let executionSessionAbsenceConfirmed = false;
    try {
      // The durable prepare transaction and OS spawn are separate boundaries.
      // Revalidate approval, immutable plan bytes, task metadata, cwd, command,
      // timeout and environment after the durable claim and immediately before
      // asking tmux to create a process. A revocation/substitution in that gap
      // is failed closed without launching the approved command.
      const { currentBoundary } = await this._spawnUnderAuthorizationWriteLock({
        taskId, boundaryIdentity, attempt: nextAttempt, command, cwd, env: executionEnv, explicitEnv: env, timeoutMs,
        executable: exactExecutable, args, executionLease, tmuxName, script, signal
      });
      spawnAccepted = true;
      const controlEnv = baseExecutionEnvironment({ homeDir: this.executionHomeDir, tmpDir: this.executionTmpDir });
      throwIfAborted(signal);
      const pid = await runPinnedExecutionControlCommand(currentBoundary.tmux, ['display-message', '-p', '-t', `${tmuxName}:0`, '#{pane_pid}'], { timeoutMs: 5000, signal, env: controlEnv });
      if (/^\d+$/.test(pid.stdout.trim())) this.store.setExecutionPid(taskId, Number(pid.stdout.trim()), { executionSessionId, attempt: nextAttempt });
      const started = Date.now();
      let exitCode = null;
      while (Date.now() - started < timeoutMs) {
        if (signal?.aborted) {
          throw new Error('Request aborted by caller');
        }
        const parsedExitCode = await readCanonicalExecutionExitMarkerFile(exitPath, `execution exit marker for ${taskId}/${nextAttempt}`);
        if (parsedExitCode !== null) { exitCode = parsedExitCode; executionExitObserved = true; break; }
        await delay(100, signal);
      }
      if (exitCode === null) {
        if (!await this._executionSessionAbsent(boundaryIdentity, tmuxName)) {
          throw new Error('execution timeout reached but absence of the accepted tmux session could not be verified');
        }
        executionSessionAbsenceConfirmed = true;
        return await this.collect(taskId, { executionSessionId, attempt: nextAttempt, command, exitCode: null, timeout: true });
      }
      await runPinnedExecutionControlCommand(boundaryIdentity.tmux, ['kill-session', '-t', tmuxName], { timeoutMs: 5000, env: controlEnv }).catch(() => {});
      return await this.collect(taskId, { executionSessionId, attempt: nextAttempt, command, exitCode, timeout: false });
    } catch (error) {
      if (executionExitObserved || executionSessionAbsenceConfirmed) throw error;
      if (spawnAccepted || error?.executionSpawnOutcome === 'possibly_spawned') {
        // Even a successful `new-session` response is followed by more local
        // control I/O that can fail. Never convert such an accepted spawn into
        // FAILED merely because pane PID lookup or a DB write threw: retain the
        // exact open attempt until the result is collected or recovery can
        // establish a coherent terminal transition.
        await this._retainAmbiguousSpawn(taskId, executionSessionId, nextAttempt, command, tmuxName, boundaryIdentity, error, signal);
        throw error;
      }
      if (signal?.aborted) {
        this.store.finishExecution(taskId, { executionSessionId, attempt: nextAttempt, command, exitCode: null, stdout: '', stderr: error.message, status: 'cancelled', error: error.message });
        throw error;
      }
      this.store.finishExecution(taskId, { executionSessionId, attempt: nextAttempt, command, exitCode: null, stdout: '', stderr: error.message, status: 'failed', error: error.message });
      throw error;
    }
  }

  async executeTask(taskId, { command, timeoutMs = this.timeoutMs, attempt = null, cwd = process.cwd(), env = {}, signal = null, executionLease = null, batchClaim = null } = {}) {
    throwIfAborted(signal);
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const taskMetadata = parseStrictJson(task.metadata_json || '{}', `task metadata for ${taskId}`);
    const requestedCommand = command === undefined ? taskMetadata.command : command;
    if (typeof requestedCommand !== 'string' || !requestedCommand.trim()) throw new Error(`deterministic command required as an exact string for task ${taskId}`);
    const exactCommand = requestedCommand.trim();
    if (exactCommand.length > MAX_EXECUTION_COMMAND_CHARS) throw new Error(`execution command exceeds ${MAX_EXECUTION_COMMAND_CHARS} characters`);
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXECUTION_TIMEOUT_MS) {
      throw new Error(`execution timeoutMs must be a safe integer in 1..${MAX_EXECUTION_TIMEOUT_MS}`);
    }
    if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 4096) throw new Error('execution cwd must be a non-empty string up to 4096 characters');
    if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('execution env must be an object of explicit string overrides');
    if (!/^(?:node|npm|npx|git|python(?:3)?|bash|sh|pnpm|yarn)\b/.test(exactCommand)) throw new Error(`unsupported deterministic command: ${exactCommand}`);
    const commandArgs = parseSafeCommandLine(exactCommand);
    if (!/^(?:node|npm|npx|git|python(?:3)?|bash|sh|pnpm|yarn)$/.test(commandArgs[0])) {
      throw new Error(`unsupported deterministic executable token: ${commandArgs[0]}`);
    }
    const planned = assertImmutablePlannedExecution(this.store, task, { command: exactCommand, cwd, timeoutMs, env });
    if (!planned && ['bash', 'sh'].includes(commandArgs[0])) {
      throw new Error('unplanned shell execution is not permitted; use a structured immutable execution plan');
    }
    const priorAttempt = task.execution_attempt == null ? 0 : task.execution_attempt;
    if (typeof priorAttempt !== 'number' || !Number.isSafeInteger(priorAttempt) || priorAttempt < 0) {
      throw new Error(`task has a malformed durable execution attempt: ${taskId}`);
    }
    if (task.execution_status === 'running') {
      const recovered = await this._collectExistingExecutionFromExitMarker(task, { command: exactCommand, batchClaim });
      if (recovered) return recovered;
      const error = new Error(`task already executing or prior attempt unresolved; no exit marker proves completion, automatic replay refused: ${taskId}`);
      error.code = 'ERR_EXECUTION_ATTEMPT_UNRESOLVED';
      throw error;
    }
    if (task.execution_status === 'completed') {
      if (task.status !== 'completed' || task.execution_exit_code !== 0 ||
          typeof task.execution_session_id !== 'string' || !task.execution_session_id || priorAttempt < 1) {
        throw new Error(`completed execution has contradictory durable task/session/attempt/exit state: ${taskId}`);
      }
      return this.store.finishExecution(taskId, {
        executionSessionId: task.execution_session_id, attempt: priorAttempt, command: exactCommand,
        exitCode: task.execution_exit_code, stdout: task.execution_stdout || '', stderr: task.execution_stderr || '',
        status: 'completed', error: null
      });
    }
    if (executionLease && (typeof executionLease.attempt !== 'number' || !Number.isSafeInteger(executionLease.attempt) || executionLease.attempt < 1)) {
      throw new Error(`execution lease attempt is malformed: ${taskId}`);
    }
    if (attempt !== null && attempt !== undefined && (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1)) {
      throw new Error(`requested execution attempt is malformed: ${taskId}`);
    }
    const nextAttempt = executionLease ? executionLease.attempt : attempt == null ? priorAttempt + 1 : attempt;
    if (!Number.isSafeInteger(nextAttempt) || nextAttempt < 1) throw new Error('execution attempt is invalid');
    const executionSessionId = id('exec');
    const tmuxName = `cos-exec-${executionSessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const startedAt = new Date().toISOString();
    await fs.mkdir(this.executionTmpDir, { recursive: true, mode: 0o700 });
    const stdoutPath = path.join(this.executionTmpDir, `${tmuxName}.stdout`);
    const stderrPath = path.join(this.executionTmpDir, `${tmuxName}.stderr`);
    const exitPath = path.join(this.executionTmpDir, `${tmuxName}.exit`);
    const executionEnv = await this._prepareExecutionEnvironment(env);
    const executableToken = commandArgs[0];
    const boundaryIdentity = await this._captureExecutionBoundary(taskId, {
      attempt: nextAttempt, command: exactCommand, cwd, env: executionEnv, executable: executableToken, executionLease
    });
    const outputLimitPath = path.join(this.executionTmpDir, `${tmuxName}.output-limit`);
    const supervisorSpec = {
      executable: boundaryIdentity.executable.realpath, args: commandArgs.slice(1), cwd: boundaryIdentity.cwd.realpath,
      env: executionEnv, stdoutPath, stderrPath, exitPath, outputLimitPath,
      maxOutputBytesPerStream: MAX_EXECUTION_OUTPUT_BYTES_PER_STREAM
    };
    const supervisorCommand = structuredCommand(boundaryIdentity.supervisor.realpath,
      ['-e', EXECUTION_OUTPUT_SUPERVISOR_SOURCE, JSON.stringify(supervisorSpec)]);
    const preparedExecution = { executionSessionId, attempt: nextAttempt, command: exactCommand, cwd, startedAt, tmuxName, boundaryIdentity };
    if (batchClaim) {
      if (typeof this.store.prepareExecutionForBatchClaim !== 'function') {
        throw new Error('batch execution requires the atomic store claim/preparation fence');
      }
      this.store.prepareExecutionForBatchClaim(taskId, preparedExecution, batchClaim);
    } else {
      this.store.prepareExecution(taskId, preparedExecution);
    }
    const script = `exec ${supervisorCommand}`;
    let spawnAccepted = false;
    let executionExitObserved = false;
    let executionSessionAbsenceConfirmed = false;
    try {
      const { currentBoundary } = await this._spawnUnderAuthorizationWriteLock({
        taskId, boundaryIdentity, attempt: nextAttempt, command: exactCommand, cwd, env: executionEnv, explicitEnv: env, timeoutMs,
        executable: executableToken, executionLease, tmuxName, script, signal
      });
      spawnAccepted = true;
      const controlEnv = baseExecutionEnvironment({ homeDir: this.executionHomeDir, tmpDir: this.executionTmpDir });
      throwIfAborted(signal);
      const pid = await runPinnedExecutionControlCommand(currentBoundary.tmux, ['display-message', '-p', '-t', `${tmuxName}:0`, '#{pane_pid}'], { timeoutMs: 5000, signal, env: controlEnv });
      if (/^\d+$/.test(pid.stdout.trim())) this.store.setExecutionPid(taskId, Number(pid.stdout.trim()), { executionSessionId, attempt: nextAttempt });
      const started = Date.now();
      let exitCode = null;
      while (Date.now() - started < timeoutMs) {
        if (signal?.aborted) {
          throw new Error('Request aborted by caller');
        }
        const parsedExitCode = await readCanonicalExecutionExitMarkerFile(exitPath, `execution exit marker for ${taskId}/${nextAttempt}`);
        if (parsedExitCode !== null) { exitCode = parsedExitCode; executionExitObserved = true; break; }
        await delay(100, signal);
      }
      if (exitCode === null) {
        if (!await this._executionSessionAbsent(boundaryIdentity, tmuxName)) {
          throw new Error('execution timeout reached but absence of the accepted tmux session could not be verified');
        }
        executionSessionAbsenceConfirmed = true;
        const timeout = await this.collect(taskId, { executionSessionId, attempt: nextAttempt, command: exactCommand, timeout: true });
        return timeout;
      }
      await runPinnedExecutionControlCommand(boundaryIdentity.tmux, ['kill-session', '-t', tmuxName], { timeoutMs: 5000, env: controlEnv }).catch(() => {});
      return await this.collect(taskId, { executionSessionId, attempt: nextAttempt, command: exactCommand, exitCode, timeout: false });
    } catch (error) {
      if (executionExitObserved || executionSessionAbsenceConfirmed) throw error;
      if (spawnAccepted || error?.executionSpawnOutcome === 'possibly_spawned') {
        await this._retainAmbiguousSpawn(taskId, executionSessionId, nextAttempt, exactCommand, tmuxName, boundaryIdentity, error, signal);
        throw error;
      }
      if (signal?.aborted) {
        this.store.finishExecution(taskId, { executionSessionId, attempt: nextAttempt, command: exactCommand, exitCode: null, stdout: '', stderr: error.message, status: 'cancelled', error: error.message });
        throw error;
      }
      this.store.finishExecution(taskId, { executionSessionId, attempt: nextAttempt, command: exactCommand, exitCode: null, stdout: '', stderr: error.message, status: 'failed', error: error.message });
      throw error;
    }
  }

  async collect(taskId, { executionSessionId, attempt, command, exitCode = null, timeout = false }) {
    const tmuxName = `cos-exec-${executionSessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const stdoutPath = path.join(this.executionTmpDir, `${tmuxName}.stdout`);
    const stderrPath = path.join(this.executionTmpDir, `${tmuxName}.stderr`);
    const exitPath = path.join(this.executionTmpDir, `${tmuxName}.exit`);
    const outputLimitPath = path.join(this.executionTmpDir, `${tmuxName}.output-limit`);
    const [stdout, stderr] = await Promise.all([
      readBoundedExecutionOutput(stdoutPath),
      readBoundedExecutionOutput(stderrPath)
    ]);
    const outputLimited = stdout.truncated || stderr.truncated || await fs.access(outputLimitPath).then(() => true, () => false);
    const outputLimitError = outputLimited
      ? `execution output reached the ${MAX_EXECUTION_OUTPUT_BYTES_PER_STREAM}-byte per-stream limit; captured output may be truncated`
      : null;
    const status = timeout ? 'timeout' : !outputLimited && exitCode === 0 ? 'completed' : 'failed';
    let result;
    let durableResultValidated = false;
    try {
      result = this.store.finishExecution(taskId, {
        executionSessionId, attempt, command, exitCode,
        stdout: stdout.text, stderr: stderr.text,
        status,
        error: timeout ? 'execution timeout' : outputLimitError
      });
      if (result?.execution_status !== status) {
        // finishExecution can durably quarantine an output whose lease expired
        // between process start and result persistence. Never return the stale
        // process's in-memory exit/stdout as a successful execution result.
        throw new Error(result?.execution_stderr || `execution result was rejected by durable state: ${taskId}`);
      }
      durableResultValidated = true;
    } finally {
      // A persistence/identity rejection is not permission to erase the only
      // output and exit evidence from a crashed or superseded attempt. Remove
      // these bounded files only after the exact durable result was accepted.
      if (durableResultValidated) {
        await Promise.all([
          fs.rm(stdoutPath, { force: true }),
          fs.rm(stderrPath, { force: true }),
          fs.rm(exitPath, { force: true }),
          fs.rm(outputLimitPath, { force: true })
        ]);
      }
    }
    return { ...result, command, exitCode, stdout: stdout.text, stderr: stderr.text, timedOut: timeout, outputLimited };
  }
}

export { shellQuote };
