// The nudge (homeroom-bot-live.js buildNudgePrompt): a build turn that ends
// without failing and changes nothing gets ONE more turn in the same
// session, on what is left of the build's clock, before the build is said
// to have failed. 23 builds ended "the build produced no change to propose"
// between 29 Sep and 8 Oct 2026; Hiking Tier List (run 1166, session 7192)
// stopped after 2 requests, one shell command and 34 seconds.
//
// What such a turn said and did is kept for admins (on the run, or the
// trial), and counted, with no text, as events a weekly query reads the
// early-quit rate per provider from.
//
// Run with: node --test tests/homeroom-bot-build-nudge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const live = require('../src/services/homeroom-bot-live');
const bot = require('../src/services/homeroom-bot');
const worker = require('../src/services/worker');
const events = require('../src/services/events');
const runner = require('../src/services/bench/runner');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const APP = { id: 9, slug: 'hiking-tier-list', name: 'Hiking Tier List', repo_url: 'https://github.com/usernode-bot/hiking' };
const REPO = { owner: 'usernode-bot', repo: 'hiking' };
const BOT = { id: 77, username: 'homeroom_bot' };
const MIN = 60 * 1000;

// What run 1166's build turn came back with: it pushed the branch
// unchanged, after 2 requests on GMICloud and one shell command.
const QUIT = Object.freeze({
  agentHarness: 'claude', ccExit: 0, exitCode: 0, pushOk: true, ahead: 0, sha: 'f'.repeat(40),
  agentThreadId: 'claude-session-7192', agentModel: 'z-ai/glm-5.3-flash',
  routedProvider: 'GMICloud', routedProviders: ['GMICloud'],
  providerTurnCount: 2, toolCallCount: 1, fileChangeCount: 0, outputTokens: 157,
  lastResultText: 'I have reviewed the spec. The plan is to build the tier list with drag and drop. Let me know if you want changes.',
});
const BUILT = Object.freeze({
  agentHarness: 'claude', ccExit: 0, exitCode: 0, pushOk: true, ahead: 3, sha: 'a'.repeat(40),
  routedProvider: 'Together', routedProviders: ['Together'],
  providerTurnCount: 152, toolCallCount: 150, fileChangeCount: 29, outputTokens: 48_000,
  lastResultText: 'Built the tier list: four tiers, drag to sort, saved per person.',
});

/**
 * buildAndPropose with a scripted build turn per call: `turns` are the
 * worker results, in order (the spec turn writes nothing, so the build goes
 * ahead from the plan). `ctx` is what the runtime hands each attempt.
 */
function harness({ turns = [QUIT, BUILT], ctx = null, pendingStop = false, promote = { status: 200, body: { ok: true, prNumber: 42 } } } = {}) {
  const calls = { queries: [], builds: [], loops: [], promoted: [], events: [], order: [] };
  const script = [...turns];
  const pool = {
    async query(sql, params) {
      calls.queries.push({ sql: String(sql), params });
      if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 5001, app_id: APP.id, user_id: BOT.id }] };
      if (/INSERT INTO events/.test(sql)) {
        calls.events.push({ type: params[3], userId: params[0], appId: params[1], sessionId: params[2], metadata: JSON.parse(params[4]) });
        calls.order.push(`event:${params[3]}`);
      }
      return { rows: [] };
    },
  };
  const express = require('express');
  const router = express.Router();
  router.post('/api/sessions/:id/promote', (req, res) => {
    calls.promoted.push(req.params.id);
    res.status(promote.status).json(promote.body);
  });
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-5001'; },
      async execInWorker(_id, opts) {
        if (opts.mode === 'scout') return { lastResultText: '' };
        calls.builds.push(opts);
        calls.order.push('build');
        const next = script.shift();
        if (!next) throw new Error('no more scripted turns');
        return typeof next === 'function' ? next(opts) : { ...next };
      },
      stopTurn() { return Promise.resolve(); },
      getPendingStop() { return pendingStop ? new Date() : null; },
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        if (args.mode === 'scout') return { result: await args.dispatchOnce({}), error: null, estimatedCostUsd: 0.01 };
        calls.loops.push(args);
        const given = typeof ctx === 'function' ? ctx(args) : (ctx || {});
        const r = await args.dispatchOnce({ ...given });
        return { result: r, error: null, estimatedCostUsd: 0.05, logicalTurnId: `00000000-0000-4000-8000-00000000000${calls.loops.length}` };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `homeroom_bot/s${sessionId}` }; } },
    activeWorkers: new Set(),
    votesRouter: router,
    seesImages: false,
  };
  return { pool, deps, calls };
}

const ARGS = {
  config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 1,
  issue: { title: 'First version' }, seed: 'Please build issue #1.',
  buildNote: 'A tier list of hikes.', turnBudgetMs: 40 * MIN, model: 'z-ai/glm-5.3-flash',
  origin: { lane: 'live', runId: 1166 },
};

const archived = (h) => h.calls.queries.some((q) => /SET status = 'archived'/.test(q.sql));

// ── The nudge ─────────────────────────────────────────────────────────────

test('a build turn that changed nothing is nudged once in its own session, builds, and is proposed', async () => {
  const h = harness({ ctx: (args) => (args.resumeThreadId ? { resumeSessionId: args.resumeThreadId, agentHarness: 'claude' } : { agentHarness: 'claude' }) });
  const kept = [];
  const out = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...ARGS,
    onNoChange: async (noChange) => { kept.push(JSON.parse(JSON.stringify(noChange))); h.calls.order.push('kept'); },
  });

  assert.equal(out.ok, true);
  assert.equal(out.prNumber, 42);
  assert.deepEqual(h.calls.promoted, ['5001'], 'proposed once, from what the nudge built');
  assert.equal(out.sha, 'a'.repeat(40));
  assert.equal(out.commits, 3);
  assert.equal(h.calls.builds.length, 2, 'the build turn, then its one nudge');

  // The same session and conversation: the nudge resumes the build's thread.
  const [build, nudge] = h.calls.loops;
  assert.equal(build.resumeThreadId, null);
  assert.equal(nudge.resumeThreadId, 'claude-session-7192');
  assert.equal(h.calls.builds[1].resumeSessionId, 'claude-session-7192');
  assert.equal(build.telemetryComponent, 'homeroom_bot_build');
  assert.equal(nudge.telemetryComponent, 'homeroom_bot_build_nudge', 'its own name on the ledger');
  assert.equal(h.calls.builds[1].telemetryComponent, 'homeroom_bot_build_nudge');
  assert.equal(h.calls.builds[1].mode, 'build');
  assert.equal(h.calls.builds[1].model, 'z-ai/glm-5.3-flash', 'the same model');
  assert.equal(h.calls.builds[1].discardFailedTurn, true);

  // What it is told: the nudge alone, since the conversation goes on.
  const sent = h.calls.builds[1].prompt;
  assert.match(sent, /^The plan is approved\. You ended your turn without changing anything, so there is nothing to propose yet\.\n/);
  assert.match(sent, /Implement the spec now, in this repository/);
  assert.match(sent, /Do not stop to summarize, ask a question or describe a plan until the change is made/);
  assert.match(sent, /The platform still stops this build at \d\d:\d\d UTC\.$/);
  assert.ok(!sent.includes('A tier list of hikes.'), 'not the whole prompt again: the conversation has it');
  // And, for a fresh run Claude Code makes if it cannot resume, the whole
  // build prompt with the nudge after it.
  const fallback = h.calls.builds[1].resumeFallbackPrompt;
  assert.ok(fallback.startsWith(h.calls.builds[0].prompt), 'the build prompt first');
  assert.match(fallback, /A first try at this build ended without changing anything, so there was nothing to propose\. The plan is approved\./);

  // What is kept: the first turn's words and facts, and that the nudge built it.
  assert.deepEqual(out.noChange.turns.map((t) => [t.turn, t.ended]), [['build', 'no_change'], ['nudge', 'changed']]);
  assert.equal(out.noChange.nudged, true);
  assert.equal(out.noChange.notNudged, null);
  assert.equal(out.noChange.committed, true);
  const first = out.noChange.turns[0];
  assert.equal(first.said, QUIT.lastResultText);
  assert.deepEqual({
    provider: first.provider, providers: first.providers, model: first.model, harness: first.harness,
    requests: first.requests, toolCalls: first.toolCalls, fileEdits: first.fileEdits, outputTokens: first.outputTokens,
  }, {
    provider: 'GMICloud', providers: ['GMICloud'], model: 'z-ai/glm-5.3-flash', harness: 'claude',
    requests: 2, toolCalls: 1, fileEdits: 0, outputTokens: 157,
  });
  assert.equal(typeof first.seconds, 'number');
  assert.equal(out.noChange.turns[1].said, null, 'a nudge that built has nothing to explain');
  assert.equal(out.noChange.turns[1].provider, 'Together');
  assert.equal(out.noChange.turns[1].fileEdits, 29);

  // Kept on the run before the nudge starts, so a restart cannot lose it.
  assert.deepEqual(kept.map((k) => k.turns.length), [1]);
  assert.ok(h.calls.order.indexOf('kept') < h.calls.order.lastIndexOf('build'), 'kept before the nudge runs');

  // Counted: the early quit as its turn ended, then the nudge's outcome.
  assert.deepEqual(h.calls.events.map((e) => e.type), ['bot_build_no_change', 'bot_build_nudged']);
  assert.ok(h.calls.order.indexOf('event:bot_build_no_change') < h.calls.order.lastIndexOf('build'),
    'the early quit is counted before the nudge, so a restart in the middle of it cannot lose it');
  const [quit, nudged] = h.calls.events;
  assert.equal(quit.appId, APP.id);
  assert.equal(quit.sessionId, 5001);
  assert.equal(quit.userId, BOT.id);
  assert.deepEqual({
    lane: quit.metadata.lane, runId: quit.metadata.runId, issueNumber: quit.metadata.issueNumber, turn: quit.metadata.turn,
    ended: quit.metadata.ended, provider: quit.metadata.provider, requests: quit.metadata.requests,
    nudged: quit.metadata.nudged, notNudged: quit.metadata.notNudged,
  }, {
    lane: 'live', runId: 1166, issueNumber: 1, turn: 'build', ended: 'no_change', provider: 'GMICloud', requests: 2,
    nudged: true, notNudged: null,
  });
  assert.equal(nudged.metadata.turn, 'nudge');
  assert.equal(nudged.metadata.committed, true);
  assert.equal(nudged.metadata.provider, 'Together');
  for (const e of h.calls.events) assert.ok(!('said' in e.metadata) && !JSON.stringify(e.metadata).includes('tier list with drag'), 'never the agent\'s words');

  // Both turns are the build's cost, and its stage's turns.
  assert.equal(out.costUsd, 0.11);
  assert.deepEqual(out.stageCosts.build.turnIds,
    ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
  assert.ok(!archived(h), 'a proposed build is not put away');
});

test('a nudge that changes nothing too ends the build as before, with what both turns said kept', async () => {
  const again = { ...QUIT, routedProvider: 'GMICloud', lastResultText: 'Here is the plan again: tiers S to D.', toolCallCount: 0, providerTurnCount: 1 };
  const h = harness({ turns: [QUIT, again] });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'the build produced no change to propose', 'the same reason, word for word: the DM and the cards read it');
  assert.deepEqual(h.calls.promoted, []);
  assert.ok(archived(h));
  assert.equal(h.calls.builds.length, 2, 'one nudge, never a second');
  assert.equal(out.noChange.nudged, true);
  assert.equal(out.noChange.committed, false);
  assert.deepEqual(out.noChange.turns.map((t) => [t.turn, t.ended, t.said]), [
    ['build', 'no_change', QUIT.lastResultText],
    ['nudge', 'no_change', 'Here is the plan again: tiers S to D.'],
  ]);
  assert.deepEqual(h.calls.events.map((e) => [e.type, e.metadata.turn]), [
    ['bot_build_no_change', 'build'], ['bot_build_nudged', 'nudge'], ['bot_build_no_change', 'nudge'],
  ]);
  assert.equal(h.calls.events[1].metadata.committed, false);
});

test('a conversation the runtime starts afresh is sent the whole build prompt with the nudge, never the nudge alone', async () => {
  // No resume id on the attempt: a thread another CLI wrote, or one the
  // worker no longer has (Codex asks for a fresh attempt).
  const h = harness({ ctx: { agentHarness: 'codex' } });
  await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  const [build, nudge] = h.calls.builds;
  assert.ok(nudge.prompt.startsWith(build.prompt));
  assert.match(nudge.prompt, /A first try at this build ended without changing anything/);
  assert.equal(nudge.resumeFallbackPrompt, undefined, 'only Claude Code makes its own fresh run');
});

test('a Codex conversation that goes on gets the nudge alone, and no Claude fallback', async () => {
  const h = harness({ ctx: (args) => (args.resumeThreadId ? { resumeSessionId: args.resumeThreadId, agentHarness: 'codex' } : { agentHarness: 'codex' }) });
  await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.match(h.calls.builds[1].prompt, /^The plan is approved\./);
  assert.equal(h.calls.builds[1].resumeFallbackPrompt, undefined);
});

// ── When it is not nudged ───────────────────────────────────────────────

test('no nudge for a turn that failed, under either CLI, or whose dispatch failed', async () => {
  const cases = [
    [{ ...QUIT, ccExit: 1, exitCode: 1 }, /the build turn failed \(the agent exited with code 1\)/],
    [{ ...QUIT, lastResultText: 'API Error: 429 Too Many Requests' }, /the build turn failed \(it ended on an API error\)/],
    [{ ...QUIT, agentHarness: 'codex', ccExit: null, exitCode: 1, agentExit: 1 }, /produced no change/],
  ];
  for (const [result, error] of cases) {
    const h = harness({ turns: [result] });
    const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
    assert.equal(h.calls.builds.length, 1, `not nudged: ${JSON.stringify(result).slice(0, 80)}`);
    assert.match(out.error, error);
    assert.equal(out.noChange, undefined, 'a failed turn is not an early quit');
    assert.deepEqual(h.calls.events, []);
  }
  const h = harness({ turns: [QUIT] });
  h.deps.sessions.runCodexAttemptLoop = async (args) => {
    if (args.mode === 'scout') return { result: { lastResultText: '' }, error: null };
    h.calls.loops.push(args);
    return { error: 'session_busy' };
  };
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.equal(h.calls.loops.length, 1);
  assert.equal(out.error, 'the build turn failed (session_busy)');
});

test('no nudge for a turn stopped on its clock', async (t) => {
  const h = harness({ turns: [QUIT] });
  let release;
  const hung = new Promise((r) => { release = r; });
  h.deps.worker.stopTurn = () => { release(); return Promise.resolve(); };
  const loop = h.deps.sessions.runCodexAttemptLoop;
  h.deps.sessions.runCodexAttemptLoop = async (args) => {
    if (args.mode === 'scout') return loop(args);
    const out = await loop(args);
    await hung;
    return out;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  for (let i = 0; i < 200 && h.calls.builds.length < 1; i += 1) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(40 * MIN);
  const out = await running;
  assert.match(out.error, /^the build ran past its time limit/);
  assert.equal(h.calls.builds.length, 1, 'a stopped turn is never nudged');
  assert.deepEqual(h.calls.events, []);
});

test('no nudge when a stop is waiting on the session, or when its push did not go through', async () => {
  let h = harness({ turns: [QUIT], pendingStop: true });
  let out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.equal(h.calls.builds.length, 1);
  assert.equal(out.error, 'the build produced no change to propose');
  assert.equal(out.noChange.nudged, false);
  assert.equal(out.noChange.notNudged, 'a stop was requested');

  h = harness({ turns: [{ ...QUIT, pushOk: false }] });
  out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.equal(h.calls.builds.length, 1);
  assert.equal(out.error, 'the build produced no change to propose', 'reported as before');
  assert.equal(out.noChange.notNudged, 'its push did not go through', '"you changed nothing" would not be true');
  assert.equal(out.noChange.turns[0].ended, 'not_pushed');
  assert.equal(h.calls.events.length, 1);
  assert.equal(h.calls.events[0].metadata.ended, 'not_pushed');
  assert.equal(h.calls.events[0].metadata.nudged, false);
});

test('no nudge when less than three minutes of the build\'s clock are left; the nudge gets what is left', async () => {
  let h = harness({ turns: [QUIT] });
  let out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, turnBudgetMs: 2 * MIN + 59 * 1000 });
  assert.equal(h.calls.builds.length, 1);
  assert.equal(out.noChange.notNudged, 'less than 3 minutes of its clock were left');
  assert.equal(out.error, 'the build produced no change to propose');
  assert.equal(h.calls.events[0].metadata.notNudged, 'less than 3 minutes of its clock were left');

  // With time left, the nudge's own clock is what is left of the build's,
  // never a new one.
  h = harness();
  const budgets = [];
  const loop = h.deps.sessions.runCodexAttemptLoop;
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => { budgets.push(ms); return realSetTimeout(fn, 0x7fffffff, ...rest); };
  try {
    h.deps.sessions.runCodexAttemptLoop = loop;
    out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, turnBudgetMs: 10 * MIN });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.equal(out.ok, true);
  const turnClocks = budgets.filter((ms) => ms > MIN);
  assert.equal(turnClocks.at(-2), 10 * MIN, 'the build turn\'s clock');
  assert.ok(turnClocks.at(-1) <= 10 * MIN && turnClocks.at(-1) > 9 * MIN, `the nudge gets what is left: ${turnClocks.at(-1)}`);
});

test('whyNotNudge: each reason, and the minimum it keeps', () => {
  const ok = { result: { ...QUIT } };
  assert.equal(live.BUILD_NUDGE_MIN_MS, 3 * MIN);
  assert.equal(live.whyNotNudge({ routed: ok, leftMs: 39 * MIN }), null);
  assert.equal(live.whyNotNudge({ routed: ok, leftMs: 3 * MIN }), null);
  assert.equal(live.whyNotNudge({ routed: ok, leftMs: 3 * MIN - 1 }), 'less than 3 minutes of its clock were left');
  assert.equal(live.whyNotNudge({ routed: ok, stopped: true, leftMs: 39 * MIN }), 'the turn was stopped');
  assert.equal(live.whyNotNudge({ routed: { error: 'dispatch: gone' }, leftMs: 39 * MIN }), 'the turn failed');
  assert.equal(live.whyNotNudge({ routed: { result: { ...QUIT, exitCode: 143 } }, leftMs: 39 * MIN }), 'the turn failed');
  assert.equal(live.whyNotNudge({ routed: { result: { ...QUIT, fatalError: 'x' } }, leftMs: 39 * MIN }), 'the turn failed');
  assert.equal(live.whyNotNudge({ routed: ok, leftMs: 39 * MIN, stopPending: true }), 'a stop was requested');
  assert.equal(live.whyNotNudge({ routed: { result: { ...QUIT, branchMismatch: true } }, leftMs: 39 * MIN }), 'its push did not go through');
  assert.equal(live.whyNotNudge({ routed: { result: { ...BUILT } }, leftMs: 39 * MIN }), 'the turn changed something');
});

test('a build that changed something on its first turn is never nudged and records nothing', async () => {
  const h = harness({ turns: [BUILT] });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.equal(out.ok, true);
  assert.equal(h.calls.builds.length, 1);
  assert.equal(out.noChange, undefined);
  assert.deepEqual(h.calls.events, []);
});

test('the nudge is said in plain words, with no em dash, and the fresh one stands alone', () => {
  const resumed = live.buildNudgePrompt({ stopAt: '21:40' });
  assert.equal(resumed, [
    'The plan is approved. You ended your turn without changing anything, so there is nothing to propose yet.',
    'Implement the spec now, in this repository: make the change it describes, then check that it works the way your instructions above ask.',
    'Do not stop to summarize, ask a question or describe a plan until the change is made: a reply with no tool call ends your turn.',
    'When your turn ends, your working tree is committed and pushed for you, so finish only once the work is in it.',
    'Only if you find you cannot make the change safely, stop and say why.',
    'The platform still stops this build at 21:40 UTC.',
  ].join('\n'));
  const fresh = live.buildNudgePrompt({ fresh: true });
  assert.match(fresh, /^A first try at this build ended without changing anything/);
  assert.doesNotMatch(fresh, /You ended your turn/);
  assert.doesNotMatch(fresh, /still stops this build/, 'no clock line without one');
  assert.doesNotMatch(resumed + fresh, /\u2014/);
});

// ── What is kept ───────────────────────────────────────────────────────────

test('turnFacts: providers in order, counts, and the relay\'s figures when Claude Code reported none', () => {
  const f = live.turnFacts({ routed: { result: { ...QUIT, routedProviders: ['GMICloud', 'Together'], routedProvider: 'Together' } } }, { turn: 'build', model: 'z-ai/glm-5.3-flash', seconds: 34.4 });
  assert.deepEqual(f, {
    turn: 'build', ended: 'no_change', provider: 'Together', providers: ['GMICloud', 'Together'],
    model: 'z-ai/glm-5.3-flash', harness: 'claude', requests: 2, toolCalls: 1, fileEdits: 0, outputTokens: 157, seconds: 34,
  });
  const relay = live.turnFacts({ routed: { result: {
    pushOk: true, ahead: 0, relayUsage: { requests: 3, outputTokens: 210 }, toolCallCount: 0,
  } } });
  assert.equal(relay.requests, 3);
  assert.equal(relay.outputTokens, 210);
  assert.equal(relay.provider, null);
  assert.deepEqual(relay.providers, []);
  assert.equal(relay.seconds, null);
  assert.equal(live.turnFacts({ routed: { result: BUILT } }).ended, 'changed');
  assert.equal(live.turnFacts({ routed: { result: QUIT }, stopped: true }).ended, 'stopped');
  assert.equal(live.turnFacts({ routed: { error: 'x' } }).ended, 'failed');
});

test('what the agent said is clipped and redacted, and display only', () => {
  const said = live.agentSaid(`Done. My key is sk-or-v1-abcdef123456 ${'x'.repeat(2000)}`);
  assert.ok(!said.includes('sk-or-v1-abcdef123456'));
  assert.ok(said.includes('****'));
  assert.equal(said.length, live.AGENT_SAID_CHARS + 1, 'clipped, with its ellipsis');
  assert.equal(live.agentSaid(''), null);
  assert.equal(live.agentSaid(null), null);
  // Never part of the reason the DM and the cards read: build_error stays
  // the bare reason, and the classifier never sees the agent's words.
  const dm = require('../src/services/homeroom-bot-dm');
  assert.match(dm.buildFailedWords('the build produced no change to propose'), /no changes to show you/);
});

test('the worker keeps every provider a turn\'s requests went to, not only the last', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  const send = (event) => worker.parseLine(`__USERNODE_CODING_PROVIDER__ ${JSON.stringify(event)}`, () => {}, state);
  send({ kind: 'provider_request_result', requestOrdinal: 1, httpStatus: 200, outcome: 'ok', providerName: 'GMICloud' });
  send({ kind: 'provider_request_result', requestOrdinal: 2, httpStatus: 200, outcome: 'ok', providerName: 'GMICloud' });
  send({ kind: 'provider_request_result', requestOrdinal: 3, httpStatus: 200, outcome: 'ok', providerName: 'Together' });
  send({ kind: 'provider_request_result', requestOrdinal: 4, httpStatus: 200, outcome: 'ok', providerName: 'bad<script>' });
  assert.equal(state.routedProvider, 'Together');
  assert.deepEqual(state.routedProviders, ['GMICloud', 'Together']);
});

// ── Every lane that builds ─────────────────────────────────────────────────

test('the live lane, the shadow lane and the bench all build through buildAndPropose, so all are nudged', () => {
  const src = read('src/services/homeroom-bot.js');
  const liveCall = src.slice(src.indexOf('built = await live.buildAndPropose({'), src.indexOf('buildMs = Date.now() - buildStartedMs;\n  } finally {'));
  assert.match(liveCall, /origin: \{ lane: 'live', runId \},\n\s+onNoChange: \(noChange\) => keepNoChange\(pool, runId, noChange\),/);
  const shadow = src.slice(src.indexOf('async function shadowBuild('), src.indexOf('async function runQueuedBuild('));
  assert.match(shadow, /origin: \{ lane: 'shadow', runId \},\n\s+onNoChange: \(noChange\) => keepNoChange\(pool, runId, noChange\),/);
  assert.match(shadow, /build_no_change = \$11::jsonb/);
  const bench = read('src/services/bench/runner.js');
  const stage = bench.slice(bench.indexOf('async function buildStage('), bench.indexOf('function reviewerCost('));
  assert.match(stage, /origin: \{ lane: 'bench', trialId: trial\.id \},/);
});

test('recordLiveBuild keeps a build\'s record of a turn that changed nothing on its run', async () => {
  const queries = [];
  const pool = { async query(sql, params) { queries.push({ sql: String(sql), params }); return { rows: [] }; } };
  const noChange = { turns: [{ turn: 'build', ended: 'no_change', said: 'a plan' }], nudged: false, notNudged: 'a stop was requested', committed: null };
  await bot.recordLiveBuild(pool, 1166, { ok: false, sessionId: 7192, error: 'the build produced no change to propose', noChange });
  const u = queries.at(-1);
  assert.match(u.sql, /build_no_change = COALESCE\(\$11::jsonb, build_no_change\)/);
  assert.deepEqual(JSON.parse(u.params[10]), noChange);
  assert.equal(u.params[2], 'the build produced no change to propose', 'the reason stays the bare reason');
  await bot.recordLiveBuild(pool, 1166, { ok: true, sessionId: 7192 });
  assert.equal(queries.at(-1).params[10], null, 'none: what is on the run stays');

  await bot.keepNoChange(pool, 1166, noChange);
  assert.match(queries.at(-1).sql, /UPDATE homeroom_bot_runs SET build_no_change = \$2::jsonb WHERE id = \$1/);
});

test('a bench build keeps its record on the trial, and a recovered bench turn that changed nothing keeps its words', () => {
  const kept = runner.recoveredBuild({ session: { id: 5, spec_md: '# Spec' }, result: { ...QUIT } });
  assert.equal(kept.ok, false);
  assert.match(kept.error, /^the build produced no change to propose/);
  assert.equal(kept.noChange.turns[0].said, QUIT.lastResultText);
  assert.equal(kept.noChange.turns[0].provider, 'GMICloud');
  assert.equal(kept.noChange.recovered, true);
  assert.equal(kept.noChange.nudged, false);
  assert.equal(runner.recoveredBuild({ session: { id: 5 }, result: { ...BUILT } }).noChange, undefined);
  assert.equal(runner.recoveredBuild({ session: { id: 5 }, result: { ...QUIT }, timedOut: true }).noChange, undefined);
  const src = read('src/services/bench/runner.js');
  assert.match(src, /\.\.\.\(built\.noChange \? \{ noChange: built\.noChange \} : \{\}\),/, 'buildResult keeps it on the trial\'s parsed record');
});

// ── After a restart ─────────────────────────────────────────────────────────

function recoveryPool(before = null) {
  const queries = [];
  const recorded = [];
  return {
    queries,
    recorded,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/SELECT build_no_change FROM homeroom_bot_runs/.test(sql)) return { rows: before ? [{ build_no_change: before }] : [] };
      if (/INSERT INTO events/.test(sql)) recorded.push({ type: params[3], metadata: JSON.parse(params[4]) });
      return { rows: [] };
    },
  };
}
const SESSION = { id: 7192, user_id: BOT.id, agent_model: 'z-ai/glm-5.3-flash' };
const WHERE = { runId: 1166, session: SESSION, origin: { lane: 'live', runId: 1166 }, appId: APP.id, issueNumber: 1 };

test('a nudge a restart caught adds its outcome to what its build turn left on the run', async () => {
  const before = {
    turns: [{ ...live.turnFacts({ routed: { result: QUIT } }, { turn: 'build' }), said: QUIT.lastResultText }],
    nudged: true, notNudged: null, committed: null,
  };
  const pool = recoveryPool(before);
  const noChange = await bot.recoveredNoChange(pool, {
    ...WHERE, result: { ...BUILT }, component: live.BUILD_NUDGE_TELEMETRY,
  });
  assert.deepEqual(noChange.turns.map((t) => [t.turn, t.ended]), [['build', 'no_change'], ['nudge', 'changed']]);
  assert.equal(noChange.turns[0].said, QUIT.lastResultText, 'what the first turn said survives the restart');
  assert.equal(noChange.committed, true);
  assert.equal(noChange.recovered, true);
  assert.deepEqual(pool.recorded.map((e) => [e.type, e.metadata.turn, e.metadata.committed, e.metadata.recovered]), [
    ['bot_build_nudged', 'nudge', true, true],
  ], 'the build turn was counted before the restart; only the nudge is counted now');

  // Read as a nudge by the record alone when the ledger name is missing.
  const again = await bot.recoveredNoChange(recoveryPool(before), { ...WHERE, result: { ...QUIT, lastResultText: 'still a plan' } });
  assert.equal(again.turns[1].turn, 'nudge');
  assert.equal(again.turns[1].said, 'still a plan');
  assert.equal(again.committed, false);
});

test('a build turn a restart caught that changed nothing is kept and counted, not nudged; one that built adds nothing', async () => {
  const pool = recoveryPool(null);
  const noChange = await bot.recoveredNoChange(pool, { ...WHERE, result: { ...QUIT } });
  assert.equal(noChange.nudged, false);
  assert.equal(noChange.notNudged, 'a restart caught the turn, and recovery does not nudge');
  assert.equal(noChange.turns[0].said, QUIT.lastResultText);
  assert.deepEqual(pool.recorded.map((e) => [e.type, e.metadata.turn, e.metadata.recovered, e.metadata.nudged]), [
    ['bot_build_no_change', 'build', true, false],
  ]);
  assert.equal(await bot.recoveredNoChange(recoveryPool(null), { ...WHERE, result: { ...BUILT } }), null);
  assert.equal(await bot.recoveredNoChange(recoveryPool(null), { ...WHERE, result: { ...QUIT }, timedOut: true }), null);
});

test('both recovery paths record it: the live one on its outcome, the lane\'s on its run', () => {
  const src = read('src/services/homeroom-bot.js');
  const finish = src.slice(src.indexOf('async function finishRecoveredTurn('), src.indexOf('async function finishConfiguredShadow('));
  assert.match(finish, /component: activeTurn\?\.telemetryComponent \|\| null,\n\s+\}\)\) \{/, 'a live turn notes its ledger name for completeRecoveredLive');
  assert.match(finish, /const noChange = await recoveredNoChange\(pool, \{/);
  assert.match(finish, /build_no_change = COALESCE\(\$9::jsonb, r\.build_no_change\)/);
  const complete = src.slice(src.indexOf('async function completeRecoveredLive('), src.indexOf('async function holdSlotDuringRecovery('));
  assert.match(complete, /const noChange = plan\.mode !== 'scout' && !plan\.lost && !reviewing && !restartedOut\n\s+\? await recoveredNoChange\(pool, \{/);
  assert.equal((complete.match(/\.\.\.noChangeOut/g) || []).length, 3, 'on every outcome of a build turn it followed');
});

// ── Where it is read ─────────────────────────────────────────────────────────

test('the run keeps it private, the console shows it as text, and the export leaves it out', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS build_no_change JSONB;\nCOMMENT ON COLUMN homeroom_bot_runs\.build_no_change IS 'staging:private';/);
  const src = read('src/services/homeroom-bot.js');
  assert.match(src.slice(src.indexOf('const RUNS_SQL'), src.indexOf('const RUNS_SQL') + 1200), /r\.build_session_id, r\.build_no_change,/);
  assert.ok(!bot.EXPORT_COLUMNS || !bot.EXPORT_COLUMNS.includes('build_no_change'));
  assert.doesNotMatch(src.slice(src.indexOf('const EXPORT_COLUMNS'), src.indexOf('function answersCell')), /build_no_change/,
    'the CSV export carries no agent text');
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  const note = tsx.slice(tsx.indexOf('function NoChangeNote('), tsx.indexOf('/** A question\'s "user_facing: why" as words. */'));
  assert.match(note, /\{`It said: \$\{t\.said\}`\}/, 'rendered as a text child, which React escapes');
  assert.doesNotMatch(note, /dangerouslySetInnerHTML|href=/);
  assert.match(tsx, /<NoChangeNote run=\{run\} \/>/);
});

test('the counters are known event types, and the nudge is a known telemetry component', () => {
  assert.equal(events.EVENT_TYPES.BOT_BUILD_NO_CHANGE, 'bot_build_no_change');
  assert.equal(events.EVENT_TYPES.BOT_BUILD_NUDGED, 'bot_build_nudged');
  assert.equal(live.BUILD_NUDGE_TELEMETRY, 'homeroom_bot_build_nudge');
  assert.match(read('src/services/llm-telemetry.js'), /'homeroom_bot_build_nudge',/);
});
