import crypto from 'node:crypto';
import { parseStrictJson } from './strict-json.js';

const IDENTITY_FIELDS = Object.freeze([
  'job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch', 'provider', 'api_base', 'workflow',
  'repository', 'event', 'ref', 'input_commit', 'request_sha256'
]);

const EXECUTION_REQUEST_FIELDS = Object.freeze([
  'schema_version', 'job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch', 'role', 'input_commit',
  'task_payload_ref', 'workspace', 'required_evidence', 'task_payload_inline'
]);

export function normalizeProviderApiBase(value) {
  const supplied = typeof value === 'string' && value.trim() ? value.trim() : 'https://api.github.com';
  let url;
  try { url = new URL(supplied); }
  catch { throw new Error('durable provider dispatch identity has an invalid api_base'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('durable provider dispatch identity api_base must be an HTTPS URL without credentials, query, or fragment');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname === '/' ? '' : pathname}`;
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`durable provider dispatch identity is missing ${field}`);
  }
  return value;
}

function ownData(object, key, label = 'provider dispatch configuration') {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new Error(`${label} ${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

export function providerDispatchConfig(provider = {}) {
  // Configuration participates in the durable dispatch key. Read only own
  // data properties so an accessor cannot change the destination between
  // identity construction and the eventual provider call.
  const ownerValue = ownData(provider, 'owner');
  const repoValue = ownData(provider, 'repo');
  const repositoryValue = ownData(provider, 'repository');
  const providerName = ownData(provider, 'providerName');
  const apiBase = ownData(provider, 'apiBase') || ownData(provider, 'api_base');
  const workflowValue = ownData(provider, 'workflow');
  const eventValue = ownData(provider, 'event');
  const refValue = ownData(provider, 'ref');
  const owner = typeof ownerValue === 'string' ? ownerValue.trim() : '';
  const repo = typeof repoValue === 'string' ? repoValue.trim() : '';
  const repository = owner && repo
    ? `${owner}/${repo}`
    : (typeof repositoryValue === 'string' && repositoryValue.trim() ? repositoryValue.trim() : 'unconfigured');
  return {
    provider: typeof providerName === 'string' && providerName.trim() ? providerName.trim() : 'github-actions',
    api_base: normalizeProviderApiBase(apiBase),
    workflow: typeof workflowValue === 'string' && workflowValue.trim() ? workflowValue.trim() : 'unconfigured',
    repository,
    event: typeof eventValue === 'string' && eventValue.trim() ? eventValue.trim() : 'workflow_dispatch',
    ref: typeof refValue === 'string' && refValue.trim() ? refValue.trim() : 'unconfigured'
  };
}

function canonicalJson(value, field = 'execution request') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error(`${field} contains a non-canonical number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error(`${field} contains a sparse array entry at index ${index}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
        throw new Error(`${field} contains a non-data array entry at index ${index}`);
      }
      parts.push(canonicalJson(descriptor.value, `${field}[${index}]`));
    }
    const extraKeys = Reflect.ownKeys(value).filter(key => key !== 'length' &&
      !(typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length && String(Number(key)) === key));
    if (extraKeys.length) throw new Error(`${field} contains unsupported array properties`);
    return `[${parts.join(',')}]`;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== 'string')) throw new Error(`${field} contains symbol-keyed properties`);
    const keys = ownKeys.sort();
    const members = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error(`${field}.${key} is not an enumerable data property`);
      }
      members.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, `${field}.${key}`)}`);
    }
    return `{${members.join(',')}}`;
  }
  throw new Error(`${field} contains a value that is not JSON-safe`);
}

export function canonicalProviderDispatchRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('execution request is required for dispatch binding');
  if (Object.getPrototypeOf(request) !== Object.prototype) throw new Error('execution request must be a plain JSON object');
  const requestMaterial = {};
  const allowed = new Set(EXECUTION_REQUEST_FIELDS);
  const requestKeys = Reflect.ownKeys(request);
  if (requestKeys.some(key => typeof key !== 'string')) throw new Error('execution request contains symbol-keyed properties');
  for (const key of requestKeys) {
    if (!allowed.has(key)) throw new Error(`execution request contains unsupported field ${key} for durable dispatch binding`);
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`execution request field ${key} is not an enumerable data property`);
    }
  }
  for (const field of EXECUTION_REQUEST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(request, field)) requestMaterial[field] = Object.getOwnPropertyDescriptor(request, field).value;
  }
  if (!Object.keys(requestMaterial).length) throw new Error('dispatch request has no bindable execution fields');
  return canonicalJson(requestMaterial);
}

export function providerDispatchRequestSha256(request) {
  return crypto.createHash('sha256').update(canonicalProviderDispatchRequest(request)).digest('hex');
}

function createCoreIdentity(request, config) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('dispatch request identity is required');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('provider dispatch configuration is required');
  if (typeof request.attempt !== 'number' || !Number.isSafeInteger(request.attempt) || request.attempt < 1 || Object.is(request.attempt, -0)) {
    throw new Error('durable provider dispatch identity has an invalid attempt');
  }
  const attempt = request.attempt;
  if (typeof request.owner_epoch !== 'number' || !Number.isSafeInteger(request.owner_epoch) || request.owner_epoch < 1 || Object.is(request.owner_epoch, -0)) {
    throw new Error('durable provider dispatch identity has an invalid owner_epoch');
  }
  if (typeof request.input_commit !== 'string') throw new Error('durable provider dispatch identity has an invalid input_commit');
  const inputCommit = requiredText(request.input_commit.toLowerCase(), 'input_commit');
  if (!/^[a-f0-9]{40}$/i.test(inputCommit)) throw new Error('durable provider dispatch identity has an invalid input_commit');
  const configProvider = ownData(config, 'provider');
  const configApiBase = ownData(config, 'api_base') ?? ownData(config, 'apiBase') ?? 'https://api.github.com';
  const configWorkflow = ownData(config, 'workflow');
  const configRepository = ownData(config, 'repository');
  const configEvent = ownData(config, 'event');
  const configRef = ownData(config, 'ref');
  return {
    job_id: requiredText(request.job_id, 'job_id'),
    task_id: requiredText(request.task_id, 'task_id'),
    lease_id: requiredText(request.lease_id, 'lease_id'),
    attempt,
    owner_epoch: request.owner_epoch,
    provider: requiredText(configProvider, 'provider'),
    api_base: normalizeProviderApiBase(configApiBase),
    workflow: requiredText(configWorkflow, 'workflow'),
    repository: requiredText(configRepository, 'repository'),
    event: requiredText(configEvent, 'event'),
    ref: requiredText(configRef, 'ref'),
    input_commit: inputCommit
  };
}

function requiredRequestDigest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('durable provider dispatch identity is missing request_sha256');
  }
  return value.toLowerCase();
}

function normalizeDispatchIdentity(identity) {
  return {
    ...createCoreIdentity(identity, identity),
    request_sha256: requiredRequestDigest(identity?.request_sha256)
  };
}

export function createProviderDispatchIdentity(request, config) {
  // Validate/snapshot request bytes before reading identity fields. Otherwise
  // a getter on job_id/attempt/owner_epoch could execute before canonical JSON
  // validation notices that the object is not an inert data record.
  // Validate numeric identity fields through own data descriptors first so
  // malformed values retain the contract's precise identity error rather than
  // being reported only as generic non-JSON-safe values.
  const attempt = ownData(request, 'attempt', 'execution request field');
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 || Object.is(attempt, -0)) {
    throw new Error('durable provider dispatch identity has an invalid attempt');
  }
  const ownerEpoch = ownData(request, 'owner_epoch', 'execution request field');
  if (typeof ownerEpoch !== 'number' || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1 || Object.is(ownerEpoch, -0)) {
    throw new Error('durable provider dispatch identity has an invalid owner_epoch');
  }
  const canonicalRequest = canonicalProviderDispatchRequest(request);
  const requestSnapshot = parseStrictJson(canonicalRequest, 'canonical provider dispatch request');
  return {
    ...createCoreIdentity(requestSnapshot, config),
    request_sha256: crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  };
}

export function providerDispatchIdentityFromIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new TypeError('durable provider dispatch intent is required');
  // Do not synthesize the new origin binding for pre-migration rows. Legacy
  // intents without this field have no trustworthy remote destination and
  // must be reconciled/migrated explicitly rather than replayed.
  if (typeof intent.api_base !== 'string' || !intent.api_base.trim()) {
    throw new Error('durable provider dispatch identity is missing api_base');
  }
  const identity = normalizeDispatchIdentity({
    ...intent,
    api_base: intent.api_base,
    workflow: intent.workflow,
    repository: intent.repository,
    event: intent.event,
    ref: intent.ref
  });
  if (typeof intent.request_json !== 'string' || !intent.request_json) {
    throw new Error('durable provider dispatch request bytes are unavailable; legacy intent requires reconciliation and cannot be dispatch-enabled');
  }
  const request = parseStrictJson(intent.request_json, 'durable provider dispatch request');
  const canonical = canonicalProviderDispatchRequest(request);
  if (canonical !== intent.request_json || providerDispatchRequestSha256(request) !== identity.request_sha256) {
    throw new Error('durable provider dispatch request bytes do not match the immutable request_sha256 binding');
  }
  return identity;
}

export function providerDispatchKey(identity) {
  const normalized = normalizeDispatchIdentity(identity);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function assertProviderDispatchIntent(intent, expectedIdentity) {
  const actual = providerDispatchIdentityFromIntent(intent);
  const expected = normalizeDispatchIdentity(expectedIdentity);
  for (const field of IDENTITY_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw new Error(`durable provider dispatch intent does not match exact ${field} binding`);
    }
  }
  const expectedKey = providerDispatchKey(expected);
  if (String(intent.dispatch_key || '') !== expectedKey || String(intent.dispatch_key || '') !== providerDispatchKey(actual)) {
    throw new Error('durable provider dispatch key does not bind the exact job/task/lease/attempt/owner-epoch/provider/workflow/repository/event/ref/input commit/request identity');
  }
  return actual;
}

export function ensureProviderDispatchIntentColumns(db) {
  if (!db || typeof db.exec !== 'function') return;
  for (const column of ['workflow', 'repository', 'event', 'ref', 'api_base', 'dispatch_claim_id', 'dispatch_claimed_at', 'request_sha256', 'request_json', 'owner_epoch']) {
    try { db.exec(`ALTER TABLE provider_dispatch_intents ADD COLUMN ${column} ${column === 'owner_epoch' ? 'INTEGER' : 'TEXT'}`); }
    catch (error) {
      if (!new RegExp(`duplicate column name:\\s*${column}`, 'i').test(String(error?.message || error))) throw error;
    }
  }
  // One execution attempt may have only one immutable intent. If a legacy DB
  // already contains conflicting rows, fail closed rather than deleting or
  // silently merging dispatch evidence.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_dispatch_intents_attempt_tuple
    ON provider_dispatch_intents(job_id,task_id,lease_id,attempt,provider)`);
}
