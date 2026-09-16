'use strict';
// Automatic challenge scoring.
//
// Three layers, tested where each of them actually lives:
//
//   challenge-rules.js    pure. Windows, payout arithmetic, the cap, and the
//                         reason a rule is skipped — plain data in, plain
//                         data out, no pool anywhere.
//   challenge-scorer.js   the tick, against a scripted pool. The properties
//                         that matter are idempotence (a second run writes
//                         nothing), the dry-run contract (reads everything,
//                         writes nothing, grades nothing) and the shape of
//                         the ledger row it produces.
//   challenge-grader.js   the pre-filter and the clamp, with a stub engine —
//                         a grading failure must leave the unit for the next
//                         tick rather than credit a guess.
//
// The ledger-row shape has its own test because it is the one thing three
// other files already depend on: `metadata.kind = 'challenge_completion'` is
// what the completion unique index and the home panel's "done" rule key on,
// and a counted measure that emitted it would have its second credit refused
// by the database.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

const rules = require('../src/services/topochain/challenge-rules');
const grader = require('../src/services/topochain/challenge-grader');
const scorer = require('../src/services/topochain/challenge-scorer');
const { challengeScoringAdminRoutes, parseRuleFields } = require('../src/routes/topochain/admin/challenge-scoring');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-16T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// A challenge row as RULE_CHALLENGES_SQL returns it: challenge columns bare,
// template columns `t_`-prefixed, plus the event's dates for the fallback.
const challengeRow = (extra = {}) => ({
  rule_id: 1,
  rule_name: 'Try apps',
  measure: 'TRY_APPS',
  rule_target: null,
  rule_points: null,
  rule_enabled: true,
  challenge_id: 74,
  season_event_id: 10,
  enabled: true,
  completed: false,
  schedule_start: iso(NOW - 3 * DAY),
  schedule_end: iso(NOW + 4 * DAY),
  metric_target: 3,
  reward: '500 pts',
  t_category: 'ONBOARDING',
  t_goal: 'Try 3 apps',
  t_schedule_start: null,
  t_schedule_end: null,
  t_metric_target: 3,
  t_reward: '500 pts',
  event_starts_at: iso(NOW - 10 * DAY),
  event_ends_at: iso(NOW + 10 * DAY),
  ...extra,
});

const rule = (extra = {}) => ({
  id: 1, name: 'Try apps', measure: 'TRY_APPS', target: null, points: null, enabled: true, ...extra,
});

// ─── Rewards ───────────────────────────────────────────────────────────

test('reward parsing is the home panel\'s, unchanged by the move', () => {
  assert.equal(rules.parseRewardPoints('500 pts'), 500);
  assert.equal(rules.parseRewardPoints('1,000 pts'), 1000);
  assert.equal(rules.parseRewardPoints('Up to 2,000 pts'), 2000);
  assert.equal(rules.parseRewardPoints('Up to 500 pts / issue'), null);
  assert.equal(rules.parseRewardPoints('½ of your final credits'), null);
  assert.equal(rules.parseRewardPoints(null), null);
  // The home panel re-exports it, so the two surfaces cannot drift.
  const panels = require('../src/routes/home-panels');
  assert.equal(panels.parseRewardPoints('Up to 6,500 pts'), 6500);
});

// ─── Windows ───────────────────────────────────────────────────────────

test('a window falls back challenge → template → event', () => {
  const onChallenge = rules.resolveWindow(challengeRow(), { now: NOW });
  assert.equal(onChallenge.startMs, NOW - 3 * DAY);
  assert.equal(onChallenge.open, true);

  const onTemplate = rules.resolveWindow(challengeRow({
    schedule_start: null, schedule_end: null,
    t_schedule_start: iso(NOW - DAY), t_schedule_end: iso(NOW + DAY),
  }), { now: NOW });
  assert.equal(onTemplate.startMs, NOW - DAY);

  // A persistent challenge carries no dates at all and inherits the event's,
  // which is what makes "open all season" need no typing.
  const onEvent = rules.resolveWindow(challengeRow({
    schedule_start: null, schedule_end: null, t_schedule_start: null, t_schedule_end: null,
  }), { now: NOW });
  assert.equal(onEvent.startMs, NOW - 10 * DAY);
  assert.equal(onEvent.open, true);
});

test('a window that closed minutes ago still pays; a week later it does not', () => {
  const justClosed = challengeRow({ schedule_end: iso(NOW - 5 * 60 * 1000) });
  assert.equal(rules.resolveWindow(justClosed, { now: NOW }).open, true,
    'Sunday 23:55 must still be credited by the tick that runs after midnight');
  const longClosed = challengeRow({ schedule_end: iso(NOW - 8 * DAY) });
  assert.equal(rules.resolveWindow(longClosed, { now: NOW }).open, false);
});

// ─── Why a rule is skipped ─────────────────────────────────────────────

test('every skip names the thing the operator has to change', () => {
  const r = rule();
  assert.equal(rules.skipReason(r, challengeRow(), { now: NOW }), null);
  assert.equal(rules.skipReason(rule({ enabled: false }), challengeRow(), { now: NOW }),
    'rule is switched off');
  assert.equal(rules.skipReason(rule({ measure: 'NOPE' }), challengeRow(), { now: NOW }),
    'unknown measure NOPE');
  assert.equal(rules.skipReason(r, challengeRow({ enabled: false }), { now: NOW }),
    'challenge is switched off');
  assert.equal(rules.skipReason(r, challengeRow({ completed: true }), { now: NOW }),
    'challenge is closed');
  assert.equal(
    rules.skipReason(r, challengeRow({ schedule_start: iso(NOW + DAY) }), { now: NOW }),
    'window has not started'
  );
  assert.match(
    rules.skipReason(r, challengeRow({ reward: 'Unlocks future rewards', t_reward: 'Unlocks future rewards' }), { now: NOW }),
    /^no points/
  );
  assert.match(
    rules.skipReason(r, challengeRow({ metric_target: null, t_metric_target: null }), { now: NOW }),
    /^no target/
  );
});

test('a rule\'s own numbers win over the challenge\'s, and blank falls back', () => {
  const row = challengeRow();
  assert.equal(rules.effectiveTarget(rule(), row), 3);
  assert.equal(rules.effectivePoints(rule(), row), 500);
  assert.equal(rules.effectiveTarget(rule({ target: 5 }), row), 5);
  assert.equal(rules.effectivePoints(rule({ points: 750 }), row), 750);
  // The reason Points exists at all: a reward that will not parse.
  const prose = challengeRow({ reward: 'Up to 2,000 pts a week', t_reward: 'Up to 2,000 pts a week' });
  assert.equal(rules.effectivePoints(rule(), prose), null);
  assert.equal(rules.effectivePoints(rule({ points: 2000 }), prose), 2000);
});

// ─── Payout ────────────────────────────────────────────────────────────

test('payout shapes match the scoring sentence each challenge prints', () => {
  // "500 pts after the third app." — nothing, nothing, then the lot.
  assert.deepEqual([0, 1, 2].map((index) => rules.unitPoints({
    payout: 'on_target', points: 500, target: 3, index,
  })), [0, 0, 500]);

  // "250 pts per account, 500 pts for both."
  assert.deepEqual([0, 1].map((index) => rules.unitPoints({
    payout: 'per_unit', points: 500, target: 2, index,
  })), [250, 250]);

  // A single completion takes the whole reward.
  assert.equal(rules.unitPoints({ payout: 'full', points: 1000, target: 1, index: 0 }), 1000);

  // A graded unit gets the ceiling; the grader lowers it.
  assert.equal(rules.unitPoints({ payout: 'graded', points: 1000, target: 4, index: 0 }), 250);
});

test('an uneven split still pays the whole reward, with the remainder on the last unit', () => {
  const paid = [0, 1, 2].map((index) => rules.unitPoints({
    payout: 'per_unit', points: 1000, target: 3, index,
  }));
  assert.deepEqual(paid, [333, 333, 334]);
  assert.equal(paid.reduce((a, b) => a + b, 0), 1000, 'no rounding tail reaches the leaderboard');
});

// ─── Planning ──────────────────────────────────────────────────────────

const candidate = (userId, key, at = iso(NOW - HOUR)) => ({
  userId, sourceKey: key, activityAt: at, description: key,
});

test('planning pays the third app and ignores the ones already credited', () => {
  const credited = new Map([[7, { keys: new Set(['app:1']), count: 1 }]]);
  const plan = rules.planCredits(rule(), challengeRow(), {
    candidates: [candidate(7, 'app:1'), candidate(7, 'app:2'), candidate(7, 'app:3')],
    credited,
    now: NOW,
  });
  assert.deepEqual(plan.map((c) => c.sourceKey), ['app:2', 'app:3']);
  assert.deepEqual(plan.map((c) => c.points), [0, 500]);
});

test('the target is a cap: a fourth app earns nothing more', () => {
  const plan = rules.planCredits(rule(), challengeRow(), {
    candidates: [1, 2, 3, 4].map((n) => candidate(7, `app:${n}`)),
    now: NOW,
  });
  assert.equal(plan.length, 3);
  assert.equal(plan.reduce((sum, c) => sum + c.points, 0), 500);
});

test('two candidates in ONE run cannot both be "the last unit"', () => {
  // Without the running tally inside planCredits, both accounts would see
  // index 1 and the challenge would pay 250 + 250 on top of an existing one.
  const plan = rules.planCredits(rule({ measure: 'CONNECT_ACCOUNTS' }), challengeRow({
    measure: 'CONNECT_ACCOUNTS', metric_target: 2, t_metric_target: 2,
  }), {
    candidates: [candidate(7, 'provider:github'), candidate(7, 'provider:x')],
    now: NOW,
  });
  assert.deepEqual(plan.map((c) => c.points), [250, 250]);
});

test('a windowed measure refuses a candidate from before the window opened', () => {
  const plan = rules.planCredits(rule(), challengeRow(), {
    candidates: [candidate(7, 'app:1', iso(NOW - 30 * DAY)), candidate(7, 'app:2')],
    now: NOW,
  });
  assert.deepEqual(plan.map((c) => c.sourceKey), ['app:2']);
});

test('a state measure counts what happened before the season, on purpose', () => {
  // Somebody who linked GitHub last month has it linked. A persistent
  // challenge that refused to see that would ask them to redo it.
  const plan = rules.planCredits(rule({ measure: 'CONNECT_ACCOUNTS' }), challengeRow({
    measure: 'CONNECT_ACCOUNTS', metric_target: 2, t_metric_target: 2,
  }), {
    candidates: [candidate(7, 'provider:github', iso(NOW - 60 * DAY))],
    now: NOW,
  });
  assert.equal(plan.length, 1);
});

test('a counted measure never emits the completion marker, a single one always does', () => {
  const counted = rules.planCredits(rule(), challengeRow(), {
    candidates: [candidate(7, 'app:1')], now: NOW,
  });
  assert.equal(counted[0].completion, false,
    'three tried apps are three rows; the completion index would refuse the second');
  const single = rules.planCredits(rule({ measure: 'PROPOSAL_SENT' }), challengeRow({
    measure: 'PROPOSAL_SENT', reward: '1,000 pts', t_reward: '1,000 pts',
  }), { candidates: [candidate(7, 'session:5')], now: NOW });
  assert.equal(single[0].completion, true);
  assert.equal(single[0].points, 1000);
});

// ─── Grading ───────────────────────────────────────────────────────────

test('the pre-filter rejects junk without spending a model call', () => {
  const seen = new Set();
  assert.equal(grader.preFilter('USEFUL_FEEDBACK', { text: 'broken' }, seen), 'too short to act on');
  const real = { text: 'The save button on the recipe screen does nothing when the title is empty.' };
  assert.equal(grader.preFilter('USEFUL_FEEDBACK', real, seen), null);
  assert.equal(grader.preFilter('USEFUL_FEEDBACK', real, seen), 'the same report was already credited',
    'sending the same sentence four times earns one credit');
  // Accepted proposals passed a group vote, so there is nothing to pre-filter.
  assert.equal(grader.preFilter('PROPOSAL_ACCEPTED', { text: 'x' }, seen), null);
});

test('a score is clamped into the band and never reaches zero', () => {
  assert.equal(grader.clampScore(180, 250), 180);
  assert.equal(grader.clampScore(400, 250), 250);
  assert.equal(grader.clampScore(0, 250), 1,
    'zero would mean writing no row, which would mean re-grading the same text every tick');
  assert.equal(grader.clampScore('not a number', 250), null);
});

test('a grading failure leaves the unit for the next tick instead of crediting a guess', async () => {
  const failing = { isEnabled: () => true, gradeChallengeUnit: async () => { throw new Error('529'); } };
  const errors = [];
  const out = await grader.gradeAll(
    [{ measure: 'USEFUL_FEEDBACK', gradeInput: { text: 'a real report about a real thing' }, points: 250 }],
    { llm: failing, onError: (e) => errors.push(e.message) }
  );
  assert.deepEqual(out, []);
  assert.deepEqual(errors, ['529']);
});

test('grading returns the model\'s score, with its reason kept for the admin', async () => {
  const stub = {
    isEnabled: () => true,
    gradeChallengeUnit: async ({ system, user }) => {
      assert.match(system, /ACTIONABLE/, 'the rubric reaches the model');
      assert.match(user, /save button/);
      return { score: 200, reason: 'Says what broke and where.', model: 'claude-haiku-4-5' };
    },
  };
  const out = await grader.gradeAll([{
    measure: 'USEFUL_FEEDBACK',
    gradeInput: { text: 'The save button does nothing', appName: 'Recipes' },
    points: 250,
  }], { llm: stub });
  assert.equal(out[0].points, 200);
  assert.equal(out[0].grade.reason, 'Says what broke and where.');
});

// ─── The tick, against a scripted pool ─────────────────────────────────

// A pool that answers by matching the query text. Deliberately not a SQL
// engine: what these tests pin is the ORDER of operations and what ends up in
// `inserted`, not Postgres's behaviour.
function scriptedPool({ challenges = [], candidates = [], credited = [] } = {}) {
  const inserted = [];
  const runs = [];
  const handle = async (sql, params) => {
    if (sql.includes('FROM challenge_scoring_rules')) return { rows: challenges };
    if (sql.includes("metadata->>'source_key' AS source_key")) return { rows: credited };
    if (sql.includes('FROM app_activity')) return { rows: candidates };
    if (sql.includes('INSERT INTO challenge_scorer_runs')) { runs.push(params); return { rows: [{ id: runs.length }] }; }
    if (sql.includes('UPDATE challenge_scorer_runs')) { runs.push(params); return { rows: [] }; }
    if (sql.includes('INSERT INTO user_activities')) {
      // The unique index is what makes a second run free; model it.
      const key = `${params[7]}:${params[0]}:${JSON.parse(params[5]).source_key}`;
      if (inserted.some((r) => r.key === key)) return { rows: [] };
      inserted.push({ key, params, metadata: JSON.parse(params[5]) });
      return { rows: [{ id: inserted.length }] };
    }
    if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) return { rows: [] };
    if (sql.includes('MAX(snapshot_at)')) return { rows: [{ at: new Date(NOW) }] };
    return { rows: [] };
  };
  return {
    inserted,
    runs,
    async query(sql, params) { return handle(sql, params); },
    async connect() {
      return { async query(sql, params) { return handle(sql, params); }, release() {} };
    },
  };
}

const appActivityRows = [
  { user_id: 7, app_id: 1, app_name: 'Recipes', last_date: '2026-09-15', seconds: 120 },
  { user_id: 7, app_id: 2, app_name: 'Runs', last_date: '2026-09-15', seconds: 90 },
  { user_id: 7, app_id: 3, app_name: 'Notes', last_date: '2026-09-16', seconds: 45 },
];

test('a run writes one ledger row per unit, in the shape the rest of the platform reads', async () => {
  const pool = scriptedPool({ challenges: [challengeRow()], candidates: appActivityRows });
  const summary = await scorer.score(pool, { now: NOW });

  assert.equal(summary.credits, 3);
  assert.deepEqual(pool.inserted.map((r) => r.metadata.source_key), ['app:1', 'app:2', 'app:3']);
  assert.deepEqual(pool.inserted.map((r) => Number(r.params[3])), [0, 0, 500]);

  const [first] = pool.inserted;
  assert.equal(first.params[2], 'ONBOARDING', 'credited under the template category, like every other credit');
  assert.equal(first.metadata.measure, 'TRY_APPS');
  assert.equal(first.metadata.rule_id, 1);
  assert.equal(first.metadata.kind, undefined, 'a counted measure must not claim completion');
  assert.match(first.params[4], /Tried Recipes/);
  // The credit is dated when the thing happened, so it sits inside its week.
  assert.match(first.params[6], /^2026-09-15/);
});

test('running again writes nothing: the same units are already credited', async () => {
  const pool = scriptedPool({ challenges: [challengeRow()], candidates: appActivityRows });
  await scorer.score(pool, { now: NOW });
  const before = pool.inserted.length;

  // Second tick: the ledger now holds what the first wrote.
  const pool2 = scriptedPool({
    challenges: [challengeRow()],
    candidates: appActivityRows,
    credited: pool.inserted.map((r) => ({ user_id: r.params[0], source_key: r.metadata.source_key })),
  });
  const summary = await scorer.score(pool2, { now: NOW });
  assert.equal(before, 3);
  assert.equal(summary.credits, 0);
  assert.equal(pool2.inserted.length, 0);
});

test('a dry run reads everything and writes nothing', async () => {
  const pool = scriptedPool({ challenges: [challengeRow()], candidates: appActivityRows });
  const summary = await scorer.score(pool, { now: NOW, dryRun: true });
  assert.equal(summary.credits, 3, 'it still says what it would pay');
  assert.equal(pool.inserted.length, 0);
});

test('a dry run of a graded measure spends no model call', async () => {
  const graded = challengeRow({
    measure: 'USEFUL_FEEDBACK', rule_name: 'Feedback', metric_target: 4, t_metric_target: 4,
    reward: '1,000 pts', t_reward: '1,000 pts', t_goal: 'Send useful feedback',
  });
  const pool = scriptedPool({ challenges: [graded] });
  pool.query = async (sql) => {
    if (sql.includes('FROM challenge_scoring_rules')) return { rows: [graded] };
    if (sql.includes('FROM feedback_reports')) {
      return {
        rows: [{
          id: 5, user_id: 7, created_at: new Date(NOW - HOUR), title: 'Save fails',
          description: 'The save button on the recipe screen does nothing when the title is empty.',
          app_name: 'Recipes',
        }],
      };
    }
    if (sql.includes("metadata->>'source_key' AS source_key")) return { rows: [] };
    return { rows: [] };
  };
  const summary = await scorer.score(pool, { now: NOW, dryRun: true });
  assert.equal(summary.challenges[0].to_grade, 1);
  assert.equal(summary.credits, 0);
  assert.equal(summary.graded, 0);
});

test('a skipped rule reports the reason instead of failing silently', async () => {
  const closed = challengeRow({ schedule_end: iso(NOW - 8 * DAY) });
  const pool = scriptedPool({ challenges: [closed] });
  const summary = await scorer.score(pool, { now: NOW });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.challenges[0].skipped, 'window has closed');
  assert.equal(pool.inserted.length, 0);
});

test('the leaderboard is not rebuilt while its last snapshot is fresh', async () => {
  const pool = scriptedPool();
  const fresh = await scorer.maybeAggregate(pool, { hours: 6, now: NOW + HOUR });
  assert.equal(fresh, null, 'each rebuild ages out older history — do not do it every tick');
});

// ─── The admin API ─────────────────────────────────────────────────────

test('a rule must name exactly one binding', () => {
  const base = { name: 'Try apps', measure: 'TRY_APPS' };
  assert.deepEqual(parseRuleFields({ ...base, challenge_template_id: 23 }, { required: true }).details, {});
  assert.match(
    parseRuleFields({ ...base }, { required: true }).details.challenge_template_id[0],
    /Bind the rule/
  );
  assert.match(
    parseRuleFields({ ...base, challenge_template_id: 23, challenge_id: 74 }, { required: true })
      .details.challenge_template_id[0],
    /not both/
  );
});

test('only a measure the platform implements can be saved', () => {
  const { details } = parseRuleFields(
    { name: 'x', measure: 'RUN_ARBITRARY_SCRIPT', challenge_template_id: 23 }, { required: true }
  );
  assert.match(details.measure[0], /must be one of/);
});

test('blank target and points are stored as blank, not as zero', () => {
  const { fields } = parseRuleFields(
    { name: 'x', measure: 'TRY_APPS', challenge_template_id: 23, target: '', points: '' },
    { required: true }
  );
  assert.equal(fields.target, null);
  assert.equal(fields.points, null);
});

function buildApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role === 'user') req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false };
    else if (role === 'readonly') req.user = { id: 901, username: 'ro', isAdmin: true, canAdminWrite: false };
    else req.user = { id: 902, username: 'admin', isAdmin: true, canAdminWrite: true };
    next();
  });
  app.use(challengeScoringAdminRoutes({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('the screen loads in one request: measures, rules and recent runs', async () => {
  currentMockPool = scriptedPool({ challenges: [challengeRow()] });
  currentMockPool.query = async (sql) => {
    if (sql.includes('LEFT JOIN challenge_templates ct ON ct.id = r.challenge_template_id')) {
      return {
        rows: [{
          id: 1, name: 'Try apps', measure: 'TRY_APPS', challenge_template_id: 23, challenge_id: null,
          target: null, points: null, enabled: true, notes: null,
          created_at: new Date(NOW), updated_at: new Date(NOW), template_goal: 'Try 3 apps',
        }],
      };
    }
    if (sql.includes('FROM challenge_scorer_runs')) return { rows: [] };
    if (sql.includes('FROM challenge_scoring_rules')) return { rows: [challengeRow()] };
    return { rows: [] };
  };
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/challenge-scoring`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data.measures.map((m) => m.key).sort(), rules.MEASURE_KEYS.slice().sort());
    assert.equal(body.data.rules[0].bound_to.kind, 'template');
    // The live column: which challenges this rule pays into, and why not.
    assert.equal(body.data.rules[0].covers[0].challenge_id, 74);
    assert.equal(body.data.rules[0].covers[0].points, 500);
    assert.equal(body.data.rules[0].covers[0].skipped, null);
  } finally { server.close(); }
});

test('a view-only admin can read the rules but not change or run them', async () => {
  currentMockPool = scriptedPool();
  const { server, base } = await listen(buildApp('readonly'));
  try {
    for (const [method, path, body] of [
      ['POST', '/api/v4/admin/challenge-scoring/rules', { name: 'x', measure: 'TRY_APPS', challenge_template_id: 1 }],
      ['PUT', '/api/v4/admin/challenge-scoring/rules/1', { name: 'x' }],
      ['DELETE', '/api/v4/admin/challenge-scoring/rules/1', undefined],
      ['POST', '/api/v4/admin/challenge-scoring/run', { dry_run: true }],
    ]) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(res.status, 403, `${method} ${path} is a write`);
    }
  } finally { server.close(); }
});

test('a second rule on the same challenge is refused as a fixable mistake, not a 500', async () => {
  currentMockPool = {
    async query(sql) {
      if (sql.includes('INSERT INTO challenge_scoring_rules')) {
        const err = new Error('duplicate key');
        err.constraint = 'challenge_scoring_rules_template_unique';
        throw err;
      }
      return { rows: [] };
    },
    async connect() { return { async query() { return { rows: [] }; }, release() {} }; },
  };
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/challenge-scoring/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second', measure: 'TRY_APPS', challenge_template_id: 23 }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.details.challenge_template_id[0], /already scores this challenge/);
  } finally { server.close(); }
});

// ─── Schema ────────────────────────────────────────────────────────────

test('the schema carries the index that makes re-running the scorer free', () => {
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS user_activities_source_key_unique/);
  assert.match(schema, /ON user_activities \(challenge_id, user_id, \(metadata->>'source_key'\)\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS challenge_scoring_rules/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS challenge_scorer_runs/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS feedback_reports/);
  // Free text a person wrote about their own use of the product.
  assert.match(schema, /COMMENT ON TABLE feedback_reports IS 'staging:private';/);
  // Exactly one binding, enforced by the database and not only by the API.
  assert.match(schema, /CONSTRAINT challenge_scoring_rules_one_binding CHECK/);
});
