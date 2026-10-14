'use strict';

// #3737: the taste eval against the FULL PostgreSQL schema and the real
// routes. The taste-v1 suite is made from its definition once, its
// placeholder briefs are never run, a capture task borrows its app's brief,
// a brief is edited by an admin while the suite is open, a launch runs a
// capture once and first versions `repeats` times, a trial's screenshots
// are stored as rows of their own, and a grade item packages the eight most
// telling of them as images, blind: the same stage for both arms, no model,
// no trial, no commit. The run's report averages each arm's rubric and
// measurements.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const EAR = 'An app to learn relative notes / chords, and then basic chord progressions.';

test('the taste eval against the full PostgreSQL schema and its routes', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bench_taste_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const poolMod = require('../src/db/pool');
  const realGetPool = poolMod.getPool;
  poolMod.getPool = () => pool;
  let server;
  t.after(async () => {
    poolMod.getPool = realGetPool;
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const taste = require('../src/services/bench/taste');
  const suites = require('../src/services/bench/suites');
  const lane = require('../src/services/bench/lane');
  const capture = require('../src/services/bench/capture');
  const graders = require('../src/services/bench/graders');
  const report = require('../src/services/bench/report');
  const demo = require('../src/services/bench/demo');
  const { homeroomBenchRoutes } = require('../src/routes/homeroom-bench');

  const apps = {};
  for (const slug of ['bread-bot-3e3f5c', 'rss-reader-4113da', 'ear-trainer-9aee0d']) {
    // eslint-disable-next-line no-await-in-loop
    const { rows: [a] } = await pool.query(
      "INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $2, 'running', $3) RETURNING id, slug",
      [slug, slug, `https://github.com/usernode-bot/${slug}`],
    );
    apps[slug] = a;
  }
  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password, is_admin) VALUES ('evan', 'x', TRUE) RETURNING id");

  const appX = express();
  appX.use(express.json());
  appX.use((req, _res, next) => {
    if (req.headers['x-test-user'] === 'admin') req.user = { id: evan.id, username: 'evan', isAdmin: true, canAdminWrite: true };
    if (req.headers['x-test-user'] === 'viewer') req.user = { id: evan.id, username: 'viewer', isAdmin: true, canAdminWrite: false };
    if (req.headers['x-test-connector']) req.cliAuthenticated = true;
    next();
  });
  appX.use(homeroomBenchRoutes({}));
  server = http.createServer(appX);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { who = 'admin', connector = false, body, raw = false } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': who, ...(connector ? { 'x-test-connector': '1' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  let suiteId;
  await t.test('taste-v1 is made once from its definition; an app that is not here is skipped with its reason', async () => {
    const first = await taste.materialize(pool, {});
    assert.equal(first.ok, true, first.error);
    suiteId = first.suiteId;
    assert.equal(first.summary.ready, 3);
    assert.deepEqual(first.summary.skipped.map((s) => [s.ref, s.reason]), [['block-game', 'App not found']]);
    const again = await taste.materialize(pool, {});
    assert.equal(again.noop, true, 'a no-op once done');
    const { rows } = await pool.query('SELECT stage, tags, reference_source FROM bench_tasks WHERE suite_id = $1 ORDER BY id', [suiteId]);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.stage === 'first_version' && r.reference_source === 'authored'), 'no task waits for a label');
    assert.deepEqual(rows.map((r) => [r.tags.taste_ref, r.tags.brief_placeholder]), [['bread-bot', true], ['rss-reader', true], ['ear-trainer', false]]);
    const label = await pool.query("SELECT COUNT(*)::int AS n FROM bench_tasks WHERE suite_id = $1 AND reference_source IS NULL", [suiteId]);
    assert.equal(label.rows[0].n, 0);
  });

  let captureTask;
  await t.test('a capture task takes its app\'s brief from the suite; an admin edits a brief while the suite is open', async () => {
    const sha = 'c'.repeat(40);
    const added = await call('POST', `/api/admin/homeroom-bot/bench/suites/${suiteId}/taste-tasks`, {
      body: { kind: 'capture', appSlug: 'ear-trainer-9aee0d', sha },
    });
    assert.equal(added.status, 200, added.body.error);
    captureTask = added.body.task;
    const refused = await call('POST', `/api/admin/homeroom-bot/bench/suites/${suiteId}/taste-tasks`, {
      who: 'viewer', body: { kind: 'capture', appSlug: 'ear-trainer-9aee0d', sha },
    });
    assert.equal(refused.status, 403, 'a view-only admin cannot add one');
    const noSha = await call('POST', `/api/admin/homeroom-bot/bench/suites/${suiteId}/taste-tasks`, { body: { kind: 'capture', appSlug: 'ear-trainer-9aee0d' } });
    assert.equal(noSha.status, 400);
    const listed = await call('GET', `/api/admin/homeroom-bot/bench/suites/${suiteId}/tasks`, { who: 'viewer' });
    const cap = listed.body.tasks.find((x) => x.stage === 'capture');
    assert.equal(cap.taste.sha, sha);
    assert.equal(cap.taste.appName, 'Ear Trainer');
    assert.ok(cap.taste.brief.startsWith(EAR), 'the first-version task\'s brief');
    const bread = listed.body.tasks.find((x) => x.tags.taste_ref === 'bread-bot');
    assert.equal(bread.taste.placeholder, true);
    const edited = await call('PATCH', `/api/admin/homeroom-bot/bench/tasks/${bread.id}/taste`, {
      body: { brief: 'Bread Bot: plan a bake from mixing to the cooling rack, with timers for every proof.' },
    });
    assert.equal(edited.status, 200, edited.body.error);
    assert.equal(edited.body.task.tags.brief_placeholder, false);
    const after = await call('GET', `/api/admin/homeroom-bot/bench/suites/${suiteId}/tasks`);
    assert.match(after.body.tasks.find((x) => x.id === bread.id).taste.brief, /cooling rack/);
    const notTaste = await suites.createSuite(pool, { name: 'other' });
    const { rows: [run] } = await pool.query(
      "INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 5, 'shadow', 'ready') RETURNING id", [apps['ear-trainer-9aee0d'].id],
    );
    await require('../src/services/homeroom-bot-snapshots').recordSnapshot(pool, { runId: run.id, stage: 'triage', appId: apps['ear-trainer-9aee0d'].id, issueNumber: 5, texts: { seed: 's' } });
    const triage = await suites.addTaskFromRun(pool, { suiteId: notTaste.suite.id, runId: run.id, stage: 'triage' });
    assert.equal((await taste.editTask(pool, { taskId: triage.task.id, patch: { brief: EAR } })).status, 400);
  });

  let launched;
  await t.test('a launch runs a capture once under the baseline, first versions `repeats` times, and never a placeholder', async () => {
    const body = {
      suiteId, models: ['z-ai/glm-5.3-flash', 'anthropic/claude-sonnet-5.5'], stages: ['first_version', 'capture'],
      repeats: 2, repeatStages: ['first_version'], capUsd: 40,
    };
    const est = await lane.estimateRun(pool, body);
    assert.equal(est.ok, true, est.error);
    launched = await lane.launchRun(pool, body, { actorId: evan.id });
    assert.equal(launched.ok, true, launched.error);
    const { rows } = await pool.query(
      `SELECT tr.model, tr.attempt, tr.status, tr.error, tr.est_cost_usd::float8 AS est, tk.stage, tk.tags->>'taste_ref' AS ref
         FROM bench_trials tr JOIN bench_tasks tk ON tk.id = tr.task_id WHERE tr.run_id = $1 ORDER BY tr.id`,
      [launched.run.id],
    );
    const caps = rows.filter((r) => r.stage === 'capture');
    assert.deepEqual(caps.map((r) => [r.model, r.attempt, r.status, r.est]), [['z-ai/glm-5.3-flash', 1, 'pending', 0]]);
    const rss = rows.filter((r) => r.ref === 'rss-reader');
    assert.equal(rss.length, 4, 'two models, two attempts');
    assert.ok(rss.every((r) => r.status === 'not_applicable' && /placeholder/.test(r.error)), 'a placeholder brief is not run');
    const ear = rows.filter((r) => r.ref === 'ear-trainer');
    assert.deepEqual(ear.map((r) => r.status), ['pending', 'pending', 'pending', 'pending']);
    assert.ok(ear.every((r) => r.est > 0));
    await lane.cancelRun(pool, launched.run.id, { worker: { stopTurn: async () => {} } });
  });

  // Two finished trials of one run, one per arm, each with its screenshots.
  const { rows: [run] } = await pool.query(
    `INSERT INTO bench_runs (suite_id, models, baseline_model, stages, status)
     VALUES ($1, ARRAY['z-ai/glm-5.3-flash'], 'z-ai/glm-5.3-flash', ARRAY['first_version','capture'], 'done') RETURNING id`,
    [suiteId],
  );
  const { rows: [earTask] } = await pool.query("SELECT id FROM bench_tasks WHERE suite_id = $1 AND tags->>'taste_ref' = 'ear-trainer'", [suiteId]);
  const trialOf = async (taskId, parsed) => {
    const { rows: [tr] } = await pool.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, parsed, cost_usd, error)
       VALUES ($1, $2, 'z-ai/glm-5.3-flash', 1, 'running', $3, $4::jsonb, 1.5, NULL) RETURNING id, item_token`,
      [run.id, taskId, crypto.randomBytes(12).toString('base64url'), JSON.stringify(parsed)],
    );
    return tr;
  };
  const shotsFor = (variant) => capture.plannedShots().map((p) => ({
    id: p.id,
    // The error and loading screens look exactly like the populated ones,
    // so grading names them instead of showing them twice.
    png: demo.demoPng(p.width, p.height, p.look === 'light' ? [250, 250, 250] : [20, 20, 20],
      p.state === 'empty' ? [] : [{ y: 40 + variant, h: 30, rgb: [200, 100, 0] }]).toString('base64'),
    status: 200, consoleErrors: 0,
  }));
  const output = (variant) => `${capture.MARKER} ${JSON.stringify({
    booted: true, error: null, steps: { install: { ran: variant === 0, ok: true, ms: 1 } }, shots: shotsFor(variant),
    checks: { consoleErrors: { count: 0, samples: [] }, overflow360: { light: 0, dark: 0, worst: 0 }, smallTapTargets: { small: 1, checked: 3, samples: [] }, lowContrast: { light: { low: variant, checked: 9, worst: 3.1, samples: [] }, dark: { low: 0, checked: 9, worst: 5, samples: [] } }, nestedCards: { worst: 0 } },
    tells: { files: 2, emojiIcons: { count: variant }, uppercaseEyebrows: { count: 0 }, arbitraryTextSizes: { count: 0, values: [] }, hexColours: { count: 1, values: ['#fff'] } },
  })}\n`;
  const fakeWorker = (variant) => ({ async runBenchCapture(container, { env }) { assert.equal(env.INLOOP_PORT, capture.CAPTURE_PORT); return output(variant); } });

  const fv = await trialOf(earTask.id, { built: true, triage: { verdict: 'ready' } });
  const cp = await trialOf(captureTask.id, { captured: true });
  for (const [tr, variant] of [[fv, 1], [cp, 0]]) {
    // eslint-disable-next-line no-await-in-loop
    const shot = await capture.captureTrial({ pool, trialId: tr.id, worker: fakeWorker(variant), containerName: 'w', appId: apps['ear-trainer-9aee0d'].id });
    assert.equal(shot.ok, true, shot.error);
    // eslint-disable-next-line no-await-in-loop
    await lane.recordTrial(pool, {
      trialRow: { id: tr.id, run_id: run.id },
      row: { stage: 'capture', repo_url: null },
      patch: { status: 'ok', parsed: tr === fv ? { built: true, triage: { verdict: 'ready' } } : { captured: true }, capture: shot.capture, cost_usd: 0 },
      user: null,
      d: { github: null, worker: { evictWorker: async () => {} }, limits: {}, managedOpenRouter: {}, afterTrial: (p, id) => graders.gradeTrial(p, id) },
    });
  }

  await t.test('screenshots are rows of their own, linked to the trial; the trial keeps the numbers', async () => {
    const { rows } = await pool.query('SELECT trial_id, shot_id, look, state, bytes, width, height FROM bench_trial_artifacts WHERE trial_id = $1 ORDER BY shot_id', [fv.id]);
    assert.equal(rows.length, 19, 'sixteen and the result state\'s three');
    assert.deepEqual(rows.filter((r) => r.state === 'result').map((r) => r.shot_id), ['desktop-light-result', 'phone-dark-result', 'phone-light-result']);
    assert.ok(rows.every((r) => r.bytes > 0 && [390, 1280].includes(r.width)));
    const { rows: [tr] } = await pool.query('SELECT capture, deterministic FROM bench_trials WHERE id = $1', [fv.id]);
    assert.equal(tr.capture.booted, true);
    assert.equal(tr.capture.shots.length, 19);
    assert.ok(tr.capture.shots.every((s) => /^[0-9a-f]{32}$/.test(s.artifactId) && !('data' in s) && !('png' in s)));
    assert.equal(tr.deterministic.needsJudge, true);
    const img = await call('GET', `/api/admin/homeroom-bot/bench/artifacts/${tr.capture.shots[0].artifactId}`, { who: 'viewer', raw: true });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(img.buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    assert.equal((await call('GET', '/api/admin/homeroom-bot/bench/artifacts/nope', { raw: true })).status, 404);
    const outsider = await call('GET', `/api/admin/homeroom-bot/bench/artifacts/${tr.capture.shots[0].artifactId}`, { who: 'nobody', raw: true });
    assert.ok(!outsider.buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'nobody but an admin gets the picture');
  });

  await t.test('a grade item packages the screenshots as images, blind: one stage for both arms, nothing about model, trial or commit', async () => {
    const q = await call('GET', '/api/bot-bench/queue', { connector: true });
    assert.deepEqual(q.body.items.map((i) => i.stage).sort(), ['taste', 'taste']);
    const items = {};
    for (const tr of [fv, cp]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call('GET', `/api/bot-bench/items/${tr.item_token}?images=1`, { connector: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.item.itemId, tr.item_token, 'the item carries its trial\'s opaque token, and only that');
      items[tr.id] = r.body.item;
    }
    for (const item of Object.values(items)) {
      assert.equal(item.stage, 'taste');
      assert.equal(item.task.appName, 'Ear Trainer');
      assert.ok(item.task.brief.startsWith(EAR));
      assert.equal(item.rubric.criteria.length, 12);
      assert.ok(item.images.length <= 8 && item.images.length >= 4);
      for (const img of item.images) {
        assert.equal(img.mimeType, 'image/png');
        assert.ok(Buffer.from(img.data, 'base64').subarray(1, 4).toString() === 'PNG');
        assert.match(img.caption, /^(Phone 390×844|Desktop 1280×800), (light|dark) look, (populated|empty|error|loading)/);
      }
      assert.ok(item.candidate.identicalScreens.length > 0, 'a state identical to the populated screen is named, not shown twice');
      assert.equal(item.signals.automaticChecks.tapTargetsUnder44px.small, 1);
      // Blind: no model, no arm, no trial, no commit, no install step.
      // The itemId is a random base64url token, checked above; by chance it can spell "glm", so it sits out this search.
      const { images: _images, itemId: _itemId, ...shown } = item;
      const text = JSON.stringify(shown);
      assert.doesNotMatch(text, /glm|z-ai|first_version|"capture"|before|c{40}|"trialId"|"runId"|"model"|install/i);
      assert.ok(!('trialId' in item) && !('runId' in item) && !('model' in item) && !('id' in item));
    }
    // The two arms' items have the same shape, so nothing in it tells them apart.
    const keys = (o) => JSON.stringify(Object.keys(o).sort());
    assert.equal(keys(items[fv.id]), keys(items[cp.id]));
    assert.equal(keys(items[fv.id].candidate), keys(items[cp.id].candidate));
    // Without images=1, no bytes.
    const plain = await call('GET', `/api/bot-bench/items/${fv.item_token}`, { connector: true });
    assert.equal(plain.body.item.images, undefined);
    assert.equal(plain.body.item.shots.length, items[fv.id].images.length);
  });

  await t.test('a grade records the twelve criteria; the run\'s report averages each arm', async () => {
    const all = Object.fromEntries(['hierarchy', 'type_scale', 'spacing', 'accent', 'both_looks', 'states', 'copy', 'no_tells', 'works_at_390', 'kit_use', 'domain_fit', 'would_ship'].map((id) => [id, true]));
    const g1 = await call('POST', `/api/bot-bench/items/${fv.item_token}/grade`, {
      connector: true, body: { verdict: 'pass', critique: 'A keyboard on every screen, both looks hold, states say what to do.', criteria: { ...all, bogus: true } },
    });
    assert.equal(g1.status, 200, g1.body.error);
    await call('POST', `/api/bot-bench/items/${cp.item_token}/grade`, {
      connector: true, body: { verdict: 'fail', critique: 'Dark only, emoji for icons, no empty state worth the name.', criteria: { ...all, both_looks: false, would_ship: false } },
    });
    const { rows: [g] } = await pool.query('SELECT criteria FROM bench_grades WHERE trial_id = $1', [fv.id]);
    assert.equal(Object.keys(g.criteria).length, 12, 'only the rubric\'s criteria');
    const r = await report.runReport(pool, run.id);
    const fvRow = r.rows.find((x) => x.stage === 'first_version');
    const cpRow = r.rows.find((x) => x.stage === 'capture');
    assert.equal(fvRow.accuracy, 1);
    assert.equal(cpRow.accuracy, 0);
    assert.equal(fvRow.taste.criteria.would_ship.rate, 1);
    assert.equal(cpRow.taste.criteria.both_looks.rate, 0);
    assert.equal(fvRow.taste.tells.emojiIcons, 1);
    assert.equal(fvRow.taste.bootedRate, 1);
    const agg = await report.runAggregates(pool, run.id);
    assert.equal(agg.cells.find((c) => c.stage === 'capture').taste.criteria.would_ship.rate, 0, 'the connector\'s view has the arms\' averages');
  });

  await t.test('the staging demo seeds a taste suite, a run of both arms and their screenshots', async () => {
    const real = process.env.USERNODE_ENV;
    process.env.USERNODE_ENV = 'staging';
    try {
      assert.equal(await demo.seedStagingTaste(pool), true);
      assert.equal(await demo.seedStagingTaste(pool), false, 'once');
    } finally {
      if (real === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = real;
    }
    const { rows: [s] } = await pool.query('SELECT name, frozen_at FROM bench_suites WHERE id = $1', [demo.TASTE_SUITE_ID]);
    assert.equal(s.name, 'Staging demo taste');
    assert.equal(s.frozen_at, null, 'open, so its tasks show the edit and add forms');
    const { rows: [n] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM bench_trial_artifacts a JOIN bench_trials t ON t.id = a.trial_id WHERE t.run_id = $1', [demo.TASTE_RUN_ID],
    );
    assert.equal(n.n, 38);
    // Its result screens differ from the populated ones, so the spot check
    // shows the phone's third, captioned with the control it tapped.
    const { rows: [fvDemo] } = await pool.query("SELECT capture FROM bench_trials WHERE run_id = $1 AND capture->'primaryAction' IS NOT NULL ORDER BY id LIMIT 1", [demo.TASTE_RUN_ID]);
    assert.equal(capture.pickShots(fvDemo.capture).chosen[2].caption, 'Phone 390×844, light look, after tapping "Plan the week" (the screen\'s primary action)');
    assert.equal(fvDemo.capture.primaryAction.length, 3);
    const r = await report.runReport(pool, demo.TASTE_RUN_ID);
    assert.deepEqual(r.rows.map((x) => x.stage).sort(), ['capture', 'first_version']);
    assert.ok(demo.TASTE_RUN_ID < demo.RUN_ID, 'the console still opens on the core demo run');
  });
});
