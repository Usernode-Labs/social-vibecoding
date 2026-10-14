'use strict';

// #3654: a benchmark trial runs a stage of the Homeroom bot on a candidate
// model with NOTHING leaving the benchmark: no post, no comment, no DM, no
// pull request, no proposal; GitHub only read, and written only on the
// trial's own `bench/` branch. Every stage is run here against stubbed
// workers with every side-effecting entry point spied on, and none of them
// may be called. Also: the stages rebuild the real prompts from the
// snapshot, start at its base commit, and classify how a turn ended; and,
// run on durable steps as a trial is (services/build-runs.js), a stage a
// restart caught goes on from the last step it saved: a turn under way is
// followed, never dispatched again, and the branch is never cut again.

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
const durableSteps = require('../src/services/durable-steps');

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

// `activeTurn` is a turn record a restart left on the trial's session,
// which a later attempt follows.
function harness({ text = '', result = null, sessionsOverride = null, activeTurn = null } = {}) {
  const calls = { prompts: [], modes: [], models: [], queries: [], ensured: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/INSERT INTO chat_sessions/.test(s)) return { rows: [{ id: 7001, branch_name: params[2] ?? null, agent_model: params[4] }] };
      // A session an earlier attempt opened, read back.
      if (/SELECT \* FROM chat_sessions WHERE id = \$1/.test(s)) return { rows: [{ id: Number(params[0]), branch_name: 'bench/r3-t44', agent_model: null }] };
      if (/SELECT active_turn FROM chat_sessions/.test(s)) return { rows: activeTurn ? [{ active_turn: activeTurn }] : [] };
      if (/'\{restarts\}'/.test(s)) return { rows: activeTurn ? [{ restarts: 1 }] : [] };
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
      seed, build_note: 'Pin the markers.', proposal_block: 'DISCUSSION ON PR #5', spec: '# Pin the markers\n\nThey stay put.',
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

// A trial's stage on durable steps, as the workflow kernel runs it
// (services/build-runs.js): every state it saves is kept here, so a later
// attempt can resume from any of them, as the next leader does after a
// restart that came just after that step was saved.
function keeping({ resumeFrom = null, signal = null } = {}) {
  const saves = [];
  const steps = durableSteps.durable({ resumeFrom, signal, lostAttempts: resumeFrom ? 1 : 0, checkpoint: async (state) => { saves.push(state); } });
  return { steps, saves };
}
const onSteps = (h, steps) => ({ deps: { ...h.deps, durable: steps } });

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

test('a first version\'s triage trial is told the project\'s people the original look was told', async (t) => {
  spySideEffects(t);
  const members = {
    people: [{ username: 'jordan_t1004', name: 'Jordan', creator: true, invited: false }, { username: 'sam_t1004', name: null, creator: false, invited: true }],
    more: 0, emailInvites: 0,
  };
  const h = harness({ text: '```json\n{"verdict":"empty","reason":"x"}\n```' });
  const snap = snapshot('triage', { firstVersion: true, members });
  await runner.runStage(ctx(h, 'triage', { snapshot: snap }));
  assert.equal(h.calls.prompts[0], bot.triagePromptFor({ seed: snap.texts.seed, issueNumber: 12, firstVersion: true, members }));
  assert.match(h.calls.prompts[0], /==== WHO IS IN THIS PROJECT ====[\s\S]*- Jordan \(@jordan_t1004\), who made the project\n- @sam_t1004, invited and not joined yet/);
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
  assert.equal(args.onSpec, null, 'the spec is posted nowhere: it is the build\'s own step');
  assert.equal(args.deps.votesRouter, undefined, 'no route to promote with');
  assert.equal(args.telemetry, 'homeroom_bench');
  assert.equal(out.build_branch, 'bench/r3-t44');
  assert.equal(out.build_commits, 2);
  assert.deepEqual(h.gh.calls.deleted, ['bench/r3-t44'], 'an earlier claim\'s branch of the same trial goes first');
  assert.deepEqual(h.gh.calls.pinned, [{ branch: 'bench/r3-t44', sha: BASE }], 'then it is cut at the base');
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
    seed: snapshot('followup').texts.seed, proposalBlock: 'DISCUSSION ON PR #5', spec: '# Pin the markers\n\nThey stay put.', prNumber: 5,
    replies: JSON.parse(snapshot('followup').texts.replies), canRevise: true,
  }));
  assert.match(h.calls.prompts[0], /They stay put\./, 'the spec the run read (#3703) is replayed with it');
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

test('every worker a stage starts is sealed at the trial\'s base commit; the bot\'s own workers never are', async (t) => {
  spySideEffects(t);
  const results = {
    triage: { lastResultText: 'no block' },
    spec: { lastResultText: '# The spec' },
    build: (opts) => (opts.mode === 'scout' ? { lastResultText: '# Spec' } : { pushOk: true, ahead: 1, sha: 'c'.repeat(40) }),
    followup: { lastResultText: '```json\n{"action":"person","reply":"x"}\n```' },
    checks_fix: { lastResultText: '```json\n{"action":"person","reply":"x"}\n```' },
  };
  for (const [stage, result] of Object.entries(results)) {
    const h = harness({ result });
    // eslint-disable-next-line no-await-in-loop
    await runner.runStage(ctx(h, stage));
    assert.ok(h.calls.ensured.length >= 1, `${stage} started a worker`);
    for (const opts of h.calls.ensured) assert.equal(opts.pinnedBase, BASE, `${stage}: sealed at the snapshot's base`);
  }
  // A snapshot with no base is built at main's tip as it was when the trial
  // started, and sealed there.
  const h = harness({ result: results.build });
  const noBase = ctx(h, 'build');
  noBase.snapshot = { ...noBase.snapshot, baseSha: null };
  await runner.runStage(noBase);
  assert.deepEqual(h.calls.ensured.map((o) => o.pinnedBase), ['f'.repeat(40)]);
  // The live bot's build (no runner, no wrapper) passes no pinned base.
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot-live.js'), 'utf8');
  assert.doesNotMatch(src, /pinnedBase/);
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

// Run 196's last ten trials, failed on their first request by the bench
// key's weekly limit at OpenRouter: the platform's fault, not the model's.
test('a provider refusing the key for its spending limit fails the trial as the platform, never as the model', () => {
  const run196 = 'the build turn failed (the agent exited with code 1); last activity: Failed to authenticate. API Error: 403 Key limit exceeded (weekly limit). Manage it using https://openrouter.ai/workspaces/default/';
  for (const error of [run196, '402 Insufficient credits', 'This request requires more credits, or fewer max_tokens']) {
    assert.equal(lane.providerLimitHit(error), true, error);
    assert.deepEqual(lane.asPlatformFault({ status: 'model_fail', error, cost_usd: 0.04 }), { status: 'infra_fail', error, cost_usd: 0.04 });
  }
  for (const error of ['the build produced no change to propose', 'unparseable: no action block', '403 Forbidden', null]) {
    assert.equal(lane.providerLimitHit(error), false, String(error));
    assert.equal(lane.asPlatformFault({ status: 'model_fail', error }).status, 'model_fail');
  }
  assert.equal(lane.asPlatformFault({ status: 'timeout', error: run196 }).status, 'timeout', 'only a model failure is read again');
  assert.equal(lane.asPlatformFault({ status: 'ok', error: null }).status, 'ok');
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
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['a/b'], stages: ['triage'], concurrency: 9 }).concurrency, 9, 'up to nine at once, as a studio run');
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['a/b'], stages: ['triage'] }).concurrency, 1, 'one when left out');
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['a/b'], stages: ['triage'], concurrency: 10 }).status, 400);
  assert.equal(lane.validateLaunch({ suiteId: 1, models: ['a/b'], stages: ['triage'], concurrency: 0 }).status, 400);
  assert.equal(lane.validateLaunch({ suiteId: 1, models: [], stages: ['triage'] }).status, 400);
});

// ── After a restart ─────────────────────────────────────────────────────
//
// A trial runs as a durable build (services/bench/lane.js runTrial): each
// part of its stage is a durable step, and a restart's next attempt carries
// it on from the last one it saved. Each test runs a first attempt, keeps
// every state it saved, and runs the next attempt from one of them.

const REVISED = { lastResultText: '```json\n{"action":"revise","reply":"Made it blue","summary":"Blue pins"}\n```', pushOk: true, sha: 'd'.repeat(40), ahead: 1 };

test('after a restart: a trial\'s turn the restart caught is followed through its journal to its end and read as the live stage reads it; nothing is cut or dispatched again', async (t) => {
  const side = spySideEffects(t);
  // The first attempt: its follow-up turn is dispatched, its record written,
  // and the process stops while the turn runs on in its worker.
  const first = harness({ result: REVISED });
  const stop = new AbortController();
  first.deps.worker.execInWorker = async (id, opts) => {
    first.calls.modes.push(opts.mode);
    await opts.onTurnRecord({ turnId: 'turn-1', journal: '/journals/t.log' });
    stop.abort();
    return new Promise(() => {});
  };
  const a = keeping({ signal: stop.signal });
  await assert.rejects(runner.runStage(ctx(first, 'followup', onSteps(first, a.steps))), { code: 'steps_stopped' },
    'a stop is not the trial\'s failure: its next attempt carries it on');
  const kept = a.saves.at(-1);
  assert.deepEqual(kept['turn:followup'].record, { turnId: 'turn-1', journal: '/journals/t.log' }, 'the turn\'s record, kept as it was written');
  assert.deepEqual(first.gh.calls.pinned, [{ branch: 'bench/r3-t44', sha: BASE }], 'the branch was cut once, at the base');

  // The next attempt finds the record on the session and its worker still
  // running, and follows the turn to where it ended: it revised.
  const h = harness({ result: REVISED, activeTurn: { turnId: 'turn-1', journal: '/journals/t.log', mode: 'build', phase: 'executing', backend: 'codex_openrouter' } });
  const followed = [];
  Object.assign(h.deps.worker, {
    workerRuntimeName: (id) => `w-${id}`,
    async getWorkerStatus() { return 'running'; },
    adoptWarmWorker(id, name) { followed.push(['adopt', name]); },
    async resumeTurnFromJournal(id, opts) { followed.push(['resume', opts.journal]); return REVISED; },
    async markTurnTail() { return true; },
    async finishTurn(id, ids) { followed.push(['finish', ids.turnId]); return true; },
  });
  Object.assign(h.deps.agentTurn, {
    async persistRecoveredAgentThread() {},
    async settleRecoveredAgentAttempt() { return { estimatedCost: { estimatedCostUsd: 0.07 } }; },
  });
  const b = keeping({ resumeFrom: kept });
  const out = await runner.runStage(ctx(h, 'followup', onSteps(h, b.steps)));
  assert.equal(out.status, 'ok', out.error);
  assert.equal(out.parsed.action, 'revise', 'read as the live stage reads it');
  assert.equal(out.parsed.moved, true);
  assert.equal(out.build_sha, 'd'.repeat(40));
  assert.match(out.diff, /app\.js/, 'diffed from the base it was cut at');
  assert.equal(out.cost_usd, 0.07, 'what the followed turn cost, settled on the ledger');
  assert.equal(out.session_id, 7001, 'on the session the first attempt opened');
  assert.deepEqual(h.calls.modes, [], 'never dispatched again');
  assert.deepEqual(h.calls.ensured, [], 'its worker taken as the restart left it');
  assert.deepEqual(followed, [['adopt', 'w-7001'], ['resume', '/journals/t.log'], ['finish', 'turn-1']],
    'followed to its end, its record released only then');
  assert.deepEqual(h.gh.calls.deleted, [], 'its branch is not cut again');
  assert.deepEqual(h.gh.calls.pinned, []);
  assert.equal(b.saves.at(-1)['turn:followup'].phase, 'done');
  assert.deepEqual(side, []);
});

test('a build trial a restart caught after its spec goes on from the spec it kept: one build turn, on the same session and branch, never cut again', async (t) => {
  const side = spySideEffects(t);
  const result = (opts) => (opts.mode === 'scout' ? { lastResultText: '# Pin the markers\n\nDo it.' } : { pushOk: true, ahead: 2, sha: 'c'.repeat(40) });
  const first = harness({ result });
  const a = keeping();
  const done = await runner.runStage(ctx(first, 'build', onSteps(first, a.steps)));
  assert.equal(done.status, 'ok', done.error);
  // A restart just after the spec was saved.
  const atSpec = a.saves.find((s) => 'build/spec' in s);
  assert.equal(atSpec['build/spec'].specMd, '# Pin the markers\n\nDo it.', 'the spec, kept as it was written');
  const h = harness({ result });
  const out = await runner.runStage(ctx(h, 'build', onSteps(h, keeping({ resumeFrom: atSpec }).steps)));
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, ['build'], 'no spec turn: the kept spec is built from');
  assert.match(h.calls.prompts[0], /Do it\./, 'the build turn is handed it');
  assert.equal(out.parsed.spec, '# Pin the markers\n\nDo it.');
  assert.equal(out.build_commits, 2);
  assert.equal(out.session_id, done.session_id, 'built on the session the spec was written in');
  assert.deepEqual(h.gh.calls.deleted, [], 'its branch is not cut again');
  assert.deepEqual(h.gh.calls.pinned, []);
  assert.deepEqual(side, []);
});

// Bench run 193: recovery that re-established a trial from its checkpoint
// pinned the branch back to the build the checkpoint named, under the fix
// that had landed after it.
test('a build turn that pushed after its last save and lost its record is taken off its branch: never dispatched again, its branch never pinned back', async (t) => {
  const side = spySideEffects(t);
  const result = (opts) => (opts.mode === 'scout' ? { lastResultText: '# Pin the markers\n\nDo it.' } : { pushOk: true, ahead: 2, sha: 'c'.repeat(40) });
  const first = harness({ result });
  const a = keeping();
  assert.equal((await runner.runStage(ctx(first, 'build', onSteps(first, a.steps)))).status, 'ok');
  // A restart just after the build turn was started, and saved as started.
  const atTurn = a.saves.find((s) => s['build/turn:build']?.phase === 'started');
  assert.equal(atTurn['build/turn:build'].headBefore, 'f'.repeat(40), 'with the branch tip it started from');
  // The turn pushed while nobody watched, and no record of it is left.
  const h = harness({ result });
  h.gh.getBranchSha = async () => 'e'.repeat(40);
  const out = await runner.runStage(ctx(h, 'build', onSteps(h, keeping({ resumeFrom: atTurn }).steps)));
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, [], 'not dispatched again');
  assert.equal(out.build_sha, 'e'.repeat(40), 'the branch tip is its result');
  assert.deepEqual(h.gh.calls.pinned, [], 'and the branch is left where the turn put it');
  assert.deepEqual(h.gh.calls.deleted, []);
  assert.match(out.diff, /app\.js/);
  assert.deepEqual(side, []);
});
