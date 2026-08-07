// Out-of-credits routes — the three ways to keep building when the daily
// AI allowance is spent.
//
// The point of public/js/credit-options.js is that ONE module owns the copy
// and the destinations, so the dev-chat card, the red credits banner and the
// Generate-proposal modal cannot drift. These tests pin the three properties
// that make that true:
//
//   1. the destinations are exactly the three Settings sections, and each
//      one is a REAL declared section (a renamed section must fail here, not
//      silently ship a dead link);
//   2. the copy adapts to the two states the server can actually produce —
//      a user who already has a key on file (a decrypt failure still 429s),
//      and the platform's shared budget running out instead of theirs; and
//   3. the platform's own error text is escaped, never injected.
//
// Run with: node --test tests/credit-options.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CreditOptions = require('../public/js/credit-options.js');

const SETTINGS_SRC = fs.readFileSync(
  path.join(__dirname, '../public/js/settings.js'), 'utf8'
);
const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '../public/js/dev-chat.js'), 'utf8'
);
const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '../public/js/app-view.js'), 'utf8'
);
const INDEX_SRC = fs.readFileSync(
  path.join(__dirname, '../public/index.html'), 'utf8'
);

test('offers exactly three routes, in the documented order', () => {
  const options = CreditOptions.options({});
  assert.equal(options.length, 3);
  assert.deepEqual(options.map((o) => o.id), ['api-key', 'local-tool', 'connector']);
  assert.deepEqual(
    options.map((o) => o.hash),
    ['#settings/api-key', '#settings/cli', '#settings/connectors']
  );
  // Every entry must be renderable: a blank title or CTA would ship an
  // unlabelled button.
  for (const option of options) {
    assert.ok(option.title.length > 0, `${option.id} has a title`);
    assert.ok(option.blurb.length > 0, `${option.id} has a blurb`);
    assert.ok(option.cta.length > 0, `${option.id} has a CTA`);
  }
});

test('every destination is a section Settings actually declares', () => {
  // The guard this file exists for: renaming a Settings section without
  // updating the card would produce buttons that navigate nowhere.
  for (const option of CreditOptions.options({})) {
    const key = option.hash.replace('#settings/', '');
    assert.match(
      SETTINGS_SRC,
      new RegExp(`key: '${key}'`),
      `Settings.SECTIONS declares '${key}'`
    );
    assert.match(
      INDEX_SRC,
      new RegExp(`data-settings-section="${key}"`),
      `index.html has a [data-settings-section="${key}"] wrapper`
    );
  }
});

test('a user who already has a key is told to check it, not to add one', () => {
  // Reachable state: limits.loadUserApiKey treats a decrypt failure as "no
  // key on file", so a saved-but-unusable key still produces the 429.
  const [first] = CreditOptions.options({ hasApiKey: true });
  assert.match(first.title, /could not be used|couldn't be used/i);
  assert.match(first.cta, /check/i);
  assert.doesNotMatch(first.cta, /^Add /);

  const [fresh] = CreditOptions.options({ hasApiKey: false });
  assert.match(fresh.cta, /^Add /);
  // The destination is the same either way — only the wording changes.
  assert.equal(first.hash, fresh.hash);
});

test('the lead distinguishes your allowance from the shared platform budget', () => {
  assert.match(CreditOptions.lead({}), /you're out of today's free ai credits/i);
  assert.match(CreditOptions.lead({ globalOut: true }), /shared daily ai budget/i);
  // Both states still offer all three routes: every one of them bypasses
  // the platform budget.
  assert.equal(CreditOptions.options({ globalOut: true }).length, 3);
});

test('the platform error text is escaped, never injected', () => {
  const html = CreditOptions.cardHtml({ error: '<img src=x onerror="alert(1)">' });
  assert.ok(!html.includes('<img'), 'no raw tag survives into the markup');
  assert.ok(html.includes('&lt;img'), 'it is rendered as escaped text');
  assert.ok(!html.includes('onerror="'), 'no attribute injection');
});

test('card and banner render one actionable control per route', () => {
  const card = CreditOptions.cardHtml({});
  const banner = CreditOptions.bannerActionsHtml({});
  for (const option of CreditOptions.options({})) {
    assert.ok(
      card.includes(`data-credits-hash="${option.hash}"`),
      `card links ${option.hash}`
    );
    assert.ok(
      banner.includes(`data-credits-hash="${option.hash}"`),
      `banner links ${option.hash}`
    );
  }
  // The card is identifiable so dev-chat can wire it after each render.
  assert.match(card, /data-credits-card="1"/);
  // The banner keeps the historical id on its first button so any existing
  // selector against it still resolves.
  assert.match(banner, /id="dc-credits-add-key"/);
});

test('wire() navigates by hash and is idempotent per node', () => {
  // Minimal DOM stand-in: enough to prove one handler is attached and that
  // it sets location.hash rather than pushing history itself.
  const handlers = [];
  const node = {
    addEventListener(type, fn) { handlers.push({ type, fn }); },
    contains() { return true; },
  };
  CreditOptions.wire(node);
  CreditOptions.wire(node);
  assert.equal(handlers.length, 1, 'a second wire() call does not stack handlers');

  const originalWindow = global.window;
  global.window = { location: { hash: '' } };
  try {
    handlers[0].fn({
      target: { closest: () => ({ getAttribute: () => '#settings/connectors' }) },
      preventDefault() {},
    });
    assert.equal(global.window.location.hash, '#settings/connectors');
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }
});

test('all three surfaces render from the shared module', () => {
  // The reason the module exists: none of the three call sites may inline
  // its own copy of the routes.
  assert.match(DEV_CHAT_SRC, /CreditOptions\.cardHtml\(msg\.creditsCard\)/,
    'the dev-chat message card renders the shared card');
  assert.match(DEV_CHAT_SRC, /CreditOptions\.bannerActionsHtml\(/,
    'the credits banner renders the shared button row');
  assert.match(APP_VIEW_SRC, /CreditOptions\.cardHtml\(state\)/,
    'the Generate-proposal modal renders the shared card');

  // And the module has to be loaded before its consumers.
  const creditIdx = INDEX_SRC.indexOf('/js/credit-options.js');
  const devChatIdx = INDEX_SRC.indexOf('/js/dev-chat.js');
  const appViewIdx = INDEX_SRC.indexOf('/js/app-view.js');
  assert.ok(creditIdx > 0, 'credit-options.js is loaded by the shell');
  assert.ok(creditIdx < devChatIdx, 'loaded before dev-chat.js');
  assert.ok(creditIdx < appViewIdx, 'loaded before app-view.js');
});

test('the dev chat renders the refusal as a card, not as prose', () => {
  // The old behaviour pushed a markdown paragraph that named only the BYOK
  // route. Guard against a regression back to that.
  assert.match(
    DEV_CHAT_SRC,
    /data\.code === 'budget_exceeded'[\s\S]{0,900}creditsCard:/,
    'the budget_exceeded branch pushes a creditsCard row'
  );
  assert.doesNotMatch(
    DEV_CHAT_SRC,
    /Open Settings from the menu \(or use the banner above\) to add your key/,
    'the BYOK-only prose reply is gone'
  );
});

test('the Generate-proposal path shows the card instead of a bare toast', () => {
  assert.match(
    APP_VIEW_SRC,
    /data\.code === 'budget_exceeded'[\s\S]{0,200}_showCreditOptionsModal/,
    'a budget refusal opens the three-route modal'
  );
});
