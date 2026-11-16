// #2598: the client half of the live weekly meter.
//
// The server pushes `budget_updated` every time a model call's cost lands
// against the spender's weekly pool (tests/budget-live-push.test.js pins that
// half). Here: the header drawer's AI-credit row, which renders "$x left this
// week", repaints from the pushed figures without a refetch, ignores a push
// with nothing to render, and the global socket hands it the event.
//
// Run with: node --test tests/budget-live-client.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');
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

test('the global socket routes budget_updated to the AI-credit row', () => {
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const start = appJs.indexOf("case 'budget_updated':");
  assert.ok(start > -1, 'without this case the server pushes into nothing');
  const body = appJs.slice(start, appJs.indexOf('break;', start));
  assert.match(body, /AiCredit\?\.Budget\?\.applyPush\?\.\(data\.budget\)/);
  // It has to sit in the GLOBAL event switch — the per-user socket — not the
  // per-session one, or a user watching the board would never see it move.
  const globalSwitch = appJs.slice(0, start);
  assert.ok(globalSwitch.lastIndexOf("case 'notification_new':") > -1
    || globalSwitch.lastIndexOf("case 'app_allowance_changed':") > -1,
    'expected the case to live beside the other per-user events');
});
