'use strict';

// B2: weekly building time. A request whose payer's week is used up is held
// until the week resets, keeping its place, instead of being dropped and
// queued again by every refresh; the lane leaves it alone until then.
//
// The queue is the bot-request machine's projection: a runtime of the bot's
// two machines (its work faked, the bot off so the lane grants nothing)
// applies what the refresh and an ask append.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-allowance-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const homeroomBot = require('../src/services/homeroom-bot');
const limits = require('../src/services/limits');
const rules = require('../src/workflow/rules/bot-loop.ts');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const requestMachine = require('../src/workflow/bot-request/machine.ts');
const laneMachine = require('../src/workflow/bot-lane/machine.ts');
const { TURN_STOP } = require('../src/workflow/rules/turn-stop.ts');

function botLoop(pool) {
  const kinds = [...Object.values(requestMachine.WORK), ...Object.values(laneMachine.WORK), TURN_STOP];
  const services = Object.fromEntries(kinds.map((k) => [k, {
    maxAttempts: 1, backoffMs: () => 0, leaseMs: 600, concurrency: 4, async run() { return { outcome: 'done' }; },
  }]));
  return createRuntime({
    pool, pollMs: 50, publish: async () => {}, services,
    machines: [requestMachine.botRequest({ staging: false }), laneMachine.botLane({ staging: false })],
  });
}

test('weekly building time against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_week_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  const { rows: [ada] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('ada', 'x', TRUE) RETURNING id`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url)
     VALUES ('Plant Pal', 'plant-pal', 'running', $1, 'https://github.com/usernode-bot/plant-pal') RETURNING *`,
    [ada.id],
  );
  const reset = limits.weeklyResetAt();
  const rt = botLoop(pool);
  t.after(() => rt.stop());
  // What the lane would grant on the project (no app paused).
  const candidates = async () => (await pool.query(rules.READ_CANDIDATES_SQL, [null, []])).rows
    .filter((r) => Number(r.app_id) === Number(app.id)).map((r) => Number(r.issue_number));
  // A queue row with its request's instance, as the machine leaves one.
  const adopt = async () => {
    await require('./lib/bot-request-fixture').seedRequests(pool, { appId: app.id });
  };

  await t.test('a held request keeps its place through every refresh, and the live queue waits for Monday', async () => {
    const { rows: [held] } = await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, enqueued_at, held_until)
       VALUES ($1, 7, 1, 'new', NOW() - INTERVAL '3 hours', $2) RETURNING *`,
      [app.id, reset],
    );
    await adopt(held);
    const github = {
      async fetchPublicIssues() {
        return { issues: [{ number: 7, state: 'open', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }] };
      },
    };
    const capRoom = { proposals_per_app: 5, proposals_total: 50, question_tripwire: 10 };
    // Three refreshes: before, the row was deleted when it was held and
    // queued again by each of these, at the back.
    for (let i = 0; i < 3; i += 1) {
      await homeroomBot.refreshApp(pool, app, { github, capRoom });
      await rt.drain();
    }
    const { rows: [after] } = await pool.query(
      'SELECT id, enqueued_at, held_until FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 7', [app.id],
    );
    assert.equal(after.id, held.id, 'the same row');
    assert.equal(after.enqueued_at.toISOString(), held.enqueued_at.toISOString(), 'its place in line is kept');
    assert.equal(after.held_until.toISOString(), held.held_until.toISOString(), 'still held');

    assert.deepEqual(await candidates(), [], 'not read while held');
    // The week resets: it is first in line, by its old place.
    const { rows: [next] } = await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, enqueued_at)
       VALUES ($1, 8, 1, 'new', NOW() - INTERVAL '1 hour') RETURNING *`,
      [app.id],
    );
    await adopt(next);
    // Its hold's end, in its machine and in the row it projects (the clock
    // the machine set fires then).
    const cl = await pool.connect();
    try {
      await cl.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await cl.query(`UPDATE wf_instances SET data = jsonb_set(data, '{owed,heldUntil}', to_jsonb((NOW() - INTERVAL '1 second')::text))
                       WHERE machine = $1 AND key = $2`, [requestMachine.MACHINE, rules.requestKey(app.id, 7)]);
      await cl.query(`UPDATE homeroom_bot_queue SET held_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [held.id]);
      await cl.query('COMMIT');
    } finally { cl.release(); }
    assert.deepEqual(await candidates(), [7, 8], 'the held one goes first');
  });

  await t.test('asking the bot to start it lifts the hold, and records who pays', async () => {
    // Held again for its payer's week (its look's end said so).
    const cl = await pool.connect();
    try {
      await cl.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await cl.query(`UPDATE wf_instances SET data = jsonb_set(data, '{owed,heldUntil}', to_jsonb($3::text))
                       WHERE machine = $1 AND key = $2`, [requestMachine.MACHINE, rules.requestKey(app.id, 7), new Date(reset).toISOString()]);
      await cl.query(`UPDATE homeroom_bot_queue SET held_until = $2 WHERE app_id = $1 AND issue_number = 7`, [app.id, reset]);
      await cl.query('COMMIT');
    } finally { cl.release(); }
    const { rows: [ben] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ('ben', 'x', TRUE) RETURNING id`,
    );
    // Owed in the caller's transaction (here the pool), its machine applies it.
    assert.deepEqual(await homeroomBot.enqueueFront(pool, { appId: app.id, issueNumber: 7, userId: ben.id, reason: 'dm_start', payerId: ben.id, db: pool }),
      { owed: true, id: null });
    await rt.drain();
    const { rows: [q] } = await pool.query(
      'SELECT held_until, payer_user_id, priority, reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 7', [app.id],
    );
    assert.deepEqual(q, { held_until: null, payer_user_id: ben.id, priority: 0, reason: 'dm_start' });
  });
});
