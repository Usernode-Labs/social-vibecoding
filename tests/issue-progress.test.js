'use strict';

// #1903: the Workshop put every issue in the `open` lane and reached
// `underway` only for a shared dev session. So an issue you had CLAIMED sat
// in open while your own session sat in underway — one piece of work, two
// cards, two lanes — which is the "assigned vs claim" confusion the request
// is about.
//
// services/issue-progress.js is where the two rules that decide it now live,
// so the Board and the Workshop cannot answer the question differently. What
// this file pins is the subtle half: a claim ages out on the FRESHEST of its
// own clock and the issue thread's, not on `claimed_at` alone. Get that
// wrong in one of the two readers and an issue under active discussion
// silently changes lane on one screen and not the other.
//
// Run with: node --test tests/issue-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  IN_PROGRESS_PAUSED_WINDOW_DAYS,
  ISSUE_CLAIM_TTL_DAYS,
  claimExpiresAt,
  claimIsLive,
  inProgressIssueNumbers,
} = require('../src/services/issue-progress');

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const iso = (t) => new Date(t).toISOString();

// ─── the liveness rule ────────────────────────────────────────────

test('a fresh claim is live, an old one is not', () => {
  assert.equal(claimIsLive(iso(NOW - DAY), null, NOW), true);
  assert.equal(claimIsLive(iso(NOW - 8 * DAY), null, NOW), false);
});

test('thread activity keeps an old claim alive — the whole point of the rule', () => {
  // Claimed nine days ago, but somebody posted on the issue yesterday. The
  // claimer has not touched anything and does not have to: an issue under
  // discussion is an issue somebody is still on.
  const claimed = iso(NOW - 9 * DAY);
  assert.equal(claimIsLive(claimed, null, NOW), false, 'on its own clock it has aged out');
  assert.equal(claimIsLive(claimed, iso(NOW - DAY), NOW), true, 'the thread carries it');
});

test('a claim never ages out EARLIER because the thread is quiet', () => {
  // The freshest of the two, not the oldest: a silent thread must not
  // shorten a claim somebody just pressed.
  assert.equal(claimIsLive(iso(NOW), iso(NOW - 30 * DAY), NOW), true);
});

test('the expiry instant is the TTL from whichever clock is fresher', () => {
  assert.equal(claimExpiresAt(iso(NOW - 3 * DAY), null).getTime(),
    NOW - 3 * DAY + ISSUE_CLAIM_TTL_DAYS * DAY);
  assert.equal(claimExpiresAt(iso(NOW - 9 * DAY), iso(NOW - DAY)).getTime(),
    NOW - DAY + ISSUE_CLAIM_TTL_DAYS * DAY);
});

test('an unparseable timestamp is treated as the epoch, never as now', () => {
  // Fail CLOSED. A row whose clock cannot be read must not be granted an
  // indefinite claim — it reads as long expired and the card falls back to
  // the open lane, which is the state this change replaces.
  assert.equal(claimIsLive('not a date', null, NOW), false);
  assert.equal(claimIsLive(null, undefined, NOW), false);
});

test('the boundary is exclusive: a claim exactly at its expiry is dead', () => {
  const claimed = iso(NOW - ISSUE_CLAIM_TTL_DAYS * DAY);
  assert.equal(claimIsLive(claimed, null, NOW), false);
  assert.equal(claimIsLive(iso(NOW - ISSUE_CLAIM_TTL_DAYS * DAY + 1), null, NOW), true);
});

// ─── the two halves, folded ───────────────────────────────────────

/** A pool stub that answers the three reads in the order they are made. */
function poolOf({ sessions = [], claims = [], threads = [] } = {}) {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      seen.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/FROM chat_sessions/.test(sql)) return { rows: sessions };
      if (/FROM issue_claims/.test(sql)) return { rows: claims };
      return { rows: threads };
    },
  };
}

test('both halves land in one set', async () => {
  const pool = poolOf({
    sessions: [{ n: 11 }, { n: 12 }],
    claims: [{ n: 20, claimed_at: iso(NOW - DAY) }],
  });
  const out = await inProgressIssueNumbers(pool, 7);
  assert.deepEqual([...out].sort((a, b) => a - b), [11, 12, 20]);
});

test('an expired claim does not place a card, and asks the thread first', async () => {
  const pool = poolOf({ claims: [{ n: 20, claimed_at: iso(NOW - 40 * DAY) }] });
  assert.deepEqual([...await inProgressIssueNumbers(pool, 7)], []);
  // It still LOOKED: the thread read is what could have revived it, and
  // skipping that read is how the two screens would disagree.
  assert.ok(pool.seen.some((q) => /FROM chat_messages/.test(q.sql)),
    'thread activity is consulted before a claim is written off');
});

test('the session half uses the paused window, not the claim TTL', async () => {
  const pool = poolOf({ sessions: [{ n: 5 }] });
  await inProgressIssueNumbers(pool, 7);
  const sessionQuery = pool.seen.find((q) => /FROM chat_sessions/.test(q.sql));
  assert.match(sessionQuery.sql, /status IN \('active','promoted','merging'\)/);
  assert.match(sessionQuery.sql, /is_headless = FALSE/,
    'headless runs ship as their own field and are ORed by the client');
  assert.equal(sessionQuery.params[1], IN_PROGRESS_PAUSED_WINDOW_DAYS);
});

test('no claims means no thread read at all', async () => {
  const pool = poolOf({ sessions: [{ n: 5 }] });
  await inProgressIssueNumbers(pool, 7);
  assert.ok(!pool.seen.some((q) => /FROM chat_messages/.test(q.sql)),
    'the third query is skipped when nothing could need it');
});

test('a missing app or pool answers empty rather than throwing', async () => {
  assert.equal((await inProgressIssueNumbers(null, 7)).size, 0);
  assert.equal((await inProgressIssueNumbers(poolOf(), null)).size, 0);
});
