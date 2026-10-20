'use strict';

// The first session's card against the full schema (src/services/app-sketch.js):
// owed once per project (the route), made by the project's setup with one
// model call whose spend is recorded (drawFor, its `card` step, before the
// first commit), always ready (the description's card when the model is no
// use), its emoji saved as the project's icon only when it has none. The
// model is a stand-in.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/app-sketch-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const sketch = require('../src/services/app-sketch');

const REPLY = JSON.stringify({
  emoji: '👟',
  tagline: 'The club\'s Sunday runs, together',
  points: ['Log a run in a tap', 'See the week\'s miles'],
});
const WS = { pushAppUpdate() {} };

function fakeLlm({ text = REPLY, fail = null, gate = null } = {}) {
  const calls = [];
  return {
    calls,
    isEnabled: () => true,
    estimateCostCents: () => 3,
    async generateAppSketch(args) {
      calls.push(args);
      if (gate) await gate;
      if (fail) throw new Error(fail);
      return { text, usage: { input_tokens: 900, output_tokens: 1200 }, model: args.model };
    },
  };
}

function fakeLimits() {
  const spends = [];
  return { spends, async recordSpend(_pool, userId, cents, opts) { spends.push({ userId, cents, opts }); } };
}

test('the sketch against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `app_sketch_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  const { rows: [ada] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('ada', 'x', TRUE) RETURNING id`);
  let n = 0;
  async function project(label = 'Run Club') {
    n += 1;
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $2, 'creating', $3) RETURNING id, name, slug`,
      [`${label} ${n}`, `${label.toLowerCase().replace(/\s+/g, '-')}-${n}`, ada.id]);
    return app;
  }
  const user = { id: ada.id };

  await t.test('schema: one row per project, private', async () => {
    const { rows: [c] } = await pool.query(`SELECT obj_description('app_sketches'::regclass, 'pg_class') AS comment`);
    assert.equal(c.comment, 'staging:private');
  });

  const iconOf = async (id) => (await pool.query('SELECT icon_emoji, icon_image_id FROM apps WHERE id = $1', [id])).rows[0];

  await t.test('made once: ready, the model\'s card, its spend recorded, its emoji the icon, and waited for', async () => {
    const app = await project();
    const llm = fakeLlm();
    const limits = fakeLimits();
    assert.equal(await sketch.startSketch(pool, { app, user, brief: 'Log our Sunday runs' }, { llm, limits, ws: WS }), true);
    assert.equal(await sketch.startSketch(pool, { app, user, brief: 'again' }, { llm, limits, ws: WS }), false, 'once per project');
    const row = await sketch.drawFor(pool, app.id, { llm, limits, ws: WS });
    assert.equal(row.status, 'ready');
    assert.deepEqual(sketch.cardOf(row.design), { emoji: '👟', tagline: 'The club\'s Sunday runs, together', points: ['Log a run in a tap', 'See the week\'s miles'] });
    assert.equal(row.design.source, 'model');
    assert.equal(row.html, null);
    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].model, sketch.SKETCH_MODEL);
    assert.match(llm.calls[0].user, /APP NAME:\nRun Club 1/);
    assert.match(llm.calls[0].user, /Log our Sunday runs/);
    // Grounded: today's date, and the creator read from their account.
    assert.match(llm.calls[0].user, /TODAY:\n[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+ \d{4} \(\d{4}-\d{2}-\d{2}\)/);
    assert.match(llm.calls[0].user, /THE CREATOR \(called "you" on the card\):\n@ada/);
    assert.deepEqual(limits.spends, [{ userId: ada.id, cents: 3, opts: { byok: false } }]);
    assert.deepEqual(await iconOf(app.id), { icon_emoji: '👟', icon_image_id: null });
  });

  await t.test('an icon somebody set is never replaced', async () => {
    const app = await project();
    await pool.query(`UPDATE apps SET icon_emoji = '🎸' WHERE id = $1`, [app.id]);
    const deps = { llm: fakeLlm(), limits: fakeLimits(), ws: WS };
    await sketch.startSketch(pool, { app, user, brief: 'Log our Sunday runs' }, deps);
    assert.equal((await sketch.drawFor(pool, app.id, deps)).design.emoji, '👟');
    assert.deepEqual(await iconOf(app.id), { icon_emoji: '🎸', icon_image_id: null });
  });

  const descriptionOf = async (id) => (await pool.query(`SELECT manifest_snapshot->>'description' AS d FROM apps WHERE id = $1`, [id])).rows[0].d;

  await t.test('its tagline is the project\'s description, never over one it has (#4235)', async () => {
    const app = await project();
    const deps = { llm: fakeLlm(), limits: fakeLimits(), ws: WS };
    await sketch.startSketch(pool, { app, user, brief: 'I want to log our Sunday runs, that me and my friends can see' }, deps);
    await sketch.drawFor(pool, app.id, deps);
    assert.equal(await descriptionOf(app.id), 'The club\'s Sunday runs, together');
    assert.deepEqual((await pool.query('SELECT manifest_snapshot->\'secrets\' AS s FROM apps WHERE id = $1', [app.id])).rows[0].s, []);

    // The creator's own "What is it?" line (POST /api/apps seeds it), or
    // one a deploy read from dapp.json, stays.
    const described = await project();
    await pool.query('UPDATE apps SET manifest_snapshot = $2 WHERE id = $1', [described.id, JSON.stringify({ description: 'Our running log', secrets: [] })]);
    await sketch.startSketch(pool, { app: described, user, brief: 'Log our Sunday runs' }, deps);
    await sketch.drawFor(pool, described.id, deps);
    assert.equal(await descriptionOf(described.id), 'Our running log');
    assert.equal(await sketch.saveDescription(pool, described, 'Something else'), false);

    // A blank one is no description: the tagline fills it, keeping the rest.
    const blank = await project();
    await pool.query('UPDATE apps SET manifest_snapshot = $2 WHERE id = $1', [blank.id, JSON.stringify({ description: '  ', secrets: [{ key: 'K' }] })]);
    assert.equal(await sketch.saveDescription(pool, blank, 'Runs, together'), true);
    const { rows: [snap] } = await pool.query('SELECT manifest_snapshot FROM apps WHERE id = $1', [blank.id]);
    assert.deepEqual(snap.manifest_snapshot, { description: 'Runs, together', secrets: [{ key: 'K' }] });
  });

  await t.test('a refusal or an error is the description\'s card, with why, and creation is not held', async () => {
    const bad = await project();
    const refused = { llm: fakeLlm({ text: 'I cannot help with that.' }), limits: fakeLimits(), ws: WS };
    await sketch.startSketch(pool, { app: bad, user, brief: 'A tracker for our weekly miles, so we can see who is keeping up' }, refused);
    const row = await sketch.drawFor(pool, bad.id, refused);
    assert.equal(row.status, 'ready');
    assert.deepEqual([row.model, row.error, row.design.source, row.design.tagline], ['fallback', 'unusable_reply', 'fallback', 'A tracker for our weekly miles']);
    assert.equal((await iconOf(bad.id)).icon_emoji, '🏃');

    const broken = await project();
    const down = { llm: fakeLlm({ fail: 'overloaded' }), limits: fakeLimits(), ws: WS };
    await sketch.startSketch(pool, { app: broken, user, brief: 'x y z' }, down);
    const failed = await sketch.drawFor(pool, broken.id, down);
    assert.deepEqual([failed.status, failed.error, sketch.sketchStatus(failed)], ['ready', 'overloaded', 'ready']);
  });

  await t.test('a slow model does not hold the setup: the description\'s card, after its wait', async () => {
    const app = await project();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const deps = { llm: fakeLlm({ gate }), limits: fakeLimits(), ws: WS, modelWaitMs: 100 };
    await sketch.startSketch(pool, { app, user, brief: 'Log our runs' }, deps);
    const started = Date.now();
    const row = await sketch.drawFor(pool, app.id, deps);
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual([row.status, row.error, row.design.source], ['ready', 'timeout', 'fallback']);
    release();
  });

  await t.test('a setup that resumes gets the card it made, and never asks the model twice', async () => {
    const app = await project();
    const deps = { llm: fakeLlm(), limits: fakeLimits(), ws: WS };
    await sketch.startSketch(pool, { app, user: { id: ada.id, username: 'ada' }, brief: 'Log our runs' }, deps);
    const first = await sketch.drawFor(pool, app.id, deps);
    const again = await sketch.drawFor(pool, app.id, deps);
    assert.deepEqual(again.design, first.design);
    assert.equal(deps.llm.calls.length, 1);
    const { rows: [owed] } = await pool.query('SELECT request FROM app_sketches WHERE app_id = $1', [app.id]);
    assert.equal(owed.request.brief, 'Log our runs');
    assert.equal(owed.request.username, 'ada', 'what the card is made from is kept with it, for the setup');
    assert.equal(await sketch.drawFor(pool, (await project()).id, deps), null, 'no card owed, none made');
  });

  await t.test('without a model (a staging preview, a local stack): the description\'s card, on the spot', async () => {
    const off = { isEnabled: () => false };
    // Its name picks the emoji before its description does
    // (app-sketch.js keywordEmoji): "Run Club" would be a runner.
    const app = await project('Friday Film Crew');
    assert.equal(await sketch.startSketch(pool, { app, user, brief: 'A poll to pick what we watch on movie night' }, { llm: off, ws: WS }), true);
    assert.equal(await sketch.startSketch(pool, { app, user, brief: 'again' }, { llm: off, ws: WS }), false, 'once per project');
    const row = await sketch.drawFor(pool, app.id, { llm: off, ws: WS });
    assert.equal(row.model, 'fallback');
    assert.deepEqual(sketch.cardOf(row.design), { emoji: '🎬', tagline: 'A poll to pick what we watch on movie night', points: [sketch.SHARED_POINT] });
    assert.equal((await iconOf(app.id)).icon_emoji, '🎬');
    assert.equal(await descriptionOf(app.id), 'A poll to pick what we watch on movie night');
  });
});
