'use strict';

// The push sender as the push-drain clock's run (src/workflow/clock/
// services.ts): every row it claims carries the run's work item and attempt,
// and a row left 'sending' is sent again only when that attempt is no longer
// live (or was this run's own, in an earlier pass). Before, each pass reset
// every 'sending' row, so the sender a release elected sent again what the
// one it replaced was still sending: a push twice at every release.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a row a live run is sending is left to it; one whose run is gone is sent again', async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'push_drain_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [user] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('ada', 'x') RETURNING id`);
  const delivery = async (status, claimedWork, claimedAttempt) => {
    const { rows: [n] } = await pool.query(
      `INSERT INTO notifications (user_id, kind) VALUES ($1, 'test_alert') RETURNING id`, [user.id]);
    const { rows: [d] } = await pool.query(
      `INSERT INTO mobile_push_deliveries (notification_id, environment, installation_id, status, claimed_work, claimed_attempt)
       VALUES ($1, 'production', $2, $3, $4, $5) RETURNING id`,
      [n.id, crypto.randomUUID(), status, claimedWork, claimedAttempt]);
    return d.id;
  };
  // Two runs of the drain: one live (its lease ahead), one whose process went.
  const work = async (leaseSeconds) => {
    const id = crypto.randomUUID();
    await pool.query(`BEGIN; SET LOCAL app.wf_writer = 'transition';
      INSERT INTO wf_work (id, machine, key, kind, work_key, input, status, attempt_count, claim_id, lease_until)
      VALUES ('${id}', 'clock', 'clock:push-drain', 'clock.push-drain', 'run:${leaseSeconds}', '{}', 'running', 1,
              gen_random_uuid(), now() + make_interval(secs => ${leaseSeconds}));
      COMMIT`);
    return id;
  };
  const live = await work(60);
  const gone = await work(-60);
  const mine = { workId: crypto.randomUUID(), attempt: 1 };

  const heldByLive = await delivery('sending', live, 1);
  const leftByGone = await delivery('sending', gone, 1);
  const myEarlierPass = await delivery('sending', mine.workId, 1);
  const unclaimed = await delivery('sending', null, null);

  const { MobilePushWorker } = require('../src/services/mobile-push-worker');
  const worker = new MobilePushWorker({ pool, config: { mobilePushEnabled: true, mobilePushEnvironment: 'production' }, provider: {} });
  await worker.resetInterrupted(mine);

  const { rows } = await pool.query('SELECT id, status, claimed_work FROM mobile_push_deliveries ORDER BY id');
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.equal(by.get(heldByLive).status, 'sending', 'a live run\'s row is left to it');
  assert.equal(by.get(heldByLive).claimed_work, live);
  assert.equal(by.get(leftByGone).status, 'pending', 'a row whose run is gone is sent again');
  assert.equal(by.get(myEarlierPass).status, 'pending', 'and so is one an earlier pass of this run left');
  assert.equal(by.get(unclaimed).status, 'pending', 'and one an older build claimed with no token');
  assert.equal(by.get(leftByGone).claimed_work, null);
});
