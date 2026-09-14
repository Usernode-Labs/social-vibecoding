// Tests for the waitlist rate-limit split (#1296).
//
// One real journey — join, save the stage-2 survey, click the emailed
// confirm link, land back on the survey — makes 5+ requests from one IP.
// The 5/15-min waitlist-join bucket used to guard every waitlist route, so
// the user's own confirm click came back 429 and the #more screen called
// their link invalid. The join POST keeps the tight bucket (it is the
// anonymous write worth throttling); the token routes (confirm, more
// read/save) sit behind the looser waitlist-token bucket, whose only job
// is bounding token scanning.
//
// Harness style follows tests/platform-mail.test.js: swap src/db/pool for
// an in-memory mock, delete the rate-limits module from require.cache so
// every test gets fresh limiter stores (they are module-level singletons
// and every test shares 127.0.0.1), mount publicApiRoutes on a throwaway
// Express app, and talk to it over real HTTP.
//
// Run with: node --test tests/waitlist-rate-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const TOKEN = 'a'.repeat(48);
const OTHER_TOKEN = 'b'.repeat(48);
const EMAIL = 'journey@example.invalid';

// Every row the mock answers with, keyed by the token that reaches it. Two
// so the per-token buckets can be shown not to share (#1296 follow-up).
const ROWS = {
  [TOKEN]: { id: 7, email: EMAIL, answers: {}, submitted_at: new Date(), confirmed_at: null, released_at: null, linked_user_id: null },
  [OTHER_TOKEN]: { id: 8, email: 'other@example.invalid', answers: {}, submitted_at: new Date(), confirmed_at: null, released_at: null, linked_user_id: null },
};

function makeMockPool() {
  return {
    async query(sql, params) {
      if (/INSERT INTO waitlist_signups/.test(sql)) {
        return { rows: [{ id: 7, more_token: TOKEN, created: true }] };
      }
      if (/SELECT id, email, answers[\s\S]*FROM waitlist_signups/.test(sql)) {
        const row = ROWS[params[0]];
        return row ? { rows: [row] } : { rows: [] };
      }
      if (/UPDATE waitlist_signups[\s\S]*SET confirmed_at = COALESCE/.test(sql)) {
        return { rows: [{ id: 7, email: EMAIL, confirmed_at: new Date() }] };
      }
      // mergeMoreAnswers gates this on the SELECT above, so an unknown
      // token never reaches here.
      if (/UPDATE waitlist_signups[\s\S]*SET answers/.test(sql)) {
        return { rows: [{ id: 7, answers: {} }] };
      }
      // The join flow reads/writes more than the shapes above; anything
      // else answers empty rather than failing the request mid-limiter.
      return { rows: [] };
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

test('a full signup journey from one IP never hits a 429', async () => {
  await withPublicApi(async (base) => {
    const join = await fetch(`${base}/api/public/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: EMAIL,
        made_url: 'https://example.invalid/thing',
        discovery_source: 'other',
      }),
    });
    assert.notEqual(join.status, 429);

    // The journey the E2E test actually took: survey read + save, the
    // emailed confirm click, then the redirect target loading the survey
    // again — plus generous headroom for reloads and retries.
    for (let i = 0; i < 10; i++) {
      const read = await fetch(`${base}/api/public/waitlist/more/${TOKEN}`);
      assert.equal(read.status, 200, `more read #${i + 1} rate-limited`);
      const save = await fetch(`${base}/api/public/waitlist/more/${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_name: 'journey test' }),
      });
      assert.equal(save.status, 200, `more save #${i + 1} rate-limited`);
    }
    const confirm = await fetch(`${base}/api/public/waitlist/confirm/${TOKEN}`, {
      redirect: 'manual',
    });
    assert.equal(confirm.status, 302);
    assert.equal(confirm.headers.get('location'), `/#more/${TOKEN}`);
  });
});

test('the join POST keeps its own tight bucket', async () => {
  await withPublicApi(async (base) => {
    const join = () => fetch(`${base}/api/public/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: EMAIL,
        made_url: 'https://example.invalid/thing',
        discovery_source: 'other',
      }),
    });
    for (let i = 0; i < 5; i++) {
      assert.notEqual((await join()).status, 429, `join #${i + 1} rate-limited early`);
    }
    const sixth = await join();
    assert.equal(sixth.status, 429, 'the 6th join in a window must be limited');
    const body = await sixth.json();
    assert.match(body.error, /Too many signups/);
    // Being join-limited must not lock the user out of their token routes.
    const read = await fetch(`${base}/api/public/waitlist/more/${TOKEN}`);
    assert.equal(read.status, 200, 'join bucket leaked into the token routes');
  });
});

test('two tokens from one address do not share a budget', async () => {
  await withPublicApi(async (base) => {
    // The old bucket was per-IP, so an office, a carrier NAT or a school
    // put every stage-2 visitor into ONE 60-request budget: person A's
    // reload could throttle person B's link. 80 reads is past that old
    // ceiling on either token alone.
    for (let i = 0; i < 80; i++) {
      const a = await fetch(`${base}/api/public/waitlist/more/${TOKEN}`);
      assert.equal(a.status, 200, `token A read #${i + 1} rate-limited`);
      const b = await fetch(`${base}/api/public/waitlist/more/${OTHER_TOKEN}`);
      assert.equal(b.status, 200, `token B read #${i + 1} rate-limited`);
    }
  });
});

test('a 30-second poll plus saves and a confirm never 429s', async () => {
  await withPublicApi(async (base) => {
    // The #more screen re-reads its own status while it waits for a
    // confirmation to land. Half an hour of that at 30s intervals is 60
    // reads, which is exactly where the old ceiling sat.
    for (let i = 0; i < 60; i++) {
      const poll = await fetch(`${base}/api/public/waitlist/more/${TOKEN}?view=status`);
      assert.equal(poll.status, 200, `poll #${i + 1} rate-limited`);
    }
    for (let i = 0; i < 10; i++) {
      const save = await fetch(`${base}/api/public/waitlist/more/${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_name: 'polling test' }),
      });
      assert.equal(save.status, 200, `save #${i + 1} rate-limited`);
    }
    const confirm = await fetch(`${base}/api/public/waitlist/confirm/${TOKEN}`, {
      redirect: 'manual',
    });
    assert.equal(confirm.status, 302, 'the confirm click was rate-limited');
  });
});

test('unknown tokens hit the scan limiter, successful reads never feed it', async () => {
  await withPublicApi(async (base) => {
    // Per-token keying alone is no defence against enumeration: a scanner
    // presents a DIFFERENT token every request and would get a fresh
    // bucket each time. The failure-only IP bucket is what bounds it.
    //
    // Spend a large amount of honest traffic from this address first. If
    // successes counted, these alone would exhaust the 40-failure budget
    // and the guesses below would be refused immediately.
    for (let i = 0; i < 60; i++) {
      const real = await fetch(`${base}/api/public/waitlist/more/${TOKEN}`);
      assert.equal(real.status, 200, `honest read #${i + 1} rate-limited`);
    }

    let limitedAt = null;
    for (let i = 0; i < 41; i++) {
      const guess = i.toString(16).padStart(48, 'f');
      const res = await fetch(`${base}/api/public/waitlist/more/${guess}`);
      if (res.status === 429) { limitedAt = i + 1; break; }
      assert.equal(res.status, 404, `guess #${i + 1} should 404`);
    }
    assert.equal(limitedAt, 41, 'scanning must be limited after 40 failures');
  });
});

test('the code-confirm endpoint is bucketed per address, not per IP', async () => {
  await withPublicApi(async (base) => {
    const attempt = (email) => fetch(`${base}/api/public/waitlist/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: '000000' }),
    });
    // Six digits against one known address is a small space, so this
    // route gets a tighter bound than the 40-failure scan bucket.
    let limitedAt = null;
    for (let i = 0; i < 11; i++) {
      const res = await attempt('victim@example.invalid');
      if (res.status === 429) { limitedAt = i + 1; break; }
    }
    assert.equal(limitedAt, 11, 'code guessing must be limited after 10 tries');
  });
});

test('an unkeyed join is unchanged at 5 per window', async () => {
  await withPublicApi(async (base) => {
    const join = (headers = {}) => fetch(`${base}/api/public/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        email: EMAIL,
        made_url: 'https://example.invalid/thing',
        discovery_source: 'other',
      }),
    });
    for (let i = 0; i < 5; i++) {
      assert.notEqual((await join()).status, 429, `join #${i + 1} rate-limited early`);
    }
    assert.equal((await join()).status, 429);
    // A key the server does not know must degrade to the anonymous
    // bucket, not error: a partner's stale key should cost them the
    // higher ceiling, not break their form.
    const wrong = await join({ 'X-Waitlist-Client-Key': 'not-a-real-key' });
    assert.equal(wrong.status, 429, 'a wrong key must not buy a fresh bucket');
  });
});

test('a trusted integrator gets a client ceiling instead of the IP bucket', async () => {
  await withPublicApi(async (base) => {
    const join = (headers) => fetch(`${base}/api/public/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        email: EMAIL,
        made_url: 'https://example.invalid/thing',
        discovery_source: 'other',
      }),
    });
    // Well past the anonymous 5: an agency proxying real people through
    // one server address used to be refused on the sixth of them.
    for (let i = 0; i < 40; i++) {
      const res = await join({ 'X-Waitlist-Client-Key': 's3cret' });
      assert.notEqual(res.status, 429, `keyed join #${i + 1} rate-limited`);
    }

    // With a forwarded visitor address, that VISITOR is still capped at
    // 5 — a key raises the client's ceiling, it does not make any one
    // person unlimited.
    const visitor = { 'X-Waitlist-Client-Key': 's3cret', 'X-Waitlist-Client-IP': '203.0.113.7' };
    for (let i = 0; i < 5; i++) {
      assert.notEqual((await join(visitor)).status, 429, `visitor join #${i + 1} rate-limited`);
    }
    assert.equal((await join(visitor)).status, 429, 'one forwarded visitor must still cap at 5');

    // A different visitor behind the same key is unaffected.
    const other = { 'X-Waitlist-Client-Key': 's3cret', 'X-Waitlist-Client-IP': '203.0.113.8' };
    assert.notEqual((await join(other)).status, 429, 'the cap leaked across forwarded addresses');

    // A key that does not match any configured secret is not an error, it
    // is simply anonymous: a partner whose key was rotated out loses the
    // higher ceiling and lands back in the ordinary 5-per-address bucket.
    const stale = { 'X-Waitlist-Client-Key': 'rotated-out' };
    let anonAt = null;
    for (let i = 0; i < 6; i++) {
      const res = await join(stale);
      assert.notEqual(res.status, 500, 'a wrong key must never error');
      if (res.status === 429) { anonAt = i + 1; break; }
    }
    assert.equal(anonAt, 6, 'a wrong key must fall back to the anonymous bucket');
  }, { waitlistIntegrationKeys: 'acme:s3cret,partner-two:other-secret' });
});
