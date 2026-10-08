'use strict';

// Custom domains (#4405) against a REAL PostgreSQL: the app_domains table as
// schema.sql ships it, and the statements services/app-domains.js and the
// Caddy ask (routes/internal.js isKnownHost) run over it.
//
//   * one claim per app and one app per hostname, as the indexes say;
//   * the status constraint and the hostname grammar;
//   * claim, taken, released-when-failed, the daily cap, remove;
//   * lookupLiveHost answers only a live row; isKnownHost only verified or
//     live; adminList joins the project and the person.
//
// Set TEST_DATABASE_URL to run; without a reachable server it skips.
//
// Run with: node --test tests/app-domains-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.USERNODE_DOMAIN = process.env.USERNODE_DOMAIN || 'social-vibecoding.usernodelabs.org';
delete process.env.APP_RUNTIME;
const DOMAIN = process.env.USERNODE_DOMAIN;
const appDomains = require('../src/services/app-domains');
const { isKnownHost } = require('../src/routes/internal');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `app_domains_test_${process.pid}`;
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

function statement(re, label) {
  const m = SCHEMA_SQL.match(re);
  assert.ok(m, `${label} must be findable in schema.sql`);
  return m[0];
}
const TABLE = statement(/CREATE TABLE IF NOT EXISTS app_domains \([\s\S]*?\n\);/, 'app_domains');
const ONE_PER_APP = statement(/CREATE UNIQUE INDEX IF NOT EXISTS app_domains_one_per_app[\s\S]*?;/, 'its one-per-app index');
const CONSTRAINTS = statement(/DO \$\$\nBEGIN\n  IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'app_domains_status_check'\)[\s\S]*?END \$\$;/, 'its constraints');

async function connect() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch {
    await probe.end().catch(() => {});
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({ connectionString: DSN, max: 4, options: `-c search_path=${SCHEMA_NAME}` });
  await pool.query(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE apps (id INTEGER PRIMARY KEY, slug TEXT UNIQUE, name TEXT, runtime_name TEXT);
    CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, staging_url TEXT);
    CREATE TABLE events (
      id SERIAL PRIMARY KEY, user_id INTEGER, app_id INTEGER, session_id INTEGER,
      event_type VARCHAR(64), metadata JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO users (id, username) VALUES (1, 'ada'), (2, 'bo');
    INSERT INTO apps (id, slug, name) VALUES (10, 'bread-bot', 'Bread Bot'), (11, 'other-app', 'Other');
  `);
  await pool.query(TABLE);
  await pool.query(ONE_PER_APP);
  await pool.query(CONSTRAINTS);
  return { pool };
}

let ctx;
test.before(async () => { ctx = await connect(); });
test.after(async () => {
  if (!ctx?.pool) return;
  await ctx.pool.query(`DROP SCHEMA ${SCHEMA_NAME} CASCADE`).catch(() => {});
  await ctx.pool.end();
});
test.beforeEach(async () => {
  if (ctx?.pool) await ctx.pool.query('DELETE FROM app_domains; DELETE FROM events;');
  appDomains.resetCachesForTest();
});

const ADA = { id: 1, username: 'ada' };
const BREAD = { id: 10, slug: 'bread-bot', name: 'Bread Bot' };
const OTHER = { id: 11, slug: 'other-app', name: 'Other' };

test('the table refuses a status it does not know and a hostname that is not one', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const insert = (hostname, status) => ctx.pool.query(
    'INSERT INTO app_domains (app_id, hostname, verification_token, status) VALUES (10, $1, $2, $3)',
    [hostname, 'a'.repeat(32), status]
  );
  await assert.rejects(insert('app.example.com', 'bogus'), /app_domains_status_check/);
  await assert.rejects(insert('App.Example.com', 'pending'), /app_domains_hostname_check/, 'stored lower-case only');
  await assert.rejects(insert('-bad.example.com', 'pending'), /app_domains_hostname_check/);
  await assert.rejects(insert('nodots', 'pending'), /app_domains_hostname_check/);
  await insert('app.example.com', 'pending');
  await assert.rejects(insert('again.example.com', 'pending'), /app_domains_one_per_app/, 'one per project');
  await assert.rejects(ctx.pool.query(
    'INSERT INTO app_domains (app_id, hostname, verification_token) VALUES (11, $1, $2)', ['app.example.com', 'b'.repeat(32)]
  ), /app_domains_hostname_key/, 'one project per hostname');
});

test('claim: the row, its token, the event; a second claim and a taken host are refused; a failed one is released', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const row = await appDomains.claim(ctx.pool, BREAD, 'App.Example.com', ADA);
  assert.equal(row.hostname, 'app.example.com');
  assert.equal(row.status, 'pending');
  assert.match(row.verification_token, /^[0-9a-f]{32}$/);
  assert.equal(row.created_by, 1);
  const { rows: evs } = await ctx.pool.query('SELECT user_id, app_id, event_type, metadata FROM events');
  assert.deepEqual(evs, [{ user_id: 1, app_id: 10, event_type: 'app_domain_changed', metadata: { hostname: 'app.example.com', action: 'added' } }]);

  await assert.rejects(appDomains.claim(ctx.pool, BREAD, 'second.example.com', ADA), (err) => err.code === 'already_has_domain');
  await assert.rejects(appDomains.claim(ctx.pool, OTHER, 'app.example.com', ADA), (err) => err.code === 'hostname_taken');
  await ctx.pool.query("UPDATE app_domains SET status = 'failed' WHERE id = $1", [row.id]);
  const theirs = await appDomains.claim(ctx.pool, OTHER, 'app.example.com', { id: 2, username: 'bo' });
  assert.equal(theirs.app_id, 11, 'the failed claim was released to the other project');
  assert.equal(await appDomains.forApp(ctx.pool, 10), null);
});

test('the daily cap counts the person’s claims of the last day', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  for (let i = 0; i < appDomains.MAX_CLAIMS_PER_USER_PER_DAY; i += 1) {
    await ctx.pool.query(
      "INSERT INTO events (user_id, app_id, event_type, metadata) VALUES (1, 10, 'app_domain_changed', $1::jsonb)",
      [JSON.stringify({ hostname: `h${i}.example.com`, action: 'added' })]
    );
  }
  await assert.rejects(appDomains.claim(ctx.pool, BREAD, 'late.example.com', ADA), (err) => err.code === 'claim_limit');
  // Old claims do not count.
  await ctx.pool.query("UPDATE events SET created_at = NOW() - INTERVAL '2 days'");
  assert.ok(await appDomains.claim(ctx.pool, BREAD, 'late.example.com', ADA));
});

test('only a LIVE row serves a host; only verified or live may cost a certificate', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const row = await appDomains.claim(ctx.pool, BREAD, 'app.example.com', ADA);
  const serves = async () => appDomains.lookupLiveHost(ctx.pool, 'app.example.com');
  const issues = async () => isKnownHost(ctx.pool, 'app.example.com');
  const setStatus = (status) => ctx.pool.query('UPDATE app_domains SET status = $2 WHERE id = $1', [row.id, status]);
  assert.equal(await serves(), null);
  assert.equal(await issues(), false);
  await setStatus('verified');
  assert.equal(await serves(), null);
  assert.equal(await issues(), true);
  await setStatus('live');
  assert.deepEqual(await serves(), { app_id: 10, slug: 'bread-bot', name: 'Bread Bot' });
  assert.equal(await issues(), true);
  assert.deepEqual(await appDomains.resolveAppHost(ctx.pool, 'app.example.com'),
    { slug: 'bread-bot', label: 'bread-bot', host: 'app.example.com', custom: true });
  await setStatus('disabled');
  appDomains.resetCachesForTest();
  assert.equal(await serves(), null);
  assert.equal(await issues(), false);
  assert.equal(await appDomains.resolveAppHost(ctx.pool, 'app.example.com'), null);
  // The Homeroom host still answers the slug path, as before.
  assert.equal(await isKnownHost(ctx.pool, `bread-bot.${DOMAIN}`), true);
});

test('remove deletes the row and records it; disable and enable move the status and record who', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const row = await appDomains.claim(ctx.pool, BREAD, 'app.example.com', ADA);
  const disabled = await appDomains.disable(ctx.pool, { appRuntime: 'docker' }, row, { id: 2 });
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.disabled_by, 2);
  assert.ok(disabled.disabled_at);
  const enabled = await appDomains.enable(ctx.pool, disabled, { id: 2 });
  assert.equal(enabled.status, 'pending');
  assert.equal(enabled.disabled_at, null);
  const list = await appDomains.adminList(ctx.pool);
  assert.equal(list.length, 1);
  assert.equal(list[0].app_slug, 'bread-bot');
  assert.equal(list[0].app_name, 'Bread Bot');
  assert.equal(list[0].created_by_username, 'ada');
  await appDomains.remove(ctx.pool, { appRuntime: 'docker' }, BREAD, enabled, ADA);
  assert.equal(await appDomains.forApp(ctx.pool, 10), null);
  const { rows: actions } = await ctx.pool.query("SELECT metadata->>'action' AS action FROM events ORDER BY id");
  assert.deepEqual(actions.map((r) => r.action), ['added', 'disabled', 'enabled', 'removed']);
});
