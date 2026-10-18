#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { exportPluginState, verifyPluginStateExport } from './plugin-state-export.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-plugin-export-test-'));
const data = path.join(root, 'data');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(data, { mode: 0o700 });
fs.mkdirSync(workspace, { mode: 0o700 });
const dbPath = path.join(data, 'workflow.db');
const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE jobs(job_id TEXT PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE tasks(task_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE events(event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
  INSERT INTO jobs VALUES('job-bench-01','isolated synthetic proposal');
  INSERT INTO tasks VALUES('task-bench-01','job-bench-01','pending');
  INSERT INTO events VALUES('event-bench-01','job-bench-01','job.proposal_requested','{"workspace":"/case/workspace"}');`);
db.close();
const initialDbHash = sha256(fs.readFileSync(dbPath));
const identity = { run_id: 'run-synthetic-01', case_id: 'CASE-01', condition: 'plugin',
  scenario_spec_sha256: 'a'.repeat(64), bundle_sha256: 'b'.repeat(64),
  model_id: 'qwen3:4b-instruct', prompt_sha256: 'c'.repeat(64) };

try {
  const outputPath = path.join(workspace, 'plugin-state-export.json');
  const exported = exportPluginState({ dataDirectory: data, workspaceDirectory: workspace,
    outputPath, identity, observedJobIds: ['job-bench-01'] });
  const evidence = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(exported.unmatched_observed_job_ids.length, 0);
  assert.equal(exported.table_counts.jobs, 1);
  assert.equal(exported.table_counts.tasks, 1);
  assert.equal(exported.table_counts.events, 1);
  assert.equal(evidence.tables.jobs.rows[0].job_id, 'job-bench-01');
  assert.equal(evidence.tables.events.rows[0].event_id, 'event-bench-01');
  assert.equal(evidence.reconciliation.workspace_artifact_causality_proven, false,
    'database evidence must not be promoted to synthetic-file causality');
  assert.equal(sha256(fs.readFileSync(dbPath)), initialDbHash, 'read-only export must not mutate the database');
  assert.equal(exported.sha256, sha256(fs.readFileSync(outputPath)));
  const verified = verifyPluginStateExport({ workspaceDirectory: workspace,
    exportInfo: { relative_path: 'plugin-state-export.json', sha256: exported.sha256 }, expectedIdentity: identity });
  assert.equal(verified.status, 'captured-not-causal');
  assert.equal(verified.workspace_artifact_causality_proven, false);
  assert.throws(() => verifyPluginStateExport({ workspaceDirectory: workspace,
    exportInfo: { relative_path: 'plugin-state-export.json', sha256: '0'.repeat(64) }, expectedIdentity: identity }), /hash mismatch/);
  assert.throws(() => verifyPluginStateExport({ workspaceDirectory: workspace,
    exportInfo: { relative_path: 'plugin-state-export.json', sha256: exported.sha256 },
    expectedIdentity: { ...identity, run_id: 'different-run' } }), /identity mismatch: run_id/);
  assert.throws(() => verifyPluginStateExport({ workspaceDirectory: workspace,
    exportInfo: { relative_path: '../outside.json', sha256: exported.sha256 }, expectedIdentity: identity }), /missing or malformed/);
  assert.throws(() => exportPluginState({ dataDirectory: data, workspaceDirectory: workspace,
    outputPath: path.join(root, 'outside-export.json'), identity, observedJobIds: [] }), /within the condition-local workspace/);
  assert.throws(() => exportPluginState({ dataDirectory: data, workspaceDirectory: workspace,
    outputPath, identity, observedJobIds: [] }), /refusing to overwrite/);
  const outsideDb = path.join(root, 'outside-workflow.db');
  fs.copyFileSync(dbPath, outsideDb);
  const linkedData = path.join(root, 'linked-data');
  fs.mkdirSync(linkedData, { mode: 0o700 });
  fs.symlinkSync(outsideDb, path.join(linkedData, 'workflow.db'));
  assert.throws(() => exportPluginState({ dataDirectory: linkedData, workspaceDirectory: workspace,
    outputPath: path.join(workspace, 'symlink-db-export.json'), identity, observedJobIds: [] }), /regular non-symlink file/,
  'database symlink must not permit reading a database outside the condition-local data directory');
  const linkedWorkspace = path.join(root, 'linked-workspace');
  fs.symlinkSync(workspace, linkedWorkspace, 'dir');
  assert.throws(() => exportPluginState({ dataDirectory: data, workspaceDirectory: linkedWorkspace,
    outputPath: path.join(linkedWorkspace, 'linked-export.json'), identity, observedJobIds: [] }), /workspace must be a real directory/);
  const verifierWorkspace = path.join(root, 'verifier-workspace');
  fs.mkdirSync(verifierWorkspace, { mode: 0o700 });
  fs.symlinkSync(outputPath, path.join(verifierWorkspace, 'plugin-state-export.json'));
  assert.throws(() => verifyPluginStateExport({ workspaceDirectory: verifierWorkspace,
    exportInfo: { relative_path: 'plugin-state-export.json', sha256: exported.sha256 }, expectedIdentity: identity }), /regular non-symlink file/,
  'export verifier must reject symlinked evidence files even when the target is inside another workspace');
  const mismatchPath = path.join(workspace, 'mismatch-export.json');
  const mismatch = exportPluginState({ dataDirectory: data, workspaceDirectory: workspace,
    outputPath: mismatchPath, identity, observedJobIds: ['missing-job'] });
  assert.deepEqual(mismatch.unmatched_observed_job_ids, ['missing-job']);
  console.log(JSON.stringify({ status: 'PASS', checks: [
    'read-only condition-local database export', 'stable schema/row/count capture',
    'observed job ID reconciliation', 'unmatched job ID fails reconciliation',
    'output path containment', 'no overwrite', 'database hash unchanged', 'export hash/identity/path validation',
    'database and workspace symlink rejection', 'workspace-artifact causality remains unproven by default' ] }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
