#!/usr/bin/env node
// Read-only host readiness gate. It does not launch a scenario or change host state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MIN_ROOT_FREE_BYTES = 20 * 1024 ** 3;
const MIN_ROOT_FREE_PERCENT = 10;
const MIN_AVAILABLE_MEMORY_BYTES = 2 * 1024 ** 3;
const checks = [];
const add = (name, passed, observed, requirement) => checks.push({ name, status: passed ? 'PASS' : 'FAIL', observed, requirement });
const bytes = value => `${(value / 1024 ** 3).toFixed(2)} GiB`;

let rootFs;
try {
  rootFs = fs.statfsSync('/');
  const total = Number(rootFs.blocks) * Number(rootFs.bsize);
  const available = Number(rootFs.bavail) * Number(rootFs.bsize);
  const freePercent = total > 0 ? available / total * 100 : 0;
  add('root-free-space', available >= MIN_ROOT_FREE_BYTES && freePercent >= MIN_ROOT_FREE_PERCENT,
    { available: bytes(available), total: bytes(total), available_percent: Number(freePercent.toFixed(2)) },
    `at least ${bytes(MIN_ROOT_FREE_BYTES)} and ${MIN_ROOT_FREE_PERCENT}% available on /`);
} catch (error) {
  add('root-free-space', false, { error: error.message }, 'filesystem free-space stats must be readable');
}

try {
  const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
  const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  const available = match ? Number(match[1]) * 1024 : 0;
  add('available-memory', available >= MIN_AVAILABLE_MEMORY_BYTES,
    { available: bytes(available) }, `at least ${bytes(MIN_AVAILABLE_MEMORY_BYTES)} MemAvailable`);
} catch (error) {
  add('available-memory', false, { error: error.message }, 'MemAvailable must be readable');
}

const load = os.loadavg();
const cpuCount = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
add('host-load', load[0] <= cpuCount * 2 && load[1] <= cpuCount * 2,
  { load_1m: Number(load[0].toFixed(2)), load_5m: Number(load[1].toFixed(2)), cpu_count: cpuCount },
  `1m and 5m load averages must each be <= ${cpuCount * 2}`);

for (const binary of ['/usr/bin/bwrap', '/usr/bin/systemd-run']) {
  add(`required-binary:${path.basename(binary)}`, fs.existsSync(binary), { path: binary }, 'binary must exist; sandbox tests separately prove behavior');
}
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const bus = uid === null ? null : `/run/user/${uid}/bus`;
add('user-systemd-bus', Boolean(bus && fs.existsSync(bus)), { uid, bus, present: Boolean(bus && fs.existsSync(bus)) },
  'user systemd bus must exist for resource-limited sandbox launch');

const result = {
  protocol: 'phase2-host-readiness-preflight-v1',
  captured_at: new Date().toISOString(),
  read_only: true,
  benchmark_scenario_executed: false,
  host: { hostname: os.hostname(), platform: os.platform(), release: os.release(), node: process.version },
  checks,
  status: checks.every(check => check.status === 'PASS') ? 'PASS' : 'BLOCKED',
  next_step: checks.every(check => check.status === 'PASS')
    ? 'Review this evidence with independent containment results; this script alone does not authorize Phase 2.'
    : 'Resolve failed host-readiness checks through approved host administration, then rerun this read-only preflight. Do not delete data automatically.',
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status !== 'PASS') process.exitCode = 2;
