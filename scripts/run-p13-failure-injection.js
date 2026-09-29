#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { summarizeObservability } from '../src/runtime/observability.js';

const exec = promisify(execFile);
const modes = (process.env.P13_MODES || 'all').split(',').map(x => x.trim()).filter(Boolean);
const selected = modes.includes('all') ? ['stale-lease', 'duplicate-result', 'provider-failure', 'corrupt-evidence', 'checkpoint-timeout'] : modes;

const { stdout } = await exec(process.execPath, ['tests/test-p13-failure-injection.js', ...selected], {
  env: { ...process.env, P13_CHILD: '1' }, maxBuffer: 1024 * 1024
});
const lines = stdout.trim().split('\n').filter(Boolean);
const summary = JSON.parse(lines.at(-1));
console.log(JSON.stringify({ phase: 'P13', ...summary }, null, 2));
if (summary.failed > 0) process.exitCode = 1;
