'use strict';

// The Homeroom bot's first-version configurations against the FULL
// PostgreSQL schema (src/services/bot-configs.js, src/services/bot-review.js,
// and their places in homeroom-bot.js and the App bench lane):
//
//   - the deploy's seed writes the three configurations once, one current;
//   - saving a recipe makes a new version, and the roles move with it so
//     there is always exactly one current;
//   - a live first version spawns its side builds on the App bench lane,
//     linked to the run and the version, within the side builds' weekly
//     budget, private projects included; a side derivable from the current
//     recipe waits for the live build's round-0 snapshot instead;
//   - the live build's outcome and its round-0 snapshot, and a side trial's
//     outcome, become results; the results become blind pairs; a pick is
//     recorded once; and the numbers come out per version, with a Wilson
//     interval;
//   - a restart that catches a first version in its review proposes its
//     last committed state and records the review as interrupted, and the
//     sweep for lost live builds leaves it alone.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const OPUS = 'anthropic/claude-opus-5.5';
const GLM = 'z-ai/glm-5.3-flash';

function shots(prefix) {
  return ['phone-light-populated', 'phone-dark-populated', 'desktop-light-populated'].map((id, i) => {
    const [viewport, look, state] = id.split('-');
    return { id, viewport, look, state, sha256: `${prefix}${i}`.padEnd(64, 'a').slice(0, 64), artifactId: null };
  });
}

test('bot configurations against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bot_configs_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const live = require('../src/services/homeroom-bot-live');
  const bot = require('../src/services/homeroom-bot');
  const real = {
    post: live.post, advanceSeen: live.advanceSeen, mentionTargets: live.mentionTargets, promoteAsBot: live.promoteAsBot,
  };
  t.after(async () => {
    Object.assign(live, real);
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  const configs = require('../src/services/bot-configs');
  const review = require('../src/services/bot-review');

  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password, is_admin) VALUES ('evan', 'x', TRUE) RETURNING id");
  const { rows: [botUser] } = await pool.query("INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username");
  // A PRIVATE project: its first version's side builds are made all the same.
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url, view_visibility, collab_visibility)
     VALUES ('Plant Log', 'plant-log', 'running', 'https://github.com/usernode-bot/plant-log', 'private', 'private')
     RETURNING id, slug, name, repo_url`,
  );
  const runRow = async (extra = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, cost_usd, duration_ms, model)
     VALUES ($1, $2, 'live', 'ready', 'A plant log: plants, waterings, reminders.', $3, $4, $5)
     RETURNING id`,
    [app.id, extra.issue || 1, extra.cost ?? 0.04, extra.ms ?? 90_000, GLM],
  )).rows[0].id;
  const snapshotFor = async (runId) => require('../src/services/homeroom-bot-snapshots').recordSnapshot(pool, {
    runId, stage: 'build', appId: app.id, issueNumber: 1, baseSha: 'a'.repeat(40),
    texts: { seed: 'Issue #1: Plant Log\n\nTrack when I water each plant.', build_note: 'A plant log: plants, waterings, reminders.' },
    extra: { firstVersion: true, model: GLM, specModel: OPUS },
  });

  let current;
  let allGlm;
  let noReview;
  await t.test('the seed writes the three configurations once, one of them current', async () => {
    assert.equal(await configs.seedConfigs(pool), 3);
    assert.equal(await configs.seedConfigs(pool), 0, 'a second deploy writes nothing');
    const list = await configs.listVersions(pool);
    assert.deepEqual(list.map((v) => [v.key, v.version, v.role]), [
      ['opus-spec-review', 1, 'current'], ['all-glm', 1, 'side'], ['opus-spec-no-review', 1, 'side'],
    ]);
    current = await configs.currentVersion(pool);
    assert.equal(current.key, 'opus-spec-review');
    assert.deepEqual(current.recipe.reviewer, { model: OPUS, maxRounds: 3, budgetMinutes: 25 });
    allGlm = list.find((v) => v.key === 'all-glm');
    noReview = list.find((v) => v.key === 'opus-spec-no-review');
    // A seeded version an admin retired stays retired.
    await configs.setRole(pool, { id: allGlm.id, role: 'retired' });
    assert.equal(await configs.seedConfigs(pool), 0);
    assert.equal((await configs.versionById(pool, allGlm.id)).role, 'retired');
    await configs.setRole(pool, { id: allGlm.id, role: 'side' });
  });

  await t.test('saving makes a new version, and there is always exactly one current', async () => {
    const recipe = { models: { triage: GLM, spec: GLM, build: GLM }, reviewer: { model: OPUS, maxRounds: 2, budgetMinutes: 15 }, pack: null };
    const bad = await configs.saveVersion(pool, { label: 'Broken', recipe: { models: {} }, role: 'side' });
    assert.equal(bad.ok, false);
    assert.equal((await configs.saveVersion(pool, { label: 'With pack', recipe: { ...recipe, pack: 999 }, role: 'side' })).status, 404, 'a pack must exist');
    assert.match((await configs.saveVersion(pool, { recipe, role: 'side' })).error, /key|label/);
    assert.equal((await configs.saveVersion(pool, { label: 'x', recipe, role: 'boss' })).ok, false);

    const v1 = await configs.saveVersion(pool, { label: 'GLM with review', recipe, role: 'side', actorId: evan.id, notes: 'try a cheap spec' });
    assert.equal(v1.ok, true, v1.error);
    assert.equal(v1.version.key, 'glm-with-review');
    assert.equal(v1.version.version, 1);
    assert.equal(v1.version.createdBy, 'evan');
    // Editing it: the next version, and the old side version retired.
    const v2 = await configs.saveVersion(pool, { key: 'glm-with-review', recipe: { ...recipe, reviewer: { ...recipe.reviewer, maxRounds: 3 } }, role: 'side' });
    assert.equal(v2.version.version, 2);
    assert.equal(v2.version.label, 'GLM with review', 'the label carries over');
    assert.equal((await configs.versionById(pool, v1.version.id)).role, 'retired');
    // Promoting it: the old current becomes a side version.
    const promoted = await configs.setRole(pool, { id: v2.version.id, role: 'current' });
    assert.equal(promoted.ok, true);
    assert.deepEqual(promoted.demoted, [{ id: current.id, role: 'side' }]);
    assert.equal((await configs.versionById(pool, current.id)).role, 'side');
    const refused = await configs.setRole(pool, { id: v2.version.id, role: 'retired' });
    assert.equal(refused.status, 409, 'the current one cannot just be retired');
    assert.equal(refused.code, 'current_required');
    // A saved current: the version current until now becomes side.
    const v3 = await configs.saveVersion(pool, { key: 'glm-with-review', recipe, role: 'current' });
    assert.equal(v3.version.role, 'current');
    assert.equal((await configs.versionById(pool, v2.version.id)).role, 'retired', 'its own earlier version is retired, not kept as a side');
    const { rows: [{ n }] } = await pool.query("SELECT COUNT(*)::int AS n FROM bot_config_versions WHERE role = 'current'");
    assert.equal(n, 1);
    // Back to the seeded current, with its sides, for what follows.
    await configs.setRole(pool, { id: current.id, role: 'current' });
    await configs.setRole(pool, { id: v3.version.id, role: 'retired' });
    const roles = (await configs.listVersions(pool)).filter((v) => v.role !== 'retired').map((v) => v.key).sort();
    assert.deepEqual(roles, ['all-glm', 'opus-spec-no-review', 'opus-spec-review']);
    // A seeded current is written as a side one when another is current.
    await pool.query("DELETE FROM bot_config_versions WHERE seed_key = 'all-glm-v1'");
    const fresh = await configs.saveVersion(pool, { key: 'all-glm', label: 'All GLM', recipe: { ...recipe, reviewer: null }, role: 'side' });
    assert.equal(fresh.version.version, 1, 'the key starts over once its seeded row is gone');
    allGlm = fresh.version;
  });

  let runId;
  let spawned;
  await t.test('a live first version spawns its side builds on the App bench lane, linked to it', async () => {
    runId = await runRow();
    const snapshotId = await snapshotFor(runId);
    const lane = { woke: 0, wake() { this.woke += 1; } };
    spawned = await configs.spawnSideBuilds(pool, {}, { botRunId: runId, app, snapshotId, current, deps: { lane } });
    assert.deepEqual({ derived: spawned.derived, trials: spawned.trials, skipped: spawned.skipped }, { derived: 1, trials: 1, skipped: 0 });
    assert.equal(lane.woke, 1, 'the lane is woken');
    const { rows: results } = await pool.query(
      'SELECT config_version_id, source, status, trial_id FROM bot_config_results WHERE bot_run_id = $1 ORDER BY config_version_id', [runId],
    );
    const bySource = Object.fromEntries(results.map((r) => [r.source, r]));
    assert.equal(bySource.round0.config_version_id, noReview.id, 'Opus spec + GLM, no reviewer: from the round-0 snapshot');
    assert.equal(bySource.round0.status, 'pending');
    assert.equal(bySource.trial.config_version_id, allGlm.id, 'all-GLM: built for real');
    const { rows: [trial] } = await pool.query(
      `SELECT tr.id, tr.model, tr.status, tr.bot_run_id, tr.bot_config_version_id, r.kind, r.cap_usd::float8 AS cap,
              t.stage, t.source_run_id, t.app_id, t.snapshot_id, s.name AS suite
         FROM bench_trials tr JOIN bench_runs r ON r.id = tr.run_id JOIN bench_tasks t ON t.id = tr.task_id
         JOIN bench_suites s ON s.id = t.suite_id WHERE tr.id = $1`,
      [bySource.trial.trial_id],
    );
    assert.deepEqual(
      [trial.model, trial.status, trial.bot_run_id, trial.bot_config_version_id, trial.kind, trial.stage, trial.source_run_id, trial.app_id, trial.snapshot_id, trial.suite],
      [`config:${allGlm.id}`, 'pending', runId, allGlm.id, 'bot_config', 'first_version', runId, app.id, snapshotId, 'Bot configurations'],
      'a first-version trial on the private project itself, replaying the live run\'s snapshot',
    );
    assert.ok(trial.cap > 0 && trial.cap <= 25, 'its run\'s cap is inside the week\'s budget');
    // Again (a live build restarted from its kept spec): nothing twice.
    const again = await configs.spawnSideBuilds(pool, {}, { botRunId: runId, app, snapshotId, current, deps: { lane } });
    assert.deepEqual({ derived: again.derived, trials: again.trials }, { derived: 0, trials: 0 });
    // The lane reads the trial as the version's recipe: a side build.
    const lanes = require('../src/services/bench/lane');
    const row = await lanes.loadTrialContext(pool, trial.id);
    const ctx = await lanes.studioContext(pool, {}, row, await bot.readSettings(pool));
    assert.deepEqual(ctx.stageModels, { triage: GLM, spec: GLM, build: GLM });
    assert.deepEqual(ctx.sideBuild, { botRunId: runId, versionId: allGlm.id });
    assert.equal(ctx.reviewer, undefined, 'all-GLM has no reviewer');
    // And `today` is the current configuration now, reviewer and all.
    const today = await lanes.studioContext(pool, {}, { ...row, bot_config_version_id: null, bot_run_id: null, model: 'today' }, await bot.readSettings(pool));
    assert.deepEqual(today.stageModels, { triage: GLM, spec: OPUS, build: GLM });
    assert.deepEqual(today.reviewer, { model: OPUS, maxRounds: 3, budgetMinutes: 25 });
    assert.equal(today.sideBuild, undefined);
    assert.equal(today.harnessOf(OPUS), 'claude');
  });

  await t.test('once the week\'s side budget is spent, a side build is skipped and says why', async () => {
    await pool.query("INSERT INTO platform_settings (key, value) VALUES ('bot_config_side_weekly_cents', '0')");
    const other = await runRow({ issue: 2 });
    const out = await configs.spawnSideBuilds(pool, {}, { botRunId: other, app, snapshotId: await snapshotFor(other), current, deps: { lane: { wake() {} } } });
    assert.deepEqual({ trials: out.trials, skipped: out.skipped, derived: out.derived }, { trials: 0, skipped: 1, derived: 1 });
    const { rows: [r] } = await pool.query(
      'SELECT status, error FROM bot_config_results WHERE bot_run_id = $1 AND config_version_id = $2', [other, allGlm.id],
    );
    assert.equal(r.status, 'skipped');
    assert.match(r.error, /weekly budget \(\$0\.00\) is spent/);
    await pool.query("DELETE FROM platform_settings WHERE key = 'bot_config_side_weekly_cents'");
    const budget = await configs.sideBudget(pool);
    assert.equal(budget.limitUsd, 25);
  });

  await t.test('the live build\'s outcome and its round-0 snapshot become results; a side trial\'s too; then blind pairs', async () => {
    // The review's screenshots, stored per round.
    const kept = [{ id: 'phone-light-populated', viewport: 'phone', look: 'light', state: 'populated', data: Buffer.from('png0'), width: 390, height: 844, bytes: 4, sha256: 'c'.repeat(64) }];
    const ids0 = await review.storeRoundShots(pool, { botRunId: runId, round: 0 }, kept);
    const ids2 = await review.storeRoundShots(pool, { botRunId: runId, round: 2 }, kept);
    const r0 = { booted: true, shots: [{ ...shots('r0')[0], artifactId: ids0['phone-light-populated'] }] };
    const fin = { booted: true, shots: [{ ...shots('fi')[0], artifactId: ids2['phone-light-populated'] }] };
    const built = {
      ok: true, sha: 'sha3', commits: 3, costUsd: 1.95,
      review: { round0: { sha: 'sha1', capture: r0, costUsd: 0.9, activeMs: 1_200_000 }, finalCapture: fin, stop: 'ship', rounds: [] },
    };
    assert.equal(await configs.finishLive(pool, { botRunId: runId, version: current, built, activeMs: 2_100_000 }), true);
    const { rows } = await pool.query(
      `SELECT source, status, built, booted, cost_usd::float8 AS cost, active_ms::float8 AS ms, sha
         FROM bot_config_results WHERE bot_run_id = $1 ORDER BY source`, [runId],
    );
    const by = Object.fromEntries(rows.map((r) => [r.source, r]));
    assert.deepEqual([by.live.status, by.live.built, by.live.booted, by.live.sha], ['done', true, true, 'sha3']);
    assert.ok(Math.abs(by.live.cost - (1.95 + 0.04)) < 1e-9, 'the whole first version: the triage, spec, build and review');
    assert.equal(by.live.ms, 2_100_000 + 90_000, 'the build\'s time and the triage\'s, no queue');
    assert.deepEqual([by.round0.status, by.round0.built, by.round0.booted, by.round0.sha], ['done', true, true, 'sha1']);
    assert.ok(Math.abs(by.round0.cost - (0.9 + 0.04)) < 1e-9, 'the cost up to round 0');
    assert.equal(by.round0.ms, 1_200_000 + 90_000);
    assert.equal(by.trial.status, 'pending', 'the side trial is still building');

    // One pair now: current against the round-0 snapshot.
    const { rows: pairs1 } = await pool.query('SELECT status FROM bot_config_pairs WHERE bot_run_id = $1', [runId]);
    assert.deepEqual(pairs1.map((p) => p.status), ['waiting']);

    // The side trial finishes: built, but its app would not boot.
    const { rows: [{ trial_id: trialId }] } = await pool.query("SELECT trial_id FROM bot_config_results WHERE bot_run_id = $1 AND source = 'trial'", [runId]);
    await pool.query(
      `UPDATE bench_trials SET status = 'ok', parsed = '{"built":true}'::jsonb, capture = $2::jsonb, cost_usd = 0.38,
              interrupted_cost_usd = 0.02, duration_ms = 1500000, build_sha = 'sideSha', build_commits = 1
        WHERE id = $1`,
      [trialId, JSON.stringify({ booted: false, error: 'npm run build failed', shots: [] })],
    );
    assert.equal(await configs.finishSideTrial(pool, trialId), true);
    const { rows: [side] } = await pool.query(
      "SELECT status, built, booted, cost_usd::float8 AS cost, active_ms::float8 AS ms FROM bot_config_results WHERE bot_run_id = $1 AND source = 'trial'", [runId],
    );
    assert.deepEqual([side.status, side.built, side.booted], ['done', true, false]);
    assert.ok(Math.abs(side.cost - (0.38 + 0.02 + 0.04)) < 1e-9, 'the trial\'s cost, its interrupted attempts and the shared triage');
    assert.equal(side.ms, 1_500_000 + 90_000);
    const { rows: pairs2 } = await pool.query(
      'SELECT status, excluded_reason FROM bot_config_pairs WHERE bot_run_id = $1 ORDER BY id', [runId],
    );
    assert.deepEqual(pairs2.map((p) => [p.status, p.excluded_reason]), [
      ['waiting', null], ['excluded', 'didn\'t boot (the side configuration)'],
    ], 'a side that did not boot is counted, never offered');
    assert.equal(await configs.settlePairs(pool, runId), 0, 'idempotent');

    // The pair, blind.
    const next = await configs.nextPair(pool, { images: true });
    assert.equal(next.waiting, 1);
    const p = next.pair;
    assert.match(p.pairId, /^[A-Za-z0-9_-]{16}$/);
    assert.match(p.brief, /Track when I water each plant/);
    assert.equal(p.plan, 'A plant log: plants, waterings, reminders.');
    assert.deepEqual(Object.keys(p).sort(), ['appName', 'brief', 'left', 'pairId', 'plan', 'right'], 'nothing names a configuration');
    assert.ok(!/opus-spec|all-glm|config|recipe|cost/i.test(JSON.stringify({ ...p, left: { ...p.left, images: [] }, right: { ...p.right, images: [] } })));
    assert.equal(p.left.images.length, 1);
    assert.equal(Buffer.from(p.left.images[0].data, 'base64').toString(), 'png0');
    assert.match(p.left.screenshots[0], /^Phone 390×844, light look/);

    // A pick, once: left or right is mapped back to the configurations.
    const { rows: [{ left_is_current: leftIsCurrent }] } = await pool.query('SELECT left_is_current FROM bot_config_pairs WHERE token = $1', [p.pairId]);
    const sidePick = leftIsCurrent ? 'right' : 'left';
    assert.equal((await configs.submitPick(pool, { pairId: p.pairId, pick: 'up', userId: evan.id })).status, 400);
    const picked = await configs.submitPick(pool, { pairId: p.pairId, pick: sidePick, note: 'cleaner empty state', userId: evan.id });
    assert.deepEqual(picked, { ok: true, waiting: 0 });
    assert.equal((await configs.submitPick(pool, { pairId: p.pairId, pick: 'tie', userId: evan.id })).status, 409);
    const { rows: [rec] } = await pool.query('SELECT pick, note, picked_by FROM bot_config_pairs WHERE token = $1', [p.pairId]);
    assert.deepEqual([rec.pick, rec.note, rec.picked_by], ['side', 'cleaner empty state', evan.id]);
    assert.equal((await configs.nextPair(pool)).pair, null);
  });

  await t.test('the numbers, per version: builds, cost, time, boot rate, and a win rate with its interval', async () => {
    // Two more first versions, each paired with the round-0 snapshot.
    for (const [issue, pick] of [[3, 'current'], [4, 'tie']]) {
      // eslint-disable-next-line no-await-in-loop
      const id = await runRow({ issue, cost: 0.06 });
      for (const [version, source, cost] of [[current.id, 'live', 2.0], [noReview.id, 'round0', 1.0]]) {
        // eslint-disable-next-line no-await-in-loop
        await configs.recordResult(pool, {
          botRunId: id, configVersionId: version, source, built: true, booted: true, costUsd: cost, activeMs: 1_800_000,
          capture: { booted: true, shots: [] },
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await configs.settlePairs(pool, id);
      // eslint-disable-next-line no-await-in-loop
      await pool.query("UPDATE bot_config_pairs SET status = 'picked', pick = $2 WHERE bot_run_id = $1", [id, pick]);
    }
    const out = await configs.listWithStats(pool);
    assert.equal(out.currentId, current.id);
    const by = Object.fromEntries(out.versions.map((v) => [v.key, v]));
    assert.equal(out.versions[0].role, 'current', 'the current one first');
    const cur = by['opus-spec-review'].stats;
    assert.equal(cur.builds, 3);
    assert.ok(Math.abs(cur.avgCostUsd - (1.99 + 2.0 + 2.0) / 3) < 1e-9);
    assert.equal(cur.medianActiveMs, 1_800_000);
    assert.equal(cur.bootRate, 1);
    assert.equal(cur.vsCurrent, null, 'the baseline has no win rate against itself');
    const nr = by['opus-spec-no-review'].stats;
    assert.equal(nr.builds, 3);
    assert.equal(nr.vsCurrent.against, current.id);
    assert.deepEqual([nr.vsCurrent.wins, nr.vsCurrent.ties, nr.vsCurrent.losses, nr.vsCurrent.n], [1, 1, 1, 3]);
    assert.equal(nr.vsCurrent.rate, 0.5, 'a tie counts half');
    const w = configs.wilson(1.5, 3);
    assert.equal(nr.vsCurrent.low, w.low);
    assert.equal(nr.vsCurrent.high, w.high);
    const glm = by['all-glm'].stats;
    assert.equal(glm.builds, 1);
    assert.equal(glm.bootRate, 0);
    assert.deepEqual([glm.vsCurrent.n, glm.vsCurrent.excluded, glm.vsCurrent.didntBoot], [0, 1, 1]);
    assert.equal(out.sideBuilds.limitUsd, 25);
    assert.equal(out.sideBuilds.skipped, 1);
    assert.ok(out.versions.some((v) => v.role === 'retired'), 'retired versions are listed too, last');
  });

  await t.test('a restart in the middle of a review: the last committed state is proposed, the review recorded interrupted', async () => {
    bot._resetForTests();
    const posts = [];
    live.post = async (args) => { posts.push(args.kind); return { postId: posts.length }; };
    live.advanceSeen = async () => ({ advanced: true });
    live.mentionTargets = async () => [];
    const promoted = [];
    live.promoteAsBot = async ({ sessionId }) => { promoted.push(Number(sessionId)); return { status: 200, body: { ok: true, prNumber: 41 } }; };
    const deps = {
      github: {
        isEnabled: () => true, getBotUsername: async () => 'usernode-bot',
        async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, title: 'Plant Log', state: 'open' } }; },
        async fetchIssueComments() { return { comments: [] }; },
      },
      ws: {}, sessionLifecycle: {}, domain: 'app.onhomeroom.com', threadContext: { async loadIssueThread() { return { messages: [] }; } },
      managedOpenRouter: { async usesIncludedKey() { return false; } }, limits: {}, dm: { async noteBuildRestarted() {} },
    };
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues)
       VALUES ($1, $2, 'dev/homeroom_bot-x', 'paused', FALSE, ARRAY[7]) RETURNING id`,
      [app.id, botUser.id],
    );
    const id = await runRow({ issue: 7 });
    await pool.query(
      `UPDATE homeroom_bot_runs SET build_session_id = $2, bot_config_version_id = $3, created_at = NOW() - INTERVAL '5 hours' WHERE id = $1`,
      [id, s.id, current.id],
    );
    await configs.recordResult(pool, { botRunId: id, configVersionId: noReview.id, source: 'round0', status: 'pending' });
    const state = {
      state: 'reviewing', reviewer: { model: OPUS, maxRounds: 3, budgetMinutes: 25 }, startedAt: new Date().toISOString(),
      round0: { sha: 'r0sha', commits: 1, capture: { booted: true, shots: [] }, costUsd: 0.9, activeMs: 1_000_000 },
      rounds: [{ round: 1, sha: 'r0sha', verdict: 'fix', issues: [] }], finalSha: 'r1sha', finalCommits: 2, buildText: 'Built.\n==== DESCRIPTION ====\nIt logs plants.\n==== END DESCRIPTION ====',
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    await bot.recordReviewState(pool, id, state);
    const { rows: [saved] } = await pool.query('SELECT review_rounds, review_stop, review->>\'state\' AS st FROM homeroom_bot_runs WHERE id = $1', [id]);
    assert.deepEqual([saved.review_rounds, saved.review_stop, saved.st], [1, null, 'reviewing']);

    // The sweep for lost live builds leaves a run in its review alone.
    const settled = await bot.settleAbandonedLiveBuilds(pool, await bot.readSettings(pool), deps);
    assert.equal(settled, 0);

    // No turn on its session, nothing in this process: the review was cut short.
    assert.equal(await bot.finishInterruptedReviews(pool, {}, deps), 1);
    assert.deepEqual(promoted, [s.id], 'proposed as it stands');
    const { rows: [after] } = await pool.query(
      `SELECT build_ok, build_sha, proposal_session_id, review_stop, review->>'state' AS st FROM homeroom_bot_runs WHERE id = $1`, [id],
    );
    assert.deepEqual([after.build_ok, after.build_sha, after.proposal_session_id, after.review_stop, after.st], [true, 'r1sha', s.id, 'interrupted', 'done']);
    assert.ok(posts.includes('proposal'), 'the proposal is said as any is');
    const { rows: [msg] } = await pool.query(
      "SELECT metadata->>'proposalDescription' AS d FROM chat_session_messages WHERE session_id = $1 AND role = 'system'", [s.id],
    );
    assert.equal(msg.d, 'It logs plants.', 'described from the build\'s own message, kept with the review');
    const { rows: res } = await pool.query(
      'SELECT source, status, built, sha FROM bot_config_results WHERE bot_run_id = $1 ORDER BY source', [id],
    );
    assert.deepEqual(res.map((r) => [r.source, r.status, r.built, r.sha]), [['live', 'done', true, 'r1sha'], ['round0', 'done', true, 'r0sha']]);
    assert.equal(await bot.finishInterruptedReviews(pool, {}, deps), 0, 'once');
  });

  await t.test('a side trial recorded by the lane: its reviewer calls beside the ledger, its branch not kept, its result made', async () => {
    const lanes = require('../src/services/bench/lane');
    const id = await runRow({ issue: 8 });
    const out = await configs.spawnSideBuilds(pool, {}, { botRunId: id, app, snapshotId: await snapshotFor(id), current, deps: { lane: { wake() {} } } });
    assert.equal(out.trials, 1);
    const { rows: [tr] } = await pool.query('SELECT id, run_id FROM bench_trials WHERE bot_run_id = $1', [id]);
    const { rows: [benchUser] } = await pool.query("INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bench', 'x', TRUE) RETURNING id");
    const { rows: [sess] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues)
       VALUES ($1, $2, 'bench/r1-t1', 'paused', FALSE, '{}') RETURNING id`, [app.id, benchUser.id],
    );
    await pool.query(
      `INSERT INTO agent_turns (id, session_id, user_id, backend, status, routed_model, estimated_cost_usd, input_tokens, output_tokens)
       VALUES ($1, $2, $3, 'codex_openrouter', 'completed', $4, 0.3, 1000, 100)`,
      [crypto.randomUUID(), sess.id, benchUser.id, GLM],
    );
    await pool.query("UPDATE bench_trials SET status = 'running', session_id = $2, started_at = NOW() WHERE id = $1", [tr.id, sess.id]);
    const row = await lanes.loadTrialContext(pool, tr.id);
    const deleted = [];
    const status = await lanes.recordTrial(pool, {
      trialRow: { id: tr.id, run_id: tr.run_id }, row,
      patch: {
        status: 'ok', session_id: sess.id, cost_usd: 0.9, review_cost_usd: 0.25, duration_ms: 1_200_000,
        build_branch: 'bench/r1-t1', build_commits: 2, build_sha: 'e'.repeat(40), parsed: { built: true }, capture: { booted: true, shots: [] },
      },
      user: { id: benchUser.id },
      d: {
        worker: { evictWorker() {} }, github: { async deleteBenchBranch(_o, _r, b) { deleted.push(b); } }, afterTrial: async () => {},
        managedOpenRouter: { async usesIncludedKey() { return false; } }, limits: {},
      },
    });
    assert.equal(status, 'ok');
    const { rows: [after] } = await pool.query('SELECT cost_usd::float8 AS cost FROM bench_trials WHERE id = $1', [tr.id]);
    const { rows: [{ priced }] } = await pool.query('SELECT COUNT(*)::int AS priced FROM agent_turns WHERE session_id = $1', [sess.id]);
    assert.equal(priced, 1);
    assert.ok(Math.abs(after.cost - (0.3 + 0.25)) < 1e-9, 'the ledger, and the reviewer calls it does not hold');
    assert.deepEqual(deleted, ['bench/r1-t1'], 'a side build\'s branch is not kept, though it has commits');
    const { rows: [res] } = await pool.query(
      "SELECT status, built, booted FROM bot_config_results WHERE bot_run_id = $1 AND source = 'trial'", [id],
    );
    assert.deepEqual([res.status, res.built, res.booted], ['done', true, true]);
  });

  await t.test('staging seeds a demo of the table once; production never', async () => {
    const before = process.env.USERNODE_ENV;
    t.after(() => { if (before === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = before; });
    delete process.env.USERNODE_ENV;
    assert.equal(await configs.seedStagingBotConfigs(pool), false);
    process.env.USERNODE_ENV = 'staging';
    assert.equal(await configs.seedStagingBotConfigs(pool), true);
    assert.equal(await configs.seedStagingBotConfigs(pool), false, 'once');
    const { rows: [n] } = await pool.query(
      `SELECT COUNT(DISTINCT r.id)::int AS runs, COUNT(p.id)::int AS pairs,
              COUNT(p.id) FILTER (WHERE p.status = 'waiting')::int AS waiting,
              COUNT(p.id) FILTER (WHERE p.status = 'excluded')::int AS excluded
         FROM homeroom_bot_runs r LEFT JOIN bot_config_pairs p ON p.bot_run_id = r.id
        WHERE r.build_note LIKE 'Staging demo:%'`,
    );
    assert.deepEqual([n.runs, n.pairs, n.excluded], [5, 10, 1]);
    assert.ok(n.waiting >= 1);
    const out = await configs.listWithStats(pool);
    assert.ok(out.versions.find((v) => v.role === 'current').stats.builds >= 5);
  });
});
