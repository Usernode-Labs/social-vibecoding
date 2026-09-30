'use strict';

// Follow-ups to the communities hub (#3269, #3270, #3271; #3268 alongside):
//
//   - the Communities screen's "Show N more" reveals five at a time
//     (features/workshop/index.tsx sectionFold, pinned in
//     tests/workshop-screen.test.js);
//   - its Needs you tab is one feed of every decision owed, mixed across
//     projects, one card per screen (features/workshop/needs-reel.tsx, GET
//     /api/workshop/needs-feed in src/routes/workshop-overview.js);
//   - on a phone its all-apps chip is the header's title
//     (features/header/header-title.tsx).
//
// The feed's query is run against a real schema in
// tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const route = require('../src/routes/workshop-overview');

test('#3270: the feed card helpers say what a card shows and where it goes', () => {
  const reel = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
  const app = { slug: 'my garden', name: 'Garden', icon_url: null, icon_emoji: null };
  assert.equal(reel.reelHref({ kind: 'proposal', id: 8, app }), '#app/my%20garden/dev/proposals/8');
  assert.equal(reel.reelHref({ kind: 'governance', id: 9, app }), '#app/my%20garden/dev/governance/9');
  assert.equal(reel.plainSummary('## What\n\n- Adds **rating** sort\n- See [the docs](https://x.y)\n\n```js\nx()\n```'),
    'What Adds rating sort See the docs', 'a paragraph, not a document');
  assert.equal(reel.plainSummary(null), '');
  assert.equal(reel.tallyLine({ yes: 2, no: 1 }), '2 yes · 1 no');
  assert.equal(reel.tallyLine({ yes: 3, no: 0 }), '3 yes', 'a zero says nothing');
  assert.equal(reel.tallyLine({ yes: 0, no: 0 }), '');
  assert.equal(reel.tallyLine({ yes: null, no: null }), '');
});

test('#3270: a change is voted on its card with the platform\'s own vote and its epoch', () => {
  const src = read('frontend/src/features/workshop/needs-reel.tsx');
  assert.match(src, /ok = !!\(await view\.castVote\(item\.id, vote, item\.epoch\)\);/,
    'AppView.castVote: the approval epoch, the line on a No, the Join on a refusal');
  assert.match(src, /setVoted\(\(v\) => \(\{ \.\.\.v, \[key\]: vote \}\)\);\s*next\(/, 'the card stays and says so, and the feed moves on');
  assert.match(src, /scroll-snap|role="feed"/);
  const css = read('public/css/app.css');
  assert.match(css, /\.workshop-reel \{[^}]*scroll-snap-type: y mandatory;/);
  assert.match(css, /\.workshop-reel-card \{[^}]*flex: 0 0 100%;[^}]*scroll-snap-align: start;/, 'one card per screen');
});

test('#3270: the feed reads the owed populations for member projects only, newest first, bounded', () => {
  const sql = route.NEEDS_FEED_SQL;
  assert.match(sql, /EXISTS \(SELECT 1 FROM community_members cm\s+WHERE cm\.community_id = a\.community_id AND cm\.user_id = \$1\)/,
    'a vote is a member\'s, so the feed is the viewer\'s projects');
  assert.match(sql, /ORDER BY o\.at DESC NULLS LAST, o\.id DESC\s+LIMIT \$4/, 'mixed by recency, not grouped by project');
  assert.match(sql, /cs\.approval_epoch AS epoch/);
  assert.ok(route.NEEDS_FEED_MAX > 0 && route.NEEDS_FEED_MAX <= 100);
  const shaped = route.shapeNeedsFeed([{
    slug: 'garden', name: 'Garden', icon_image_id: 'abc', icon_emoji: null,
    kind: 'proposal', id: '8', title: 'Sort', summary: '  ', author: 'ada', number: 12, epoch: 3,
    at: new Date('2026-09-20T10:00:00Z'), yes: 2, no: 0,
  }]);
  assert.deepEqual(shaped, [{
    kind: 'proposal', id: 8, title: 'Sort', summary: null, author: 'ada', number: 12, epoch: 3,
    at: '2026-09-20T10:00:00.000Z', yes: 2, no: 0,
    app: { slug: 'garden', name: 'Garden', icon_url: '/app-icons/abc', icon_emoji: null },
  }]);
  // ?demo=1 on staging: the real rows first, then the demo cards, never twice.
  const real = [{ kind: 'proposal', id: 1, app: { slug: 'x' } }];
  const merged = route.withDemoNeedsFeed(real);
  assert.equal(merged[0], real[0]);
  assert.equal(merged.length, 1 + route.DEMO_NEEDS_FEED.length);
  assert.ok(route.DEMO_NEEDS_FEED.every((it) => it.id < 0), 'a demo card can never vote on a real proposal');
  assert.ok(route.DEMO_NEEDS_FEED.some((it) => it.kind === 'governance'));
});

test('#3271: on a phone the Communities screen\'s header is its all-apps chip', () => {
  const header = read('frontend/src/features/header/header-title.tsx');
  assert.match(header, /const allAppsSwitcher = screen === 'workshop-screen' && phone;/);
  assert.match(header, /id="header-scope-switch"[\s\S]{0,400}aria-controls="community-switcher"[\s\S]{0,200}onClick=\{\(e\) => toggleSwitcher\('header', e\.currentTarget\)\}/,
    'the same switcher the in-page chip opens: Your communities (#852)');
  const css = read('public/css/app.css');
  assert.match(css, /@media \(max-width: 699\.98px\) \{\s*#workshop-screen #workshop-scope \{ display: none; \}\s*\}/,
    'and the in-page chip steps aside at the same width');
});
