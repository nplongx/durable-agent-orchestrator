#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const target = process.env.OPENCLAW_BOOTSTRAP_TARGET?.trim();
const credential = process.env.OPENCLAW_BOOTSTRAP_CREDENTIAL?.trim();
const binary = process.env.OPENCLAW_BIN?.trim() || 'openclaw';

if (!target || !credential) {
  throw new Error('OPENCLAW_BOOTSTRAP_TARGET and OPENCLAW_BOOTSTRAP_CREDENTIAL are required');
}

// The Gateway-issued bootstrap is deliberately materialized only into a private,
// one-shot target file consumed by `openclaw connect`. It is never persisted in
// runner config, logs, artifacts, or command arguments.
const dir = await mkdtemp(path.join(os.tmpdir(), 'openclaw-runner-'));
const targetFile = path.join(dir, 'connect-target');
// `target` is retained as an admission-bound sanity input. OpenClaw's native
// connect CLI consumes the setup-code credential; the URL target is embedded
// in that setup code and must not be separately supplied.
await writeFile(targetFile, `${credential}\n`, { mode: 0o600 });

const child = spawn(binary, ['connect', '--ephemeral', '--target-file', targetFile], {
  stdio: 'inherit',
  env: {
    ...process.env,
    OPENCLAW_BOOTSTRAP_CREDENTIAL: undefined,
  },
});

const cleanup = async () => {
  await rm(dir, { recursive: true, force: true });
};

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));

const exitCode = await new Promise((resolve) => {
  child.once('exit', (code, signal) => resolve(signal ? 128 + (signal === 'SIGTERM' ? 15 : 2) : code ?? 1));
  child.once('error', () => resolve(1));
});

await cleanup();
process.exitCode = Number(exitCode);
