'use strict';

// #4772: THE VIEWER'S CONVERSATIONS WITH HOMEROOM BOT, under Your work on a
// project's hub. A change where this viewer and the bot have both written in
// the change's discussion lately gets a row in the For you card — its title,
// "With Homeroom bot", who spoke last and when — opening that change. Only
// the viewer's own conversations, only open changes, at most three, nothing
// at all with none.
//
// Run with: node --test tests/hub-bot-talks.test.js
// The query itself runs against a real database in
// tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HUB = 'frontend/src/features/dev-board/workshop/hub-cards.tsx';

const communities = require('../src/services/communities');

// The fake pool records what the service asked for and hands back the rows
// given, so the test pins the query's shape without a database.
function fakePool(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows }; },
  };
}

test('botTalks asks for the change threads both sides wrote in, and shapes the rows', async () => {
  const pool = fakePool([
    { session_id: 12, pr_number: 34, title: 'Dark mode', last_at: '2026-10-12T07:00:00Z', bot_last: true },
    { session_id: 13, pr_number: null, title: null, last_at: '2026-10-11T07:00:00Z', bot_last: false },
  ]);
  const rows = await communities.botTalks(pool, 7, 2, 3);
  assert.deepEqual(rows, [
    { session_id: 12, pr_number: 34, title: 'Dark mode', last_at: '2026-10-12T07:00:00Z', bot_last: true },
    { session_id: 13, pr_number: null, title: null, last_at: '2026-10-11T07:00:00Z', bot_last: false },
  ], 'a null PR and a null title survive as nulls, bot_last as a boolean');
  assert.equal(pool.calls.length, 1, 'one query');
  const { sql, params } = pool.calls[0];
  assert.match(sql, /thread_type = 'session'/, 'only the change thread itself, not a reply thread under one message');
  assert.match(sql, /msg_type = 'message'/, 'system lines say nothing');
  assert.match(sql, /deleted_at IS NULL/, 'a taken-back message says nothing');
  assert.match(sql, /moderation_hidden_at IS NULL/, 'a hidden message says nothing');
  assert.match(sql, /t\.mine_at IS NOT NULL AND t\.bot_at IS NOT NULL/, 'a conversation is both sides');
  assert.match(sql, /make_interval\(days => \$4::int\)/, 'the window is a parameter, not text into the SQL');
  assert.match(sql, /status = ANY\(\$5::text\[\]\)/, 'the open statuses are a parameter');
  assert.match(sql, /ORDER BY last_at DESC/, 'newest conversation first');
  assert.deepEqual(params, [7, 2, 3, 3, ['active', 'paused', 'promoted', 'merging'], 3],
    'the app, both writers, the three-day window, the open statuses, and the cap of three');
});

test('botTalks has nothing to ask with no viewer, no bot, or the viewer being the bot', async () => {
  const pool = fakePool([]);
  assert.deepEqual(await communities.botTalks(pool, 7, null, 3), [], 'a guest has nobody to have talked with');
  assert.deepEqual(await communities.botTalks(pool, 7, 2, null), [], 'no bot account, no conversation');
  assert.deepEqual(await communities.botTalks(pool, null, 2, 3), [], 'no app, nothing to read');
  assert.deepEqual(await communities.botTalks(pool, 7, 2, 2), [], 'nobody talks with themself');
  assert.equal(pool.calls.length, 0, 'returned [] straight away, without a query');
});

test('the community route adds bot_talks best-effort, never a failed hub', () => {
  const apps = read('src/routes/apps.js');
  assert.match(apps, /const bot = await botDm\.botAccount\(pool\);/, 'the bot is the synthetic user');
  assert.match(apps, /botTalks = await communities\.botTalks\(pool, app\.id, req\.user\.id, bot\?\.id \|\| null\);/,
    'the viewer’s own conversations, on the app being read');
  assert.match(apps, /bot_talks: botTalks,/, 'the response carries them');
  assert.match(apps,
    /let botTalks = \[\];[\s\S]{0,600}?if \(req\.user\?\.id\) \{[\s\S]{0,600}?try \{[\s\S]{0,600}?\} catch \(err\) \{[\s\S]{0,600}?Could not read the bot conversations for the hub/,
    'a read that fails is no rows, never a failed hub');
  assert.match(apps, /if \(req\.user\?\.id\) \{[\s\S]{0,400}?botAccount/, 'a guest costs no bot lookup at all');
});

test('the For you card draws the With Homeroom bot rows between Your work and the Discussion', () => {
  const { ForYouCard } = loadTsx(HUB);
  const card = (data, over = {}) => renderToHtml(createElement(ForYouCard, {
    slug: 'garden', name: 'Garden', queue: [], mine: null, workEmpty: null, alone: false, canPost: true,
    onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {}, data, ...over,
  }));
  const talks = [
    { session_id: 12, pr_number: 34, title: 'Show the meeting date on each book', last_at: '2026-10-12T07:00:00Z', bot_last: true },
    { session_id: 13, pr_number: null, title: 'Sort the reading list by author', last_at: '2026-10-11T07:00:00Z', bot_last: false },
  ];
  // Your work has something in flight, so the three rows can be seen in
  // order in one rendering.
  const mine = { viewer: true, rows: [{ t: 'card', key: 's1', card: { title: { text: 'Dark mode for the reader' } } }] };
  const html = card({
    bot_talks: talks,
    channel: {
      last_message: 'See you Sunday', last_at: '2026-10-12T06:00:00Z', last_by: 'lin', unread_count: 0,
      recent: [], href: '#messages/app/garden', handle: null,
    },
  }, { mine });
  const rows = [...html.matchAll(/data-ws-bot-talk="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['12', '13'], 'one row per conversation, newest first');
  // The rows sit in Your work's card: after Your work's row, before the Discussion's.
  const mineAt = html.indexOf('data-ws-mine-card');
  const first = html.indexOf('data-ws-bot-talk');
  const channel = html.indexOf('data-ws-channel=');
  assert.ok(mineAt > -1 && first > mineAt && channel > first, 'after Your work, before the Discussion');
  // Each row is a door to its change, and says who spoke last.
  assert.match(html, /href="#app\/garden\/dev\/changes\/34"[^>]*data-ws-bot-talk="12"/, 'a change with a pull request opens it by number');
  assert.match(html, /href="#app\/garden\/dev\/proposals\/13"[^>]*data-ws-bot-talk="13"/, 'one without opens by session');
  assert.match(html, />Show the meeting date on each book</, 'the change’s title first');
  assert.match(html, new RegExp(`<span data-ws-bot-talk-last="">${
    message('project:hub.forYou.bot.botLast').replace('{{ago}}', '[^<]+')}</span>`), 'the bot spoke last');
  assert.match(html, new RegExp(`<span data-ws-bot-talk-last="">${
    message('project:hub.forYou.bot.youLast').replace('{{ago}}', '[^<]+')}</span>`), 'the viewer spoke last');
  assert.doesNotMatch(html, /dev-ws-foryou-pill[^>]*data-ws-bot-talk|data-ws-bot-talk[^>]*>.*?dev-ws-foryou-pill/,
    'no pill on the row');
  assert.equal((html.match(/data-ws-bot-talk="/g) || []).length, 2);
  // None: nothing drawn, and the card stands without it.
  assert.doesNotMatch(card({}), /data-ws-bot-talk/, 'no conversations, no rows');
  assert.doesNotMatch(card({ bot_talks: [] }), /data-ws-bot-talk/);
  // Only the conversations, nothing else on the card: the rows alone are
  // enough to raise it.
  const only = card({ audience: 'solo', audience_label: 'Just you', channel: null, bot_talks: talks }, { alone: true });
  assert.match(only, /data-ws-hub-for-you=""/, 'the card still stands');
  assert.match(only, /data-ws-bot-talk="12"/);
  assert.doesNotMatch(only, /data-ws-channel=/, 'no Discussion row on a project that is just yours');
  assert.doesNotMatch(only, /data-ws-mine-card/, 'no Your work row for a viewer with nothing in flight');
});

test('the hub draws at most three, whatever the server sent', () => {
  const { ForYouCard } = loadTsx(HUB);
  const talks = [1, 2, 3, 4, 5].map((n) => ({
    session_id: n, pr_number: n, title: `Change ${n}`, last_at: '2026-10-12T07:00:00Z', bot_last: true,
  }));
  const html = renderToHtml(createElement(ForYouCard, {
    slug: 'garden', name: 'Garden', queue: [], mine: null, workEmpty: null, alone: false, canPost: true,
    onNeeds: () => {}, onWork: () => {}, onDiscussion: () => {}, data: { bot_talks: talks },
  }));
  assert.equal((html.match(/data-ws-bot-talk="/g) || []).length, 3, 'three rows, no more');
});
