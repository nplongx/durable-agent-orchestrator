import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupStaleOpenClawPluginBuildDirs, getInodePressure, classifyInodePressure } from '../src/runtime/tmp-pressure.js';

assert.deepEqual(classifyInodePressure(69), { warning: false, cleanup: false, critical: false });
assert.deepEqual(classifyInodePressure(70), { warning: true, cleanup: false, critical: false });
assert.deepEqual(classifyInodePressure(85), { warning: true, cleanup: true, critical: false });
assert.deepEqual(classifyInodePressure(95), { warning: true, cleanup: true, critical: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-pressure-'));
const stale = path.join(root, 'openclaw-plugin-build-stale');
const fresh = path.join(root, 'openclaw-plugin-build-fresh');
const unrelated = path.join(root, 'workflow.db');
fs.mkdirSync(stale);
fs.mkdirSync(fresh);
fs.writeFileSync(unrelated, 'keep');
const old = new Date(Date.now() - 60_000);
fs.utimesSync(stale, old, old);

const result = cleanupStaleOpenClawPluginBuildDirs({ root, maxAgeMs: 30_000 });
assert.equal(result.removed, 1);
assert.equal(fs.existsSync(stale), false);
assert.equal(fs.existsSync(fresh), true);
assert.equal(fs.existsSync(unrelated), true);

const pressure = getInodePressure(root);
assert.ok(pressure.total > 0);
assert.ok(pressure.usedPercent >= 0 && pressure.usedPercent <= 100);

fs.rmSync(root, { recursive: true, force: true });
console.log('TMP INODE GUARD PASS');
