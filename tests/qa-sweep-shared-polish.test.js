'use strict';

// QA sweep 2026-09-24, shared polish: the smaller Leaderboard, Profile,
// Settings and notifications findings, each pinned where it lives.
//
//   Q34   Settings → Anthropic API key: spaces either side of the link
//   Q32c  Standings "done · View challenges" spacing; My history kind chips
//   Q30e  Profile header on a phone: the button drops under the name
//   Q30f  Notifications sheet: invites flow in the sheet, fold past three
//   Q24   Settings: the open section's sheet runs to the bottom of the screen
//
// Q17, Q21, Q25, Q28 and Q31 are pinned beside the code they touch
// (home-panels-*, challenge-*, standings-screen, overlay-scrim, native-kit,
// platform-ui and nav-recents tests).
//
// Run with: node --test tests/qa-sweep-shared-polish.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Q34: the API key note has a space either side of the spend-limits link', () => {
  const { ApiKeySection } = loadTsx('frontend/src/features/settings/sections/api-key.tsx');
  const html = renderToHtml(createElement(ApiKeySection));
  assert.match(html,
    /that level of access\. <a href="https:\/\/console\.anthropic\.com\/settings\/keys"[^>]*>Set tight spend limits<\/a> on the key itself for defense in depth\./);
  const src = read('frontend/src/features/settings/sections/api-key.tsx');
  assert.doesNotMatch(src, /\{' '\}/, 'no whitespace-only child: it cannot survive hydration (React #418)');
});

test('Q32c: the standings line reads "done · View challenges", spaced both sides', () => {
  const src = read('frontend/src/features/leaderboard/topochain-standings.tsx');
  const line = src.slice(src.indexOf('function ChallengeLine('), src.indexOf('function Cell('));
  assert.match(line, /`\$\{line\.done\} of \$\{line\.total\} challenges done `/, 'the space before the dot');
  assert.match(line, /<span className="text-zinc-500 dark:text-zinc-500">\{'· '\}<\/span>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<button/,
    'and the space after it, inside the dot\'s own span');
});

test('Q32c: My history names a proposal\'s kind in words, never the column value', () => {
  const had = Object.prototype.hasOwnProperty.call(global, 'window');
  const saved = global.window;
  global.window = {};
  try {
    loadTsx('frontend/src/features/leaderboard/leaderboard.js');
    const { Leaderboard } = global.window;
    assert.ok(Leaderboard && typeof Leaderboard._kindLabel === 'function');
    assert.deepEqual(
      ['secret_change', 'rename', 'close_issue', 'featured_illustration', 'maintenance_campaign']
        .map((k) => Leaderboard._kindLabel(k)),
      ['Secret change', 'Rename', 'Close issue', 'Featured illustration', 'Maintenance campaign']);
    assert.equal(Leaderboard._kindLabel('brand_new_kind'), 'Brand new kind', 'a newer kind still reads as words');
    assert.equal(Leaderboard._kindLabel(''), '');
    // Every governance kind the server knows has a label of its own.
    const kinds = [...read('src/services/governance-kinds.js')
      .matchAll(/^ {2}'([a-z_]+)',$/gm)].map((m) => m[1]);
    assert.ok(kinds.length >= 5);
    for (const kind of kinds) {
      assert.ok(Object.prototype.hasOwnProperty.call(Leaderboard._KIND_LABELS, kind), `${kind} has a label`);
    }
    const lb = read('frontend/src/features/leaderboard/leaderboard.js');
    assert.match(lb, /tone: 'sky', text: Leaderboard\._kindLabel\(it\.issue\.kind\)/);
  } finally {
    if (had) global.window = saved;
    else delete global.window;
  }
});

test('Q30e: on a phone the Edit button drops under the name, lined up with it', () => {
  const src = read('frontend/src/features/profile/profile-view.tsx');
  const at = src.indexOf('function IdentityCard(');
  const card = src.slice(at, src.indexOf('</Button>', at));
  assert.match(card, /<div className="flex flex-col gap-3 sm:flex-row sm:items-center">/,
    'stacked below sm, one row from sm up');
  assert.match(card, /className="self-start ml-\[68px\] sm:self-auto sm:ml-0"/,
    'under the text column: the 56px avatar plus the 12px gap');
  assert.match(card, /font-bold break-words line-clamp-2">\{identity\.name\}/,
    'a long name wraps to two lines rather than losing its end');
  assert.doesNotMatch(card, /font-bold truncate/);
});

test('Q30f: invites scroll with the sheet and fold past three behind "Show N more"', () => {
  const { visibleInvites, INVITES_SHOWN, INVITES_FOLD_AFTER } = loadTsx('frontend/src/features/notifications/notifications-list.tsx');
  assert.equal(INVITES_SHOWN, 2);
  assert.equal(INVITES_FOLD_AFTER, 3);
  const list = (n) => Array.from({ length: n }, (_, i) => i + 1);
  assert.deepEqual(visibleInvites(list(3), false), { shown: [1, 2, 3], hidden: 0 },
    'three fit: folding one would take the room it saves');
  assert.deepEqual(visibleInvites(list(5), false), { shown: [1, 2], hidden: 3 });
  assert.deepEqual(visibleInvites(list(5), true), { shown: list(5), hidden: 0 }, 'opened: all of them');
  assert.deepEqual(visibleInvites([], false), { shown: [], hidden: 0 });

  const src = read('frontend/src/features/notifications/notifications-list.tsx');
  assert.match(src, /<div id="notifications-invites" className="shrink-0">/,
    'no scroller of its own inside the sheet\'s scroller (it was overflow-y-auto max-h-48)');
  assert.match(src, /\{`Show \$\{hiddenInvites\} more \$\{hiddenInvites === 1 \? 'invite' : 'invites'\}`\}/);
  assert.match(src, /const \[invitesOpen, setInvitesOpen\] = useState\(false\);/);
});

test('Q24: the open section\'s sheet runs to the bottom, like every sheet on the ladder', () => {
  const css = read('public/css/app.css');
  const sheet = css.slice(css.indexOf('.settings-sheet {'), css.indexOf('}', css.indexOf('.settings-sheet {')));
  assert.doesNotMatch(sheet, /min-height/, 'no fixed 60vh box that ends mid-screen');
  assert.match(css, /html\[data-browser-scroller="settings-screen"\] #settings-screen:has\(#settings-section-content:not\(\.hidden\)\) \{\n  flex: 1 0 auto;\n\}/,
    'on a phone the strip fills the screen instead of stopping at its content');
  assert.match(css, /#settings-content-col > \.settings-sheet \{\n  flex: 1 0 auto;\n  margin-bottom: calc\(-1 \* max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom, 0px\)\)\);\n  padding-bottom: calc\(32px \+ max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom, 0px\)\)\);\n\}/,
    'the sheet takes the rest of the height, runs under the tab bar and still clears it');
  // Scoped to an open section: the phone's level-1 menu keeps its layout.
  for (const sel of ['#settings-screen:not(.hidden):has(', '#settings-root:has(', '#settings-content-col:has(']) {
    assert.ok(css.includes(`${sel}${sel.startsWith('#settings-content-col') ? '> ' : ''}#settings-section-content:not(.hidden))`),
      `${sel} is scoped to an open section`);
  }
  // The sheet is still the lift's session plane, whose square foot is drawn
  // for exactly this: a sheet that runs off the bottom.
  const island = read('frontend/src/features/settings/index.tsx');
  assert.match(island, /<div id="settings-section-content" className="settings-sheet dc-lift dc-lift-session">/);
});
