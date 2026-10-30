'use strict';

// Versions, as the payloads and routes say them (docs/plans/versions.md,
// "API shapes"):
//
//   src/services/version-links.js   upstream_link / versions on the app,
//                                   made_from / versions on the community,
//                                   and the original's hub
//   src/routes/versions.js          GET /versions, POST /follow-pr
//   src/services/follow-pr.js       the proposal that sets followOriginal
//   src/services/app-manifest.js    followOriginal, reconciled on deploy
//
// Run with: node --test tests/versions-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const versionLinks = require('../src/services/version-links');
const followPr = require('../src/services/follow-pr');
const appManifest = require('../src/services/app-manifest');

const ORIGINAL_ROW = {
  original_id: 3, original_slug: 'tier-list', original_name: 'Tier list', original_created_by: 1,
  original_self_hosted: false, original_collab_visibility: 'public', original_view_visibility: 'public',
  original_moderation_suspended_at: null,
};

function linksPool(row) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/FROM apps a\s+LEFT JOIN apps o/.test(sql)) return { rows: row ? [row] : [] };
      // checkAppAccess: no block, not a collaborator.
      return { rows: [] };
    },
  };
}

// ── The app and community payloads ────────────────────────────────────

test('a version says what it was made from and whether it gets its updates', async () => {
  const pool = linksPool({ upstream: { appId: 3, slug: 'tier-list', following: true }, versions: 0, following: 0, ...ORIGINAL_ROW });
  assert.deepEqual(await versionLinks.appFields(pool, { id: 12 }, { id: 5 }), {
    upstream_link: { slug: 'tier-list', name: 'Tier list', following: true, linkable: true },
    versions: null,
  });
  assert.deepEqual(await versionLinks.communityFields(pool, { id: 12 }), {
    made_from: { slug: 'tier-list', name: 'Tier list', following: true },
    versions: null,
  });
  const read1 = pool.queries[0];
  assert.match(read1.sql, /o\.id = \(a\.upstream->>'appId'\)::int/);
  assert.match(read1.sql, /WHERE v\.upstream IS NOT NULL AND \(v\.upstream->>'appId'\)::int = a\.id/,
    'counted by the expression index the schema keeps');
  assert.deepEqual(read1.params, [12]);
});

test('an original says how many versions it has, and how many get its updates', async () => {
  const pool = linksPool({ upstream: null, versions: 5, following: 3 });
  assert.deepEqual(await versionLinks.appFields(pool, { id: 3 }, null), { upstream_link: null, versions: { count: 5, following: 3 } });
  assert.deepEqual(await versionLinks.communityFields(pool, { id: 3 }), { made_from: null, versions: { count: 5, following: 3 } });
});

test('an original the viewer cannot open is named but not linkable; a deleted one is neither', async () => {
  const privateOriginal = { ...ORIGINAL_ROW, original_view_visibility: 'private' };
  let pool = linksPool({ upstream: { appId: 3, slug: 'tier-list', following: false }, versions: 0, following: 0, ...privateOriginal });
  assert.deepEqual((await versionLinks.appFields(pool, { id: 12 }, { id: 5 })).upstream_link,
    { slug: 'tier-list', name: 'Tier list', following: false, linkable: false });
  pool = linksPool({ upstream: { appId: 3, slug: 'tier-list', following: false }, versions: 0, following: 0, original_id: null });
  assert.deepEqual((await versionLinks.appFields(pool, { id: 12 }, { id: 5 })).upstream_link,
    { slug: 'tier-list', name: null, following: false, linkable: false });
  assert.equal((await versionLinks.communityFields(pool, { id: 12 })).made_from, null);
  // Demo mode keeps the lineage quiet, as forked_from does.
  pool = linksPool({ upstream: { appId: 3, following: true }, versions: 0, following: 0, ...ORIGINAL_ROW });
  assert.equal((await versionLinks.appFields(pool, { id: 12, demo_mode: true }, { id: 5 })).upstream_link, null);
});

test('GET /api/apps/:slug and the community read carry the fields, best-effort', () => {
  const apps = read('src/routes/apps.js');
  assert.match(apps, /await attachForkLineage\(pool, appPayload\);\s+\/\/ Versions[\s\S]{0,400}Object\.assign\(appPayload, await versionLinks\.appFields\(pool, appRow, req\.user\)\.catch\(/);
  assert.match(apps, /return \{ upstream_link: null, versions: null \};/);
  assert.match(apps, /const versionFields = await versionLinks\.communityFields\(pool, app\)\.catch\(/);
  assert.match(apps, /made_from: versionFields\.made_from,\s+versions: versionFields\.versions,/);
});

// ── The hub ───────────────────────────────────────────────────────────

function hubPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/SELECT COUNT\(\*\)::int AS count,/.test(text)) return { rows: [{ count: 4, following: 2 }] };
      if (/FROM chat_sessions cs\s+LEFT JOIN apps v ON v\.id = cs\.suggested_from_app_id/.test(text)) {
        return {
          rows: [
            { id: 70, pr_number: 9, pr_title: 'Suggested by Cities: Sort', from_slug: 'cities', from_name: 'Cities', from_view: 'public' },
            { id: 71, pr_number: null, pr_title: 'Suggested by Mine: Dark', from_slug: 'mine', from_name: 'Mine', from_view: 'private' },
          ],
        };
      }
      if (/COUNT\(DISTINCT v\.id\)::int AS versions/.test(text)) return { rows: [{ versions: 2, changes: 3 }] };
      if (/SELECT cs\.pr_title, cs\.merged_at, v\.slug, v\.name/.test(text)) {
        return { rows: [{ pr_title: 'Add a timer', merged_at: new Date('2026-10-20T10:00:00Z'), slug: 'cities', name: 'Cities' }] };
      }
      if (/FROM upstream_offers/.test(text)) return { rows: [{ from_sha: 'a'.repeat(40), offered: 4, took: 1, skipped: 1, deciding: 2 }] };
      return { rows: [] };
    },
  };
}

test('the hub: counts, suggestions (a private version unnamed), lately, and the last update', async () => {
  const pool = hubPool();
  const out = await versionLinks.hub(pool, { id: 3, slug: 'tier-list', main_sha: 'a'.repeat(40) });
  assert.deepEqual(out, {
    count: 4,
    following: 2,
    suggestions: [
      { sessionId: 70, href: '#app/tier-list/dev/changes/9', title: 'Suggested by Cities: Sort', from: { slug: 'cities', name: 'Cities' } },
      { sessionId: 71, href: '#app/tier-list/dev/proposals/71', title: 'Suggested by Mine: Dark', from: null },
    ],
    lately: { versions: 2, changes: 3, rows: [{ title: 'Add a timer', from: { slug: 'cities', name: 'Cities' }, at: '2026-10-20T10:00:00.000Z' }] },
    lastUpdate: { offered: 4, took: 1, skipped: 1, deciding: 2 },
  });
  const lately = pool.queries.find((q) => /SELECT cs\.pr_title, cs\.merged_at/.test(q.sql));
  assert.match(lately.sql, /v\.view_visibility = 'public' OR v\.upstream->>'share' = 'true'/, 'public versions, or those that share');
  assert.match(lately.sql, /cs\.upstream_from_app_id IS NULL/, 'not the updates they took from here');
  assert.deepEqual(lately.params, [3, 30, 10]);
  const offers = pool.queries.find((q) => /FROM upstream_offers/.test(q.sql));
  assert.match(offers.sql, /FILTER \(WHERE state IN \('open', 'available', 'needs_fit'\)\)/);
  assert.deepEqual(offers.params, [3, 'a'.repeat(40)]);
});

test('the hub of an original that never offered an update has no last update', async () => {
  const pool = { async query(sql) { return /COUNT\(\*\)::int AS count,/.test(sql) ? { rows: [{ count: 0, following: 0 }] } : { rows: [] }; } };
  const out = await versionLinks.hub(pool, { id: 3, slug: 'x' });
  assert.equal(out.lastUpdate, null);
  assert.deepEqual(out.lately, { versions: 0, changes: 0, rows: [] });
});

// ── following, as a line of dapp.json ─────────────────────────────────

test('followOriginal reads as a boolean, or nothing', () => {
  assert.equal(appManifest.readFollowOriginal({ followOriginal: true }), true);
  assert.equal(appManifest.readFollowOriginal({ followOriginal: false }), false);
  assert.equal(appManifest.readFollowOriginal({}), null);
  assert.equal(appManifest.readFollowOriginal({ followOriginal: 'yes' }), null);
});

test('the deploy reconciles followOriginal into the version\'s link, and never makes one', async () => {
  const calls = [];
  const pool = { async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [{ id: 12 }] }; } };
  assert.equal(await appManifest.reconcileAppFollow(pool, { id: 12, slug: 'v' }, { followOriginal: false }), true);
  assert.match(calls[0].sql, /UPDATE apps SET upstream = upstream \|\| jsonb_build_object\('following', \$2::boolean\)/);
  assert.match(calls[0].sql, /WHERE id = \$1 AND upstream IS NOT NULL/, 'a project that is not a version is left alone');
  assert.match(calls[0].sql, /upstream->'following' IS DISTINCT FROM to_jsonb\(\$2::boolean\)/);
  assert.deepEqual(calls[0].params, [12, false]);
  assert.equal(await appManifest.reconcileAppFollow(pool, { id: 12 }, { followOriginal: null }), false);
  assert.equal(calls.length, 1, 'an absent line is a no-op');
  const staging = read('src/services/staging.js');
  assert.match(staging, /await appManifest\.reconcileAppFollow\(prodPool, app, manifest\)\s+\.catch\(/);
});

test('the proposal sets followOriginal, titled in the words people read', async () => {
  assert.equal(followPr.followPrTitle(true, 'Tier list'), 'Get Tier list\'s updates');
  assert.equal(followPr.followPrTitle(false, 'Tier list'), 'Stop getting Tier list\'s updates');
  const renamePr = require('../src/services/rename-pr');
  const saved = renamePr.createManifestPR;
  let opts = null;
  renamePr.createManifestPR = async (_c, _p, _a, _actor, o) => { opts = o; return { sessionId: 1, prNumber: 2 }; };
  try {
    await followPr.createFollowPR({}, {}, { name: 'Cities' }, { follow: true, originalName: 'Tier list' }, { id: 5, username: 'sam' });
  } finally {
    renamePr.createManifestPR = saved;
  }
  const manifest = { name: 'Cities', followOriginal: false };
  opts.mutate(manifest);
  assert.deepEqual(manifest, { name: 'Cities', followOriginal: true });
  assert.equal(opts.branchPrefix, 'follow');
  assert.equal(opts.prTitle, 'Get Tier list\'s updates');
  assert.ok(!opts.explicitApproval, 'no protected block: the ordinary vote decides it');
  for (const text of [opts.prBody, opts.chatText({ number: 2 }, 1, 1)]) {
    assert.doesNotMatch(text, /remix|upstream|fork|template|—/i);
  }
  const op = require('../src/services/manifest-proposal-operation');
  const flavor = op.FLAVORS.get('follow');
  assert.equal(flavor.access, 'collab');
  assert.equal(flavor.member, true);
  assert.equal(flavor.selfHosted, false);
});

// ── The routes ────────────────────────────────────────────────────────

function routeApp({ app, open = null, collab = true, operation }) {
  const ids = {
    platformOps: require.resolve('../src/services/platform-operations'),
    github: require.resolve('../src/services/github'),
    route: require.resolve('../src/routes/versions'),
  };
  const github = require(ids.github);
  const savedEnabled = github.isEnabled, savedWrite = github.hasWriteAccess;
  github.isEnabled = () => true;
  github.hasWriteAccess = () => false; // Web can admit a conductor operation.
  const platformOps = require(ids.platformOps);
  const savedRequest = platformOps.request;
  const asked = [];
  platformOps.request = async (p) => { asked.push(p); return operation ? operation(p) : { ok: true, sessionId: 81, prNumber: 14 }; };
  delete require.cache[ids.route];
  const { versionsRoutes } = require(ids.route);
  const pool = {
    async query(sql, params) {
      const text = String(sql);
      if (/SELECT \* FROM apps WHERE slug = \$1/.test(text)) return { rows: app && params[0] === app.slug ? [app] : [] };
      if (/FROM app_collaborators WHERE app_id = \$1 AND user_id = \$2/.test(text)) return { rows: collab ? [{ ok: 1 }] : [] };
      if (/branch_name LIKE 'follow\/%'/.test(text)) return { rows: open ? [open] : [] };
      if (/SELECT name FROM apps WHERE id = \$1/.test(text)) return { rows: [{ name: 'Tier list' }] };
      // The membership gate's read: a member.
      if (/FROM apps a WHERE a\.slug = \$1/.test(text)) return { rows: [{ ...app, is_member: true }] };
      if (/FROM community_members/.test(text)) return { rows: [{ ok: 1 }] };
      return { rows: [] };
    },
  };
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.user = { id: 5, username: 'sam' }; next(); });
  server.use(versionsRoutes({}, { pool }));
  const restore = () => { github.isEnabled = savedEnabled; github.hasWriteAccess = savedWrite; platformOps.request = savedRequest; };
  return { server, asked, restore };
}

async function listen(server) {
  return new Promise((resolve) => { const s = server.listen(0, () => resolve(s)); });
}

const VERSION = {
  id: 12, slug: 'cities', name: 'Cities', created_by: 5, self_hosted: false,
  collab_visibility: 'private', view_visibility: 'private', community_id: null,
  repo_url: 'https://github.com/usernode-bot/cities',
  upstream: { appId: 3, slug: 'tier-list', following: false },
};

test('POST follow-pr opens the proposal on a conductor and answers where it is', async () => {
  const { server, asked, restore } = routeApp({ app: VERSION });
  const s = await listen(server);
  const base = `http://127.0.0.1:${s.address().port}/api/apps`;
  const post = (slug, body) => fetch(`${base}/${slug}/follow-pr`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    let res = await post('cities', { follow: 'yes' });
    assert.equal(res.status, 400);
    res = await post('nope', { follow: true });
    assert.equal(res.status, 404);
    res = await post('cities', { follow: false });
    assert.equal(res.status, 400, 'that is how it is already');
    res = await post('cities', { follow: true });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true, sessionId: 81, prNumber: 14, href: '#app/cities/dev/changes/14' });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].op, 'manifest.propose');
    assert.deepEqual(asked[0].input, { flavor: 'follow', args: { follow: true, originalName: 'Tier list' }, repoUrl: VERSION.repo_url });
  } finally {
    s.close();
    restore();
  }
});

test('POST follow-pr: one in flight, named; not on a project that is not a version', async () => {
  let fx = routeApp({ app: VERSION, open: { id: 60, pr_number: 7, pr_title: 'Get Tier list\'s updates' } });
  let s = await listen(fx.server);
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/apps/cities/follow-pr`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ follow: true }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'already_open');
    assert.deepEqual([body.sessionId, body.prNumber, body.href], [60, 7, '#app/cities/dev/changes/7']);
    assert.equal(fx.asked.length, 0);
  } finally {
    s.close();
    fx.restore();
  }

  fx = routeApp({ app: { ...VERSION, upstream: null } });
  s = await listen(fx.server);
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/apps/cities/follow-pr`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ follow: true }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'not_a_version');
  } finally {
    s.close();
    fx.restore();
  }

  // The conductor found one opened in between: named the same way.
  fx = routeApp({ app: VERSION, operation: () => ({ ok: false, status: 409, error: 'x', sessionId: 61, prNumber: 8 }) });
  s = await listen(fx.server);
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/apps/cities/follow-pr`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ follow: true }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual([body.code, body.sessionId, body.href], ['already_open', 61, '#app/cities/dev/changes/8']);
  } finally {
    s.close();
    fx.restore();
  }
});

test('the routes are mounted, membership-gated where they write', () => {
  assert.match(read('server.js'), /app\.use\(require\('\.\/src\/routes\/versions'\)\.versionsRoutes\(config\)\);/);
  assert.match(read('src/routes/versions.js'),
    /router\.post\('\/api\/apps\/:slug\/follow-pr', drainGuard, issueCreateLimiter, requireAppMembership,/);
});
