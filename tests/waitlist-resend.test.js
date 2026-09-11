// POST /api/public/waitlist/resend — the non-enumeration contract.
//
// The six-digit confirmation code expires fifteen minutes after a join, and
// until this endpoint there was no way to ask for another one: a returning
// visitor on a new device could only submit the join form again, which is
// idempotent, so it minted nothing, sent nothing, and told them a code was
// on its way regardless.
//
// The property that matters most here is NOT that a code goes out. It is
// that the answer is the same one in every case. This endpoint is public and
// unauthenticated, and it takes an email address, so any difference between
// its branches — a status code, a word, a timing hint carried in the body —
// turns it into a membership oracle for the waitlist. Whether an address is
// already confirmed is disclosed in the MAIL instead, which only the address
// itself receives.
//
// #1538 widened what the mail is FOR without touching any of that. A
// confirmed address used to get no code at all, which made "check my
// status" impossible from a device that had never joined: the only thing
// this endpoint would send it was a stage-2 survey link. Every branch now
// mints, and the four bodies are still one frozen object.
//
// Harness style follows tests/waitlist-rate-limit.test.js: swap src/db/pool
// for an in-memory mock, drop the rate-limits and public-api modules from
// require.cache so each test gets fresh limiter stores, mount
// publicApiRoutes on a throwaway Express app, and talk to it over HTTP.
//
// Run with: node --test tests/waitlist-resend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const TOKEN = 'a'.repeat(48);

// The four branches, one address each, so a single mock can answer all of
// them and the bodies can be compared against each other.
const PENDING = 'pending@example.invalid';
const CONFIRMED = 'confirmed@example.invalid';
const STRANGER = 'stranger@example.invalid';
const BROKEN = 'broken@example.invalid';

function makeMockPool() {
  return {
    async query(sql, params) {
      if (/SELECT id, email, confirmed_at, more_token[\s\S]*FROM waitlist_signups/.test(sql)) {
        const email = params[0];
        if (email === PENDING) {
          return { rows: [{ id: 1, email, confirmed_at: null, more_token: TOKEN }] };
        }
        if (email === CONFIRMED) {
          return { rows: [{ id: 2, email, confirmed_at: new Date(), more_token: TOKEN }] };
        }
        if (email === BROKEN) throw new Error('pool is on fire');
        return { rows: [] };
      }
      // issueVerificationCode's write.
      if (/waitlist_verification_codes/.test(sql)) return { rows: [{ id: 1 }] };
      // joinWaitlist's ON CONFLICT DO NOTHING insert. rowCount 0 is a
      // RE-join: the row was already there, so nothing was written.
      if (/INSERT INTO waitlist_signups/.test(sql)) {
        return { rowCount: params[0] === PENDING ? 0 : 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

async function withPublicApi(fn, extraConfig = {}) {
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

function resend(base, email) {
  return fetch(`${base}/api/public/waitlist/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

test('every branch answers with the same status and the same bytes', async () => {
  await withPublicApi(async (base) => {
    const seen = [];
    for (const email of [PENDING, CONFIRMED, STRANGER, BROKEN]) {
      const res = await resend(base, email);
      seen.push({ status: res.status, body: await res.text() });
    }
    // Compared as raw text, not as parsed objects: key ORDER is observable
    // over the wire too, and a body that merely deep-equals another can
    // still be told apart by anyone counting bytes.
    for (const answer of seen) {
      assert.equal(answer.status, seen[0].status);
      assert.equal(answer.body, seen[0].body);
    }
    assert.equal(seen[0].status, 200);
    const body = JSON.parse(seen[0].body);
    assert.equal(body.ok, true);
    assert.equal(body.cooldown_seconds, 60);
    assert.match(body.message, /six-digit code is on its way/i);
    // It must not claim the address "still needs confirming" (#1538): a
    // confirmed address is now a first-class caller here, so that clause
    // would be false for the very branch check-my-status runs, and a false
    // clause in a shared body is a hint about which branch answered.
    assert.doesNotMatch(body.message, /needs confirming/i);
    // The words must not resolve the question either. "If that address" is
    // load-bearing copy, not hedging.
    assert.match(body.message, /if that address/i);
  });
});

test('a database failure is still a 200, not a 500', async () => {
  // A 500 for one address and a 200 for another is the oracle again, and it
  // is the easiest one to reintroduce: the natural shape of the handler is
  // to let the read throw.
  await withPublicApi(async (base) => {
    const res = await resend(base, BROKEN);
    assert.equal(res.status, 200);
  });
});

test('a malformed address is refused before any lookup happens', async () => {
  // The one branch that DOES answer differently, and it may: "that is not
  // an email address" is a statement about the input, not about the list.
  await withPublicApi(async (base) => {
    for (const bad of ['', 'not-an-email', 'a@', '   ']) {
      const res = await resend(base, bad);
      assert.equal(res.status, 422, `expected 422 for ${JSON.stringify(bad)}`);
    }
  });
});

test('both a pending and a confirmed address are mailed a fresh code (#1538)', async () => {
  // The mail is the ONLY channel that distinguishes the two, and it goes to
  // the address itself, so it discloses nothing to a third party.
  //
  // The confirmed branch is the one #1538 fixed. It used to return before
  // minting anything and mail a stage-2 survey link instead, which is
  // backwards: anyone asking to read their status is by definition already
  // confirmed, so the branch that most needs a code was the only one that
  // never got one.
  const seen = [];
  await withPublicApi(async (base) => {
    await resend(base, PENDING);
    await resend(base, CONFIRMED);
    await resend(base, STRANGER);
  }, { mailTransport: { send: async (m) => { seen.push(m); } } });

  assert.equal(seen.length, 2, 'an address that is not on the list is mailed nothing');

  // Unconfirmed: a code plus the one-click confirm link, unchanged.
  assert.equal(seen[0].kind, 'waitlist_code');
  assert.equal(seen[0].confirmed, false);
  assert.match(seen[0].code, /^[0-9]{6}$/);
  assert.match(seen[0].confirmUrl, /\/api\/public\/waitlist\/confirm\/a{48}$/);

  // Confirmed: a code as well, flagged so the template picks the
  // status-code wording, and NO confirm link — there is nothing left to
  // confirm, and a capability token in a mail nobody asked for is a
  // capability handed to whoever the mailbox forwards to.
  assert.equal(seen[1].kind, 'waitlist_code');
  assert.equal(seen[1].confirmed, true);
  assert.match(seen[1].code, /^[0-9]{6}$/);
  assert.equal(seen[1].confirmUrl, null);
  // The status URL is a query spelling, never a fragment: the link
  // rewriters mail providers apply drop everything after the `#` (#1545).
  assert.match(seen[1].statusUrl, /\/\?status=1$/);
  assert.doesNotMatch(seen[1].statusUrl, /#/);

  // And the two codes are different values, because each call mints its
  // own and deletes any predecessor.
  assert.notEqual(seen[0].code, seen[1].code);
});

test('a confirmed address falls back to the survey link only when minting fails', async () => {
  // The degradation, kept from the old behaviour: if the code cannot be
  // written we still send something the address can act on rather than
  // going silent. It is the fallback now, not the rule.
  const seen = [];
  const poolPath = require.resolve('../src/db/pool');
  const publicApiPath = require.resolve('../src/routes/public-api');
  const rateLimitsPath = require.resolve('../src/middleware/rate-limits');
  const originalPool = require.cache[poolPath];
  const base = makeMockPool();
  const brokenMint = {
    async query(sql, params) {
      if (/INSERT INTO waitlist_verification_codes/.test(sql)) {
        throw new Error('codes table is on fire');
      }
      return base.query(sql, params);
    },
  };
  require.cache[poolPath] = {
    exports: { getPool: () => brokenMint },
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
    app.use(publicApiRoutes({
      databaseUrl: 'postgres://fake/fake',
      env: 'test',
      mailTransport: { send: async (m) => { seen.push(m); } },
    }));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await resend(origin, CONFIRMED)).status, 200);
    assert.equal((await resend(origin, PENDING)).status, 200);
  } finally {
    if (server) server.close();
    if (originalPool) require.cache[poolPath] = originalPool;
    else delete require.cache[poolPath];
    delete require.cache[rateLimitsPath];
    delete require.cache[publicApiPath];
  }

  assert.equal(seen.length, 1, 'only the confirmed branch has a fallback to send');
  assert.equal(seen[0].code, null);
  assert.match(seen[0].statusUrl, /#more\/a{48}$/);
});

test('the resend limiter is keyed per address, not shared across them', async () => {
  // Six requests for one address exhaust its bucket; a seventh for a
  // different address must not be caught by it. The per-IP limiter is
  // deliberately looser than 6, or this test would fail on that instead.
  await withPublicApi(async (base) => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await resend(base, PENDING)).status);
    }
    assert.equal(statuses[0], 200);
    assert.equal(statuses[5], 429, 'the sixth request for one address is throttled');
    assert.equal((await resend(base, CONFIRMED)).status, 200);
  });
});

test('a re-join sends a fresh code instead of claiming it sent one', async () => {
  // The bug behind the whole feature. joinWaitlist is idempotent by email,
  // so a second submit wrote nothing, minted nothing and mailed nothing —
  // while the screen said "we sent a six-digit code to you@…" on any 200.
  // The response is unchanged (it has to be: the join endpoint is public and
  // must not disclose membership either); what changed is that the claim is
  // now true.
  const seen = [];
  await withPublicApi(async (base) => {
    const res = await fetch(`${base}/api/public/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: PENDING }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // A re-join still carries no stage-2 token: that belongs to the row's
    // first creation, and handing one out here would leak that the address
    // was already on the list.
    assert.equal(body.more_token || null, null);
  }, { mailTransport: { send: async (m) => { seen.push(m); } } });

  assert.equal(seen.length, 1, 'exactly one mail, and it is not a second welcome');
  assert.equal(seen[0].kind, 'waitlist_code');
  assert.match(seen[0].code, /^[0-9]{6}$/);
});
