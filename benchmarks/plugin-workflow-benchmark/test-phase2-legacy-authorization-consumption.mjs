#!/usr/bin/env node
// Isolated adversarial tests for legacy one-shot authorization consumption.
// All modified authorization/spec/consumption files live in disposable temp
// repositories; no historical decision or consumption record is edited.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.NODE_ENV = 'test';
process.env.PHASE2_ALLOW_UNSIGNED_LEGACY_AUTHORIZATION_TEST_FIXTURES = '1';
const sourceFiles = [
  'phase2-approval-contract.mjs',
  'phase2-v38-execution-authorization.mjs',
  'scenario-execution-spec-v3.8-draft.json',
  'scenario-execution-spec-v3.8-case01-authorized-20261012-07.json',
  'phase2-case01-v3.8-execution-authorization-20261012-07.json'
];
const roots = new Set();
function makeFixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `phase2-auth-consume-${label}-`));
  roots.add(root);
  const target = path.join(root, 'benchmarks/plugin-workflow-benchmark');
  const consumptionDirectory = path.join(target, 'runs/phase2-test');
  fs.mkdirSync(consumptionDirectory, { recursive: true, mode: 0o700 });
  for (const name of sourceFiles) fs.copyFileSync(path.join(here, name), path.join(target, name));
  const recordPath = path.join(target, 'phase2-case01-v3.8-execution-authorization-20261012-07.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.output_path = 'benchmarks/plugin-workflow-benchmark/runs/phase2-test/output.json';
  record.consumption_record_path = 'benchmarks/plugin-workflow-benchmark/runs/phase2-test/consumption.json';
  record.consumption_status = 'fresh-not-yet-consumed';
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return {
    root,
    target,
    recordPath,
    consumptionPath: path.join(root, record.consumption_record_path),
    outputPath: path.join(root, record.output_path),
    modulePath: path.join(target, 'phase2-v38-execution-authorization.mjs'),
    moduleUrl: pathToFileURL(path.join(target, 'phase2-v38-execution-authorization.mjs')).href,
    authorizedSpecPath: path.join(target, 'scenario-execution-spec-v3.8-case01-authorized-20261012-07.json')
  };
}
async function importFixture(fixture) { return import(fixture.moduleUrl + `?fixture=${cryptoRandomSuffix()}`); }
function cryptoRandomSuffix() { return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function validateArgs(fixture, module, options = {}) {
  const specBytes = fs.readFileSync(fixture.authorizedSpecPath);
  return module.validatePhase2V38Authorization({ specPath: fixture.authorizedSpecPath, specBytes,
    caseId: 'CASE-01', outputPath: fixture.outputPath, ...options });
}
function writeRecord(fixture, patcher) {
  const record = JSON.parse(fs.readFileSync(fixture.recordPath, 'utf8'));
  const updated = patcher(record);
  fs.writeFileSync(fixture.recordPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  return updated;
}
function spawnConsumer(fixture, { runId, env = {} }) {
  const code = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const module = await import(${JSON.stringify(fixture.moduleUrl)});
    const modulePath = fileURLToPath(import.meta.url);
    const specBytes = fs.readFileSync(module.authorizedV38SpecPath);
    const root = path.resolve(path.dirname(module.authorizedV38SpecPath), '../..');
    const recordBytes = fs.readFileSync(module.v38AuthorizationRecordPath);
    const record = module.validatePhase2V38Authorization({
      specPath: module.authorizedV38SpecPath, specBytes, caseId: 'CASE-01',
      outputPath: path.resolve(root, JSON.parse(recordBytes.toString('utf8')).output_path), requireConsumed: false
    });
    try {
      module.consumePhase2V38Authorization({ record: record.record, consumptionPath: record.consumptionPath,
        runId: ${JSON.stringify(runId)}, outputPath: path.resolve(root, record.record.output_path) });
      process.stdout.write('CONSUMED:${runId}\\n');
    } catch (error) {
      process.stderr.write('CONSUME_REJECTED:' + String(error?.message || error) + '\\n');
      process.exitCode = 17;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: fixture.root,
    env: { ...process.env, NODE_ENV: 'test', PHASE2_ALLOW_UNSIGNED_LEGACY_AUTHORIZATION_TEST_FIXTURES: '1',
      WORKFLOW_DB: path.join(fixture.root, 'unused.db'), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}

try {
  // Exact-schema, duplicate-key, hash, prohibited-scope and dangling-link
  // mutations operate on a copy of a consumed historical token, never the
  // actual repository's historical authorization or consumption files.
  {
    const fixture = makeFixture('mutants');
    const module = await importFixture(fixture);
    const originalRecord = fs.readFileSync(fixture.recordPath);
    assert.equal(validateArgs(fixture, module).record.decision_id, module.PHASE2_V38_AUTHORIZATION_ID);

    // Even if a caller rewrites a disposable historical record's output and
    // consumption paths and resets its status, production must not mistake
    // mutable unsigned JSON for a newly issued authorization.
    const productionCheck = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';import path from 'node:path';
      const m=await import(${JSON.stringify(fixture.moduleUrl)});
      const r=JSON.parse(fs.readFileSync(m.v38AuthorizationRecordPath,'utf8'));
      try { m.validatePhase2V38Authorization({specPath:m.authorizedV38SpecPath,specBytes:fs.readFileSync(m.authorizedV38SpecPath),caseId:'CASE-01',outputPath:path.resolve(path.dirname(m.authorizedV38SpecPath),'../..',r.output_path)}); process.exit(0); }
      catch (e) { if (/audit-only|trusted authority/.test(String(e.message))) { console.log('BLOCKED_UNSIGNED_LEGACY_AUTHORITY:'+e.message); process.exit(42); } throw e; }
    `], { cwd: fixture.root, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'production', PHASE2_ALLOW_UNSIGNED_LEGACY_AUTHORIZATION_TEST_FIXTURES: '',
      WORKFLOW_DB: path.join(fixture.root, 'unused.db')
    } });
    assert.equal(productionCheck.status, 42, `production must reject unsigned legacy authorization after path substitution: ${productionCheck.stderr}`);
    assert.match(productionCheck.stdout, /BLOCKED_UNSIGNED_LEGACY_AUTHORITY/);

    writeRecord(fixture, record => ({ ...record, unreviewed_extension: false }));
    assert.throws(() => validateArgs(fixture, module), /unknown or missing top-level keys/,
      'unknown top-level authorization key must be rejected');
    fs.writeFileSync(fixture.recordPath, originalRecord, { mode: 0o600 });

    writeRecord(fixture, record => ({ ...record, scope: { ...record.scope, unreviewed_extension: false } }));
    assert.throws(() => validateArgs(fixture, module), /scope has unknown or missing keys/,
      'unknown nested authorization scope key must be rejected');
    fs.writeFileSync(fixture.recordPath, originalRecord, { mode: 0o600 });

    writeRecord(fixture, record => ({ ...record, scope: { ...record.scope, external_network: true } }));
    assert.throws(() => validateArgs(fixture, module), /prohibited scope external_network must be explicitly false/,
      'legacy authorization must not enable external network access');
    fs.writeFileSync(fixture.recordPath, originalRecord, { mode: 0o600 });

    const symlinkPath = path.join(path.dirname(fixture.consumptionPath), 'dangling.json');
    fs.symlinkSync(path.join(path.dirname(fixture.consumptionPath), 'missing.json'), symlinkPath);
    writeRecord(fixture, record => ({ ...record, consumption_record_path: path.relative(fixture.root, symlinkPath).split(path.sep).join('/') }));
    assert.throws(() => validateArgs(fixture, module), /symlink or non-regular file/,
      'dangling symlink at the one-shot consumption path must not be treated as an absent file');
    fs.unlinkSync(symlinkPath);
    fs.writeFileSync(fixture.recordPath, originalRecord, { mode: 0o600 });

    const validated = validateArgs(fixture, module);
    module.consumePhase2V38Authorization({ record: validated.record, consumptionPath: validated.consumptionPath,
      runId: 'fixture-consumption-run-1', outputPath: fixture.outputPath });
    const canonicalConsumption = fs.readFileSync(fixture.consumptionPath);
    assert.equal(module.validatePhase2V38Authorization({ specPath: fixture.authorizedSpecPath,
      specBytes: fs.readFileSync(fixture.authorizedSpecPath), caseId: 'CASE-01', outputPath: fixture.outputPath,
      runId: 'fixture-consumption-run-1', requireConsumed: true }).record.decision_id, module.PHASE2_V38_AUTHORIZATION_ID);

    const wrongHash = JSON.parse(canonicalConsumption.toString('utf8'));
    wrongHash.source_spec_sha256 = 'd'.repeat(64);
    fs.writeFileSync(fixture.consumptionPath, `${JSON.stringify(wrongHash, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => module.validatePhase2V38Authorization({ specPath: fixture.authorizedSpecPath,
      specBytes: fs.readFileSync(fixture.authorizedSpecPath), caseId: 'CASE-01', outputPath: fixture.outputPath,
      runId: 'fixture-consumption-run-1', requireConsumed: true }), /consumption source hash is detached/,
    'durable consumption must bind the exact source bytes authorized by its decision');

    fs.writeFileSync(fixture.consumptionPath, canonicalConsumption, { mode: 0o600 });
    const duplicateJson = canonicalConsumption.toString('utf8').replace('"case_id": "CASE-01"', '"case_id": "CASE-01",\n  "case_id": "CASE-01"');
    assert.notEqual(duplicateJson, canonicalConsumption.toString('utf8'));
    fs.writeFileSync(fixture.consumptionPath, duplicateJson, { mode: 0o600 });
    assert.throws(() => module.validatePhase2V38Authorization({ specPath: fixture.authorizedSpecPath,
      specBytes: fs.readFileSync(fixture.authorizedSpecPath), caseId: 'CASE-01', outputPath: fixture.outputPath,
      runId: 'fixture-consumption-run-1', requireConsumed: true }), /duplicate decoded object key "case_id"/,
    'duplicate decoded keys in a durable consumption record must fail strict decoding');
    fs.writeFileSync(fixture.consumptionPath, canonicalConsumption, { mode: 0o600 });
    assert.throws(() => module.validatePhase2V38Authorization({ specPath: fixture.authorizedSpecPath,
      specBytes: fs.readFileSync(fixture.authorizedSpecPath), caseId: 'CASE-01', outputPath: fixture.outputPath,
      runId: 'fixture-consumption-run-2', requireConsumed: true }), /consumption record run ID|already consumed/i,
    'consumption from another run cannot satisfy the current caller');
    console.log('LEGACY AUTHORIZATION UNKNOWN-KEY / PROHIBITED-SCOPE / SYMLINK / EXACT-CONSUMPTION-HASH REGRESSIONS PASS');
  }

  // Two independent processes both validate a fresh one-shot token and pause
  // immediately before exclusive create. Exactly one must create the durable
  // consumption file; the other must fail closed without overwriting it.
  {
    const fixture = makeFixture('concurrent');
    const barrier = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-auth-consumption-barrier-'));
    roots.add(barrier);
    const children = [
      spawnConsumer(fixture, { runId: 'concurrent-consumer-A', env: { PHASE2_TEST_AUTH_CONSUMPTION_BARRIER_DIR: barrier } }),
      spawnConsumer(fixture, { runId: 'concurrent-consumer-B', env: { PHASE2_TEST_AUTH_CONSUMPTION_BARRIER_DIR: barrier } })
    ];
    const readyPaths = children.map(({ child }) => path.join(barrier, `${child.pid}.ready`));
    const deadline = Date.now() + 15000;
    while (!readyPaths.every(candidate => fs.existsSync(candidate))) {
      if (Date.now() > deadline) throw new Error('both one-shot consumers did not reach the pre-write barrier');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    fs.writeFileSync(path.join(barrier, 'release'), 'release\n', { flag: 'wx', mode: 0o600 });
    const outcomes = await Promise.all(children.map(item => item.done));
    assert.equal(outcomes.filter(item => item.code === 0 && item.stdout.includes('CONSUMED:')).length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter(item => item.code === 17 || (item.code !== 0 && item.signal === null)).length, 1, JSON.stringify(outcomes));
    const record = JSON.parse(fs.readFileSync(fixture.consumptionPath, 'utf8'));
    assert.ok(['concurrent-consumer-A', 'concurrent-consumer-B'].includes(record.run_id));
    assert.equal(record.source_spec_sha256, JSON.parse(fs.readFileSync(fixture.recordPath, 'utf8')).source_spec_sha256);
    assert.equal(record.authorized_execution_spec_sha256, JSON.parse(fs.readFileSync(fixture.recordPath, 'utf8')).authorized_execution_spec_sha256);
    const module = await importFixture(fixture);
    assert.equal(module.validatePhase2V38Authorization({ specPath: fixture.authorizedSpecPath,
      specBytes: fs.readFileSync(fixture.authorizedSpecPath), caseId: 'CASE-01', outputPath: fixture.outputPath,
      runId: record.run_id, requireConsumed: true }).record.decision_id, module.PHASE2_V38_AUTHORIZATION_ID);
    assert.throws(() => module.validatePhase2V38Authorization({ specPath: fixture.authorizedSpecPath,
      specBytes: fs.readFileSync(fixture.authorizedSpecPath), caseId: 'CASE-01', outputPath: fixture.outputPath,
      requireConsumed: false }), /already been consumed|pre-existing path entry/);
    console.log('LEGACY AUTHORIZATION TWO-PROCESS ONE-SHOT CONSUMPTION RACE PASS');
  }

  // Killing a consumer after the fsynced write but before its success response
  // leaves a verifiable consumed record. Recovery may read it, but it must not
  // treat the missing process response as permission to consume again.
  {
    const fixture = makeFixture('crash-after-write');
    const child = spawnConsumer(fixture, { runId: 'crash-after-write-run', env: {
      PHASE2_TEST_AUTH_CONSUMPTION_CRASH_AFTER_WRITE: 'SIGKILL'
    } });
    const outcome = await child.done;
    assert.equal(outcome.signal, 'SIGKILL', `consumer should terminate after durable write: ${JSON.stringify(outcome)}`);
    const bytes = fs.readFileSync(fixture.consumptionPath);
    assert.ok(bytes.length > 0);
    const module = await importFixture(fixture);
    const recovered = module.validatePhase2V38Authorization({ specPath: fixture.authorizedSpecPath,
      specBytes: fs.readFileSync(fixture.authorizedSpecPath), caseId: 'CASE-01', outputPath: fixture.outputPath,
      runId: 'crash-after-write-run', requireConsumed: true });
    assert.equal(recovered.record.decision_id, module.PHASE2_V38_AUTHORIZATION_ID);
    const validated = module.validatePhase2V38Authorization({ specPath: fixture.authorizedSpecPath,
      specBytes: fs.readFileSync(fixture.authorizedSpecPath), caseId: 'CASE-01', outputPath: fixture.outputPath,
      runId: 'crash-after-write-run', requireConsumed: true });
    assert.throws(() => module.consumePhase2V38Authorization({ record: validated.record,
      consumptionPath: validated.consumptionPath, runId: 'retry-after-crash-run', outputPath: fixture.outputPath }),
    /already been consumed|pre-existing path entry/,
    'a missing process response cannot reopen an already fsynced one-shot consumption');
    console.log('LEGACY AUTHORIZATION SIGKILL AFTER FSYNC / DURABLE READBACK / NO REPLAY PASS');
  }

  // Killing a validator/consumer while it is waiting before exclusive create
  // must leave the token unused and safe for a later consumer.
  {
    const fixture = makeFixture('crash-before-write');
    const barrier = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-auth-consumption-prewrite-'));
    roots.add(barrier);
    const child = spawnConsumer(fixture, { runId: 'crash-before-write-run', env: { PHASE2_TEST_AUTH_CONSUMPTION_BARRIER_DIR: barrier } });
    const readyPath = path.join(barrier, `${child.child.pid}.ready`);
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(readyPath)) {
      if (Date.now() > deadline) throw new Error('consumer did not reach the pre-write crash barrier');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    child.child.kill('SIGKILL');
    const outcome = await child.done;
    assert.equal(outcome.signal, 'SIGKILL');
    assert.equal(fs.existsSync(fixture.consumptionPath), false, 'pre-write crash must not leave a consumption file');
    const module = await importFixture(fixture);
    const validated = validateArgs(fixture, module);
    module.consumePhase2V38Authorization({ record: validated.record, consumptionPath: validated.consumptionPath,
      runId: 'safe-retry-after-prewrite-crash', outputPath: fixture.outputPath });
    assert.equal(JSON.parse(fs.readFileSync(fixture.consumptionPath, 'utf8')).run_id, 'safe-retry-after-prewrite-crash');
    console.log('LEGACY AUTHORIZATION SIGKILL BEFORE CREATE / RETRY SAME TOKEN PASS');
  }

  console.log('test-phase2-legacy-authorization-consumption: PASS');
} finally {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}
