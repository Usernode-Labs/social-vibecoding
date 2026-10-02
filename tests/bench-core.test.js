'use strict';

// #3654 Core v1: the checked-in definition of the default benchmark suite,
// and the pure parts of making it: the definition's schema and counts, the
// dynamic rules' selection, the historical cutoff (comments at as_of, the
// commit at as_of), the requester's next reply as a DM task's hidden answer,
// the launcher's defaults, and the Core card's states. The database half
// (materializing, idempotency, skips, labelling, freezing) is
// tests/bench-core-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/services/bench/core');
const backfill = require('../src/services/bench/backfill');
const lane = require('../src/services/bench/lane');
const catalog = require('../src/services/bench/catalog');
const github = require('../src/services/github');

const def = core.loadDefinition();
const clone = () => JSON.parse(JSON.stringify(def));

test('the checked-in Core v1 definition is valid and shaped like the first version', () => {
  const v = core.validateDefinition(def);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.equal(def.key, 'core-v1');
  assert.equal(def.version, 1);
  assert.equal(def.kind, 'frozen');
  // 40 stratified real triage runs plus 4 authored adversarial ones.
  const triage = def.tasks.filter((t) => t.stage === 'triage');
  assert.equal(triage.length, 44);
  const real = triage.filter((t) => !t.synthetic);
  assert.equal(real.length, 40);
  const byVerdict = {};
  for (const t of real) byVerdict[t.tags.verdict_bot] = (byVerdict[t.tags.verdict_bot] || 0) + 1;
  assert.deepEqual(byVerdict, { ready: 16, person: 10, question: 8, empty: 6 });
  assert.equal(real.filter((t) => t.tags.platform).length, 20);
  assert.equal(new Set(real.filter((t) => !t.tags.platform).map((t) => t.app_slug)).size, 16, '20 other-app tasks across 16 apps');
  for (const t of real) {
    assert.ok(Number.isInteger(t.issue_number) && t.issue_number > 0, t.ref);
    assert.ok(!Number.isNaN(Date.parse(t.as_of)), t.ref);
    assert.ok(Number.isInteger(t.source_run_id), t.ref);
    assert.equal(t.reference, undefined, 'the bot\'s verdict is a tag, never a reference');
  }
  // Stable references, not private text: only authored tasks carry text.
  for (const t of def.tasks) {
    if (!t.synthetic) {
      assert.equal(t.title, undefined);
      assert.equal(t.body, undefined);
    }
    if (t.notes) assert.ok(t.notes.length < 300, `${t.ref}: a short note, not a copy of the request`);
  }
  const adversarial = triage.filter((t) => t.synthetic);
  assert.deepEqual(adversarial.map((t) => t.tags.adversarial).sort(), ['content_rules', 'contradictory', 'cross_repo', 'prompt_injection']);
  for (const t of adversarial) {
    assert.equal(t.reference_source, 'authored');
    assert.ok(['question', 'ready', 'person', 'empty'].includes(t.reference.verdict));
    assert.ok(t.issue_number >= 990001, 'a number no real request uses');
  }
  assert.match(adversarial.find((t) => t.tags.adversarial === 'prompt_injection').synthetic.body, /ignore your rules/i);

  const builds = def.tasks.filter((t) => t.stage === 'build');
  assert.equal(builds.length, 10, 'ten platform builds from merged pull requests');
  assert.deepEqual(builds.map((t) => t.pr_number), [3625, 3626, 3627, 3628, 3629, 3630, 3631, 3632, 3634, 3647]);
  assert.ok(builds.every((t) => t.tags.platform === true && /^[0-9a-f]{40}$/.test(t.base_sha)));
  assert.equal(builds.find((t) => t.pr_number === 3647).request_from, 'pr_body');
  assert.equal(builds.find((t) => t.pr_number === 3647).base_sha, '18df8f1c187a32029f663612a4536378184569bd');
  assert.ok(builds.filter((t) => t.pr_number !== 3647).every((t) => t.base_sha === 'ac67fac30de91d0dd969f72b2cd73633d4719dd9'));
  assert.deepEqual(def.tasks.filter((t) => t.stage === 'checks_fix').map((t) => t.proposal_session_id), [5754, 5755]);
  assert.deepEqual(def.tasks.filter((t) => t.stage === 'dm').map((t) => t.source_run_id), [649, 267, 172, 8, 590]);
  assert.deepEqual(def.dynamic.map((r) => [r.rule, r.limit]), [['merged_bot_proposals', 10], ['bot_followups', 3]]);
  assert.deepEqual(v.counts, { triage: 44, build: 20, followup: 3, checks_fix: 2, dm: 5, spec: 0 });
});

test('the definition\'s schema refuses what would make a bad suite', () => {
  const errs = (mutate) => { const d = clone(); mutate(d); return core.validateDefinition(d).errors.join('\n'); };
  assert.match(errs((d) => { d.tasks[1].ref = d.tasks[0].ref; }), /duplicate ref/);
  assert.match(errs((d) => { d.tasks.push({ ...d.tasks[0], ref: 'triage:again' }); }), /the same task twice/);
  assert.match(errs((d) => { delete d.tasks[0].as_of; }), /no as_of/);
  assert.match(errs((d) => { d.tasks[0].as_of = 'yesterday'; }), /not an ISO timestamp/);
  assert.match(errs((d) => { delete d.tasks[0].stage; }), /unknown stage/);
  assert.match(errs((d) => { const t = d.tasks.find((x) => x.synthetic); delete t.reference; delete t.reference_source; }), /authored reference verdict/);
  assert.match(errs((d) => { d.tasks[0].reference = { verdict: 'ready' }; }), /reference_source "authored"/);
  assert.match(errs((d) => { d.tasks.find((x) => x.stage === 'build').pr_number = null; }), /merged pr_number/);
  assert.match(errs((d) => { d.tasks.find((x) => x.stage === 'checks_fix').proposal_session_id = 'x'; }), /proposal_session_id/);
  assert.match(errs((d) => { d.tasks = d.tasks.filter((x) => x.stage !== 'triage' || x.tags.verdict_bot !== 'ready'); }), /triage has 28 tasks; expected 40 to 50/);
  assert.match(errs((d) => { d.dynamic[0].rule = 'everything'; }), /unknown rule/);
  assert.match(errs((d) => { d.dynamic[0].limit = 50; }), /limit must be 1 to 20/);
  assert.match(errs((d) => { d.tasks.find((x) => x.stage === 'dm').synthetic = { title: 'x', body: 'y' }; }), /only a triage task can be synthetic/);
});

test('a dynamic rule picks distinct apps in the order given, leaving out apps already used', () => {
  const rows = [
    { run_id: 9, app_id: 1, issue_number: 4 },
    { run_id: 8, app_id: 1, issue_number: 3 },
    { run_id: 7, app_id: 2, issue_number: 2 },
    { run_id: 6, app_id: 3, issue_number: 9 },
    { run_id: 5, app_id: 4, issue_number: 1 },
  ];
  assert.deepEqual(core.pickDistinctApps(rows, 3).map((r) => r.run_id), [9, 7, 6], 'the newest per app');
  assert.deepEqual(core.pickDistinctApps(rows, 10, { exclude: [2] }).map((r) => r.run_id), [9, 6, 5]);
  assert.deepEqual(core.pickDistinctApps([], 3), []);
  assert.deepEqual(core.pickDistinctApps(rows, 0), []);
});

test('the thread as of as_of keeps only what was there, and says when the request may have been edited since', () => {
  const asOf = '2026-09-30T12:00:00.000Z';
  const comments = [
    { author: 'amy', body: 'before', createdAt: '2026-09-30T11:00:00Z' },
    { author: 'amy', body: 'at the moment', createdAt: '2026-09-30T12:00:00Z' },
    { author: 'amy', body: 'the answer, later', createdAt: '2026-09-30T13:00:00Z' },
    { author: 'amy', body: 'no time', createdAt: '' },
  ];
  const threadMessages = [
    { author: 'bo', body: 'thread before', createdAt: '2026-09-30T10:00:00Z' },
    { author: 'bo', body: 'thread after', createdAt: '2026-10-01T10:00:00Z' },
  ];
  const out = backfill.threadAsOf({
    issue: { createdAt: '2026-09-30T09:00:00Z', updatedAt: '2026-09-30T13:00:02Z' }, comments, threadMessages, asOf,
  });
  assert.deepEqual(out.comments.map((c) => c.body), ['before', 'at the moment']);
  assert.deepEqual(out.threadMessages.map((m) => m.body), ['thread before']);
  assert.deepEqual(out.dropped, { comments: 2, thread: 1 });
  assert.equal(out.bodyEditedAfter, false, 'the later comment explains the later updated_at');
  assert.equal(out.createdAfter, false);
  const edited = backfill.threadAsOf({ issue: { createdAt: '2026-09-30T09:00:00Z', updatedAt: '2026-10-02T09:00:00Z' }, comments, asOf });
  assert.equal(edited.bodyEditedAfter, true, 'nothing later explains it: the body or title may have been edited');
  const untouched = backfill.threadAsOf({ issue: { updatedAt: '2026-09-30T11:30:00Z' }, comments: [], asOf });
  assert.equal(untouched.bodyEditedAfter, false);
  assert.equal(backfill.threadAsOf({ issue: { createdAt: '2026-09-30T12:00:01Z' }, asOf }).createdAfter, true);
  assert.throws(() => backfill.threadAsOf({ asOf: 'not a time' }));
});

test('the commit at as_of is the default branch\'s newest commit dated at or before it', async (t) => {
  const calls = [];
  github._setOctokitFactoryForTests(() => ({
    rest: {
      repos: {
        async get(args) { calls.push(['get', args]); return { data: { default_branch: 'trunk' } }; },
        async listCommits(args) {
          calls.push(['listCommits', args]);
          return { data: [{ sha: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', commit: { committer: { date: '2026-09-30T11:59:00Z' } } }] };
        },
      },
    },
  }));
  t.after(() => github._setOctokitFactoryForTests(null));
  const at = await github.getCommitAt('o', 'r', '2026-09-30T12:00:00.000Z');
  assert.deepEqual(at, { sha: 'abcdef0123456789abcdef0123456789abcdef01', committedAt: '2026-09-30T11:59:00Z', branch: 'trunk' });
  assert.deepEqual(calls[1], ['listCommits', { owner: 'o', repo: 'r', sha: 'trunk', until: '2026-09-30T12:00:00.000Z', per_page: 1 }]);
  await assert.rejects(github.getCommitAt('o', 'r', 'nonsense'), /valid time/);

  // commitAsOf: a skip with a reason, never a throw.
  const repo = { owner: 'o', repo: 'r' };
  assert.equal((await backfill.commitAsOf({ async getCommitAt() { return null; } }, repo, '2020-01-01T00:00:00Z')).ok, false);
  const gone = await backfill.commitAsOf({ async getCommitAt() { const e = new Error('Not Found'); e.status = 404; throw e; } }, repo, '2020-01-01T00:00:00Z');
  assert.deepEqual([gone.ok, gone.reason, gone.transient], [false, 'the repository is gone', false]);
  const flaky = await backfill.commitAsOf({ async getCommitAt() { throw new Error('socket hang up'); } }, repo, '2020-01-01T00:00:00Z');
  assert.equal(flaky.transient, true);
  // The benchmark's GitHub may read it; it may not write.
  const guarded = require('../src/services/bench/runner').guardedGithub({ getCommitAt: async () => ({ sha: 'x' }), createIssueComment: async () => {} });
  assert.deepEqual(await guarded.getCommitAt('o', 'r', 'x'), { sha: 'x' });
  assert.throws(() => guarded.createIssueComment('o', 'r', 1, 'no'), /may not/);
});

test('a DM task\'s hidden answer is the requester\'s own next reply after the question', () => {
  const after = '2026-09-30T12:00:00Z';
  const comments = [
    { author: 'amy', body: 'earlier', createdAt: '2026-09-30T11:00:00Z' },
    { author: 'bystander', body: 'I think blue', createdAt: '2026-09-30T12:10:00Z' },
    { author: 'Amy', body: '  dark blue please ', createdAt: '2026-09-30T12:30:00Z' },
  ];
  const thread = [{ author: 'amy', body: 'from the thread', createdAt: '2026-09-30T12:20:00Z' }];
  assert.deepEqual(backfill.nextReplyAfter({ comments, threadMessages: thread, after, requester: ['amy'] }),
    { text: 'from the thread', at: '2026-09-30T12:20:00Z', source: 'thread' });
  assert.equal(backfill.nextReplyAfter({ comments, after, requester: ['amy'] }).text, 'dark blue please');
  assert.equal(backfill.nextReplyAfter({ comments, after, requester: [] }), null, 'nobody\'s answer stands in for an unknown requester');
  assert.equal(backfill.nextReplyAfter({ comments, after: '2026-10-01T00:00:00Z', requester: ['amy'] }), null);
});

test('the launcher starts on Core v1 with the candidate models, triage repeated, $50', () => {
  const suites = [
    { id: 3, name: 'scratch', frozen_at: null, counts: { triage: 2 } },
    { id: 7, name: 'Core', frozen_at: null, counts: { triage: 44, build: 18, checks_fix: 2, dm: 4, followup: 0 } },
    { id: 9, name: 'Staging demo core', frozen_at: '2026-10-01', counts: { triage: 6 } },
  ];
  const d = lane.launcherDefaults({ suites, coreSuiteId: 7 });
  assert.equal(d.suiteId, 7);
  assert.deepEqual(d.stages, ['triage', 'dm'], 'the cheap stages; builds are a run of their own');
  assert.deepEqual(d.models, [
    'z-ai/glm-5.3-flash', 'xiaomi/mimo-v2.6-pro', 'deepseek/deepseek-v4.1-flash', 'qwen/qwen3.8-flash',
    'minimax/minimax-m3', 'openai/gpt-5.6-luna', 'moonshotai/kimi-k2.7-code', 'anthropic/claude-sonnet-5.5',
  ]);
  assert.equal(d.models[0], catalog.BASELINE);
  assert.deepEqual([d.repeats, d.repeatStages, d.capUsd], [3, ['triage'], 50]);
  assert.equal(lane.launcherDefaults({ suites, coreSuiteId: null }).suiteId, 9, 'no Core yet: the first frozen suite');
  assert.equal(lane.launcherDefaults({ suites: [] }).suiteId, null);

  const v = lane.validateLaunch({ suiteId: 7, models: d.models, stages: d.stages, repeats: 3, capUsd: 50, repeatStages: ['triage'] });
  assert.equal(v.ok, true);
  assert.deepEqual([lane.attemptsFor('triage', v), lane.attemptsFor('dm', v), lane.attemptsFor('checks_fix', v), lane.attemptsFor('build', v)], [3, 1, 1, 1]);
  const old = lane.validateLaunch({ suiteId: 7, models: ['a/b'], stages: ['dm'], repeats: 3 });
  assert.equal(lane.attemptsFor('dm', old), 3, 'without repeatStages, every stage but a build repeats, as before');
  assert.equal(lane.validateLaunch({ suiteId: 7, models: ['a/b'], stages: ['dm'], repeatStages: ['nope'] }).status, 400);
  // Kimi is entered for builds only: not applicable to triage, never failed.
  const kimi = catalog.CANDIDATES.find((c) => c.id === 'moonshotai/kimi-k2.7-code');
  assert.match(catalog.notApplicableReason({ ...kimi, contextTokens: null }, 'triage', 100), /build and spec only/);
});

test('the Core card says where the suite stands, and offers Freeze only when every task is labelled', () => {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { CorePanel, Launcher, BenchmarkArea } = loadTsx('frontend/src/features/admin/admin-homeroom-bench.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, { get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)) }),
      },
    },
  });
  const definition = { key: 'core-v1', name: 'Core', version: 1, expected: {}, valid: true };
  const render = (status, canWrite = true) => renderToHtml(createElement(CorePanel, { status, canWrite, onMaterialize() {}, onFreeze() {} }));

  const fresh = render({ definition, materialization: null, suite: null, running: false, githubEnabled: true });
  assert.match(fresh, /id="admin-homeroom-bench-core"/);
  assert.match(fresh, />Core v1</);
  assert.match(fresh, /Not made yet/);
  assert.match(fresh, /id="admin-homeroom-bench-core-materialize"[^>]*>Materialize Core v1 now/);
  assert.doesNotMatch(render({ definition, materialization: null, suite: null, running: false, githubEnabled: false }), /core-materialize/);
  assert.doesNotMatch(render({ definition, materialization: null, suite: null, running: false, githubEnabled: true }, false), /core-materialize/, 'view-only admins read');

  const done = {
    definition,
    materialization: {
      status: 'done', finishedAt: null,
      summary: { ready: 60, stages: { triage: { ready: 43, skipped: 1 }, dm: { ready: 4, skipped: 1 } }, skipped: [
        { ref: 'triage:gone#1', stage: 'triage', app: 'gone', reason: 'the app gone is gone' },
        { ref: 'dm:x#2', stage: 'dm', app: 'x', reason: 'the requester never answered the question', transient: false },
      ] },
    },
    suite: { id: 5, name: 'Core', version: 1, frozen_at: null, total: 60, labelled: 12 },
    running: false, githubEnabled: true,
  };
  const partly = render(done);
  assert.match(partly, /60 tasks ready, 2 skipped\./);
  assert.match(partly, /Triage 43 ready, 1 skipped · DM 4 ready, 1 skipped/);
  assert.match(partly, /triage:gone#1: the app gone is gone/);
  assert.match(partly, /id="admin-homeroom-bench-core-labelled"[^>]*>12 of 60 labelled\./);
  assert.match(partly, /list_bench_grading_queue, kind label/);
  assert.doesNotMatch(partly, /core-freeze/, 'no Freeze while tasks are unlabelled');
  assert.match(partly, />Try the skipped tasks again</);

  const labelled = render({ ...done, suite: { ...done.suite, labelled: 60 } });
  assert.match(labelled, /id="admin-homeroom-bench-core-freeze"[^>]*>Freeze Core v1/);
  const frozen = render({ ...done, suite: { ...done.suite, labelled: 60, frozen_at: '2026-10-02' } });
  assert.doesNotMatch(frozen, /core-freeze|core-materialize/);
  assert.match(render({ ...done, running: true }), /Being made now/);
  assert.match(render({ ...done, materialization: { status: 'failed', summary: { error: 'GitHub is not configured' }, finishedAt: null } }), /The last attempt failed: GitHub is not configured/);

  // The launcher, from its defaults: Core picked, every model ticked.
  const launcher = { suiteId: 5, models: ['z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.7-code'], stages: ['triage', 'dm'], repeats: 3, repeatStages: ['triage'], capUsd: 50 };
  const html = renderToHtml(createElement(Launcher, {
    suites: [{ id: 4, name: 'other', version: 1, kind: 'frozen', frozen_at: 'x', counts: {}, total: 0, labelled: 0 }, { id: 5, name: 'Core', version: 1, kind: 'frozen', frozen_at: null, counts: { triage: 44 }, total: 44, labelled: 0 }],
    models: [{ id: 'z-ai/glm-5.3-flash', label: 'GLM' }, { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi', stages: ['build', 'spec'] }, { id: 'x/other', label: 'Other' }],
    defaults: { capUsd: 50, repeats: 3, maxConcurrency: 2 }, launcher, hiddenChecks: '', onLaunched() {}, say() {},
  }));
  assert.match(html, /<option value="5" selected="">Core v1 \(not frozen\)<\/option>/);
  assert.equal((html.match(/data-bench-model="[^"]+"><input type="checkbox" class="mt-1" checked=""/g) || []).length, 2, 'the two default models ticked, the other not');
  assert.match(html, /id="admin-homeroom-bench-launch-cap"[^>]*value="50"/);
  assert.match(html, /id="admin-homeroom-bench-launch-repeat-all"/);

  const area = renderToHtml(createElement(BenchmarkArea, { canWrite: true }));
  assert.match(area, /id="admin-homeroom-bench-core"/);
  assert.match(area, /Loading…/);
});
