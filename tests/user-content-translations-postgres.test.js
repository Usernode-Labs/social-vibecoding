// #6081: the statements of services/user-content-translations.js against the
// real schema.
//
// tests/user-content-translations.test.js has the rules on a fake table; this
// is what a fake cannot prove: that the SQL runs, that a stored translation
// survives a second ask, and that the daily ask count is a real row.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/user-content-translations-postgres.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const service = require('../src/services/user-content-translations');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const source = {
  files: {
    'config.json': { languages: { en: 'English', fr: 'Français' } },
    'glossary.json': { doNotTranslate: [], terms: {}, style: {} },
  },
};
const limits = { checkSystemBudget: async () => ({}), recordSystemSpend: async () => {} };

function model(text) {
  const calls = [];
  return {
    calls,
    isEnabled: () => true,
    estimateCostCents: () => 0,
    async translateCatalogDirect(requests) {
      calls.push(requests);
      return new Map(requests.map((request) => [request.customId, {
        text: JSON.stringify({ items: request.items.map((item) => ({ id: item.id, from: 'zh-CN', same: false, text })) }),
      }]));
    },
  };
}

test('a translation, its cache and the daily ask count, on the real tables', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `user_content_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4, connectionTimeoutMillis: 10000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows } = await pool.query("INSERT INTO users (username, password) VALUES ('reader', 'x') RETURNING id");
  const userId = rows[0].id;

  const llm = model('Bonjour');
  const first = await service.translate(pool, { texts: ['你好'], language: 'fr', userId }, { llm, limits, source });
  assert.deepEqual(first.results, [{ state: 'translated', text: 'Bonjour', from: 'zh-CN' }]);
  assert.equal(llm.calls.length, 1);

  // The row survived, and the second ask is answered without a model call.
  const stored = await pool.query('SELECT text, source_language, same_language FROM user_content_translations');
  assert.deepEqual(stored.rows, [{ text: 'Bonjour', source_language: 'zh-CN', same_language: false }]);
  const second = await service.translate(pool, { texts: ['你好'], language: 'fr', userId }, { llm, limits, source });
  assert.deepEqual(second.results, [{ state: 'translated', text: 'Bonjour', from: 'zh-CN' }]);
  assert.equal(llm.calls.length, 1);

  // One new translation was counted for this person today.
  const asks = await pool.query('SELECT count FROM user_content_translation_asks WHERE user_id = $1', [userId]);
  assert.equal(Number(asks.rows[0].count), 1);
});
