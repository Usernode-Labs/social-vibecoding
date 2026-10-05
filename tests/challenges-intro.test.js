// "How challenges work" at the top of the Challenges tab (first-session
// run-through, 5 October 2026, item 17), frontend/src/features/leaderboard/
// challenges-intro.tsx.
//
// What it pins:
//   * Evan's words, exactly, in the Getting started card's shape: a plane
//     GroupedList, a sentence-case title with the round ✕, three ListRows
//     with an IconTile each, lines that wrap;
//   * the ✕ closes it on this device and a quiet text link brings it back,
//     run on the REAL component against a React stepped by hand (effects
//     and state included, which renderToStaticMarkup never runs);
//   * storage that throws (Safari's private mode) shows the card and never
//     breaks the close or the bring-back;
//   * it sits first inside #tc-se-grid, so a challenge's page hides it, and
//     the prerendered shell carries none of it.
//
// Run with: node --test tests/challenges-intro.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const INTRO = 'frontend/src/features/leaderboard/challenges-intro.tsx';
const PANE = 'frontend/src/features/leaderboard/challenges-pane.tsx';
const PANE_API = 'tests/fixtures/challenges-pane-api.ts';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── Storage and the viewer, swapped in per test ─────────────────────────

const STORAGE = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const WINDOW = Object.getOwnPropertyDescriptor(globalThis, 'window');

function useStorage(storage) {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
}
function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}
const refusing = {
  getItem() { throw new Error('SecurityError: storage is disabled'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError: storage is disabled'); },
};
function signedIn(id) {
  Object.defineProperty(globalThis, 'window', { value: { App: { user: { id } } }, configurable: true, writable: true });
}

test.afterEach(() => {
  if (STORAGE) Object.defineProperty(globalThis, 'localStorage', STORAGE);
  else delete globalThis.localStorage;
  if (WINDOW) Object.defineProperty(globalThis, 'window', WINDOW);
  else delete globalThis.window;
});

// ── A React small enough to step through ────────────────────────────────
//
// Only what challenges-intro.tsx and the primitives it imports call:
// useState (with an initializer), useRef, useEffect, and the forwardRef that
// grouped-list.tsx makes ListRow with at load. Elements still come from the
// real JSX runtime; nothing below a component is rendered, the tree is
// walked instead, so a click is a call of the element's own onClick.

function steppedReact() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let component = null;
  let tree = null;
  let dirty = false;
  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  const React = {
    useState(initial) {
      const s = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [s.value, (next) => {
        const value = typeof next === 'function' ? next(s.value) : next;
        if (!Object.is(value, s.value)) { s.value = value; dirty = true; }
      }];
    },
    useRef: (current) => slot(() => ({ current })),
    useEffect(effect, deps) {
      const s = slot(() => ({ deps: null }));
      if (s.deps && deps.every((d, i) => Object.is(d, s.deps[i]))) return;
      s.deps = deps;
      effects.push(effect);
    },
    forwardRef: (render) => ({ $$typeof: Symbol.for('react.forward_ref'), render }),
  };
  const render = () => {
    cursor = 0;
    effects = [];
    tree = component();
    for (const run of effects) run();
  };
  return {
    React,
    mount(fn) { component = fn; render(); },
    // A state change re-renders, as React would after the event.
    settle() { while (dirty) { dirty = false; render(); } },
    tree: () => tree,
  };
}

// Expand our own pure view, then collect every element in the tree.
function elements(node, expand, out = []) {
  if (Array.isArray(node)) { for (const n of node) elements(n, expand, out); return out; }
  if (!node || typeof node !== 'object' || !node.props) return out;
  if (expand.includes(node.type)) return elements(node.type(node.props), expand, out);
  out.push(node);
  elements(node.props.children, expand, out);
  if (node.props.leading) elements(node.props.leading, expand, out);
  return out;
}

function mountIntro() {
  const fake = steppedReact();
  const mod = loadTsx(INTRO, { stubs: { react: fake.React } });
  fake.mount(() => mod.ChallengesIntro());
  const all = () => elements(fake.tree(), [mod.ChallengesIntroView]);
  return {
    fake,
    mod,
    state: () => {
      const root = all().find((e) => e.props['data-challenges-intro']);
      return root ? root.props['data-challenges-intro'] : null;
    },
    closeButton: () => all().find((e) => e.type === 'button' && 'data-challenges-intro-close' in e.props),
    link: () => all().find((e) => e.type === 'button' && e.props['data-challenges-intro'] === 'closed'),
  };
}

const view = (closed) => {
  useStorage(memoryStorage());
  const mod = loadTsx(INTRO);
  return renderToHtml(createElement(mod.ChallengesIntroView, { closed, onClose() {}, onOpen() {} }));
};
const text = (html) => html.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);

// ── The words ───────────────────────────────────────────────────────────

test('the card says Evan\'s words, in order', () => {
  const { INTRO_TITLE, INTRO_ROWS } = loadTsx(INTRO);
  assert.equal(INTRO_TITLE(), 'How challenges work');
  assert.deepEqual(INTRO_ROWS.map((r) => [r.title, r.subtitle]), [
    ['Do it, and it counts', 'Complete challenges.'],
    ['Earn points', 'Each card shows what it earns. Points add up in standings.'],
    ['New ones each week', 'This week starts again on Monday. Always open has no deadline.'],
  ]);
  assert.deepEqual(text(view(false)), [
    'How challenges work',
    'Do it, and it counts', 'Complete challenges.',
    'Earn points', 'Each card shows what it earns. Points add up in standings.',
    'New ones each week', 'This week starts again on Monday. Always open has no deadline.',
  ]);
});

test('it is the Getting started card\'s shape: plane card, 15px title, the round ✕, three rows with a tile', () => {
  const html = view(false);
  const icons = loadTsx('frontend/@/components/ui/icons.tsx');
  const drawing = (Icon) => renderToHtml(createElement(Icon)).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');

  assert.match(html, /^<section aria-label="How challenges work" class="mb-4" data-challenges-intro="open">/);
  assert.match(html, /<div class="[^"]*\brounded-\[20px\][^"]*\bbg-\[color:var\(--dc-sheet-solid\)\][^"]*">/,
    'GroupedList in the plane tone');
  assert.match(html, /<div class="[^"]*\bmx-0\b/, 'flush with the pane\'s own gutter, as Getting started is on Home');
  assert.match(html, /<div class="min-w-0 flex-1 text-\[0\.9375rem\] font-\[650\] leading-5 text-zinc-900 dark:text-zinc-100">How challenges work<\/div>/);
  assert.match(html, /<button type="button" class="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-500\/10 dark:text-zinc-400" aria-label="Close How challenges work" title="Close" data-challenges-intro-close="">/);
  assert.ok(html.includes(drawing(icons.XIcon)), 'the ✕ is the shell\'s XIcon');

  assert.equal((html.match(/\bh-11 w-11 rounded-xl\b/g) || []).length, 3, 'one IconTile size sm per row');
  const order = [icons.CheckIcon, icons.TrophyIcon, icons.ArrowPathIcon].map((I) => html.indexOf(drawing(I)));
  assert.ok(order.every((i) => i > 0), 'Check, Trophy and ArrowPath are drawn');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order');
  assert.ok(!html.includes(drawing(icons.ChevronRightIcon)), 'no chevrons: the rows go nowhere');
  assert.equal((html.match(/text-\[0\.8125rem\][^"]*whitespace-normal/g) || []).length, 3, 'the lines wrap rather than truncate');
  assert.doesNotMatch(html, /\bbg-violet-/, 'nothing is filled with the accent');
});

test('closed, all that is left is a quiet text link with the same words', () => {
  const html = view(true);
  assert.equal(html,
    '<button type="button" class="mb-4 text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline" '
    + 'data-challenges-intro="closed">How challenges work</button>');
});

// ── Close and bring back ────────────────────────────────────────────────

test('the ✕ closes it on this device, the link brings it back, and a new visit remembers', () => {
  const storage = memoryStorage();
  useStorage(storage);
  signedIn(7);

  const first = mountIntro();
  assert.equal(first.state(), 'open', 'shown until it is closed');
  first.closeButton().props.onClick();
  first.fake.settle();
  assert.equal(first.state(), 'closed');
  assert.equal(storage.map.get('usernode:challenges-intro-closed:7'), '1', 'kept for this account on this device');

  const again = mountIntro();
  assert.equal(again.state(), 'closed', 'the next visit opens on the link, with no flash of the card');

  again.link().props.onClick();
  again.fake.settle();
  assert.equal(again.state(), 'open');
  assert.equal(storage.map.has('usernode:challenges-intro-closed:7'), false, 'and forgets the close');
  assert.equal(mountIntro().state(), 'open');
});

test('each account on a device has its own answer; a signed-out viewer shares one', () => {
  const storage = memoryStorage();
  useStorage(storage);
  const { introKey, readClosed, writeClosed } = loadTsx(INTRO);
  assert.equal(introKey(7), 'usernode:challenges-intro-closed:7');
  assert.equal(introKey(null), 'usernode:challenges-intro-closed:guest');
  writeClosed(7, true);
  assert.equal(readClosed(7), true);
  assert.equal(readClosed(8), false);
  assert.equal(readClosed(null), false);
});

test('storage that throws shows the card, and the ✕ and the link still work for the visit', () => {
  useStorage(refusing);
  signedIn(7);
  const { readClosed, writeClosed } = loadTsx(INTRO);
  assert.equal(readClosed(7), false, 'a read that throws shows the card');
  assert.doesNotThrow(() => writeClosed(7, true));
  assert.doesNotThrow(() => writeClosed(7, false));

  const intro = mountIntro();
  assert.equal(intro.state(), 'open');
  assert.doesNotThrow(() => intro.closeButton().props.onClick());
  intro.fake.settle();
  assert.equal(intro.state(), 'closed', 'closed for this visit');
  intro.link().props.onClick();
  intro.fake.settle();
  assert.equal(intro.state(), 'open');

  // No storage at all (a stripped WebView) reads the same way.
  useStorage(undefined);
  assert.equal(readClosed(7), false);
});

test('focus follows the tap: onto the link after a close, onto the ✕ after a bring-back', () => {
  useStorage(memoryStorage());
  signedIn(7);
  const intro = mountIntro();
  // A stepped React attaches no refs, so the test attaches them: the root of
  // the tree is the view, holding the two the component made.
  const focused = [];
  const { closeRef, linkRef } = intro.fake.tree().props;
  closeRef.current = { focus: () => focused.push('close') };
  linkRef.current = { focus: () => focused.push('link') };

  intro.closeButton().props.onClick();
  intro.fake.settle();
  assert.deepEqual(focused, ['link'], 'closing puts focus on the link that replaced the card');
  intro.link().props.onClick();
  intro.fake.settle();
  assert.deepEqual(focused, ['link', 'close'], 'bringing it back puts focus on the card\'s ✕');
});

// ── Where it sits ───────────────────────────────────────────────────────

const DETAIL = {
  key: '5',
  eyebrow: 'ONBOARDING',
  deadline: '3d left',
  amount: { text: '500 pts', earned: false },
  goal: 'Join a community',
  task: 'Find people to build with.',
  illustration: null,
  illustrationTone: null,
  state: 'new',
  stateLabel: 'Not started',
  fill: 0,
  counted: false,
  cta: { kind: 'route', href: '#apps', label: 'Find a community' },
  description: null,
  requirements: null,
  scoring: null,
  participants: 'Participants · 3',
  pointsTotal: null,
  moreLabel: null,
  entries: { kind: 'empty' },
};

test('it is first inside #tc-se-grid, so a challenge\'s page hides it with the grid', () => {
  useStorage(memoryStorage());
  const api = loadTsx(PANE_API);
  const at = (html) => ({
    grid: html.indexOf('id="tc-se-grid"'),
    intro: html.indexOf('data-challenges-intro="open"'),
    page: html.indexOf('id="tc-se-detail-overlay"'),
  });

  api.topochainChallengesStore.set({ mounted: true, grid: { kind: 'empty' }, detail: null, profile: null });
  const list = renderToHtml(createElement(api.ChallengesPane));
  assert.match(list, /<div id="tc-se-grid"><section aria-label="How challenges work"/, 'first in the grid, which is showing');

  api.topochainChallengesStore.set({ detail: DETAIL });
  const page = renderToHtml(createElement(api.ChallengesPane));
  const p = at(page);
  assert.match(page, /<div id="tc-se-grid" class="hidden">/, 'the grid steps aside for the page');
  assert.ok(p.grid < p.intro && p.intro < p.page, 'and the card is inside it, not on the page');

  const src = read(PANE);
  const grid = src.slice(src.indexOf('<div id="tc-se-grid"'), src.indexOf('<Grid view={state.grid} />'));
  assert.match(grid, /<ChallengesIntro \/>[\s\S]*<YourStanding \/>/, 'above the standing');
});

test('the prerendered shell carries none of it: the pane draws nothing until it mounts', () => {
  useStorage(memoryStorage());
  const api = loadTsx(PANE_API);
  assert.equal(api.topochainChallengesStore.get().mounted, false);
  assert.equal(renderToHtml(createElement(api.ChallengesPane)), '');
  const shell = path.join(__dirname, '..', 'public', 'index.html');
  if (fs.existsSync(shell)) {
    assert.doesNotMatch(fs.readFileSync(shell, 'utf8'), /challenges-intro|How challenges work/);
  }
  assert.doesNotMatch(read(INTRO), /\bid=/, 'and it adds no id to the shell\'s inventory');
});
