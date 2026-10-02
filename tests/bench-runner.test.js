'use strict';

// #3654: a benchmark trial runs a stage of the Homeroom bot on a candidate
// model with NOTHING leaving the benchmark: no post, no comment, no DM, no
// pull request, no proposal; GitHub only read, and written only on the
// trial's own `bench/` branch. Every stage is run here against stubbed
// workers with every side-effecting entry point spied on, and none of them
// may be called. Also: the stages rebuild the real prompts from the
// snapshot, start at its base commit, and classify how a turn ended.

const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../src/services/bench/runner');
const catalog = require('../src/services/bench/catalog');
const lane = require('../src/services/bench/lane');
const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const dm = require('../src/services/homeroom-bot-dm');
const githubModule = require('../src/services/github');
const snapshots = require('../src/services/homeroom-bot-snapshots');

const BASE = 'b'.repeat(40);
const APP = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/o/todo', self_hosted: false };
const REPO = { owner: 'o', repo: 'todo' };
const USER = { id: 501, username: 'homeroom_bench' };

// Every function that would leave the benchmark, replaced by a recorder.
function spySideEffects(t) {
  const calls = [];
  const targets = [
    [live, ['post', 'postOnProposal', 'promoteAsBot', 'postSpecOnProposal', 'shareSpecVersion', 'applyMentionAsks', 'advanceSeen']],
    [dm, ['sendDm', 'relayIssuePost', 'noteProposalMerged', 'noteOverAllowance', 'recordRequester']],
    [githubModule, ['createIssueComment', 'createPR', 'mergePR', 'createIssue', 'closeIssue', 'updatePR', 'createBranch']],
  ];
  for (const [mod, names] of targets) {
    for (const name of names) {
      const real = mod[name];
      mod[name] = (...args) => { calls.push(name); return Promise.resolve(null); };
      t.after(() => { mod[name] = real; });
    }
  }
  return calls;
}

function fakeGithub() {
  const calls = { pinned: [], deleted: [], comments: 0 };
  return {
    calls,
    isEnabled: () => true,
    async getBranchSha() { return 'f'.repeat(40); },
    async ensureBranchAtSha(owner, repo, branch, sha) { calls.pinned.push({ branch, sha }); },
    async deleteBenchBranch(owner, repo, branch) { calls.deleted.push(branch); return true; },
    async compareFiles() { return { files: [{ filename: 'app.js', status: 'modified' }], diff: 'diff --git a/app.js b/app.js\n+x', complete: true, truncated: false }; },
    async createIssueComment() { calls.comments += 1; },
    async createPR() { calls.comments += 1; },
  };
}

function harness({ text = '', result = null, sessionsOverride = null } = {}) {
  const calls = { prompts: [], modes: [], models: [], queries: [], ensured: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/INSERT INTO chat_sessions/.test(s)) return { rows: [{ id: 7001, branch_name: params[2] ?? null, agent_model: params[4] }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const gh = fakeGithub();
  const deps = {
    github: runner.guardedGithub(gh),
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { calls.ensured.push(opts); return 'w-7001'; },
      async execInWorker(id, opts) {
        calls.prompts.push(opts.prompt);
        calls.modes.push(opts.mode);
        if (typeof result === 'function') return result(opts);
        return result || { lastResultText: text };
      },
      async stopTurn() {},
      clearPendingStop() {},
    },
    sessions: sessionsOverride || {
      async runCodexAttemptLoop(args) {
        await args.resolveRuntime();
        calls.models.push(args.session.agent_model);
        const r = await args.dispatchOnce({});
        return { result: r, error: null, estimatedCostUsd: 0.02 };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext({ session }) { return { agentModel: session.agent_model }; } },
    activeWorkers: new Set(),
  };
  return { pool, deps, calls, gh };
}

const BUDGETS = { turnMs: 60_000, buildMs: 60_000, specMs: 60_000 };
const TRIAL = { id: 44, run_id: 3, attempt: 1 };

function snapshot(stage, extra = {}) {
  const seed = 'Please work on GitHub issue #12: "Pins drift".';
  return {
    id: 1, stage, issueNumber: 12, baseSha: BASE, promptHash: snapshots.hashText(bot.triagePromptFor({ seed, issueNumber: 12 })),
    texts: {
      seed, build_note: 'Pin the markers.', proposal_block: 'DISCUSSION ON PR #5',
      replies: JSON.stringify([{ where: 'issue', via: 'homeroom', author: 'ann', body: 'Make it blue', createdAt: '2026-09-30T00:00:00Z' }]),
      failing: JSON.stringify([{ name: 'home', path: '/', reason: 'expected Blue' }]),
    },
    thread: { issue: { title: 'Pins drift' } },
    extra: { prNumber: 5, canRevise: true, total: 10, ...extra },
  };
}

function ctx(h, stage, over = {}) {
  return {
    pool: h.pool, config: {}, stage, task: { id: 1, stage, reference: {} }, snapshot: snapshot(stage === 'spec' ? 'build' : stage),
    model: 'qwen/qwen3.8-flash', user: USER, app: APP, repo: REPO, trial: TRIAL, deps: h.deps, budgets: BUDGETS,
    title: 'Homeroom benchmark: run 3, trial 44', ...over,
  };
}

test('the GitHub a trial gets: reads, and its own bench/ branch, and nothing else', async () => {
  const gh = fakeGithub();
  const g = runner.guardedGithub(gh);
  assert.equal(g.isEnabled(), true);
  await g.ensureBranchAtSha('o', 'todo', 'bench/r3-t44', BASE);
  assert.deepEqual(gh.calls.pinned, [{ branch: 'bench/r3-t44', sha: BASE }]);
  assert.throws(() => g.ensureBranchAtSha('o', 'todo', 'main', BASE), /may not touch the branch main/);
  assert.throws(() => g.ensureBranchAtSha('o', 'todo', 'dev/alice-1', BASE), /may not touch/);
  assert.throws(() => g.deleteBenchBranch('o', 'todo', 'bench/../main'), /may not touch/);
  for (const name of ['createIssueComment', 'createPR', 'mergePR', 'createIssue', 'closeIssue', 'forceBranchToSha', 'pushFiles']) {
    assert.throws(() => g[name]('o', 'todo', 1, 'x'), /benchmark trials may not call github\./, name);
  }
  assert.equal(gh.calls.comments, 0);
});

test('a triage trial: the real prompt from the snapshot, at its base commit, on the trial\'s model, posting nothing', async (t) => {
  const side = spySideEffects(t);
  const h = harness({ text: '```json\n{"verdict":"question","question":"Which map?","default":"The route map","blocker":"user_facing","why_default_fails":"two maps","answers":["The route map","The city map"]}\n```' });
  const out = await runner.runStage(ctx(h, 'triage'));
  assert.equal(out.status, 'ok');
  assert.equal(out.parsed.verdict, 'question');
  assert.deepEqual(out.parsed.questionAnswers, ['The route map', 'The city map']);
  assert.equal(out.parsed.promptMatchesSnapshot, true, 'today\'s prompt is the prompt the run read');
  assert.equal(h.calls.prompts[0], bot.triagePromptFor({ seed: snapshot('triage').texts.seed, issueNumber: 12 }));
  assert.deepEqual(h.calls.modes, ['scout']);
  assert.deepEqual(h.calls.models, ['qwen/qwen3.8-flash']);
  assert.deepEqual(h.gh.calls.pinned, [{ branch: 'bench/r3-t44', sha: BASE }], 'cut at the snapshot\'s base');
  assert.equal(h.calls.ensured[0].branchName, 'bench/r3-t44');
  assert.equal(out.base_sha, BASE);
  const insert = h.calls.queries.find((q) => /INSERT INTO chat_sessions/.test(q.s));
  assert.equal(insert.params[1], USER.id, 'the bench user\'s session, never the bot\'s');
  assert.deepEqual(side, [], 'nothing posted, commented, DMed or proposed');
});

test('how a triage turn ended: unparseable is the model\'s, a wall clock a timeout, a platform fault infra', async (t) => {
  spySideEffects(t);
  assert.equal((await runner.runStage(ctx(harness({ text: 'no block' }), 'triage'))).status, 'model_fail');
  const stopped = harness();
  stopped.deps.sessions.runCodexAttemptLoop = async () => { throw new Error('boom'); };
  const out = await runner.runStage(ctx(stopped, 'triage'));
  assert.equal(out.status, 'infra_fail');
  assert.match(out.error, /dispatch: boom/);
  assert.deepEqual(runner.turnStatus({ stopped: true, routed: {} }), { status: 'timeout', error: 'the turn ran past its time limit' });
  assert.equal(runner.turnStatus({ routed: { error: 'credential_required' } }).status, 'infra_fail');
  assert.equal(runner.turnStatus({ routed: { error: 'session_busy' } }).status, 'infra_fail');
  assert.equal(runner.turnStatus({ routed: { error: 'max_turns' } }).status, 'model_fail');
  const noWorker = harness();
  noWorker.deps.worker.ensureWorker = async () => { throw new Error('quota'); };
  assert.equal((await runner.runStage(ctx(noWorker, 'triage'))).status, 'infra_fail');
});

test('a build trial: built without proposing, on its bench branch at the base, its diff read, nothing said', async (t) => {
  const side = spySideEffects(t);
  const realBuild = live.buildAndPropose;
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return realBuild(a); };
  t.after(() => { live.buildAndPropose = realBuild; });
  const h = harness({
    result: (opts) => (opts.mode === 'scout' ? { lastResultText: '# Pin the markers\n\nDo it.' } : { pushOk: true, ahead: 2, sha: 'c'.repeat(40) }),
  });
  const out = await runner.runStage(ctx(h, 'build', {
    task: { id: 1, stage: 'build', reference: { hidden_checks: [{ name: 'pins', path: '/' }] } },
  }));
  assert.equal(out.status, 'ok');
  assert.equal(args.propose, false, 'never proposed');
  assert.equal(args.onSpec, null, 'the spec is posted nowhere');
  assert.equal(args.deps.votesRouter, undefined, 'no route to promote with');
  assert.equal(args.telemetry, 'homeroom_bench');
  assert.equal(out.build_branch, 'bench/r3-t44');
  assert.equal(out.build_commits, 2);
  assert.deepEqual(h.gh.calls.pinned, [{ branch: 'bench/r3-t44', sha: BASE }]);
  assert.match(out.diff, /diff --git a\/app\.js/);
  assert.deepEqual(out.changed_files.files, [{ filename: 'app.js', status: 'modified' }]);
  assert.equal(out.checks.ran, false, 'hidden checks are not run yet, and the trial says so');
  assert.equal(out.checks.reason, runner.HIDDEN_CHECKS_GAP);
  assert.equal(out.parsed.spec, '# Pin the markers\n\nDo it.');
  assert.deepEqual(h.calls.modes, ['scout', 'build']);
  assert.deepEqual(side, []);
});

test('a build that changed nothing is the model\'s failure, not the platform\'s', async (t) => {
  spySideEffects(t);
  const h = harness({ result: (opts) => (opts.mode === 'scout' ? { lastResultText: '' } : { pushOk: true, ahead: 0 }) });
  const out = await runner.runStage(ctx(h, 'build'));
  assert.equal(out.status, 'model_fail');
  assert.match(out.error, /no change/);
});

test('a spec trial writes a spec and shows it to nobody', async (t) => {
  const side = spySideEffects(t);
  const h = harness({ text: '# The spec\n\nPin them.' });
  const out = await runner.runStage(ctx(h, 'spec'));
  assert.equal(out.status, 'ok');
  assert.equal(out.parsed.spec, '# The spec\n\nPin them.');
  assert.deepEqual(h.calls.modes, ['scout']);
  assert.deepEqual(side, []);
});

test('a follow-up trial answers or revises on its own branch at the proposal\'s head, and says nothing', async (t) => {
  const side = spySideEffects(t);
  const h = harness({ result: { lastResultText: '```json\n{"action":"revise","reply":"Made it blue","summary":"Blue pins"}\n```', pushOk: true, sha: 'd'.repeat(40), ahead: 1 } });
  const out = await runner.runStage(ctx(h, 'followup'));
  assert.equal(out.status, 'ok');
  assert.equal(out.parsed.action, 'revise');
  assert.equal(out.parsed.moved, true);
  assert.equal(h.calls.prompts[0], followup.followUpPrompt({
    seed: snapshot('followup').texts.seed, proposalBlock: 'DISCUSSION ON PR #5', prNumber: 5,
    replies: JSON.parse(snapshot('followup').texts.replies), canRevise: true,
  }));
  assert.deepEqual(h.calls.modes, ['build']);
  assert.match(out.diff, /app\.js/);
  assert.deepEqual(side, [], 'no revision post, no reconcile, no DM');

  const fix = harness({ result: { lastResultText: '```json\n{"action":"person","reply":"Fails on main too"}\n```', pushOk: true, sha: BASE } });
  const fixed = await runner.runStage(ctx(fix, 'checks_fix'));
  assert.equal(fixed.status, 'ok');
  assert.equal(fixed.parsed.action, 'person');
  assert.equal(fixed.parsed.moved, false, 'the head did not move');
  assert.match(fix.calls.prompts[0], /1 of 10 failed/);
  assert.deepEqual(side, []);
});

test('the catalog: a model entered for some stages only, a prompt too big for a context window, an estimate', () => {
  const kimi = { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi', stages: ['build', 'spec'], contextTokens: 262_144 };
  assert.match(catalog.notApplicableReason(kimi, 'triage', 1000), /entered for build and spec only/);
  assert.equal(catalog.notApplicableReason(kimi, 'build', 100_000), null);
  assert.match(catalog.notApplicableReason(kimi, 'build', 600_000), /needs about \d+K tokens/);
  assert.equal(catalog.notApplicableReason({ label: 'x', contextTokens: null }, 'triage', 9e9), null, 'unknown window: try it');
  assert.equal(catalog.estimateTrialCost({}, 'build', [0.1, 0.2, 5, 0.3]), 5, 'p90 of the history');
  assert.equal(catalog.estimateTrialCost({ inputPerMillion: 0.1, outputPerMillion: 0.4 }, 'triage', []), (1_500_000 * 0.1 + 20_000 * 0.4) / 1e6);
  assert.equal(catalog.estimateTrialCost({}, 'build', []), catalog.FALLBACK_USD.build);
});

test('the cap holds the next trial when what is spent, under way and next would cross it', () => {
  assert.equal(lane.fitsCap({ spentUsd: 49, capUsd: 50, inFlightEst: 0, nextEst: 0.5 }), true);
  assert.equal(lane.fitsCap({ spentUsd: 49, capUsd: 50, inFlightEst: 0.6, nextEst: 0.5 }), false);
  assert.equal(lane.fitsCap({ spentUsd: 50, capUsd: 50, inFlightEst: 0, nextEst: 0 }), true);
  assert.equal(lane.fitsCap({ spentUsd: 50.01, capUsd: 50 }), false);
});

test('launch validation: models, stages, repeats, the $50 default cap and concurrency', () => {
  const ok = lane.validateLaunch({ suiteId: 1, models: ['qwen/qwen3.8-flash', 'z-ai/glm-5.3-flash'], stages: ['triage'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.capUsd, 50);
  assert.equal(ok.repeats, 3);
  assert.equal(ok.baseline, 'z-ai/glm-5.3-flash', 'the baseline when it is in the run');
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['a/b'], stages: ['triage'], capUsd: 5000 }).status, 400);
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['not a model'], stages: ['triage'] }).status, 400);
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['a/b'], stages: ['judge'] }).status, 400);
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['a/b'], stages: ['triage'], concurrency: 8 }).concurrency, 8, 'up to eight at once');
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['a/b'], stages: ['triage'] }).concurrency, 1, 'one when left out');
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['a/b'], stages: ['triage'], concurrency: 9 }).status, 400);
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['a/b'], stages: ['triage'], concurrency: 0 }).status, 400);
  assert.equal(lane.validateLaunch({ suiteId: 1, models: [], stages: ['triage'] }).status, 400);
});

test('after a restart: only a trial\'s last turn is finished from its journal, read as the live stage reads it', async (t) => {
  const side = spySideEffects(t);
  const scout = { mode: 'scout' };
  const build = { mode: 'build' };
  assert.equal(runner.resumableTurn('triage', scout), true);
  assert.equal(runner.resumableTurn('followup', build), true);
  assert.equal(runner.resumableTurn('checks_fix', build), true);
  assert.equal(runner.resumableTurn('build', build), true, 'the build turn is a build\'s last');
  assert.equal(runner.resumableTurn('build', scout), false, 'its spec turn has the build still to run');
  assert.equal(runner.resumableTurn('dm', scout), false, 'a DM conversation is several turns');
  assert.equal(runner.resumableTurn('spec', scout), false);
  assert.equal(runner.resumableTurn('triage', null), false);

  // A follow-up that revised: the same reader as the live stage, diffed from its recorded base.
  const h = harness();
  const out = await runner.recoverStage({
    stage: 'followup', snapshot: snapshot('followup'), task: { id: 1, stage: 'followup', reference: {} }, trial: TRIAL,
    session: { id: 7001, spec_md: '' }, activeTurn: build, repo: REPO, deps: h.deps, baseSha: BASE, branch: 'bench/r3-t44',
    result: { lastResultText: '```json\n{"action":"revise","reply":"Made it blue","summary":"Blue pins"}\n```', pushOk: true, sha: 'd'.repeat(40), ahead: 1 },
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.parsed.action, 'revise');
  assert.equal(out.parsed.moved, true);
  assert.equal(out.build_sha, 'd'.repeat(40));
  assert.match(out.diff, /app\.js/);
  assert.deepEqual(h.gh.calls.pinned, [], 'nothing is cut or pushed by recovery');
  // A triage turn that ended on the trial's clock is a timeout, as live.
  const timedOut = await runner.recoverStage({
    stage: 'triage', snapshot: snapshot('triage'), task: { id: 1, stage: 'triage', reference: {} }, trial: TRIAL,
    session: { id: 7001 }, activeTurn: scout, repo: REPO, deps: h.deps, baseSha: BASE, timedOut: true, result: { lastResultText: '' },
  });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(await runner.recoverStage({
    stage: 'dm', snapshot: snapshot('triage'), task: { id: 1, stage: 'dm', reference: {} }, trial: TRIAL,
    session: { id: 7001 }, activeTurn: scout, repo: REPO, deps: h.deps, result: {},
  }), null);
  assert.deepEqual(side, []);
});
