'use strict';

// The Homeroom bot's first-version configurations (src/services/bot-configs.js),
// the pure half: a recipe is checked into one shape, the seed is the three
// configurations the owner chose (an Opus 5.5 spec with a GLM 5.3 Flash build
// and an Opus review as current; all-GLM and "Opus spec + GLM, no reviewer"
// as side), a side recipe is derivable from the current one's round-0
// snapshot exactly when it is the current recipe with no reviewer, and the
// numbers: a Wilson interval, a win rate that counts a tie half, and why a
// pair is left out. tests/bot-configs-postgres.test.js has the rest.
//
// Run with: node --test tests/bot-configs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const configs = require('../src/services/bot-configs');
const bot = require('../src/services/homeroom-bot');

const OPUS = 'anthropic/claude-opus-5.5';
const GLM = 'z-ai/glm-5.3-flash';
const current = () => ({ models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: { model: OPUS, maxRounds: 3, budgetMinutes: 25 }, pack: null });

test('the seed is the owner\'s three configurations, with the confirmed OpenRouter ids', () => {
  assert.equal(configs.OPUS, OPUS);
  assert.equal(configs.GLM, GLM);
  for (const id of [OPUS, GLM]) assert.match(id, bot.MODEL_ID_RE, `${id} is an OpenRouter model id the bot accepts`);
  const byKey = Object.fromEntries(configs.SEED.map((s) => [s.key, s]));
  assert.deepEqual(configs.SEED.map((s) => s.role), ['current', 'side', 'side'], 'exactly one current');
  assert.deepEqual(byKey['opus-spec-review'].recipe, current());
  assert.deepEqual(byKey['all-glm'].recipe, { models: { triage: GLM, spec: GLM, build: GLM }, reviewer: null, pack: null });
  assert.deepEqual(byKey['opus-spec-no-review'].recipe, { ...current(), reviewer: null });
  for (const s of configs.SEED) {
    assert.equal(configs.validateRecipe(s.recipe).ok, true, s.key);
    assert.ok(s.seedKey && s.label && s.notes, `${s.key} is written once and says what it is`);
  }
  assert.equal(new Set(configs.SEED.map((s) => s.seedKey)).size, 3);
});

test('a recipe is checked and put in its one shape; anything else is refused with why', () => {
  const ok = configs.validateRecipe({ models: { triage: ` ${GLM}`, spec: OPUS, build: GLM }, reviewer: { model: OPUS, maxRounds: '2', budgetMinutes: 10 } });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.recipe, { models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: { model: OPUS, maxRounds: 2, budgetMinutes: 10 }, pack: null });
  assert.equal(configs.validateRecipe({ ...current(), pack: 4 }).recipe.pack, 4);
  for (const [raw, re] of [
    [null, /object/],
    [[], /object/],
    [{ ...current(), extra: 1 }, /unknown keys: extra/],
    [{ ...current(), models: { triage: GLM, spec: OPUS } }, /models\.build/],
    [{ ...current(), models: { triage: GLM, spec: OPUS, build: GLM, followup: GLM } }, /unknown stages: followup/],
    [{ ...current(), models: { triage: 'glm', spec: OPUS, build: GLM } }, /models\.triage must be an OpenRouter model id/],
    [{ ...current(), reviewer: { model: 'nope', maxRounds: 1, budgetMinutes: 5 } }, /reviewer\.model/],
    [{ ...current(), reviewer: { model: OPUS, maxRounds: 6, budgetMinutes: 5 } }, /maxRounds must be a whole number from 0 to 5/],
    [{ ...current(), reviewer: { model: OPUS, maxRounds: 1.5, budgetMinutes: 5 } }, /maxRounds/],
    [{ ...current(), reviewer: { model: OPUS, maxRounds: 1, budgetMinutes: 0 } }, /budgetMinutes must be a whole number from 1 to 60/],
    [{ ...current(), reviewer: { model: OPUS, maxRounds: 1, budgetMinutes: 61 } }, /budgetMinutes/],
    [{ ...current(), reviewer: { model: OPUS, maxRounds: 1, budgetMinutes: 5, eager: true } }, /reviewer has unknown keys: eager/],
    [{ ...current(), reviewer: 'opus' }, /reviewer must be null/],
    [{ ...current(), pack: 'warm' }, /pack must be null or an App bench context pack id/],
    [{ ...current(), pack: -1 }, /pack/],
  ]) {
    const v = configs.validateRecipe(raw);
    assert.equal(v.ok, false, JSON.stringify(raw));
    assert.equal(v.status, 400);
    assert.match(v.error, re);
  }
  assert.equal(configs.recipeOf({ models: {} }), null, 'a stored recipe that no longer validates reads as none');
});

test('the recipe in one line, as the console shows it', () => {
  assert.equal(configs.recipeLine(current()), 'triage glm-5.3-flash · spec claude-opus-5.5 · build glm-5.3-flash · review claude-opus-5.5 ×3 in 25 min');
  assert.equal(configs.recipeLine({ ...current(), reviewer: null, pack: 7 }), 'triage glm-5.3-flash · spec claude-opus-5.5 · build glm-5.3-flash · no review · pack 7');
  assert.equal(configs.recipeLine({}), 'not a valid recipe');
});

test('derivableFrom: a side recipe is the current one\'s round-0 snapshot exactly when it is that recipe with no reviewer', () => {
  const noReview = { ...current(), reviewer: null };
  assert.equal(configs.derivableFrom(current(), noReview), true, 'the seeded "Opus spec + GLM, no reviewer"');
  assert.equal(configs.derivableFrom(current(), { models: { triage: GLM, spec: GLM, build: GLM }, reviewer: null, pack: null }), false, 'all-GLM writes another spec: built for real');
  assert.equal(configs.derivableFrom(current(), current()), false, 'a side with a reviewer reviews on its own');
  assert.equal(configs.derivableFrom(current(), { ...noReview, pack: 3 }), false, 'another pack is another prompt');
  assert.equal(configs.derivableFrom({ ...current(), pack: 3 }, { ...noReview, pack: 3 }), true);
  assert.equal(configs.derivableFrom(current(), { ...noReview, models: { ...noReview.models, triage: OPUS } }), false, 'another triage is another plan');
  assert.equal(configs.derivableFrom(noReview, noReview), true, 'a current with no reviewer: its round 0 is its final state');
  assert.equal(configs.derivableFrom({ models: {} }, noReview), false);
  assert.equal(configs.derivableFrom(current(), null), false);
  assert.equal(configs.reviews(current()), true);
  assert.equal(configs.reviews({ ...current(), reviewer: { model: OPUS, maxRounds: 0, budgetMinutes: 5 } }), false, 'zero rounds is no review');
  assert.equal(configs.reviews(noReview), false);
});

test('a 95% Wilson interval: known values, a tie as half, and nothing for no picks', () => {
  const w = configs.wilson(7, 10);
  assert.equal(w.rate, 0.7);
  assert.ok(Math.abs(w.low - 0.3968) < 0.001, `low ${w.low}`);
  assert.ok(Math.abs(w.high - 0.8922) < 0.001, `high ${w.high}`);
  assert.equal(w.n, 10);
  const all = configs.wilson(5, 5);
  assert.equal(all.rate, 1);
  assert.equal(all.high, 1);
  assert.ok(all.low > 0.5 && all.low < 0.6);
  const none = configs.wilson(0, 5);
  assert.equal(none.low, 0);
  assert.ok(none.high > 0.4 && none.high < 0.45);
  assert.deepEqual(configs.wilson(0, 0), { rate: null, low: null, high: null, n: 0 });
  const half = configs.wilson(1.5, 3);
  assert.equal(half.rate, 0.5, 'fractional successes are allowed');
  assert.ok(half.low < 0.5 && half.high > 0.5);
});

test('a win rate against the current version counts each tie as half a win', () => {
  const picks = [{ winner: 9 }, { winner: 9 }, { winner: 'tie' }, { winner: 4 }];
  const wr = configs.winRateOf(picks, 9);
  assert.deepEqual({ wins: wr.wins, ties: wr.ties, losses: wr.losses, n: wr.n }, { wins: 2, ties: 1, losses: 1, n: 4 });
  assert.equal(wr.rate, 2.5 / 4);
  const other = configs.winRateOf(picks, 4);
  assert.equal(other.rate, 1.5 / 4, 'the same picks from the other side');
  assert.equal(configs.winRateOf([], 9).n, 0);
});

test('a pair is left out, and says why, when either side did not build or boot', () => {
  const okSide = { built: true, booted: true, capture: {} };
  assert.equal(configs.exclusionOf(okSide, okSide), null);
  assert.equal(configs.exclusionOf({ ...okSide, built: false }, okSide), 'didn\'t build (the current configuration)');
  assert.equal(configs.exclusionOf(okSide, { built: false, booted: null, capture: null }), 'didn\'t build (the side configuration)');
  assert.equal(configs.exclusionOf(okSide, { ...okSide, booted: false }), 'didn\'t boot (the side configuration)');
  assert.equal(configs.exclusionOf({ ...okSide, capture: null }, okSide), 'no screenshots (the current configuration)');
});

test('the median, and a side trial\'s configuration from its model', () => {
  assert.equal(configs.median([3, 1, 2]), 2);
  assert.equal(configs.median([4, 1, 2, 3]), 2.5);
  assert.equal(configs.median([null, undefined]), null);
  assert.equal(configs.configIdOfModel('config:12'), 12);
  assert.equal(configs.configIdOfModel('z-ai/glm-5.3-flash'), null);
  assert.equal(configs.configIdOfModel(null), null);
});

test('the side builds\' weekly budget is a platform setting, $25 unless set', () => {
  assert.equal(configs.SIDE_WEEKLY_KEY, 'bot_config_side_weekly_cents');
  assert.equal(configs.DEFAULT_SIDE_WEEKLY_CENTS, 2500);
});
