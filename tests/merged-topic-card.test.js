'use strict';

// #4417: AFTER A MERGE, A CARD MARKS IT.
//
// When a topic is merged into another, the survivor's channel shows one card
// in its history where the merge applied — "#signup was merged into this
// topic" and "Read #signup ›", which opens the merged channel read-only. It
// is drawn from the registry's `merged_at` (the community record's `places`)
// as a transcript MARKER, never from a chat row: Homeroom writes no activity
// into a channel (AGENTS.md, "a channel is what people said").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const CARD = 'frontend/src/features/dev-board/workshop/merged-topic-card.tsx';
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const PLACES = 'frontend/src/features/dev-board/workshop/places.ts';
const DISCUSSION = 'frontend/src/features/dev-board/workshop/project-discussion.tsx';

const base = {
  id: 1, kind: 'message', username: 'alice', time: '09:05 AM', timeTitle: 'Oct 1, 2026, 09:05 AM',
  bodyHtml: '<p>hi</p>', systemText: '', mine: false, editedTitle: null, unread: false,
  bookmarked: false, canEdit: false, flash: false, showEdit: false, showBookmark: false,
  showReact: true, quote: null, reactions: [], attachments: [], voteRowClass: '',
  voteRef: null, specShare: null, event: null, eventHref: null,
};
let seq = 100;
const said = (at, text) => ({ ...base, id: (seq += 1), at, bodyHtml: `<p>${text}</p>` });
const marker = (handle, at) => ({
  key: `merged-${handle}`, at, kind: 'merged-topic', from: { handle, name: handle, icon: '' },
});
const renderRows = (view) => renderToHtml(createElement(loadTsx(TRANSCRIPT).TranscriptRows, { view, source: 'thread' }));

test('the card says what merged and links to its read-only channel', () => {
  const html = renderComponent(CARD, 'MergedTopicCard', {
    from: { handle: 'signup', name: 'Sign up', icon: '🚪' }, at: '2026-10-02T10:00:00Z', slug: 'homeroom',
  });
  assert.match(html, /^<div class="dev-ws-merged-card" data-merged-topic="signup" data-merged-at="2026-10-02T10:00:00Z" role="note">/);
  assert.match(html, />#signup was merged into this topic</);
  // An anchor with the channel's own address, so a new tab opens it too.
  assert.match(html, /<a class="dev-ws-merged-card-link" href="\/app\/homeroom\/dev\/c\/signup" data-merged-topic-link="signup">Read #signup ›<\/a>/);
  // Nothing about it is a message: no author, no reactions, no reply.
  assert.doesNotMatch(html, /gc-msg|data-msg-id|react|reply/i);
});

test('the card sits in the history at the merge, the way a date divider does', () => {
  const rows = [said('2026-10-01T09:00:00Z', 'before'), said('2026-10-03T09:00:00Z', 'after')];
  const html = renderRows({
    messages: rows,
    lead: { earlier: false, placeholder: null, markers: [marker('signup', '2026-10-02T10:00:00Z')] },
  });
  const at = html.indexOf('data-merged-topic="signup"');
  assert.ok(at > 0, 'the card is drawn');
  assert.ok(html.indexOf('before') < at && at < html.indexOf('after'), 'between the rows either side of the merge');
});

test('a merge newer than every loaded row comes after them; one older waits for Load earlier', () => {
  const rows = [said('2026-10-05T09:00:00Z', 'one'), said('2026-10-06T09:00:00Z', 'two')];
  const newest = renderRows({
    messages: rows, lead: { earlier: false, placeholder: null, markers: [marker('late', '2026-10-07T00:00:00Z')] },
  });
  assert.ok(newest.indexOf('data-merged-topic="late"') > newest.indexOf('two'), 'after the newest row');

  const old = marker('old', '2026-09-01T00:00:00Z');
  const paged = renderRows({ messages: rows, lead: { earlier: true, placeholder: null, markers: [old] } });
  assert.doesNotMatch(paged, /data-merged-topic="old"/, 'older history not loaded yet: the card is not guessed at');
  const whole = renderRows({ messages: rows, lead: { earlier: false, placeholder: null, markers: [old] } });
  assert.ok(whole.indexOf('data-merged-topic="old"') < whole.indexOf('one'), 'the whole history is here: it leads');
});

test('the cards come from the registry: merged topics, oldest merge first', () => {
  const { mergedInto } = loadTsx(PLACES);
  const topic = (over) => ({
    id: 1, kind: 'topic', key: 'k', handle: 'h', aliases: [], name: 'N', about: '', icon: '',
    state: 'live', merged_into: null, merged_at: null, requests: 0, unread: 0, ...over,
  });
  const onboarding = topic({ key: 'onboarding', handle: 'onboarding' });
  const places = {
    owed: 0,
    channels: [
      { ...topic({ kind: 'general', key: null, handle: 'general' }) },
      onboarding,
      topic({ key: 'invites', handle: 'invites', state: 'merged', merged_into: 'onboarding', merged_at: '2026-10-04T00:00:00Z' }),
      topic({ key: 'signup', handle: 'signup', state: 'merged', merged_into: 'onboarding', merged_at: '2026-10-02T00:00:00Z' }),
      topic({ key: 'old', handle: 'old', state: 'archived' }),
      topic({ key: 'elsewhere', handle: 'elsewhere', state: 'merged', merged_into: 'infra', merged_at: '2026-10-01T00:00:00Z' }),
    ],
  };
  assert.deepEqual(mergedInto(places, onboarding).map((t) => t.handle), ['signup', 'invites']);
  assert.deepEqual(mergedInto(places, null), []);

  // The channel hands them to its history as markers, and posts nothing.
  const src = read(DISCUSSION);
  assert.match(src, /kind: 'merged-topic'/);
  assert.match(src, /setThreadMarkers/);
});

test('a merge writes no chat line', () => {
  // The reconcile moves votes and placements and stamps merged_at; it never
  // inserts into chat_messages, and neither does the topics PR.
  for (const file of ['src/services/app-manifest.js', 'src/services/topics-pr.js', 'src/services/places.js']) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /INSERT INTO chat_messages/i, `${file} writes no chat row`);
    assert.doesNotMatch(code, /sendSystemMessage/, `${file} writes no system line`);
  }
});
