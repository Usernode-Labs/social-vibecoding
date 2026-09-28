'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readSessionUsage, usageView } = require('../src/services/session-usage');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

test('usage combines each recorded source once and retains decimal cents', async () => {
  let query;
  const pool = { query: async (sql, params) => {
    query = { sql, params };
    return { rows: [{ chat_cents: '1.25', agent_cost_cents: '200.5', openrouter_cents: '12.125', unpriced_turns: '1' }] };
  } };
  assert.deepEqual(await readSessionUsage(pool, 51, 9), {
    totalCents: 213.875, chatCents: 1.25, claudeCents: 200.5, openRouterCents: 12.125,
    pendingOrUnpriced: true, basis: 'recorded_list_price',
  });
  assert.deepEqual(query.params, [51, 9]);
  assert.match(query.sql, /cs\.id = \$1 AND cs\.user_id = \$2/);
  assert.match(query.sql, /SUM\(t\.estimated_cost_usd\).*\* 100/);
  assert.doesNotMatch(query.sql, /agent_model_usage|stream|UPDATE|INSERT/);
});

test('missing, zero, and unusable cost records do not invent charges', async () => {
  assert.equal(await readSessionUsage({ query: async () => ({ rows: [] }) }, 51, 9), null);
  assert.deepEqual(usageView({ chat_cents: null, agent_cost_cents: '-2', openrouter_cents: 'NaN', unpriced_turns: 0 }), {
    totalCents: 0, chatCents: 0, claudeCents: 0, openRouterCents: 0,
    pendingOrUnpriced: false, basis: 'recorded_list_price',
  });
});

test('disclosure labels a recorded estimate and distinguishes missing records from free usage', () => {
  const { UsageDisclosure } = loadTsx('frontend/src/features/dev-chat/session-usage.tsx');
  assert.match(renderToHtml(createElement(UsageDisclosure, { usage: { totalCents: 213.875 } })), /Recorded session ~\$2\.139/);
  assert.match(renderToHtml(createElement(UsageDisclosure, { usage: { totalCents: 0 } })), /No session usage recorded yet/);
  const { UsageDisclosure: Open } = loadTsx('frontend/src/features/dev-chat/session-usage.tsx', {
    stubs: { react: { useState: () => [true, () => {}], useEffect: () => {} } },
  });
  const html = renderToHtml(createElement(Open, { usage: {
    totalCents: 213.875, chatCents: 1.25, claudeCents: 200.5, openRouterCents: 12.125, pendingOrUnpriced: true,
  } }));
  for (const text of ['Chat ~$0.013', 'Claude coding ~$2.005', 'OpenRouter coding ~$0.121',
    'at list prices', 'personal-key calls', 'allowance is shown separately',
    'Older records may be incomplete', 'outside this figure', 'pending or have no recorded price']) assert.ok(html.includes(text), text);
});

// Execute the effect with controlled promises/timers: verify cancellation,
// visibility and retry without depending on a running browser or backend.
function effectHarness(t, { visible = true, fetch } = {}) {
  const effects = [], states = [], updates = [], intervals = [], timeouts = [], listeners = new Map();
  const react = {
    useState(value) { const i = states.push(value) - 1; return [value, next => { updates.push([i, next]); states[i] = next; }]; },
    useEffect(fn) { effects.push(fn); },
  };
  t.mock.method(global, 'fetch', fetch);
  t.mock.method(global, 'setInterval', fn => { intervals.push(fn); return 123; });
  t.mock.method(global, 'clearInterval', () => {});
  t.mock.method(global, 'setTimeout', fn => { timeouts.push(fn); return 456; });
  t.mock.method(global, 'clearTimeout', () => {});
  const prior = global.document;
  global.document = {
    visibilityState: 'visible',
    getElementById: () => ({ getClientRects: () => visible ? [{}] : [] }),
    addEventListener: (kind, fn) => listeners.set(kind, fn),
    removeEventListener: kind => listeners.delete(kind),
  };
  t.after(() => { if (prior === undefined) delete global.document; else global.document = prior; });
  const { SessionUsage } = loadTsx('frontend/src/features/dev-chat/session-usage.tsx', { stubs: { react } });
  SessionUsage({ sessionId: 51 });
  const stop = effects[0]();
  return { states, updates, intervals, timeouts, listeners, stop };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('a response for the unmounted previous session cannot paint the next one', async t => {
  let resolve, signal;
  const h = effectHarness(t, { fetch: (_url, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); } });
  h.stop();
  assert.equal(signal.aborted, true);
  resolve({ status: 200, ok: true, json: async () => ({ usage: { totalCents: 9 } }) });
  await flush();
  assert.deepEqual(h.updates, []);
  assert.equal(h.listeners.size, 0);
});

test('hidden session does not poll; access denial stops subsequent polling', async t => {
  let calls = 0;
  const h = effectHarness(t, { fetch: async () => { calls++; return { status: 404 }; } });
  await flush();
  await h.intervals[0]();
  assert.equal(calls, 1);
  assert.equal(h.states[0], null);
  assert.equal(h.states[1], false);
  h.stop();
});

test('a collapsed session budget starts no background requests', async t => {
  let calls = 0;
  const h = effectHarness(t, { visible: false, fetch: async () => { calls++; } });
  await h.intervals[0]();
  assert.equal(calls, 0);
  h.stop();
});

test('a timed-out fetch offers retry and permits a later successful refresh', async t => {
  let calls = 0;
  const h = effectHarness(t, { fetch: (_url, { signal }) => {
    calls++;
    if (calls === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timed out'))));
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ usage: { totalCents: 14 } }) });
  } });
  h.timeouts[0]();
  await flush();
  assert.equal(h.states[1], true);
  h.intervals[0]();
  await flush();
  assert.equal(h.states[0].totalCents, 14);
  assert.equal(h.states[1], false);
  h.stop();
});

test('the shared-session composer never mounts an owner-only usage reader', () => {
  let header, mounts = 0, reads = 0;
  const { BudgetPill } = loadTsx('frontend/src/features/dev-chat/budget-pill.tsx', { stubs: {
    '../../lib/use-store-state': { useStoreState: () => (++reads % 2) ? header : { parts: [] } },
    './session-usage': { SessionUsage: () => { mounts++; return null; } },
  } });
  header = { sessionId: 51, ownsSession: false };
  renderToHtml(createElement(BudgetPill));
  assert.equal(mounts, 0);
  header = { sessionId: 51, ownsSession: true };
  renderToHtml(createElement(BudgetPill));
  assert.equal(mounts, 1);
});
