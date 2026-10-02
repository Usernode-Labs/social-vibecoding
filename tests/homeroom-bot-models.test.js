'use strict';

// #3654: each stage of the Homeroom bot runs on a model of its own, and the
// model that runs is the model that is recorded.
//
// The bug this pins: a turn runs whatever model its SESSION carries
// (agent-turn resolveCodexRuntimeContext reads session.agent_model), and the
// bot's triage session per app was stamped once, when it was created. Change
// the model later and the run ledger recorded the new one while the turn
// kept running the old. stampSessionModel makes the session agree with the
// stage's model before every turn.
//
// Also here: each run records a replayable snapshot of what it read
// (services/homeroom-bot-snapshots.js), a model failure included and a
// platform fault not.

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

test('per-stage models: parsed from settings, blank or malformed means the platform default', () => {
  const s = bot.parseSettings([
    { key: bot.KEY_MODELS.triage, value: 'xiaomi/mimo-v2.6-pro' },
    { key: bot.KEY_MODELS.build, value: 'not a model id' },
  ]);
  assert.deepEqual(s.models, { triage: 'xiaomi/mimo-v2.6-pro', spec: '', build: '', followup: '' });
  const config = { openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };
  assert.equal(bot.stageModel(s, config, 'triage'), 'xiaomi/mimo-v2.6-pro');
  assert.equal(bot.stageModel(s, config, 'build'), 'z-ai/glm-5.3-flash', 'a malformed value falls back');
  assert.equal(bot.stageModel(s, config, 'spec'), 'z-ai/glm-5.3-flash');
  assert.equal(bot.stageModel(null, {}, 'triage'), null);
});

test('per-stage models: the settings patch accepts an id or blank, and refuses anything else', () => {
  const ok = bot.validateSettingsPatch({ models: { triage: 'deepseek/deepseek-v4.1-flash', followup: '' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.updates, [
    [bot.KEY_MODELS.triage, 'deepseek/deepseek-v4.1-flash'],
    [bot.KEY_MODELS.followup, ''],
  ]);
  assert.match(bot.validateSettingsPatch({ models: { judge: 'a/b' } }).error, /unknown stage "judge"/);
  assert.match(bot.validateSettingsPatch({ models: { build: 'gpt; rm -rf' } }).error, /OpenRouter model id/);
  assert.match(bot.validateSettingsPatch({ models: ['a/b'] }).error, /object/);
});

// The triage harness of tests/homeroom-bot.test.js, trimmed, with a session
// born on an OLD model and a resolver that reports what it was handed.
function harness({ verdictText, sessionModel = 'old/model', result = null } = {}) {
  const calls = { queries: [], resolvedWith: [], exec: [] };
  const sessionRow = {
    id: 501, user_id: 77, app_id: 9, branch_name: 'main', agent_backend: 'codex_openrouter', agent_model: sessionModel,
  };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT \* FROM chat_sessions/.test(s)) return { rows: [{ ...sessionRow }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 900 }] };
      if (/INSERT INTO homeroom_bot_run_snapshots/.test(s)) return { rows: [{ id: 41 }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async getBranchSha() { return 'a'.repeat(40); },
      async fetchPublicIssue() { return { issue: { number: 12, title: 'Pins drift', body: 'They drift.', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [{ author: 'ann', body: 'on zoom', createdAt: '2026-09-20T00:00:00Z' }] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-501'; },
      async execInWorker(id, opts) { calls.exec.push(opts); return result || { lastResultText: verdictText, inputTokens: 10, outputTokens: 5 }; },
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn: {
      async resolveCodexRuntimeContext({ session }) {
        // What the platform does: the session's model, not the argument.
        calls.resolvedWith.push(session.agent_model);
        return { agentModel: session.agent_model };
      },
    },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: { async loadIssueThread() { return { messages: [{ author: 'pat', body: 'the route map', createdAt: '2026-09-21T00:00:00Z' }] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: {
      buildHeadlessSeed: require('../src/routes/sessions').buildHeadlessSeed,
      async runCodexAttemptLoop({ dispatchOnce, resolveRuntime }) {
        const ctx = await resolveRuntime();
        const r = await dispatchOnce(ctx);
        return { result: r, error: null, estimatedCostUsd: 0.01 };
      },
    },
    activeWorkers: new Set(),
  };
  return { pool, deps, calls };
}

const APP = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo', self_hosted: false };
const ITEM = { id: 31, app_id: 9, issue_number: 12, priority: 1, reason: 'new', thread_seen_at: '2026-09-20T00:00:00Z' };
const BOT = { id: 77, username: 'homeroom_bot' };
const READY = '```json\n{"verdict":"ready","determined":true,"build_note":"Pin the markers to the map."}\n```';

test('the triage turn runs the triage model, not the one its session was born with, and records the same one', async () => {
  const { pool, deps, calls } = harness({ verdictText: READY });
  const settings = { ...bot.DEFAULTS, models: { triage: 'qwen/qwen3.8-flash', spec: '', build: '', followup: '' } };
  const out = await bot.runTriage(pool, { openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' }, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings, deps,
  });
  assert.equal(out.verdict, 'ready');
  assert.deepEqual(calls.resolvedWith, ['qwen/qwen3.8-flash'], 'the session was re-stamped before the turn resolved its model');
  const stamp = calls.queries.find((q) => /UPDATE chat_sessions SET agent_model = \$2 WHERE id = \$1/.test(q.s));
  assert.deepEqual(stamp.params, [501, 'qwen/qwen3.8-flash']);
  const insert = calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.equal(insert.params[13], 'qwen/qwen3.8-flash', 'the ledger records the model that ran');
  assert.equal(calls.exec[0].model, 'qwen/qwen3.8-flash');
});

test('a session already on the stage model is left alone', async () => {
  const { pool, deps, calls } = harness({ verdictText: READY, sessionModel: 'z-ai/glm-5.3-flash' });
  await bot.runTriage(pool, { openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' }, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: { ...bot.DEFAULTS }, deps,
  });
  assert.ok(!calls.queries.some((q) => /SET agent_model/.test(q.s)));
  assert.deepEqual(calls.resolvedWith, ['z-ai/glm-5.3-flash']);
});

test('a triage run records a replayable snapshot: seed, frozen thread, prompt and base commit', async () => {
  const { pool, deps, calls } = harness({ verdictText: READY });
  await bot.runTriage(pool, { openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' }, {
    bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: { ...bot.DEFAULTS }, deps,
  });
  const snap = calls.queries.find((q) => /INSERT INTO homeroom_bot_run_snapshots/.test(q.s));
  assert.ok(snap, 'a snapshot row is written');
  const [runId, stage, appId, issueNumber, baseSha, promptHash, texts, extra] = snap.params;
  assert.deepEqual([runId, stage, appId, issueNumber, baseSha], [900, 'triage', 9, 12, 'a'.repeat(40)]);
  const names = Object.keys(JSON.parse(texts)).sort();
  assert.deepEqual(names, ['prompt', 'seed', 'thread']);
  assert.equal(JSON.parse(texts).prompt, promptHash, 'the prompt hash is the stored prompt\'s');
  assert.equal(JSON.parse(extra).model, 'z-ai/glm-5.3-flash');
  const blobs = calls.queries.filter((q) => /INSERT INTO homeroom_bot_snapshot_blobs/.test(q.s));
  assert.equal(blobs.length, 3, 'one compressed blob per text');
  // The prompt the snapshot holds rebuilds from its seed alone.
  const seed = require('../src/routes/sessions').buildHeadlessSeed(12, { title: 'Pins drift', body: 'They drift.' },
    [{ author: 'ann', body: 'on zoom', createdAt: '2026-09-20T00:00:00Z' }], 'usernode-bot',
    [{ author: 'pat', body: 'the route map', createdAt: '2026-09-21T00:00:00Z' }]);
  assert.equal(calls.exec[0].prompt, bot.triagePromptFor({ seed, issueNumber: 12 }));
});

test('a model failure is snapshotted (a better model might get it right); a platform fault is not', async () => {
  const bad = harness({ verdictText: 'no json here at all' });
  const out = await bot.runTriage(bad.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: { ...bot.DEFAULTS }, deps: bad.deps });
  assert.equal(out.verdict, 'failed');
  assert.ok(bad.calls.queries.some((q) => /INSERT INTO homeroom_bot_run_snapshots/.test(q.s)));

  const infra = harness({ verdictText: READY });
  infra.deps.worker.ensureWorker = async () => { throw new Error('quota'); };
  const out2 = await bot.runTriage(infra.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: { ...bot.DEFAULTS }, deps: infra.deps });
  assert.equal(out2.reason, 'infra');
  assert.ok(!infra.calls.queries.some((q) => /INSERT INTO homeroom_bot_run_snapshots/.test(q.s)));
});

test('a build stamps its spec model for the spec turn and its build model for the build turn', async () => {
  const seen = [];
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 5001, agent_model: params[4] }] };
      return { rows: [] };
    },
  };
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'w'; },
      async execInWorker(_id, opts) {
        return opts.mode === 'scout' ? { lastResultText: '# Spec\n\nPin it.' } : { pushOk: true, ahead: 1, sha: 'b'.repeat(40) };
      },
      stopTurn: async () => {},
      clearPendingStop() {},
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        seen.push([args.mode, args.session.agent_model]);
        return { result: await args.dispatchOnce({}), error: null, estimatedCostUsd: 0.01 };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `dev/s${sessionId}` }; } },
    activeWorkers: new Set(),
  };
  const out = await live.buildAndPropose({
    pool, deps, config: {}, bot: BOT, app: APP, repo: { owner: 'o', repo: 'r' }, issueNumber: 12,
    issue: { title: 'Pins' }, seed: 'seed', buildNote: 'note', turnBudgetMs: 60_000,
    model: 'openai/gpt-5.6-luna', specModel: 'minimax/minimax-m3', propose: false,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, [['scout', 'minimax/minimax-m3'], ['build', 'openai/gpt-5.6-luna']]);
});

test('a follow-up turn runs the follow-up model on a proposal session born with the build model', async () => {
  const followup = require('../src/services/homeroom-bot-followup');
  const queries = [];
  const resolvedWith = [];
  const pool = { async query(s, params) { queries.push({ s, params }); return { rows: [], rowCount: 1 }; } };
  const session = { id: 602, branch_name: 'bot/todo-12', agent_model: 'moonshotai/kimi-k2.7-code' };
  const out = await followup.runFollowUpTurn({
    pool, config: {}, bot: BOT, repo: { owner: 'usernode-bot', repo: 'todo' }, session, prompt: 'Address the review.',
    mode: 'build', issueNumber: 12, turnBudgetMs: 60000, model: 'qwen/qwen3.8-flash',
    deps: {
      worker: {
        async ensureWorkerImage() {}, async ensureWorker() { return 'usernode-worker-602'; },
        async execInWorker() { return { lastResultText: 'done' }; }, async stopTurn() {},
      },
      agentTurn: { async resolveCodexRuntimeContext({ session: s }) { resolvedWith.push(s.agent_model); return { agentModel: s.agent_model }; } },
      sessions: {
        async runCodexAttemptLoop({ dispatchOnce, resolveRuntime }) {
          const r = await dispatchOnce(await resolveRuntime());
          return { result: r, error: null, estimatedCostUsd: 0.01 };
        },
      },
      activeWorkers: new Set(),
    },
  });
  assert.ok(!out.routed?.error, JSON.stringify(out.routed));
  assert.deepEqual(resolvedWith, ['qwen/qwen3.8-flash'], 'the session was re-stamped before the turn resolved its model');
  const stamp = queries.find((q) => /UPDATE chat_sessions SET agent_model = \$2 WHERE id = \$1/.test(q.s));
  assert.deepEqual(stamp?.params, [602, 'qwen/qwen3.8-flash']);
});
