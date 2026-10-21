'use strict';

// The notification ask and #4396 against the full schema: the account's
// record of what it was asked (services/notification-asks.js), and the
// members told when a project they joined while it was made opens
// (services/project-opened.js), which rings their phone under Change alerts.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/notify-ask-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const asks = require('../src/services/notification-asks');
const projectOpened = require('../src/services/project-opened');

test('the notification ask against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `notify_ask_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6, connectionTimeoutMillis: 10000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  async function user(username, extra = '') {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access${extra ? ', is_synthetic' : ''})
       VALUES ($1, 'x', TRUE${extra ? ', TRUE' : ''}) RETURNING id, username`,
      [username]);
    return u;
  }
  const maya = await user('maya');
  const sam = await user('sam');
  const alex = await user('alex');
  const lee = await user('lee');
  const bot = await user('notify_ask_bot', 'synthetic');

  await t.test('an answer per account, surface and moment; a later one replaces it', async () => {
    let state = await asks.readAsks(pool, sam.id);
    assert.deepEqual(state, { asks: [], phone: false, email: false });
    await asks.recordAsk(pool, sam.id, { surface: 'web', moment: 'invite_sent', answer: 'not_now' });
    await asks.recordAsk(pool, sam.id, { surface: 'app', moment: 'invite_sent', answer: 'not_now' });
    state = await asks.recordAsk(pool, sam.id, { surface: 'app', moment: 'invite_sent', answer: 'yes' });
    assert.deepEqual(state.asks.map((a) => `${a.surface}:${a.moment}:${a.answer}`).sort(),
      ['app:invite_sent:yes', 'web:invite_sent:not_now']);
    assert.deepEqual((await asks.readAsks(pool, alex.id)).asks, [], 'nobody else\'s');
    await assert.rejects(pool.query(
      `INSERT INTO notification_asks (user_id, surface, moment, answer) VALUES ($1, 'app', 'whenever', 'yes')`,
      [alex.id]), /check/i, 'the table refuses an unknown moment');
  });

  await t.test('email stands in only for a confirmed address with activity email on', async () => {
    await pool.query(`UPDATE users SET email = 'sam@example.test', email_confirmed = TRUE WHERE id = $1`, [sam.id]);
    assert.equal((await asks.readAsks(pool, sam.id)).email, true);
    await pool.query('UPDATE users SET activity_email = FALSE WHERE id = $1', [sam.id]);
    assert.equal((await asks.readAsks(pool, sam.id)).email, false);
  });

  await t.test('project_opened: its members, once, never its maker, the bot or a blocker', async () => {
    const { rows: [community] } = await pool.query('INSERT INTO communities DEFAULT VALUES RETURNING id');
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, community_id) VALUES ('Run Club', 'run-club-open', 'running', $1, $2)
       RETURNING id, community_id`,
      [maya.id, community.id]);
    for (const who of [maya, sam, alex, lee, bot]) {
      await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [app.community_id, who.id]);
    }
    await pool.query('INSERT INTO user_app_blocks (user_id, app_id) VALUES ($1, $2)', [lee.id, app.id]);
    const told = await projectOpened.tellMembers(pool, { appSlug: 'run-club-open', makerId: maya.id });
    assert.deepEqual(told.map((r) => Number(r.user_id)).sort((a, b) => a - b), [sam.id, alex.id].sort((a, b) => a - b));
    assert.deepEqual(await projectOpened.tellMembers(pool, { appSlug: 'run-club-open', makerId: maya.id }), [],
      'a second live tells nobody again');
    const { rows } = await pool.query(
      `SELECT user_id FROM notifications WHERE kind = 'project_opened' AND app_id = $1`, [app.id]);
    assert.equal(rows.length, 2);
  });

  await t.test('it rings under Change alerts, which a person can switch off', async () => {
    const { rows } = await pool.query(
      `SELECT category, default_enabled FROM mobile_push_kind_categories WHERE kind = 'project_opened'`);
    assert.deepEqual(rows, [{ category: 'proposal_alerts', default_enabled: true }]);
  });
});
