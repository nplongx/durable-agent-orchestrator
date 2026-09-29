import fs from 'node:fs';
import path from 'node:path';

const root = path.join(process.cwd(), '.test-tmp');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });

export function tempDir(prefix = 'test-') {
  return fs.mkdtempSync(path.join(root, prefix));
}

export async function tempDirAsync(prefix = 'test-') {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(root, prefix));
}
