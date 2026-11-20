// The worker relay's gates (routes/anthropic-proxy.js): the platform's own
// Claude Code turns (before & after shots, Sync with main) forward to
// OpenRouter on the platform's OpenRouter key while the allowance they bill
// has room, and are refused (start of call) or cut off (mid-stream) when it
// has none. Sync turns bill the system bucket. This file was the per-call
// switchover onto a person's own Anthropic key (#664); those keys went in
// task 2275, so the switchover cases went with them and an exhausted
// allowance is simply a 429 now.
//
// The relay router is loaded fresh per test (its budget caches are
// module-level) against require.cache stubs: auth injects a fixed
// workerSession, anthropic-stream's forwardCall is captured instead of
// hitting the network, and the worker registry and ws are recording
// fakes. The REAL limits module runs against a mock pool so the cap/spend
// SQL shapes stay covered, and the platform key is the transport's own
// test override (openrouter-messages.js).
//
// Run with: node --test tests/anthropic-proxy-gates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const limits = require('../src/services/limits');
const openrouterMessages = require('../src/services/openrouter-messages');

const DATA_KEY = 'test-data-key';
const PLATFORM_KEY = 'sk-or-platform-key';
const OPENROUTER_BASE = 'https://openrouter.test/api/v1';
const SESSION_ID = 42;
const USER_ID = 7;

// ── require.cache stubbing (same pattern as recovered-turn-spend) ──────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = {
    id, filename: id, loaded: true, exports,
    paths: original ? original.paths : [],
  };
  return original;
}

// Mock pool answering every SQL shape the proxy + real limits issue.
function makePool({
  // The retained-but-unenforced per-user daily figure (#2571).
  userLimit = 2500,
  userSpent = 0,
  // #2571: the account's one allowance, and therefore what every case
  // below is written against. $25 a week by default — the figure the
  // pre-existing cases assume, now read over the week rather than the day.
  weeklyLimit = 2500,
  weeklySpent = 0,
  weeklyOverride = null,
  globalLimit = 20000,
  globalSpent = 0,
  systemSpent = 0,
} = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT user_id FROM chat_sessions/.test(sql)) {
        return { rows: [{ user_id: USER_ID }] };
      }
      if (/SELECT daily_limit_cents(?:, weekly_limit_cents)? FROM users/.test(sql)) {
        return { rows: [{ daily_limit_cents: userLimit, weekly_limit_cents: weeklyOverride }] };
      }
      if (/SELECT value FROM platform_settings/.test(sql)) {
        const value = params[0] === limits.KEY_GLOBAL ? globalLimit
          : params[0] === limits.KEY_SYSTEM ? 2500
          : params[0] === limits.KEY_WEEKLY ? weeklyLimit : userLimit;
        return { rows: [{ value: String(value) }] };
      }
      if (/SELECT total_cost_cents FROM llm_usage/.test(sql)) {
        return { rows: [{ total_cost_cents: userSpent }] };
      }
      // Week-to-date for one user. Matched BEFORE the global sum below,
      // which is the same aggregate without the user predicate.
      if (/llm_usage WHERE user_id = \$1 AND date >= \$2/.test(sql)) {
        return { rows: [{ total: weeklySpent, byok: 0 }] };
      }
      if (/SELECT SUM\(total_cost_cents\)/.test(sql)) {
        return { rows: [{ total: globalSpent }] };
      }
      if (/SELECT cost_cents FROM system_token_usage/.test(sql)) {
        return { rows: [{ cost_cents: systemSpent }] };
      }
      return { rows: [] };
    },
    issued(re) { return calls.some((c) => re.test(c.sql)); },
  };
}

// Load routes/anthropic-proxy.js fresh with stubs, mount it, and return
// a driver + captured state.
function loadProxy(pool, { turnMode = 'build', forwardResult = {}, platformKey = PLATFORM_KEY, path = '/v1/messages' } = {}) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    credit: require.resolve('../src/services/openrouter-credit'),
    auth: require.resolve('../src/middleware/anthropic-proxy-auth'),
    stream: require.resolve('../src/services/anthropic-stream'),
    worker: require.resolve('../src/services/worker'),
    ws: require.resolve('../src/services/ws'),
    proxy: require.resolve('../src/routes/anthropic-proxy'),
  };

  const state = {
    forwards: [],       // { apiKey, upstreamUrl, shouldKill }
    broadcasts: [],
    outages: [],        // openrouter-credit.js noteOutage calls
  };
  const previousKey = openrouterMessages._setPlatformKeyForTests(platformKey);

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => pool })],
    [paths.auth, stubModule(paths.auth, {
      anthropicProxyAuth: (req, _res, next) => {
        req.workerSession = { sessionId: SESSION_ID };
        next();
      },
    })],
    [paths.stream, stubModule(paths.stream, {
      forwardCall: async ({ res, apiKey, upstreamUrl, shouldKill }) => {
        state.forwards.push({ apiKey, upstreamUrl, shouldKill: shouldKill || null });
        res.status(200).json({ ok: true });
        return { costCents: 5, model: 'claude-test', killed: false, status: 200, ...forwardResult };
      },
    })],
    [paths.worker, stubModule(paths.worker, {
      getActiveTurnMode: () => turnMode,
      turnModeFor: async () => turnMode,
      getTurnByokCents: () => 0,
    })],
    [paths.credit, stubModule(paths.credit, {
      noteOutage: async (_pool, { words }) => { state.outages.push(words); return { since: 'now', fresh: true }; },
    })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: (ev) => state.broadcasts.push(ev),
    })],
  ];
  delete require.cache[paths.proxy];
  const anthropicProxyRoutes = require('../src/routes/anthropic-proxy');

  const app = express();
  app.use(anthropicProxyRoutes({
    dataEncryptionKey: DATA_KEY,
    openrouterApiBase: OPENROUTER_BASE,
  }));
  const server = http.createServer(app);

  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.proxy];
    openrouterMessages._setPlatformKeyForTests(previousKey);
    server.close();
  };

  const call = async () => {
    if (!server.listening) await new Promise((r) => server.listen(0, r));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/anthropic${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', messages: [] }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };

  return { state, call, restore };
}

test.beforeEach(() => limits.invalidate());

test('allowance headroom → forwards to OpenRouter on the platform key', async () => {
  const pool = makePool({ weeklySpent: 100 });
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 200);
    assert.equal(p.state.forwards.length, 1);
    assert.equal(p.state.forwards[0].apiKey, PLATFORM_KEY);
    assert.equal(p.state.forwards[0].upstreamUrl, `${OPENROUTER_BASE}/messages`);
    assert.equal(pool.issued(/anthropic_key_enc/), false, 'no stored Anthropic key is read any more');
  } finally {
    p.restore();
  }
});

test('token counts go to OpenRouter\'s count_tokens; any other path is refused before any budget work', async () => {
  const counted = loadProxy(makePool(), { path: '/v1/messages/count_tokens' });
  try {
    assert.equal((await counted.call()).status, 200);
    assert.equal(counted.state.forwards[0].upstreamUrl, `${OPENROUTER_BASE}/messages/count_tokens`);
  } finally {
    counted.restore();
  }
  limits.invalidate();
  const pool = makePool();
  const other = loadProxy(pool, { path: '/v1/models' });
  try {
    const r = await other.call();
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'unsupported_path');
    assert.equal(other.state.forwards.length, 0);
    assert.equal(pool.issued(/llm_usage/), false, 'refused before any ledger is read');
  } finally {
    other.restore();
  }
});

// #6898: the relay pays with the platform's OpenRouter key, the one the
// bot builds on, so OpenRouter's 402 for credit (forwardCall's refusal, in
// provider-error.js's one reading) is the one stored outage.
test('OpenRouter\'s 402 for credit on a relayed call records the credit outage', async () => {
  const p = loadProxy(makePool({ weeklySpent: 100 }), {
    forwardResult: { costCents: 0, status: 402, refusal: 'credit_out' },
  });
  try {
    assert.equal((await p.call()).status, 200, 'the stub answered; the refusal is what forwardCall said');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(p.state.outages, ['a before & after shots call met OpenRouter\'s 402 for credit']);
  } finally {
    p.restore();
  }
  limits.invalidate();
  const sync = loadProxy(makePool(), { turnMode: 'sync', forwardResult: { costCents: 0, status: 402, refusal: 'credit_out' } });
  try {
    await sync.call();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sync.state.outages, ['a Sync with main call met OpenRouter\'s 402 for credit']);
  } finally {
    sync.restore();
  }
  limits.invalidate();
  const shorter = loadProxy(makePool(), { forwardResult: { costCents: 0, status: 402, refusal: 'billing' } });
  try {
    await shorter.call();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(shorter.state.outages, [], 'the 402 that asks for a shorter reply is no outage');
  } finally {
    shorter.restore();
  }
});

test('no platform OpenRouter key → 502 no_platform_key, nothing forwarded', async () => {
  const p = loadProxy(makePool({ weeklySpent: 100 }), { platformKey: null });
  try {
    const r = await p.call();
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'no_platform_key');
    assert.equal(p.state.forwards.length, 0);
  } finally {
    p.restore();
  }
});

// #1088: the regression this issue reported. The per-turn registry flag
// resets on every dispatch, so before the day claim the notice re-fired
// on every chat for the rest of the day.
test('user cap exhausted → 429 budget_exceeded, nothing forwarded', async () => {
  const pool = makePool({ weeklySpent: 2500 });
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'budget_exceeded');
    assert.equal(r.body.message, 'Weekly limit reached ($25.00). Resets Monday 00:00 UTC.');
    assert.equal(p.state.forwards.length, 0);
  } finally {
    p.restore();
  }
});

test('GLOBAL cap exhausted → non-regressive: forwards on the platform key', async () => {
  const pool = makePool({ weeklySpent: 100, globalSpent: 20000 });
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 200, 'keyless users gain no NEW 429 from the global-cap check');
    assert.equal(p.state.forwards[0].apiKey, PLATFORM_KEY);
  } finally {
    p.restore();
  }
});

test('sync turn over the system budget → 429', async () => {
  const pool = makePool({ systemSpent: 2500 });
  const p = loadProxy(pool, { turnMode: 'sync' });
  try {
    const r = await p.call();
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'budget_exceeded');
    assert.match(r.body.message, /System token budget reached/);
    assert.equal(p.state.forwards.length, 0);
  } finally {
    p.restore();
  }
});

test('mid-stream: crossing the cap while the answer streams kills the call', async () => {
  const pool = makePool({ weeklySpent: 2400 });
  const p = loadProxy(pool);
  try {
    await p.call();
    const kill = p.state.forwards[0].shouldKill;
    assert.ok(kill, 'platform-billed calls carry the hook');
    assert.equal(kill(500, 'claude-test'), 'over_budget');
    assert.equal(kill(1, 'claude-test'), null, 'under-cap streaming is untouched');
  } finally {
    p.restore();
  }
});

// ── #1788/#2571: the weekly cap is the gate ─────────────────────────────
//
// #1788 added the weekly ceiling beside a daily one; #2571 switched the
// daily one off, so every case above is already a weekly-only account.
// These cover the axis at a different figure: it refuses, it kills
// mid-stream, and it stays entirely out of the way of sync turns, which
// still bill the daily system bucket.

test('weekly cap exhausted → 429 naming the WEEK, not the day', async () => {
  // Nothing spent today; only the week-to-date sum refuses this call.
  const pool = makePool({ userSpent: 0, weeklyLimit: 17500, weeklySpent: 17500 });
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'budget_exceeded');
    assert.equal(r.body.message, 'Weekly limit reached ($175.00). Resets Monday 00:00 UTC.',
      'the refusal names the boundary the user actually has to wait for');
    assert.equal(p.state.forwards.length, 0);
    assert.ok(pool.issued(/llm_usage WHERE user_id = \$1 AND date >= \$2/),
      'and it got there by reading the week, not by inferring it from today');
  } finally {
    p.restore();
  }
});

test('a weekly cap with headroom left costs one read and then gets out of the way', async () => {
  const pool = makePool({ userSpent: 100, weeklyLimit: 17500, weeklySpent: 900 });
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 200);
    assert.equal(p.state.forwards[0].apiKey, PLATFORM_KEY);
  } finally {
    p.restore();
  }
});

test('no weekly cap → the weekly ledger is never queried at all', async () => {
  const pool = makePool({ weeklyLimit: 0, weeklyOverride: 0 });
  const p = loadProxy(pool);
  try {
    await p.call();
    assert.equal(pool.issued(/COALESCE\(SUM\(total_cost_cents\), 0\) AS total/), false,
      'an account with the weekly layer switched off pays nothing for it');
  } finally {
    p.restore();
  }
});

// Fails closed: an account an admin has switched both caps off for has no
// allowance to draw down, so it is refused rather than handed the
// platform key.
test('both caps switched off → 429, and the copy points at the admin console', async () => {
  const pool = makePool({ userLimit: 0, weeklyLimit: 0, weeklyOverride: 0 });
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'budget_exceeded');
    assert.match(r.body.message, /No AI allowance is configured for this account/);
    assert.match(r.body.message, /admin can set a daily or weekly cap/);
    assert.doesNotMatch(r.body.message, /Resets/,
      'there is no window to wait for — waiting fixes nothing here');
    assert.equal(p.state.forwards.length, 0);
  } finally {
    p.restore();
  }
});

test('sync turns bill the system bucket and never consult a weekly cap', async () => {
  const pool = makePool({ systemSpent: 0, weeklyLimit: 17500, weeklySpent: 17500 });
  const p = loadProxy(pool, { turnMode: 'sync' });
  try {
    const r = await p.call();
    assert.equal(r.status, 200, 'the user’s weekly cap is not the payer here');
    assert.equal(p.state.forwards[0].apiKey, PLATFORM_KEY);
    assert.equal(pool.issued(/COALESCE\(SUM\(total_cost_cents\), 0\) AS total/), false);
  } finally {
    p.restore();
  }
});

test('mid-stream: a weekly crossing kills the call, same as a daily one', async () => {
  // $1 of weekly room left, and plenty of daily room — so only the weekly
  // bucket can cross while the response streams.
  const pool = makePool({ userSpent: 0, weeklyLimit: 17500, weeklySpent: 17400 });
  const p = loadProxy(pool);
  try {
    await p.call();
    const kill = p.state.forwards[0].shouldKill;
    assert.ok(kill, 'platform-billed calls carry the hook');
    assert.equal(kill(500, 'claude-test'), 'over_budget',
      'the running cost pushed week-to-date past the weekly cap');
    assert.equal(kill(1, 'claude-test'), null, 'under both caps, streaming is untouched');
  } finally {
    p.restore();
  }
});

// #2513 REVERSES THIS, deliberately, and the old expectation is recorded
// rather than deleted.
//
// This test used to be named "a weekly ledger read that throws fails OPEN",
// and it asserted `200` with the reasoning: "the gate's whole purpose is
// refusing spend, so a bookkeeping read that fails must not be what does the
// refusing." That is a real argument, and it was the intended behaviour —
// this was never an oversight.
//
// The security audit in #2513 weighed it the other way, and the deciding
// point is what each failure mode costs. Failing open on a cap over REAL
// MONEY means a Postgres blip removes the spending limit rather than the
// traffic — for the full cache TTL, on every replica independently, while
// the caller is free to spend as fast as they can issue calls. Failing
// closed costs a 429 that a caller retries a second later.
//
// The refusal is also softened by the rest of the fix: a previous reading is
// kept and reused rather than discarded, so this hard refusal only happens
// when NOTHING is known about the payer yet, and the retry window is one
// second rather than the full ten.
test('a weekly ledger read that throws fails CLOSED (#2513)', async () => {
  const pool = makePool({ userSpent: 0, weeklyLimit: 17500, weeklySpent: 17500 });
  const inner = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/COALESCE\(SUM\(total_cost_cents\), 0\) AS total/.test(sql)) {
      throw new Error('weekly read boom');
    }
    return inner(sql, params);
  };
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 429,
      'an unreadable ledger must not be treated as zero spend on a money cap');
    assert.equal(p.state.forwards.length, 0, 'and nothing is forwarded upstream');
  } finally {
    p.restore();
  }
});
