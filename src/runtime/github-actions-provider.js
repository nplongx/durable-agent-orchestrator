import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { validateExecutionRequest, validateExecutionResult } from './execution-contract.js';
import { verifyExecutionEvidence } from './execution-verifier.js';
import { parseStrictJson } from './strict-json.js';
import {
  assertProviderDispatchIntent,
  canonicalProviderDispatchRequest,
  createProviderDispatchIdentity,
  ensureProviderDispatchIntentColumns,
  normalizeProviderApiBase,
  providerDispatchConfig,
  providerDispatchIdentityFromIntent
} from './provider-dispatch-identity.js';

const API_VERSION = '2026-03-10';
const DEFAULT_API = 'https://api.github.com';
const DEFAULT_WORKFLOW = 'p2-provider-smoke.yml';
const DEFAULT_REF = 'main';
const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_TASK_PAYLOAD_SOURCE_BYTES = 1024 * 1024;
const WORKFLOW_RUN_STATUSES = new Set(['queued', 'in_progress', 'completed', 'requested', 'waiting', 'pending']);
const WORKFLOW_RUN_CONCLUSIONS = new Set([
  'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'startup_failure', 'success', 'timed_out'
]);
// Do not infer that every 4xx proves a dispatch side effect did not happen.
// Request timeout/conflict/too-early/rate-limit responses can be ambiguous for
// a mutating request; only explicit validation/authentication/route rejection
// responses are eligible to release the one-way durable send claim.
const DEFINITIVE_PRE_SEND_REJECTION_STATUSES = new Set([400, 401, 403, 404, 405, 410, 413, 415, 422]);

function workspaceRelativeTaskPayloadRef(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.startsWith('-') || value.includes('\\') ||
      /^[a-zA-Z]:/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !part.includes(':'));
}

function readTaskPayloadAtCommit({ inputCommit, ref }) {
  if (typeof inputCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(inputCommit)) {
    throw new Error('immutable task payload source requires a full input commit SHA');
  }
  if (!workspaceRelativeTaskPayloadRef(ref)) throw new Error('immutable task payload source ref is not a safe workspace-relative path');
  return execFileSync('git', ['show', `${inputCommit}:${ref}`], {
    encoding: 'buffer', maxBuffer: MAX_TASK_PAYLOAD_SOURCE_BYTES, stdio: ['ignore', 'pipe', 'pipe']
  });
}

function validateInlineP3TaskPayload(request) {
  const payload = request.task_payload_inline;
  if (payload === undefined) return;
  const fail = message => { throw new Error(`P3 inline task payload ${message}`); };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.getPrototypeOf(payload) !== Object.prototype) {
    fail('must be a plain object');
  }
  if (payload.schema_version !== 1) fail('schema_version must be 1');
  for (const field of ['job_id', 'task_id']) {
    if (payload[field] !== request[field]) fail(`${field} must match the durable execution request`);
  }
  for (const field of ['lease_id', 'attempt', 'owner_epoch']) {
    if (payload[field] !== undefined && payload[field] !== request[field]) {
      fail(`${field} must match the durable execution request when supplied`);
    }
  }
  if (payload.role !== undefined && payload.role !== request.role) fail('role must match the dispatched role');
  if (!Array.isArray(payload.required_evidence) || payload.required_evidence.length === 0) {
    fail('required_evidence must be a non-empty array');
  }
  const evidence = new Set();
  for (const reference of payload.required_evidence) {
    if (typeof reference !== 'string' || !reference || path.isAbsolute(reference) ||
        reference.split('/').includes('..') || reference.split('\\').includes('..')) {
      fail(`contains an invalid required_evidence reference: ${String(reference)}`);
    }
    if (evidence.has(reference)) fail(`contains duplicate required_evidence reference ${reference}`);
    evidence.add(reference);
  }
  if (payload.required_evidence.length !== request.required_evidence.length ||
      payload.required_evidence.some((reference, index) => reference !== request.required_evidence[index])) {
    fail('required_evidence must exactly match the immutable execution request');
  }
  const agentTask = payload.execution_mode === 'agent' || payload.runtime_owner === 'github-runner';
  if (!agentTask && !payload.command && !(payload.executable && Array.isArray(payload.args))) {
    fail('must define command or structured executable/args unless it is a runner-agent task');
  }
  if (payload.command !== undefined && typeof payload.command !== 'string') fail('command must be a string');
  if (payload.executable !== undefined && (typeof payload.executable !== 'string' ||
      !Array.isArray(payload.args) || payload.args.some(argument => typeof argument !== 'string'))) {
    fail('executable/args must be a string and an array of strings');
  }
}

function zipInteger64(bytes, offset, label) {
  if (offset < 0 || offset + 8 > bytes.length) throw new Error(`provider artifact ZIP has a truncated ${label}`);
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`provider artifact ZIP ${label} exceeds the supported range`);
  return Number(value);
}

function zipCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readValidatedZipEntry(bytes, entry) {
  const compressed = bytes.subarray(entry.dataStart, entry.dataEnd);
  let content;
  if (entry.method === 0) content = Buffer.from(compressed);
  else content = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
  if (content.length !== entry.uncompressedSize || zipCrc32(content) !== entry.crc32) {
    throw new Error(`provider artifact ZIP entry has invalid uncompressed size or CRC: ${JSON.stringify(entry.name)}`);
  }
  return content;
}

function validateZipEntryTypes(bytes) {
  // Parse and validate the complete central directory before interpreting any
  // payload. Entries are read from the already-bounded response buffer rather
  // than extracted to a mutable filesystem path, eliminating symlink traversal
  // and temp-file replacement races at the archive boundary.
  if (bytes.length < 22) throw new Error('provider artifact is not a complete ZIP archive');
  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let cursor = bytes.length - 22; cursor >= minEocd; cursor--) {
    if (bytes.readUInt32LE(cursor) !== 0x06054b50) continue;
    const commentLength = bytes.readUInt16LE(cursor + 20);
    if (cursor + 22 + commentLength === bytes.length) { eocd = cursor; break; }
  }
  if (eocd < 0) throw new Error('provider artifact is not a complete ZIP archive');

  let entryCount = bytes.readUInt16LE(eocd + 10);
  let centralSize = bytes.readUInt32LE(eocd + 12);
  let centralOffset = bytes.readUInt32LE(eocd + 16);
  const diskNumber = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const hasZip64Sentinel = entryCount === 0xffff || diskEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
  if (diskNumber !== 0 || centralDisk !== 0 || (entryCount !== diskEntries && !hasZip64Sentinel)) {
    throw new Error('provider artifact ZIP uses unsupported multi-disk layout');
  }
  const locatorOffset = eocd - 20;
  const hasZip64Locator = locatorOffset >= 0 && bytes.readUInt32LE(locatorOffset) === 0x07064b50;
  if (hasZip64Sentinel || hasZip64Locator) {
    if (!hasZip64Locator) throw new Error('provider artifact ZIP has missing ZIP64 end record');
    const zip64Offset = zipInteger64(bytes, locatorOffset + 8, 'ZIP64 end-record offset');
    if (zip64Offset + 56 > bytes.length || bytes.readUInt32LE(zip64Offset) !== 0x06064b50) {
      throw new Error('provider artifact ZIP has an invalid ZIP64 end record');
    }
    if (bytes.readUInt32LE(zip64Offset + 16) !== 0 || bytes.readUInt32LE(zip64Offset + 20) !== 0) {
      throw new Error('provider artifact ZIP uses unsupported multi-disk ZIP64 layout');
    }
    const entriesOnDisk = zipInteger64(bytes, zip64Offset + 24, 'ZIP64 per-disk entry count');
    entryCount = zipInteger64(bytes, zip64Offset + 32, 'ZIP64 entry count');
    if (entriesOnDisk !== entryCount) throw new Error('provider artifact ZIP has inconsistent ZIP64 entry counts');
    centralSize = zipInteger64(bytes, zip64Offset + 40, 'ZIP64 central-directory size');
    centralOffset = zipInteger64(bytes, zip64Offset + 48, 'ZIP64 central-directory offset');
  }
  const centralEnd = centralOffset + centralSize;
  if (!Number.isSafeInteger(centralEnd) || centralOffset < 0 || centralEnd > bytes.length || centralEnd > eocd) {
    throw new Error('provider artifact ZIP has an out-of-bounds central directory');
  }

  let cursor = centralOffset;
  const seenNames = new Set();
  const localRanges = [];
  const entries = new Map();
  let totalUncompressedBytes = 0;
  for (let entry = 0; entry < entryCount; entry++) {
    if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('provider artifact ZIP has a malformed central-directory entry');
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > centralEnd) throw new Error('provider artifact ZIP has a truncated central-directory entry');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    let name;
    if (flags & 0x0800) {
      try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); }
      catch { throw new Error('provider artifact ZIP contains an invalid UTF-8 entry name'); }
    } else name = nameBytes.toString('latin1');
    const normalizedName = name.endsWith('/') ? name.slice(0, -1) : name;
    if (!normalizedName || normalizedName.startsWith('/') || normalizedName.startsWith('-') || /^[a-zA-Z]:/.test(normalizedName) || normalizedName.includes('\\') ||
        /[\u0000-\u001f\u007f]/.test(normalizedName) || normalizedName.split('/').some(part => !part || part === '.' || part === '..') ||
        path.posix.normalize(normalizedName) !== normalizedName) {
      throw new Error(`provider artifact contains an unsafe ZIP entry path: ${JSON.stringify(name)}`);
    }
    if (seenNames.has(normalizedName)) throw new Error(`provider artifact has an empty or duplicate ZIP entry listing: ${JSON.stringify(name)}`);
    seenNames.add(normalizedName);
    if ((flags & 0x0001) || (flags & 0x0040) || ![0, 8].includes(method)) {
      throw new Error(`provider artifact ZIP entry uses unsupported encryption or compression flags: ${JSON.stringify(name)}`);
    }
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('provider artifact ZIP per-entry ZIP64 sizes/offsets are unsupported by the bounded artifact reader');
    }
    totalUncompressedBytes += uncompressedSize;
    if (uncompressedSize > 32 * 1024 * 1024 || totalUncompressedBytes > 128 * 1024 * 1024) {
      throw new Error('provider artifact ZIP exceeds the per-entry or total uncompressed size limit');
    }
    if (compressedSize === 0 && uncompressedSize > 0 || compressedSize > 0 && uncompressedSize / compressedSize > 1000) {
      throw new Error('provider artifact ZIP entry exceeds the supported compression ratio');
    }
    if (localOffset < 0 || localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`provider artifact ZIP has an invalid local header offset for ${JSON.stringify(name)}`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > centralOffset || dataEnd > centralOffset || dataEnd < dataStart ||
        localFlags !== flags || localMethod !== method || localNameLength !== nameLength ||
        !bytes.subarray(localNameStart, localNameStart + localNameLength).equals(nameBytes)) {
      throw new Error(`provider artifact ZIP local and central headers disagree for ${JSON.stringify(name)}`);
    }
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressed = bytes.readUInt32LE(localOffset + 18);
    const localUncompressed = bytes.readUInt32LE(localOffset + 22);
    const hasDataDescriptor = Boolean(flags & 0x0008);
    if ((!hasDataDescriptor && (localCrc !== bytes.readUInt32LE(cursor + 16) || localCompressed !== compressedSize || localUncompressed !== uncompressedSize)) ||
        (hasDataDescriptor && ((localCrc !== 0 && localCrc !== bytes.readUInt32LE(cursor + 16)) ||
          (localCompressed !== 0 && localCompressed !== compressedSize) || (localUncompressed !== 0 && localUncompressed !== uncompressedSize)))) {
      throw new Error(`provider artifact ZIP local sizes or CRC disagree with the central directory for ${JSON.stringify(name)}`);
    }
    let localRecordEnd = dataEnd;
    if (hasDataDescriptor) {
      // Bit 3 moves the authoritative CRC/sizes into a descriptor immediately
      // after the compressed payload. Merely allowing zero local-header sizes
      // without validating that descriptor admits malformed records and lets
      // descriptor bytes overlap a later local header while escaping the
      // overlap check below.
      const descriptorMatches = descriptorStart => descriptorStart + 12 <= centralOffset &&
        bytes.readUInt32LE(descriptorStart) === bytes.readUInt32LE(cursor + 16) &&
        bytes.readUInt32LE(descriptorStart + 4) === compressedSize &&
        bytes.readUInt32LE(descriptorStart + 8) === uncompressedSize;
      // The optional signature's value can also be a legitimate CRC32. Prefer
      // the signed form only when all three descriptor fields match; otherwise
      // test the unsigned form instead of rejecting a valid CRC collision.
      const signedDescriptorMatches = dataEnd + 16 <= centralOffset &&
        bytes.readUInt32LE(dataEnd) === 0x08074b50 && descriptorMatches(dataEnd + 4);
      const unsignedDescriptorMatches = descriptorMatches(dataEnd);
      if (!signedDescriptorMatches && !unsignedDescriptorMatches) {
        throw new Error(`provider artifact ZIP has an invalid data descriptor for ${JSON.stringify(name)}`);
      }
      localRecordEnd = dataEnd + (signedDescriptorMatches ? 16 : 12);
    }
    const entryInfo = {
      name, method, crc32: bytes.readUInt32LE(cursor + 16), compressedSize, uncompressedSize,
      dataStart, dataEnd
    };
    localRanges.push({ start: localOffset, end: localRecordEnd, name });
    entries.set(name, entryInfo);
    const madeByOs = bytes.readUInt16LE(cursor + 4) >>> 8;
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    if (madeByOs === 3 || madeByOs === 19) {
      const modeType = (externalAttributes >>> 16) & 0xf000;
      if (modeType !== 0 && modeType !== 0x8000 && modeType !== 0x4000) {
        throw new Error(`provider artifact contains a symlink or special ZIP entry: ${JSON.stringify(name)}`);
      }
      if ((modeType === 0x4000 && !name.endsWith('/')) || (modeType === 0x8000 && name.endsWith('/'))) {
        throw new Error(`provider artifact ZIP entry type conflicts with its path: ${JSON.stringify(name)}`);
      }
    }
    cursor = end;
  }
  if (cursor !== centralEnd) throw new Error('provider artifact ZIP central-directory length is inconsistent');
  localRanges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < localRanges.length; index++) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw new Error(`provider artifact ZIP entries overlap: ${JSON.stringify(localRanges[index - 1].name)} and ${JSON.stringify(localRanges[index].name)}`);
    }
  }
  return entries;
}

async function readBoundedResponseBytes(response, maxBytes, label, { onReader = null } = {}) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel?.(); } catch {}
    throw new Error(`${label} exceeds the ${maxBytes}-byte response limit`);
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte response limit`);
    return bytes;
  }
  const reader = response.body.getReader();
  onReader?.(reader);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(`${label} exceeds the ${maxBytes}-byte response limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { try { reader.releaseLock(); } catch {} }
  return Buffer.concat(chunks, total);
}

async function fetchBoundedResponse(fetchImpl, url, options, { maxBytes, label, timeoutMs }) {
  const controller = new AbortController();
  let response = null;
  let reader = null;
  let timedOut = false;
  let timer;
  const work = (async () => {
    response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (timedOut) {
      try { await response.body?.cancel?.(); } catch {}
      throw new Error(`${label} timed out after ${timeoutMs} ms`);
    }
    const responseBytes = await readBoundedResponseBytes(response, maxBytes, label, {
      onReader: value => { reader = value; }
    });
    return { response, responseBytes };
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      // fetch aborts ordinary Web streams; cancel the acquired reader as well
      // so a body that is stalled after headers does not retain a pipe/socket.
      try {
        const cancellation = reader ? reader.cancel() : response?.body?.cancel?.();
        Promise.resolve(cancellation).catch(() => {});
      } catch {}
      const error = new Error(`${label} timed out after ${timeoutMs} ms`);
      error.code = 'ERR_PROVIDER_REQUEST_TIMEOUT';
      error.remoteOutcome = ['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase()) ? 'not_sent' : 'ambiguous';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`GitHubActionsProvider: ${field} is required`);
  return value;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export class GitHubActionsProvider {
  constructor({
    token = process.env.GITHUB_ACTIONS_TOKEN || process.env.GITHUB_TOKEN || (process.env.GITHUB_ACTIONS_USE_GH_CLI === 'true'
      ? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
      : undefined),
    owner = process.env.GITHUB_REPOSITORY_OWNER,
    repo = process.env.GITHUB_REPOSITORY_NAME,
    repository = process.env.GITHUB_REPOSITORY,
    apiBase = DEFAULT_API,
    workflow = process.env.GITHUB_ACTIONS_WORKFLOW || 'p3-worker.yml',
    ref = DEFAULT_REF,
    fetchImpl = globalThis.fetch,
    store = null,
    artifactDownloader = null,
    taskPayloadSourceReader = readTaskPayloadAtCommit,
    allowUnverifiedLegacyResults = false,
    now = () => Date.now(),
    requestTimeoutMs = 30_000
  } = {}) {
    this.token = token;
    const [repoOwner, repoName] = String(repository || '').split('/');
    this.owner = owner || repoOwner;
    this.repo = repo || repoName;
    this.apiBase = normalizeProviderApiBase(apiBase);
    this.workflow = workflow;
    this.ref = ref;
    this.fetch = fetchImpl;
    this.store = store;
    this.artifactDownloader = artifactDownloader;
    if (typeof taskPayloadSourceReader !== 'function') throw new Error('GitHubActionsProvider: taskPayloadSourceReader must be a function');
    this.taskPayloadSourceReader = taskPayloadSourceReader;
    this.allowUnverifiedLegacyResults = allowUnverifiedLegacyResults === true;
    this.now = now;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647) {
      throw new Error('GitHubActionsProvider: requestTimeoutMs must be a positive safe integer no greater than 2147483647');
    }
    this.requestTimeoutMs = requestTimeoutMs;
    if (!this.fetch) throw new Error('GitHubActionsProvider: fetch is unavailable');
    required(this.owner, 'owner');
    required(this.repo, 'repo');
    required(this.token, 'token');
    this.ensureSchema();
  }

  ensureSchema() {
    this.store?.db?.exec(`
      CREATE TABLE IF NOT EXISTS provider_runs (
        provider_run_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        owner_epoch INTEGER,
        input_commit TEXT NOT NULL,
        dispatch_key TEXT,
        request_sha256 TEXT,
        workflow TEXT NOT NULL,
        ref TEXT NOT NULL,
        state TEXT NOT NULL,
        conclusion TEXT,
        html_url TEXT,
        artifact_id TEXT,
        output_commit TEXT,
        run_attempt INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_runs_task ON provider_runs(task_id, attempt);
      CREATE TABLE IF NOT EXISTS provider_dispatch_intents (
        dispatch_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        owner_epoch INTEGER,
        provider TEXT NOT NULL,
        input_commit TEXT NOT NULL,
        request_sha256 TEXT,
        request_json TEXT,
        api_base TEXT,
        workflow TEXT,
        repository TEXT,
        event TEXT,
        ref TEXT,
        state TEXT NOT NULL,
        provider_run_id TEXT,
        dispatch_claim_id TEXT,
        dispatch_claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_dispatch_intents_state ON provider_dispatch_intents(state, created_at);
    `);
    ensureProviderDispatchIntentColumns(this.store?.db);
    // Existing local databases predate provider-run-attempt binding. Adding a
    // nullable column is safe, but P3 result collection below fails closed for
    // legacy rows that have no trustworthy run_attempt recorded at dispatch.
    try { this.store?.db?.exec('ALTER TABLE provider_runs ADD COLUMN run_attempt INTEGER'); }
    catch (error) {
      if (!/duplicate column name:\s*run_attempt/i.test(String(error?.message || error))) throw error;
    }
    for (const column of ['dispatch_key', 'request_sha256', 'owner_epoch']) {
      try { this.store?.db?.exec(`ALTER TABLE provider_runs ADD COLUMN ${column} ${column === 'owner_epoch' ? 'INTEGER' : 'TEXT'}`); }
      catch (error) {
        if (!new RegExp(`duplicate column name:\\s*${column}`, 'i').test(String(error?.message || error))) throw error;
      }
    }
  }

  headers() {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': API_VERSION,
      'user-agent': 'durable-agent-orchestrator/github-actions-provider'
    };
  }

  _assertAuthenticatedRequestDestination(dispatchIntent) {
    if (!dispatchIntent) return;
    const durableIdentity = providerDispatchIdentityFromIntent(dispatchIntent);
    assertProviderDispatchIntent(dispatchIntent, { ...durableIdentity, ...providerDispatchConfig(this) });
  }

  async request(method, pathname, body = undefined, { dispatchIntent = null } = {}) {
    // Revalidate synchronously at each authenticated request boundary. A prior
    // status/readiness check can go stale while the previous awaited response
    // is in flight, especially across paginated artifact enumeration.
    this._assertAuthenticatedRequestDestination(dispatchIntent);
    const requestUrl = `${this.apiBase}${pathname}`;
    const { response, responseBytes } = await fetchBoundedResponse(this.fetch, requestUrl, {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, { maxBytes: MAX_API_RESPONSE_BYTES, label: 'GitHub API response', timeoutMs: this.requestTimeoutMs });
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(responseBytes); }
    catch { throw new Error('GitHub API response body is not valid UTF-8'); }
    let data = null;
    if (text) { try { data = parseStrictJson(text, 'GitHub API response'); } catch { data = text; } }
    if (!response.ok) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      const error = new Error(`GitHub API ${response.status}: ${detail}`);
      error.status = response.status;
      error.response = data;
      error.remoteOutcome = DEFINITIVE_PRE_SEND_REJECTION_STATUSES.has(response.status) ? 'not_sent' : 'ambiguous';
      throw error;
    }
    return data;
  }

  async requestAllPages(pathname, collectionKey, { maxPages = 10, dispatchIntent = null } = {}) {
    const separator = pathname.indexOf('?');
    const basePath = separator < 0 ? pathname : pathname.slice(0, separator);
    const params = new URLSearchParams(separator < 0 ? '' : pathname.slice(separator + 1));
    const all = [];
    let lastPage = null;
    for (let page = 1; page <= maxPages; page++) {
      params.set('per_page', '100');
      params.set('page', String(page));
      const data = await this.request('GET', `${basePath}?${params}`, undefined, { dispatchIntent });
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data[collectionKey])) {
        throw new Error(`GitHub API paginated ${collectionKey} response is malformed`);
      }
      lastPage = data;
      all.push(...data[collectionKey]);
      if (data[collectionKey].length < 100) return { ...lastPage, [collectionKey]: all };
    }
    throw new Error(`GitHub API ${collectionKey} pagination exceeded the ${maxPages}-page safety limit`);
  }

  _persist(run) {
    if (!this.store?.db) return;
    const ts = new Date(this.now()).toISOString();
    // The identity preflight, upsert, and readback must be one SQLite write
    // transition. Otherwise a concurrent insert can win between SELECT and
    // UPSERT, letting a conflicting run attempt mutate terminal metadata before
    // the post-write identity check throws. A savepoint composes with callers
    // that already hold a larger dispatch-binding transaction.
    this.store.db.exec('SAVEPOINT provider_run_persist_identity');
    try {
      const persisted = this.store.db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(String(run.provider_run_id));
      if (persisted) {
        for (const field of ['provider', 'job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch', 'input_commit', 'workflow', 'ref', 'dispatch_key', 'request_sha256', 'run_attempt']) {
          const current = persisted[field]; const incoming = run[field];
          if (current !== null && current !== undefined && incoming !== null && incoming !== undefined &&
              String(current).toLowerCase() !== String(incoming).toLowerCase()) {
            throw new Error(`provider run ${run.provider_run_id} immutable ${field} binding conflicts with durable ledger`);
          }
        }
        if (persisted.state === 'COMPLETED' &&
            (run.state !== 'COMPLETED' || String(persisted.conclusion ?? '') !== String(run.conclusion ?? ''))) {
          throw new Error(`provider run ${run.provider_run_id} incoming state/conclusion conflicts with durable terminal state`);
        }
        if (persisted.state === 'COMPLETED') {
          for (const field of ['artifact_id', 'output_commit']) {
            if (persisted[field] !== null && persisted[field] !== undefined && run[field] !== null && run[field] !== undefined &&
                String(persisted[field]).toLowerCase() !== String(run[field]).toLowerCase()) {
              throw new Error(`provider run ${run.provider_run_id} incoming ${field} conflicts with durable terminal evidence`);
            }
          }
        }
      }
      const result = this.store.db.prepare(`INSERT INTO provider_runs
      (provider_run_id,provider,job_id,task_id,lease_id,attempt,owner_epoch,input_commit,dispatch_key,request_sha256,workflow,ref,state,conclusion,html_url,artifact_id,output_commit,run_attempt,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider_run_id) DO UPDATE SET
      state=CASE WHEN provider_runs.state='COMPLETED' OR excluded.state='COMPLETED' THEN 'COMPLETED' ELSE excluded.state END,
      conclusion=CASE WHEN provider_runs.state='COMPLETED' THEN provider_runs.conclusion ELSE excluded.conclusion END,
      html_url=COALESCE(provider_runs.html_url,excluded.html_url),
      artifact_id=COALESCE(provider_runs.artifact_id,excluded.artifact_id),
      output_commit=COALESCE(provider_runs.output_commit,excluded.output_commit),
      dispatch_key=COALESCE(provider_runs.dispatch_key,excluded.dispatch_key),
      request_sha256=COALESCE(provider_runs.request_sha256,excluded.request_sha256),
      owner_epoch=COALESCE(provider_runs.owner_epoch,excluded.owner_epoch),
      run_attempt=COALESCE(provider_runs.run_attempt,excluded.run_attempt), updated_at=excluded.updated_at
      WHERE (provider_runs.dispatch_key IS NULL OR excluded.dispatch_key IS NULL OR provider_runs.dispatch_key=excluded.dispatch_key)
        AND (provider_runs.request_sha256 IS NULL OR excluded.request_sha256 IS NULL OR provider_runs.request_sha256=excluded.request_sha256)`)
        .run(run.provider_run_id, 'github-actions', run.job_id, run.task_id, run.lease_id, run.attempt,
        Number.isSafeInteger(Number(run.owner_epoch)) && Number(run.owner_epoch) >= 1 ? Number(run.owner_epoch) : null, run.input_commit,
        run.dispatch_key || null, run.request_sha256 || null, run.workflow, run.ref, run.state, run.conclusion || null, run.html_url || null, run.artifact_id || null,
        run.output_commit || null, Number.isSafeInteger(Number(run.run_attempt)) && Number(run.run_attempt) >= 1 ? Number(run.run_attempt) : null,
        run.created_at || ts, ts);
      if (result?.changes === 0) throw new Error(`provider run ${run.provider_run_id} immutable dispatch binding compare-and-set failed`);
      const persistedAfterWrite = this.store.db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(String(run.provider_run_id));
      if (!persistedAfterWrite) throw new Error(`provider run ${run.provider_run_id} durable readback is missing after persistence`);
      for (const field of ['provider', 'job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch', 'input_commit', 'workflow', 'ref', 'dispatch_key', 'request_sha256', 'run_attempt']) {
        const expected = run[field];
        const actual = persistedAfterWrite[field];
        if (expected !== null && expected !== undefined && expected !== '' && actual !== null && actual !== undefined &&
            String(actual).toLowerCase() !== String(expected).toLowerCase()) {
          throw new Error(`provider run ${run.provider_run_id} durable readback conflicts with immutable ${field} binding`);
        }
        if (expected !== null && expected !== undefined && expected !== '' &&
            ['job_id', 'task_id', 'lease_id', 'input_commit', 'workflow', 'ref', 'dispatch_key', 'request_sha256'].includes(field) &&
            (actual === null || actual === undefined || actual === '')) {
          throw new Error(`provider run ${run.provider_run_id} durable readback is missing immutable ${field} binding`);
        }
      }
      for (const field of ['artifact_id', 'output_commit']) {
        const expected = run[field];
        const actual = persistedAfterWrite[field];
        if (expected !== null && expected !== undefined && expected !== '' && actual !== null && actual !== undefined &&
            String(actual).toLowerCase() !== String(expected).toLowerCase()) {
          throw new Error(`provider run ${run.provider_run_id} durable readback conflicts with terminal ${field} evidence`);
        }
      }
      if (persistedAfterWrite.state !== 'COMPLETED' && run.state === 'COMPLETED') {
        throw new Error(`provider run ${run.provider_run_id} durable readback failed to preserve terminal state`);
      }
      if (persistedAfterWrite.state === 'COMPLETED' &&
          (run.state !== 'COMPLETED' || String(persistedAfterWrite.conclusion ?? '') !== String(run.conclusion ?? ''))) {
        throw new Error(`provider run ${run.provider_run_id} durable readback conflicts with terminal state/conclusion`);
      }
      this.store.db.exec('RELEASE SAVEPOINT provider_run_persist_identity');
    } catch (error) {
      try { this.store.db.exec('ROLLBACK TO SAVEPOINT provider_run_persist_identity'); } catch {}
      try { this.store.db.exec('RELEASE SAVEPOINT provider_run_persist_identity'); } catch {}
      throw error;
    }
  }

  _assertP3ResultCollectionLease(providerRunId, result, expectedOwnerEpoch) {
    // This check is called after all remote awaits and while the caller holds a
    // SQLite writer savepoint. Status/artifact reads may outlive the lease or
    // race cancellation; the immutable provider run alone cannot authorize a
    // result once its task/parent has become terminal or ownership has changed.
    if (!this.store?.db || typeof this.store.getTaskLease !== 'function' ||
        typeof this.store.getTask !== 'function' || typeof this.store.getJob !== 'function') return;
    const currentRun = this._getPersisted(providerRunId);
    const currentIntent = this._getDispatchIntent(providerRunId);
    const lease = this.store.getTaskLease(result.lease_id);
    const task = this.store.getTask(result.task_id);
    const parent = this.store.getJob(result.job_id);
    const expiry = typeof lease?.expires_at === 'string' ? Date.parse(lease.expires_at) : NaN;
    if (!currentRun || !currentIntent || currentRun.provider_run_id !== String(providerRunId) ||
        currentRun.provider !== 'github-actions' || currentRun.state !== 'COMPLETED' ||
        String(currentRun.conclusion || '').toLowerCase() !== 'success' || currentRun.job_id !== result.job_id ||
        currentRun.task_id !== result.task_id || currentRun.lease_id !== result.lease_id ||
        currentRun.attempt !== result.attempt || currentRun.owner_epoch !== expectedOwnerEpoch ||
        currentRun.run_attempt !== result.provider_run_attempt ||
        String(currentRun.input_commit || '').toLowerCase() !== String(result.input_commit || '').toLowerCase() ||
        currentIntent.state !== 'DISPATCHED' || currentIntent.provider_run_id !== String(providerRunId) ||
        currentIntent.job_id !== result.job_id || currentIntent.task_id !== result.task_id ||
        currentIntent.lease_id !== result.lease_id || currentIntent.attempt !== result.attempt ||
        currentIntent.owner_epoch !== expectedOwnerEpoch || currentIntent.dispatch_key !== currentRun.dispatch_key ||
        currentIntent.request_sha256 !== currentRun.request_sha256 ||
        !/^[a-f0-9]{64}$/.test(String(currentIntent.request_sha256 || '')) ||
        !currentIntent.request_json || crypto.createHash('sha256').update(currentIntent.request_json).digest('hex') !== currentIntent.request_sha256 ||
        !lease || lease.state !== 'ACTIVE' || lease.job_id !== result.job_id || lease.task_id !== result.task_id ||
        lease.attempt !== result.attempt || lease.owner_epoch !== expectedOwnerEpoch ||
        !Number.isFinite(expiry) || new Date(expiry).toISOString() !== lease.expires_at || expiry <= this.now() ||
        !task || task.job_id !== result.job_id || task.status !== 'running' || task.execution_attempt !== result.attempt ||
        !parent || parent.status !== 'active' || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(String(parent.state || '').toUpperCase())) {
      throw new Error(`P3 result collection lost its exact active task/lease/dispatch fence for provider run ${providerRunId}`);
    }
    const request = parseStrictJson(currentIntent.request_json, 'durable P3 execution request at result-collection fence');
    if (JSON.stringify(request) !== currentIntent.request_json) {
      throw new Error(`P3 result collection found non-canonical immutable request bytes for provider run ${providerRunId}`);
    }
    assertProviderDispatchIntent(currentIntent, {
      job_id: result.job_id, task_id: result.task_id, lease_id: result.lease_id,
      attempt: result.attempt, owner_epoch: expectedOwnerEpoch, input_commit: result.input_commit,
      request_sha256: currentIntent.request_sha256,
      ...providerDispatchConfig(this)
    });
  }

  _validateP3RunMetadata(data, providerRunId, intent) {
    if (this.workflow.includes('p3-worker')) this._assertProviderDispatchIntent(intent);
    if (!data || typeof data !== 'object' || Array.isArray(data) || String(data.id ?? '') !== String(providerRunId)) {
      throw new Error(`GitHub Actions status response identity mismatch: requested=${providerRunId} received=${String(data?.id ?? '')}`);
    }
    if (!WORKFLOW_RUN_STATUSES.has(String(data.status || ''))) {
      throw new Error(`GitHub Actions run ${providerRunId} has an unsupported status`);
    }
    if (data.status === 'completed' && typeof data.conclusion !== 'string') {
      throw new Error(`GitHub Actions completed run ${providerRunId} has no explicit conclusion`);
    }
    if (data.status === 'completed' && !WORKFLOW_RUN_CONCLUSIONS.has(data.conclusion)) {
      throw new Error(`GitHub Actions completed run ${providerRunId} has an unsupported conclusion: ${String(data.conclusion)}`);
    }
    if (data.status !== 'completed' && data.conclusion != null) {
      throw new Error(`GitHub Actions run ${providerRunId} has a conclusion before completion`);
    }
    const expectedPath = String(intent.workflow).startsWith('.github/workflows/') ? intent.workflow : `.github/workflows/${intent.workflow}`;
    const expectedBranch = String(intent.ref).replace(/^refs\/heads\//, '');
    const createdAt = Date.parse(data.created_at || '');
    const requestedAt = Date.parse(intent?.dispatch_claimed_at || intent?.created_at || '');
    const runAttempt = Number(data.run_attempt);
    if (String(data.path || '').split('@', 1)[0] !== expectedPath || data.event !== intent.event ||
        String(data.repository?.full_name || '').toLowerCase() !== String(intent.repository).toLowerCase() ||
        (!/^[a-f0-9]{40}$/i.test(expectedBranch) && String(data.head_branch || '') !== expectedBranch) ||
        !Number.isSafeInteger(runAttempt) || runAttempt < 1 ||
        String(data.display_title || '') !== `P3 worker ${intent.dispatch_key}` ||
        !Number.isFinite(createdAt) || !Number.isFinite(requestedAt) ||
        createdAt < requestedAt - 30_000 || createdAt > requestedAt + 10 * 60_000 ||
        String(data.head_sha || '').toLowerCase() !== String(intent.input_commit || '').toLowerCase()) {
      throw new Error(`GitHub Actions run ${providerRunId} does not match the durable P3 dispatch key, creation window, and input commit/workflow/repository/ref/event contract`);
    }
    return {
      provider_run_id: String(data.id), job_id: intent.job_id, task_id: intent.task_id,
      lease_id: intent.lease_id, attempt: Number(intent.attempt), input_commit: intent.input_commit,
      owner_epoch: Number(intent.owner_epoch),
      workflow: this.workflow, ref: this.ref,
      state: data.status === 'completed' ? 'COMPLETED' : 'RUNNING',
      conclusion: data.conclusion || null, html_url: data.html_url || null,
      created_at: data.created_at, run_attempt: runAttempt, status: data.status,
      head_sha: data.head_sha, head_branch: data.head_branch, event: data.event, path: data.path
    };
  }

  _getPersisted(providerRunId) {
    return this.store?.db?.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(String(providerRunId)) || null;
  }

  _getDispatchIntent(providerRunId) {
    return this.store?.db?.prepare('SELECT * FROM provider_dispatch_intents WHERE provider_run_id=?').get(String(providerRunId)) || null;
  }

  async _reconcileClaimedDispatchIntent(intent) {
    let reconciliationError = null;
    try {
      const reconciled = await this.reconcileDispatchIntent(intent);
      if (reconciled) return { ...reconciled, dispatch_key: String(intent.dispatch_key), idempotent: true };
    } catch (error) {
      reconciliationError = String(error?.message || error);
    }

    const latest = this.store?.db?.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(String(intent.dispatch_key));
    if (latest?.provider_run_id) {
      this._assertProviderDispatchIntent(latest);
      const existing = this._getPersisted(latest.provider_run_id);
      if (!existing || existing.provider !== 'github-actions' || existing.workflow !== this.workflow || existing.ref !== this.ref ||
          existing.job_id !== latest.job_id || existing.task_id !== latest.task_id || existing.lease_id !== latest.lease_id ||
          Number(existing.attempt) !== Number(latest.attempt) || Number(existing.owner_epoch) !== Number(latest.owner_epoch) ||
          String(existing.input_commit).toLowerCase() !== String(latest.input_commit).toLowerCase()) {
        throw new Error('claimed P3 dispatch intent has no matching durable provider-run record');
      }
      return { ...existing, dispatch_key: String(intent.dispatch_key), idempotent: true };
    }
    return {
      provider_run_id: null,
      dispatch_key: String(intent.dispatch_key),
      state: 'DISPATCHING',
      pending_reconciliation: true,
      dispatch_error: 'dispatch_claim_owned_by_another_process',
      ...(reconciliationError ? { reconciliation_error: reconciliationError } : {})
    };
  }

  _assertProviderDispatchIntent(intent, request = null, inputCommit = null) {
    const source = request
      // Keep the immutable request bytes exactly as supplied when calculating
      // request_sha256. Git commit IDs are case-insensitive, and resolveCommit
      // returns lowercase; rewriting input_commit here would change the request
      // digest mid-lifecycle and reject an otherwise identical uppercase SHA.
      ? (({ dispatch_key: _dispatchKey, ...executionRequest }) => executionRequest)(request)
      : intent;
    const expected = request
      ? createProviderDispatchIdentity(source, providerDispatchConfig(this))
      : providerDispatchIdentityFromIntent(source);
    if (request && inputCommit && expected.input_commit !== String(inputCommit).toLowerCase()) {
      throw new Error('resolved provider input commit does not match the immutable execution request identity');
    }
    return assertProviderDispatchIntent(intent, expected);
  }

  _assertActiveDispatchLease(intent, request, checkedAt = new Date(this.now()).toISOString()) {
    const db = this.store?.db;
    // Unit-level provider fakes do not implement SQLite lease storage. The
    // production P3 boundary uses node:sqlite DatabaseSync, whose isOpen
    // property distinguishes the real durable store from those narrow fakes.
    if (!db || typeof db.isOpen !== 'boolean') return;
    const lease = db.prepare('SELECT * FROM task_leases WHERE lease_id=?').get(String(intent.lease_id));
    const valid = lease && lease.state === 'ACTIVE' &&
      String(lease.job_id) === String(intent.job_id) &&
      String(lease.task_id) === String(intent.task_id) &&
      Number(lease.attempt) === Number(intent.attempt) &&
      Number(lease.owner_epoch) === Number(intent.owner_epoch) &&
      typeof lease.expires_at === 'string' && lease.expires_at > checkedAt &&
      String(request?.job_id) === String(intent.job_id) &&
      String(request?.task_id) === String(intent.task_id) &&
      String(request?.lease_id) === String(intent.lease_id) &&
      Number(request?.attempt) === Number(intent.attempt) &&
      Number(request?.owner_epoch) === Number(intent.owner_epoch);
    if (!valid) {
      const error = new Error('P3 dispatch requires the exact active, unexpired durable lease at the provider send boundary');
      error.remoteOutcome = 'not_sent';
      throw error;
    }
  }

  _bindDispatchRun(intent, run) {
    const db = this.store?.db;
    if (!db) throw new Error('GitHub Actions dispatch result binding requires durable SQLite storage');
    this._assertProviderDispatchIntent(intent);
    const expectedRunIdentity = {
      job_id: intent.job_id, task_id: intent.task_id, lease_id: intent.lease_id,
      attempt: Number(intent.attempt), owner_epoch: Number(intent.owner_epoch), input_commit: String(intent.input_commit).toLowerCase(),
      workflow: intent.workflow, ref: intent.ref
    };
    for (const field of ['job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch', 'input_commit', 'workflow', 'ref']) {
      if (field === 'attempt') {
        if (Number(run[field]) !== expectedRunIdentity[field]) throw new Error(`GitHub Actions run binding does not match durable ${field} identity`);
      } else if (field === 'owner_epoch') {
        if (Number(run[field]) !== expectedRunIdentity[field]) throw new Error(`GitHub Actions run binding does not match durable ${field} identity`);
      } else if (field === 'input_commit'
        ? String(run[field] ?? '').toLowerCase() !== expectedRunIdentity[field]
        : String(run[field] ?? '') !== String(expectedRunIdentity[field] ?? '')) {
        throw new Error(`GitHub Actions run binding does not match durable ${field} identity`);
      }
    }
    const bind = () => {
      // DatabaseSync (the production node:sqlite API) has no transaction(fn)
      // helper. Use a real savepoint and make its first statement a write so
      // competing processes serialize before reading the intent. The intent CAS
      // and provider-run ledger insert must commit or roll back together.
      db.exec('SAVEPOINT provider_dispatch_run_binding');
      try {
      const reservation = db.prepare('UPDATE provider_dispatch_intents SET updated_at=updated_at WHERE dispatch_key=?')
        .run(String(intent.dispatch_key));
      if (reservation.changes !== 1) throw new Error('GitHub Actions durable dispatch intent disappeared before result binding');
      const current = db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(String(intent.dispatch_key));
      if (!current || current.job_id !== intent.job_id || current.task_id !== intent.task_id ||
          current.lease_id !== intent.lease_id || Number(current.attempt) !== Number(intent.attempt) ||
          Number(current.owner_epoch) !== Number(intent.owner_epoch) ||
          current.provider !== 'github-actions' || String(current.input_commit).toLowerCase() !== String(intent.input_commit).toLowerCase() ||
          current.request_sha256 !== intent.request_sha256 ||
          current.request_json !== intent.request_json ||
          current.api_base !== intent.api_base || current.workflow !== intent.workflow || current.repository !== intent.repository ||
          current.event !== intent.event || current.ref !== intent.ref) {
        throw new Error('GitHub Actions dispatch intent changed identity before result binding');
      }
      if (!Number.isSafeInteger(Number(run.run_attempt)) || Number(run.run_attempt) < 1) {
        throw new Error('GitHub Actions P3 run binding requires a validated positive run_attempt');
      }
      const existingRun = this._getPersisted(run.provider_run_id);
      if (existingRun && (existingRun.provider !== 'github-actions' || existingRun.workflow !== run.workflow ||
          existingRun.ref !== run.ref || existingRun.job_id !== run.job_id || existingRun.task_id !== run.task_id ||
          existingRun.lease_id !== run.lease_id || Number(existingRun.attempt) !== Number(run.attempt) ||
          Number(existingRun.owner_epoch) !== Number(run.owner_epoch) ||
          String(existingRun.input_commit).toLowerCase() !== String(run.input_commit).toLowerCase() ||
          String(existingRun.dispatch_key || '') !== String(intent.dispatch_key) ||
          String(existingRun.request_sha256 || '') !== String(intent.request_sha256) ||
          Number(existingRun.run_attempt) !== Number(run.run_attempt))) {
        throw new Error(`GitHub Actions run ${run.provider_run_id} is already bound to a different durable execution attempt`);
      }
      if (current.provider_run_id) {
        if (String(current.provider_run_id) !== String(run.provider_run_id) || !['DISPATCHED', 'COMPLETED'].includes(String(current.state))) {
          throw new Error('GitHub Actions dispatch intent was concurrently bound to a different provider run');
        }
        if (!existingRun) throw new Error('GitHub Actions dispatch intent points to a provider run missing from the durable run ledger');
        db.exec('RELEASE SAVEPOINT provider_dispatch_run_binding');
        return existingRun;
      }
      if (current.state !== 'DISPATCHING') throw new Error(`GitHub Actions dispatch intent cannot bind a run from state ${String(current.state)}`);
      const update = db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHED', provider_run_id=?, updated_at=?
        WHERE dispatch_key=? AND state='DISPATCHING' AND provider_run_id IS NULL`)
        .run(String(run.provider_run_id), new Date(this.now()).toISOString(), String(intent.dispatch_key));
      if (update.changes !== 1) throw new Error('GitHub Actions dispatch intent compare-and-set failed during result binding');
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_PROVIDER_INTENT_BIND_CAS === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
      this._persist({ ...run, dispatch_key: String(intent.dispatch_key), request_sha256: String(intent.request_sha256) });
      const persistedRun = this._getPersisted(run.provider_run_id);
      if (!persistedRun || persistedRun.provider !== 'github-actions' || persistedRun.workflow !== run.workflow ||
          persistedRun.ref !== run.ref || persistedRun.job_id !== run.job_id || persistedRun.task_id !== run.task_id ||
          persistedRun.lease_id !== run.lease_id || Number(persistedRun.attempt) !== Number(run.attempt) ||
          String(persistedRun.input_commit).toLowerCase() !== String(run.input_commit).toLowerCase() ||
          String(persistedRun.dispatch_key || '') !== String(intent.dispatch_key) ||
          String(persistedRun.request_sha256 || '') !== String(intent.request_sha256) ||
          Number(persistedRun.run_attempt) !== Number(run.run_attempt)) {
        throw new Error('GitHub Actions provider-run ledger readback does not match the exact dispatch binding');
      }
      db.exec('RELEASE SAVEPOINT provider_dispatch_run_binding');
      return run;
      } catch (error) {
        try { db.exec('ROLLBACK TO SAVEPOINT provider_dispatch_run_binding'); } catch {}
        try { db.exec('RELEASE SAVEPOINT provider_dispatch_run_binding'); } catch {}
        throw error;
      }
    };
    return bind();
  }

  async resolveCommit(commit) {
    required(commit, 'input_commit');
    if (/^[0-9a-f]{40}$/i.test(commit)) return commit.toLowerCase();
    const data = await this.request('GET', `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/commits/${encodeURIComponent(commit)}`);
    if (!/^[0-9a-f]{40}$/i.test(String(data?.sha || ''))) throw new Error(`GitHub commit lookup returned invalid SHA for ${commit}`);
    return String(data.sha).toLowerCase();
  }

  async dispatch(request) {
    let dispatchKey;
    let executionRequest;
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype) {
        throw new Error('GitHub Actions dispatch request must be a plain JSON object');
      }
      const keys = Reflect.ownKeys(request);
      if (keys.some(key => typeof key !== 'string')) throw new Error('GitHub Actions dispatch request contains symbol-keyed properties');
      for (const key of keys) {
        if (key !== 'dispatch_key' && ![
          'schema_version', 'job_id', 'task_id', 'lease_id', 'attempt', 'role', 'input_commit',
          'owner_epoch', 'task_payload_ref', 'workspace', 'required_evidence', 'task_payload_inline'
        ].includes(key)) throw new Error(`GitHub Actions dispatch request contains unsupported field ${key}`);
        const descriptor = Object.getOwnPropertyDescriptor(request, key);
        if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new Error(`GitHub Actions dispatch request field ${key} is not an enumerable data property`);
        }
      }
      dispatchKey = Object.hasOwn(request, 'dispatch_key') ? Object.getOwnPropertyDescriptor(request, 'dispatch_key').value : undefined;
      const requestMaterial = {};
      for (const key of keys) if (key !== 'dispatch_key') requestMaterial[key] = Object.getOwnPropertyDescriptor(request, key).value;
      // Snapshot the full canonical request synchronously before the first
      // await. A caller mutating the original object while commit resolution or
      // provider I/O is pending cannot change the request sent after its hash
      // was checked against the durable intent.
      executionRequest = parseStrictJson(canonicalProviderDispatchRequest(requestMaterial), 'GitHub Actions dispatch request snapshot');
      validateExecutionRequest(executionRequest);
      if (this.workflow.includes('p3-worker')) validateInlineP3TaskPayload(executionRequest);
      request = executionRequest;
    }
    catch (error) { error.remoteOutcome = 'not_sent'; throw error; }
    const requiresP3Evidence = this.workflow.includes('p3-worker');
    if (requiresP3Evidence && !this.store?.db) {
      throw new Error('P3 GitHub Actions dispatch requires a durable provider-run ledger before any remote side effect');
    }
    if (requiresP3Evidence && !/^[a-f0-9]{64}$/i.test(String(dispatchKey || ''))) {
      throw new Error('P3 GitHub Actions dispatch requires a 64-character hexadecimal dispatch_key');
    }
    if (dispatchKey !== undefined && dispatchKey !== null && !/^[a-f0-9]{64}$/i.test(String(dispatchKey))) {
      throw new Error('GitHub Actions dispatch_key must be a 64-character hexadecimal digest');
    }
    // Authentication principal and transport implementation are not included
    // in the request digest (secrets must not be persisted), but they still
    // must not be hot-swapped during an in-flight durable dispatch. The
    // request/header methods are also part of the transport boundary: checking
    // only `fetch` would let a replaced `request()` bypass URL/header binding
    // while retaining the original fetch function.
    const dispatchTokenAtStart = this.token;
    const dispatchFetchAtStart = this.fetch;
    const dispatchRequestMethodAtStart = this.request;
    const dispatchHeadersMethodAtStart = this.headers;
    let inputCommit;
    try { inputCommit = await this.resolveCommit(request.input_commit); }
    catch (error) { error.remoteOutcome = 'not_sent'; throw error; }
    let dispatchIntent = null;
    if (requiresP3Evidence) {
      dispatchIntent = this.store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(String(dispatchKey));
      if (!dispatchIntent) throw new Error('P3 dispatch requires a pre-existing durable provider_dispatch_intents row before any remote side effect');
      if (dispatchIntent.job_id !== request.job_id || dispatchIntent.task_id !== request.task_id ||
          dispatchIntent.lease_id !== request.lease_id || Number(dispatchIntent.attempt) !== Number(request.attempt) ||
          dispatchIntent.provider !== 'github-actions' || String(dispatchIntent.input_commit).toLowerCase() !== inputCommit) {
        throw new Error('P3 durable dispatch intent does not match the approved execution request identity');
      }
      try { this._assertProviderDispatchIntent(dispatchIntent, request, inputCommit); }
      catch (error) {
        error.remoteOutcome = 'not_sent';
        throw error;
      }
      if (dispatchIntent.provider_run_id) {
        const existing = this._getPersisted(dispatchIntent.provider_run_id);
        if (!existing || existing.workflow !== this.workflow || existing.ref !== this.ref ||
            existing.job_id !== request.job_id || existing.task_id !== request.task_id ||
            existing.lease_id !== request.lease_id || Number(existing.attempt) !== Number(request.attempt) ||
            Number(existing.owner_epoch) !== Number(request.owner_epoch) ||
            String(existing.input_commit).toLowerCase() !== inputCommit) {
          throw new Error('P3 resolved dispatch intent has no matching durable provider-run record');
        }
        return { ...existing, dispatch_key: String(dispatchKey), idempotent: true };
      }
      if (dispatchIntent.state !== 'DISPATCHING') {
        throw new Error(`P3 durable dispatch intent is not dispatchable from state ${String(dispatchIntent.state)}`);
      }
      if (dispatchIntent.dispatch_claim_id) {
        // A durable claim is deliberately one-way after the first possible
        // remote side effect. A different process may reconcile this intent,
        // but must never issue another workflow_dispatch POST merely because
        // no run is visible yet (including after a timeout or crash).
        return this._reconcileClaimedDispatchIntent(dispatchIntent);
      }
      // Commit resolution may await remote metadata lookup. Re-check the
      // durable lease after that await so an expired/fenced attempt cannot
      // obtain a fresh one-way send claim.
      this._assertActiveDispatchLease(dispatchIntent, request, new Date(this.now()).toISOString());
    }
    const body = {
      ref: this.ref,
      inputs: {
        job_id: request.job_id,
        task_id: request.task_id,
        lease_id: request.lease_id,
        attempt: String(request.attempt),
        input_commit: inputCommit
      }
    };
    if (this.workflow.includes('p3-worker')) {
      body.inputs.owner_epoch = String(request.owner_epoch);
      body.inputs.task_payload_ref = request.task_payload_ref;
      body.inputs.role = request.role;
      if (request.task_payload_inline !== undefined) {
        body.inputs.task_payload_json = JSON.stringify(request.task_payload_inline);
      }
    }
    if (dispatchKey) body.inputs.dispatch_key = dispatchKey;
    let dispatchClaimId = null;
    if (requiresP3Evidence) {
      dispatchClaimId = crypto.randomUUID();
      const dispatchClaimedAt = new Date(this.now()).toISOString();
      const durableRequestJson = dispatchIntent?.request_json;
      const durableRequestHash = dispatchIntent?.request_sha256;
      const nativeSqlite = typeof this.store.db.isOpen === 'boolean';
      const claimSql = `UPDATE provider_dispatch_intents
        SET dispatch_claim_id=?, dispatch_claimed_at=?, updated_at=?
        WHERE dispatch_key=? AND state='DISPATCHING' AND provider_run_id IS NULL AND dispatch_claim_id IS NULL
          AND request_sha256=? AND request_json=?${nativeSqlite ? `
          AND EXISTS (SELECT 1 FROM task_leases lease WHERE lease.lease_id=? AND lease.job_id=? AND lease.task_id=?
            AND lease.attempt=? AND lease.owner_epoch=? AND lease.state='ACTIVE' AND lease.expires_at>?)
          AND NOT EXISTS (SELECT 1 FROM provider_dispatch_intents sibling WHERE sibling.lease_id=? AND sibling.task_id=?
            AND sibling.attempt=? AND sibling.provider=? AND sibling.dispatch_key<>?)` : ''}`;
      const claim = this.store.db.prepare(claimSql).run(...[
        dispatchClaimId, dispatchClaimedAt, dispatchClaimedAt, String(dispatchKey), durableRequestHash, durableRequestJson,
        ...(nativeSqlite ? [String(dispatchIntent.lease_id), String(dispatchIntent.job_id), String(dispatchIntent.task_id),
          Number(dispatchIntent.attempt), Number(dispatchIntent.owner_epoch), dispatchClaimedAt,
          String(dispatchIntent.lease_id), String(dispatchIntent.task_id), Number(dispatchIntent.attempt),
          String(dispatchIntent.provider), String(dispatchKey)] : [])
      ]);
      if (claim.changes !== 1) {
        const latest = this.store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(String(dispatchKey));
        if (!latest) throw new Error('P3 durable dispatch intent disappeared before the remote send claim');
        this._assertProviderDispatchIntent(latest, request, inputCommit);
        if (latest.provider_run_id) {
          const existing = this._getPersisted(latest.provider_run_id);
          if (!existing) throw new Error('P3 resolved dispatch intent has no matching durable provider-run record');
          return { ...existing, dispatch_key: String(dispatchKey), idempotent: true };
        }
        if (latest.dispatch_claim_id) return this._reconcileClaimedDispatchIntent(latest);
        throw new Error('P3 dispatch lost its durable one-way send claim before any remote side effect');
      }
      dispatchIntent.dispatch_claim_id = dispatchClaimId;
      dispatchIntent.dispatch_claimed_at = dispatchClaimedAt;
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_PROVIDER_SEND_CLAIM === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
    }
    let data;
    try {
      // `now` and other injected callbacks are application-controlled code. A
      // callback can mutate provider configuration after the first intent
      // check but before the POST. Revalidate the complete durable identity at
      // the last synchronous point before crossing the network boundary. The
      // surrounding catch releases the claim only for this explicit not-sent
      // failure; no request has been handed to fetch yet.
      if (requiresP3Evidence) {
        // Evaluate the injected clock before the final configuration checks.
        // `now()` is application-controlled and may mutate provider fields;
        // calling it after identity validation creates a last-instruction
        // destination-substitution window immediately before transport.
        const finalLeaseCheckAt = new Date(this.now()).toISOString();
        if (this.token !== dispatchTokenAtStart || this.fetch !== dispatchFetchAtStart ||
            this.request !== dispatchRequestMethodAtStart || this.headers !== dispatchHeadersMethodAtStart) {
          const error = new Error('P3 dispatch authentication credential, request pipeline, or transport changed while the durable request was pending');
          error.remoteOutcome = 'not_sent';
          throw error;
        }
        try { this._assertProviderDispatchIntent(dispatchIntent, request, inputCommit); }
        catch (error) { error.remoteOutcome = 'not_sent'; throw error; }
        this._assertActiveDispatchLease(dispatchIntent, request, finalLeaseCheckAt);
      }
      // Invoke the exact request method captured before asynchronous commit
      // resolution. The equality checks above make this a defense-in-depth
      // invariant rather than trusting a mutable instance method at send time.
      data = await dispatchRequestMethodAtStart.call(this, 'POST', `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/workflows/${encodeURIComponent(this.workflow)}/dispatches`, body);
      if (process.env.NODE_ENV === 'test' && process.env.CHAT_ON_STEROIDS_TEST_CRASH_AFTER_PROVIDER_DISPATCH_RESPONSE === 'SIGKILL') {
        process.kill(process.pid, 'SIGKILL');
      }
    } catch (error) {
      if (error?.remoteOutcome === 'not_sent' && dispatchClaimId) {
        // Only an explicit rejection before remote acceptance lets us release
        // the claim. If this cleanup is interrupted, the durable claim stays
        // conservative and recovery remains reconciliation-only.
        this.store.db.prepare(`UPDATE provider_dispatch_intents SET dispatch_claim_id=NULL, dispatch_claimed_at=NULL, updated_at=?
          WHERE dispatch_key=? AND state='DISPATCHING' AND provider_run_id IS NULL AND dispatch_claim_id=?`)
          .run(new Date(this.now()).toISOString(), String(dispatchKey), dispatchClaimId);
      }
      // A transport failure after workflow_dispatch is ambiguous: GitHub may have
      // accepted the request even though the client did not receive its response.
      // Do not let the caller treat that as a definite dispatch failure and start
      // a replacement attempt until the original intent has been reconciled.
      if (error?.remoteOutcome === 'not_sent' || (error?.status && error.status < 500) || !dispatchKey || !this.store?.db) throw error;
      const intent = dispatchIntent || {
        dispatch_key: dispatchKey,
        job_id: request.job_id,
        task_id: request.task_id,
        lease_id: request.lease_id,
        attempt: request.attempt,
        input_commit: inputCommit,
        created_at: new Date(this.now()).toISOString()
      };
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const reconciled = await this.reconcileDispatchIntent(intent);
          if (reconciled) return reconciled;
        } catch {
          // Preserve the original ambiguous state. A later reconciliation pass
          // can retry after GitHub's API becomes reachable again. An API error
          // during reconciliation is not evidence that the original dispatch
          // was rejected.
        }
        await sleep(250 * (attempt + 1));
      }
      return {
        provider_run_id: null,
        dispatch_key: dispatchKey,
        state: 'DISPATCHING',
        pending_reconciliation: true,
        dispatch_error: 'ambiguous_transport_failure'
      };
    }
    // GitHub normally answers workflow_dispatch with HTTP 204 and only exposes
    // the workflow_run_id after the run is created. Reconcile the dispatch intent
    // instead of treating a successful 204 as a failed dispatch.
    if (!data?.workflow_run_id) {
      if (!dispatchKey || !this.store?.db) {
        return { provider_run_id: null, dispatch_key: dispatchKey || null, state: 'DISPATCHING', pending_reconciliation: true };
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const reconciled = await this.reconcileDispatchIntent(dispatchIntent || {
          dispatch_key: dispatchKey,
          job_id: request.job_id,
          task_id: request.task_id,
          lease_id: request.lease_id,
          attempt: request.attempt,
          input_commit: inputCommit,
          created_at: new Date(this.now()).toISOString()
        });
        if (reconciled) return reconciled;
        await sleep(250 * (attempt + 1));
      }
      return { provider_run_id: null, dispatch_key: dispatchKey, state: 'DISPATCHING', pending_reconciliation: true };
    }
    const run = {
      provider_run_id: String(data.workflow_run_id), job_id: request.job_id, task_id: request.task_id,
      lease_id: request.lease_id, attempt: request.attempt, input_commit: inputCommit,
      owner_epoch: request.owner_epoch,
      workflow: this.workflow, ref: this.ref, state: 'QUEUED', conclusion: null,
      html_url: data.html_url || data.run_url || null, created_at: new Date(this.now()).toISOString()
    };
    if (requiresP3Evidence) {
      if (!/^\d+$/.test(run.provider_run_id)) {
        return { provider_run_id: null, dispatch_key: dispatchKey, state: 'DISPATCHING', pending_reconciliation: true,
          dispatch_error: 'malformed_dispatch_run_id' };
      }
      // A dispatch response's numeric ID is not proof that it belongs to this
      // intent. Fetch and validate the actual run metadata before committing the
      // one-way durable intent -> run binding. Any lookup/identity failure after
      // POST is an ambiguous remote outcome; keep the intent pending instead of
      // expiring its lease or binding an unrelated run.
      try {
        const actual = await this.request('GET', `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/runs/${encodeURIComponent(run.provider_run_id)}`, undefined, {
          dispatchIntent
        });
        const validated = this._validateP3RunMetadata(actual, run.provider_run_id, dispatchIntent);
        return this._bindDispatchRun(dispatchIntent, validated);
      } catch (error) {
        return { provider_run_id: null, dispatch_key: dispatchKey, state: 'DISPATCHING', pending_reconciliation: true,
          dispatch_error: 'dispatch_run_identity_unverified', reconciliation_error: String(error?.message || error) };
      }
    }
    if (!/^\d+$/.test(run.provider_run_id)) throw new Error('GitHub Actions dispatch response returned a malformed workflow_run_id');
    this._persist(run);
    return run;
  }

  async reconcileDispatchIntent(intent) {
    if (!/^[a-f0-9]{64}$/i.test(String(intent?.dispatch_key || ''))) {
      throw new Error('GitHub Actions dispatch reconciliation requires a 64-character hexadecimal dispatch_key');
    }
    if (this.workflow.includes('p3-worker')) this._assertProviderDispatchIntent(intent);
    const created = new Date(intent.dispatch_claimed_at || intent.created_at || Date.now());
    const since = new Date(created.getTime() - 30_000).toISOString();
    const until = new Date(Math.max(this.now(), created.getTime() + 10 * 60_000)).toISOString();
    if (this.workflow.includes('p3-worker')) {
      // A claimed intent may already have caused a remote side effect, so its
      // recovery path is lookup-only. Lookup-only must still use the exact
      // durable destination: this request carries the provider bearer token.
      // Validate after the injected clock callback and immediately before the
      // lookup boundary, not merely by validating the intent against itself.
      const durableIdentity = providerDispatchIdentityFromIntent(intent);
      assertProviderDispatchIntent(intent, { ...durableIdentity, ...providerDispatchConfig(this) });
    }
    const params = new URLSearchParams({ event: 'workflow_dispatch', head_sha: intent.input_commit, created: `${since}..${until}`, per_page: '100' });
    const data = await this.requestAllPages(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/workflows/${encodeURIComponent(this.workflow)}/runs?${params}`, 'workflow_runs', {
      dispatchIntent: this.workflow.includes('p3-worker') ? intent : null
    });
    const marker = String(intent.dispatch_key);
    // Dispatch keys are 64 hex characters. Do not accept a run whose title
    // merely contains those characters as a substring: a lookalike run name
    // could otherwise be linked to this task/lease and later supply its result.
    // The P3 workflow has an explicit run-name contract; older workflows are
    // accepted only when the key is a complete token, bounded by non-hex chars.
    const tokenPattern = new RegExp(`(^|[^0-9a-f])${marker}([^0-9a-f]|$)`, 'i');
    const matches = (data?.workflow_runs || []).filter(run => {
      const title = String(run.display_title || '');
      const name = String(run.name || '');
      const createdAt = Date.parse(run.created_at || '');
      if (!Number.isFinite(createdAt) || createdAt < created.getTime() - 30_000 || createdAt > created.getTime() + 10 * 60_000) return false;
      if (this.workflow.includes('p3-worker')) {
        const expectedPath = this.workflow.startsWith('.github/workflows/') ? this.workflow : `.github/workflows/${this.workflow}`;
        const expectedBranch = String(this.ref).replace(/^refs\/heads\//, '');
        return title === `P3 worker ${marker}` && /^\d+$/.test(String(run.id ?? '')) &&
          String(run.path || '').split('@', 1)[0] === expectedPath && run.event === 'workflow_dispatch' &&
          String(run.repository?.full_name || '').toLowerCase() === `${this.owner}/${this.repo}`.toLowerCase() &&
          (/^[a-f0-9]{40}$/i.test(expectedBranch) || String(run.head_branch || '') === expectedBranch) &&
          String(run.head_sha || '').toLowerCase() === String(intent.input_commit || '').toLowerCase() &&
          ['queued', 'in_progress', 'completed', 'requested', 'waiting', 'pending'].includes(String(run.status || '')) &&
          (run.status !== 'completed' || typeof run.conclusion === 'string') &&
          Number.isSafeInteger(Number(run.run_attempt)) && Number(run.run_attempt) >= 1;
      }
      return tokenPattern.test(title) || tokenPattern.test(name);
    });
    if (matches.length !== 1) return null;
    const run = matches[0];
    let normalized;
    if (this.workflow.includes('p3-worker')) normalized = this._validateP3RunMetadata(run, String(run.id), intent);
    else normalized = {
      provider_run_id: String(run.id), job_id: intent.job_id, task_id: intent.task_id,
      lease_id: intent.lease_id, attempt: intent.attempt, input_commit: intent.input_commit,
      workflow: this.workflow, ref: this.ref, state: run.status === 'completed' ? 'COMPLETED' : 'RUNNING',
      conclusion: run.conclusion || null, html_url: run.html_url || null, created_at: run.created_at || new Date(this.now()).toISOString()
    };
    if (this.store?.db) {
      const durableIntent = this.store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(String(intent.dispatch_key));
      if (durableIntent) return this._bindDispatchRun(intent, normalized);
      if (this.workflow.includes('p3-worker')) throw new Error('P3 reconciliation requires a current durable dispatch intent');
    }
    this._persist(normalized);
    return normalized;
  }

  async getStatus(providerRunId) {
    required(providerRunId, 'providerRunId');
    if (!/^\d+$/.test(String(providerRunId))) throw new Error('GitHub Actions providerRunId must be a numeric workflow run ID');
    const requiresP3Evidence = this.workflow.includes('p3-worker');
    const persistedBeforeStatus = this._getPersisted(providerRunId);
    const dispatchIntent = requiresP3Evidence ? this._getDispatchIntent(providerRunId) : null;
    if (requiresP3Evidence) {
      if (!persistedBeforeStatus || !dispatchIntent || !/^[a-f0-9]{64}$/i.test(String(dispatchIntent.dispatch_key || '')) ||
          !['DISPATCHED', 'COMPLETED'].includes(String(dispatchIntent.state || '')) ||
          String(dispatchIntent.provider_run_id || '') !== String(providerRunId)) {
        throw new Error(`P3 status requires matching durable provider-run and dispatch-intent lineage for ${providerRunId}`);
      }
      if (persistedBeforeStatus.provider !== 'github-actions' || persistedBeforeStatus.workflow !== this.workflow || persistedBeforeStatus.ref !== this.ref ||
          Number(persistedBeforeStatus.owner_epoch) !== Number(dispatchIntent.owner_epoch) ||
          String(persistedBeforeStatus.dispatch_key || '') !== String(dispatchIntent.dispatch_key) ||
          String(persistedBeforeStatus.request_sha256 || '') !== String(dispatchIntent.request_sha256 || '') ||
          !/^[a-f0-9]{64}$/i.test(String(dispatchIntent.request_sha256 || '')) ||
          persistedBeforeStatus.job_id !== dispatchIntent.job_id || persistedBeforeStatus.task_id !== dispatchIntent.task_id ||
          persistedBeforeStatus.lease_id !== dispatchIntent.lease_id || Number(persistedBeforeStatus.attempt) !== Number(dispatchIntent.attempt) ||
          String(persistedBeforeStatus.input_commit).toLowerCase() !== String(dispatchIntent.input_commit).toLowerCase()) {
        throw new Error(`P3 durable provider-run record does not match its dispatch intent for ${providerRunId}`);
      }
      // Status polling sends the bearer token just like dispatch reconciliation.
      // The persisted run/intent may be valid while this provider instance was
      // restarted with a different API origin or repository configuration.
      // Bind the current authenticated destination to the durable identity
      // before the first network call; checking the returned run after the GET
      // cannot prevent credential disclosure to a substituted origin.
      const durableIdentity = providerDispatchIdentityFromIntent(dispatchIntent);
      assertProviderDispatchIntent(dispatchIntent, { ...durableIdentity, ...providerDispatchConfig(this) });
    }
    const data = await this.request('GET', `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/runs/${encodeURIComponent(providerRunId)}`, undefined, {
      dispatchIntent: requiresP3Evidence ? dispatchIntent : null
    });
    // Bind every status read to the requested run ID before persisting anything.
    // A proxy, malformed API response, or cross-linked fixture must not let
    // collectResult combine the status/conclusion of one run with artifacts
    // fetched from another run's URL.
    if (!data || typeof data !== 'object' || Array.isArray(data) || String(data.id ?? '') !== String(providerRunId)) {
      throw new Error(`GitHub Actions status response identity mismatch: requested=${providerRunId} received=${String(data?.id ?? '')}`);
    }
    if (!WORKFLOW_RUN_STATUSES.has(String(data.status || ''))) {
      throw new Error(`GitHub Actions status response has an unsupported state for run ${providerRunId}: ${String(data.status ?? '')}`);
    }
    if (data.status === 'completed' && typeof data.conclusion !== 'string') {
      throw new Error(`GitHub Actions completed run ${providerRunId} has no explicit conclusion`);
    }
    if (data.status === 'completed' && !WORKFLOW_RUN_CONCLUSIONS.has(data.conclusion)) {
      throw new Error(`GitHub Actions completed run ${providerRunId} has an unsupported conclusion: ${String(data.conclusion)}`);
    }
    if (data.status !== 'completed' && data.conclusion != null) {
      throw new Error(`GitHub Actions run ${providerRunId} has a conclusion before completion`);
    }
    if (this.workflow.includes('p3-worker')) {
      const validated = this._validateP3RunMetadata(data, providerRunId, dispatchIntent);
      if (!Number.isSafeInteger(Number(persistedBeforeStatus.run_attempt)) ||
          Number(persistedBeforeStatus.run_attempt) !== Number(validated.run_attempt)) {
        throw new Error(`GitHub Actions run ${providerRunId} run_attempt changed or lacks a durable initial binding`);
      }
    }
    const state = data.status === 'completed' ? 'COMPLETED' : 'RUNNING';
    const normalized = {
      provider_run_id: String(data.id), state,
      conclusion: data.conclusion || null,
      status: data.status,
      html_url: data.html_url || null,
      head_sha: data.head_sha || null,
      run_attempt: data.run_attempt || 1,
      created_at: data.created_at || null,
      started_at: data.run_started_at || null,
      updated_at: data.updated_at || null
    };
    const persisted = persistedBeforeStatus;
    this._persist({ ...(persisted || {}), provider_run_id: String(data.id), job_id: persisted?.job_id || '', task_id: persisted?.task_id || '', lease_id: persisted?.lease_id || '', attempt: persisted?.attempt || Number(data.run_attempt || 1), input_commit: persisted?.input_commit || data.head_sha || '', workflow: persisted?.workflow || this.workflow, ref: persisted?.ref || this.ref, state, conclusion: normalized.conclusion, html_url: normalized.html_url, created_at: persisted?.created_at || data.created_at, run_attempt: Number(data.run_attempt || 1) });
    // A concurrent poll can persist a terminal result while this older request
    // is still in flight. The durable ledger is monotonic: never return a stale
    // RUNNING state or a contradictory terminal conclusion after that transition.
    const persistedAfterStatus = this._getPersisted(providerRunId);
    if (persistedAfterStatus?.state === 'COMPLETED' &&
        (normalized.state !== 'COMPLETED' || String(persistedAfterStatus.conclusion ?? '') !== String(normalized.conclusion ?? ''))) {
      throw new Error(`GitHub Actions status response contradicts the durable terminal run state/conclusion for ${providerRunId}`);
    }
    return normalized;
  }

  async _downloadArtifact(artifact, { dispatchIntent = null } = {}) {
    if (this.artifactDownloader) {
      this._assertAuthenticatedRequestDestination(dispatchIntent);
      return this.artifactDownloader(artifact, this.headers());
    }
    const apiBase = new URL(this.apiBase);
    const downloadUrl = new URL(String(artifact?.archive_download_url || ''));
    const artifactId = String(artifact?.id ?? '');
    const expectedPath = `${apiBase.pathname.replace(/\/$/, '')}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/artifacts/${encodeURIComponent(artifactId)}/zip`;
    // archive_download_url is API response data, not an authority to disclose
    // the bearer token to an arbitrary host. Only fetch the exact repository
    // artifact endpoint; GitHub's own redirect to a signed blob URL is handled
    // by fetch after this authenticated request.
    if (apiBase.protocol !== 'https:' || downloadUrl.protocol !== 'https:' ||
        downloadUrl.origin !== apiBase.origin || downloadUrl.username || downloadUrl.password ||
        downloadUrl.search || downloadUrl.hash || !/^\d+$/.test(artifactId) ||
        downloadUrl.pathname !== expectedPath) {
      throw new Error('provider artifact download URL is not the exact HTTPS artifact endpoint for this repository and artifact ID');
    }
    // This endpoint returns a ZIP rather than the JSON consumed by request().
    // It still carries the same bearer token and therefore must be rebound to
    // the exact durable API origin immediately before the network boundary.
    this._assertAuthenticatedRequestDestination(dispatchIntent);
    const { response, responseBytes: buffer } = await fetchBoundedResponse(this.fetch, artifact.archive_download_url,
      { method: 'GET', headers: this.headers() }, { maxBytes: MAX_ARTIFACT_ARCHIVE_BYTES, label: 'GitHub artifact archive', timeoutMs: this.requestTimeoutMs });
    if (!response.ok) throw new Error(`GitHub artifact download failed: ${response.status}`);
    const entries = validateZipEntryTypes(buffer);
    if (!entries.size) throw new Error('provider artifact ZIP has no entries');
    // Verify every entry, including unrelated members, using the exact bytes
    // from the response buffer. This checks decompression bounds and CRCs
    // without invoking unzip or reopening a path that another process could
    // replace between validation and evidence reading.
    const contents = new Map();
    for (const [name, entry] of entries) contents.set(name, readValidatedZipEntry(buffer, entry));
    const fileNames = [...entries.keys()].filter(name => !name.endsWith('/'));
    const p3 = /^p3-worker-/.test(String(artifact.name || ''));
    const wanted = p3 ? '.p3-worker/result.json'
      : /^p2-provider-/.test(String(artifact.name || '')) ? '.p2-provider/result.json'
        : /^p1-smoke-/.test(String(artifact.name || '')) ? '.p1-smoke/result.json' : 'result.json';
    if (!fileNames.includes(wanted)) throw new Error(`provider artifact does not contain its required result envelope: ${wanted}`);
    const rawResultBytes = contents.get(wanted);
    const rawResultText = new TextDecoder('utf-8', { fatal: true }).decode(rawResultBytes);
    const result = parseStrictJson(rawResultText, 'provider artifact result envelope');
    const evidence = {};
    const evidence_bytes = { 'result.json': Buffer.from(rawResultBytes) };
    const prefix = path.posix.dirname(wanted) === '.' ? '' : `${path.posix.dirname(wanted)}/`;
    for (const entryName of fileNames) {
      if (entryName === wanted || !entryName.startsWith(prefix)) continue;
      const relative = entryName.slice(prefix.length);
      if (!relative || relative.includes('/')) continue;
      if (Object.prototype.hasOwnProperty.call(evidence_bytes, relative)) {
        throw new Error(`provider artifact has ambiguous duplicate evidence basename: ${relative}`);
      }
      const rawBytes = contents.get(entryName);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
      evidence_bytes[relative] = Buffer.from(rawBytes);
      evidence[relative] = relative.endsWith('.json') ? parseStrictJson(text, `provider artifact evidence ${relative}`) : text;
    }
    return { result, evidence, evidence_bytes };
  }

  async collectResult(providerRunId) {
    const requiresP3Evidence = this.workflow.includes('p3-worker');
    const persisted = this._getPersisted(providerRunId);
    let dispatchIntent = null;
    if (requiresP3Evidence && !persisted) {
      throw new Error(`P3 result collection requires a durable dispatch/run ledger record for ${providerRunId}`);
    }
    let expectedOwnerEpoch = null;
    if (requiresP3Evidence) {
      dispatchIntent = this._getDispatchIntent(providerRunId);
      if (!dispatchIntent || !dispatchIntent.request_json) throw new Error('P3 result collection requires immutable request bytes for owner-epoch verification');
      const durableRequest = parseStrictJson(dispatchIntent.request_json, 'durable P3 execution request');
      if (!Number.isSafeInteger(Number(durableRequest.owner_epoch)) || Number(durableRequest.owner_epoch) < 1 ||
          Number(dispatchIntent.owner_epoch) !== Number(durableRequest.owner_epoch) || Number(persisted.owner_epoch) !== Number(durableRequest.owner_epoch)) {
        throw new Error('P3 owner epoch does not reconcile across dispatch request, intent, and provider-run ledger');
      }
      expectedOwnerEpoch = Number(durableRequest.owner_epoch);
    }
    const status = await this.getStatus(providerRunId);
    if (status.state !== 'COMPLETED') throw new Error(`provider run ${providerRunId} is not completed: ${status.status}`);
    const artifacts = await this.requestAllPages(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/runs/${encodeURIComponent(providerRunId)}/artifacts?per_page=100`, 'artifacts', {
      dispatchIntent
    });
    if (!artifacts || typeof artifacts !== 'object' || !Array.isArray(artifacts.artifacts)) {
      throw new Error(`provider run ${providerRunId} returned a malformed artifact listing`);
    }
    const candidates = artifacts.artifacts.filter(item => item && item.expired === false && /^\d+$/.test(String(item.id ?? '')) && typeof item.name === 'string');
    const preferredName = requiresP3Evidence ? `p3-worker-${providerRunId}` : null;
    const matches = requiresP3Evidence
      ? candidates.filter(item => item.name === preferredName)
      : candidates.filter(item => /^p2-provider-/.test(item.name));
    if (matches.length > 1) throw new Error(`provider run ${providerRunId} has ambiguous matching result artifacts`);
    const preferred = matches[0] || null;
    // Never fall back from a P3 worker to an arbitrary result artifact: it may
    // have no task-payload/execution bytes to bind correlation and real output.
    // Legacy P2 smoke results require explicit compatibility opt-in and remain
    // marked unverified; they cannot silently satisfy the strict P3 gate.
    const artifact = preferred || (!requiresP3Evidence && this.allowUnverifiedLegacyResults
      ? candidates.find(item => /result/.test(item.name))
      : null);
    if (!artifact) throw new Error(`provider run ${providerRunId} has no result artifact`);
    if (requiresP3Evidence && !/^p3-worker-/.test(artifact.name)) {
      throw new Error(`provider run ${providerRunId} artifact name does not identify a P3 evidence bundle`);
    }
    if (!requiresP3Evidence && !this.allowUnverifiedLegacyResults) {
      throw new Error('legacy P2 provider results lack execution-evidence verification and are disabled by default');
    }
    const downloaded = await this._downloadArtifact(artifact, { dispatchIntent });
    const bundle = downloaded?.result ? downloaded : { result: downloaded, evidence: {} };
    const raw = bundle.result;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('provider artifact result envelope must be a JSON object');
    if (requiresP3Evidence) {
      for (const field of ['job_id', 'task_id', 'lease_id', 'attempt', 'input_commit', 'provider_run_id', 'provider_run_attempt', 'evidence_artifact']) {
        if (raw[field] === undefined || raw[field] === null || raw[field] === '') {
          throw new Error(`P3 result envelope is missing required identity: ${field}`);
        }
      }
      if (String(raw.provider_run_id) !== String(providerRunId)) throw new Error('P3 result provider_run_id does not match the collected GitHub run');
      if (!Number.isSafeInteger(raw.provider_run_attempt) || raw.provider_run_attempt < 1 ||
          raw.provider_run_attempt !== Number(persisted?.run_attempt)) {
        throw new Error('P3 result provider_run_attempt does not match the durably bound GitHub run attempt');
      }
      if (raw.evidence_artifact !== artifact.name) throw new Error('P3 result evidence_artifact does not match the selected immutable artifact name');
      for (const [field, expected] of Object.entries({
        job_id: persisted?.job_id, task_id: persisted?.task_id, lease_id: persisted?.lease_id,
        attempt: persisted?.attempt, input_commit: persisted?.input_commit
      })) {
        if (expected != null && String(raw[field]) !== String(expected)) {
          throw new Error(`P3 result ${field} conflicts with the durable provider-run dispatch record`);
        }
      }
    } else if (!this.allowUnverifiedLegacyResults) {
      throw new Error('legacy P2 provider results lack execution-evidence verification and are disabled by default');
    }
    const result = {
      ...raw,
      provider_run_id: String(raw.provider_run_id ?? providerRunId),
      job_id: raw.job_id || persisted?.job_id,
      task_id: raw.task_id || persisted?.task_id,
      lease_id: raw.lease_id || persisted?.lease_id,
      attempt: raw.attempt || persisted?.attempt,
      ...(requiresP3Evidence ? { owner_epoch: raw.owner_epoch } : {}),
      input_commit: raw.input_commit || persisted?.input_commit,
      evidence_artifact: raw.evidence_artifact || artifact.name,
      evidence_refs: Array.isArray(raw.evidence_refs) ? raw.evidence_refs : [artifact.archive_download_url]
    };
    if (requiresP3Evidence && Number(result.owner_epoch) !== expectedOwnerEpoch) {
      throw new Error('P3 result owner_epoch does not match the exact durable dispatch lease owner');
    }
    if (requiresP3Evidence) {
      const durableRequest = parseStrictJson(this._getDispatchIntent(providerRunId).request_json, 'durable P3 execution request');
      const rawTaskPayload = bundle.evidence_bytes?.['task-payload.json'];
      if (!(Buffer.isBuffer(rawTaskPayload) || rawTaskPayload instanceof Uint8Array)) {
        throw new Error('P3 task-payload.json raw evidence bytes are required');
      }
      const taskPayload = parseStrictJson(rawTaskPayload, 'raw P3 task-payload.json evidence');
      if (!Array.isArray(taskPayload?.required_evidence) ||
          taskPayload.required_evidence.length !== durableRequest.required_evidence.length ||
          taskPayload.required_evidence.some((reference, index) => reference !== durableRequest.required_evidence[index])) {
        throw new Error('P3 task payload required_evidence does not match the immutable durable execution request');
      }
      if (durableRequest.task_payload_inline != null) {
        const expectedTaskPayload = {
          ...durableRequest.task_payload_inline,
          lease_id: durableRequest.lease_id,
          attempt: durableRequest.attempt,
          owner_epoch: durableRequest.owner_epoch
        };
        if (!isDeepStrictEqual(taskPayload, expectedTaskPayload)) {
          throw new Error('task payload evidence does not exactly match the immutable inline execution request');
        }
      } else if (typeof durableRequest.task_payload_ref === 'string') {
        const uriShapedRef = /^[a-z][a-z0-9+.-]*:\/\//i.test(durableRequest.task_payload_ref);
        if (uriShapedRef && this.taskPayloadSourceReader === readTaskPayloadAtCommit) {
          throw new Error('P3 task_payload_ref must be a safe workspace-relative path for immutable source attestation');
        }
        if (!uriShapedRef && !workspaceRelativeTaskPayloadRef(durableRequest.task_payload_ref)) {
          throw new Error('immutable task payload source ref is not a safe workspace-relative path');
        }
        const sourceBytes = await this.taskPayloadSourceReader({
          inputCommit: persisted?.input_commit,
          ref: durableRequest.task_payload_ref
        });
        if (!(Buffer.isBuffer(sourceBytes) || sourceBytes instanceof Uint8Array) || sourceBytes.byteLength > MAX_TASK_PAYLOAD_SOURCE_BYTES) {
          throw new Error('immutable task payload source reader returned invalid or oversized bytes');
        }
        const sourcePayload = parseStrictJson(Buffer.from(sourceBytes), 'task payload at immutable input commit');
        if (!sourcePayload || typeof sourcePayload !== 'object' || Array.isArray(sourcePayload)) {
          throw new Error('task payload at immutable input commit must be a JSON object');
        }
        const expectedTaskPayload = {
          ...sourcePayload,
          lease_id: durableRequest.lease_id,
          attempt: durableRequest.attempt,
          owner_epoch: durableRequest.owner_epoch
        };
        if (!isDeepStrictEqual(taskPayload, expectedTaskPayload)) {
          throw new Error('task payload evidence does not match the payload at immutable input commit');
        }
      }
    }
    if (!result.checkpoint_commit && bundle.evidence?.['checkpoint.json']?.checkpoint_commit) {
      result.checkpoint_commit = bundle.evidence['checkpoint.json'].checkpoint_commit;
      result.checkpoint_ref = bundle.evidence['checkpoint.json'].checkpoint_ref || null;
    }
    validateExecutionResult(result);
    const verification = requiresP3Evidence
      ? verifyExecutionEvidence({ result, evidence: bundle.evidence, evidenceBytes: bundle.evidence_bytes,
        requireRawEvidenceBytes: true, trustedInputCommit: persisted?.input_commit })
      : { valid: true, errors: [], evidence_hash: null, skipped: true };
    if (!verification.valid) throw new Error(`provider evidence rejected: ${verification.errors.join('; ')}`);
    const runConclusion = String(status.conclusion || '').toLowerCase();
    if ((result.status === 'SUCCEEDED' && runConclusion !== 'success') ||
        (runConclusion === 'success' && result.status !== 'SUCCEEDED')) {
      throw new Error(`provider run conclusion ${runConclusion || 'unknown'} contradicts result status ${result.status}`);
    }
    // P3 currently has no independent output-commit attestation. Keep the
    // worker-reported SHA on the returned result with explicit provenance, but
    // do not store it in provider_runs.output_commit as trusted provider state.
    const persistedOutputCommit = requiresP3Evidence ? null : (result.output_commit || null);
    const terminalRunUpdate = { ...(persisted || {}), provider_run_id: String(providerRunId), job_id: result.job_id,
      task_id: result.task_id, lease_id: result.lease_id, attempt: result.attempt, input_commit: result.input_commit,
      workflow: persisted?.workflow || this.workflow, ref: persisted?.ref || this.ref, state: 'COMPLETED',
      conclusion: status.conclusion, html_url: status.html_url, artifact_id: String(artifact.id),
      output_commit: persistedOutputCommit, created_at: persisted?.created_at || status.created_at };
    if (requiresP3Evidence && this.store?.db && typeof this.store.getTaskLease === 'function' &&
        typeof this.store.getTask === 'function' && typeof this.store.getJob === 'function') {
      // Hold the writer reservation across the final active-lease/parent/task
      // check and provider-run artifact/output persistence. Without this outer
      // fence, a long artifact download could outlive the lease, then publish
      // stale output metadata after another process had already terminalized or
      // reassigned the task. _persist composes as a nested savepoint.
      this.store.db.exec('SAVEPOINT p3_result_collection_terminal_fence');
      try {
        this._assertP3ResultCollectionLease(providerRunId, result, expectedOwnerEpoch);
        this._persist(terminalRunUpdate);
        const readback = this._getPersisted(providerRunId);
        if (!readback || readback.state !== 'COMPLETED' || readback.conclusion !== status.conclusion ||
            String(readback.artifact_id || '') !== String(artifact.id) ||
            String(readback.output_commit || '') !== String(persistedOutputCommit || '') ||
            readback.owner_epoch !== expectedOwnerEpoch || readback.run_attempt !== result.provider_run_attempt) {
          throw new Error(`P3 result collection terminal readback failed exact artifact/trusted-output/attempt binding for ${providerRunId}`);
        }
        this.store.db.exec('RELEASE SAVEPOINT p3_result_collection_terminal_fence');
      } catch (error) {
        try { this.store.db.exec('ROLLBACK TO SAVEPOINT p3_result_collection_terminal_fence'); } catch {}
        try { this.store.db.exec('RELEASE SAVEPOINT p3_result_collection_terminal_fence'); } catch {}
        throw error;
      }
    } else {
      this._persist(terminalRunUpdate);
    }
    return { ...result, evidence_verification: verification };
  }

  async cancel(providerRunId) {
    required(providerRunId, 'providerRunId');
    const requiresP3Evidence = this.workflow.includes('p3-worker');
    const persisted = requiresP3Evidence ? this._getPersisted(providerRunId) : null;
    const dispatchIntent = requiresP3Evidence ? this._getDispatchIntent(providerRunId) : null;
    if (requiresP3Evidence) {
      if (!persisted || !dispatchIntent || !['DISPATCHED', 'COMPLETED'].includes(String(dispatchIntent.state || '')) ||
          String(dispatchIntent.provider_run_id || '') !== String(providerRunId) ||
          persisted.provider !== 'github-actions' || persisted.workflow !== this.workflow || persisted.ref !== this.ref ||
          String(persisted.dispatch_key || '') !== String(dispatchIntent.dispatch_key || '') ||
          String(persisted.request_sha256 || '') !== String(dispatchIntent.request_sha256 || '') ||
          Number(persisted.owner_epoch) !== Number(dispatchIntent.owner_epoch) ||
          persisted.job_id !== dispatchIntent.job_id || persisted.task_id !== dispatchIntent.task_id ||
          persisted.lease_id !== dispatchIntent.lease_id || Number(persisted.attempt) !== Number(dispatchIntent.attempt)) {
        throw new Error(`P3 cancellation requires matching durable provider-run and dispatch-intent lineage for ${providerRunId}`);
      }
    }
    await this.request('POST', `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/actions/runs/${encodeURIComponent(providerRunId)}/cancel`, undefined, {
      dispatchIntent
    });
    const status = await this.getStatus(providerRunId);
    // GitHub workflow cancellation is not proof that a native OpenClaw node has
    // been fenced or destroyed. Keep that distinction explicit for callers.
    return {
      ...status,
      cancellation_requested: true,
      fencing_confirmed: false,
      teardown_confirmed: false
    };
  }

  async wait(providerRunId, { intervalMs = 2000, timeoutMs = 300000 } = {}) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const status = await this.getStatus(providerRunId);
      if (status.state === 'COMPLETED') return status;
      await sleep(intervalMs);
    }
    throw new Error(`provider run ${providerRunId} status polling timed out`);
  }
}
