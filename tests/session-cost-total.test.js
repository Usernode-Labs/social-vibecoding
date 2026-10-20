// #3249: the dev chat meter's running total for the whole change.
//
// Server half: one helper sums the three per-session cost records
// (Homeroom's replies, the Claude agent ledger, OpenRouter coding turns) and
// both session payloads the dev chat reads carry it. Client half: the meter
// shows "this change $X" after the credits and "this turn" figures, hidden
// at zero, and every /status answer for the session on screen moves it.
//
// Run with: node --test tests/session-cost-total.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

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

test('both session payloads the dev chat reads carry the total', () => {
  const src = fs.readFileSync(path.join(root, 'src/routes/sessions.js'), 'utf8');
  assert.match(src, /session\.cost_total_cents = await sessionCost\.sessionCostCents\(pool, session\.id\)/);
  assert.match(src, /catch \{ session\.cost_total_cents = null; \}/);
  const status = src.slice(src.indexOf("router.get('/api/sessions/:id/status'"));
  const visibility = status.indexOf('canViewSession(seen[0], req.user)');
  const read = status.indexOf('sessionCost.sessionCostCents(pool, sessionId)');
  assert.ok(visibility > 0 && read > visibility, 'the total is read only after the visibility check');
  assert.match(status.slice(0, status.indexOf('router.post(')), /costTotalCents,/);
});

// ── Client ──────────────────────────────────────────────────────────────

function devChat({ search = '', openRouter = false } = {}) {
  let published = null;
  const sandbox = {
    console, URLSearchParams,
    location: { search },
    setInterval: () => 1, clearInterval: () => {},
    setTimeout, clearTimeout,
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: () => null },
    fetch: () => new Promise(() => {}),
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.Settings = { state: {} };
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  const file = path.join(root, 'frontend/src/features/dev-chat/dev-chat.js');
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\n;this.chat = DevChat;', sandbox);
  const chat = sandbox.chat;
  chat.currentSession = { id: 42 };
  chat._isOpenRouterSession = () => openRouter;
  chat._settledBudgetPillView = () => ({ title: null, parts: [{ text: '$3.20/$50.00', className: 'x' }] });
  chat.renderBudget = () => { published = chat._budgetPillView(); };
  return { chat, text: () => (published || chat._budgetPillView()).parts.map((p) => p.text).join('') };
}

const change = (amount) => message('devchat:budget.pill.thisChange').replace('{{amount}}', amount);
const turn = (amount) => message('devchat:budget.pill.thisTurnEstimated').replace('{{amount}}', amount);

test('the meter shows the change total after the credits, hidden at zero', () => {
  const { chat, text } = devChat();
  assert.equal(text(), '$3.20/$50.00');
  chat.currentSession.cost_total_cents = 0.4;
  assert.equal(text(), '$3.20/$50.00', 'a total that rounds to $0.00 says nothing');
  chat.currentSession.cost_total_cents = '124';
  assert.equal(text(), `$3.20/$50.00 · ${change('1.24')}`);
  const part = chat._budgetPillView().parts.at(-1);
  assert.equal(part.title, message('devchat:budget.pill.thisChangeTitle'));
});

test('while a turn runs, "this change" follows "this turn"', () => {
  const { chat, text } = devChat();
  chat.currentSession.cost_total_cents = 300;
  chat._applyLiveSpend({ busy: true, spend: { costCents: 40, estimated: true }, costTotalCents: 320 }, 42);
  assert.equal(text(), `$3.20/$50.00 · ${turn('0.40')} · ${change('3.20')}`);
});

test('a /status answer moves the total; another session\'s answer does not', () => {
  const { chat, text } = devChat();
  chat._applyLiveSpend({ busy: false, costTotalCents: 250 }, 42);
  assert.equal(text(), `$3.20/$50.00 · ${change('2.50')}`);
  chat._applyLiveSpend({ busy: false, costTotalCents: 999 }, 7);
  assert.equal(text(), `$3.20/$50.00 · ${change('2.50')}`);
  chat._applyLiveSpend({ busy: false, costTotalCents: null }, 42);
  assert.equal(text(), `$3.20/$50.00 · ${change('2.50')}`, 'a failed read keeps the figure');
});

test('an idle OpenRouter snapshot still updates the total and keeps "this turn"', () => {
  const { chat, text } = devChat({ openRouter: true });
  chat._applyLiveSpend({ busy: true, spend: { costCents: 12, estimated: true }, costTotalCents: 100 }, 42);
  chat._applyLiveSpend({ busy: false, costTotalCents: 130 }, 42);
  assert.equal(text(), `$3.20/$50.00 · ${turn('0.12')} · ${change('1.30')}`);
});

test('?shot=session-cost paints a sample $1.24 on the open change', () => {
  const { chat, text } = devChat({ search: '?shot=session-cost' });
  assert.equal(text(), `$3.20/$50.00 · ${change('1.24')}`);
  chat.currentSession = null;
  assert.equal(chat._shotSessionCost(), null);
});
