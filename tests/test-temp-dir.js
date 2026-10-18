import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep scratch state outside potentially shared/writable repository parents.
// The private SQLite path guard intentionally rejects database paths below a
// non-sticky group/world-writable ancestor; tests should not depend on a repo
// checkout location being safe for durable database storage.
const root = os.tmpdir();

export function tempDir(prefix = 'test-') {
  return fs.mkdtempSync(path.join(root, prefix));
}

export async function tempDirAsync(prefix = 'test-') {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(root, prefix));
}
