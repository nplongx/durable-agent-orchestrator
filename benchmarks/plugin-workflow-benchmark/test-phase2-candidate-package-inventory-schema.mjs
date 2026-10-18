#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const checker = path.join(here, 'test-phase2-candidate-package-inventory.mjs');
const legacy = path.join(here, 'phase2-candidate-package-inventory-final3-20261013.json');
const result = spawnSync(process.execPath, [checker, path.relative(root, legacy)], { cwd: root, encoding: 'utf8' });
assert.equal(result.status, 2, `legacy inventory should be BLOCKED, got ${result.status}: ${result.stderr}`);
assert.match(result.stdout, /BLOCKED: historical inventory lacks source-tree\/source-byte provenance/);
console.log('PASS: legacy inventory without source provenance is explicitly BLOCKED; historical file remains unchanged');
