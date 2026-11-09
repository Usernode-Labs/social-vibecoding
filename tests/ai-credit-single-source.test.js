// #6493: one live AI credit figure, everywhere.
//
// The AI-credit row in Settings and the AI chat's "$ left" pill share one
// copy; the dev chat's meter and Settings' "This week's spend" card used to
// keep their own. A missed live update (a backgrounded tab, a dropped socket)
// left those copies tens of dollars apart. These drive the real modules: the
// dev chat's /api/budget answer lands in the one shared allowance (so the
// Settings row moves), and a Settings-side write repaints an open dev chat
// through `homeroom:ai-budget-changed`. The spend card's platform line is
// read from the same state, so its figure is the row's.
//
// Run with: node --test tests/ai-credit-single-source.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const importOnce = require('./lib/import-once');
const { renderComponent } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');

const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

// A document stand-in shared by every sandbox in this file, so a write in one
// module reaches the listener another module registered — the same way a real
// `homeroom:ai-budget-changed` on the page does.
function eventBus() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) || []) fn(event);
      return true;
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

let sharedBus = null;
function bus() {
  if (!sharedBus) {
    sharedBus = eventBus();
    globalThis.document = sharedBus;
  }
  return sharedBus;
}

async function loadCredit() {
  bus();
  const g = globalThis;
  if (!g.window) g.window = g;
  if (!g.PlatformI18n) g.PlatformI18n = englishPlatformI18n();
  if (!g.CreditOptions) {
    const sandbox = { module: { exports: {} }, window: {}, console, PlatformI18n: englishPlatformI18n() };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('public/js/credit-options.js'), sandbox);
    g.CreditOptions = sandbox.module.exports;
    g.window.CreditOptions = g.CreditOptions;
  }
  await importOnce(path.join(root, 'frontend/src/features/header/ai-credit.js'));
  const store = await importOnce(
    path.join(root, 'frontend/src/features/header/ai-budget-store.js'));
  return { AiCredit: g.window.AiCredit, aiBudgetStore: store.aiBudgetStore };
}

function reset(AiCredit) {
  AiCredit.Budget.state = null;
  AiCredit.Budget._ticket = 0;
  AiCredit.Budget._lastApplied = 0;
}

// ── The dev chat, in a sandbox over the real shared allowance ────────────

function devChat(AiCredit, answer) {
  let published = null;
  const sandbox = {
    console, URLSearchParams,
    location: { search: '' },
    setInterval: () => 1, clearInterval: () => {},
    setTimeout, clearTimeout,
    document: bus(),
    localStorage: { getItem: () => null },
    fetch: async () => ({ ok: true, json: async () => answer }),
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.Settings = { state: {} };
  sandbox.PlatformI18n = englishPlatformI18n();
  // The real module, published where the dev chat reads it (#6493).
  sandbox.AiCredit = AiCredit;
  vm.createContext(sandbox);
  vm.runInContext(`${read('frontend/src/features/dev-chat/dev-chat.js')}\n;this.chat = DevChat;`, sandbox);
  const chat = sandbox.chat;
  chat.currentSession = { id: 42 };
  chat._isOpenRouterSession = () => false;
  chat._applyCreditsBanner = () => {};
  chat._applyCreditsLowBanner = () => {};
  chat.renderBudget = () => { published = chat._budgetPillView(); };
  return {
    chat,
    html: () => (published
      ? renderComponent('frontend/src/features/dev-chat/budget-pill.tsx', 'BudgetPillView',
        JSON.parse(JSON.stringify(published)))
      : ''),
  };
}

// ── Settings, in a sandbox with just the spend card's nodes ──────────────

function settingsScreen(AiCredit) {
  const node = () => ({ textContent: '', title: '', classList: { add() {}, remove() {}, contains: () => false } });
  const nodes = {
    'settings-spend': node(),
    'settings-spend-platform': node(),
    'settings-spend-byok': node(),
    'settings-spend-reset': node(),
  };
  const sandbox = {
    console,
    PlatformI18n: englishPlatformI18n(),
    document: {
      addEventListener: bus().addEventListener,
      dispatchEvent: bus().dispatchEvent,
      getElementById: (id) => nodes[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    location: { hash: '', search: '' },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    fetch: async () => { throw new Error('not used by this test'); },
  };
  sandbox.window = sandbox;
  sandbox.AiCredit = AiCredit;
  vm.createContext(sandbox);
  vm.runInContext(read('frontend/src/features/settings/settings.js'), sandbox);
  return { Settings: sandbox.Settings, nodes };
}

const snapshot = (over = {}) => ({
  limitCents: 84000,
  spentCents: 8000,
  remainingCents: 76000,
  byokCents: 0,
  hasByokKey: false,
  capWindow: 'weekly',
  windowLabel: 'This week',
  resetLabel: 'Monday 00:00 UTC',
  ...over,
});

test('a dev chat budget answer fills the one allowance, so the Settings row moves', async () => {
  const { AiCredit, aiBudgetStore } = await loadCredit();
  reset(AiCredit);
  const h = devChat(AiCredit, {
    ...snapshot({ spentCents: 8000, remainingCents: 76000 }),
    byokSpentCents: 0,
    globalSpentCents: 0,
    globalLimitCents: 100000,
    aiEnabled: true,
  });

  await h.chat.refreshBudget();

  assert.equal(AiCredit.Budget.current().spentCents, 8000,
    'the dev chat answered with the shared figure');
  assert.match(JSON.stringify(aiBudgetStore.get().view), /\$760/,
    'the Settings row renders it without a fetch of its own');
  assert.equal(h.chat.budget.spentCents, 8000, 'and the dev chat meter reads it too');
  assert.equal(h.chat.budget.globalSpentCents, 0, 'the route-only extras survive');
});

test('a Settings-side write repaints an open dev chat from the same figure', async () => {
  const { AiCredit } = await loadCredit();
  reset(AiCredit);
  const h = devChat(AiCredit, null);
  h.chat.renderBudget();
  assert.doesNotMatch(h.html(), /\$16\.00/, 'nothing to show before the fetch lands');

  // Settings._refreshSpend (or any other surface) adopts the fresh answer.
  AiCredit.Budget.adopt(snapshot({ spentCents: 1600, remainingCents: 82400 }));

  assert.match(h.html(), /\$16\.00/,
    'the homeroom:ai-budget-changed event repainted the meter');
  assert.match(h.html(), /\$840\.00/);
});

test('the spend card platform line is the AI-credit row\'s figure', async () => {
  const { AiCredit, aiBudgetStore } = await loadCredit();
  reset(AiCredit);
  const { Settings, nodes } = settingsScreen(AiCredit);

  AiCredit.Budget.adopt(snapshot({ spentCents: 8000, remainingCents: 76000 }));
  Settings._paintSpendPlatform();

  assert.equal(nodes['settings-spend-platform'].textContent, '$80.00 of $840.00');
  // The row states the same allowance: "$760 of $840 left".
  const row = JSON.stringify(aiBudgetStore.get().view);
  assert.match(row, /\$760/);
  assert.match(row, /\$840/);
});
