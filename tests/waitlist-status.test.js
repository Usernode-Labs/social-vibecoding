// Tests for the queue-status block on GET /api/public/waitlist/more/:token.
//
// Stage 2 of the waitlist ("Want in sooner?") could tell a visitor what
// their answers were, but not where they stood: a confirmed signup and an
// admitted one rendered the identical form, so the screen that exists to
// answer "am I in yet" was the one screen that could not. The row always
// knew — submitted_at / confirmed_at / released_at / linked_user_id are
// columns this route already had to read — so this is a projection of
// existing state, not new state and not a schema change.
//
// ?view=status is the same read with the expensive tail skipped: the
// screen polls it while it waits for a confirmation to land, and the full
// payload costs two extra queries plus a conditional invite-code INSERT.
//
// Harness style follows tests/waitlist-rate-limit.test.js: swap
// src/db/pool for an in-memory mock, drop the rate-limits and public-api
// modules from require.cache so limiter stores start empty, mount
// publicApiRoutes on a throwaway Express app and talk real HTTP.
//
// Run with: node --test tests/waitlist-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const PENDING = 'a'.repeat(48);
const CONFIRMED = 'b'.repeat(48);
const ADMITTED = 'c'.repeat(48);
const UNKNOWN = 'd'.repeat(48);
// Released, and its address already has an account that is set up.
const SET_UP = 'e'.repeat(48);

const JOINED = new Date('2026-01-02T03:04:05.000Z');
const CONFIRMED_AT = new Date('2026-01-03T03:04:05.000Z');
const RELEASED_AT = new Date('2026-01-09T03:04:05.000Z');

const ROWS = {
  [PENDING]: {
    id: 1, email: 'pending@example.invalid', answers: { group_name: 'saved earlier' },
    submitted_at: JOINED, confirmed_at: null, released_at: null, linked_user_id: null,
  },
  [CONFIRMED]: {
    id: 2, email: 'confirmed@example.invalid', answers: {},
    submitted_at: JOINED, confirmed_at: CONFIRMED_AT, released_at: null, linked_user_id: null,
  },
  [ADMITTED]: {
    id: 3, email: 'admitted@example.invalid', answers: {},
    submitted_at: JOINED, confirmed_at: CONFIRMED_AT, released_at: RELEASED_AT, linked_user_id: 900001,
  },
  [SET_UP]: {
    id: 4, email: 'set.up@example.invalid', answers: {},
    submitted_at: JOINED, confirmed_at: CONFIRMED_AT, released_at: RELEASED_AT, linked_user_id: 900002,
  },
};

// The accounts the addresses would prove, by address: ADMITTED's has chosen
// no username and set no password yet (it is still new); SET_UP's has.
const USERS = {
  'admitted@example.invalid': { is_admin: false, password_set: false, needs_username_choice: true },
  'set.up@example.invalid': { is_admin: false, password_set: false, needs_username_choice: false },
};

// Every statement the route runs, so a test can assert what ?view=status
// did NOT do as well as what the full read returned.
let statements = [];

function makeMockPool() {
  return {
    async query(sql, params) {
      statements.push(sql);
      if (/SELECT id, email, answers[\s\S]*FROM waitlist_signups/.test(sql)) {
        const row = ROWS[params[0]];
        return row ? { rows: [row] } : { rows: [] };
      }
      if (/waitlist_invite_codes/.test(sql)) return { rows: [{ code: 'INVITECODE' }] };
      if (/FROM users/.test(sql)) {
        const user = USERS[params[0]];
        return { rows: user ? [user] : [] };
      }
      return { rows: [] };
    },
  };
}

async function withPublicApi(fn, extraConfig = {}) {
  statements = [];
  const poolPath = require.resolve('../src/db/pool');
  const publicApiPath = require.resolve('../src/routes/public-api');
  const rateLimitsPath = require.resolve('../src/middleware/rate-limits');
  const originalPool = require.cache[poolPath];
  require.cache[poolPath] = {
    exports: { getPool: () => makeMockPool() },
    loaded: true, id: poolPath, filename: poolPath,
    paths: originalPool ? originalPool.paths : [],
  };
  delete require.cache[rateLimitsPath];
  delete require.cache[publicApiPath];
  let server;
  try {
    const { publicApiRoutes } = require('../src/routes/public-api');
    const app = express();
    app.use(express.json());
    app.use(publicApiRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test', ...extraConfig }));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (server) server.close();
    if (originalPool) require.cache[poolPath] = originalPool;
    else delete require.cache[poolPath];
    delete require.cache[rateLimitsPath];
    delete require.cache[publicApiPath];
  }
}

function get(base, token, query = '') {
  return fetch(`${base}/api/public/waitlist/more/${token}${query}`);
}

test('the three queue states come off the row the route already read', async () => {
  await withPublicApi(async (base) => {
    const pending = await (await get(base, PENDING)).json();
    assert.equal(pending.status.state, 'pending');
    assert.equal(pending.status.confirmed, false);
    assert.equal(pending.status.admitted, false);
    assert.equal(pending.status.confirmed_at, null);
    assert.equal(pending.status.admitted_at, null);
    assert.equal(pending.status.joined_at, JOINED.toISOString());

    const confirmed = await (await get(base, CONFIRMED)).json();
    assert.equal(confirmed.status.state, 'confirmed');
    assert.equal(confirmed.status.confirmed, true);
    assert.equal(confirmed.status.admitted, false);
    assert.equal(confirmed.status.confirmed_at, CONFIRMED_AT.toISOString());
    assert.equal(confirmed.status.admitted_at, null);

    const admitted = await (await get(base, ADMITTED)).json();
    assert.equal(admitted.status.state, 'admitted');
    assert.equal(admitted.status.confirmed, true);
    assert.equal(admitted.status.admitted, true);
    assert.equal(admitted.status.admitted_at, RELEASED_AT.toISOString());
  });
});

test('admitted is answered at the top level too', async () => {
  await withPublicApi(async (base) => {
    // "Am I in yet" is the one question this route exists to answer, so a
    // caller that reads nothing else should not have to know the block's
    // shape. Both spellings must agree.
    for (const [token, expected] of [[PENDING, false], [CONFIRMED, false], [ADMITTED, true]]) {
      const body = await (await get(base, token)).json();
      assert.equal(body.admitted, expected, `top-level admitted wrong for ${token[0]}`);
      assert.equal(body.admitted, body.status.admitted, 'the two spellings disagree');
    }
  });
});

test('has_account tracks linked_user_id, not admission', async () => {
  await withPublicApi(async (base) => {
    // Admission and having signed up are different facts: someone can be
    // released and not have redeemed the invite yet, and the pill says a
    // different thing in each case.
    const confirmed = await (await get(base, CONFIRMED)).json();
    assert.equal(confirmed.status.has_account, false);
    const admitted = await (await get(base, ADMITTED)).json();
    assert.equal(admitted.status.has_account, true);
  });
});

test('?view=status answers the poll alone and writes nothing', async () => {
  await withPublicApi(async (base) => {
    const res = await get(base, ADMITTED, '?view=status');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['admitted', 'ok', 'status']);
    assert.equal(body.status.state, 'admitted');
    // The tail of the full read is the point of the parameter: two extra
    // queries and a conditional invite-code INSERT, on a route the screen
    // re-hits every 30 seconds while it waits.
    assert.equal(body.answers, undefined);
    assert.equal(body.invite, undefined);
    assert.equal(body.oauth, undefined);
    assert.equal(body.follow, undefined);
    assert.ok(
      !statements.some((sql) => /waitlist_invite_codes/.test(sql)),
      'a status poll must not mint an invite code'
    );
    assert.equal(statements.length, 1, 'a status poll must be a single SELECT');
  });
});

test('an unknown view value returns the full payload rather than an error', async () => {
  await withPublicApi(async (base) => {
    // A stale client, a copied URL or a typo must never turn a working
    // screen into an error; anything that is not the one known value
    // simply means "the whole thing".
    const res = await get(base, PENDING, '?view=everything');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.answers, { group_name: 'saved earlier' });
    assert.ok(body.invite, 'the full payload should still carry the invite block');
    assert.ok(body.oauth, 'the full payload should still carry the oauth block');
    assert.ok(body.follow, 'the full payload should still carry the follow block');
    assert.equal(body.status.state, 'pending');
  });
});

test('the full read names the address, and the poll still does not (#1537)', async () => {
  await withPublicApi(async (base) => {
    // The stage-2 screen is where the mailed confirm link lands, so it is the
    // "you're on the list" surface a returning visitor sees — and it had no
    // way to say which address the signup was made with. The row the route
    // already SELECTs carries it, so this costs no extra query.
    for (const [token, email] of [
      [PENDING, 'pending@example.invalid'],
      [CONFIRMED, 'confirmed@example.invalid'],
      [ADMITTED, 'admitted@example.invalid'],
    ]) {
      const before = statements.length;
      const body = await (await get(base, token)).json();
      assert.equal(body.email, email, `full payload should name ${email}`);
      // The one read a released row adds is the `new_account` check, which
      // is about its account, not its address (tests below).
      const own = statements.slice(before).filter((sql) => !/FROM users/.test(sql));
      assert.ok(own.length <= 3, 'naming the address must not add a query of its own');
    }
  });
});

test('the confirmation poll is unchanged by the address (#1537)', async () => {
  await withPublicApi(async (base) => {
    // ?view=status repeats on a timer while the screen waits for a
    // confirmation to land, and nothing reads an address off it.
    const body = await (await get(base, CONFIRMED, '?view=status')).json();
    assert.equal(body.email, undefined);
    assert.deepEqual(Object.keys(body).sort(), ['admitted', 'ok', 'status']);
    assert.equal(statements.length, 1, 'a status poll must still be a single SELECT');
  });
});

test('an unknown token still 404s, with and without the status view', async () => {
  await withPublicApi(async (base) => {
    // The non-enumeration contract is unchanged: the cheap view must not
    // become a faster oracle than the full read.
    const full = await get(base, UNKNOWN);
    assert.equal(full.status, 404);
    const poll = await get(base, UNKNOWN, '?view=status');
    assert.equal(poll.status, 404);
    const body = await full.json();
    assert.deepEqual(await poll.json(), body);
    // #1537: the refusal must not echo anything back either — the address
    // field exists on the SUCCESS payload only.
    assert.equal(body.email, undefined);
  });
});

// Evan, 12 Oct 2026: a "You're in" link for an account that is still new is
// spent as the page opens (frontend/src/features/auth/landing.tsx), and this
// read is how the page knows, before it spends anything. A boolean, and a
// read only: nothing about the link or a session is touched here.
test('new_account says whether a released row\'s account is still new, and spends nothing', async () => {
  await withPublicApi(async (base) => {
    const reads = [];
    for (const [token, expected] of [[ADMITTED, true], [SET_UP, false], [PENDING, false], [CONFIRMED, false]]) {
      const before = statements.length;
      const body = await (await get(base, token)).json();
      assert.equal(body.new_account, expected, `new_account for ${token[0]}`);
      reads.push(...statements.slice(before));
      const users = statements.slice(before).filter((sql) => /FROM users/.test(sql));
      // Only a released row has a link to spend, so only it is asked about.
      assert.equal(users.length, token === ADMITTED || token === SET_UP ? 1 : 0, `account reads for ${token[0]}`);
    }
    // Spends nothing: no link, no session, no account touched.
    for (const sql of reads) {
      assert.doesNotMatch(sql, /waitlist_release_links|web_signup_sessions|\bsessions\b|UPDATE users|INSERT INTO users/i, sql);
    }
    for (const sql of reads.filter((q) => /FROM users/.test(q))) {
      assert.match(sql, /^\s*SELECT is_admin, password_set, needs_username_choice\s+FROM users\s+WHERE lower\(email\) = lower\(\$1\)\s*$/, 'a plain read, not FOR UPDATE');
    }
  });
});

test('the poll never says new_account, and asks nothing about the account', async () => {
  await withPublicApi(async (base) => {
    const body = await (await get(base, ADMITTED, '?view=status')).json();
    assert.equal(body.new_account, undefined);
    assert.ok(!statements.some((sql) => /FROM users/.test(sql)));
  });
});
