'use strict';

// One bubble, not two: your turn is a card, the agent's is plain text.
//
// Both were filled surfaces — yours a solid `--accent`, the agent's
// `--bubble-bg` — which made a two-party conversation two competing blocks of
// colour and put the transcript's loudest element on the half a reader wrote
// themselves and does not need to re-read.
//
// The accent fill is the part worth guarding, because keeping type legible on
// it took seven rules and three contrast incidents recorded in app.css:
//
//   * white on the eyedropped #0a7cff is 3.93:1, which is why `--accent` was
//     darkened to #0a6ee0 in the first place;
//   * `--accent-ink` then had to invert the body, the header, and the two
//     header slots that declared colour INLINE and so beat every class rule;
//   * and the 0.72 opacity that quietened the stamp had to be re-scoped off
//     the role label after it took that one word to 2.7:1.
//
// None of that says anything a reader needs. Side, shape and surface already
// say whose turn it is. This file pins that the fill does not come back and
// that its machinery stayed retired.
//
// Run with: node --test tests/dev-chat-bubbles.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_CSS = read('public/css/app.css');
const TRANSCRIPT = read('frontend/src/features/dev-chat/transcript.tsx');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

function rule(sel) {
  const at = APP_CSS.indexOf(`\n${sel} {`);
  assert.ok(at > 0, `${sel} must be declared`);
  return APP_CSS.slice(at, APP_CSS.indexOf('}', at));
}

test('your turn is a quiet tint, not a saturated fill and not the card surface', () => {
  const r = rule('.dc-msg-user');
  // This was --dc-raised, the ladder's third step — and that was the bug:
  // --dc-raised is the token the coding-run card, the PR card and the stopped
  // card also fill with, so your message and the agent's cards came out the
  // identical grey. See tests/dev-chat-ground.test.js for the pair of cues
  // that replaced it.
  assert.doesNotMatch(r, /var\(--dc-raised\)/,
    'that is the agent cards\' own surface');
  assert.match(r, /background: var\(--accent-tint\)/);
  // The retired fill stays retired: a TINT is 8% of the accent over the
  // sheet, which the page's own ink reads against. The FILL was the accent
  // itself, which needed --accent-ink and six more inversion rules.
  assert.doesNotMatch(r, /var\(--accent\)[^-]/, 'never the accent fill again');
  assert.doesNotMatch(r, /var\(--accent-ink\)/, 'and so it needs no inverted ink');
});

test('the agent\'s turn is plain text on the ground', () => {
  assert.match(rule('.dc-msg-assistant'), /background: transparent/);
});

test('the fill\'s seven-rule ink inversion is gone with the fill', () => {
  // Each of these existed ONLY to keep type readable on the accent.
  for (const gone of [
    '.dc-msg-user .dc-msg-content',
    '.dc-msg-user .dc-msg-header',
    '.dc-msg-user .dc-msg-meta',
    '.dc-msg-user .dc-msg-content a',
  ]) {
    assert.ok(!APP_CSS.includes(gone), `${gone} was a consequence of the fill`);
  }
  // And the stamp keeps the quiet it had on a neutral surface: --text-muted
  // at 9px, with no opacity — that was the fill's device, and halving an
  // already-muted token is what took the label to 2.7:1.
  const meta = rule('.dc-msg-meta');
  assert.match(meta, /color: var\(--text-muted\)/);
  assert.match(meta, /font-size: 9px/);
  assert.doesNotMatch(meta, /opacity/);
});

test('--bubble-bg is retired; --accent-ink is not', () => {
  // --bubble-bg existed only because --bg-primary IS the page ground in dark,
  // so a bubble drawn on it vanished. With the agent's turn as plain text
  // there is nothing to keep distinct and it had no other reader.
  assert.doesNotMatch(APP_CSS, /--bubble-bg\s*:/, 'the token is gone');
  assert.doesNotMatch(APP_CSS, /var\(--bubble-bg\)/, 'and so is every use');

  // --accent-ink STAYS. It is the near-black-on-light-accent pair, and
  // .messages-state button is still a real accent fill — retiring it with the
  // bubble would have taken a live button's contrast with it.
  assert.match(APP_CSS, /--accent-ink: #ffffff;/);
  assert.match(APP_CSS, /--accent-ink: #0b0b0c;/);
  assert.match(rule('.messages-state button'), /color: var\(--accent-ink\)/);
});

test('"You" is read, not shown — and the agent\'s label still is', () => {
  const { Row } = loadTsx('frontend/src/features/dev-chat/transcript.tsx');
  const mine = renderToHtml(createElement(Row, {
    r: { t: 'msg', key: 'a', who: 'user', model: '', stamp: '#1', contentHtml: '<p>hi</p>' },
  }));
  // Present for a screen reader — alignment is not available to one, and it
  // is the audience the word was actually telling.
  assert.match(mine, /class="sr-only">You</,
    'the role stays in the accessible tree');

  const theirs = renderToHtml(createElement(Row, {
    r: { t: 'msg', key: 'b', who: 'ai', model: 'claude-opus · reply $0.03', stamp: '#2', contentHtml: '<p>ok</p>' },
  }));
  assert.match(theirs, /text-emerald-700 dark:text-emerald-400">AI</,
    'the agent keeps a visible label: it opens a meta line that also carries '
    + 'the model and the cost, so it is a sentence rather than a tag');
  assert.match(theirs, /claude-opus · reply \$0\.03/);
});

test('the two rows are still told apart by side and surface', () => {
  assert.match(rule('.dc-msg-user'), /margin-left: auto/);
  assert.match(rule('.dc-msg-assistant'), /margin-right: auto/);
  // Same radius on both: the deck's bubbles rely on side and surface, not on
  // a tail notch. (The notch went in the reskin; this keeps it gone.)
  assert.match(rule('.dc-msg-user'), /border-radius: 1\.25rem/);
  assert.match(rule('.dc-msg-assistant'), /border-radius: 1\.25rem/);
});

test('the three GROUNDS ascend in both themes; the card only has to differ', () => {
  // The bug: --bg-secondary / --bg-primary ascend in light (#f5f5f7 →
  // #ffffff) and DESCEND in dark (#1c1c1e → #0b0b0c). The lift was built on
  // that pairing, so in dark the session sheet came out as the darkest thing
  // on the screen — a near-black hole in the #0b0d1b wallpaper, with the
  // strip above it lighter than both. Measured before the fix: wallpaper
  // (11,13,27) → strip (28,28,30) → sheet (11,11,12). Nothing about it was
  // visible until the agent's turn stopped being a --bubble-bg card and
  // became plain text on that ground.
  //
  // The GROUNDS are what must climb: each layer nearer the reader is lighter
  // than the one behind it, in both themes. A CARD is the other kind of
  // step — on white it is a grey inset, on near-black it is a lighter raise —
  // so its direction flips by theme and only its DISTANCE from the sheet is
  // the invariant. Asserting "lighter" on it is what a first draft of this
  // test did, and light mode caught it.
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const val = (block, name) => {
    const m = block.match(new RegExp(`${name}: (#[0-9a-f]{6});`));
    assert.ok(m, `${name} must be declared`);
    return m[1];
  };
  const light = APP_CSS.slice(0, APP_CSS.indexOf('\n.dark {'));
  const dark = APP_CSS.slice(APP_CSS.indexOf('\n.dark {'));
  for (const [theme, block, ground] of [
    ['light', light, '#f4f2e4'],
    ['dark', dark, '#0b0d1b'],
  ]) {
    const grounds = [ground, val(block, '--dc-strip'), val(block, '--dc-sheet')];
    for (let i = 1; i < grounds.length; i++) {
      assert.ok(lum(grounds[i]) > lum(grounds[i - 1]),
        `${theme}: ${grounds[i]} must be nearer the reader than ${grounds[i - 1]}`);
    }
    const sheet = val(block, '--dc-sheet');
    const raised = val(block, '--dc-raised');
    assert.ok(Math.abs(lum(raised) - lum(sheet)) >= 8,
      `${theme}: a card (${raised}) must be visibly off the sheet (${sheet})`);
  }
});

test('light mode is byte-identical — only dark moved', () => {
  // The ladder's light values ARE the tokens the lift shipped with, so a
  // reader who liked light mode sees exactly what they saw.
  const light = APP_CSS.slice(0, APP_CSS.indexOf('\n.dark {'));
  assert.match(light, /--dc-strip: #f5f5f7;/, "--bg-secondary's value");
  assert.match(light, /--dc-sheet: #ffffff;/, "--bg-primary's value");
  assert.match(light, /--dc-raised: #f5f5f7;/, "--bg-secondary's value again");
});

test('nothing in the transcript reads the raw surface tokens any more', () => {
  // The sweep this pins. Moving the sheet in dark left every OTHER card in
  // the transcript sitting on the wrong step: a rule on --bg-secondary was
  // flush with the new sheet (both #1c1c1e) and one on --bg-primary was
  // DARKER than it (#0b0b0c) — a hole rather than an inset. The worst of
  // them was .dc-pr-card, which carries the before/after strip and the
  // Propose button.
  //
  // The swap is light-identical BY CONSTRUCTION, which is the only reason it
  // could be done mechanically: --dc-sheet is --bg-primary's light value and
  // --dc-raised is --bg-secondary's, asserted above.
  const rules = APP_CSS.split('}');
  const offenders = [];
  for (const r of rules) {
    const head = r.slice(0, r.indexOf('{'));
    if (!/\.dc-[a-z0-9-]/.test(head)) continue;
    if (/background(-color)?\s*:\s*var\(--bg-(primary|secondary)\)/.test(r)) {
      offenders.push(head.trim().split('\n').pop().trim());
    }
  }
  assert.deepEqual(offenders, [],
    'a .dc- surface must take the ladder, not the raw token');
});
