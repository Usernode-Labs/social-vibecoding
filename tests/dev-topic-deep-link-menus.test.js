// #1324 — a topic page opened by DIRECT URL must be as interactive as one
// reached by tapping a card.
//
// The bug: renderDevView() installed BOTH document-level handler sets from
// its CARD-LIST branch, near the bottom —
//
//   _cardMenuInit()  the ⋯ "More actions" menu every dev card carries
//   _attrInit()      the priority / category / assignee chip dropdowns, and
//                    the "?" / "How voting works" popover
//
// — while the topic, chat and session branches each return long before
// reaching it. So pasting, sharing or reloading
// #app/<slug>/dev/proposals/<id> painted a proposal whose ⋯ menu and chips
// did nothing at all on click, and the same page opened by tapping the card
// on the board worked, because the card list had rendered first and
// installed them as a side effect.
//
// Both are one-shot (_cardMenuInited / _attrInited), so the gap is invisible
// to anyone who visited the board first — which is how you arrive when you
// are working on the board, and why it survived so long.
//
// The fix hoists both calls above the branches. These tests drive each
// early-returning branch on a FRESH sandbox — so nothing else could have
// installed anything — and assert a synthetic click actually reaches the
// handler.
//
// Same vm-context harness as attr-vote-repaint.test.js.
//
// Run with: node --test tests/dev-topic-deep-link-menus.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function fakeEl(extra) {
  const el = {
    innerHTML: '',
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
  };
  el.remove = () => {};
  return Object.assign(el, extra || {});
}

// A document stub that RECORDS its document-level listeners, so a test can
// fire a synthetic click the way a real user's tap would arrive.
function makeSandbox() {
  const listeners = {};
  const titles = [];
  const record = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: {
      user: { id: 1 },
      currentApp: 'puzzlechain-6cf8ff',
      currentSubTab: 'dev',
      setHeaderTitle: (...args) => titles.push(args),
    },
    document: {
      getElementById: (id) => (id === 'app-content' ? fakeEl() : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: record,
      createElement: () => fakeEl(),
      body: { appendChild: () => {} },
    },
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
  return { AppView: sandbox.__AppView, sandbox, listeners, titles };
}

// Stub everything renderDevView reaches EXCEPT the two installers, which
// are the thing under test.
function stubBranches(AppView, calls = {}) {
  AppView._setSurface = () => {};
  AppView._saveFeedScroll = () => {};
  AppView._teardownDevRoots = () => {};
  AppView._renderTopicSubView = async () => { calls.topic = (calls.topic || 0) + 1; };
  AppView._renderChatSubView = () => { calls.chat = (calls.chat || 0) + 1; };
  AppView.renderDevChatTab = async () => { calls.session = (calls.session || 0) + 1; };
  return calls;
}

// Fire a synthetic document click whose target matches `selector`.
function clickMatching(listeners, selector, node) {
  const evt = {
    target: { closest: (sel) => (sel === selector ? node : null) },
    preventDefault: () => {},
    stopPropagation: () => {},
  };
  (listeners.click || []).forEach((fn) => fn(evt));
}

test('deep link to a proposal wires the ⋯ "More actions" menu (regression)', async () => {
  const { AppView, listeners } = makeSandbox();
  const calls = stubBranches(AppView);

  let toggled = null;
  AppView._toggleCardMenu = (trigger) => { toggled = trigger; };

  // Exactly what a pasted #app/<slug>/dev/proposals/3431 produces: the topic
  // branch, on a page where the card list has never rendered.
  await AppView.renderDevView('topic', { kind: 'proposal', id: 3431 });

  assert.equal(calls.topic, 1, 'the topic branch still renders');
  assert.equal(AppView._cardMenuInited, true,
    '_cardMenuInit must run before renderDevView branches into the topic view');

  const trigger = fakeEl({ dataset: { cardMenu: 'proposal:3431' } });
  clickMatching(listeners, '[data-card-menu]', trigger);
  assert.equal(toggled, trigger, 'tapping ⋯ on a deep-linked proposal must open its menu');
});

test('deep link to a proposal wires the attribute chip dropdowns', async () => {
  const { AppView, listeners } = makeSandbox();
  stubBranches(AppView);

  let opened = null;
  AppView._openAttrPopover = (chip) => { opened = chip; };

  await AppView.renderDevView('topic', { kind: 'proposal', id: 3431 });

  assert.equal(AppView._attrInited, true,
    '_attrInit must run before renderDevView branches into the topic view');

  const chip = fakeEl({ dataset: { attrField: 'priority' } });
  clickMatching(listeners, '[data-attr-chip]', chip);
  assert.equal(opened, chip,
    'clicking a priority/category/assignee chip must open its dropdown');
});

test('deep link to a proposal wires the "How voting works" popover', async () => {
  const { AppView, listeners } = makeSandbox();
  stubBranches(AppView);

  let helpAnchor = null;
  AppView._openVotingHelpPopover = (anchor) => { helpAnchor = anchor; };
  AppView._findTopicItem = () => ({ id: 3431 });

  await AppView.renderDevView('topic', { kind: 'proposal', id: 3431 });

  const btn = fakeEl({});
  clickMatching(listeners, '[data-voting-help]', btn);
  assert.equal(helpAnchor, btn, 'the "?" / "How voting works" affordance must open the popover');
});

test('every direct topic link replaces another app\'s remembered header title', async () => {
  // #2487: localStorage is shared between tabs, so a cold document may start
  // with the last app's display-only shell snapshot. Every topic kind takes
  // the same early-returning branch and must publish the app metadata that
  // has just loaded before painting its content.
  for (const ref of [
    { kind: 'issue', id: 42 },
    { kind: 'proposal', id: 3431 },
    { kind: 'gov', id: 9 },
    { kind: 'session', id: 7 },
  ]) {
    const { AppView, sandbox, titles } = makeSandbox();
    stubBranches(AppView);
    // The loaded record is the open app's: a record naming another app is
    // not this one's name, and the topic view asks for the right one first
    // (tests/dev-topic-missing-app-record.test.js).
    sandbox.App.currentApp = 'usernode-2d5619';
    AppView.appData = { slug: 'usernode-2d5619', name: 'Homeroom' };

    await AppView.renderDevView('topic', ref);

    assert.equal(titles.length, 1, `${ref.kind} publishes one definitive title`);
    assert.equal(titles[0][0], 'Homeroom', `${ref.kind} replaces the stale app name`);
    assert.equal(titles[0][1], undefined, `${ref.kind} keeps the topic name in the body`);
  }
});

test('every early-returning Dev sub-view installs both handler sets', async () => {
  // The proposal topic is not special: an issue topic renders the same
  // chips and the same ⋯ menu, and chat / session return from the same
  // function just as early.
  for (const [subTab, ref] of [
    ['topic', { kind: 'issue', id: 42 }],
    ['chat', null],
    ['sessions', 7],
  ]) {
    const { AppView } = makeSandbox();
    stubBranches(AppView);
    await AppView.renderDevView(subTab, ref);
    assert.equal(AppView._attrInited, true, `sub-view "${subTab}" must wire the chip handlers`);
    assert.equal(AppView._cardMenuInited, true, `sub-view "${subTab}" must wire the ⋯ menu`);
  }
});

test('the card list still wires them (the path that always worked)', async () => {
  const { AppView } = makeSandbox();
  stubBranches(AppView);
  // The card-list branch paints far more DOM than this stub can satisfy;
  // what matters is that both installers have already run by the time it
  // starts, so however it ends the handlers are in place.
  await AppView.renderDevView('forum', null).catch(() => {});
  assert.equal(AppView._attrInited, true);
  assert.equal(AppView._cardMenuInited, true);
});

test('source guard: both installers sit above the first early return', () => {
  const start = SRC.indexOf('async renderDevView(');
  assert.ok(start > 0, 'renderDevView is still in app-view.js');

  const attrAt = SRC.indexOf('AppView._attrInit();', start);
  const menuAt = SRC.indexOf('AppView._cardMenuInit();', start);
  const firstBranchReturn = SRC.indexOf('await AppView.renderDevChatTab(ref);', start);

  assert.ok(attrAt > start, 'renderDevView still calls _attrInit');
  assert.ok(menuAt > start, 'renderDevView still calls _cardMenuInit');
  assert.ok(firstBranchReturn > start, 'the session branch is still the first early return');

  assert.ok(attrAt < firstBranchReturn,
    '_attrInit must sit ABOVE the first early-returning sub-view branch — '
    + 'below it, deep-linked topic pages get dead chips again');
  assert.ok(menuAt < firstBranchReturn,
    '_cardMenuInit must sit ABOVE the first early-returning sub-view branch — '
    + 'below it, deep-linked topic pages get a dead ⋯ menu again');
  // _cardMenuInit's rows open the popover _attrInit's dismissers own
  // (see _cardMenuActingEvent), so they are installed as a pair, in order.
  assert.ok(attrAt < menuAt, '_attrInit is installed before _cardMenuInit');
});
