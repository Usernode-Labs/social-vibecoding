const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const worker = require('../src/services/worker');
const progress = require('../src/services/worker-progress');
const live = require('../src/services/live-agent-spend');
const { renderComponent } = require('./lib/render-tsx');

function feed(state, event) { worker.parseLine(JSON.stringify(event), () => {}, state); }
function stream(event, extra = {}) { return { type: 'stream_event', session_id: 'provider-1', event, ...extra }; }
function start(id = 'm1', extra = {}) {
  return stream({ type: 'message_start', message: {
    id, model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 0 },
  } }, extra);
}

test('the real worker parser publishes growing spend before result without changing billing', () => {
  const state = worker.newWatchState();
  state.hostSessionId = 1600;
  state.liveSpendEnabled = true;
  feed(state, start());
  const before = progress.get(1600).spend.costCents;
  feed(state, stream({ type: 'content_block_delta', delta: { text: 'a'.repeat(4000) } }));
  assert.ok(progress.get(1600).spend.costCents > before);
  assert.equal(progress.get(1600).spend.estimated, true);
  assert.equal(state.costUsd, 0, 'live estimates cannot become a billable result');
  progress.set(1600, 'Reading file');
  assert.ok(progress.get(1600).spend.costCents > before, 'ordinary progress preserves spend');
  feed(state, { type: 'result', total_cost_usd: 0.0123 });
  assert.deepEqual(progress.get(1600).spend, { costCents: 1.23, estimated: false });
  assert.equal(state.costUsd, 0.0123, 'existing final billing behavior is retained');
  progress.clear(1600);
  assert.equal(progress.get(1600), null);
});

test('message usage reconciles estimates, duplicate content blocks do not double-count', () => {
  const tracker = live.createTracker();
  live.observe(tracker, start());
  const delta = stream({ type: 'content_block_delta', delta: { partial_json: 'x'.repeat(4000) } }, { uuid: 'delta-1' });
  live.observe(tracker, delta);
  const estimated = live.snapshot(tracker).costCents;
  live.observe(tracker, delta);
  assert.equal(live.snapshot(tracker).costCents, estimated);
  live.observe(tracker, stream({ type: 'message_delta', usage: { output_tokens: 100 } }));
  assert.ok(live.snapshot(tracker).costCents < estimated, 'authoritative count replaces the text estimate');
  const full = { type: 'assistant', session_id: 'provider-1', message: {
    id: 'm1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 }, content: [],
  } };
  const reconciled = live.snapshot(tracker).costCents;
  live.observe(tracker, full);
  live.observe(tracker, full);
  assert.equal(live.snapshot(tracker).costCents, reconciled);
  live.observe(tracker, start('m2'));
  assert.ok(live.snapshot(tracker).costCents > reconciled, 'successive tool-loop calls accumulate');
});

test('interleaved subagent streams remain separate and include cache usage', () => {
  const tracker = live.createTracker();
  live.observe(tracker, start());
  live.observe(tracker, start('child', { parent_tool_use_id: 'tool-1' }));
  live.observe(tracker, stream({ type: 'message_delta', usage: { output_tokens: 100 } }, { parent_tool_use_id: 'tool-1' }));
  live.observe(tracker, stream({ type: 'message_delta', usage: { output_tokens: 200 } }));
  assert.ok(Math.abs(live.snapshot(tracker).costCents - 0.7) < 1e-9);
  live.observe(tracker, { type: 'assistant', message: { id: 'cached', model: 'claude-sonnet-4-6', content: [],
    usage: { cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: 1000 } } } });
  assert.ok(Math.abs(live.snapshot(tracker).costCents - 1.12) < 1e-9);
});

test('replaying a journal reconstructs the same estimate; other sessions and sync stay isolated', () => {
  const events = [start(), stream({ type: 'content_block_delta', delta: { thinking: 'x'.repeat(80) } })];
  const first = worker.newWatchState();
  const recovered = worker.newWatchState();
  for (const event of events) { feed(first, event); feed(recovered, event); }
  assert.deepEqual(live.snapshot(first.liveSpend), live.snapshot(recovered.liveSpend));
  first.hostSessionId = 99;
  first.liveSpendEnabled = false;
  feed(first, start('sync'));
  assert.equal(progress.get(99), null);
  assert.equal(live.snapshot(worker.newWatchState().liveSpend), null);
});

test('missing, synthetic and invalid usage do not produce a bogus amount', () => {
  const tracker = live.createTracker();
  for (const event of [null, {}, { type: 'assistant', message: { id: 'x', model: '<synthetic>', usage: { input_tokens: 1000 } } },
    { type: 'assistant', message: { id: 'y', model: 'claude-sonnet-4-6', usage: { input_tokens: -1, output_tokens: Infinity } } },
    { type: 'result', total_cost_usd: NaN }]) live.observe(tracker, event);
  assert.equal(live.snapshot(tracker), null);
});

function clientHarness({ search = '' } = {}) {
  let tick;
  let respond;
  let requests = 0;
  let published;
  const sandbox = {
    console, URLSearchParams,
    location: { search },
    setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = null; },
    setTimeout, clearTimeout,
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: () => null },
    fetch: () => { requests++; return new Promise((resolve) => { respond = resolve; }); },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.Settings = { state: {} };
  vm.createContext(sandbox);
  const file = path.join(__dirname, '../frontend/src/features/dev-chat/dev-chat.js');
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\n;this.chat = DevChat;', sandbox);
  requests = 0;
  const chat = sandbox.chat;
  chat.currentSession = { id: 42 };
  chat._isOpenRouterSession = () => false;
  const realMeter = chat._settledBudgetPillView;
  chat._settledBudgetPillView = () => ({ title: 'Today', parts: [{ text: '$1.00/$25.00' }] });
  chat.renderBudget = () => { published = chat._budgetPillView(); };
  return { chat, tick: () => tick?.(), requests: () => requests,
    respond: (body) => respond({ ok: true, json: async () => body }),
    useRealMeter: () => { chat._settledBudgetPillView = realMeter; },
    html: () => renderComponent('frontend/src/features/dev-chat/budget-pill.tsx', 'BudgetPillView',
      JSON.parse(JSON.stringify(published))),
  };
}

test('the rendered meter updates during a turn, then clears without changing the daily total', async () => {
  const h = clientHarness();
  h.chat._startSpendPolling();
  const pending = h.tick();
  await h.tick();
  assert.equal(h.requests(), 1, 'only one request may be in flight');
  h.respond({ busy: true, spend: { costCents: 23.5, estimated: true } });
  await pending;
  assert.match(h.html(), /this turn ~\$0.23/);
  assert.match(h.html(), /\$1.00\/\$25.00/);
  h.chat._applyLiveSpend({ busy: true, spend: { costCents: 50, estimated: false } }, 42);
  assert.match(h.html(), /this turn \$0.50/);
  h.chat._stopSpendPolling();
  assert.doesNotMatch(h.html(), /this turn/);
});

test('late responses after stop or navigation cannot restore stale spend', async () => {
  const h = clientHarness();
  h.chat._startSpendPolling();
  const pending = h.tick();
  h.chat._stopSpendPolling();
  h.chat.currentSession = { id: 43 };
  h.respond({ busy: true, spend: { costCents: 100, estimated: true } });
  await pending;
  assert.equal(h.chat._liveSpend, null);
  h.chat._applyLiveSpend({ busy: true, spend: { costCents: 100 } }, 42);
  assert.equal(h.chat._liveSpend, null);
});

test('reconnect polling avoids duplicate requests, and a Claude session drops the figure once idle', async () => {
  const h = clientHarness();
  h.chat._startSpendPolling();
  h.chat._progressPollTimer = 5;
  await h.tick();
  assert.equal(h.requests(), 0);
  h.chat._applyLiveSpend({ busy: true, spend: { costCents: 100 } }, 42);
  assert.match(h.html(), /this turn/);
  h.chat._applyLiveSpend({ busy: false, spend: { costCents: 100 } }, 42);
  assert.equal(h.chat._liveSpend, null);
  h.chat._stopSpendPolling();
});

// #2118: an OpenRouter session's figure is the ledger's list-price estimate,
// known only as the coding run ends and after which the session reads idle
// while the reply is still being written. So the session polls like a
// Claude one, keeps what it learned through the idle snapshot and the end
// of the turn, and starts the next turn clean.
test('an OpenRouter session shows the turn\'s recorded cost and keeps it once the session idles', async () => {
  const h = clientHarness();
  h.chat._isOpenRouterSession = () => true;
  h.chat._settledBudgetPillView = () => ({ title: null, parts: [] });
  h.chat._startSpendPolling();
  const pending = h.tick();
  await h.tick();
  assert.equal(h.requests(), 1, 'an OpenRouter session polls too');
  h.respond({ busy: true, spend: null });
  await pending;
  assert.equal(h.chat._liveSpend, null, 'nothing is known until Codex reports usage');
  h.chat._applyLiveSpend({ busy: true, spend: { costCents: 12.4, estimated: true } }, 42);
  assert.match(h.html(), /this turn ~\$0\.12/);
  assert.match(h.html(), /OpenRouter list price/);
  assert.doesNotMatch(h.html(), /Claude Code/);
  h.chat._applyLiveSpend({ busy: false, spend: null }, 42);
  assert.match(h.html(), /this turn ~\$0\.12/, 'an idle snapshot has nothing newer to say');
  h.chat._stopSpendPolling({ keepSpend: true });
  assert.match(h.html(), /this turn ~\$0\.12/, 'the figure outlives the turn');
  h.chat._startSpendPolling();
  assert.equal(h.chat._liveSpend, null, 'the next turn starts clean');
  h.chat._stopSpendPolling();
  assert.doesNotMatch(h.html(), /this turn/);
});

test('the usage receipt feeds an OpenRouter session\'s figure and leaves a Claude session\'s alone', () => {
  const h = clientHarness();
  h.chat._settledBudgetPillView = () => ({ title: null, parts: [] });
  h.chat._noteTurnUsage({ costCents: 12, estimated: true });
  assert.equal(h.chat._liveSpend, null, 'Claude usage events are settlement receipts, not the live figure');
  h.chat._isOpenRouterSession = () => true;
  h.chat._noteTurnUsage({ costCents: 0 });
  h.chat._noteTurnUsage({ costCents: 'unknown' });
  h.chat._noteTurnUsage({});
  assert.equal(h.chat._liveSpend, null, 'no figure is invented from an empty receipt');
  h.chat._noteTurnUsage({ costCents: 12, estimated: true });
  assert.match(h.html(), /this turn ~\$0\.12/);
});

test('an OpenRouter session\'s meter says what is left on the key, in the key\'s own window', () => {
  const h = clientHarness();
  h.useRealMeter();
  h.chat._isOpenRouterSession = () => true;
  h.chat.renderBudget();
  assert.equal(h.html(), '', 'nothing before the allowance read lands');
  h.chat.openrouterAllowance = {
    configured: true, source: 'usernode_managed', last4: '7f2c',
    limit: 1, limitRemaining: 0.86, limitReset: 'daily',
  };
  h.chat.renderBudget();
  assert.match(h.html(), /\$0\.86 left today/);
  assert.match(h.html(), /text-emerald-700/);
  assert.match(h.html(), /Your included OpenRouter key has \$0\.86 of its \$1\.00 daily allowance left\. OpenRouter resets it daily\./);
  h.chat.openrouterAllowance = {
    configured: true, source: 'personal', last4: 'abcd',
    limit: 10, limitRemaining: 1.5, limitReset: 'weekly',
  };
  h.chat.renderBudget();
  assert.match(h.html(), /\$1\.50 left this week/);
  assert.match(h.html(), /text-red-700/, '85% of the limit is spent');
  assert.match(h.html(), /Your OpenRouter key \(\u2026abcd\) has \$1\.50 of its \$10\.00 weekly allowance left/);
  h.chat.openrouterAllowance = { configured: true, source: 'usernode_managed', limit: 1, limitRemaining: 0, limitReset: 'daily' };
  h.chat.renderBudget();
  assert.match(h.html(), /\$0\.00 left today/);
  assert.match(h.html(), /font-semibold/);
  h.chat.openrouterAllowance = { configured: true, source: 'personal', last4: 'abcd', limit: null, limitRemaining: null, limitReset: null };
  h.chat.renderBudget();
  assert.equal(h.html(), '', 'a key OpenRouter reports no limit for has nothing to say');
  h.chat._isOpenRouterSession = () => false;
  h.chat.openrouterAllowance = { configured: true, limit: 1, limitRemaining: 0.86, limitReset: 'daily' };
  h.chat.renderBudget();
  assert.equal(h.html(), '', 'a Claude session never reads the OpenRouter figure');
});

test('an OpenRouter session refreshes its meter from the live allowance route, or from the shot fixture', async () => {
  const h = clientHarness();
  h.useRealMeter();
  h.chat._isOpenRouterSession = () => true;
  const refresh = h.chat.refreshBudget();
  assert.equal(h.requests(), 1);
  h.respond({ configured: true, source: 'usernode_managed', limit: 1, limitRemaining: 0.74, limitReset: 'daily' });
  await refresh;
  assert.match(h.html(), /\$0\.74 left today/);

  // ?shot=openrouter-spend answers the read itself and paints the turn too…
  const shot = clientHarness({ search: '?shot=openrouter-spend' });
  shot.useRealMeter();
  shot.chat._isOpenRouterSession = () => true;
  await shot.chat.refreshBudget();
  assert.equal(shot.requests(), 0, 'the fixture answers the read');
  assert.match(shot.html(), /\$0\.86 left today/);
  assert.match(shot.html(), /this turn ~\$0\.12/);

  // …but only in an OpenRouter session: a Claude session's budget read runs untouched.
  const claude = clientHarness({ search: '?shot=openrouter-spend' });
  claude.useRealMeter();
  const claudeRefresh = claude.chat.refreshBudget();
  assert.equal(claude.requests(), 1);
  claude.respond({ spentCents: 100, limitCents: 2500, remainingCents: 2400, aiEnabled: true });
  await claudeRefresh;
  assert.match(claude.html(), /\$1\.00/);
  assert.doesNotMatch(claude.html(), /this turn|left today/);
});
