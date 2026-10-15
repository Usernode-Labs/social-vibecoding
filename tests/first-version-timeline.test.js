'use strict';

// A first version's timeline (newcomer run five, 13 October 2026): one
// `first_version_stage` event each time a project's first version moves to a
// new stage, written by the pipeline as it moves (services/
// first-version-timeline.js): its plan written, Build it, its build taking
// its slot, the spec turn, the first look, the build turn, the build pushed,
// each review round, the proposal (its checks), the merge and live. Run
// five's timings could only be pieced together from screenshots and a
// polling watcher. Beside it, the live build loop's own last pass, which
// get_homeroom_bot carried as the shadow lane's.
//
// The rows themselves, against the real schema: tests/first-version-timeline-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const timeline = require('../src/services/first-version-timeline');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function recordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) { queries.push({ sql, params }); return { rows: /INSERT INTO events/.test(sql) ? [{ id: queries.length }] : [] }; },
  };
}

test('the stages, and the build steps that are stages', () => {
  assert.deepEqual(timeline.STAGES, [
    'plan_written', 'go_ahead', 'picked_up', 'spec_started', 'first_look_saved', 'build_started',
    'build_done', 'review_round', 'testing_started', 'merged', 'live',
  ]);
  assert.deepEqual(timeline.STAGE_OF_STEP, {
    spec_turn: 'spec_started', build_turn: 'build_started', landed: 'build_done', proposed: 'testing_started',
  });
  // Every step it names is a boundary the build reaches and tells its
  // caller of (homeroom-bot-live.js buildAndPropose's step).
  const live = read('src/services/homeroom-bot-live.js');
  for (const step of Object.keys(timeline.STAGE_OF_STEP)) assert.ok(live.includes(`await step('${step}'`), step);
  assert.equal(require('../src/services/events').EVENT_TYPES.FIRST_VERSION_STAGE, 'first_version_stage');
});

test('a stage is written for its run, or its project before there is one; its detail is numbers and codes only', async () => {
  const pool = recordingPool();
  assert.equal(await timeline.record(pool, {
    runId: 41, stage: 'review_round', sessionId: 9,
    detail: { round: 2, rounds: 3, words: 'A sentence somebody wrote', nested: { a: 1 }, stage: 'live', runId: 7, bad_key: 1, nan: NaN },
  }), true);
  const [byRun] = pool.queries;
  assert.equal(byRun.sql, timeline.BY_RUN_SQL);
  assert.deepEqual(byRun.params.slice(0, 3), [41, 9, 'first_version_stage']);
  assert.deepEqual(JSON.parse(byRun.params[3]), { round: 2, rounds: 3, stage: 'review_round' });
  // Only a first version's live run, joined to its first-version row.
  assert.match(timeline.BY_RUN_SQL, /JOIN homeroom_bot_first_versions f\s+ON f\.app_id = r\.app_id AND f\.issue_number = r\.issue_number AND f\.bot_builds/);
  assert.match(timeline.BY_RUN_SQL, /WHERE r\.id = \$1::int AND r\.mode = 'live'/);
  assert.match(timeline.BY_RUN_SQL, /SELECT f\.user_id, f\.app_id/, 'its maker and its project');

  assert.equal(await timeline.record(pool, { appId: 3, stage: 'plan_written', detail: { source: 'make_it', questions: 2 } }), true);
  assert.equal(pool.queries[1].sql, timeline.BY_APP_SQL);
  assert.deepEqual(pool.queries[1].params, [3, 'first_version_stage', JSON.stringify({ source: 'make_it', questions: 2, stage: 'plan_written' })]);

  // A code is a short lower-case word; anything else is left out.
  assert.deepEqual(timeline.cleanDetail({ how: 'saved_screen', why: 'Because it broke', ok: true, ms: 12.5 }), { how: 'saved_screen', ok: true, ms: 12.5 });
  assert.deepEqual(timeline.cleanDetail(null), {});
});

test('best effort: nothing written for no stage, no run, or a pool that fails, and it never throws', async () => {
  const pool = recordingPool();
  assert.equal(await timeline.record(pool, { runId: 1, stage: 'deployed' }), false);
  assert.equal(await timeline.record(pool, { stage: 'live' }), false);
  assert.equal(await timeline.record(pool, { runId: 'x', stage: 'live' }), false);
  assert.equal(await timeline.record(null, { runId: 1, stage: 'live' }), false);
  assert.deepEqual(pool.queries, []);
  assert.equal(await timeline.record({ async query() { throw new Error('connection refused'); } }, { runId: 1, stage: 'live' }), false);
  assert.equal(await timeline.record({ query() { return undefined; } }, { runId: 1, stage: 'live' }), false);
  assert.equal(await timeline.recordStep(pool, { runId: 1, step: 'session' }), false, 'not every step is a stage');
  assert.equal(await timeline.recordStep(pool, { runId: 1, step: 'landed', detail: { partial: true } }), true);
  assert.deepEqual(JSON.parse(pool.queries[0].params[3]), { partial: true, stage: 'build_done' });
});

test('each review round is a stage as its review begins, for a live run only', async () => {
  const live = require('../src/services/homeroom-bot-live');
  const botReview = require('../src/services/bot-review');
  const realLoop = botReview.runReviewLoop;
  const realReview = botReview.reviewCapture;
  try {
    botReview.reviewCapture = async () => ({ ok: true, verdict: 'ship', issues: [] });
    botReview.runReviewLoop = async ({ review }) => {
      await review({ round: 1, capture: {}, previousIssues: null, timeoutMs: 1000 });
      await review({ round: 2, capture: {}, previousIssues: null, timeoutMs: 1000 });
      return { rounds: [] };
    };
    const args = (owner) => ({
      pool: recordingPool(), config: {}, bot: { id: 1 }, app: { id: 3, slug: 'club-votes' }, repo: { owner: 'o', repo: 'r' },
      session: { id: 9 }, branchName: 'b', seed: '', spec: '', deps: { worker: {} }, runBuildTurn: async () => ({}),
      turnBudgetMs: 1000, readsImages: false, platformRepo: false, skipNow: async () => null, onProgress: null,
      start: { sha: 'abc', commits: 1 }, review: { reviewer: { model: 'm', maxRounds: 3, budgetMinutes: 10 }, owner },
    });
    const run = args({ botRunId: 41 });
    await live.reviewLanded(run);
    const rows = run.pool.queries.filter((q) => /INSERT INTO events/.test(q.sql));
    assert.deepEqual(rows.map((q) => [q.params[0], q.params[1], JSON.parse(q.params[3])]), [
      [41, 9, { round: 1, rounds: 3, stage: 'review_round' }],
      [41, 9, { round: 2, rounds: 3, stage: 'review_round' }],
    ]);
    const trial = args({ trialId: 5 });
    await live.reviewLanded(trial);
    assert.deepEqual(trial.pool.queries, [], 'a bench trial has no timeline');
  } finally {
    botReview.runReviewLoop = realLoop;
    botReview.reviewCapture = realReview;
  }
});

test('the pipeline writes each stage where it happens', () => {
  const bot = read('src/services/homeroom-bot.js');
  // Build it: when, kept (go_ahead_at), and as a stage.
  assert.match(bot, /SET awaiting_go_at = NULL, live_build_waiting_at = NOW\(\), go_ahead_at = NOW\(\),/);
  assert.match(bot, /void timeline\.record\(pool, \{ runId, stage: 'go_ahead', detail: \{ answers: chosen\.length \} \}\);/);
  // The plan, written by the triage (a plan from Make it was recorded when it was written).
  assert.match(bot, /if \(!parsed\?\.fromMakeIt\) \{\s+void timeline\.record\(pool, \{ runId, stage: 'plan_written', detail: \{ source: 'triage'/);
  assert.match(bot, /fromMakeIt: true,\s+\};\s+const capSuppressed = await simulateCaps/);
  // Its build takes its slot: how long it waited, logged and a stage.
  assert.match(bot, /const claim = await claimLiveBuild\(pool, \{ runId, sessionId: session\.id \}\);\s+if \(!claim\.claimed\) return LOST_CLAIM;/);
  assert.match(bot, /log\.info\('homeroom-bot', 'A live build took its slot', \{\s+app: app\.slug, issueNumber, runId, sessionId: session\.id, waitedMs, attempt: claims,/);
  assert.match(bot, /stage: 'picked_up', sessionId: session\.id,/);
  // The build's own steps, for a first version only, and nothing else: the
  // build keeps its own steps (durable-steps.js).
  assert.match(bot, /onStep: \(name, data\) => \{[\s\S]{0,200}if \(firstVersion\) \{\s+void timeline\.recordStep\(pool, \{\s+runId, step: name, sessionId: data\.sessionId,[\s\S]{0,300}?\}\);\s+\}\s+\},\n\s+origin: \{ lane: 'live', runId \},/);
  // Its first look, whichever way it was drawn.
  assert.match(bot, /stage: 'first_look_saved', detail: \{ from: 'saved_screen' \}/);
  assert.match(bot, /if \(drawn\) void timeline\.record\(pool, \{ runId, stage: 'first_look_saved', detail: \{ from: 'spec' \} \}\);\s+return drawn;/);
  // Merged, and live: noteProposalMerged is asked once production runs the
  // change (the merge-followups machine), so both are recorded then.
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.match(dm, /SELECT r\.id AS run_id, r\.app_id, r\.issue_number/);
  assert.match(dm, /void timeline\.record\(pool, \{ runId: run\.run_id, stage: 'merged', sessionId: session\.id \}\);/);
  assert.match(dm, /void timeline\.record\(pool, \{ runId: run\.run_id, stage: 'live', sessionId: session\.id \}\);/);
  // And at Make it, before there is a run.
  assert.match(read('src/services/first-version-plan.js'), /appId: app\.id, stage: 'plan_written', detail: \{ source: 'make_it', questions: made\.plan\.questions\.length \},/);
});
