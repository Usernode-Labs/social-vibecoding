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

  await t.test('a second driver, in this process or another, does not take a campaign another one drives', async () => {
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
