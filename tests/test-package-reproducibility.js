import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateZipEntryTypes } from '../benchmarks/plugin-workflow-benchmark/phase2-zip-entry-type-safety.mjs';
import { serializePluginPackageMetadata } from '../scripts/plugin-package-metadata.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/package-runalith-mcpb.sh');
const packagerSource = fs.readFileSync(script, 'utf8');
assert.ok(packagerSource.includes('RUNALITH_DATA_DIR="$SMOKE_DATA_DIR"'), 'packager MCP smoke must isolate the Runalith data directory');
assert.ok(packagerSource.includes('RUNALITH_WORKFLOW_DB="$SMOKE_DB_PATH"'), 'packager MCP smoke must isolate the Runalith database');
assert.ok(packagerSource.includes('RUNALITH_EXECUTION_TMP_DIR="$SMOKE_DATA_DIR/runtime"'), 'packager MCP smoke must isolate Runalith execution temp');
assert.ok(packagerSource.includes('RUNALITH_WORKSPACE="$EXTRACTED"'), 'packager MCP smoke must isolate the Runalith workspace');
assert.match(packagerSource, /WORKFLOW_DB="\$SMOKE_DB_PATH"/, 'packager MCP smoke must isolate the legacy workflow DB override as well');
assert.match(packagerSource, /WORKFLOW_DATA_DIR="\$SMOKE_DATA_DIR"/, 'packager MCP smoke must isolate the SQLite parent directory');
assert.match(packagerSource, /SMOKE_ROOT="\$\(mktemp -d/, 'MCP smoke SQLite state must live outside a potentially shared checkout parent');
assert.doesNotMatch(packagerSource, /SMOKE_DATA_DIR="\$EXTRACTED\/\.smoke-data"/, 'MCP smoke state must not be placed beneath the extracted bundle path');
assert.match(packagerSource, /unzip -q \"\$BUNDLE\" -d \"\$EXTRACTED\"/, 'packager must extract the completed archive before running MCP smoke/E2E');
assert.match(packagerSource, /node \"\$EXTRACTED\/server\/index\.js\"/, 'MCP handshake must use the archive-extracted server bytes');
assert.match(packagerSource, /node \"\$EXTRACTED\/tests\/test-runalith-plugin\.js\"/, 'full local MCP E2E must use archive-extracted test/runtime bytes');
assert.doesNotMatch(packagerSource, /node \"\$PAYLOAD\/(?:server\/index\.js|tests\/test-runalith-plugin\.js)\"/, 'packager must not substitute the pre-archive staging tree for packaged E2E');
assert.match(packagerSource, /test-extracted-package-tool-schemas\.mjs/, 'packager must validate schemas from the exact candidate archive');
assert.match(packagerSource, /plugin-package-metadata\.mjs/, 'packager must project full-app metadata into the local-only runtime dependency closure');
const serverSource = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
assert.match(serverSource, /getSpecialistRoleGuidance\(contract\.role\)/, 'built-in specialist prompt builder must wire the role-specific guidance helper');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-reproducibility-'));
const outputs = [path.join(temp, 'first.mcpb'), path.join(temp, 'second.mcpb')];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Fingerprint the actual package inputs (the explicit payload roots plus the
// runtime dependency closure collected by the production collector) before
// and after each build. Comparing only the resulting archives would not prove
// that both builds consumed the same source state if a file changed between
// invocations. The packager and collector themselves are inputs too.
function packageInputSnapshot(label) {
  const stage = path.join(temp, `source-${label}`);
  fs.mkdirSync(stage);
  const explicit = [
    'README.md', 'LICENSE', 'plugin/manifest.json',
    'tests/test-runalith-plugin.js',
    'tests/test-mcp-stdio-backpressure.mjs',
    'tests/test-mcp-graceful-signal-shutdown-20261017.js',
    'tests/test-mcp-shutdown-backpressure-deadline-20261017.js',
    'tests/test-mcp-eof-shutdown-framing-20261017.js',
    'tests/test-production-behavioral-qa.js',
    'scripts/package-runalith-mcpb.sh',
    'scripts/collect-plugin-runtime.mjs',
    'scripts/plugin-package-metadata.mjs',
  ];
  // These files are executed by the packager to decide whether publication is
  // safe, but are deliberately not part of the archive payload. Bind their
  // bytes into the build-input fingerprint separately from packaged entries.
  const validationSources = [
    'tests/test-extracted-package-tool-schemas.mjs',
    'tests/test-execution-lease-fencing.js',
    'tests/test-temp-dir.js',
  ];
  for (const relative of validationSources) {
    const sourcePath = path.join(root, relative);
    const stat = fs.lstatSync(sourcePath);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(sourcePath) === sourcePath,
      `executed package validation source must be a canonical regular file: ${relative}`);
  }
  const collected = spawnSync(process.execPath, [path.join(root, 'scripts/collect-plugin-runtime.mjs'), root, stage], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(collected.status, 0, `runtime dependency closure must collect successfully:\n${collected.stdout}\n${collected.stderr}`);
  const files = new Map();
  for (const relative of explicit) files.set(relative, fs.readFileSync(path.join(root, relative)));
  const sourcePackageBytes = fs.readFileSync(path.join(root, 'package.json'));
  files.set('package.json', serializePluginPackageMetadata(JSON.parse(sourcePackageBytes.toString('utf8'))));
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = path.posix.join(prefix, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`package source closure contains symlink: ${relative}`);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) files.set(relative, fs.readFileSync(full));
      else throw new Error(`package source closure contains a special file: ${relative}`);
    }
  }
  walk(stage);
  const canonical = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const hash = crypto.createHash('sha256');
  for (const [relative, bytes] of canonical) {
    hash.update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0');
  }
  for (const relative of validationSources.sort()) {
    const bytes = fs.readFileSync(path.join(root, relative));
    hash.update('executed-validation-source\0').update(relative).update('\0')
      .update(String(bytes.length)).update('\0').update(bytes).update('\0');
  }
  // Bind the full source manifest too, even though the archive carries only its
  // intentionally reduced local-runtime projection.
  hash.update('repository-package-json-input\0').update(sourcePackageBytes).update('\0');
  return { hash: hash.digest('hex'), files: canonical };
}

function archiveEntries(file) {
  const archiveBytes = fs.readFileSync(file);
  validateZipEntryTypes(archiveBytes);
  // The archive is part of the reproducible build identity, including Unix
  // permission bits. Ambient umask must not leak into ZIP central-directory
  // attributes even when every entry payload is byte-identical.
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = archiveBytes.lastIndexOf(eocdSignature);
  assert.ok(eocd >= 0, 'ZIP end-of-central-directory record must exist');
  const centralCount = archiveBytes.readUInt16LE(eocd + 10);
  let centralCursor = archiveBytes.readUInt32LE(eocd + 16);
  for (let index = 0; index < centralCount; index++) {
    assert.equal(archiveBytes.readUInt32LE(centralCursor), 0x02014b50, 'central-directory record must be valid');
    const nameLength = archiveBytes.readUInt16LE(centralCursor + 28);
    const extraLength = archiveBytes.readUInt16LE(centralCursor + 30);
    const commentLength = archiveBytes.readUInt16LE(centralCursor + 32);
    const name = archiveBytes.subarray(centralCursor + 46, centralCursor + 46 + nameLength).toString('utf8');
    const externalAttributes = archiveBytes.readUInt32LE(centralCursor + 38);
    const unixMode = (externalAttributes >>> 16) & 0o777;
    assert.equal(unixMode, 0o644, `archive entry mode must be normalized to 0644 regardless of umask: ${name}`);
    centralCursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(centralCursor, archiveBytes.readUInt32LE(eocd + 16) + archiveBytes.readUInt32LE(eocd + 12),
    'central-directory records must exactly fill the declared directory range');
  const listed = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' });
  assert.equal(listed.status, 0, `archive entry listing must succeed: ${listed.stderr}`);
  const names = listed.stdout.trim().split(/\r?\n/);
  assert.equal(new Set(names).size, names.length, 'archive must not contain duplicate entry names');
  assert.deepEqual(names, [...names].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), 'archive entries must be in canonical bytewise path order');
  const extracted = new Map();
  for (const name of names) {
    const entry = spawnSync('unzip', ['-p', file, name], { encoding: null, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(entry.status, 0, `archive entry must be readable: ${name}`);
    extracted.set(name, entry.stdout);
  }
  return { names, extracted };
}

function buildEnvironmentSnapshot() {
  const command = (name, args) => {
    const result = spawnSync(name, args, { cwd: root, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, `build environment probe must succeed: ${name} ${args.join(' ')}\n${result.stderr}`);
    return `${result.stdout || ''}${result.stderr || ''}`.trim();
  };
  const dependencyTree = JSON.parse(command('npm', ['ls', '@langchain/langgraph', '--depth=0', '--json']));
  const dependencyFiles = [
    'package.json', 'package-lock.json', 'pnpm-lock.yaml',
    'benchmarks/plugin-workflow-benchmark/phase2-dependency-sbom-20261013.cdx.json',
  ];
  return {
    node: command(process.execPath, ['--version']),
    npm: command('npm', ['--version']),
    zip: command('zip', ['-v']).split(/\r?\n/).slice(0, 3).join('\n'),
    unzip: command('unzip', ['-v']).split(/\r?\n/).slice(0, 3).join('\n'),
    find: command('find', ['--version']).split(/\r?\n/)[0],
    touch: command('touch', ['--version']).split(/\r?\n/)[0],
    platform: command('uname', ['-srmo']),
    langgraph_tree: dependencyTree.dependencies?.['@langchain/langgraph'] ?? null,
    dependency_file_sha256: Object.fromEntries(dependencyFiles.map(relative => [relative, digest(fs.readFileSync(path.join(root, relative)))])),
  };
}

try {
  // The inventory/readiness type guard must reject symlink entries even when
  // their stored link target is ordinary text and the entry path is benign.
  const zipTypeDir = path.join(temp, 'zip-entry-type-fixture');
  fs.mkdirSync(zipTypeDir);
  fs.symlinkSync('README.md', path.join(zipTypeDir, 'README.md'));
  const symlinkArchive = path.join(zipTypeDir, 'symlink.mcpb');
  const symlinkZipResult = spawnSync('zip', ['-q', '-y', symlinkArchive, 'README.md'], { cwd: zipTypeDir, encoding: 'utf8' });
  assert.equal(symlinkZipResult.status, 0, `symlink ZIP fixture should build: ${symlinkZipResult.stderr}`);
  assert.throws(() => validateZipEntryTypes(fs.readFileSync(symlinkArchive)), /symlink or special entry/,
    'archive validator must reject Unix symlink entries before trusting their bytes');
  const specialArchiveBytes = fs.readFileSync(symlinkArchive);
  const centralEntryOffset = specialArchiveBytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralEntryOffset >= 0, 'special-file fixture must contain a central directory entry');
  const originalAttributes = specialArchiveBytes.readUInt32LE(centralEntryOffset + 38);
  const fifoMode = (0x1000 | 0o644) << 16;
  specialArchiveBytes.writeUInt32LE(fifoMode >>> 0, centralEntryOffset + 38);
  assert.throws(() => validateZipEntryTypes(specialArchiveBytes), /symlink or special entry/,
    'archive validator must reject special-file mode bits before interpreting entry data');
  specialArchiveBytes.writeUInt32LE(originalAttributes, centralEntryOffset + 38);

  const sourceBefore = packageInputSnapshot('before');
  const environmentBefore = buildEnvironmentSnapshot();
  for (const [index, output] of outputs.entries()) {
    const buildArgs = index === 0
      ? ['-c', 'umask 022; exec bash "$1"', 'package-reproducibility', script]
      : ['-c', 'umask 077; exec bash "$1"', 'package-reproducibility', script];
    const result = spawnSync('bash', buildArgs, {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PLUGIN_BUNDLE_OUT: output },
    });
    assert.equal(result.status, 0, `candidate build must pass before reproducibility comparison:\n${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(output), true, 'validated archive must be published at its unique output path');
    assert.equal(packageInputSnapshot(`after-${path.basename(output, '.mcpb')}`).hash, sourceBefore.hash,
      'packaging inputs must remain byte-identical across each build, not merely have equal output metadata');
    assert.deepEqual(buildEnvironmentSnapshot(), environmentBefore,
      'toolchain, resolved runtime dependency tree, lockfiles, and SBOM must remain identical across builds');
  }
  const first = fs.readFileSync(outputs[0]);
  const second = fs.readFileSync(outputs[1]);
  assert.equal(digest(first), digest(second), 'same source bytes and toolchain must yield bit-for-bit identical MCPB archives');
  assert.deepEqual(first, second, 'archive byte comparison must agree with SHA-256 equality');
  const firstArchive = archiveEntries(outputs[0]);
  const secondArchive = archiveEntries(outputs[1]);
  assert.deepEqual(firstArchive.names, secondArchive.names, 'independent builds must have identical ordered payload entry names');
  const expectedArchiveNames = new Set(sourceBefore.files.map(([relative]) => {
    if (relative === 'plugin/manifest.json') return 'manifest.json';
    if (relative === 'scripts/package-runalith-mcpb.sh' || relative === 'scripts/collect-plugin-runtime.mjs' ||
        relative === 'scripts/plugin-package-metadata.mjs') return null;
    return relative;
  }).filter(Boolean));
  assert.deepEqual(new Set(firstArchive.names), expectedArchiveNames,
    'archive path set must exactly equal the package roots plus collected runtime closure (no omitted or unexpected entries)');
  for (const name of firstArchive.names) {
    assert.ok(name && !name.startsWith('/') && !name.startsWith('-') && !name.includes('\\') &&
      !/[\u0000-\u001f\u007f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'),
    `archive must contain only safe relative unique paths: ${JSON.stringify(name)}`);
  }
  for (const [relative, bytes] of sourceBefore.files) {
    if (!firstArchive.extracted.has(relative)) continue;
    assert.deepEqual(firstArchive.extracted.get(relative), bytes, `packaged entry must match exact source bytes: ${relative}`);
    assert.deepEqual(secondArchive.extracted.get(relative), bytes, `second packaged entry must match exact source bytes: ${relative}`);
  }
  assert.equal(firstArchive.names.length, 45,
    'candidate payload must include the strict JSON parser dependency, hybrid workflow catalog/definition, pinned role-profile and policy runtime modules, packaged MCP stdio backpressure and shutdown regressions, pinned production behavioral QA harness, and exact runtime closure');
  assert.ok(firstArchive.extracted.has('src/runtime/strict-json.js'), 'strict JSON consumer hardening must ship its parser dependency in the MCP bundle');
  assert.ok(firstArchive.extracted.has('src/runtime/workflow/specialist-role-guidance.js'), 'the runtimePrefix-loaded specialist prompt helper must ship in the extracted MCP bundle');

  // Exercise the collector against a disposable source tree containing a
  // side-effect-only static import. The package source closure must include
  // that module even though it has no `from` clause or dynamic import call.
  const fixtureRoot = path.join(temp, 'side-effect-import-fixture');
  const fixtureStage = path.join(temp, 'side-effect-import-stage');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  for (const directory of ['server', 'src', 'protocol']) {
    fs.cpSync(path.join(root, directory), path.join(fixtureRoot, directory), { recursive: true, dereference: false });
  }
  fs.mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/collect-plugin-runtime.mjs'), path.join(fixtureRoot, 'scripts/collect-plugin-runtime.mjs'));
  fs.writeFileSync(path.join(fixtureRoot, 'server/collector-side-effect-fixture.js'), 'globalThis.__collectorSideEffectFixture = true;\n', { flag: 'wx' });
  fs.appendFileSync(path.join(fixtureRoot, 'server/index.js'), "\nimport './collector-side-effect-fixture.js';\n");
  const sideEffectCollect = spawnSync(process.execPath, [path.join(fixtureRoot, 'scripts/collect-plugin-runtime.mjs'), fixtureRoot, fixtureStage], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(sideEffectCollect.status, 0, `collector must follow side-effect-only imports:\n${sideEffectCollect.stdout}\n${sideEffectCollect.stderr}`);
  assert.equal(fs.readFileSync(path.join(fixtureStage, 'server/collector-side-effect-fixture.js'), 'utf8'),
    'globalThis.__collectorSideEffectFixture = true;\n');
  console.log(`PASS: two independent validated builds are bit-for-bit reproducible (${digest(first)}); stable input SHA-256 ${sourceBefore.hash}; stable toolchain/dependency identity; ${firstArchive.names.length} ordered entries byte-verified`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
