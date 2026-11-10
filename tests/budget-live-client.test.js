// #2598: the client half of the live weekly meter.
//
// The server pushes `budget_updated` every time a model call's cost lands
// against the spender's weekly pool (tests/budget-live-push.test.js pins that
// half). Here: the two surfaces that render "$x left this week" repaint from
// the pushed figures, without a refetch, and without losing the fields the
// push does not carry.
//
// The last one is the trap worth a test. The pushed payload is the shared
// snapshot (limits.getBudgetSnapshot); GET /api/budget wraps that snapshot
// with three fields of its own plus a different spelling of the BYOK figure,
// and the composer's exhausted banner reads two of them to decide whether it
// is the user's allowance or the platform's shared budget that ran out. A
// push that replaced the object instead of merging into it would blank those
// and quietly change what the banner says.
//
// Run with: node --test tests/budget-live-client.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const { renderComponent } = require('./lib/render-tsx');
const importOnce = require('./lib/import-once');

const root = path.join(__dirname, '..');

// The snapshot the server pushes — limits.getBudgetSnapshot's shape.
const pushed = (over = {}) => ({
  limitCents: 5000,
  spentCents: 1200,
  remainingCents: 3800,
  weeklySpentCents: 1200,
  byokCents: 0,
  hasByokKey: false,
  capWindow: 'weekly',
  windowLabel: 'This week',
  resetLabel: 'Monday 00:00 UTC',
  lowBalancePct: 80,
  live: true,
  ...over,
});

// ── The composer's meter ────────────────────────────────────────────────

function devChat({ search = '', sharedState = null } = {}) {
  let published = null;
  let requests = 0;
  let ticket = 0;
  // The ONE shared allowance (#6493). The real holder is
  // features/header/ai-credit.js; a plain cell stands in for it here so what
  // is under test is the dev chat's getter and its repaint, not that module.
  const shared = { state: sharedState };
  const sandbox = {
    console, URLSearchParams,
    location: { search },
    setInterval: () => 1, clearInterval: () => {},
    setTimeout, clearTimeout,
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: () => null },
    fetch: () => { requests += 1; return new Promise(() => {}); },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.Settings = { state: {} };
  sandbox.PlatformI18n = englishPlatformI18n();
  sandbox.AiCredit = {
    Budget: {
      current: () => shared.state,
      adopt: (snap) => { shared.state = snap; return true; },
      _takeTicket: () => { ticket += 1; return ticket; },
    },
  };
  vm.createContext(sandbox);
  const file = path.join(root, 'frontend/src/features/dev-chat/dev-chat.js');
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\n;this.chat = DevChat;', sandbox);
  requests = 0; // whatever the module did on load is not what is under test
  const chat = sandbox.chat;
  chat.currentSession = { id: 42 };
  chat._isOpenRouterSession = () => false;
  // The real meter, but with the two banner writers stubbed: they resolve
  // elements this sandbox has none of, and what is under test is the figure.
  chat._applyCreditsBanner = () => {};
  chat._applyCreditsLowBanner = () => {};
  chat.renderBudget = () => {
    chat._applyCreditsBanner();
    chat._applyCreditsLowBanner();
    published = chat._budgetPillView();
  };
  return {
    chat,
    shared,
    requests: () => requests,
    html: () => (published
      ? renderComponent('frontend/src/features/dev-chat/budget-pill.tsx', 'BudgetPillView',
        JSON.parse(JSON.stringify(published)))
      : ''),
  };
}

test('a pushed figure repaints the composer meter with no request of its own', () => {
  const h = devChat({
    sharedState: pushed({ spentCents: 1200, weeklySpentCents: 1200, remainingCents: 3800 }),
  });
  h.chat.renderBudget();
  assert.match(h.html(), /\$12\.00/);

  // app.js's order: the push lands in the one shared allowance first, then
  // the dev chat repaints from it.
  const next = pushed({ spentCents: 1850, weeklySpentCents: 1850, remainingCents: 3150 });
  h.shared.state = next;
  h.chat.applyBudgetUpdate(next);
  assert.match(h.html(), /\$18\.50/, 'the meter moved mid-turn');
  assert.match(h.html(), /\$50\.00/);
  assert.equal(h.requests(), 0, 'the push carries the figures; nothing is refetched');

  // …and again, a couple of seconds later, as the next call lands.
  const later = pushed({ spentCents: 2010, weeklySpentCents: 2010, remainingCents: 2990 });
  h.shared.state = later;
  h.chat.applyBudgetUpdate(later);
  assert.match(h.html(), /\$20\.10/);
});

test('the dev chat composes the shared snapshot with /api/budget\'s own fields', () => {
  const h = devChat();
  h.chat._budgetExtras = { globalSpentCents: 4000, globalLimitCents: 100000, aiEnabled: true };
  // Three fields the pushed snapshot does not carry. _globalBudgetOut()
  // reads two of them to decide whose budget the exhausted banner blames.
  h.shared.state = pushed({ spentCents: 4900, weeklySpentCents: 4900, remainingCents: 100, byokCents: 450 });
  assert.equal(h.chat.budget.globalSpentCents, 4000);
  assert.equal(h.chat.budget.globalLimitCents, 100000);
  assert.equal(h.chat.budget.aiEnabled, true);
  assert.equal(h.chat._globalBudgetOut(), false, 'the shared-budget verdict is unchanged');
  assert.equal(h.chat.budget.byokSpentCents, 450,
    'the snapshot\'s byokCents is the spelling this meter reads');
  assert.equal(h.chat.budget.limitCents, 5000, 'the allowance itself is the shared one');
});

test('a fixture page keeps its fixture', () => {
  for (const search of ['?demo=1', '?demo=weekly-out', '?shot=credits-low', '?shot=credits-exhausted']) {
    const h = devChat({ search });
    const before = h.chat._budgetDemo() ? null : h.chat._shotCreditsLowBudget();
    h.chat.budget = before || { spentCents: 5000, limitCents: 5000, remainingCents: 0 };
    h.shared.state = pushed({ spentCents: 10, weeklySpentCents: 10, remainingCents: 4990 });
    h.chat.applyBudgetUpdate(pushed({ spentCents: 10, weeklySpentCents: 10, remainingCents: 4990 }));
    assert.notEqual(h.chat.budget.spentCents, 10,
      `${search} is showing a fixture on purpose and the shared figure must not swap it out`);
  }
});

test('a malformed push changes nothing', () => {
  const h = devChat();
  const budget = { spentCents: 1200, limitCents: 5000, remainingCents: 3800 };
  h.chat.budget = budget;
  for (const bad of [null, undefined, 'nope', 42]) h.chat.applyBudgetUpdate(bad);
  assert.equal(h.chat.budget, budget, 'the object is not even replaced');
});

// ── The header drawer's AI-credit row ───────────────────────────────────

const CREDIT_OPTIONS_SRC = fs.readFileSync(path.join(root, 'public/js/credit-options.js'), 'utf8');

async function loadCredit() {
  const g = globalThis;
  if (!g.window) g.window = g;
  if (!g.PlatformI18n) g.PlatformI18n = englishPlatformI18n();
  if (!g.CreditOptions) {
    const sandbox = { module: { exports: {} }, window: {}, console };
    sandbox.globalThis = sandbox;
    sandbox.PlatformI18n = englishPlatformI18n();
    vm.createContext(sandbox);
    vm.runInContext(CREDIT_OPTIONS_SRC, sandbox);
    g.CreditOptions = sandbox.module.exports;
    g.window.CreditOptions = g.CreditOptions;
  }
  await importOnce(path.join(root, 'frontend/src/features/header/ai-credit.js'));
  const store = await importOnce(
    path.join(root, 'frontend/src/features/header/ai-budget-store.js'));
  return { AiCredit: g.window.AiCredit, aiBudgetStore: store.aiBudgetStore };
}

test('the drawer row renders a pushed figure, and does not defer the next fetch', async () => {
  const { AiCredit, aiBudgetStore } = await loadCredit();
  aiBudgetStore.set({ view: null, hidden: false });
  AiCredit.Budget._lastFetchAt = 0;

  AiCredit.Budget.applyPush(pushed({ spentCents: 1360, remainingCents: 3640 }));
  const view = aiBudgetStore.get().view;
  assert.equal(aiBudgetStore.get().hidden, false);
  const text = JSON.stringify(view);
  assert.match(text, /\$13\.60/);
  assert.match(text, /\$36\.40 left/, 'the row is where "$x left this week" is spelled out');
  assert.equal(AiCredit.Budget._lastFetchAt, 0,
    'a push is not a fetch: it must not start the poll throttle');

  // The next call moves it again — this is the ticking the request asked for.
  AiCredit.Budget.applyPush(pushed({ spentCents: 1520, remainingCents: 3480 }));
  assert.match(JSON.stringify(aiBudgetStore.get().view), /\$34\.80 left/);
});

test('the drawer row ignores a push with nothing to render', async () => {
  const { AiCredit, aiBudgetStore } = await loadCredit();
  AiCredit.Budget.applyPush(pushed({ spentCents: 1360, remainingCents: 3640 }));
  const before = JSON.stringify(aiBudgetStore.get());
  for (const bad of [null, undefined, {}, { limitCents: 'lots' }, 'nope']) {
    AiCredit.Budget.applyPush(bad);
  }
  assert.equal(JSON.stringify(aiBudgetStore.get()), before);
});

// ── The socket wiring ───────────────────────────────────────────────────

test('the global socket routes budget_updated to both meters', () => {
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const start = appJs.indexOf("case 'budget_updated':");
  assert.ok(start > -1, 'without this case the server pushes into nothing');
  const body = appJs.slice(start, appJs.indexOf('break;', start));
  assert.match(body, /DevChat\.applyBudgetUpdate\(data\.budget\)/);
  assert.match(body, /AiCredit\?\.Budget\?\.applyPush\?\.\(data\.budget\)/);
  // #6493: the shared allowance is adopted BEFORE the dev chat repaints, so
  // the meter draws the figure the push just moved.
  assert.ok(body.indexOf('AiCredit') > -1
    && body.indexOf('AiCredit') < body.indexOf('DevChat.applyBudgetUpdate'),
  'AiCredit.Budget.applyPush runs first');
  // It has to sit in the GLOBAL event switch — the per-user socket — not the
  // per-session one, or a user watching the board would never see it move.
  const globalSwitch = appJs.slice(0, start);
  assert.ok(globalSwitch.lastIndexOf("case 'notification_new':") > -1
    || globalSwitch.lastIndexOf("case 'app_allowance_changed':") > -1,
    'expected the case to live beside the other per-user events');
});
