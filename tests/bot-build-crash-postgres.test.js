'use strict';

// A Homeroom bot build, or an App bench trial, killed at every step it
// saves, and carried on by the next process (docs/plans/bot-build-workflow.md,
// "Verifying it").
//
// Each build runs in a child process with the real workflow runtime, the
// bot-build machine, build-runs.js, durable-steps.js, durable-turn.js and the
// pipeline (the bot's, or the bench lane's and runner's), against the full
// schema; only what leaves the box is faked
// (tests/fixtures/bot-build-crash-fakes.js), and the fakes' memory is in
// this process's database (tests/lib/bot-build-crash.js): a coding turn
// dispatched before a kill finishes and pushes after it, whoever is alive.
//
// The scenarios (SCENARIOS): a later change with no review; a first version
// whose review asks for one fix and then ships it; a later change built
// from its kept plan, a cost carried onto it; and a bench first-version
// trial (its first commit, its branch, a triage, the plan, a spec, a build
// reviewed with one fix round, the screenshot step, the trial recorded).
// For each the build runs once uninterrupted, recording every durable save.
// Then, for every save, a fresh build is SIGKILLed right before it and right
// after it, and at the fakes' own points (a turn about to be dispatched, a
// turn under way, the pull request opened before its session was marked, a
// post between its row and its GitHub comment, the trial's first commit
// half made); its lease runs out, a new child takes it over and finishes
// it, and the end is compared with the uninterrupted run's:
//
//   a bot build   the instance done, the run's outcome, one pull request and
//                 one promotion, each post once and on GitHub, at most one
//                 debit, the same branch tip, no second session;
//   a trial       recorded once (its status, cost and commits; the run
//                 charged its cost once), its branch never moved once a turn
//                 pushed to it, one session per part, its first commit kept
//                 once (made again only when a kill lost it), its
//                 screenshots kept;
//   both          no turn dispatched twice for one step (one under way at the
//                 kill is followed), no work left, no two claims at once, no
//                 turn record or ledger attempt left.
//
// Besides: the fix turn still running when the next process attaches (bench
// run 193's shape), a turn whose push was refused while nobody was up, a
// second kill of the process that followed a turn, and the fakes' points
// hit with a clean stop (the runtime stops, the build unwinds and gives its
// lease up, keeping a step it finished), as a release's SIGTERM gives one.
//
// A kill point whose comparison fails because of a known bug is marked todo
// with it (KNOWN_BUGS below): it stays failing, and passes once the bug is
// fixed.
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
// What a first version's triage answers: ready, with a plan for its creator.
const TRIAGE = `I read the request.\n\`\`\`json\n${JSON.stringify({
  verdict: 'ready', determined: true, missing_fact: 'none', build_note: 'A habit list with a check for each day.',
  plan: ['A list of habits', 'A check for each day'],
})}\n\`\`\``;
const FV_SPEC = '# Habit Hero\n\n## User-facing changes\n\nA list of habits, each with a check for today.\n\n## Technical implementation\n\nA habits table and one screen.';
const FV_SAID = 'Built the habit list.\n==== DESCRIPTION ====\nA list of habits with a daily check.\n==== END DESCRIPTION ====';

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
  // A bench first-version trial (bench/runner.js firstVersionStage), built by
  // the reviewed configuration (`config:<id>`): its first commit, a triage, a
  // spec, a build and one review fix, then the screenshot step.
  trial: {
    title: 'a bench first-version trial reviewed with one fix round',
    target: 'trial',
    plan: {
      turns: {
        triage: { ms: 60, text: TRIAGE }, spec: { ms: 60, text: FV_SPEC }, build: { ms: 80, commits: 1, text: FV_SAID }, 'fix:1': FIX,
      },
      reviewer: ['fix', 'ship'],
    },
  },
};

// The bugs the kill points show, each with where it is and how a kill point
// shows it: { id, shows(point, got, problems), text }. A point one of these
// explains is todo; one none of them explains still fails. The five this
// suite found first (a build resumed after its promotion stopping on its own
// proposal, a claim refused by its own link, a second session, a post lost
// between its row and its comment, a carried cost counted twice) are fixed.
// None today: each bug the kill points showed is fixed, and its points are
// plain asserts. A new one may be listed here while its fix is under way,
// with where it is and how a kill point shows it (`shows`), so its points
// are todo rather than failing.
const KNOWN_BUGS = [];

test('bot builds and bench trials carried on through a crash at every step they save', { timeout: 1500000 }, async (t) => {
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
    // The bot and the bench's user, each with its included OpenRouter key
    // (openrouter-managed-keys.js MANAGED_SOURCE); a first-version
    // configuration with a reviewer of two rounds; no later-changes
    // configuration, so a later change is built with the per-stage models.
    await p.query(
      `INSERT INTO users (username, password, is_synthetic, weekly_limit_cents, daily_limit_cents, display_name)
       VALUES ('homeroom_bot', 'x', TRUE, 100000, 100000, 'Homeroom bot'), ('homeroom_bench', 'x', TRUE, 100000, 100000, NULL)`);
    await p.query(
      `INSERT INTO credentials.user_ai_credentials (user_id, provider, purpose, secret_last4, status, verified_at, metadata)
       SELECT id, 'openrouter', 'coding_agent', 'test', 'valid', NOW(), '{"source": "usernode_managed"}'
         FROM users WHERE username IN ('homeroom_bot', 'homeroom_bench')`);
    await p.query(
      `INSERT INTO bot_config_versions (key, label, version, recipe, role, scope)
       VALUES ('reviewed', 'Reviewed', 1, $1, 'current', 'first_version')`,
      [JSON.stringify({ models: { triage: MODEL, spec: MODEL, build: MODEL }, reviewer: { model: REVIEWER, maxRounds: 2, budgetMinutes: 30 }, pack: null })]);
    await p.end();
  }
  for (let i = 0; i < LANES; i += 1) {
    const name = `bbc_${tag}_${i}`;
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
    // A build still going this long after the budget ran out is called stuck:
    // the file ends inside the runner's 180 s, its teardown included.
    lanes.push(makeLane(name, i, childEnv, started + BUDGET_MS + 20000));
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
      assert.equal(b.debits.length, 1, 'a bot build debits the bot once; a trial, the bench user (lane.js recordTrial)');
      assert.deepEqual(b.unexpected, [], 'nothing reached an outside service the fakes do not fake');
      if (scenario.target === 'trial') {
        assert.equal(b.acted, 'ok', JSON.stringify({ trial: b.trial, dispatches: b.dispatches }));
        assert.equal(b.trial.status, 'ok', JSON.stringify(b.trial));
        assert.equal(b.trial.error, null);
        assert.equal(b.trial.build_commits, 2, 'the build and its fix');
        assert.equal(b.trial.build_sha, b.tip, 'recorded at the branch\'s tip');
        assert.ok(b.trial.cost_usd > 0, 'what its turns cost');
        assert.equal(b.spent, b.trial.cost_usd, 'the run charged the trial\'s cost once');
        assert.equal(b.trial.booted, true, 'its screenshot step saw it boot');
        assert.ok(b.artifacts > 0, 'its screenshots kept');
        assert.deepEqual(b.dispatches, { triage: 1, spec: 1, build: 1, 'fix:1': 1 });
        assert.deepEqual(b.reviewerCalls, [1, 2], 'round 1 asked for a fix, round 2 shipped it');
        assert.equal(b.sessions, 2, 'a triage session and a build session');
        assert.equal(new Set(b.sessionSteps).size, 2, `one session per part: ${JSON.stringify(b.sessionSteps)}`);
        assert.ok(b.sessionSteps.some((s) => /(^|\/)session:triage$/.test(s)), `a triage session: ${JSON.stringify(b.sessionSteps)}`);
        assert.equal(b.rootCommits, 1);
        assert.deepEqual(b.repinned, [], 'its branch never moved once a turn pushed to it');
        return;
      }
      assert.equal(b.acted, 'proposed', JSON.stringify({ run: b.run, dispatches: b.dispatches, unexpected: b.unexpected }));
      assert.equal(b.run.build_ok, true, JSON.stringify(b.run));
      assert.ok(b.run.has_proposal);
      assert.equal(b.prs, 1);
      assert.deepEqual(b.posts, ['proposal', 'spec']);
      assert.equal(b.comments, 2);
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
  // Reported in the order below. They run in another (runOrder): the fakes'
  // points, the run-193 shape and the clean stops first, then the saves,
  // the scenarios' taken in turn and each scenario's spread over the whole
  // build, so a run cut short by the time budget skips a few saves from
  // everywhere rather than every build's end.
  const fakes = [];
  const saves = [];
  const stops = [];
  for (const [id] of Object.entries(SCENARIOS)) {
    const b = baselines[id];
    const scenario = SCENARIOS[id];
    const from = scenario.savesFrom ? b.saves.find((s) => s.label === scenario.savesFrom)?.n || 1 : 1;
    for (const s of b.saves.filter((x) => x.n >= from)) {
      saves.push({ id, point: `save:${s.n}:before`, label: s.label });
      // A save that changed nothing leaves the build as it was before it:
      // killed after it is killed before it.
      if (s.label !== '(same)') saves.push({ id, point: `save:${s.n}:after`, label: s.label });
    }
    if (scenario.savesFrom) continue;
    for (const step of Object.keys(b.dispatches)) {
      const exec = { id, point: `exec:${step}`, label: `the ${step} turn registered, not yet dispatched` };
      const under = { id, point: `dispatched:${step}`, label: `the ${step} turn under way` };
      fakes.push(exec, under);
      stops.push({ ...exec, mode: 'stop' }, { ...under, mode: 'stop' });
    }
    if (scenario.target === 'trial') {
      // The first commit a trial's branch is cut at, half made: claimed
      // (bench_scaffolds), the commit not yet made, or made and not yet kept.
      fakes.push({ id, point: 'rootCommit:before', label: 'its first commit claimed, not yet made' });
      fakes.push({ id, point: 'rootCommit:after', label: 'its first commit made, not yet kept' });
      continue;
    }
    for (let n = 1; n <= b.comments; n += 1) {
      fakes.push({ id, point: `comment:${n}:before`, label: `post ${n}: its row written, GitHub not yet asked` });
      fakes.push({ id, point: `comment:${n}:after`, label: `post ${n}: GitHub made the comment, its answer lost` });
    }
    const pr = { id, point: 'promote:pr', label: 'the pull request opened, the session not yet marked promoted' };
    fakes.push(pr);
    stops.push({ ...pr, mode: 'stop' });
  }
  // The run-193 shape, in a bot build and in the bench trial it happened
  // in: the review's fix turn under way at the kill, long enough that the
  // next process finds it still running, and pushing after.
  for (const id of ['review', 'trial']) {
    fakes.unshift({
      id, point: 'dispatched:fix:1', label: 'the fix turn under way, still running when the next process attaches',
      plan: { turns: { ...SCENARIOS[id].plan.turns, 'fix:1': { ...FIX, ms: 4000 } } },
      expectFollowRunning: true,
    });
  }
  // A turn that finished while no process was up, its push refused by the
  // platform's push proxy (down with it): the next process follows it and
  // pushes its commit from the worker (durable-turn.js followTurn).
  for (const [id, step] of [['later', 'build'], ['review', 'fix:1'], ['trial', 'fix:1']]) {
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
  for (const [id, step] of [['later', 'build'], ['review', 'fix:1'], ['trial', 'build']]) {
    const turns = SCENARIOS[id].plan.turns;
    fakes.push({
      id, point: `dispatched:${step}`, then: `followed:${step}`,
      label: `the ${step} turn under way, and its follower killed as it read the turn's end`,
      plan: { turns: { ...turns, [step]: { ...turns[step], ms: 1500 } } },
    });
  }
  const points = [...fakes, ...saves, ...stops];
  const where = (p) => `${p.mode === 'stop' ? 'stopped' : 'killed'} at ${p.point}${p.then ? `, then at ${p.then}` : ''}`;
  const nameOf = (p) => `${p.id} ${where(p)} (${p.label})`;
  const chosen = ONLY ? points.filter((p) => ONLY.split(',').some((s) => `${nameOf(p)} `.includes(s))) : points;
  const order = runOrder(chosen);

  const results = new Array(chosen.length);
  let next = 0;
  await Promise.all(lanes.map(async (lane) => {
    for (;;) {
      if (next >= order.length) return;
      const i = order[next];
      next += 1;
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
  let skipped = 0;
  for (const [i, p] of chosen.entries()) {
    const scenario = SCENARIOS[p.id];
    const b = baselines[p.id];
    const got = results[i];
    const title = `${scenario.title}: ${where(p)} (${p.label})`;
    if (got.overBudget) {
      skipped += 1;
      await t.test(title, { skip: `not run: past the suite's time budget (BOT_BUILD_CRASH_BUDGET_MS=${BUDGET_MS})` }, () => {});
      continue;
    }
    const problems = got.error ? [] : compare(b, got, p);
    if (process.env.BOT_BUILD_CRASH_RESULTS) console.log(JSON.stringify({ point: nameOf(p), got: { ...got, saves: undefined } }));
    const bug = !got.error && problems.length ? KNOWN_BUGS.find((k) => k.shows(p, got, problems)) : null;
    if (!got.error && got.ensureWhileRunning) ensuredUnderTurn.push(`${p.id} ${p.point}`);
    if (!got.error && !bug && got.debits.length === 0 && b.debits.length === 1) underDebited.push(`${p.id} ${p.point}`);
    if (bug) todo.set(bug.id, [...(todo.get(bug.id) || []), `${p.id} ${p.mode || 'kill'} ${p.point}`]);
    await t.test(title, bug ? { todo: `${bug.id}: ${bug.text}` } : {}, () => {
      if (got.error) throw got.error;
      assert.deepEqual(problems, [], `${p.point}: ${problems.join('; ')}`);
    });
  }
  for (const [id, seen] of todo) t.diagnostic(`known bug ${id} shown at: ${seen.join(', ')}`);
  if (underDebited.length) {
    t.diagnostic(`builds left undebited by a kill (homeroom-bot.js debitBuildOnce saves its step before the debit, lane.js recordTrial charges after the trial's row: under rather than twice): ${underDebited.join(', ')}`);
  }
  if (ensuredUnderTurn.length) {
    t.diagnostic(`a worker made sure (worker.ensureWorker) while a turn of its session ran in it: ${ensuredUnderTurn.join(', ')}`);
  }
  t.diagnostic(`${chosen.length - skipped} of ${chosen.length} kill points run in ${Math.round((Date.now() - started) / 1000)} s on ${LANES} lanes`);
});

/**
 * The order kill points run in, as indices into `points`: every point but
 * a save first, as listed; then the saves, one scenario's after another's in
 * turn, each scenario's in the van der Corput order of its list, so any
 * prefix of it is spread evenly over the build. Pure.
 */
function runOrder(points) {
  const isSave = (p) => p.mode !== 'stop' && /^save:/.test(p.point);
  const first = [...points.keys()].filter((i) => !isSave(points[i]));
  const spread = (list) => {
    const bits = Math.max(1, Math.ceil(Math.log2(list.length)));
    const rev = (i) => parseInt(i.toString(2).padStart(bits, '0').split('').reverse().join(''), 2);
    return list.map((x, i) => [rev(i), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  };
  const ids = [...new Set(points.map((p) => p.id))];
  const lists = ids.map((id) => spread([...points.keys()].filter((i) => isSave(points[i]) && points[i].id === id)));
  const saves = [];
  for (let k = 0; lists.some((l) => k < l.length); k += 1) for (const l of lists) if (k < l.length) saves.push(l[k]);
  return [...first, ...saves];
}

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
  if (got.timedOut) problems.push(`it did not end: ${got.why}`);
  // The n-th save of this build is the uninterrupted run's n-th: the steps
  // run in one order.
  if (/^save:/.test(p.point) && got.killLabels[0] !== p.label) {
    problems.push(`killed at a different step than the uninterrupted run's save of that number: ${got.killLabels[0]}`);
  }
  same('instance', got.state, 'done');
  same('what the build did', got.acted, b.acted);
  if (got.trial) {
    same('trial.status', got.trial.status, b.trial.status);
    same('trial.error', got.trial.error, b.trial.error);
    same('trial.build_sha', got.trial.build_sha, b.trial.build_sha);
    same('trial.build_commits', got.trial.build_commits, b.trial.build_commits);
    same('trial.cost_usd', got.trial.cost_usd, b.trial.cost_usd);
    same('trial.booted', got.trial.booted, b.trial.booted);
    same('the run\'s spend', got.spent, b.spent);
    same('screenshots kept', got.artifacts, b.artifacts);
    same('first commits kept', got.scaffolds, b.scaffolds);
    // One made and lost at a kill (made, not yet kept) is made again; no more.
    if (got.rootCommits < b.rootCommits || got.rootCommits > b.rootCommits + got.kills) {
      problems.push(`first commits made: ${got.rootCommits}, uninterrupted ${b.rootCommits}, with ${got.kills} kill(s)`);
    }
    same('sessions, by part', got.sessionSteps, b.sessionSteps);
    if (got.repinned.length) problems.push(`its branch moved after a turn pushed to it: ${got.repinned.join('; ')}`);
  } else {
    same('run.build_ok', got.run.build_ok, b.run.build_ok);
    same('run has its proposal', got.run.has_proposal, b.run.has_proposal);
    same('run.build_sha', got.run.build_sha, b.run.build_sha);
    same('run.build_commits', got.run.build_commits, b.run.build_commits);
    same('run.build_cost_usd', got.run.build_cost_usd, b.run.build_cost_usd);
    same('pull requests', got.prs, b.prs);
    same('promotions', got.promotions, b.promotions);
    same('posts', got.posts, b.posts);
    same('GitHub comments', got.comments, b.comments);
  }
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

// How long a build may take to end before the run is called stuck (a trial
// waiting on something nobody will finish), and the child running it killed;
// less once the lane's `deadline` is near.
const END_WAIT_MS = 30000;

function makeLane(name, index, childEnv, deadline = Infinity) {
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

  const waitFor = (ms) => Math.max(5000, Math.min(ms, deadline - Date.now()));

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
    const build = scenario.target === 'trial' ? await trialBuild(pool, app, n) : await liveBuild(pool, app, n, scenario);
    const { key } = build;
    // `killAt` is one point, or a chain: the first child is killed at the
    // first, the one that takes the build over at the second, and so on.
    const chain = Array.isArray(killAt) ? killAt : killAt ? [killAt] : [];
    const children = [];
    let child = await runner(chain[0] || null, killMode);
    children.push(child);
    mark('started');
    // What the bot's dispatch, or the bench lane, appends (platform.ts requestBuild).
    await pool.query(
      `INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key)
       VALUES ('bot-build', $1, $2, 'Requested', $3, $4, NULL, $5)`,
      [key, app.id, JSON.stringify(build.payload), JSON.stringify({ kind: 'system', name: 'bot-build' }), `request:${key}`]);
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
    let timedOut = false;
    let why = null;
    try {
      for (let hop = 0; ; hop += 1) {
        const outcome = await Promise.race([
          child.exited.then(() => 'exited'),
          world.until(ended, `${key} to end`, waitFor(END_WAIT_MS), 25).then(() => 'ended'),
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
          'the turns under way to finish', waitFor(30000), 20);
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
      // A build that did not end is still under way in its child: that child
      // goes, so the next run starts in one of its own.
      if (/^timed out/.test(why)) {
        timedOut = true;
        if (current && !current.exitInfo) await current.kill();
      }
    }
    // The result event is applied at once: the work is settled.
    await world.until(async () => !(await pool.query(
      `SELECT 1 FROM wf_work WHERE machine = 'bot-build' AND key = $1 AND status IN ('reported')`, [key])).rows.length,
    'the result to be applied', 5000).catch(() => {});
    mark('settled');
    const out = await collect(pool, { app, key, children, build });
    mark('collected');
    if (process.env.BOT_BUILD_CRASH_TIMING) {
      console.log(`[lane ${index}] ${chain.length ? `${killMode} ${chain.join(' then ')}` : 'uninterrupted'}: ${timing.slice(1).map(([w, at], i) => `${w} +${at - timing[i][1]}`).join(' ')}`);
    }
    return {
      ...out, killed: chain.length > 0 && kills === chain.length, kills, stopped, endedInStop, leaseGivenUp, timedOut,
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

/** A live build waiting for its slot, as buildOne starts one. */
async function liveBuild(pool, app, n, scenario) {
  const issueNumber = 40 + n;
  const { rows: [run] } = await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at, go_ahead_at,
                                    build_spec_md, build_cost_usd)
     VALUES ($1, $2, 'live', 'ready', 'Show who hosts each meeting.', NOW(), NOW(), $3, $4) RETURNING id, live_build_waiting_at`,
    [app.id, issueNumber, scenario.presetSpec || null, scenario.carriedCostUsd || null]);
  const nonce = `w${new Date(run.live_build_waiting_at).getTime()}`;
  // What buildOne reads and decides, as its work item keeps it (homeroom-bot.js liveBuildInput).
  const input = { args: {
    issueNumber, issue: { number: issueNumber, title: `Request ${issueNumber}`, state: 'open', body: 'Please add it.', user: 'someone' },
    parsed: { verdict: 'ready', buildNote: 'Show who hosts each meeting.' },
    seed: `Build issue #${issueNumber}: Request ${issueNumber}\n\nPlease add it.`, seedReadAt: new Date().toISOString(),
    turnBudgetMs: 20 * 60 * 1000, botLogin: 'usernode-bot', model: MODEL, specModel: MODEL, proposalCeiling: 8,
    firstVersion: !!scenario.firstVersion, presetSpec: scenario.presetSpec || null, carriedCostUsd: scenario.carriedCostUsd || 0,
    complicated: false, plan: null, presetSpecHtml: null,
  } };
  return { kind: 'live', key: `run:${run.id}@${nonce}`, runId: run.id, payload: { target: 'live', id: run.id, nonce, input } };
}

/**
 * A bench first-version trial as the lane leaves it once it claimed it
 * (lane.js tick): a one-task suite and run, the trial `running`, its first
 * claim. Its model is the reviewed configuration (`config:<id>`).
 */
async function trialBuild(pool, app, n) {
  const snapshots = require('../src/services/homeroom-bot-snapshots');
  const snapshotId = await snapshots.recordSnapshot(pool, {
    runId: null, stage: 'build', appId: app.id, issueNumber: 1, source: 'import',
    texts: { brief: 'A habit tracker: a list of habits and a check for each day.' },
    extra: { taste: 'first_version', appName: 'Habit Hero' },
  });
  if (!snapshotId) throw new Error('could not record the task\'s snapshot');
  const token = () => crypto.randomBytes(8).toString('hex');
  const { rows: [{ id: configId }] } = await pool.query(`SELECT id FROM bot_config_versions WHERE key = 'reviewed'`);
  const model = `config:${configId}`;
  const { rows: [suite] } = await pool.query(`INSERT INTO bench_suites (name, version) VALUES ($1, 1) RETURNING id`, [`crash ${app.slug}`]);
  const { rows: [task] } = await pool.query(
    `INSERT INTO bench_tasks (suite_id, stage, snapshot_id, app_id, tags, reference, reference_source, label_token)
     VALUES ($1, 'first_version', $2, $3, '{}', '{}', 'authored', $4) RETURNING id`, [suite.id, snapshotId, app.id, token()]);
  const { rows: [benchRun] } = await pool.query(
    `INSERT INTO bench_runs (suite_id, models, stages, repeats, cap_usd, concurrency, status, started_at)
     VALUES ($1, ARRAY[$2]::text[], ARRAY['first_version']::text[], 1, 50, 1, 'running', NOW()) RETURNING id`, [suite.id, model]);
  const { rows: [trial] } = await pool.query(
    `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, claims, est_cost_usd, started_at, first_started_at)
     VALUES ($1, $2, $3, 1, 'running', $4, 1, 1, NOW(), NOW()) RETURNING id`, [benchRun.id, task.id, model, token()]);
  const nonce = `c1.${(Date.now() + n).toString(36)}`;
  return {
    kind: 'trial', key: `trial:${trial.id}@${nonce}`, trialId: trial.id, benchRunId: benchRun.id,
    branch: `bench/r${benchRun.id}-t${trial.id}`, payload: { target: 'trial', id: trial.id, nonce, input: {} },
  };
}

async function collect(pool, { app, key, children, build }) {
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const all = async (sql, args) => (await pool.query(sql, args)).rows;
  const repo = String(app.repo_url).replace('https://github.com/', '');
  const inst = await one(`SELECT state, data FROM wf_instances WHERE machine = 'bot-build' AND key = $1`, [key]);
  const effects = await all(`SELECT kind, data, pid, build, at FROM crash_world_effects WHERE app_id = $1 OR build = $2 ORDER BY id`, [app.id, key]);
  const of = (kind) => effects.filter((e) => e.kind === kind);
  // The turns the worker was handed, by step: its own rows, which a stop
  // cutting the dispatch after the hand-off cannot leave unrecorded.
  const dispatches = {};
  for (const { step } of await all('SELECT step FROM crash_world_turns WHERE app_id = $1 ORDER BY id', [app.id])) {
    dispatches[step] = (dispatches[step] || 0) + 1;
  }
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
  const sessions = await all('SELECT id, status, branch_name, workflow_step, active_turn FROM chat_sessions WHERE app_id = $1 ORDER BY id', [app.id]);
  const result = inst?.data?.result || null;
  const out = {
    state: inst?.state || null,
    acted: result?.acted ?? result?.status ?? null,
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
    unexpected: effects.filter((e) => e.kind === 'fake.unexpected' || e.kind === 'net.refused').map((e) => e.data),
    ensureWhileRunning: of('worker.ensure').filter((e) => e.data.turnRunning).length,
    repushed: of('push').some((e) => e.data.by === 'execPushFromWorker'),
    killLabels: effects.filter((e) => e.build === key && e.kind === 'killed').map((e) => e.data.label ?? null),
  };
  if (build.kind === 'trial') return { ...out, ...await collectTrial(pool, { build, repo, effects, sessions }) };

  const r = await one(
    `SELECT build_ok, build_sha, build_commits, build_error, proposal_session_id, build_session_id, build_cost_usd,
            live_build_waiting_at
       FROM homeroom_bot_runs WHERE id = $1`, [build.runId]);
  // The branch of the build's session (its proposal's, when it has one).
  const built = r.proposal_session_id || r.build_session_id;
  const session = built ? await one('SELECT branch_name FROM chat_sessions WHERE id = $1', [built]) : null;
  const tipRow = session ? await one('SELECT sha FROM crash_world_branches WHERE repo = $1 AND branch = $2', [repo, session.branch_name]) : null;
  return {
    ...out,
    run: {
      build_ok: r.build_ok, build_sha: r.build_sha, build_commits: r.build_commits, build_error: r.build_error,
      build_cost_usd: r.build_cost_usd == null ? null : Math.round(Number(r.build_cost_usd) * 1e6) / 1e6,
      has_proposal: r.proposal_session_id != null,
    },
    runLeft: { build_session_id: r.build_session_id, waiting: r.live_build_waiting_at != null },
    prs: Number((await one('SELECT count(*)::int AS n FROM crash_world_prs WHERE repo = $1', [repo])).n),
    posts: (await all('SELECT kind FROM homeroom_bot_posts WHERE app_id = $1 ORDER BY kind', [app.id])).map((p) => p.kind),
    comments: of('github.comment').length,
    tip: tipRow?.sha || null,
    promotions: of('promote').length,
  };
}

/** What a trial's end left: its row, its run's spend, its branch and what moved it. */
async function collectTrial(pool, { build, repo, effects, sessions }) {
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const usd = (v) => (v == null ? null : Math.round(Number(v) * 1e6) / 1e6);
  const tr = await one(
    `SELECT status, error, cost_usd, build_sha, build_commits, build_branch, session_id, capture, finished_at
       FROM bench_trials WHERE id = $1`, [build.trialId]);
  const run = await one('SELECT spent_usd FROM bench_runs WHERE id = $1', [build.benchRunId]);
  const tip = await one('SELECT sha FROM crash_world_branches WHERE repo = $1 AND branch = $2', [repo, build.branch]);
  // A move of the trial's branch (cut, removed, forced) after a turn pushed
  // to it would throw that turn's commits away: bench run 193.
  const moves = new Set(['github.ensureBranch', 'github.deleteBranch', 'github.forceBranch']);
  const repinned = [];
  let pushed = false;
  for (const e of effects) {
    if (e.data?.branch !== build.branch) continue;
    if (e.kind === 'push') pushed = true;
    else if (pushed && moves.has(e.kind) && !(e.kind === 'github.ensureBranch' && e.data.outcome === 'kept')) {
      repinned.push(`${e.kind} ${JSON.stringify({ sha: e.data.sha || null, outcome: e.data.outcome || null })}`);
    }
  }
  return {
    trial: {
      status: tr.status, error: tr.error, cost_usd: usd(tr.cost_usd), build_sha: tr.build_sha, build_commits: tr.build_commits,
      booted: tr.capture ? tr.capture.booted === true : null, recorded: tr.finished_at != null,
    },
    spent: usd(run.spent_usd),
    tip: tip?.sha || null,
    repinned,
    rootCommits: effects.filter((e) => e.kind === 'github.rootCommit').length,
    scaffolds: Number((await one(
      `SELECT count(*)::int AS n FROM bench_scaffolds WHERE run_id = $1 AND status = 'ready'`, [build.benchRunId])).n),
    artifacts: Number((await one('SELECT count(*)::int AS n FROM bench_trial_artifacts WHERE trial_id = $1', [build.trialId])).n),
    scaffoldStates: (await pool.query('SELECT status FROM bench_scaffolds WHERE run_id = $1 ORDER BY id', [build.benchRunId])).rows.map((r) => r.status),
    // Which part each session is (runner.js trialSession's workflow_step).
    sessionSteps: sessions.map((s) => String(s.workflow_step || '')).sort(),
  };
}
