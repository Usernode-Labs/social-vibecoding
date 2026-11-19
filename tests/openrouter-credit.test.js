'use strict';

// #6867: the credit policy (services/openrouter-credit.js) — what admins are
// told, and when — and what makes a turn an outage rather than a failure.
// Pure: no database, no network.

const test = require('node:test');
const assert = require('node:assert/strict');

const credit = require('../src/services/openrouter-credit');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const at = (minutes) => NOW + minutes * 60 * 1000;

test('one warning per crossing, re-armed once back above the level', () => {
  let { state, events } = credit.decide(null, 60000, { now: NOW });
  assert.deepEqual(events, [], 'above $500 says nothing');

  ({ state, events } = credit.decide(state, 48000, { now: at(15) }));
  assert.deepEqual(events.map((e) => e.type), ['low']);
  assert.equal(events[0].thresholdCents, 50000);

  // Still below the same level: said once.
  ({ state, events } = credit.decide(state, 40000, { now: at(30) }));
  assert.deepEqual(events, []);

  // Back above $500 re-arms it.
  ({ state, events } = credit.decide(state, 52000, { now: at(45) }));
  assert.deepEqual(events, []);
  ({ state, events } = credit.decide(state, 49000, { now: at(60) }));
  assert.deepEqual(events.map((e) => e.type), ['low']);
});

test('the urgent warning comes at $200, once, after the first', () => {
  let r = credit.decide(null, 55000, { now: NOW });
  r = credit.decide(r.state, 19000, { now: at(15) });
  assert.deepEqual(r.events.map((e) => [e.type, e.thresholdCents]), [['low', 50000], ['urgent', 20000]]);
  r = credit.decide(r.state, 15000, { now: at(30) });
  assert.deepEqual(r.events, [], 'said once');
});

test('a failed read changes nothing', () => {
  const before = credit.decide(null, 48000, { now: NOW });
  const after = credit.decide(before.state, null, { now: at(15) });
  assert.deepEqual(after.events, []);
  assert.equal(after.state.armed.low, false);
});

test('credit is back only after five minutes and at least $25', () => {
  let state = credit.outageSet(credit.decide(null, 0, { now: NOW }).state, { words: '402', now: NOW });
  // A few cents, minutes later: still an outage.
  let r = credit.decide(state, 100, { now: at(10) });
  assert.deepEqual(r.events, []);
  assert.ok(r.state.outage, 'still out');
  // Credit shown before the outage has stood five minutes: not lifted yet.
  r = credit.decide(state, 5000, { now: at(1) });
  assert.ok(r.state.outage);
  // Both conditions met: back.
  r = credit.decide(state, 5000, { now: at(10) });
  assert.deepEqual(r.events.map((e) => e.type), ['back']);
  assert.equal(r.state.outage, null);
});

test('an outage is set once and keeps its first words', () => {
  const first = credit.outageSet(null, { words: '402 first', now: NOW });
  const again = credit.outageSet(first, { words: '402 second', now: at(5) });
  assert.deepEqual(again.outage, first.outage);
  assert.match(again.outage.words, /402 first/);
});

test('a 402 for credit is an outage; the smaller-reply refusal is not', () => {
  assert.equal(credit.creditOut({ agentErrorCode: 'insufficient_credits' }), true);
  assert.equal(credit.creditOut({ agentErrorCode: 'insufficient_credits_max_tokens' }), false);
  assert.equal(credit.creditOut({
    error: 'API Error: 402 This request would exceed your available credits given your current in-flight requests.',
  }), true);
  assert.equal(credit.creditOut({
    error: 'API Error: 402 This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1000.',
  }), false);
  assert.equal(credit.creditOut({ error: 'the agent exited with code 1' }), false);
  assert.equal(credit.creditOut(null), false);
});

test('the detail token names the level, the dollars and the days', () => {
  assert.equal(credit.detailToken({ type: 'low', thresholdCents: 50000, balanceCents: 48000 }, 6), 'credit:low:500:480:6');
  assert.equal(credit.detailToken({ type: 'urgent', thresholdCents: 20000, balanceCents: 15000 }, 2), 'credit:urgent:200:150:2');
});
