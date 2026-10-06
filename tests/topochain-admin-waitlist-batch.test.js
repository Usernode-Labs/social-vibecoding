// The admin waitlist's search box and batch-admit tool.
//
//   - GET /api/v4/admin/waitlist?q=   (and export-csv?q=) — search by address
//     or linked username.
//   - POST /api/v4/admin/waitlist/resolve — a pasted list of addresses,
//     resolved to what each one is on the waitlist. Reads only.
//   - POST /api/v4/admin/waitlist/bulk-release — admit many rows at once.
//
// Same "fake Postgres" idiom as tests/topochain-admin-waitlist-api.test.js,
// through the FULL composer app so the router-wide adminReadGate runs too.
// The search's SQL itself (the ILIKE, the ESCAPE, the username EXISTS) is
// validated against a real parser by `npm run lint:sql` only as far as its
// dynamic-baseline entry goes; what this file pins is that the typed text
// only ever reaches the database as a bound parameter, and at the right
// placeholder for each of the three queries that share the clause.
//
// Run with: node --test tests/topochain-admin-waitlist-batch.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

// The route calls waitlist.releaseWaitlistSignup through the module object,
// so a test can stand in for it; the release itself (access grant, account
// backfill) is services/waitlist.js's own, and tested with it.
const waitlistService = require('../src/services/waitlist');
const realRelease = waitlistService.releaseWaitlistSignup;

const { topochainAdminRoutes } = require('../src/routes/topochain/admin');
const { RESOLVE_MAX, BULK_ADMIT_MAX } = require('../src/routes/topochain/admin/waitlist');
const { renderComponent, loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const SCREEN = 'frontend/src/features/admin/topochain/waitlist.tsx';
const screenSource = fs.readFileSync(path.join(ROOT, SCREEN), 'utf8');

// ─── Fixtures + mock pool ───────────────────────────────────────────────

let signupRows;
let accountRows;
const seen = [];

function resetFixtures() {
  signupRows = [
    { id: 1, email: 'waiting@example.invalid', released_at: null, confirmed_at: new Date(), linked_username: 'waiter', has_platform_access: false },
    { id: 2, email: 'unconfirmed@example.invalid', released_at: null, confirmed_at: null, linked_username: null, has_platform_access: null },
    { id: 3, email: 'in@example.invalid', released_at: new Date(), confirmed_at: new Date(), linked_username: null, has_platform_access: null },
  ];
  accountRows = [
    { email: 'member@example.invalid', username: 'member', has_platform_access: true },
    { email: 'stuck@example.invalid', username: 'stuck', has_platform_access: false },
  ];
}

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);
  seen.push({ sql, params });
  if (sql.startsWith('SELECT COUNT(*)::int AS c FROM waitlist_signups w')) return { rows: [{ c: 0 }] };
  if (sql.startsWith('SELECT w.id, w.email') && sql.includes('LIMIT $1 OFFSET $2')) return { rows: [] };
  if (sql.startsWith('SELECT w.id, w.email') && sql.includes('user_social_identities')) return { rows: [] };
  if (sql.startsWith('SELECT w.id, w.email') && sql.includes('w.email = ANY($1::text[])')) {
    return { rows: signupRows.filter((r) => params[0].includes(r.email)) };
  }
  if (sql.startsWith('SELECT lower(email) AS email, username, has_platform_access FROM users')) {
    return { rows: accountRows.filter((r) => params[0].includes(r.email)) };
  }
  if (sql.startsWith('SELECT os, update_url FROM app_version_configs')) return { rows: [] };
  if (sql.startsWith('SELECT COUNT(*) FILTER (WHERE invite_generation = 0')) return { rows: [{ roots: 0, through_links: 0 }] };
  throw new Error(`Unhandled mock query: ${sql}`);
}

function makeMockPool() {
  return {
    query: async (sql, params) => handleQuery(sql, params),
    connect: async () => ({ query: async (sql, params) => handleQuery(sql, params), release: () => {} }),
  };
}

// ─── App ────────────────────────────────────────────────────────────────

let mailed;

function buildApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role === 'readonly') req.user = { id: 901, username: 'ro', isAdmin: true, canAdminWrite: false };
    else req.user = { id: 902, username: 'full', isAdmin: true, canAdminWrite: true };
    next();
  });
  // No databaseUrl: the mailer skips its throttle bookkeeping and sends
  // straight to the injected transport, which is what this file counts.
  app.use(topochainAdminRoutes({
    mailTransport: { provider: 'test', send: async (m) => { mailed.push(m); } },
  }));
  return app;
}

async function call(method, url, body, role = 'admin') {
  const server = buildApp(role).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* CSV */ }
    return { status: res.status, body: json, text };
  } finally { server.close(); }
}

test.beforeEach(() => {
  resetFixtures();
  seen.length = 0;
  mailed = [];
  currentMockPool = makeMockPool();
  waitlistService.releaseWaitlistSignup = realRelease;
});

test.after(() => { waitlistService.releaseWaitlistSignup = realRelease; });

// ─── parseEmailList ─────────────────────────────────────────────────────

test('a pasted list splits on lines, commas, semicolons and spaces, in paste order', () => {
  const { entries, skipped, duplicates } = waitlistService.parseEmailList(
    'Jane Doe <Jane@Example.com>, bob@x.io; BOB@x.io\n"carol@y.org"\tmailto:dan@z.co. (eve@q.net) broken@',
  );
  assert.deepEqual(entries.map((e) => e.email),
    ['jane@example.com', 'bob@x.io', 'carol@y.org', 'dan@z.co', 'eve@q.net', null]);
  // The input is kept as typed (minus the wrapping), so an admin can find it.
  assert.equal(entries[0].input, 'Jane@Example.com');
  assert.equal(entries[5].input, 'broken@');
  assert.equal(skipped, 2, '"Jane" and "Doe" have no @ and are skipped, not reported');
  assert.equal(duplicates, 1, 'the upper-case repeat of bob@x.io is dropped');
});

test('an empty or non-string paste has no candidates', () => {
  for (const v of ['', '   \n  ', null, undefined, 42]) {
    assert.deepEqual(waitlistService.parseEmailList(v).entries, [], String(v));
  }
});

// ─── Search ─────────────────────────────────────────────────────────────

test('?q= reaches the database only as a bound, LIKE-escaped parameter', async () => {
  const typed = "o'brien_100%";
  const res = await call('GET', `/api/v4/admin/waitlist?status=pending&q=${encodeURIComponent(`  ${typed} `)}`);
  assert.equal(res.status, 200);
  const count = seen.find((s) => s.sql.startsWith('SELECT COUNT(*)::int AS c'));
  const page = seen.find((s) => s.sql.includes('LIMIT $1 OFFSET $2'));
  for (const { sql } of [count, page]) {
    assert.ok(!sql.includes('brien'), 'the typed text is never spliced into the SQL');
    assert.match(sql, /w\.released_at IS NULL AND \(w\.email ILIKE/, 'the search ANDs onto the status filter');
    assert.match(sql, /su\.username ILIKE/, 'and also searches the linked account’s username');
    assert.match(sql, /ESCAPE '\\'/);
  }
  // The count binds only the search; the page binds LIMIT and OFFSET first.
  assert.deepEqual(count.params, ['%o\'brien\\_100\\%%']);
  assert.match(count.sql, /ILIKE \$1 ESCAPE/);
  assert.equal(page.params.length, 3);
  assert.equal(page.params[2], '%o\'brien\\_100\\%%');
  assert.match(page.sql, /ILIKE \$3 ESCAPE/);
});

test('no ?q= (or a blank one) adds no clause and no parameter', async () => {
  await call('GET', '/api/v4/admin/waitlist?q=%20%20');
  const count = seen.find((s) => s.sql.startsWith('SELECT COUNT(*)::int AS c'));
  const page = seen.find((s) => s.sql.includes('LIMIT $1 OFFSET $2'));
  assert.ok(!count.sql.includes('ILIKE'));
  assert.deepEqual(count.params, []);
  assert.equal(page.params.length, 2);
});

test('Export CSV applies the same search, bound as $1', async () => {
  const res = await call('GET', '/api/v4/admin/waitlist/export-csv?q=acme');
  assert.equal(res.status, 200);
  const q = seen.find((s) => s.sql.includes('user_social_identities'));
  assert.match(q.sql, /ILIKE \$1 ESCAPE/);
  assert.deepEqual(q.params, ['%acme%']);
});

// ─── Resolve ────────────────────────────────────────────────────────────

test('resolve says what each pasted address is, in paste order', async () => {
  const res = await call('POST', '/api/v4/admin/waitlist/resolve', {
    text: 'IN@example.invalid\nwaiting@example.invalid, member@example.invalid stuck@example.invalid '
      + 'nobody@example.invalid unconfirmed@example.invalid not-an-address@',
  });
  assert.equal(res.status, 200);
  const { entries, admit_max: admitMax } = res.body.data;
  assert.deepEqual(entries.map((e) => [e.email, e.match]), [
    ['in@example.invalid', 'admitted'],
    ['waiting@example.invalid', 'waiting'],
    ['member@example.invalid', 'not_found'],
    ['stuck@example.invalid', 'not_found'],
    ['nobody@example.invalid', 'not_found'],
    ['unconfirmed@example.invalid', 'waiting'],
    [null, 'invalid'],
  ]);
  assert.equal(admitMax, BULK_ADMIT_MAX);
  assert.equal(entries[1].signup.id, 1);
  assert.equal(entries[1].signup.linked_username, 'waiter');
  assert.deepEqual(entries[2].account, { username: 'member', has_platform_access: true });
  assert.deepEqual(entries[3].account, { username: 'stuck', has_platform_access: false });
  assert.equal(entries[4].account, null);
  // Only addresses with no waitlist row are looked up as accounts.
  const accounts = seen.find((s) => s.sql.includes('FROM users'));
  assert.deepEqual(accounts.params[0].sort(),
    ['member@example.invalid', 'nobody@example.invalid', 'stuck@example.invalid']);
});

test('resolve refuses an empty paste and one past its bound', async () => {
  const empty = await call('POST', '/api/v4/admin/waitlist/resolve', { text: 'no addresses here' });
  assert.equal(empty.status, 422);
  const list = Array.from({ length: RESOLVE_MAX + 1 }, (_, i) => `p${i}@example.invalid`).join('\n');
  const tooMany = await call('POST', '/api/v4/admin/waitlist/resolve', { text: list });
  assert.equal(tooMany.status, 422);
  assert.match(tooMany.body.error, new RegExp(`at most ${RESOLVE_MAX}`));
  assert.equal(seen.length, 0, 'neither reaches the database');
});

test('resolve and bulk-release are write-admin only', async () => {
  const r = await call('POST', '/api/v4/admin/waitlist/resolve', { text: 'a@example.invalid' }, 'readonly');
  assert.equal(r.status, 403);
  const b = await call('POST', '/api/v4/admin/waitlist/bulk-release', { ids: [1] }, 'readonly');
  assert.equal(b.status, 403);
});

// ─── Bulk release ───────────────────────────────────────────────────────

function fakeRelease({ failOn = [] } = {}) {
  const calls = [];
  waitlistService.releaseWaitlistSignup = async (_pool, id) => {
    calls.push(id);
    if (failOn.includes(id)) throw new Error('boom');
    const row = signupRows.find((r) => r.id === id);
    if (!row) return null;
    const newly = row.released_at == null;
    row.released_at = row.released_at || new Date();
    return { id, email: row.email, released_at: row.released_at, linked_user_id: null, more_token: `t${id}`, newly_released: newly };
  };
  return calls;
}

test('bulk-release admits each id, mails only the newly admitted, and reports every outcome', async () => {
  const calls = fakeRelease();
  const res = await call('POST', '/api/v4/admin/waitlist/bulk-release', { ids: [1, '2', 3, 404, 1, 'x'] });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [1, 2, 3, 404], 'deduped, unparseable ids dropped, order kept');
  assert.deepEqual(res.body.data, { admitted: [1, 2], already_admitted: [3], not_found: [404], failed: [] });
  assert.deepEqual(mailed.map((m) => [m.kind, m.to]).sort(), [
    ['waitlist_released', 'unconfirmed@example.invalid'],
    ['waitlist_released', 'waiting@example.invalid'],
  ]);

  // Again: all idempotent, nobody mailed twice.
  mailed = [];
  const again = await call('POST', '/api/v4/admin/waitlist/bulk-release', { ids: [1, 2] });
  assert.deepEqual(again.body.data.admitted, []);
  assert.deepEqual(again.body.data.already_admitted, [1, 2]);
  assert.equal(mailed.length, 0);
});

test('one row failing does not strand the rows already admitted unmailed', async () => {
  fakeRelease({ failOn: [2] });
  const res = await call('POST', '/api/v4/admin/waitlist/bulk-release', { ids: [2, 1] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.failed, [2]);
  assert.deepEqual(res.body.data.admitted, [1]);
  assert.deepEqual(mailed.map((m) => m.to), ['waiting@example.invalid']);
});

test('bulk-release refuses no ids and more than one batch', async () => {
  const calls = fakeRelease();
  assert.equal((await call('POST', '/api/v4/admin/waitlist/bulk-release', { ids: [] })).status, 422);
  const ids = Array.from({ length: BULK_ADMIT_MAX + 1 }, (_, i) => i + 1);
  const res = await call('POST', '/api/v4/admin/waitlist/bulk-release', { ids });
  assert.equal(res.status, 422);
  assert.match(res.body.error, new RegExp(`at most ${BULK_ADMIT_MAX}`));
  assert.deepEqual(calls, [], 'an oversized batch admits nobody');
});

// The bound exists because admitting mails, and the platform's hourly mail
// ceiling is one budget shared with sign-in codes. A batch must leave most
// of it standing.
test('one batch cannot spend the hourly mail budget sign-in codes share', () => {
  const { DEFAULT_MAX_PER_HOUR } = require('../src/services/mail/rate-limit');
  assert.ok(BULK_ADMIT_MAX <= DEFAULT_MAX_PER_HOUR / 3,
    `a batch of ${BULK_ADMIT_MAX} is too large a share of ${DEFAULT_MAX_PER_HOUR} mails/hour`);
});

// ─── The screen ─────────────────────────────────────────────────────────

const screen = loadTsx(SCREEN);

test('the search box commits on Enter or blur, not on every keystroke', () => {
  assert.match(screenSource, /id: 'admin-topo-wl-search'/);
  assert.match(screenSource, /onBlur=\{\(e\) => commitSearch\(e\.currentTarget\.value\)\}/);
  assert.match(screenSource, /if \(e\.key === 'Enter'\)/);
  // onChange commits only the EMPTY value (clearing the box), never text.
  assert.match(screenSource, /onChange=\{\(e\) => \{ if \(!e\.currentTarget\.value\) commitSearch\(''\); \}\}/);
  assert.match(screenSource, /if \(search && q\) params\.set\('q', q\);/,
    'the search rides filterParams, so Export CSV carries it too');
});

test('Batch admit renders only for a write admin', () => {
  assert.match(screenSource, /toolbar=\{write \? \(\s*<button\s+id="admin-topo-wl-batch"/);
});

test('the batch panel starts empty, with nothing to admit until a lookup', () => {
  const html = renderComponent(SCREEN, 'BatchAdmitPanel', { onClose() {}, onAdmitted() {} });
  assert.match(html, /id="admin-topo-wl-batch-input"/);
  assert.match(html, /id="admin-topo-wl-batch-resolve"[^>]*disabled/, 'Look up waits for a paste');
  assert.ok(!html.includes('admin-topo-wl-batch-admit'), 'no Admit button before a lookup');
});

test('each resolved address reads as a sentence about what it is', () => {
  const { resolvedDetail } = screen;
  assert.match(resolvedDetail({ input: 'x', email: null, match: 'invalid' }), /doesn’t look like an email/);
  assert.match(resolvedDetail({ input: 'a', email: 'a', match: 'not_found', account: null }),
    /Nobody with this address/);
  assert.match(resolvedDetail({
    input: 'a', email: 'a', match: 'not_found', account: { username: 'stuck', has_platform_access: false },
  }), /has an account \(stuck\) without access\. Grant it from Users\./);
  assert.match(resolvedDetail({
    input: 'a', email: 'a', match: 'not_found', account: { username: 'm', has_platform_access: true },
  }), /already has access/);
  assert.match(resolvedDetail({
    input: 'a', email: 'a', match: 'waiting', signup: { id: 1, email: 'a', confirmed_at: null, linked_username: null },
  }), /^Never confirmed their address · no account yet/);
});

test('the lookup summary counts every outcome, and says what it dropped', () => {
  const { resolutionSummary } = screen;
  const line = resolutionSummary({
    entries: [
      { input: 'a', email: 'a', match: 'waiting' },
      { input: 'b', email: 'b', match: 'waiting' },
      { input: 'c', email: 'c', match: 'admitted' },
      { input: 'd', email: 'd', match: 'not_found' },
      { input: 'e', email: null, match: 'invalid' },
    ],
    skipped: 2,
    duplicates: 1,
    admit_max: BULK_ADMIT_MAX,
  });
  assert.equal(line, '5 addresses: 2 waiting · 1 already admitted · 1 not on the waitlist · '
    + '1 not an address. (1 repeat dropped, 2 words without an @ ignored.)');
});

test('the admit outcome names everything that did not simply succeed', () => {
  const { admitOutcomeLine } = screen;
  assert.equal(admitOutcomeLine({ admitted: [1, 2], already_admitted: [], not_found: [], failed: [] }),
    'Admitted 2 signups.');
  assert.equal(admitOutcomeLine({ admitted: [1], already_admitted: [3], not_found: [4], failed: [5, 6] }),
    'Admitted 1 signup. 1 was already in. 1 had been deleted from the waitlist. '
    + '2 could not be admitted; look the list up again and retry.');
});

test('an empty search result says it is the search, and how to widen it', () => {
  const { waitlistEmpty } = screen;
  const narrowed = waitlistEmpty({ status: 'pending', only: 'any', q: 'zed' });
  assert.equal(narrowed.title, 'No waiting signup matches “zed”');
  assert.match(narrowed.body, /set the filters to All and Everyone/);
  const wide = waitlistEmpty({ status: 'all', only: 'any', q: 'zed' });
  assert.match(wide.body, /Clear the search to see the rest\.$/);
  // Without a search the old empty states are unchanged.
  assert.equal(waitlistEmpty({ status: 'pending', only: 'any', q: '' }).title, 'Nobody is waiting');
});
