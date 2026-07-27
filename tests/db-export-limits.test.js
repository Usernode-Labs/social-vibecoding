// Platform database export — the rate limit (dbExportLimiter).
//
// Three full dumps per admin per rolling day. The number is small on
// purpose: each ticket authorizes a complete, unredacted copy of the
// platform database, so an admin account that has been taken over should
// be able to walk away with the crown jewels at most a handful of times
// before it is stopped, not indefinitely.
//
// The trap this file exists to catch: `exemptAdmins`. Every one of this
// limiter's neighbours in rate-limits.js sets it, and it skips the limiter
// for anyone with canAdminWrite — which is EXACTLY the population this
// limiter bounds, because the route is already full-admin-only. Setting it
// here would silently disable the limit entirely while looking tidier. A
// behavioural test (a full admin really does get throttled) plus a source
// assertion keep that from being "cleaned up" later.
//
// Run with: node --test tests/db-export-limits.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/middleware/rate-limits.js'), 'utf8');
const { dbExportLimiter } = require('../src/middleware/rate-limits');

// Isolate the limiter's own declaration from its neighbours.
const decl = src.slice(
  src.indexOf('const dbExportLimiter = makeLimiter({'),
  src.indexOf('});', src.indexOf('const dbExportLimiter = makeLimiter({'))
);

test('dbExportLimiter is declared and exported', () => {
  assert.ok(decl.length > 0, 'the limiter exists in rate-limits.js');
  assert.equal(typeof dbExportLimiter, 'function', 'exported as middleware');
});

test('the budget is 3 per 24 hours', () => {
  assert.match(decl, /max:\s*3\b/, 'three exports');
  assert.match(decl, /windowMs:\s*24 \* 60 \* 60 \* 1000/, 'per rolling day');
});

test('it is keyed by user, not by IP', () => {
  // Two admins behind one office NAT must each get their own budget, and
  // one admin must not be able to reset theirs by changing networks.
  assert.match(decl, /keyByUser:\s*true/);
});

test('exemptAdmins is NOT set — it would disable this limiter outright', () => {
  assert.ok(!/exemptAdmins/.test(decl),
    'the route is full-admin-only, so exempting full admins removes the limit');
  // The option really does mean what the comment above claims.
  assert.match(src, /options\.skip = \(req\) => !!req\.user\?\.canAdminWrite/);
});

test('a failed attempt is refunded, so a typo does not burn a slot', () => {
  assert.match(decl, /skipFailedRequests:\s*true/);
});

test('the limiter is registered on the ticket route, not the stream route', () => {
  // Only the POST needs limiting: it is what authorizes a dump. Limiting
  // the GET too would let a flaky download eat the budget the POST
  // already paid for.
  const admin = fs.readFileSync(path.join(root, 'src/routes/admin.js'), 'utf8');
  assert.match(admin, /noteDbExportPreDenials, requireAdminWrite, dbExportLimiter/,
    'the ticket route chains the pre-denial audit, the write gate, then the limiter');
  const streamRoute = admin.slice(admin.indexOf("router.get('/api/admin/db-export',"));
  assert.ok(!/dbExportLimiter/.test(streamRoute.slice(0, 200)),
    'the download route is gated by the single-use ticket, not by the limiter');
});

// ─── Behaviour ────────────────────────────────────────────────────

test('a full admin is throttled after 3 successful requests', async () => {
  const app = express();
  const user = { id: 4242, username: 'fullish', isAdmin: true, canAdminWrite: true };
  app.use((req, _res, next) => { req.user = user; next(); });
  app.post('/t', dbExportLimiter, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/t`;

  const codes = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(base, { method: 'POST' });
    codes.push(res.status);
    if (res.status === 429) {
      const body = await res.json();
      assert.match(body.error, /up to 3 database exports per day/);
      assert.ok(typeof body.retryAfterSeconds === 'number', 'the client is told when to retry');
      // Throttles stay `code`-free: clients discriminate billing 429s by
      // their code tag (#463).
      assert.ok(!('code' in body));
    }
  }
  assert.deepEqual(codes, [200, 200, 200, 429],
    'a FULL admin — the only population that can reach the route — really is limited');
  server.close();
});

test('each admin gets their own budget', async () => {
  const app = express();
  let user = { id: 5001, username: 'a', isAdmin: true, canAdminWrite: true };
  app.use((req, _res, next) => { req.user = user; next(); });
  app.post('/t', dbExportLimiter, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/t`;

  for (let i = 0; i < 3; i++) await fetch(base, { method: 'POST' });
  assert.equal((await fetch(base, { method: 'POST' })).status, 429, 'first admin exhausted');
  user = { id: 5002, username: 'b', isAdmin: true, canAdminWrite: true };
  assert.equal((await fetch(base, { method: 'POST' })).status, 200,
    'the second admin (same IP) still has their own three');
  server.close();
});

test('MAX_PER_DAY in the service matches the enforced limit', () => {
  // The service constant is display-only (the capability probe), so it can
  // drift from the enforced number without anything failing at runtime.
  const dbExport = require('../src/services/db-export');
  assert.equal(dbExport.MAX_PER_DAY, 3);
});
