import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore } from '../src/runtime/job-store.js';
import { createArtifactRecord, validateArtifact } from '../src/runtime/workflow/artifacts.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-artifacts-'));
const db = new DatabaseSync(path.join(dir, 'workflow.db'));
db.exec(`
CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  dependency_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  producer_role TEXT,
  content TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  supersedes TEXT,
  content_hash TEXT
);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE workflow_plans (
  job_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  compiled_at TEXT,
  approved_at TEXT
);
`);
const store = new WorkflowStore(db);

const ts = new Date().toISOString();
db.prepare(`INSERT INTO jobs(job_id, conversation_key, title, state, status, created_at, updated_at) VALUES(?, ?, ?, 'PROPOSED', 'active', ?, ?)`).run('m2-job', 'm2-conv', 'M2', ts, ts);
db.prepare(`INSERT INTO tasks(task_id, job_id, role, description, status, dependency_json, metadata_json, created_at, updated_at) VALUES(?, ?, ?, ?, 'completed', '[]', '{}', ?, ?)`).run('m2-task', 'm2-job', 'architect', 'm2', ts, ts);

const first = store.createArtifact({
  artifact_id: 'artifact_m2_1', job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', schema_version: 1,
  producer_role: 'architect', content: { components: ['api', 'worker'], interfaces: ['api→worker'], failure_modes: ['worker unavailable'], implementation_boundary: 'src/runtime' }, evidence: ['code reference: src/runtime']
});
assert.equal(first.status, 'active');
assert.match(first.content_hash, /^[a-f0-9]{64}$/);
assert.equal(store.createArtifact({
  artifact_id: first.artifact_id, job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', schema_version: 1,
  producer_role: 'architect', content: first.content, evidence: ['code reference: src/runtime']
}).artifact_id, first.artifact_id, 'an exact idempotent retry must still return the original durable artifact');
const firstEventId = crypto.createHash('sha256').update(`m2-job|artifact.created|${first.artifact_id}`).digest('hex');
const firstEvent = db.prepare('SELECT * FROM events WHERE event_id=?').get(firstEventId);
assert.ok(firstEvent, 'artifact creation must persist its matching event');
db.prepare('DELETE FROM events WHERE event_id=?').run(firstEventId);
assert.throws(() => store.createArtifact({
  artifact_id: first.artifact_id, job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', schema_version: 1,
  producer_role: 'architect', content: first.content, evidence: ['code reference: src/runtime']
}), /artifact creation event lineage mismatch/,
'an idempotent retry must not claim success when the durable artifact creation event is missing');
db.prepare('INSERT INTO events(event_id, job_id, type, payload_json, created_at) VALUES(?, ?, ?, ?, ?)')
  .run(firstEvent.event_id, firstEvent.job_id, firstEvent.type, firstEvent.payload_json, firstEvent.created_at);
assert.deepEqual(store.getLatestArtifact('m2-job', 'architecture').content, {
  components: ['api', 'worker'],
  interfaces: ['api→worker'],
  failure_modes: ['worker unavailable'],
  implementation_boundary: 'src/runtime'
});
assert.throws(() => store.createArtifact({
  artifact_id: first.artifact_id, job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', schema_version: 1,
  producer_role: 'architect', content: first.content, evidence: ['different evidence reference']
}), /artifact id collision/,
'an idempotent artifact retry must reject changed evidence instead of silently returning a record with different durable lineage');
const artifactCountBeforeInheritedContent = db.prepare('SELECT COUNT(*) AS count FROM artifacts').get().count;
const artifactEventsBeforeInheritedContent = db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'artifact.created'").get().count;
const inheritedArchitectureContent = Object.create({
  components: ['inherited'], interfaces: ['inherited'], failure_modes: ['inherited'], implementation_boundary: 'inherited'
});
assert.throws(() => store.createArtifact({
  artifact_id: 'artifact_m2_inherited_content', job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', schema_version: 1,
  producer_role: 'architect', content: inheritedArchitectureContent, evidence: []
}), /plain JSON objects and arrays|missing components|content must be an object/,
'required artifact fields must be own serializable properties and rejected before any durable write');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM artifacts').get().count, artifactCountBeforeInheritedContent,
  'rejected inherited-only artifact content must not leave a durable artifact row');
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'artifact.created'").get().count, artifactEventsBeforeInheritedContent,
  'rejected inherited-only artifact content must not leave a misleading durable creation event');
assert.throws(() => store.createArtifact({
  artifact_id: 'artifact_m2_wrong_role', job_id: 'm2-job', task_id: 'm2-task', type: 'review', schema_version: 1,
  producer_role: 'architect', content: { x: 1 }, evidence: []
}), /not allowed for producer role architect/);

const second = store.createArtifact({
  artifact_id: 'artifact_m2_2', job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', schema_version: 1,
  producer_role: 'architect', content: { components: ['api', 'worker', 'queue'], interfaces: ['api→worker'], failure_modes: ['worker unavailable'], implementation_boundary: 'src/runtime' }, evidence: ['updated design'], supersedes: first.artifact_id
});
assert.equal(second.status, 'active');
assert.equal(second.supersedes, first.artifact_id);
assert.equal(store.getArtifact(first.artifact_id).status, 'superseded');
assert.equal(store.listArtifacts('m2-job', { type: 'architecture', activeOnly: true }).length, 1);
assert.throws(() => store.createArtifact({
  artifact_id: 'artifact_m2_bad', job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', schema_version: 1,
  producer_role: 'architect', content: { components: ['bad'], interfaces: [], failure_modes: [], implementation_boundary: 'src/runtime' }, evidence: [], supersedes: first.artifact_id
}), /already superseded/);

const artifactCountBeforeEventFailure = db.prepare('SELECT COUNT(*) AS count FROM artifacts').get().count;
const artifactEventCountBeforeEventFailure = db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'artifact.created'").get().count;
db.exec(`CREATE TRIGGER reject_artifact_created_event BEFORE INSERT ON events
  WHEN NEW.type = 'artifact.created' BEGIN SELECT RAISE(ABORT, 'injected artifact event failure'); END;`);
assert.throws(() => store.createArtifact({
  artifact_id: 'artifact_m2_event_failure', job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', schema_version: 1,
  producer_role: 'architect', content: { components: ['rollback'], interfaces: [], failure_modes: [], implementation_boundary: 'src/runtime' },
  evidence: ['failure-injection'], supersedes: second.artifact_id
}), /injected artifact event failure/,
'failure to write artifact.created must roll back the new artifact and any supersession mutation');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM artifacts').get().count, artifactCountBeforeEventFailure,
  'failed artifact event insertion must not leave a durable artifact row');
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'artifact.created'").get().count, artifactEventCountBeforeEventFailure,
  'failed artifact event insertion must not leave a partial creation event');
assert.equal(store.getArtifact(second.artifact_id).status, 'active',
  'failed replacement must not leave the previously active artifact superseded');
db.exec('DROP TRIGGER reject_artifact_created_event');

const collidingArtifactId = 'artifact_m2_event_id_collision';
const collidingEventId = crypto.createHash('sha256').update(`m2-job|artifact.created|${collidingArtifactId}`).digest('hex');
db.prepare('INSERT INTO events(event_id, job_id, type, payload_json, created_at) VALUES(?, ?, ?, ?, ?)')
  .run(collidingEventId, 'm2-job', 'unrelated.event', '{}', ts);
const artifactCountBeforeEventIdCollision = db.prepare('SELECT COUNT(*) AS count FROM artifacts').get().count;
assert.throws(() => store.createArtifact({
  artifact_id: collidingArtifactId, job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', schema_version: 1,
  producer_role: 'architect', content: { components: ['collision'], interfaces: [], failure_modes: [], implementation_boundary: 'src/runtime' }, evidence: []
}), /artifact creation event lineage mismatch/,
'INSERT OR IGNORE must not conceal a pre-existing conflicting event ID and permit an artifact without its creation event');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM artifacts').get().count, artifactCountBeforeEventIdCollision,
  'event-ID collision must roll back the newly inserted artifact row');
assert.equal(db.prepare('SELECT type FROM events WHERE event_id=?').get(collidingEventId).type, 'unrelated.event',
  'event-ID collision handling must preserve the pre-existing event byte-for-byte');

const callerOwnedContent = { components: ['before'], interfaces: [], failure_modes: [], implementation_boundary: 'src/runtime', nested: { label: 'original' } };
const immutableRecord = createArtifactRecord({
  artifact_id: 'artifact_m2_immutable', job_id: 'm2-job', task_id: 'm2-task', type: 'architecture',
  producer_role: 'architect', content: callerOwnedContent, evidence: ['source-a']
});
callerOwnedContent.components.push('after');
callerOwnedContent.nested.label = 'mutated';
assert.deepEqual(immutableRecord.content.components, ['before'], 'artifact record must snapshot caller-owned nested arrays');
assert.equal(immutableRecord.content.nested.label, 'original', 'artifact record must snapshot caller-owned nested objects');
assert.equal(validateArtifact(immutableRecord), true, 'snapshotted record hash must remain valid after caller mutation');
assert.throws(() => createArtifactRecord({
  artifact_id: 'artifact_m2_getter', job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', producer_role: 'architect',
  content: Object.defineProperties({ interfaces: [], failure_modes: [], implementation_boundary: 'src/runtime' }, {
    components: { enumerable: true, get() { return ['unstable']; } }
  }), evidence: []
}), /non-data or non-enumerable property/,
'accessor-backed artifact fields must not be evaluated into ambiguous durable bytes');
assert.throws(() => createArtifactRecord({
  artifact_id: 'artifact_m2_nonfinite', job_id: 'm2-job', task_id: 'm2-task', type: 'architecture', producer_role: 'architect',
  content: { components: [], interfaces: [], failure_modes: [], implementation_boundary: 'src/runtime', opaque_metric: Number.NaN }, evidence: []
}), /non-finite number/,
'non-finite nested values must be rejected rather than silently normalized by JSON.stringify');

const artifactContent = components => ({
  components, interfaces: [], failure_modes: [], implementation_boundary: 'src/runtime'
});
for (const key of ['NaN', 'Infinity', '-Infinity', '4294967295']) {
  const components = ['visible'];
  Object.defineProperty(components, key, { value: 'not-an-array-index', enumerable: true, writable: true, configurable: true });
  assert.throws(() => createArtifactRecord({
    artifact_id: `artifact_m2_extra_array_key_${key}`, job_id: 'm2-job', task_id: 'm2-task',
    type: 'architecture', producer_role: 'architect', content: artifactContent(components), evidence: []
  }), /extra array property/,
  `array property ${key} must not disappear from the bytes after validation`);
}

const hugeSparseComponents = [];
hugeSparseComponents[0xFFFFFFFE] = 'single high index';
assert.equal(hugeSparseComponents.length, 0xFFFFFFFF, 'fixture must have near-maximum legal array length without allocating dense slots');
assert.throws(() => createArtifactRecord({
  artifact_id: 'artifact_m2_huge_sparse_array', job_id: 'm2-job', task_id: 'm2-task',
  type: 'architecture', producer_role: 'architect', content: artifactContent(hugeSparseComponents), evidence: []
}), /sparse array/,
'sparse arrays with near-maximum legal index must fail closed without walking every possible index');

let ownToJsonCalls = 0;
const ownToJsonContent = artifactContent(['caller-value']);
Object.defineProperty(ownToJsonContent, 'toJSON', {
  enumerable: false,
  value() { ownToJsonCalls += 1; return artifactContent(['serialized-value']); }
});
assert.throws(() => createArtifactRecord({
  artifact_id: 'artifact_m2_nonenumerable_tojson', job_id: 'm2-job', task_id: 'm2-task',
  type: 'architecture', producer_role: 'architect', content: ownToJsonContent, evidence: []
}), /non-data or non-enumerable property/,
'a non-enumerable toJSON hook must be rejected rather than execute after field validation');
assert.equal(ownToJsonCalls, 0, 'rejected own toJSON hook must never execute');

const hiddenPropertyContent = artifactContent(['visible']);
Object.defineProperty(hiddenPropertyContent, 'unpersisted_authority', { value: true, enumerable: false });
assert.throws(() => createArtifactRecord({
  artifact_id: 'artifact_m2_hidden_property', job_id: 'm2-job', task_id: 'm2-task',
  type: 'architecture', producer_role: 'architect', content: hiddenPropertyContent, evidence: []
}), /non-data or non-enumerable property/,
'non-enumerable data must not be accepted by validation and silently omitted from durable JSON');

const priorPrototypeToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
let inheritedToJsonCalls = 0;
try {
  if (priorPrototypeToJson && priorPrototypeToJson.configurable === false) {
    throw new Error('cannot safely exercise inherited toJSON regression because Object.prototype.toJSON is non-configurable');
  }
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    enumerable: false,
    writable: true,
    value() { inheritedToJsonCalls += 1; return { injected: 'prototype hook' }; }
  });
  const inheritedHookContent = artifactContent(['must-preserve-original']);
  const inheritedHookRecord = createArtifactRecord({
    artifact_id: 'artifact_m2_inherited_tojson', job_id: 'm2-job', task_id: 'm2-task',
    type: 'architecture', producer_role: 'architect', content: inheritedHookContent, evidence: []
  });
  assert.deepEqual([...inheritedHookRecord.content.components], ['must-preserve-original'],
    'snapshot serialization must preserve supplied data instead of invoking Object.prototype.toJSON');
  assert.equal(inheritedToJsonCalls, 0, 'prototype-inherited serialization hooks must never execute');
  assert.equal(validateArtifact(inheritedHookRecord), true);
} finally {
  if (priorPrototypeToJson) Object.defineProperty(Object.prototype, 'toJSON', priorPrototypeToJson);
  else delete Object.prototype.toJSON;
}

const record = createArtifactRecord({ artifact_id: 'artifact_m2_3', job_id: 'm2-job', task_id: 'm2-task', type: 'review', producer_role: 'reviewer', content: {
  requirementsSatisfied: true, architectureConformant: true, securityAccepted: true, qaAccepted: true,
  platformAccepted: true, documentationAccepted: true, implementationIssues: [], evidenceIssues: [],
  securityIssues: [], blockingIssues: [], decision: 'accept'
}, evidence: [] });
assert.equal(validateArtifact(record), true);
assert.throws(() => validateArtifact({ ...record, content_hash: 'bad' }), /content_hash mismatch/);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('M2 ARTIFACTS PASS');
