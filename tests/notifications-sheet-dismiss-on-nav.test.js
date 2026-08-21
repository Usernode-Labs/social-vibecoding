// #1329: accepting an invitation from the notifications drawer on a phone used
// to navigate to the app BEHIND the still-presented drawer. Nothing ever
// dismissed it, so the user was stranded under a modal, mostly-empty near-white
// surface over a dimmed backdrop — reported as "the app freezes on a white
// screen". The same held for tapping a notification row or a saved message.
//
// The contract under test: every action that actually NAVIGATES calls
// Notifications._dismissSheetForNav() first, and it is a strict no-op when
// nothing is presented.
//
// THE UI OVERHAUL changed two things about it. The list lives in the hamburger
// now, so what gets dismissed is that drawer (HeaderMenu.close) rather than a
// panel this module presented itself. And the rule applies at EVERY width: the
// desktop "keep-open" behaviour below existed because the anchored dropdown sat
// in a corner and covered nothing, while a side drawer covers the screen you
// just navigated to. The touch/desktop split in these tests is therefore about
// which PRESENTATION the drawer uses, not about whether it closes.
//
// The REAL shipped notifications.js is evaluated in a vm sandbox (so the
// assertions can't drift from what runs); only display plumbing the harness
// doesn't model (_renderBadge, refresh, _markOneRead) is stubbed per test.
//
// Run with: node --test tests/notifications-sheet-dismiss-on-nav.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8'
);

function makeClassList(initial) {
  const classes = new Set(initial);
  return {
    add: (...cs) => cs.forEach((c) => classes.add(c)),
    remove: (...cs) => cs.forEach((c) => classes.delete(c)),
    contains: (c) => classes.has(c),
    toggle(c, force) {
      const on = force === undefined ? !classes.has(c) : !!force;
      if (on) classes.add(c); else classes.delete(c);
      return on;
    },
  };
}

// Evaluate the shipped module over minimal stubs. `touch` selects the kit
// bottom-sheet path (PlatformUI.isTouch + a sheet handle whose dismiss runs
// onDismiss synchronously — the exit spring's terminal state, which is all
// the controller observes) versus the desktop anchored panel. `calls` is the
// ordered event log the assertions read.
function load({ touch = true, fetchImpl } = {}) {
  const calls = [];
  const panel = { classList: makeClassList(['hidden']) };
  // The hamburger owns the presentation now, so the harness stubs it the way
  // the real controller behaves: a kit sheet/panel on touch, a CSS slide-over
  // on desktop, and `isPresenting()` as the single source of "is it up".
  let presenting = false;
  const headerMenu = {
    isPresenting: () => presenting,
    open() {
      if (presenting) return;
      presenting = true;
      panel.classList.remove('hidden');
      if (touch) {
        panel.classList.add('platform-panel-adopted');
        calls.push(['present']);
      }
    },
    close() {
      if (!presenting) return Promise.resolve();
      presenting = false;
      panel.classList.add('hidden');
      panel.classList.remove('platform-panel-adopted');
      calls.push(['dismiss']);
      return Promise.resolve();
    },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    URLSearchParams,
    document: {
      title: '',
      getElementById: (id) => (id === 'header-menu-panel' ? panel : null),
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts) => {
      calls.push(['fetch', String(url), (opts && opts.method) || 'GET']);
      if (fetchImpl) return fetchImpl(url, opts);
      return { ok: false, json: async () => ({}) };
    },
    HeaderMenu: headerMenu,
    PlatformUI: {
      isTouch: () => touch,
      toast: (msg) => calls.push(['toast', String(msg)]),
    },
    App: {
      user: { id: 1 },
      openAppTab: (slug, tab) => calls.push(['nav', slug, tab]),
      _isScreenVisible: () => false,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const N = sandbox.Notifications;
  // Display/network plumbing outside this contract: the badge writes DOM the
  // harness doesn't model, refresh() is the fire-and-forget re-pull the
  // accept path triggers, and _markOneRead POSTs before routing. The routing
  // methods under test stay the real shipped ones.
  N._renderBadge = () => {};
  N.refresh = async () => { calls.push(['refresh']); return true; };
  N._markOneRead = () => { calls.push(['markRead']); };
  return { sandbox, N, panel, calls };
}

const acceptOk = (appSlug) => async (url) => (String(url).includes('/accept')
  ? { ok: true, json: async () => ({ ok: true, appSlug }) }
  : { ok: true, json: async () => ({ ok: true }) });

const navAndDismiss = (calls) => calls
  .filter((c) => c[0] === 'dismiss' || c[0] === 'nav')
  .map((c) => c[0]);

// ── the reported bug: accept on touch ───────────────────────────────────

test('touch: accepting an invite dismisses the sheet, then navigates to the app', async () => {
  const { N, panel, calls } = load({ touch: true, fetchImpl: acceptOk('demo-app') });
  N.invites = [{ appId: 5, appSlug: 'demo-app', kind: 'approver' }];
  N.show();
  assert.ok(calls.some((c) => c[0] === 'present'), 'the drawer rides in a kit surface on touch');
  assert.equal(N.open, true);

  await N._acceptInvite(5, 'demo-app', 'approver');

  assert.deepEqual(navAndDismiss(calls), ['dismiss', 'nav'],
    'the sheet is dismissed BEFORE navigation');
  const nav = calls.find((c) => c[0] === 'nav');
  assert.deepEqual(nav, ['nav', 'demo-app', 'group-chat']);
  assert.equal(N.open, false, 'the drawer is closed');
  assert.ok(panel.classList.contains('hidden'), 'the panel is hidden again');
  assert.ok(!panel.classList.contains('platform-panel-adopted'),
    'the adopted-surface class is rolled back');
});

test('touch: the accept response appSlug wins over the row slug', async () => {
  const { N, calls } = load({ touch: true, fetchImpl: acceptOk('canonical-slug') });
  N.invites = [{ appId: 5, appSlug: 'stale-slug', kind: 'collab' }];
  N.show();
  await N._acceptInvite(5, 'stale-slug', 'collab');
  assert.deepEqual(calls.find((c) => c[0] === 'nav'), ['nav', 'canonical-slug', 'group-chat']);
});

test('touch: a failed accept keeps the sheet up (toast + re-sync, no navigation)', async () => {
  const { N, calls } = load({
    touch: true,
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'Invite not found' }) }),
  });
  N.invites = [{ appId: 5, appSlug: 'demo-app', kind: 'approver' }];
  N.show();
  await N._acceptInvite(5, 'demo-app', 'approver');

  assert.equal(N.open, true, 'the drawer stays presented');
  assert.ok(!calls.some((c) => c[0] === 'dismiss'), 'no dismiss');
  assert.ok(!calls.some((c) => c[0] === 'nav'), 'no navigation');
  assert.deepEqual(calls.find((c) => c[0] === 'toast'), ['toast', 'Invite not found']);
  assert.ok(calls.some((c) => c[0] === 'refresh'), 're-syncs the invite list');
});

test('touch: declining does not navigate and keeps the sheet up', async () => {
  const { N, calls } = load({
    touch: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  N.invites = [{ appId: 5, appSlug: 'demo-app', kind: 'collab' }];
  N.show();
  await N._declineInvite(5, 'collab');

  assert.equal(N.open, true, 'the drawer stays presented');
  assert.ok(!calls.some((c) => c[0] === 'dismiss'), 'no dismiss');
  assert.ok(!calls.some((c) => c[0] === 'nav'), 'no navigation');
  assert.deepEqual(N.invites, [], 'the invite row is removed locally');
});

// ── desktop closes too, now that the list is in a side drawer ───────────

test('desktop: accepting navigates and the drawer closes behind it', async () => {
  // This asserted the OPPOSITE until THE UI OVERHAUL: the bell's anchored
  // dropdown sat in the top-right corner, covered nothing, and keeping it open
  // was a documented click-through convenience. The list is in a right-edge
  // side drawer now, which covers the screen the row just navigated to — the
  // same problem the touch sheet had, so it gets the same answer.
  const { N, panel, calls } = load({ touch: false, fetchImpl: acceptOk('demo-app') });
  N.invites = [{ appId: 5, appSlug: 'demo-app', kind: 'approver' }];
  N.show();
  assert.ok(!calls.some((c) => c[0] === 'present'), 'no kit surface on desktop');
  assert.equal(N.open, true);

  await N._acceptInvite(5, 'demo-app', 'approver');

  assert.deepEqual(navAndDismiss(calls), ['dismiss', 'nav'],
    'the drawer closes BEFORE navigation, at every width');
  assert.deepEqual(calls.find((c) => c[0] === 'nav'), ['nav', 'demo-app', 'group-chat']);
  assert.equal(N.open, false, 'the drawer is closed');
  assert.ok(panel.classList.contains('hidden'), 'the panel is hidden again');
});

test('desktop: clicking a notification row closes the drawer before routing', () => {
  const { N, panel, calls } = load({ touch: false });
  N.items = [{ id: 9, kind: 'mention', appSlug: 'demo-app', readAt: null }];
  N.show();
  N._onItemClick(9);

  assert.deepEqual(navAndDismiss(calls), ['dismiss', 'nav']);
  assert.deepEqual(calls.find((c) => c[0] === 'nav'), ['nav', 'demo-app', 'dev']);
  assert.equal(N.open, false, 'the drawer is closed');
  assert.ok(panel.classList.contains('hidden'));
});

// ── the other navigating drawer actions on touch ────────────────────────

test('touch: clicking a notification row dismisses the sheet before routing', () => {
  const { N, calls } = load({ touch: true });
  N.items = [{ id: 9, kind: 'mention', appSlug: 'demo-app', readAt: null }];
  N.show();
  N._onItemClick(9);

  assert.deepEqual(navAndDismiss(calls), ['dismiss', 'nav']);
  assert.deepEqual(calls.find((c) => c[0] === 'nav'), ['nav', 'demo-app', 'dev']);
  assert.equal(N.open, false);
});

test('touch: a non-routing item leaves the sheet presented', () => {
  const { N, calls } = load({ touch: true });
  // No appSlug and not a conversation/session kind: _onItemClick marks it
  // read and routes nowhere, so the sheet must stay.
  N.items = [{ id: 10, kind: 'mention', appSlug: null, readAt: null }];
  N.show();
  N._onItemClick(10);

  assert.equal(N.open, true, 'the drawer stays presented');
  assert.ok(!calls.some((c) => c[0] === 'dismiss'), 'no dismiss');
  assert.ok(!calls.some((c) => c[0] === 'nav'), 'no navigation');
});

test('touch: clicking a saved message dismisses the sheet before routing', () => {
  const { N, calls } = load({ touch: true });
  N.saved = [{ messageId: 3, appSlug: 'demo-app' }];
  N.show();
  N._onSavedClick(3);

  assert.deepEqual(navAndDismiss(calls), ['dismiss', 'nav']);
  assert.deepEqual(calls.find((c) => c[0] === 'nav'), ['nav', 'demo-app', 'dev']);
});

test('touch: a saved row without an appSlug routes nowhere and keeps the drawer', () => {
  const { N, calls } = load({ touch: true });
  N.saved = [{ messageId: 3, appSlug: null }];
  N.show();
  N._onSavedClick(3);
  assert.equal(N.open, true);
  assert.ok(!calls.some((c) => c[0] === 'dismiss' || c[0] === 'nav'));
});

// ── the cog drawer's pinned rows used to share _onItemClick ─────────────

test('the session kinds the cog drawer showed route through the same handler', () => {
  // The cog's "Needs attention" rows rendered through this module's row
  // component and routed through _onItemClick, so the case that mattered was
  // "dismiss the OTHER drawer's sheet first". THE UI OVERHAUL retired the cog
  // and merged those four kinds into this one list, so there is no other
  // drawer — but the rows are still here, and they must still close the
  // drawer they now live in before navigating.
  const { N, calls } = load({ touch: true });
  N.items = [{ id: 9, kind: 'session_done', appSlug: 'demo-app', sessionId: 4, readAt: null }];
  N.show();
  N._onItemClick(9);

  assert.deepEqual(navAndDismiss(calls), ['dismiss', 'nav'],
    'a session notification closes the drawer before navigation');
});

test('the four session kinds are rendered rather than filtered out', () => {
  // They rendered ONLY in the cog before, so the merge had to drop the filter
  // or four notification kinds would have gone invisible everywhere — the one
  // thing a drawer merge must not do.
  const { N } = load({ touch: false });
  N.items = [
    { id: 1, kind: 'session_done', appSlug: 'a', readAt: null },
    { id: 2, kind: 'auto_solve_done', appSlug: 'a', readAt: null },
    { id: 3, kind: 'stale_pr', appSlug: 'a', readAt: null },
    { id: 4, kind: 'check_failed', appSlug: 'a', readAt: null },
    { id: 5, kind: 'mention', appSlug: 'a', readAt: null },
  ];
  assert.equal(N._bellItems().length, 5, 'every kind reaches the list');
});

// ── the helper's gate, directly ─────────────────────────────────────────

test('_dismissSheetForNav is a strict no-op with nothing presented', () => {
  const { N, panel, calls } = load({ touch: false });
  // Never opened: closing an already-closed drawer must not fire a teardown.
  N._dismissSheetForNav();
  assert.equal(N.open, false);
  assert.ok(panel.classList.contains('hidden'));
  assert.ok(!calls.some((c) => c[0] === 'dismiss'));
});
