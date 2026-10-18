#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../../src/runtime/strict-json.js';
import { serializePluginPackageMetadata } from '../../scripts/plugin-package-metadata.mjs';
import { isSafePortableArchivePath, validateZipEntryTypes } from './phase2-zip-entry-type-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bundleArg = process.argv[2];
const outputArg = process.argv[3];
if (!bundleArg || !outputArg) {
  console.error('Usage: node benchmarks/plugin-workflow-benchmark/create-phase2-candidate-inventory.mjs <candidate-bundle-path> <new-inventory-path>');
  process.exit(2);
}
const bundlePath = path.resolve(root, bundleArg);
const outputPath = path.resolve(root, outputArg);
if (!bundlePath.startsWith(`${root}${path.sep}`) || !outputPath.startsWith(`${root}${path.sep}`)) throw new Error('bundle and inventory paths must remain inside repository');
if (!fs.existsSync(bundlePath)) throw new Error(`candidate bundle does not exist: ${path.relative(root, bundlePath)}`);
if (fs.existsSync(outputPath) || fs.lstatSync(outputPath, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('inventory output already exists; refusing overwrite');
const outputParent = path.dirname(outputPath);
if (!fs.existsSync(outputParent)) throw new Error('inventory output parent must already exist');
let parentCursor = root;
for (const part of path.relative(root, outputParent).split(path.sep).filter(Boolean)) {
  parentCursor = path.join(parentCursor, part);
  const stat = fs.lstatSync(parentCursor);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`inventory output parent contains symlink or non-directory: ${parentCursor}`);
}
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (fs.realpathSync(root) !== root) throw new Error('repository root must not be a symlink alias');
function readStableRegularFile(filePath, label) {
  const beforePath = fs.lstatSync(filePath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || fs.realpathSync(filePath) !== filePath) {
    throw new Error(`${label} must be a canonical regular non-symlink file`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error(`${label} path identity changed before descriptor read`);
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        !afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.dev !== before.dev || afterPath.ino !== before.ino ||
        afterPath.size !== before.size || afterPath.mtimeNs !== before.mtimeNs || afterPath.ctimeNs !== before.ctimeNs ||
        fs.realpathSync(filePath) !== filePath) {
      throw new Error(`${label} changed while its verified descriptor bytes were being read`);
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}
function readRegularSource(relative) {
  if (!isSafePortableArchivePath(relative)) {
    throw new Error(`source path is not a normalized repository-relative path: ${relative}`);
  }
  const parts = relative.split('/');
  let cursor = root;
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) throw new Error(`source path is missing or contains a symlink: ${relative}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`source path contains a non-directory parent or non-regular file: ${relative}`);
    }
  }
  if (fs.realpathSync(cursor) !== cursor) throw new Error(`source path is not canonical: ${relative}`);
  return readStableRegularFile(cursor, `source ${relative}`);
}
const bundleRelative = path.relative(root, bundlePath).split(path.sep).join('/');
const archive = readRegularSource(bundleRelative);
validateZipEntryTypes(archive);
let inventoryEntries;
let names;
let entries;
let manifest;
let sourceInventoryDigest;
const archiveSnapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-candidate-inventory-'));
fs.chmodSync(archiveSnapshotDir, 0o700);
try {
  const archiveSnapshotPath = path.join(archiveSnapshotDir, 'candidate.mcpb');
  const archiveFd = fs.openSync(archiveSnapshotPath, 'wx', 0o600);
  try { fs.writeFileSync(archiveFd, archive); fs.fsyncSync(archiveFd); } finally { fs.closeSync(archiveFd); }
  fs.chmodSync(archiveSnapshotPath, 0o400);
  names = execFileSync('unzip', ['-Z1', archiveSnapshotPath], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(name => name && !name.endsWith('/')).sort();
  if (new Set(names).size !== names.length || names.some(name => !isSafePortableArchivePath(name))) {
    throw new Error('candidate archive has duplicate or unsafe entry paths');
  }
  entries = names.map(name => {
    const bytes = execFileSync('unzip', ['-p', archiveSnapshotPath, name], { maxBuffer: 32 * 1024 * 1024 });
    const sourcePath = name === 'manifest.json' ? 'plugin/manifest.json' : name;
    const fullSource = path.resolve(root, sourcePath);
    if (!fullSource.startsWith(`${root}${path.sep}`)) throw new Error(`source path escapes repository: ${sourcePath}`);
    let source;
    let sourceDerivation;
    let sourceInputSha256;
    if (name === 'package.json') {
      // The MCPB contains only the local runtime closure. Do not leak the full
      // application's LangGraph dependency or scripts that reference excluded
      // source files into the packaged runtime metadata.
      const sourcePackageBytes = readRegularSource('package.json');
      const sourcePackage = parseStrictJson(sourcePackageBytes, 'repository package.json');
      source = serializePluginPackageMetadata(sourcePackage);
      sourceDerivation = 'runtime-metadata-projection-v1';
      sourceInputSha256 = sha256(sourcePackageBytes);
    } else {
      source = readRegularSource(sourcePath);
    }
    if (!source.equals(bytes)) throw new Error(`source/archive bytes differ for ${name}; refusing to create lineage inventory`);
    return {
      path: name, size_bytes: bytes.length, sha256: sha256(bytes), source_path: sourcePath, source_sha256: sha256(source),
      ...(sourceDerivation ? { source_derivation: sourceDerivation, source_input_sha256: sourceInputSha256 } : {})
    };
  });
  manifest = parseStrictJson(execFileSync('unzip', ['-p', archiveSnapshotPath, 'manifest.json'], { encoding: null }), 'candidate manifest');
  sourceInventoryDigest = sha256(Buffer.from(JSON.stringify(entries.map(entry => ({
    path: entry.source_path, sha256: entry.source_sha256,
    ...(entry.source_input_sha256 ? { source_input_sha256: entry.source_input_sha256, source_derivation: entry.source_derivation } : {})
  })))));
  // Ensure the candidate name still resolves to precisely the bytes just
  // inventoried. A pathname replacement during ZIP verification is a blocker.
  const finalArchiveBytes = readRegularSource(bundleRelative);
  if (!finalArchiveBytes.equals(archive)) throw new Error('candidate archive pathname changed while its entry inventory was being verified');
} finally {
  fs.rmSync(archiveSnapshotDir, { recursive: true, force: true });
}
const inventory = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  status: 'candidate-unapproved-review-evidence-only',
  bundle: { path: path.relative(root, bundlePath), size_bytes: archive.length, sha256: sha256(archive) },
  source_tree: {
    git_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    packaged_source_inventory_sha256: sourceInventoryDigest,
    working_tree_dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  },
  manifest: { name: manifest.name, version: manifest.version, server_entry_point: manifest.server?.entry_point, declared_tool_count: manifest.tools?.length },
  entries,
};
const fd = fs.openSync(outputPath, 'wx', 0o600);
try { fs.writeFileSync(fd, `${JSON.stringify(inventory, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
console.log(JSON.stringify({ status: 'PASS', inventory_path: path.relative(root, outputPath), inventory_sha256: sha256(fs.readFileSync(outputPath)), bundle_path: inventory.bundle.path, bundle_sha256: inventory.bundle.sha256, entry_count: entries.length, source_inventory_sha256: sourceInventoryDigest, approved: false }, null, 2));
