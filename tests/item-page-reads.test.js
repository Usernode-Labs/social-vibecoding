// What an item's page and the dev chat's session list read.
//
// Measured on production (the platform app): a proposal's own row was 265 KB,
// 255 KB of it the names of the 821 checks that passed, and the dev chat's
// session list was every session its author ever started there (1,112 rows,
// 693 KB; 1,015 merged and 97 archived), re-read on every open of a change.
// Pinned here:
//   - the item's own read (/proposals/:id, /api/sessions/:id/details) takes
//     `?results=failing` and then counts its passing checks instead of naming
//     them, once there are more than the verdict lists without a fold;
//   - the verdict's fold reads the names when opened, and keeps them for that
//     run, so a later refresh in the short form does not take them away;
//   - `GET /api/apps/:slug/sessions?recent=N` answers every session under
//     way and the N newest finished ones, counting the rest, and the dev
//     chat's list ends with "Show N older sessions" that reads the whole list.
//
// Run with: node --test tests/item-page-reads.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── The session list route, driven for real ────────────────────────────
const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(String(sql), params) });
const worker = require('../src/services/worker');
worker.warmRegistrySnapshot = () => [];
const appAccess = require('../src/services/app-access');
appAccess.getAppForUser = async () => ({ id: 1, slug: 'demo', repo_url: 'https://github.com/bot/demo' });
const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');
const listTestResults = require('../src/services/list-test-results');

const VIEWER = { id: 7, username: 'tester' };

async function withServer(fn) {
  const app = express();
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({}));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    poolQueryHandler = async () => ({ rows: [] });
  }
}

// Newest first, as the route's ORDER BY created_at DESC answers them.
const HISTORY = [
  { id: 9, status: 'active' },
  { id: 8, status: 'merged' },
  { id: 7, status: 'promoted' },
  { id: 6, status: 'merged' },
  { id: 5, status: 'archived' },
  { id: 4, status: 'paused' },
  { id: 3, status: 'merged' },
];

function answerHistory(statusFilter) {
  poolQueryHandler = async (sql, params) => {
    if (/FROM chat_sessions\s+WHERE app_id = \$1 AND user_id = \$2/.test(sql)) {
      statusFilter.push(params[2]);
      const rows = params[2] ? HISTORY.filter((r) => r.status === params[2]) : HISTORY;
      return { rows: rows.map((r) => ({ ...r })) };
    }
    return { rows: [] };
  };
}

test('?recent=N lists every session under way and the N newest finished ones, counting the rest', async () => {
  const filters = [];
  answerHistory(filters);
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/apps/demo/sessions?recent=2`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.sessions.map((s) => s.id), [9, 8, 7, 6, 4],
      'active, promoted and paused all stay; the two newest finished stay; order is kept');
    assert.equal(body.older_finished, 2, 'the archived row and the oldest merged one are counted, not sent');
    assert.ok(body.sessions.every((s) => s.warm === false), 'rows still carry `warm`');
  });
  assert.deepEqual(filters, [null], 'the SQL still reads the whole history; only the answer is cut');
});

test('without ?recent the list is answered whole, and ?status=archived ignores it', async () => {
  answerHistory([]);
  await withServer(async (base) => {
    const whole = await (await fetch(`${base}/api/apps/demo/sessions`)).json();
    assert.equal(whole.sessions.length, HISTORY.length);
    assert.ok(!('older_finished' in whole), 'the old shape, exactly');
    for (const junk of ['0', '-3', 'abc', '']) {
      const r = await (await fetch(`${base}/api/apps/demo/sessions?recent=${junk}`)).json();
      assert.equal(r.sessions.length, HISTORY.length, `recent=${junk} is not a limit`);
    }
    const archived = await (await fetch(`${base}/api/apps/demo/sessions?status=archived&recent=1`)).json();
    assert.deepEqual(archived.sessions.map((s) => s.id), [5]);
    assert.ok(!('older_finished' in archived));
  });
});

// ── The change page's own read, driven for real ────────────────────────
// The app's access columns (appAccess.ACCESS_COLUMNS), open to everyone.
const ACCESS = { slug: 'demo', created_by: 1, self_hosted: false, collab_visibility: 'public', view_visibility: 'public', moderation_suspended_at: null };
const checks = (passing, failing) => [
  ...Array.from({ length: passing }, (_, i) => ({ name: `pass ${i}`, status: 'pass' })),
  ...Array.from({ length: failing }, (_, i) => ({ name: `fail ${i}`, status: 'fail' })),
];

test('/api/sessions/:id/details takes ?results=failing; /checks and the plain read keep every result', async () => {
  poolQueryHandler = async (sql) => {
    // The session guard and the route read the same join; one row answers
    // both (the guard needs the app's access columns).
    if (/FROM chat_sessions cs\s+JOIN apps a ON a\.id = cs\.app_id\s+WHERE cs\.id = \$1/.test(sql)) {
      return { rows: [{
        id: 41, user_id: VIEWER.id, status: 'promoted', source: 'native', app_slug: 'demo',
        test_results: checks(12, 1), ...ACCESS,
      }] };
    }
    return { rows: [] };
  };
  await withServer(async (base) => {
    const short = (await (await fetch(`${base}/api/sessions/41/details?results=failing`)).json()).session;
    assert.deepEqual(short.test_results.map((r) => r.name), ['fail 0']);
    assert.equal(short.test_results_omitted, 12);
    const whole = (await (await fetch(`${base}/api/sessions/41/details`)).json()).session;
    assert.equal(whole.test_results.length, 13);
    const ondemand = (await (await fetch(`${base}/api/sessions/41/checks`)).json()).session;
    assert.equal(ondemand.test_results.length, 13);
  });
});

test('forItem keeps a row whole when the verdict would list its passes without a fold', () => {
  const req = { query: { results: 'failing' } };
  assert.equal(listTestResults.ITEM_PASSES_LISTED, 8);
  const few = { id: 1, test_results: checks(8, 2) };
  assert.equal(listTestResults.forItem(req, few), few, 'eight passes are listed inline, so they are sent');
  const many = listTestResults.forItem(req, { id: 1, test_results: checks(9, 2) });
  assert.equal(many.test_results.length, 2);
  assert.equal(many.test_results_omitted, 9);
  const plain = { id: 1, test_results: checks(30, 0) };
  assert.equal(listTestResults.forItem({ query: {} }, plain), plain, 'opt-in');
  assert.equal(listTestResults.forItem(req, null), null);
  // The inline limit is the verdict's own fold threshold.
  assert.match(read('public/js/app-view.js'), /PASS_FOLD_AT: 8,/);
});

// ── The client: AppView's verdict and the names read on demand ─────────
function loadAppView({ fetchImpl } = {}) {
  const calls = [];
  const sandbox = {
    console, relTime: () => 'just now', App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null, querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach() {} }), addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} }, hidden: false,
    },
    fetch: async (url) => { calls.push(String(url)); return fetchImpl ? fetchImpl(String(url)) : { ok: true, json: async () => ({}) }; },
    alert() {}, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    dispatchEvent() {}, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    localStorage: { getItem: () => null, setItem() {} },
    location: { search: '', hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${read('public/js/merge-status.js')}\n${read('public/js/session-transcript.js')}\n`
    + `${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, calls };
}

const shortRow = (over = {}) => ({
  id: 41, status: 'promoted', check_state: 'passing',
  checks_commit_sha: 'abc', checks_checked_at: '2026-09-29T09:00:00Z',
  test_results: [{ name: 'advisory one', status: 'fail', advisory: true }],
  test_results_omitted: 20,
  ...over,
});

test('the verdict counts passes it was not told the names of, and says whose they are', () => {
  const { AppView } = loadAppView();
  const v = AppView._checksVerdictView(shortRow());
  assert.equal(v.passCount, 20);
  assert.equal(v.passes.length, 0);
  assert.equal(v.passesFor, 41, 'the fold knows whose names to read');
  assert.equal(v.foldPasses, true);
  const whole = AppView._checksVerdictView(shortRow({ test_results: checks(3, 0), test_results_omitted: undefined }));
  assert.equal(whole.passesFor, null, 'a row that names its passes needs no read');
});

test('opening the fold reads the row in full, once, and the names survive a short refresh of the same run', async () => {
  const full = shortRow({ test_results: [...checks(20, 0), { name: 'advisory one', status: 'fail', advisory: true }], test_results_omitted: undefined });
  const { AppView, calls } = loadAppView({
    fetchImpl: async () => ({ ok: true, json: async () => ({ proposal: JSON.parse(JSON.stringify(full)) }) }),
  });
  AppView.appData = { slug: 'demo' };
  const held = shortRow();
  AppView._proposals = [held];
  const [a, b] = await Promise.all([AppView._loadCheckNames(41), AppView._loadCheckNames(41)]);
  assert.equal(a, true); assert.equal(b, true);
  assert.deepEqual(calls, ['/api/apps/demo/proposals/41'], 'one read, in full: no ?results=failing');
  assert.equal(held.test_results.length, 21, 'the held row took the names');

  // A live refresh hands back the short form for the SAME run: still named.
  const again = AppView._checksVerdictView(shortRow());
  assert.equal(again.passes.length, 20);
  assert.equal(again.passCount, 20, 'counted once, not twice');
  assert.equal(again.passesFor, null);
  // A NEW run counts its own passes, and the fold reads again.
  const next = AppView._checksVerdictView(shortRow({ checks_checked_at: '2026-09-29T10:00:00Z' }));
  assert.equal(next.passesFor, 41);
});

test('the item reads ask for the short form; an underway change reads /details', async () => {
  const { AppView, calls } = loadAppView({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  AppView.appData = { slug: 'demo' };
  await AppView._readTopicRow(41, true);
  await AppView._readTopicRow(42, false);
  await AppView._readTopicRow(42, false, { full: true });
  assert.deepEqual(calls, [
    '/api/apps/demo/proposals/41?results=failing',
    '/api/sessions/42/details?results=failing',
    '/api/sessions/42/details',
  ]);
  const head = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  // A live re-read (#4177) adds `cache: 'no-cache'` to the same request.
  assert.match(head, /await fetch\(`\$\{url\}\?results=failing\$\{demo\}`, fresh \? \{ \.\.\.FRESH, signal \} : \{ signal \}\);/,
    'the change page\'s own read (readChangeDetail) asks for the short form too');
  assert.match(read('public/js/app-view.js'), /passCount: v\.passCount, passesFor: v\.passesFor,/,
    'the ledger\'s checks row carries it');
});

// ── The client: the dev chat's session list ────────────────────────────
function loadDevChat(answer) {
  const calls = [];
  let published = null;
  const sandbox = {
    console,
    document: {
      getElementById: (id) => (id === 'dc-session-list' ? {} : null),
      querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {}, removeEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, appendChild: () => {}, setAttribute: () => {} }),
      body: { appendChild: () => {}, addEventListener: () => {} },
    },
    escapeHtml: (s) => String(s == null ? '' : s),
    requestAnimationFrame: () => {}, alert: () => {},
    fetch: async (url) => { calls.push(String(url)); return { ok: true, json: async () => answer(String(url)) }; },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {}, removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    UsernodeReact: { devChat: { publishSessionList: (state) => { published = state; } } },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${read('frontend/src/features/dev-chat/dev-chat.js')}\n;globalThis.__DevChat = DevChat;`, sandbox);
  sandbox.AppView = { appData: { slug: 'demo' } };
  return { DevChat: sandbox.__DevChat, calls, published: () => JSON.parse(JSON.stringify(published)), sandbox };
}

test('the dev chat reads its recent sessions, and "Show older" reads the whole list for this app from then on', async () => {
  const row = (id, status) => ({ id, status, session_title: `s${id}`, created_at: '2026-09-01T00:00:00Z' });
  const h = loadDevChat((url) => (url.includes('?recent=')
    ? { sessions: [row(1, 'active'), row(2, 'merged')], older_finished: 1092 }
    : { sessions: [row(1, 'active'), row(2, 'merged'), row(3, 'archived')] }));
  assert.equal(h.DevChat.SESSIONS_RECENT, 20);
  await h.DevChat.loadSessions('demo');
  h.DevChat.renderSessionList();
  assert.deepEqual(h.calls, ['/api/apps/demo/sessions?recent=20']);
  assert.equal(h.published().older, 1092);
  assert.equal(h.published().rows.length, 2);

  await h.DevChat.showOlderSessions();
  assert.equal(h.calls[1], '/api/apps/demo/sessions', 'the whole list');
  assert.equal(h.published().older, 0);
  assert.equal(h.published().rows.length, 3);
  await h.DevChat.loadSessions('demo');
  assert.equal(h.calls[2], '/api/apps/demo/sessions', 'a later reload keeps the whole list');

  h.DevChat.reset();
  await h.DevChat.loadSessions('other');
  assert.equal(h.calls[3], '/api/apps/other/sessions?recent=20', 'another app starts short again');
});

// ── What the reader sees ───────────────────────────────────────────────
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

test('the list ends with "Show N older sessions" only when it left some out', () => {
  const { SessionListView } = loadTsx('tests/fixtures/dev-session-list-api.ts');
  const r = { id: 1, status: 'active', statusTone: 'active', title: 'One', branch: 'b', busy: false, pr: null, createdAt: '2026-09-01T00:00:00Z', actions: [] };
  const withOlder = renderToHtml(createElement(SessionListView, { rows: [r], older: 1092 }));
  assert.match(withOlder, /class="dc-session-older[^"]*"[^>]*>Show 1,092 older sessions</);
  assert.match(renderToHtml(createElement(SessionListView, { rows: [r], older: 1 })), />Show 1 older session</);
  assert.doesNotMatch(renderToHtml(createElement(SessionListView, { rows: [r], older: 0 })), /dc-session-older/);
  assert.doesNotMatch(renderToHtml(createElement(SessionListView, { rows: [], older: 5 })), /Just ask/,
    'rows left out are not "no sessions"');
  assert.match(renderToHtml(createElement(SessionListView, { rows: [], older: 0 })), /Just ask/);
});

test('a fold whose names are not here yet says so, and opening it is what reads them', () => {
  const { ChecksVerdictView } = loadTsx('tests/fixtures/dev-card-api.ts');
  const v = {
    failing: false, heading: 'All passed', summary: '20 checks · 20 passed', failures: [], passes: [], passCount: 20,
    passesFor: 41, foldPasses: true, advisoryNote: null, checkedNote: null, baseNote: null, fixNote: null, action: null,
  };
  const html = renderToHtml(createElement(ChecksVerdictView, { v }));
  assert.match(html, /Show 20 passing checks/);
  assert.match(html, /class="dev-passes-pending[^"]*">Loading passing checks…</);
  const named = renderToHtml(createElement(ChecksVerdictView, { v: { ...v, passesFor: null, passes: [] } }));
  assert.doesNotMatch(named, /dev-passes-pending/);
  const head = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(head, /<details className="mt-1" onToggle=\{names\.onToggle\}>/);
  assert.match(head, /<details className="dev-ledger-passes" onToggle=\{names\.onToggle\}>/);
  assert.match(head, /if \(!e\.currentTarget\.open \|\| !passesFor \|\| state === 'loading' \|\| !av\?\._loadCheckNames\) return;/,
    'only an OPEN fold with unnamed passes reads, and never twice at once');
});
