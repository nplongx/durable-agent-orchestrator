import assert from 'node:assert/strict';
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
assert.deepEqual(store.getLatestArtifact('m2-job', 'architecture').content, {
  components: ['api', 'worker'],
  interfaces: ['api→worker'],
  failure_modes: ['worker unavailable'],
  implementation_boundary: 'src/runtime'
});
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

const record = createArtifactRecord({ artifact_id: 'artifact_m2_3', job_id: 'm2-job', task_id: 'm2-task', type: 'review', producer_role: 'reviewer', content: 'review', evidence: [] });
assert.equal(validateArtifact(record), true);
assert.throws(() => validateArtifact({ ...record, content_hash: 'bad' }), /content_hash mismatch/);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('M2 ARTIFACTS PASS');
