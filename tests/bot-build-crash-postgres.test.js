'use strict';

// A Homeroom bot build killed at every step it saves, and carried on by the
// next process (docs/plans/bot-build-workflow.md, "Verifying it").
//
// Each build runs in a child process with the real workflow runtime, the
// bot-build machine, build-runs.js, durable-steps.js, durable-turn.js and the
// bot's pipeline, against the full schema; only what leaves the box is faked
// (tests/fixtures/bot-build-crash-fakes.js), and the fakes' memory is in
// this process's database (tests/lib/bot-build-crash.js): a coding turn
// dispatched before a kill finishes and pushes after it, whoever is alive.
//
// The scenarios (SCENARIOS): a later change with no review; a first version
// whose review asks for one fix and then ships it; a later change built
// from its kept plan, a cost carried onto it. For each the build runs once
// uninterrupted, recording every durable save. Then, for every save, a
// fresh build is SIGKILLed right before it and right after it, and at the
// fakes' own points (a turn about to be dispatched, a turn under way, the
// pull request opened before its session was marked, a post between its
// row and its GitHub comment); its lease runs out, a new child takes it
// over and finishes it, and the end is compared with the uninterrupted
// run's: the instance done, the run's outcome, one pull request and one
// promotion, each post once and on GitHub, at most one debit, the same
// branch tip, no turn dispatched twice for one step (one under way at the
// kill is followed), no work left, no two claims at once, no turn record or
// ledger attempt left, no second session. Besides: the fix turn still
// running when the next process attaches (bench run 193's shape), a turn
// whose push was refused while nobody was up, a second kill of the process
// that followed a turn, and the fakes' points hit with a clean stop (the
// runtime stops, the build unwinds and gives its lease up), as a release's
// SIGTERM gives one.
//
// A kill point whose comparison fails because of a bug in the pipeline is
// marked todo with the bug (KNOWN_BUGS below): it stays failing, and passes
// once the bug is fixed.
//
// Like the repository's other postgres suites it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.
//
//   BOT_BUILD_CRASH_LANES      builds run at once (default 4), a database each
//   BOT_BUILD_CRASH_ONLY       a,b,…: only the kill points whose name has one
//   BOT_BUILD_CRASH_BUDGET_MS  stop starting kill points after this long
//                              (default 150000); the rest are skipped, so the
//                              file stays under the runner's 180 s timeout
//   BOT_BUILD_CRASH_DEBUG=1    the children's output
//   BOT_BUILD_CRASH_TIMING=1   each run's timeline
//   BOT_BUILD_CRASH_RESULTS=1  what each kill point ended with, as JSON

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const world = require('./lib/bot-build-crash');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const LANES = Math.max(1, Number(process.env.BOT_BUILD_CRASH_LANES) || 4);
const ONLY = process.env.BOT_BUILD_CRASH_ONLY || null;
const BUDGET_MS = Number(process.env.BOT_BUILD_CRASH_BUDGET_MS) || 150000;
const MODEL = 'test/coder';
const REVIEWER = 'test/reviewer';
const CONFIG = {
  dataEncryptionKey: 'synthetic-bot-build-crash-key', wfPoolMax: 3, wfSlots: 2, wfOwnershipMode: 'raise', dbPoolMax: 4,
  codexOpenrouterEnabled: true, openrouterModelHarnesses: { [MODEL]: 'claude' }, openrouterDefaultCodexReasoning: 'low',
};
const SPEC = '# Show who hosts each meeting\n\n## User-facing changes\n\nEach meeting shows who hosts it.\n\n## Technical implementation\n\nA host column on meetings.';
const SAID = 'Added the host column.\n==== DESCRIPTION ====\nEach meeting shows who hosts it.\n==== END DESCRIPTION ====';
const FIX = { ms: 100, commits: 1, text: 'Made the add button bigger.' };

const SCENARIOS = {
  later: {
    title: 'a later change (no review)',
    firstVersion: false,
    plan: { turns: { spec: { ms: 60, text: SPEC }, build: { ms: 80, commits: 1, text: SAID } } },
  },
  review: {
    title: 'a first version reviewed with one fix round',
    firstVersion: true,
    plan: { turns: { spec: { ms: 60, text: SPEC }, build: { ms: 80, commits: 1, text: SAID }, 'fix:1': FIX }, reviewer: ['fix', 'ship'] },
  },
  // A build from the plan a person approved (buildOne's presetSpec), whose
  // plan cost is carried onto the build's own; only the steps from its
  // build's end on are what this one adds.
  kept: {
    title: 'a later change built from its kept plan, its plan\'s cost carried',
    firstVersion: false,
    presetSpec: SPEC,
    carriedCostUsd: 0.3,
    savesFrom: '+try',
    plan: { turns: { build: { ms: 80, commits: 1, text: SAID } } },
  },
};

// The bugs the kill points show, each with where it is and how a kill point
// shows it. A point whose every difference one of these explains is todo;
// a difference none of them explains (two debits, two claims at once, a turn
// dispatched twice) still fails it.
const only = (problems, re) => problems.length > 0 && problems.every((x) => re.test(x));
const OUTCOME = /^(what the build did|run[. ]|pull requests|promotions|posts|GitHub comments|branch tip|turns dispatched per step)/;
const KNOWN_BUGS = [
  {
    id: 'skip-after-promotion',
    shows: (p, got, problems) => got.acted === 'skipped' && only(problems, OUTCOME)
      && /^skipped: the request already has a proposal/.test(String(got.run.build_error || '')),
    text: 'An attempt after the promotion reads the build\'s own proposal as a reason to stop: buildAndPropose re-asks '
      + 'skipNow() on every attempt (homeroom-bot-live.js:3960, also :4121 and :4266, none of them a step), and once the '
      + '`promoted` step (homeroom-bot-live.js:4325) has run but buildLive\'s `try` step (homeroom-bot.js:7732) is not '
      + 'saved yet, whyNotBuild (homeroom-bot.js:8285) -> requestProposal (homeroom-bot.js:8219) finds the session this '
      + 'very build promoted. The build ends "skipped: the request already has a proposal (<its own session>)": the run is '
      + 'build_ok=false with no proposal_session_id and no proposal post, while its pull request is open and up for a vote.',
  },
  {
    id: 'claim-not-idempotent',
    shows: (p, got, problems) => got.acted === 'lost_claim' && only(problems, OUTCOME),
    text: 'The claim is not idempotent: buildAndPropose\'s `claim` step (homeroom-bot-live.js:3780) runs onSession -> '
      + 'claimLiveBuild (homeroom-bot.js:7480), whose UPDATE requires build_session_id IS NULL (homeroom-bot.js:7484). Killed '
      + 'after that UPDATE and before the step is saved, the next attempt runs the claim again, is refused by its own link, '
      + 'and returns LOST_CLAIM (homeroom-bot.js:7638 -> 7764): its session is archived as a lost claim\'s is and the build '
      + 'ends `lost_claim` having recorded nothing. The run is left linked to that archived session, no longer waiting '
      + '(live_build_waiting_at cleared by the claim), build_ok NULL, no proposal, nothing said; its instance is `done`, '
      + 'and nothing asks for the build again.',
  },
  {
    id: 'orphan-session',
    shows: (p, got, problems) => only(problems, /^sessions opened/),
    text: 'The `session` step (homeroom-bot-live.js:3731) INSERTs the chat_sessions row (and sets workflow_owner) before the '
      + 'step is saved; killed in between, the next attempt opens a second session. The first is left `active` with no '
      + 'branch, no turn and no run linking it: nothing in the build puts it away.',
  },
  {
    id: 'lost-post',
    shows: (p, got, problems) => /^comment:\d+:before$/.test(p.point) && only(problems, /^GitHub comments/),
    text: 'A post is at most once, and a kill makes it never: live.post writes its homeroom_bot_posts row first '
      + '(homeroom-bot-live.js:1613) and only then the GitHub comment (:1625), the DM relay and the thread message. Killed '
      + 'between the two, the next attempt finds the row (runPosted, homeroom-bot.js:75, read by onSpec at :7552 and by '
      + 'announceBuilt at :6613) and says nothing: the plan or the proposal never reaches GitHub, the request\'s thread '
      + 'or the requester\'s DM.',
  },
  {
    id: 'carried-cost-twice',
    shows: (p, got, problems) => only(problems, /^run\.build_cost_usd/),
    text: 'buildLive mutates the value its `try` step returned (homeroom-bot.js:7793 `built.costUsd += carriedCostUsd`, '
      + 'and `built.model` above it): durable-steps.js once() hands back the kept object itself, so the next save '
      + '(`debited`, `configs`) writes the mutated value into the checkpoint. An attempt after that save starts from a '
      + '`try` whose cost already holds the carried plan cost and adds it again: the run records build_cost_usd with the '
      + 'plan\'s cost counted twice.',
  },
];

test('bot builds carried on through a crash at every step they save', { timeout: 1500000 }, async (t) => {
  const started = Date.now();
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 2 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const tag = crypto.randomBytes(5).toString('hex');
  const template = `bbc_tpl_${tag}`;
  const lanes = [];
  // The children's compiled code, kept between them (they load the platform each).
  const compileCache = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-build-crash-'));
  const childEnv = {
    HOMEROOM_BOT_SPEC_SCREENS: '0',
    LOG_LEVEL: process.env.BOT_BUILD_CRASH_DEBUG ? 'INFO' : 'ERROR',
    NODE_COMPILE_CACHE: compileCache,
  };
  t.after(async () => {
    await Promise.all(lanes.map((lane) => lane.close().catch(() => {})));
    for (const lane of lanes) await admin.query(`DROP DATABASE IF EXISTS ${lane.name} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`).catch(() => {});
    await admin.end();
    fs.rmSync(compileCache, { recursive: true, force: true });
  });

  // One schema, copied for each lane.
  await admin.query(`CREATE DATABASE ${template}`);
  {
    const p = new Pool({ connectionString: urlOf(template), max: 1 });
    await p.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
    await p.query(world.WORLD_SQL);
    // The bot and its included OpenRouter key (openrouter-managed-keys.js
    // MANAGED_SOURCE); a first-version configuration with a reviewer of two
    // rounds; no later-changes configuration, so a later change is built with
    // the per-stage models.
    await p.query(
      `INSERT INTO users (username, password, is_synthetic, weekly_limit_cents, daily_limit_cents, display_name)
       VALUES ('homeroom_bot', 'x', TRUE, 100000, 100000, 'Homeroom bot')`);
    await p.query(
      `INSERT INTO credentials.user_ai_credentials (user_id, provider, purpose, secret_last4, status, verified_at, metadata)
       SELECT id, 'openrouter', 'coding_agent', 'test', 'valid', NOW(), '{"source": "usernode_managed"}' FROM users WHERE username = 'homeroom_bot'`);
    await p.query(
      `INSERT INTO bot_config_versions (key, label, version, recipe, role, scope)
       VALUES ('reviewed', 'Reviewed', 1, $1, 'current', 'first_version')`,
      [JSON.stringify({ models: { triage: MODEL, spec: MODEL, build: MODEL }, reviewer: { model: REVIEWER, maxRounds: 2, budgetMinutes: 30 }, pack: null })]);
    await p.end();
  }
  for (let i = 0; i < LANES; i += 1) {
    const name = `bbc_${tag}_${i}`;
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
    lanes.push(makeLane(name, i, childEnv));
  }

  // ── The uninterrupted runs ──────────────────────────────────────────
  const baselines = {};
  await Promise.all(Object.entries(SCENARIOS).map(async ([id, scenario], i) => {
    baselines[id] = await lanes[i % lanes.length].run(scenario, {});
  }));
  for (const [id, scenario] of Object.entries(SCENARIOS)) {
    await t.test(`${scenario.title}: uninterrupted, the end every crash below must reach`, () => {
      const b = baselines[id];
      t.diagnostic(`${scenario.title}: ${b.saves.length} saves: ${b.saves.map((s) => `${s.n} ${s.label}`).join(' | ')}`);
      assert.equal(b.state, 'done', b.why);
      assert.equal(b.acted, 'proposed', JSON.stringify({ run: b.run, dispatches: b.dispatches, unexpected: b.unexpected }));
      assert.equal(b.run.build_ok, true, JSON.stringify(b.run));
      assert.ok(b.run.has_proposal);
      assert.equal(b.prs, 1);
      assert.deepEqual(b.posts, ['proposal', 'spec']);
      assert.equal(b.comments, 2);
      assert.equal(b.debits.length, 1);
      assert.deepEqual(b.unexpected, [], 'nothing reached an outside service the fakes do not fake');
      assert.equal(b.sessions, 1);
      if (id === 'review') {
        assert.deepEqual(b.dispatches, { spec: 1, build: 1, 'fix:1': 1 });
        assert.deepEqual(b.reviewerCalls, [1, 2], 'round 1 asked for a fix, round 2 shipped it');
        assert.equal(b.run.build_commits, 2, 'the build and its fix');
      } else if (id === 'kept') {
        assert.deepEqual(b.dispatches, { build: 1 }, 'built from the kept plan: no spec turn');
        assert.equal(b.run.build_cost_usd, 0.5, 'its build turn and the plan it carried');
      } else {
        assert.deepEqual(b.dispatches, { spec: 1, build: 1 });
        assert.equal(b.run.build_commits, 1);
      }
    });
  }

  // ── Every kill point ────────────────────────────────────────────────
  // In the order they run: the fakes' points and the run-193 shape first,
  // then every save of each scenario, then the clean stops, so a run cut
  // short by the time budget loses the least.
  const fakes = [];
  const saves = [];
  const stops = [];
  for (const [id] of Object.entries(SCENARIOS)) {
    const b = baselines[id];
    const scenario = SCENARIOS[id];
    const from = scenario.savesFrom ? b.saves.find((s) => s.label === scenario.savesFrom)?.n || 1 : 1;
    for (const s of b.saves.filter((x) => x.n >= from)) {
      saves.push({ id, point: `save:${s.n}:before`, label: s.label });
      saves.push({ id, point: `save:${s.n}:after`, label: s.label });
    }
    if (scenario.savesFrom) continue;
    for (const step of Object.keys(b.dispatches)) {
      const exec = { id, point: `exec:${step}`, label: `the ${step} turn registered, not yet dispatched` };
      const under = { id, point: `dispatched:${step}`, label: `the ${step} turn under way` };
      fakes.push(exec, under);
      stops.push({ ...exec, mode: 'stop' }, { ...under, mode: 'stop' });
    }
    for (let n = 1; n <= b.comments; n += 1) {
      fakes.push({ id, point: `comment:${n}:before`, label: `post ${n}: its row written, GitHub not yet asked` });
      fakes.push({ id, point: `comment:${n}:after`, label: `post ${n}: GitHub made the comment, its answer lost` });
    }
    const pr = { id, point: 'promote:pr', label: 'the pull request opened, the session not yet marked promoted' };
    fakes.push(pr);
    stops.push({ ...pr, mode: 'stop' });
  }
  // The run-193 shape: the review's fix turn under way at the kill, long
  // enough that the next process finds it still running, and pushing after.
  fakes.unshift({
    id: 'review', point: 'dispatched:fix:1', label: 'the fix turn under way, still running when the next process attaches',
    plan: { turns: { ...SCENARIOS.review.plan.turns, 'fix:1': { ...FIX, ms: 4000 } } },
    expectFollowRunning: true,
  });
  // A turn that finished while no process was up, its push refused by the
  // platform's push proxy (down with it): the next process follows it and
  // pushes its commit from the worker (durable-turn.js followTurn).
  for (const [id, step] of [['later', 'build'], ['review', 'fix:1']]) {
    const turns = SCENARIOS[id].plan.turns;
    fakes.push({
      id, point: `dispatched:${step}`, label: `the ${step} turn finished while nobody was up, its push refused`,
      plan: { turns: { ...turns, [step]: { ...turns[step], ms: 300, pushNeedsPlatform: true } } },
      restartAfterTurns: true, expectRepush: true,
    });
  }
  // Two restarts: the turn under way at the first kill, and the process that
  // followed it killed too, as it read the turn's end and before it kept
  // anything of it; a third process follows the turn again.
  for (const [id, step] of [['later', 'build'], ['review', 'fix:1']]) {
    const turns = SCENARIOS[id].plan.turns;
    fakes.push({
      id, point: `dispatched:${step}`, then: `followed:${step}`,
      label: `the ${step} turn under way, and its follower killed as it read the turn's end`,
      plan: { turns: { ...turns, [step]: { ...turns[step], ms: 1500 } } },
    });
  }
  // The scenarios' saves taken in turn, so a cut leaves none of them untried at the end.
  const byScenario = Object.keys(SCENARIOS).map((id) => saves.filter((x) => x.id === id));
  const interleaved = [];
  for (let i = 0; byScenario.some((list) => i < list.length); i += 1) {
    for (const list of byScenario) if (i < list.length) interleaved.push(list[i]);
  }
  const points = [...fakes, ...interleaved, ...stops];
  const where = (p) => `${p.mode === 'stop' ? 'stopped' : 'killed'} at ${p.point}${p.then ? `, then at ${p.then}` : ''}`;
  const nameOf = (p) => `${p.id} ${where(p)} (${p.label})`;
  const chosen = ONLY ? points.filter((p) => ONLY.split(',').some((s) => `${nameOf(p)} `.includes(s))) : points;

  const results = new Array(chosen.length);
  let next = 0;
  await Promise.all(lanes.map(async (lane) => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= chosen.length) return;
      if (Date.now() - started > BUDGET_MS) { results[i] = { overBudget: true }; continue; }
      const p = chosen[i];
      const scenario = p.plan ? { ...SCENARIOS[p.id], plan: { ...SCENARIOS[p.id].plan, ...p.plan } } : SCENARIOS[p.id];
      try {
        results[i] = await lane.run(scenario, {
          killAt: p.then ? [p.point, p.then] : p.point, killMode: p.mode || 'kill', restartAfterTurns: !!p.restartAfterTurns,
        });
      } catch (err) {
        results[i] = { error: err };
      }
    }
  }));

  const underDebited = [];
  const ensuredUnderTurn = [];
  const todo = new Map();
  for (const [i, p] of chosen.entries()) {
    const scenario = SCENARIOS[p.id];
    const b = baselines[p.id];
    const got = results[i];
    const title = `${scenario.title}: ${where(p)} (${p.label})`;
    if (got.overBudget) {
      await t.test(title, { skip: `not run: past the suite's time budget (BOT_BUILD_CRASH_BUDGET_MS=${BUDGET_MS})` }, () => {});
      continue;
    }
    const problems = got.error ? [] : compare(b, got, p);
    if (process.env.BOT_BUILD_CRASH_RESULTS) console.log(JSON.stringify({ point: nameOf(p), got: { ...got, saves: undefined } }));
    if (!got.error && got.ensureWhileRunning) ensuredUnderTurn.push(`${p.id} ${p.point}`);
    if (!got.error && got.debits.length === 0 && b.debits.length === 1) underDebited.push(`${p.id} ${p.point}`);
    const bug = !got.error && problems.length ? KNOWN_BUGS.find((k) => k.shows(p, got, problems)) : null;
    if (bug) todo.set(bug.id, [...(todo.get(bug.id) || []), `${p.id} ${p.mode || 'kill'} ${p.point}`]);
    await t.test(title, bug ? { todo: `${bug.id}: ${bug.text}` } : {}, () => {
      if (got.error) throw got.error;
      assert.deepEqual(problems, [], `${p.point}: ${problems.join('; ')}`);
    });
  }
  for (const [id, seen] of todo) t.diagnostic(`known bug ${id} shown at: ${seen.join(', ')}`);
  if (underDebited.length) {
    t.diagnostic(`builds left undebited by a kill (debitBuildOnce, homeroom-bot.js:93, saves the step before the debit: under rather than twice): ${underDebited.join(', ')}`);
  }
  if (ensuredUnderTurn.length) {
    t.diagnostic(`a worker made sure (worker.ensureWorker) while a turn of its session ran in it: ${ensuredUnderTurn.join(', ')}`);
  }

  // ── A bench first-version trial ─────────────────────────────────────
  await t.test('a bench first-version trial, killed at every step it saves', {
    todo: 'services/bench/lane.js has no runTrial yet (build-runs.js TARGETS.trial calls it) and still keeps the old bench_trials.checkpoint; this scenario waits for the bench conversion',
  }, () => {
    assert.equal(typeof require('../src/services/bench/lane').runTrial, 'function');
  });
});

// ── Comparing a crashed build with the uninterrupted one ───────────────

function compare(b, got, p) {
  const problems = [];
  const same = (what, x, y) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) problems.push(`${what}: ${JSON.stringify(x)}, uninterrupted ${JSON.stringify(y)}`);
  };
  if (p.mode === 'stop') {
    if (!got.stopped) problems.push(`the child did not stop at ${p.point}`);
    if (got.stopped && !got.endedInStop && !got.leaseGivenUp) problems.push('the stopping process kept its lease (it should give it up)');
  } else if (!got.killed) {
    problems.push(`the children reached ${got.kills} of the kill points ${[p.point, p.then].filter(Boolean).join(', ')}`);
  }
  // The n-th save of this build is the uninterrupted run's n-th: the steps
  // run in one order.
  if (/^save:/.test(p.point) && got.killLabels[0] !== p.label) {
    problems.push(`killed at a different step than the uninterrupted run's save of that number: ${got.killLabels[0]}`);
  }
  same('instance', got.state, 'done');
  same('what the build did', got.acted, b.acted);
  same('run.build_ok', got.run.build_ok, b.run.build_ok);
  same('run has its proposal', got.run.has_proposal, b.run.has_proposal);
  same('run.build_sha', got.run.build_sha, b.run.build_sha);
  same('run.build_commits', got.run.build_commits, b.run.build_commits);
  same('run.build_cost_usd', got.run.build_cost_usd, b.run.build_cost_usd);
  same('pull requests', got.prs, b.prs);
  same('promotions', got.promotions, b.promotions);
  same('posts', got.posts, b.posts);
  same('GitHub comments', got.comments, b.comments);
  same('branch tip', got.tip, b.tip);
  same('turns dispatched per step', got.dispatches, b.dispatches);
  if (got.debits.length > 1) problems.push(`debited ${got.debits.length} times: ${JSON.stringify(got.debits)}`);
  if (got.workLeft) problems.push(`${got.workLeft} work item(s) left queued or running`);
  if (got.overlaps.length) problems.push(`two claims at once: ${got.overlaps.join('; ')}`);
  if (got.leakedRecords) problems.push(`${got.leakedRecords} turn record(s) left on the build's sessions`);
  if (got.runningAttempts) problems.push(`${got.runningAttempts} ledger attempt(s) left running`);
  if (got.unexpected.length) problems.push(`reached unfaked: ${JSON.stringify(got.unexpected)}`);
  if (got.sessions !== b.sessions) problems.push(`sessions opened: ${got.sessions} (${got.sessionStates.join(', ')}), uninterrupted ${b.sessions}`);
  // A turn the restart caught is followed, not dispatched again.
  const step = /^dispatched:(.+)$/.exec(p.point)?.[1];
  if (step && p.mode !== 'stop' && !got.follows.some((f) => f.step === step)) {
    problems.push(`the ${step} turn under way at the kill was not followed (follows: ${JSON.stringify(got.follows)})`);
  }
  if (p.expectRepush && !got.repushed) problems.push(`the ${step} turn's refused push was not pushed again from its worker`);
  if (p.expectFollowRunning && !got.follows.some((f) => f.step === step && f.at === 'running')) {
    problems.push(`the next process did not find the ${step} turn still running (follows: ${JSON.stringify(got.follows)})`);
  }
  return problems;
}

// ── A lane: one database, one build at a time ──────────────────────────

function urlOf(db) {
  const u = new URL(DSN);
  u.pathname = `/${db}`;
  return String(u);
}

function makeLane(name, index, childEnv) {
  const databaseUrl = urlOf(name);
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  pool.on('error', () => {});
  let seq = 0;
  let closed = false;
  // A child loaded and waiting (`warm`), so a restart does not wait for the
  // platform to load; and the child that runs the lane's builds (`current`):
  // the next build is armed in it, until a kill or a stop takes it and the
  // warm one takes its place.
  let warm = null;
  let current = null;
  const fresh = () => world.forkChild({ databaseUrl, config: CONFIG, env: childEnv, label: `${index}` });
  const takeWarm = () => {
    const child = warm || fresh();
    warm = null;
    setImmediate(() => { if (!warm && !closed) warm = fresh(); });
    return child;
  };
  async function runner(killAt, killMode) {
    if (current && !current.exitInfo) {
      await current.arm({ killAt, killMode });
      return current;
    }
    current = takeWarm();
    await current.start({ killAt, killMode });
    // A process is up again: a worker's push goes through.
    await pool.query('UPDATE crash_world_platform SET up = TRUE');
    return current;
  }
  // The fake worker's turns finish here, whoever is alive.
  let settling = false;
  const settler = setInterval(() => {
    if (settling || closed) return;
    settling = true;
    world.settleTurns(pool).catch(() => {}).finally(() => { settling = false; });
  }, 20);

  // One build at a time in a lane: every child of a lane's database runs
  // whichever build is due, as every process of one platform would.
  let queue = Promise.resolve();
  function run(scenario, opts = {}) {
    const mine = queue.then(() => runOne(scenario, opts));
    queue = mine.catch(() => {});
    return mine;
  }

  async function runOne(scenario, { killAt = null, killMode = 'kill', restartAfterTurns = false } = {}) {
    const timing = [];
    const mark = (what) => timing.push([what, Date.now()]);
    mark('begin');
    seq += 1;
    const n = seq;
    const slug = `crash-${index}-${n}`;
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $1, 'running', $2) RETURNING id, slug, repo_url`,
      [slug, `https://github.com/usernode-bot/${slug}`]);
    await pool.query('INSERT INTO crash_world_plans (app_id, plan) VALUES ($1, $2)', [app.id, JSON.stringify(scenario.plan)]);
    const issueNumber = 40 + n;
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at, go_ahead_at,
                                      build_spec_md, build_cost_usd)
       VALUES ($1, $2, 'live', 'ready', 'Show who hosts each meeting.', NOW(), NOW(), $3, $4) RETURNING id, live_build_waiting_at`,
      [app.id, issueNumber, scenario.presetSpec || null, scenario.carriedCostUsd || null]);
    const nonce = `w${new Date(run.live_build_waiting_at).getTime()}`;
    const key = `run:${run.id}@${nonce}`;
    // What buildOne reads and decides, as its work item keeps it (homeroom-bot.js liveBuildInput).
    const input = { args: {
      issueNumber, issue: { number: issueNumber, title: `Request ${issueNumber}`, state: 'open', body: 'Please add it.', user: 'someone' },
      parsed: { verdict: 'ready', buildNote: 'Show who hosts each meeting.' },
      seed: `Build issue #${issueNumber}: Request ${issueNumber}\n\nPlease add it.`, seedReadAt: new Date().toISOString(),
      turnBudgetMs: 20 * 60 * 1000, botLogin: 'usernode-bot', model: MODEL, specModel: MODEL, proposalCeiling: 8,
      firstVersion: !!scenario.firstVersion, presetSpec: scenario.presetSpec || null, carriedCostUsd: scenario.carriedCostUsd || 0,
      complicated: false, plan: null, presetSpecHtml: null,
    } };
    // `killAt` is one point, or a chain: the first child is killed at the
    // first, the one that takes the build over at the second, and so on.
    const chain = Array.isArray(killAt) ? killAt : killAt ? [killAt] : [];
    const children = [];
    let child = await runner(chain[0] || null, killMode);
    children.push(child);
    mark('started');
    // What the bot's dispatch appends (platform.ts requestBuild).
    await pool.query(
      `INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key)
       VALUES ('bot-build', $1, $2, 'Requested', $3, $4, NULL, $5)`,
      [key, app.id, JSON.stringify({ target: 'live', id: run.id, nonce, input }),
        JSON.stringify({ kind: 'system', name: 'bot-build' }), `request:${key}`]);
    await pool.query(`SELECT pg_notify('wf_events', 'bot-build')`);
    const ended = async () => {
      const { rows: [i] } = await pool.query(`SELECT state FROM wf_instances WHERE machine = 'bot-build' AND key = $1`, [key]);
      return i && ['done', 'failed'].includes(i.state);
    };
    const effectOf = async (kind, pid) => !!(await pool.query(
      'SELECT 1 FROM crash_world_effects WHERE kind = $1 AND build = $2 AND pid = $3', [kind, key, pid])).rows[0];
    let kills = 0;
    let stopped = false;
    let endedInStop = false;
    let leaseGivenUp = null;
    let why = null;
    try {
      for (let hop = 0; ; hop += 1) {
        const outcome = await Promise.race([
          child.exited.then(() => 'exited'),
          world.until(ended, `${key} to end`, 90000, 25).then(() => 'ended'),
        ]);
        mark(outcome);
        if (outcome === 'ended') {
          if (killMode === 'stop' && await effectOf('stopping', child.pid)) {
            // It finished what it was doing before the stop reached it.
            await child.exited;
            stopped = true;
            endedInStop = true;
          }
          break;
        }
        if (await effectOf('killed', child.pid)) {
          kills += 1;
          // Its lease runs out (time passing, as after a crash).
          await pool.query(
            `UPDATE wf_work SET lease_until = now() - interval '1 second'
              WHERE machine = 'bot-build' AND key = $1 AND status = 'running'`, [key]);
        } else if (await effectOf('stopping', child.pid)) {
          stopped = true;
          const { rows: [w] } = await pool.query(
            `SELECT status, lease_until <= now() AS free FROM wf_work WHERE machine = 'bot-build' AND key = $1 AND kind = 'build.run'`, [key]);
          leaseGivenUp = !w || w.status !== 'running' || w.free;
        } else {
          throw new Error(`the child died on its own (${JSON.stringify(child.exitInfo)})\n${child.stderr().slice(-3000)}`);
        }
        // Nobody is up until every turn under way has finished.
        if (restartAfterTurns) {
          await world.until(async () => !(await pool.query(
            `SELECT 1 FROM crash_world_turns WHERE app_id = $1 AND status = 'running'`, [app.id])).rows.length,
          'the turns under way to finish', 30000, 20);
        }
        if (await ended()) {
          endedInStop = stopped;
          break;
        }
        child = await runner(chain[hop + 1] || null, 'kill');
        children.push(child);
        mark('restarted');
      }
    } catch (err) {
      why = err.message;
    }
    // The result event is applied at once: the work is settled.
    await world.until(async () => !(await pool.query(
      `SELECT 1 FROM wf_work WHERE machine = 'bot-build' AND key = $1 AND status IN ('reported')`, [key])).rows.length,
    'the result to be applied', 5000).catch(() => {});
    mark('settled');
    const out = await collect(pool, { app, run, key, children });
    mark('collected');
    if (process.env.BOT_BUILD_CRASH_TIMING) {
      console.log(`[lane ${index}] ${chain.length ? `${killMode} ${chain.join(' then ')}` : 'uninterrupted'}: ${timing.slice(1).map(([w, at], i) => `${w} +${at - timing[i][1]}`).join(' ')}`);
    }
    return {
      ...out, killed: chain.length > 0 && kills === chain.length, kills, stopped, endedInStop, leaseGivenUp,
      why: why || (out.state !== 'done' ? children.map((c) => c.stderr().slice(-2000)).join('\n---\n') : null),
    };
  }

  return {
    name,
    run,
    async close() {
      closed = true;
      clearInterval(settler);
      if (current) await current.stop({ graceMs: 5000 });
      if (warm) await warm.kill();
      await pool.end().catch(() => {});
    },
  };
}

async function collect(pool, { app, run, key, children }) {
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const all = async (sql, args) => (await pool.query(sql, args)).rows;
  const repo = String(app.repo_url).replace('https://github.com/', '');
  const inst = await one(`SELECT state, data FROM wf_instances WHERE machine = 'bot-build' AND key = $1`, [key]);
  const r = await one(
    `SELECT build_ok, build_sha, build_commits, build_error, proposal_session_id, build_session_id, build_cost_usd,
            live_build_waiting_at
       FROM homeroom_bot_runs WHERE id = $1`, [run.id]);
  const effects = await all(`SELECT kind, data, pid, build, at FROM crash_world_effects WHERE app_id = $1 OR build = $2 ORDER BY id`, [app.id, key]);
  const of = (kind) => effects.filter((e) => e.kind === kind);
  // The branch of the build's session (its proposal's, when it has one).
  const built = r.proposal_session_id || r.build_session_id;
  const session = built ? await one('SELECT branch_name FROM chat_sessions WHERE id = $1', [built]) : null;
  const tipRow = session ? await one('SELECT sha FROM crash_world_branches WHERE repo = $1 AND branch = $2', [repo, session.branch_name]) : null;
  const dispatches = {};
  for (const e of of('turn.dispatch')) dispatches[e.data.step] = (dispatches[e.data.step] || 0) + 1;
  // Each process's run of the handler, from its start to its end, or to
  // the moment its process died: no two may overlap.
  const deaths = new Map(children.map((c) => [c.pid, c.exitInfo?.at || Date.now()]));
  const runs = [];
  for (const e of effects.filter((x) => x.build === key && (x.kind === 'handler.enter' || x.kind === 'handler.exit'))) {
    if (e.kind === 'handler.enter') runs.push({ pid: e.pid, from: e.at.getTime(), to: null });
    else {
      const open = runs.find((x) => x.pid === e.pid && x.to == null);
      if (open) open.to = e.at.getTime();
    }
  }
  for (const x of runs) if (x.to == null) x.to = deaths.get(x.pid) || Date.now();
  const overlaps = [];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      if (runs[i].from < runs[j].to && runs[j].from < runs[i].to) overlaps.push(`pid ${runs[i].pid} and pid ${runs[j].pid}`);
    }
  }
  // And the kernel's claims: each attempt over before the next was made.
  const attempts = await all(
    `SELECT a.number, a.started_at, a.finished_at, a.outcome FROM wf_work_attempts a JOIN wf_work w ON w.id = a.work_id
      WHERE w.machine = 'bot-build' AND w.key = $1 AND w.kind = 'build.run' ORDER BY a.number`, [key]);
  for (let i = 1; i < attempts.length; i += 1) {
    const prev = attempts[i - 1];
    if (!prev.finished_at || prev.finished_at > attempts[i].started_at) overlaps.push(`attempt ${prev.number} was still live when ${attempts[i].number} was claimed`);
  }
  const sessions = await all('SELECT id, status, branch_name, active_turn FROM chat_sessions WHERE app_id = $1 ORDER BY id', [app.id]);
  return {
    state: inst?.state || null,
    acted: inst?.data?.result?.acted ?? null,
    run: {
      build_ok: r.build_ok, build_sha: r.build_sha, build_commits: r.build_commits, build_error: r.build_error,
      build_cost_usd: r.build_cost_usd == null ? null : Math.round(Number(r.build_cost_usd) * 1e6) / 1e6,
      has_proposal: r.proposal_session_id != null,
    },
    prs: Number((await one('SELECT count(*)::int AS n FROM crash_world_prs WHERE repo = $1', [repo])).n),
    posts: (await all('SELECT kind FROM homeroom_bot_posts WHERE app_id = $1 ORDER BY kind', [app.id])).map((p) => p.kind),
    comments: of('github.comment').length,
    tip: tipRow?.sha || null,
    debits: effects.filter((e) => e.kind === 'debit' && e.build === key).map((e) => e.data.cents),
    dispatches,
    reviewerCalls: of('reviewer.call').map((e) => e.data.round),
    follows: of('turn.follow').map((e) => e.data),
    saves: of('save').filter((e) => e.build === key && e.pid === children[0].pid).map((e) => e.data),
    workLeft: Number((await one(
      `SELECT count(*)::int AS n FROM wf_work WHERE machine = 'bot-build' AND key = $1 AND status IN ('queued', 'running')`, [key])).n),
    overlaps,
    leakedRecords: sessions.filter((s) => s.active_turn).length,
    runningAttempts: Number((await one(
      `SELECT count(*)::int AS n FROM agent_turns WHERE session_id = ANY($1::int[]) AND status = 'running'`,
      [sessions.map((s) => s.id)])).n),
    sessions: sessions.length,
    sessionStates: sessions.map((x) => `${x.status}${x.branch_name ? '' : ' without a branch'}`),
    runLeft: { build_session_id: r.build_session_id, waiting: r.live_build_waiting_at != null },
    unexpected: effects.filter((e) => e.kind === 'fake.unexpected' || e.kind === 'net.refused').map((e) => e.data),
    ensureWhileRunning: of('worker.ensure').filter((e) => e.data.turnRunning).length,
    repushed: of('push').some((e) => e.data.by === 'execPushFromWorker'),
    promotions: of('promote').length,
    killLabels: effects.filter((e) => e.build === key && e.kind === 'killed').map((e) => e.data.label ?? null),
  };
}
