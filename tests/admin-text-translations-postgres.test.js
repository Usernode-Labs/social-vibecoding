// #6152: the statements of services/admin-text-translations.js against the real
// schema. tests/admin-text-translations.test.js has the rules on a fake table;
// this is what a fake cannot prove: that the SQL runs, and that the WHERE on the
// pass's upsert keeps what a person wrote.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/admin-text-translations-postgres.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const service = require('../src/services/admin-text-translations');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const source = {
  files: {
    'config.json': { languages: { en: 'English', fr: 'Français' } },
    'glossary.json': { doNotTranslate: [], terms: {}, style: {} },
  },
};

const model = (prefix) => ({
  isEnabled: () => true,
  estimateCostCents: () => 0,
  async translateCatalogDirect(requests) {
    return new Map(requests.map((request) => [request.customId, {
      text: JSON.stringify({ translations: request.items.map((item) => ({ id: item.id, text: `${prefix} ${item.english}` })) }),
    }]));
  },
});
const limits = { checkSystemBudget: async () => ({}), recordSystemSpend: async () => {} };

test('a pass, a correction, an approval and a new English, on the real table', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `admin_text_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4, connectionTimeoutMillis: 10000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(
    `INSERT INTO app_version_configs (os, min_build_number, must_update_message, is_active)
     VALUES ('ios', 10, 'Update now.', TRUE)`,
  );
  const must = { key: 'app-version:ios:must', english: 'Update now.', reviewRequired: true };
  const deps = { source, llm: model('fr:'), limits };

  assert.deepEqual(await service.look({ pool, deps }), { items: [{ target: 'pending', input: {} }] });
  assert.equal((await service.runOnce({ pool, deps })).saved, 3, 'the ios message and the two defaults');
  assert.deepEqual(await service.look({ pool, deps }), { skipped: 'nothing_missing' });

  // Waiting for review, so still English.
  assert.equal(await service.translated(pool, must, 'fr'), 'Update now.');
  assert.deepEqual(await service.approve(pool, { key: must.key, language: 'fr', userId: null }, { source }), { ok: true });
  assert.equal(await service.translated(pool, must, 'fr'), 'fr: Update now.');

  // A person's words stand against a later pass of the same English.
  assert.deepEqual(await service.correct(pool, { key: must.key, language: 'fr', text: 'Mettez à jour.', userId: null }, { source }), { ok: true });
  await service.runOnce({ pool, deps: { ...deps, llm: model('again:') } });
  assert.equal(await service.translated(pool, must, 'fr'), 'Mettez à jour.');

  // New English retires them: English at once, then a translation to review.
  await pool.query(`UPDATE app_version_configs SET must_update_message = 'Please update today.'`);
  const next = { ...must, english: 'Please update today.' };
  assert.equal(await service.translated(pool, next, 'fr'), 'Please update today.');
  await service.runOnce({ pool, deps });
  assert.equal(await service.translated(pool, next, 'fr'), 'Please update today.');
  const { messages } = await service.overview(pool, { source });
  const line = messages.find((m) => m.key === must.key).languages[0];
  assert.equal(line.state, 'needs_review');
  assert.equal(line.text, 'fr: Please update today.');

  assert.deepEqual(await service.retranslate(pool, { key: must.key, language: 'fr' }, { source }), { ok: true });
  assert.equal(messages.length, 3);
  assert.deepEqual(await service.look({ pool, deps }), { items: [{ target: 'pending', input: {} }] });
});
