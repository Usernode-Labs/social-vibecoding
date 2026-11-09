// GET /api/workshop/live-feed: what went live in the last seven days in the
// communities the viewer is a member of, newest first. Home's side column
// in the one frame reads it ("Live this week",
// frontend/src/features/home/frame/home-frame.tsx). Read-only, and the same
// visibility rules as the Needs you feed beside it.
//
// Run with: node --test tests/workshop-live-feed.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const overview = require('../src/routes/workshop-overview');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'workshop-overview.js'), 'utf8');

test('the query is the viewer\'s communities, this week, newest first, bounded', () => {
  const sql = overview.LIVE_FEED_SQL;
  assert.match(sql, /FROM chat_sessions cs/);
  assert.match(sql, /cs\.status = 'merged'/, 'only what went live');
  assert.match(sql, /COALESCE\(cs\.merged_at, cs\.created_at\) > NOW\(\) - INTERVAL '7 days'/, 'this week; merged_at is null on old rows');
  assert.match(sql, /EXISTS \(SELECT 1 FROM community_members cm\s+WHERE cm\.community_id = a\.community_id AND cm\.user_id = \$1\)/, 'a member\'s communities only');
  // The SAME visibility filter as the counts and feeds beside it
  // (VISIBLE_APP_WHERE over `a` and the viewer's membership row `me`), not a
  // copy of part of it: a private project's changes reach only its
  // collaborators and admins, a suspended one nobody.
  assert.match(sql, /LEFT JOIN app_collaborators me\s+ON me\.app_id = a\.id AND me\.user_id = \$1 AND me\.status = 'member'/);
  assert.match(sql, /a\.moderation_suspended_at IS NULL/, 'never a suspended project');
  assert.match(sql, /\(NOT a\.self_hosted OR \$2::boolean\)/, 'the platform\'s own project by the shared rule');
  assert.match(sql, /\(\$3::boolean OR a\.view_visibility = 'public' OR me\.user_id IS NOT NULL\)/, 'a private project only for its collaborators, or an admin');
  assert.match(SRC, /const LIVE_FEED_SQL = `[^`]*\$\{VISIBLE_APP_WHERE\}/, 'written with the shared filter itself');
  assert.match(sql, /ORDER BY COALESCE\(cs\.merged_at, cs\.created_at\) DESC, cs\.id DESC\s+LIMIT \$4/);
  assert.equal(overview.LIVE_FEED_MAX, 8);
});

test('a row is shaped as the feed beside it shapes its project', () => {
  const [row, bare] = overview.shapeLiveFeed([
    { id: 7, pr_number: 6412, pr_title: 'Penalty shoot-out mode', at: new Date('2026-11-09T10:00:00Z'), author: 'Bruno', slug: 'goal', name: 'GOAL!', icon_image_id: 'abc', icon_emoji: null },
    { id: 8, pr_number: null, pr_title: null, at: '2026-11-08T10:00:00Z', author: null, slug: 'solo', name: 'Solo', icon_image_id: null, icon_emoji: '🎮' },
  ]);
  assert.deepEqual(row, {
    id: 7, number: 6412, title: 'Penalty shoot-out mode', at: '2026-11-09T10:00:00.000Z', author: 'Bruno',
    app: { slug: 'goal', name: 'GOAL!', icon_url: '/app-icons/abc', icon_emoji: null },
  });
  assert.deepEqual(bare, {
    id: 8, number: null, title: null, at: '2026-11-08T10:00:00.000Z', author: null,
    app: { slug: 'solo', name: 'Solo', icon_url: null, icon_emoji: '🎮' },
  });
});

test('the route answers a signed-in viewer, with the four parameters in the query\'s order', () => {
  const at = SRC.indexOf("router.get('/api/workshop/live-feed'");
  assert.ok(at > 0, 'the route is registered');
  const body = SRC.slice(at, SRC.indexOf('\n  });', at));
  assert.match(body, /if \(!req\.user\?\.id\) return res\.status\(401\)\.json\(\{ error: 'Not authenticated' \}\);/);
  assert.match(body, /pool\.query\(LIVE_FEED_SQL, \[req\.user\.id, !!req\.user\.isAdmin \|\| !!config\.selfAppPublicVoting, !!req\.user\.isAdmin, LIVE_FEED_MAX\]\)/,
    'viewer, may-see-self-hosted, is-admin, bound: the shared filter\'s own parameters');
  assert.match(body, /res\.json\(\{ items: shapeLiveFeed\(rows\) \}\)/);
  assert.match(body, /res\.status\(500\)\.json\(\{ error: 'Internal server error' \}\)/);
});
