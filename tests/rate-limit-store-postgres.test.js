'use strict';

// The shared rate-limit store (src/services/rate-limit-store.js): the
// limiters that gate a send, a bill or a guess count in Postgres, so two
// processes count against one budget and a deploy does not reset it. Each
// counted in its process's memory before: N web Pods were N budgets, and
// every release gave everybody a fresh one.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/rate-limit-store-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const store = require('../src/services/rate-limit-store');

test('shared limiters count in Postgres, one budget for every process', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'rate_limits_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    store.setPool(null);
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  store.setPool(pool);

  await t.test('two processes\' stores share one count, kept by hash, and a window starts again once it has passed', async () => {
    // Two web Pods each build the same limiter: two stores, one name.
    const a = new store.SharedStore('otp-request');
    const b = new store.SharedStore('otp-request');
    a.init({ windowMs: 60 * 1000 });
    b.init({ windowMs: 60 * 1000 });
    assert.equal((await a.increment('203.0.113.7')).totalHits, 1);
    assert.equal((await b.increment('203.0.113.7')).totalHits, 2, 'the other process counts on the same budget');
    const third = await a.increment('203.0.113.7');
    assert.equal(third.totalHits, 3);
    assert.ok(third.resetTime > new Date(), 'a window from its first hit');
    assert.equal((await new store.SharedStore('login-burst').increment('203.0.113.7')).totalHits, 1, 'another limiter, another count');
    await b.decrement('203.0.113.7');
    assert.equal((await a.get('203.0.113.7')).totalHits, 2, 'a refunded request');
    const { rows } = await pool.query('SELECT key FROM rate_limit_hits');
    assert.ok(rows.every((r) => !r.key.includes('203.0.113.7')), 'what it counts is never kept as itself');
    // Past its window: counted from one again.
    await pool.query(`UPDATE rate_limit_hits SET reset_at = now() - interval '1 second'`);
    assert.equal((await a.increment('203.0.113.7')).totalHits, 1);
    await a.resetKey('203.0.113.7');
    assert.equal(await a.get('203.0.113.7'), undefined);
  });

  await t.test('a limiter marked shared refuses across processes, through express-rate-limit', async () => {
    const { rateLimit } = require('express-rate-limit');
    const limiter = () => rateLimit({ windowMs: 60 * 1000, max: 2, store: new store.SharedStore('sms-test'), standardHeaders: 'draft-7', legacyHeaders: false });
    const serve = (mw) => {
      const app = express();
      app.post('/x', mw, (_req, res) => res.json({ ok: true }));
      return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    };
    const one = await serve(limiter());
    const two = await serve(limiter());
    try {
      const hit = (s) => fetch(`http://127.0.0.1:${s.address().port}/x`, { method: 'POST' }).then((r) => r.status);
      assert.deepEqual([await hit(one), await hit(two), await hit(one), await hit(two)], [200, 200, 429, 429]);
    } finally {
      one.close();
      two.close();
    }
  });

  await t.test('the retention clock deletes counts an hour past their window', async () => {
    await pool.query(`INSERT INTO rate_limit_hits (key, hits, reset_at) VALUES ('old', 1, now() - interval '2 hours'), ('recent', 1, now() - interval '5 minutes')`);
    assert.deepEqual(await store.prune(pool), { deleted: 1 });
    const { rows } = await pool.query(`SELECT key FROM rate_limit_hits WHERE key IN ('old', 'recent')`);
    assert.deepEqual(rows.map((r) => r.key), ['recent']);
  });
});

// Which limiters share their count is the rule's, not a taste: a send, a
// bill or a guess.
test('the limiters that gate a send, a bill or a guess are shared; a runaway-client bound is not', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/middleware/rate-limits.js'), 'utf8');
  const shared = new Set([...src.matchAll(/name: '([^']+)', shared: true,/g)].map((m) => m[1]));
  for (const name of ['login-burst', 'login-identity', 'otp-request', 'otp-verify', 'phone-otp-request', 'phone-verify',
    'password-reset-request', 'password-reset-confirm', 'waitlist-join', 'waitlist-resend', 'waitlist-token', 'waitlist-code-confirm',
    'wallet-auth', 'release-link', 'sms-test', 'mail-test', 'report-ai', 'workshop-ask', 'dictation', 'bench-runs', 'feedback-title']) {
    assert.ok(shared.has(name), `${name} is shared`);
  }
  for (const name of ['chat', 'conversation-message', 'board-order', 'ui-telemetry', 'link-cards']) {
    assert.ok(!shared.has(name), `${name} stays per process`);
  }
  assert.match(src, /\.\.\.\(shared \? \{ store: new SharedStore\(name\), passOnStoreError: true \} : \{\}\),/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'),
    /require\('\.\/src\/services\/rate-limit-store'\)\.setPool\(getPool\(config\)\);/);
});
