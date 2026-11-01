'use strict';

// The shell follows the reading direction with LOGICAL properties, so one
// `dir` on <html> mirrors every screen and no per-screen rule has to repeat
// the layout. This guard keeps new work on the logical side: a physical
// `margin-left` or `ml-3` added to app.css or frontend/src is a piece of the
// shell that will not mirror in Arabic.
//
// Exceptions are the ones direction cannot answer: a percentage position
// paired with translateX(-50%) is centring, and a centre does not move. The
// English-only admin console is pinned dir="ltr" so its logical utilities
// still render left to right.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const CSS = read('public/css/app.css');

// Tailwind's physical utilities, with the value pattern that keeps prose
// (`right-click`, `left-aligned`, `pr-btn`) and custom class names out.
const VALUE = /^(?:\d+(?:\.\d+)?(?:\/\d+)?|px|auto|full|screen|transparent|current|white|black|inherit|\[[^\]]+\]|[a-z]+-\d{2,3})$/;
const TOKEN = /(?<![\w-])(-?)(ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br)-(\[[^\]]+\]|[a-z0-9][a-z0-9./[\]#%-]*)/g;
const BARE = /(?<![\w-])(text-left|text-right|border-l|border-r|rounded-l|rounded-r)(?![\w-])/g;

function files(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (/(^|\/)(node_modules|dist|build)\//.test(full)) continue;
    if (entry.isDirectory()) files(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('app.css has no physical left/right layout declarations left', () => {
  const offenders = [];
  const lines = CSS.split('\n');
  let inComment = false;
  // One block is physical on purpose and says so: the device's side strip,
  // corner and top band are sides of the HARDWARE (iPhone Duo's column of
  // system chrome), so the native insets that set them are the screen's
  // left/right and the rules that clear them must not mirror in Arabic.
  // app.css marks the block with `direction: physical` / `direction: logical`.
  let hardware = false;
  lines.forEach((line, index) => {
    const text = line.trim();
    if (text.startsWith('/* direction: physical')) hardware = true;
    if (text.startsWith('/* direction: logical')) hardware = false;
    if (hardware) return;
    if (inComment) { if (text.includes('*/')) inComment = false; return; }
    if (text.startsWith('/*')) { if (!text.includes('*/')) inComment = true; return; }
    if (!text || text.startsWith('*') || text.startsWith('//')) return;
    const physical = /(?:^|[;{\s])(margin-left|margin-right|padding-left|padding-right|border-left|border-right|border-left-color|border-right-color|border-left-width|border-right-width|border-top-left-radius|border-top-right-radius|border-bottom-left-radius|border-bottom-right-radius|scroll-margin-left|scroll-margin-right|scroll-padding-left|scroll-padding-right)\s*:/;
    const align = /(?:^|[;{\s])text-align\s*:\s*(left|right)\b/;
    const float = /(?:^|[;{\s])float\s*:\s*(left|right)\b/;
    const position = /(?:^|[;{\s])(left|right)\s*:\s*([^;}]*)/;
    const positionMatch = line.match(position);
    const centring = positionMatch && /^\s*50%\s*$/.test(positionMatch[2]);
    if (physical.test(line) || align.test(line) || float.test(line) || (positionMatch && !centring)) {
      offenders.push(`${index + 1}: ${text}`);
    }
  });
  assert.deepEqual(offenders, [], 'physical left/right declarations do not mirror; use the inline-start/end twins');
});

test('frontend/src uses no physical Tailwind direction utilities', () => {
  const offenders = [];
  for (const file of [...files(path.join(ROOT, 'frontend/src')), ...files(path.join(ROOT, 'frontend/@/components/ui'))]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(BARE)) {
      offenders.push(`${path.relative(ROOT, file)}: ${match[0]}`);
    }
    for (const match of text.matchAll(TOKEN)) {
      const [, , prefix, value] = match;
      if (!VALUE.test(value)) continue;
      // left-1/2 with -translate-x-1/2 centres a box: direction cannot move
      // a centre, and the pair has to stay physical together.
      if ((prefix === 'left' || prefix === 'right') && value === '1/2') continue;
      offenders.push(`${path.relative(ROOT, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'use ms-/me-/ps-/pe-/start-/end-/text-start/text-end/border-s/border-e');
});
