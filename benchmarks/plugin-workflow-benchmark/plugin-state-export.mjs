import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const EXPORTED_TABLES = new Set([
  'jobs', 'tasks', 'approvals', 'attempts', 'results', 'artifacts', 'events', 'workflow_events',
  'workflow_runtime_state', 'workflow_plans', 'task_leases', 'task_checkpoints',
  'execution_batches', 'execution_batch_items', 'manual_interventions',
  'custom_role_versions', 'custom_workflow_versions', 'custom_workflow_plans',
  'provider_runs', 'provider_dispatch_intents', 'm12_native_specialist_runtime',
  'provider_admission', 'provider_admission_leases',
]);

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function jsonSafe(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { encoding: 'base64', value: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  return value;
}

function orderBy(columns) {
  const primary = columns.filter(c => Number(c.pk) > 0).sort((a, b) => a.pk - b.pk).map(c => quoteIdentifier(c.name));
  return primary.length ? ` ORDER BY ${primary.join(', ')}` : ' ORDER BY rowid';
}

export function exportPluginState({ dataDirectory, workspaceDirectory, outputPath, identity, observedJobIds = [] } = {}) {
  if (!identity || !['plugin', 'control'].includes(identity.condition)) throw new Error('evidence identity must include condition=plugin or control');
  for (const key of ['run_id', 'case_id', 'scenario_spec_sha256', 'model_id', 'prompt_sha256']) {
    if (typeof identity[key] !== 'string' || !identity[key]) throw new Error(`evidence identity missing ${key}`);
  }
  if (identity.condition !== 'plugin') throw new Error('plugin state export is only valid for the plugin condition');
  const dataRootStat = fs.lstatSync(dataDirectory);
  if (!dataRootStat.isDirectory() || dataRootStat.isSymbolicLink()) throw new Error('condition-local data directory must be a real directory, not a symlink');
  const workspaceRootStat = fs.lstatSync(workspaceDirectory);
  if (!workspaceRootStat.isDirectory() || workspaceRootStat.isSymbolicLink()) throw new Error('condition-local workspace must be a real directory, not a symlink');
  const dataRoot = fs.realpathSync(dataDirectory);
  const dbPath = path.join(dataRoot, 'workflow.db');
  let dbStat;
  try { dbStat = fs.lstatSync(dbPath); } catch { throw new Error('condition-local workflow.db is missing; cannot claim plugin-state evidence'); }
  if (!dbStat.isFile() || dbStat.isSymbolicLink()) throw new Error('condition-local workflow.db must be a regular non-symlink file');
  const output = path.resolve(outputPath);
  const outputParent = fs.realpathSync(path.dirname(output));
  const workspaceRoot = fs.realpathSync(workspaceDirectory);
  if (outputParent !== workspaceRoot && !outputParent.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error('export destination must resolve within the condition-local workspace');
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite plugin-state export: ${output}`);

  const databaseFiles = ['workflow.db', 'workflow.db-wal', 'workflow.db-shm']
    .map(name => path.join(dataRoot, name)).filter(file => fs.existsSync(file))
    .map(file => {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`condition-local database sidecar must be a regular non-symlink file: ${path.basename(file)}`);
      return { name: path.basename(file), size_bytes: stat.size, sha256: sha256(fs.readFileSync(file)) };
    });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let tables;
  try {
    db.exec('PRAGMA query_only = ON');
    const available = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    tables = {};
    for (const table of available) {
      if (!EXPORTED_TABLES.has(table.name)) continue;
      const quoted = quoteIdentifier(table.name);
      const columns = db.prepare(`PRAGMA table_info(${quoted})`).all();
      const rows = db.prepare(`SELECT * FROM ${quoted}${orderBy(columns)}`).all().map(row => jsonSafe(row));
      tables[table.name] = { create_sql: table.sql, columns, row_count: rows.length, rows };
    }
  } finally {
    db.close();
  }

  const jobIdsInDb = new Set((tables.jobs?.rows ?? []).map(row => row.job_id).filter(v => typeof v === 'string'));
  const observed = [...new Set(observedJobIds)].filter(v => typeof v === 'string');
  const unmatchedObservedJobIds = observed.filter(id => !jobIdsInDb.has(id));
  const evidence = {
    protocol: 'cos-plugin-state-export-v1',
    captured_at: new Date().toISOString(),
    identity: structuredClone(identity),
    scope: 'all rows from the fresh condition-local SQLite database only; no shared runtime database is opened',
    database: { relative_path: 'data/workflow.db', sha256: sha256(fs.readFileSync(dbPath)), files: databaseFiles },
    observed_job_ids: observed,
    job_ids_present_in_database: [...jobIdsInDb].sort(),
    unmatched_observed_job_ids: unmatchedObservedJobIds,
    table_counts: Object.fromEntries(Object.entries(tables).map(([name, value]) => [name, value.row_count])),
    tables,
    reconciliation: {
      job_id_match: unmatchedObservedJobIds.length === 0,
      workspace_artifact_causality_proven: false,
      note: 'A durable DB snapshot alone does not prove that plugin state caused a synthetic workspace artifact. Require explicit artifact ID/hash/evidence linkage before crediting plugin orchestration benefit.',
    },
  };
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  fs.writeFileSync(output, bytes, { mode: 0o600, flag: 'wx' });
  return { path: output, sha256: sha256(bytes), table_counts: evidence.table_counts,
    observed_job_ids: observed, unmatched_observed_job_ids: unmatchedObservedJobIds,
    workspace_artifact_causality_proven: false };
}

export function verifyPluginStateExport({ workspaceDirectory, exportInfo, expectedIdentity } = {}) {
  if (!exportInfo || exportInfo.relative_path !== 'plugin-state-export.json' || typeof exportInfo.sha256 !== 'string') {
    throw new Error('plugin-state export reference is missing or malformed');
  }
  const workspaceStat = fs.lstatSync(workspaceDirectory);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) throw new Error('condition-local workspace must be a real directory, not a symlink');
  const workspace = fs.realpathSync(workspaceDirectory);
  const exportPath = path.resolve(workspace, exportInfo.relative_path);
  if (!exportPath.startsWith(`${workspace}${path.sep}`)) throw new Error('plugin-state export path escaped workspace');
  const exportStat = fs.lstatSync(exportPath);
  if (!exportStat.isFile() || exportStat.isSymbolicLink()) throw new Error('plugin-state export must be a regular non-symlink file');
  const realExportPath = fs.realpathSync(exportPath);
  if (!realExportPath.startsWith(`${workspace}${path.sep}`)) throw new Error('plugin-state export symlink escaped workspace');
  const bytes = fs.readFileSync(realExportPath);
  if (sha256(bytes) !== exportInfo.sha256) throw new Error('plugin-state export hash mismatch');
  const document = JSON.parse(bytes.toString('utf8'));
  if (document.protocol !== 'cos-plugin-state-export-v1') throw new Error('unexpected plugin-state export protocol');
  for (const [key, expected] of Object.entries(expectedIdentity ?? {})) {
    if (document.identity?.[key] !== expected) throw new Error(`plugin-state export identity mismatch: ${key}`);
  }
  if (!Array.isArray(document.unmatched_observed_job_ids) || document.unmatched_observed_job_ids.length) {
    throw new Error('observed plugin job IDs do not reconcile with the condition-local database');
  }
  if (document.reconciliation?.workspace_artifact_causality_proven !== false) {
    throw new Error('database export must not claim workspace artifact causality');
  }
  return { status: 'captured-not-causal', sha256: exportInfo.sha256,
    table_counts: document.table_counts, observed_job_ids: document.observed_job_ids,
    workspace_artifact_causality_proven: false,
    note: 'Private SQLite state was captured and identity-checked; it does not prove that plugin state caused scored workspace artifacts.' };
}

export { EXPORTED_TABLES };
