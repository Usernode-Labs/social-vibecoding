'use strict';

// The `later` scope of the Homeroom bot's configurations against the FULL
// PostgreSQL schema (src/services/bot-configs.js):
//
//   - a database from before scopes (one current, the single one-current
//     index) takes the scope column and the per-scope index on boot, and the
//     seed then writes the later changes' two: an Opus spec and a GLM build,
//     current, beside all GLM; once, whatever an admin did since;
//   - roles move within a scope: each scope keeps exactly one current, a key
//     belongs to one scope, a later recipe has no reviewer, and a call that
//     names the wrong scope is refused;
//   - a later change's side builds are bench trials at the `build` stage,
//     on a run of their own kind, within their own weekly budget ($50 unless
//     set, set apart from the first versions' $25); once it is spent they are
//     skipped with a note that says they pause; the platform's own
//     repository is skipped with why;
//   - a later build's result and its side trial's make a pair with no
//     screenshots needed; the pair shows each side's spec and diff, blind;
//     a pick names its scope; the numbers come out per scope, with the build
//     rate and the current version's live proposals' outcomes.
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
const BASE = 'a'.repeat(40);

test('the later changes\' configurations against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bot_configs_later_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  const CATALOG = [
    { id: GLM, pricing: { prompt: '0.0000001', completion: '0.0000004' }, architecture: { input_modalities: ['text'] } },
    { id: OPUS, pricing: { prompt: '0.000005', completion: '0.000025' }, architecture: { input_modalities: ['text', 'image'] } },
  ];
  await pool.query('INSERT INTO openrouter_model_catalog (id, models, fetched_at) VALUES (TRUE, $1::jsonb, NOW())', [JSON.stringify(CATALOG)]);
  const configs = require('../src/services/bot-configs');
  const snapshots = require('../src/services/homeroom-bot-snapshots');

  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password, is_admin) VALUES ('evan', 'x', TRUE) RETURNING id");
  const { rows: [botUser] } = await pool.query("INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id");
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url, view_visibility, collab_visibility)
     VALUES ('Todo', 'todo', 'running', 'https://github.com/usernode-bot/todo', 'private', 'private')
     RETURNING id, slug, name, repo_url`,
  );
  const runRow = async ({ issue = 1, mode = 'live', proposal = null } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, cost_usd, duration_ms, model, proposal_session_id, build_spec_md)
     VALUES ($1, $2, $3, 'ready', 'Add a dark look.', 0.03, 60000, $4, $5, $6)
     RETURNING id`,
    [app.id, issue, mode, GLM, proposal, `# Dark mode (run ${issue})\n\n## User-facing changes\nThe live spec.`],
  )).rows[0].id;
  const snapshotFor = async (runId) => snapshots.recordSnapshot(pool, {
    runId, stage: 'build', appId: app.id, issueNumber: 1, baseSha: BASE,
    texts: { seed: 'Issue #1: Dark mode\n\nPlease add a dark look.', build_note: 'Add a dark look.' },
    extra: { firstVersion: false, model: GLM, specModel: OPUS },
  });
  const proposalSession = async (status) => (await pool.query(
    'INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, $3) RETURNING id', [app.id, botUser.id, status],
  )).rows[0].id;

  let laterCurrent;
  let laterGlm;
  await t.test('a database from before scopes takes the scope and the per-scope index, then the later seed, once', async () => {
    // Production before this change: no scope, the single one-current index,
    // and the first versions' current version.
    await pool.query('DROP INDEX idx_bot_config_versions_one_current_per_scope');
    await pool.query('ALTER TABLE bot_config_versions DROP COLUMN scope');
    await pool.query("CREATE UNIQUE INDEX idx_bot_config_versions_one_current ON bot_config_versions ((TRUE)) WHERE role = 'current'");
    const [first] = configs.SEED;
    await pool.query(
      `INSERT INTO bot_config_versions (key, label, version, recipe, role, seed_key)
       VALUES ($1, $2, 1, $3::jsonb, 'current', $4)`,
      [first.key, first.label, JSON.stringify(first.recipe), first.seedKey],
    );
    await pool.query(schema); // the deploy's boot
    await pool.query(schema); // and the next: idempotent
    const { rows: idx } = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'bot_config_versions' AND indexname LIKE 'idx_bot_config_versions_one_current%'",
    );
    assert.deepEqual(idx.map((r) => r.indexname), ['idx_bot_config_versions_one_current_per_scope']);
    const { rows: [old] } = await pool.query('SELECT scope FROM bot_config_versions WHERE seed_key = $1', [first.seedKey]);
    assert.equal(old.scope, 'first_version', 'every row before scopes is a first version\'s');

    assert.equal(await configs.seedConfigs(pool), 4, 'the first versions\' two sides and the later changes\' two');
    assert.equal(await configs.seedConfigs(pool), 0, 'once');
    const later = await configs.listVersions(pool, 'later');
    assert.deepEqual(later.map((v) => [v.key, v.label, v.role, v.scope]), [
      ['later-opus-spec', 'Opus spec + GLM build', 'current', 'later'], ['later-all-glm', 'All GLM', 'side', 'later'],
    ], 'the current one first');
    [laterCurrent, laterGlm] = later;
    assert.deepEqual(laterCurrent.recipe, { models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: null, pack: null });
    assert.deepEqual(laterGlm.recipe.models, { triage: GLM, spec: GLM, build: GLM });
    assert.ok((await configs.listVersions(pool)).every((v) => v.scope === 'first_version'), 'a scope left out is the first versions\'');
    assert.equal((await configs.currentVersion(pool)).key, first.key, 'the first versions\' current is untouched');
    assert.equal((await configs.currentVersion(pool, 'later')).id, laterCurrent.id);
    assert.equal((await configs.laterVersion(pool)).id, laterCurrent.id, 'merging this turns it on');
    // One current per scope, enforced by the schema.
    await assert.rejects(pool.query(
      "INSERT INTO bot_config_versions (key, label, version, recipe, role, scope) VALUES ('x', 'x', 1, '{}'::jsonb, 'current', 'later')",
    ), /idx_bot_config_versions_one_current_per_scope/);
    await assert.rejects(pool.query(
      "INSERT INTO bot_config_versions (key, label, version, recipe, role, scope) VALUES ('y', 'y', 1, '{}'::jsonb, 'side', 'everything')",
    ), /bot_config_versions_scope_check/);
    // A retired seed stays retired.
    await configs.setRole(pool, { id: laterGlm.id, role: 'retired', scope: 'later' });
    assert.equal(await configs.seedConfigs(pool), 0);
    await configs.setRole(pool, { id: laterGlm.id, role: 'side', scope: 'later' });
  });

  await t.test('roles move within a scope; a key is one scope\'s; a later recipe has no reviewer', async () => {
    const recipe = { models: { triage: GLM, spec: GLM, build: GLM }, reviewer: null, pack: null };
    const reviewed = await configs.saveVersion(pool, { label: 'Reviewed', recipe: { ...recipe, reviewer: { model: OPUS, maxRounds: 1, budgetMinutes: 10 } }, role: 'side', scope: 'later' });
    assert.equal(reviewed.status, 400);
    assert.match(reviewed.error, /review loop is for first versions/);
    assert.equal((await configs.saveVersion(pool, { label: 'x', recipe, role: 'side', scope: 'everything' })).status, 400);
    const mismatch = await configs.saveVersion(pool, { key: 'later-all-glm', recipe, role: 'side' });
    assert.deepEqual([mismatch.status, mismatch.code], [409, 'scope_mismatch'], 'a later key is not saved as a first version\'s');
    // A later current, saved: only the later current moves.
    const firstCurrent = await configs.currentVersion(pool);
    const saved = await configs.saveVersion(pool, { key: 'later-glm-spec', label: 'GLM spec', recipe, role: 'current', scope: 'later', actorId: evan.id });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.version.scope, 'later');
    assert.deepEqual(saved.demoted, [{ id: laterCurrent.id, role: 'side' }]);
    assert.equal((await configs.currentVersion(pool)).id, firstCurrent.id, 'the first versions\' current did not move');
    const { rows: currents } = await pool.query("SELECT scope FROM bot_config_versions WHERE role = 'current' ORDER BY scope");
    assert.deepEqual(currents.map((r) => r.scope), ['first_version', 'later']);
    // setRole names the version's own scope: today's callers (no scope) cannot move a later one by mistake.
    const wrong = await configs.setRole(pool, { id: laterCurrent.id, role: 'current' });
    assert.deepEqual([wrong.status, wrong.code], [409, 'scope_mismatch']);
    assert.match(wrong.error, /pass scope "later"/);
    const back = await configs.setRole(pool, { id: laterCurrent.id, role: 'current', scope: 'later' });
    assert.deepEqual(back.demoted, [{ id: saved.version.id, role: 'side' }]);
    await configs.setRole(pool, { id: saved.version.id, role: 'retired', scope: 'later' });
    assert.equal((await configs.setRole(pool, { id: firstCurrent.id, role: 'retired' })).code, 'current_required', 'the first versions\' as before');
  });

  let runId;
  let trialId;
  await t.test('a later change\'s side builds: a build-stage trial on its own run kind, replaying the snapshot', async () => {
    runId = await runRow({ issue: 1, proposal: await proposalSession('merged') });
    await pool.query('UPDATE homeroom_bot_runs SET bot_config_version_id = $2 WHERE id = $1', [runId, laterCurrent.id]);
    const snapshotId = await snapshotFor(runId);
    const lane = { woke: 0, wake() { this.woke += 1; } };
    const out = await configs.spawnSideBuilds(pool, {}, {
      botRunId: runId, app, snapshotId, current: laterCurrent, scope: 'later', deps: { lane },
    });
    assert.deepEqual({ derived: out.derived, trials: out.trials, skipped: out.skipped }, { derived: 0, trials: 1, skipped: 0 });
    assert.equal(lane.woke, 1);
    const { rows: [trial] } = await pool.query(
      `SELECT tr.id, tr.model, tr.status, tr.bot_run_id, tr.bot_config_version_id, r.kind, r.stages, r.cap_usd::float8 AS cap,
              t.stage, t.source_run_id, t.snapshot_id, t.tags, s.name AS suite
         FROM bench_trials tr JOIN bench_runs r ON r.id = tr.run_id JOIN bench_tasks t ON t.id = tr.task_id
         JOIN bench_suites s ON s.id = t.suite_id WHERE tr.bot_run_id = $1`,
      [runId],
    );
    trialId = trial.id;
    assert.deepEqual(
      [trial.model, trial.status, trial.bot_config_version_id, trial.kind, trial.stages, trial.stage, trial.source_run_id, trial.snapshot_id, trial.suite, trial.tags.scope],
      [`config:${laterGlm.id}`, 'pending', laterGlm.id, 'bot_config_later', ['build'], 'build', runId, snapshotId, 'Bot configurations', 'later'],
    );
    assert.ok(trial.cap > 0 && trial.cap <= 50, 'its run\'s cap is inside the later week\'s budget');
    // The lane reads it as the side version's recipe, a side build.
    const lanes = require('../src/services/bench/lane');
    const row = await lanes.loadTrialContext(pool, trial.id);
    assert.equal(row.run_kind, 'bot_config_later');
    const ctx = await lanes.studioContext(pool, {}, row, await require('../src/services/homeroom-bot').readSettings(pool));
    assert.deepEqual(ctx.stageModels, { triage: GLM, spec: GLM, build: GLM });
    assert.deepEqual(ctx.sideBuild, { botRunId: runId, versionId: laterGlm.id });
    // Nothing twice; and the first versions' week is its own.
    const again = await configs.spawnSideBuilds(pool, {}, { botRunId: runId, app, snapshotId, current: laterCurrent, scope: 'later', deps: { lane } });
    assert.equal(again.trials, 0);
    const later = await configs.sideBudget(pool, 'later');
    assert.equal(later.limitUsd, 50);
    assert.ok(later.pendingUsd > 0, 'its trial is reserved against the later week');
    const first = await configs.sideBudget(pool);
    assert.deepEqual([first.limitUsd, first.pendingUsd], [25, 0], 'and not against the first versions\'');
  });

  await t.test('the later week: spent, a side build is skipped and says it pauses; the platform\'s repository says why', async () => {
    assert.equal((await configs.setSideWeeklyBudget(pool, { scope: 'later', weeklyUsd: -1 })).status, 400);
    assert.equal((await configs.setSideWeeklyBudget(pool, { scope: 'later', weeklyUsd: 'lots' })).status, 400);
    const set = await configs.setSideWeeklyBudget(pool, { scope: 'later', weeklyUsd: 0, actorId: evan.id });
    assert.equal(set.ok, true);
    assert.equal(set.sideBuilds.limitUsd, 0);
    assert.equal(await configs.sideWeeklyCents(pool), 2500, 'the first versions\' is its own setting');
    const other = await runRow({ issue: 2 });
    const out = await configs.spawnSideBuilds(pool, {}, {
      botRunId: other, app, snapshotId: await snapshotFor(other), current: laterCurrent, scope: 'later', deps: { lane: { wake() {} } },
    });
    assert.deepEqual({ trials: out.trials, skipped: out.skipped }, { trials: 0, skipped: 1 });
    const { rows: [r] } = await pool.query('SELECT status, error FROM bot_config_results WHERE bot_run_id = $1', [other]);
    assert.equal(r.status, 'skipped');
    assert.match(r.error, /later changes' side builds' weekly budget \(\$0\.00\) is spent: they pause until the last seven days' spend is back under it/);
    const stats = await configs.listWithStats(pool, { scope: 'later' });
    assert.equal(stats.sideBuilds.paused, true);
    assert.equal(stats.sideBuilds.skipped, 1);
    assert.equal((await configs.listWithStats(pool)).sideBuilds.skipped, 0, 'counted in its own scope');
    await configs.setSideWeeklyBudget(pool, { scope: 'later', weeklyUsd: 50 });

    const platform = await runRow({ issue: 3 });
    const skipped = await configs.spawnSideBuilds(pool, {}, {
      botRunId: platform, app, snapshotId: await snapshotFor(platform), current: laterCurrent, scope: 'later',
      skipReason: "the platform's own repository is left out of side builds (homeroom_bot_shadow_build_platform is off)",
      deps: { lane: { wake() { throw new Error('nothing is queued'); } } },
    });
    assert.deepEqual({ trials: skipped.trials, skipped: skipped.skipped }, { trials: 0, skipped: 1 });
    const { rows: [p] } = await pool.query('SELECT status, error FROM bot_config_results WHERE bot_run_id = $1', [platform]);
    assert.deepEqual([p.status, p.error], ['skipped', "the platform's own repository is left out of side builds (homeroom_bot_shadow_build_platform is off)"]);
  });

  await t.test('a later build and its side trial become a pair with no screenshots needed; the pair shows specs and diffs, blind', async () => {
    const built = {
      ok: true, sha: 'c'.repeat(40), commits: 2, costUsd: 1.2,
      stageCosts: { spec: { usd: 0.8, model: OPUS }, build: { usd: 0.4, model: GLM } },
    };
    assert.equal(await configs.finishLive(pool, { botRunId: runId, version: laterCurrent, built, activeMs: 900_000 }), true);
    const { rows: [live] } = await pool.query(
      "SELECT status, built, booted, capture, cost_usd::float8 AS cost, active_ms::float8 AS ms, cost_parts FROM bot_config_results WHERE bot_run_id = $1 AND source = 'live'",
      [runId],
    );
    assert.deepEqual([live.status, live.built, live.booted, live.capture], ['done', true, null, null], 'boot unknown: no capture step');
    assert.ok(Math.abs(live.cost - 1.23) < 1e-9, 'the build and the shared triage');
    assert.equal(live.ms, 900_000 + 60_000);
    assert.deepEqual(live.cost_parts.stages.map((x) => [x.stage, x.model, x.usd]), [['triage', GLM, 0.03], ['spec', OPUS, 0.8], ['build', GLM, 0.4]]);

    await pool.query(
      `UPDATE bench_trials SET status = 'ok', cost_usd = 0.3, duration_ms = 700000, build_sha = $2, build_commits = 1, base_sha = $3,
              build_branch = 'bench/r1-t1',
              parsed = '{"built":true,"spec":"# Dark mode\\n\\nThe side spec.","costParts":{"spec":{"usd":0.1,"model":"z-ai/glm-5.3-flash"},"build":{"usd":0.2,"model":"z-ai/glm-5.3-flash"}}}'::jsonb,
              changed_files = '{"files":[{"filename":"a.js","additions":5,"deletions":2},{"filename":"b.css","additions":1,"deletions":0}]}'::jsonb
        WHERE id = $1`,
      [trialId, 'd'.repeat(40), BASE],
    );
    assert.equal(await configs.finishSideTrial(pool, trialId), true);
    const { rows: pairs } = await pool.query('SELECT status, excluded_reason FROM bot_config_pairs WHERE bot_run_id = $1', [runId]);
    assert.deepEqual(pairs.map((p) => [p.status, p.excluded_reason]), [['waiting', null]], 'offered with no screenshots on either side');
    assert.equal((await configs.nextPair(pool)).pair, null, 'not among the first versions\' pairs');

    // The pair, blind: each side's own spec and its diff from the same base.
    const asked = [];
    const github = {
      async compareFiles(owner, repo, basehead) {
        asked.push([owner, repo, basehead]);
        if (basehead.endsWith('d'.repeat(40))) throw new Error('Not Found: the branch is gone');
        return { files: [{ filename: 'a.js', additions: 9, deletions: 3 }] };
      },
    };
    const next = await configs.nextPair(pool, { scope: 'later', github });
    assert.equal(next.scope, 'later');
    assert.equal(next.waiting, 1);
    const p = next.pair;
    assert.match(p.brief, /Please add a dark look/);
    assert.equal(p.plan, 'Add a dark look.');
    const { rows: [{ left_is_current: leftIsCurrent }] } = await pool.query('SELECT left_is_current FROM bot_config_pairs WHERE token = $1', [p.pairId]);
    const [cur, side] = leftIsCurrent ? [p.left, p.right] : [p.right, p.left];
    assert.match(cur.spec, /The live spec\./);
    assert.match(side.spec, /The side spec\./);
    assert.deepEqual(cur.diff, { files: 1, insertions: 9, deletions: 3, compareUrl: `${app.repo_url}/compare/${BASE}...${'c'.repeat(40)}` });
    assert.deepEqual(side.diff, { files: 2, insertions: 6, deletions: 2, compareUrl: `${app.repo_url}/compare/${BASE}...${'d'.repeat(40)}` }, 'its stored files when GitHub has none');
    assert.deepEqual(asked.map((a) => a[2]), [`${BASE}...${'c'.repeat(40)}`, `${BASE}...${'d'.repeat(40)}`]);
    assert.deepEqual([cur.booted, side.booted, cur.screenshots, side.screenshots], [null, null, [], []]);
    assert.deepEqual(Object.keys(p.left).sort(), Object.keys(p.right).sort(), 'both sides have the same shape');
    assert.ok(!/later-opus|later-all-glm|config|recipe|cost|bench\//i.test(JSON.stringify(p)), 'nothing names a configuration or a side build');
    // A diff either side cannot have is left off both.
    const blind = await configs.nextPair(pool, { scope: 'later', github: { async compareFiles() { throw new Error('down'); } } });
    const sides = [blind.pair.left, blind.pair.right];
    assert.ok(sides.some((x) => x.spec) && sides.every((x) => x.diff === null), 'the live side has no stored files: neither shows a diff');

    // A pick names its scope.
    const wrong = await configs.submitPick(pool, { pairId: p.pairId, pick: 'left', userId: evan.id });
    assert.deepEqual([wrong.status, wrong.code], [409, 'scope_mismatch']);
    const sidePick = leftIsCurrent ? 'right' : 'left';
    assert.deepEqual(await configs.submitPick(pool, { pairId: p.pairId, pick: sidePick, userId: evan.id, scope: 'later' }), { ok: true, waiting: 0 });
  });

  await t.test('the numbers per scope: build rate, cost by stage, time, the live proposals\' outcomes, and the win rate', async () => {
    // Two more later changes: one whose proposal is still open, and a shadow
    // build (no proposal to count) whose side build did not build.
    const open = await runRow({ issue: 4, proposal: await proposalSession('promoted') });
    const shadow = await runRow({ issue: 5, mode: 'shadow' });
    for (const [id, sideBuilt] of [[open, true], [shadow, false]]) {
      // eslint-disable-next-line no-await-in-loop
      await configs.recordResult(pool, { botRunId: id, configVersionId: laterCurrent.id, source: 'live', built: true, costUsd: 1.0, activeMs: 600_000, sha: `live${id}` });
      // eslint-disable-next-line no-await-in-loop
      await configs.recordResult(pool, { botRunId: id, configVersionId: laterGlm.id, source: 'trial', built: sideBuilt, costUsd: 0.4, activeMs: 500_000, sha: sideBuilt ? `side${id}` : null });
      // eslint-disable-next-line no-await-in-loop
      await configs.settlePairs(pool, id);
    }
    const { rows: [shadowPair] } = await pool.query('SELECT status, excluded_reason FROM bot_config_pairs WHERE bot_run_id = $1', [shadow]);
    assert.deepEqual([shadowPair.status, shadowPair.excluded_reason], ['excluded', 'didn\'t build (the side configuration)']);
    await pool.query("UPDATE bot_config_pairs SET status = 'picked', pick = 'current' WHERE bot_run_id = $1", [open]);

    const out = await configs.listWithStats(pool, { scope: 'later' });
    assert.deepEqual([out.scope, out.label, out.currentId], ['later', 'Later changes', laterCurrent.id]);
    assert.ok(out.versions.every((v) => v.scope === 'later'));
    assert.equal(out.versions[0].id, laterCurrent.id, 'the current one first');
    const cur = out.versions[0].stats;
    assert.deepEqual([cur.builds, cur.built, cur.buildRate], [3, 3, 1]);
    assert.ok(Math.abs(cur.avgCostUsd - (1.23 + 1.0 + 1.0) / 3) < 1e-9);
    assert.equal(cur.avgCostByStage.n, 1);
    assert.deepEqual(cur.avgCostByStage.stages.spec, { usd: 0.8, models: [OPUS] });
    assert.equal(cur.medianActiveMs, 600_000);
    assert.equal(cur.bootRate, null, 'no capture, so no boot rate');
    assert.deepEqual(cur.proposals, { merged: 1, closed: 0, open: 1, none: 0 }, 'the live builds\' proposals; the shadow build proposes nothing');
    const side = out.versions.find((v) => v.id === laterGlm.id).stats;
    assert.deepEqual([side.builds, side.built], [3, 2]);
    assert.ok(Math.abs(side.buildRate - 2 / 3) < 1e-9);
    // One build failed and the two that built have no capture: nothing was
    // measured booting, so no boot rate. Counting the failed build as "didn't
    // boot" once showed 0% for configurations whose builds all booted.
    assert.equal(side.bootRate, null, 'a failed build is not a boot that failed, and an unmeasured one is unknown');
    assert.equal(side.proposals, undefined, 'only the current version\'s builds are proposed');
    assert.deepEqual([side.vsCurrent.wins, side.vsCurrent.losses, side.vsCurrent.n, side.vsCurrent.didntBuild], [1, 1, 2, 1], 'one pick each way, one left out');
    assert.ok(side.vsCurrent.low >= 0 && side.vsCurrent.high <= 1);
    assert.equal(out.pairsWaiting, 0);

    // The first versions' numbers are their own.
    const first = await configs.listWithStats(pool);
    assert.equal(first.scope, 'first_version');
    assert.ok(first.versions.every((v) => v.scope === 'first_version' && v.stats.builds === 0));
    assert.equal((await configs.listWithStats(pool, { scope: 'nope' })).status, 400);

    // The connector's list: both scopes, labelled, each current first.
    const all = await configs.listAllScopes(pool);
    assert.deepEqual(all.scopes.map((s) => [s.scope, s.label, s.versions[0].role]), [
      ['first_version', 'First versions', 'current'], ['later', 'Later changes', 'current'],
    ]);
  });

  await t.test('a later build given up stops its side builds, in its own words', async () => {
    const id = await runRow({ issue: 6 });
    await pool.query('UPDATE homeroom_bot_runs SET bot_config_version_id = $2 WHERE id = $1', [id, laterCurrent.id]);
    await configs.spawnSideBuilds(pool, {}, { botRunId: id, app, snapshotId: await snapshotFor(id), current: laterCurrent, scope: 'later', deps: { lane: { wake() {} } } });
    const stopped = await configs.abandonSideBuilds(pool, id, 'not needed any more', { lane: { cancelTrial() {} } });
    assert.equal(stopped, 1);
    const { rows: [tr] } = await pool.query('SELECT status, error FROM bench_trials WHERE bot_run_id = $1', [id]);
    assert.equal(tr.status, 'cancelled');
    assert.equal(tr.error, 'the build they are compared with was not needed any more');
  });
});
