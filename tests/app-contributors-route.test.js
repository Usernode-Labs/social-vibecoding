// #919: GET /api/apps/:slug/contributors — the ranked list behind the app
// details page's Contributors section (public/js/browse.js).
//
// What matters here is the GATING and the SHAPE, not the SQL (the ranking
// and the counts live in Postgres — see src/services/contributors.js):
//   - view-level access, 404 (never 403) on deny so nothing is enumerable;
//   - the self-hosted branch mirrored from GET /api/apps/:slug;
//   - `limit` parsed/clamped, garbage falling back to the default;
//   - no wallet/pubkey field (that's the PUBLIC api's opt-in, not this one);
//   - the ?demo=1 staging injection firing ONLY in staging;
//   - and the one invariant that keeps the two contributor surfaces from
//     drifting: routes/public-api.js re-exports the SAME function object.
//
// Same harness shape as tests/apps-last-failure-route.test.js (stub the
// heavy service requires, swap getPool before requiring the route module,
// mount on a throwaway express app and hit it over HTTP) with the
// SQL-dispatching mock pool style of tests/public-api.test.js.
//
// Run with: node --test tests/app-contributors-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  appCreator: require.resolve('../src/services/app-creator'),
  appForker: require.resolve('../src/services/app-forker'),
  caddy: require.resolve('../src/services/caddy'),
  docker: require.resolve('../src/services/docker'),
  github: require.resolve('../src/services/github'),
  driftPoller: require.resolve('../src/services/main-drift-poller'),
  appSecrets: require.resolve('../src/services/app-secrets'),
  appManifest: require.resolve('../src/services/app-manifest'),
  renamePr: require.resolve('../src/services/rename-pr'),
  staging: require.resolve('../src/services/staging'),
};

stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub(ids.appCreator, { createApp: async () => {} });
stub(ids.appForker, { forkApp: async () => {} });
stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
stub(ids.docker, { getHostPort: async () => null });
stub(ids.github, { parseGithubUrl: () => null, isEnabled: () => false });
stub(ids.driftPoller, { checkAndRedeployOne: async () => ({}) });
stub(ids.appSecrets, {});
stub(ids.appManifest, { MAX_APP_NAME_LENGTH: 64 });
stub(ids.renamePr, {});
stub(ids.staging, { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });

// The ranked rows the LATERAL query would return, newest-shipper first.
// `total` rides every row (COUNT(*) OVER ()) exactly as the real query
// emits it, so the handler's total-extraction is exercised for real.
const RANKED = [
  { user_id: 10, username: 'alice', merged_count: 12, votes_count: 30, is_creator: true, is_member: true, last_merged_at: '2026-07-01T00:00:00.000Z', total: 3 },
  { user_id: 11, username: 'bob', merged_count: 4, votes_count: 22, is_creator: false, is_member: true, last_merged_at: '2026-06-01T00:00:00.000Z', total: 3 },
  { user_id: 12, username: 'carol', merged_count: 0, votes_count: 7, is_creator: false, is_member: false, last_merged_at: null, total: 3 },
];

const poolMod = require('../src/db/pool');
let appRow = null;
let collaboratorIds = new Set();
let rankedRows = RANKED;
// Every (sql, params) pair the handler issued, so the limit clamp and the
// app-id scoping can be asserted rather than inferred.
let queries = [];
poolMod.getPool = () => ({
  query: async (sql, params) => {
    const s = String(sql);
    queries.push({ sql: s, params });
    if (/FROM apps WHERE slug = \$1/.test(s)) {
      return appRow ? { rows: [appRow] } : { rows: [] };
    }
    // The ranked read — matched on its distinguishing projection so the
    // access-check's own app_collaborators probe below can't shadow it.
    if (/contributor_ids/.test(s) && /merged_count/.test(s)) {
      return { rows: rankedRows };
    }
    // appAccess.isCollaborator's membership probe.
    if (/FROM app_collaborators/.test(s)) {
      return collaboratorIds.has(params?.[1]) ? { rows: [{ 1: 1 }] } : { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  },
});

const { appRoutes } = require('../src/routes/apps');
const contributors = require('../src/services/contributors');
const express = require('express');

let currentUser = null;

function startServer(config) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes(config || { selfAppPublicVoting: true }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function makeAppRow(over) {
  return {
    id: 7,
    name: 'Block Game',
    slug: 'block-game',
    status: 'running',
    created_by: 10,
    self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    ...over,
  };
}

async function get(server, qs) {
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}/api/apps/block-game/contributors${qs || ''}`
  );
  return { status: res.status, body: await res.json() };
}

function reset() {
  appRow = makeAppRow();
  collaboratorIds = new Set();
  rankedRows = RANKED;
  queries = [];
  currentUser = { id: 99, isAdmin: false };
  delete process.env.USERNODE_ENV;
}

// The ranked query's LIMIT param — $2 in services/contributors.js.
function rankedLimit() {
  const q = queries.find((x) => /contributor_ids/.test(x.sql) && /merged_count/.test(x.sql));
  return q ? q.params[1] : null;
}

// ── Happy path + shape ────────────────────────────────────────────────

test('200 with ranked contributors and the full-set total', async () => {
  reset();
  const server = await startServer();
  try {
    const { status, body } = await get(server);
    assert.equal(status, 200);
    assert.equal(body.slug, 'block-game');
    assert.equal(body.total, 3, 'total comes from COUNT(*) OVER ()');
    assert.deepEqual(body.contributors.map((c) => c.username), ['alice', 'bob', 'carol'],
      'server order is preserved verbatim — the client never re-sorts');
    assert.deepEqual(body.contributors[0], {
      user_id: 10, username: 'alice', merged_count: 12, votes_count: 30,
      is_creator: true, is_member: true,
    });
  } finally { server.close(); }
});

test('the payload carries no wallet address / pubkey', async () => {
  reset();
  rankedRows = RANKED.map((r) => ({ ...r, usernode_pubkey: 'ut1secret', wallet_address: 'ut1secret' }));
  const server = await startServer();
  try {
    const { body } = await get(server);
    const raw = JSON.stringify(body);
    assert.ok(!/ut1secret/.test(raw), 'no wallet leaks into the UI payload');
    for (const c of body.contributors) {
      assert.deepEqual(Object.keys(c).sort(),
        ['is_creator', 'is_member', 'merged_count', 'user_id', 'username', 'votes_count']);
    }
  } finally { server.close(); }
});

test('an empty contributor set is 200 with total 0, not a 404', async () => {
  reset();
  rankedRows = [];
  const server = await startServer();
  try {
    const { status, body } = await get(server);
    assert.equal(status, 200);
    assert.equal(body.total, 0);
    assert.deepEqual(body.contributors, []);
  } finally { server.close(); }
});

// ── Gating ────────────────────────────────────────────────────────────

test('404 for a view-private app when the viewer is not a collaborator', async () => {
  reset();
  appRow = makeAppRow({ view_visibility: 'private' });
  const server = await startServer();
  try {
    const { status } = await get(server);
    assert.equal(status, 404, 'non-disclosure: 404, never 403');
  } finally { server.close(); }
});

test('a collaborator on a view-private app gets the list', async () => {
  reset();
  appRow = makeAppRow({ view_visibility: 'private' });
  collaboratorIds = new Set([99]);
  const server = await startServer();
  try {
    const { status, body } = await get(server);
    assert.equal(status, 200);
    assert.equal(body.total, 3);
  } finally { server.close(); }
});

test('404 for an unknown slug', async () => {
  reset();
  appRow = null;
  const server = await startServer();
  try {
    const { status } = await get(server);
    assert.equal(status, 404);
  } finally { server.close(); }
});

test('a read-only viewer of a collab-private app still gets the list (view level)', async () => {
  reset();
  // collab_visibility private + view public: the /collaborators route would
  // 404 this viewer, this one must not — it is view-gated by design.
  appRow = makeAppRow({ collab_visibility: 'private', view_visibility: 'public' });
  const server = await startServer();
  try {
    const { status } = await get(server);
    assert.equal(status, 200);
  } finally { server.close(); }
});

test('404 for a self-hosted app when SELF_APP_PUBLIC_VOTING is off and the viewer is not an admin', async () => {
  reset();
  appRow = makeAppRow({ self_hosted: true });
  const server = await startServer({ selfAppPublicVoting: false });
  try {
    const { status } = await get(server);
    assert.equal(status, 404, 'mirrors the GET /api/apps/:slug self-hosted branch');
  } finally { server.close(); }
});

test('an admin reads a self-hosted app even with SELF_APP_PUBLIC_VOTING off', async () => {
  reset();
  appRow = makeAppRow({ self_hosted: true });
  currentUser = { id: 1, isAdmin: true };
  const server = await startServer({ selfAppPublicVoting: false });
  try {
    const { status } = await get(server);
    assert.equal(status, 200);
  } finally { server.close(); }
});

test('the self-app is readable by anyone when SELF_APP_PUBLIC_VOTING is on (the default)', async () => {
  reset();
  appRow = makeAppRow({ self_hosted: true });
  const server = await startServer({ selfAppPublicVoting: true });
  try {
    const { status } = await get(server);
    assert.equal(status, 200);
  } finally { server.close(); }
});

// ── limit ─────────────────────────────────────────────────────────────

test('limit defaults to 50, honours a valid value, and clamps at 100', async () => {
  const server = await startServer();
  try {
    reset();
    await get(server);
    assert.equal(rankedLimit(), 50, 'unset -> default');

    reset();
    await get(server, '?limit=5');
    assert.equal(rankedLimit(), 5);

    reset();
    await get(server, '?limit=9999');
    assert.equal(rankedLimit(), 100, 'clamped to the cap');

    reset();
    await get(server, '?limit=0');
    assert.equal(rankedLimit(), 1, 'clamped to at least one row');
  } finally { server.close(); }
});

test('a garbage limit falls back to the default instead of erroring', async () => {
  reset();
  const server = await startServer();
  try {
    const { status } = await get(server, '?limit=not-a-number');
    assert.equal(status, 200);
    assert.equal(rankedLimit(), 50);
  } finally { server.close(); }
});

test('clampRankedLimit is pure and total about its bounds', () => {
  const { clampRankedLimit, DEFAULT_RANKED_LIMIT, MAX_RANKED_LIMIT } = contributors;
  assert.equal(clampRankedLimit(undefined), DEFAULT_RANKED_LIMIT);
  assert.equal(clampRankedLimit(''), DEFAULT_RANKED_LIMIT);
  assert.equal(clampRankedLimit('abc'), DEFAULT_RANKED_LIMIT);
  assert.equal(clampRankedLimit('-4'), 1);
  assert.equal(clampRankedLimit('1'), 1);
  assert.equal(clampRankedLimit(String(MAX_RANKED_LIMIT + 1)), MAX_RANKED_LIMIT);
  assert.equal(clampRankedLimit('23'), 23);
});

// ── Staging mock data ─────────────────────────────────────────────────

test('?demo=1 injects the mock rows ONLY in staging', async () => {
  const server = await startServer();
  try {
    // Production (env unset): ?demo=1 is a strict no-op.
    reset();
    let r = await get(server, '?demo=1');
    assert.deepEqual(r.body.contributors.map((c) => c.username), ['alice', 'bob', 'carol'],
      'request-time demo injection must never fire outside staging');

    // Staging, no ?demo=1: also a no-op.
    reset();
    process.env.USERNODE_ENV = 'staging';
    r = await get(server);
    assert.deepEqual(r.body.contributors.map((c) => c.username), ['alice', 'bob', 'carol']);

    // Staging + ?demo=1: the mock set REPLACES the real rows, so the
    // screenshot capture is deterministic whichever cloned app it hits.
    reset();
    process.env.USERNODE_ENV = 'staging';
    r = await get(server, '?demo=1');
    assert.equal(r.body.total, 7);
    assert.equal(r.body.contributors.length, 7);
    assert.ok(r.body.contributors.every((c) => /^staging-demo-/.test(c.username)),
      'obviously fake, per the Staging mock data convention');
    assert.equal(r.body.contributors[0].username, 'staging-demo-lead');
  } finally {
    delete process.env.USERNODE_ENV;
    server.close();
  }
});

test('the demo set overflows the 5-row fold and covers the zero-merge rows', () => {
  const rows = contributors.DEMO_CONTRIBUTORS;
  assert.ok(rows.length > 5, 'more than the fold, so the Show-all toggle renders');
  assert.ok(rows.some((c) => c.is_creator), 'a creator row');
  assert.ok(rows.some((c) => c.merged_count === 0 && c.votes_count > 0),
    'a votes-only contributor (muted 0-merged pill)');
  assert.ok(rows.some((c) => c.merged_count === 0 && c.votes_count === 0 && c.is_member),
    'a bare member row with no vote fragment');
  // Pre-ranked exactly as the SQL would order it, so the demo list is a
  // faithful stand-in for a real one.
  const merged = rows.map((c) => c.merged_count);
  assert.deepEqual(merged, [...merged].sort((a, b) => b - a));
  assert.ok(rows.every((c) => c.user_id >= 990201 && c.user_id <= 990299),
    'reserved demo id range');
});

test('demoRankedContributors hands back a fresh copy each call', () => {
  process.env.USERNODE_ENV = 'staging';
  try {
    const a = contributors.demoRankedContributors({ query: { demo: '1' } });
    a.items[0].username = 'mutated';
    const b = contributors.demoRankedContributors({ query: { demo: '1' } });
    assert.equal(b.items[0].username, 'staging-demo-lead', 'no shared mutable state');
    assert.equal(contributors.demoRankedContributors({ query: {} }), null);
  } finally { delete process.env.USERNODE_ENV; }
});

// ── The anti-drift invariant ──────────────────────────────────────────

test('the public API and this route share ONE contributor definition', () => {
  const publicApi = require('../src/routes/public-api');
  assert.equal(publicApi.loadContributors, contributors.loadContributors,
    'routes/public-api.js must re-export the service function, not a copy — '
    + 'two implementations would let "who counts as a contributor" drift');
  assert.equal(publicApi.shapeContributor, contributors.shapeContributor);
  // Both loaders build their row set from the same shared CTE text.
  assert.ok(contributors.CONTRIBUTOR_IDS_CTE.includes('created_by AS user_id'));
  assert.ok(contributors.CONTRIBUTOR_IDS_CTE.includes("status = 'member'"));
  assert.ok(contributors.CONTRIBUTOR_IDS_CTE.includes("status = 'merged'"));
});

test('the ranked query scopes every aggregate to the one app id', async () => {
  reset();
  const server = await startServer();
  try {
    await get(server);
    const q = queries.find((x) => /contributor_ids/.test(x.sql) && /merged_count/.test(x.sql));
    assert.ok(q, 'the ranked read ran');
    assert.deepEqual(q.params[0], [7], 'the resolved app id, not the slug');
    // Both aggregates are LATERALs, not extra joins folded into a GROUP BY —
    // that would cross-multiply the merge and vote fan-outs.
    assert.equal((q.sql.match(/LEFT JOIN LATERAL/g) || []).length, 2);
    assert.ok(!/GROUP BY/.test(q.sql));
    assert.ok(/ORDER BY merged_count DESC/.test(q.sql));
  } finally { server.close(); }
});
