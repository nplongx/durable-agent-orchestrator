#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitFiles(args) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'ls-files', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not enumerate repository files with git ls-files: ${details}`);
  }
}

function removeCodeBlocks(markdown) {
  return markdown
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (block) =>
      block.replace(/[^\n]/g, ' '),
    )
    .replace(/(^|[^\\])`+[^`\n]*`+/g, '$1');
}

function findMarkdownLinks(markdown) {
  // Intentionally checks inline Markdown links/images. Reference-style links are
  // not parsed here; the checker is a guard against common broken local targets.
  const withoutCode = removeCodeBlocks(markdown);
  const links = [];
  const linkPattern = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

  for (const match of withoutCode.matchAll(linkPattern)) {
    const rawTarget = match[1].startsWith('<') && match[1].endsWith('>')
      ? match[1].slice(1, -1)
      : match[1];
    const offset = match.index ?? 0;
    const line = withoutCode.slice(0, offset).split('\n').length;
    links.push({ target: rawTarget, line });
  }

  return links;
}

function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

function decodePath(target) {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function githubHeadingSlugs(markdown) {
  const slugs = new Set();
  const occurrences = new Map();
  const headingPattern = /^#{1,6}\s+(.+?)\s*#*\s*$/gm;

  for (const match of markdown.matchAll(headingPattern)) {
    const heading = match[1]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/`/g, '')
      .trim()
      .toLocaleLowerCase();
    const base = heading
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    slugs.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }

  return slugs;
}

function check() {
  const allFiles = new Set(gitFiles(['-co', '--exclude-standard']));
  const markdownFiles = [...allFiles]
    .filter((file) => file.toLowerCase().endsWith('.md'))
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .sort();
  const trackedHtml = gitFiles(['-c', '--', 'docs/diagrams/rendered/*.html']);
  const errors = [];
  let linkCount = 0;

  for (const htmlFile of trackedHtml) {
    errors.push(`${htmlFile}: standalone generated HTML should not be committed as the GitHub documentation view`);
  }

  for (const markdownFile of markdownFiles) {
    const sourcePath = path.join(repoRoot, markdownFile);
    const markdown = readFileSync(sourcePath, 'utf8');
    const links = findMarkdownLinks(markdown);

    for (const { target: rawTarget, line } of links) {
      if (!rawTarget || isExternal(rawTarget)) continue;
      linkCount += 1;

      const target = decodePath(rawTarget);
      const targetWithoutFragment = target.split('#', 1)[0].split('?', 1)[0];
      const fragment = target.includes('#') ? target.slice(target.indexOf('#') + 1).split('?', 1)[0] : '';

      if (targetWithoutFragment.toLowerCase().endsWith('.html')) {
        errors.push(`${markdownFile}:${line}: local HTML link is not a supported primary documentation view: ${rawTarget}`);
        continue;
      }

      const resolved = targetWithoutFragment
        ? path.resolve(path.dirname(sourcePath), targetWithoutFragment)
        : sourcePath;
      const relativeResolved = path.relative(repoRoot, resolved);
      if (relativeResolved === '..' || relativeResolved.startsWith(`..${path.sep}`) || path.isAbsolute(relativeResolved)) {
        errors.push(`${markdownFile}:${line}: local link escapes the repository: ${rawTarget}`);
        continue;
      }

      if (!existsSync(resolved)) {
        errors.push(`${markdownFile}:${line}: local target does not exist: ${rawTarget}`);
        continue;
      }

      if (fragment && path.extname(resolved).toLowerCase() === '.md') {
        const targetMarkdown = readFileSync(resolved, 'utf8');
        const slugs = githubHeadingSlugs(targetMarkdown);
        if (!slugs.has(fragment.toLowerCase())) {
          errors.push(`${markdownFile}:${line}: heading anchor not found in ${path.relative(repoRoot, resolved)}: #${fragment}`);
        }
      }

      try {
        const details = statSync(resolved);
        if (!details.isFile() && !details.isDirectory()) {
          errors.push(`${markdownFile}:${line}: local target is not a file or directory: ${rawTarget}`);
        }
      } catch {
        errors.push(`${markdownFile}:${line}: could not inspect local target: ${rawTarget}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(`Documentation check failed with ${errors.length} issue(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Documentation check passed: ${markdownFiles.length} Markdown files and ${linkCount} local links checked.`);
}

try {
  check();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
