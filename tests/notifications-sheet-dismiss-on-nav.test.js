// #1329: accepting an invitation from the bell drawer on a phone used to
// navigate to the app BEHIND the still-presented kit bottom sheet. Nothing
// ever dismissed the sheet, so the user was stranded under a modal,
// mostly-empty near-white surface over a dimmed backdrop — reported as "the
// app freezes on a white screen". The same held for tapping a notification
// row or a saved message inside the sheet.
//
// The contract under test: every bell-drawer action that actually NAVIGATES
// calls Notifications._dismissSheetForNav() first, which dismisses a
// presented kit sheet (and a presented WorkDrawer sheet — the cog's pinned
// rows route through the shared _onItemClick) and is a strict no-op
// otherwise. On desktop no sheet exists, so the anchored panel KEEPS its
// documented keep-open behaviour — pinned here so a later change can't
// silently flip it.
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
      getElementById: (id) => (id === 'notifications-panel' ? panel : null),
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts) => {
      calls.push(['fetch', String(url), (opts && opts.method) || 'GET']);
      if (fetchImpl) return fetchImpl(url, opts);
      return { ok: false, json: async () => ({}) };
    },
    PlatformUI: {
      isTouch: () => touch,
      toast: (msg) => calls.push(['toast', String(msg)]),
      sheet(opts) {
        if (!touch) return null;
        calls.push(['present']);
        return {
          el: {},
          dismiss: () => { calls.push(['dismiss']); opts.onDismiss(); },
        };
      },
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
  assert.ok(N._sheet, 'the drawer rides in a kit sheet on touch');
  assert.equal(N.open, true);

  await N._acceptInvite(5, 'demo-app', 'approver');

  assert.deepEqual(navAndDismiss(calls), ['dismiss', 'nav'],
    'the sheet is dismissed BEFORE navigation');
  const nav = calls.find((c) => c[0] === 'nav');
  assert.deepEqual(nav, ['nav', 'demo-app', 'group-chat']);
  assert.equal(N._sheet, null, 'the sheet handle is cleared');
  assert.equal(N.open, false, 'the drawer is closed');
  assert.ok(panel.classList.contains('hidden'), 'the panel is hidden again');
  assert.ok(!panel.classList.contains('platform-sheet-adopted'),
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

  assert.ok(N._sheet, 'the sheet stays presented');
  assert.equal(N.open, true);
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

  assert.ok(N._sheet, 'the sheet stays presented');
  assert.ok(!calls.some((c) => c[0] === 'dismiss'), 'no dismiss');
  assert.ok(!calls.some((c) => c[0] === 'nav'), 'no navigation');
  assert.deepEqual(N.invites, [], 'the invite row is removed locally');
});

// ── the preserved desktop contract ──────────────────────────────────────

test('desktop: accepting navigates and the anchored panel KEEPS its keep-open behaviour', async () => {
  const { N, panel, calls } = load({ touch: false, fetchImpl: acceptOk('demo-app') });
  N.invites = [{ appId: 5, appSlug: 'demo-app', kind: 'approver' }];
  N.show();
  assert.equal(N._sheet, null, 'no sheet on desktop');
  assert.equal(N.open, true);

  await N._acceptInvite(5, 'demo-app', 'approver');

  assert.deepEqual(calls.find((c) => c[0] === 'nav'), ['nav', 'demo-app', 'group-chat']);
  assert.equal(N.open, true, 'the anchored panel stays open');
  assert.ok(!panel.classList.contains('hidden'), 'the panel is still visible');
  assert.ok(!calls.some((c) => c[0] === 'dismiss'), '_dismissSheetForNav was a no-op');
});

test('desktop: clicking a notification row keeps the panel open (documented click-through)', () => {
  const { N, panel, calls } = load({ touch: false });
  N.items = [{ id: 9, kind: 'mention', appSlug: 'demo-app', readAt: null }];
  N.show();
  N._onItemClick(9);

  assert.deepEqual(calls.find((c) => c[0] === 'nav'), ['nav', 'demo-app', 'dev']);
  assert.equal(N.open, true, 'the anchored panel stays open');
  assert.ok(!panel.classList.contains('hidden'));
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

  assert.ok(N._sheet, 'the sheet stays presented');
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

test('touch: a saved row without an appSlug routes nowhere and keeps the sheet', () => {
  const { N, calls } = load({ touch: true });
  N.saved = [{ messageId: 3, appSlug: null }];
  N.show();
  N._onSavedClick(3);
  assert.ok(N._sheet);
  assert.ok(!calls.some((c) => c[0] === 'dismiss' || c[0] === 'nav'));
});

// ── the cog drawer's pinned rows share _onItemClick ─────────────────────

test('a presented WorkDrawer sheet is dismissed by the shared _onItemClick routing', () => {
  const { sandbox, N, calls } = load({ touch: true });
  // The cog's "Needs attention" rows render through the bell's row component
  // and route through Notifications._onItemClick while the WORK drawer's
  // sheet is the one presented (the two are mutually exclusive).
  sandbox.WorkDrawer = {
    _sheet: { dismiss: () => {} },
    hide: () => calls.push(['wd-hide']),
  };
  N.items = [{ id: 9, kind: 'session_done', appSlug: 'demo-app', sessionId: 4, readAt: null }];
  N._onItemClick(9);

  const order = calls.filter((c) => c[0] === 'wd-hide' || c[0] === 'nav').map((c) => c[0]);
  assert.deepEqual(order, ['wd-hide', 'nav'], 'the cog sheet is dismissed before navigation');
});

// ── the helper's gate, directly ─────────────────────────────────────────

test('_dismissSheetForNav is a strict no-op with no sheet presented', () => {
  const { N, panel, calls } = load({ touch: false });
  N.show();
  N._dismissSheetForNav();
  assert.equal(N.open, true, 'the desktop panel is untouched');
  assert.ok(!panel.classList.contains('hidden'));
  assert.ok(!calls.some((c) => c[0] === 'dismiss'));
});
