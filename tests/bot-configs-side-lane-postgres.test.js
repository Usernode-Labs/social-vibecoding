'use strict';

// The Homeroom bot configurations' side builds on the App bench lane
// (src/services/bench/lane.js, src/services/bot-configs.js), against the
// FULL PostgreSQL schema, as they stood on 9 Oct 2026 and since:
//
//   - a side build its run's cap stops is finished, its result skipped with
//     why ("capped: ..."), and counted; before, capRun left it pending for
//     good, never paired and never counted (9 of the last 50);
//   - one already left that way, or cancelled by an admin, is settled by
//     the bench-sweep clock; one still running is left to its own finisher;
//   - a side build's branch is kept while its pair waits for a pick (up to
//     BRANCH_KEEP_WAITING_DAYS), and goes at seven days once it does not;
//   - the pairs waiting per scope, which the Homeroom bot console's Overview
//     shows.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { asTransition } = require('./lib/as-transition');

const lane = require('../src/services/bench/lane');
const runner = require('../src/services/bench/runner');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const benchLaneMod = require('../src/workflow/bench-lane/machine.ts');
const { benchLaneServices } = require('../src/workflow/bench-lane/services.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const OPUS = 'anthropic/claude-opus-5.5';
const GLM = 'z-ai/glm-5.3-flash';
const BASE = 'a'.repeat(40);

test('side builds on the App bench lane against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bot_configs_side_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const realRunStage = runner.runStage;
  const realGate = lane.allowanceGate;
  let rt = null;
  t.after(async () => {
    runner.runStage = realRunStage;
    lane.allowanceGate = realGate;
    if (rt) await rt.stop();
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
  await configs.seedConfigs(pool);
  const laterCurrent = await configs.currentVersion(pool, 'later');
  const [laterGlm] = await configs.sideVersions(pool, 'later');

  const { rows: [user] } = await pool.query(
    "INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bench', 'x', TRUE) RETURNING id, username",
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/usernode-bot/todo')
     RETURNING id, slug, name, repo_url`,
  );

  runner.runStage = async () => ({ status: 'ok', cost_usd: 0.1, parsed: { built: true }, duration_ms: 5 });
  const deleted = [];
  const deps = {
    user,
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    github: { isEnabled: () => true, async deleteBenchBranch(_o, _r, branch) { deleted.push(branch); } },
    worker: { async stopTurn() {} },
    afterTrial: async () => {},
  };

  // The lane's machine, run here (its grants' builds are not: nothing in
  // this suite runs a trial).
  lane.allowanceGate = async () => ({ ok: true, reason: null });
  rt = createRuntime({ pool, machines: [benchLaneMod.benchLane()], services: benchLaneServices({ config: {}, pool }), pollMs: 50 });
  let rk = 0;
  const laneLook = async () => {
    await rt.append(benchLaneMod.MACHINE, benchLaneMod.KEY, { type: 'Look', payload: {} }, { requestKey: `look-${++rk}`, source: { kind: 'system', name: 'test' } });
    for (let i = 0; i < 6; i += 1) { await rt.drain(); if (!(await rt.runServices())) break; }
    await rt.drain();
  };
  const laneCancel = async (trialId) => {
    const id = await rt.append(benchLaneMod.MACHINE, benchLaneMod.KEY, { type: 'TrialCancelled', payload: { trialId } },
      { requestKey: `cancel-${++rk}`, source: { kind: 'admin', name: 'test' } });
    await rt.drain();
    const { rows: [e] } = await pool.query('SELECT result, reason, reply FROM wf_events WHERE id = $1', [id]);
    return { status: e.result, reason: e.reason, reply: e.reply };
  };

  // A later change, built live by the current configuration, with its side
  // build queued on the lane at $0.40, its run capped at three times that.
  let issue = 0;
  const sideBuild = async () => {
    issue += 1;
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, cost_usd, duration_ms, model, bot_config_version_id)
       VALUES ($1, $2, 'live', 'ready', 'Add a dark look.', 0.03, 60000, $3, $4) RETURNING id`,
      [app.id, issue, GLM, laterCurrent.id],
    );
    const snapshotId = await snapshots.recordSnapshot(pool, {
      runId: run.id, stage: 'build', appId: app.id, issueNumber: issue, baseSha: BASE,
      texts: { seed: `Issue #${issue}: Dark mode`, build_note: 'Add a dark look.' },
      extra: { firstVersion: false, model: GLM, specModel: OPUS },
    });
    const out = await configs.spawnSideBuilds(pool, {}, {
      botRunId: run.id, app, snapshotId, current: laterCurrent, scope: 'later', deps: { lane: { look() {} } },
    });
    assert.equal(out.trials, 1);
    const { rows: [trial] } = await pool.query('SELECT id, run_id FROM bench_trials WHERE bot_run_id = $1', [run.id]);
    await pool.query('UPDATE bench_trials SET est_cost_usd = 0.4 WHERE id = $1', [trial.id]);
    await pool.query('UPDATE bench_runs SET cap_usd = 1.2 WHERE id = $1', [trial.run_id]);
    return { botRunId: run.id, trialId: trial.id, benchRunId: trial.run_id };
  };
  const resultOf = async (botRunId) => (await pool.query(
    "SELECT status, error, trial_id FROM bot_config_results WHERE bot_run_id = $1 AND source = 'trial'", [botRunId],
  )).rows[0];
  const trialOf = async (id) => (await pool.query('SELECT status, error FROM bench_trials WHERE id = $1', [id])).rows[0];
  // A restart put the trial back in the queue (lane.js releaseTrial): what
  // its interrupted attempt spent is charged to its run, and kept on it.
  const putBack = (s) => pool.query(
    'UPDATE bench_trials SET claims = 1, prior_ms = 600000, interrupted_cost_usd = 1.0 WHERE id = $1', [s.trialId],
  ).then(() => pool.query('UPDATE bench_runs SET spent_usd = 1.0 WHERE id = $1', [s.benchRunId]));

  await t.test('a side build its run\'s cap stops is finished skipped, with why, and counted', async () => {
    const s = await sideBuild();
    // Its run had spent $1.00 of its $1.20: the $0.40 it needs does not fit.
    await putBack(s);
    await laneLook();
    assert.equal((await trialOf(s.trialId)).status, 'skipped_cap');
    const r = await resultOf(s.botRunId);
    assert.equal(r.status, 'skipped', 'not left pending for good');
    assert.equal(r.error, 'capped: its run had spent $1.00 of its $1.20 cap');
    const stats = await configs.listWithStats(pool, { scope: 'later' });
    assert.equal(stats.sideBuilds.skipped, 1, 'counted with the side builds that never ran');
    const { rows: pairs } = await pool.query('SELECT 1 FROM bot_config_pairs WHERE bot_run_id = $1', [s.botRunId]);
    assert.equal(pairs.length, 0, 'never offered');
  });

  await t.test('one left pending before, or cancelled by an admin, is settled by the sweep; one running is left alone', async () => {
    // As capRun left them before: the trial skipped, its result pending.
    const before = await sideBuild();
    await pool.query("UPDATE bench_trials SET status = 'skipped_cap', finished_at = NOW() WHERE id = $1", [before.trialId]);
    await pool.query("UPDATE bench_runs SET status = 'capped', spent_usd = 1.15 WHERE id = $1", [before.benchRunId]);
    const cancelled = await sideBuild();
    const out = await lane.cancelTrial(pool, cancelled.trialId, { platform: { benchCancelTrial: (id) => laneCancel(id) } });
    assert.deepEqual(out, { ok: true, status: 'cancelled' });
    const held = await sideBuild();
    await asTransition(pool, "UPDATE bench_trials SET status = 'running', started_at = NOW() WHERE id = $1", [held.trialId]);
    assert.equal((await resultOf(before.botRunId)).status, 'pending');

    assert.equal(await lane.settleSideResults(pool), 2);
    assert.deepEqual(Object.values(await resultOf(before.botRunId)).slice(0, 2), ['skipped', 'capped: its run had spent $1.15 of its $1.20 cap']);
    assert.deepEqual(Object.values(await resultOf(cancelled.botRunId)).slice(0, 2), ['skipped', 'cancelled by an admin']);
    assert.equal((await resultOf(held.botRunId)).status, 'pending', 'its own finisher records it');
    await pool.query("UPDATE bench_trials SET status = 'cancelled', finished_at = NOW() WHERE id = $1", [held.trialId]);
    assert.equal(await lane.settleSideResults(pool), 1, 'once it has ended');
    assert.equal(await lane.settleSideResults(pool), 0, 'once');
    // The bench-sweep clock's run settles them.
    const later = await sideBuild();
    await pool.query("UPDATE bench_trials SET status = 'skipped_cap', finished_at = NOW() WHERE id = $1", [later.trialId]);
    await pool.query("UPDATE bench_runs SET status = 'capped' WHERE id = $1", [later.benchRunId]);
    await lane.sweep(pool, deps);
    assert.equal((await resultOf(later.botRunId)).status, 'skipped');
  });

  await t.test('a side build\'s branch is kept while its pair waits for a pick, and not for good', async () => {
    deleted.length = 0;
    const branchOf = (s) => `bench/r${s.benchRunId}-t${s.trialId}`;
    // Built, finished `days` ago, with its pair `pair` (or none).
    const finished = async (days, pair) => {
      const s = await sideBuild();
      await pool.query(
        `UPDATE bench_trials SET status = 'ok', build_branch = $2, build_commits = 1, build_sha = $3,
                finished_at = NOW() - make_interval(days => $4)
          WHERE id = $1`,
        [s.trialId, branchOf(s), 'd'.repeat(40), days],
      );
      await pool.query("UPDATE bench_runs SET status = 'done' WHERE id = $1", [s.benchRunId]);
      if (!pair) return s;
      const cur = await configs.recordResult(pool, {
        botRunId: s.botRunId, configVersionId: laterCurrent.id, source: 'live', built: true, sha: `live${s.botRunId}`,
      });
      const side = await configs.recordResult(pool, {
        botRunId: s.botRunId, configVersionId: laterGlm.id, source: 'trial', trialId: s.trialId, built: true, sha: 'd'.repeat(40),
      });
      await pool.query(
        `INSERT INTO bot_config_pairs (token, bot_run_id, current_result_id, side_result_id, left_is_current, status, pick)
         VALUES ($1, $2, $3, $4, TRUE, $5, $6)`,
        [crypto.randomBytes(12).toString('base64url'), s.botRunId, cur, side, pair, pair === 'picked' ? 'side' : null],
      );
      return s;
    };
    const waiting = await finished(8, 'waiting');
    const picked = await finished(8, 'picked');
    const alone = await finished(8, null);
    const young = await finished(2, null);
    const stale = await finished(lane.BRANCH_KEEP_WAITING_DAYS + 1, 'waiting');
    await lane.sweepBranches(pool, deps);
    assert.deepEqual(deleted.sort(), [branchOf(picked), branchOf(alone), branchOf(stale)].sort());
    const gone = async (s) => !!(await pool.query('SELECT branch_deleted_at FROM bench_trials WHERE id = $1', [s.trialId])).rows[0].branch_deleted_at;
    assert.equal(await gone(waiting), false, 'its pair waits: the compare link still opens');
    assert.equal(await gone(young), false);
    assert.equal(await gone(stale), true, 'not kept for good');
    // Picked, it goes on the next sweep.
    await pool.query("UPDATE bot_config_pairs SET status = 'picked', pick = 'tie' WHERE side_result_id = (SELECT id FROM bot_config_results WHERE trial_id = $1)", [waiting.trialId]);
    await lane.sweepBranches(pool, deps);
    assert.equal(await gone(waiting), true);
  });

  await t.test('the pairs waiting for a pick, per scope', async () => {
    assert.deepEqual(await configs.pairsWaitingByScope(pool), { first_version: 0, later: 1 }, 'the stale one still waits');
    await pool.query("UPDATE bot_config_pairs SET status = 'picked', pick = 'current' WHERE status = 'waiting'");
    assert.deepEqual(await configs.pairsWaitingByScope(pool), { first_version: 0, later: 0 });
    assert.equal(await configs.pairsWaitingByScope({ async query() { throw new Error('down'); } }), null);
  });
});
