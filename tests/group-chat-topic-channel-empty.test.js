// #5683 (audit F18, F19, F22): what a chat says when it is new, who the bot
// is, and how the inline vote card counts.
//
//   - An empty topic channel shows a centred invitation to start it, in its
//     own name and description, rather than "Nothing said here yet." in a
//     corner. A viewer who cannot post gets the same block, plainly.
//   - Homeroom bot's row wears its name and logo, as in Messages, not
//     "homeroom_bot" with a letter avatar like a person.
//   - The chat's inline vote card says the tally in words ("4 of 3 yes
//     votes"); the board and vote panel keep "x / y".
//
// Run with: node --test tests/group-chat-topic-channel-empty.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { renderComponent } = require('./lib/render-tsx');

const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';

const row = (patch = {}) => ({
  id: 7, kind: 'message', username: 'maya', time: '09:05 AM',
  timeTitle: 'Oct 8, 2026, 09:05 AM', at: '2026-10-08T09:05:00Z', bodyHtml: '<p>hi</p>', systemText: '',
  mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false,
  flash: false, showEdit: false, showBookmark: false, showReact: false, quote: null,
  reactions: [], attachments: [], voteRowClass: '', voteRef: null, specShare: null,
  event: null, eventHref: null,
  ...patch,
});

test('a Homeroom bot row says "Homeroom bot" and wears the logo, never a letter', () => {
  const bot = renderComponent(TRANSCRIPT, 'MessageRow', { msg: row({ username: 'homeroom_bot' }) });
  assert.match(bot, /data-username="homeroom_bot"/, 'the row keeps its raw handle');
  assert.match(bot, /<img src="\/brand\/homeroom-mark\.png" alt="" class="h-full w-full object-cover" data-bot-avatar=""\/>/);
  assert.match(bot, />Homeroom bot</);
  assert.doesNotMatch(bot, />homeroom_bot</);
  const person = renderComponent(TRANSCRIPT, 'MessageRow', { msg: row({ username: 'maya' }) });
  assert.doesNotMatch(person, /data-bot-avatar/);
  assert.match(person, />maya</);
});

test('an empty topic channel invites the first post in its own name', () => {
  const lead = (canPost) => ({
    earlier: false, placeholder: null,
    emptyChannel: { handle: 'onboarding', about: 'How new people get going in their first session.', canPost },
  });
  const member = renderComponent(TRANSCRIPT, 'TranscriptRows', {
    view: { lead: lead(true), messages: [] }, source: 'main',
  });
  assert.match(member, /<div class="gc-channel-empty" data-channel-empty="onboarding">/);
  assert.match(member, /class="gc-channel-empty-mark" aria-hidden="true">#</);
  assert.match(member, />Start #onboarding</);
  assert.match(member, />How new people get going in their first session\.</);
  assert.match(member, />Ideas posted here can become requests\.</);

  const readOnly = renderComponent(TRANSCRIPT, 'TranscriptRows', {
    view: { lead: lead(false), messages: [] }, source: 'main',
  });
  assert.match(readOnly, /data-channel-empty="onboarding"/);
  assert.match(readOnly, />Nothing said here yet\.</);
  assert.doesNotMatch(readOnly, /Ideas posted here can become requests\./);
});

test('the chat\'s inline vote card says the tally in words; the default keeps "x / y"', () => {
  const c = {
    console,
    App: { user: { id: 42, username: 'evan' }, currentApp: 'example', currentTab: 'dev' },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null },
    addEventListener() {}, dispatchEvent() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  c.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/app-view.js'), 'utf8'), c);
  vm.runInContext('globalThis.av = AppView', c);
  const pr = { status: 'promoted', yes_count: 4, no_count: 0, votes_required: 3 };
  assert.match(c.av.voteCountPill(pr, 3, { words: true }), /<span class="gc-vote-count-label">4 of 3 yes votes<\/span>/);
  assert.match(c.av.voteCountPill(pr, 3), /<span class="gc-vote-count-label">4 \/ 3<\/span>/);
  assert.match(c.av.voteCountPill({ ...pr, votes_required: 1 }, 1, { words: true }), />4 of 1 yes vote</);
});
