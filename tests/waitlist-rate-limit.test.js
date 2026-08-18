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
const EMAIL = 'journey@example.invalid';

function makeMockPool() {
  return {
    async query(sql, params) {
      if (/INSERT INTO waitlist_signups/.test(sql)) {
        return { rows: [{ id: 7, more_token: TOKEN, created: true }] };
      }
      if (/SELECT id, email, answers FROM waitlist_signups/.test(sql)) {
        return params[0] === TOKEN
          ? { rows: [{ id: 7, email: EMAIL, answers: {} }] }
          : { rows: [] };
      }
      if (/UPDATE waitlist_signups[\s\S]*SET confirmed_at = COALESCE/.test(sql)) {
        return { rows: [{ id: 7, email: EMAIL, confirmed_at: new Date() }] };
      }
      if (/UPDATE waitlist_signups[\s\S]*SET answers/.test(sql)) {
        return { rows: [{ id: 7, answers: {} }] };
      }
      // The join flow reads/writes more than the shapes above; anything
      // else answers empty rather than failing the request mid-limiter.
      return { rows: [] };
    },
  };
}

async function withPublicApi(fn) {
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
    app.use(publicApiRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
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

test('the token routes are still bounded against scanning', async () => {
  await withPublicApi(async (base) => {
    let limited = null;
    for (let i = 0; i < 61; i++) {
      const res = await fetch(`${base}/api/public/waitlist/more/${TOKEN}`);
      if (res.status === 429) { limited = { at: i + 1, res }; break; }
    }
    assert.ok(limited, 'token routes must eventually rate-limit');
    assert.equal(limited.at, 61, 'token bucket should allow 60 per window');
    const body = await limited.res.json();
    // The screen shows this retry hint verbatim, so it has to exist.
    assert.ok(Number(body.retryAfterSeconds) > 0);
  });
});
