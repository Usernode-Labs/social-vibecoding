'use strict';

// #5683 (UX audit F18/F19): what a request's chat says, and what an empty
// topic channel says.
//
//   * an empty topic channel invites the first post, centred, with its name
//     and what it is for — and the same block without the invitation for a
//     viewer who cannot post;
//   * Homeroom bot's rows wear its name and logo, not "homeroom_bot" and a
//     letter tile;
//   * the inline vote card in a chat says its tally in words ("4 of 3 yes
//     votes"), while the board and the vote panel keep "4 / 3".
//
// Run with: node --test tests/group-chat-topic-channel-empty.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';

const rowBase = {
  id: 5, kind: 'message', username: 'evan', time: '10:00', timeTitle: 't', bodyHtml: '<p>hi</p>', systemText: '',
  mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false, flash: false,
  showEdit: false, showBookmark: false, showReact: false, quote: null, reactions: [],
  attachments: [], voteRowClass: '', voteRef: null, specShare: null, event: null, eventHref: null,
};

const lead = (emptyChannel) => ({
  earlier: false, placeholder: null, emptyChannel, markers: null, unread: null, error: null,
});

test('an empty topic channel invites the first post: its name, what it is for, and why', () => {
  const html = renderComponent(TRANSCRIPT, 'TranscriptRows', {
    source: 'main',
    view: { lead: lead({ handle: 'onboarding', about: 'How new people get going', canPost: true }), messages: [] },
  });
  assert.match(html, /<div class="gc-channel-empty" data-channel-empty="onboarding">/);
  assert.match(html, /class="gc-channel-empty-hash" aria-hidden="true">#<\/span>/);
  assert.match(html, /gc-channel-empty-title">Start #onboarding<\/div>/);
  assert.match(html, /gc-channel-empty-about">How new people get going<\/p>/);
  assert.match(html, /gc-channel-empty-invite">Ideas posted here can become requests\.<\/p>/);
  assert.doesNotMatch(html, /Nothing said here yet/, 'the corner line is gone');
});

test('someone who cannot post reads the same block, saying nothing is there yet', () => {
  const html = renderComponent(TRANSCRIPT, 'TranscriptRows', {
    source: 'main',
    view: { lead: lead({ handle: 'onboarding', about: 'How new people get going', canPost: false }), messages: [] },
  });
  assert.match(html, /<div class="gc-channel-empty" data-channel-empty="onboarding">/);
  assert.match(html, /gc-channel-empty-title">Nothing said here yet\.<\/div>/);
  assert.match(html, /gc-channel-empty-about">How new people get going<\/p>/);
  assert.doesNotMatch(html, /Start #onboarding|can become requests/);
});

test('a channel with rows draws no invitation', () => {
  const html = renderComponent(TRANSCRIPT, 'TranscriptRows', {
    source: 'main',
    view: { lead: lead({ handle: 'onboarding', about: '', canPost: true }), messages: [rowBase] },
  });
  assert.doesNotMatch(html, /gc-channel-empty/);
});

test('Homeroom bot\'s row wears its name and its logo, and keeps the raw username in data-username', () => {
  const { MessageRow } = loadTsx(TRANSCRIPT);
  for (const username of ['homeroom_bot', 'usernode-bot']) {
    const html = renderToHtml(createElement(MessageRow, { msg: { ...rowBase, username } }));
    assert.match(html, /data-username="(?:homeroom_bot|usernode-bot)"/, 'data-username stays raw');
    assert.match(html, /<img[^>]*src="\/brand\/homeroom-mark\.png"[^>]*data-bot-avatar=""/, `${username}: the Homeroom mark`);
    assert.match(html, /<span>Homeroom bot<\/span>/, `${username}: named as Messages names it`);
  }
  const person = renderToHtml(createElement(MessageRow, { msg: rowBase }));
  assert.doesNotMatch(person, /data-bot-avatar|Homeroom bot/);
  assert.match(person, /<span>evan<\/span>/);
});

function appView() {
  const c = {
    console,
    App: { user: { id: 42, username: 'evan' }, currentApp: 'example', currentTab: 'dev' },
    relTime: () => 'just now',
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => ({ style: {} }),
    },
    localStorage: { getItem: () => null },
    addEventListener() {}, dispatchEvent() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
    PlatformI18n: englishPlatformI18n(),
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8'), c);
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  return c.av;
}

test('the inline vote card says the tally in words; the board and the panel keep "4 / 3"', () => {
  const av = appView();
  const pr = { id: 7, pr_number: 700, status: 'promoted', yes_count: 4, no_count: 0, votes_required: 3 };
  const words = av.voteCountPill(pr, 3, { words: true });
  assert.match(words, /<span class="gc-vote-count-label">4 of 3 yes votes<\/span>/);
  const pair = av.voteCountPill(pr, 3);
  assert.match(pair, /<span class="gc-vote-count-label">4 \/ 3<\/span>/);
  assert.doesNotMatch(pair, /yes votes/);
  // One vote needed is one whole sentence, not "1 yes votes".
  assert.match(av.voteCountPill({ ...pr, yes_count: 1, votes_required: 1 }, 1, { words: true }),
    /class="gc-vote-count-label">1 of 1 yes vote<\/span>/);
});
