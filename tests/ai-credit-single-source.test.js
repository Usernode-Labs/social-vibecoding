// #6493: one live AI credit figure, everywhere.
//
// The AI-credit row in Settings and the AI chat's "$ left" pill share one
// copy; Settings' "This week's spend" card used to keep its own. A missed
// live update (a backgrounded tab, a dropped socket) left the copies tens of
// dollars apart. This drives the real modules: the spend card's platform line
// is read from the same state as the row, so its figure is the row's.
//
// Run with: node --test tests/ai-credit-single-source.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const importOnce = require('./lib/import-once');

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
