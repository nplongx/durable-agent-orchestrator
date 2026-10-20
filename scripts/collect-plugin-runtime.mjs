import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const stage = path.resolve(process.argv[3]);
if (!process.argv[3]) throw new Error('staging directory argument is required');
if (fs.realpathSync(root) !== root) throw new Error('plugin source root must not be a symlink alias');

function assertRegularSource(relative) {
  let cursor = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) throw new Error(`plugin dependency is missing or contains a symlink: ${relative}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`plugin dependency is not a regular source file: ${relative}`);
    }
  }
  if (fs.realpathSync(cursor) !== cursor) throw new Error(`plugin dependency resolves outside its canonical source path: ${relative}`);
  return cursor;
}

const queue = [
  'server/index.js',
  'src/runtime/job-store.js',
  // The read-only liveness tool is imported through runtimePrefix rather than
  // a static relative path, so package it explicitly with the runtime closure.
  'src/runtime/job-liveness.js',
  'src/runtime/execution-manager.js',
  // The packaged Phase-5 recovery regression loads this module via a fixture
  // forwarder; include it in the staged test runtime closure explicitly.
  'src/runtime/recovery-manager.js',
  'src/runtime/workflow/artifacts.js',
  'src/runtime/workflow/agent-contracts.js',
  // server/index.js selects the workflow helper through a runtimePrefix
  // template-literal import, which the static relative-import collector
  // cannot resolve. Keep this runtime dependency explicit in the bundle.
  'src/runtime/workflow/case01-artifact-acceptance.js',
  'src/runtime/workflow/custom-roles.js',
  'src/runtime/workflow/custom-workflows.js',
  // Proactive reusable-resource discovery is selected through runtimePrefix.
  'src/runtime/workflow/resource-recommender.js',
  // The immutable system coordinator and specialist prompt helper are loaded
  // through runtimePrefix in the server entry point, so keep these dynamic
  // import dependencies explicit in the packaged runtime closure.
  'src/runtime/workflow/system-coordinator.js',
  'src/runtime/workflow/specialist-role-guidance.js',
  // These structured error/recovery modules are also selected through the
  // runtimePrefix import in server/index.js and cannot be discovered statically.
  'src/runtime/workflow/recovery-compatibility.js',
  'src/runtime/workflow/tool-errors.js'
];
const visited = new Set();
// Include static imports, dynamic imports, and side-effect-only imports. If a
// bare `import './register.js'` is skipped, the source may work in-tree while
// the packaged dependency closure silently omits a required module.
const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;

while (queue.length) {
  const relative = queue.shift();
  if (visited.has(relative)) continue;
  visited.add(relative);
  const source = path.resolve(root, relative);
  if (!source.startsWith(`${root}${path.sep}`)) throw new Error(`plugin dependency escapes repository: ${relative}`);
  assertRegularSource(relative);
  const destination = path.join(stage, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const contents = fs.readFileSync(source, 'utf8');
  for (const match of contents.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
    if (!target.endsWith('.js') && !target.endsWith('.json')) throw new Error(`unsupported extensionless local import in plugin dependency: ${relative} -> ${specifier}`);
    if (!visited.has(target)) queue.push(target);
  }
}

console.log(`Collected ${visited.size} local runtime files for plugin bundle.`);
