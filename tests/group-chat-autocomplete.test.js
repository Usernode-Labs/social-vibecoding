// The group chat composer's autocomplete menus — `@name` and
// `#123` / `PR#123` — after #1191 made their contents React's, and the
// `:shortcode` emoji menu that was React from its first row.
//
// ── Why this file is new ──────────────────────────────────────────────
//
// Neither menu had a test. They were built by `menu.innerHTML = items.map(…)`
// inside public/js/group-chat.js, and the only thing standing between an
// organiser-chosen issue title (or a username) and the page was an
// `escapeHtml` call in that template. Converting the markup is the moment to
// give the rules that were only implicit somewhere to live:
//
//   1. Untrusted text — a username, an issue title — reaches the DOM as a
//      text node, never as markup.
//   2. The highlighted row is the one at `active`, and exactly one row has
//      the class the arrow keys used to toggle by hand.
//   3. The attributes the delegated `mousedown` handler reads are on the row.
//      That handler is bound ONCE, to the host, and reads `data-username` /
//      `data-kind` + `data-number`; a row that stopped carrying them would
//      make the menu silently unclickable while looking correct.
//   4. The two visual affordances the dropdown exists to teach: "you" beside
//      your own name, and the violet PR# / emerald # badge.
//
// Run with: node --test tests/group-chat-autocomplete.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { renderComponent } = require('./lib/render-tsx');

const MENUS = 'frontend/src/features/group-chat/autocomplete.tsx';
const mention = (slot) => renderComponent(MENUS, 'MentionMenuView', slot);
const refs = (slot) => renderComponent(MENUS, 'RefMenuView', slot);
const emoji = (slot) => renderComponent(MENUS, 'EmojiMenuView', slot);

const gcJs = read('public/js/group-chat.js');

test('a closed menu draws nothing', () => {
  // `close()` publishes an empty slot rather than clearing innerHTML, so this
  // is what "closed" now renders. The host keeps its own `hidden`, which is
  // still the module's — the menu is position:fixed and placed by measurement.
  assert.equal(mention({ items: [], active: -1 }), '');
  assert.equal(refs({ items: [], active: -1 }), '');
  assert.equal(emoji({ items: [], active: -1, query: '' }), '');
});

test('a username can never escape into markup', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const html = mention({ items: [{ username: hostile, you: false }], active: 0 });
  assert.ok(!html.includes('<img'), 'the tag never lands as markup');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('an issue title can never escape into markup', () => {
  const html = refs({
    items: [{ kind: 'issue', number: 7, title: '<script>alert(1)</script> "quoted"' }],
    active: 0,
  });
  assert.ok(!html.includes('<script'), 'the tag never lands as markup');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;quoted&quot;/);
});

test('exactly one row is highlighted, and it is the one at `active`', () => {
  const items = [
    { username: 'alice', you: false },
    { username: 'bob', you: false },
    { username: 'carol', you: false },
  ];
  for (const active of [0, 1, 2]) {
    const html = mention({ items, active });
    assert.equal((html.match(/gc-mention-option-active/g) || []).length, 1,
      `active=${active}: one highlight`);
    // …and it is the row whose `data-index` matches.
    const row = html.match(
      new RegExp(`<div class="gc-mention-option gc-mention-option-active"[^>]*data-index="(\\d+)"`)
    );
    assert.ok(row, `active=${active}: found the highlighted row`);
    assert.equal(Number(row[1]), active, `active=${active}: on the right row`);
  }
  // A closed-but-populated slot (-1) highlights nothing, which is what the
  // module publishes between a token change and the first arrow key.
  assert.equal((mention({ items, active: -1 }).match(/gc-mention-option-active/g) || []).length, 0);
});

test('every row carries what the delegated mousedown handler reads', () => {
  // The handler is bound once, on the host, by `_ensureMenu` — deliberately,
  // because it must preventDefault() to keep the composer focused. It finds
  // the row with `closest('.gc-mention-option')` and reads its dataset, so
  // the class and the attributes are the whole contract between them.
  assert.match(gcJs, /menu\.addEventListener\('mousedown'[\s\S]{0,320}?closest\('\.gc-mention-option'\)/);
  assert.match(gcJs, /MentionAutocomplete\.accept\(opt\.dataset\.username\)/);
  assert.match(gcJs, /RefAutocomplete\.accept\(opt\.dataset\.kind, opt\.dataset\.number\)/);

  const m = mention({ items: [{ username: 'alice', you: false }], active: 0 });
  assert.match(m, /class="gc-mention-option gc-mention-option-active"/);
  assert.match(m, /data-username="alice"/);
  assert.match(m, /data-index="0"/);
  assert.match(m, /role="option"/);

  const r = refs({ items: [{ kind: 'pr', number: 42, title: 'Fix the header' }], active: 0 });
  assert.match(r, /class="gc-mention-option gc-ref-option gc-mention-option-active"/);
  assert.match(r, /data-kind="pr"/);
  assert.match(r, /data-number="42"/);
});

test('the dropdown teaches the two renderings it inserts', () => {
  // "you" beside your own name — the module decides it, where the viewer is
  // known, and only your row gets it.
  const html = mention({
    items: [{ username: 'alice', you: false }, { username: 'me', you: true }],
    active: 0,
  });
  assert.equal((html.match(/gc-mention-option-you/g) || []).length, 1);
  assert.match(html, /data-username="me"[\s\S]*?gc-mention-option-you/);
  assert.match(html, /gc-mention-option-at">@<\/span>alice/);

  // The badge reuses the message-chip classes, so the dropdown looks like
  // what it is about to insert: violet PR#N, emerald #N.
  const pr = refs({ items: [{ kind: 'pr', number: 9, title: 'A' }], active: 0 });
  assert.match(pr, /class="gc-ref gc-ref-pr">PR#9</);
  const issue = refs({ items: [{ kind: 'issue', number: 9, title: 'A' }], active: 0 });
  assert.match(issue, /class="gc-ref gc-ref-issue">#9</);
});

test('the emoji menu: a heading, then a listbox of glyph + `:code:` rows', () => {
  const items = [
    { emoji: '👍', shortcode: 'thumbsup' },
    { emoji: '👎', shortcode: 'thumbsdown' },
  ];
  const html = emoji({ items, active: 1, query: 'thu' });
  assert.match(html, /^<div class="gc-emoji-menu-heading">Emoji matching <span class="gc-emoji-menu-query">:thu<\/span><\/div>/);
  assert.match(html, /<div role="listbox" aria-label="Emoji">/);
  assert.equal((html.match(/role="option"/g) || []).length, 2);
  // The highlight is the shared class the arrow keys move, on the row at `active`.
  assert.equal((html.match(/gc-mention-option-active/g) || []).length, 1);
  assert.match(html, /class="gc-mention-option gc-emoji-option gc-mention-option-active" role="option" aria-selected="true" data-emoji="👎" data-shortcode="thumbsdown" data-index="1"/);
  assert.match(html, /<span class="gc-emoji-option-glyph" aria-hidden="true">👍<\/span><span class="gc-emoji-option-code">:thumbsup:<\/span>/);
  // The delegated handler reads `data-emoji` off `.gc-emoji-option`.
  assert.match(gcJs, /menu\.addEventListener\('mousedown'[\s\S]{0,320}?closest\('\.gc-emoji-option'\)/);
  assert.match(gcJs, /EmojiAutocomplete\.accept\(opt\.dataset\.emoji\)/);
});

test('the emoji menu rides the same seams as the other two', () => {
  // Attached to both composers, like the mention and reference menus.
  const appView = read('public/js/app-view.js');
  assert.match(appView, /EmojiAutocomplete\.attach\(gcInput\)/);
  assert.match(gcJs, /RefAutocomplete\.attach\(input, slug\);\s*\}\s*\/\/[^\n]*\n\s*if \(typeof EmojiAutocomplete !== 'undefined'\) \{\s*EmojiAutocomplete\.attach\(input\);/);
  // Capture-phase keydown, like theirs, so Enter/Tab insert instead of sending.
  assert.match(gcJs, /input\.addEventListener\('keydown', \(e\) => \{\s*if \(EmojiAutocomplete\._input === input\) EmojiAutocomplete\._onKeydown\(e\);\s*\}, true\);/);
  // Only a typed colon converts `:tada:`; the synthetic `input` accept()
  // dispatches never does.
  assert.match(gcJs, /e\.inputType === 'insertText' && e\.data === ':' && EmojiAutocomplete\._convert\(\)/);
  // Its host is in the ownership audit with the other two.
  assert.match(read('scripts/audit-react-ownership.mjs'), /\{ sel: '#gc-emoji-menu' \}/);
});

test('the module publishes and positions; it no longer paints', () => {
  const code = gcJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const name of ['MentionAutocomplete', 'RefAutocomplete', 'EmojiAutocomplete']) {
    const start = code.indexOf(`const ${name} = {`);
    assert.ok(start > 0, `located ${name}`);
    const body = code.slice(start, code.indexOf('\n};', start));
    assert.doesNotMatch(body, /innerHTML/, `${name} builds no markup`);
    assert.match(body, /_publish\(\)/, `${name} publishes instead`);
    // The three things that stay: the host, its geometry, and its `hidden`.
    assert.match(body, /document\.body\.appendChild\(menu\)/,
      `${name} still owns the floating host`);
    assert.match(body, /menu\.style\.left = /, `${name} still places it`);
    assert.match(body, /classList\.(add|remove)\('hidden'\)/,
      `${name} still opens and closes it`);
  }
});
