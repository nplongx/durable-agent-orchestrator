import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/package-runalith-mcpb.sh');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-no-overwrite-'));

function runAt(output) {
  return spawnSync('bash', [script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PLUGIN_BUNDLE_OUT: output },
  });
}

try {
  const existing = path.join(temp, 'existing.mcpb');
  const sentinel = Buffer.from('do-not-overwrite-frozen-artifact\n');
  fs.writeFileSync(existing, sentinel);
  const existingResult = runAt(existing);
  assert.equal(existingResult.status, 2, `existing path should be rejected: ${existingResult.stderr}`);
  assert.deepEqual(fs.readFileSync(existing), sentinel, 'existing output bytes must remain unchanged');

  const danglingLink = path.join(temp, 'dangling.mcpb');
  const linkTarget = path.join(temp, 'target-that-must-not-be-created.mcpb');
  fs.symlinkSync(linkTarget, danglingLink);
  const linkResult = runAt(danglingLink);
  assert.equal(linkResult.status, 2, `dangling symlink should be rejected: ${linkResult.stderr}`);
  assert.equal(fs.lstatSync(danglingLink).isSymbolicLink(), true, 'dangling symlink must remain untouched');
  assert.equal(fs.existsSync(linkTarget), false, 'symlink target must not be created');

  const protectedFrozen = path.join(root, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb');
  const frozenStatBefore = fs.lstatSync(protectedFrozen, { throwIfNoEntry: false });
  const frozenBytes = frozenStatBefore?.isFile() ? fs.readFileSync(protectedFrozen) : null;
  const frozenLink = frozenStatBefore?.isSymbolicLink() ? fs.readlinkSync(protectedFrozen) : null;
  const assertFrozenUnchanged = () => {
    const current = fs.lstatSync(protectedFrozen, { throwIfNoEntry: false });
    if (!frozenStatBefore) {
      assert.equal(current, undefined, 'candidate build must not create the protected frozen path');
      return;
    }
    assert.ok(current, 'pre-existing protected path must remain present');
    assert.equal(current.dev, frozenStatBefore.dev, 'protected path device must remain unchanged');
    assert.equal(current.ino, frozenStatBefore.ino, 'protected path inode must remain unchanged');
    if (frozenBytes) assert.deepEqual(fs.readFileSync(protectedFrozen), frozenBytes, 'protected frozen artifact bytes must remain unchanged');
    if (frozenLink !== null) assert.equal(fs.readlinkSync(protectedFrozen), frozenLink, 'protected symlink target must remain unchanged');
  };
  const frozenResult = runAt(protectedFrozen);
  assert.equal(frozenResult.status, 2, `Phase 1 frozen path must be protected: ${frozenResult.stderr}`);
  assertFrozenUnchanged();

  const frozenAlias = path.join(root, 'dist', '..', 'dist', 'chat-on-steroids-local-orchestrator-1.0.8.mcpb');
  const aliasResult = runAt(frozenAlias);
  assert.equal(aliasResult.status, 2, `normalized alias of frozen path must be protected: ${aliasResult.stderr}`);
  assertFrozenUnchanged();

  const symlinkedParent = path.join(temp, 'dist-alias');
  fs.symlinkSync(path.join(root, 'dist'), symlinkedParent, 'dir');
  const symlinkAliasResult = runAt(path.join(symlinkedParent, 'chat-on-steroids-local-orchestrator-1.0.8.mcpb'));
  assert.equal(symlinkAliasResult.status, 2, `symlinked-parent alias of frozen path must be protected: ${symlinkAliasResult.stderr}`);
  assertFrozenUnchanged();

  const fakeBin = path.join(temp, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const nodeWrapper = path.join(fakeBin, 'node');
  fs.writeFileSync(nodeWrapper, `#!/usr/bin/env bash\nfor arg in "$@"; do\n  if [[ "$arg" == */tests/test-runalith-plugin.js ]]; then\n    echo 'intentional integration-test failure for publication-safety test' >&2\n    exit 91\n  fi\ndone\nexec "$REAL_NODE" "$@"\n`);
  fs.chmodSync(nodeWrapper, 0o755);
  const failedBuild = path.join(temp, 'must-not-publish.mcpb');
  const failedBuildResult = spawnSync('bash', [script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUGIN_BUNDLE_OUT: failedBuild,
      PATH: `${fakeBin}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
    },
  });
  assert.notEqual(failedBuildResult.status, 0, 'injected package integration failure must fail the build');
  assert.equal(fs.existsSync(failedBuild), false, 'failed package validation must not publish an output artifact');
  assert.equal(fs.readdirSync(temp).some(name => name.startsWith('.plugin-package-stage.')), false,
    'failed package validation must clean its staging directory');

  const symlinkSourceRoot = path.join(temp, 'symlink-source-project');
  fs.mkdirSync(path.join(symlinkSourceRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(script, path.join(symlinkSourceRoot, 'scripts/package-runalith-mcpb.sh'));
  const externalReadme = path.join(temp, 'external-readme.md');
  fs.writeFileSync(externalReadme, 'external source bytes that must not be packaged\n');
  fs.symlinkSync(externalReadme, path.join(symlinkSourceRoot, 'README.md'));
  const symlinkSourceOutput = path.join(symlinkSourceRoot, 'dist/candidate.mcpb');
  const symlinkSourceBuild = spawnSync('bash', [path.join(symlinkSourceRoot, 'scripts/package-runalith-mcpb.sh')], {
    cwd: symlinkSourceRoot, encoding: 'utf8', env: { ...process.env, PLUGIN_BUNDLE_OUT: symlinkSourceOutput },
  });
  assert.equal(symlinkSourceBuild.status, 2, 'packager must reject a symlinked explicit source file before staging or publication');
  assert.match(symlinkSourceBuild.stderr, /missing or symlinked package source: README\.md/);
  assert.equal(fs.existsSync(symlinkSourceOutput), false, 'symlinked explicit source must never produce a package');

  // The extracted-schema contract is a production packaging dependency: its
  // absence or symlink substitution must be rejected by the same preflight as
  // the manifest, runtime collector, and acceptance test.
  const schemaSourceRoot = path.join(temp, 'symlink-schema-test-project');
  for (const directory of ['scripts', 'tests', 'plugin']) fs.mkdirSync(path.join(schemaSourceRoot, directory), { recursive: true });
  for (const relative of [
    'README.md', 'LICENSE', 'package.json', 'plugin/manifest.json',
    'tests/test-runalith-plugin.js', 'tests/test-production-behavioral-qa.js',
    'tests/test-execution-lease-fencing.js', 'tests/test-mcp-stdio-backpressure.mjs', 'tests/test-temp-dir.js',
    'scripts/package-runalith-mcpb.sh', 'scripts/collect-plugin-runtime.mjs', 'scripts/plugin-package-metadata.mjs'
  ]) fs.copyFileSync(path.join(root, relative), path.join(schemaSourceRoot, relative));
  fs.symlinkSync(externalReadme, path.join(schemaSourceRoot, 'tests/test-extracted-package-tool-schemas.mjs'));
  const schemaSourceOutput = path.join(schemaSourceRoot, 'dist/candidate.mcpb');
  const symlinkSchemaBuild = spawnSync('bash', [path.join(schemaSourceRoot, 'scripts/package-runalith-mcpb.sh')], {
    cwd: schemaSourceRoot, encoding: 'utf8', env: { ...process.env, PLUGIN_BUNDLE_OUT: schemaSourceOutput },
  });
  assert.equal(symlinkSchemaBuild.status, 2,
    'packager must reject a symlinked extracted-schema test before creating staging or a candidate');
  assert.match(symlinkSchemaBuild.stderr, /missing or symlinked package source: tests\/test-extracted-package-tool-schemas\.mjs/);
  assert.equal(fs.existsSync(schemaSourceOutput), false, 'a substituted schema acceptance test must never produce a candidate');

  // The lease-fencing acceptance executable and its shared temp-dir helper are
  // also executed/imported by the packager before publication. Both must be in
  // the canonical-source preflight; otherwise a symlink can run arbitrary JS
  // outside the repository while appearing to be a routine packaging test.
  const externalTest = path.join(temp, 'external-package-test.js');
  fs.writeFileSync(externalTest, "throw new Error('external package test must never execute');\n", { flag: 'wx', mode: 0o600 });
  const preflightInputs = [
    'README.md', 'LICENSE', 'package.json', 'plugin/manifest.json',
    'tests/test-runalith-plugin.js', 'tests/test-production-behavioral-qa.js', 'tests/test-extracted-package-tool-schemas.mjs',
    'tests/test-execution-lease-fencing.js', 'tests/test-mcp-stdio-backpressure.mjs', 'tests/test-temp-dir.js',
    'scripts/package-runalith-mcpb.sh', 'scripts/collect-plugin-runtime.mjs', 'scripts/plugin-package-metadata.mjs'
  ];
  for (const [relative, expectedMessage] of [
    ['tests/test-production-behavioral-qa.js', /missing or symlinked package source: tests\/test-production-behavioral-qa\.js/],
    ['tests/test-execution-lease-fencing.js', /missing or symlinked package source: tests\/test-execution-lease-fencing\.js/],
    ['tests/test-mcp-stdio-backpressure.mjs', /missing or symlinked package source: tests\/test-mcp-stdio-backpressure\.mjs/],
    ['tests/test-temp-dir.js', /missing or symlinked package source: tests\/test-temp-dir\.js/]
  ]) {
    const project = path.join(temp, `symlink-package-preflight-${path.basename(relative, '.js')}`);
    for (const directory of ['scripts', 'tests', 'plugin']) fs.mkdirSync(path.join(project, directory), { recursive: true });
    for (const input of preflightInputs) {
      if (input === relative) continue;
      fs.copyFileSync(path.join(root, input), path.join(project, input));
    }
    fs.symlinkSync(externalTest, path.join(project, relative));
    const output = path.join(project, 'dist/candidate.mcpb');
    const result = spawnSync('bash', [path.join(project, 'scripts/package-runalith-mcpb.sh')], {
      cwd: project, encoding: 'utf8', env: { ...process.env, PLUGIN_BUNDLE_OUT: output },
    });
    assert.equal(result.status, 2, `packager must reject symlinked ${relative} before executing it: ${result.stderr}`);
    assert.match(result.stderr, expectedMessage);
    assert.equal(fs.existsSync(output), false, `symlinked ${relative} must never produce a candidate archive`);
    assert.equal(fs.readdirSync(project).some(name => name.startsWith('.plugin-package-stage.')), false,
      `preflight rejection for ${relative} must happen before staging`);
  }

  const collector = path.join(root, 'scripts/collect-plugin-runtime.mjs');
  const symlinkRuntimeRoot = path.join(temp, 'symlink-runtime-project');
  const symlinkRuntimeStage = path.join(temp, 'symlink-runtime-stage');
  fs.mkdirSync(path.join(symlinkRuntimeRoot, 'server'), { recursive: true });
  fs.mkdirSync(symlinkRuntimeStage);
  fs.symlinkSync(externalReadme, path.join(symlinkRuntimeRoot, 'server/index.js'));
  const symlinkRuntimeBuild = spawnSync(process.execPath, [collector, symlinkRuntimeRoot, symlinkRuntimeStage], { cwd: root, encoding: 'utf8' });
  assert.notEqual(symlinkRuntimeBuild.status, 0, 'runtime collector must reject symlinked source dependencies');
  assert.match(symlinkRuntimeBuild.stderr, /contains a symlink/);

  console.log('PASS: packaging protects the frozen path through normalized/symlink aliases, refuses existing files and dangling symlinks, and never publishes after validation failure');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
