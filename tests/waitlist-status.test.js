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

test('an unknown token still 404s, with and without the status view', async () => {
  await withPublicApi(async (base) => {
    // The non-enumeration contract is unchanged: the cheap view must not
    // become a faster oracle than the full read.
    const full = await get(base, UNKNOWN);
    assert.equal(full.status, 404);
    const poll = await get(base, UNKNOWN, '?view=status');
    assert.equal(poll.status, 404);
    assert.deepEqual(await poll.json(), await full.json());
  });
});
