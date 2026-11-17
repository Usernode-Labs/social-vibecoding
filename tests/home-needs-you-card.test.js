'use strict';

// Home's Needs you card: the second card of Home's side column, under the
// New project card, from 1280px.
//
//   1. It is drawn only while a vote waits on the viewer (the count Home's
//      Needs you tile and the tab badge read), and it is one link to Needs
//      you (`#needs`).
//   2. Its numbers come from the Needs you feed, read only where the column
//      is displayed: how many votes decide, how many are advisory, and the
//      communities that wait.
//   3. Zero says nothing: no advisory part when there is none.
//
// Run with: node --test tests/home-needs-you-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const CARD = 'frontend/src/features/home/needs-you-card.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const item = (id, slug, extra = {}) => ({
  kind: 'proposal', id, title: `Change ${id}`, app: { slug, name: slug.toUpperCase() }, ...extra,
});

test('the island mounts it under Standard (WIP), in the row it shares with Challenges', () => {
  const island = read('frontend/src/features/home/index.tsx');
  assert.match(island, /const aside = wip && grid\.ready && !!grid\.create;/);
  assert.match(island, /\{wip \? \(\s*<div id="home-row" className="home-row">\s*\{aside \? \(\s*<aside id="home-aside" className="home-aside">\s*<NeedsYouCard \/>\s*<\/aside>\s*\) : null\}\s*<ChallengesSection \/>\s*<\/div>\s*\) : null\}/);
  assert.match(island, /\{wip \? null : <ChallengesSection \/>\}/, 'every other look keeps Challenges in its own place');
  // Beside Challenges from 1280px at the card's own width; narrower, a row
  // of its own as wide as the column.
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin-wip\] \.home-row > \.home-aside > \* \{ flex: 0 0 auto; width: var\(--wip-needs-w\); \}/);
  assert.match(css, /html\[data-skin-wip\] \.home-row > \.home-aside > \* \{ flex: 1 1 auto; min-width: 0; \}/);
});

test('the card is one link to Needs you, drawn from the waiting count', () => {
  const src = read(CARD);
  assert.match(src, /const \{ badgeNeeds \} = useStoreState\(communityScopeStore\)/);
  assert.match(src, /if \(!summary\) return null;/);
  assert.match(src, /<section id="home-needs-card" aria-labelledby="home-needs-card-title" data-needs=\{String\(summary\.total\)\}>/);
  assert.match(src, /<a id="home-needs-card-btn" href="#needs" className=\{CARD\}>/);
  assert.equal(message('home:needsCard.eyebrow'), 'Needs you');
  assert.equal(message('home:needsCard.waiting_one'), '{{count}} decision waiting for your vote');
  assert.equal(message('home:needsCard.waiting_other'), '{{count}} decisions waiting for your vote');
});

test('the feed is read at every width, and again when the count moves', () => {
  const src = read(CARD);
  assert.doesNotMatch(src, /matchMedia/, 'the card is drawn at every width, so nothing waits on one');
  assert.match(src, /if \(!waiting\) \{ setFeed\(null\); return undefined; \}/, 'nothing waits: nothing is read');
  assert.match(src, /sharedJson<\{ items\?: NeedsCardItem\[\] \}>\(`\/api\/workshop\/needs-feed\$\{demoQuery\(\)\}`, \{ fresh: true \}\)/);
  assert.match(src, /\}, \[waiting\]\);/);
});

test('the numbers: the count until the feed is read, then the feed\'s own split', () => {
  const { needsSummary, decides } = loadTsx(CARD);
  assert.equal(needsSummary(0, null), null, 'nothing waits: no card');
  assert.deepEqual(needsSummary(3, null), { total: 3, decide: 0, advisory: 0 }, 'the count alone, before the feed');
  assert.equal(needsSummary(3, []), null, 'a feed that came back empty: nothing to open');
  const feed = [item(1, 'a'), item(2, 'a', { advisory: true }), item(3, 'b', { uncounted: true }), item(4, 'c')];
  assert.deepEqual(needsSummary(9, feed), { total: 4, decide: 2, advisory: 2 }, 'the two parts add up to the total');
  assert.equal(decides(feed[0]), true);
  assert.equal(decides(feed[1]), false, 'outside the deciders');
  assert.equal(decides(feed[2]), false, 'a vote recorded but not counted');
});

test('the icons are the communities that wait: once each, in order, four at most', () => {
  const { waitingApps } = loadTsx(CARD);
  const feed = [item(1, 'a'), item(2, 'a'), item(3, 'b'), { kind: 'question', id: 4, title: 'q', app: null },
    item(5, 'c'), item(6, 'd'), item(7, 'e')];
  assert.deepEqual(waitingApps(feed).map((app) => app.slug), ['a', 'b', 'c', 'd']);
  assert.deepEqual(waitingApps(null), []);
});

test('zero says nothing: the advisory part is drawn only when there is one', () => {
  const src = read(CARD);
  assert.match(src, /\{summary\.advisory \? \(\s*<>\s*\{' · '\}\s*<RichMessage\s+id="home:needsCard\.advisory"/);
  assert.match(message('home:needsCard.decide_one'), /<0>\{\{count\}\}<\/0> decides/);
  assert.match(message('home:needsCard.decide_other'), /<0>\{\{count\}\}<\/0> decide$/);
});
