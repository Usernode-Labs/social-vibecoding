'use strict';

// Profile without the four-second wait (19 Oct 2026 polish board, #5).
//
// Profile held its skeleton until all seven of its reads answered, and one
// of them, GET /api/me/requests, took 3.7 s for someone with about 800
// requests: three EXISTS probes per request, each walking the app's changes
// for `number = ANY(linked_issues)`. Two fixes, pinned here:
//
//   - the server reads where each request stands once per app and joins it
//     in (MY_REQUESTS_STANDING), and answers Profile's row with the counts
//     alone (`?counts=1`); the SQL itself runs in
//     tests/me-requests-postgres.test.js;
//   - the page draws without those counts: the Your requests row holds its
//     line's place and fills in when they land (profile.js _fillRequests).
//
// Run with: node --test tests/profile-requests-late.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STORE = 'frontend/src/features/profile/profile-store.js';

// ── The server ─────────────────────────────────────────────────────────

test('standing is read once per app and joined in, not probed per request', () => {
  const profile = require('../src/routes/profile');
  for (const sql of [profile.MY_REQUESTS_SQL, profile.MY_REQUEST_COUNTS_SQL]) {
    assert.doesNotMatch(sql, /EXISTS\s*\(/, 'no per-request probe');
    assert.doesNotMatch(sql, /= ANY\(cs\.linked_issues\)/);
    assert.match(sql, /CROSS JOIN LATERAL unnest\(cs\.linked_issues\) AS n\(number\)/);
    assert.match(sql, /GROUP BY cs\.app_id, n\.number/, 'one row per app and number, so no request is multiplied');
    assert.match(sql, /LEFT JOIN linked l ON l\.app_id = m\.app_id AND l\.number = m\.number/);
    assert.match(sql, /LEFT JOIN applied_closes ac ON ac\.app_id = m\.app_id AND ac\.number = m\.number::text/);
    // Only the apps the viewer asked something of are read.
    assert.equal((sql.match(/WHERE (?:cs|c)\.app_id IN \(SELECT app_id FROM mine\)/g) || []).length, 2);
  }
  // The list keeps its page and its counts over the whole set.
  assert.match(profile.MY_REQUESTS_SQL, /COUNT\(\*\) OVER \(\) AS total,/);
  assert.match(profile.MY_REQUESTS_SQL, /LIMIT \$2\s*$/);
  // The counts read is one row and takes only the viewer.
  assert.match(profile.MY_REQUEST_COUNTS_SQL, /SELECT COUNT\(\*\)::int AS total,\s*COUNT\(\*\) FILTER \(WHERE s\.shipped OR s\.closed\)::int AS done\s*FROM standing s\s*$/);
  assert.doesNotMatch(profile.MY_REQUEST_COUNTS_SQL, /\$2/);
});

test('the counts read is shaped as Profile\'s row reads it', () => {
  const profile = require('../src/routes/profile');
  assert.deepEqual(profile.shapeRequestCounts({ total: 806, done: 750 }), { open: 56, done: 750 });
  assert.deepEqual(profile.shapeRequestCounts({ total: '3', done: '1' }), { open: 2, done: 1 }, 'bigint strings too');
  assert.deepEqual(profile.shapeRequestCounts(undefined), { open: 0, done: 0 });
  // Staging's demo counts are the demo rows', and only for an empty set.
  assert.deepEqual(profile.withDemoRequestCounts({ open: 0, done: 0 }, { slug: 'usernode-2d5619' }), { open: 2, done: 1 });
  const real = { open: 1, done: 0 };
  assert.equal(profile.withDemoRequestCounts(real, { slug: 'x' }), real, 'real counts win');
  assert.deepEqual(profile.withDemoRequestCounts({ open: 0, done: 0 }, null), { open: 0, done: 0 });
});

function makeApp({ user = { id: 7 }, counts = { total: 806, done: 750 } } = {}) {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      const profile = require('../src/routes/profile');
      if (sql === profile.MY_REQUEST_COUNTS_SQL) return { rows: [counts] };
      if (sql === profile.MY_REQUESTS_SQL) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 90)}`);
    },
  };
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  let routes;
  try {
    delete require.cache[require.resolve('../src/routes/profile')];
    routes = require('../src/routes/profile').profileRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
  }
  const app = express();
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(routes);
  return { app, calls };
}

async function get(app, url) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

test('GET /api/me/requests?counts=1 answers the two counts alone', async () => {
  const profile = require('../src/routes/profile');
  const { app, calls } = makeApp();
  const res = await get(app, '/api/me/requests?counts=1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { open: 56, done: 750 });
  assert.equal(res.cache, 'no-store');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, profile.MY_REQUEST_COUNTS_SQL);
  assert.deepEqual(calls[0].params, [7], 'me-scoped');

  // Without it, the list as before.
  const list = makeApp();
  const all = await get(list.app, '/api/me/requests');
  assert.deepEqual(all.body, { requests: [], open: 0, done: 0 });
  assert.equal(list.calls[0].sql, profile.MY_REQUESTS_SQL);

  const anonymous = makeApp({ user: null });
  assert.equal((await get(anonymous.app, '/api/me/requests?counts=1')).status, 401);
  assert.equal(anonymous.calls.length, 0);
});

// ── The page ───────────────────────────────────────────────────────────

function loadProfileModule() {
  return loadTsx('frontend/src/features/profile/profile.js', {
    stubs: {
      '../friends/api': {
        act: async () => null,
        announceFriendsChanged: () => {},
        errorMessage: () => '',
        FRIENDS_CHANGED_EVENT: 'friends-changed',
        listFriends: async () => null,
      },
    },
  }).Profile;
}

const RANKING = { scope: 'season', season_id: 3, season_name: 'Season 3', rank: 3 };
const USER = { id: 7, username: 'webuser' };

// A Profile whose reads answer at once, except the requests' counts, which
// answer when the test says (`answer(body)`, or `answer(null)` for a 500).
function withProfile(run) {
  return async () => {
    const saved = { window: globalThis.window, App: globalThis.App, fetch: globalThis.fetch };
    const asked = [];
    const pending = [];
    globalThis.App = { user: USER };
    globalThis.window = { App: globalThis.App, addEventListener() {}, removeEventListener() {} };
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      if (String(url).startsWith('/api/me/requests')) {
        return new Promise((resolve) => pending.push((body) => resolve(body
          ? { ok: true, status: 200, json: async () => body }
          : { ok: false, status: 500, json: async () => ({}) })));
      }
      if (String(url).startsWith('/challenges-api/me/ranking')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: RANKING }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const Profile = loadProfileModule();
      const renders = [];
      Profile._render = () => renders.push(Profile._data);
      Profile._targetUsername = null;
      Profile._open = true;
      const answer = async (body) => {
        pending.shift()(body);
        // The fetch, its json(), the catch and _fillRequests' await: every
        // microtask runs before the next macrotask.
        await new Promise((resolve) => setImmediate(resolve));
      };
      await run({ Profile, asked, answer, renders });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
      }
    }
  };
}

test('the page draws before the requests\' counts answer, and they fill in when they land', withProfile(async ({ Profile, asked, answer, renders }) => {
  const { moreRowsView } = loadTsx(STORE);
  Profile._ownCache = null;
  Profile._data = null;
  await Profile._load();
  assert.ok(asked.includes('/api/me/requests?counts=1'), 'the counts alone');
  assert.equal(Profile._loading, false, 'the load is over with the counts still out');
  assert.equal(Profile._data.ranking.rank, 3, 'and the rest of the page is drawn');
  let rows = moreRowsView(Profile._data);
  assert.equal(rows.requests, null);
  assert.equal(rows.requestsPending, true, 'the row holds its place');
  assert.equal(Profile._ownCache.data, Profile._data);

  const drawn = renders.length;
  await answer({ open: 56, done: 750 });
  rows = moreRowsView(Profile._data);
  assert.equal(rows.requests, '56 open · 750 done');
  assert.equal(rows.requestsPending, false);
  assert.equal(renders.length, drawn + 1, 'drawn once more');
  assert.equal(Profile._ownCache.data, Profile._data, 'and filed for the next visit, as one object');
}));

test('a return visit shows last visit\'s counts while this visit\'s are out', withProfile(async ({ Profile, answer }) => {
  const { moreRowsView } = loadTsx(STORE);
  Profile._ownCache = { username: 'webuser', data: { summary: {}, requests: { open: 55, done: 750 } } };
  Profile._data = Profile._cachedOwnData();
  await Profile._load();
  let rows = moreRowsView(Profile._data);
  assert.equal(rows.requests, '55 open · 750 done', 'no placeholder between two sets of numbers');
  await answer({ open: 56, done: 750 });
  rows = moreRowsView(Profile._data);
  assert.equal(rows.requests, '56 open · 750 done');
}));

test('a counts read that fails keeps last visit\'s counts, or lets the row say what is behind it', withProfile(async ({ Profile, answer }) => {
  const { moreRowsView } = loadTsx(STORE);
  Profile._ownCache = { username: 'webuser', data: { requests: { open: 1, done: 2 } } };
  Profile._data = Profile._cachedOwnData();
  await Profile._load();
  await answer(null);
  assert.equal(moreRowsView(Profile._data).requests, '1 open · 2 done');
  assert.equal(moreRowsView(Profile._data).requestsPending, false);

  Profile._ownCache = null;
  Profile._data = null;
  await Profile._load();
  await answer(null);
  const rows = moreRowsView(Profile._data);
  assert.equal(rows.requests, null);
  assert.equal(rows.requestsPending, false, 'no placeholder left standing');
}));

test('an older load\'s counts never fill a newer load\'s page', withProfile(async ({ Profile, answer }) => {
  const { moreRowsView } = loadTsx(STORE);
  Profile._ownCache = null;
  Profile._data = null;
  await Profile._load();
  await Profile._load();
  // The first load's counts land after the second load drew.
  await answer({ open: 9, done: 9 });
  assert.equal(moreRowsView(Profile._data).requestsPending, true, 'still waiting on its own read');
  assert.equal(Profile._ownCache.data.requestsPending, Profile._loadToken);
  await answer({ open: 56, done: 750 });
  assert.equal(moreRowsView(Profile._data).requests, '56 open · 750 done');
}));

test('a public profile opened meanwhile is left alone, while the own copy still fills', withProfile(async ({ Profile, answer }) => {
  Profile._ownCache = null;
  Profile._data = null;
  await Profile._load();
  const visiting = { publicProfile: { username: 'someone' } };
  Profile._targetUsername = 'someone';
  Profile._data = visiting;
  await answer({ open: 56, done: 750 });
  assert.equal(Profile._data, visiting);
  assert.deepEqual(Profile._ownCache.data.requests, { open: 56, done: 750 });
}));

test('the row holds its line\'s place at the subtitle\'s height, with words for a screen reader', () => {
  const mod = loadTsx('frontend/src/features/profile/account-panel.tsx');
  const pending = renderToHtml(createElement(mod.WorkPanel, { rows: { challenges: null, kudos: null, requestsPending: true } }));
  const row = pending.slice(pending.indexOf('id="profile-row-feedback"'), pending.indexOf('id="profile-row-votes"'));
  assert.match(row, /<div class="flex h-\[1\.125rem\] items-center"><span class="sr-only">Counting your requests<\/span><div class="[^"]*animate-pulse[^"]*" aria-hidden="true"><\/div><\/div>/);
  assert.doesNotMatch(row, /What you asked for/, 'the fallback is not said while the counts are coming');
  // The bar stands in for ListRow's one subtitle line (13px on 1.125rem).
  assert.match(read('frontend/@/components/ui/grouped-list.tsx'), /'mt-0\.5 truncate text-\[0\.8125rem\] leading-\[1\.125rem\]/);
  assert.equal(message('profile:work.requests.counting'), 'Counting your requests');

  const landed = renderToHtml(createElement(mod.WorkPanel, { rows: { challenges: null, kudos: null, requests: '56 open · 750 done', requestsPending: true } }));
  assert.match(landed, /56 open · 750 done/, 'counts on hand are said, pending or not');
  assert.doesNotMatch(landed, /Counting your requests/);
  const failed = renderToHtml(createElement(mod.WorkPanel, { rows: { challenges: null, kudos: null } }));
  assert.match(failed, /What you asked for, and where it stands/);
});

test('the counts read is not in the load\'s Promise.all', () => {
  const src = read('frontend/src/features/profile/profile.js');
  const all = src.slice(src.indexOf('await Promise.all(['), src.indexOf(']);', src.indexOf('await Promise.all([')));
  assert.doesNotMatch(all, /\/api\/me\/requests/);
  assert.match(src, /const requestsRead = Profile\._fetchJson\(`\/api\/me\/requests\?counts=1\$\{demo \? '&demo=1' : ''\}`\)\s*\.catch\(\(\) => null\);/);
});
