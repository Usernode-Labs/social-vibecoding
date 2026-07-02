// #463: the credits-exhausted banner + the meter's explicit exhausted
// state. Guards the show-condition contract:
//   - free allowance spent AND no BYOK key → banner + "free credits used
//     up" meter label
//   - key saved → neither (spillover billing continues silently)
//   - headroom left → neither
//   - global cap spent (user under) → banner with the shared-budget copy
//
// dev-chat.js is a plain browser script (`const DevChat = {…}`). We load
// its source into a vm context with the browser globals it touches
// stubbed (same harness as dev-chat-changes-ready-card.test.js), point
// #dc-budget at a capturing element, and assert on the produced HTML.
//
// Run with: node --test tests/credits-banner-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

function makeDevChat({ hasApiKey = false } = {}) {
  let budgetHtml = '';
  const budgetEl = {
    set innerHTML(v) { budgetHtml = v; },
    get innerHTML() { return budgetHtml; },
  };
  const noopEl = {
    style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
    appendChild: () => {}, innerHTML: '', textContent: '',
  };
  const sandbox = {
    console,
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    document: {
      getElementById: (id) => (id === 'dc-budget' ? budgetEl : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: { sendBeacon: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.Settings = { state: { hasApiKey, keyLast4: hasApiKey ? '1234' : null } };
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  return {
    DevChat: sandbox.__DevChat,
    meterHtml: () => budgetHtml,
  };
}

// /api/budget shape (src/routes/sessions.js GET /api/budget).
const budget = (over) => ({
  spentCents: 0, limitCents: 2500,
  globalSpentCents: 0, globalLimitCents: 20000,
  byokSpentCents: 0, aiEnabled: true,
  ...over,
});

test('allowance spent + no key → banner renders with the Add API key CTA', () => {
  const { DevChat } = makeDevChat();
  DevChat.budget = budget({ spentCents: 2500 });
  assert.equal(DevChat._creditsExhausted(), true);
  const html = DevChat._renderCreditsBannerHtml();
  assert.match(html, /dc-credits-banner/, 'banner element present');
  assert.match(html, /free AI credits/, 'names the actual problem');
  assert.match(html, /dc-credits-add-key/, 'Add API key button present');
  assert.match(html, /Add API key/, 'CTA label present');
});

test('meter shows the explicit exhausted label instead of $spent/$limit', () => {
  const { DevChat, meterHtml } = makeDevChat();
  DevChat.budget = budget({ spentCents: 2500 });
  DevChat.renderBudget();
  assert.match(meterHtml(), /free credits used up/, 'unmistakable exhausted label');
  assert.doesNotMatch(meterHtml(), /\$25\.00\/\$25\.00/, 'no ambiguous number pair');
});

test('key saved → no banner, meter keeps the BYOK rendering', () => {
  const { DevChat, meterHtml } = makeDevChat({ hasApiKey: true });
  DevChat.budget = budget({ spentCents: 2500 });
  assert.equal(DevChat._creditsExhausted(), false);
  assert.equal(DevChat._renderCreditsBannerHtml(), '');
  DevChat.renderBudget();
  assert.doesNotMatch(meterHtml(), /free credits used up/);
  assert.match(meterHtml(), /limit /, 'key-holder meter unchanged');
});

test('headroom left → no banner, normal $spent/$limit meter', () => {
  const { DevChat, meterHtml } = makeDevChat();
  DevChat.budget = budget({ spentCents: 100 });
  assert.equal(DevChat._creditsExhausted(), false);
  assert.equal(DevChat._renderCreditsBannerHtml(), '');
  DevChat.renderBudget();
  assert.match(meterHtml(), /\$1\.00/, 'normal meter rendering');
});

test('global cap spent (user under) → banner with the shared-budget copy', () => {
  const { DevChat } = makeDevChat();
  DevChat.budget = budget({ spentCents: 100, globalSpentCents: 20000 });
  assert.equal(DevChat._creditsExhausted(), true);
  const html = DevChat._renderCreditsBannerHtml();
  assert.match(html, /shared daily AI budget/, 'global-cap copy variant');
  assert.match(html, /dc-credits-add-key/, 'CTA still offered — BYOK bypasses the global cap');
});

test('no budget fetched yet → stays quiet', () => {
  const { DevChat } = makeDevChat();
  DevChat.budget = null;
  assert.equal(DevChat._creditsExhausted(), false);
  assert.equal(DevChat._renderCreditsBannerHtml(), '');
});
