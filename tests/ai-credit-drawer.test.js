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
// Run with: node --test tests/ai-credit-drawer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
// #1079 chunk B: same module, moved into the React bundle with the drawer
// rows it renders into.
const creditJs = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/ai-credit.js'), 'utf8');

test('the shell still carries the renderer, now via the React bundle', () => {
  assert.ok(!html.includes('src="/js/ai-credit.js"'),
    'the classic tag is retired — a surviving one would load a second copy');
  const menu = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/header-menu.tsx'), 'utf8');
  assert.match(menu, /import '\.\/ai-credit\.js'/,
    'the header-menu island must import it, or nothing defines window.AiCredit');
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
  // empty slot for something else to fill.
  const section = fs.readFileSync(
    path.join(root, 'frontend/src/features/settings/sections/api-key.tsx'), 'utf8');
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
  // …and the drawer must NOT still poll for a row it no longer shows.
  const headerMenuJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/header-menu-controller.js'), 'utf8');
  const open = headerMenuJs.slice(headerMenuJs.indexOf('  open() {'));
  assert.ok(!/AiCredit\.refreshAll\(\)/.test(open.slice(0, open.indexOf('\n  },'))),
    'a drawer that does not render the row must not refresh it');
});

test('the row renders inside the Anthropic API key section', () => {
  const pane = html.indexOf('data-settings-section="api-key"');
  const slot = html.indexOf('id="ai-budget-slot"');
  assert.ok(pane !== -1, 'the api-key settings pane is missing');
  assert.ok(slot > pane, 'the slot lives inside that pane');
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

test('?shot=menu opens the drawer and is not env-gated', () => {
  const fn = appJs.slice(appJs.indexOf('  _applyMenuShot() {'));
  const body = fn.slice(0, 800);
  assert.ok(body.length > 0, '_applyMenuShot is defined');
  assert.match(body, /shot !== 'menu'/, 'keys off ?shot=menu');
  assert.match(body, /App\.HeaderMenu\.open\(\)/, 'opens the drawer');
  assert.ok(!/staging|USERNODE_ENV/i.test(body),
    'pure UI state — never env-gated, or the production "before" shot starves');
  assert.match(appJs, /App\._applyMenuShot\(\);/, 'called from the authed boot');
});

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
