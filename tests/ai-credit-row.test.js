// #555: wiring for the AI-credit row.
//
// THE UI OVERHAUL moved that row out of the hamburger drawer — where it was a
// status figure nobody acts on from a menu — and into Settings → Anthropic API
// key, which is already the page about what happens when your allowance runs
// out. Only the parent changed: same module, same #ai-budget-slot id.
//
// The renderer lives in its own module but depends on four things it
// doesn't own: the shell loading the script, the shell's slot id, the
// authed boot calling init(), and the screen that shows it refreshing on
// entry. Each is a silent failure if it drifts — the row just never
// appears — so all four are pinned here.
//
// A second renderer (AiCredit.AnthropicCredits → the org's remaining
// Anthropic credit, admins only) shipped in the same module and was
// removed again: Anthropic publishes no credit balance, so the figure had
// to be recorded by hand and the row read "Not set up" indefinitely. Its
// absence is asserted below so it can't drift back in unnoticed; the
// balance lives solely in the console's Spend limits section now.
//
// Static-assertion style (cf. tests/header-status-pane.test.js): read the
// shipped source files and assert the wiring is present.
//
// Run with: node --test tests/ai-credit-row.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { shellMarkup } = require('./lib/shell-markup');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const importOnce = require('./lib/import-once');

const root = path.join(__dirname, '..');
const html = shellMarkup();
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
// #1079 chunk B: same module, moved into the React bundle with the drawer
// rows it renders into.
const creditJs = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/ai-credit.js'), 'utf8');

test('the shell still carries the renderer, now via the React bundle', () => {
  assert.ok(!html.includes('src="/js/ai-credit.js"'),
    'the classic tag is retired — a surviving one would load a second copy');
  const menu = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/platform-header.tsx'), 'utf8');
  assert.match(menu, /import '\.\/ai-credit\.js'/,
    'the header bar island must import it, or nothing defines window.AiCredit');
});

test('the renderer publishes into the store the row reads', () => {
  // #1367: the module no longer resolves the slot by id — the row IS the
  // component (features/header/ai-budget.tsx), and that is what renders
  // `#drawer-row-ai-budget` / `#ai-budget-slot` now.
  assert.match(creditJs, /import \{ aiBudgetStore \} from '\.\/ai-budget-store\.js'/);
  assert.match(creditJs, /aiBudgetStore\.set\(/);
  const row = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/ai-budget.tsx'), 'utf8');
  assert.match(row, /id="drawer-row-ai-budget"/);
  assert.match(row, /id="ai-budget-slot"/);
  // …and the section that hosts it renders the component rather than an
  // empty slot for something else to fill. That is the Usage part since the
  // settings restructure lifted the allowance out of the Anthropic API key
  // part, onto the same page, just above it.
  const section = fs.readFileSync(
    path.join(root, 'frontend/src/features/settings/sections/usage.tsx'), 'utf8');
  assert.match(section, /<AiBudgetRow \/>/);
  assert.doesNotMatch(section, /id="ai-budget-slot"/, 'exactly one renderer');
});

test('the authed boot initialises the renderer', () => {
  assert.match(appJs, /AiCredit\?\.Budget\?\.init\)\s*AiCredit\.Budget\.init\(\)/,
    'AiCredit.Budget.init() runs at authed boot');
});

test('the settings screen refreshes the row when a section opens', () => {
  const settingsJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/settings/settings.js'), 'utf8');
  const fn = settingsJs.slice(settingsJs.indexOf('    _renderContent() {'));
  const body = fn.slice(0, fn.indexOf('\n    },'));
  assert.match(body, /AiCredit\.refreshAll\(\)/,
    '_renderContent refreshes the figure — it is throttled inside AiCredit');
  // The drawer used to poll for this row too, and the second half of this
  // test pinned that it had stopped. The drawer is retired outright now, so
  // Settings is the only surface that renders the row and the only one that
  // refreshes it.
});

test('the row renders inside the Usage part, ahead of the keys on its page', () => {
  const pane = html.indexOf('data-settings-section="usage"');
  const slot = html.indexOf('id="ai-budget-slot"');
  const next = html.indexOf('data-settings-section=', pane + 1);
  assert.ok(pane !== -1, 'the usage settings part is missing');
  assert.ok(slot > pane && slot < next, 'the slot lives inside that part');
  // Ships EMPTY: the me-scoped fetch that fills it is what confirms there is
  // an audience, so a signed-out visitor never sees a stub.
  const row = html.slice(html.indexOf('id="drawer-row-ai-budget"'));
  assert.match(row.slice(0, 400), /id="ai-budget-slot"[^>]*>\s*<\/span>/,
    'the slot ships empty');
});

test('the removed Anthropic-credits renderer leaves nothing behind', () => {
  assert.ok(!/AnthropicCredits/.test(creditJs),
    'no AnthropicCredits renderer in the module');
  assert.ok(!/AnthropicCredits/.test(appJs),
    'no AnthropicCredits init or visibility toggle in app.js');
  assert.ok(!/anthropic-credits-slot|drawer-row-anthropic-credits/.test(creditJs),
    'no credits row/slot ids left in the module');
  // Helpers that existed only for the org figure — dead weight if kept.
  for (const dead of ['moneyRound', 'agoText', 'timeText', 'dayText',
    'CREDITS_THROTTLE_MS']) {
    assert.ok(!new RegExp(dead).test(creditJs),
      `${dead} is gone with its only caller`);
  }
});

test('the budget row carries no global spend or cap', () => {
  // redact() in services/status.js treats global figures as admin-only;
  // this row is rendered for every signed-in user.
  assert.ok(!/globalSpend|globalRemaining|globalLimit/.test(creditJs),
    'no global spend/cap fields anywhere in the user-facing renderer');
});

test('the pill carries the class hook the dapp.json check asserts on', () => {
  // The sidebar reorg (#913) renamed the hook from ai-budget-pill to
  // ai-budget-meter and updated dapp.json's rendered check to match;
  // keep this pin aligned with the selector dapp.json asserts on. It moved
  // to the component with the markup.
  const row = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/ai-budget.tsx'), 'utf8');
  assert.match(row, /ai-budget-meter/, '#ai-budget-slot meter has a stable hook class');
});

// `?shot=menu` opened the drawer so the capture pipeline could see this row.
// The hamburger is retired and the drawer with it; the row is Settings' own
// (#drawer-row-ai-budget under #settings/api-key), which the checks reach by
// its real address. There is no capture-only door left to pin.

test('tooltips need no escaping, because nothing builds an attribute string', () => {
  // The tooltip interpolates server-provided values, and used to do it into
  // a hand-built `title=""`. React sets the attribute, so the escaping is
  // structural — and the two helpers that did it by hand are retired rather
  // than left as a second, unused escaper to reach for.
  assert.doesNotMatch(creditJs, /function escapeAttr/);
  assert.doesNotMatch(creditJs, /function escapeHtml/);
  assert.doesNotMatch(creditJs, /innerHTML/, 'the module writes no markup at all');
  const row = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/ai-budget.tsx'), 'utf8');
  assert.match(row, /title=\{view\.title\}/, 'the tooltip is a prop');
});

// ── #6493: adopt() is the one writer ────────────────────────────────────
//
// Every credit surface (this row, the composer's pill and ring, the dev chat's
// meter and Settings' spend card) reads `AiCredit.Budget.adopt/current()`.
// These drive the real module: a /api/budget answer must normalise the BYOK
// spelling and render the row, and an answer whose request started before a
// newer write must be dropped rather than jumping the figure backwards.

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

const budgetAnswer = (over = {}) => ({
  limitCents: 84000,
  spentCents: 8000,
  remainingCents: 76000,
  byokSpentCents: 0,
  hasByokKey: false,
  capWindow: 'weekly',
  windowLabel: 'This week',
  resetLabel: 'Monday 00:00 UTC',
  ...over,
});

test('adopt maps a /api/budget payload onto the shared state and renders the row', async () => {
  const { AiCredit, aiBudgetStore } = await loadCredit();
  AiCredit.Budget._ticket = 0;
  AiCredit.Budget._lastApplied = 0;
  aiBudgetStore.set({ view: null, hidden: false, figures: null });

  const ok = AiCredit.Budget.adopt(budgetAnswer({ byokSpentCents: 450, hasByokKey: true }));
  assert.equal(ok, true);
  assert.equal(AiCredit.Budget.current().limitCents, 84000);
  assert.equal(AiCredit.Budget.current().byokCents, 450,
    'the route\'s byokSpentCents is normalised to the snapshot\'s byokCents');
  const text = JSON.stringify(aiBudgetStore.get().view);
  assert.match(text, /\$760/, 'the row renders the shared figure');
  assert.match(text, /\$4\.50/, 'and the BYOK figure it normalised');
});

test('a stale fetch answer cannot undo a newer write', async () => {
  const { AiCredit, aiBudgetStore } = await loadCredit();
  AiCredit.Budget._ticket = 0;
  AiCredit.Budget._lastApplied = 0;

  const startedBefore = AiCredit.Budget._takeTicket();
  AiCredit.Budget.applyPush(budgetAnswer({ spentCents: 8000, remainingCents: 76000 }));
  const newer = AiCredit.Budget.current().spentCents;

  const adopted = AiCredit.Budget.adopt(
    budgetAnswer({ spentCents: 4000, remainingCents: 80000 }), { seq: startedBefore });
  assert.equal(adopted, false, 'the slower answer is dropped');
  assert.equal(AiCredit.Budget.current().spentCents, newer,
    'the figure on screen stays the newer one');
  assert.match(JSON.stringify(aiBudgetStore.get().view), /\$760/);
});

test('adopt rejects a snapshot without a numeric limit', async () => {
  const { AiCredit } = await loadCredit();
  AiCredit.Budget._ticket = 0;
  AiCredit.Budget._lastApplied = 0;
  for (const bad of [null, undefined, {}, { limitCents: 'lots' }, 'nope']) {
    assert.equal(AiCredit.Budget.adopt(bad), false);
  }
});
