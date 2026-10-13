'use strict';

// R5: a first version's review is carried on after a platform restart
// (homeroom-bot.js finishRecoveredLive → resumeInterruptedReview →
// reviewRecoveredBuild → live.reviewLanded → bot-review.js runReviewLoop's
// `resumeFrom`), against the FULL PostgreSQL schema.
//
// Run four (12 Oct 2026, Club Votes, bot run 1746): a release restarted the
// server two minutes into a first version's review, while its fix turn was
// making six fixes, the first a blocker. Recovery followed the fix turn to
// its end, then rolled the branch back to the build ("not seen to boot
// before the restart") and proposed it as it stood; its checks failed on the
// same bug, and a checks fix redid the work in eleven more minutes. Now:
//
//   - a review a gone process left (its `leader` stamp is not this one's) is
//     carried on at once, not after 20 quiet minutes; one this process saved
//     moments ago is left alone;
//   - a reviewer call the restart cut short is asked again for that round,
//     and the screenshots it was given are the ones the round stored;
//   - the fix turn recovery followed to its end is recorded on its round
//     (its cost from the turn ledger), captured, reviewed and proposed with
//     the fix, never rolled back unseen; what recovery noted is spent;
//   - what the resumed review spent is the build's, each reviewer call once.
//
// The worker, the capture and the reviewer are stubbed; the runs, sessions,
// snapshots, round screenshots, checkpoints and the proposal path are real.
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('a first version\'s review is carried on after a restart', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bot_review_resume_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const live = require('../src/services/homeroom-bot-live');
  const bot = require('../src/services/homeroom-bot');
  const botReview = require('../src/services/bot-review');
  const checkpoint = require('../src/services/homeroom-bot-checkpoint');
  const real = { post: live.post, advanceSeen: live.advanceSeen, mentionTargets: live.mentionTargets, promoteAsBot: live.promoteAsBot };
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
  const REVIEWER = current.recipe.reviewer;

  const { rows: [botUser] } = await pool.query("INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id");
  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password) VALUES ('evan', 'x') RETURNING id");
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Club Votes', 'club-votes', 'running', 'https://github.com/usernode-bot/club-votes')
     RETURNING id, slug, name, repo_url`,
  );
  const SPEC = '# Club Votes\n\n## User-facing changes\n\nPost a decision and vote on it.\n\n## Technical implementation\n\nOne screen.';
  const MIN = 60_000;

  // A shot as the screenshot step keeps it (bench/capture.js acceptShots).
  const kept = (ids) => ids.map((id) => {
    const [viewport, look, state] = id.split('-');
    return { id, viewport, look, state, data: PNG, width: 1, height: 1, bytes: PNG.length, sha256: crypto.createHash('sha256').update(`${id}${Math.random()}`).digest('hex') };
  });
  const SHOTS = ['phone-light-populated', 'phone-dark-populated', 'phone-light-empty'];
  const summary = (artifacts, { booted = true } = {}) => ({
    booted, error: booted ? null : 'it did not start', ms: 1000,
    shots: Object.entries(artifacts).map(([id, artifactId]) => {
      const [viewport, look, state] = id.split('-');
      return { id, viewport, look, state, sha256: crypto.createHash('sha256').update(artifactId).digest('hex'), artifactId };
    }),
    checks: { consoleErrors: { count: 0 } }, tells: {},
  });

  /** A configured first version in its review, as the loop last saved it (`state`), by a process that is gone. */
  const inReview = async (issue, stateOf, { leader = 'a-leader-that-is-gone', savedMinutesAgo = 2 } = {}) => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, spec_md, agent_model)
       VALUES ($1, $2, $3, 'paused', FALSE, ARRAY[$4::int], $5, $6) RETURNING id`,
      [app.id, botUser.id, `dev/homeroom_bot-${issue}`, issue, SPEC, GLM],
    );
    const { rows: [r] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, model, build_session_id, bot_config_version_id, created_at)
       VALUES ($1, $2, 'live', 'ready', 'Decisions the club votes on.', $3, $4, $5, NOW() - INTERVAL '30 minutes') RETURNING id`,
      [app.id, issue, GLM, s.id, current.id],
    );
    await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, first_version) VALUES ($1, $2, $3, TRUE)', [app.id, issue, evan.id]);
    await require('../src/services/homeroom-bot-snapshots').recordSnapshot(pool, {
      runId: r.id, stage: 'build', appId: app.id, issueNumber: issue, baseSha: 'a'.repeat(40),
      texts: { seed: `Issue #${issue}: Club Votes\n\nLet the club post decisions and vote.`, build_note: 'Decisions the club votes on.' },
      extra: { firstVersion: true, model: GLM, specModel: OPUS },
    });
    await checkpoint.save(pool, r.id, s.id, 'landed', { landed: { sha: 'b1sha', commits: 1, pushOk: true, text: 'Built.' } });
    // Round 0's screenshots, stored as the loop stores a round's.
    const r0 = summary(await botReview.storeRoundShots(pool, { botRunId: r.id, round: 0 }, kept(SHOTS)));
    const now = Date.now();
    const state = {
      state: 'reviewing', reviewer: REVIEWER,
      startedAt: new Date(now - 8 * MIN).toISOString(), updatedAt: new Date(now - savedMinutesAgo * MIN).toISOString(),
      round0: { sha: 'b1sha', commits: 1, capture: botReview.slimCapture(r0), captureMs: 34_000, captureError: null, costUsd: 0.9, activeMs: 1_000_000 },
      latest: { index: 0, sha: 'b1sha', capture: botReview.reviewForm(r0) },
      lastBooted: { sha: 'b1sha', commits: 1 }, lastBootedCapture: botReview.slimCapture(r0),
      rounds: [], stop: null, stopDetail: null, finalSha: 'b1sha', finalCommits: 1, finalCapture: null, costUsd: 0,
      buildText: 'Built.\n==== DESCRIPTION ====\nThe club posts decisions and votes on them.\n==== END DESCRIPTION ====',
      ...stateOf(r0),
    };
    await bot.recordReviewState(pool, r.id, state);
    // recordReviewState keeps what the loop saved; the loop stamps the leader.
    await pool.query("UPDATE homeroom_bot_runs SET review = jsonb_set(review, '{leader}', to_jsonb($2::text)) WHERE id = $1", [r.id, leader]);
    return { runId: r.id, sessionId: s.id, r0 };
  };

  const promoted = [];
  const moved = [];
  live.post = async () => ({ postId: 1 });
  live.advanceSeen = async () => ({ advanced: true });
  live.mentionTargets = async () => [];
  live.promoteAsBot = async ({ sessionId }) => { promoted.push(Number(sessionId)); return { status: 200, body: { ok: true, prNumber: 9 } }; };
  const calls = { captures: [], reviews: [], ensured: 0 };
  let verdicts = [];
  const deps = {
    github: {
      isEnabled: () => true, getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, title: 'Club Votes', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
      async forceBranchToSha(...a) { moved.push(a); return { updated: true }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id) { calls.ensured += 1; return `sv-worker-s${id}`; },
      workerRuntimeName: (id) => `sv-worker-s${id}`,
      clearPendingStop() {},
    },
    // Each capture stores its round's screenshots as the real step does.
    captureRound: async ({ store, detached }) => {
      calls.captures.push({ prior: detached?.prior || null });
      return { ok: true, capture: summary(await store(kept(SHOTS))) };
    },
    reviewDeps: {
      callReviewer: async ({ content }) => {
        calls.reviews.push(content);
        const v = verdicts.shift() || 'ship';
        return {
          ok: true, costUsd: 0.25, ms: 10,
          text: JSON.stringify(v === 'ship' ? { verdict: 'ship', issues: [] }
            : { verdict: 'fix', issues: [{ id: 'votes', severity: 'major', screen: 'phone', problem: 'x', fix: 'y' }] }),
        };
      },
    },
    seesImages: false,
    ws: {}, sessionLifecycle: {}, domain: 'app.onhomeroom.com', threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } }, limits: {},
    dm: { async noteBuildRestarted() {}, async requesterOf() { return { locale: null }; } },
  };
  const row = async (runId) => (await pool.query(
    `SELECT build_ok, build_sha, build_commits, build_cost_usd::float8 AS cost, proposal_session_id, review, review_stop, review_rounds
       FROM homeroom_bot_runs WHERE id = $1`, [runId],
  )).rows[0];
  const reset = () => {
    bot._resetForTests();
    promoted.length = 0; moved.length = 0; calls.captures.length = 0; calls.reviews.length = 0; calls.ensured = 0; verdicts = [];
  };

  await t.test('a reviewer call a gone leader left is asked again at once, on the round\'s stored screenshots', async () => {
    reset();
    const a = await inReview(51, () => ({
      rounds: [{ round: 1, sha: 'b1sha', captureIndex: 0, artifactIds: [], booted: true, verdict: null, issues: [], previousFixed: [], fix: null }],
      inFlight: { step: 'review', round: 1, at: new Date(Date.now() - 2 * MIN).toISOString() },
    }));
    // One this process saved a moment ago is its own, still running: left alone.
    const mine = await inReview(52, () => ({ rounds: [] }), { leader: botReview.PROCESS_ID, savedMinutesAgo: 1 });
    // What restart recovery reads with the session (server.js adoptOrphanWorker).
    const inProgress = async (sessionId) => (await pool.query(
      `SELECT ${bot.BOT_REVIEW_IN_PROGRESS_SQL} AS x FROM chat_sessions cs WHERE cs.id = $1`, [sessionId],
    )).rows[0].x;
    assert.equal(await inProgress(a.sessionId), true);
    verdicts = ['ship'];
    assert.equal(await bot.finishInterruptedReviews(pool, {}, deps, { wait: true }), 1, 'no 20 quiet minutes for a gone leader\'s');
    assert.equal(calls.reviews.length, 1, 'asked again, once');
    assert.match(calls.reviews[0][0].text, /^ROUND 1 of /, 'for the round that was cut');
    assert.equal(calls.reviews[0].filter((c) => c.type === 'image_url').length, SHOTS.length, 'with the screenshots round 0 stored');
    assert.equal(calls.captures.length, 0, 'round 0 is not taken again');
    const r = await row(a.runId);
    assert.deepEqual([r.build_ok, r.build_sha, r.proposal_session_id, r.review_stop, r.review_rounds], [true, 'b1sha', a.sessionId, 'ship', 1]);
    assert.equal(r.review.state, 'done');
    assert.equal(r.review.resumes, 1);
    assert.equal(r.review.rounds.length, 1);
    assert.equal(r.review.rounds[0].reissued, 1);
    assert.equal(r.review.leader, botReview.PROCESS_ID, 'stamped by the process that carried it on');
    assert.equal(await inProgress(a.sessionId), false, 'out of its review once proposed');
    assert.ok(Math.abs(r.cost - 0.25) < 1e-9, `the reviewer call, once (${r.cost})`);
    assert.deepEqual(promoted, [a.sessionId]);
    assert.deepEqual(moved, []);
    const { rows: [m] } = await pool.query("SELECT review->>'state' AS st FROM homeroom_bot_runs WHERE id = $1", [mine.runId]);
    assert.equal(m.st, 'reviewing', 'this process\'s own review is not taken from it');
    assert.equal(await bot.finishInterruptedReviews(pool, {}, deps, { wait: true }), 0, 'once');
  });

  await t.test('the run-four restart: the fix turn recovery followed is recorded, captured and proposed with the fix', async () => {
    reset();
    const fixStarted = new Date(Date.now() - 13 * MIN).toISOString();
    const a = await inReview(61, () => ({
      rounds: [{
        round: 1, sha: 'b1sha', captureIndex: 0, artifactIds: [], booted: true, verdict: 'fix',
        issues: [{ id: 'post-sheet', severity: 'blocker', screen: 'post a decision', problem: '[object HTMLFormElement]', fix: 'read the form\'s fields' }],
        previousFixed: [], reviewedBy: 'model', reviewerCostUsd: 0.4, reviewerMs: 15_000, fix: null,
      }],
      inFlight: { step: 'fix', round: 1, at: fixStarted },
      costUsd: 0.4,
    }));
    // The fix turn's ledger row, settled by recovery as any recovered turn's.
    await pool.query(
      `INSERT INTO agent_turns (id, session_id, user_id, backend, status, estimated_cost_usd, started_at, completed_at)
       VALUES ($1, $2, $3, 'codex_openrouter', 'completed', 0.21, $4::timestamptz + INTERVAL '5 seconds', $4::timestamptz + INTERVAL '12 minutes')`,
      [crypto.randomUUID(), a.sessionId, botUser.id, fixStarted],
    );
    // Recovery followed the fix turn's journal to its end: six fixes, pushed.
    assert.equal(await bot.finishRecoveredTurn({
      pool, session: { id: a.sessionId }, activeTurn: { mode: 'build' },
      result: { pushOk: true, ahead: 2, sha: '394d7494', lastResultText: 'Fixed all six.' },
    }), 'live_pending');
    verdicts = ['ship'];
    assert.equal(await bot.completeRecoveredLive({ pool, config: {}, sessionId: a.sessionId, deps }), 'proposed');
    assert.equal(calls.captures.length, 1, 'the fix is captured');
    assert.equal(calls.reviews.length, 1, 'and reviewed');
    assert.match(calls.reviews[0][0].text, /^ROUND 2 of /);
    assert.match(calls.reviews[0][0].text, /PREVIOUS ISSUES[\s\S]*post-sheet/);
    const r = await row(a.runId);
    assert.deepEqual([r.build_ok, r.build_sha, r.build_commits, r.review_stop], [true, '394d7494', 2, 'ship'], 'proposed with the fix');
    assert.deepEqual(moved, [], 'never rolled back unseen');
    const fix = r.review.rounds[0].fix;
    assert.deepEqual([fix.ok, fix.sha, fix.commits, fix.recovered, fix.costUsd], [true, '394d7494', 2, true, 0.21], 'its cost from the ledger');
    assert.ok(fix.ms >= 11 * MIN && fix.ms <= 13 * MIN, `${fix.ms}`);
    assert.deepEqual(r.review.lastBooted, { sha: '394d7494', commits: 2 });
    // The ledger's turns and every reviewer call, each once.
    assert.ok(Math.abs(r.cost - (0.21 + 0.4 + 0.25)) < 1e-9, `${r.cost}`);
    const { rows: shots } = await pool.query('SELECT round, COUNT(*)::int AS n FROM bot_capture_artifacts WHERE bot_run_id = $1 GROUP BY round ORDER BY round', [a.runId]);
    assert.deepEqual(shots.map((x) => [x.round, x.n]), [[0, 3], [1, 3]]);
    assert.equal((await checkpoint.read(pool, a.runId, a.sessionId)).recovered ?? null, null, 'what recovery noted is spent');
    assert.equal((await checkpoint.read(pool, a.runId, a.sessionId)).step, 'proposed');
    const { rows: [res] } = await pool.query("SELECT sha, booted FROM bot_config_results WHERE bot_run_id = $1 AND source = 'live'", [a.runId]);
    assert.deepEqual([res.sha, res.booted], ['394d7494', true], 'the configuration\'s result is the reviewed build, with its final screenshots');
  });

  await t.test('a capture a restart left running is harvested by its id where it runs', async () => {
    reset();
    const a = await inReview(71, () => ({
      rounds: [{
        round: 1, sha: 'b1sha', captureIndex: 0, verdict: 'fix', issues: [{ id: 'a', severity: 'major', screen: 'x', problem: 'y', fix: 'z' }],
        reviewerCostUsd: 0.3, fix: { ok: true, sha: 'f1sha', commits: 2, costUsd: 0.1, ms: 1 },
      }],
      finalSha: 'f1sha', finalCommits: 2,
      inFlight: { step: 'capture', index: 1, id: 'feedfacecafebeef', startedAt: new Date(Date.now() - 3 * MIN).toISOString() },
    }));
    verdicts = ['ship'];
    assert.equal(await bot.finishInterruptedReviews(pool, {}, deps, { wait: true }), 1);
    assert.deepEqual(calls.captures.map((c) => c.prior?.id || null), ['feedfacecafebeef']);
    assert.equal(calls.ensured, 0, 'the worker is not made sure before it is looked in: a new image would replace it');
    const r = await row(a.runId);
    assert.deepEqual([r.build_sha, r.review_stop], ['f1sha', 'ship']);
  });

  await t.test('the adoption and the sweep never carry the same review on twice', async () => {
    reset();
    const a = await inReview(81, () => ({
      rounds: [{ round: 1, sha: 'b1sha', verdict: null, issues: [], fix: null }],
    }));
    verdicts = ['ship', 'ship'];
    // The worker's adoption (server.js adoptBotOrphan) and the loop's sweep
    // reach it together at boot.
    const sweep = bot.finishInterruptedReviews(pool, {}, deps, { wait: true });
    const adopted = (async () => {
      await bot.abandonRecoveredTurn({ pool, session: { id: a.sessionId }, why: 'the platform restarted during its review' });
      return bot.completeRecoveredLive({ pool, config: {}, sessionId: a.sessionId, deps });
    })();
    await Promise.all([sweep, adopted]);
    assert.equal(calls.reviews.length, 1, 'one review');
    assert.deepEqual(promoted, [a.sessionId], 'one proposal');
  });
});
