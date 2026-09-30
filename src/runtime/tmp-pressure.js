import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ROOT = '/tmp';
const BUILD_PREFIX = 'openclaw-plugin-build-';

export function getInodePressure(root = DEFAULT_ROOT) {
  const stat = fs.statfsSync(root);
  const files = Number(stat.files);
  const free = Number(stat.ffree);
  if (!Number.isFinite(files) || files <= 0 || !Number.isFinite(free)) {
    throw new Error(`Unable to read inode capacity for ${root}`);
  }
  const used = Math.max(0, files - free);
  return {
    root,
    total: files,
    free,
    used,
    usedPercent: (used / files) * 100
  };
}

export function cleanupStaleOpenClawPluginBuildDirs({
  root = DEFAULT_ROOT,
  maxAgeMs = 10 * 60_000,
  maxEntries = 500,
  now = Date.now()
} = {}) {
  const cutoff = now - Math.max(0, Number(maxAgeMs) || 0);
  let scanned = 0;
  let removed = 0;
  let failed = 0;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith(BUILD_PREFIX) || removed >= maxEntries) continue;
      scanned++;
      const dir = path.join(root, name);
      try {
        const stat = fs.statSync(dir);
        if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch (_) {
        failed++;
      }
    }
  } catch (_) {
    failed++;
  }
  return { root, scanned, removed, failed, maxAgeMs, maxEntries };
}

export function classifyInodePressure(usedPercent, { warnPercent = 70, cleanupPercent = 85, criticalPercent = 95 } = {}) {
  const value = Number(usedPercent);
  return { warning: value >= warnPercent, cleanup: value >= cleanupPercent, critical: value >= criticalPercent };
}

export function enforceTmpInodeGuard({
  root = DEFAULT_ROOT,
  warnPercent = 70,
  cleanupPercent = 85,
  criticalPercent = 95,
  maxAgeMs = 10 * 60_000,
  maxEntries = 500
} = {}) {
  const before = getInodePressure(root);
  let cleanup = null;
  if (before.usedPercent >= cleanupPercent) {
    cleanup = cleanupStaleOpenClawPluginBuildDirs({ root, maxAgeMs, maxEntries });
  }
  const after = cleanup ? getInodePressure(root) : before;
  return {
    ...after,
    ...classifyInodePressure(after.usedPercent, { warnPercent, cleanupPercent, criticalPercent }),
    cleanupTriggered: Boolean(cleanup),
    cleanup,
  };
}
