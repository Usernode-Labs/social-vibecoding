// #555: wiring for the drawer's two AI-credit rows.
//
// The renderers live in their own module but depend on four things they
// don't own: the shell loading the script, the shell's slot ids, the
// authed boot calling init(), and HeaderMenu.open() refreshing on the
// only surface where they're visible. Each is a silent failure if it
// drifts — the row just never appears — so all four are pinned here.
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

test('both renderers resolve their slot by the shell-owned id', () => {
  assert.match(creditJs, /getElementById\('ai-budget-slot'\)/);
  assert.match(creditJs, /getElementById\('anthropic-credits-slot'\)/);
});

test('the authed boot initialises both renderers', () => {
  assert.match(appJs, /AiCredit\?\.Budget\?\.init\)\s*AiCredit\.Budget\.init\(\)/,
    'AiCredit.Budget.init() runs at authed boot');
  assert.match(appJs, /AiCredit\?\.AnthropicCredits\?\.init\)\s*AiCredit\.AnthropicCredits\.init\(\)/,
    'AiCredit.AnthropicCredits.init() runs at authed boot');
});

test('opening the drawer refreshes both rows, before the touch early-return', () => {
  const open = appJs.slice(appJs.indexOf('    open() {'));
  const body = open.slice(0, open.indexOf('PlatformUI.isTouch()'));
  assert.match(body, /AiCredit\.refreshAll\(\)/,
    'HeaderMenu.open() refreshes the rows above the touch branch, which returns early');
});

test('the admin row is gated on isAdmin inside the renderer as well', () => {
  // Belt and braces with renderAdminButton: the fetch itself must not
  // fire for a non-admin (it would 403), and reading App.user.isAdmin
  // means the "View as non-admin" preview masks the row for free.
  const credits = creditJs.slice(creditJs.indexOf('AnthropicCredits: {'));
  assert.match(credits, /App\.user\.isAdmin/,
    'the credits renderer checks App.user.isAdmin');
  assert.ok(!/canAdminWrite/.test(creditJs),
    'never gated on canAdminWrite — view-only admins are part of the audience');
});

test('the budget row carries no global spend or cap', () => {
  // redact() in services/status.js treats global figures as admin-only;
  // this row is rendered for every signed-in user.
  assert.ok(!/globalSpend|globalRemaining|globalLimit/.test(creditJs),
    'no global spend/cap fields anywhere in the user-facing renderer');
});

test('the pills carry the class hooks the dapp.json checks assert on', () => {
  assert.match(creditJs, /ai-budget-pill/, '#ai-budget-slot pill has a stable hook class');
  assert.match(creditJs, /anthropic-credits-pill/, 'credits pill has a stable hook class');
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
  // Both tooltips interpolate server-provided values into a title="".
  assert.match(creditJs, /function escapeAttr/, 'escapeAttr helper is present');
  const titles = creditJs.match(/title="'\s*\+\s*escapeAttr/g) || [];
  assert.ok(titles.length >= 3,
    `every title="" goes through escapeAttr (found ${titles.length})`);
});
