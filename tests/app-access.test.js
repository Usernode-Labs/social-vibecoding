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

// ── Fail-closed on a row that cannot answer the question ────────────────
//
// This used to be "legacy rows without visibility columns are treated as
// public". That default was the structural cause of the /api/iframe-token
// bug: a caller that projected the column away got a silent pass for every
// app, including the view-private ones. A row that cannot answer must now
// throw, so the mistake surfaces as a 500 instead of a privacy bypass.

test('a row missing the visibility column throws, at both levels', async () => {
  const trimmed = { id: 4, slug: 'old', created_by: 10 };
  const pool = stubPool({ apps: { 4: trimmed } });
  await assert.rejects(
    () => appAccess.checkAppAccess(pool, trimmed, user(99), 'view'),
    /missing `view_visibility`/
  );
  await assert.rejects(
    () => appAccess.checkAppAccess(pool, trimmed, user(99), 'collab'),
    /missing `collab_visibility`/
  );
});

// Each level names ITS OWN column: a row carrying only view_visibility
// still cannot answer a 'collab' question, and must not borrow the other.
test('a half-projected row throws for the level it cannot answer', async () => {
  const viewOnly = { id: 5, slug: 'half', created_by: 10, view_visibility: 'public' };
  const pool = stubPool({ apps: { 5: viewOnly } });
  assert.equal(await appAccess.checkAppAccess(pool, viewOnly, user(99), 'view'), true);
  await assert.rejects(
    () => appAccess.checkAppAccess(pool, viewOnly, user(99), 'collab'),
    /missing `collab_visibility`/
  );
});

// NOT NULL DEFAULT 'public' in schema.sql means a real row always carries a
// non-empty string, so a NULL/empty value is as broken as an absent key —
// and treating it as public is the same bug wearing a different hat.
test('a present-but-null visibility value throws too', async () => {
  const nulled = { id: 6, slug: 'nul', created_by: 10, collab_visibility: null, view_visibility: '' };
  const pool = stubPool({ apps: { 6: nulled } });
  await assert.rejects(
    () => appAccess.checkAppAccess(pool, nulled, user(99), 'view'),
    /missing `view_visibility`/
  );
  await assert.rejects(
    () => appAccess.checkAppAccess(pool, nulled, user(99), 'collab'),
    /missing `collab_visibility`/
  );
});

// The check precedes the admin short-circuit on purpose: admins are who
// the screenshot and proposal-checks runners authenticate as, so an
// admin-exempt version would keep slipping through the very paths most
// likely to hit a trimmed projection.
test('an admin gets the throw too, not a free pass', async () => {
  const trimmed = { id: 4, slug: 'old', created_by: 10 };
  const pool = stubPool({ apps: { 4: trimmed } });
  await assert.rejects(
    () => appAccess.checkAppAccess(pool, trimmed, user(99, true), 'view'),
    /missing `view_visibility`/
  );
  await assert.rejects(
    () => appAccess.checkAppAccess(pool, trimmed, user(99, true), 'collab'),
    /missing `collab_visibility`/
  );
});

// getAppForUser propagates rather than swallowing — its ~50 callers all sit
// inside route-level try/catch blocks that answer 500.
test('getAppForUser propagates the throw when handed a trimmed column list', async () => {
  const pool = {
    async query(sql) {
      if (/FROM apps WHERE slug/.test(sql)) return { rows: [{ id: 7, slug: 'trim' }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  await assert.rejects(
    () => appAccess.getAppForUser(pool, 'trim', user(99), 'view', 'id, slug'),
    /missing `view_visibility`/
  );
});

// A fully-populated row is unaffected — the common path stays a boolean.
test('a fully-projected row still resolves normally', async () => {
  const pool = stubPool({ apps: { 3: FULLY_PRIVATE }, members: new Set(['3:10']) });
  assert.equal(await appAccess.checkAppAccess(pool, FULLY_PRIVATE, user(10), 'view'), true);
  assert.equal(await appAccess.checkAppAccess(pool, FULLY_PRIVATE, user(99), 'view'), false);
  assert.equal(await appAccess.checkAppAccess(pool, PUBLIC_APP, user(99), 'collab'), true);
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
