'use strict';

// A test project's run report (services/run-report.js), without a database:
// how the rows the queries return are shaped (numbers, times, codes kept to
// their own shapes, free text cut short), what is never carried, how the
// lists are capped and the whole held under its size, and that keeping one
// never throws. tests/run-report-postgres.test.js runs the queries for real
// and the retire that keeps it.

const test = require('node:test');
const assert = require('node:assert/strict');

const logged = [];
const logger = require('../src/services/logger');
for (const level of ['info', 'warn', 'error', 'debug']) {
  logger[level] = (...args) => { logged.push([level, ...args]); };
}

const runReport = require('../src/services/run-report');

const T0 = new Date('2026-10-13T09:00:00.000Z');
const at = (secs) => new Date(T0.getTime() + secs * 1000);

function appRow(extra = {}) {
  return {
    id: 41, slug: 'plant-pal-1', name: 'Plant Pal', status: 'running', created_at: T0,
    created_by: 7, created_by_username: 'tester_7',
    has_first_version: true, fv_created_at: at(1), fv_status: 'filed', filed_at: at(60), issue_number: 1,
    bot_builds: true, fv_attempts: 1, fv_error: null, brief_chars: 212,
    early_plan_status: 'ready', early_plan_at: at(7), plan_secs: '6.2', early_plan_error: null,
    plan_questions: 2, answered_at: at(40), answers: ['Weekly', null],
    ...extra,
  };
}

function runRow(extra = {}) {
  return {
    id: 5, issue_number: 1, mode: 'live', verdict: 'ready', read_reason: 'new', model: 'anthropic/claude-opus-5.5',
    created_at: at(61), awaiting_go_at: null, live_build_waiting_at: null, build_queued_at: at(62), build_at: at(63),
    session_id: null, build_session_id: '9', proposal_session_id: 9, build_ok: true, build_attempts: 1, build_commits: 4,
    build_error: null, error: null, budget_stop: null, cost_usd: '0.41000000', build_cost_usd: '3.20000000', duration_ms: 1800000,
    spec_md_chars: 9100, spec_html_chars: 30500, review_rounds: 2, review_stop: 'ship', bot_config_version_id: 3,
    bot_config_key: 'opus-review', bot_config_version: 2,
    review_state: 'done', review_stop_detail: null, review_cost_usd: '0.9', review_resumes: '0',
    review_rounds_json: [
      {
        round: 1, sha: 'abc1234', artifactIds: ['a1', 'a2'], booted: true, verdict: 'fix', reviewedBy: 'model',
        reviewerCostUsd: 0.3, reviewerMs: 42000,
        issues: [{ id: 'empty-list', severity: 'major', screen: 'Home', problem: 'The list is empty.', fix: 'Seed it.' }],
        fix: { ok: true, sha: 'def5678', commits: 5, costUsd: 0.5, ms: 300000 },
      },
      { round: 2, booted: true, verdict: 'ship', reviewedBy: 'model', reviewerCostUsd: 0.1, reviewerMs: 30000, issues: [] },
    ],
    total: '1',
    ...extra,
  };
}

function turnRow(extra = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001', session_id: '9', component: 'homeroom_bot_build',
    requested_model: 'anthropic/claude-opus-5.5', routed_model: 'anthropic/claude-opus-5.5', routed_provider: 'Anthropic',
    reasoning_effort: 'high', status: 'completed', attempt_number: 1, started_at: at(63), completed_at: at(875),
    secs: '812.0', input_tokens: '120000', cached_input_tokens: '90000', output_tokens: '9000', reasoning_output_tokens: '2000',
    actual_cost_usd: '3.10000000', error_code: null,
    metrics: { tool_calls: 31, browser_phase_ms: 41000, tool_sequence: ['Read', 'Edit', 'Bash'] },
    total: '1',
    ...extra,
  };
}

function rows(extra = {}) {
  return {
    app: appRow(),
    runs: [runRow()],
    sessions: [{
      id: 9, status: 'promoted', branch_name: 'bot/issue-1', pr_number: 3, created_at: at(63), promoted_at: at(1900),
      merged_at: null, live_at: null, archived_at: null, check_state: 'passed', checks_commit_sha: 'def5678aa', total: '1',
    }],
    turns: [turnRow(), turnRow({ id: '00000000-0000-4000-8000-000000000002', metrics: null })],
    invocations: [{
      created_at: at(2), component: 'first_version_plan', attempt_number: '1', requested_model: 'z-ai/glm-5.3-flash',
      served_model: 'z-ai/glm-5.3-flash', provider: 'openrouter', duration_ms: '5100', outcome: 'success',
      stop_reason: 'end_turn', input_tokens: '1200', output_tokens: '640', cost_usd: '0.001', total: '1',
    }],
    screens: [{
      bot_run_id: 5, kind: 'first_look', position: 0, content_type: 'image/png', width: 390, height: 844, bytes: 51200,
      created_at: at(400), total: '1',
    }],
    incidents: [{
      created_at: at(500), session_id: 9, kind: 'build_interrupted', mode: 'live', outcome: 'resumed',
      why: 'the worker is gone', run_id: '5', issue_number: '1', total: '1',
    }],
    ...extra,
  };
}

test('every section is shaped: numbers as numbers, times as ISO strings, durations in seconds', () => {
  const report = runReport.shapeReport(rows(), { now: at(3600) });
  assert.equal(report.version, 1);
  assert.equal(report.generatedAt, '2026-10-13T10:00:00.000Z');
  assert.deepEqual(report.app, {
    id: 41, slug: 'plant-pal-1', name: 'Plant Pal', status: 'running', createdAt: '2026-10-13T09:00:00.000Z',
    createdBy: { id: 7, username: 'tester_7' },
  });
  const fv = report.firstVersion;
  assert.equal(fv.planSecs, 6.2);
  assert.equal(fv.planQuestions, 2);
  assert.equal(fv.briefChars, 212, 'the brief\'s length, never the brief');
  assert.equal(fv.earlyPlanAt, '2026-10-13T09:00:07.000Z');
  assert.deepEqual(fv.answers, ['Weekly', null]);

  const [run] = report.runs;
  assert.equal(run.costUsd, 0.41);
  assert.equal(run.buildCostUsd, 3.2);
  assert.equal(run.buildSessionId, 9);
  assert.equal(run.specMdChars, 9100);
  assert.equal(run.specHtmlChars, 30500);
  assert.deepEqual(run.review, { state: 'done', stopDetail: null, costUsd: 0.9, resumes: 0 });
  assert.deepEqual(run.botConfig, { id: 3, key: 'opus-review', version: 2 });

  assert.equal(report.reviewRounds.length, 2);
  const [r1, r2] = report.reviewRounds;
  assert.equal(r1.runId, 5);
  assert.equal(r1.verdict, 'fix');
  assert.equal(r1.reviewerMs, 42000);
  assert.deepEqual(r1.fix, { ok: true, commits: 5, costUsd: 0.5, ms: 300000, error: null, stopped: false });
  assert.deepEqual(r1.issues, [{ id: 'empty-list', severity: 'major', screen: 'Home', problem: 'The list is empty.' }]);
  assert.equal(r2.verdict, 'ship');
  assert.equal(r2.fix, null);

  assert.equal(report.sessions[0].checksCommitSha, 'def5678aa');
  assert.equal(report.sessions[0].promotedAt, '2026-10-13T09:31:40.000Z');
  const [turn] = report.turns;
  assert.equal(turn.secs, 812);
  assert.equal(turn.inputTokens, 120000);
  assert.equal(turn.costUsd, 3.1);
  assert.equal(turn.sessionId, 9);
  assert.equal(report.turns.length, 2);
  assert.equal(report.turnMetrics.length, 1, 'a turn with no metrics has no metrics row');
  assert.deepEqual(report.turnMetrics[0].metrics, {
    browser_phase_ms: 41000, tool_calls: 31, tool_sequence: '["Read","Edit","Bash"]',
  });
  assert.equal(report.invocations[0].durationMs, 5100);
  assert.equal(report.invocations[0].servedModel, 'z-ai/glm-5.3-flash');
  assert.equal(report.screens[0].bytes, 51200);
  assert.equal(report.incidents[0].runId, 5);
  assert.equal(report.incidents[0].why, 'the worker is gone');
  assert.deepEqual(report.truncated, {});
});

test('an app with no first version and nothing built is still a report', () => {
  const report = runReport.shapeReport({
    app: appRow({ has_first_version: false }), runs: [], sessions: [], turns: [], invocations: [], screens: [], incidents: [],
  });
  assert.equal(report.firstVersion, null);
  for (const key of runReport.SECTIONS) assert.deepEqual(report[key], [], key);
});

test('never a spec, a brief, a prompt, a fix\'s words, a capture or an image, whatever the row carries', () => {
  const secret = 'SECRET-TEXT-0451';
  const report = runReport.shapeReport(rows({
    app: appRow({ brief: secret, early_plan: { prompt: secret } }),
    runs: [runRow({
      build_spec_md: secret, build_spec_html: secret, plan_change: secret, question: secret,
      review_rounds_json: [{ round: 1, verdict: 'fix', issues: [{ id: 'x', severity: 'minor', screen: 'Home', problem: 'p', fix: secret }], capture: { html: secret } }],
    })],
    screens: [{ bot_run_id: 5, kind: 'real', position: 1, data: Buffer.from(secret), bytes: 10, total: '1' }],
    turns: [turnRow({ metadata: { prompt: secret } })],
  }));
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('identifiers keep their own shape, and free text is cut short and marked', () => {
  const long = 'x'.repeat(1000);
  const report = runReport.shapeReport(rows({
    app: appRow({ name: 'n'.repeat(500), early_plan_error: long, answers: [long, null, 'a', 'b', 'c', 'd', 'e', 'f'] }),
    runs: [runRow({
      model: 'not a model id; drop table', build_error: long, budget_stop: 'wall clock',
      review_rounds_json: [{
        round: 1, verdict: 'fix <script>', issues: [{ id: 'Not An Id!', severity: 'major', screen: long, problem: long }],
        fix: { ok: false, error: long },
      }],
    })],
    sessions: [{ id: 9, status: 'active', branch_name: 'feat/$(rm -rf)', checks_commit_sha: 'zzz', total: '1' }],
    turns: [turnRow({ routed_provider: 'Anthropic <b>', error_code: 'rate_limited', metrics: { tool_sequence: long, 'bad key!': 1 } })],
  }));
  assert.equal(report.app.name.length, runReport.TEXT.name + '… [truncated]'.length);
  assert.match(report.firstVersion.earlyPlanError, /… \[truncated\]$/);
  assert.equal(report.firstVersion.answers.length, runReport.LIMITS.answers);
  assert.equal(report.firstVersion.answers[0].length, runReport.TEXT.answer + '… [truncated]'.length);
  const [run] = report.runs;
  assert.equal(run.model, null, 'a model id is a model id or nothing');
  assert.equal(run.budgetStop, 'wall clock');
  assert.equal(run.buildError.length, runReport.TEXT.error + '… [truncated]'.length);
  const [round] = report.reviewRounds;
  assert.equal(round.verdict, null);
  assert.equal(round.issues[0].id, null);
  assert.equal(round.issues[0].screen.length, runReport.TEXT.screen + '… [truncated]'.length);
  assert.equal(round.issues[0].problem.length, runReport.TEXT.problem + '… [truncated]'.length);
  assert.match(round.fix.error, /… \[truncated\]$/);
  assert.equal(report.sessions[0].branchName, null);
  assert.equal(report.sessions[0].checksCommitSha, null);
  assert.equal(report.turns[0].routedProvider, null);
  assert.equal(report.turns[0].errorCode, 'rate_limited');
  assert.equal(report.turnMetrics[0].metrics.tool_sequence.length, runReport.TEXT.metric + '… [truncated]'.length);
  assert.equal('bad key!' in report.turnMetrics[0].metrics, false);
});

test('a list the query cut says how long it was, and long review rounds and issue lists are capped', () => {
  const rounds = Array.from({ length: 15 }, (_, i) => ({
    round: i + 1, verdict: 'fix',
    issues: Array.from({ length: 25 }, (__, j) => ({ id: `issue-${j}`, severity: 'minor', screen: 'Home', problem: 'p' })),
  }));
  const metrics = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`metric_${String(i).padStart(3, '0')}`, i]));
  const report = runReport.shapeReport(rows({
    runs: [runRow({ review_rounds_json: rounds, total: '1' })],
    turns: [turnRow({ total: '340', metrics })],
  }));
  assert.deepEqual(report.truncated.turns, { shown: 1, total: 340 });
  assert.equal(report.reviewRounds.length, runReport.LIMITS.rounds);
  assert.deepEqual(report.truncated.reviewRounds, { shown: runReport.LIMITS.rounds, total: 15 });
  assert.equal(report.reviewRounds[0].issueCount, 25);
  assert.equal(report.reviewRounds[0].issues.length, runReport.LIMITS.issuesPerRound);
  assert.equal(report.turnMetrics[0].count, 100);
  assert.equal(Object.keys(report.turnMetrics[0].metrics).length, runReport.LIMITS.metricsPerTurn);
});

test('the whole report is held under its size by halving the largest list, and says so', () => {
  const many = Array.from({ length: 300 }, (_, i) => turnRow({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, total: '300',
    metrics: Object.fromEntries(Array.from({ length: 80 }, (__, k) => [`m_${k}`, 'v'.repeat(390)])),
  }));
  const report = runReport.shapeReport(rows({ turns: many }));
  const bytes = Buffer.byteLength(JSON.stringify(report));
  assert.ok(bytes <= runReport.MAX_REPORT_BYTES, `${bytes} bytes`);
  assert.ok(report.truncated.turnMetrics, 'the metrics, the largest list, were cut');
  assert.equal(report.truncated.turnMetrics.total, 300);
  assert.equal(report.truncated.turnMetrics.shown, report.turnMetrics.length);
  assert.ok(report.turnMetrics.length < report.turns.length, 'the metrics were cut more than the turns');
  for (const [key, cut] of Object.entries(report.truncated)) {
    assert.equal(cut.shown, report[key].length, `${key} says how many it shows`);
  }
  assert.equal(report.turnMetrics[0].turnId, many[0].id, 'the earliest rows are the ones kept');

  // Halving again keeps the first total it recorded.
  const fitted = runReport.fitReport(report, 20 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 20 * 1024);
  assert.equal(fitted.truncated.turnMetrics.total, 300);
  assert.equal(fitted.truncated.turns.total, 300);
});

// A pool whose queries answer by the table they read.
function fakeDb(answers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [match, value] of answers) {
        if (sql.includes(match)) {
          if (value instanceof Error) throw value;
          return { rows: typeof value === 'function' ? value(params) : value };
        }
      }
      return { rows: [] };
    },
  };
}

test('the first version\'s timeline: its stages, its maker\'s moments, a refused plan\'s shape, the go-ahead and the host', () => {
  const report = runReport.shapeReport(rows({
    app: appRow({
      early_plan_status: 'failed', early_plan_error: 'unusable_reply',
      early_plan_reply: {
        chars: 2, json: 'object', why: 'no_plan', keyCount: 0, keys: [{ key: 'plan', type: 'string', length: 412 }, { key: 'bad key!', type: 'array', items: 3 }],
        finishReason: 'tool_calls', toolCallCount: 1, textChars: 1533, routedProvider: 'CoreWeave', words: 'never kept',
      },
    }),
    runs: [runRow({ go_ahead_at: at(70) })],
    invocations: [{
      created_at: at(2), component: 'first_version_plan', attempt_number: '1', requested_model: 'z-ai/glm-5.3-flash',
      served_model: 'z-ai/glm-5.3-flash', provider: 'openrouter', routed_provider: 'Together', duration_ms: '1927',
      outcome: 'success', stop_reason: 'tool_calls', input_tokens: '1200', output_tokens: '325', cost_usd: '0.001', total: '1',
    }],
    stages: [
      { created_at: at(2), session_id: null, metadata: { stage: 'plan_written', issueNumber: 1, source: 'triage', questions: 2 }, total: '3' },
      { created_at: at(71), session_id: 9, metadata: { stage: 'picked_up', runId: 5, issueNumber: 1, waitedMs: 46000, attempt: 1, note: 'Free text!' }, total: '3' },
      { created_at: at(2000), session_id: 9, metadata: { stage: 'review_round', runId: 5, issueNumber: 1, round: 1, rounds: 2 }, total: '3' },
    ],
    moments: [
      { created_at: at(9), user_id: 7, metadata: { kind: 'questions_shown', clientAt: at(8).toISOString(), receivedAt: at(9).toISOString(), count: 2 }, total: '2' },
      { created_at: at(41), user_id: 7, metadata: { kind: 'tour_step_shown', clientAt: at(40).toISOString(), step: 3, steps: 9 }, total: '2' },
    ],
  }), { now: at(3600) });
  assert.deepEqual(report.firstVersion.earlyPlanReply, {
    chars: 2, json: 'object', why: 'no_plan', keyCount: 0,
    keys: [{ key: 'plan', type: 'string', length: 412, items: null }, { key: null, type: 'array', length: null, items: 3 }],
    finishReason: 'tool_calls', toolCallCount: 1, textChars: 1533, routedProvider: 'CoreWeave',
  }, 'lengths, types and codes; never a word of it');
  assert.equal(report.runs[0].goAheadAt, at(70).toISOString());
  assert.equal(report.invocations[0].routedProvider, 'Together');
  assert.deepEqual(report.stages.map((s) => s.stage), ['plan_written', 'picked_up', 'review_round']);
  assert.deepEqual(report.stages[1], {
    at: at(71).toISOString(), stage: 'picked_up', runId: 5, issueNumber: 1, sessionId: 9, waitedMs: 46000, attempt: 1,
  }, 'a code keeps its shape; free text is left out');
  assert.deepEqual([report.stages[2].round, report.stages[2].rounds], [1, 2]);
  assert.deepEqual(report.moments[1], {
    at: at(41).toISOString(), clientAt: at(40).toISOString(), kind: 'tour_step_shown', userId: 7, step: 3, steps: 9,
  });
  assert.equal(report.moments[0].count, 2);
  assert.equal(runReport.shapeReport(rows(), { now: at(3600) }).firstVersion.earlyPlanReply, null, 'none when the plan was not refused');
});

// Run seven (14 Oct 2026): GMICloud at ~18 tokens a second served builds, and
// the report could neither name every host a turn used nor say how often it
// left the shortlist; a host with a space in its name was dropped outright.
test('run seven: a turn\'s hosts, spaces and all, and how many of its requests left the shortlist', () => {
  const report = runReport.shapeReport(rows({
    turns: [
      turnRow({
        routed_provider: 'Sail Research',
        routed_providers: ['Fireworks', 'Near AI', 'Sail Research', 'Bad <b>', { x: 1 }],
        shortlist_fallbacks: '2',
      }),
      turnRow({ id: '00000000-0000-4000-8000-000000000002', routed_provider: 'Near AI', metrics: null }),
    ],
  }), { now: at(3600) });
  const [turn, older] = report.turns;
  assert.equal(turn.routedProvider, 'Sail Research', 'a provider\'s name keeps its space');
  assert.deepEqual(turn.routedProviders, ['Fireworks', 'Near AI', 'Sail Research'], 'each in a provider\'s shape, in order');
  assert.equal(turn.shortlistFallbacks, 2);
  assert.equal(older.routedProvider, 'Near AI');
  assert.equal(older.routedProviders, null, 'a turn that did not record them says nothing');
  assert.equal(older.shortlistFallbacks, null);
  assert.equal(runReport.shapeReport(rows({ turns: [turnRow({ routed_providers: Array.from({ length: 12 }, (_, i) => `Host ${i}`) })] }))
    .turns[0].routedProviders.length, 8);
});

test('run seven: a run\'s last look after its final fix, recorded beside its rounds and changing neither', () => {
  const look = {
    round: 2, fixed: ['empty-list', 'Not An Id!'], open: ['header-overlap'], verdict: 'ship', costUsd: 0.21, ms: 38000,
    at: at(1900).toISOString(), retry: 'x', issues: [{ problem: 'never kept' }],
  };
  const report = runReport.shapeReport(rows({
    runs: [runRow({ review_rounds: 2, review_stop: 'round_limit', review_final_look: look })],
  }), { now: at(3600) });
  const [run] = report.runs;
  assert.deepEqual(run.reviewFinalLook, {
    round: 2, fixed: ['empty-list'], open: ['header-overlap'], verdict: 'ship', costUsd: 0.21, ms: 38000,
    at: at(1900).toISOString(), error: null,
  });
  assert.equal(run.reviewRounds, 2, 'still the rounds the loop ran');
  assert.equal(run.reviewStop, 'round_limit');
  assert.equal(report.reviewRounds.length, 2, 'and no round of its own');
  const failed = runReport.shapeReport(rows({
    runs: [runRow({ review_final_look: { round: 2, fixed: [], open: [], costUsd: null, ms: 12, error: 'x'.repeat(1000) } })],
  })).runs[0].reviewFinalLook;
  assert.match(failed.error, /… \[truncated\]$/);
  assert.equal(runReport.shapeReport(rows()).runs[0].reviewFinalLook, null, 'none when no look was taken');
});

test('build reads one app by id or slug, and every list by that app\'s id with its cap', async () => {
  const db = fakeDb([
    ['FROM apps a', [appRow()]],
    ['FROM homeroom_bot_runs r\n', [runRow()]],
  ]);
  const report = await runReport.build(db, { slug: 'plant-pal-1' });
  assert.equal(report.app.slug, 'plant-pal-1');
  assert.deepEqual(db.calls[0].params, [null, 'plant-pal-1']);
  const lists = db.calls.slice(1);
  assert.equal(lists.length, 8);
  for (const call of lists) assert.equal(call.params[0], 41, 'by the app\'s id');
  assert.deepEqual(lists.map((c) => c.params[1]).sort((a, b) => a - b),
    [runReport.LIMITS.screens, runReport.LIMITS.runs, runReport.LIMITS.incidents, runReport.LIMITS.sessions,
      runReport.LIMITS.turns, runReport.LIMITS.invocations, runReport.LIMITS.stages, runReport.LIMITS.moments]
      .sort((a, b) => a - b));
  for (const call of db.calls) assert.doesNotMatch(call.sql, /\bdata\b|build_spec_md,|\bbrief,|r\.review,/, 'no body or image is read');

  const none = fakeDb([]);
  assert.equal(await runReport.build(none, { slug: 'gone' }), null);
  assert.equal(await runReport.build(none, {}), null);
  assert.equal(none.calls.length, 1, 'nothing is read without an app');
});

test('keep never throws: a report that cannot be kept is logged and the caller goes on', async () => {
  logged.length = 0;
  const client = fakeDb([['FROM apps a', new Error('canceling statement due to statement timeout')]]);
  const pool = { connect: async () => ({ ...client, release() {} }) };
  const kept = await runReport.keep(pool, { app: { id: 41, slug: 'plant-pal-1' }, testUser: { id: 7, username: 'tester_7' } });
  assert.equal(kept, false);
  assert.ok(client.calls.some((c) => c.sql === 'ROLLBACK'));
  assert.ok(client.calls.some((c) => /SET LOCAL statement_timeout/.test(c.sql)), 'a slow read is cut off');
  const warn = logged.find(([level]) => level === 'warn');
  assert.ok(warn, 'it is logged');
  assert.match(warn[2], /retire goes on/);
  assert.equal(await runReport.keep({ connect: async () => { throw new Error('pool is closed'); } }, { app: { id: 41, slug: 'x' } }), false);
  assert.equal(await runReport.keep(pool, { app: null }), false);
});
