'use strict';

// The App bench studio (services/bench/studio.js, services/bench/scaffold.js,
// services/bench/packs.js) against the FULL PostgreSQL schema: a launch
// makes the host app once, a task per brief (the same brief, the same task),
// and one trial per brief, model, pack and attempt; a watch reports what
// changed since its cursor; a reference order waits for the run's first
// commit and then hands it out; a reference handed in becomes a trial of its
// own, a later one with the same label its next attempt; a re-run is the
// arm's next attempt; per-trial reads of a run that is not a studio run wait
// for the judge; and only a studio build can be previewed, at most four at
// once, for a day.
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

const SHA = (c) => c.repeat(40);

test('the App bench studio against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bench_studio_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const studio = require('../src/services/bench/studio');
  const packs = require('../src/services/bench/packs');
  const scaffold = require('../src/services/bench/scaffold');

  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password, is_admin) VALUES ('evan', 'x', TRUE) RETURNING id");
  const created = [];
  const deps = {
    // App creation's own path, stood in for: the repository arrives a moment later.
    async createApp(_config, app) {
      created.push(app.id);
      await pool.query("UPDATE apps SET repo_url = $2, status = 'running' WHERE id = $1", [app.id, `https://github.com/usernode-bot/${app.slug}`]);
    },
  };

  let pack;
  await t.test('a pack is saved as the next version of its name; a child keeps what it leaves out', async () => {
    const first = await packs.create(pool, { name: 'warm theme', guidance: 'Warm colours.', files: [{ path: '.claude/skills/warm/SKILL.md', content: 'x' }] }, { actorId: evan.id });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.pack.version, 1);
    const child = await packs.create(pool, { parentId: first.pack.id, guidance: 'Warm colours.\nRound corners.' }, { actorId: evan.id });
    assert.equal(child.pack.version, 2);
    assert.equal(child.pack.name, 'warm theme');
    assert.deepEqual(child.pack.files.map((f) => f.path), ['.claude/skills/warm/SKILL.md'], 'the parent\'s files');
    const got = await packs.get(pool, child.pack.id);
    assert.equal(got.diff.guidance, ' Warm colours.\n+Round corners.');
    assert.equal((await packs.create(pool, { parentId: 9999 })).status, 404);
    pack = child.pack;
    const listed = await packs.list(pool);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].guidance, undefined, 'the list never carries the text');
  });

  let run;
  let launched;
  await t.test('a launch makes the host once, a task per brief, and a trial per brief, model, pack and attempt', async () => {
    for (const [body, re] of [
      [{ briefSet: 'starter' }, /cap/],
      [{ briefSet: 'starter', capUsd: 5, models: ['not a model'] }, /OpenRouter/],
      [{ briefSet: 'starter', capUsd: 5, contextPackIds: [0, 1, 2, 3, 4] }, /contextPackIds/],
      [{ briefSet: 'mine', capUsd: 5 }, /briefSet/],
      [{ briefs: [{ ref: 'nope' }], capUsd: 5 }, /starter brief/],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await studio.launch(pool, {}, body, { actorId: evan.id, deps });
      assert.equal(out.ok, false);
      assert.match(out.error, re);
    }
    assert.equal((await studio.launch(pool, {}, { briefSet: 'starter', capUsd: 5, contextPackIds: [777] }, { actorId: evan.id, deps })).status, 404);
    assert.equal(created.length, 0, 'nothing was made for a refused launch');

    launched = await studio.launch(pool, {}, {
      briefSet: 'starter', refs: ['bread', 'tier-list'],
      briefs: [{ name: 'Plant Log', brief: 'Track when I water each of my plants, and remind me when one is due.' }],
      models: ['today', 'z-ai/glm-5.3-flash'], contextPackIds: [0, pack.id], references: 1, capUsd: 20, note: 'first try',
    }, { actorId: evan.id, deps });
    assert.equal(launched.ok, true, launched.error);
    assert.equal(created.length, 1, 'the host app is made once');
    assert.equal(launched.trials, 3 * 2 * 2);
    assert.deepEqual(launched.briefs.map((b) => b.ref), ['bread', 'tier-list', null]);
    run = launched.run;
    const { rows: [r] } = await pool.query('SELECT kind, context_pack_ids, references_per_brief, stages FROM bench_runs WHERE id = $1', [run.id]);
    assert.equal(r.kind, 'studio');
    assert.deepEqual(r.context_pack_ids, [0, pack.id]);
    assert.equal(r.references_per_brief, 1);
    assert.deepEqual(r.stages, ['first_version']);
    const host = await studio.hostRow(pool);
    assert.equal(await studio.isHostApp(pool, host.id), true);
    const { rows: [{ n }] } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM app_collaborators WHERE app_id = $1 AND status = 'member'", [host.id],
    );
    assert.equal(n, 1, 'the host app is private to the benchmark user');
    const { rows: [usedAt] } = await pool.query('SELECT used_at FROM bench_context_packs WHERE id = $1', [pack.id]);
    assert.ok(usedAt.used_at, 'a pack is stamped used at launch');

    const again = await studio.launch(pool, {}, { briefs: [{ ref: 'bread' }], capUsd: 5 }, { actorId: evan.id, deps });
    assert.equal(again.briefs[0].taskId, launched.briefs[0].taskId, 'the same brief, the same task');
    assert.equal(created.length, 1);
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [again.run.id]);
    const runs = await studio.listStudioRuns(pool);
    assert.deepEqual(runs.map((x) => x.id), [again.run.id, run.id]);
  });

  await t.test('a watch reports every trial, then only what changed since its cursor', async () => {
    const first = await studio.watchRun(pool, run.id);
    assert.equal(first.ok, true);
    assert.equal(first.trials.length, 12);
    assert.equal(first.counts.pending, 12);
    assert.equal(first.changedOnly, false);
    const labels = new Set(first.trials.map((x) => x.armLabel));
    assert.ok(labels.has('z-ai/glm-5.3-flash + warm theme v2'), [...labels].join(', '));
    assert.ok(labels.has('today'));

    const quiet = await studio.watchRun(pool, run.id, { since: first.cursor });
    assert.equal(quiet.trials.length, 0);
    const moving = first.trials[0];
    await pool.query(
      "UPDATE bench_trials SET status = 'running', started_at = NOW(), progress = $2::jsonb WHERE id = $1",
      [moving.trialId, JSON.stringify({ step: 'build', lines: ['Using skill warm'], skills: { invoked: ['warm'], read: [] }, updatedAt: new Date(Date.now() + 1000).toISOString() })],
    );
    const next = await studio.watchRun(pool, run.id, { since: first.cursor });
    assert.equal(next.changedOnly, true);
    assert.deepEqual(next.trials.map((x) => x.trialId), [moving.trialId]);
    assert.equal(next.trials[0].step, 'build');
    assert.deepEqual(next.trials[0].skills.invoked, ['warm']);
    assert.equal((await studio.watchRun(pool, 99999)).status, 404);
  });

  let order;
  await t.test('a reference order waits for the first commit, then hands it out with the pack', async () => {
    const taskId = launched.briefs[0].taskId;
    assert.equal((await studio.referenceOrder(pool, {}, { runId: run.id, taskId, packId: 4242 })).status, 400, 'a pack the run was not launched with');
    const github = { createRootCommit: async () => SHA('a'), deleteBenchBranch: async () => {}, ensureBranchAtSha: async () => {} };
    const waiting = await studio.referenceOrder(pool, {}, {
      runId: run.id, taskId, packId: pack.id,
      deps: { github, makeSketch: async () => ({ design: { kind: 'card', emoji: '🍞', tagline: 'Bread by the gram', points: ['Pick a bread'] }, model: 'm' }) },
    });
    assert.equal(waiting.ok, true);
    assert.equal(waiting.ready, false);
    let ready = null;
    for (let i = 0; i < 50 && !ready; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ready = await scaffold.readyFor(pool, { runId: run.id, taskId, packId: pack.id });
      // eslint-disable-next-line no-await-in-loop
      if (!ready) await new Promise((r) => { setTimeout(r, 50); });
    }
    assert.ok(ready, 'the first commit was made in the background');
    const out = await studio.referenceOrder(pool, {}, { runId: run.id, taskId, packId: pack.id });
    assert.equal(out.ready, true);
    order = out.order;
    assert.equal(order.start.sha, SHA('a'));
    assert.match(order.start.branch, /^bench\/r\d+-s\d+$/);
    assert.equal(order.ref, 'bread');
    assert.equal(order.pack.version, 2);
    assert.match(order.pack.guidance.build, /Round corners/);
    assert.deepEqual(order.pack.files, ['.claude/skills/warm/SKILL.md']);
    assert.equal(order.sketch.tagline, 'Bread by the gram');
    assert.match(order.howItIsJudged, /16 screenshots/);
    const watch = await studio.watchRun(pool, run.id);
    assert.ok(watch.firstCommits.some((f) => f.taskId === taskId && f.packId === pack.id && f.status === 'ready'));
  });

  let refTrial;
  await t.test('a reference handed in is a trial of its own; the same label again is its next attempt', async () => {
    const taskId = launched.briefs[0].taskId;
    const common = { runId: run.id, taskId, packId: pack.id, user: { id: evan.id } };
    assert.equal((await studio.submitReference(pool, {}, { ...common, label: 'Ref V1', patch: 'x' })).status, 400);
    assert.equal((await studio.submitReference(pool, {}, { ...common, label: 'ref-v1', patch: 'x', branch: 'b' })).status, 400);
    const notLinked = await studio.submitReference(pool, {}, {
      ...common, label: 'ref-v1', repo: 'bread', branch: 'main', deps: { githubLink: { linkStatus: async () => ({ linked: false }) } },
    });
    assert.equal(notLinked.code, 'github_not_linked');
    const { rows: [{ n: left }] } = await pool.query("SELECT COUNT(*)::int AS n FROM bench_trials WHERE status = 'awaiting'");
    assert.equal(left, 0, 'a refused hand-in leaves nothing behind');

    const pins = [];
    const refDeps = {
      applyPatch: async ({ baseSha }) => { assert.equal(baseSha, SHA('a')); return { ok: true, headSha: SHA('b'), cleanup: () => {} }; },
      github: { ensureBranchAtSha: async (o, r, branch, sha) => { pins.push([branch, sha]); } },
    };
    const patch = `From ${SHA('1')} Mon Sep 17 00:00:00 2001\nSubject: one\n\nFrom ${SHA('2')} Mon Sep 17 00:00:00 2001\nSubject: two\n`;
    const v1 = await studio.submitReference(pool, {}, { ...common, label: 'ref-v1', patch, deps: refDeps });
    assert.equal(v1.ok, true, v1.error);
    assert.equal(v1.attempt, 1);
    assert.equal(v1.commits, 2);
    assert.equal(v1.model, 'reference:ref-v1');
    assert.deepEqual(pins, [[`bench/r${run.id}-t${v1.trialId}`, SHA('b')]]);
    const { rows: [row] } = await pool.query('SELECT status, capture_sha, reference_label, context_pack_id, base_sha FROM bench_trials WHERE id = $1', [v1.trialId]);
    assert.deepEqual(row, { status: 'pending', capture_sha: SHA('b'), reference_label: 'ref-v1', context_pack_id: pack.id, base_sha: SHA('a') });
    const v1b = await studio.submitReference(pool, {}, { ...common, label: 'ref-v1', patch, deps: refDeps });
    assert.equal(v1b.attempt, 2);
    refTrial = v1.trialId;
    const watch = await studio.watchRun(pool, run.id);
    const ref = watch.trials.find((x) => x.trialId === refTrial);
    assert.equal(ref.arm.kind, 'reference');
    assert.equal(ref.armLabel, 'reference ref-v1 + warm theme v2');
    const again = await studio.referenceOrder(pool, {}, { runId: run.id, taskId, packId: pack.id });
    assert.deepEqual(again.order.references.map((x) => x.label), ['ref-v1', 'ref-v1']);
  });

  await t.test('a re-run is the arm\'s next attempt; a build is kept only while it has a branch', async () => {
    assert.equal((await studio.rerunTrial(pool, refTrial)).status, 409, 'still under way');
    await pool.query(
      "UPDATE bench_trials SET status = 'ok', finished_at = NOW(), build_branch = $2, build_sha = $3 WHERE id = $1",
      [refTrial, `bench/r${run.id}-t${refTrial}`, SHA('b')],
    );
    const re = await studio.rerunTrial(pool, refTrial);
    assert.equal(re.ok, true, re.error);
    assert.equal(re.attempt, 3);
    const { rows: [made] } = await pool.query('SELECT capture_sha, reference_label, status FROM bench_trials WHERE id = $1', [re.trialId]);
    assert.deepEqual(made, { capture_sha: SHA('b'), reference_label: 'ref-v1', status: 'pending' }, 'a reference is captured again at its commit');

    const plain = (await studio.watchRun(pool, run.id)).trials.find((x) => x.arm.kind === 'platform' && x.status === 'pending');
    assert.equal((await studio.keepTrial(pool, plain.trialId)).status, 404, 'no branch to keep');
    const kept = await studio.keepTrial(pool, refTrial);
    assert.equal(kept.kept, true);
    assert.equal((await studio.keepTrial(pool, refTrial, false)).kept, false);
  });

  await t.test('per-trial reads of a run that is not a studio run wait for the judge', async () => {
    const open = await studio.trialRows(pool, run.id);
    assert.equal(open.ok, true, 'a studio run is open by design');
    assert.ok(open.trials.length >= 14);
    const detail = await studio.trialDetail(pool, refTrial);
    assert.equal(detail.ok, true);
    assert.match(detail.trial.brief, /bread/i);

    const { rows: [classic] } = await pool.query(
      `INSERT INTO bench_runs (suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, status)
       SELECT suite_id, ARRAY['m/a'], 'm/a', ARRAY['first_version'], 1, 5, 1, 'running' FROM bench_runs WHERE id = $1 RETURNING id`,
      [run.id],
    );
    const { rows: [blind] } = await pool.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, finished_at)
       VALUES ($1, $2, 'm/a', 1, 'ok', $3, NOW()) RETURNING id`,
      [classic.id, launched.briefs[0].taskId, crypto.randomBytes(8).toString('hex')],
    );
    const rows = await studio.trialRows(pool, classic.id);
    assert.equal(rows.code, 'judge_pending', JSON.stringify(rows));
    assert.equal((await studio.trialDetail(pool, blind.id)).code, 'judge_pending');
  });

  await t.test('only a studio build can be previewed, at most four at once, and the sweep takes one down after a day', async () => {
    const { rows: [other] } = await pool.query("INSERT INTO apps (name, slug, status, repo_url) VALUES ('Real', 'real-app', 'running', 'https://github.com/usernode-bot/real-app') RETURNING id");
    const { rows: [task] } = await pool.query('SELECT suite_id, snapshot_id FROM bench_tasks WHERE id = $1', [launched.briefs[0].taskId]);
    const { rows: [realTask] } = await pool.query(
      `INSERT INTO bench_tasks (suite_id, stage, app_id, snapshot_id, reference_source, label_token)
       VALUES ($1, 'first_version', $2, $3, 'authored', $4) RETURNING id`,
      [task.suite_id, other.id, task.snapshot_id, crypto.randomBytes(8).toString('hex')],
    );
    const { rows: [realTrial] } = await pool.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, build_sha, build_branch)
       VALUES ($1, $2, 'm/b', 1, 'ok', $3, $4, 'bench/r1-t1') RETURNING id`,
      [run.id, realTask.id, crypto.randomBytes(8).toString('hex'), SHA('c')],
    );
    const refused = await studio.deployPreview(pool, {}, { trialId: realTrial.id, user: { id: evan.id } });
    assert.equal(refused.status, 409);
    assert.match(refused.error, /never an app's real data/);

    const deploys = [];
    const benchUser = (await pool.query("INSERT INTO users (username, password, is_synthetic) VALUES ('bench_stub', 'x', TRUE) RETURNING id")).rows[0];
    const previewDeps = {
      user: benchUser,
      staging: {
        async buildAndDeployStaging(_config, session, app, sha) {
          deploys.push({ sessionId: session.id, app: app.slug, sha });
          await pool.query('UPDATE chat_sessions SET staging_url = $2 WHERE id = $1', [session.id, `https://staging.example/${session.id}`]);
        },
      },
    };
    const up = await studio.deployPreview(pool, {}, { trialId: refTrial, user: { id: evan.id }, deps: previewDeps });
    assert.equal(up.ok, true, up.error);
    assert.equal(up.preview.status, 'building');
    for (let i = 0; i < 50 && !deploys.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 20); });
    }
    await new Promise((r) => { setTimeout(r, 50); });
    assert.equal(deploys[0].sha, SHA('b'));
    const host = await studio.hostRow(pool);
    assert.equal(deploys[0].app, host.slug, 'on the host app, whose database is its own empty one');
    const { rows: [member] } = await pool.query('SELECT status FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [host.id, evan.id]);
    assert.equal(member.status, 'member', 'the admin who asked can open it');
    const live = (await studio.watchRun(pool, run.id)).trials.find((x) => x.trialId === refTrial).preview;
    assert.equal(live.status, 'live');
    assert.match(live.url, /^https:\/\/staging\.example\//);
    const reused = await studio.deployPreview(pool, {}, { trialId: refTrial, user: { id: evan.id }, deps: previewDeps });
    assert.equal(reused.reused, true, 'one preview a build at a time');

    await pool.query(
      `INSERT INTO bench_previews (trial_id, status, expires_at)
       SELECT $1, 'live', NOW() + INTERVAL '1 hour' FROM generate_series(1, 3)`,
      [realTrial.id],
    );
    const otherRef = (await pool.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, build_sha, build_branch, reference_label)
       VALUES ($1, $2, 'reference:ref-v9', 1, 'ok', $3, $4, 'bench/r1-t9', 'ref-v9') RETURNING id`,
      [run.id, launched.briefs[0].taskId, crypto.randomBytes(8).toString('hex'), SHA('d')],
    )).rows[0];
    const capped = await studio.deployPreview(pool, {}, { trialId: otherRef.id, user: { id: evan.id }, deps: previewDeps });
    assert.equal(capped.code, 'preview_cap');

    await pool.query("UPDATE bench_previews SET expires_at = NOW() - INTERVAL '1 minute'");
    const torn = [];
    const ended = await studio.sweepPreviews(pool, {
      force: true, sessionLifecycle: { async teardownStagingForSession({ sessionId }) { torn.push(sessionId); } },
    });
    assert.equal(ended, 4);
    assert.deepEqual(torn, [deploys[0].sessionId]);
    const { rows: [s] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [deploys[0].sessionId]);
    assert.equal(s.status, 'archived');
  });

  await t.test('the routes: any admin reads the console\'s; only a full admin reaches the connector\'s, and its writes are same-origin', async () => {
    const poolMod = require('../src/db/pool');
    const realGetPool = poolMod.getPool;
    poolMod.getPool = () => pool;
    let routes;
    try {
      ({ benchStudioRoutes: routes } = require('../src/routes/bench-studio'));
    } finally {
      poolMod.getPool = realGetPool;
    }
    const appX = express();
    appX.use(express.json());
    appX.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'admin') req.user = { id: evan.id, username: 'evan', isAdmin: true, canAdminWrite: true };
      if (req.headers['x-test-user'] === 'viewer') req.user = { id: evan.id, username: 'viewer', isAdmin: true, canAdminWrite: false };
      next();
    });
    appX.use(routes({}));
    const server = http.createServer(appX);
    await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
    t.after(() => new Promise((r) => { server.close(r); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, { who = 'admin', body, sameOrigin = true } = {}) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': who, 'sec-fetch-site': sameOrigin ? 'same-origin' : 'cross-site' },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };

    const consoleRead = await call('GET', '/api/admin/homeroom-bot/bench/studio', { who: 'viewer' });
    assert.equal(consoleRead.status, 200);
    assert.equal(consoleRead.body.starter.length, 5);
    assert.ok(consoleRead.body.runs.length >= 2);
    assert.equal((await call('POST', '/api/admin/homeroom-bot/bench/studio/packs', { who: 'viewer', body: { name: 'x', guidance: 'y' } })).status, 403);
    // Somebody who is not an admin is sent away, as from every console route.
    assert.ok([302, 403].includes((await call('GET', '/api/admin/homeroom-bot/bench/studio', { who: 'nobody' })).status));

    assert.equal((await call('GET', '/api/bot-studio', { who: 'viewer' })).status, 403, 'a read-only admin never reaches the connector\'s doors');
    assert.equal((await call('GET', '/api/bot-studio/shots', { who: 'viewer' })).status, 403);
    const home = await call('GET', '/api/bot-studio');
    assert.equal(home.status, 200);
    assert.equal(home.body.limits.livePreviews, 4);
    const watch = await call('GET', `/api/bot-studio/runs/${run.id}/watch?since=`);
    assert.equal(watch.status, 200);
    assert.equal(watch.body.changedOnly, false);
    assert.equal((await call('GET', '/api/bot-studio/runs/abc/watch')).status, 400);

    assert.equal((await call('POST', '/api/bot-studio/packs', { body: { name: 'cool', guidance: 'Cool colours.' }, sameOrigin: false })).status, 403);
    const saved = await call('POST', '/api/bot-studio/packs', { body: { name: 'cool', guidance: 'Cool colours.' } });
    assert.equal(saved.status, 200, saved.body.error);
    assert.equal(saved.body.pack.version, 1);
    const big = await call('POST', '/api/bot-studio/launch', { body: { briefSet: 'starter', capUsd: 150 } });
    assert.equal(big.status, 400);
    assert.match(big.body.error, /confirmLargeCap/);
    const rows = await call('GET', `/api/bot-studio/runs/${run.id}/trials`);
    assert.equal(rows.status, 200);
    const suites = await call('GET', '/api/bot-studio/suites');
    assert.equal(suites.status, 200);
    assert.ok(JSON.stringify(suites.body).includes('App bench studio'));
  });

  await t.test('the gallery groups each studio brief\'s builds, newest first, without the ones that never ran', async () => {
    const g = await studio.gallery(pool, {});
    assert.equal(g.ok, true);
    const bread = g.briefs.find((b) => b.ref === 'bread');
    assert.ok(bread.builds.length > 0);
    assert.ok(bread.builds.every((b) => b.status !== 'awaiting' && b.status !== 'not_applicable'));
    const ids = bread.builds.map((b) => b.trialId);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    const one = await studio.gallery(pool, { taskId: bread.taskId });
    assert.deepEqual(one.briefs.map((b) => b.taskId), [bread.taskId]);
  });
});
