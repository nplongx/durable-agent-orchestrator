import assert from 'node:assert/strict';
import { findMarkdownLinks } from '../scripts/check-docs.mjs';

const markdown = [
  '# Link parser regression',
  '',
  '[inline](./inline.md)',
  '![image](./image.png "image title")',
  '[full][guide-ref] and [collapsed][] and [shortcut]',
  '[external][site]',
  '',
  '[guide-ref]: <./guide.md#safe-heading> "guide title"',
  '[collapsed]: ./collapsed.md',
  '[shortcut]: ./shortcut.md',
  '[site]: https://example.org/docs',
  '',
  '```md',
  '[fake](./not-a-link.md)',
  '[fake-ref][missing]',
  '```',
  '',
  '`[also-fake](./inline-code.md)`',
].join('\n');

assert.deepEqual(findMarkdownLinks(markdown), [
  { target: './inline.md', line: 3 },
  { target: './image.png', line: 4 },
  { target: './guide.md#safe-heading', line: 5 },
  { target: './collapsed.md', line: 5 },
  { target: './shortcut.md', line: 5 },
  { target: 'https://example.org/docs', line: 6 },
]);

console.log('DOC MARKDOWN LINK PARSER PASS (inline/image, reference/full/collapsed/shortcut, code masking, source lines)');
