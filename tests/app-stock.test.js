// The stock photo search route for apps, answering with fixed samples
// (request #7042, the first part of #6457).
//
// Covers src/routes/app-stock.js and src/services/stock-sample.js:
//   • who may call: the app's token plus a signed-in person's token, or that
//     person's token alone (the path a staging preview uses), and nothing
//     else; a token minted for another app is refused;
//   • the answer: six sample rows in the shape real results will have, marked
//     `sample: true`, safe search on, the same whatever was typed, with no
//     real photographer and no link off example.com;
//   • input rules: q, provider and page are refused with their own codes,
//     perPage is clamped;
//   • the limit: 60 searches a minute for one person in one app, and one
//     person reaching it does not stop the next;
//   • nothing is read from the environment or sent out: the route's sources
//     name no key and make no request.
//
// Harness: the same shape as tests/app-platform-members.test.js (stubbed
// logger, an in-memory pool installed before the route loads, real HTTP on
// loopback, real platform-minted RS256 identities).
//
// Run with: node --test tests/app-stock.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const APP_TOKEN = 'd'.repeat(64);
const APP_ID = 21;
const USERS = [1004, 1005, 1006, 1007];

const pool = {
  async query(sql, params = []) {
    const s = String(sql);
    if (/SELECT id FROM users WHERE id = \$1/.test(s)) {
      return { rows: USERS.includes(params[0]) ? [{ id: params[0] }] : [] };
    }
    if (/FROM apps WHERE llm_proxy_token/.test(s)) {
      return {
        rows: params[0] === APP_TOKEN
          ? [{ id: APP_ID, slug: 'photo-wall-1a2b3c', llm_proxy_token: APP_TOKEN }]
          : [],
      };
    }
    if (/FROM apps WHERE id = \$1/.test(s)) {
      return { rows: params[0] === APP_ID ? [{ id: APP_ID, slug: 'photo-wall-1a2b3c' }] : [] };
    }
    return { rows: [], rowCount: 0 };
  },
};

const poolMod = require('../src/db/pool');
poolMod.getPool = () => pool;

const appStockRoutes = require('../src/routes/app-stock');
const {
  STOCK_PROVIDERS, STOCK_ERRORS, STOCK_SAMPLE,
} = require('../src/services/stock-sample');
const { trustedProxyClientIp } = require('../src/services/client-ip');
const express = require('express');

let server;
test.before(async () => {
  const app = express();
  app.set('trust proxy', false);
  app.use(trustedProxyClientIp({
    hostname: 'caddy.test',
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  }));
  app.use(appStockRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});
test.after(() => server?.close());

function identity(userId, appId = APP_ID) {
  return platformJwt.signAppIdentityToken({ appId, user: { id: userId, username: `person_${userId}` } });
}

async function search(query, { appToken = APP_TOKEN, userToken = identity(1004) } = {}) {
  const headers = {};
  if (userToken) headers['x-usernode-user-token'] = userToken;
  if (appToken) headers['x-usernode-app-token'] = appToken;
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}/api/app-stock/v1/search${query}`, { headers }
  );
  return { status: res.status, body: await res.json() };
}

const ROW_FIELDS = [
  'height', 'id', 'license', 'originalUrl', 'photographer', 'photographerUrl',
  'previewUrl', 'provider', 'sourcePageUrl', 'thumbUrl', 'width',
];

// ── Who may call ────────────────────────────────────────────────────────

test('no tokens is refused as missing_app_token', async () => {
  const { status, body } = await search('?q=lake', { appToken: null, userToken: null });
  assert.equal(status, 401);
  assert.equal(body.code, 'missing_app_token');
});

test('an app token with no person is refused as missing_user_token', async () => {
  const { status, body } = await search('?q=lake', { userToken: null });
  assert.equal(status, 401);
  assert.equal(body.code, 'missing_user_token');
});

test('an unknown app token is refused as bad_app_token', async () => {
  const { status, body } = await search('?q=lake', { appToken: 'e'.repeat(64) });
  assert.equal(status, 401);
  assert.equal(body.code, 'bad_app_token');
});

test('a person token minted for another app is refused as bad_user_token', async () => {
  const { status, body } = await search('?q=lake', { userToken: identity(1004, 99) });
  assert.equal(status, 401);
  assert.equal(body.code, 'bad_user_token');
  assert.equal(body.results, undefined);
});

test('a person who no longer exists is refused', async () => {
  const { status, body } = await search('?q=lake', { userToken: identity(4242) });
  assert.equal(status, 401);
  assert.equal(body.code, 'bad_user_token');
});

// ── The answer ──────────────────────────────────────────────────────────

test('an app and a signed-in person get the six samples, marked as samples', async () => {
  const { status, body } = await search('?q=lake');
  assert.equal(status, 200);
  assert.deepEqual({ ...body, results: null }, {
    ok: true,
    sample: true,
    safesearch: true,
    query: 'lake',
    provider: 'all',
    page: 1,
    perPage: 15,
    totalResults: 6,
    hasMore: false,
    results: null,
  });
  assert.equal(body.results.length, 6);
  assert.deepEqual(body.results, JSON.parse(JSON.stringify(STOCK_SAMPLE)));
});

test('a staging preview (the person token alone) gets the same answer', async () => {
  const preview = await search('?q=lake', { appToken: null });
  const live = await search('?q=lake');
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body, live.body);
});

test('every row has exactly the eleven fields, on example.com, with real sizes', async () => {
  const { body } = await search('?q=lake');
  const ids = new Set();
  for (const row of body.results) {
    assert.deepEqual(Object.keys(row).sort(), ROW_FIELDS);
    assert.ok(STOCK_PROVIDERS.includes(row.provider));
    assert.match(row.id, new RegExp(`^${row.provider}:sample-\\d+$`));
    ids.add(row.id);
    for (const key of ['thumbUrl', 'previewUrl', 'originalUrl', 'photographerUrl', 'sourcePageUrl']) {
      const url = new URL(row[key]);
      assert.equal(url.protocol, 'https:', key);
      assert.equal(url.hostname, 'example.com', key);
      assert.ok(url.pathname.startsWith('/stock-sample/'), key);
    }
    for (const key of ['width', 'height']) {
      assert.ok(Number.isInteger(row[key]) && row[key] > 0, key);
    }
    assert.equal(row.license, row.provider === 'pexels' ? 'Pexels License' : 'Pixabay Content License');
  }
  assert.equal(ids.size, 6);
});

test('nobody real is credited: every photographer is a Sample Photographer', async () => {
  const { body } = await search('?q=lake');
  for (const row of body.results) assert.match(row.photographer, /^Sample Photographer [A-Z][a-z]+$/);
  assert.equal(new Set(body.results.map((r) => r.photographer)).size, 6);
});

test('the words typed do not change the results, and come back trimmed', async () => {
  const a = await search('?q=lake');
  const b = await search(`?q=${encodeURIComponent('  red bicycle  ')}`);
  assert.equal(b.status, 200);
  assert.equal(b.body.query, 'red bicycle');
  assert.deepEqual(b.body.results, a.body.results);
});

test('naming one service returns only its samples: four Pexels, two Pixabay', async () => {
  const pexels = await search('?q=lake&provider=pexels');
  assert.equal(pexels.body.provider, 'pexels');
  assert.equal(pexels.body.totalResults, 4);
  assert.deepEqual([...new Set(pexels.body.results.map((r) => r.provider))], ['pexels']);

  const pixabay = await search('?q=lake&provider=pixabay');
  assert.equal(pixabay.body.totalResults, 2);
  assert.equal(pixabay.body.results.length, 2);
  assert.deepEqual([...new Set(pixabay.body.results.map((r) => r.provider))], ['pixabay']);

  const all = await search('?q=lake&provider=all');
  assert.equal(all.body.totalResults, 6);
});

// ── Input rules ─────────────────────────────────────────────────────────

test('a missing, blank, repeated or 101-character q is invalid_query', async () => {
  for (const query of ['', '?q=', '?q=%20%20', '?q=a&q=b', `?q=${'x'.repeat(101)}`]) {
    const { status, body } = await search(query);
    assert.equal(status, 400, query);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'invalid_query', query);
    assert.equal(body.results, undefined);
  }
  assert.equal((await search(`?q=${'x'.repeat(100)}`)).status, 200);
});

test('an unknown service is invalid_provider', async () => {
  for (const query of ['?q=lake&provider=flickr', '?q=lake&provider=Pexels', '?q=lake&provider=pexels&provider=pixabay']) {
    const { status, body } = await search(query);
    assert.equal(status, 400, query);
    assert.equal(body.code, 'invalid_provider', query);
  }
});

test('page 0, a negative page and a page that is not a whole number are invalid_page', async () => {
  for (const page of ['0', '-1', '1.5', '2abc', 'two']) {
    const { status, body } = await search(`?q=lake&page=${page}`);
    assert.equal(status, 400, page);
    assert.equal(body.code, 'invalid_page', page);
  }
});

test('perPage pages through the samples and is clamped to 1..40, never refused', async () => {
  const second = await search('?q=lake&perPage=2&page=2');
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.results.map((r) => r.id), [STOCK_SAMPLE[2].id, STOCK_SAMPLE[3].id]);
  assert.equal(second.body.hasMore, true);
  assert.equal(second.body.totalResults, 6);

  const last = await search('?q=lake&perPage=2&page=3');
  assert.equal(last.body.results.length, 2);
  assert.equal(last.body.hasMore, false);

  assert.equal((await search('?q=lake&perPage=999')).body.perPage, 40);
  assert.equal((await search('?q=lake&perPage=0')).body.perPage, 1);
  assert.equal((await search('?q=lake&perPage=lots')).body.perPage, 15);
});

test('a page past the end is an empty page, not an error', async () => {
  const { status, body } = await search('?q=lake&page=7');
  assert.equal(status, 200);
  assert.deepEqual(body.results, []);
  assert.equal(body.hasMore, false);
  assert.equal(body.totalResults, 6);
});

// ── The limit ───────────────────────────────────────────────────────────

test('one person in one app gets 60 searches a minute, and the next person is not held up', async () => {
  assert.equal(appStockRoutes.SEARCHES_PER_MINUTE, 60);
  const busy = { userToken: identity(1006) };
  const answers = [];
  for (let i = 0; i < 61; i += 1) answers.push((await search('?q=lake', busy)).status);
  assert.deepEqual(answers.slice(0, 60), new Array(60).fill(200));
  assert.equal(answers[60], 429);

  const refused = await search('?q=lake', busy);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.code, 'rate_limited');
  assert.equal(refused.body.results, undefined);

  // The preview path counts toward the same person's minute.
  assert.equal((await search('?q=lake', { ...busy, appToken: null })).status, 429);
  assert.equal((await search('?q=lake', { userToken: identity(1007) })).status, 200);
});

// ── The contract the real services will reuse ───────────────────────────

test('the error codes are defined once, with the statuses the real services will use', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(STOCK_ERRORS).map(([code, e]) => [code, e.status])),
    {
      invalid_query: 400,
      invalid_provider: 400,
      invalid_page: 400,
      rate_limited: 429,
      provider_not_configured: 503,
      provider_unavailable: 502,
      provider_rate_limited: 429,
    }
  );
  for (const e of Object.values(STOCK_ERRORS)) assert.ok(e.message && !e.message.includes('—'));
  assert.deepEqual([...STOCK_PROVIDERS], ['pexels', 'pixabay']);
});

test('the samples cannot be changed by a caller', () => {
  assert.ok(Object.isFrozen(STOCK_SAMPLE));
  assert.ok(STOCK_SAMPLE.every((row) => Object.isFrozen(row)));
  assert.ok(Object.isFrozen(STOCK_ERRORS));
});

test('no key is read and nothing is sent out: the sources name neither', () => {
  for (const file of ['src/routes/app-stock.js', 'src/services/stock-sample.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /process\.env/, file);
    assert.doesNotMatch(source, /\bfetch\(|require\('(node:)?https?'\)|axios|undici/, file);
    assert.doesNotMatch(source, /api\.pexels\.com|pixabay\.com/, file);
  }
});

test('the route is mounted with the other app-facing routes, before the browser session gate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mount = source.indexOf('app.use(appStockRoutes(config));');
  assert.ok(mount > source.indexOf('app.use(appLlmProxyRoutes(config));'));
  assert.ok(mount < source.indexOf('app.use(appStorageRoutes(config));'));
});
