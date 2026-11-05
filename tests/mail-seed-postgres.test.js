'use strict';

// src/db/email-template-seeds.js, src/db/migrate.js: the first templates reach
// the database at boot, once, safely with several servers starting together, in
// the languages the translation lookup has, and never come back once deleted.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { hash } = require('../scripts/language-packs');
const { KINDS } = require('../src/services/mail/templates');
const { reset } = require('../src/services/push-language');
const log = require('../src/services/logger');
const { SEEDS, seedEmailTemplates, englishTemplate } = require('../src/db/email-template-seeds');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const ROOT = path.join(__dirname, '..');
const ENGLISH = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/email.json'), 'utf8'));
const FRENCH = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mail-seed-french.json'), 'utf8'));
const SOURCE = {
  files: {
    'config.json': { sourceLanguage: 'en', languages: { en: 'English', fr: 'Français', es: 'Español' } },
    'glossary.json': { doNotTranslate: ['Homeroom'] },
    'en/email.json': ENGLISH,
  },
};
const TRANSLATED = KINDS.filter((kind) => !['admin_test', 'content_report'].includes(kind));

test('seeding email templates against PostgreSQL', { timeout: 180000 }, async (t) => {
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
  const config = { databaseUrl: String(url), adminUsername: 'seed-admin', adminPassword: 'only-for-tests', selfAppSlug: 'seed-platform', platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };
  const { migrate } = require('../src/db/migrate');
  const dbPool = require('../src/db/pool');
  const originalGetPool = dbPool.getPool;
  dbPool.getPool = () => pool;
  t.after(() => { dbPool.getPool = originalGetPool; });
  await migrate(config);
  const store = require('../src/services/mail/template-store');

  const count = async (sql) => (await pool.query(sql)).rows[0].n;
  const empty = () => pool.query('TRUNCATE email_template_translations, email_layout_translations, email_templates, email_layouts');

  await t.test('booting seeds every kind and the one layout, and booting again adds nothing', async () => {
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), KINDS.length);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 1);
    await migrate(config);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), KINDS.length);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 1);
    const { rows } = await pool.query("SELECT e.action, e.version, e.status, e.layout_family_id, l.name AS layout FROM email_templates e JOIN email_layouts l ON l.family_id = e.layout_family_id");
    assert.equal(rows.length, KINDS.length);
    assert.ok(rows.every((row) => row.version === 1 && row.status === 'live' && row.layout === 'Homeroom standard'));
  });

  await t.test('the snapshot the sender will read holds the seeds as written', async () => {
    const { templates, layouts } = await store.snapshot(pool);
    assert.deepEqual(Object.keys(templates).sort(), [...KINDS].sort());
    assert.equal(Object.keys(layouts).length, 1);
    const expected = englishTemplate('waitlist_released');
    for (const field of ['name', 'subject', 'preheader', 'why', 'html', 'text']) {
      assert.equal(templates.waitlist_released[field], expected[field], field);
    }
    assert.equal(Object.values(layouts)[0].html, SEEDS.layouts[0].html);
  });

  await t.test('re-seeding after delete adds nothing', async () => {
    const { templates } = await store.snapshot(pool);
    const v1 = templates.otp;
    const v2 = await store.saveTemplate(pool, { action: 'otp', name: v1.name, layoutFamilyId: v1.layout_family_id, subject: 'Edited', preheader: '', why: v1.why, html: v1.html, text: v1.text, expectedLiveId: v1.id }, null);
    await store.deleteTemplate(pool, v2.id, { replacementId: v1.id }, null);
    // The store always keeps one live, so the last version goes by hand.
    await pool.query("UPDATE email_templates SET status = 'archived', deleted_at = NOW() WHERE action = 'otp'");
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE action = 'otp' AND deleted_at IS NULL"), 0);
    const before = await count('SELECT count(*)::int AS n FROM email_templates');

    await seedEmailTemplates(pool, { source: SOURCE });
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), before);
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE action = 'otp' AND deleted_at IS NULL"), 0);
  });

  await t.test('a deleted layout is not brought back', async () => {
    await pool.query("UPDATE email_layouts SET status = 'archived', deleted_at = NOW()");
    await seedEmailTemplates(pool, { source: SOURCE });
    assert.equal(await count("SELECT count(*)::int AS n FROM email_layouts WHERE deleted_at IS NULL"), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 1);

    // A new kind whose layout an admin deleted waits for an admin, and the rest of
    // the seeding still works.
    await pool.query("DELETE FROM email_templates WHERE action = 'password_reset'");
    await seedEmailTemplates(pool, { source: SOURCE });
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE action = 'password_reset'"), 0);
  });

  await t.test('only the missing kind is added, and an edited one is left alone', async () => {
    await empty();
    await seedEmailTemplates(pool, { source: SOURCE });
    await pool.query("UPDATE email_templates SET subject = 'Edited' WHERE action = 'otp'");
    await pool.query("DELETE FROM email_templates WHERE action = 'password_reset'");
    await seedEmailTemplates(pool, { source: SOURCE });
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE action = 'password_reset' AND version = 1 AND status = 'live'"), 1);
    assert.equal((await pool.query("SELECT subject FROM email_templates WHERE action = 'otp'")).rows[0].subject, 'Edited');
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 1);
  });

  await t.test('servers booting together seed once', async () => {
    await empty();
    await Promise.all(Array.from({ length: 6 }, () => seedEmailTemplates(pool, { source: SOURCE })));
    // A server that lost the lock left the work to the winner, which has finished.
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), KINDS.length);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE version <> 1"), 0);
  });

  await t.test('with nothing to do, a boot costs one query and no connection held', async () => {
    const seen = [];
    const spy = { query: (...args) => { seen.push(args[0]); return pool.query(...args); }, connect: () => { throw new Error('no connection needed'); } };
    await seedEmailTemplates(spy, { source: SOURCE });
    assert.equal(seen.length, 1);
  });

  await t.test('a language in the cache gets its rows, a language with nothing gets none', async () => {
    await empty();
    reset();
    for (const [key, text] of Object.entries(FRENCH)) {
      await pool.query(
        "INSERT INTO language_translations (language, namespace, key, source, text) VALUES ('fr', 'email', $1, $2, $3) ON CONFLICT DO NOTHING",
        [key, hash(ENGLISH[key].text), text],
      );
    }
    await seedEmailTemplates(pool, { source: SOURCE });
    const { rows } = await pool.query(
      `SELECT e.action, t.locale, t.origin, t.subject, t.html FROM email_template_translations t JOIN email_templates e ON e.id = t.template_id`,
    );
    assert.deepEqual(rows.map((row) => row.action).sort(), [...TRANSLATED].sort());
    assert.ok(rows.every((row) => row.locale === 'fr' && row.origin === 'machine'));
    assert.equal(rows.find((row) => row.action === 'otp').subject, FRENCH['otp.subject']);
    assert.match(rows.find((row) => row.action === 'waitlist_joined').html, /Merci d'avoir rejoint/);
    await pool.query("DELETE FROM language_translations WHERE language = 'fr' AND namespace = 'email'");
    reset();
  });

  await t.test('a failed seed changes nothing and the next boot tries again', async () => {
    await empty();
    const failing = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: (sql, params) => (/INSERT INTO email_templates/.test(sql) && params[0] === 'password_reset'
            ? Promise.reject(new Error('no such luck'))
            : client.query(sql, params)),
        };
      },
    };
    await seedEmailTemplates(failing, { source: SOURCE });
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 0);
    await seedEmailTemplates(pool, { source: SOURCE });
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), KINDS.length);
  });

  await t.test('a database that cannot be reached is logged, and never fails the boot', async (st) => {
    const errors = st.mock.method(log, 'error', () => {});
    const broken = { query: () => Promise.reject(new Error('connection refused')), connect: () => Promise.reject(new Error('connection refused')) };
    await seedEmailTemplates(broken, { source: SOURCE });
    assert.equal(errors.mock.callCount(), 1);
    assert.equal(errors.mock.calls[0].arguments[1], 'Could not seed email templates');
  });
});
