'use strict';

// The sketch against the full schema (src/services/app-sketch.js): started
// once per project, drawn by one model call whose spend is recorded, ready
// or failed (never a reason creation fails), waited for by creation, and
// committed late when it missed the first commit. The model and GitHub are
// stand-ins.
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
  design: {
    job: 'Log the club\'s Sunday runs', primaryAction: 'Log a run', accentName: 'tomato red',
    accent: { light: '#e5533d', dark: '#ff8a75' }, signature: 'A route strip', layout: ['Title', 'Log a run'], words: { run: 'run' },
  },
  html: '<header><h1 class="text-title">Run Club</h1><p class="text-body text-muted">Twelve of us, every Sunday at eight.</p></header><script>x</script>',
});

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
  async function project() {
    n += 1;
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ($1, $2, 'creating', $3) RETURNING id, name, slug`,
      [`Run Club ${n}`, `run-club-${n}`, ada.id]);
    return app;
  }
  const user = { id: ada.id };

  await t.test('schema: one row per project, private', async () => {
    const { rows: [c] } = await pool.query(`SELECT obj_description('app_sketches'::regclass, 'pg_class') AS comment`);
    assert.equal(c.comment, 'staging:private');
  });

  await t.test('drawn once: ready, sanitized, its spend recorded, and waited for', async () => {
    const app = await project();
    const llm = fakeLlm();
    const limits = fakeLimits();
    assert.equal(await sketch.startSketch(pool, { app, user, brief: 'Log our Sunday runs' }, { llm, limits }), true);
    assert.equal(await sketch.startSketch(pool, { app, user, brief: 'again' }, { llm, limits }), false, 'once per project');
    const row = await sketch.whenReady(pool, app.id, 5000);
    assert.equal(row.status, 'ready');
    assert.equal(row.design.primaryAction, 'Log a run');
    assert.doesNotMatch(row.html, /<script/);
    assert.match(row.html, /Twelve of us/);
    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].model, sketch.SKETCH_MODEL);
    assert.match(llm.calls[0].user, /APP NAME:\nRun Club 1/);
    assert.match(llm.calls[0].user, /Log our Sunday runs/);
    // Grounded: today's date, and the creator read from their account.
    assert.match(llm.calls[0].user, /TODAY:\n[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+ \d{4} \(\d{4}-\d{2}-\d{2}\)/);
    assert.match(llm.calls[0].user, /THE CREATOR \(shown on the screen as "You"\):\n@ada/);
    assert.deepEqual(limits.spends, [{ userId: ada.id, cents: 3, opts: { byok: false } }]);
  });

  await t.test('a refusal or an error is a failed row, and nothing waits on it', async () => {
    const bad = await project();
    await sketch.startSketch(pool, { app: bad, user, brief: 'x y z' }, { llm: fakeLlm({ text: 'I cannot help with that.' }), limits: fakeLimits() });
    assert.equal(await sketch.whenReady(pool, bad.id, 5000), null);
    assert.equal((await sketch.readSketch(pool, bad.id)).status, 'failed');
    assert.equal((await sketch.readSketch(pool, bad.id)).error, 'unusable_reply');

    const broken = await project();
    await sketch.startSketch(pool, { app: broken, user, brief: 'x y z' }, { llm: fakeLlm({ fail: 'overloaded' }), limits: fakeLimits() });
    assert.equal(await sketch.whenReady(pool, broken.id, 5000), null);
    const row = await sketch.readSketch(pool, broken.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'overloaded');
    assert.equal(sketch.sketchStatus(row), 'failed');
  });

  await t.test('creation waits only as long as it said, and a late sketch is committed on its own', async () => {
    const app = await project();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await sketch.startSketch(pool, { app, user, brief: 'Log our runs' }, { llm: fakeLlm({ gate }), limits: fakeLimits() });
    const started = Date.now();
    assert.equal(await sketch.whenReady(pool, app.id, 200), null, 'not in time');
    assert.ok(Date.now() - started < 2000);

    const pushes = [];
    const github = { async pushFiles(owner, repo, files, opts) { pushes.push({ owner, repo, files, opts }); } };
    const late = sketch.commitWhenReady(pool, { appId: app.id, name: app.name, owner: 'usernode-bot', repo: app.slug }, { github });
    release();
    assert.equal(await late, true);
    assert.equal(pushes.length, 1);
    assert.deepEqual(pushes[0].files.map((f) => f.path), ['design/sketch.html', 'design/sketch.json']);
    assert.equal(pushes[0].opts.message, `Add the sketch ${app.name} was made from`);
    assert.ok((await sketch.readSketch(pool, app.id)).committed_at, 'marked committed');
    assert.equal(await sketch.commitWhenReady(pool, { appId: app.id, name: app.name, owner: 'o', repo: 'r' }, { github }), false, 'once');
    assert.equal(pushes.length, 1);
  });

  await t.test('a row being drawn elsewhere is watched until it is ready', async () => {
    const app = await project();
    await pool.query(`INSERT INTO app_sketches (app_id, user_id, status) VALUES ($1, $2, 'pending')`, [app.id, ada.id]);
    setTimeout(() => {
      pool.query(`UPDATE app_sketches SET status = 'ready', design = $2::jsonb, html = '<p>ok</p>', ready_at = NOW() WHERE app_id = $1`,
        [app.id, JSON.stringify({ job: 'x' })]).catch(() => {});
    }, 150);
    const row = await sketch.whenReady(pool, app.id, 3000, { pollMs: 50 });
    assert.equal(row && row.status, 'ready');
  });

  await t.test('without a model: nothing in production, an obvious demo in a staging preview', async () => {
    const off = { isEnabled: () => false };
    const prod = await project();
    assert.equal(await sketch.startSketch(pool, { app: prod, user, brief: 'x' }, { llm: off, staging: false }), false);
    assert.equal(await sketch.readSketch(pool, prod.id), null);
    const staging = await project();
    assert.equal(await sketch.startSketch(pool, { app: staging, user, brief: 'x' }, { llm: off, staging: true }), true);
    const row = await sketch.whenReady(pool, staging.id, 100);
    assert.equal(row.model, 'staging-demo');
    assert.match(row.html, /Staging demo sketch/);
  });
});
