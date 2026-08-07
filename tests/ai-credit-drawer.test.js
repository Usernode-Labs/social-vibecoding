// #555: wiring for the drawer's AI-credit row.
//
// The renderer lives in its own module but depends on four things it
// doesn't own: the shell loading the script, the shell's slot id, the
// authed boot calling init(), and HeaderMenu.open() refreshing on the
// only surface where it's visible. Each is a silent failure if it
// drifts — the row just never appears — so all four are pinned here.
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
const creditJs = fs.readFileSync(path.join(root, 'public/js/ai-credit.js'), 'utf8');

test('the shell loads /js/ai-credit.js', () => {
  assert.match(html, /<script src="\/js\/ai-credit\.js"><\/script>/,
    'ai-credit.js is script-tagged in the shell');
});

test('the renderer resolves its slot by the shell-owned id', () => {
  assert.match(creditJs, /getElementById\('ai-budget-slot'\)/);
});

test('the authed boot initialises the renderer', () => {
  assert.match(appJs, /AiCredit\?\.Budget\?\.init\)\s*AiCredit\.Budget\.init\(\)/,
    'AiCredit.Budget.init() runs at authed boot');
});

test('opening the drawer refreshes the row, before the touch early-return', () => {
  const open = appJs.slice(appJs.indexOf('    open() {'));
  const body = open.slice(0, open.indexOf('PlatformUI.isTouch()'));
  assert.match(body, /AiCredit\.refreshAll\(\)/,
    'HeaderMenu.open() refreshes the row above the touch branch, which returns early');
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
  // keep this pin aligned with the selector dapp.json asserts on.
  assert.match(creditJs, /ai-budget-meter/, '#ai-budget-slot meter has a stable hook class');
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

test('tooltips are attribute-escaped', () => {
  // The tooltip interpolates server-provided values into a title="".
  assert.match(creditJs, /function escapeAttr/, 'escapeAttr helper is present');
  const titles = creditJs.match(/title="'\s*\+\s*escapeAttr/g) || [];
  assert.ok(titles.length >= 1,
    `every title="" goes through escapeAttr (found ${titles.length})`);
});
