'use strict';

// ONE MESSAGE ROW, ONE RULE (dedupe step 2). Every place that draws a
// message asks one pure function what the viewer can do with it
// (frontend/src/features/message-actions/rules.ts), wires the answer through
// one controls hook (controls.tsx), draws reactions with one chip
// (reactions.tsx), and draws the row itself with Messages' own row
// (frontend/src/features/messages/message-row.tsx MessageRowView). These
// run the REAL modules, and read the places' sources to hold that each of
// them asks rather than deciding for itself.
//
// Run with: node --test tests/message-action-rules.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DIR = 'frontend/src/features/message-actions';

const { messageActions } = loadTsx(`${DIR}/rules.ts`);

const ask = (over = {}) => ({
  viewer: { signedIn: true, canWrite: true, ...(over.viewer || {}) },
  author: { mine: false, known: true, ...(over.author || {}) },
  place: over.place || 'channel',
  message: { live: true, said: true, hasText: true, threadable: true, askable: false, ...(over.message || {}) },
});
const yes = (actions) => Object.keys(actions).filter((key) => actions[key]).sort();

test('somebody else\'s message in a channel: react, reply, save, its thread, copy, translate, its pictures, its link, mark unread, report, block', () => {
  assert.deepEqual(yes(messageActions(ask())), [
    'block', 'copy', 'download', 'link', 'markUnread', 'react', 'reply', 'report', 'save', 'thread', 'translate',
  ]);
});

test('your own message in a channel: edit and delete in place of mark unread, report, block and translate', () => {
  assert.deepEqual(yes(messageActions(ask({ author: { mine: true } }))), [
    'copy', 'download', 'edit', 'link', 'react', 'remove', 'reply', 'save', 'thread',
  ]);
  assert.equal(messageActions(ask({ author: { mine: true }, message: { askable: true } })).makeRequest, true,
    'one of your own, in a channel the bot answers in, can be handed to it as a request');
  assert.equal(messageActions(ask({ author: { mine: true }, message: { askable: true }, place: 'thread' })).makeRequest, false,
    'but not from a reply thread');
});

test('edit needs words: a message that is only a picture has nothing to edit or copy', () => {
  const actions = messageActions(ask({ author: { mine: true }, message: { hasText: false } }));
  assert.equal(actions.edit, false);
  assert.equal(actions.copy, false);
  assert.equal(actions.remove, true);
});

test('the place decides threads and the read position', () => {
  for (const place of ['direct', 'thread', 'stream']) {
    assert.equal(messageActions(ask({ place })).thread, false, `no thread starts from ${place}`);
  }
  assert.equal(messageActions(ask({ place: 'group' })).thread, true);
  for (const place of ['thread', 'stream']) {
    assert.equal(messageActions(ask({ place })).markUnread, false, `${place} is read as a whole`);
  }
  assert.equal(messageActions(ask({ place: 'direct' })).markUnread, true);
  assert.equal(messageActions(ask({ message: { threadable: false } })).thread, false, 'a row that cannot start one');
});

test('a notice (nothing anybody said) is never edited, deleted, reported or blocked', () => {
  const actions = messageActions(ask({ message: { said: false } }));
  for (const act of ['edit', 'remove', 'report', 'block', 'translate']) assert.equal(actions[act], false, act);
  for (const act of ['react', 'reply', 'save', 'copy', 'link']) assert.equal(actions[act], true, act);
});

test('who is asking: a read-only reader saves but does not react or reply; a signed-out reader copies and links', () => {
  const readOnly = messageActions(ask({ viewer: { canWrite: false }, author: { mine: true } }));
  assert.equal(readOnly.react, false);
  assert.equal(readOnly.reply, false);
  assert.equal(readOnly.edit, false, '#621: no edits read-only');
  assert.equal(readOnly.save, true, 'saving writes nothing to the app');
  assert.equal(readOnly.remove, true);
  assert.deepEqual(yes(messageActions(ask({ viewer: { signedIn: false } }))), ['copy', 'download', 'link', 'thread', 'translate']);
});

test('a message not delivered, gone, or previewed as a comment on the board offers nothing', () => {
  assert.deepEqual(yes(messageActions(ask({ message: { live: false } }))), []);
  assert.deepEqual(yes(messageActions(ask({ place: 'comment' }))), []);
  assert.deepEqual(yes(messageActions(ask({ place: 'comment', author: { mine: true } }))), []);
});

test('an unknown author cannot be blocked, but the message can still be reported', () => {
  const actions = messageActions(ask({ author: { known: false } }));
  assert.equal(actions.block, false);
  assert.equal(actions.report, true);
});

test('every place that draws a message asks the rule and wires it through the one controls hook', () => {
  for (const file of [
    'frontend/src/features/messages/message-row.tsx',
    'frontend/src/features/group-chat/transcript.tsx',
    'frontend/src/features/dev-board/card/feed-thread.tsx',
  ]) {
    const source = read(file);
    assert.match(source, /messageActions\(\{/, `${file} asks the rule`);
    assert.match(source, /useMessageControls\(/, `${file} wires its controls through the shared hook`);
    assert.doesNotMatch(source, /<MessageActionBar\b/, `${file} draws no bar of its own`);
    assert.doesNotMatch(source, /messageMenu\(\{/, `${file} builds no menu of its own`);
  }
  // The old per-place copies are gone.
  const transcript = read('frontend/src/features/group-chat/transcript.tsx');
  for (const gone of ['function MessageActions', 'export function messageMenuItems', 'function RowActions', 'export function Reactions', 'ChatMessageRow']) {
    assert.ok(!transcript.includes(gone), `transcript.tsx has no ${gone}`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/group-chat/reaction-bar.tsx')), 'the floating reaction bar is gone');
  const gc = read('public/js/group-chat.js');
  for (const gone of ['_openReactionBar', '_ensureReactionBar', 'showEdit:', 'showReact:', 'showBookmark:', "closest('.gc-react-add')", "closest('.gc-msg-save')"]) {
    assert.ok(!gc.includes(gone), `group-chat.js has no ${gone}`);
  }
});

test('every place that draws a message draws Messages\' row', () => {
  assert.match(read('frontend/src/features/messages/message-row.tsx'), /<MessageRowView\b/);
  const transcript = read('frontend/src/features/group-chat/transcript.tsx');
  assert.equal((transcript.match(/<MessageRowView\b/g) || []).length, 2, 'a person\'s message and a GitHub comment');
  assert.match(read('frontend/src/features/dev-board/card/feed-thread.tsx'), /<MessageRowView\b[\s\S]*?\bcompact\b/, 'a comment, at the board\'s size');
});

test('reactions are one chip: the feed primitive\'s ReactionPill, with its count and who reacted', () => {
  const { MessageReactions } = loadTsx(`${DIR}/reactions.tsx`);
  const html = renderToHtml(createElement(MessageReactions, {
    className: 'messages-reactions',
    reactions: [
      { emoji: '👍', count: 2, mine: true, users: ['ada', 'bo'] },
      { emoji: '🎉', count: 1, mine: false, users: ['cy'] },
    ],
    onToggle: () => {},
  }));
  assert.match(html, /^<div class="messages-reactions">/);
  assert.equal((html.match(/<button type="button"/g) || []).length, 2);
  assert.match(html, /aria-pressed="true"[^>]*aria-label="thumbs up: 2 reactions"[^>]*title="ada[^"]*bo"/);
  assert.match(html, /aria-pressed="false"[^>]*aria-label="[^"]+: 1 reaction"/);
  assert.match(html, /bg-violet-100/, 'yours in the accent tint');
  assert.equal(renderToHtml(createElement(MessageReactions, { className: 'x', reactions: [] })), '', 'no reactions, no row');
  for (const file of ['frontend/src/features/messages/message-row.tsx', 'frontend/src/features/group-chat/transcript.tsx']) {
    assert.match(read(file), /<MessageReactions\b/, `${file} draws the one chip`);
    assert.doesNotMatch(read(file), /<ReactionPill\b/, `${file} draws no chip of its own`);
  }
  assert.doesNotMatch(read('public/css/app.css'), /\.messages-reactions button \{/, 'the Messages chip\'s own CSS is gone');
});

test('the shared row: a room\'s named row, a conversation\'s bubble, and the place\'s own hooks on it', () => {
  const { MessageRowView } = loadTsx('frontend/src/features/messages/message-row.tsx');
  const base = {
    author: 'ada', at: '2026-11-01T10:00:00Z', time: '10:00 AM', timeTitle: 'Nov 1, 2026, 10:00 AM', gutter: '10:00',
    avatar: createElement('span', { 'aria-hidden': 'true' }, 'A'),
    body: createElement('div', { className: 'gc-msg-content' }, 'hello'),
  };
  const room = renderToHtml(createElement(MessageRowView, {
    ...base, sided: false, mine: false, end: false, grouped: false,
    className: 'gc-msg', attrs: { 'data-msg-id': 7 }, timeClassName: 'gc-msg-time',
  }));
  assert.match(room, /^<article data-msg-id="7" class="messages-message group [^"]*\bgc-msg"/);
  assert.match(room, /<div class="messages-message-head"><span dir="auto" class="messages-message-author ">ada<\/span><time class="gc-msg-time" datetime="2026-11-01T10:00:00Z" title="Nov 1, 2026, 10:00 AM">10:00 AM<\/time><\/div><div class="gc-msg-content">hello<\/div>/i);

  const mine = renderToHtml(createElement(MessageRowView, { ...base, sided: true, mine: true, end: false, grouped: false }));
  assert.match(mine, /class="messages-message group messages-message-bubble [^"]*messages-message-self/);
  assert.doesNotMatch(mine, /aria-hidden="true">A</, 'your own bubble has no face');
  assert.match(mine, /messages-message-author sr-only/, 'your name for a screen reader alone');
  assert.match(mine, /<div class="messages-bubble" dir="auto"><div class="gc-msg-content">hello<\/div><\/div>/);

  const grouped = renderToHtml(createElement(MessageRowView, { ...base, sided: false, mine: false, end: false, grouped: true }));
  assert.match(grouped, /<time class="messages-message-gutter"[^>]*>10:00<\/time>/);
  assert.doesNotMatch(grouped, /messages-message-head/);

  const compact = renderToHtml(createElement(MessageRowView, { ...base, sided: true, mine: false, end: false, grouped: false, compact: true }));
  assert.match(compact, /messages-message-compact/);
});
