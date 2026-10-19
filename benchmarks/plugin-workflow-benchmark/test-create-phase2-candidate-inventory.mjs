import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSafePortableArchivePath } from './phase2-zip-entry-type-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
for (const unsafe of ['C:/outside.txt', 'c:outside.txt', 'D:/a/../outside.txt', '../outside.txt', '/absolute.txt']) {
  assert.equal(isSafePortableArchivePath(unsafe), false, `portable archive path validator must reject ${unsafe}`);
}
assert.equal(isSafePortableArchivePath('src/runtime/strict-json.js'), true);
const script = path.join(root, 'benchmarks/plugin-workflow-benchmark/create-phase2-candidate-inventory.mjs');
// Prefer a caller-pinned candidate; otherwise try candidates newest-first until
// one proves exact current-source lineage. Historical candidates intentionally
// remain in dist and must not make this regression fail merely because they are
// stale relative to a newer dirty-tree implementation.
const bundleCandidates = process.env.PHASE2_CANDIDATE_BUNDLE
  ? [process.env.PHASE2_CANDIDATE_BUNDLE]
  : fs.readdirSync(path.join(root, 'dist'))
    .filter(name => /^runalith-.*-candidate-.*\.mcpb$/.test(name))
    .map(name => `dist/${name}`)
    .sort((left, right) => fs.statSync(path.join(root, right)).mtimeMs - fs.statSync(path.join(root, left)).mtimeMs);
const outDir = path.join(root, 'benchmarks/plugin-workflow-benchmark');
const output = path.join(outDir, `.inventory-builder-regression-${process.pid}.json`);
const symlinkParent = path.join(outDir, `.inventory-builder-symlink-${process.pid}`);
const traversalOutput = `${output}.traversal`;
const symlinkOutput = path.join(outDir, `symlink-output-${process.pid}.json`);
for (const destination of [output, symlinkParent, traversalOutput, symlinkOutput]) {
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
    throw new Error(`refusing to run inventory regression because its unique destination already exists: ${destination}`);
  }
}
const run = (bundleArg, outputArg) => spawnSync(process.execPath, [script, bundleArg, outputArg], { cwd: root, encoding: 'utf8' });
let outputCreatedByThisTest = false;
let symlinkParentCreatedByThisTest = false;

try {
  let bundle = null;
  let good = null;
  for (const candidate of bundleCandidates) {
    const attempt = run(candidate, path.relative(root, output));
    if (attempt.status === 0) {
      bundle = candidate;
      good = attempt;
      outputCreatedByThisTest = true;
      break;
    }
  }
  assert.ok(bundle && good, `no candidate has exact current-source lineage; tried ${bundleCandidates.length} candidates`);
  assert.equal(good.status, 0, `valid candidate should produce inventory: ${good.stderr}`);
  const inventory = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(inventory.status, 'candidate-unapproved-review-evidence-only');
  assert.equal(inventory.entries.length, 37, 'the packaged runtime closure must include the strict JSON parser, pinned behavioral QA harness, current runtime metadata closure, and all three shutdown regressions');
  assert.ok(inventory.entries.some(entry => entry.path === 'src/runtime/strict-json.js'), 'candidate inventory must bind exact bytes for the shipped strict JSON parser');
  assert.equal(inventory.bundle.sha256, (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(root, bundle))).digest('hex'));
  const packageEntry = inventory.entries.find(entry => entry.path === 'package.json');
  assert.equal(packageEntry?.source_derivation, 'runtime-metadata-projection-v1',
    'package.json must be explicitly inventoried as a generated local-runtime metadata projection');
  assert.equal(packageEntry?.source_input_sha256,
    (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(root, 'package.json'))).digest('hex'),
    'runtime metadata projection must bind the full repository package.json input');
  const packagedMetadataResult = spawnSync('unzip', ['-p', path.join(root, bundle), 'package.json'], { encoding: 'utf8' });
  assert.equal(packagedMetadataResult.status, 0, 'candidate must contain readable package metadata');
  const packagedMetadata = JSON.parse(packagedMetadataResult.stdout);
  assert.equal(packagedMetadata.main, 'server/index.js');
  assert.equal(packagedMetadata.engines?.node, '>=22.13.0');
  assert.equal(Object.hasOwn(packagedMetadata, 'dependencies'), false,
    'local-only runtime metadata must not declare the excluded LangGraph dependency');
  assert.deepEqual(Object.keys(packagedMetadata.scripts).sort(), ['start', 'test'],
    'packaged scripts must not refer to omitted source-only tests or workflows');

  const overwrite = run(bundle, path.relative(root, output));
  assert.notEqual(overwrite.status, 0, 'existing inventory output must not be overwritten');

  const traversal = run('../../etc/passwd', path.relative(root, traversalOutput));
  assert.notEqual(traversal.status, 0, 'bundle path traversal outside repository must fail');
  assert.equal(fs.existsSync(traversalOutput), false, 'unsafe bundle path must not produce output');

  fs.symlinkSync(outDir, symlinkParent, 'dir');
  symlinkParentCreatedByThisTest = true;
  const symlinkedParent = run(bundle, path.relative(root, path.join(symlinkParent, path.basename(symlinkOutput))));
  assert.notEqual(symlinkedParent.status, 0, 'symlinked output parent must fail closed');
  assert.equal(fs.existsSync(symlinkOutput), false, 'symlinked parent must not produce output');

  // Exercise source-side symlink handling in an isolated miniature repository.
  // The archive bytes deliberately match the symlink target, so only an
  // lstat/realpath source check (not a byte comparison) can reject this lineage.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `inventory-source-symlink-${process.pid}-`));
  try {
    const fixtureBuilderDir = path.join(fixtureRoot, 'benchmarks/plugin-workflow-benchmark');
    const fixturePluginDir = path.join(fixtureRoot, 'plugin');
    const fixtureDist = path.join(fixtureRoot, 'dist');
    const fixtureScriptsDir = path.join(fixtureRoot, 'scripts');
    const fixtureStrictJson = path.join(fixtureRoot, 'src/runtime/strict-json.js');
    const payload = path.join(fixtureRoot, 'payload');
    fs.mkdirSync(fixtureBuilderDir, { recursive: true });
    fs.mkdirSync(fixturePluginDir, { recursive: true });
    fs.mkdirSync(fixtureDist, { recursive: true });
    fs.mkdirSync(fixtureScriptsDir, { recursive: true });
    fs.mkdirSync(path.dirname(fixtureStrictJson), { recursive: true });
    fs.mkdirSync(payload);
    fs.copyFileSync(script, path.join(fixtureBuilderDir, 'create-phase2-candidate-inventory.mjs'));
    fs.copyFileSync(path.join(outDir, 'phase2-zip-entry-type-safety.mjs'), path.join(fixtureBuilderDir, 'phase2-zip-entry-type-safety.mjs'));
    fs.copyFileSync(path.join(root, 'scripts/plugin-package-metadata.mjs'), path.join(fixtureScriptsDir, 'plugin-package-metadata.mjs'));
    fs.copyFileSync(path.join(root, 'src/runtime/strict-json.js'), fixtureStrictJson);
    fs.writeFileSync(path.join(fixturePluginDir, 'manifest.json'), '{"name":"fixture","tools":[]}\n');
    const externalSource = path.join(fixtureRoot, 'external-readme.md');
    fs.writeFileSync(externalSource, 'external README bytes\n');
    fs.symlinkSync(externalSource, path.join(fixtureRoot, 'README.md'));
    fs.writeFileSync(path.join(payload, 'README.md'), fs.readFileSync(externalSource));
    fs.writeFileSync(path.join(payload, 'manifest.json'), fs.readFileSync(path.join(fixturePluginDir, 'manifest.json')));
    const fixtureBundle = path.join(fixtureDist, 'candidate.mcpb');
    const zipped = spawnSync('zip', ['-q', fixtureBundle, 'README.md', 'manifest.json'], { cwd: payload, encoding: 'utf8' });
    assert.equal(zipped.status, 0, `fixture archive should build: ${zipped.stderr}`);
    const fixtureOutput = path.join(fixtureBuilderDir, 'inventory.json');
    const unsafeSource = spawnSync(process.execPath, [path.join(fixtureBuilderDir, 'create-phase2-candidate-inventory.mjs'), 'dist/candidate.mcpb', 'benchmarks/plugin-workflow-benchmark/inventory.json'], { cwd: fixtureRoot, encoding: 'utf8' });
    assert.notEqual(unsafeSource.status, 0, 'inventory must reject source symlinks even when archive bytes match their targets');
    assert.match(unsafeSource.stderr, /source path is missing or contains a symlink: README\.md/);
    assert.equal(fs.existsSync(fixtureOutput), false, 'unsafe source lineage must not publish an inventory');

    // A drive-prefixed archive name is a host-absolute/drive-relative path on
    // Windows even though POSIX path.resolve treats it as a relative component.
    // Make the malicious source bytes exist too, so the archive must be rejected
    // by portable path policy rather than merely by missing-source detection.
    fs.unlinkSync(path.join(fixtureRoot, 'README.md'));
    fs.writeFileSync(path.join(fixtureRoot, 'README.md'), 'external README bytes\n', { flag: 'wx' });
    fs.mkdirSync(path.join(fixtureRoot, 'C:'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'C:', 'outside.txt'), 'portable path attack\n', { flag: 'wx' });
    fs.mkdirSync(path.join(payload, 'C:'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'C:', 'outside.txt'), 'portable path attack\n', { flag: 'wx' });
    const drivePathBundle = path.join(fixtureDist, 'drive-path.mcpb');
    const driveZip = spawnSync('zip', ['-q', drivePathBundle, 'README.md', 'manifest.json', 'C:/outside.txt'], { cwd: payload, encoding: 'utf8' });
    assert.equal(driveZip.status, 0, `drive-path archive fixture should build: ${driveZip.stderr}`);
    const driveInventoryPath = path.join(fixtureBuilderDir, 'drive-path-inventory.json');
    const driveInventory = spawnSync(process.execPath, [path.join(fixtureBuilderDir, 'create-phase2-candidate-inventory.mjs'), 'dist/drive-path.mcpb', 'benchmarks/plugin-workflow-benchmark/drive-path-inventory.json'], { cwd: fixtureRoot, encoding: 'utf8' });
    assert.notEqual(driveInventory.status, 0, 'inventory builder must reject Windows drive-prefixed archive names on POSIX');
    assert.match(driveInventory.stderr, /unsafe entry paths/);
    assert.equal(fs.existsSync(driveInventoryPath), false, 'unsafe drive-prefixed archive must not publish an inventory');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
  console.log('PASS: inventory builder binds exact source bytes and refuses source symlinks, overwrite, traversal and symlinked output parents');
} finally {
  if (outputCreatedByThisTest) fs.rmSync(output, { force: true });
  if (symlinkParentCreatedByThisTest) fs.rmSync(symlinkParent, { recursive: true, force: true });
}
