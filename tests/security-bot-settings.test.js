'use strict';
// The daily security bot's settings (#4678): finite, bounded caps that are
// off by default, refused on write when invalid, and read back as the safe
// defaults when missing or malformed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');
const settings = require('../src/services/security-bot/settings');
const { ADMIN_MUTATION_LOCK } = require('../src/services/advisory-locks');

test('defaults are the spec values and the bot ships disabled', () => {
  assert.deepEqual({ ...settings.DEFAULTS }, {
    enabled: false,
    schedule_hour_utc: 6,
    daily_budget_usd: 5,
    weekly_budget_usd: 35,
    max_run_minutes: 30,
    max_target_requests: 300,
    max_attacker_calls: 60,
    max_output_tokens: 4096,
    max_parallel_requests: 2,
  });
  assert.equal(settings.storedText('schedule_hour_utc', 6), '06');
  assert.equal(settings.storedText('daily_budget_usd', 5), '5.00');
});

test('zero, negative, unlimited, infinite and out-of-range values are refused', () => {
  const bad = {
    daily_budget_usd: [0, '0', '0.00', -1, '-5', 'unlimited', Infinity, NaN, '1e3', '101', '', null, '5.001'],
    weekly_budget_usd: [0, 'Infinity', 701],
    max_run_minutes: [0, -3, 121, '30.5', 'none'],
    max_target_requests: [0, 1001, Number.MAX_SAFE_INTEGER],
    max_attacker_calls: [0, 201],
    max_output_tokens: [0, 16385],
    max_parallel_requests: [0, 9],
    schedule_hour_utc: [-1, 24, '6am'],
    enabled: ['yes', 1, null],
  };
  for (const [name, values] of Object.entries(bad)) {
    for (const v of values) {
      assert.equal(settings.parseValue(name, v).ok, false, `${name}=${String(v)} must be refused`);
    }
  }
  assert.equal(settings.parseValue('no_such_setting', 1).ok, false);
  assert.deepEqual(settings.parseValue('daily_budget_usd', '4.50'), { ok: true, value: 4.5 });
  assert.deepEqual(settings.parseValue('schedule_hour_utc', '00'), { ok: true, value: 0 });
  assert.deepEqual(settings.parseValue('enabled', 'true'), { ok: true, value: true });
});

test('readers fall back to the defaults for missing or malformed rows', () => {
  const p = settings.PREFIX;
  const out = settings.fromRows([
    { key: `${p}enabled`, value: 'maybe' },
    { key: `${p}max_attacker_calls`, value: '0' },
    { key: `${p}max_output_tokens`, value: 'unlimited' },
    { key: `${p}max_run_minutes`, value: '45' },
    { key: 'unrelated', value: '1' },
  ]);
  assert.equal(out.enabled, false);
  assert.equal(out.max_attacker_calls, 60);
  assert.equal(out.max_output_tokens, 4096);
  assert.equal(out.max_run_minutes, 45);
  // A stored weekly cap below the daily cap is not trusted: both defaults.
  const inverted = settings.fromRows([
    { key: `${p}daily_budget_usd`, value: '20.00' },
    { key: `${p}weekly_budget_usd`, value: '10.00' },
  ]);
  assert.equal(inverted.daily_budget_usd, 5);
  assert.equal(inverted.weekly_budget_usd, 35);
});

test('a read failure answers the disabled defaults rather than throwing', async () => {
  const pool = { query: async () => { throw new Error('connection refused'); } };
  assert.deepEqual(await settings.read(pool), { ...settings.DEFAULTS });
});

test('limitsSnapshot captures the caps a run starts under, and nothing else', () => {
  const snap = settings.limitsSnapshot({ ...settings.DEFAULTS, enabled: true, max_attacker_calls: 12 });
  assert.equal(snap.max_attacker_calls, 12);
  assert.equal(snap.daily_budget_usd, 5);
  assert.ok(!('enabled' in snap));
  assert.ok(!('schedule_hour_utc' in snap));
});

test('write validates, holds ADMIN_MUTATION_LOCK and stores bounded text (PostgreSQL)', { timeout: 60000 }, async (t) => {
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const root = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await root.connect(); } catch (err) { await root.end().catch(() => {}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const name = `security_bot_settings_${process.pid}`;
  let pool;
  try {
    await root.query(`DROP DATABASE IF EXISTS ${name}`);
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(dsn); url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));

    // Nothing stored: the defaults, disabled.
    assert.deepEqual(await settings.read(pool), { ...settings.DEFAULTS });

    const stored = async () => Object.fromEntries((await pool.query(
      "SELECT key, value FROM platform_settings WHERE key LIKE 'security\\_bot.%' ORDER BY key")).rows
      .map((r) => [r.key, r.value]));

    const after = await settings.write(pool, { enabled: true, daily_budget_usd: '4.5', schedule_hour_utc: 7 });
    assert.equal(after.enabled, true);
    assert.deepEqual(await stored(), {
      'security_bot.daily_budget_usd': '4.50',
      'security_bot.enabled': 'true',
      'security_bot.schedule_hour_utc': '07',
    });
    assert.equal((await settings.read(pool)).daily_budget_usd, 4.5);

    // An invalid value writes nothing, not even the valid key beside it.
    await assert.rejects(settings.write(pool, { max_run_minutes: 10, max_attacker_calls: 0 }),
      (err) => err.code === 'invalid_setting' && err.setting === 'max_attacker_calls');
    await assert.rejects(settings.write(pool, { weekly_budget_usd: 'unlimited' }),
      (err) => err.code === 'invalid_setting');
    // A weekly cap under the stored daily cap is refused against the merged values.
    await assert.rejects(settings.write(pool, { weekly_budget_usd: '4.00' }),
      (err) => err.code === 'invalid_setting' && err.setting === 'weekly_budget_usd');
    assert.equal(Object.keys(await stored()).length, 3, 'refused writes left the stored rows alone');

    // The write waits for ADMIN_MUTATION_LOCK.
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);
    let done = false;
    const pending = settings.write(pool, { max_run_minutes: 20 }).then((v) => { done = true; return v; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(done, false, 'the write is blocked while another admin mutation holds the lock');
    await holder.query('COMMIT');
    holder.release();
    assert.equal((await pending).max_run_minutes, 20);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
});
