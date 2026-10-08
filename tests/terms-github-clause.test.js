'use strict';

// The terms' one-time GitHub clause (issue #4384): the make screen stopped
// saying what you write and the code are public on GitHub, and the fact
// moved into Homeroom's terms — published by the boot as a NEW version
// (services/terms-github-clause.js), so people who accepted the earlier one
// are told the terms changed (frontend/src/features/settings/
// terms-first-run.js). Pins the module's shape next to the identity
// rollout's, and, where a PostgreSQL server is reachable, its behaviour
// against the full schema (the verified-identity-postgres pattern):
// skipped when no server answers, required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const read = (rel) => fs.readFileSync(require.resolve(`../${rel}`), 'utf8');

test('the clause and version read exactly as specified', () => {
  const mod = require('../src/services/terms-github-clause');
  assert.equal(mod.CLAUSE, 'Projects you make here, including their description and code, are public on GitHub.');
  assert.equal(mod.VERSION, '2026-10-github-public');
  assert.equal(mod.MARKER, 'terms_github_public_clause');
});

test('applies() is production only: staging, test, development and unset are all out', () => {
  const { applies } = require('../src/services/terms-github-clause');
  assert.equal(applies({ NODE_ENV: 'production' }), true);
  assert.equal(applies({ NODE_ENV: 'production', USERNODE_ENV: 'staging' }), false, 'staging previews are out');
  assert.equal(applies({ NODE_ENV: 'staging' }), false);
  assert.equal(applies({ NODE_ENV: 'test' }), false);
  assert.equal(applies({ NODE_ENV: 'development' }), false);
  assert.equal(applies({}), false);
});

test('migrate() calls the clause migration next to the identity rollout', () => {
  const migrate = read('src/db/migrate.js');
  const rollout = migrate.indexOf("applyIdentityRollout(pool)");
  const clause = migrate.indexOf('applyTermsGithubClause(pool)');
  assert.ok(clause > 0, 'migrate() must call applyTermsGithubClause(pool)');
  assert.ok(rollout > 0 && clause > rollout, 'after the identity rollout');
});

test('the run reads the current version the way termsCurrentHandler does', () => {
  const mod = read('src/services/terms-github-clause.js');
  assert.match(mod, /published_at IS NOT NULL/);
  assert.match(mod, /ORDER BY published_at DESC, id DESC LIMIT 1/);
  // One transaction carries the marker and the new version together, and
  // the version's UNIQUE constraint arbiters two replicas booting together.
  assert.match(mod, /BEGIN/);
  assert.match(mod, /ON CONFLICT \(key\) DO NOTHING RETURNING key/);
  assert.match(mod, /ON CONFLICT \(version\) DO NOTHING/);
});

test('against the full schema: copies the latest version, appends the clause, runs once', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'terms_github_clause_' + crypto.randomBytes(6).toString('hex');
  let otherName = null; // set below: a second database whose terms already carry the clause
  let other = null;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres'); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    if (other) await other.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    if (otherName) await admin.query(`DROP DATABASE IF EXISTS ${otherName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const mod = require('../src/services/terms-github-clause');
  const ENV = { NODE_ENV: 'production' };
  const NOW = new Date('2026-10-08T12:00:00.000Z');

  // A fresh install: nothing published, so nothing changes and the marker
  // stays unset — a later boot, once terms exist, still carries the clause.
  assert.deepEqual(await mod.applyTermsGithubClause(pool, { env: ENV, now: NOW }),
    { applied: false, reason: 'no_published_terms' });
  assert.equal((await pool.query('SELECT 1 FROM terms_versions')).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM platform_settings WHERE key = 'terms_github_public_clause'")).rowCount, 0);

  // One published version: the boot publishes a new one that copies its
  // title and terms_link, appends the clause after a blank line, and marks.
  await pool.query(
    `INSERT INTO terms_versions (version, title, body_markdown, terms_link, published_at, created_at, updated_at)
     VALUES ('1.4.0', 'Homeroom Terms',
             '# Homeroom Terms' || chr(10) || chr(10) || 'Be kind.',
             'https://homeroom.example/terms', NOW() - INTERVAL '10 days', NOW(), NOW())`
  );
  assert.deepEqual(await mod.applyTermsGithubClause(pool, { env: ENV, now: NOW }),
    { applied: true, version: '2026-10-github-public' });
  const { rows: published } = await pool.query(
    `SELECT version, title, body_markdown, terms_link, published_at
       FROM terms_versions ORDER BY published_at DESC, id DESC`);
  assert.equal(published.length, 2);
  assert.deepEqual(published.map((r) => r.version), ['2026-10-github-public', '1.4.0']);
  const added = published[0];
  assert.equal(added.title, 'Homeroom Terms', 'title copied');
  assert.equal(added.terms_link, 'https://homeroom.example/terms', 'terms_link copied');
  assert.equal(added.body_markdown, '# Homeroom Terms\n\nBe kind.\n\n' + mod.CLAUSE);
  assert.ok(added.published_at, 'published now');
  assert.equal((await pool.query("SELECT 1 FROM platform_settings WHERE key = 'terms_github_public_clause'")).rowCount, 1);

  // A second run adds nothing: the current body now carries the clause, so
  // the run sees it and marks done without publishing.
  assert.deepEqual(await mod.applyTermsGithubClause(pool, { env: ENV, now: NOW }),
    { applied: false, reason: 'already_present' });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM terms_versions')).rows[0].n, 2);

  // A database whose current body already carries the clause: nothing is
  // added, only the marker is written.
  const otherName_ = 'terms_github_clause_' + crypto.randomBytes(6).toString('hex');
  const otherUrl = new URL(url); otherUrl.pathname = '/' + otherName_;
  other = new Pool({ connectionString: String(otherUrl), max: 6 });
  otherName = otherName_;
  await admin.query(`CREATE DATABASE ${otherName_}`);
  await other.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await other.query(
    `INSERT INTO terms_versions (version, title, body_markdown, terms_link, published_at, created_at, updated_at)
     VALUES ('1.5.0', 'Homeroom Terms',
             '# Homeroom Terms' || chr(10) || chr(10) || 'Be kind.' || chr(10) || chr(10) || $1,
             NULL, NOW(), NOW(), NOW())`,
    [mod.CLAUSE]
  );
  assert.deepEqual(await mod.applyTermsGithubClause(other, { env: ENV, now: NOW }),
    { applied: false, reason: 'already_present' });
  assert.equal((await other.query('SELECT count(*)::int AS n FROM terms_versions')).rows[0].n, 1);
  assert.equal((await other.query("SELECT 1 FROM platform_settings WHERE key = 'terms_github_public_clause'")).rowCount, 1);

  // Not production: nothing is read or written at all.
  assert.deepEqual(await mod.applyTermsGithubClause(pool, { env: { NODE_ENV: 'test' }, now: NOW }),
    { applied: false, reason: 'not_production' });
  assert.deepEqual(await mod.applyTermsGithubClause(pool, { env: { NODE_ENV: 'production', USERNODE_ENV: 'staging' }, now: NOW }),
    { applied: false, reason: 'not_production' });
});