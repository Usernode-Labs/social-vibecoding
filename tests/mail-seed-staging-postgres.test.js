'use strict';

// src/db/migrate.js, src/db/email-template-seeds.js: when a preview seeds its email
// templates. Its own file because migrate() keeps one pool per process, for the
// first database it was given.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { KINDS } = require('../src/services/mail/templates');
const { reset } = require('../src/services/push-language');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// A preview that starts empty fills its translation cache in the background. The
// email seeds are English and read no translation, so they are written during the
// boot, and a production that never answers holds up neither.
test('on staging the seed runs during the boot, without waiting for the translation import', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('Set TEST_DATABASE_URL for PostgreSQL'); return;
  }
  const name = 'mail_seed_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const saved = { env: process.env.USERNODE_ENV, origin: process.env.USERNODE_PLATFORM_ORIGIN };
  const originalFetch = globalThis.fetch;
  let answer;
  const answered = new Promise((resolve) => { answer = resolve; });
  t.after(() => {
    answer();
    globalThis.fetch = originalFetch;
    for (const [key, value] of [['USERNODE_ENV', saved.env], ['USERNODE_PLATFORM_ORIGIN', saved.origin]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.USERNODE_ENV = 'staging';
  process.env.USERNODE_PLATFORM_ORIGIN = 'https://platform.example';

  // Production's translation export does not answer while the boot runs.
  globalThis.fetch = async (asked, options) => {
    if (!String(asked).endsWith('/api/languages/cache')) return originalFetch(asked, options);
    await answered;
    return { ok: true, status: 200, json: async () => ({ entries: {} }) };
  };
  reset();

  const config = { databaseUrl: String(url), adminUsername: 'seed-admin', adminPassword: 'only-for-tests', selfAppSlug: 'seed-platform', platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };
  await require('../src/db/migrate').migrate(config);
  const count = async (sql) => (await pool.query(sql)).rows[0].n;
  assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), KINDS.length, 'seeded during the boot');
  assert.equal(await count('SELECT count(*)::int AS n FROM email_template_translations'), 0, 'in English');
  reset();
});
