'use strict';

// A PHONE GETS AROUND A COMMUNITY FROM ITS HUB (Evan, 3 Nov 2026: "lose one
// layer of sidebar").
//
// Under 768px a community's places were a drawer beside its page. The drawer
// is gone (tests/nav-drawer.test.js pins the header that is left): the Hub is
// how a phone reaches the places, and All communities, a grid of tiles, is
// where it switches community. These pin the two halves of that:
//
//   - the Hub's rows: For you's Workshop row, always there on a phone and
//     named for the place it opens, and a Topics card, a row a live topic,
//     each opening its channel (frontend/src/features/dev-board/workshop/
//     hub-cards.tsx TopicsCard, drawn by ./workshop.tsx on a phone only);
//   - All communities as a grid on a phone (frontend/src/features/workshop/
//     index.tsx CommunityTile), whose tile is a door to the Hub.
//
// Run with: node --test tests/phone-nav-hub-and-grid.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('on a phone the Hub lists every live topic, each a door to its channel', () => {
  const cards = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  const topics = cards.slice(cards.indexOf('export function TopicsCard('), cards.indexOf('/* ── The hub while it loads'));
  assert.match(topics, /const topics = liveTopics\(data\?\.places\);\s*if \(!topics\.length\) return null;/, 'a project with no topics draws no card');
  assert.match(topics, /onClick=\{\(\) => onOpen\(channelPlace\(topic\.handle\)\)\}/, 'a row opens the topic\'s channel');
  assert.match(topics, /data-ws-hub-topic=\{topic\.handle\}/);
  assert.match(topics, /<span className="dev-ws-foryou-handle">#\{topic\.handle\}<\/span>/, 'its #handle, as the Discussion row has #general');
  // One pill a row, and a zero says nothing.
  assert.match(topics, /trailing=\{unread \? \(/);
  assert.match(topics, /t\('project:hub\.channel\.unread', \{ count: unread, shown: unread > 99 \? '99\+' : String\(unread\) \}\)/);
  // The first few, then the rest behind "Show N more", as the sidebar folds them.
  assert.match(cards, /export const HUB_TOPICS_SHOWN = 6;/);
  assert.match(topics, /t\('project:places\.list\.showMore', \{ count: more \}\)/);
  assert.equal(message('project:hub.topics.title'), 'Topics');

  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /\{slug && drawerOn \? <TopicsCard data=\{community\} onOpen=\{\(key\) => openTab\(key\)\} \/> : null\}/,
    'on a phone only: a wide window lists the topics in its sidebar');
  assert.match(ws, /places=\{drawerOn\}\s*\/>/);
});

test('on a phone For you\'s Workshop row is always there, and named for the place it opens', () => {
  const cards = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  // 5 Nov 2026: a row of its own, beside Your work (which opens the Homeroom
  // bot tab, where your work is): the Workshop row was both until then.
  assert.match(cards, /\{places \? <WorkshopRow onOpen=\{onWork\} \/> : null\}/);
  assert.match(cards, /if \(!needs && !work && !places && !talk\) return null;/, 'there whenever the Hub is the way to the places');
  assert.match(cards, /title=\{placeName\('workshop'\)\}\s+subtitle=\{t\('project:hub\.workshop\.sub'\)\}/);
});

test('on a phone All communities is a grid of tiles, each a door to its Hub', () => {
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.match(screen, /phone \? \(\s*\/\*[\s\S]*?\*\/\s*<div className="grid grid-cols-4 gap-x-1 gap-y-4 px-3 pt-1" data-workshop-rows=\{pressed\} data-workshop-grid="">/,
    'four to a row, keeping the list\'s data attribute for the checks');
  assert.match(screen, /\{shown\.map\(\(row\) => <CommunityTile key=\{row\.slug\} row=\{row\} \/>\)\}/);
  const tile = screen.slice(screen.indexOf('export function CommunityTile('), screen.indexOf('/**\n * Four rows of the real geometry'));
  // A door to the Hub (AGENTS.md: a door calls AppView._landOnHub first).
  assert.match(tile, /win\.AppView\?\._landOnHub\?\.\(row\.slug\);[^\n]*\n\s*win\.App\?\.navigateToApp\?\.\(row\.slug, 'dev'\);/);
  assert.match(tile, /href=\{href\}/, 'an anchor with the hub\'s address, so a new tab opens it too');
  assert.match(tile, /data-workshop-app=\{row\.slug\}/);
  // The votes it waits on you for: a badge in the accent, said in words to a reader.
  assert.match(tile, /bg-violet-600 text-white/);
  assert.match(tile, /\{votes > 0 \? <span className="sr-only">\{t\('communities:row\.toVote', \{ count: votes \}\)\}<\/span> : null\}/);
  assert.doesNotMatch(tile, /\{votes\}\s*<\/span>\s*\) : \(/, 'a zero says nothing');
  // Settled after mount, so the first render is the prerender's list.
  assert.match(screen, /function usePhoneWidth\(\): boolean \{\s*const \[phone, setPhone\] = useState\(false\);/);
});
