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

// ── The whole list is capped: a prefix it cannot fill is asked by name ──
//
// GET /api/apps/:slug/mention-suggestions answers at most 500 people, so in a
// larger community a quiet member late in its order is not in the list the
// room's composer caches. When the list is full and a prefix does not fill
// the menu from it, the composer asks the same endpoint with ?q= (as the hub's
// channel box does since #3361) and merges the answer — unless the token
// under the caret has moved on by the time it lands.

function loadMentionAutocomplete({ fetchImpl }) {
  const vm = require('node:vm');
  const start = gcJs.indexOf('const MentionAutocomplete = {');
  const end = gcJs.indexOf('\n};\n', start);
  const src = gcJs.slice(start, end + 3);
  const timers = [];
  const input = { value: '', selectionStart: 0, selectionEnd: 0 };
  const ctx = {
    fetch: fetchImpl,
    document: { activeElement: input },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    Map, Set, RegExp, Date, Array, encodeURIComponent,
  };
  vm.createContext(ctx);
  const MA = vm.runInContext(`${src}\nMentionAutocomplete`, ctx);
  const shown = [];
  MA._render = () => { MA._open = true; shown.push(MA._items.slice()); };
  MA.close = () => { MA._open = false; MA._items = []; };
  MA._input = input;
  MA._slug = 'big';
  const type = (text) => {
    input.value = text;
    input.selectionStart = input.selectionEnd = text.length;
    MA._sync();
  };
  const runTimers = async () => {
    const due = timers.splice(0).filter(Boolean);
    for (const fn of due) await fn();
  };
  return { MA, type, runTimers, shown, input };
}

const fullList = () => Array.from({ length: 500 }, (_, i) => `member_${String(i).padStart(3, '0')}`);
const ok = (users) => ({ ok: true, status: 200, json: async () => ({ users: users.map((username) => ({ username })) }) });

test('a full list that cannot fill a prefix asks the server by that prefix and merges the answer', async () => {
  const calls = [];
  const { MA, type, runTimers } = loadMentionAutocomplete({
    fetchImpl: async (url) => { calls.push(url); return ok(['quiet_member']); },
  });
  MA._cacheBySlug.set('big', { users: fullList(), fetchedAt: Date.now() });

  type('hi @qu');
  assert.equal(MA._open, false, 'nobody in the whole list starts with qu');
  await runTimers();
  assert.deepEqual(calls, ['/api/apps/big/mention-suggestions?q=qu']);
  assert.deepEqual([...MA._items], ['quiet_member'], 'the member late in the order is offered');

  // Remembered: the same prefix again costs no request.
  type('hi @q');
  type('hi @qu');
  await runTimers();
  assert.equal(calls.filter((u) => u.endsWith('?q=qu')).length, 1);

  // A list below the cap is complete, and is never widened.
  const small = loadMentionAutocomplete({ fetchImpl: async (url) => { calls.push(url); return ok([]); } });
  small.MA._cacheBySlug.set('big', { users: ['alice'], fetchedAt: Date.now() });
  const before = calls.length;
  small.type('@qu');
  await small.runTimers();
  assert.equal(calls.length, before);
});

test('an answer for a prefix no longer under the caret is dropped; a 429 is not remembered', async () => {
  let release;
  const calls = [];
  const { MA, type, runTimers, input } = loadMentionAutocomplete({
    fetchImpl: (url) => {
      calls.push(url);
      return new Promise((resolve) => { release = resolve; });
    },
  });
  MA._cacheBySlug.set('big', { users: fullList(), fetchedAt: Date.now() });

  type('@qu');
  const pending = runTimers();
  // The person types on before the answer lands.
  input.value = '@qx';
  input.selectionStart = input.selectionEnd = 3;
  release(ok(['quiet_member']));
  await pending;
  assert.equal(MA._candidates().includes('quiet_member'), false, 'the stale answer is not merged');
  assert.equal(MA._open, false);

  // A refused lookup (the route is rate limited) degrades silently and is
  // asked again on the next keystroke rather than cached as nobody.
  const limited = loadMentionAutocomplete({
    fetchImpl: async (url) => { calls.push(url); return { ok: false, status: 429, json: async () => ({}) }; },
  });
  limited.MA._cacheBySlug.set('big', { users: fullList(), fetchedAt: Date.now() });
  limited.type('@zz');
  await limited.runTimers();
  assert.equal(limited.MA._prefixBySlug.size, 0);
  limited.type('@zz');
  await limited.runTimers();
  assert.equal(calls.filter((u) => u.endsWith('?q=zz')).length, 2);
});

// ── #4571: the menu belongs to the box being typed in ───────────────────
//
// The side panel's thread composer mounts through the same
// GroupChat.mountThread the full change page takes, so all three controllers
// are attached to it — but whichever composer attached LAST owned the
// singleton `_input`, and every event handler read that one's value and
// caret. With the panel open beside a tab that mounts a composer after it
// (the Discussion tab, Messages, another thread), typing `@` in the panel
// read a detached or hidden box and no menu opened.
//
// EmojiAutocomplete already retargets per event (`own()`); Mention and Ref
// now do the same. These tests load a controller in a `vm` the way
// loadMentionAutocomplete does and drive fake inputs whose listeners are
// fired by hand, so what is under test is which box an event came from.

function loadAutocomplete(name, { fetchImpl = async () => ok([]) } = {}) {
  const vm = require('node:vm');
  const start = gcJs.indexOf(`const ${name} = {`);
  const end = gcJs.indexOf('\n};\n', start);
  const src = gcJs.slice(start, end + 3);
  const timers = [];
  const doc = { activeElement: null };
  const mkInput = (id) => {
    const handlers = {};
    const el = {
      id,
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
      fire(type, event) { for (const fn of handlers[type] || []) fn(event || {}); },
      getAttribute: () => null,
      setSelectionRange(pos) { el.selectionStart = el.selectionEnd = pos; },
      focus() { doc.activeElement = el; },
    };
    return el;
  };
  const threadInput = mkInput('thread');
  const generalInput = mkInput('general');
  const ctx = {
    fetch: fetchImpl,
    document: doc,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    Map, Set, RegExp, Date, Array, encodeURIComponent,
  };
  vm.createContext(ctx);
  const AC = vm.runInContext(`${src}\n${name}`, ctx);
  const shown = [];
  AC._render = () => { AC._open = true; shown.push(Array.from(AC._items, (item) => (typeof item === 'object' ? { ...item } : item))); };
  // Record which box the singleton pointed at each time an OPEN menu was
  // closed, so a test can see the close happened BEFORE the retarget took
  // the input over. (close() also runs as a no-op from _sync after a
  // retarget; those are not logged.)
  const realClose = AC.close;
  const closeLog = [];
  AC.close = () => { if (AC._open) closeLog.push(AC._input); realClose.call(AC); };
  const type = (input, text) => {
    input.value = text;
    input.setSelectionRange(text.length);
    input.fire('input');
  };
  return { AC, threadInput, generalInput, shown, closeLog, doc, type };
}

test('an earlier-attached input still opens its own @ menu (#4571)', () => {
  const { AC, threadInput, generalInput, shown, type } = loadAutocomplete('MentionAutocomplete');
  AC._cacheBySlug.set('a', { users: ['alice', 'alan'], fetchedAt: Date.now() });
  AC._cacheBySlug.set('b', { users: ['zoe'], fetchedAt: Date.now() });
  // The side panel's thread composer attached first; a page tab's composer
  // attached after it and took the singleton over.
  AC.attach(threadInput, 'a');
  AC.attach(generalInput, 'b');

  // Typing `@al` in the earlier-attached thread box.
  type(threadInput, '@al');

  assert.equal(AC._input, threadInput, 'the menu answers for the box typed in');
  assert.equal(AC._slug, 'a');
  assert.equal(AC._open, true, 'the menu opened');
  assert.deepEqual(shown.at(-1), ['alice', 'alan'], 'slug a’s candidates, not slug b’s');
});

test('an earlier-attached input still opens its own # menu (#4571)', () => {
  const { AC, threadInput, generalInput, shown, type } = loadAutocomplete('RefAutocomplete');
  AC._cacheBySlug.set('a', {
    prs: [{ number: 12, title: 'Fix the header', kind: 'pr' }],
    issues: [{ number: 1, title: 'Bug', kind: 'issue' }],
    fetchedAt: Date.now(),
  });
  AC._cacheBySlug.set('b', {
    prs: [{ number: 77, title: 'Other project', kind: 'pr' }],
    issues: [],
    fetchedAt: Date.now(),
  });
  AC.attach(threadInput, 'a');
  AC.attach(generalInput, 'b');

  type(threadInput, '#1');

  assert.equal(AC._input, threadInput);
  assert.equal(AC._slug, 'a');
  assert.equal(AC._open, true, 'the menu opened');
  assert.deepEqual(shown.at(-1), [
    { number: 1, title: 'Bug', kind: 'issue' },
    { number: 12, title: 'Fix the header', kind: 'pr' },
  ], 'slug a’s items, not slug b’s');
});

test('switching boxes closes the other one’s open menu before retargeting (#4571)', () => {
  const { AC, threadInput, generalInput, closeLog, type } = loadAutocomplete('MentionAutocomplete');
  AC._cacheBySlug.set('a', { users: ['alice'], fetchedAt: Date.now() });
  AC._cacheBySlug.set('b', { users: ['zoe'], fetchedAt: Date.now() });
  AC.attach(threadInput, 'a');
  AC.attach(generalInput, 'b');
  type(threadInput, '@al');
  assert.equal(AC._open, true);

  // Now typing in the other box: the menu closes first — while it still
  // belongs to the thread box — and then the singleton retargets.
  type(generalInput, 'hello');

  assert.equal(closeLog.at(-1), threadInput, 'close() ran before the retarget');
  assert.equal(AC._open, false, 'the other box’s menu is closed');
  assert.equal(AC._input, generalInput);
  assert.equal(AC._slug, 'b');
});

test('focusing a box warms that box’s project (#4571)', async () => {
  const calls = [];
  let resolveFetch;
  const { AC, threadInput, generalInput } = loadAutocomplete('MentionAutocomplete', {
    fetchImpl: (url) => {
      calls.push(url);
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
  });
  AC.attach(threadInput, 'a');
  AC.attach(generalInput, 'b');

  threadInput.fire('focus');
  assert.deepEqual(calls, ['/api/apps/a/mention-suggestions'],
    'the focus warms the focused box’s project, not the last-attached one’s');
  resolveFetch(ok(['alice']));
  await new Promise(setImmediate);
  assert.deepEqual([...AC._cacheBySlug.get('a').users], ['alice']);
});

test('the panel path keeps all three controllers; both menus retarget (#4571)', () => {
  // The side panel's thread host mounts through GroupChat.mountThread
  // (AppView.openTopicInPanel → _mountTopicThread), so the panel needs no
  // wiring of its own — the pin is that the shared path still attaches all
  // three to the thread input.
  assert.match(gcJs, /MentionAutocomplete\.attach\(input, slug\);\s*\}\s*if \(typeof RefAutocomplete !== 'undefined'\) \{\s*RefAutocomplete\.attach\(input, slug\);\s*\}\s*\/\/ `:th` emoji shortcodes[\s\S]{0,200}?EmojiAutocomplete\.attach\(input\);/);
  for (const [name, prop] of [['MentionAutocomplete', '_gcMentionSlug'], ['RefAutocomplete', '_gcRefSlug']]) {
    const start = gcJs.indexOf(`const ${name} = {`);
    const body = gcJs.slice(start, gcJs.indexOf('\n};\n', start));
    assert.match(body, new RegExp(`input\\.${prop} = slug;`),
      `${name} remembers the slug on the element`);
    assert.match(body, new RegExp(`${name}\\.close\\(\\);\\s*${name}\\._input = input;\\s*${name}\\._slug = input\\.${prop};`),
      `${name} retargets the menu to the box an event came from`);
    assert.doesNotMatch(body, /_input === input\) [A-Za-z]+Autocomplete\._loadCandidates/,
      `${name}'s focus handler warms unconditionally (the guard would skip a box the last attach moved past)`);
  }
});
