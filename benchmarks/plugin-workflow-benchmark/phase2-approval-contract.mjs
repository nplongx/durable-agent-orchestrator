import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CASE06_ACTIONS = Object.freeze([
  'custom_role_create',
  'custom_workflow_create',
  'custom_workflow_preview',
  'custom_workflow_approve',
  'custom_workflow_run_create',
]);

const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

// JSON.parse silently collapses duplicate object member names (including
// escaped spellings of the same decoded name). That is unsafe for signed
// authorization/review evidence because two parsers can otherwise disagree
// about the bytes that were reviewed. This small recursive-descent parser
// delegates string escape validation to JSON.parse but rejects duplicate
// decoded keys before constructing each object.
export function parseStrictJson(input, label = 'JSON evidence') {
  let text;
  try {
    text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${error.message}`);
  }
  let index = 0;
  let nodes = 0;
  const fail = message => { throw new SyntaxError(`${label} is invalid at byte/character offset ${index}: ${message}`); };
  const whitespace = () => { while (index < text.length && (text[index] === ' ' || text[index] === '\t' || text[index] === '\r' || text[index] === '\n')) index++; };
  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail('expected a JSON string');
    index++;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index++;
        try { return JSON.parse(text.slice(start, index)); }
        catch { fail('invalid JSON string escape'); }
      }
      if (character.charCodeAt(0) < 0x20) fail('unescaped control character in string');
      if (character === '\\') {
        index++;
        if (index >= text.length) fail('truncated string escape');
        const escape = text[index];
        if (escape === 'u') {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid Unicode escape');
          index += 5;
          continue;
        }
        if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) fail('invalid string escape');
      }
      index++;
    }
    fail('unterminated JSON string');
  };
  const parseValue = depth => {
    whitespace();
    if (depth > 256) fail('maximum nesting depth exceeded');
    if (++nodes > 1_000_000) fail('maximum JSON node count exceeded');
    const character = text[index];
    if (character === '"') return parseString();
    if (character === '{') {
      index++;
      whitespace();
      const object = {};
      const keys = new Set();
      if (text[index] === '}') { index++; return object; }
      while (index < text.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) fail(`duplicate decoded object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[index] !== ':') fail('expected colon after object key');
        index++;
        const value = parseValue(depth + 1);
        Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
        whitespace();
        if (text[index] === '}') { index++; return object; }
        if (text[index] !== ',') fail('expected comma or closing brace');
        index++;
      }
      fail('unterminated JSON object');
    }
    if (character === '[') {
      index++;
      whitespace();
      const array = [];
      if (text[index] === ']') { index++; return array; }
      while (index < text.length) {
        array.push(parseValue(depth + 1));
        whitespace();
        if (text[index] === ']') { index++; return array; }
        if (text[index] !== ',') fail('expected comma or closing bracket');
        index++;
      }
      fail('unterminated JSON array');
    }
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, index)) { index += literal.length; return value; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (number) {
      index += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) fail('number is outside the supported finite range');
      return value;
    }
    fail('expected a JSON value');
  };
  const value = parseValue(0);
  whitespace();
  if (index !== text.length) fail('trailing content after the JSON value');
  return value;
}

const LEGACY_PHASE2_AUTHORIZATION_COMMON_KEYS = Object.freeze([
  'authorization_source', 'authorized_at', 'authorized_execution_spec_path', 'authorized_execution_spec_sha256',
  'case_id', 'condition_order', 'consumption_record_path', 'consumption_status', 'decision', 'decision_id',
  'frozen_bundle_sha256', 'model_id', 'output_path', 'permitted_side_effects', 'protocol', 'scope',
  'source_spec_path', 'source_spec_sha256', 'stop_conditions'
]);

export function validateLegacyPhase2AuthorizationRecord(record, {
  label = 'legacy Phase 2 authorization',
  optionalTopKeys = [],
  requireBubblewrapNetworkNamespace = false,
  expectedDecisionId
} = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.getPrototypeOf(record) !== Object.prototype) {
    throw new Error(`${label} must be a plain JSON object`);
  }
  const expectedTopKeys = [...LEGACY_PHASE2_AUTHORIZATION_COMMON_KEYS].sort();
  const allowedOptionalTopKeys = [...new Set(optionalTopKeys)];
  if (allowedOptionalTopKeys.some(key => !['consumed_run_id', 'result_path', 'result_status'].includes(key))) {
    throw new Error(`${label} validator configuration contains unsupported optional schema keys`);
  }
  const actualTopKeys = Object.keys(record).sort();
  if (actualTopKeys.some(key => !expectedTopKeys.includes(key) && !allowedOptionalTopKeys.includes(key)) ||
      expectedTopKeys.some(key => !actualTopKeys.includes(key)) ||
      allowedOptionalTopKeys.some(key => !actualTopKeys.includes(key))) {
    const unknown = actualTopKeys.filter(key => !expectedTopKeys.includes(key) && !allowedOptionalTopKeys.includes(key));
    const missing = expectedTopKeys.filter(key => !actualTopKeys.includes(key));
    throw new Error(`${label} has unknown or missing top-level keys (unknown=${unknown.join(',')}; missing=${missing.join(',')})`);
  }
  if (record.protocol !== 'cos-phase2-one-case-execution-authorization-v1' || record.case_id !== 'CASE-01' ||
      (expectedDecisionId !== undefined && record.decision_id !== expectedDecisionId)) {
    throw new Error(`${label} protocol, exact CASE-01 scope, or decision identity is invalid`);
  }
  for (const field of ['source_spec_sha256', 'authorized_execution_spec_sha256', 'frozen_bundle_sha256']) {
    if (typeof record[field] !== 'string' || !/^[a-f0-9]{64}$/.test(record[field])) {
      throw new Error(`${label} ${field} must be strict lower-case SHA-256`);
    }
  }
  if (!record.scope || typeof record.scope !== 'object' || Array.isArray(record.scope) || Object.getPrototypeOf(record.scope) !== Object.prototype) {
    throw new Error(`${label} scope must be a plain object`);
  }
  const expectedScopeKeys = [
    'bubblewrap_network_namespace_required',
    'automatic_retry', 'external_credentials', 'external_network', 'official_manifest_mutation', 'opshub',
    'other_cases', 'private_database_per_condition', 'private_workspace_per_condition', 'shared_runtime',
    'systemd_user_scope_required'
  ].sort();
  const actualScopeKeys = Object.keys(record.scope).sort();
  const permissibleScopeKeys = requireBubblewrapNetworkNamespace
    ? expectedScopeKeys
    : expectedScopeKeys.filter(key => key !== 'bubblewrap_network_namespace_required');
  if (actualScopeKeys.some(key => !expectedScopeKeys.includes(key)) ||
      (requireBubblewrapNetworkNamespace && !actualScopeKeys.includes('bubblewrap_network_namespace_required')) ||
      actualScopeKeys.filter(key => key !== 'bubblewrap_network_namespace_required').join(',') !== permissibleScopeKeys.filter(key => key !== 'bubblewrap_network_namespace_required').join(',')) {
    const unknown = actualScopeKeys.filter(key => !expectedScopeKeys.includes(key));
    const missing = expectedScopeKeys.filter(key => !actualScopeKeys.includes(key));
    throw new Error(`${label} scope has unknown or missing keys (unknown=${unknown.join(',')}; missing=${missing.join(',')})`);
  }
  const mustBeFalse = ['automatic_retry', 'external_credentials', 'external_network', 'official_manifest_mutation', 'opshub', 'other_cases', 'shared_runtime'];
  for (const key of mustBeFalse) {
    if (record.scope[key] !== false) throw new Error(`${label} prohibited scope ${key} must be explicitly false`);
  }
  for (const key of ['private_database_per_condition', 'private_workspace_per_condition', 'systemd_user_scope_required']) {
    if (record.scope[key] !== true) throw new Error(`${label} required isolation scope ${key} must be explicitly true`);
  }
  if (Object.hasOwn(record.scope, 'bubblewrap_network_namespace_required') && record.scope.bubblewrap_network_namespace_required !== true) {
    throw new Error(`${label} must require the bubblewrap network namespace`);
  }
  for (const field of ['condition_order', 'permitted_side_effects', 'stop_conditions']) {
    const value = record[field];
    if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
      throw new Error(`${label} ${field} must be a non-empty array of strings`);
    }
  }
  if (new Set(record.condition_order).size !== record.condition_order.length) {
    throw new Error(`${label} condition_order contains duplicate entries`);
  }
  if (typeof record.source_spec_path !== 'string' || !record.source_spec_path ||
      typeof record.authorized_execution_spec_path !== 'string' || !record.authorized_execution_spec_path ||
      typeof record.output_path !== 'string' || !record.output_path ||
      typeof record.consumption_record_path !== 'string' || !record.consumption_record_path) {
    throw new Error(`${label} source/spec/output/consumption paths are required`);
  }
  return record;
}

export function assertLegacyPhase2AuthorizationExecutionAllowed(label = 'legacy Phase 2 authorization') {
  // Historical one-shot records predate the production signed-authority
  // contract. They remain readable for audit/reconciliation, but their mutable
  // JSON path/scope fields are not a production execution grant. Only isolated
  // test fixtures may exercise the legacy consume implementation explicitly.
  if (process.env.NODE_ENV === 'test' && process.env.PHASE2_ALLOW_UNSIGNED_LEGACY_AUTHORIZATION_TEST_FIXTURES === '1') return true;
  throw new Error(`${label} is audit-only: unsigned legacy authorization cannot grant execution; a fresh exact-scope signed authorization and configured production trust anchor are required`);
}

// Read authority-controlled files only from a canonical repository-relative
// path. Hash the bytes read through one no-follow descriptor, and reject
// symlinked parents, non-regular files, or inode/metadata changes while reading.
// This narrows path substitution races but cannot make same-UID parent-directory
// replacement universally impossible on every filesystem/platform.
export function readVerifiedRepoFile(repoRoot, relativePath, label = 'repository file') {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
      relativePath.includes('\\') || relativePath.includes('\0')) {
    throw new Error(`${label} path must be a clean repository-relative path`);
  }
  const parts = relativePath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${label} path contains an unsafe segment`);
  const root = path.resolve(repoRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root) {
    throw new Error(`${label} repository root is not a canonical non-symlink directory`);
  }
  const resolved = path.resolve(root, ...parts);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path escapes repository root`);
  let cursor = root;
  for (const segment of parts.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(cursor) !== cursor) {
      throw new Error(`${label} path traverses a symlink or non-directory parent`);
    }
  }
  const before = fs.lstatSync(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${label} must be an existing regular non-symlink file`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(resolved, flags);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
        opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
      throw new Error(`${label} changed between path validation and descriptor open`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(resolved, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
        !pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino ||
        pathAfter.size !== opened.size || pathAfter.mtimeNs !== opened.mtimeNs || pathAfter.ctimeNs !== opened.ctimeNs ||
        fs.realpathSync(resolved) !== resolved) {
      throw new Error(`${label} changed while its verified bytes were being read`);
    }
    return { path: resolved, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally { fs.closeSync(fd); }
}

// Resolve a future or existing repository-relative authority destination while
// still checking every existing parent and the final directory entry. Unlike
// existsSync this observes dangling symlinks and rejects paths whose final
// component is not absent or a regular non-symlink file.
export function resolveVerifiedRepoPath(repoRoot, relativePath, label = 'repository path') {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
      relativePath.includes('\\') || relativePath.includes('\0')) {
    throw new Error(`${label} must be a clean repository-relative path`);
  }
  const parts = relativePath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`${label} contains an unsafe segment`);
  const root = path.resolve(repoRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error(`${label} repository root is not canonical`);
  const resolved = path.resolve(root, ...parts);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escapes repository root`);
  let cursor = root;
  for (const segment of parts.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(cursor) !== cursor) {
      throw new Error(`${label} traverses a missing, symlinked, or non-directory parent`);
    }
  }
  const leaf = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (leaf && (!leaf.isFile() || leaf.isSymbolicLink() || fs.realpathSync(resolved) !== resolved)) {
    throw new Error(`${label} leaf is a symlink or non-regular file`);
  }
  return { path: resolved, exists: Boolean(leaf), stat: leaf || null };
}

// Create a one-shot consumption record with exclusive semantics and explicitly
// flush the file and containing directory. This cannot make all filesystem and
// SQLite operations jointly atomic, but it ensures a successful return means
// the exact record bytes were fsynced without overwriting an existing token.
export function writeExclusiveVerifiedRepoFile(repoRoot, relativePath, contents, label = 'authority consumption record') {
  const target = resolveVerifiedRepoPath(repoRoot, relativePath, label);
  if (target.exists) throw new Error(`${label} already exists; exclusive one-shot consumption is not available`);
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(target.path, flags, 0o600);
  let opened;
  try {
    opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new Error(`${label} descriptor is not a regular file`);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(target.path, { bigint: true });
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino ||
        after.dev !== opened.dev || after.ino !== opened.ino || after.size !== BigInt(bytes.length) || pathAfter.size !== BigInt(bytes.length)) {
      throw new Error(`${label} changed inode or size during the exclusive durable write`);
    }
  } finally { fs.closeSync(fd); }
  const directoryFd = fs.openSync(path.dirname(target.path), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try { fs.fsyncSync(directoryFd); }
  finally { fs.closeSync(directoryFd); }
  const verified = readVerifiedRepoFile(repoRoot, relativePath, label);
  if (!verified.bytes.equals(bytes)) throw new Error(`${label} readback bytes differ from the exclusive durable write`);
  return verified;
}

// Signed decision timestamps use one unambiguous wire format. Date.parse alone
// accepts locale-dependent/date-only forms and normalizes impossible calendar
// values, which can make independently interpreted signed decisions disagree.
const validTimestamp = value => {
  if (!nonEmpty(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};
// Approval is a deployment gate, so an otherwise unexpired decision must also
// be recent enough to describe the current review context. Authorities can
// issue a fresh signed record; verifiers never silently extend this window.
export const MAX_AUTHORITY_DECISION_AGE_MS = 24 * 60 * 60 * 1000;
function validateDecisionFreshness(record, issuedField) {
  const errors = [];
  const issuedAt = Date.parse(record?.[issuedField] || '');
  const expiresAt = Date.parse(record?.expires_at || '');
  if (!validTimestamp(record?.[issuedField])) errors.push(`${issuedField} must be a canonical UTC ISO-8601 timestamp with millisecond precision`);
  else if (issuedAt > Date.now()) errors.push(`${issuedField} is in the future`);
  else if (Date.now() - issuedAt > MAX_AUTHORITY_DECISION_AGE_MS) errors.push(`signed decision ${issuedField} is stale (maximum age is 24 hours)`);
  if (!validTimestamp(record?.expires_at)) errors.push('signed decision expires_at must be a canonical UTC ISO-8601 timestamp with millisecond precision');
  else if (expiresAt <= Date.now()) errors.push('signed decision has expired');
  if (Number.isFinite(issuedAt) && Number.isFinite(expiresAt) && expiresAt <= issuedAt) errors.push('signed decision expires_at must be after its issue timestamp');
  return errors;
}
const canonicalize = value => Array.isArray(value) ? value.map(canonicalize) :
  (value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])])) : value);
const sameJson = (a, b) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
const hasOnlyKeys = (value, allowed) => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)));
const AUTHORIZATION_RECORD_KEYS = Object.freeze([
  'protocol', 'decision_id', 'decision', 'case_id', 'source_spec_sha256', 'authorized_execution_spec_sha256',
  'frozen_bundle_sha256', 'authorized_execution_spec_path', 'source_tree_identity', 'authority_id', 'authority_role',
  'authority_identity_verification_reference', 'authority_reference', 'decision_channel_reference', 'decided_at',
  'expires_at', 'stop_conditions', 'limits', 'consumption_status', 'output_path', 'scope', 'authority_attestation',
]);
const AUTHORITY_ATTESTATION_KEYS = Object.freeze(['algorithm', 'key_id', 'signature_base64']);
const AUTHORIZATION_LIMIT_KEYS = Object.freeze(['max_attempts', 'max_duration_seconds', 'max_memory_mb', 'max_cpu_percent']);
const SOURCE_TREE_IDENTITY_KEYS = Object.freeze(['git_head', 'packaged_source_inventory_sha256', 'working_tree_dirty']);
const CANDIDATE_REVIEW_KEYS = Object.freeze([
  'status', 'candidate_path', 'candidate_sha256', 'source_tree_identity', 'reviewer_id',
  'reviewer_identity_verification_reference', 'reviewer_role', 'authority_role',
  'reviewer_authority_verification_reference', 'independent_of_implementation', 'review_channel_reference',
  'reviewed_at', 'expires_at', 'findings', 'residual_risks_accepted', 'residual_risk_rationale', 'authority_attestation',
]);
const REVIEW_FINDING_KEYS = Object.freeze([
  'finding_id', 'title', 'severity', 'evidence', 'reproduction', 'recommendation', 'disposition',
]);
const CASE06_DISPOSITION_KEYS = Object.freeze([
  'decision', 'source_spec_path', 'source_spec_sha256', 'reviewer_id',
  'reviewer_identity_verification_reference', 'reviewer_role', 'authority_role', 'authority_reference',
  'reviewer_authority_verification_reference', 'review_channel_reference', 'decided_at', 'expires_at',
  'rationale', 'reviewed_actions', 'action_dispositions', 'conditions', 'residual_risks', 'authority_attestation',
]);
const CASE06_ACTION_DISPOSITION_KEYS = Object.freeze(['decision', 'rationale']);
export const canonicalRecordSha256 = record => crypto.createHash('sha256').update(JSON.stringify(canonicalize(record))).digest('hex');

// Identity/authority references are descriptive strings, not proof. A decision
// is accepted only when a configured out-of-band trust anchor verifies an
// Ed25519 signature over the complete record (excluding the signature envelope).
export function validateAuthorityAttestation(record, trustedAuthorityPublicKey, expectedRole) {
  const errors = [];
  const envelope = record?.authority_attestation;
  if (typeof trustedAuthorityPublicKey !== 'string' || !trustedAuthorityPublicKey.trim()) {
    errors.push('trusted authority public key is not configured by the verifier');
    return errors;
  }
  if (!envelope || envelope.algorithm !== 'Ed25519' || !nonEmpty(envelope.key_id) || !nonEmpty(envelope.signature_base64)) {
    errors.push('cryptographic authority attestation is missing or malformed');
    return errors;
  }
  if (!hasOnlyKeys(envelope, AUTHORITY_ATTESTATION_KEYS)) errors.push('authority attestation contains unknown keys');
  const roleFields = ['reviewer_role', 'authority_role'].filter(field => Object.hasOwn(record || {}, field));
  if (roleFields.length === 0 || roleFields.some(field => record[field] !== expectedRole)) {
    errors.push(`every declared signed authority role must be ${expectedRole}`);
  }
  try {
    const signedRecord = { ...record };
    delete signedRecord.authority_attestation;
    const signature = Buffer.from(envelope.signature_base64, 'base64');
    if (!/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature_base64) || signature.length !== 64 || signature.toString('base64') !== envelope.signature_base64) {
      errors.push('authority attestation signature encoding is not canonical Ed25519 base64');
      return errors;
    }
    const valid = crypto.verify(null, Buffer.from(JSON.stringify(canonicalize(signedRecord))), trustedAuthorityPublicKey, signature);
    if (!valid) errors.push('authority attestation signature does not verify against the configured trust anchor');
  } catch {
    errors.push('authority attestation could not be verified');
  }
  return errors;
}

export function validateCandidateReviewRecord({ record, candidatePath, candidateSha256, sourceTreeIdentity, trustedAuthorityPublicKey }) {
  const errors = [];
  if (!hasOnlyKeys(record, CANDIDATE_REVIEW_KEYS)) errors.push('candidate review record contains unknown keys or is not an object');
  if (!hasOnlyKeys(record?.source_tree_identity, SOURCE_TREE_IDENTITY_KEYS) || !hasOnlyKeys(sourceTreeIdentity, SOURCE_TREE_IDENTITY_KEYS)) errors.push('review source-tree identity contains unknown keys or is not an object');
  if (!record || record.status !== 'approved') errors.push('review status is not approved');
  if (record?.candidate_path !== candidatePath) errors.push('review candidate path is stale or mismatched');
  if (record?.candidate_sha256 !== candidateSha256) errors.push('review candidate SHA-256 is stale or mismatched');
  if (!sameJson(record?.source_tree_identity, sourceTreeIdentity)) errors.push('review source-tree identity does not match current inventory');
  if (!nonEmpty(record?.reviewer_id)) errors.push('reviewer identity is missing');
  if (!nonEmpty(record?.reviewer_identity_verification_reference)) errors.push('reviewer identity verification reference is missing');
  if (record?.reviewer_role !== 'independent-technical-reviewer') errors.push('reviewer role is not the required independent technical reviewer');
  errors.push(...validateAuthorityAttestation(record, trustedAuthorityPublicKey, 'independent-technical-reviewer'));
  if (!nonEmpty(record?.reviewer_authority_verification_reference)) errors.push('reviewer authority verification reference is missing');
  if (record?.independent_of_implementation !== true) errors.push('reviewer independence is not explicitly declared');
  if (!nonEmpty(record?.review_channel_reference)) errors.push('review channel/reference is missing');
  errors.push(...validateDecisionFreshness(record, 'reviewed_at'));
  if (!Array.isArray(record?.findings)) errors.push('findings must be an array');
  else if (record.findings.some(item => !hasOnlyKeys(item, REVIEW_FINDING_KEYS) || !nonEmpty(item.finding_id) || !nonEmpty(item.title) ||
    !['blocking', 'high', 'medium', 'low', 'info'].includes(item.severity) || !nonEmpty(item.evidence) ||
    !nonEmpty(item.reproduction) || !nonEmpty(item.recommendation) ||
    !['open', 'fixed-verified', 'accepted-residual-risk', 'not-reproducible'].includes(item.disposition))) {
    errors.push('finding schema requires ID, title, severity, evidence, reproduction, recommendation and disposition');
  }
  else if (record.findings.some(item => item.severity === 'blocking')) errors.push('blocking findings remain open');
  if (record?.residual_risks_accepted !== true || !nonEmpty(record?.residual_risk_rationale)) errors.push('residual risks are not explicitly accepted with rationale');
  return { valid: errors.length === 0, errors };
}

export function validateCase06Disposition({ record, expectedSpecPath, expectedSpecSha256, trustedAuthorityPublicKey }) {
  const errors = [];
  if (!hasOnlyKeys(record, CASE06_DISPOSITION_KEYS)) errors.push('CASE-06 disposition record contains unknown keys or is not an object');
  if (!record || record.decision !== 'accept') errors.push('CASE-06 decision is not accept');
  if (record?.source_spec_path !== expectedSpecPath) errors.push('CASE-06 source spec path is stale or mismatched');
  if (record?.source_spec_sha256 !== expectedSpecSha256) errors.push('CASE-06 source spec SHA-256 is stale or mismatched');
  if (!nonEmpty(record?.reviewer_id)) errors.push('policy reviewer identity is missing');
  if (!nonEmpty(record?.reviewer_identity_verification_reference)) errors.push('policy reviewer identity verification reference is missing');
  if (record?.reviewer_role !== 'policy-spec-authority') errors.push('reviewer is not identified as policy/spec authority');
  errors.push(...validateAuthorityAttestation(record, trustedAuthorityPublicKey, 'policy-spec-authority'));
  if (!nonEmpty(record?.authority_reference)) errors.push('policy authority reference is missing');
  if (!nonEmpty(record?.reviewer_authority_verification_reference)) errors.push('policy reviewer authority verification reference is missing');
  if (!nonEmpty(record?.review_channel_reference)) errors.push('policy decision channel/reference is missing');
  errors.push(...validateDecisionFreshness(record, 'decided_at'));
  if (!nonEmpty(record?.rationale)) errors.push('overall policy rationale is missing');
  if (!Array.isArray(record?.reviewed_actions) || record.reviewed_actions.length !== CASE06_ACTIONS.length || !CASE06_ACTIONS.every(action => record.reviewed_actions.includes(action))) errors.push('reviewed_actions must contain exactly the five CASE-06 actions');
  if (!record?.action_dispositions || !hasOnlyKeys(record.action_dispositions, CASE06_ACTIONS) || Object.keys(record.action_dispositions).length !== CASE06_ACTIONS.length ||
    CASE06_ACTIONS.some(action => !hasOnlyKeys(record.action_dispositions[action], CASE06_ACTION_DISPOSITION_KEYS) ||
      record.action_dispositions[action]?.decision !== 'accept' || !nonEmpty(record.action_dispositions[action]?.rationale))) errors.push('each CASE-06 action needs an explicit accept disposition and rationale, with no extra actions or unknown fields');
  if (!Array.isArray(record?.conditions) || record.conditions.some(condition => !nonEmpty(condition))) errors.push('conditions must be an array of explicit non-empty strings');
  if (!Array.isArray(record?.residual_risks) || record.residual_risks.some(risk => !nonEmpty(risk))) errors.push('residual_risks must be an explicit array');
  return { valid: errors.length === 0, errors };
}

export function validateFreshAuthorization({ spec, record, consumption, repoRoot, currentSpecSha256, currentAuthorizedSpecSha256, frozenSha256, expectedSourceTreeIdentity, priorDecisionIds = [], trustedAuthorityPublicKey }) {
  const errors = [];
  const validSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (spec?.status !== 'authorized-for-one-scenario') errors.push('execution spec is not an authorized single-scenario spec');
  if (!['open', 'authorized'].includes(spec?.execution_gate?.status)) errors.push('execution gate is not authorized/open');
  if (!Array.isArray(spec?.execution_gate?.authorized_case_ids) || spec.execution_gate.authorized_case_ids.length !== 1 || spec.execution_gate.authorized_case_ids[0] !== 'CASE-01') errors.push('authorized case scope is not exactly CASE-01');
  if (!record || record.protocol !== 'cos-phase2-one-case-execution-authorization-v1') errors.push('authorization record protocol is missing/invalid');
  if (!hasOnlyKeys(record, AUTHORIZATION_RECORD_KEYS)) errors.push('authorization record contains unknown keys or is not an object');
  if (record?.authority_attestation && !hasOnlyKeys(record.authority_attestation, AUTHORITY_ATTESTATION_KEYS)) errors.push('authority attestation contains unknown keys');
  if (record?.limits && !hasOnlyKeys(record.limits, AUTHORIZATION_LIMIT_KEYS)) errors.push('authorization limits contain unknown keys');
  if (!nonEmpty(record?.decision_id) || priorDecisionIds.includes(record?.decision_id)) errors.push('authorization ID is missing or already used');
  if (record?.decision !== 'authorized-for-one-paired-CASE-01-v3.8-pilot-only' || record?.case_id !== 'CASE-01') errors.push('authorization decision/scope is not exact CASE-01');
  if (!validSha256(record?.source_spec_sha256) || record?.source_spec_sha256 !== currentSpecSha256) errors.push('authorization is stale or invalid against the current source spec SHA-256');
  if (!validSha256(record?.authorized_execution_spec_sha256) || record?.authorized_execution_spec_sha256 !== currentAuthorizedSpecSha256) errors.push('authorized execution spec SHA-256 is missing, invalid, or stale');
  try {
    const authorizedSpec = readVerifiedRepoFile(repoRoot, record?.authorized_execution_spec_path, 'authorized execution spec');
    if (!validSha256(authorizedSpec.sha256) || authorizedSpec.sha256 !== record?.authorized_execution_spec_sha256 ||
        authorizedSpec.sha256 !== currentAuthorizedSpecSha256) {
      errors.push('authorized execution spec actual bytes do not match both the signed record and verifier hash');
    }
  } catch (error) {
    errors.push(`authorized execution spec bytes cannot be securely verified: ${error.message}`);
  }
  if (!validSha256(record?.frozen_bundle_sha256) || record?.frozen_bundle_sha256 !== frozenSha256) errors.push('authorization frozen artifact SHA-256 is missing, invalid, or does not match verified frozen bytes');
  if (!hasOnlyKeys(record?.source_tree_identity, SOURCE_TREE_IDENTITY_KEYS) || !hasOnlyKeys(expectedSourceTreeIdentity, SOURCE_TREE_IDENTITY_KEYS)) errors.push('authorization source-tree identity contains unknown keys or is not an object');
  if (!sameJson(record?.source_tree_identity, expectedSourceTreeIdentity)) errors.push('authorization source-tree identity does not match current packaged source inventory');
  if (!nonEmpty(record?.authority_id) || !nonEmpty(record?.authority_identity_verification_reference) ||
      !nonEmpty(record?.authority_reference) || !nonEmpty(record?.decision_channel_reference)) {
    errors.push('authorization authority identity, verification reference, authority reference, or decision channel is missing/invalid');
  }
  errors.push(...validateDecisionFreshness(record, 'decided_at'));
  errors.push(...validateAuthorityAttestation(record, trustedAuthorityPublicKey, 'execution-authorization-authority'));
  if (!Array.isArray(record?.stop_conditions) || record.stop_conditions.length === 0 || record.stop_conditions.some(item => !nonEmpty(item))) errors.push('authorization stop_conditions must be a non-empty array of explicit stop conditions');
  if (!record?.limits || record.limits.max_attempts !== 1 || !Number.isFinite(record.limits.max_duration_seconds) || record.limits.max_duration_seconds <= 0 ||
      !Number.isFinite(record.limits.max_memory_mb) || record.limits.max_memory_mb <= 0 ||
      !Number.isFinite(record.limits.max_cpu_percent) || record.limits.max_cpu_percent <= 0 || record.limits.max_cpu_percent > 100) {
    errors.push('authorization limits must constrain one attempt, positive duration/memory, and CPU at or below 100 percent');
  }
  if (record?.consumption_status !== 'fresh-not-yet-consumed') errors.push('authorization metadata says consumed or is not fresh');
  const output = typeof record?.output_path === 'string' ? record.output_path : '';
  const root = path.resolve(repoRoot);
  const resolvedOutput = path.resolve(root, output);
  const parts = output.split(/[\\/]/);
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root) {
      errors.push('authorization repository root is not a canonical non-symlink directory');
    }
  } catch (error) {
    errors.push(`authorization repository root cannot be verified: ${error.message}`);
  }
  const lexicalPathSafe = Boolean(output) && !path.isAbsolute(output) &&
    !output.includes('\\') &&
    resolvedOutput.startsWith(`${root}${path.sep}`) &&
    parts.every(part => part !== '' && part !== '.' && part !== '..') &&
    parts[0] === 'runs' && parts.length >= 2;
  if (!lexicalPathSafe) errors.push('authorization output path is unsafe or outside runs/');
  else {
    let cursor = root;
    for (const part of path.relative(root, resolvedOutput).split(path.sep).slice(0, -1)) {
      cursor = path.join(cursor, part);
      try {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          errors.push('authorization output path traverses a symlink or non-directory parent');
          break;
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          errors.push('authorization output path parent directory does not exist');
          break;
        }
        errors.push(`authorization output path parent cannot be verified: ${error.message}`);
        break;
      }
    }
    try {
      fs.lstatSync(resolvedOutput);
      errors.push('authorized output path already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(`authorized output path cannot be verified: ${error.message}`);
    }
  }
  if (consumption) errors.push('a durable consumption record already exists; one-shot cannot be reused');
  const expectedScopeKeys = ['automatic_retry', 'external_credentials', 'external_network', 'opshub', 'other_cases', 'shared_runtime'];
  if (!record?.scope || typeof record.scope !== 'object' || Array.isArray(record.scope) ||
      Object.keys(record.scope).sort().join(',') !== expectedScopeKeys.join(',') ||
      expectedScopeKeys.some(key => record.scope[key] !== false)) {
    errors.push('authorization prohibitions/scope must contain exactly the required six false-valued restrictions');
  }
  const embedded = spec?.execution_gate?.authorization_record;
  if (!embedded || embedded.decision_id !== record?.decision_id || embedded.source_spec_sha256 !== record?.source_spec_sha256 ||
      embedded.authorized_execution_spec_sha256 !== record?.authorized_execution_spec_sha256 ||
      embedded.frozen_bundle_sha256 !== record?.frozen_bundle_sha256 ||
      embedded.authorization_record_sha256 !== canonicalRecordSha256(record)) errors.push('execution gate does not bind the exact signed authorization record and all required hashes');
  return { valid: errors.length === 0, errors };
}
