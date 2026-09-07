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

function clientHarness() {
  let tick;
  let respond;
  let requests = 0;
  let published;
  const sandbox = {
    console, URLSearchParams,
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
  chat._settledBudgetPillView = () => ({ title: 'Today', parts: [{ text: '$1.00/$25.00' }] });
  chat.renderBudget = () => { published = chat._budgetPillView(); };
  return { chat, tick: () => tick?.(), requests: () => requests,
    respond: (body) => respond({ ok: true, json: async () => body }),
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

test('reconnect polling avoids duplicate requests and unsupported runners show no estimate', async () => {
  const h = clientHarness();
  h.chat._startSpendPolling();
  h.chat._progressPollTimer = 5;
  await h.tick();
  assert.equal(h.requests(), 0);
  h.chat._applyLiveSpend({ busy: true, spend: { costCents: 100 } }, 42);
  h.chat._isOpenRouterSession = () => true;
  h.chat.renderBudget();
  assert.doesNotMatch(h.html(), /this turn/);
  h.chat._applyLiveSpend({ busy: false, spend: { costCents: 100 } }, 42);
  assert.equal(h.chat._liveSpend, null);
  h.chat._stopSpendPolling();
});
