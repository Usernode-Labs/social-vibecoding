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

// Said to the building agent when it declares, so it can declare again:
// a guest change on an app whose guests are shown nothing of it, and a
// claim about signed-out visitors declared for a signed-in persona.
test('persona warnings name guest changes guests cannot see and signed-out claims on signed-in personas', async (t) => {
  const appAccess = require('../src/services/app-access');
  const saved = { EDGE_JWT_SECRET: process.env.EDGE_JWT_SECRET, APP_HOST_SIGNIN: process.env.APP_HOST_SIGNIN };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    appAccess.invalidateAllVisibility();
  });
  process.env.EDGE_JWT_SECRET = 'e'.repeat(64);
  delete process.env.APP_HOST_SIGNIN;
  let row = { id: 42, view_visibility: 'private', moderation_suspended_at: null };
  const pool = { async query() { return { rows: row ? [row] : [] }; } };
  const app = { id: 42, slug: 'vote-inbox' };
  const story = (id, persona, claim) => ({ id, persona, claim });
  const warn = async (stories, options) => {
    appAccess.invalidateAllVisibility();
    return identities.personaWarnings(pool, app, { stories }, options);
  };

  const privateGuest = await warn([story('summary-line', 'guest', 'A line under the header counts open proposals.')]);
  assert.equal(privateGuest.length, 1);
  assert.match(privateGuest[0], /^summary-line is declared for guest, but this app is private/);
  assert.match(privateGuest[0], /declare it again with persona member/);

  row = { id: 42, view_visibility: 'public', moderation_suspended_at: null };
  assert.deepEqual(await warn([story('summary-line', 'guest', 'A line under the header.')]), [],
    'a public app shows its guests a guest view');
  assert.deepEqual(await warn([story('landing', 'guest', 'The landing page says hello.')], { selfApp: true }), [],
    'Homeroom shows a signed-out browser its own pages');

  const signedOut = await warn([
    story('lobby', 'member', 'The lobby renders unchanged for a signed-out visitor.'),
    story('board', 'member', 'The board shows a new column.'),
  ]);
  assert.equal(signedOut.length, 1);
  assert.match(signedOut[0], /^lobby describes a visitor who is not signed in/);
  assert.match(signedOut[0], /persona guest/);
  assert.deepEqual(await warn([]), []);
  assert.deepEqual(await identities.personaWarnings(pool, app, null), []);
});

// An app built on Homeroom is told who is signed in, never their role in it
// (platform-jwt.js signAppIdentityToken), so no shots browser is its creator
// or one of its admins. Three runs on one app's Creator Studio were refused
// for every persona (QuestVerse's PRs 7 to 9). Said when the change is
// declared.
test('persona warnings say no shots browser is a child app\'s creator or admin', async (t) => {
  const appAccess = require('../src/services/app-access');
  const saved = { EDGE_JWT_SECRET: process.env.EDGE_JWT_SECRET, APP_HOST_SIGNIN: process.env.APP_HOST_SIGNIN };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    appAccess.invalidateAllVisibility();
  });
  process.env.EDGE_JWT_SECRET = 'e'.repeat(64);
  delete process.env.APP_HOST_SIGNIN;
  const pool = { async query() { return { rows: [{ id: 42, view_visibility: 'public', moderation_suspended_at: null }] }; } };
  const app = { id: 42, slug: 'questverse' };
  const story = (id, persona, claim, intent = {}) => ({
    id, persona, claim,
    intent: { startPath: '/', steps: ['Open it'], checkpoint: 'It shows', focus: 'The screen', ...intent },
  });
  const warn = async (stories, options) => {
    appAccess.invalidateAllVisibility();
    return identities.personaWarnings(pool, app, { stories }, options);
  };

  const admins = await warn([
    story('theme-picker', 'full_admin', 'A seasonal theme picker in the studio.'),
    story('music', 'read_only_admin', 'A background music uploader.'),
  ]);
  assert.equal(admins.length, 1);
  assert.match(admins[0], /^theme-picker, music are declared for an administrator persona/);
  assert.match(admins[0], /Homeroom administrators, which this app is not told/);
  assert.match(admins[0], /no shots browser is its creator or one of its admins/);
  assert.match(admins[0], /particular accounts \(its creator, a list of usernames or ids\)\s+cannot be shot/);
  assert.match(admins[0], /say how in hints\.setup; otherwise declare what a member sees/);

  const studio = await warn([
    story('prelude', 'member', 'The Creator Studio gains a prelude story editor.'),
    story('admin-path', 'member', 'A new tab appears.', { startPath: '/#/admin' }),
    story('board', 'member', 'The board shows a new column.'),
  ]);
  assert.equal(studio.length, 1, 'a member change on an ordinary screen draws nothing');
  assert.match(studio[0], /^prelude, admin-path describe a screen for this app's creator, owner or admins/);
  assert.match(studio[0], /Homeroom tells an app who is signed in, never their role in it/);

  assert.deepEqual(await warn([story('group-owner', 'member', 'The group owner sees a Rename button.', {
    hints: { setup: 'Create a group from + first; its creator is its owner' },
  })]), [], 'a role the app grants in its own UI is reached through hints.setup');
  assert.deepEqual(await warn([story('banner', 'guest', 'Admins are named in the guest banner.')]), [],
    'a guest holds no role anywhere, and a public app shows it its guest view');

  // Homeroom's own copies: the administrator personas are its administrators.
  assert.deepEqual(await warn([
    story('merge-panel', 'full_admin', 'The admin console shows a merge panel.'),
    story('creator-row', 'member', 'The project creator is named on the hub.'),
  ], { selfApp: true }), []);
});
