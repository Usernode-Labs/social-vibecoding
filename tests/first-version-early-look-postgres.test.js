'use strict';

// A first version's EARLY first look (services/first-version-early-look.js)
// against the real schema (newcomer run six, 14 October 2026): drawn from
// its plan at Make it and pictured in the worker of the app's bot session
// (the model and the worker stand in), kept by project before there is a
// run, recorded on its timeline as first_look_saved { from: 'early' }, read
// by the App tab as the first look until the spec saves its own (and only
// for the run built from its plan), handed to that spec, and counted in its
// run report. A failure is recorded and nothing else changes.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/first-version-early-look-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

let pool = null;
require('../src/db/pool').getPool = () => pool;

const bot = require('../src/services/homeroom-bot');
const early = require('../src/services/first-version-early-look');
const fvs = require('../src/services/first-version-screens');
const runReport = require('../src/services/run-report');

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SCREEN = '<template data-screen data-size="phone" data-height="900"><style>.poll{color:rgb(var(--fg))}</style>'
  + '<div data-side="after" data-change="1"><h1>Club Votes</h1><ul class="list"><li class="list-row poll">Pizza night?</li></ul></div></template>';
const PLAN = {
  bullets: ['Make a poll in a few taps', 'Everyone votes once', 'See who won'],
  questions: [{ question: 'When does a vote end?', answers: ['When you close it', 'After 24 hours'] }],
  buildNote: 'One screen: the open polls. Its primary action is New poll.',
  model: 'z-ai/glm-5.3-flash',
};

test('an early first look: kept, shown until the spec saves its own, handed to the spec, reported', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `fv_early_look_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 4 });
  const prevSwitch = process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK;
  delete process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK;
  t.after(async () => {
    if (prevSwitch === undefined) delete process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK; else process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK = prevSwitch;
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  // Applied twice, as every deploy does: idempotent.
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const BOT = await user('homeroom_bot', true);
  const maker = await user('evan_t1014');
  const project = async (slug, repoUrl) => {
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url) VALUES ($1, $2, 'creating', $3, $4)
       RETURNING id, slug, name`,
      [`Club Votes ${slug}`, slug, maker.id, repoUrl],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds, early_plan, early_plan_status, early_plan_at)
       VALUES ($1, $2, 'Polls for the club', TRUE, $3::jsonb, 'ready', NOW())`,
      [app.id, maker.id, JSON.stringify(PLAN)],
    );
    return app;
  };
  const sessions = [];
  const deps = (overrides = {}) => ({
    env: {},
    llm: {
      isEnabled: () => true,
      estimateCostCents: () => 0,
      async generateFirstLook() { return { text: SCREEN, usage: null, model: 'claude-sonnet-5-5' }; },
    },
    limits: { async recordSpend() {} },
    // The real bot session; the worker stands in.
    bot: {
      parseRepo: bot.parseRepo,
      starterOfApp: bot.starterOfApp,
      async ensureBotSession(...args) { const s = await bot.ensureBotSession(...args); sessions.push(s); return s; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(sessionId) { return `w-${sessionId}`; },
      async runBenchCapture() { return `${fvs.MARKER} ${JSON.stringify({ ok: true, png: PNG.toString('base64') })}\n`; },
    },
    repoPollMs: 5,
    ...overrides,
  });

  await t.test('drawn, pictured in the bot session\'s worker once the repository exists, kept and on the timeline', async () => {
    const app = await project('club-votes', null);
    const drawing = early.runEarlyLook(pool, { appId: app.id, config: {} }, { ...deps(), botUser: BOT });
    // The project's first commit is pushed a moment later.
    setTimeout(() => { pool.query('UPDATE apps SET repo_url = $2 WHERE id = $1', [app.id, 'https://github.com/o/club-votes']).catch(() => {}); }, 30);
    assert.deepEqual(await drawing, { ok: true, error: null });
    const { rows: [row] } = await pool.query('SELECT * FROM first_version_early_looks WHERE app_id = $1', [app.id]);
    assert.equal(row.status, 'ready');
    assert.equal(row.screen, SCREEN);
    assert.equal(row.model, 'claude-sonnet-5-5');
    assert.ok(Buffer.from(row.png).equals(PNG));
    assert.deepEqual([row.width, row.height, row.bytes], [1, 1, PNG.length]);
    assert.ok(row.drawn_at && row.saved_at && row.saved_at >= row.drawn_at);
    assert.equal(row.error, null);
    // In the app's own bot session, the one its triage reads in.
    assert.equal(sessions.length, 1);
    assert.equal(Number(sessions[0].user_id), BOT.id);
    assert.equal(sessions[0].branch_name, 'main');
    // Its timeline: the first look saved, from the early look, for its maker and project.
    const { rows: stages } = await pool.query(
      `SELECT user_id, app_id, metadata FROM events WHERE event_type = 'first_version_stage' AND app_id = $1`, [app.id],
    );
    assert.equal(stages.length, 1);
    assert.equal(stages[0].user_id, maker.id);
    assert.equal(stages[0].metadata.stage, 'first_look_saved');
    assert.equal(stages[0].metadata.from, 'early');
    assert.equal(typeof stages[0].metadata.drawMs, 'number');
    // Once.
    assert.deepEqual(await early.runEarlyLook(pool, { appId: app.id, config: {} }, { ...deps(), botUser: BOT }), { skipped: 'claimed' });

    // The App tab: the first look before there is a run.
    let showcase = await fvs.showcaseOf(pool, app.id);
    assert.equal(showcase.runId, null);
    assert.equal(showcase.screens.first_look.count, 1);
    assert.equal(fvs.firstVersionShowcase(showcase, 'building').screens.kind, 'first_look');
    assert.ok((await fvs.readScreen(pool, app.id, 'first_look', 0)).data.equals(PNG));

    // The request is filed and the bot builds from the plan at Make it; its
    // maker's choice goes onto the build note (Build it, homeroom-bot.js goAhead).
    await pool.query(`UPDATE homeroom_bot_first_versions SET status = 'filed', issue_number = 1 WHERE app_id = $1`, [app.id]);
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note)
       VALUES ($1, 1, 'live', 'ready', $2) RETURNING id`,
      [app.id, `${PLAN.buildNote}\n\nWhat its creator approved:\n- When does a vote end? After 24 hours`],
    );
    showcase = await fvs.showcaseOf(pool, app.id);
    assert.equal(showcase.runId, run.id);
    assert.equal(showcase.screens.first_look.count, 1, 'still the early look');
    // Its spec starts from it.
    const { rows: [{ build_note: note }] } = await pool.query('SELECT build_note FROM homeroom_bot_runs WHERE id = $1', [run.id]);
    assert.equal(await early.forSpec(pool, { appId: app.id, buildNote: note }), SCREEN);
    assert.equal(await early.forSpec(pool, { appId: app.id, buildNote: 'A plan made again' }), null);

    // The spec saves its own: that one is the first look from then on.
    const SPEC_PNG = Buffer.concat([PNG, Buffer.from([0])]);
    await fvs.storeScreens(pool, run.id, 'first_look', [{ data: SPEC_PNG, width: 1, height: 1 }]);
    showcase = await fvs.showcaseOf(pool, app.id);
    assert.equal(showcase.screens.first_look.count, 1);
    assert.ok((await fvs.readScreen(pool, app.id, 'first_look', 0)).data.equals(SPEC_PNG));

    // A plan its maker asked to change is a new run: no old picture on it.
    await pool.query('DELETE FROM first_version_screens WHERE bot_run_id = $1', [run.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note) VALUES ($1, 1, 'live', 'ready', 'Two screens: a calendar.')`,
      [app.id],
    );
    assert.deepEqual((await fvs.showcaseOf(pool, app.id)).screens, {});
    assert.equal(await fvs.readScreen(pool, app.id, 'first_look', 0), null);

    // The run report says how far it got and how soon, never what it drew.
    const report = await runReport.build(pool, { appId: app.id });
    const look = report.firstVersion.earlyLook;
    assert.equal(look.status, 'ready');
    assert.equal(look.model, 'claude-sonnet-5-5');
    assert.equal(look.error, null);
    assert.equal(look.screenChars, SCREEN.length);
    assert.equal(look.bytes, PNG.length);
    assert.ok(look.savedSecs >= look.drawnSecs);
    assert.equal(JSON.stringify(report).includes('Pizza night'), false);
  });

  await t.test('15 Oct 2026: drawn but not pictured yet, the drawn screen is shown, as a document that runs nothing', async () => {
    // Newcomer run nine: the worker for its picture was slow to start, and
    // the made screen showed an empty phone for 11 seconds after Submit.
    const app = await project('club-votes-drawn', 'https://github.com/o/club-votes-drawn');
    const hold = {};
    const held = new Promise((resolve) => { hold.release = resolve; });
    const slow = deps({
      worker: {
        async ensureWorkerImage() {},
        async ensureWorker(sessionId) { await held; return `w-${sessionId}`; },
        async runBenchCapture() { return `${fvs.MARKER} ${JSON.stringify({ ok: true, png: PNG.toString('base64') })}\n`; },
      },
    });
    const drawing = early.runEarlyLook(pool, { appId: app.id, config: {} }, { ...slow, botUser: BOT });
    let row = null;
    for (let i = 0; i < 200 && row?.status !== 'drawn'; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ({ rows: [row] } = await pool.query('SELECT status, drawn_at FROM first_version_early_looks WHERE app_id = $1', [app.id]));
      // eslint-disable-next-line no-await-in-loop
      if (row?.status !== 'drawn') await new Promise((r) => { setTimeout(r, 10); });
    }
    assert.equal(row.status, 'drawn', 'drawn, its worker still starting');
    let showcase = await fvs.showcaseOf(pool, app.id);
    assert.deepEqual(showcase.screens.first_look, { count: 1, at: new Date(row.drawn_at).toISOString(), drawn: true });
    assert.equal(fvs.firstVersionShowcase(showcase, 'building').screens.drawn, true);
    assert.equal(await fvs.readScreen(pool, app.id, 'first_look', 0), null, 'no picture yet');
    const doc = await fvs.readDrawnDocument(pool, app.id);
    assert.match(doc, /^<!doctype html>/);
    assert.ok(doc.includes('Pizza night?'));
    // The worker starts; the picture is saved and takes its place.
    hold.release();
    assert.deepEqual(await drawing, { ok: true, error: null });
    showcase = await fvs.showcaseOf(pool, app.id);
    assert.equal('drawn' in showcase.screens.first_look, false);
    assert.ok((await fvs.readScreen(pool, app.id, 'first_look', 0)).data.equals(PNG));
    assert.ok(await fvs.readDrawnDocument(pool, app.id), 'a frame asked for just then still has it');
    // The spec's own first look replaces both.
    await pool.query(`UPDATE homeroom_bot_first_versions SET status = 'filed', issue_number = 1 WHERE app_id = $1`, [app.id]);
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note) VALUES ($1, 1, 'live', 'ready', $2) RETURNING id`,
      [app.id, PLAN.buildNote],
    );
    await fvs.storeScreens(pool, run.id, 'first_look', [{ data: PNG, width: 1, height: 1 }]);
    assert.equal(await fvs.readDrawnDocument(pool, app.id), null);
  });

  await t.test('a failure is recorded and harmless: nothing shown, nothing handed to the spec', async () => {
    const app = await project('club-votes-2', 'https://github.com/o/club-votes-2');
    const failing = deps({ llm: { isEnabled: () => true, estimateCostCents: () => 0, async generateFirstLook() { throw new Error('529'); } } });
    const drawing = early.runEarlyLook(pool, { appId: app.id, config: {} }, { ...failing, botUser: BOT });
    assert.deepEqual(await drawing, { ok: false, error: 'failed' });
    const { rows: [row] } = await pool.query('SELECT status, error, png FROM first_version_early_looks WHERE app_id = $1', [app.id]);
    assert.deepEqual([row.status, row.error, row.png], ['failed', 'failed', null]);
    assert.equal(await fvs.showcaseOf(pool, app.id), null);
    assert.equal(await early.forSpec(pool, { appId: app.id, buildNote: PLAN.buildNote }), null);
    const { rows: stages } = await pool.query(`SELECT 1 FROM events WHERE event_type = 'first_version_stage' AND app_id = $1`, [app.id]);
    assert.equal(stages.length, 0);
    // The project going takes its early look with it.
    await pool.query('DELETE FROM homeroom_bot_first_versions WHERE app_id = $1', [app.id]);
    await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);
    assert.equal((await pool.query('SELECT 1 FROM first_version_early_looks WHERE app_id = $1', [app.id])).rows.length, 0);
  });
});
