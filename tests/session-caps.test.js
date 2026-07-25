// Unit test for src/services/session-caps.js — the per-requester
// resolver for the two per-user concurrency ceilings (running dev
// sessions, open proposals).
//
// The rule under test is small but load-bearing in two directions:
//   - it decides who gets the RAISED admin caps (5 / 8 by default), and
//     the single most dangerous mistake would be gating on `isAdmin`
//     instead of `canAdminWrite` — that would silently hand the bump to
//     every view-only admin (#311), of which production has several.
//   - it feeds the `caps` field on GET /api/me/active-sessions, which the
//     dev drawer renders as the "(N/M)" denominators. A missing/partial
//     config must therefore never yield undefined.
//
// Pure function, no pool, no express — asserted as a table.
//
// Run with: node --test tests/session-caps.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  effectiveSessionCaps,
  DEFAULT_USER_SESSIONS,
  DEFAULT_USER_PROMOTED,
  DEFAULT_ADMIN_SESSIONS,
  DEFAULT_ADMIN_PROMOTED,
} = require('../src/services/session-caps');

// A fully-populated config, distinct from the fallbacks so a test can
// tell "read the config" apart from "fell back to a default".
const CONFIG = {
  maxUserSessions: 3,
  maxUserPromotedSessions: 5,
  maxAdminUserSessions: 5,
  maxAdminUserPromotedSessions: 8,
};

test('defaults are the documented 3/5 base and 5/8 admin tiers', () => {
  assert.strictEqual(DEFAULT_USER_SESSIONS, 3);
  assert.strictEqual(DEFAULT_USER_PROMOTED, 5);
  assert.strictEqual(DEFAULT_ADMIN_SESSIONS, 5);
  assert.strictEqual(DEFAULT_ADMIN_PROMOTED, 8);
});

test('tiering is gated on canAdminWrite, never on isAdmin', () => {
  const cases = [
    // [label, user, expected]
    ['regular user', { id: 1 }, { activeSessions: 3, promotedSessions: 5 }],
    ['full platform admin', { id: 2, isAdmin: true, canAdminWrite: true }, { activeSessions: 5, promotedSessions: 8 }],
    // #311: view-only admins see everything but mutate nothing elevated.
    // Holding extra warm workers / staging previews is an elevated
    // capability, so they stay on the base caps like any regular user.
    ['view-only admin', { id: 3, isAdmin: true, canAdminWrite: false }, { activeSessions: 3, promotedSessions: 5 }],
    // Per-app admin status is scoped to one app and grants nothing
    // platform-wide — it must not move a platform-wide budget. (The
    // resolver never consults app-admins; this asserts an app-admin-ish
    // shaped user gets nothing extra.)
    ['per-app admin only', { id: 4, appAdminOf: [7] }, { activeSessions: 3, promotedSessions: 5 }],
    ['undefined user', undefined, { activeSessions: 3, promotedSessions: 5 }],
    ['null user', null, { activeSessions: 3, promotedSessions: 5 }],
  ];
  for (const [label, user, expected] of cases) {
    assert.deepStrictEqual(effectiveSessionCaps(CONFIG, user), expected, label);
  }
});

test('config values are honored over the fallbacks, per tier', () => {
  const tuned = {
    maxUserSessions: 2,
    maxUserPromotedSessions: 4,
    maxAdminUserSessions: 11,
    maxAdminUserPromotedSessions: 12,
  };
  assert.deepStrictEqual(
    effectiveSessionCaps(tuned, { id: 1 }),
    { activeSessions: 2, promotedSessions: 4 }
  );
  assert.deepStrictEqual(
    effectiveSessionCaps(tuned, { id: 2, canAdminWrite: true }),
    { activeSessions: 11, promotedSessions: 12 }
  );
});

// Route tests mount routers with `sessionRoutes({})`, and the caps ride a
// JSON payload the client renders as a denominator — `undefined` there
// would paint "(N/undefined)".
test('empty / partial / garbage config falls back to numeric caps', () => {
  for (const cfg of [{}, undefined, null, { maxUserSessions: null }, { maxUserSessions: 'abc' }, { maxUserSessions: 0 }, { maxUserSessions: -4 }]) {
    const base = effectiveSessionCaps(cfg, { id: 1 });
    assert.deepStrictEqual(base, { activeSessions: 3, promotedSessions: 5 }, JSON.stringify(cfg));
    const admin = effectiveSessionCaps(cfg, { id: 2, canAdminWrite: true });
    assert.deepStrictEqual(admin, { activeSessions: 5, promotedSessions: 8 }, JSON.stringify(cfg));
    for (const v of Object.values({ ...base, ...admin })) {
      assert.ok(Number.isInteger(v) && v > 0, 'caps are positive integers');
    }
  }
});

// A misconfigured deployment (admin cap below the base cap) is honored
// LITERALLY rather than silently clamped — config.js warns about it at
// boot, and the boot log stays the single source of truth for what is
// actually enforced.
test('an admin cap below the base cap is honored literally, not clamped', () => {
  const misconfigured = {
    maxUserSessions: 3,
    maxUserPromotedSessions: 5,
    maxAdminUserSessions: 1,
    maxAdminUserPromotedSessions: 2,
  };
  assert.deepStrictEqual(
    effectiveSessionCaps(misconfigured, { id: 2, canAdminWrite: true }),
    { activeSessions: 1, promotedSessions: 2 }
  );
});

test('resolver is pure — repeated calls with the same inputs match, inputs unmutated', () => {
  const cfg = { ...CONFIG };
  const user = { id: 2, canAdminWrite: true };
  const a = effectiveSessionCaps(cfg, user);
  const b = effectiveSessionCaps(cfg, user);
  assert.deepStrictEqual(a, b);
  assert.notStrictEqual(a, b, 'returns a fresh object, not shared state');
  assert.deepStrictEqual(cfg, CONFIG);
  assert.deepStrictEqual(user, { id: 2, canAdminWrite: true });
});
