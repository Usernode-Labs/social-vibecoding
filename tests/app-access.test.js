// Unit tests for src/services/app-access.js — the shared per-app
// visibility gate. Uses a minimal stub pool keyed on query shape, same
// spirit as tests/kudos.test.js's pool stubbing.

const test = require('node:test');
const assert = require('node:assert/strict');

const appAccess = require('../src/services/app-access');

// Stub pool: routes membership lookups by the table referenced in the
// SQL. `members` is a Set of "appId:userId" strings with member rows.
function stubPool({ apps = {}, members = new Set() } = {}) {
  return {
    async query(sql, params = []) {
      if (/FROM app_collaborators/.test(sql)) {
        const [appId, userId] = params;
        return { rows: members.has(`${appId}:${userId}`) ? [{ '?column?': 1 }] : [] };
      }
      if (/FROM apps WHERE slug/.test(sql)) {
        const app = Object.values(apps).find((a) => a.slug === params[0]);
        return { rows: app ? [app] : [] };
      }
      if (/FROM apps WHERE id/.test(sql)) {
        const app = apps[params[0]];
        return { rows: app ? [app] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const PUBLIC_APP = { id: 1, slug: 'pub', created_by: 10, collab_visibility: 'public', view_visibility: 'public' };
const INVITE_ONLY = { id: 2, slug: 'inv', created_by: 10, collab_visibility: 'private', view_visibility: 'public' };
const FULLY_PRIVATE = { id: 3, slug: 'priv', created_by: 10, collab_visibility: 'private', view_visibility: 'private' };

const user = (id, isAdmin = false) => ({ id, isAdmin });

test('public app: everyone passes both levels', async () => {
  const pool = stubPool({ apps: { 1: PUBLIC_APP } });
  assert.equal(await appAccess.checkAppAccess(pool, PUBLIC_APP, user(99), 'view'), true);
  assert.equal(await appAccess.checkAppAccess(pool, PUBLIC_APP, user(99), 'collab'), true);
});

test('invite-only build: outsiders view but cannot collab', async () => {
  const pool = stubPool({ apps: { 2: INVITE_ONLY }, members: new Set(['2:10']) });
  assert.equal(await appAccess.checkAppAccess(pool, INVITE_ONLY, user(99), 'view'), true);
  assert.equal(await appAccess.checkAppAccess(pool, INVITE_ONLY, user(99), 'collab'), false);
  assert.equal(await appAccess.checkAppAccess(pool, INVITE_ONLY, user(10), 'collab'), true);
});

test('fully private: only members see anything', async () => {
  const pool = stubPool({ apps: { 3: FULLY_PRIVATE }, members: new Set(['3:10']) });
  assert.equal(await appAccess.checkAppAccess(pool, FULLY_PRIVATE, user(99), 'view'), false);
  assert.equal(await appAccess.checkAppAccess(pool, FULLY_PRIVATE, user(10), 'view'), true);
});

test('admins always pass, even fully private', async () => {
  const pool = stubPool({ apps: { 3: FULLY_PRIVATE } });
  assert.equal(await appAccess.checkAppAccess(pool, FULLY_PRIVATE, user(99, true), 'view'), true);
  assert.equal(await appAccess.checkAppAccess(pool, FULLY_PRIVATE, user(99, true), 'collab'), true);
});

test('pending invite (no member row) grants nothing', async () => {
  // members set is keyed only on status='member' rows — an invited user
  // simply has no entry here, mirroring the SQL's status filter.
  const pool = stubPool({ apps: { 3: FULLY_PRIVATE }, members: new Set() });
  assert.equal(await appAccess.checkAppAccess(pool, FULLY_PRIVATE, user(42), 'view'), false);
  assert.equal(await appAccess.checkAppAccess(pool, FULLY_PRIVATE, user(42), 'collab'), false);
});

test('legacy rows without visibility columns are treated as public', async () => {
  const legacy = { id: 4, slug: 'old', created_by: 10 };
  const pool = stubPool({ apps: { 4: legacy } });
  assert.equal(await appAccess.checkAppAccess(pool, legacy, user(99), 'view'), true);
  assert.equal(await appAccess.checkAppAccess(pool, legacy, user(99), 'collab'), true);
});

test('parseAppHost maps hosts to app slugs', () => {
  const D = 'social-vibecoding.usernodelabs.org'; // services/caddy.js default
  assert.equal(appAccess.parseAppHost(`myapp.${D}`)?.slug, 'myapp');
  assert.equal(appAccess.parseAppHost(`MyApp.${D}:443`)?.slug, 'myapp');
  // Staging previews (current + legacy hash suffix) inherit the prod slug.
  assert.equal(appAccess.parseAppHost(`myapp--s42.${D}`)?.slug, 'myapp');
  assert.equal(appAccess.parseAppHost(`myapp--s42--abc123.${D}`)?.slug, 'myapp');
  // Non-platform / multi-label / apex hosts are not app hosts.
  assert.equal(appAccess.parseAppHost('evil.example.com'), null);
  assert.equal(appAccess.parseAppHost(`a.b.${D}`), null);
  assert.equal(appAccess.parseAppHost(D), null);
  assert.equal(appAccess.parseAppHost(''), null);
});

test('getAppForUser resolves by slug and applies the gate', async () => {
  const pool = stubPool({
    apps: { 3: FULLY_PRIVATE },
    members: new Set(['3:10']),
  });
  const denied = await appAccess.getAppForUser(pool, 'priv', user(99), 'view');
  assert.equal(denied, null);
  const allowed = await appAccess.getAppForUser(pool, 'priv', user(10), 'view');
  assert.equal(allowed?.id, 3);
  const missing = await appAccess.getAppForUser(pool, 'nope', user(10), 'view');
  assert.equal(missing, null);
});
