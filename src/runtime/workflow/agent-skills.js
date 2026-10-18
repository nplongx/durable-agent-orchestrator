import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// MVP limits keep a role snapshot bounded and predictable. Imported helpers are
// stored as text but are never executed by the role runtime.
export const MAX_SKILLS_PER_ROLE = 8;
export const MAX_SKILL_FILES = 40;
export const MAX_SKILL_FILE_BYTES = 32 * 1024;
export const MAX_SKILLS_TOTAL_BYTES = 160 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.xml', '.html', '.css', '.svg',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.sql', '.graphql'
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next']);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseFrontmatter(markdown, expectedDirectoryName) {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter bounded by --- lines');
  const lines = match[1].split(/\r?\n/);
  const readScalar = (field) => {
    const index = lines.findIndex(line => new RegExp(`^${field}:\\s*`).test(line));
    if (index < 0) throw new Error(`SKILL.md frontmatter is missing required field: ${field}`);
    const raw = lines[index].slice(lines[index].indexOf(':') + 1).trim();
    if (/^[>|][+-]?$/.test(raw)) {
      const values = [];
      for (let i = index + 1; i < lines.length; i++) {
        if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*/.test(lines[i])) break;
        if (lines[i].trim()) values.push(lines[i].trim());
      }
      return values.join(' ');
    }
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1).trim();
    return raw;
  };
  const name = readScalar('name');
  const description = readScalar('description');
  if (!SKILL_NAME.test(name) || name.length > 64 || name.startsWith('-') || name.endsWith('-')) {
    throw new Error('SKILL.md name must be a lowercase slug of 1-64 characters (letters, numbers, hyphens)');
  }
  if (!description || description.length > 1024) throw new Error('SKILL.md description must contain 1-1024 characters');
  if (expectedDirectoryName && expectedDirectoryName !== name) {
    throw new Error(`SKILL.md name "${name}" must match the skill directory name "${expectedDirectoryName}"`);
  }
  return { name, description, instructions: normalized.slice(match[0].length).trim() };
}

function safeRelativePath(value) {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe skill file path: ${value}`);
  }
  return normalized;
}

function addTextFile(files, relativePath, bytes, counter) {
  const safePath = safeRelativePath(relativePath);
  if (!TEXT_EXTENSIONS.has(path.posix.extname(safePath).toLowerCase())) return;
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) throw new Error(`skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${safePath}`);
  if (bytes.includes(0)) return; // Skip binary files in the MVP importer.
  const content = bytes.toString('utf8');
  if (Buffer.from(content, 'utf8').compare(bytes) !== 0) throw new Error(`skill file is not valid UTF-8 text: ${safePath}`);
  counter.totalBytes += bytes.byteLength;
  if (counter.totalBytes > MAX_SKILLS_TOTAL_BYTES) throw new Error(`combined skill files exceed ${MAX_SKILLS_TOTAL_BYTES} bytes`);
  files.push({ path: safePath, content, sha256: sha256(bytes), size_bytes: bytes.byteLength });
  if (files.length > MAX_SKILL_FILES) throw new Error(`skill may contain at most ${MAX_SKILL_FILES} text files`);
}

function expandLocalPath(source) {
  let candidate = source;
  if (candidate === '~') candidate = os.homedir();
  else if (candidate.startsWith('~/')) candidate = path.join(os.homedir(), candidate.slice(2));
  return path.resolve(process.env.WORKFLOW_WORKSPACE || os.homedir(), candidate);
}

function importLocalDirectory(source, counter) {
  const requested = expandLocalPath(source);
  const rootStat = fs.lstatSync(requested);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`local skill source must be a real directory, not a symlink: ${source}`);
  const root = fs.realpathSync(requested);
  const files = [];
  const walk = (directory, relative = '', depth = 0) => {
    if (depth > 8) throw new Error('skill directory exceeds maximum nesting depth 8');
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`skill directory must not contain symlinks: ${rel}`);
      if (info.isDirectory()) walk(absolute, rel, depth + 1);
      else if (info.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        if (info.size > MAX_SKILL_FILE_BYTES) throw new Error(`skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${rel}`);
        addTextFile(files, rel, fs.readFileSync(absolute), counter);
      }
    }
  };
  walk(root);
  if (!files.some(file => file.path === 'SKILL.md')) throw new Error(`local skill directory must contain a root SKILL.md: ${source}`);
  const nameFromPath = path.basename(root);
  const main = files.find(file => file.path === 'SKILL.md');
  const metadata = parseFrontmatter(main.content, nameFromPath);
  return bundleSkill(metadata, files, { kind: 'local', location: root });
}

function parseGithubSource(source) {
  let url;
  try { url = new URL(source); } catch { throw new Error('remote skill source must be a valid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('remote skill source must be a clean HTTPS GitHub URL without credentials, query or fragment');
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (host === 'github.com' && parts.length >= 4 && ['tree', 'blob'].includes(parts[2])) {
    const [owner, repo, mode, ref, ...rest] = parts;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || !ref || ref.includes('/')) throw new Error('unsupported GitHub source path');
    if (mode === 'blob' && (rest.at(-1) !== 'SKILL.md' || rest.length < 1)) throw new Error('GitHub blob skill source must point to SKILL.md');
    return { owner, repo, ref, directory: mode === 'blob' ? rest.slice(0, -1).join('/') : rest.join('/') };
  }
  if (host === 'raw.githubusercontent.com' && parts.length >= 4) {
    const [owner, repo, ref, ...rest] = parts;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || !ref || ref.includes('/')) throw new Error('unsupported raw GitHub source path');
    if (rest.at(-1) !== 'SKILL.md') throw new Error('raw GitHub skill source must point to SKILL.md');
    return { owner, repo, ref, directory: rest.slice(0, -1).join('/') };
  }
  throw new Error('remote skills currently support public GitHub tree URLs or raw SKILL.md URLs only');
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'chat-on-steroids-local-orchestrator' },
    redirect: 'error', signal: AbortSignal.timeout(10000)
  });
  if (!response?.ok) throw new Error(`skill download failed (${response?.status ?? 'network error'}): ${new URL(url).hostname}`);
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (declaredLength > MAX_SKILLS_TOTAL_BYTES * 4) throw new Error('remote skill response is too large');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SKILLS_TOTAL_BYTES * 4) throw new Error('remote skill response is too large');
  if (bytes.includes(0)) throw new Error('remote skill response must be UTF-8 text');
  return bytes.toString('utf8');
}

async function importGithubDirectory(source, counter, fetchImpl) {
  const { owner, repo, ref, directory } = parseGithubSource(source);
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const tree = JSON.parse(await fetchText(apiUrl, fetchImpl));
  if (!Array.isArray(tree.tree) || tree.truncated) throw new Error('GitHub skill repository tree is missing or truncated');
  const prefix = directory ? `${directory}/` : '';
  const candidates = tree.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith(prefix) &&
    (directory ? entry.path.slice(prefix.length).length > 0 : true));
  const scoped = candidates.map(entry => ({ ...entry, relative: entry.path.slice(prefix.length) }))
    .filter(entry => entry.relative && !entry.relative.split('/').some(part => part === '.' || part === '..'))
    .filter(entry => !entry.relative.split('/').some(part => part.startsWith('.') || SKIP_DIRS.has(part)))
    .filter(entry => TEXT_EXTENSIONS.has(path.posix.extname(entry.relative).toLowerCase()));
  if (scoped.length > MAX_SKILL_FILES) throw new Error(`remote skill may contain at most ${MAX_SKILL_FILES} text files`);
  for (const entry of scoped) {
    if (entry.size > MAX_SKILL_FILE_BYTES) throw new Error(`remote skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${entry.relative}`);
  }
  if (!scoped.some(entry => entry.relative === 'SKILL.md')) throw new Error('GitHub skill directory must contain a root SKILL.md');

  const files = [];
  for (let offset = 0; offset < scoped.length; offset += 4) {
    const batch = scoped.slice(offset, offset + 4);
    const loaded = await Promise.all(batch.map(async entry => {
      const encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
      const raw = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodedPath}`;
      return { entry, content: await fetchText(raw, fetchImpl) };
    }));
    for (const { entry, content } of loaded) addTextFile(files, entry.relative, Buffer.from(content, 'utf8'), counter);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const main = files.find(file => file.path === 'SKILL.md');
  const directoryName = directory ? path.posix.basename(directory) : null;
  const metadata = parseFrontmatter(main.content, directoryName);
  return bundleSkill(metadata, files, { kind: 'github', location: source });
}

function bundleSkill(metadata, files, source) {
  files.sort((a, b) => a.path.localeCompare(b.path));
  const canonicalFiles = files.map(file => ({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes }));
  return {
    name: metadata.name,
    description: metadata.description,
    source,
    sha256: sha256(JSON.stringify(canonicalFiles)),
    instructions: metadata.instructions,
    files
  };
}

export async function loadAgentSkills(sources, { fetchImpl = globalThis.fetch } = {}) {
  if (!Array.isArray(sources)) throw new Error('skills must be an array of local paths or public GitHub URLs');
  if (sources.length > MAX_SKILLS_PER_ROLE) throw new Error(`skills may contain at most ${MAX_SKILLS_PER_ROLE} entries per role`);
  if (sources.some(source => typeof source !== 'string' || !source.trim() || source.trim().length > 2048)) {
    throw new Error('each skills entry must be a non-empty path or URL of at most 2048 characters');
  }
  if (new Set(sources.map(source => source.trim())).size !== sources.length) throw new Error('skills must not contain duplicate sources');
  const counter = { totalBytes: 0 };
  const bundles = [];
  for (const rawSource of sources) {
    const source = rawSource.trim();
    const skill = /^https:\/\//i.test(source)
      ? await importGithubDirectory(source, counter, fetchImpl)
      : importLocalDirectory(source, counter);
    if (bundles.some(bundle => bundle.name === skill.name)) throw new Error(`duplicate skill name: ${skill.name}`);
    bundles.push(skill);
  }
  return bundles;
}
