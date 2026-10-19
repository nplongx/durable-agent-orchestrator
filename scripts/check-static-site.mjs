import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteRoot = path.join(root, 'site');
const required = ['index.html', 'styles.css', '404.html', '.nojekyll'];
for (const name of required) {
  const file = path.join(siteRoot, name);
  assert.ok(fs.existsSync(file) && fs.statSync(file).isFile(), `missing static site asset: ${name}`);
}
const html = fs.readFileSync(path.join(siteRoot, 'index.html'), 'utf8');
const notFound = fs.readFileSync(path.join(siteRoot, '404.html'), 'utf8');
const css = fs.readFileSync(path.join(siteRoot, 'styles.css'), 'utf8');
assert.match(html, /<html lang="en">/i, 'site should declare its language');
assert.match(html, /<meta name="description"/i, 'site should declare a search description');
assert.match(html, /<link rel="canonical" href="https:\/\/nplongx\.github\.io\/runalith\/"/, 'site canonical URL should match project Pages URL');
assert.match(html, /\.mcpb/, 'site should explain the MCP bundle format');
assert.match(html, /https:\/\/github\.com\/nplongx\/runalith/, 'site must link to the renamed repository');
assert.match(html, /href="styles\.css"/, 'site should use a relative stylesheet path');
assert.match(notFound, /href="\.\/"/, '404 page should link back to the static site root');
assert.doesNotMatch(`${html}\n${notFound}\n${css}`, /chat on steroids|chat-on-steroids/i, 'public site must use neutral Runalith branding');
assert.doesNotMatch(html, /<script\b|cdn\./i, 'landing page should be static and not require client-side frameworks/CDN assets');
const allIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
for (const match of html.matchAll(/\bhref="#([^"]+)"/g)) {
  assert.ok(allIds.has(match[1]), `site anchor does not resolve: #${match[1]}`);
}
assert.ok(css.length > 1000, 'stylesheet unexpectedly empty');
console.log(`Static site check PASS (${required.length} required files, ${allIds.size} page IDs, accessible local anchors; framework-free HTML/CSS)`);
