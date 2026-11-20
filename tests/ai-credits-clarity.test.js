// #593: the daily AI allowance, stated clearly instead of cryptically.
//
// Three things shipped and each one is a silent regression if it drifts:
//   1. the figures a builder needs — what is LEFT and when it comes back —
//      are RENDERED on the drawer row, not tooltip-only (they were
//      invisible on touch and absent from every review screenshot),
//   2. the allowance turns low at the server-declared threshold, and a
//      BYOK key never becomes a level of its own,
//   3. the reset sentence and the shared-cap refusal name the boundary.
//
// The normalisation and the copy live in public/js/credit-options.js (one
// definition for every surface), so most of this exercises that module
// directly; the drawer row is read from its source.
//
// Run with: node --test tests/ai-credits-clarity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// The scripts under test read their text from the language runtime's
// global; give them the real English one.
globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const CO = require('../public/js/credit-options.js');
const LIMITS_SRC = fs.readFileSync(path.join(root, 'src/services/limits.js'), 'utf8');
const SESSIONS_SRC = fs.readFileSync(path.join(root, 'src/routes/sessions.js'), 'utf8');
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

test('an old payload\'s own-key flag is not carried into the state', () => {
  // level describes the ALLOWANCE. The own Anthropic key that once bypassed
  // the cap (#119) went in task 2275, so the flag is no longer read.
  const s = CO.creditState(budget({ spentCents: 2500, hasByokKey: true }));
  assert.equal(s.level, 'exhausted');
  assert.equal('hasByokKey' in s, false);
});

test('the reset sentence names the UTC boundary and translates it', () => {
  const at = new Date('2026-08-13T00:00:00.000Z');
  const now = at.getTime() - (3 * 60 + 20) * 60 * 1000;
  const sentence = CO.resetSentence({ resetsAt: at.toISOString() }, now);
  assert.match(sentence, /reset at midnight UTC/,
    'the boundary the server enforces, stated as the server states it');
  assert.match(sentence, /about 3h 20m from now/, 'and how long that is');
  assert.match(CO.resetSentence({ resetsAt: at.toISOString() }, at.getTime() - 45 * 60 * 1000), /about 45m from now/);
  const past = CO.resetSentence({ resetsAt: at.toISOString() }, at.getTime() + 1000);
  assert.match(past, /reset at midnight UTC\./);
  assert.doesNotMatch(past, /from now/, 'a past boundary drops the clause rather than printing a negative');
  assert.match(CO.resetSentence({}), /reset at midnight UTC\./,
    'no resetsAt → still says when, just not how long');
  assert.match(CO.resetSentence({ level: 'locked' }), /Connect GitHub or X.*\$10\.00\/day/,
    'locked credits name the unlock action, not a reset that will not help');
});

// ── The server side ─────────────────────────────────────────────────────

test('both budget reads carry the remainder, the reset and the threshold', () => {
  const handler = SESSIONS_SRC.slice(
    SESSIONS_SRC.indexOf("router.get('/api/budget'"),
    SESSIONS_SRC.indexOf("router.get('/api/sessions/:id/preview-status'"));
  for (const field of ['remainingCents', 'resetsAt', 'lowBalancePct']) {
    assert.match(handler, new RegExp(field), `GET /api/budget sends ${field}`);
  }
  assert.match(handler, /getBudgetSnapshot\(pool, req\.user\.id\)/,
    'the real branch gets reset/remainder/tier fields from the shared snapshot');
  // …and the snapshot the drawer reads gets them from the same helper.
  const snapshot = LIMITS_SRC.slice(
    LIMITS_SRC.indexOf('async function getBudgetSnapshot'),
    LIMITS_SRC.indexOf('// Shared BYOK key lookup'));
  // #2571: one cap, one boundary — the instant the payload promises is the
  // week's, and the words beside it come from the same constant.
  assert.match(snapshot, /resetsAt: weeklyResetAt\(\)/);
  assert.match(snapshot, /resetLabel: WEEKLY_RESET_LABEL/,
    'and the words match the instant');
  assert.match(snapshot, /windowLabel: 'This week'/);
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

// ── The drawer row ──────────────────────────────────────────────────────

test('the drawer row renders the remainder and shares the reset wording', () => {
  // #1367: the hook is rendered by features/header/ai-budget.tsx, from the
  // `remaining` flag this module sets on that part.
  assert.match(AI_CREDIT_SRC, /remaining: true/, 'the remainder carries its hook');
  assert.match(
    fs.readFileSync(path.join(root, 'frontend/src/features/header/ai-budget.tsx'), 'utf8'),
    /'data-credits-remaining': '1'/,
  );
  assert.match(AI_CREDIT_SRC, /runs\(weeklyWindow \? 'wallet:credit\.meter\.leftWeekly' : 'wallet:credit\.meter\.leftToday',\s+brief, \[leftTone\]\)/,
    'rendered, not tooltip-only');
  assert.match(AI_CREDIT_SRC, /remaining: wholeMoney\(remaining\)/);
  // #5284: one sentence, the amount left first.
  assert.equal(message('wallet:credit.meter.leftWeekly', { remaining: '$839.99', limit: '$840' }), '<0>$839.99</0> of $840 left this week');
  assert.equal(message('wallet:credit.meter.leftToday', { remaining: '$19', limit: '$20' }), '<0>$19</0> of $20 left today');
  assert.match(AI_CREDIT_SRC, /CO\.resetSentence\(state, undefined, \{ withUtc: true \}\)/,
    'one wording for the boundary, CreditOptions\'');
  assert.ok(!/Resets at midnight UTC/.test(AI_CREDIT_SRC),
    'no second, hand-written copy of the reset sentence');
  // The row is user-facing for every signed-in account, so the #555 rule
  // that it carries no global figures still holds.
  assert.ok(!/globalSpend|globalRemaining|globalLimit/.test(AI_CREDIT_SRC));
});

// ── The checks that keep it visible ─────────────────────────────────────

test('dapp.json points at the credits indicator', () => {
  const named = DAPP.tests.filter((t) => /#593/.test(t.name));
  assert.ok(named.some((t) => /data-credits-remaining/.test(t.expectSelector || '')),
    'the visible remainder has a check — the drawer row\'s, since #1353 took '
      + 'the composer meter\'s copy of the figure out');
});
