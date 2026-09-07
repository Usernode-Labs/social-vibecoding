// GET /api/budget?demo=1 — the staging hook that makes the out-of-credits
// state reviewable.
//
// The exhausted state (red meter, three-route credits banner, the in-chat
// card) is otherwise unreachable on a staging preview without actually
// burning a real daily allowance, so a reviewer would only ever see the
// healthy layout. This adds the platform's standard staging fixture idiom
// to that one route.
//
// The property that matters is that it is a STRICT no-op in production: it
// must be gated on the deployment mode, must not read or write the
// database, and must not change the real code path.
//
// Run with: node --test tests/budget-demo.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SESSIONS_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/sessions.js'), 'utf8'
);
const AUTH_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/auth.js'), 'utf8'
);
const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '../frontend/src/features/dev-chat/dev-chat.js'), 'utf8'
);

// The demo branch, isolated from the rest of the handler.
const HANDLER = SESSIONS_SRC.slice(
  SESSIONS_SRC.indexOf("router.get('/api/budget'"),
  SESSIONS_SRC.indexOf("router.post('/api/sessions/:id/deploy-staging'")
);
const DEMO_BRANCH = HANDLER.slice(0, HANDLER.indexOf('try {'));
// #1788 added a second sibling fixture for the WEEKLY cap, so the region
// above now holds two branches. The assertions about the original one are
// scoped to its own half rather than to the first match in the region.
const WEEKLY_AT = DEMO_BRANCH.indexOf("req.query.demo === 'weekly-out'");
const DEMO_DAILY = WEEKLY_AT > 0 ? DEMO_BRANCH.slice(0, WEEKLY_AT) : DEMO_BRANCH;
const DEMO_WEEKLY = WEEKLY_AT > 0 ? DEMO_BRANCH.slice(WEEKLY_AT) : '';

test('the demo branch is gated on staging AND the explicit flag', () => {
  assert.match(
    DEMO_DAILY,
    /process\.env\.USERNODE_ENV === 'staging' && req\.query\.demo === '1'/,
    'both conditions, so a stray ?demo=1 in production does nothing'
  );
  // It returns before any real work, so production never even evaluates it
  // beyond the one comparison.
  assert.ok(
    DEMO_DAILY.indexOf('return res.json') > 0,
    'the branch returns its fixture directly'
  );
});

test('the fixture never touches the database', () => {
  assert.doesNotMatch(DEMO_BRANCH, /pool\.query/);
  assert.doesNotMatch(DEMO_BRANCH, /await /);
  assert.doesNotMatch(DEMO_BRANCH, /limits\./);
});

test('the fixture reports the user’s own allowance as exhausted', () => {
  // The client's _creditsExhausted() keys on spentCents >= limitCents, so
  // these two must be equal for the banner and card to appear at all.
  const spent = /spentCents: (\d+)/.exec(DEMO_DAILY);
  const limit = /limitCents: (\d+)/.exec(DEMO_DAILY);
  assert.ok(spent && limit);
  assert.equal(spent[1], limit[1], 'the personal allowance reads as spent');

  // …while the SHARED budget still has headroom, so the reviewed copy is
  // the ordinary "you're out" wording rather than the platform-wide one.
  const globalSpent = Number(/globalSpentCents: (\d+)/.exec(DEMO_DAILY)[1]);
  const globalLimit = Number(/globalLimitCents: (\d+)/.exec(DEMO_DAILY)[1]);
  assert.ok(globalSpent < globalLimit, 'the shared budget is not exhausted');

  // No BYOK spillover, so the card shows the "add a key" variant.
  assert.match(DEMO_DAILY, /byokSpentCents: 0/);
  assert.match(DEMO_DAILY, /aiEnabled: true/);
  // Flagged, which is what the client keys its one-off card injection off.
  assert.match(DEMO_DAILY, /demo: true/);

  // #1788: and it says WHICH window those three figures describe. The
  // daily cap is the one that binds here, which is what this fixture has
  // always meant — stated now that it is no longer the only answer.
  assert.match(DEMO_DAILY, /capWindow: 'daily'/);
  assert.match(DEMO_DAILY, /resetLabel: 'midnight UTC'/);
});

// The two halves of the #1055 fixture used to cancel each other out: the
// budget half says "your allowance is spent", the profile half says "you have
// a key on file (…7f2c)" — and a key on file is precisely the condition that
// makes exhaustion irrelevant, so _creditsExhausted() returned false and the
// card the demo state exists to show was never injected. The fake key has to
// be distinguishable from a real one at the point of that decision.
test('the demo API key does not read as a real key on file', () => {
  const SETTINGS_SRC = fs.readFileSync(
    path.join(__dirname, '../frontend/src/features/settings/settings.js'), 'utf8'
  );
  // Same gate as everything else here, so `demoKey` cannot exist in
  // production — which is what makes branching on it safe.
  const profile = AUTH_SRC.slice(AUTH_SRC.indexOf('let demoKey = false;'));
  assert.match(profile.slice(0, 300), /IS_STAGING && req\.query\.demo === '1'/);
  assert.match(profile, /\.\.\.\(demoKey \? \{ demoKey: true \} : \{\}\)/,
    'reported alongside hasApiKey, not instead of it — the key-on-file UI still renders');

  assert.match(SETTINGS_SRC, /this\.state\.demoKey = !!j\.user\?\.demoKey;/,
    'carried into the client state the surfaces read');
  assert.match(SETTINGS_SRC, /state: \{ hasApiKey: false, demoKey: false,/,
    'and defaulted, so a stale/failed refresh reads as "not a demo key"');

  assert.match(DEV_CHAT_SRC, /if \(settings\?\.hasApiKey && !settings\.demoKey\) return false;/,
    'exhaustion is only suppressed by a key that can actually be billed');
});

test('it mirrors the established staging-fixture idiom', () => {
  // GET /api/me/ai-budget is the sibling that set this pattern; the two
  // should look the same so neither drifts into an ad-hoc shape.
  assert.match(
    AUTH_SRC,
    /IS_STAGING && req\.query\.demo === '1'/,
    'the sibling route uses the same gate'
  );
  assert.match(AUTH_SRC, /demo: true/);
});

test('the client passes the flag through and injects one card', () => {
  assert.match(DEV_CHAT_SRC, /_budgetDemo\(\)/, 'dev-chat reads ?demo=1 from the page');
  assert.match(
    DEV_CHAT_SRC,
    /fetch\(`\/api\/budget\$\{DevChat\._budgetDemo\(\) \? `\?demo=\$\{DevChat\._budgetDemoValue\(\)\}` : ''\}`\)/,
    'and passes the flag through to the budget read, whichever spelling it is'
  );
  const inject = DEV_CHAT_SRC.slice(
    DEV_CHAT_SRC.indexOf('_maybeInjectDemoCreditsCard()'),
    DEV_CHAT_SRC.indexOf('_globalBudgetOut()')
  );
  // The injection requires the SERVER to have confirmed the demo — a
  // production /api/budget never sets it, so this cannot fire there.
  assert.match(inject, /if \(!DevChat\.budget \|\| !DevChat\.budget\.demo\) return;/);
  assert.match(inject, /if \(!DevChat\._creditsExhausted\(\)\) return;/);
  assert.match(
    inject,
    /if \(DevChat\.messages\.some\(\(m\) => m && m\.creditsCard\)\) return;/,
    'idempotent: repeated budget refreshes do not stack cards'
  );
});

// ── #1788: the weekly sibling ────────────────────────────────────────────
//
// A spent WEEKLY allowance is even less reachable on a preview than a spent
// daily one — it would take seven days of seeded spend — and its copy
// differs everywhere the boundary is named ("this week", "Resets Monday
// 00:00 UTC"). So it gets its own fixture at ?demo=weekly-out rather than a
// flag on the one above, and the same no-op-in-production properties apply.

test('the weekly fixture is its own branch under the same gate', () => {
  assert.ok(DEMO_WEEKLY, 'the ?demo=weekly-out branch exists');
  assert.match(
    DEMO_BRANCH,
    /process\.env\.USERNODE_ENV === 'staging' && req\.query\.demo === 'weekly-out'/,
    'staging AND the explicit value, exactly like the daily one'
  );
  assert.ok(
    DEMO_WEEKLY.indexOf('return res.json') > 0,
    'and returns its fixture directly'
  );
  // Belt and braces: the region-wide no-DB assertions above already cover
  // this branch, since DEMO_BRANCH spans both.
  assert.doesNotMatch(DEMO_WEEKLY, /pool\.query/);
  assert.doesNotMatch(DEMO_WEEKLY, /await /);
});

test('the weekly fixture makes the WEEKLY cap the binding one', () => {
  // Same equality the client's _creditsExhausted() keys on.
  const spent = Number(/spentCents: (\d+)/.exec(DEMO_WEEKLY)[1]);
  const limit = Number(/limitCents: (\d+)/.exec(DEMO_WEEKLY)[1]);
  assert.equal(spent, limit, 'the reported allowance reads as spent');

  // The DAILY cap still has headroom, so there is no ambiguity about which
  // window the copy under review is describing.
  const dailyLimit = Number(/dailyLimitCents: (\d+)/.exec(DEMO_WEEKLY)[1]);
  const dailySpent = Number(/dailySpentCents: (\d+)/.exec(DEMO_WEEKLY)[1]);
  assert.ok(dailySpent < dailyLimit, 'the daily cap is not the one that ran out');

  assert.match(DEMO_WEEKLY, /weeklyApplies: true/);
  const weeklyLimit = Number(/weeklyLimitCents: (\d+)/.exec(DEMO_WEEKLY)[1]);
  const weeklySpent = Number(/weeklySpentCents: (\d+)/.exec(DEMO_WEEKLY)[1]);
  assert.equal(weeklySpent, weeklyLimit, 'and the weekly one is');
  assert.equal(limit, weeklyLimit, 'the headline figures are the weekly cap’s');

  assert.match(DEMO_WEEKLY, /capWindow: 'weekly'/);
  assert.match(DEMO_WEEKLY, /windowLabel: 'This week'/);
  assert.match(DEMO_WEEKLY, /resetLabel: 'Monday 00:00 UTC'/,
    'so every "resets at midnight UTC" sentence reads the boundary correctly');
  assert.match(DEMO_WEEKLY, /demo: true/);
});

test('the client forwards either demo spelling, and only those two', () => {
  const reader = DEV_CHAT_SRC.slice(
    DEV_CHAT_SRC.indexOf('_budgetDemoValue()'),
    DEV_CHAT_SRC.indexOf('_budgetDemo()', DEV_CHAT_SRC.indexOf('_budgetDemoValue()'))
  );
  assert.match(reader, /\(v === '1' \|\| v === 'weekly-out'\) \? v : null/,
    'an arbitrary ?demo= value is not forwarded');
  // The window-aware copy on the injected card, so the reviewed card names
  // the same boundary as the banner beside it.
  const inject = DEV_CHAT_SRC.slice(
    DEV_CHAT_SRC.indexOf('_maybeInjectDemoCreditsCard()'),
    DEV_CHAT_SRC.indexOf('_globalBudgetOut()')
  );
  assert.match(inject, /Weekly limit reached \(\$175\.00\)\. Resets Monday 00:00 UTC\./);
  assert.match(inject, /Daily limit reached \(\$20\.00\)\. Resets at midnight UTC\./);
});
