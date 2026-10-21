'use strict';

// "Try it" from the Needs you feed: GET /api/workshop/needs-feed gives each
// proposal item `staging_url`, the change's live preview, exactly when the
// change's own card on its project offers one (the column /promoted hands
// the card; services/staging.js previewDisplayState calls a row with one
// 'ready'), and null otherwise. A group decision has no preview and carries
// no field. The ?demo=1 cards have no container, so theirs is null.
//
// The query itself runs against a real schema in
// tests/communities-postgres.test.js.
//
// Run with: node --test tests/needs-feed-staging-url.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const route = require('../src/routes/workshop-overview');
const { previewDisplayState } = require('../src/services/staging');

const row = (over = {}) => ({
  kind: 'proposal', id: 8, title: 'Sort', slug: 'garden', name: 'Garden', status: 'promoted',
  staging_url: null, ...over,
});

test('a proposal with a live preview carries its URL; one without carries null', () => {
  const [live, none, blank] = route.shapeNeedsFeed([
    row({ staging_url: 'https://garden--s8.onhomeroom.com' }),
    row({ id: 9 }),
    row({ id: 10, staging_url: '   ' }),
  ]);
  assert.equal(live.staging_url, 'https://garden--s8.onhomeroom.com');
  assert.equal(none.staging_url, null);
  assert.equal(blank.staging_url, null, 'an empty column is no preview');
  assert.ok('staging_url' in none, 'the field is always there on a proposal, null when there is nothing to try');
});

test('the rule is the card\'s: a URL is a ready preview, its absence is building, failed or unavailable', () => {
  // The project's own card reads previewDisplayState off the same column.
  assert.equal(previewDisplayState({ staging_url: 'https://x' }).preview_state, 'ready');
  assert.equal(previewDisplayState({ staging_url: null, check_state: 'pending', check_phase: 'building' }).preview_state, 'building');
  assert.equal(previewDisplayState({ staging_url: null, check_state: 'error', check_error_detail: 'boom' }).preview_state, 'failed');
  // A preview still building or failed gives the feed nothing to open.
  for (const over of [
    { check_state: 'pending', check_phase: 'building' },
    { check_state: 'error', check_error_detail: 'boom' },
  ]) assert.equal(route.shapeNeedsFeed([row(over)])[0].staging_url, null);
});

test('only a change up for a vote offers it, and a group decision carries no field', () => {
  assert.equal(route.shapeNeedsFeed([row({ status: 'merging', staging_url: 'https://x' })])[0].staging_url, null);
  const decision = route.shapeNeedsFeed([{ kind: 'governance', id: 5, title: 'Rename', slug: 'garden', staging_url: 'https://x' }])[0];
  assert.ok(!('staging_url' in decision));
});

test('the query reads the column for proposals and a typed NULL for decisions, in step', () => {
  const sql = route.NEEDS_FEED_SQL;
  assert.match(sql, /cs\.staging_url::text AS staging_url\s+FROM chat_sessions cs/);
  assert.match(sql, /NULL::text AS staging_url\s+FROM issues i/);
  assert.match(sql, /o\.requires_explicit_approval, o\.explicit_approval_reason, o\.staging_url,/);
  // Both halves of the UNION end on the same three columns, so a positional
  // mismatch cannot put a decision's payload where the URL goes.
  const [proposals, decisions] = sql.split('UNION ALL');
  assert.match(proposals, /explicit_approval_reason::text,[\s\S]*?staging_url\s+FROM chat_sessions/);
  assert.match(decisions, /explicit_approval_reason,\s+NULL::text AS staging_url\s+FROM issues/);
  assert.ok(route.NEEDS_FEED_MAX > 0, 'still bounded');
});

test('the ?demo=1 proposal cards have no preview to try', () => {
  const demo = route.DEMO_NEEDS_FEED.filter((it) => it.kind === 'proposal');
  assert.ok(demo.length > 0);
  for (const it of demo) assert.equal(it.staging_url, null, `${it.title}`);
  for (const it of route.DEMO_NEEDS_FEED.filter((x) => x.kind === 'governance')) assert.ok(!('staging_url' in it));
});
