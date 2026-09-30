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
  const value = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function createArtifactRecord({ artifact_id, job_id, task_id, type, schema_version = 1, producer_role, content, evidence = [], status = ArtifactStatus.ACTIVE, created_at = new Date().toISOString(), supersedes = null }) {
  const record = { artifact_id, job_id, task_id, type, schema_version, producer_role, content, evidence, status, created_at, supersedes, content_hash: hashArtifactContent(content) };
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
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      if (typeof content.requirementsSatisfied !== 'boolean' || typeof content.architectureConformant !== 'boolean' || typeof content.securityAccepted !== 'boolean' || typeof content.qaAccepted !== 'boolean' || typeof content.platformAccepted !== 'boolean' || typeof content.documentationAccepted !== 'boolean' || !['accept', 'reject', 'needs_changes'].includes(content.decision) || !['implementationIssues', 'evidenceIssues', 'securityIssues', 'blockingIssues'].every(field => Array.isArray(content[field]) && content[field].every(item => typeof item === 'string'))) throw new Error('review artifact content has invalid fields');
    }
    return true;
  }
  const fields = type === ArtifactType.REVIEW ? null : ARTIFACT_CONTENT_FIELDS[type];
  if (!fields) return true;
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error(type + ' artifact content must be an object');
  for (const field of fields) {
    if (!(field in content)) throw new Error(type + ' artifact content missing ' + field);
  }
  if (type === ArtifactType.REQUIREMENTS && (!Array.isArray(content.acceptance_criteria) || !Array.isArray(content.non_goals))) throw new Error('requirements artifact lists must be arrays');
  if (type === ArtifactType.RESEARCH && (!Array.isArray(content.findings) || !Array.isArray(content.sources) || !Array.isArray(content.limitations))) throw new Error('research artifact lists must be arrays');
  if (type === ArtifactType.ARCHITECTURE && (!Array.isArray(content.components) || !Array.isArray(content.interfaces) || !Array.isArray(content.failure_modes) || typeof content.implementation_boundary !== 'string' || !content.implementation_boundary.trim())) throw new Error('architecture artifact content has invalid fields');
  if (type === ArtifactType.IMPLEMENTATION && (typeof content.summary !== 'string' || !content.summary.trim() || !Array.isArray(content.files_changed) || !Array.isArray(content.verification) || !content.execution || typeof content.execution !== 'object' || Number(content.execution.exit_code) !== 0 || typeof content.execution.session_id !== 'string' || !content.execution.session_id)) throw new Error('implementation artifact content has invalid fields');
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
