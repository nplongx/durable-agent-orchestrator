import crypto from 'node:crypto';

export const ArtifactType = Object.freeze({
  REQUIREMENTS: 'requirements',
  RESEARCH: 'research',
  ARCHITECTURE: 'architecture',
  IMPLEMENTATION: 'implementation',
  SECURITY_REVIEW: 'security-review',
  QA_REPORT: 'qa-report',
  PLATFORM_REVIEW: 'platform-review',
  DOCUMENTATION: 'documentation',
  REVIEW: 'review',
  CTO_DECISION: 'cto-decision'
});

export const ArtifactStatus = Object.freeze({
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  INVALIDATED: 'invalidated'
});

const ARTIFACT_CONTENT_FIELDS = Object.freeze({
  requirements: Object.freeze(['scope', 'acceptance_criteria', 'non_goals']),
  research: Object.freeze(['findings', 'sources', 'limitations']),
  architecture: Object.freeze(['components', 'interfaces', 'failure_modes', 'implementation_boundary']),
  implementation: Object.freeze(['summary', 'files_changed', 'verification', 'execution']),
  'security-review': Object.freeze(['threats', 'findings', 'decision']),
  'qa-report': Object.freeze(['checks', 'results', 'decision']),
  'platform-review': Object.freeze(['runtime', 'deployment', 'recovery']),
  documentation: Object.freeze(['summary', 'user_facing_changes', 'verification']),
  review: Object.freeze([]),
  'cto-decision': Object.freeze(['decision', 'summary', 'accepted_requirements', 'unresolved_risks', 'follow_up_actions', 'evidence_refs'])
});
const REVIEW_REQUIRED_FIELDS = Object.freeze(['requirementsSatisfied', 'architectureConformant', 'securityAccepted', 'qaAccepted', 'platformAccepted', 'documentationAccepted', 'implementationIssues', 'evidenceIssues', 'securityIssues', 'blockingIssues', 'decision']);

const REQUIRED = ['artifact_id', 'job_id', 'task_id', 'type', 'schema_version', 'producer_role', 'content', 'evidence', 'status', 'created_at', 'content_hash'];

export function hashArtifactContent(content) {
  // Hash the same plain JSON snapshot the durable artifact contract accepts.
  // JSON.stringify on an arbitrary object can call an own or inherited toJSON
  // hook, making the bytes hashed depend on executable properties rather than
  // on the data fields inspected by validation.
  const value = typeof content === 'string' ? content : snapshotArtifactJson(content, 'artifact content for hashing').serialized;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function snapshotArtifactJson(value, label) {
  const ancestors = new Set();
  function snapshotJsonValue(current, at) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error(`${label} contains a non-finite number at ${at}`);
      return current;
    }
    if (typeof current !== 'object') throw new Error(`${label} contains a non-JSON value at ${at}`);
    if (ancestors.has(current)) throw new Error(`${label} contains a circular reference at ${at}`);
    const isArray = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (isArray ? prototype !== Array.prototype : (prototype !== Object.prototype && prototype !== null)) {
      throw new Error(`${label} must contain only plain JSON objects and arrays at ${at}`);
    }
    const ownKeys = Reflect.ownKeys(current);
    if (ownKeys.some(key => typeof key === 'symbol')) throw new Error(`${label} contains symbol keys at ${at}`);
    ancestors.add(current);
    // Rebuild using prototype-free containers. JSON.stringify consults a
    // toJSON property through the prototype chain even when it is inherited or
    // non-enumerable. Serializing caller-owned objects directly therefore lets
    // code execute after data validation and can hash/persist different bytes.
    const snapshot = isArray ? [] : Object.create(prototype);
    // If a runtime/global prototype has been polluted with a toJSON member,
    // shadow it on the private snapshot. Keep normal container prototypes so
    // returned records retain ordinary Array/Object APIs; the undefined own
    // data property cannot execute and is ignored by JSON serialization.
    let inheritedPrototype = prototype;
    let hasInheritedToJSON = false;
    while (inheritedPrototype) {
      if (Object.getOwnPropertyDescriptor(inheritedPrototype, 'toJSON')) {
        hasInheritedToJSON = true;
        break;
      }
      inheritedPrototype = Object.getPrototypeOf(inheritedPrototype);
    }
    if (hasInheritedToJSON) {
      Object.defineProperty(snapshot, 'toJSON', { value: undefined, enumerable: false, writable: false, configurable: false });
    }
    let arrayIndexCount = 0;
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (key === 'toJSON' && !descriptor?.enumerable && Object.hasOwn(descriptor || {}, 'value') && descriptor.value === undefined) {
        // Accepted only as the inert shadow inserted above (or an equivalent
        // harmless caller property); functions/accessors and hidden data still
        // fail closed below.
        continue;
      }
      if (isArray && key === 'length') {
        if (!descriptor || descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value !== current.length) {
          throw new Error(`${label} contains a malformed array length property at ${at}`);
        }
        continue;
      }
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`${label} contains a non-data or non-enumerable property at ${at}.${key}`);
      }
      if (isArray) {
        const index = Number(key);
        // ECMAScript array indices are canonical decimal uint32 strings except
        // 2^32-1. Number()/String() alone incorrectly accepts NaN and infinities.
        if (!Number.isInteger(index) || index < 0 || index >= 0xFFFFFFFF || String(index) !== key) {
          throw new Error(`${label} contains an extra array property at ${at}.${key}`);
        }
        arrayIndexCount++;
      }
      const child = snapshotJsonValue(descriptor.value, `${at}.${key}`);
      if (isArray) snapshot[key] = child;
      else Object.defineProperty(snapshot, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    if (isArray && arrayIndexCount !== current.length) {
      // Do not walk array.length: a sparse array with one valid index near
      // 2^32 can set length to 4,294,967,295 without allocating that many
      // entries. Counting already-validated own index descriptors rejects it
      // in O(ownKeys) time instead of an attacker-controlled billions-iteration
      // loop. Canonical array indices are unique and each array's length is
      // maxIndex + 1, so matching the count is equivalent to density.
      throw new Error(`${label} contains a sparse array at ${at}`);
    }
    ancestors.delete(current);
    return snapshot;
  }
  const safeSnapshot = snapshotJsonValue(value, '$');
  let serialized;
  try { serialized = JSON.stringify(safeSnapshot); } catch (error) {
    throw new Error(`${label} cannot be serialized as JSON: ${error.message}`);
  }
  if (typeof serialized !== 'string') throw new Error(`${label} cannot be serialized as JSON`);
  return { serialized, value: safeSnapshot };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function createArtifactRecord({ artifact_id, job_id, task_id, type, schema_version = 1, producer_role, content, evidence = [], status = ArtifactStatus.ACTIVE, created_at = new Date().toISOString(), supersedes = null }) {
  const contentSnapshot = snapshotArtifactJson(content, 'artifact content');
  const evidenceSnapshot = snapshotArtifactJson(evidence, 'artifact evidence');
  const record = { artifact_id, job_id, task_id, type, schema_version, producer_role, content: deepFreeze(contentSnapshot.value), evidence: deepFreeze(evidenceSnapshot.value), status, created_at, supersedes, content_hash: hashArtifactContent(contentSnapshot.value) };
  validateArtifact(record);
  return Object.freeze(record);
}

export function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') throw new Error('artifact is required');
  for (const field of REQUIRED) if (artifact[field] == null || artifact[field] === '') throw new Error(`artifact ${field} is required`);
  if (!Object.values(ArtifactType).includes(artifact.type)) throw new Error(`unknown artifact type: ${artifact.type}`);
  if (!Number.isInteger(artifact.schema_version) || artifact.schema_version < 1) throw new Error(`invalid artifact schema version: ${artifact.schema_version}`);
  if (!Object.values(ArtifactStatus).includes(artifact.status)) throw new Error(`invalid artifact status: ${artifact.status}`);
  if (!Array.isArray(artifact.evidence) || artifact.evidence.some(item => typeof item !== 'string')) throw new Error('artifact evidence must be an array of strings');
  const expectedHash = hashArtifactContent(artifact.content);
  if (artifact.content_hash !== expectedHash) throw new Error('artifact content_hash mismatch');
  validateArtifactContent(artifact.type, artifact.content);
  return true;
}

export function validateArtifactContent(type, content) {
  if (type === ArtifactType.REVIEW) {
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('review artifact content must be an object');
    for (const field of REVIEW_REQUIRED_FIELDS) {
      if (!Object.hasOwn(content, field)) throw new Error('review artifact content missing ' + field);
    }
    if (typeof content.requirementsSatisfied !== 'boolean' || typeof content.architectureConformant !== 'boolean' || typeof content.securityAccepted !== 'boolean' || typeof content.qaAccepted !== 'boolean' || typeof content.platformAccepted !== 'boolean' || typeof content.documentationAccepted !== 'boolean' || !['accept', 'reject', 'needs_changes'].includes(content.decision) || !['implementationIssues', 'evidenceIssues', 'securityIssues', 'blockingIssues'].every(field => Array.isArray(content[field]) && content[field].every(item => typeof item === 'string'))) throw new Error('review artifact content has invalid fields');
    return true;
  }
  const fields = type === ArtifactType.REVIEW ? null : ARTIFACT_CONTENT_FIELDS[type];
  if (!fields) return true;
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error(type + ' artifact content must be an object');
  for (const field of fields) {
    // Artifact content is persisted via JSON.stringify. Inherited properties
    // pass the `in` operator but are omitted by serialization, which previously
    // let validation succeed and then left an invalid durable row when read
    // back. Require each contract field to be an own serializable property.
    if (!Object.hasOwn(content, field)) throw new Error(type + ' artifact content missing ' + field);
  }
  if (type === ArtifactType.REQUIREMENTS && (!Array.isArray(content.acceptance_criteria) || !Array.isArray(content.non_goals))) throw new Error('requirements artifact lists must be arrays');
  if (type === ArtifactType.RESEARCH && (!Array.isArray(content.findings) || !Array.isArray(content.sources) || !Array.isArray(content.limitations))) throw new Error('research artifact lists must be arrays');
  if (type === ArtifactType.ARCHITECTURE && (!Array.isArray(content.components) || !Array.isArray(content.interfaces) || !Array.isArray(content.failure_modes) || typeof content.implementation_boundary !== 'string' || !content.implementation_boundary.trim())) throw new Error('architecture artifact content has invalid fields');
  if (type === ArtifactType.IMPLEMENTATION) {
    const execution = content.execution;
    const hasDeterministicExecution = execution && execution.exit_code === 0 && typeof execution.session_id === 'string' && execution.session_id.trim();
    const hasLocalToolEvidence = execution?.mode === 'chat-on-steroids-local-tools'
      && execution.exit_code === null
      && execution.session_id === null
      && Array.isArray(execution.evidence_refs)
      && execution.evidence_refs.length > 0
      && execution.evidence_refs.every(item => typeof item === 'string' && item.trim())
      && Array.isArray(content.verification)
      && content.verification.length > 0;
    if (typeof content.summary !== 'string' || !content.summary.trim() || !Array.isArray(content.files_changed) || !Array.isArray(content.verification) || !execution || typeof execution !== 'object' || (!hasDeterministicExecution && !hasLocalToolEvidence)) {
      throw new Error('implementation artifact content has invalid fields');
    }
  }
  if (type === ArtifactType.SECURITY_REVIEW && (!Array.isArray(content.threats) || !Array.isArray(content.findings) || !['accept', 'reject', 'needs_changes'].includes(content.decision))) throw new Error('security-review artifact content has invalid fields');
  if (type === ArtifactType.QA_REPORT && (!Array.isArray(content.checks) || !Array.isArray(content.results) || !['accept', 'reject', 'needs_changes'].includes(content.decision))) throw new Error('qa-report artifact content has invalid fields');
  if (type === ArtifactType.PLATFORM_REVIEW && (!content.runtime || typeof content.runtime !== 'object' || !content.deployment || typeof content.deployment !== 'object' || !content.recovery || typeof content.recovery !== 'object')) throw new Error('platform-review artifact content has invalid fields');
  if (type === ArtifactType.DOCUMENTATION && (typeof content.summary !== 'string' || !content.summary.trim() || !Array.isArray(content.user_facing_changes) || !Array.isArray(content.verification))) throw new Error('documentation artifact content has invalid fields');
  if (type === ArtifactType.CTO_DECISION && (typeof content.summary !== 'string' || !content.summary.trim() || !['approve', 'reject', 'rework'].includes(content.decision) || !Array.isArray(content.accepted_requirements) || !Array.isArray(content.unresolved_risks) || !Array.isArray(content.follow_up_actions) || !Array.isArray(content.evidence_refs) || content.accepted_requirements.some(item => typeof item !== 'string') || content.unresolved_risks.some(item => typeof item !== 'string') || content.follow_up_actions.some(item => typeof item !== 'string') || content.evidence_refs.some(item => typeof item !== 'string'))) throw new Error('cto-decision artifact content has invalid fields');
  return true;
}

export function artifactSchemaForType(type) {
  if (!Object.values(ArtifactType).includes(type)) throw new Error(`unknown artifact type: ${type}`);
  return Object.freeze({ type, schema_version: 1, required_content_fields: Object.freeze([...(type === ArtifactType.REVIEW ? REVIEW_REQUIRED_FIELDS : (ARTIFACT_CONTENT_FIELDS[type] || []))]) });
}
