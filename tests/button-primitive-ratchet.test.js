// test:changed: when frontend/src/ (every source there, for hand-written buttons)
// test:changed: when frontend/@/components/ui/button.tsx (the kinds its message names)
// THE BUTTON PRIMITIVE IS HOW A BUTTON IS DRAWN, AND THE HAND-WRITTEN ONES
// CAN ONLY GET FEWER.
//
// The shell's actions come in four kinds (primary, secondary, quiet and
// link), and frontend/@/components/ui/button.tsx draws every one of them:
// its header lists which variant is which kind. Outside the admin console,
// which draws with its own AdminUI recipes by design (AGENTS.md, "One
// language, two surfaces"), a `<button` written by hand is a button that
// spells its own class string, and every such string is one more place the
// look has to be kept in step by hand.
//
// There were about 900 of them when the primitive was given its four kinds,
// too many to move in one change. So this is a RATCHET rather than a ban: it
// counts every `<button` in frontend/src outside features/admin (markup in a
// .tsx file, and markup in a string a .ts or .js file builds) and fails when
// the count goes ABOVE the committed ceiling. A change that moves buttons onto
// the primitive lowers MAX_HAND_WRITTEN_BUTTONS to the new count in the same
// change, so the next one cannot spend the room it made.
//
// A count below the ceiling passes, because changes merge independently: two
// that each lower it must not fail each other once both are in.
//
// Run with: node --test tests/button-primitive-ratchet.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'frontend', 'src');
const ADMIN = path.join(SRC, 'features', 'admin');

/** The most hand-written buttons frontend/src may hold. Lower it; never raise it. */
const MAX_HAND_WRITTEN_BUTTONS = 861;

/** A `<button` element's opening, in JSX or in markup a string builds. */
const OPENING = /<button(?=[\s>/]|$)/gm;

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === ADMIN || entry.name === 'node_modules') continue;
      sources(full, out);
    } else if (/\.(?:tsx?|jsx?|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function count() {
  const perFile = [];
  let total = 0;
  for (const file of sources(SRC)) {
    const n = (fs.readFileSync(file, 'utf8').match(OPENING) || []).length;
    if (n) {
      perFile.push([path.relative(ROOT, file), n]);
      total += n;
    }
  }
  perFile.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { total, perFile };
}

test('the hand-written <button> count in frontend/src (outside the admin console) is at or under its ceiling', () => {
  const { total, perFile } = count();
  const most = perFile.slice(0, 8).map(([file, n]) => `  ${n}  ${file}`).join('\n');
  assert.ok(
    total <= MAX_HAND_WRITTEN_BUTTONS,
    `frontend/src has ${total} hand-written <button> elements, ${total - MAX_HAND_WRITTEN_BUTTONS} over the ceiling of ${MAX_HAND_WRITTEN_BUTTONS}.\n`
    + 'Draw the new button with the Button primitive (frontend/@/components/ui/button.tsx): pick the variant for its kind '
    + '(primary, secondary, quiet or link; the file\'s header says which is which) and the size the screen needs, '
    + 'and widen its table, in the order the shell writes its classes, only when no value writes them already. '
    + 'Do not raise MAX_HAND_WRITTEN_BUTTONS.\nThe files with the most:\n' + most,
  );
});

test('the counter sees the shapes a hand-written button is written in, and only those', () => {
  const sample = [
    '<button type="button" className="x">a</button>',
    '<button\n  type="button"\n>',
    '<button>b</button>',
    "el.innerHTML = '<button class=\"y\">c</button>';",
    '<Button variant="pillAccent">d</Button>',
    '<buttonish />',
    'a <button-group> tag',
  ].join('\n');
  assert.equal((sample.match(OPENING) || []).length, 4);
});

test('the admin console is left out, and the primitive itself is not under frontend/src', () => {
  const files = sources(SRC);
  assert.ok(files.length > 100, 'the walk finds the shell\'s sources');
  assert.ok(!files.some((f) => f.startsWith(ADMIN + path.sep)), 'nothing under features/admin is counted');
  assert.ok(fs.existsSync(path.join(ROOT, 'frontend', '@', 'components', 'ui', 'button.tsx')), 'the primitive lives under frontend/@');
});
