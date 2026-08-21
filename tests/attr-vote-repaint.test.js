// #608: priority/assignee votes must repaint EVERY card surface, not just
// the feed. _refreshAttrCards used to touch only #dev-feed /
// #gc-thread-head / #gc-merged, so in the board view (which mounts
// #dev-kanban-board instead) a vote updated the cached item but the visible
// chips stayed stale until a reload. It now delegates to the mode-aware
// _repaintCards() and then re-anchors the open popover to its chip's new
// position — closing it when the chip is no longer rendered (e.g. the card
// dropped off a filtered kanban board).
//
// Same vm-context harness as assignee-avatar-chip.test.js: load app-view.js
// into a sandbox, stub the globals it reaches, spy on the repaint fns.
//
// Run with: node --test tests/attr-vote-repaint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// A minimal fake DOM node. Extend per test with whatever the code reads.
function fakeEl(extra) {
  const el = {
    innerHTML: '',
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    removed: false,
  };
  el.remove = () => { el.removed = true; };
  return Object.assign(el, extra || {});
}

// A document stub backed by an id → node map plus an optional
// querySelector resolver (used for the [data-attr-chip] lookup).
function fakeDoc(ids, querySelector) {
  return {
    getElementById: (id) => (ids && ids[id]) || null,
    querySelector: querySelector || (() => null),
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    createElement: () => fakeEl(),
    body: { appendChild: () => {} },
  };
}

function makeSandbox() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 }, currentSubTab: 'dev' },
    document: fakeDoc({}),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    innerWidth: 1000,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, sandbox };
}

test('_refreshAttrCards delegates to the mode-aware _repaintCards (board gap regression)', () => {
  const { AppView } = makeSandbox();
  let devBodyRepaints = 0;
  let topicRepaints = 0;
  AppView._repaintDevBody = () => { devBodyRepaints += 1; };
  AppView._renderTopicHead = () => { topicRepaints += 1; };
  AppView._reanchorAttrPopover = () => {};

  AppView._refreshAttrCards();
  // The old implementation only touched #dev-feed / #gc-merged directly and
  // never went through _repaintDevBody, so the board stayed stale.
  assert.equal(devBodyRepaints, 1);
  assert.equal(topicRepaints, 0); // not on the topic sub-tab
});

test('_refreshAttrCards repaints the topic head only in the topic sub-view', () => {
  const { AppView, sandbox } = makeSandbox();
  let topicRepaints = 0;
  AppView._repaintDevBody = () => {};
  AppView._renderTopicHead = () => { topicRepaints += 1; };
  AppView._reanchorAttrPopover = () => {};

  sandbox.App.currentSubTab = 'topic';
  sandbox.document = fakeDoc({ 'gc-thread-head': fakeEl() });
  AppView._refreshAttrCards();
  assert.equal(topicRepaints, 1);

  // Topic sub-tab but no mounted head → no repaint attempt.
  sandbox.document = fakeDoc({});
  AppView._refreshAttrCards();
  assert.equal(topicRepaints, 1);
});

test('kanban mode: a vote repaint reaches _repaintKanbanBoard', () => {
  const { AppView, sandbox } = makeSandbox();
  sandbox.localStorage = { getItem: () => 'kanban', setItem: () => {} };
  sandbox.document = fakeDoc({
    'dev-body': fakeEl(),
    'dev-kanban-filterbar': fakeEl(),
    'dev-kanban-board': fakeEl(),
  });
  let boardRepaints = 0;
  AppView._repaintKanbanBoard = () => { boardRepaints += 1; };
  AppView._reanchorAttrPopover = () => {};

  AppView._refreshAttrCards();
  assert.equal(boardRepaints, 1);
});

test('a stored PM preference resolves to the board, and repaints it', () => {
  // THE UI OVERHAUL retired the PM view. A viewer who last left the board in
  // that mode still has 'pm' in localStorage, and the migration table
  // (AppView.RETIRED_VIEW_MODES) is what stops them landing on the width
  // default instead of the nearest surviving surface. The repaint has to
  // follow the MIGRATED mode, not the stored string.
  const { AppView, sandbox } = makeSandbox();
  sandbox.localStorage = { getItem: () => 'pm', setItem: () => {} };
  sandbox.document = fakeDoc({
    'dev-body': fakeEl(),
    'dev-kanban-filterbar': fakeEl(),
    'dev-kanban-board': fakeEl(),
  });
  let boardRepaints = 0;
  AppView._repaintKanbanBoard = () => { boardRepaints += 1; };
  AppView._reanchorAttrPopover = () => {};

  assert.equal(AppView._getViewMode(), 'kanban');
  AppView._refreshAttrCards();
  assert.equal(boardRepaints, 1);
});

test('re-anchor: the open popover snaps under its chip\'s new position', () => {
  const { AppView, sandbox } = makeSandbox();
  AppView._repaintCards = () => {};
  AppView._attrPopover = { field: 'assignee', targetType: 'issue', targetRef: 5, slug: 'x' };

  const pop = fakeEl();
  const chip = fakeEl({ getBoundingClientRect: () => ({ bottom: 100, left: 50 }) });
  let seenSelector = null;
  sandbox.document = fakeDoc({ 'attr-popover': pop }, (sel) => {
    seenSelector = sel;
    return chip;
  });

  AppView._refreshAttrCards();
  // Looked up by the popover's own field/target identifiers.
  assert.match(seenSelector, /data-attr-chip/);
  assert.match(seenSelector, /data-attr-field="assignee"/);
  assert.match(seenSelector, /data-attr-target-type="issue"/);
  assert.match(seenSelector, /data-attr-target-ref="5"/);
  // Same clamped math _openAttrPopover uses: top = bottom + 4, left as-is.
  assert.equal(pop.style.position, 'fixed');
  assert.equal(pop.style.top, '104px');
  assert.equal(pop.style.left, '50px');
  assert.equal(pop.removed, false);
  assert.ok(AppView._attrPopover);
});

test('re-anchor: left edge clamps to the viewport like the initial open', () => {
  const { AppView, sandbox } = makeSandbox();
  AppView._repaintCards = () => {};
  AppView._attrPopover = { field: 'priority', targetType: 'proposal', targetRef: 7, slug: 'x' };

  const pop = fakeEl();
  const chip = fakeEl({ getBoundingClientRect: () => ({ bottom: 20, left: 990 }) });
  sandbox.document = fakeDoc({ 'attr-popover': pop }, () => chip);

  AppView._refreshAttrCards();
  // innerWidth 1000 → clamped to 1000 - 240 = 760.
  assert.equal(pop.style.left, '760px');
});

test('re-anchor: popover closes when its chip is no longer rendered', () => {
  const { AppView, sandbox } = makeSandbox();
  AppView._repaintCards = () => {};
  AppView._attrPopover = { field: 'priority', targetType: 'issue', targetRef: 9, slug: 'x' };

  const pop = fakeEl();
  sandbox.document = fakeDoc({ 'attr-popover': pop }, () => null);

  AppView._refreshAttrCards();
  assert.equal(pop.removed, true);
  assert.equal(AppView._attrPopover, null);
});

test('re-anchor: no-op when no popover is open', () => {
  const { AppView, sandbox } = makeSandbox();
  AppView._repaintCards = () => {};
  AppView._attrPopover = null;
  let queried = false;
  sandbox.document = fakeDoc({}, () => { queried = true; return null; });

  AppView._refreshAttrCards();
  assert.equal(queried, false);
});
