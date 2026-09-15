// POST /api/public/waitlist/status — the read half of check-my-status (#2201).
//
// Every other public waitlist route refuses the membership question. The
// join endpoint is idempotent and says the same thing to a new address and
// a returning one; /resend answers with one frozen body whatever it found;
// /confirm gives a wrong code and an address that was never on the list the
// same 422. That silence had one bad ending: a person who mistyped their
// address on "Check my status" was told a six-digit code was on its way and
// left waiting for a mail nobody sent, because there was nothing to send it
// about.
//
// So this route answers out loud, and the whole of what it is allowed to
// say is pinned here:
//
//   1. THREE distinguishable answers — not on the list, on it and
//      unconfirmed, on it and confirmed — because that distinction IS the
//      feature. A change that collapses them back into one body is not a
//      hardening of this route, it is a removal of it, and these tests are
//      where that shows up.
//   2. Nothing beyond them. more_token is the stage-2 capability and is
//      issued on first join only; invite_code, invited_by, answers, ip and
//      the linked account are nobody's business by address. Confirming an
//      address still means holding the code mailed to it, which is what
//      keeps this a read of public membership rather than a way in.
//   3. It WRITES NOTHING. No code minted, no row touched, no mail sent, so
//      it spends none of the waitlist_code mail budget and cannot invalidate
//      the code already sitting in somebody's inbox. Asserted against the
//      queries the mock pool actually sees, not against the source.
//   4. Its status block is byte-identical to the one POST /confirm returns
//      for the same row. Four surfaces now carry that block (/confirm,
//      /more/:token, the join, and this route) and all four derive it from
//      the one signupStatus() helper — a second derivation is how one row
//      starts being described two ways.
//
// Harness style follows tests/waitlist-resend.test.js: swap src/db/pool for
// an in-memory mock, drop the rate-limits and public-api modules from
// require.cache so each test gets fresh limiter stores, stub the mailer so
// a send is countable, mount publicApiRoutes on a throwaway Express app,
// and talk to it over real HTTP.
//
// Run with: node --test tests/waitlist-status-endpoint.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcrypt');

const TOKEN = 'a'.repeat(48);
const INVITE = 'inv1nv1t3';

// One address per case, so a single mock answers all of them and the
// bodies can be compared against each other.
const STRANGER = 'stranger@example.invalid';
const PENDING = 'pending@example.invalid';
const CONFIRMED = 'confirmed@example.invalid';
const ADMITTED = 'admitted@example.invalid';
const BROKEN = 'broken@example.invalid';

const JOINED_AT = new Date('2026-01-02T03:04:05.000Z');
const CONFIRMED_AT = new Date('2026-01-03T03:04:05.000Z');
const RELEASED_AT = new Date('2026-01-04T03:04:05.000Z');

// The code /confirm is driven with in the parity test. Its bcrypt hash goes
// into the mock's waitlist_verification_codes row, so the real
// bcrypt.compare inside confirmSignupByCode actually succeeds and the
// parity assertion compares two REAL responses rather than two fixtures.
const CODE = '123456';

// The rows as the unique-email lookup returns them: the full state tuple
// getSignupByEmail selects, plus the columns this route must never disclose
// so their absence from the response is a real assertion and not a mock
// that simply never had them.
const ROWS = {
  [PENDING]: {
    id: 1, email: PENDING, submitted_at: JOINED_AT, confirmed_at: null,
    released_at: null, linked_user_id: null, more_token: TOKEN,
    invite_code: INVITE, invited_by: 42, answers: { group_name: 'secret' },
    ip: '203.0.113.9',
  },
  [CONFIRMED]: {
    id: 2, email: CONFIRMED, submitted_at: JOINED_AT, confirmed_at: CONFIRMED_AT,
    released_at: null, linked_user_id: null, more_token: TOKEN,
    invite_code: INVITE, invited_by: null, answers: {}, ip: '203.0.113.9',
  },
  [ADMITTED]: {
    id: 3, email: ADMITTED, submitted_at: JOINED_AT, confirmed_at: CONFIRMED_AT,
    released_at: RELEASED_AT, linked_user_id: 7, more_token: TOKEN,
    invite_code: INVITE, invited_by: null, answers: {}, ip: '203.0.113.9',
  },
};

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// Records every statement so the "writes nothing" contract can be asserted
// against what the route actually asked the database for.
function makeMockPool(seen) {
  return {
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      seen.push({ sql, params });

      // getSignupByEmail — the one indexed lookup both branches make.
      if (/^SELECT id, email, submitted_at, confirmed_at, released_at,[\s\S]*FROM waitlist_signups/.test(sql)) {
        const email = params[0];
        if (email === BROKEN) throw new Error('pool is on fire');
        const row = ROWS[email];
        return { rows: row ? [{ ...row }] : [] };
      }

      // confirmSignupByCode's live-code read, for the parity test only.
      if (/^SELECT id, code_hash, attempts, expires_at FROM waitlist_verification_codes/.test(sql)) {
        const email = params[0];
        if (!ROWS[email]) return { rows: [] };
        return {
          rows: [{
            id: 99,
            code_hash: bcrypt.hashSync(CODE, 10),
            attempts: 0,
            expires_at: new Date(Date.now() + 15 * 60 * 1000),
          }],
        };
      }

      // …and its COALESCE stamp, which returns the same state tuple.
      if (/^UPDATE waitlist_signups SET confirmed_at = COALESCE/.test(sql)) {
        const email = params[0];
        const row = ROWS[email];
        if (!row) return { rows: [] };
        // Already-confirmed rows keep their first timestamp, exactly as the
        // COALESCE does, so the two surfaces are comparing one row's truth.
        return { rows: [{ ...row, confirmed_at: row.confirmed_at || new Date() }] };
      }

      return { rowCount: 0, rows: [] };
    },
  };
}

async function withPublicApi(fn) {
  const poolPath = require.resolve('../src/db/pool');
  const publicApiPath = require.resolve('../src/routes/public-api');
  const rateLimitsPath = require.resolve('../src/middleware/rate-limits');
  const mailerPath = require.resolve('../src/services/topochain/mailer');
  const originalPool = require.cache[poolPath];
  const originalMailer = require.cache[mailerPath];
  const seen = [];
  const mails = [];

  require.cache[poolPath] = {
    exports: { getPool: () => makeMockPool(seen) },
    loaded: true, id: poolPath, filename: poolPath,
    paths: originalPool ? originalPool.paths : [],
  };
  // Every mail this family can send, counted rather than delivered. The
  // route must reach none of them.
  require.cache[mailerPath] = {
    exports: {
      sendWaitlistJoinMail: (...args) => { mails.push({ kind: 'join', args }); },
      sendWaitlistCodeMail: (...args) => { mails.push({ kind: 'code', args }); },
    },
    loaded: true, id: mailerPath, filename: mailerPath,
    paths: originalMailer ? originalMailer.paths : [],
  };
  delete require.cache[rateLimitsPath];
  delete require.cache[publicApiPath];

  let server;
  try {
    const { publicApiRoutes } = require('../src/routes/public-api');
    const app = express();
    app.use(express.json());
    app.use(publicApiRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    await fn(`http://127.0.0.1:${server.address().port}`, { seen, mails });
  } finally {
    if (server) server.close();
    if (originalPool) require.cache[poolPath] = originalPool;
    else delete require.cache[poolPath];
    if (originalMailer) require.cache[mailerPath] = originalMailer;
    else delete require.cache[mailerPath];
    delete require.cache[rateLimitsPath];
    delete require.cache[publicApiPath];
  }
}

function status(base, body) {
  return fetch(`${base}/api/public/waitlist/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── The three answers ────────────────────────────────────────────────

test('an address that is not on the list is told so', async () => {
  await withPublicApi(async (base) => {
    const res = await status(base, { email: STRANGER });
    assert.equal(res.status, 200);
    // The dead end this change exists to remove. `status: null` rather than
    // an empty block: there is no row, so there is no state to describe,
    // and a caller reading `status.confirmed` off a stranger must get
    // nothing rather than `false`.
    assert.deepEqual(await res.json(), {
      ok: true, on_list: false, admitted: false, status: null,
    });
  });
});

test('an address on the list but unconfirmed reads as pending', async () => {
  await withPublicApi(async (base) => {
    const res = await status(base, { email: PENDING });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.on_list, true);
    assert.equal(body.admitted, false);
    assert.equal(body.status.state, 'pending');
    assert.equal(body.status.confirmed, false);
    assert.equal(body.status.has_account, false);
    assert.equal(body.status.joined_at, JOINED_AT.toISOString());
    assert.equal(body.status.confirmed_at, null);
    assert.equal(body.status.admitted_at, null);
  });
});

test('a confirmed address reads as confirmed, which is what skips the code step', async () => {
  await withPublicApi(async (base) => {
    const res = await status(base, { email: CONFIRMED });
    const body = await res.json();
    assert.equal(body.on_list, true);
    assert.equal(body.admitted, false);
    assert.equal(body.status.state, 'confirmed');
    assert.equal(body.status.confirmed, true);
    assert.equal(body.status.confirmed_at, CONFIRMED_AT.toISOString());
    // The screen branches on exactly this field to skip the send, so a
    // regression that stopped reporting it would strand a confirmed reader
    // back on a code box for a mail they do not need.
    assert.equal(body.status.confirmed, true);
  });
});

test('a released row reads as admitted, not merely confirmed', async () => {
  await withPublicApi(async (base) => {
    const res = await status(base, { email: ADMITTED });
    const body = await res.json();
    // signupStatus orders most-advanced first: a released row carries a
    // confirmed_at too, and describing it as `confirmed` would hide the
    // one state that has a button behind it.
    assert.equal(body.status.state, 'admitted');
    assert.equal(body.status.admitted, true);
    // Mirrored at the top level exactly as /more/:token does it, so a
    // caller reading one field needs no knowledge of the block's shape.
    assert.equal(body.admitted, true);
    assert.equal(body.status.admitted_at, RELEASED_AT.toISOString());
    // Redeemed into an account. Already in every signupStatus payload;
    // dropping it here would make this the one surface that describes a
    // row differently.
    assert.equal(body.status.has_account, true);
  });
});

test('a malformed address is refused in the words /resend uses', async () => {
  await withPublicApi(async (base) => {
    for (const body of [{ email: 'not-an-address' }, { email: '' }, {}, { email: 42 }]) {
      const res = await status(base, body);
      assert.equal(res.status, 422, `${JSON.stringify(body)} should be refused`);
      assert.deepEqual(await res.json(), { error: 'A valid email address is required.' });
    }
  });
});

test('a pool failure is a 500 and says nothing about the address', async () => {
  await withPublicApi(async (base) => {
    const res = await status(base, { email: BROKEN });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Internal server error' });
  });
});

// ─── What it must never say ───────────────────────────────────────────

test('no answer carries a capability, an invite, the survey, or an email echo', async () => {
  await withPublicApi(async (base) => {
    for (const email of [STRANGER, PENDING, CONFIRMED, ADMITTED]) {
      const res = await status(base, { email });
      const text = await res.text();
      // Read as raw text, not as a parsed object: a field nested somewhere
      // unexpected is still a disclosure, and the mock rows carry every one
      // of these so their absence is the route's doing.
      assert.ok(!text.includes(TOKEN), `more_token leaked for ${email}`);
      assert.ok(!text.includes(INVITE), `invite_code leaked for ${email}`);
      assert.doesNotMatch(text, /more_token|invite|answers|invited_by|linked_user|linked_username|"ip"/,
        `a withheld field is named in the body for ${email}`);
      assert.ok(!text.includes('secret'), `survey answers leaked for ${email}`);
      assert.ok(!text.includes('203.0.113.9'), `the join IP leaked for ${email}`);
      // Not even the address that was submitted: echoing it back is how a
      // response body becomes a reflector, and the caller already has it.
      assert.ok(!text.includes(email), `the submitted address was echoed for ${email}`);
    }
  });
});

// ─── What it must never do ────────────────────────────────────────────

test('it writes nothing, mints nothing and mails nothing', async () => {
  await withPublicApi(async (base, { seen, mails }) => {
    for (const email of [STRANGER, PENDING, CONFIRMED, ADMITTED]) {
      await status(base, { email });
    }
    // The whole route is one indexed read per request and nothing else.
    assert.equal(seen.length, 4, 'one query per request, no more');
    for (const { sql } of seen) {
      assert.match(sql, /^SELECT id, email, submitted_at, confirmed_at, released_at,/);
      assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/,
        'the status read must never write');
      assert.doesNotMatch(sql, /waitlist_verification_codes/,
        'and must never touch the code table: issuing deletes the live code');
    }
    assert.deepEqual(mails, [], 'no mail, so none of the waitlist_code budget');
  });
});

test('both branches make the SAME single lookup, so the clock separates nothing', async () => {
  await withPublicApi(async (base, { seen }) => {
    await status(base, { email: STRANGER });
    const absent = seen.splice(0);
    await status(base, { email: CONFIRMED });
    const present = seen.splice(0);
    // Timing is the one side channel a response body cannot close. An extra
    // query, a cache, or an await on only the on-list path would give back
    // by the clock what the words already say.
    assert.equal(absent.length, 1);
    assert.equal(present.length, 1);
    assert.equal(absent[0].sql, present[0].sql);
  });
});

// ─── One derivation, four surfaces ────────────────────────────────────

test('the block is byte-identical to the one POST /confirm returns', async () => {
  await withPublicApi(async (base) => {
    // Parity on a row that is ALREADY confirmed, because that is the row
    // both surfaces can describe: /confirm's COALESCE leaves its
    // confirmed_at alone, so the two reads are of one unchanging truth.
    const read = await status(base, { email: CONFIRMED });
    const confirm = await fetch(`${base}/api/public/waitlist/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: CONFIRMED, code: CODE }),
    });
    assert.equal(confirm.status, 200, 'the parity fixture must actually confirm');

    const fromRead = await read.json();
    const fromConfirm = await confirm.json();
    // Serialized, not deep-equalled: key ORDER is observable over the wire,
    // and two blocks that merely deep-equal can still be told apart. Both
    // come from signupStatus(), so they must be the same bytes.
    assert.equal(JSON.stringify(fromRead.status), JSON.stringify(fromConfirm.status));
    assert.equal(fromRead.admitted, fromConfirm.admitted);
    // The difference between the two surfaces is the capability, and it
    // belongs to the one that proved possession of the mailbox.
    assert.equal(fromConfirm.more_token, TOKEN);
    assert.equal('more_token' in fromRead, false);
  });
});
