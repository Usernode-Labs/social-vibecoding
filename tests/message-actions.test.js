'use strict';

// The acts on a message (#2387): one hover bar, one ⋯ menu, one emoji picker
// and one phone sheet, shared by Messages conversations and app channels
// (frontend/src/features/message-actions/). These run the REAL modules:
// the picker's search, the device's recent reactions, and the bar and the
// thread chip rendered to markup.
//
// Run with: node --test tests/message-actions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const DIR = 'frontend/src/features/message-actions';

test('the picker search finds an emoji by its name, every word of the query', () => {
  const { searchEmoji, emojiName, ALL_EMOJI, EMOJI_CATEGORIES } = loadTsx(`${DIR}/emoji-data.ts`);
  assert.equal(searchEmoji('thumbs up')[0].emoji, '👍');
  assert.ok(searchEmoji('heart').some((entry) => entry.emoji === '❤️'));
  assert.ok(searchEmoji('HEART  red').every((entry) => entry.terms.includes('heart') && entry.terms.includes('red')),
    'case and extra spaces do not matter, and every word must match');
  assert.deepEqual(searchEmoji('   '), [], 'an empty query is no results, not all of them');
  assert.equal(searchEmoji('face', 5).length, 5, 'the limit holds');
  assert.equal(emojiName('👍'), 'thumbs up');

  // One entry per emoji across the categories, each with the name the bar's
  // aria-label reads out.
  const seen = new Set();
  for (const entry of ALL_EMOJI) {
    assert.ok(!seen.has(entry.emoji), `${entry.emoji} is listed once`);
    seen.add(entry.emoji);
    assert.ok(entry.name && entry.terms.includes(entry.name.split(' ')[0]), `${entry.emoji} has a name it is found by`);
  }
  assert.ok(EMOJI_CATEGORIES.length >= 6);
});

test('recent reactions: the picker moves a pick to the front, and the bar always has three', () => {
  const store = new Map();
  global.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  try {
    const recents = loadTsx(`${DIR}/recents.ts`);
    const read = () => {
      let out = null;
      const Probe = () => { out = recents.useRecentReactions(); return null; };
      renderToHtml(createElement(Probe));
      return out;
    };
    // renderToStaticMarkup takes the server snapshot: the defaults, so a
    // prerender and the first client render agree.
    assert.deepEqual([...read()], ['👍', '❤️', '🙏']);

    recents.rememberReaction('🎉');
    assert.deepEqual(JSON.parse(store.get('usernode:recent-reactions')).slice(0, 4), ['🎉', '👍', '❤️', '🙏']);
    recents.rememberReaction('❤️');
    assert.deepEqual(JSON.parse(store.get('usernode:recent-reactions')).slice(0, 3), ['❤️', '🎉', '👍'],
      'a pick already in the list moves to the front rather than appearing twice');

    for (let i = 0; i < 30; i += 1) recents.rememberReaction(String.fromCodePoint(0x1F600 + i));
    assert.equal(JSON.parse(store.get('usernode:recent-reactions')).length, 16, 'at most sixteen are kept');

    // Whatever a previous version (or a hand) left in storage, the list is
    // strings, deduplicated, and topped up to three.
    store.set('usernode:recent-reactions', JSON.stringify(['🔥', 7, '', '🔥', null]));
    recents.resetRecentReactionsForTest();
    recents.rememberReaction('🔥');
    assert.deepEqual(JSON.parse(store.get('usernode:recent-reactions')), ['🔥', '👍', '❤️']);
  } finally {
    delete global.localStorage;
  }
});

test('the hover bar: three recents, the picker, reply, save and ⋯, in that order', () => {
  const { MessageActionBar } = loadTsx(`${DIR}/action-bar.tsx`);
  const noop = () => {};
  const html = renderToHtml(createElement(MessageActionBar, {
    className: 'messages-message-actions',
    recents: ['👍', '❤️', '🙏', '🎉'],
    reacted: (emoji) => emoji === '❤️',
    onReact: noop, onTogglePicker: noop, onReply: noop, onToggleSave: noop, onToggleMore: noop,
    saved: false,
  }));
  const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, [
    'Message actions',
    'React with thumbs up', 'Remove your red heart reaction', 'React with folded hands',
    'Add reaction', 'Reply', 'Save message', 'More actions',
  ]);
  assert.match(html, /role="toolbar"/);
  assert.match(html, /aria-label="More actions"[^>]*aria-haspopup="menu"|aria-haspopup="menu"[^>]*aria-label="More actions"/);
  assert.doesNotMatch(html, /🎉/, 'only three recents ride on the bar');

  const saved = renderToHtml(createElement(MessageActionBar, {
    className: 'x', recents: [], onToggleSave: noop, saved: true,
  }));
  assert.match(saved, /aria-pressed="true"[^>]*aria-label="Unsave message"/);
  assert.doesNotMatch(saved, /msgx-bar-divider/, 'no divider without the reactions it divides');

  const pending = renderToHtml(createElement(MessageActionBar, {
    className: 'x', recents: ['👍'], onReact: noop, hidden: true,
  }));
  assert.match(pending, /aria-hidden="true"/, 'a send in flight keeps the bar laid out but hidden');
});

test('the thread chip counts replies and says what it opens', () => {
  const { ThreadSummaryChip } = loadTsx(`${DIR}/thread-summary.tsx`);
  const one = renderToHtml(createElement(ThreadSummaryChip, { replyCount: 1, lastReplyAt: null, onOpen: () => {} }));
  assert.match(one, />1 reply</);
  assert.match(one, /aria-label="1 reply\. Open thread"/);
  assert.match(one, /aria-pressed="false"/);
  const many = renderToHtml(createElement(ThreadSummaryChip, {
    replyCount: 3, lastReplyAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), active: true, onOpen: () => {},
  }));
  assert.match(many, />3 replies</);
  assert.match(many, /Last reply /);
  assert.match(many, /msgx-thread-chip-active/);
});

// #2387 follow-up: Discord's card — "3 replies ›" over the newest reply.
test('the thread card shows the count over the newest reply', () => {
  const { ThreadSummaryChip } = loadTsx(`${DIR}/thread-summary.tsx`);
  const html = renderToHtml(createElement(ThreadSummaryChip, {
    replyCount: 3,
    lastReplyAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    lastReply: { face: createElement('span', { className: 'face' }, 'S'), name: 'salah', text: 'Thanks a lot @AdoN' },
    onOpen: () => {},
  }));
  assert.match(html, /class="msgx-thread-chip msgx-thread-card /, 'still the thread chip, for the selectors that find a thread by it');
  assert.match(html, /<span class="msgx-thread-count">3 replies<\/span>/);
  assert.match(html, /class="msgx-thread-line"><span class="face">S<\/span><strong class="msgx-thread-line-name">@salah<\/strong><span class="msgx-thread-line-text">Thanks a lot @AdoN<\/span><time/);
  assert.match(html, /aria-label="3 replies, last from @salah 3h ago\. Open thread"/);
});

// #2387 follow-up: a thread's replies in the main transcript, where they
// landed — one card for a run of them.
test('the thread-activity card names the thread, the time and the latest three replies', () => {
  const { ThreadActivityCard, THREAD_ACTIVITY_LINES } = loadTsx(`${DIR}/thread-activity.tsx`);
  const reply = (name, text) => ({ key: name + text, face: createElement('i', null, name[0]), name, text });
  const one = renderToHtml(createElement(ThreadActivityCard, {
    rootText: 'Anyone else trying the new #general room?', time: '1:21 PM', replies: [reply('ada', 'Yes!')], onOpen: () => {},
  }));
  assert.match(one, /class="msgx-thread-activity-what">Replied in thread</);
  assert.match(one, /class="msgx-thread-activity-root ">Anyone else trying the new #general room\?</);
  assert.match(one, /· 1:21 PM/);
  assert.match(one, /aria-label="Replied in thread: Anyone else trying the new #general room\?, 1:21 PM\. Open thread"/);

  const many = renderToHtml(createElement(ThreadActivityCard, {
    rootText: 'Root', time: '1:21 PM – 1:30 PM',
    replies: [reply('a', 'one'), reply('b', 'two'), reply('c', 'three'), reply('d', 'four')], onOpen: () => {},
  }));
  assert.match(many, />4 replies in thread</, 'the head counts the whole run');
  assert.equal((many.match(/class="msgx-thread-line"/g) || []).length, THREAD_ACTIVITY_LINES, 'three lines at most');
  assert.doesNotMatch(many, />one</, 'the latest three: the oldest drops');
  assert.match(many, />four</);

  const gone = renderToHtml(createElement(ThreadActivityCard, {
    rootText: '', rootDeleted: true, time: '9:00 AM', replies: [reply('a', '')], onOpen: () => {},
  }));
  assert.match(gone, /msgx-thread-activity-root-deleted">Message deleted</);
  assert.match(gone, /msgx-thread-line-text">Attachment</, 'a reply with no words is a file');
});

test('Reply focuses the box only where there is a mouse or trackpad', () => {
  const { wantsKeyboardFocus } = loadTsx(`${DIR}/focus.ts`);
  const withPointer = (fine) => {
    global.window = { matchMedia: (query) => ({ matches: query === '(any-pointer: fine)' ? fine : false }) };
    try { return wantsKeyboardFocus(); } finally { delete global.window; }
  };
  assert.equal(withPointer(true), true, 'a desktop, or a tablet with a trackpad');
  assert.equal(withPointer(false), false, 'a touch-only phone: no on-screen keyboard over the message');
  assert.equal(wantsKeyboardFocus(), false, 'no window (a prerender) answers no');
});
