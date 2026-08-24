// #593: the daily AI allowance, stated clearly instead of cryptically.
//
// Three things shipped and each one is a silent regression if it drifts:
//   1. the figures a builder needs — what is LEFT and when it comes back —
//      are RENDERED, not tooltip-only (they were invisible on touch and
//      absent from every review screenshot),
//   2. a proactive low-balance warning fires at the server-declared
//      threshold and is mutually exclusive with the red exhausted banner,
//   3. the exhausted path names the reset boundary and keeps the BYOK
//      route on offer rather than dead-ending.
//
// The normalisation and the copy live in public/js/credit-options.js (one
// definition, three surfaces), so most of this exercises that module
// directly; the composer states are driven through the same vm harness
// tests/credits-banner-render.test.js uses.
//
// Run with: node --test tests/ai-credits-clarity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderComponent } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const CO = require('../public/js/credit-options.js');
const LIMITS_SRC = fs.readFileSync(path.join(root, 'src/services/limits.js'), 'utf8');
const SESSIONS_SRC = fs.readFileSync(path.join(root, 'src/routes/sessions.js'), 'utf8');
const DEV_CHAT_SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/dev-chat/dev-chat.js'), 'utf8');
const AI_CREDIT_SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/ai-credit.js'), 'utf8');
const DAPP = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// ── The shared state model ──────────────────────────────────────────────

const budget = (over) => ({
  spentCents: 0, limitCents: 2500,
  globalSpentCents: 0, globalLimitCents: 20000,
  byokSpentCents: 0, aiEnabled: true,
  lowBalancePct: 80,
  ...over,
});

test('creditState makes zero-credit states explicit instead of unknown or NaN', () => {
  assert.equal(CO.creditState(null).level, 'unknown', 'nothing fetched → say nothing');
  assert.equal(CO.creditState(budget({ limitCents: 0 })).level, 'exhausted',
    'an intentional zero admin cap is a real exhausted state');
  const locked = CO.creditState(budget({
    limitCents: 0, verificationRequired: true, entitlementAvailable: true,
  }));
  assert.equal(locked.level, 'locked');
  assert.equal(locked.pctUsed, 0, 'zero never divides into NaN');
  assert.equal(CO.creditState(budget({
    limitCents: 0, entitlementAvailable: false,
  })).level, 'unavailable');
  assert.equal(CO.creditState(budget({ spentCents: 100 })).level, 'ok');
  assert.equal(CO.creditState(budget({ spentCents: 2000 })).level, 'low',
    'exactly at the threshold counts as low — 80% of 2500');
  assert.equal(CO.creditState(budget({ spentCents: 2500 })).level, 'exhausted');
  assert.equal(CO.creditState(budget({ globalSpentCents: 20000 })).level, 'exhausted',
    'the shared cap exhausts the allowance just as the personal one does');

  // The drawer payload (GET /api/me/ai-budget) names BYOK spend
  // differently and carries no global figures at all — same state out.
  const drawer = CO.creditState({
    limitCents: 2000, spentCents: 1360, remainingCents: 640,
    byokCents: 450, hasByokKey: true, lowBalancePct: 80,
  });
  assert.equal(drawer.level, 'ok');
  assert.equal(drawer.byokCents, 450, 'byokCents and byokSpentCents both read');
  assert.equal(drawer.remainingCents, 640);
  assert.equal(drawer.globalOut, false, 'absent global figures are not "out"');
});

test('the threshold comes from the server, not from the client', () => {
  // limits.LOW_BALANCE_PCT is the definition; LOW_PCT in the browser module
  // is only the fallback for a payload that predates the field.
  assert.match(LIMITS_SRC, /const LOW_BALANCE_PCT = 80;/);
  assert.match(LIMITS_SRC, /LOW_BALANCE_PCT,/, 'exported');
  assert.equal(CO.creditState(budget({ spentCents: 1500, lowBalancePct: 50 })).level, 'low',
    'a server-sent threshold moves the warning');
  assert.equal(CO.creditState(budget({ spentCents: 1500, lowBalancePct: 90 })).level, 'ok');
  assert.equal(CO.creditState(budget({ spentCents: 2000, lowBalancePct: undefined })).level,
    'low', 'and an old payload still warns, at the fallback');
});

test('a BYOK key never turns into a level of its own', () => {
  // level describes the ALLOWANCE; whether the user is actually blocked is
  // the surface's call, because a key bypasses the cap entirely (#119).
  const s = CO.creditState(budget({ spentCents: 2500, hasByokKey: true }));
  assert.equal(s.level, 'exhausted');
  assert.equal(s.hasByokKey, true);
});

test('the reset sentence names the UTC boundary and translates it', () => {
  const at = new Date('2026-08-13T00:00:00.000Z');
  const now = at.getTime() - (3 * 60 + 20) * 60 * 1000;
  const sentence = CO.resetSentence({ resetsAt: at.toISOString() }, now);
  assert.match(sentence, /reset at midnight UTC/,
    'the boundary the server enforces, stated as the server states it');
  assert.match(sentence, /about 3h 20m from now/, 'and how long that is');
  assert.equal(CO.resetIn(at.toISOString(), at.getTime() - 45 * 60 * 1000), '45m');
  assert.equal(CO.resetIn(at.toISOString(), at.getTime() + 1000), null,
    'a past boundary drops the clause rather than printing a negative');
  assert.match(CO.resetSentence({}), /reset at midnight UTC\./,
    'no resetsAt → still says when, just not how long');
  assert.match(CO.resetSentence({ level: 'locked' }), /Connect GitHub or X.*\$10\.00\/day/,
    'locked credits name the unlock action, not a reset that will not help');
});

test('locked credits render an unlock meter and lead with the identity action', () => {
  const state = CO.creditState(budget({
    limitCents: 0, verificationRequired: true, entitlementAvailable: true,
  }));
  assert.deepEqual(CO.meterParts(state), [
    { key: 'locked', text: 'verify account · unlock $10/day' },
  ]);
  assert.equal(CO.meterTone(state), 'amber');
  assert.match(CO.lead(state), /Connect GitHub or X.*\$10\/day/);
  const options = CO.options({ verificationRequired: true });
  assert.equal(options[0].id, 'social-identity');
  assert.equal(options[0].hash, '#settings/connectors');
});

test('the meter states what is left, in words a builder can act on', () => {
  const left = (over) => {
    const parts = CO.meterParts(CO.creditState(budget(over)));
    return (parts.find((p) => p.key === 'remaining') || {}).text;
  };
  assert.equal(left({ spentCents: 1000 }), '$15.00 left');
  assert.equal(left({ spentCents: 2000 }), '$5.00 left', 'low still names the figure');
  assert.equal(left({ spentCents: 2500 }), 'none left');
  assert.equal(left({ globalSpentCents: 20000 }), 'shared budget spent',
    'the shared cap is not the user’s own spend and does not read like it');
  assert.equal(CO.meterParts(CO.creditState(null)).length, 1,
    'unknown renders the pair only — no invented remainder');

  // The pair keeps its halves so both surfaces can colour the spend figure
  // and leave the cap grey, without re-deriving the formatting.
  const pair = CO.meterParts(CO.creditState(budget({ spentCents: 1000 })))[0];
  assert.equal(pair.spent, '$10.00');
  assert.equal(pair.limit, '$25.00');
  assert.equal(pair.text, '$10.00/$25.00');
});

test('the tone thresholds are derived from the level, not retyped', () => {
  assert.equal(CO.meterTone(CO.creditState(budget({ spentCents: 100 }))), 'emerald');
  assert.equal(CO.meterTone(CO.creditState(budget({ spentCents: 2000 }))), 'amber');
  assert.equal(CO.meterTone(CO.creditState(budget({ spentCents: 2500 }))), 'red');
});

// ── The server side ─────────────────────────────────────────────────────

test('both budget reads carry the remainder, the reset and the threshold', () => {
  const handler = SESSIONS_SRC.slice(
    SESSIONS_SRC.indexOf("router.get('/api/budget'"),
    SESSIONS_SRC.indexOf("router.post('/api/sessions/:id/deploy-staging'"));
  for (const field of ['remainingCents', 'resetsAt', 'lowBalancePct']) {
    assert.match(handler, new RegExp(field), `GET /api/budget sends ${field}`);
  }
  assert.match(handler, /getBudgetSnapshot\(pool, req\.user\.id\)/,
    'the real branch gets reset/remainder/tier fields from the shared snapshot');
  // …and the snapshot the drawer reads gets them from the same helper.
  const snapshot = LIMITS_SRC.slice(
    LIMITS_SRC.indexOf('async function getBudgetSnapshot'),
    LIMITS_SRC.indexOf('// Shared BYOK key lookup'));
  assert.match(snapshot, /resetsAt: dailyResetAt\(\)/);
  assert.match(snapshot, /lowBalancePct: LOW_BALANCE_PCT/);
});

test('the shared-cap refusal says when it lifts (it used to say "tomorrow")', () => {
  const check = LIMITS_SRC.slice(
    LIMITS_SRC.indexOf('async function checkBudget'),
    LIMITS_SRC.indexOf('// #555: read-only view'));
  assert.match(check, /Global daily limit reached[^\n]*Resets at midnight UTC\./,
    'the global message names the boundary, like the per-user one above it');
  assert.ok(!/Try again tomorrow/.test(LIMITS_SRC),
    '"tomorrow" is not a boundary — and for most readers it was the wrong day');
});

// ── The composer ────────────────────────────────────────────────────────

// Same harness as tests/credits-banner-render.test.js: dev-chat.js is a
// plain script, so it is evaluated in a vm context with the globals it
// touches stubbed and #dc-budget captured.
function makeDevChat({ hasApiKey = false, search = '' } = {}) {
  // #1191: the meter's markup is features/dev-chat/budget-pill.tsx's, so
  // `renderBudget()` publishes fragments. `meterHtml()` renders the component
  // from what was published, so the assertions still read the meter as a
  // reader sees it.
  let published = { title: null, parts: [] };
  const budgetEl = { innerHTML: '' };
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
      createElement: () => ({ style: {}, innerHTML: '', textContent: '' }),
      body: { appendChild: () => {} },
    },
    location: { search, hash: '' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    navigator: { sendBeacon: () => {} },
    URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.Settings = { state: { hasApiKey, keyLast4: hasApiKey ? '1234' : null } };
  sandbox.UsernodeReact = {
    devChat: {
      mountBudgetPill: () => {},
      publishBudgetPill: (state) => { published = state; },
      mountAttachStrip: () => {},
      publishAttachStrip: () => {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/build-venues.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/credit-options.js'), 'utf8'), sandbox);
  vm.runInContext(`${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  return {
    DevChat: sandbox.__DevChat,
    meterHtml: () => renderComponent(
      'frontend/src/features/dev-chat/budget-pill.tsx', 'BudgetPillView',
      JSON.parse(JSON.stringify(published)),
    ),
  };
}

test('the composer meter is the pair and the reset, and nothing else', () => {
  // #593 rendered the remainder here rather than hiding it in a tooltip.
  // #1353 took it back out of THIS meter alone: $25.00 minus $10.00 is the
  // same fact as "$15.00 left", stated two characters away, on the
  // narrowest strip in the app — and the remainder was the half that
  // wrapped. The drawer row below still spells it out, and the low-balance
  // and exhausted banners still say it in words once it starts to matter.
  const { DevChat, meterHtml } = makeDevChat();
  DevChat.budget = budget({ spentCents: 1000 });
  DevChat.renderBudget();
  assert.match(meterHtml(), /\$10\.00/, 'the spend/cap pair is what the meter is');
  assert.match(meterHtml(), /\$25\.00/);
  assert.doesNotMatch(meterHtml(), /data-credits-remaining/);
  assert.doesNotMatch(meterHtml(), /left/, 'no second statement of the same figure');
  assert.match(meterHtml(), /title="[^"]*reset at midnight UTC/,
    'and the tooltip still answers "when do they come back?"');
});

test('nearly out → the amber warning, with the same routes as the red one', () => {
  const { DevChat } = makeDevChat();
  DevChat.budget = budget({ spentCents: 2000 });
  assert.equal(DevChat._creditsExhausted(), false, 'nothing is refused yet');
  assert.equal(DevChat._creditsLow(), true);
  const html = DevChat._renderCreditsLowBannerHtml();
  assert.match(html, /id="dc-credits-low-banner"/);
  assert.match(html, /Running low on free AI credits/, 'states the situation, not a failure');
  assert.match(html, /\$5\.00 of \$25\.00 left today/, 'with the actual headroom');
  assert.match(html, /reset at midnight UTC/, 'and the boundary');
  assert.match(html, /dc-credits-add-key/, 'the BYOK route is offered before it bites');
  assert.match(html, /#settings\/cli/, 'as are the other ways to keep building');
  assert.match(html, /bg-amber-50/, 'amber — a warning, not an error');
});

test('the two banners are mutually exclusive', () => {
  const { DevChat } = makeDevChat();
  DevChat.budget = budget({ spentCents: 2500 });
  assert.equal(DevChat._creditsExhausted(), true);
  assert.equal(DevChat._creditsLow(), false, 'past the cap, "running low" is the wrong tense');
  assert.equal(DevChat._renderCreditsLowBannerHtml(), '');
});

test('the warning stays out of the way of everyone it cannot help', () => {
  const withKey = makeDevChat({ hasApiKey: true });
  withKey.DevChat.budget = budget({ spentCents: 2000 });
  assert.equal(withKey.DevChat._creditsLow(), false,
    'a key-holder spills over to their own key — the cap is not a cliff for them');

  const quiet = makeDevChat();
  quiet.DevChat.budget = null;
  assert.equal(quiet.DevChat._creditsLow(), false, 'nothing fetched → no guessing');

  const openrouter = makeDevChat();
  openrouter.DevChat.currentSession = { id: 7, agent_backend: 'codex_openrouter' };
  openrouter.DevChat.budget = budget({ spentCents: 2000 });
  assert.equal(openrouter.DevChat._creditsLow(), false,
    'an OpenRouter turn never touches the Claude allowance');
});

test('the exhausted banner names the reset in rendered text', () => {
  const { DevChat } = makeDevChat();
  DevChat.budget = budget({ spentCents: 2500, resetsAt: '2026-08-13T00:00:00.000Z' });
  const html = DevChat._renderCreditsBannerHtml();
  assert.match(html, /data-credits-reset/);
  assert.match(html, /reset at midnight UTC/);
  assert.match(html, /dc-credits-add-key/, 'still links the bring-your-own-key route');
});

test('?shot=credits-low paints the warning without a fetch or a write', () => {
  const { DevChat, meterHtml } = makeDevChat({ search: '?shot=credits-low' });
  const fixture = DevChat._shotCreditsLowBudget();
  assert.ok(fixture, 'the latch answers on the deep link');
  assert.equal(fixture.spentCents / fixture.limitCents, 0.8, 'exactly at the threshold');
  DevChat.currentSession = { id: 990403 };
  DevChat.budget = fixture;
  assert.equal(DevChat._creditsLow(), true);
  DevChat.renderBudget();
  assert.match(meterHtml(), /\$20\.00/, 'the meter paints the fixture spend');
  assert.match(DevChat._renderCreditsLowBannerHtml(), /\$5\.00 of \$25\.00 left today/,
    'and the WARNING is what states the headroom (#1353)');

  // Pure UI: no environment gate (a production "before" shot has to be
  // obtainable) and no other ?shot= value hijacks the real budget read.
  const fn = DEV_CHAT_SRC.slice(DEV_CHAT_SRC.indexOf('_shotCreditsLowBudget() {'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.ok(!/staging|USERNODE_ENV|demo/i.test(body), 'not environment-gated');
  assert.ok(!/fetch|pool|POST/.test(body), 'reads nothing and writes nothing');
  assert.equal(makeDevChat({ search: '?shot=venue-sheet' }).DevChat._shotCreditsLowBudget(), null);
  assert.equal(makeDevChat().DevChat._shotCreditsLowBudget(), null);
});

// ── The drawer row ──────────────────────────────────────────────────────

test('the drawer row renders the remainder and shares the reset wording', () => {
  // #1367: the hook is rendered by features/header/ai-budget.tsx, from the
  // `remaining` flag this module sets on that part.
  assert.match(AI_CREDIT_SRC, /remaining: true/, 'same hook as the composer meter');
  assert.match(
    fs.readFileSync(path.join(root, 'frontend/src/features/header/ai-budget.tsx'), 'utf8'),
    /'data-credits-remaining': '1'/,
  );
  assert.match(AI_CREDIT_SRC, /money\(remaining\) \+ ' left'/, 'rendered, not tooltip-only');
  assert.match(AI_CREDIT_SRC, /CO\.resetSentence\(state\)/,
    'one wording for the boundary, shared with the dev chat');
  assert.ok(!/Resets at midnight UTC/.test(AI_CREDIT_SRC),
    'no second, hand-written copy of the reset sentence');
  // The row is user-facing for every signed-in account, so the #555 rule
  // that it carries no global figures still holds.
  assert.ok(!/globalSpend|globalRemaining|globalLimit/.test(AI_CREDIT_SRC));
});

// ── The checks that keep it visible ─────────────────────────────────────

test('dapp.json points at the credits indicator and the warning', () => {
  const named = DAPP.tests.filter((t) => /#593/.test(t.name));
  assert.ok(named.length >= 4, `#593 checks present (found ${named.length})`);
  const shot = named.filter((t) => /shot=credits-low/.test(t.path));
  assert.ok(shot.length >= 2, 'the screenshot-state deep link is checked, not just added');
  assert.ok(named.some((t) => /data-credits-remaining/.test(t.expectSelector || '')),
    'the visible remainder has a check — the drawer row\'s, since #1353 took '
      + 'the composer meter\'s copy of the figure out');
  assert.ok(named.some((t) => /dc-credits-low-banner/.test(t.expectSelector || '')),
    'so does the low-balance warning');
  assert.ok(named.some((t) => /dc-credits-banner \[data-credits-reset\]/.test(t.expectSelector || '')),
    'and the exhausted banner’s reset statement');
});

test('?shot=credits-exhausted reaches the refusal state (#1348)', () => {
  // The two-door bar IS that state's whole interface now, so it needs a
  // route the checks and the vote screenshots can open without a reviewer
  // burning a real daily allowance.
  const { DevChat } = makeDevChat({ search: '?shot=credits-exhausted' });
  const fixture = DevChat._shotCreditsLowBudget();
  assert.ok(fixture, 'the shot answers with a fixture budget');
  assert.equal(fixture.spentCents, fixture.limitCents, 'spent meets the cap');
  assert.equal(fixture.remainingCents, 0);
  // The low shot is still the low shot — one fixture shape, two states.
  const low = makeDevChat({ search: '?shot=credits-low' }).DevChat._shotCreditsLowBudget();
  assert.ok(low.spentCents < low.limitCents, 'the warning is not the refusal');
  // And the exhausted fixture actually trips the banner.
  DevChat.budget = fixture;
  assert.equal(DevChat._creditsExhausted(), true);
  const html = DevChat._renderCreditsBannerHtml();
  assert.match(html, /Add API key/);
  assert.match(html, /data-credits-venue="1"/);
  assert.equal((html.match(/<button/g) || []).length, 2);
});
