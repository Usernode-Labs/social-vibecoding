// Tests for the worker Anthropic proxy's per-call BYOK switchover (#664)
// — routes/anthropic-proxy.js. When the daily allowance (user cap OR
// global cap) is exhausted, calls from a user with a BYOK key on file
// must forward on THAT key instead of 429ing; keyless users keep the
// exact gate/kill behaviour they had; sync turns never spill onto a
// user's key.
//
// The proxy router is loaded fresh per test (its budget caches are
// module-level) against require.cache stubs: auth injects a fixed
// workerSession, anthropic-stream's forwardCall is captured instead of
// hitting the network, and the worker registry / ws / session-bus are
// recording fakes. The REAL limits module runs against a mock pool so
// the cap/spend SQL shapes stay covered.
//
// Run with: node --test tests/anthropic-proxy-switchover.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const limits = require('../src/services/limits');
const secrets = require('../src/services/secrets');

// At-rest encryption key (services/secrets.js KDF input) — not a
// signing key. Same value the old shared JWT_SECRET held; the split was
// a rename, so existing ciphertext keeps decrypting.
const DATA_KEY = 'test-jwt-secret';
const USER_KEY = 'sk-ant-user-key';
const PLATFORM_KEY = 'sk-ant-platform-key';
const GOOD_KEY_ENC = secrets.encrypt(USER_KEY, DATA_KEY);
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
  userLimit = 2500,
  userSpent = 0,
  globalLimit = 20000,
  globalSpent = 0,
  systemSpent = 0,
  keyEnc = null,
} = {}) {
  const calls = [];
  const notices = [];
  return {
    calls,
    notices,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT user_id FROM chat_sessions/.test(sql)) {
        return { rows: [{ user_id: USER_ID }] };
      }
      if (/SELECT daily_limit_cents FROM users/.test(sql)) {
        return { rows: [{ daily_limit_cents: userLimit }] };
      }
      if (/SELECT value FROM platform_settings/.test(sql)) {
        const value = params[0] === limits.KEY_GLOBAL ? globalLimit
          : params[0] === limits.KEY_SYSTEM ? 2500 : userLimit;
        return { rows: [{ value: String(value) }] };
      }
      if (/SELECT total_cost_cents FROM llm_usage/.test(sql)) {
        return { rows: [{ total_cost_cents: userSpent }] };
      }
      if (/SELECT SUM\(total_cost_cents\)/.test(sql)) {
        return { rows: [{ total: globalSpent }] };
      }
      if (/SELECT cost_cents FROM system_token_usage/.test(sql)) {
        return { rows: [{ cost_cents: systemSpent }] };
      }
      // The kill-suppression EXISTS probe (AS present) must match BEFORE
      // the decrypting key lookup — both mention anthropic_key_enc.
      if (/AS present/.test(sql)) {
        return { rows: [{ present: !!keyEnc }] };
      }
      if (/SELECT anthropic_key_enc FROM users/.test(sql)) {
        return { rows: keyEnc ? [{ anthropic_key_enc: keyEnc }] : [] };
      }
      if (/INSERT INTO chat_session_messages/.test(sql)) {
        notices.push({ sessionId: params[0], text: params[1], metadata: params[2] });
        return { rows: [] };
      }
      return { rows: [] };
    },
    issued(re) { return calls.some((c) => re.test(c.sql)); },
  };
}

// Load routes/anthropic-proxy.js fresh with stubs, mount it, and return
// a driver + captured state.
function loadProxy(pool, { turnMode = 'build', forwardResult = {} } = {}) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    auth: require.resolve('../src/middleware/anthropic-proxy-auth'),
    stream: require.resolve('../src/services/anthropic-stream'),
    worker: require.resolve('../src/services/worker'),
    ws: require.resolve('../src/services/ws'),
    bus: require.resolve('../src/services/session-bus'),
    proxy: require.resolve('../src/routes/anthropic-proxy'),
  };

  const state = {
    forwards: [],       // { apiKey, upstreamUrl, shouldKill }
    byokSpend: [],      // { sessionId, cents }
    switchMarks: 0,     // markTurnByokSwitched invocations
    alreadySwitched: false,
    broadcasts: [],
    busEvents: [],
  };

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => pool })],
    [paths.auth, stubModule(paths.auth, {
      anthropicProxyAuth: (req, _res, next) => {
        req.workerSession = { sessionId: SESSION_ID };
        next();
      },
    })],
    [paths.stream, stubModule(paths.stream, {
      ANTHROPIC_UPSTREAM: 'https://api.anthropic.test',
      forwardCall: async ({ res, apiKey, upstreamUrl, shouldKill }) => {
        state.forwards.push({ apiKey, upstreamUrl, shouldKill: shouldKill || null });
        res.status(200).json({ ok: true });
        return { costCents: 5, model: 'claude-test', killed: false, status: 200, ...forwardResult };
      },
    })],
    [paths.worker, stubModule(paths.worker, {
      getActiveTurnMode: () => turnMode,
      markTurnByokSwitched: () => {
        state.switchMarks += 1;
        if (state.alreadySwitched) return false;
        state.alreadySwitched = true;
        return true;
      },
      noteTurnByokSpend: (sessionId, cents) => state.byokSpend.push({ sessionId, cents }),
      getTurnByokCents: () => 0,
    })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: (ev) => state.broadcasts.push(ev),
    })],
    [paths.bus, stubModule(paths.bus, {
      publish: (sessionId, ev) => state.busEvents.push({ sessionId, ev }),
      subscribe: () => () => {},
      clearSession: () => {},
    })],
  ];
  delete require.cache[paths.proxy];
  const anthropicProxyRoutes = require('../src/routes/anthropic-proxy');

  const app = express();
  app.use(anthropicProxyRoutes({
    anthropicApiKey: PLATFORM_KEY,
    // The BYOK ciphertext is keyed off the at-rest data key, which is no
    // longer any token-signing secret. Same bytes here — the split was an
    // env-var rename, so GOOD_KEY_ENC below still decrypts.
    dataEncryptionKey: DATA_KEY,
  }));
  const server = http.createServer(app);

  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.proxy];
    server.close();
  };

  const call = async () => {
    if (!server.listening) await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/anthropic/v1/messages`, {
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

test('allowance headroom → forwards on the platform key, no key lookup', async () => {
  const pool = makePool({ userSpent: 100, keyEnc: GOOD_KEY_ENC });
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 200);
    assert.equal(p.state.forwards.length, 1);
    assert.equal(p.state.forwards[0].apiKey, PLATFORM_KEY);
    assert.equal(pool.issued(/SELECT anthropic_key_enc/), false,
      'the decrypting key lookup only runs once the allowance is exhausted');
    assert.equal(p.state.byokSpend.length, 0);
  } finally {
    p.restore();
  }
});

test('user cap exhausted + key on file → forwards on the USER key, notice once, spillover tallied', async () => {
  const pool = makePool({ userSpent: 2500, keyEnc: GOOD_KEY_ENC });
  const p = loadProxy(pool);
  try {
    const r1 = await p.call();
    assert.equal(r1.status, 200, 'no 429 for key-holders at the cap');
    assert.equal(p.state.forwards[0].apiKey, USER_KEY);
    assert.equal(p.state.forwards[0].shouldKill, null, 'BYOK calls carry no budget kill');
    // The switched call's observed cost lands in the per-turn tally.
    assert.deepEqual(p.state.byokSpend, [{ sessionId: SESSION_ID, cents: 5 }]);
    // One-time notice: persisted system row + WS broadcast + bus publish.
    assert.equal(pool.notices.length, 1);
    assert.match(pool.notices[0].text, /continuing on your Anthropic API key/);
    assert.equal(pool.notices[0].sessionId, SESSION_ID);
    assert.equal(p.state.broadcasts.length, 1);
    assert.equal(p.state.broadcasts[0].event, 'billing_switched');
    assert.equal(p.state.busEvents.length, 1);
    assert.equal(p.state.busEvents[0].ev.type, 'billing_switched');
    assert.ok(p.state.busEvents[0].ev._seq, 'bus events must carry a _seq to survive publish');

    // Second switched call in the same turn: forwards again, NO second notice.
    const r2 = await p.call();
    assert.equal(r2.status, 200);
    assert.equal(p.state.forwards[1].apiKey, USER_KEY);
    assert.equal(pool.notices.length, 1, 'notice fires exactly once per turn');
    assert.equal(p.state.broadcasts.length, 1);
  } finally {
    p.restore();
  }
});

test('user cap exhausted + NO key → the unchanged 429 budget_exceeded', async () => {
  const pool = makePool({ userSpent: 2500 });
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'budget_exceeded');
    assert.equal(r.body.message, 'Daily limit reached ($25.00). Resets at midnight UTC.');
    assert.equal(p.state.forwards.length, 0);
    assert.equal(pool.notices.length, 0);
  } finally {
    p.restore();
  }
});

test('GLOBAL cap exhausted + key on file → switches to the user key mid-turn', async () => {
  const pool = makePool({ userSpent: 100, globalSpent: 20000, keyEnc: GOOD_KEY_ENC });
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 200);
    assert.equal(p.state.forwards[0].apiKey, USER_KEY);
    assert.equal(pool.notices.length, 1);
  } finally {
    p.restore();
  }
});

test('GLOBAL cap exhausted + NO key → non-regressive: forwards on the platform key', async () => {
  const pool = makePool({ userSpent: 100, globalSpent: 20000 });
  const p = loadProxy(pool);
  try {
    const r = await p.call();
    assert.equal(r.status, 200, 'keyless users gain no NEW 429 from the global-cap check');
    assert.equal(p.state.forwards[0].apiKey, PLATFORM_KEY);
  } finally {
    p.restore();
  }
});

test('sync turn + key on file → still 429s on the system budget (never bills the user key)', async () => {
  const pool = makePool({ systemSpent: 2500, keyEnc: GOOD_KEY_ENC });
  const p = loadProxy(pool, { turnMode: 'sync' });
  try {
    const r = await p.call();
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'budget_exceeded');
    assert.match(r.body.message, /System token budget reached/);
    assert.equal(pool.issued(/SELECT anthropic_key_enc/), false,
      'sync turns never even look the user key up');
    assert.equal(p.state.forwards.length, 0);
  } finally {
    p.restore();
  }
});

test('mid-stream kill suppressed for key-holders on the boundary call, active for keyless', async () => {
  // Key-holder, allowance nearly gone: the platform-billed call goes out,
  // and its shouldKill must return null even when the running cost
  // crosses the cap (the NEXT call's gate does the switch).
  const keyedPool = makePool({ userSpent: 2400, keyEnc: GOOD_KEY_ENC });
  const keyed = loadProxy(keyedPool);
  try {
    await keyed.call();
    const kill = keyed.state.forwards[0].shouldKill;
    assert.ok(kill, 'platform-billed calls still receive a shouldKill hook');
    assert.equal(kill(500, 'claude-test'), null,
      'over-budget mid-stream must NOT kill when a BYOK fallback exists');
  } finally {
    keyed.restore();
  }

  limits.invalidate();

  // Keyless user at the same spend: the kill fires exactly as today.
  const keylessPool = makePool({ userSpent: 2400 });
  const keyless = loadProxy(keylessPool);
  try {
    await keyless.call();
    const kill = keyless.state.forwards[0].shouldKill;
    assert.equal(kill(500, 'claude-test'), 'over_budget');
    assert.equal(kill(1, 'claude-test'), null, 'under-cap streaming is untouched');
  } finally {
    keyless.restore();
  }
});
