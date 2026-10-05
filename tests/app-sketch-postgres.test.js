'use strict';

// The first session's card against the full schema (src/services/app-sketch.js):
// started once per project, made by one model call whose spend is recorded,
// always ready (the description's card when the model is no use), its emoji
// saved as the project's icon only when it has none, waited for by creation,
// and committed late when it missed the first commit. The model and GitHub
// are stand-ins.
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
    const row = await sketch.whenReady(pool, app.id, 5000);
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
    await sketch.startSketch(pool, { app, user, brief: 'Log our Sunday runs' }, { llm: fakeLlm(), limits: fakeLimits(), ws: WS });
    assert.equal((await sketch.whenReady(pool, app.id, 5000)).design.emoji, '👟');
    assert.deepEqual(await iconOf(app.id), { icon_emoji: '🎸', icon_image_id: null });
  });

  await t.test('a refusal or an error is the description\'s card, with why, and creation is not held', async () => {
    const bad = await project();
    await sketch.startSketch(pool, { app: bad, user, brief: 'A tracker for our weekly miles, so we can see who is keeping up' },
      { llm: fakeLlm({ text: 'I cannot help with that.' }), limits: fakeLimits(), ws: WS });
    const row = await sketch.whenReady(pool, bad.id, 5000);
    assert.equal(row.status, 'ready');
    assert.deepEqual([row.model, row.error, row.design.source, row.design.tagline], ['fallback', 'unusable_reply', 'fallback', 'A tracker for our weekly miles']);
    assert.equal((await iconOf(bad.id)).icon_emoji, '🏃');

    const broken = await project();
    await sketch.startSketch(pool, { app: broken, user, brief: 'x y z' }, { llm: fakeLlm({ fail: 'overloaded' }), limits: fakeLimits(), ws: WS });
    const failed = await sketch.whenReady(pool, broken.id, 5000);
    assert.deepEqual([failed.status, failed.error, sketch.sketchStatus(failed)], ['ready', 'overloaded', 'ready']);
  });

  await t.test('creation waits only as long as it said, and a late sketch is committed on its own', async () => {
    const app = await project();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await sketch.startSketch(pool, { app, user, brief: 'Log our runs' }, { llm: fakeLlm({ gate }), limits: fakeLimits(), ws: WS, modelWaitMs: 60000 });
    const started = Date.now();
    assert.equal(await sketch.whenReady(pool, app.id, 200), null, 'not in time');
    assert.ok(Date.now() - started < 2000);

    const pushes = [];
    const github = {
      async getFileContent() { return '{\n  "secrets": []\n}'; },
      async pushFiles(owner, repo, files, opts) { pushes.push({ owner, repo, files, opts }); },
    };
    const late = sketch.commitWhenReady(pool, { appId: app.id, name: app.name, owner: 'usernode-bot', repo: app.slug }, { github });
    release();
    assert.equal(await late, true);
    assert.equal(pushes.length, 1);
    assert.deepEqual(pushes[0].files.map((f) => f.path), ['design/sketch.json', 'dapp.json']);
    assert.deepEqual(JSON.parse(pushes[0].files[1].content).icon, { emoji: '👟' });
    assert.equal(pushes[0].opts.message, `Add the card ${app.name} was made with`);
    assert.ok((await sketch.readSketch(pool, app.id)).committed_at, 'marked committed');
    assert.equal(await sketch.commitWhenReady(pool, { appId: app.id, name: app.name, owner: 'o', repo: 'r' }, { github }), false, 'once');
    assert.equal(pushes.length, 1);
  });

  await t.test('a row being drawn elsewhere is watched until it is ready', async () => {
    const app = await project();
    await pool.query(`INSERT INTO app_sketches (app_id, user_id, status) VALUES ($1, $2, 'pending')`, [app.id, ada.id]);
    setTimeout(() => {
      pool.query(`UPDATE app_sketches SET status = 'ready', design = $2::jsonb, ready_at = NOW() WHERE app_id = $1`,
        [app.id, JSON.stringify({ kind: 'card', emoji: '🏃', tagline: 'x', points: [] })]).catch(() => {});
    }, 150);
    const row = await sketch.whenReady(pool, app.id, 3000, { pollMs: 50 });
    assert.equal(row && row.status, 'ready');
  });

  await t.test('without a model (a staging preview, a local stack): the description\'s card, on the spot', async () => {
    const off = { isEnabled: () => false };
    // Its name picks the emoji before its description does
    // (app-sketch.js keywordEmoji): "Run Club" would be a runner.
    const app = await project('Friday Film Crew');
    assert.equal(await sketch.startSketch(pool, { app, user, brief: 'A poll to pick what we watch on movie night' }, { llm: off, ws: WS }), true);
    assert.equal(await sketch.startSketch(pool, { app, user, brief: 'again' }, { llm: off, ws: WS }), false, 'once per project');
    const row = await sketch.whenReady(pool, app.id, 100);
    assert.equal(row.model, 'fallback');
    assert.deepEqual(sketch.cardOf(row.design), { emoji: '🎬', tagline: 'A poll to pick what we watch on movie night', points: [sketch.SHARED_POINT] });
    assert.equal((await iconOf(app.id)).icon_emoji, '🎬');
  });
});
