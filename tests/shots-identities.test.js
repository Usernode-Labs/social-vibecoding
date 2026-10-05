'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const visuals = require('../src/services/visuals');
const fixtures = require('../src/services/shots-fixtures');
const identities = require('../src/services/shots-identities');

test('full-admin shots token names only the identity installed in disposable clones', async () => {
  const original = visuals.mintCaptureToken;
  const queries = [];
  visuals.mintCaptureToken = (user, appId) => `${appId}:${user.id}:${user.username}`;
  try {
    const pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [
          { id: 10, username: visuals.CAPTURE_USERNAME },
          {
            id: 11, username: visuals.CAPTURE_ADMIN_USERNAME,
            is_admin: true, admin_readonly: true,
          },
        ] };
      },
    };
    const tokens = await identities.mintShotsAuthTokens(pool, 42);
    assert.equal(tokens.member, `42:10:${visuals.CAPTURE_USERNAME}`);
    assert.equal(tokens.read_only_admin, `42:11:${visuals.CAPTURE_ADMIN_USERNAME}`);
    assert.equal(tokens.full_admin,
      `42:${fixtures.FULL_ADMIN_USER_ID}:${fixtures.FULL_ADMIN_USERNAME}`);
    assert.deepEqual(queries[0].params[0], [visuals.CAPTURE_USERNAME, visuals.CAPTURE_ADMIN_USERNAME]);
  } finally {
    visuals.mintCaptureToken = original;
  }
});

// The guest browser is not signed in. A guest token goes only where the
// production edge would give one (services/edge-gate.js): a view-public,
// unsuspended child app, with app-host sign-in on and a guest signer.
test('a guest token is minted only for a view-public child app, as the edge would', async (t) => {
  const appAccess = require('../src/services/app-access');
  const platformJwt = require('../src/services/platform-jwt');
  const saved = { EDGE_JWT_SECRET: process.env.EDGE_JWT_SECRET, APP_HOST_SIGNIN: process.env.APP_HOST_SIGNIN };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    appAccess.invalidateAllVisibility();
  });
  process.env.EDGE_JWT_SECRET = 'e'.repeat(64);
  delete process.env.APP_HOST_SIGNIN;
  let row = { id: 42, view_visibility: 'public', moderation_suspended_at: null };
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: row ? [row] : [] };
    },
  };
  const app = { id: 42, slug: 'puzzlechain' };
  const identity = async (options) => {
    appAccess.invalidateAllVisibility();
    return identities.shotsGuestIdentity(pool, app, options);
  };

  const guest = await identity();
  assert.equal(guest.kind, 'guest');
  const claims = platformJwt.verifyGuestToken(guest.token, { appId: 42 });
  assert.equal(claims.guest, true);
  assert.equal(claims.exp - claims.iat, 15 * 60, 'as short-lived as the fixture tokens');
  assert.equal(claims.id, undefined, 'it names nobody');
  assert.throws(() => platformJwt.verifyAppIdentityToken(guest.token, { appId: 42 }),
    'it is not a person\'s token');
  assert.equal(queries.at(-1).params[0], 'puzzlechain', 'the edge\'s own lookup, by slug');

  // Homeroom's own copies show a signed-out browser their own pages: no token, no lookup.
  const before = queries.length;
  assert.deepEqual(await identity({ selfApp: true }), { kind: 'homeroom', token: null });
  assert.equal(queries.length, before);

  row = { ...row, view_visibility: 'private' };
  assert.deepEqual(await identity(), { kind: 'private', token: null });
  row = { id: 42, view_visibility: 'public', moderation_suspended_at: new Date() };
  assert.deepEqual(await identity(), { kind: 'private', token: null }, 'a suspended app admits nobody');
  row = { id: 7, view_visibility: 'public', moderation_suspended_at: null };
  assert.deepEqual(await identity(), { kind: 'private', token: null }, 'the slug must be this app\'s');
  row = null;
  assert.deepEqual(await identity(), { kind: 'private', token: null });

  row = { id: 42, view_visibility: 'public', moderation_suspended_at: null };
  process.env.APP_HOST_SIGNIN = 'off';
  assert.deepEqual(await identity(), { kind: 'unavailable', token: null }, 'no guests where sign-in is off');
  delete process.env.APP_HOST_SIGNIN;
  delete process.env.EDGE_JWT_SECRET;
  assert.deepEqual(await identity(), { kind: 'unavailable', token: null }, 'no guests without a signer');
});
