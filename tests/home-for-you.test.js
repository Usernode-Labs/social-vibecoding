'use strict';

// #6650: Home's For you column (frontend/src/features/home/for-you.tsx) and
// the two reads behind it (src/services/home-for-you.js,
// src/routes/home-for-you.js). Pinned here:
//
//   1. the activity shaper keeps only communities with news, busiest first,
//      draws three and counts the rest, and says since when it counted;
//   2. the work shaper rounds points and takes Profile's own counts;
//   3. the staging demo fills an empty card and never covers real data;
//   4. the routes answer signed-in viewers only, and Mark all read is a
//      same-origin POST;
//   5. the cards render what they are given: the slots line in both states,
//      the Needs you split and its next two, the activity rows with only the
//      kinds that happened, and the Your work rows;
//   6. Home's layout: the column comes first in the markup inside the
//      reversed .home-split, and the content keeps its areas as siblings.
//
// Run with: node --test tests/home-for-you.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const FOR_YOU = 'frontend/src/features/home/for-you.tsx';
const svc = require('../src/services/home-for-you');

test('activity: only communities with news, busiest first, three drawn and the rest counted', () => {
  const rows = [
    { slug: 'a', name: 'Alpha', messages: 1, merged: 0, requests: 0, since: '2026-11-10T00:00:00Z' },
    { slug: 'b', name: 'Beta', messages: 0, merged: 0, requests: 0, since: '2026-11-10T00:00:00Z' },
    { slug: 'c', name: 'Gamma', messages: 2, merged: 2, requests: 0, since: '2026-11-10T00:00:00Z' },
    { slug: 'd', name: 'Delta', messages: 0, merged: 0, requests: 3, since: '2026-11-10T00:00:00Z' },
    { slug: 'e', name: 'Epsilon', messages: 1, merged: 0, requests: 0, since: '2026-11-10T00:00:00Z', icon_image_id: 'abc_1' },
  ];
  const body = svc.shapeActivity(rows);
  assert.equal(body.since, '2026-11-10T00:00:00.000Z');
  assert.deepEqual(body.communities.map((c) => c.slug), ['c', 'd', 'a']);
  assert.equal(body.more, 1, 'Epsilon has news but no room');
  assert.deepEqual(body.communities[0], {
    slug: 'c', name: 'Gamma', iconUrl: null, iconEmoji: null, iconColor: null, messages: 2, merged: 2, requests: 0,
  });
  // Ties keep the name order.
  assert.deepEqual(svc.shapeActivity(rows, { limit: 5 }).communities.map((c) => c.slug), ['c', 'd', 'a', 'e']);
  assert.equal(svc.shapeActivity(rows, { limit: 5 }).communities[3].iconUrl, '/app-icons/abc_1');
});

test('activity: no rows reads the default window, and nothing is drawn', () => {
  const now = Date.parse('2026-11-13T09:00:00Z');
  const body = svc.shapeActivity([], { now });
  assert.deepEqual(body, { since: '2026-11-06T09:00:00.000Z', communities: [], more: 0 });
  assert.equal(svc.DEFAULT_WINDOW_DAYS, 7);
});

test('activity: the SQL counts unread by the chat\'s own rule, since the last look, among member communities', () => {
  const sql = svc.ACTIVITY_SQL;
  assert.match(sql, /FROM home_activity_seen WHERE user_id = \$1/);
  assert.match(sql, /FROM community_members m/);
  assert.match(sql, /c\.thread_type IS NULL/);
  assert.match(sql, /c\.id > rc\.last_read_message_id/);
  assert.match(sql, /c\.deleted_at IS NULL/);
  assert.match(sql, /user_blocks blocked/);
  assert.match(sql, /s\.status = 'merged' AND s\.live_at IS NOT NULL/);
  assert.match(sql, /q\.created_by IS DISTINCT FROM \$1/);
  assert.match(read('src/db/migrations/home-activity-seen.sql'), /COMMENT ON TABLE home_activity_seen IS 'staging:private'/);
});

test('work: points rounded, Profile\'s counts reused', () => {
  const body = svc.shapeWork(
    { points: '1240.4', points_week: '180.6', changes_waiting: 3, votes_cast: 48 },
    { summary: { proposals_total: 12 }, requests: { total: 5, done: 3 } },
  );
  assert.deepEqual(body, {
    points: 1240, pointsWeek: 181,
    changes: { total: 12, waiting: 3 },
    requests: { total: 5, open: 2 },
    votes: { cast: 48 },
  });
  assert.deepEqual(svc.shapeWork(null), {
    points: 0, pointsWeek: 0, changes: { total: 0, waiting: 0 }, requests: { total: 0, open: 0 }, votes: { cast: 0 },
  });
  const profile = require('../src/routes/profile');
  assert.equal(typeof profile.SUMMARY_COUNTS_SQL, 'string');
  assert.equal(typeof profile.MY_REQUEST_COUNTS_SQL, 'string');
});

test('demo: fills an empty card, never covers real data', () => {
  const empty = svc.withDemoActivity({ since: '2026-11-10T00:00:00.000Z', communities: [], more: 0 });
  assert.equal(empty.communities.length, 3);
  assert.ok(empty.communities.every((c) => c.name.startsWith('[Sample]')));
  const real = { since: 'x', communities: [{ slug: 'mine', name: 'Mine', messages: 1, merged: 0, requests: 0 }], more: 0 };
  assert.equal(svc.withDemoActivity(real), real);

  assert.equal(svc.withDemoWork(svc.shapeWork(null)).points, 1240);
  const mine = svc.shapeWork({ points: 5 });
  assert.equal(svc.withDemoWork(mine), mine);
});

test('routes: signed in only, and Mark all read is a same-origin POST', async () => {
  const express = require('express');
  const { homeForYouRoutes } = require('../src/routes/home-for-you');
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO home_activity_seen/.test(sql)) return { rows: [{ seen_at: '2026-11-13T09:00:00Z' }] };
      return { rows: [] };
    },
  };
  const app = express();
  app.use((req, _res, next) => { req.user = req.headers['x-user'] ? { id: Number(req.headers['x-user']) } : null; next(); });
  app.use(homeForYouRoutes({}, { pool, staging: false }));
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/me/home-activity`)).status, 401);
    assert.equal((await fetch(`${base}/api/me/home-work`)).status, 401);

    const activity = await fetch(`${base}/api/me/home-activity`, { headers: { 'x-user': '7' } });
    assert.equal(activity.status, 200);
    assert.equal(activity.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await activity.json()).communities, []);

    const seen = await fetch(`${base}/api/me/home-activity/seen`, {
      method: 'POST', headers: { 'x-user': '7', 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(seen.status, 200);
    assert.equal((await seen.json()).since, '2026-11-13T09:00:00.000Z');
    assert.ok(calls.some((c) => /INSERT INTO home_activity_seen/.test(c.sql) && c.params[0] === 7));

    const cross = await fetch(`${base}/api/me/home-activity/seen`, {
      method: 'POST', headers: { 'x-user': '7', 'sec-fetch-site': 'cross-site' },
    });
    assert.notEqual(cross.status, 200, 'a cross-site POST does not mark anything read');
  } finally {
    server.close();
  }
});

test('the slots line: how many are left, or a way to ask for more', () => {
  const two = renderComponent(FOR_YOU, 'SlotsLine', { allowance: { quota: { used: 1, limit: 3, remaining: 2 } } });
  assert.match(two, /data-home-slots="2"/);
  assert.match(two, /<b[^>]*>2<\/b> project slots available/);
  const one = renderComponent(FOR_YOU, 'SlotsLine', { allowance: { quota: { used: 2, limit: 3, remaining: 1 } } });
  assert.match(one, /<b[^>]*>1<\/b> project slot available/);
  const none = renderComponent(FOR_YOU, 'SlotsLine', { allowance: { quota: { used: 3, limit: 3, remaining: 0 } } });
  assert.match(none, /No project slots left\./);
  assert.match(none, /<a href="#profile\?slots"[^>]*>Request project slots<\/a> to build your own ideas\./);
  assert.equal(renderComponent(FOR_YOU, 'SlotsLine', { allowance: null }), '');
  assert.equal(renderComponent(FOR_YOU, 'SlotsLine', { allowance: { quota: { used: 9, limit: null, remaining: null } } }), '', 'no limit, no line');
});

test('Needs you: the feed decides the numbers, so the bar, the tags and the count agree', () => {
  const { needsSplit, isAdvisory } = loadTsx(FOR_YOU);
  const items = [
    { kind: 'proposal', id: 1, title: 'Widen every page', app: { slug: 'bio', name: 'Biomarkers' } },
    { kind: 'proposal', id: 2, title: 'Second', advisory: true, app: { slug: 'x', name: 'X' } },
    { kind: 'governance', id: 3, title: 'Third', app: { slug: 'y', name: 'Y' } },
    { kind: 'proposal', id: 4, title: 'Fourth', uncounted: true, app: { slug: 'z', name: 'Z' } },
  ];
  // Before the feed: the badge's count, all deciding.
  assert.deepEqual(needsSplit(null, 9), { count: 9, decide: 9, advisory: 0, next: [] });
  // After it: the feed is the one source, whatever the badge said (the
  // screenshot of #6650's first cut read "0 decide, 9 advisory" over two rows
  // tagged Decides, a badge of 9 against a feed with more advisory items).
  const split = needsSplit(items, 9);
  assert.equal(split.count, 4);
  assert.equal(split.decide, 2);
  assert.equal(split.advisory, 2);
  assert.equal(split.next.length, 2);
  assert.equal(isAdvisory(items[3]), true, 'a vote recorded but not counted is not one that decides');

  const html = renderComponent(FOR_YOU, 'NeedsCardView', { count: 13, items });
  assert.match(html, /id="home-needs-card"/);
  assert.match(html, /data-home-needs="4"/);
  assert.match(html, /Decisions waiting for your vote/);
  assert.match(html, /<b[^>]*>2<\/b> decide/);
  assert.match(html, /<b[^>]*>2<\/b> advisory/);
  assert.match(html, /Widen every page/);
  assert.match(html, />Decides</);
  assert.match(html, />Advisory</);
  assert.doesNotMatch(html, /Third/, 'only the next two');
  assert.match(html, /<a href="#needs" id="home-needs-review"[^>]*>Start reviewing · 4<\/a>/);
  assert.equal(renderComponent(FOR_YOU, 'NeedsCardView', { count: 3, items: [] }), '', 'an empty feed draws no card');
});

test('New in your communities: what happened, only the kinds that did', () => {
  const { activityParts } = loadTsx(FOR_YOU);
  assert.deepEqual(activityParts({ messages: 2, merged: 0, requests: 1 }), [
    { kind: 'messages', count: 2 }, { kind: 'requests', count: 1 },
  ]);
  const html = renderComponent(FOR_YOU, 'ActivityCardView', {
    communities: [
      { slug: 'oath', name: 'Oath of Ember', messages: 2, merged: 0, requests: 0 },
      { slug: 'home', name: 'Homeroom', messages: 1, merged: 1, requests: 0 },
    ],
    more: 2,
    onMarkRead() {},
  });
  assert.match(html, /New in your communities/);
  assert.match(html, /Activity since your last visit/);
  assert.match(html, /id="home-activity-read"[^>]*>Mark all read</);
  assert.match(html, /href="\/app\/oath\/workshop"/);
  assert.match(html, /2 new messages/);
  assert.match(html, /1 change went live/);
  assert.match(html, /data-activity-kind="merged"/);
  assert.match(html, /1 new message</);
  assert.doesNotMatch(html, /data-activity-kind="requests"/);
  assert.match(html, /2 more communities have news\./);
});

test('Your work: points, this week, and where each count stands', () => {
  const html = renderComponent(FOR_YOU, 'WorkCardView', {
    work: { points: 1240, pointsWeek: 180, changes: { total: 12, waiting: 3 }, requests: { total: 5, open: 2 }, votes: { cast: 48 } },
    owed: 13,
  });
  assert.match(html, /Your work/);
  assert.match(html, /1,240/);
  assert.match(html, /\+180 this week/);
  assert.match(html, /3 waiting for a vote/);
  assert.match(html, /2 still open/);
  assert.match(html, /13 more need you/);
  assert.match(html, /href="#profile\?tab=changes"/);
  assert.match(html, /href="#profile\?tab=requests"/);
  assert.match(html, /href="#profile\?tab=votes"/);
  // Nothing this week, nothing said.
  const quiet = renderComponent(FOR_YOU, 'WorkCardView', {
    work: { points: 10, pointsWeek: 0, changes: { total: 0, waiting: 0 }, requests: { total: 0, open: 0 }, votes: { cast: 0 } },
    owed: 0,
  });
  assert.doesNotMatch(quiet, /this week/);
  assert.doesNotMatch(quiet, /waiting for a vote|still open|need you/);
});

test('the column ships hidden and holds Challenges; Home lays it out first in a reversed row', () => {
  const html = renderComponent(FOR_YOU, 'HomeForYou', {});
  assert.match(html, /^<aside id="home-for-you" class="home-for-you" hidden="" aria-label="For you">/);
  assert.match(html, /id="home-challenges-section"/);
  assert.doesNotMatch(html, /home-new-project|home-needs-card|home-activity-card|home-work-card/, 'nothing signed-in in the prerender');

  const index = read('frontend/src/features/home/index.tsx');
  const split = index.indexOf('<div className="home-split">');
  assert.ok(split > 0);
  assert.ok(index.indexOf('<HomeForYou />', split) < index.indexOf('<div className="home-main">', split), 'the column comes first');
  assert.doesNotMatch(index, /<ChallengesSection \/>/, 'Challenges lives in the column now');
  const css = read('public/css/app.css');
  assert.match(css, /\.home-split \{[^}]*flex-direction: row-reverse;[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.home-for-you:not\(\[hidden\]\) \{[^}]*display: grid;/);
  assert.match(css, /\.home-main > section:not\(\[hidden\]\) ~ \.home-section-rule:not\(\[hidden\]\)/);
});
