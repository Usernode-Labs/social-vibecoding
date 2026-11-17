// #3249: a change's running cost total.
//
// One helper sums the three per-session cost records (Homeroom's replies,
// the Claude agent ledger, OpenRouter coding turns), and both session
// payloads carry it: GET /api/sessions/:id and GET /api/sessions/:id/status
// (the connector's get_change reads the latter).
//
// Run with: node --test tests/session-cost-total.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { sessionCostCents } = require('../src/services/session-cost');

// ── Server ──────────────────────────────────────────────────────────────

test('sessionCostCents sums the three session ledgers in one query', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ cents: '412.5' }] }; } };
  assert.equal(await sessionCostCents(pool, 7), 412.5);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [7]);
  assert.match(calls[0].sql, /SUM\(m\.cost_cents\) FROM chat_session_messages/);
  assert.match(calls[0].sql, /cs\.agent_cost_cents/);
  assert.match(calls[0].sql, /SUM\(t\.estimated_cost_usd\) \* 100 FROM agent_turns/);
});

test('sessionCostCents answers 0 for a missing session or a non-number', async () => {
  assert.equal(await sessionCostCents({ query: async () => ({ rows: [] }) }, 7), 0);
  assert.equal(await sessionCostCents({ query: async () => ({ rows: [{ cents: null }] }) }, 7), 0);
});

test('both session payloads carry the total', () => {
  const src = fs.readFileSync(path.join(root, 'src/routes/sessions.js'), 'utf8');
  assert.match(src, /session\.cost_total_cents = await sessionCost\.sessionCostCents\(pool, session\.id\)/);
  assert.match(src, /catch \{ session\.cost_total_cents = null; \}/);
  const status = src.slice(src.indexOf("router.get('/api/sessions/:id/status'"));
  const visibility = status.indexOf('canViewSession(seen[0], req.user)');
  const read = status.indexOf('sessionCost.sessionCostCents(pool, sessionId)');
  assert.ok(visibility > 0 && read > visibility, 'the total is read only after the visibility check');
  // Who gets it, through the real route: tests/session-status-cost-route.test.js.
  assert.match(status.slice(0, status.indexOf('router.post(')), /\.\.\.\(mayReadCost \? \{ costTotalCents \} : \{\}\),/);
});
