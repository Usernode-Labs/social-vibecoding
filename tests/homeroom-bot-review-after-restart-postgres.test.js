'use strict';

// A first version whose own build turn a restart caught is reviewed before
// recovery proposes it (homeroom-bot.js reviewRecoveredBuild), against the
// FULL PostgreSQL schema.
//
// On 7 Oct 2026 five restarts in half an hour caught a first version's build
// (run 1077, Bay Area Restaurant Tier List): recovery proposed it as it
// stood, and the Opus reviewer its configuration named never saw it. Now:
//
//   - recovery runs the same review the live path runs (live.reviewLanded),
//     its request rebuilt from the build snapshot, its spec from the session,
//     its reviewer from the run's configuration, its fix turns in the same
//     session (live.buildTurnRunner), and proposes where the review ended,
//     its cost added to the build's;
//   - while it reviews, it holds the project's build slot and the sweep for
//     lost live builds leaves the run alone;
//   - a configuration with no reviewer, a request that is not a first
//     version, or a run with no snapshot is proposed as it stands, as is one
//     whose review could not run.
//
// The worker and the review loop itself are stubbed (bot-review.js has its
// own tests); the runs, the sessions, the configurations and the snapshot
// are real. Skips when no database is reachable, unless TEST_DATABASE_URL
// insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const OPUS = 'anthropic/claude-opus-5.5';
const GLM = 'z-ai/glm-5.3-flash';

test('a first version a restart caught is reviewed before it is proposed', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bot_review_restart_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const live = require('../src/services/homeroom-bot-live');
  const bot = require('../src/services/homeroom-bot');
  const real = {
    post: live.post, advanceSeen: live.advanceSeen, mentionTargets: live.mentionTargets,
    promoteAsBot: live.promoteAsBot, reviewLanded: live.reviewLanded,
  };
  t.after(async () => {
    Object.assign(live, real);
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const CATALOG = [
    { id: GLM, pricing: { prompt: '0.0000001', completion: '0.0000004' }, architecture: { input_modalities: ['text'] } },
    { id: OPUS, pricing: { prompt: '0.000005', completion: '0.000025' }, architecture: { input_modalities: ['text', 'image'] } },
  ];
  await pool.query('INSERT INTO openrouter_model_catalog (id, models, fetched_at) VALUES (TRUE, $1::jsonb, NOW())', [JSON.stringify(CATALOG)]);

  const configs = require('../src/services/bot-configs');
  await configs.seedConfigs(pool);
  await configs.upgradeSeedConfigs(pool);
  const current = await configs.currentVersion(pool);
  assert.ok(configs.reviews(current.recipe), 'the current first-version configuration names a reviewer');
  const noReview = (await configs.listVersions(pool)).find((v) => v.key === 'opus-spec-no-review');
  assert.ok(noReview && !configs.reviews(noReview.recipe));

  const { rows: [botUser] } = await pool.query("INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id");
  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password) VALUES ('evan', 'x') RETURNING id");
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Shelf Sorter', 'shelf-sorter', 'running', 'https://github.com/usernode-bot/shelf-sorter')
     RETURNING id, slug, name, repo_url`,
  );

  // A configured first version whose build turn ran on through a restart
  // and pushed b1: its session, run, requester and build snapshot.
  const SPEC = '# Shelf Sorter\n\n## User-facing changes\n\nSort books onto shelves.\n\n## Technical implementation\n\nOne screen.';
  const firstVersion = async (issue, { version = current, firstVersionRow = true, snapshot = true } = {}) => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, spec_md)
       VALUES ($1, $2, $3, 'active', FALSE, ARRAY[$4::int], $5) RETURNING id`,
      [app.id, botUser.id, `dev/homeroom_bot-${issue}`, issue, SPEC],
    );
    const { rows: [r] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, model, build_session_id, bot_config_version_id, created_at)
       VALUES ($1, $2, 'live', 'ready', 'Shelves you sort books onto.', $3, $4, $5, NOW() - INTERVAL '5 hours') RETURNING id`,
      [app.id, issue, GLM, s.id, version.id],
    );
    await pool.query(
      'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, first_version) VALUES ($1, $2, $3, $4)',
      [app.id, issue, evan.id, firstVersionRow],
    );
    if (snapshot) {
      await require('../src/services/homeroom-bot-snapshots').recordSnapshot(pool, {
        runId: r.id, stage: 'build', appId: app.id, issueNumber: issue, baseSha: 'a'.repeat(40),
        texts: { seed: `Issue #${issue}: Shelf Sorter\n\nLet me sort my books onto shelves.`, build_note: 'Shelves you sort books onto.' },
        extra: { firstVersion: true, model: GLM, specModel: OPUS },
      });
    }
    assert.equal(await bot.finishRecoveredTurn({
      pool, session: { id: s.id }, activeTurn: { mode: 'build' },
      result: { pushOk: true, ahead: 2, sha: 'b1sha', lastResultText: 'Built.\n==== DESCRIPTION ====\nIt sorts books.\n==== END DESCRIPTION ====' },
    }), 'live_pending');
    return { runId: r.id, sessionId: s.id };
  };

  const promoted = [];
  live.post = async () => ({ postId: 1 });
  live.advanceSeen = async () => ({ advanced: true });
  live.mentionTargets = async () => [];
  live.promoteAsBot = async ({ sessionId }) => { promoted.push(Number(sessionId)); return { status: 200, body: { ok: true, prNumber: 7 } }; };
  const workerCalls = [];
  const deps = {
    github: {
      isEnabled: () => true, getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, title: 'Shelf Sorter', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() { workerCalls.push('image'); },
      async ensureWorker(id, opts) { workerCalls.push(['worker', id, opts.branchName, opts.temporary]); return `sv-worker-s${id}`; },
    },
    seesImages: false,
    ws: {}, sessionLifecycle: {}, domain: 'app.onhomeroom.com', threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } }, limits: {},
    dm: { async noteBuildRestarted() {}, async requesterOf() { return null; } },
  };
  const buildRow = async (runId) => (await pool.query(
    'SELECT build_ok, build_sha, build_commits, build_cost_usd::float AS cost, proposal_session_id FROM homeroom_bot_runs WHERE id = $1', [runId],
  )).rows[0];

  await t.test('reviewed with what the live path had, and proposed where the review ended', async () => {
    bot._resetForTests();
    promoted.length = 0; workerCalls.length = 0;
    const a = await firstVersion(11);
    const reviews = [];
    let sweptDuringReview = null;
    live.reviewLanded = async (args) => {
      reviews.push(args);
      // In the middle of the review: the sweep for lost live builds does not
      // take a run whose build is old enough to look lost.
      sweptDuringReview = await bot.settleAbandonedLiveBuilds(pool, await bot.readSettings(pool), deps);
      return {
        state: 'done', stop: 'approved', reviewer: current.recipe.reviewer,
        round0: { sha: 'b1sha', commits: 2, capture: { booted: true, shots: [] }, costUsd: 0.3, activeMs: 1000 },
        rounds: [{ round: 1, sha: 'b1sha', verdict: 'fix', issues: [] }, { round: 2, sha: 'r2sha', verdict: 'approve', issues: [] }],
        finalSha: 'r2sha', finalCommits: 3, costUsd: 0.45, buildText: 'Built.',
      };
    };
    const acted = await bot.completeRecoveredLive({ pool, config: {}, sessionId: a.sessionId, deps });
    assert.equal(acted, 'proposed');
    assert.equal(reviews.length, 1, 'the review ran, once');
    const r = reviews[0];
    assert.match(r.seed, /^Issue #11: Shelf Sorter/, 'its request, from the build snapshot');
    assert.equal(r.spec, SPEC, 'its spec, from the session');
    assert.deepEqual(r.review.reviewer, current.recipe.reviewer, 'the reviewer of the configuration it was built under');
    assert.deepEqual(r.review.owner, { botRunId: a.runId });
    assert.equal(typeof r.review.onState, 'function');
    assert.equal(typeof r.review.budgetCheck, 'function');
    assert.deepEqual([r.start.sha, r.start.commits], ['b1sha', 2], 'it starts from what the build pushed');
    assert.match(r.start.buildText, /It sorts books\./);
    assert.equal(r.branchName, 'dev/homeroom_bot-11');
    assert.equal(r.session.id, a.sessionId);
    assert.equal(r.session.app_slug, 'shelf-sorter', 'the full session row the turn runner needs');
    assert.equal(typeof r.runBuildTurn, 'function', 'its fix turns run in the same session');
    assert.equal(r.readsImages, false);
    assert.ok(r.turnBudgetMs > 0);
    assert.deepEqual(workerCalls, ['image', ['worker', a.sessionId, 'dev/homeroom_bot-11', true]]);
    assert.equal(sweptDuringReview, 0, 'the run under review is not called lost');
    assert.deepEqual(promoted, [a.sessionId]);
    const row = await buildRow(a.runId);
    assert.deepEqual([row.build_ok, row.build_sha, row.build_commits, row.proposal_session_id], [true, 'r2sha', 3, a.sessionId],
      'proposed where the review ended');
    assert.ok(Math.abs(row.cost - 0.45) < 1e-9, 'the review\'s cost is the build\'s');
    const { rows: res } = await pool.query(
      "SELECT source, sha FROM bot_config_results WHERE bot_run_id = $1 AND source = 'live'", [a.runId],
    );
    assert.deepEqual(res.map((x) => x.sha), ['r2sha'], 'the configuration\'s result is the reviewed build');
  });

  await t.test('no reviewer, not a first version, or no snapshot: proposed as it stands, unreviewed', async () => {
    for (const [issue, opts] of [
      [21, { version: noReview }],
      [22, { firstVersionRow: false }],
      [23, { snapshot: false }],
    ]) {
      bot._resetForTests();
      promoted.length = 0;
      let reviewed = 0;
      live.reviewLanded = async () => { reviewed += 1; return null; };
      // eslint-disable-next-line no-await-in-loop
      const a = await firstVersion(issue, opts);
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await bot.completeRecoveredLive({ pool, config: {}, sessionId: a.sessionId, deps }), 'proposed', `#${issue}`);
      assert.equal(reviewed, 0, `#${issue} is not reviewed`);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await buildRow(a.runId)).build_sha, 'b1sha', `#${issue} as the build pushed it`);
    }
  });

  await t.test('a review that cannot run leaves the build proposed as it stands', async () => {
    bot._resetForTests();
    promoted.length = 0;
    live.reviewLanded = async () => { throw new Error('reviewer unavailable'); };
    const a = await firstVersion(31);
    assert.equal(await bot.completeRecoveredLive({ pool, config: {}, sessionId: a.sessionId, deps }), 'proposed');
    assert.equal((await buildRow(a.runId)).build_sha, 'b1sha');
    assert.deepEqual(promoted, [a.sessionId]);

    bot._resetForTests();
    const failing = { ...deps, worker: { async ensureWorkerImage() {}, async ensureWorker() { throw new Error('no worker'); } } };
    live.reviewLanded = async () => { throw new Error('not reached'); };
    const b = await firstVersion(32);
    assert.equal(await bot.completeRecoveredLive({ pool, config: {}, sessionId: b.sessionId, deps: failing }), 'proposed');
    assert.equal((await buildRow(b.runId)).build_sha, 'b1sha', 'a worker that will not start is no reason to lose the build');
  });
});
