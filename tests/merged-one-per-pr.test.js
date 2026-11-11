// #6482: the Completed stream (the Workshop's All items) drew one merged
// change twice when more than one chat_sessions row named the same pull
// request and both were marked merged. GET /api/apps/:slug/merged now leaves
// the older twin out of its page, its Done total and the shipped-week count;
// the client groups again for rows cached across loads, so the hub's
// Recently live cannot draw the twin either. The row kept is the one
// /changes/:number opens: the row that reached a vote, then the newest.
//
// Run with: node --test tests/merged-one-per-pr.test.js
// The PostgreSQL half skips unless TEST_DATABASE_URL/DATABASE_URL is
// reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('module');
const vm = require('node:vm');
const path = require('node:path');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// ---------------------------------------------------------------- client

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox.__AppView;
}

const at = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00Z`;
const mergedRow = (over) => ({
  id: over.id,
  pr_number: over.pr_number,
  pr_title: over.pr_title || `Change ${over.id}`,
  status: over.status || 'merged',
  row_type: over.row_type || 'pr',
  user_id: 1,
  username: 'smartfren666',
  created_at: over.created_at || at(1),
  merged_at: over.merged_at || at(2),
  live_at: over.live_at === undefined ? at(3) : over.live_at,
  ...over,
});
const idsOf = (items) => Array.from(items, (i) => i.id);

test('two merged records naming one pull request give one Done entry and one Recently live entry', () => {
  const AppView = makeAppView();
  const older = mergedRow({ id: 901, pr_number: 700, merged_at: at(2) });
  const newer = mergedRow({ id: 905, pr_number: 700, merged_at: at(3) });

  const b = AppView._bucketDevItems({
    issues: [], proposals: [], gov: [], merged: [older, newer],
  });
  assert.deepEqual(idsOf(b.done), [905], 'one entry, the newest record');

  AppView._merged = [older, newer];
  const live = AppView._workshopRecentLive(10);
  assert.deepEqual(live.map((row) => row.sessionId), [905], 'Recently live shows it once too');
});

test('the twin cannot take a Recently live slot', () => {
  const AppView = makeAppView();
  const older = mergedRow({ id: 901, pr_number: 700, merged_at: at(2) });
  const newer = mergedRow({ id: 905, pr_number: 700, merged_at: at(3) });
  const other = mergedRow({ id: 910, pr_number: 701, merged_at: at(1) });
  AppView._merged = [older, newer, other];
  const live = AppView._workshopRecentLive(1);
  assert.deepEqual(live.map((row) => row.sessionId), [905],
    'the kept record, not the older twin, fills the first slot');
});

test('the record that reached a vote wins over the newest merged twin', () => {
  const AppView = makeAppView();
  const merged = mergedRow({ id: 905, pr_number: 700, status: 'merged', merged_at: at(3) });
  const promoted = mergedRow({ id: 901, pr_number: 700, status: 'promoted', merged_at: null });
  const b = AppView._bucketDevItems({
    issues: [], proposals: [], gov: [], merged: [merged, promoted],
  });
  assert.deepEqual(idsOf(b.done), [901], 'promoted first, then merging, then newest');
});

test('rows with no pull request number, and close-issue decisions, each keep their entry', () => {
  const AppView = makeAppView();
  const noPrA = mergedRow({ id: 901, pr_number: null });
  const noPrB = mergedRow({ id: 902, pr_number: null });
  const decision = mergedRow({ id: 905, pr_number: 700, row_type: 'close_issue' });
  const pr = mergedRow({ id: 906, pr_number: 700 });
  const b = AppView._bucketDevItems({
    issues: [], proposals: [], gov: [], merged: [noPrA, noPrB, decision, pr],
  });
  assert.deepEqual(idsOf(b.done).sort(), [901, 902, 905, 906],
    'nothing groups a null PR number or a decision with a change');
});

// ---------------------------------------------------------------- route

function makeRecordingRouter(routes) {
  const record = (method) => (p, ...handlers) => {
    routes.push({ method, path: p, handler: handlers[handlers.length - 1] });
  };
  return { get: record('get'), post: record('post'), put: record('put'), delete: record('delete'), use() {} };
}

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadVotes({ query, app }) {
  const routes = [];
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    topicAttrs: require.resolve('../src/services/topic-attributes'),
    visuals: require.resolve('../src/services/visuals'),
    delivery: require.resolve('../src/services/proposal-delivery'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) {
    if (k === 'express') continue;
    orig[k] = require.cache[id];
  }
  const captured = { calls: [] };

  const _origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'express') return { Router: () => makeRecordingRouter(routes) };
    return _origLoad.call(this, request, ...rest);
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => ({
    async query(sql, params) {
      captured.calls.push({ sql, params });
      return query(sql, params, captured.calls.length);
    },
  }) });
  stub(ids.github, { isEnabled: () => false });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.ws, { broadcast() {}, getReactionsForMessages: async () => ({}) });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 3, majority: 2 }),
    isUserActive: async () => true,
    listActiveUserIds: async () => [],
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.appAccess, {
    getAppForUser: async () => ({ id: 1, slug: 'demo', self_hosted: false, ...(app || {}) }),
    sessionCollabGuard: () => (req, res, next) => next(),
    ACCESS_COLUMNS: '',
  });
  stub(ids.topicAttrs, {
    summarizeForTargets: async () => new Map(),
    summarizeForProposals: async () => new Map(),
    emptySummary: () => ({ priority: null, assignee: null }),
  });
  stub(ids.visuals, { shapeAgg: () => null });
  stub(ids.delivery, { annotateChild: async (_config, _pool, _app, rows) => {
    for (const row of rows) {
      if ((row.row_type || 'pr') === 'pr') row.deployment_state = 'unknown';
    }
    return { kind: 'child', state: 'unknown' };
  } });

  delete require.cache[ids.subject];
  const { voteRoutes } = require('../src/routes/votes');
  voteRoutes({});

  Module._load = _origLoad;
  delete require.cache[ids.subject];
  for (const [k, id] of Object.entries(ids)) {
    if (k === 'express') continue;
    if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
  }
  return { routes, captured };
}

async function callMerged(routes, query) {
  const route = routes.find((r) => r.method === 'get' && r.path === '/api/apps/:slug/merged');
  assert.ok(route, 'merged route registered');
  let payload = null;
  await route.handler(
    { params: { slug: 'demo' }, user: { id: 1 }, query },
    { json(p) { payload = p; }, status(c) { return { json(p) { payload = p; } }; } }
  );
  return payload;
}

const emptyPage = (sql) => {
  if (/AS total/.test(sql)) return { rows: [{ total: 0 }] };
  if (/AS shipped_week/.test(sql)) return { rows: [{ shipped_week: 0, shipped_prev_week: 0 }] };
  return { rows: [] };
};

test('the page, the Done total and the shipped-week count each leave the older twin out', async () => {
  const { routes, captured } = loadVotes({ query: async (sql) => emptyPage(sql) });
  await callMerged(routes, {});

  const page = captured.calls.find((c) => /ORDER BY COALESCE\(cs\.merged_at/.test(c.sql));
  assert.ok(page, 'the merged page query ran');
  assert.match(page.sql, /NOT EXISTS \(\s*SELECT 1 FROM chat_sessions twin\s+WHERE twin\.app_id = cs\.app_id AND twin\.status = 'merged'\s+AND twin\.pr_number = cs\.pr_number AND twin\.id > cs\.id\)/,
    'one entry per pull request: no newer merged twin');
  assert.match(page.sql, /ORDER BY COALESCE\(cs\.merged_at, cs\.created_at\) DESC, cs\.id DESC/, 'order unchanged');

  const total = captured.calls.find((c) => /COUNT\(\*\)::int AS total/.test(c.sql));
  assert.ok(total, 'the Done total query ran');
  assert.match(total.sql, /FROM chat_sessions cs/);
  assert.match(total.sql, /twin\.pr_number = cs\.pr_number AND twin\.id > cs\.id/, 'the total counts the grouped set');

  const shipped = captured.calls.find((c) => /AS shipped_week/.test(c.sql));
  assert.ok(shipped, 'the shipped-week query ran');
  assert.match(shipped.sql, /FROM chat_sessions cs/);
  assert.match(shipped.sql, /twin\.pr_number = cs\.pr_number AND twin\.id > cs\.id/, 'this week counts one per pull request');

  const close = captured.calls.find((c) => /i\.kind = 'close_issue' AND i\.status = 'closed'/.test(c.sql));
  assert.ok(close, 'the close-issue query ran');
  assert.doesNotMatch(close.sql, /chat_sessions twin/, 'a decision keeps its own entry');

  const cursor = captured.calls.find((c) => /\(COALESCE\(cs\.merged_at, cs\.created_at\), cs\.id\) < \(\$3, \$4\)/.test(c.sql));
  assert.ok(!cursor, 'no cursor predicate on the first page');
});

test('a keyset cursor still pages over the grouped set', async () => {
  const { routes, captured } = loadVotes({ query: async (sql) => emptyPage(sql) });
  await callMerged(routes, { before_completed_at: '2026-01-30T00:00:00.000Z', before_id: '900' });
  const page = captured.calls.find((c) => /ORDER BY COALESCE\(cs\.merged_at/.test(c.sql));
  assert.match(page.sql, /\(COALESCE\(cs\.merged_at, cs\.created_at\), cs\.id\) < \(\$3, \$4\)/, 'keyset predicate unchanged');
  assert.match(page.sql, /twin\.id > cs\.id/, 'the twin exclusion travels with any page');
  assert.match(page.sql, /LIMIT \$5/, 'limit bound after cursor params');
});

// ---------------------------------------------------------------- real DB

test('against PostgreSQL, two merged records naming one pull request give one row, one total and one shipped', { timeout: 120000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  let Pool;
  let admin;
  try {
    ({ Pool } = require('pg'));
    admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    await admin.query('SELECT 1');
  } catch (err) {
    if (admin) await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }

  const dbName = 'merged_one_per_pr_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  let schema;
  try {
    schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  } catch {
    t.skip('src/db/schema.sql is not built; run npm run build:schema');
    return;
  }
  await pool.query(schema);

  const { rows: [user] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('smartfren666', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by) VALUES ('Demo', 'demo', $1) RETURNING id`, [user.id]);
  const insert = (id, prNumber, mergedAt) => pool.query(
    `INSERT INTO chat_sessions (id, app_id, user_id, status, pr_number, pr_title, merged_at, live_at, created_at)
     VALUES ($1, $2, $3, 'merged', $4, $5, $6, $6, $6)`,
    [id, app.id, user.id, prNumber, `Change ${prNumber}`, mergedAt]);
  const older = new Date(Date.now() - 10 * 1000);
  const newer = new Date(Date.now() - 7 * 1000);
  await insert(901, 700, older);
  await insert(905, 700, newer);       // the newer twin
  await insert(910, 701, older);       // a different pull request
  await insert(911, null, older);      // no pull request number
  await insert(912, null, older);      // no pull request number

  const { routes } = loadVotes({
    query: (sql, params) => pool.query(sql, params),
    app: { id: app.id, slug: 'demo', self_hosted: false },
  });
  // appAccess was stubbed with id 1; the real route must read this app's rows.
  const payload = await callMerged(routes, {});
  const ids = payload.merged.map((row) => row.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [905, 910, 911, 912],
    'one row per pull request (the newest twin), and rows without one stay');
  assert.ok(!payload.merged.some((row) => row.id === 901), 'the older twin is left out');
  assert.equal(payload.total, 4, 'the Done total counts each change once');
  assert.equal(payload.shipped.week, 4, 'shipped this week counts each change once');
  assert.ok(payload.shipped.prevWeek >= 0);
});
