import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowStore } from '../src/runtime/job-store.js';
import { artifactSchemaForType } from '../src/runtime/workflow/artifacts.js';
import { getAgentInputArtifactTypes } from '../src/runtime/workflow/agent-contracts.js';
import { standardEngineeringTaskSpecs } from '../src/runtime/workflow/catalog/standard-engineering.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-planning-'));
const db = new DatabaseSync(path.join(dir, 'workflow.db'));
db.exec(`
CREATE TABLE jobs (job_id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE tasks (task_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, role TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, uri TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, producer_role TEXT, content TEXT NOT NULL DEFAULT '', evidence_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', supersedes TEXT, content_hash TEXT);
CREATE TABLE events (event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
`);
const store = new WorkflowStore(db);
const ts = new Date().toISOString();
db.prepare('INSERT INTO jobs(job_id, conversation_key, title, state, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run('m3-job', 'm3', 'M3 planning', 'PROPOSED', 'active', ts, ts);
for (const [task_id, role] of [['po', 'product-owner'], ['research', 'researcher'], ['arch', 'architect']]) {
  db.prepare('INSERT INTO tasks(task_id, job_id, role, description, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(task_id, 'm3-job', role, role, 'completed', ts, ts);
}

const requirements = store.createArtifact({
  artifact_id: 'm3-req', job_id: 'm3-job', task_id: 'po', type: 'requirements', producer_role: 'product-owner',
  content: { scope: 'adapter hardening', acceptance_criteria: ['tests pass'], non_goals: ['provider rewrite'] }, evidence: ['job request']
});
const research = store.createArtifact({
  artifact_id: 'm3-research', job_id: 'm3-job', task_id: 'research', type: 'research', producer_role: 'researcher',
  content: { findings: ['existing SQLite artifact store is reusable'], sources: ['src/runtime/job-store.js'], limitations: ['no external benchmark'] }, evidence: ['repository inspection']
});
const architecture = store.createArtifact({
  artifact_id: 'm3-arch', job_id: 'm3-job', task_id: 'arch', type: 'architecture', producer_role: 'architect',
  content: { components: ['artifact store', 'workflow agents'], interfaces: ['agent → artifact store'], failure_modes: ['invalid artifact rejected'], implementation_boundary: 'src/runtime' },
  evidence: [requirements.artifact_id, research.artifact_id]
});

assert.equal(architecture.status, 'active');
assert.deepEqual(getAgentInputArtifactTypes('architect'), ['requirements', 'research']);
assert.deepEqual(getAgentInputArtifactTypes('engineer'), ['requirements', 'architecture']);
assert.deepEqual(artifactSchemaForType('requirements').required_content_fields, ['scope', 'acceptance_criteria', 'non_goals']);
const specs = standardEngineeringTaskSpecs();
assert.deepEqual(specs.find(x => x.role === 'architect').dependencies, ['standard-product-owner', 'standard-researcher']);
assert.deepEqual(specs.find(x => x.role === 'engineer').dependencies, ['standard-architect']);
assert.throws(() => store.createArtifact({
  artifact_id: 'm3-bad-research', job_id: 'm3-job', task_id: 'research', type: 'research', producer_role: 'researcher',
  content: { findings: [], sources: [] }, evidence: []
}), /missing limitations/);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('M3 PLANNING ARTIFACTS PASS');
