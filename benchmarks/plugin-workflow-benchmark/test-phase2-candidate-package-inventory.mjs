import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateZipEntryTypes } from './phase2-zip-entry-type-safety.mjs';
import { serializePluginPackageMetadata } from '../../scripts/plugin-package-metadata.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryPath = process.argv[2]
  ? path.resolve(root, process.argv[2])
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'phase2-candidate-package-inventory-final4-20261013.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
assert.equal(inventory.status, 'candidate-unapproved-review-evidence-only');
const bundlePath = path.join(root, inventory.bundle.path);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const archive = fs.readFileSync(bundlePath);
validateZipEntryTypes(archive);
assert.equal(archive.length, inventory.bundle.size_bytes, 'candidate archive size changed');
assert.equal(digest(archive), inventory.bundle.sha256, 'candidate archive SHA-256 changed');

const names = execFileSync('unzip', ['-Z1', bundlePath], { encoding: 'utf8' })
  .trim().split(/\r?\n/).filter(name => name && !name.endsWith('/')).sort();
assert.deepEqual(names, inventory.entries.map(entry => entry.path).sort(), 'candidate archive entry list changed');
assert.equal(new Set(names).size, names.length, 'candidate archive must not contain duplicate entry names');
for (const name of names) {
  assert.ok(name.length > 0 && !name.startsWith('/') && !name.startsWith('-') && !name.includes('\\') &&
    name.split('/').every(part => part !== '' && part !== '.' && part !== '..'), `unsafe candidate archive path: ${name}`);
}
assert.equal(inventory.bundle.path, path.relative(root, bundlePath), 'inventory must bind the exact candidate path');

// Historical inventories without source provenance are valid historical records,
// but cannot establish current source lineage. Fail closed with BLOCKED, not an
// uncaught assertion that looks like a test implementation failure.
if (!inventory.source_tree || !Array.isArray(inventory.entries) ||
    inventory.entries.some(entry => typeof entry.source_path !== 'string' || !/^[a-f0-9]{64}$/.test(String(entry.source_sha256 || '')))) {
  console.log('BLOCKED: historical inventory lacks source-tree/source-byte provenance required for current-source lineage; preserve inventory unchanged and use a separately generated successor inventory');
  process.exit(2);
}

const sourceMismatches = [];
for (const entry of inventory.entries) {
  const bytes = execFileSync('unzip', ['-p', bundlePath, entry.path], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(bytes.length, entry.size_bytes, `entry size changed: ${entry.path}`);
  assert.equal(digest(bytes), entry.sha256, `entry SHA-256 changed: ${entry.path}`);
  const expectedSourcePath = entry.path === 'manifest.json' ? 'plugin/manifest.json' : entry.path;
  assert.equal(entry.source_path, expectedSourcePath, `source path mapping changed: ${entry.path}`);
  assert.equal(entry.source_sha256, entry.sha256, `source hash was not bound to package entry: ${entry.path}`);
  const source = fs.readFileSync(path.join(root, entry.source_path));
  if (entry.source_derivation === 'runtime-metadata-projection-v1') {
    if (entry.path !== 'package.json' || digest(source) !== entry.source_input_sha256 ||
        !serializePluginPackageMetadata(JSON.parse(source.toString('utf8'))).equals(bytes)) {
      sourceMismatches.push(entry.path);
    }
  } else if (entry.source_derivation !== undefined || entry.source_input_sha256 !== undefined ||
      digest(source) !== entry.source_sha256 || !source.equals(bytes)) {
    sourceMismatches.push(entry.path);
  }
}

const manifest = JSON.parse(execFileSync('unzip', ['-p', bundlePath, 'manifest.json'], { encoding: 'utf8' }));
assert.equal(manifest.version, inventory.manifest.version);
assert.equal(manifest.server?.entry_point, inventory.manifest.server_entry_point);
assert.equal(manifest.tools?.length, inventory.manifest.declared_tool_count);
const sourceInventoryHash = digest(Buffer.from(JSON.stringify(inventory.entries.map(entry => ({
  path: entry.source_path,
  sha256: entry.source_sha256,
  ...(entry.source_input_sha256 ? {
    source_input_sha256: entry.source_input_sha256,
    source_derivation: entry.source_derivation,
  } : {}),
})))));
assert.equal(inventory.source_tree?.packaged_source_inventory_sha256, sourceInventoryHash, 'source inventory digest mismatch');
assert.equal(inventory.source_tree?.git_head, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
assert.equal(inventory.source_tree?.working_tree_dirty, true, 'review packet must disclose dirty working tree');
if (sourceMismatches.length) {
  console.log(`BLOCKED: archive and historical inventory agree, but current source bytes differ for ${sourceMismatches.join(', ')}; do not review or authorize this candidate as the current source build`);
  process.exitCode = 2;
} else {
  console.log(`PASS: candidate archive and all ${inventory.entries.length} entry hashes reconcile to current source bytes and declared source identity (candidate remains unapproved)`);
}
