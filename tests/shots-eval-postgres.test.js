'use strict';

// Before & after shots evals against the REAL schema in a throwaway
// PostgreSQL database (services/shots-eval.js, services/shots-eval-runner.js).
// Pinned here, end to end:
//   - configurations are immutable versions of a recipe;
//   - an eval shoots merged proposals only, frozen from their own published
//     run, the live agent as the control and each configuration beside it;
//   - a trial runs the real shots pipeline (shots-orchestrator.executeRun)
//     with the arm's model, prompts and budget, keeps its state and files on
//     its own rows and never touches the proposal's own shots, and its cost
//     counts against its eval's cap;
//   - two finished arms of one proposal make a blind pair, whose pick and
//     marks feed each arm's numbers;
//   - a trial a restart interrupted is queued again under a fresh attempt
//     id, once; the cap stops an eval; a cancel cancels; the GC knows trials.
// The builds, copies and the shots agent itself are fakes: everything
// between them and the database is the production code. Skipped when no
// server is reachable, and required when TEST_DATABASE_URL is set, the same
// contract as the other *-postgres suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client, Pool } = require('pg');

const planContract = require('../src/services/visible-changes');
const controlPlane = require('../src/services/shots-control');
const shotsAgent = require('../src/services/shots-agent');
const shotsGc = require('../src/services/shots-gc');
const evals = require('../src/services/shots-eval');
const runner = require('../src/services/shots-eval-runner');
const fixtures = require('./fixtures/shots');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const BASE = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);
const MERGED = 900310;
const OPEN = 900311;
const NO_RUN = 900312;
const NO_CHANGE = 900313;
const MERGED_TWO = 900314;
const PUBLISHED_RUN = 'e'.repeat(32);
const CONFIG = { shots: { execute: true, maxRunMs: 60_000, maxAgentMs: 30_000, agentModel: 'claude-sonnet-5-5' } };

async function freshDb(t) {
  const root = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await root.connect(); }
  catch (err) {
    await root.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`Local test database unavailable: ${err.code}`);
    return null;
  }
  const database = `shots_eval_${crypto.randomBytes(6).toString('hex')}`;
  await root.query(`CREATE DATABASE ${database}`);
  const url = new URL(DSN); url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString(), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  });
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);
  return pool;
}

function intentOf(ids) {
  return planContract.parseIntent(fixtures.intent({
    stories: ids.map((id) => ({ ...fixtures.intent().stories[0], id, claim: `The board shows ${id}.` })),
  }));
}

async function seed(pool) {
  await pool.query(`INSERT INTO users (username, password) VALUES ('eval-admin', 'x'), ('eval-author', 'x')`);
  await pool.query(
    `INSERT INTO apps (id, name, slug, status, view_visibility, created_by, repo_url)
     SELECT 900301, 'Eval demo', 'eval-demo', 'running', 'public', u.id, 'https://github.com/acme/eval-demo'
       FROM users u WHERE u.username = 'eval-author'`
  );
  const session = async (id, status) => pool.query(
    `INSERT INTO chat_sessions (id, app_id, user_id, branch_name, pr_number, pr_title, status, reviewed_head_sha)
     SELECT $1::int, 900301, u.id, 'eval/demo', $1::int - 900000, 'Eval demo change', $2::varchar, $3::varchar
       FROM users u WHERE u.username = 'eval-author'`,
    [id, status, HEAD]
  );
  const publish = async (id, runId, intent, { files = false } = {}) => {
    await pool.query(
      `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, plan_hash, intent, hard_verdict, state, trigger, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'verified', 'test', NOW(), NOW())`,
      [runId, id, BASE, HEAD, 'f'.repeat(64), JSON.stringify(intent),
        JSON.stringify({ passed: true, mode: 'shots', runs: 1, stories: intent.stories.map((s) => ({ id: s.id, status: 'ready', files: 2 })) })]
    );
    await pool.query(
      `UPDATE chat_sessions SET shots_run_id = $2, shots_state = 'verified', shots_detail = '{}'::jsonb WHERE id = $1`,
      [id, runId]
    );
    if (!files) return;
    for (const [side, shade] of [['base', 30], ['head', 220]]) {
      const data = fixtures.png({ shade });
      await pool.query(
        `INSERT INTO shot_artifacts (id, run_id, story_id, viewport, side, variant, media, content_type, data, width, height, bytes, sha256)
         VALUES ($1, $2, 'board-sort', 'desktop', $3, 'context', 'png', 'image/png', $4, 4, 3, $5, $6)`,
        [crypto.randomBytes(16).toString('hex'), runId, side, data, data.length, crypto.createHash('sha256').update(data).digest('hex')]
      );
    }
  };
  await session(MERGED, 'merged');
  await publish(MERGED, PUBLISHED_RUN, intentOf(['board-sort']), { files: true });
  await session(MERGED_TWO, 'merged');
  await publish(MERGED_TWO, 'a'.repeat(32), intentOf(['board-sort', 'board-filter']));
  await session(OPEN, 'active');
  await publish(OPEN, 'b'.repeat(32), intentOf(['board-sort']));
  await session(NO_RUN, 'merged');
  await session(NO_CHANGE, 'merged');
  await pool.query(
    `INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state, trigger, completed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'not_required', 'test', NOW())`,
    ['9'.repeat(32), NO_CHANGE, BASE, HEAD, JSON.stringify({ version: 1, impact: 'none', rationale: 'Server only.', stories: [] })]
  );
  await pool.query(`UPDATE chat_sessions SET shots_run_id = $2 WHERE id = $1`, [NO_CHANGE, '9'.repeat(32)]);
  const { rows: [admin] } = await pool.query(`SELECT id FROM users WHERE username = 'eval-admin'`);
  return admin.id;
}

// The pipeline's outside world, faked: two builds that are temp dirs, their
// copies, signed-in personas, and a shots agent that saves a before and an
// after of every declared change through the real control plane.
function pipelineDeps({ dispatched, costUsd = 0.5 } = {}) {
  const checkouts = { base: fs.mkdtempSync(path.join(os.tmpdir(), 'eval-base-')), head: fs.mkdtempSync(path.join(os.tmpdir(), 'eval-head-')) };
  const provenance = { fixtureFingerprint: 'fixture-1', baseImageDigest: 'sha256:base', headImageDigest: 'sha256:head' };
  return {
    github: {
      compareRefs: async () => ({ files: ['frontend/src/board.tsx'], filesComplete: true }),
      getProposalDiff: async () => ({ diff: 'diff --git', fileCount: 1, truncated: false }),
    },
    shotsAgent: {
      ...shotsAgent,
      dispatch: async (cfg, options) => {
        dispatched.push({
          model: shotsAgent.agentModel(cfg), budgetMs: cfg.shots.maxAgentMs, timeoutMs: options.timeoutMs,
          systemPrompt: options.systemPrompt, taskPrompt: options.taskPrompt, runId: options.runId,
        });
        // The agent's calls, through the trial's workspace in Postgres.
        const intent = (await controlPlane.read(options.pool, options.runId)).intent;
        for (const story of intent.stories) {
          for (const viewport of story.viewports) {
            for (const [side, shade] of [['before', 10], ['after', 200]]) {
              await controlPlane.withControl(options.pool, { runId: options.runId, sessionId: options.session.id },
                (control) => control.saveShot({ change: story.id, screen: viewport.name, side, kind: 'screen' }, fixtures.png({ shade })));
            }
          }
        }
        return { backend: 'claude_code', model: shotsAgent.agentModel(cfg), result: { costUsd } };
      },
    },
    injected: {
      environment: {
        preparePair: async (_config, { run }) => ({
          runId: run.id, fixtureFingerprint: provenance.fixtureFingerprint,
          sides: { base: { imageDigest: provenance.baseImageDigest, checkout: checkouts.base },
            head: { imageDigest: provenance.headImageDigest, checkout: checkouts.head } },
        }),
        resetPair: async () => ({ origins: { base: 'http://base.internal:3000', head: 'http://head.internal:3000' }, baseSha: BASE, headSha: HEAD, ...provenance }),
      },
      // The copies are fakes: nothing to remove.
      removeCopies: async () => [],
      identities: {
        mintShotsAuthTokens: async () => ({ member: 'm', read_only_admin: 'a', full_admin: 'f' }),
        shotsGuestIdentity: async () => ({ kind: 'private', token: null }),
      },
      shotsStarter: { beforeIsStarter: async () => false },
      worker: {
        isInFlight: () => false, getActiveTurnMode: () => null, stopTurn: async () => {},
        clearPendingStop: () => {}, destroyCcVolume: async () => {},
      },
      waitForSessionIdle: async () => ({ outcome: 'idle' }),
      shotsDiff: { screensFor: async () => [], unchangedStories: () => [] },
    },
  };
}

async function settleInFlight() {
  for (const entry of [...runner._inFlight.values()]) await entry.promise;
}

test('shots evals, end to end (PostgreSQL)', { timeout: 180_000 }, async (t) => {
  const pool = await freshDb(t);
  if (!pool) return;
  runner._resetForTests();
  t.after(() => runner._resetForTests());
  const adminId = await seed(pool);
  let configId;
  let evalId;

  await t.test('a configuration is saved as versions of a key, and lists its prompts only when asked', async () => {
    const first = await evals.saveConfig(pool, { label: 'Toast first', recipe: { guidance: 'Close any toast before you shoot.', agentMinutes: 6 }, actorId: adminId });
    assert.equal(first.ok, true);
    assert.equal(first.config.key, 'toast-first');
    assert.equal(first.config.version, 1);
    const second = await evals.saveConfig(pool, { key: 'toast-first', recipe: { guidance: 'Close any toast, then wait a second.', model: 'claude-opus-5-5' } });
    assert.equal(second.config.version, 2);
    assert.equal(second.config.label, 'Toast first', 'a version keeps its key\'s label');
    configId = second.config.id;
    assert.equal((await evals.saveConfig(pool, { label: 'x', recipe: {} })).status, 400);
    const listed = await evals.listConfigs(pool, CONFIG);
    assert.deepEqual(listed.configs.map((c) => c.version), [2, 1]);
    assert.equal(typeof listed.configs[0].recipe.guidance, 'object', 'a prompt is a hash and length');
    assert.equal(listed.live.model, 'claude-sonnet-5-5');
    const withText = await evals.listConfigs(pool, CONFIG, { prompts: true });
    assert.equal(withText.configs[0].recipe.guidance, 'Close any toast, then wait a second.');
    assert.equal(withText.live.systemPrompt, shotsAgent.SYSTEM_PROMPT);
  });

  await t.test('an eval shoots merged proposals only, frozen from their own published run', async () => {
    const refused = await evals.launch(pool, CONFIG, { sessionIds: [MERGED, OPEN, NO_RUN, NO_CHANGE], configIds: [configId], capUsd: 20 });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.refused.map((r) => r.sessionId), [OPEN, NO_RUN, NO_CHANGE]);
    assert.match(refused.error, /Nothing was launched/);
    assert.equal((await evals.launch(pool, CONFIG, { sessionIds: [MERGED], configIds: [99999], capUsd: 20 })).status, 404);
    assert.equal((await evals.launch(pool, CONFIG, { sessionIds: [MERGED], capUsd: 1 })).status, 400, 'a cap under one trial\'s estimate');
    const { rows: [{ n: before }] } = await pool.query('SELECT COUNT(*)::int AS n FROM shots_eval_runs');
    assert.equal(before, 0, 'a refused launch writes nothing');

    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED], configIds: [configId], capUsd: 20, label: 'Toast', actorId: adminId });
    assert.equal(launched.ok, true);
    evalId = launched.eval.id;
    assert.equal(launched.eval.trials, 2);
    assert.deepEqual(launched.eval.arms.map((a) => a.arm), ['control', `config-${configId}`]);
    assert.equal(launched.eval.perTrialUsd, evals.DEFAULT_TRIAL_CENTS / 100);
    const { rows } = await pool.query('SELECT config_id, position, base_sha, head_sha, intent, state FROM shots_eval_trials WHERE eval_run_id = $1 ORDER BY position', [evalId]);
    assert.deepEqual(rows.map((r) => [r.config_id, r.position, r.state]), [[null, 1, 'planned'], [configId, 2, 'planned']]);
    assert.equal(rows[0].base_sha, BASE);
    assert.equal(rows[0].intent.stories[0].id, 'board-sort');
  });

  const dispatched = [];
  const deps = pipelineDeps({ dispatched });

  await t.test('a trial runs the real pipeline with its arm, on its own rows, and is billed to its eval', async () => {
    const { rows: [sessionBefore] } = await pool.query('SELECT shots_run_id, shots_state, shots_detail FROM chat_sessions WHERE id = $1', [MERGED]);
    const out = await runner.tick(pool, CONFIG, deps);
    assert.equal(out.started, 1, 'one trial at a time on one proposal');
    await settleInFlight();
    assert.equal((await runner.tick(pool, CONFIG, deps)).started, 1);
    await settleInFlight();

    assert.equal(dispatched.length, 2);
    const [control, tried] = dispatched;
    assert.equal(control.model, 'claude-sonnet-5-5');
    assert.equal(control.systemPrompt, shotsAgent.SYSTEM_PROMPT, 'the control is the live agent');
    assert.equal(tried.model, 'claude-opus-5-5', 'the arm\'s model');
    assert.equal(tried.systemPrompt, `${shotsAgent.SYSTEM_PROMPT}\n\nClose any toast, then wait a second.`);
    assert.equal(tried.budgetMs, CONFIG.shots.maxAgentMs, 'a version names its whole recipe: v1\'s agentMinutes is not inherited');

    const { rows } = await pool.query(
      `SELECT t.id, t.state, t.config_id, t.recipe, t.hard_verdict, t.cost_cents::float8 AS cost, t.attempts,
              (SELECT COUNT(*)::int FROM shots_eval_artifacts a WHERE a.trial_id = t.id) AS files
         FROM shots_eval_trials t WHERE t.eval_run_id = $1 ORDER BY t.position`,
      [evalId]
    );
    assert.deepEqual(rows.map((r) => r.state), ['verified', 'verified']);
    assert.deepEqual(rows.map((r) => r.files), [2, 2]);
    assert.deepEqual(rows.map((r) => r.cost), [50, 50], 'what Claude Code reported, in cents');
    assert.deepEqual(rows.map((r) => r.attempts), [1, 1]);
    assert.equal(rows[0].recipe.live, true);
    assert.equal(rows[1].recipe.model, 'claude-opus-5-5');
    assert.equal(rows[1].hard_verdict.stories[0].status, 'ready');
    const { rows: [run] } = await pool.query('SELECT spent_cents::float8 AS spent, status FROM shots_eval_runs WHERE id = $1', [evalId]);
    assert.equal(run.spent, 100);

    const { rows: [sessionAfter] } = await pool.query('SELECT shots_run_id, shots_state, shots_detail FROM chat_sessions WHERE id = $1', [MERGED]);
    assert.deepEqual(sessionAfter, sessionBefore, 'the proposal\'s own shots are untouched');
    const { rows: [{ n: runs }] } = await pool.query('SELECT COUNT(*)::int AS n FROM shot_runs WHERE session_id = $1', [MERGED]);
    assert.equal(runs, 1, 'no shots run was made for the proposal');

    await runner.tick(pool, CONFIG, deps);
    const { rows: [done] } = await pool.query('SELECT status FROM shots_eval_runs WHERE id = $1', [evalId]);
    assert.equal(done.status, 'done', 'an eval with nothing left is done');
  });

  await t.test('two finished arms make a blind pair, and its pick and marks feed the numbers', async () => {
    const waiting = await evals.nextPair(pool, { runId: evalId });
    assert.equal(waiting.waiting, 1);
    const { pair } = waiting;
    assert.match(pair.pairId, /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal(pair.left.images.length, 2);
    assert.equal(pair.right.images.length, 2);
    assert.deepEqual(pair.left.images.map((i) => i.caption), ['board-sort · desktop · before', 'board-sort · desktop · after']);
    const text = JSON.stringify({ ...pair, left: { ...pair.left, images: [] }, right: { ...pair.right, images: [] } });
    assert.doesNotMatch(text, /control|config|Toast|live shots agent|claude-/i, 'nothing says which arm is which');

    const { rows: [p] } = await pool.query('SELECT left_is_control FROM shots_eval_pairs WHERE token = $1', [pair.pairId]);
    const armSide = p.left_is_control ? 'right' : 'left';
    const controlSide = p.left_is_control ? 'left' : 'right';
    assert.equal((await evals.submitPick(pool, { token: pair.pairId, pick: 'left', marks: [{ side: 'up', change: 'board-sort', shows: 'yes' }] })).status, 400);
    assert.equal((await evals.submitPick(pool, { token: pair.pairId, pick: 'left', marks: [{ side: 'left', change: 'nope', shows: 'yes' }] })).status, 400);
    const picked = await evals.submitPick(pool, {
      token: pair.pairId, pick: armSide, note: 'Closed the toast.', userId: adminId,
      marks: [
        { side: armSide, change: 'board-sort', shows: 'yes' },
        { side: controlSide, change: 'board-sort', shows: 'partly', misleading: true },
      ],
    });
    assert.deepEqual(picked, { ok: true, waiting: 0 });
    assert.equal((await evals.submitPick(pool, { token: pair.pairId, pick: 'tie' })).status, 409, 'once per pair');
    assert.equal((await evals.nextPair(pool, { runId: evalId })).pair, null);

    const read = await evals.getRun(pool, evalId);
    const [control, arm] = read.arms;
    assert.equal(control.arm, 'control');
    assert.equal(control.label, 'live shots agent');
    assert.equal(arm.label, 'Toast first v2');
    assert.equal(arm.ranWith.model, 'claude-opus-5-5');
    assert.deepEqual([arm.vsControl.wins, arm.vsControl.ties, arm.vsControl.losses], [1, 0, 0]);
    assert.equal(arm.marks.yes, 1);
    assert.equal(control.marks.partly, 1);
    assert.equal(control.marks.misleading, 1);
    assert.equal(arm.readyRate.rate, 1);
    assert.equal(arm.avgCostUsd, 0.5);
    assert.deepEqual(read.pairs, { waiting: 0, picked: 1, excluded: 0 });
    assert.equal(read.trials.length, 2);
    assert.equal(read.trials[1].armLabel, 'Toast first v2');
    assert.equal(read.trials[1].changes[0].status, 'ready');

    const listed = await evals.listRuns(pool);
    assert.equal(listed.evals[0].id, evalId);
    assert.equal(listed.evals[0].finished, 2);
  });

  await t.test('one proposal\'s shots come back every arm side by side, the published ones first', async () => {
    const shots = await evals.proposalShots(pool, evalId, { sessionId: MERGED });
    assert.equal(shots.ok, true);
    assert.deepEqual(shots.images.map((i) => i.caption), [
      'board-sort · desktop · published shots · before', 'board-sort · desktop · published shots · after',
      'board-sort · desktop · live shots agent · before', 'board-sort · desktop · live shots agent · after',
      'board-sort · desktop · Toast first v2 · before', 'board-sort · desktop · Toast first v2 · after',
    ]);
    assert.deepEqual(shots.arms.map((a) => a.arm), ['control', `config-${configId}`]);
    const afterOnly = await evals.proposalShots(pool, evalId, { sessionId: MERGED, side: 'after', published: false });
    assert.equal(afterOnly.images.length, 2);
    assert.equal((await evals.proposalShots(pool, evalId, { sessionId: NO_RUN })).status, 404);
  });

  await t.test('sameProposalsAs reruns the same frozen proposals', async () => {
    const again = await evals.launch(pool, CONFIG, { sameProposalsAs: evalId, capUsd: 10, repeats: 2 });
    assert.equal(again.ok, true);
    assert.deepEqual(again.eval.proposals, [MERGED]);
    assert.equal(again.eval.trials, 2, 'the control only, twice');
    await evals.cancelRun(pool, again.eval.id);
    assert.equal((await evals.cancelRun(pool, again.eval.id)).status, 409);
    const { rows } = await pool.query('SELECT DISTINCT state FROM shots_eval_trials WHERE eval_run_id = $1', [again.eval.id]);
    assert.deepEqual(rows.map((r) => r.state), ['cancelled']);
  });

  await t.test('a trial a restart interrupted is queued again under a fresh attempt id, once', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    const { rows: [trial] } = await pool.query('SELECT id, attempt_id FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    await pool.query(`UPDATE shots_eval_trials SET state = 'exploring', attempts = 1, updated_at = NOW() - interval '10 minutes' WHERE id = $1`, [trial.id]);
    const cleaned = [];
    const cleanupRunResources = async (_config, run) => { cleaned.push(run); return []; };
    assert.deepEqual(await runner.recoverStale(pool, CONFIG, { cleanupRunResources }), { requeued: 1, failed: 0 });
    assert.deepEqual(cleaned, [{ id: trial.attempt_id, app_slug: 'eval-demo' }], 'its copies are removed by its old names');
    const { rows: [requeued] } = await pool.query('SELECT state, attempt_id FROM shots_eval_trials WHERE id = $1', [trial.id]);
    assert.equal(requeued.state, 'planned');
    assert.notEqual(requeued.attempt_id, trial.attempt_id);

    await pool.query(`UPDATE shots_eval_trials SET state = 'provisioning', attempts = 2, updated_at = NOW() - interval '10 minutes' WHERE id = $1`, [trial.id]);
    assert.deepEqual(await runner.recoverStale(pool, CONFIG, { cleanupRunResources }), { requeued: 0, failed: 1 });
    const { rows: [failed] } = await pool.query('SELECT state, failure_code FROM shots_eval_trials WHERE id = $1', [trial.id]);
    assert.deepEqual(failed, { state: 'failed', failure_code: 'shots_eval_interrupted' });
    await pool.query(`UPDATE shots_eval_runs SET status = 'done' WHERE id = $1`, [launched.eval.id]);
  });

  await t.test('the cap stops an eval before a trial it cannot pay for', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], configIds: [configId], capUsd: 5 });
    await pool.query('UPDATE shots_eval_runs SET spent_cents = 300 WHERE id = $1', [launched.eval.id]);
    let started = 0;
    const out = await runner.tick(pool, CONFIG, { executeTrial: async () => { started += 1; } });
    assert.equal(started, 0);
    assert.equal(out.capped, 1);
    const { rows: [run] } = await pool.query('SELECT status FROM shots_eval_runs WHERE id = $1', [launched.eval.id]);
    assert.equal(run.status, 'capped');
    const { rows } = await pool.query('SELECT DISTINCT state FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    assert.deepEqual(rows.map((r) => r.state), ['cancelled']);
  });

  await t.test('the GC keeps a running trial\'s checkout and prunes old trial images', async () => {
    const launched = await evals.launch(pool, CONFIG, { sessionIds: [MERGED_TWO], capUsd: 10 });
    const { rows: [trial] } = await pool.query('SELECT id, attempt_id FROM shots_eval_trials WHERE eval_run_id = $1', [launched.eval.id]);
    await pool.query(`UPDATE shots_eval_trials SET state = 'exploring', updated_at = NOW() WHERE id = $1`, [trial.id]);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-gc-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const live = `usernode-shots-${trial.attempt_id.slice(0, 8)}-live`;
    const orphan = 'usernode-shots-0f0f0f0f-orphan';
    for (const name of [live, orphan]) {
      fs.mkdirSync(path.join(tmpDir, name));
      const old = new Date(Date.now() - 600_000);
      fs.utimesSync(path.join(tmpDir, name), old, old);
    }
    const swept = await shotsGc.sweepOrphanCheckouts(pool, { maxAgeMs: 60_000, tmpDir });
    assert.equal(swept.removed, 1);
    assert.deepEqual(fs.readdirSync(tmpDir), [live]);

    await pool.query(`UPDATE shots_eval_trials SET completed_at = NOW() - interval '40 days' WHERE eval_run_id = $1`, [evalId]);
    assert.equal(await shotsGc.pruneEvalArtifacts(pool), 4);
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM shots_eval_artifacts');
    assert.equal(n, 0);
    const { rows: [kept] } = await pool.query(`SELECT COUNT(*)::int AS n FROM shots_eval_trials WHERE eval_run_id = $1 AND state = 'verified'`, [evalId]);
    assert.equal(kept.n, 2, 'the trials keep their results');
  });
});
