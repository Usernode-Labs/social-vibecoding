'use strict';

// #6726: a vote count keeps its slot when it reaches two digits.
//
// At "9" a change's Votes card and the vote picker's Yes/No halves laid out
// one way; at "10" the wider number dropped the figure onto its own line (or
// moved the label), pushing the Vote and Cancel buttons under the reader's
// finger. The fix reserves the width instead:
//
//   1. the Yes/No tallies hold a slot wide enough for "10/10" and do not
//      wrap, so the switch's halves keep their size;
//   2. on a phone the Votes card's head keeps its
//      name and figure on one line; the figure ends in "…" if the sentence
//      is ever too long, and its full words stay in the `title`;
//   3. the figure's own look (size, weight, colour, tabular digits) is
//      unchanged.
//
// Run with: node --test tests/vote-count-width.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs
  .readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const CHANGE_HEAD = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/dev-board/topic/change-head.tsx'),
  'utf8'
);

const PHONE = '@media (max-width: 640px)';

// Every rule in the stylesheet with the at-rule it sits inside, so the phone
// rule is told apart from the base rule of the same selector.
function rules(css) {
  const out = [];
  const stack = [];
  let buf = '';
  for (const ch of css) {
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      const selector = stack.pop();
      if (selector && !selector.startsWith('@')) {
        out.push({ selector, body: buf, context: stack.join(' ') });
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

const RULES = rules(CSS);

function bodies(selector, match = () => true) {
  const found = RULES.filter((r) => r.selector === selector && match(r));
  assert.ok(found.length, `a rule for ${selector}`);
  return found;
}

// ── 1. The vote switch's tallies ─────────────────────────────────────

test('the Yes and No counts hold a two-digit slot and the switch does not wrap', () => {
  const opt = bodies('.dev-vote-switch-opt', (r) => r.context === '')[0].body;
  assert.match(opt, /white-space:\s*nowrap/,
    'the half stays on one line, so the count cannot move the label');

  const tally = bodies('.dev-vote-switch-opt .dev-vote-n', (r) => r.context === '')[0].body;
  assert.match(tally, /min-width:\s*5ch/,
    'five tabular digits is "10/10", the widest count the slot must hold');
  assert.match(tally, /display:\s*inline-block/);
  assert.match(tally, /flex:\s*none/,
    'the slot keeps its width when the half runs out of room');
  assert.match(tally, /text-align:\s*start/);
  assert.match(tally, /font-variant-numeric:\s*tabular-nums/,
    'digits stay tabular, so 9 and 10 take the same room');
  // The look is unchanged: the fix is width only.
  assert.match(tally, /font-size:\s*11px/);
  assert.match(tally, /font-weight:\s*500/);
  assert.match(tally, /color:\s*var\(--text-muted\)/);
});

test('the sheet and Needs you sizes still win, changing only the font size', () => {
  for (const scope of ['.dev-vote-sheet', '.dev-ws-vote-form']) {
    const rule = bodies(`${scope} .dev-vote-switch-opt .dev-vote-n`, (r) => r.context === '')[0].body;
    assert.match(rule, /font-size:\s*12\.5px/);
    assert.doesNotMatch(rule, /min-width|display|flex:/,
      `${scope} changes only the size; the slot comes from the base rule`);
  }
});

// ── 2. The Votes card's head ─────────────────────────────────────────

test('on a phone the Votes head keeps its figure on one line', () => {
  const inPhone = (r) => r.context.includes(PHONE);
  const head = bodies('.dev-change-gate-head', inPhone)[0].body;
  assert.match(head, /flex-wrap:\s*nowrap/, '10 cannot wrap under the name');
  assert.doesNotMatch(head, /flex-wrap:\s*wrap/, 'the old wrapping rule is gone');

  const name = bodies('.dev-change-gate-name', inPhone)[0].body;
  assert.match(name, /flex:\s*none/, 'the name "Votes" keeps its width');

  const figure = bodies('.dev-change-gate-figure', inPhone)[0].body;
  assert.match(figure, /white-space:\s*nowrap/);
  assert.match(figure, /text-overflow:\s*ellipsis/,
    'a sentence too long for the line ends in "…" instead of wrapping');
});

// ── 3. The elided sentence is still readable ────────────────────────

test('the Votes figure keeps its whole sentence in a title', () => {
  assert.match(
    CHANGE_HEAD,
    /<span className="dev-change-gate-figure" title=\{g\.figure\}>\{g\.figure\}<\/span>/,
    'a cut-off figure can still be read in full, by hover and by a screen reader'
  );
});
