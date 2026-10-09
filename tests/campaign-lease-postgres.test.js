'use strict';

// One driver per maintenance campaign, in any process (fleet-maintenance.js
// runCampaign): the lease on the campaign row, against the full PostgreSQL
// schema. Before it, the only guard was an in-process set, so a second
// process (the dashboard's retry on the other pod, the new leader resuming
// while the old one still drained) drove the same campaign at the same time.
// The model and GitHub are stubbed; a model call can be held open, which is
// where a driver spends its time.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const stub = (p, exports) => { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] }; };
// Each model call answers "skip this app", once the test lets it.
const model = { calls: 0, gate: null };
stub('../src/services/llm', {
  isEnabled: () => true,
  estimateCostCents: () => 0,
  async streamChat() {
    model.calls += 1;
    if (model.gate) await model.gate.promise;
    return { toolUses: [{ id: `t${model.calls}`, name: 'skip_app', input: { reason: 'not needed' } }],
      rawContent: [], stopReason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, servedModel: 'test' };
  },
});
stub('../src/services/github', { isEnabled: () => true, async getFileContent() { return null; } });
stub('../src/services/limits', { async recordSpend() {} });
const shutdown = { now: false };
stub('../src/services/lifecycle', { ...require('../src/services/lifecycle'), isShuttingDown: () => shutdown.now });
const fleet = require('../src/services/fleet-maintenance');

function gate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}

test('maintenance campaigns: one driver at a time, whichever process calls', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'campaign_lease_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows: [owner] } = await pool.query(`INSERT INTO users (username, password) VALUES ('owner', 'x') RETURNING id`);
  for (const slug of ['one', 'two']) {
    await pool.query(`INSERT INTO apps (name, slug, created_by, repo_url) VALUES ($1::text, $1::text, $2, 'https://github.com/acme/' || $1::text)`, [slug, owner.id]);
  }
  const campaign = async () => (await pool.query(
    `INSERT INTO maintenance_campaigns (title, instructions, status) VALUES ('Tidy', 'Tidy up', 'running') RETURNING id`)).rows[0].id;
  const rowsOf = async (id) => (await pool.query(
    `SELECT a.slug, m.state, m.runner_id FROM maintenance_campaign_apps m JOIN apps a ON a.id = m.app_id
      WHERE m.campaign_id = $1 ORDER BY a.slug`, [id])).rows;
  const leaseOf = async (id) => (await pool.query('SELECT status, runner_id, lease_until FROM maintenance_campaigns WHERE id = $1', [id])).rows[0];
  const until = async (fn, what) => {
    for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`timed out waiting for ${what}`);
  };

  await t.test('a second driver does not take a campaign another one drives (the lease is in the database, so the process does not matter)', async () => {
    const id = await campaign();
    model.gate = gate();
    const first = fleet.runCampaign({}, pool, id);
    await until(() => model.calls > 0, 'the first driver to be working on an app');
    assert.deepEqual(await fleet.runCampaign({}, pool, id), { ran: false, reason: 'not_taken' });
    model.gate.open();
    model.gate = null;
    assert.deepEqual(await first, { ran: true });
    assert.deepEqual((await rowsOf(id)).map((r) => r.state), ['skipped', 'skipped']);
    const done = await leaseOf(id);
    assert.equal(done.status, 'done');
    assert.equal(done.lease_until, null, 'let go when it ends');
  });

  await t.test('a driver whose lease lapsed is replaced, and what it was doing is neither lost nor written twice', async () => {
    const id = await campaign();
    model.calls = 0;
    model.gate = gate();
    // The old pod: still working through its drain while its lease runs out.
    const old = fleet.runCampaign({}, pool, id);
    await until(() => model.calls > 0, 'the old driver to be working on an app');
    const oldRunner = (await leaseOf(id)).runner_id;
    assert.equal((await rowsOf(id)).filter((r) => r.state === 'running').length, 1);
    await pool.query(`UPDATE maintenance_campaigns SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [id]);
    // The new leader resumes it: the app the old driver held is run again.
    const held = model.gate;
    model.gate = null;
    assert.deepEqual(await fleet.runCampaign({}, pool, id), { ran: true });
    const after = await rowsOf(id);
    assert.deepEqual(after.map((r) => r.state), ['skipped', 'skipped']);
    assert.ok(after.every((r) => r.runner_id !== oldRunner), 'every result written by the driver that holds the lease');
    // The old driver's answer comes in late: it writes nothing, and stops.
    held.open();
    assert.deepEqual(await old, { ran: true, paused: 'lease_lost' });
    assert.deepEqual((await rowsOf(id)).map((r) => r.runner_id), after.map((r) => r.runner_id), 'nothing it wrote landed');
  });

  await t.test('a driver whose lease went to another writes nothing more and claims nothing more', async () => {
    const id = await campaign();
    model.calls = 0;
    model.gate = gate();
    const stale = fleet.runCampaign({}, pool, id);
    await until(() => model.calls > 0, 'the driver to be working on its first app');
    const [held] = (await rowsOf(id)).filter((r) => r.state === 'running');
    // Another driver holds the lease now (it took it while this one was stalled).
    await pool.query(`UPDATE maintenance_campaigns SET runner_id = 'another', lease_until = NOW() + INTERVAL '2 minutes' WHERE id = $1`, [id]);
    const answered = model.gate;
    model.gate = null;
    answered.open();
    assert.deepEqual(await stale, { ran: true, paused: 'lease_lost' });
    const after = await rowsOf(id);
    assert.deepEqual(after.find((r) => r.slug === held.slug), held, 'its answer for the app it held did not land');
    assert.ok(after.filter((r) => r.slug !== held.slug).every((r) => r.state === 'pending'), 'and it claimed no other app');
    assert.equal((await leaseOf(id)).runner_id, 'another');
    assert.equal(model.calls, 1, 'no model call after it lost the lease');
  });

  await t.test('a campaign is done only when no app is pending or still running', async () => {
    const id = await campaign();
    const { rows: [one] } = await pool.query(`SELECT id FROM apps WHERE slug = 'one'`);
    // A row a replaced driver still holds: this driver resets it when it takes the lease.
    await pool.query(
      `INSERT INTO maintenance_campaign_apps (campaign_id, app_id, state, runner_id, updated_at)
       VALUES ($1, $2, 'running', 'gone', NOW() - INTERVAL '2 hours')`, [id, one.id]);
    await pool.query(`UPDATE maintenance_campaigns SET runner_id = 'gone', lease_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id]);
    model.calls = 0;
    assert.deepEqual(await fleet.runCampaign({}, pool, id), { ran: true });
    assert.deepEqual((await rowsOf(id)).map((r) => r.state), ['skipped', 'skipped'], 'the held row was run again, then done');
    assert.equal((await leaseOf(id)).status, 'done');
  });

  await t.test('a takeover waits for a fenced write in progress, so it never lands in the middle of one', async () => {
    // A write that waits on an app row's lock would re-read that row, but not
    // the lease it checked before the wait (another review's finding: the
    // reset then reset a successor's claim). The fence holds the lease's row.
    const id = await campaign();
    const { rows: [one] } = await pool.query(`SELECT id FROM apps WHERE slug = 'one'`);
    const { rows: [row] } = await pool.query(
      `INSERT INTO maintenance_campaign_apps (campaign_id, app_id, state, runner_id) VALUES ($1, $2, 'running', 'gone') RETURNING id`,
      [id, one.id]);
    await pool.query(`UPDATE maintenance_campaigns SET runner_id = 'mine', lease_until = NOW() + INTERVAL '1 second' WHERE id = $1`, [id]);
    const holder = await pool.connect();   // someone else holds the app row
    let released = false;
    const release = async () => { if (!released) { released = true; await holder.query('COMMIT'); holder.release(); } };
    let write = null;
    let takeover = null;
    let took = null;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM maintenance_campaign_apps WHERE id = $1 FOR UPDATE', [row.id]);
      write = fleet.underLease(pool, id, 'mine', (c) => c.query(
        `UPDATE maintenance_campaign_apps SET state = 'pending' WHERE id = $1 AND state = 'running'`, [row.id]));
      await new Promise((r) => setTimeout(r, 1200));   // its lease has run out meanwhile
      takeover = fleet.takeLease(pool, id, 'successor').then((c) => { took = c; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(took, null, 'the takeover waits while the fenced write is in progress');
    } finally {
      await release();   // a failure above must not leave the row locked
      await Promise.allSettled([write, takeover]);
    }
    assert.ok(await write, 'the write landed, under the lease it held when it began');
    assert.equal(took?.runner_id, 'successor', 'and the successor takes over after it, not in the middle');
    assert.equal((await pool.query('SELECT state FROM maintenance_campaign_apps WHERE id = $1', [row.id])).rows[0].state, 'pending');
  });

  await t.test('a campaign a driver from before the lease is still moving is left to it', async () => {
    const id = await campaign();
    const { rows: [one] } = await pool.query(`SELECT id FROM apps WHERE slug = 'one'`);
    // Its rows, as that driver leaves them: one claimed a minute ago, no lease taken.
    await pool.query(
      `INSERT INTO maintenance_campaign_apps (campaign_id, app_id, state, updated_at) VALUES ($1, $2, 'running', NOW() - INTERVAL '1 minute')`,
      [id, one.id]);
    assert.deepEqual(await fleet.runCampaign({}, pool, id), { ran: false, reason: 'not_taken' });
    // Quiet for half an hour: it is gone, and the campaign is taken up.
    await pool.query(`UPDATE maintenance_campaign_apps SET updated_at = NOW() - INTERVAL '31 minutes' WHERE campaign_id = $1`, [id]);
    model.calls = 0;
    assert.deepEqual(await fleet.runCampaign({}, pool, id), { ran: true });
    assert.deepEqual((await rowsOf(id)).map((r) => r.state), ['skipped', 'skipped']);
  });

  await t.test('a process shutting down stops between apps and lets the lease go for the next leader', async () => {
    const id = await campaign();
    shutdown.now = true;
    try {
      assert.deepEqual(await fleet.runCampaign({}, pool, id), { ran: true, paused: 'shutting_down' });
    } finally { shutdown.now = false; }
    assert.equal((await leaseOf(id)).lease_until, null);
    assert.equal((await leaseOf(id)).status, 'running', 'still to do');
    // The resume takes it up (only campaigns no driver holds).
    await fleet.resumeRunningCampaigns({}, pool);
    await until(async () => (await leaseOf(id)).status === 'done', 'the resumed campaign to finish');
  });
});
