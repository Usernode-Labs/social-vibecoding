'use strict';

// #4553: the clap chip on a change page's Addresses row (features/leaderboard/
// kudos.js, opts.thread). It was meant to stay hidden while nobody has said
// thanks, but the wrap's Tailwind inline-block beat the [hidden] preflight
// rule and a "👏 0" chip showed, its number pressed into the clap. Pins:
//
//   1. app.css restates [hidden] at the row's specificity, and gives the
//      chip's button the small gap the "Thank snait" pill already uses;
//   2. renderButton: the wrap carries hidden while the count is 0 with no
//      thanks face, and does not once there is something to show;
//   3. _refreshButton keeps that true afterwards, from the count, so the
//      chip appears on the first thanks and hides again when it drops back
//      to 0 (a live kudos_update or the viewer's own retract included).
//
// Run with: node --test tests/change-thanks-chip.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

if (!globalThis.window) globalThis.window = globalThis;
// kudos.js escapes through a scratch element, as the shell does.
globalThis.document = {
  createElement: () => ({
    _t: '',
    set textContent(v) { this._t = String(v); },
    get innerHTML() { return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  }),
};
globalThis.App = { user: { id: 1, username: 'alice' } };
globalThis.AppView = { readOnly: false };
loadTsx('frontend/src/features/leaderboard/kudos.js');
const Kudos = globalThis.window.Kudos;

const fresh = (over) => ({
  id: 9, status: 'promoted', my_vote: null, user_id: 2, username: 'evan',
  kudos_count: 0, my_kudos: false, my_kudos_direct: false, ...(over || {}),
});

test('app.css keeps the zero chip out of the row and spaces the clap from the number', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-change-chips \.dev-change-thanks\[hidden\] \{ display: none; \}/,
    'the wrap\'s Tailwind inline-block beats the preflight [hidden] rule, so the row restates it');
  assert.match(css, /\.dev-change-chips \.dev-change-thanks > \.gc-vote-btn \{[^}]*gap: 4px;/,
    'the small gap the "Thank snait" pill already uses, so the number no longer runs into the clap');
});

test('renderButton: the Addresses chip is hidden while the count is 0, shown once there are thanks', () => {
  const zero = Kudos.renderButton(fresh({ id: 30, my_vote: 'yes' }), { compact: true, thread: true });
  assert.match(zero, /class="kudos-wrap relative inline-block dev-change-thanks" data-kudos-session="30" data-kudos-variant="count" hidden\s*>/,
    'the wrap is left out of the row while nobody has said thanks');
  assert.match(zero, /<span data-kudos-count>0<\/span>/, 'the count still rides along for the live counter');

  const thanked = Kudos.renderButton(fresh({ id: 31, my_vote: 'yes', kudos_count: 2 }), { compact: true, thread: true });
  assert.match(thanked, /class="kudos-wrap relative inline-block dev-change-thanks" data-kudos-session="31" data-kudos-variant="count">\s*</,
    'the count pill shows once thanks exist');
  assert.doesNotMatch(thanked, /data-kudos-variant="count" hidden/);
  assert.match(thanked, /<span data-kudos-count>2<\/span>/);

  // The thanks face (the viewer has not voted or thanked yet) is never quiet.
  const prompt = Kudos.renderButton(fresh({ id: 32 }), { compact: true, thread: true });
  assert.match(prompt, /data-kudos-variant="thanks"/);
  assert.doesNotMatch(prompt, /data-kudos-variant="thanks" hidden/);
});

test('_refreshButton keeps the zero quiet afterwards, from the count', () => {
  const src = read('frontend/src/features/leaderboard/kudos.js');
  assert.match(src, /if \(wrap\.classList\.contains\('dev-change-thanks'\)\) \{\s*wrap\.hidden = wrap\.getAttribute\('data-kudos-variant'\) === 'count' && !\(\(entry\.count \|\| 0\) > 0\);\s*\}/,
    'the wrap reappears on the first thanks and hides again when the count drops back to 0');
});
