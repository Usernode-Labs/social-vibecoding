// Admitting a PHONE keyed waitlist row — its one "you're in" text.
//
// The email half already sends exactly one waitlist_released mail on the
// FIRST release (tests/topochain-admin-waitlist-api.test.js pins the list
// payload; services/topochain/mailer.js pins the mail). This file pins the
// phone half end to end through the admin release route:
//
//   - a phone row with no email sends a waitlist_released_sms, not a mail;
//   - the text goes out ONCE — a re-release sends nothing (newly_released);
//   - the release text branches its copy on whether an account already has
//     the number (sign-up link vs sign-in link);
//   - linkUserByPhone admits an account appearing on an already-released
//     row, the phone twin of linkUserByEmail;
////
// The pool is a hand-rolled mock; the route talks to services/waitlist
// (whose queries the mock recognises) and to src/services/sms (whose only
// outbound boundary is the injected transport, so nothing real is texted).
//
// Run with: node --test tests/waitlist-phone-release.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const PHONE = '+15550100001';
const DAY = 24 * 60 * 60 * 1000;

// ─── Mock pool ──────────────────────────────────────────────────────────
// Recognises the queries the release path issues: releaseWaitlistSignup's
// CTE update, its backfill lookups, grantPlatformAccess, and the admin
// list count. Everything else (the mail mobile lookup) returns empty rows.

function makePool() {
  const state = {
    signups: new Map(),
    delivered: [],
    releasedAt: new Map(),
    linkedUserId: new Map(),
    grants: [],
  };
  function row(id) {
    const s = state.signups.get(id);
    return {
      id,
      email: s ? s.email : null,
      phone_e164: s ? s.phone_e164 : null,
      released_at: state.releasedAt.get(id) || null,
      linked_user_id: state.linkedUserId.get(id) || null,
      more_token: s ? s.more_token : null,
    };
  }
  return {
    state,
    async query(rawSql, params = []) {
      const sql = rawSql.replace(/\s+/g, ' ').trim();

      // releaseWaitlistSignup's CTE update.
      if (/WITH prev AS/.test(sql)) {
        const id = params[0];
        if (!state.signups.has(id)) return { rows: [] };
        const wasReleased = state.releasedAt.get(id);
        if (!wasReleased) state.releasedAt.set(id, new Date());
        return {
          rows: [{
            ...row(id),
            released_at: state.releasedAt.get(id),
            newly_released: wasReleased == null,
          }],
        };
      }
      // The backfill lookups.
      if (/SELECT id FROM users WHERE email = \$1/.test(sql)) return { rows: [] };
      if (/SELECT user_id AS id FROM user_phone_identities WHERE phone_e164 = \$1/.test(sql)) {
        const p = params[0];
        const acct = [...state.signups.values()].find((s) => s.phone_e164 === p && s.account_user_id);
        return { rows: acct ? [{ id: acct.account_user_id }] : [] };
      }
      if (/UPDATE waitlist_signups SET linked_user_id = \$1 WHERE id = \$2/.test(sql)) {
        state.linkedUserId.set(params[1], params[1]);
        return { rows: [] };
      }
      // grantPlatformAccess — the recorded fact this test asserts on.
      if (/UPDATE users SET has_platform_access = TRUE/.test(sql)) {
        state.grants.push(params[0]);
        return { rows: [] };
      }
      // Page count for the admin list echo.
      if (/SELECT COUNT\(\*\)::int AS c FROM waitlist_signups/.test(sql)) return { rows: [{ c: 1 }] };
      // The mail mobile lookup — a failed/empty answer drops the steps.
      if (/FROM app_version_configs/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    connect: async () => ({
      query: async (sql, params) => this.query(sql, params),
      release: () => {},
    }),
  };
}

// ─── Harness ────────────────────────────────────────────────────────────

const poolPath = require.resolve('../src/db/pool');
let currentPool = null;
const poolMod = require('../src/db/pool');
poolMod.getPool = () => currentPool;

// Replace the SMS module BEFORE the admin composer is required, because the
// route destructures `sendWaitlistReleaseSms` at require time — a later swap
// of the export would be invisible to it. `captured` collects the sends;
const captured = [];
const smsPath = require.resolve('../src/services/sms');
const realSms = require('../src/services/sms');
require.cache[smsPath] = {
  ...require.cache[smsPath],
  exports: {
    ...realSms,
    sendWaitlistReleaseSms: async (_config, to, opts) => { captured.push({ to, ...opts }); },
    sendWaitlistJoinSms: async () => {},
    sendWaitlistCodeSms: async () => {},
  },
};

const { topochainAdminRoutes } = require('../src/routes/topochain/admin');

function buildApp(role = 'admin') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = role === 'readonly'
      ? { id: 901, username: 'ro', isAdmin: true, canAdminWrite: false }
      : { id: 902, username: 'admin', isAdmin: true, canAdminWrite: true };
    next();
  });
  app.use(topochainAdminRoutes({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function release(id, role = 'admin') {
  const { server, base } = await listen(buildApp(role));
  try {
    const res = await fetch(`${base}/api/v4/admin/waitlist/${id}/release`, { method: 'POST' });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

test.beforeEach(() => { captured.length = 0; });

// ─── Tests ──────────────────────────────────────────────────────────────

test('a phone row with no email sends one text on its first release', async () => {
  const pool = makePool();
  pool.state.signups.set(1, { email: null, phone_e164: PHONE, more_token: null });
  currentPool = pool;

  const { status } = await release(1);
  assert.equal(status, 200);
  assert.equal(captured.length, 1, 'exactly one text');
  assert.equal(captured[0].to, PHONE);
  assert.equal(captured[0].hasAccount, false, 'no account yet — the sign-up link');
});

test('a re-release sends nothing: the text rides newly_released', async () => {
  const pool = makePool();
  pool.state.signups.set(1, { email: null, phone_e164: PHONE, more_token: null });
  currentPool = pool;

  await release(1);
  assert.equal(captured.length, 1);
  await release(1);
  assert.equal(captured.length, 1, 'an idempotent re-release must not text again');
});

test('an email row still sends the mail, never a text', async () => {
  const pool = makePool();
  pool.state.signups.set(2, { email: 'someone@example.invalid', phone_e164: null, more_token: 'tok' });
  currentPool = pool;

  await release(2);
  assert.equal(captured.length, 0, 'an email row is not texted');
});

test('a row whose account already has the number is sent the sign-in link', async () => {
  const pool = makePool();
  pool.state.signups.set(3, { email: null, phone_e164: PHONE, more_token: null, account_user_id: 77 });
  currentPool = pool;

  await release(3);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].hasAccount, true);
});

test('a readonly admin cannot release at all', async () => {
  const pool = makePool();
  pool.state.signups.set(4, { email: null, phone_e164: PHONE, more_token: null });
  currentPool = pool;

  const { status } = await release(4, 'readonly');
  assert.equal(status, 403);
  assert.equal(captured.length, 0, 'no text for a refused release');
});


// ─── linkUserByPhone: the phone twin of linkUserByEmail ─────────────────

const waitlist = require('../src/services/waitlist');
const memberWaitlist = require('../src/services/member-waitlist');

function linkPool({ releasedAt = null, linkRow = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(rawSql, params = []) {
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      calls.push(sql);
      if (/UPDATE waitlist_signups SET linked_user_id = \$1 WHERE phone_e164 = \$2/.test(sql)) {
        return { rows: linkRow ? [{ released_at: releasedAt }] : [] };
      }
      if (/UPDATE users SET has_platform_access = TRUE/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

test('linkUserByPhone admits an account appearing on an already-released row', async () => {
  const pool = linkPool({ releasedAt: new Date() });
  await waitlist.linkUserByPhone(pool, { userId: 42, phone: PHONE });
  // The link is written, then access is granted because the row was
  // already released.
  assert.ok(pool.calls.some((s) => /UPDATE waitlist_signups SET linked_user_id/.test(s)));
  assert.ok(pool.calls.some((s) => /UPDATE users SET has_platform_access = TRUE/.test(s)),
    'a released row grants access on the spot');
});

test('linkUserByPhone links but does not grant for a row still waiting', async () => {
  const pool = linkPool({ releasedAt: null });
  await waitlist.linkUserByPhone(pool, { userId: 42, phone: PHONE });
  assert.ok(pool.calls.some((s) => /UPDATE waitlist_signups SET linked_user_id/.test(s)));
  assert.ok(!pool.calls.some((s) => /UPDATE users SET has_platform_access/.test(s)),
    'a waiting row must not hand out access early');
});

test('linkUserByPhone is a no-op on a malformed number and never throws to a sign-in', async () => {
  const pool = linkPool();
  await assert.doesNotReject(waitlist.linkUserByPhone(pool, { userId: 42, phone: 'nonsense' }));
  assert.equal(pool.calls.length, 0, 'no query for a number that cannot be E.164');
});

test('a number already on another account is refused, never re-pointed', async () => {
  // heldByAnotherPhone, the phone twin of heldByAnother: an account may not
  // claim a number that user_phone_identities or a linked waitlist row
  // already holds. Exercised through joinByPhone, since the helper is not
  // exported (its email twin is not either).
  const held = { async query() { return { rows: [{ '?column?': 1 }] }; } };
  await assert.rejects(
    memberWaitlist.joinByPhone(held, { userId: 7, rawPhone: PHONE, send: () => {} }),
    (err) => err.code === 'phone_in_use' && err.status === 409
  );
});
