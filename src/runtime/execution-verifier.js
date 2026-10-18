import crypto from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { validateExecutionResult } from './execution-contract.js';
import { MAX_STRICT_JSON_BYTES, parseStrictJson } from './strict-json.js';

// Provider evidence is bounded independently of each JSON document. The local
// execution manager caps stdout/stderr at 4 MiB per stream; this aggregate cap
// leaves room for result/payload/status files without allowing a provider to
// force unbounded copies and UTF-8 decoding in one verification call.
export const MAX_RAW_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_RAW_EVIDENCE_FILES = 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`evidence verification failed: ${field} is empty`);
}

function canonicalStringByteLength(value, field) {
  // Compute JSON.stringify's UTF-8 size without first allocating the escaped
  // representation (a long string of control characters can expand 6x).
  let bytes = 2; // surrounding quotes
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; }
      else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else bytes += 3;
    if (bytes > MAX_STRICT_JSON_BYTES) {
      throw new TypeError(`${field} exceeds the ${MAX_STRICT_JSON_BYTES}-byte canonical JSON limit`);
    }
  }
  return bytes;
}

function canonicalJson(value, field = 'evidence', budget = { nodes: 0, bytes: 0, stack: new Set() }, depth = 0) {
  if (++budget.nodes > 1_000_000) throw new TypeError(`${field} exceeds the JSON node limit`);
  if (depth > 256) throw new TypeError(`${field} exceeds the maximum JSON nesting depth`);
  const encode = text => {
    // Bound the canonical representation before assembling large parent strings.
    if (text.length > MAX_STRICT_JSON_BYTES) {
      throw new TypeError(`${field} exceeds the ${MAX_STRICT_JSON_BYTES}-byte canonical JSON limit`);
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (budget.bytes + bytes > MAX_STRICT_JSON_BYTES) {
      throw new TypeError(`${field} exceeds the ${MAX_STRICT_JSON_BYTES}-byte canonical JSON limit`);
    }
    budget.bytes += bytes;
    return text;
  };
  if (value === null || typeof value === 'boolean') return encode(JSON.stringify(value));
  if (typeof value === 'string') {
    const bytes = canonicalStringByteLength(value, field);
    if (budget.bytes + bytes > MAX_STRICT_JSON_BYTES) {
      throw new TypeError(`${field} exceeds the ${MAX_STRICT_JSON_BYTES}-byte canonical JSON limit`);
    }
    return encode(JSON.stringify(value));
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError(`${field} contains a non-canonical number`);
    }
    return encode(JSON.stringify(value));
  }
  // Proxies can run arbitrary traps during getPrototypeOf/ownKeys/descriptor
  // inspection. Reject them before any reflective operation can invoke a trap.
  if (value && typeof value === 'object' && utilTypes.isProxy(value)) {
    throw new TypeError(`${field} contains a Proxy object`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${field} contains an array with a non-canonical prototype`);
    if (budget.stack.has(value)) throw new TypeError(`${field} contains a cyclic reference`);
    if (value.length > 1_000_000 - budget.nodes) throw new TypeError(`${field} exceeds the JSON node limit`);
    const keys = Reflect.ownKeys(value);
    const extras = keys.filter(key => key !== 'length' &&
      !(typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length && String(Number(key)) === key));
    if (extras.length) throw new TypeError(`${field} contains unsupported array properties`);
    budget.stack.add(value);
    try {
      encode('[');
      const parts = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new TypeError(`${field} contains a sparse or non-data array entry at index ${index}`);
        }
        if (index) encode(',');
        parts.push(canonicalJson(descriptor.value, `${field}[${index}]`, budget, depth + 1));
      }
      encode(']');
      return `[${parts.join(',')}]`;
    } finally {
      budget.stack.delete(value);
    }
  }
  if (value && typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    if (budget.stack.has(value)) throw new TypeError(`${field} contains a cyclic reference`);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw new TypeError(`${field} contains symbol-keyed properties`);
    if (keys.length > 1_000_000 - budget.nodes) throw new TypeError(`${field} exceeds the JSON node limit`);
    let keyBytes = 0;
    for (const key of keys) {
      keyBytes += canonicalStringByteLength(key, `${field} property name`);
      if (budget.bytes + keyBytes > MAX_STRICT_JSON_BYTES) {
        throw new TypeError(`${field} exceeds the ${MAX_STRICT_JSON_BYTES}-byte canonical JSON limit`);
      }
    }
    budget.stack.add(value);
    try {
      encode('{');
      const members = [];
      const orderedKeys = keys.sort();
      for (let index = 0; index < orderedKeys.length; index++) {
        const key = orderedKeys[index];
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new TypeError(`${field}.${key} is not an enumerable data property`);
        }
        if (index) encode(',');
        const encodedKey = encode(JSON.stringify(key));
        encode(':');
        members.push(`${encodedKey}:${canonicalJson(descriptor.value, `${field}.${key}`, budget, depth + 1)}`);
      }
      encode('}');
      return `{${members.join(',')}}`;
    } finally {
      budget.stack.delete(value);
    }
  }
  throw new TypeError(`${field} contains a value that is not JSON-safe`);
}

function safeEvidenceRef(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.startsWith('-') &&
    // Evidence refs are portable archive-relative names, not host paths.
    // Reject drive-absolute and drive-relative paths even when verification
    // runs on POSIX; a later Windows extractor must not reinterpret them as
    // paths outside the evidence root.
    !/^[a-zA-Z]:/.test(value) &&
    !value.includes('\\') && !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..');
}

export function verifyExecutionEvidence({ result, evidence = {}, evidenceBytes = null, requireRawEvidenceBytes = false, trustedInputCommit = null } = {}) {
  // Freeze the interpretation of in-memory callers just as strictly as raw
  // provider JSON. Canonicalization inspects descriptors before values so an
  // accessor cannot run and sparse/undefined arrays cannot alias valid JSON.
  result = parseStrictJson(canonicalJson(result, 'execution result'), 'execution result');
  evidence = parseStrictJson(canonicalJson(evidence, 'execution evidence'), 'execution evidence');
  validateExecutionResult(result);
  const errors = [];
  let consumedEvidence = evidence;

  for (const field of ['job_id', 'task_id', 'lease_id', 'provider_run_id']) {
    try { nonEmpty(result[field], field); } catch (error) { errors.push(error.message); }
  }

  const refs = new Set(result.evidence_refs || []);
  if (refs.size !== (result.evidence_refs || []).length) errors.push('duplicate evidence_refs are not permitted');
  for (const ref of refs) if (!safeEvidenceRef(ref)) errors.push(`unsafe evidence ref: ${String(ref)}`);

  let exactEvidenceHash = null;
  let rawSnapshots = null;
  let outputCommitProvenance = null;
  if (requireRawEvidenceBytes) {
    if (!evidenceBytes || typeof evidenceBytes !== 'object' || Array.isArray(evidenceBytes)) {
      errors.push('raw evidence bytes are required for provider execution verification');
    } else {
      if (utilTypes.isProxy(evidenceBytes)) {
        throw new TypeError('raw evidence bytes cannot be a Proxy object');
      }
      if (Object.getPrototypeOf(evidenceBytes) !== Object.prototype && Object.getPrototypeOf(evidenceBytes) !== null) {
        throw new TypeError('raw evidence bytes must be a plain data object');
      }
      const evidenceKeys = Reflect.ownKeys(evidenceBytes);
      if (evidenceKeys.length > MAX_RAW_EVIDENCE_FILES) {
        throw new TypeError(`raw evidence exceeds the ${MAX_RAW_EVIDENCE_FILES}-file limit`);
      }
      let totalRawBytes = 0;
      // Validate all descriptors, byte container types, and aggregate sizes
      // before copying buffers, decoding text, or hashing any content.
      for (const key of evidenceKeys) {
        if (typeof key !== 'string') throw new TypeError('raw evidence bytes cannot contain symbol-keyed properties');
        const descriptor = Object.getOwnPropertyDescriptor(evidenceBytes, key);
        if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new TypeError(`raw evidence bytes ${key} is not an enumerable data property`);
        }
        const value = descriptor.value;
        if (utilTypes.isProxy(value)) throw new TypeError(`raw evidence bytes ${key} cannot be a Proxy object`);
        if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
          throw new TypeError(`raw evidence bytes are not a byte buffer: ${key}`);
        }
        totalRawBytes += value.byteLength;
        if (totalRawBytes > MAX_RAW_EVIDENCE_BYTES) {
          throw new TypeError(`raw evidence exceeds the ${MAX_RAW_EVIDENCE_BYTES}-byte aggregate limit`);
        }
      }
      const rawEntries = Object.keys(evidenceBytes).sort();
      if (!Object.prototype.hasOwnProperty.call(evidenceBytes, 'result.json')) {
        errors.push('raw result.json bytes are required to bind the decoded result envelope');
      }
      const decoded = Object.create(null);
      // Verify every downstream invariant against the same immutable snapshot
      // that was hashed and decoded. Uint8Array views may be backed by shared
      // memory, so rereading evidenceBytes later can observe different bytes.
      rawSnapshots = Object.create(null);
      const digest = crypto.createHash('sha256');
      for (const name of rawEntries) {
        if (!safeEvidenceRef(name)) {
          errors.push(`unsafe raw evidence path: ${String(name)}`);
          continue;
        }
        const value = evidenceBytes[name];
        if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
          errors.push(`raw evidence bytes are not a byte buffer: ${name}`);
          continue;
        }
        const bytes = Buffer.from(value);
        rawSnapshots[name] = bytes;
        digest.update(Buffer.from(name, 'utf8')).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0');
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          decoded[name] = name.endsWith('.json') ? parseStrictJson(text, `raw evidence ${name}`) : text;
        } catch (error) {
          errors.push(`raw evidence cannot be decoded as its declared UTF-8/JSON content: ${name}: ${error.message}`);
        }
      }
      exactEvidenceHash = digest.digest('hex');
      consumedEvidence = decoded;
      if (Object.prototype.hasOwnProperty.call(decoded, 'result.json') &&
          canonicalJson(decoded['result.json']) !== canonicalJson(result)) {
        errors.push('raw result.json bytes decode to a different execution result envelope');
      }
      for (const ref of refs) {
        if (!Object.prototype.hasOwnProperty.call(evidenceBytes, ref)) errors.push(`raw evidence bytes missing for referenced file: ${ref}`);
      }
    }
  }

  for (const ref of refs) {
    if (!Object.prototype.hasOwnProperty.call(consumedEvidence || {}, ref)) errors.push(`missing evidence ref: ${ref}`);
  }

  const payload = consumedEvidence?.['task-payload.json'];
  if (!payload) errors.push('task payload evidence missing');
  else {
    const expected = { job_id: result.job_id, task_id: result.task_id, lease_id: result.lease_id, attempt: result.attempt,
      ...(result.owner_epoch !== undefined && result.owner_epoch !== null ? { owner_epoch: result.owner_epoch } : {}) };
    for (const [key, value] of Object.entries(expected)) {
      if (payload[key] !== value) errors.push(`payload correlation mismatch: ${key}`);
    }
    if (payload.schema_version !== 1) errors.push('unsupported task payload schema');
    // required_evidence is part of the execution request contract, not merely
    // descriptive payload metadata. Every requested evidence member (except
    // result.json, which is the envelope itself) must be both named by the
    // result and present in the exact bytes consumed by this verifier.
    if (!Array.isArray(payload.required_evidence) || payload.required_evidence.length === 0) {
      errors.push('task payload required_evidence must be a non-empty array');
    } else {
      const required = new Set();
      for (const ref of payload.required_evidence) {
        if (!safeEvidenceRef(ref)) {
          errors.push(`unsafe task payload required_evidence ref: ${String(ref)}`);
          continue;
        }
        if (required.has(ref)) errors.push(`duplicate task payload required_evidence ref: ${ref}`);
        required.add(ref);
        if (ref === 'result.json') continue;
        if (!refs.has(ref)) errors.push(`required evidence ref is absent from execution result evidence_refs: ${ref}`);
        if (!Object.prototype.hasOwnProperty.call(consumedEvidence || {}, ref)) {
          errors.push(`required evidence bytes are missing: ${ref}`);
        }
        if (requireRawEvidenceBytes && !Object.prototype.hasOwnProperty.call(evidenceBytes || {}, ref)) {
          errors.push(`required raw evidence bytes are missing: ${ref}`);
        }
      }
    }
  }

  const execution = consumedEvidence?.['execution.json'];
  if (!execution) errors.push('execution evidence missing');
  else {
    if (execution.exit_code !== result.exit_code) errors.push('execution exit_code mismatch');
    if (execution.timed_out !== (result.status === 'TIMED_OUT')) errors.push('execution timeout mismatch');
    if (execution.task_id !== result.task_id) errors.push('execution task_id mismatch');
    if (requireRawEvidenceBytes && result.status === 'SUCCEEDED') {
      if (typeof execution.output_commit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(execution.output_commit)) {
        errors.push('execution output_commit must be a Git commit SHA');
      } else if (execution.output_commit !== result.output_commit) {
        errors.push('execution output_commit mismatch');
      }
      // result.json and execution.json are emitted by the same worker process;
      // matching them proves consistency, not independent output-commit
      // provenance. The dispatch/run record independently anchors input_commit,
      // but output_commit is observed after the command and may legitimately
      // differ when an authorized task creates a commit. Do not incorrectly
      // equate the post-execution value to the dispatch input; surface the
      // remaining provenance limit to callers instead of mislabeling it verified.
      if (typeof trustedInputCommit !== 'string' || !/^[a-f0-9]{40,64}$/i.test(trustedInputCommit)) {
        errors.push('trusted input commit anchor is required for successful raw evidence');
      } else {
        if (String(result.input_commit).toLowerCase() !== trustedInputCommit.toLowerCase()) {
          errors.push('result input_commit does not match trusted input commit anchor');
        }
        outputCommitProvenance = 'worker_reported_and_execution_json_bound_not_independently_attested';
      }
    }
    if (requireRawEvidenceBytes) {
      // execution.json is produced beside the raw stdout/stderr artifacts. Its
      // digests and byte counts must bind those exact archive bytes; otherwise
      // a ZIP can contain a self-consistent result envelope but substituted
      // output that the worker never recorded in its execution metadata.
      for (const stream of ['stdout', 'stderr']) {
        const file = `${stream}.txt`;
        const bytes = rawSnapshots[file];
        const byteCount = execution[`${stream}_bytes`];
        const digest = execution[`${stream}_sha256`];
        if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
          errors.push(`execution raw ${file} bytes are required for stream integrity verification`);
          continue;
        }
        if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
          errors.push(`execution ${stream}_bytes must be a non-negative safe integer`);
        } else if (byteCount !== bytes.byteLength) {
          errors.push(`execution ${stream}_bytes mismatch`);
        }
        if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
          errors.push(`execution ${stream}_sha256 must be a lower-case SHA-256`);
        } else if (sha256(Buffer.from(bytes)) !== digest) errors.push(`execution ${stream}_sha256 mismatch`);
      }
      const gitStatusBytes = rawSnapshots['git-status.txt'];
      const gitStatusByteCount = execution.git_status_bytes;
      const gitStatusDigest = execution.git_status_sha256;
      if (!(Buffer.isBuffer(gitStatusBytes) || gitStatusBytes instanceof Uint8Array)) {
        errors.push('execution raw git-status.txt bytes are required for Git-state integrity verification');
      } else {
        if (!Number.isSafeInteger(gitStatusByteCount) || gitStatusByteCount < 0) {
          errors.push('execution git_status_bytes must be a non-negative safe integer');
        } else if (gitStatusByteCount !== gitStatusBytes.byteLength) {
          errors.push('execution git_status_bytes mismatch');
        }
        if (typeof gitStatusDigest !== 'string' || !/^[a-f0-9]{64}$/.test(gitStatusDigest)) {
          errors.push('execution git_status_sha256 must be a lower-case SHA-256');
        } else if (sha256(Buffer.from(gitStatusBytes)) !== gitStatusDigest) {
          errors.push('execution git-status_sha256 mismatch');
        }
      }
    }
  }

  if (result.status === 'SUCCEEDED') {
    if (result.exit_code !== 0 || !result.output_commit) errors.push('successful result lacks zero exit code/output commit');
    if (!String(consumedEvidence?.['stdout.txt'] ?? '').trim() && !String(consumedEvidence?.['stderr.txt'] ?? '').trim()) {
      errors.push('successful execution has no stdout or stderr evidence');
    }
    const status = String(consumedEvidence?.['git-status.txt'] ?? '');
    if (!Object.prototype.hasOwnProperty.call(consumedEvidence || {}, 'git-status.txt')) errors.push('git status evidence missing');
    if (status.includes('\0')) errors.push('git status evidence contains NUL');
  }

  if (result.status === 'TIMED_OUT' && result.checkpoint_commit) {
    if (!/^[0-9a-f]{7,64}$/i.test(result.checkpoint_commit)) errors.push('invalid checkpoint commit');
    const checkpoint = consumedEvidence?.['checkpoint.json'];
    if (!checkpoint) errors.push('checkpoint evidence missing');
    else if (checkpoint.checkpoint_commit !== result.checkpoint_commit) errors.push('checkpoint commit mismatch');
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors,
    evidence_hash: exactEvidenceHash || sha256(canonicalJson(Object.keys(consumedEvidence || {}).sort().reduce((out, key) => {
      out[key] = consumedEvidence[key];
      return out;
    }, Object.create(null)))),
    ...(outputCommitProvenance ? { output_commit_provenance: outputCommitProvenance } : {})
  });
}

export function assertExecutionEvidence(input) {
  const verification = verifyExecutionEvidence(input);
  if (!verification.valid) throw new Error(`execution evidence verification failed: ${verification.errors.join('; ')}`);
  return verification;
}
