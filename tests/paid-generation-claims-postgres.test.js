'use strict';

// A paid generation's claim, against the full PostgreSQL schema: a report
// generation claims its app's app_report_ai row (services/report-ai.js), a
// dictation its person's dictation_claims row (services/dictation.js). One
// at a time on any process, a claim a crash left released once its lease
// lapses, and a release that frees only its own claim. Both were a Set in
// each process. tests/lib/dictation-claims.js, which the dictation route
// suite uses, is held to the same answers here.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/paid-generation-claims-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a paid generation claims its row, once at a time on any process', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'paid_claims_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows: [u] } = await pool.query(`INSERT INTO users (username, password) VALUES ('ada', 'x') RETURNING id`);
  const { rows: [a] } = await pool.query(`INSERT INTO apps (name, slug, created_by) VALUES ('Demo', 'demo', $1) RETURNING id`, [u.id]);

  await t.test('dictation: one per person, a lapsed claim taken over, a release frees only its own', async () => {
    const dictation = require('../src/services/dictation');
    const { withDictationClaims } = require('./lib/dictation-claims');
    // The real table and the route suites' emulation, side by side.
    for (const db of [pool, withDictationClaims({ query: async () => assert.fail('the emulation answers alone') })]) {
      const first = await dictation.claim(db, u.id, 60000);
      assert.ok(first);
      assert.equal(await dictation.claim(db, u.id, 60000), null, 'busy while it is held');
      await dictation.release(db, u.id, first);
      const second = await dictation.claim(db, u.id, 1);
      assert.ok(second, 'free once released');
      await new Promise((r) => setTimeout(r, 1100));
      const third = await dictation.claim(db, u.id, 60000);
      assert.ok(third, 'a lapsed claim (its process went away) is taken over');
      await dictation.release(db, u.id, second);
      assert.equal(await dictation.claim(db, u.id, 60000), null, 'the late release of a lapsed claim frees nothing');
      await dictation.release(db, u.id, third);
    }
  });

  await t.test('report: the app\'s row is the claim, a first generation leaves no report, and a crash\'s claim lapses', async (t2) => {
    const llm = require('../src/services/llm');
    const reportAi = require('../src/services/report-ai');
    let release;
    let calls = 0;
    const waiting = new Promise((r) => { release = r; });
    const prev = llm._setClientForTests({
      messages: { create: async () => { calls += 1; await waiting; throw new Error('the provider failed'); } },
    });
    t2.after(() => llm._setClientForTests(prev));
    const limits = require('../src/services/limits');
    t2.mock.method(limits, 'resolveBillingPath', async () => ({ apiKey: null }));
    const app = { id: a.id, slug: 'demo', name: 'Demo' };
    const run = reportAi.generateForApp({ pool, config: {}, app, userId: u.id });
    while (!calls) await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(reportAi.generateForApp({ pool, config: {}, app, userId: u.id }),
      (err) => err.code === 'generation_in_flight', 'the second click is refused');
    assert.equal(await reportAi.getCached(pool, a.id), null, 'the claim\'s row holds no report');
    release();
    await assert.rejects(run, /the provider failed/);
    const { rows: [r] } = await pool.query('SELECT generating_until FROM app_report_ai WHERE app_id = $1', [a.id]);
    assert.equal(r.generating_until, null, 'released when it ends, failed or not');

    // A process that went away mid-generation: its claim holds until it lapses.
    await pool.query(`UPDATE app_report_ai SET generating_until = NOW() + interval '1 minute' WHERE app_id = $1`, [a.id]);
    await assert.rejects(reportAi.generateForApp({ pool, config: {}, app, userId: u.id }), (err) => err.code === 'generation_in_flight');
    await pool.query(`UPDATE app_report_ai SET generating_until = NOW() - interval '1 second' WHERE app_id = $1`, [a.id]);
    await assert.rejects(reportAi.generateForApp({ pool, config: {}, app, userId: u.id }), /the provider failed/,
      'taken over once it lapsed');
  });
});
