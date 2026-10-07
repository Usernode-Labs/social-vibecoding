'use strict';

// The hub's since-your-last-visit line (services/since-summary.js,
// routes/since-summary.js, llm.generateSinceSummary):
//
//   - a visit is floored to a WINDOW many members share: a six-hour block
//     within the last day, its UTC day within two weeks, two weeks ago
//     before that;
//   - nothing landed: no card; three changes or fewer: their own titles,
//     no model call; more: one or two sentences from Claude Sonnet 5.5;
//   - the line is cached per window; a newer merge leaves the old line on
//     screen and rewrites it behind the request at most once an hour;
//     concurrent first askers share one call; a failure falls back to the
//     titles and is retried after an hour, not on every view;
//   - the model call runs on Sonnet 5.5 at low effort with a JSON schema
//     and the refusal fallback, and a refusal throws.
//
// The SQL itself is exercised against a real schema in
// tests/since-summary-postgres.test.js.
//
// Run with: node --test tests/since-summary.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/services/llm');
const since = require('../src/services/since-summary');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 29, 15, 30); // Tuesday 29 Sep 2026, 15:30 UTC

test('a visit is floored to a window many members share', () => {
  assert.equal(since.windowStart(0, NOW), null, 'a first visit has no window');
  assert.equal(since.windowStart(NaN, NOW), null);
  assert.equal(since.windowStart(NOW + 1000, NOW), null, 'a clock in the future has none');
  // Within the day: the six-hour block the visit fell in.
  assert.equal(since.windowStart(Date.UTC(2026, 8, 29, 13, 10), NOW), Date.UTC(2026, 8, 29, 12));
  assert.equal(since.windowStart(Date.UTC(2026, 8, 28, 20, 5), NOW), Date.UTC(2026, 8, 28, 18));
  // Within two weeks: its UTC day.
  assert.equal(since.windowStart(Date.UTC(2026, 8, 24, 9, 0), NOW), Date.UTC(2026, 8, 24));
  // Longer ago: the last two weeks, from a UTC midnight.
  assert.equal(since.windowStart(Date.UTC(2026, 7, 1), NOW), Date.UTC(2026, 8, 15));
});

// A pool that answers the three statements the service makes.
function fakePool({ merged = [], cached = null } = {}) {
  const state = { cached, writes: [], deletes: 0 };
  return {
    state,
    async query(sql, params) {
      if (/FROM chat_sessions/.test(sql)) {
        const from = Date.parse(params[1]);
        const rows = merged
          .filter((m) => m.at >= from)
          .sort((a, b) => b.at - a.at);
        return {
          rows: rows.slice(0, params[2]).map((m) => ({
            pr_number: m.pr, pr_title: m.title, pr_summary_md: m.summary || null,
            landed_at: new Date(m.at), total: String(rows.length),
          })),
        };
      }
      if (/FROM app_since_summaries/.test(sql)) {
        return { rows: state.cached ? [state.cached] : [] };
      }
      if (/INSERT INTO app_since_summaries/.test(sql)) {
        state.writes.push(params);
        const [, , headAt, count, summary, error, model, version] = params;
        const prev = state.cached;
        state.cached = {
          head_at: summary || !prev || !prev.summary ? headAt : prev.head_at,
          change_count: summary || !prev || !prev.summary ? count : prev.change_count,
          summary: summary || (prev && prev.summary) || null,
          error, model, version: summary ? version : (prev ? prev.version : version),
          generated_at: new Date(NOW),
        };
        return { rows: [] };
      }
      if (/DELETE FROM app_since_summaries/.test(sql)) { state.deletes += 1; return { rows: [] }; }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const APP = { id: 7, slug: 'homeroom' };
const change = (n, at, extra = {}) => ({ pr: 3300 + n, title: `Change ${n}`, summary: `Summary ${n}.`, at, ...extra });
const visit = Date.UTC(2026, 8, 28, 9, 0); // yesterday: window starts Mon 28 Sep 00:00 UTC

async function withModel(fn, { enabled = true, reply } = {}) {
  const orig = { gen: llm.generateSinceSummary, enabled: llm.isEnabled };
  const calls = [];
  llm.isEnabled = () => enabled;
  llm.generateSinceSummary = async (args) => {
    calls.push(args);
    if (reply instanceof Error) throw reply;
    return { summary: reply || 'Mostly polish on Messages and Discover.', usage: undefined, model: 'claude-sonnet-5-5' };
  };
  try { return await fn(calls); } finally {
    llm.generateSinceSummary = orig.gen;
    llm.isEnabled = orig.enabled;
  }
}

test('nothing landed in the window: no card', async () => {
  await withModel(async (calls) => {
    const pool = fakePool({ merged: [change(1, Date.UTC(2026, 8, 20))] });
    assert.deepEqual(await since.getSummary(pool, APP, { since: visit, now: NOW }), { state: 'none' });
    assert.deepEqual(await since.getSummary(pool, APP, { since: 0, now: NOW }), { state: 'none' });
    assert.equal(calls.length, 0);
  });
});

test('three changes or fewer: their own titles, no model call', async () => {
  await withModel(async (calls) => {
    const pool = fakePool({ merged: [change(1, NOW - 2 * HOUR), change(2, NOW - 3 * HOUR)] });
    const out = await since.getSummary(pool, APP, { since: visit, now: NOW });
    assert.equal(out.state, 'list');
    assert.equal(out.count, 2);
    assert.equal(out.windowStart, Date.UTC(2026, 8, 28));
    assert.deepEqual(out.items.map((i) => i.title), ['Change 1', 'Change 2']);
    assert.equal(calls.length, 0);
  });
});

test('more than three: the model writes the line once and it is cached for the window', async () => {
  await withModel(async (calls) => {
    const merged = [1, 2, 3, 4, 5].map((n) => change(n, NOW - n * HOUR));
    const pool = fakePool({ merged });
    const out = await since.getSummary(pool, APP, { since: visit, now: NOW });
    assert.equal(out.state, 'ai');
    assert.equal(out.text, 'Mostly polish on Messages and Discover.');
    assert.equal(out.count, 5);
    assert.equal(out.headAt, NOW - HOUR);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].total, 5);
    assert.equal(calls[0].truncated, false);
    assert.equal(calls[0].fromDate, '2026-09-28');
    assert.deepEqual(calls[0].changes[0], { pr: 3301, title: 'Change 1', summary: 'Summary 1.' });
    assert.equal(pool.state.writes.length, 1);
    // The same window again: served from the cache.
    const again = await since.getSummary(pool, APP, { since: visit + HOUR, now: NOW });
    assert.equal(again.text, out.text);
    assert.equal(calls.length, 1);
  });
});

test('a newer merge serves the old line and rewrites it behind the request, at most once an hour', async () => {
  await withModel(async (calls) => {
    const merged = [1, 2, 3, 4].map((n) => change(n, NOW - n * HOUR));
    const cached = {
      head_at: new Date(NOW - 2 * HOUR), change_count: 3, summary: 'The old line.',
      error: null, version: llm.SINCE_SUMMARY_VERSION, generated_at: new Date(NOW - 30 * 60 * 1000),
    };
    // Written half an hour ago: served as is, nothing rewritten yet.
    let pool = fakePool({ merged, cached: { ...cached } });
    let out = await since.getSummary(pool, APP, { since: visit, now: NOW });
    assert.equal(out.text, 'The old line.');
    assert.equal(out.count, 3, 'the count the old line was written for');
    assert.equal(calls.length, 0);
    // Written two hours ago: still served now, and rewritten in the background.
    pool = fakePool({ merged, cached: { ...cached, generated_at: new Date(NOW - 2 * HOUR) } });
    out = await since.getSummary(pool, APP, { since: visit, now: NOW });
    assert.equal(out.text, 'The old line.');
    await Promise.all([...since._inFlight.values()]);
    assert.equal(calls.length, 1);
    assert.equal(pool.state.cached.summary, 'Mostly polish on Messages and Discover.');
  });
});

test('concurrent first askers share one model call', async () => {
  await withModel(async (calls) => {
    const merged = [1, 2, 3, 4].map((n) => change(n, NOW - n * HOUR));
    const pool = fakePool({ merged });
    const [a, b] = await Promise.all([
      since.getSummary(pool, APP, { since: visit, now: NOW }),
      since.getSummary(pool, APP, { since: visit + 60000, now: NOW }),
    ]);
    assert.equal(calls.length, 1);
    assert.equal(a.text, b.text);
  });
});

test('no model, or a failed call: the newest titles and the count, retried after an hour', async () => {
  const merged = [1, 2, 3, 4, 5].map((n) => change(n, NOW - n * HOUR));
  await withModel(async (calls) => {
    const out = await since.getSummary(fakePool({ merged }), APP, { since: visit, now: NOW });
    assert.equal(out.state, 'list');
    assert.equal(out.count, 5);
    assert.equal(out.items.length, 3);
    assert.equal(calls.length, 0);
  }, { enabled: false });

  await withModel(async (calls) => {
    const pool = fakePool({ merged });
    const out = await since.getSummary(pool, APP, { since: visit, now: NOW });
    assert.equal(out.state, 'list');
    assert.equal(calls.length, 1);
    assert.match(pool.state.cached.error, /refused/);
    // Asked again straight away: no second call inside the backoff.
    await since.getSummary(pool, APP, { since: visit, now: NOW + 10 * 60 * 1000 });
    assert.equal(calls.length, 1);
    // After it: tried again.
    await since.getSummary(pool, APP, { since: visit, now: NOW + 2 * HOUR });
    assert.equal(calls.length, 2);
  }, { reply: new Error('Since summary request was refused') });
});

test('a failed rewrite keeps the old line with the head it was written for', async () => {
  await withModel(async () => {
    const merged = [1, 2, 3, 4].map((n) => change(n, NOW - n * HOUR));
    const pool = fakePool({
      merged,
      cached: {
        head_at: new Date(NOW - 3 * HOUR), change_count: 2, summary: 'The old line.',
        error: null, version: llm.SINCE_SUMMARY_VERSION, generated_at: new Date(NOW - 2 * HOUR),
      },
    });
    await since.getSummary(pool, APP, { since: visit, now: NOW });
    await Promise.all([...since._inFlight.values()]);
    assert.equal(pool.state.cached.summary, 'The old line.');
    assert.equal(pool.state.cached.change_count, 2);
    assert.equal(Date.parse(pool.state.cached.head_at), NOW - 3 * HOUR);
  }, { reply: new Error('boom') });
});

// ── The model call ────────────────────────────────────────────────────

function stubClient(response) {
  const calls = [];
  const create = (kind) => async (params) => { calls.push({ kind, params }); return response; };
  return { calls, messages: { create: create('plain') }, beta: { messages: { create: create('beta') } } };
}

async function withClient(c, fn) {
  llm._setClientForTests(c);
  try { return await fn(); } finally { llm._setClientForTests(null); }
}

const ok = (text) => ({
  model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_details: null,
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }],
  usage: { input_tokens: 2000, output_tokens: 60 },
});

test('the line is written by Sonnet 5.5 at low effort, to a schema, with the refusal fallback', async () => {
  const c = stubClient(ok('{"summary":"  Mostly polish on\\nMessages.  "}'));
  const out = await withClient(c, () => llm.generateSinceSummary({
    changes: [{ pr: 1, title: 'A', summary: 'B' }], total: 40, truncated: false, fromDate: '2026-09-28',
  }));
  assert.equal(out.summary, 'Mostly polish on Messages.');
  const { kind, params } = c.calls[0];
  assert.equal(kind, 'beta');
  assert.equal(params.model, 'claude-sonnet-5-5');
  assert.equal(params.fallbacks, 'default');
  assert.equal(params.output_config.effort, 'low');
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.ok(params.max_tokens >= 1000);
  const input = JSON.parse(params.messages[0].content);
  assert.deepEqual([input.total, input.shown, input.truncated, input.since], [40, 1, false, '2026-09-28']);
  assert.match(params.system, /never describe the list in front of you as if it were everything/);
  assert.match(params.system, /No numbers or counts/);
});

test('a refusal or a cut-off answer throws', async () => {
  await assert.rejects(() => withClient(stubClient({ ...ok(''), stop_reason: 'refusal', content: [] }),
    () => llm.generateSinceSummary({ changes: [], total: 5, truncated: false, fromDate: 'x' })), /refused/);
  await assert.rejects(() => withClient(stubClient({ ...ok('{"summ'), stop_reason: 'max_tokens' }),
    () => llm.generateSinceSummary({ changes: [], total: 5, truncated: false, fromDate: 'x' })), /tokens/);
});

test('the route reads with the app view rule and is mounted', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/since-summary.js'), 'utf8');
  assert.match(route, /getAppForUser\(pool, req\.params\.slug, req\.user, 'view'/);
  assert.match(route, /IS_STAGING && req\.query\.demo === '1'/);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /app\.use\(sinceSummaryRoutes\(config\)\)/);
  const { stagingDemoSummary } = require('../src/routes/since-summary');
  const demo = stagingDemoSummary(NOW);
  assert.equal(demo.state, 'ai');
  assert.match(demo.text, /^Staging demo:/);
});

test('#4098: the excerpt the model reads carries a summary\'s words, never its explain fence', async () => {
  await withModel(async (calls) => {
    const fence = '```explain\n{"v":1,"blocks":[{"kind":"steps","steps":["a","b"]}]}\n```';
    const merged = [1, 2, 3, 4, 5].map((n) => change(n, NOW - n * HOUR, { summary: `Summary ${n}.\n\n${fence}` }));
    const pool = fakePool({ merged });
    await since.getSummary(pool, APP, { since: visit, now: NOW });
    assert.equal(calls.length, 1);
    for (const c of calls[0].changes) {
      assert.doesNotMatch(c.summary, /explain|blocks/);
      assert.match(c.summary, /^Summary \d\.$/);
    }
  });
});
