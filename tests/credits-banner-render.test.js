// #463: the credits-exhausted banner + the meter's exhausted styling.
// Guards the show-condition contract:
//   - free allowance spent AND no BYOK key → banner + the $spent/$limit
//     pair styled red (the numbers stay; no replacement label)
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
const SESSIONS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
  'utf8'
);

function makeDevChat({ hasApiKey = false, fetchImpl } = {}) {
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
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
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

test('exhausted meter keeps the $spent/$limit pair, styled red', () => {
  const { DevChat, meterHtml } = makeDevChat();
  DevChat.budget = budget({ spentCents: 2500 });
  DevChat.renderBudget();
  assert.match(meterHtml(), /\$25\.00/, 'the spent figure stays visible');
  assert.match(meterHtml(), /\/\$25\.00/, 'the limit figure stays visible');
  assert.match(meterHtml(), /text-red-500/, 'exhausted pair is unmistakably red');
  assert.match(meterHtml(), /left \$0\.00/, 'exhausted state explicitly says none remains');
  assert.match(meterHtml(), /free daily AI credits are used up/, 'tooltip still explains the state');
  assert.doesNotMatch(meterHtml(), /free credits used up</, 'no replacement label — the numbers remain');
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
  assert.match(meterHtml(), /left.*\$24\.00/, 'normal meter exposes the allowance still available');
});

test('global cap spent (user under) → banner with the shared-budget copy', () => {
  const { DevChat, meterHtml } = makeDevChat();
  DevChat.budget = budget({ spentCents: 100, globalSpentCents: 20000 });
  assert.equal(DevChat._creditsExhausted(), true);
  const html = DevChat._renderCreditsBannerHtml();
  assert.match(html, /shared daily AI budget/, 'global-cap copy variant');
  assert.match(html, /dc-credits-add-key/, 'CTA still offered — BYOK bypasses the global cap');
  DevChat.renderBudget();
  assert.match(meterHtml(), /personal left.*\$24\.00/, 'personal headroom remains factual');
  assert.match(meterHtml(), /shared unavailable/, 'the separate blocking cap is explicit');
});

test('global cap spent with a key explains the payer switch without erasing personal headroom', () => {
  const { DevChat, meterHtml } = makeDevChat({ hasApiKey: true });
  DevChat.budget = budget({ spentCents: 100, globalSpentCents: 20000 });
  DevChat.renderBudget();
  assert.match(meterHtml(), /personal left.*\$24\.00/);
  assert.match(meterHtml(), /shared unavailable/);
  assert.match(meterHtml(), /key .* is used until the shared budget resets/);
});

test('a failed refresh clears a stale allowance', async () => {
  const { DevChat, meterHtml } = makeDevChat({
    fetchImpl: async () => ({ ok: false }),
  });
  DevChat.budget = budget({ spentCents: 100 });
  DevChat.renderBudget();
  assert.match(meterHtml(), /\$24\.00/);
  await DevChat.refreshBudget();
  assert.equal(DevChat.budget, null);
  assert.equal(meterHtml(), '');
});

test('the composer toolbar may wrap the longer remaining-allowance meter', () => {
  assert.match(SRC, /class="flex flex-wrap items-center gap-2 mb-2"/);
  assert.match(SRC, /id="dc-budget" class="ml-auto max-w-full text-right/);
});

test('/api/budget reads factual display snapshots instead of collapsing cap errors', () => {
  const start = SESSIONS_SRC.indexOf("router.get('/api/budget'");
  const route = SESSIONS_SRC.slice(start, start + 2200);
  assert.ok(start >= 0, 'budget route exists');
  assert.match(route, /getBudgetSnapshot\(pool, req\.user\.id\)/,
    'personal spend comes from the full display snapshot');
  assert.match(route, /SUM\(total_cost_cents\) AS total/,
    'shared spend is read independently');
  assert.doesNotMatch(route, /budget\.error\s*\?\s*userLimit/,
    'a shared-cap error can no longer fabricate full personal spend');
});

test('no budget fetched yet → stays quiet', () => {
  const { DevChat } = makeDevChat();
  DevChat.budget = null;
  assert.equal(DevChat._creditsExhausted(), false);
  assert.equal(DevChat._renderCreditsBannerHtml(), '');
});
