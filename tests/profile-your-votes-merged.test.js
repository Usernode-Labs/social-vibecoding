'use strict';

// #6101: Your votes must not keep a merged change under Still open.
//
// A list read while the change was still up for a vote can reach the screen
// with an open status after the change has merged. The merge's own time
// (`merged_at`, from GET /api/me/history) decides it: it moves to Decided and
// says Going live or Live from the status the server reported.
//
// Run with: node --test tests/profile-your-votes-merged.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

const { votesView } = loadTsx('frontend/src/features/profile/profile-store.js');

const vote = (over = {}) => ({
  type: 'pr_vote',
  vote: 'yes',
  status: 'promoted',
  merged_at: '2026-11-02T10:00:00Z',
  app: { slug: 'run-club', name: 'Run Club' },
  pr: { sessionId: 31, number: 40, title: 'Weekly distance leaderboard' },
  ...over,
});

function groups(items) {
  const view = votesView({ items });
  return Object.fromEntries(view.sections.map((s) => [s.label, s.rows.map((r) => r.meta)]));
}

test('a promoted row that has a merge time is Decided, never Still open', () => {
  const seen = groups([vote()]);
  assert.equal(seen['Still open'], undefined, 'no still-open group at all');
  assert.deepEqual(seen.Decided, [
    `Run Club · you voted yes · ${message('profile:votes.outcome.goingLive')}`,
  ], 'nothing is live yet: the deploy is still to come');
});

test('merged and going_live keep their own words', () => {
  assert.deepEqual(groups([vote({ status: 'merged' })]).Decided,
    [`Run Club · you voted yes · ${message('profile:votes.outcome.live')}`]);
  assert.deepEqual(groups([vote({ status: 'going_live' })]).Decided,
    [`Run Club · you voted yes · ${message('profile:votes.outcome.goingLive')}`]);
});

test('a row closed without merging is Decided too, and a row still being decided stays open', () => {
  const seen = groups([
    vote({ status: 'closed', merged_at: null, closed_at: '2026-11-02T11:00:00Z' }),
    vote({ status: 'promoted', merged_at: null, pr: { sessionId: 32, number: 41, title: 'Route map' } }),
  ]);
  assert.deepEqual(seen.Decided, [`Run Club · you voted yes · ${message('profile:votes.outcome.closed')}`]);
  assert.deepEqual(seen['Still open'], ['Run Club · you voted yes'], 'an unmerged promoted row is still open');
});
