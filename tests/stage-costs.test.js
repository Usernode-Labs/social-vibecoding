'use strict';

// What a first version cost, stage by stage and model by model
// (services/stage-costs.js), and where an admin reads it: a bench trial
// (bench/studio.js trialOut, get_bench_trial, get_bench_studio_run's rows)
// with, for a reviewed one, its review round by round; and the bot
// configurations' results and averages (bot-configs.js, list_bot_configs;
// tests/bot-configs-postgres.test.js has the stored side).
//
// Run with: node --test tests/stage-costs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const stageCosts = require('../src/services/stage-costs');
const studio = require('../src/services/bench/studio');
const tools = require('../src/services/mcp-tools');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const OPUS = 'anthropic/claude-opus-5.5';
const GLM = 'z-ai/glm-5.3-flash';
const TURN = '11111111-2222-4333-8444-555555555555';

const REVIEW = {
  state: 'done',
  reviewer: { model: OPUS, maxRounds: 2, budgetMinutes: 20 },
  round0: { sha: 'sha1', commits: 2, capture: { booted: true, shots: [] }, captureMs: 50000, costUsd: 0.92, activeMs: 1500000 },
  rounds: [
    {
      round: 1, sha: 'sha1', booted: true, verdict: 'fix', reviewedBy: 'model', reviewerCostUsd: 0.31, reviewerMs: 42000,
      issues: [{ id: 'empty-mine', severity: 'major', screen: 'phone light populated', problem: 'My list shows six empty rows', fix: 'Seed the viewer\'s own picks' }],
      previousFixed: [],
      fix: { ok: true, sha: 'sha2', commits: 3, costUsd: 0.44, ms: 300000 },
    },
    {
      round: 2, sha: 'sha2', booted: true, verdict: 'ship', reviewedBy: 'model', reviewerCostUsd: 0.27, reviewerMs: 39000,
      issues: [], previousFixed: ['empty-mine'], fix: null,
    },
  ],
  stop: 'ship', stopDetail: null, finalSha: 'sha2', costUsd: 1.02,
};

test('a breakdown names each stage with its model, and what is left over, so it adds up to the total', () => {
  const parts = {
    triage: { usd: 0.012, model: GLM, inputTokens: 40000, outputTokens: 2000 },
    spec: { usd: 0.81, model: OPUS, turnIds: [TURN], screens: [{ size: 'phone', chars: 12000, svgs: 6, shapes: 20, overBudget: false }] },
    build: { usd: 0.35, model: GLM, turnIds: [TURN] },
    ...stageCosts.reviewParts(REVIEW, { buildModel: GLM }),
  };
  const b = stageCosts.breakdown(2.2, parts);
  assert.deepEqual(b.stages.map((s) => [s.stage, s.model, s.usd]), [
    ['triage', GLM, 0.012], ['spec', OPUS, 0.81], ['build', GLM, 0.35], ['review_reviewer', OPUS, 0.58], ['review_fixes', GLM, 0.44],
  ]);
  assert.equal(b.totalUsd, 2.2);
  assert.equal(b.other.usd, 0.008);
  assert.deepEqual([b.stages[0].inputTokens, b.stages[0].outputTokens], [40000, 2000]);
  assert.ok(!('turnIds' in b.stages[1]), 'turn ids are the ledger\'s key, not the report\'s');
  assert.equal(b.stages[1].screens.length, 1);
  assert.equal(b.stages[1].overBudget, undefined);
  const sum = b.stages.reduce((s, x) => s + x.usd, 0) + b.other.usd;
  assert.ok(Math.abs(sum - b.totalUsd) < 1e-9);

  // A spec whose drawn screen ran past twice its budget says so on its line.
  const over = stageCosts.breakdown(1, { spec: { usd: 1, model: OPUS, screens: [{ chars: 40000, overBudget: true }] } });
  assert.equal(over.stages[0].overBudget, true);
  // No total: the parts are it. A total under its parts says so, never a negative remainder.
  assert.equal(stageCosts.breakdown(null, { build: { usd: 0.5, model: GLM } }).totalUsd, 0.5);
  const short = stageCosts.breakdown(0.4, { build: { usd: 0.5, model: GLM } });
  assert.equal(short.other.usd, 0);
  assert.match(short.note, /more than the recorded total/);
  assert.equal(stageCosts.breakdown(1, {}), null);
  assert.equal(stageCosts.breakdown(1, { build: { usd: null } }), null, 'a stage with no known cost has no line');
  // Only well-formed model ids and turn ids are kept.
  assert.equal(stageCosts.part({ usd: 1, model: 'not a model </x>' }).model, null);
  assert.equal(stageCosts.part({ usd: 1, turnIds: ['nope'] }).turnIds, undefined);
});

test('averages per stage over the results that recorded their stages, adding up to their average total', () => {
  const a = stageCosts.breakdown(2.0, { spec: { usd: 0.8, model: OPUS }, build: { usd: 0.4, model: GLM } });
  const b = stageCosts.breakdown(1.0, { spec: { usd: 0.2, model: GLM }, build: { usd: 0.6, model: GLM } });
  const avg = stageCosts.averages([a, b, null]);
  assert.equal(avg.n, 2);
  assert.equal(avg.totalUsd, 1.5);
  assert.deepEqual(avg.stages.spec, { usd: 0.5, models: [OPUS, GLM] });
  assert.deepEqual(avg.stages.build, { usd: 0.5, models: [GLM] });
  assert.equal(avg.otherUsd, 0.5);
  assert.equal(avg.otherOf, undefined, 'nothing named the remainders');
  assert.equal(stageCosts.averages([]), null);
});

test('the remainder says what it is: the ledger\'s turns no stage took, by component, largest first', () => {
  const of = [
    { component: 'homeroom_bot_triage', usd: 0.05 }, { component: 'kept_plan', usd: 0.4 },
    { component: 'homeroom_bot_triage', usd: 0.01 }, { component: null, usd: 0.02 }, { component: 'Not A Name!', usd: 0.01 },
    { component: 'nothing_spent', usd: 0 },
  ];
  assert.deepEqual(stageCosts.byComponent(of), [
    { component: 'kept_plan', usd: 0.4 }, { component: 'homeroom_bot_triage', usd: 0.06 }, { component: 'unnamed', usd: 0.03 },
  ]);
  const b = stageCosts.breakdown(1.0, { build: { usd: 0.5, model: GLM } }, { of });
  assert.equal(b.other.usd, 0.5);
  assert.deepEqual(b.other.of.map((o) => o.component), ['kept_plan', 'homeroom_bot_triage', 'unnamed']);
  assert.equal(stageCosts.breakdown(0.5, { build: { usd: 0.5, model: GLM } }, { of }).other.of, undefined, 'no remainder, nothing to name');
  const avg = stageCosts.averages([b, stageCosts.breakdown(1.0, { build: { usd: 1.0, model: GLM } })]);
  assert.deepEqual(avg.otherOf, [
    { component: 'kept_plan', usd: 0.2 }, { component: 'homeroom_bot_triage', usd: 0.03 }, { component: 'unnamed', usd: 0.015 },
  ], 'averaged over every result, as each stage is');
});

test('a build session\'s parts off its ledger: named turns keep their stage, the rest go by component, fixes after the review', async () => {
  const REVIEW_AT = '2026-10-08T12:00:00.000Z';
  const SPEC = 'aaaaaaaa-0000-4000-8000-000000000001';
  const rows = [
    { id: SPEC, component: null, model: OPUS, started_at: '2026-10-08T11:00:00Z', cost: 0.6, priced: 1, input: 1000, output: 100 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', component: 'homeroom_bot_build', model: GLM, started_at: '2026-10-08T11:10:00Z', cost: 0.3, priced: 2, input: 5000, output: 400 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', component: 'homeroom_bot_build', model: GLM, started_at: '2026-10-08T12:05:00Z', cost: 0.2, priced: 1, input: 2000, output: 200 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000004', component: 'homeroom_bot_triage', model: GLM, started_at: '2026-10-08T10:00:00Z', cost: 0.05, priced: 1, input: 0, output: 0 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000005', component: 'homeroom_bot_build', model: GLM, started_at: '2026-10-08T11:20:00Z', cost: 0, priced: 0, input: 0, output: 0 },
  ];
  const pool = { async query() { return { rows }; } };
  const given = {
    spec: { usd: 0.5, model: OPUS, turnIds: [SPEC], screens: [{ size: 'phone', overBudget: false }] },
    review_reviewer: { usd: 0.3, model: OPUS },
  };
  const { parts, unnamed } = await stageCosts.ledgerParts(pool, 42, given, {
    models: { build: GLM, review_fixes: GLM }, reviewStartedAt: REVIEW_AT,
  });
  assert.deepEqual([parts.spec.usd, parts.spec.model, parts.spec.inputTokens, parts.spec.screens.length], [0.6, OPUS, 1000, 1],
    'the ledger\'s figure, every attempt, with what the build knew of it');
  assert.deepEqual([parts.build.usd, parts.build.model, parts.build.outputTokens], [0.3, GLM, 400]);
  assert.deepEqual([parts.review_fixes.usd, parts.review_fixes.model], [0.2, GLM], 'a build-runner turn after the review started is a fix');
  assert.deepEqual(parts.review_reviewer, given.review_reviewer, 'a stage the ledger does not hold is kept as given');
  assert.deepEqual(unnamed, [{ component: 'homeroom_bot_triage', usd: 0.05, startedAt: '2026-10-08T10:00:00.000Z' }]);

  // No session, or a ledger that cannot be read: the parts as given.
  const empty = { async query() { return { rows: [] }; } };
  assert.deepEqual(await stageCosts.ledgerParts(empty, null, given), { parts: given, unnamed: [] });
  const broken = { async query() { throw new Error('down'); } };
  assert.deepEqual(await stageCosts.ledgerParts(broken, 42, given), { parts: given, unnamed: [] });
});

test('the review record: round 0, then each round\'s verdict, issues, fixes and costs, and why it stopped', () => {
  const r = studio.reviewRecord(REVIEW);
  assert.deepEqual(r.reviewer, { model: OPUS, maxRounds: 2, budgetMinutes: 20 });
  assert.deepEqual(r.round0, { sha: 'sha1', commits: 2, booted: true, captureError: null, costUsd: 0.92, activeMs: 1500000 });
  assert.equal(r.rounds.length, 2);
  assert.deepEqual(r.rounds[0].issues, [{ id: 'empty-mine', severity: 'major', screen: 'phone light populated', problem: 'My list shows six empty rows', fix: 'Seed the viewer\'s own picks' }]);
  assert.deepEqual(r.rounds[0].reviewer, { costUsd: 0.31, ms: 42000, error: null });
  assert.deepEqual(r.rounds[0].fix, { ok: true, costUsd: 0.44, ms: 300000, sha: 'sha2', commits: 3, error: null });
  assert.deepEqual([r.rounds[1].verdict, r.rounds[1].previousFixed, r.rounds[1].fix], ['ship', ['empty-mine'], null]);
  assert.deepEqual([r.stop, r.finalSha, r.costUsd], ['ship', 'sha2', 1.02]);
  assert.equal(studio.reviewRecord(null), null);
});

const ROW = {
  id: 9, run_id: 31, task_id: 5, model: GLM, attempt: 1, status: 'ok', cost_usd: 2.0,
  parsed: {
    built: true,
    costParts: { triage: { usd: 0.012, model: GLM }, spec: { usd: 0.81, model: OPUS }, build: { usd: 0.35, model: GLM } },
    review: REVIEW,
    spec: `# A long spec\n\n${'x'.repeat(50000)}`,
    specScreens: [{ size: 'phone', height: 1400, chars: 13000, svgs: 7, shapes: 24, overBudget: false }],
  },
  progress: {}, tags: {},
};

test('a trial carries its breakdown; get_bench_trial its whole spec, its screens and its review', async (t) => {
  const out = studio.trialOut(ROW);
  assert.deepEqual(out.costBreakdown.stages.map((s) => s.stage), ['triage', 'spec', 'build']);
  assert.equal(out.costBreakdown.other.usd, 0.828, 'the review and anything else: the trial recorded its stages before review ones existed');
  assert.equal(studio.trialOut({ ...ROW, parsed: { built: true } }).costBreakdown, null);
  assert.equal(studio.TRIAL_SPEC_CHARS, 120000);

  const real = global.fetch;
  t.after(() => { global.fetch = real; });
  const detail = {
    ...out, stage: 'first_version', spec: ROW.parsed.spec, specChars: ROW.parsed.spec.length, specScreens: ROW.parsed.specScreens,
    review: studio.reviewRecord(REVIEW), specNote: null,
  };
  global.fetch = async (url) => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(String(url).includes('/watch') ? { run: { id: 31 }, trials: [out], cursor: 'c' } : { trial: detail }),
  });
  const specs = new Map();
  const handlers = new Map();
  tools.registerTools({ registerTool(name, spec, handler) { specs.set(name, spec); handlers.set(name, handler); } }, {
    accessToken: 'svmcp_test', scopes: [READ_SCOPE, WRITE_SCOPE], user: { id: 1, username: 'evan', isAdmin: true, canAdminWrite: true },
    clientName: 'Claude Code', clientId: 'c1', origin: 'https://homeroom.example', baseUrl: 'http://platform.internal',
    pool: null, config: {}, tokenId: 1, grantId: null, delegation: null, imageInput: false,
  });
  const got = (await handlers.get('get_bench_trial')({ trialId: 9 })).structuredContent.trial;
  assert.deepEqual(got.costBreakdown.stages.map((s) => [s.stage, s.model, s.usd]), [['triage', GLM, 0.012], ['spec', OPUS, 0.81], ['build', GLM, 0.35]]);
  assert.match(got.spec, /^<untrusted-content>/);
  assert.ok(got.spec.length > 50000, 'the whole spec, not its first 12,000 characters');
  assert.equal(got.specChars, ROW.parsed.spec.length);
  assert.deepEqual(got.specScreens, [{ size: 'phone', height: 1400, chars: 13000, svgs: 7, shapes: 24, overBudget: false }]);
  assert.match(got.review, /^<untrusted-content>/, 'issues are a model\'s words');
  assert.match(got.review, /empty-mine/);
  assert.match(got.review, /"previousFixed"/);
  assert.doesNotMatch(got.detail, /A long spec/, 'the spec is no longer squeezed into the detail');
  assert.match(specs.get('get_bench_trial').description, /costBreakdown/);
  assert.match(specs.get('get_bench_trial').description, /review/);

  const run = (await handlers.get('get_bench_studio_run')({ runId: 31 })).structuredContent;
  assert.equal(run.trials[0].costBreakdown.totalUsd, 2.0);
  assert.match(specs.get('get_bench_studio_run').description, /costBreakdown/);
  assert.match(specs.get('list_bot_configs').description, /avgCostByStage/);
});
