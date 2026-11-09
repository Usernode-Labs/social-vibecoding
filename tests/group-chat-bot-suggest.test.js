'use strict';

// 3 Nov 2026 (#6213): the suggested replies under Homeroom bot's message in
// a request's or a change's discussion. Pinned here: who is shown them (the
// people its metadata names, and only while the set is open), that a tap
// sends the label as that person's own reply in the message's own thread,
// and that the transcript draws the row only for the person it is for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The module reads catalog text only when it draws a row, which these tests
// do not; the ids are enough.
const i18n = { t: (key) => key, errorText: () => '' };

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadGroupChat(userId = 9) {
  const sandbox = {
    window: {},
    URLSearchParams,
    location: { search: '' },
    document: { getElementById: () => null, addEventListener() {} },
    App: { user: { id: userId } },
    PlatformI18n: i18n,
  };
  // In a browser these are the same object; the module reads `window.App`.
  sandbox.window.App = sandbox.App;
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  return sandbox.window.GroupChat;
}

// #6321: Propose to close under an "already works" note is offered to no one
// person, so any signed-in viewer who can take part here gets its buttons.
test('an offer to nobody in particular is every signed-in viewer\'s, for a close only', () => {
  const offer = (kind, forUserId) => ({
    homeroomBot: {
      kind: 'voice',
      offer: { id: 1, kind, status: 'open', forUserId },
      actions: [{ id: 'yes', label: 'Propose to close', style: 'primary' }, { id: 'no', label: 'Keep it open', style: 'secondary' }],
    },
  });
  assert.equal(loadGroupChat(9)._botOfferView(offer('close_request', null)).forMe, true);
  assert.equal(loadGroupChat(null)._botOfferView(offer('close_request', null)).forMe, false, 'signed out');
  const readOnly = loadGroupChat(9);
  readOnly._app = { readOnly: true };
  assert.equal(readOnly._botOfferView(offer('close_request', null)).forMe, false, 'read-only');
  assert.equal(loadGroupChat(9)._botOfferView(offer('copy_request', null)).forMe, false, 'no other kind');
  assert.equal(loadGroupChat(9)._botOfferView(offer('close_request', 9)).forMe, true, 'its one person');
  assert.equal(loadGroupChat(9)._botOfferView(offer('close_request', 12)).forMe, false, 'somebody else\'s');
  assert.equal(readOnly._botOfferView(offer('close_request', 9)).forMe, true, 'one person\'s reads as it did');
});

const view = (over = {}) => ({
  homeroomBot: {
    kind: 'note',
    suggest: { status: 'open', forUserIds: [9, 12] },
    actions: [
      { id: 'go_ahead', label: 'Go ahead', style: 'primary', type: 'prompt' },
      { id: 'smaller', label: 'Just the triage part', style: 'secondary', type: 'prompt' },
      { id: 'not_now', label: 'Not now', style: 'secondary', type: 'prompt' },
    ],
    ...over.bot,
  },
  ...over.meta,
});

test('only the people the message names see its suggestions', () => {
  const named = loadGroupChat(9)._botSuggestView(view());
  assert.equal(named.status, 'open');
  assert.equal(named.forMe, true);
  assert.deepEqual(named.actions.map((a) => [a.label, a.primary]),
    [['Go ahead', true], ['Just the triage part', false], ['Not now', false]]);

  assert.equal(loadGroupChat(10)._botSuggestView(view()).forMe, false, 'somebody else sees none');
  assert.equal(loadGroupChat(null)._botSuggestView(view()).forMe, false, 'a signed-out reader sees none');
});

test('a closed set, another message, or a read-only viewer draws nothing', () => {
  assert.equal(loadGroupChat(9)._botSuggestView(view({ bot: { suggest: { status: 'closed', forUserIds: [9] } } })).status, 'closed');
  assert.equal(loadGroupChat(9)._botSuggestView(view({ bot: { suggest: null } })), null);
  assert.equal(loadGroupChat(9)._botSuggestView({}), null);
  const readOnly = loadGroupChat(9);
  readOnly._app = { readOnly: true };
  assert.equal(readOnly._botSuggestView(view()).forMe, false);
});

// #6391: the second set belongs to the members the reply did not answer.
const othersMeta = (status = 'open') => ({
  homeroomBot: {
    kind: 'voice',
    suggest: { status, forUserIds: [9] },
    actions: [{ id: 'suggest-1', label: 'Yes, tell me here', style: 'secondary', type: 'prompt' }],
    othersActions: [
      { id: 'others-1', label: "I'd like this too", style: 'secondary', type: 'prompt' },
      { id: 'others-2', label: 'Can I try it?', style: 'secondary', type: 'prompt' },
      { id: 'others-3', label: "What's left to do?", style: 'secondary', type: 'prompt' },
    ],
  },
});

test('#6391: a member the reply did not answer gets the other members\' set', () => {
  const meta = othersMeta();
  const member = loadGroupChat(10);
  assert.equal(member._member, null);
  assert.equal(member._botSuggestView(meta).forMe, false, 'membership not known yet: none');
  member._member = true;
  const mine = member._botSuggestView(meta);
  assert.equal(mine.forMe, true);
  assert.equal(mine.audience, 'others');
  assert.deepEqual(mine.actions.map((a) => a.label), ["I'd like this too", 'Can I try it?', "What's left to do?"]);

  // The person it answered keeps the first set, and never both.
  const answered = loadGroupChat(9);
  answered._member = true;
  const theirs = answered._botSuggestView(meta);
  assert.equal(theirs.audience, 'answered');
  assert.deepEqual(theirs.actions.map((a) => a.label), ['Yes, tell me here']);

  // A non-member, a signed-out reader and a read-only viewer see none.
  const outsider = loadGroupChat(10);
  outsider._member = false;
  assert.equal(outsider._botSuggestView(meta).forMe, false);
  assert.equal(loadGroupChat(null)._botSuggestView(meta).forMe, false);
  const readOnly = loadGroupChat(10);
  readOnly._member = true;
  readOnly._app = { readOnly: true };
  assert.equal(readOnly._botSuggestView(meta).forMe, false);
  // A closed set draws nothing, and an old message with no others' set is as it was.
  assert.equal(member._botSuggestView(othersMeta('closed')).status, 'closed');
  const old = member._botSuggestView(view());
  assert.equal(old.forMe, false);
  assert.equal(old.audience, null);
});

test('#6391: the thread page\'s viewer_member is what the second set reads', () => {
  const state = () => ({
    messages: [], oldestId: null, hasMore: true, loading: false, loaded: false,
    failed: false, again: false, stale: false, syncedMax: -Infinity, root: null,
  });
  const take = (gc, data) => {
    const log = [];
    log.held = new Set();
    gc._takeNewest(state(), { type: 'issue', ref: 7 }, [], { messages: [], has_more_before: true, ...data }, log, true);
    return gc._member;
  };
  assert.equal(take(loadGroupChat(10), { viewer_member: true }), true);
  assert.equal(take(loadGroupChat(10), { viewer_member: false }), false);
  const gc = loadGroupChat(10);
  assert.equal(take(gc, { viewer_member: true }), true);
  assert.equal(take(gc, {}), true, 'a page that says nothing keeps what it knew');
  // The route says it for a request's or a change's thread only.
  const route = read('src/routes/chat.js');
  assert.match(route, /if \(threadType === 'issue' \|\| threadType === 'session'\) \{/);
  assert.match(route, /body\.viewer_member = /);
  assert.match(route, /communities\.isMember\(pool, appId, viewerId\)/);
});

test('a tap sends the label as that person\'s reply in the message\'s own thread', () => {
  const gc = loadGroupChat(9);
  gc.messages = [{ id: 5, thread_type: 'issue', thread_ref: 7 }];
  const sent = [];
  gc.send = (content, thread) => { sent.push({ content, thread }); };
  gc.sendBotSuggestion(5, 'Go ahead');
  assert.deepEqual(sent.map((s) => ({ content: s.content, thread: { ...s.thread } })),
    [{ content: 'Go ahead', thread: { type: 'issue', ref: 7 } }]);
  // A change's discussion, and the message not known here: the open thread.
  gc.messages = [{ id: 6, thread_type: 'session', thread_ref: 12 }];
  gc.sendBotSuggestion(6, 'Not now');
  assert.deepEqual({ ...sent[1].thread }, { type: 'session', ref: 12 });
  // A row with no thread facts of its own (the open thread is the scope).
  gc.messages = [{ id: 6 }];
  gc.activeThread = { type: 'issue', ref: 7 };
  gc.sendBotSuggestion(6, 'Go ahead');
  assert.deepEqual({ ...sent[2].thread }, { type: 'issue', ref: 7 });
  // Never from a read-only viewer, and never a blank label.
  gc._app = { readOnly: true };
  gc.sendBotSuggestion(6, 'Go ahead');
  assert.equal(sent.length, 3);
  gc._app = null;
  gc.sendBotSuggestion(6, '   ');
  assert.equal(sent.length, 3);
});

test('the transcript draws the row only for the person it is for', () => {
  const tx = read('frontend/src/features/group-chat/transcript.tsx');
  assert.match(tx, /function BotSuggestButtons/);
  assert.match(tx, /data-gc-bot-suggest=\{suggest\.audience \|\| ''\}/);
  assert.match(tx, /controller\(\)\?\.sendBotSuggestion\?\.\(id, label\)/);
  assert.match(tx, /msg\.botSuggest && msg\.botSuggest\.forMe && msg\.botSuggest\.status === 'open' && msg\.botSuggest\.actions\.length/);
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'BotSuggestButtons', {
    id: 5,
    suggest: {
      status: 'open',
      forMe: true,
      actions: [
        { id: 'go_ahead', label: 'Go ahead', primary: true },
        { id: 'smaller', label: 'Just the triage part', primary: false },
        { id: 'not_now', label: 'Not now', primary: false },
      ],
    },
  });
  assert.match(html, /data-gc-bot-suggest=""/);
  assert.equal((html.match(/<button/g) || []).length, 3);
  // #6391: the other members' set says so, and draws the same pill buttons.
  const others = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'BotSuggestButtons', {
    id: 6,
    suggest: {
      status: 'open',
      forMe: true,
      audience: 'others',
      actions: [
        { id: 'others-1', label: "I'd like this too", primary: false },
        { id: 'others-2', label: 'Can I try it?', primary: false },
        { id: 'others-3', label: "What's left to do?", primary: false },
      ],
    },
  });
  assert.match(others, /data-gc-bot-suggest="others"/);
  assert.equal((others.match(/<button/g) || []).length, 3);
  assert.ok(others.includes('>I&#x27;d like this too</button>') || others.includes(">I'd like this too</button>"));
  assert.match(read('frontend/src/features/group-chat/transcript-store.ts'), /audience: 'answered' \| 'others' \| null;/);
  assert.ok(html.includes('>Go ahead</button>'));
  assert.ok(html.includes('>Just the triage part</button>'));
  const gc = read('public/js/group-chat.js');
  assert.match(gc, /botSuggest: GroupChat\._botSuggestView\(kind === 'message' && !deleted \? meta : null\)/);
  assert.match(gc, /botSuggest: view\.botSuggest/);
});

test('#6519: suggestions show only under the newest comment', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const { newestComment } = loadTsx('frontend/src/features/group-chat/transcript.tsx');
  const row = (kind, over = {}) => ({ kind, id: over.id ?? 1, ...over });

  assert.equal(newestComment([], true), null, 'an empty stream has no newest comment');
  assert.equal(newestComment([], false), null);

  const first = row('message', { id: 1 });
  const second = row('message', { id: 2 });
  assert.equal(newestComment([first, second], true), second, 'a later message wins');
  assert.equal(newestComment([first, second], false), second);

  // A status line is not a comment: the message under it stays newest.
  for (const kind of ['system', 'vote', 'spec_share']) {
    assert.equal(newestComment([first, row(kind, { id: 9 })], false), first, `${kind} is skipped`);
    assert.equal(newestComment([first, row(kind, { id: 9 })], true), first, `${kind} is skipped with GitHub rows`);
  }

  // GitHub comments count on a request's page only, and a plan's mirror is not one.
  const github = row('github', { id: 10, key: 'gh-1' });
  assert.equal(newestComment([first, github], true), github, 'a GitHub comment wins');
  assert.equal(newestComment([first, github], false), first, 'a change page has none');
  assert.equal(newestComment([first, row('github', { id: 11, key: 'gh-2', githubSpec: { title: null, markdown: '', html: '' } })], true), first,
    'a plan mirrored from GitHub is not a comment');

  // A deleted message is not a comment either, so the one before it stays newest.
  assert.equal(newestComment([first, row('message', { id: 3, deleted: true })], true), first);
  assert.equal(newestComment([row('message', { id: 3, deleted: true })], true), null);

  const tx = read('frontend/src/features/group-chat/transcript.tsx');
  assert.match(tx, /\{isNewest && msg\.botSuggest && msg\.botSuggest\.forMe && msg\.botSuggest\.status === 'open' && msg\.botSuggest\.actions\.length \? \(/);
  assert.match(tx, /const newest = newestComment\(stream\.rows, true\)/);
  assert.match(tx, /const newest = newestComment\(rows, false\)/);
  assert.equal((tx.match(/const newest = newestComment\(rows, false\)/g) || []).length, 2,
    'both the change and the transcript rows find it');
  // A request's rows are pinned by their props elsewhere, so that stream
  // publishes its newest through the context; every other row is told
  // directly, and a row reads either.
  assert.match(tx, /const publishedNewest = useContext\(NewestCommentContext\);/);
  assert.match(tx, /<NewestCommentContext\.Provider value=\{newest\}>/);
  const calls = tx.match(/<MessageRow\b[^>]*?\/>/gs) || [];
  assert.ok(calls.length >= 4, 'the transcript draws the row in several places');
  const direct = calls.filter((call) => !call.includes('seeVote={seeVoteOf(msg)}'));
  assert.equal(direct.length, calls.length - 1, 'only the request stream leaves the prop off');
  for (const call of direct) assert.match(call, /\blatest=/, 'every other row is told whether it is the newest comment');
  assert.match(tx, /<MessageRow key=\{key\} msg=\{msg\} grouped=\{grouped\} surface="thread" tag=\{tagOf\(msg\)\} seeVote=\{seeVoteOf\(msg\)\} \/>/,
    'the request stream\'s row props stay as they were');
});

test('#6519: a request\'s stream draws the suggestions under its newest comment only', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const suggest = { status: 'open', forMe: true, actions: [{ id: 'go_ahead', label: 'Go ahead', primary: true }] };
  const rowBase = {
    id: 1, kind: 'message', username: 'evan', time: '10:00', timeTitle: 't', bodyHtml: '<p>hi</p>', systemText: '',
    mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false, flash: false,
    showEdit: false, showBookmark: false, showReact: false, quote: null, reactions: [],
    attachments: [], voteRowClass: '', voteRef: null, specShare: null,
  };
  const lead = { earlier: false, placeholder: null, language: 'request', request: { loaded: true, githubMore: null } };
  const bot = { ...rowBase, id: 10, username: 'homeroom_bot', botSuggest: suggest };
  const newer = { ...rowBase, id: 11, time: '10:05', bodyHtml: '<p>newer</p>' };
  const count = (html) => (html.match(/data-gc-bot-suggest/g) || []).length;
  assert.equal(count(renderComponent('frontend/src/features/group-chat/transcript.tsx', 'RequestRows', {
    view: { lead, messages: [bot, newer] },
  })), 0, 'a comment after it takes the buttons away');
  assert.equal(count(renderComponent('frontend/src/features/group-chat/transcript.tsx', 'RequestRows', {
    view: { lead, messages: [bot] },
  })), 1, 'the bot\'s own newest message still offers them');
});

test('#6272: a request-page reply whose text list was lifted shows buttons to the person it answered', async () => {
  const voice = require('../src/services/homeroom-bot-voice');
  const sent = [];
  const pool = {
    async query(sql) {
      if (/INSERT INTO bot_cards/.test(String(sql))) return { rows: [{ id: 5 }] };
      return { rows: [] };
    },
  };
  const deps = {
    ws: {
      async sendBotMessage(_pool, _appId, args) { sent.push(args); return { id: 900, createdAt: new Date() }; },
      broadcast() {},
    },
    notifications: { async createMentionNotifications() { return []; } },
  };
  // The reply the model wrote: its suggestions as a list in the text.
  const ctx = { app: { id: 1, slug: 'x' }, place: { type: 'issue', ref: 7 }, deps: {} };
  await voice.runTool(pool, ctx, 'reply', {
    text: 'Once it is built, the checks run. When they pass, it goes up for a vote.\n\nSuggestions:\n'
      + '- So once the checks pass I can vote on it?\n- Where do I see the checks?\n',
    suggestionsForOthers: ["I'd like this too", "What's left to do?"],
  });
  assert.equal(ctx.reply.text, 'Once it is built, the checks run. When they pass, it goes up for a vote.');
  await voice.say(pool, {
    app: { id: 1, slug: 'x' },
    place: { type: 'issue', ref: 7 },
    bot: { id: 2, username: 'homeroom_bot' },
    text: ctx.reply.text,
    answer: [{ message: { id: 50, content: 'What happens after the plan is built?' }, username: 'evan', userId: 9 }],
    suggestions: ctx.reply.suggestions,
    deps,
  });
  const { metadata, content } = sent[0];
  assert.doesNotMatch(content, /Suggestions:/, 'the list is not written into the message');
  const mine = loadGroupChat(9)._botSuggestView(metadata);
  assert.equal(mine.status, 'open');
  assert.equal(mine.forMe, true);
  assert.deepEqual(mine.actions.map((a) => a.label),
    ['So once the checks pass I can vote on it?', 'Where do I see the checks?']);
  assert.equal(loadGroupChat(10)._botSuggestView(metadata).forMe, false, 'someone it did not answer sees none');
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'BotSuggestButtons', { id: 900, suggest: mine });
  assert.equal((html.match(/<button/g) || []).length, 2);
  assert.ok(html.includes('>So once the checks pass I can vote on it?</button>'));
});
