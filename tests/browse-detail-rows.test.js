// The app detail page's cards, RENDERED — and the declared checks that select
// into them, matched against that render.
//
// ── Why this file exists ───────────────────────────────────────────────
//
// #2446 replaced this page's hand-copied card/row class strings with the
// GroupedList + ListRow primitives. That is a tag-and-nesting change as much
// as a padding one: ListRow renders whatever `as` says, wraps the label in its
// own content div, and moves the trailing chevron from a caller-supplied
// element to its own. dapp.json declares four checks that select into
// #browse-detail, and a proposal whose checks aren't passing cannot merge.
//
// tests/dapp-selectors-resolve.test.js cannot cover this: it proves a
// selector's static `#id` anchors exist in the prerendered shell, which is
// exactly the half that a tag-name change leaves untouched. The immediately
// preceding UI-consistency fix broke a declared check by turning a <p> into an
// <a> under an `a[data-…]:first-of-type` selector — every id still present,
// every grep still green.
//
// So this suite renders the real component and runs the real selectors over
// the real output, with a tiny descendant matcher (the selectors are plain
// descendant chains of tag / #id / .class / [attr="value"], plus the one
// structural pseudo-class the Share check needs, `:first-child` — nothing
// here invents support for combinators the manifest does not use on this
// page; an unsupported selector THROWS rather than silently passing).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { tokenize, decodeEntities, VOID_ELEMENTS } = require('./helpers/html-tokens');
const { loadTsx, renderToHtml, createElement, ROOT } = require('./lib/render-tsx');

const ENTRY = 'frontend/src/features/apps/browse-detail.tsx';
const source = fs.readFileSync(path.join(ROOT, ENTRY), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));

// ── the fixture ────────────────────────────────────────────────────────
//
// One ready descriptor that satisfies every declared check at once: the
// Open button, the Share row leading the action card, an action row labelled
// "View on GitHub", a second labelled "Fork this app", the fork-lineage
// anchor, and a contributor row for the demo seed the contributors check
// quotes.
const DETAIL = {
  state: 'ready',
  app: { slug: 'staging-demo-fork', name: 'Staging demo fork' },
  name: 'Staging demo fork',
  slug: 'staging-demo-fork',
  versionPillHtml: '',
  forkedFrom: { name: 'Staging demo forkable', href: '#app/staging-demo-forkable' },
  updatedRel: '2h ago',
  canOpen: true,
  openLabel: 'Open',
  isAdded: false,
  favLabel: 'Add to Your apps',
  // A running app with a public link (Browse.shareUrlFor), so the Share row
  // draws — the declared Share check selects it as the card's first child.
  canShare: true,
  actions: [
    { index: 0, label: 'View on GitHub', title: 'See the source', danger: false, disabled: false },
    { index: 1, label: 'Fork this app', title: null, danger: false, disabled: false },
    { index: 2, label: 'Delete app', title: null, danger: true, disabled: true },
  ],
  contributors: {
    state: 'ready',
    count: 2,
    rows: [
      {
        who: 'staging-demo-lead',
        rank: 1,
        initial: 'S',
        merged: 3,
        meta: 'Creator · 4 votes',
        pillTint: 'border-violet-200 bg-violet-50 text-violet-700',
      },
      { who: 'quiet', rank: 2, initial: 'Q', merged: 0, meta: null, pillTint: 'border-zinc-200' },
    ],
    toggle: 'Show all 7 contributors',
    note: null,
  },
};

// #browse-detail is the host features/apps/browse-screen.tsx mounts this
// component into, and every declared selector starts at it — so the render is
// wrapped in it here rather than asserting against a fragment the browser
// never sees on its own.
function renderDetail(detail = DETAIL) {
  const { BrowseDetail } = loadTsx(ENTRY);
  return renderToHtml(
    createElement('div', { id: 'browse-detail' }, createElement(BrowseDetail, { detail })),
  );
}

// ── a child tree, from the shared tokenizer ────────────────────────────

function treeOf(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null, text: '' };
  let cur = root;
  for (const t of tokenize(html)) {
    if (t.kind === 'open') {
      const attrs = {};
      // Attribute values arrive as they were SERIALISED (`[&amp;:not(…)]`), and
      // a class string compared against source spelling has to be the decoded
      // one — this is the shell's own markup round-tripped, not user text.
      for (const a of t.attrs) {
        attrs[a.name.toLowerCase()] = a.value === null ? null : decodeEntities(a.value);
      }
      const node = { tag: t.tag.toLowerCase(), attrs, children: [], parent: cur, text: '' };
      cur.children.push(node);
      if (!t.selfClosing && !VOID_ELEMENTS.has(node.tag)) cur = node;
    } else if (t.kind === 'close') {
      const want = t.tag.toLowerCase();
      let node = cur;
      while (node && node.tag !== want) node = node.parent;
      if (node && node.parent) cur = node.parent;
    } else if (t.kind === 'text' || t.kind === 'raw') {
      for (let n = cur; n; n = n.parent) n.text += decodeEntities(t.text);
    }
  }
  return root;
}

function walk(node, fn) {
  for (const child of node.children) { fn(child); walk(child, fn); }
}

function all(node) {
  const out = [];
  walk(node, (n) => out.push(n));
  return out;
}

// ── the matcher ────────────────────────────────────────────────────────

// Scanned left to right rather than matched with global regexes: an attribute
// value carries arbitrary text, and `a[href="#app/x"]` read by a loose /#(…)/
// yields the id "app". That was a real false negative while writing this.
function parseCompound(part) {
  const out = { tag: null, id: null, classes: [], attrs: [], firstChild: false };
  let i = 0;
  const tag = /^(?:[a-z][a-z0-9-]*|\*)/.exec(part);
  if (tag) { out.tag = tag[0] === '*' ? null : tag[0]; i = tag[0].length; }
  while (i < part.length) {
    const rest = part.slice(i);
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) { out.id = m[1]; }
    else if ((m = /^\.([\w-]+)/.exec(rest))) { out.classes.push(m[1]); }
    else if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) {
      out.attrs.push({ name: m[1].toLowerCase(), value: m[2] === undefined ? null : m[2] });
    } else if ((m = /^:first-child\b/.exec(rest))) {
      // The Share check's claim is POSITIONAL (Share leads the action card,
      // as in the prototype's More list), so the matcher learned exactly this
      // pseudo-class — element children only, as in CSS.
      out.firstChild = true;
    } else {
      throw new Error(`browse-detail-rows.test.js: unsupported selector part "${part}" — `
        + 'this matcher covers only descendant chains of tag / #id / .class / [attr="value"]. '
        + 'Extend it deliberately rather than dropping the check.');
    }
    i += m[0].length;
  }
  return out;
}

function matchesCompound(node, c) {
  if (c.tag && node.tag !== c.tag) return false;
  if (c.id && node.attrs.id !== c.id) return false;
  if (c.firstChild && (!node.parent || node.parent.children[0] !== node)) return false;
  const classList = (node.attrs.class || '').split(/\s+/);
  if (c.classes.some((cls) => !classList.includes(cls))) return false;
  return c.attrs.every(({ name, value }) => {
    const got = node.attrs[name];
    if (got === undefined) return false;
    return value === null || got === value;
  });
}

/** Every element matching a descendant chain, in document order. */
function queryAll(root, selector) {
  const parts = selector.trim().split(/\s+/).map(parseCompound);
  let level = [root];
  for (const c of parts) {
    const next = [];
    for (const scope of level) for (const n of all(scope)) if (matchesCompound(n, c)) next.push(n);
    level = next;
    if (!level.length) return [];
  }
  return level;
}

// ── the declared checks ────────────────────────────────────────────────

const declared = (manifest.tests || []).filter((t) => (
  typeof t.expectSelector === 'string'
  && /browse-detail|browse-contrib/.test(t.expectSelector)
));

test('the manifest still declares the detail-page checks this suite guards', () => {
  // A floor, not a fixture count: if a check is ADDED, this suite must grow a
  // fixture that satisfies it rather than quietly skipping it.
  assert.ok(declared.length >= 4,
    `expected at least 4 declared #browse-detail checks, found ${declared.length}`);
});

test('every declared #browse-detail selector matches the RENDERED detail page', () => {
  const root = treeOf(renderDetail());
  for (const t of declared) {
    const hits = queryAll(root, t.expectSelector);
    assert.ok(hits.length > 0,
      `dapp.json check "${t.name}" no longer matches: ${t.expectSelector}`);
  }
});

test('the text each declared check quotes is still rendered', () => {
  const text = treeOf(renderDetail()).text;
  for (const phrase of ['Share', 'Fork this app', 'View on GitHub', 'staging-demo-lead']) {
    assert.ok(text.includes(phrase), `the detail page stopped rendering "${phrase}"`);
  }
});

// ── the structural facts those selectors ride on ───────────────────────
//
// Pinned by NAME, because a selector that matches today can be broken by a
// change that leaves every id in place: the tag the row renders as, the
// element the id sits on, and whether the rows are siblings of one another.

test('the contributors card is the DIV that carries the id, and the rows are its descendants', () => {
  const root = treeOf(renderDetail());
  const cards = all(root).filter((n) => n.attrs.id === 'browse-detail-contributors');
  assert.equal(cards.length, 1, 'exactly one #browse-detail-contributors');
  assert.equal(cards[0].tag, 'div', '#browse-detail-contributors must stay a <div>');

  const rows = queryAll(root, '#browse-detail-contributors .browse-contrib-row');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.tag, 'button',
      '.browse-contrib-row must render as a <button>: the row is an action, and the '
      + 'declared check reaches it by class through a descendant chain');
    assert.equal(row.attrs.type, 'button');
    assert.ok(row.attrs['data-username'], 'the row keeps its data-username hook');
  }
  // Siblings of one another and of nothing else, so ListRow's
  // `:not(:last-child)` hairline lands on every row but the final contributor
  // — and so no future `:first-of-type`-shaped selector can be thrown by a
  // stray element sharing the wrapper.
  const wrapper = rows[0].parent;
  assert.ok(rows.every((r) => r.parent === wrapper), 'the rows share one wrapper');
  assert.deepEqual(wrapper.children.map((c) => c.tag), ['button', 'button']);
  // The fold toggle sits OUTSIDE that wrapper, which is what keeps the last
  // contributor row hairline-free.
  const toggle = all(root).find((n) => n.attrs.id === 'browse-contrib-toggle');
  assert.ok(toggle && toggle.parent !== wrapper,
    '#browse-contrib-toggle must not join the rows wrapper');
});

test('an action row stays a <button> that carries its index and its disabled state', () => {
  const root = treeOf(renderDetail());
  const rows = queryAll(root, '#browse-detail .browse-detail-action');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.tag), ['button', 'button', 'button'],
    '.browse-detail-action must stay a <button>: features/home/home.js writes '
    + '`itemEl.disabled` and `itemEl.textContent` onto the clicked node');
  assert.deepEqual(rows.map((r) => r.attrs['data-action-index']), ['0', '1', '2']);
  assert.ok('disabled' in rows[2].attrs, 'a disabled action still renders disabled');
  assert.equal(rows[0].attrs.title, 'See the source',
    'the row tooltip survives the move onto ListRow (its `tooltip` prop)');
});

// ── the density this issue is about ────────────────────────────────────

test('both cards draw at the grouped-list density, with the hairline at left-4', () => {
  const root = treeOf(renderDetail());
  const rows = [
    ...queryAll(root, '#browse-detail .browse-detail-action'),
    ...queryAll(root, '#browse-detail-contributors .browse-contrib-row'),
  ];
  assert.equal(rows.length, 5);
  for (const row of rows) {
    const cls = row.attrs.class || '';
    assert.ok(/(^|\s)px-4(\s|$)/.test(cls), `row is not at px-4: ${cls}`);
    assert.ok(/(^|\s)py-3\.5(\s|$)/.test(cls), `row is not at py-3.5: ${cls}`);
    assert.ok(cls.includes('[&:not(:last-child)]:after:left-4'),
      `row hairline is not at the text inset: ${cls}`);
  }
});

test('the hand-copied row rule is gone from the source, left-3 and all', () => {
  assert.doesNotMatch(source, /ROW_RULE/,
    'the hand-copy of grouped-list.tsx\'s hairline came back');
  assert.doesNotMatch(source, /after:left-3\b/,
    'a left-3 hairline is 4px off the rows GroupedList draws');
  assert.match(source, /from '@\/components\/ui\/grouped-list'/,
    'the page must build its cards from the primitive, not a copy of it');
});

test('Share is a <button> leading the action card, only when there is a link to share', () => {
  const root = treeOf(renderDetail());
  const share = queryAll(root, '#browse-detail #browse-detail-share');
  assert.equal(share.length, 1);
  assert.equal(share[0].tag, 'button', 'a row that DOES something is a button (ListRow as="button")');
  assert.equal(share[0].attrs.type, 'button');
  const card = share[0].parent;
  assert.equal(card.children[0], share[0], 'it leads the card, as Share leads the prototype\'s More list');
  assert.ok(card.children.slice(1).every((n) => /\bbrowse-detail-action\b/.test(n.attrs.class || '')),
    'and the menu-derived action rows follow it in the same card');
  assert.doesNotMatch(share[0].attrs.class || '', /\bbrowse-detail-action\b/,
    'it is not one of Home.menuItemsFor\'s rows, so it carries no action index');
  assert.equal(share[0].attrs.title, 'Share a link to this app');

  // No link, no row — and a page with no actions and no link draws no card.
  const unshared = treeOf(renderDetail({ ...DETAIL, canShare: false }));
  assert.equal(queryAll(unshared, '#browse-detail #browse-detail-share').length, 0);
  const bare = treeOf(renderDetail({ ...DETAIL, canShare: false, actions: [] }));
  assert.equal(queryAll(bare, '#browse-detail .browse-detail-action').length, 0);
  const shareOnly = treeOf(renderDetail({ ...DETAIL, canShare: true, actions: [] }));
  assert.equal(queryAll(shareOnly, '#browse-detail #browse-detail-share').length, 1,
    'a link alone still gets its card');
});

// #2991: the fold toggle said whether it was open only through its label.
// It now says so as aria-expanded, and names the rows wrapper it opens, as
// Discover's list's own "Show more" does (./browse-list.tsx).
test('the contributors toggle exposes its fold state and the list it controls (#2991)', () => {
  const toggleOf = (contributors) => {
    const root = treeOf(renderDetail({ ...DETAIL, contributors: { ...DETAIL.contributors, ...contributors } }));
    const toggle = all(root).find((n) => n.attrs.id === 'browse-contrib-toggle');
    assert.ok(toggle, '#browse-contrib-toggle renders');
    return { root, toggle };
  };
  const folded = toggleOf({ expanded: false, toggle: 'Show all 7 contributors' });
  assert.equal(folded.toggle.attrs['aria-expanded'], 'false');
  const open = toggleOf({ expanded: true, toggle: 'Show fewer' });
  assert.equal(open.toggle.attrs['aria-expanded'], 'true');

  const controls = open.toggle.attrs['aria-controls'];
  assert.equal(controls, 'browse-contrib-list');
  const target = all(open.root).find((n) => n.attrs.id === controls);
  assert.ok(target, 'aria-controls names an element that exists');
  assert.ok(queryAll(target, '.browse-contrib-row').length > 0,
    'and that element is the rows wrapper');
});
