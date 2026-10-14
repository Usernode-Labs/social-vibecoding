'use strict';

// Custom domains (#4405): the project's own routes in routes/apps.js.
//
//   GET    /api/apps/:slug/domain          any viewer; the manage flag rides along
//   POST   /api/apps/:slug/domain          canManageApp, never the platform's own app
//   POST   /api/apps/:slug/domain/check    the same, bounded per app
//   DELETE /api/apps/:slug/domain          the same
//
// and what the app payloads carry (custom_domain, share_url). The pool is
// stubbed the way tests/admins-pr-route.test.js stubs it; the DNS check and
// the edge are stubbed on the service, so this is about who may do what and
// what comes back, not about resolvers.
//
// Run with: node --test tests/app-domain-routes.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.USERNODE_DOMAIN = process.env.USERNODE_DOMAIN || 'social-vibecoding.usernodelabs.org';
delete process.env.APP_RUNTIME;
const DOMAIN = process.env.USERNODE_DOMAIN;

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });

const appDomains = require('../src/services/app-domains');
const appAdminsSvc = require('../src/services/app-admins');
const { appRoutes } = require('../src/routes/apps');
const express = require('express');

const APP_ROW = {
  id: 21, slug: 'demo', name: 'Demo', created_by: 1, self_hosted: false,
  repo_url: 'https://github.com/o/r', collab_visibility: 'public', view_visibility: 'public',
  admin_usernames: [], moderation_suspended_at: null,
};
const SELF_ROW = { ...APP_ROW, id: 22, slug: 'platform', name: 'Platform', self_hosted: true };

let currentUser;
let rows; // app_domains rows by id
let events;
let nextId;

function handler() {
  return async (sql, params) => {
    if (/FROM apps WHERE slug = \$1/.test(sql)) {
      if (params[0] === 'demo') return { rows: [APP_ROW] };
      if (params[0] === 'platform') return { rows: [SELF_ROW] };
      return { rows: [] };
    }
    if (/SELECT id, slug, name, runtime_name FROM apps WHERE id/.test(sql)) {
      return { rows: [APP_ROW] };
    }
    if (/FROM app_domains WHERE app_id = \$1/.test(sql)) {
      return { rows: Object.values(rows).filter((r) => r.app_id === params[0]) };
    }
    if (/SELECT app_id, status FROM app_domains WHERE hostname = \$1/.test(sql)) {
      return { rows: Object.values(rows).filter((r) => r.hostname === params[0]).map((r) => ({ app_id: r.app_id, status: r.status })) };
    }
    if (/COUNT\(\*\)::int AS n FROM events/.test(sql)) {
      return { rows: [{ n: events.filter((e) => e.user_id === params[1] && e.metadata.action === 'added').length }] };
    }
    if (/DELETE FROM app_domains WHERE hostname = \$1/.test(sql)) {
      for (const r of Object.values(rows)) if (r.hostname === params[0]) delete rows[r.id];
      return { rows: [] };
    }
    if (/DELETE FROM app_domains WHERE id = \$1/.test(sql)) {
      delete rows[params[0]];
      return { rows: [] };
    }
    if (/INSERT INTO app_domains/.test(sql)) {
      const row = {
        id: nextId++, app_id: params[0], hostname: params[1], verification_token: params[2], status: 'pending',
        created_by: params[3], created_at: new Date(), updated_at: new Date(), dns_checked_at: null, verified_at: null,
        live_at: null, cert_expires_at: null, last_error: null, failure_count: 0, disabled_at: null, disabled_by: null,
      };
      rows[row.id] = row;
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE app_domains SET/.test(sql)) {
      const row = rows[params[0]];
      const sets = sql.match(/SET (.*) WHERE/s)[1].split(', ');
      for (const part of sets) {
        const m = part.trim().match(/^(\w+) = \$(\d+)$/);
        if (m) row[m[1]] = params[Number(m[2]) - 1];
      }
      return { rows: [{ ...row }] };
    }
    if (/INSERT INTO events/.test(sql)) {
      events.push({ user_id: params[0], app_id: params[1], type: params[3], metadata: JSON.parse(params[4]) });
      return { rows: [{ id: events.length }] };
    }
    if (/FROM app_admins/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
}

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({ jwtSecret: 'test', selfAppSlug: 'platform' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  rows = {};
  events = [];
  nextId = 100;
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  poolQueryHandler = handler();
  appAdminsSvc.invalidateAppAdmins(APP_ROW.id);
  appDomains.resetCachesForTest();
});

const browser = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
const call = (method, path, body) => fetch(`${base}${path}`, {
  method, headers: browser, body: body === undefined ? undefined : JSON.stringify(body),
});

test('a manager claims a hostname: 201 with the two records; the claim is on the record', async () => {
  const res = await call('POST', '/api/apps/demo/domain', { hostname: 'App.Example.com' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.domain.hostname, 'app.example.com');
  assert.equal(body.domain.status, 'pending');
  assert.ok(!('verification_token' in body.domain), 'the token is only ever shown as the TXT value');
  assert.deepEqual(body.records.map((r) => [r.type, r.name]), [['CNAME', 'app.example.com'], ['TXT', '_homeroom.app.example.com']]);
  assert.equal(body.records[0].value, `demo.${DOMAIN}`);
  assert.match(body.records[1].value, /^homeroom-verify=[0-9a-f]{32}$/);
  assert.equal(body.homeroom_host, `demo.${DOMAIN}`);
  assert.equal(body.can_manage, true);
  assert.deepEqual(events.map((e) => [e.type, e.metadata]), [['app_domain_changed', { hostname: 'app.example.com', action: 'added' }]]);
  assert.equal(events[0].user_id, 1);
});

test('the read: anyone who may view the app sees where it stands; can_manage says who may change it', async () => {
  await call('POST', '/api/apps/demo/domain', { hostname: 'app.example.com' });
  currentUser = { id: 9, username: 'visitor', isAdmin: false };
  const res = await fetch(`${base}/api/apps/demo/domain`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.domain.hostname, 'app.example.com');
  assert.equal(body.can_manage, false);
  assert.equal((await fetch(`${base}/api/apps/nope/domain`)).status, 404);
});

test('refusals: 400 with the reason, 409 for a second claim or a taken host, 403 for a visitor, never the platform', async () => {
  const code = async (hostname) => {
    const res = await call('POST', '/api/apps/demo/domain', { hostname });
    return [res.status, (await res.json()).code];
  };
  assert.deepEqual(await code('example.com'), [400, 'apex_unsupported']);
  assert.deepEqual(await code(`x.${DOMAIN}`), [400, 'platform_domain']);
  assert.deepEqual(await code('1.2.3.4'), [400, 'invalid_hostname']);
  assert.deepEqual(await code('app.example.com'), [201, undefined]);
  assert.deepEqual(await code('other.example.com'), [409, 'already_has_domain']);
  // Another app's live claim on the same name.
  rows[5] = { id: 5, app_id: 77, hostname: 'theirs.example.com', status: 'live' };
  delete rows[100];
  assert.deepEqual(await code('theirs.example.com'), [409, 'hostname_taken']);
  // A failed claim by another app is released.
  rows[5].status = 'failed';
  assert.deepEqual(await code('theirs.example.com'), [201, undefined]);
  assert.ok(!rows[5], 'the failed claim is gone');

  currentUser = { id: 9, username: 'visitor', isAdmin: false };
  assert.equal((await call('POST', '/api/apps/demo/domain', { hostname: 'z.example.com' })).status, 403);
  assert.equal((await call('DELETE', '/api/apps/demo/domain')).status, 403);
  assert.equal((await call('POST', '/api/apps/demo/domain/check')).status, 403);
  currentUser = { id: 50, username: 'root', isAdmin: true, canAdminWrite: true };
  assert.equal((await call('POST', '/api/apps/platform/domain', { hostname: 'p.example.com' })).status, 403, 'the platform’s own app');
});

test('the daily claim cap: 429 on the sixth claim of a day', async () => {
  for (let i = 0; i < 5; i += 1) {
    events.push({ user_id: 1, app_id: 1, type: 'app_domain_changed', metadata: { hostname: `h${i}.example.com`, action: 'added' } });
  }
  const res = await call('POST', '/api/apps/demo/domain', { hostname: 'late.example.com' });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, 'claim_limit');
});

test('Check now runs the check on the spot and answers the row as it stands', async () => {
  appDomains._setResolverFactoryForTest(() => ({
    resolveCname: async () => [`demo.${DOMAIN}`],
    resolveTxt: async () => [[`homeroom-verify=${rows[100].verification_token}`]],
  }));
  try {
    await call('POST', '/api/apps/demo/domain', { hostname: 'app.example.com' });
    const res = await call('POST', '/api/apps/demo/domain/check');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.domain.status, 'verified', 'both records answered');
    assert.ok(body.domain.verified_at);
    assert.equal(body.domain.last_error, null);
  } finally {
    appDomains._setResolverFactoryForTest(null);
  }
  assert.equal((await call('POST', '/api/apps/nope/domain/check')).status, 404);
});

test('Check now is bounded: the seventh check in a minute is 429', async () => {
  appDomains._setResolverFactoryForTest(() => ({
    resolveCname: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
    resolveTxt: async () => [],
  }));
  try {
    await call('POST', '/api/apps/demo/domain', { hostname: 'bounded.example.com' });
    // The limiter is per app and per minute, and the test above already
    // spent one check on this app, so the cut comes within six.
    const statuses = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await call('POST', '/api/apps/demo/domain/check')).status);
    const cut = statuses.indexOf(429);
    assert.ok(cut >= 1 && cut <= 6, `cut off within six checks: ${statuses.join(' ')}`);
    assert.ok(statuses.slice(0, cut).every((s) => s === 200));
    assert.ok(statuses.slice(cut).every((s) => s === 429), 'and stays off');
    assert.equal(rows[100].last_error, 'No CNAME record found for bounded.example.com.');
  } finally {
    appDomains._setResolverFactoryForTest(null);
  }
});

test('Remove domain: 204, the row gone, on the record', async () => {
  await call('POST', '/api/apps/demo/domain', { hostname: 'app.example.com' });
  const res = await call('DELETE', '/api/apps/demo/domain');
  assert.equal(res.status, 204);
  assert.deepEqual(Object.keys(rows), []);
  assert.deepEqual(events.map((e) => e.metadata.action), ['added', 'removed']);
  assert.equal((await call('DELETE', '/api/apps/demo/domain')).status, 404, 'nothing left to remove');
  const read = await (await fetch(`${base}/api/apps/demo/domain`)).json();
  assert.equal(read.domain, null);
  assert.deepEqual(read.records, []);
});

test('a write that does not come from the platform’s own page is refused', async () => {
  const res = await fetch(`${base}/api/apps/demo/domain`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ hostname: 'app.example.com' }),
  });
  assert.equal(res.status, 403);
});

test('GET /api/apps/:slug carries the custom domain and the share address switches once it is live', async () => {
  const detail = async () => (await (await fetch(`${base}/api/apps/demo`)).json()).app;
  let app = await detail();
  assert.equal(app.custom_domain, null);
  assert.equal(app.share_url, app.url);
  await call('POST', '/api/apps/demo/domain', { hostname: 'app.example.com' });
  app = await detail();
  assert.deepEqual(app.custom_domain, { hostname: 'app.example.com', status: 'pending' });
  assert.equal(app.share_url, app.url, 'not yet');
  rows[100].status = 'live';
  app = await detail();
  assert.equal(app.custom_domain.status, 'live');
  if (/^https:/.test(app.url)) {
    assert.equal(app.share_url, 'https://app.example.com');
  } else {
    assert.equal(app.share_url, app.url, 'a dev box keeps its localhost address');
  }
});
