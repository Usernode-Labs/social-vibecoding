'use strict';

// scripts/migrate-kubernetes.js: the migration Job is where production seeds the
// email templates, and pods never do. A seed that failed or was skipped would
// leave a release sending plain mail or none, so the Job refuses to finish: the
// release stops and the running pods keep sending. Only the Job checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const languageCache = require('../src/services/language-cache');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const ROOT = path.join(__dirname, '..');
const ENGLISH = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/email.json'), 'utf8'));
const SOURCE = { files: { 'config.json': { sourceLanguage: 'en', languages: { en: 'English' } }, 'glossary.json': {}, 'en/email.json': ENGLISH } };

test('the Job stops on missing email templates, and only the Job checks', () => {
  const job = fs.readFileSync(path.join(ROOT, 'scripts/migrate-kubernetes.js'), 'utf8');
  const main = job.slice(job.indexOf('async function main'));
  assert.ok(main.indexOf('await migrate(config)') < main.indexOf('await requireEmailTemplates(pool)'), 'checked after the migration seeded');
  for (const file of ['server.js', 'src/db/migrate.js', 'src/db/email-template-seeds.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /requireEmailTemplates/, file);
  }
});

test('requireEmailTemplates against PostgreSQL', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('Set TEST_DATABASE_URL for PostgreSQL'); return;
  }
  const name = 'mail_job_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const dbPool = require('../src/db/pool');
  const originalGetPool = dbPool.getPool;
  dbPool.getPool = () => pool;
  t.after(() => { dbPool.getPool = originalGetPool; });
  t.mock.method(languageCache, 'readSource', () => SOURCE);
  const { migrate } = require('../src/db/migrate');
  await migrate({ databaseUrl: String(url), adminUsername: 'job-admin', adminPassword: 'only-for-tests', selfAppSlug: 'job-platform', platformRepoUrl: 'https://github.com/example/platform' });
  const { requireEmailTemplates } = require('../scripts/migrate-kubernetes');

  await requireEmailTemplates(pool, {});
  await pool.query("UPDATE email_templates SET status = 'archived', deleted_at = NOW() WHERE action IN ('otp', 'project_opened')");
  await assert.rejects(requireEmailTemplates(pool, {}), (err) => {
    assert.match(err.message, /otp, project_opened/);
    assert.match(err.message, /release stops/);
    return true;
  });
  // A preview is never checked: its mail is not production's, and a reviewer may
  // have deleted a template on purpose.
  await requireEmailTemplates(pool, { USERNODE_ENV: 'staging' });
});
