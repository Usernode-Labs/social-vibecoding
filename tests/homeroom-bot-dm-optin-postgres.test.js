'use strict';

// #3624: joining the Homeroom bot's DM from Settings, against the full
// PostgreSQL schema.
//
// What only a real database can show: the compare-and-swap UPDATE in
// setDmMember matches the stored text exactly, so people joining at the
// same moment all land and none is written out; an admin's save of the list
// and a self-join compose; and the bot's own gate (isEnabledFor, which
// /api/auth/me reports as `homeroomBotDm`) reads what was written.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const dm = require('../src/services/homeroom-bot-dm');
const homeroomBot = require('../src/services/homeroom-bot');

test('joining the Homeroom bot DM against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_optin_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  let seq = 0;
  async function user(prefix) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access)
       VALUES ($1, 'x', TRUE) RETURNING id, username`,
      [`${prefix}_${++seq}`],
    );
    return rows[0];
  }
  const stored = async () => {
    const { rows } = await pool.query(`SELECT value, updated_by FROM platform_settings WHERE key = 'homeroom_bot_dm_users'`);
    return { list: JSON.parse(rows[0].value), updatedBy: rows[0].updated_by };
  };
  const ada = await user('Ada');

  await t.test('a join lands on the seeded list, says who wrote it, and the bot\'s gate agrees', async () => {
    assert.deepEqual((await stored()).list, [], 'seeded empty');
    assert.equal(await dm.isEnabledFor(pool, ada), false);
    assert.deepEqual(await homeroomBot.setDmMember(pool, ada.username, true, ada.id), { ok: true, joined: true, changed: true });
    assert.deepEqual(await stored(), { list: [ada.username.toLowerCase()], updatedBy: ada.id });
    assert.equal(await dm.isEnabledFor(pool, ada), true);
    assert.deepEqual((await homeroomBot.readSettings(pool)).dmUsers, [ada.username.toLowerCase()]);
  });

  await t.test('people joining at the same moment all land', async () => {
    const people = await Promise.all(Array.from({ length: 8 }, () => user('crowd')));
    const results = await Promise.all(people.map((p) => homeroomBot.setDmMember(pool, p.username, true, p.id)));
    for (const r of results) assert.equal(r.ok, true, JSON.stringify(r));
    const { list } = await stored();
    assert.equal(list.length, 9, 'Ada and all eight');
    for (const p of people) assert.ok(list.includes(p.username.toLowerCase()), p.username);
    // Leave them all again, at once too.
    await Promise.all(people.map((p) => homeroomBot.setDmMember(pool, p.username, false, p.id)));
    assert.deepEqual((await stored()).list, [ada.username.toLowerCase()]);
  });

  await t.test('an admin\'s save and a self-join compose; leaving keeps the admin\'s people', async () => {
    const sam = await user('sam');
    assert.equal((await homeroomBot.writeSettings(pool, { dmUsers: [ada.username, 'evan'] }, null)).ok, true);
    assert.equal((await homeroomBot.setDmMember(pool, sam.username, true, sam.id)).ok, true);
    assert.deepEqual((await stored()).list, [ada.username.toLowerCase(), 'evan', sam.username.toLowerCase()]);
    assert.equal((await homeroomBot.setDmMember(pool, ada.username, false, ada.id)).changed, true);
    assert.deepEqual((await stored()).list, ['evan', sam.username.toLowerCase()]);
    assert.equal(await dm.isEnabledFor(pool, ada), false, 'off the list, off for the bot');
  });

  await t.test('a full list refuses a join and writes nothing', async () => {
    const full = Array.from({ length: homeroomBot.MAX_DM_USERS }, (_, i) => `u${i}`);
    assert.equal((await homeroomBot.writeSettings(pool, { dmUsers: full }, null)).ok, true);
    const before = await pool.query(`SELECT value, updated_at FROM platform_settings WHERE key = 'homeroom_bot_dm_users'`);
    assert.deepEqual(await homeroomBot.setDmMember(pool, ada.username, true, ada.id),
      { ok: false, error: 'full', max: homeroomBot.MAX_DM_USERS });
    const after = await pool.query(`SELECT value, updated_at FROM platform_settings WHERE key = 'homeroom_bot_dm_users'`);
    assert.deepEqual(after.rows, before.rows);
  });
});
