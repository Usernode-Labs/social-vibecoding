// Tests for the header-cog "your work" drawer (public/js/work-drawer.js)
// and the notification-kind split it introduces:
//
//   1. Kind routing — the four session-related kinds (session_done,
//      auto_solve_done, stale_pr, check_failed) render in the cog
//      drawer, everything else stays in the bell; the canonical set in
//      notifications.js and work-drawer.js's standalone fallback literal
//      must agree.
//   2. Spin predicate — WorkDrawer.isWorking() is true exactly while an
//      AI turn is in flight (busy totals / busy session rows) or a
//      proposal sits in a spinner-carrying MergeStatus lifecycle state
//      (merging / resolving / checks running); idle sessions and settled
//      proposals do NOT spin.
//   3. Badge math — Notifications._sessionUnread / _bellUnread split the
//      account-wide unread count between the cog's green badge and the
//      bell's red badge without double-counting.
//
// Real shipped sources are loaded into a vm sandbox (so the tests can't
// drift from what runs) with minimal DOM stubs.
//
// Run with: node --test tests/work-drawer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const MERGE_STATUS_SRC = read('merge-status.js');
const WORK_DRAWER_SRC = read('work-drawer.js');
const NOTIFICATIONS_SRC = read('notifications.js');

// Minimal escapeHtml-compatible element for notifications.js's div-based
// escaper (set textContent, read innerHTML).
function makeEscaperElement() {
  const el = { _v: '' };
  Object.defineProperty(el, 'textContent', { set(v) { el._v = String(v); } });
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return el._v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  });
  return el;
}

function makeSandbox() {
  const elements = new Map();
  const sandbox = {
    console,
    title: '',
    document: {
      title: '',
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: makeEscaperElement,
      body: { appendChild: () => {} },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: false }),
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__elements = elements;
  vm.createContext(sandbox);
  return sandbox;
}

// The full page stack, in real load order: notifications.js →
// merge-status.js → work-drawer.js.
function loadAll() {
  const sandbox = makeSandbox();
  vm.runInContext(
    `${NOTIFICATIONS_SRC}\n${MERGE_STATUS_SRC}\n${WORK_DRAWER_SRC}`,
    sandbox
  );
  return sandbox;
}

const SESSION_KINDS = ['session_done', 'auto_solve_done', 'stale_pr', 'check_failed'];

// ── 1. kind routing ─────────────────────────────────────────────────────

test('the canonical session-kind set holds exactly the four session-related kinds', () => {
  const sb = loadAll();
  const set = sb.window.SESSION_NOTIF_KINDS;
  assert.ok(set && set.size === 4, 'set exposed on window');
  assert.deepEqual(Array.from(set).sort(), [...SESSION_KINDS].sort());
});

test("work-drawer's standalone fallback literal matches the canonical set", () => {
  const sb = loadAll();
  const canonical = [...sb.window.SESSION_NOTIF_KINDS].sort();
  // Drop the canonical set to expose the fallback path.
  delete sb.window.SESSION_NOTIF_KINDS;
  const fallback = [...sb.WorkDrawer._kinds()].sort();
  assert.deepEqual(fallback, canonical);
});

test('bell rendering excludes session kinds; the cog pinned section holds exactly the unread ones', () => {
  const sb = loadAll();
  const N = sb.window.Notifications;
  N.items = [
    { id: 1, kind: 'mention', appId: 5, appName: 'A', createdAt: '2026-01-01', readAt: null },
    { id: 2, kind: 'session_done', appId: 5, appName: 'A', createdAt: '2026-01-01', readAt: null },
    { id: 3, kind: 'check_failed', appId: 5, appName: 'A', createdAt: '2026-01-01', readAt: null },
    { id: 4, kind: 'stale_pr', appId: 5, appName: 'A', createdAt: '2026-01-01', readAt: '2026-01-02' },
    { id: 5, kind: 'kudos', appId: 6, appName: 'B', createdAt: '2026-01-01', readAt: null },
    { id: 6, kind: 'auto_solve_done', appId: 6, appName: 'B', createdAt: '2026-01-01', readAt: null },
  ];
  // Array.from: results are VM-realm arrays, which deepStrictEqual
  // rejects on prototype identity — copy into host-realm arrays first.
  const bellIds = Array.from(N._bellItems(), (n) => n.id);
  assert.deepEqual(bellIds, [1, 5], 'bell keeps only the social kinds');
  const grouped = [];
  for (const g of Array.from(N._groupByApp())) {
    for (const n of Array.from(g.items)) grouped.push(n.id);
  }
  assert.deepEqual(grouped.sort(), [1, 5], 'grouping never sees session kinds');

  const pendingIds = Array.from(sb.WorkDrawer._pendingNotifs(), (n) => n.id);
  assert.deepEqual(pendingIds, [2, 3, 6], 'cog pins unread session kinds only (read stale_pr dropped)');
});

test('renderPendingSection renders the shared per-kind rows under a "Needs attention" header', () => {
  const sb = loadAll();
  sb.window.Notifications.items = [
    { id: 2, kind: 'session_done', appId: 5, appName: 'Demo App', prTitle: 'Fix the header', createdAt: new Date().toISOString(), readAt: null },
  ];
  const html = sb.WorkDrawer.renderPendingSection();
  assert.match(html, /Needs attention/);
  assert.match(html, /data-notif-id="2"/, 'reuses the bell row markup (clickable, markable)');
  assert.match(html, /Your dev session in/);
  assert.match(html, /Fix the header/);
});

test('work-drawer mark-all sends a generic section selector with the Activity watermark', async () => {
  const sb = loadAll();
  const N = sb.window.Notifications;
  N.items = [{ id: '9007199254740993', kind: 'session_done', readAt: null }];
  N.unread = 1;
  N.readThroughInboxSequence = '9007199254740993';
  N._reconcileCompletionTitle = () => {};
  N._renderBadge = () => {};
  let request;
  sb.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ unread: 0, cleared: 1 }) };
  };

  await sb.WorkDrawer.markAllRead();

  assert.equal(request.url, '/api/notifications/read');
  assert.deepEqual(JSON.parse(request.options.body), {
    section: 'work',
    through_inbox_sequence: '9007199254740993',
  });
  assert.ok(N.items[0].readAt, 'the work item is marked read locally');
});

test('work-drawer preserves Activity notification ids as opaque strings', () => {
  assert.match(WORK_DRAWER_SRC, /const id = el\.getAttribute\('data-notif-id'\)/);
  assert.doesNotMatch(WORK_DRAWER_SRC, /Number\(el\.getAttribute\('data-notif-id'\)\)/);
});

// ── 2. spin predicate ───────────────────────────────────────────────────

function drawerWith(sb, { totals, sessions, proposals } = {}) {
  const W = sb.WorkDrawer;
  W.totals = totals || { active: 0, promoted: 0, paused: 0, busy: 0, total: 0 };
  W.sessions = sessions || [];
  W.proposals = proposals || [];
  W.governance = [];
  return W;
}

test('isWorking: false when idle (open sessions waiting on the user do not spin)', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    totals: { active: 2, promoted: 1, paused: 1, busy: 0, total: 4 },
    sessions: [{ id: 1, status: 'active', busy: false }],
    proposals: [{ id: 9, status: 'promoted', yes_count: 0, majority: 3, check_state: 'passing' }],
  });
  assert.equal(W.isWorking(), false);
});

test('isWorking: true while an AI turn is in flight', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    totals: { active: 1, promoted: 0, paused: 0, busy: 1, total: 1 },
    sessions: [{ id: 1, status: 'active', busy: true }],
  });
  assert.equal(W.isWorking(), true);
});

test('isWorking: true for each spinner-carrying merge-lifecycle state', () => {
  const sb = loadAll();
  const spinnerStates = [
    { status: 'merging' },                              // merging
    { status: 'promoted', merge_conflict_state: 'resolving' }, // resolving
    { status: 'promoted', check_state: 'pending' },     // checks running
  ];
  for (const p of spinnerStates) {
    const W = drawerWith(sb, { proposals: [{ id: 1, yes_count: 0, majority: 3, ...p }] });
    assert.equal(W.isWorking(), true, `spins for ${JSON.stringify(p)}`);
  }
});

test('isWorking: false for settled / blocked proposal states', () => {
  const sb = loadAll();
  const stillStates = [
    { status: 'promoted', check_state: 'failing' },
    { status: 'promoted', merge_conflict_state: 'failed', check_state: 'passing' },
    { status: 'merged' },
  ];
  for (const p of stillStates) {
    const W = drawerWith(sb, { proposals: [{ id: 1, yes_count: 0, majority: 3, ...p }] });
    assert.equal(W.isWorking(), false, `no spin for ${JSON.stringify(p)}`);
  }
});

// ── 3. badge math ───────────────────────────────────────────────────────

function badgeEl() {
  const classes = new Set(['hidden']);
  return {
    textContent: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
  };
}

test('_renderBadge splits unread between the cog (green) and the bell (red)', () => {
  const sb = loadAll();
  const N = sb.window.Notifications;
  const red = badgeEl();
  const green = badgeEl();
  const markAll = { disabled: false };
  sb.__elements.set('notifications-badge', red);
  sb.__elements.set('notifications-badge-ai', green);
  sb.__elements.set('notifications-mark-all', markAll);

  // 5 unread account-wide: 3 session-related (loaded), 2 bell, +1 invite.
  N.unread = 5;
  N.invites = [{ appId: 1 }];
  N.items = [
    { id: 1, kind: 'session_done', readAt: null },
    { id: 2, kind: 'check_failed', readAt: null },
    { id: 3, kind: 'stale_pr', readAt: null },
    { id: 4, kind: 'stale_pr', readAt: '2026-01-01' }, // read: counts nowhere
    { id: 5, kind: 'mention', readAt: null },
    { id: 6, kind: 'kudos', readAt: null },
  ];
  N._renderBadge();

  assert.equal(green.textContent, '3', 'cog badge = unread session-related items');
  assert.ok(!green.classList.contains('hidden'));
  assert.equal(red.textContent, '3', 'bell badge = (unread - session) + invites = 2 + 1');
  assert.ok(!red.classList.contains('hidden'));
  assert.equal(markAll.disabled, false, 'bell has its own unread → mark-all enabled');

  // Only session-related unread left → bell red hides (no invites), green stays.
  N.unread = 1;
  N.invites = [];
  N.items = [{ id: 1, kind: 'auto_solve_done', readAt: null }];
  N._renderBadge();
  assert.ok(red.classList.contains('hidden'), 'red hides when the bell itself has nothing');
  assert.equal(green.textContent, '1');
  assert.equal(markAll.disabled, true, 'bell mark-all disabled when only cog items remain');
});

// ── 4. de-dup: promoted sessions render under "Your proposals" only (#747) ──

const mkSession = (over = {}) => ({
  id: 1, status: 'active', busy: false, app_slug: 'demo', app_name: 'Demo App',
  session_title: 'A session', last_activity_at: new Date().toISOString(),
  created_at: new Date().toISOString(), ...over,
});

const mkProposal = (over = {}) => ({
  id: 1, status: 'promoted', pr_number: 101, pr_title: 'A proposal',
  pr_title_fallback: false, app_slug: 'demo', app_name: 'Demo App',
  yes_count: 1, no_count: 0, majority: 3, check_state: 'passing', ...over,
});

test('renderSessionsSection drops a session whose id appears in the proposals list', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    sessions: [
      mkSession({ id: 7, status: 'promoted', session_title: 'Promoted dup' }),
      mkSession({ id: 8, status: 'active', session_title: 'Plain active' }),
    ],
    proposals: [mkProposal({ id: 7, pr_title: 'Promoted dup' })],
  });
  const html = W.renderSessionsSection();
  assert.match(html, /Your sessions/);
  assert.match(html, /Plain active/, 'non-promoted session still renders');
  assert.doesNotMatch(html, /dev\/sessions\/7/, 'duplicated promoted session is dropped');
  assert.match(html, /dev\/sessions\/8/);
});

test('renderSessionsSection returns "" when every session is filtered out (no orphan header)', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    sessions: [mkSession({ id: 7, status: 'promoted' })],
    proposals: [mkProposal({ id: 7 })],
  });
  assert.equal(W.renderSessionsSection(), '');
});

test('a session matching a governance row id is NOT filtered (PR proposals only)', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    sessions: [mkSession({ id: 42, session_title: 'Session colliding with an issue id' })],
    proposals: [],
  });
  // Governance ids come from the issues table — same numeric space as
  // nothing session-related; a collision must not hide the session.
  W.governance = [{ id: 42, title: 'Secret change', app_slug: 'demo', app_name: 'Demo App', up_count: 0 }];
  const html = W.renderSessionsSection();
  assert.match(html, /dev\/sessions\/42/, 'session survives a governance id collision');
});

test('renderProposalsSection carries the "working…" tag from a busy matching session', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    sessions: [
      mkSession({ id: 7, status: 'promoted', busy: true }),
      mkSession({ id: 9, status: 'promoted', busy: false }),
    ],
    proposals: [
      mkProposal({ id: 7, pr_title: 'Busy proposal' }),
      mkProposal({ id: 9, pr_title: 'Idle proposal' }),
    ],
  });
  const html = W.renderProposalsSection();
  const rows = html.split('<a ');
  const busyRow = rows.find((r) => r.includes('dev/proposals/7'));
  const idleRow = rows.find((r) => r.includes('dev/proposals/9'));
  assert.ok(busyRow && busyRow.includes('working…'), 'busy session\'s proposal row shows the spinner tag');
  assert.ok(idleRow && !idleRow.includes('working…'), 'idle proposal row has no spinner tag');
});

test('isWorking stays true for a busy promoted session filtered from the rendered list', () => {
  const sb = loadAll();
  const W = drawerWith(sb, {
    totals: { active: 0, promoted: 1, paused: 0, busy: 0, total: 1 },
    sessions: [mkSession({ id: 7, status: 'promoted', busy: true })],
    proposals: [mkProposal({ id: 7, check_state: 'passing' })],
  });
  assert.equal(W.renderSessionsSection(), '', 'row hidden from Your sessions');
  assert.equal(W.isWorking(), true, 'cog spin still driven by the unfiltered data array');
});
