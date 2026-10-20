'use strict';

// #5483: a Yes cast in the chat with Homeroom bot sticks.
//
// The Yes on a ready card (bot-ready.tsx) or a Ready to try row in the
// drawer (bot-strip.tsx) was saved by api.approveChange but kept on the
// screen only: the card held it in its own state, which leaving the chat
// unmounts, and nothing else on the page heard about it. Reopened, the card
// read the transcript's copy from before the vote and offered Try it /
// Approve / Change something again. The vote now lands in a page-lifetime
// record in the activity store (./bot-activity-store.ts), which both surfaces
// read, and the rest of the page hears it the way AppView.castVote announces
// a vote (Your votes' own-vote note, the saved-vote publication the Needs you
// surfaces listen on, the notification list).
//
// #5484: the same moment also fires the tray's window event, so the tray
// readers (the Activity bar, the inbox's Homeroom bot row) read again even
// when the socket's push is missed.
//
// Run with: node --test tests/messages-ready-approval-kept.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const STORE = 'frontend/src/features/messages/bot-activity-store.ts';
const READY = 'frontend/src/features/messages/bot-ready.tsx';
const STRIP = 'frontend/src/features/messages/bot-strip.tsx';

// The page's own timeline of what a Yes did: reads asked for and window
// events dispatched, in order. #5484 fires the tray's event here itself.
const page = [];

globalThis.window = {
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {},
  dispatchEvent(event) { page.push(['event', event.type]); },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout, setInterval, clearInterval,
};

// The store reads the change's state again once a Yes is recorded; the stub
// answers the one read the store makes, as the server would for no cards.
const answeringApi = (reads) => ({
  getHomeroomBotActivity(options) {
    page.push(['read', options && options.fresh]);
    if (reads) reads.push(options);
    return Promise.resolve({ cards: [], ready: [] });
  },
  catchUpHomeroomBotActivity() { return Promise.resolve(0); },
});

// A fresh store module each call: its record is for the page's lifetime, and
// each test loads its own so none sees another's Yes.
function loadStore({ api, reads } = {}) {
  return loadTsx(STORE, {
    stubs: {
      './api': api || answeringApi(reads),
      './store': { handleEvent() {} },
    },
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// ── The record ──

test('a Yes recorded here is kept at its version, and the page hears it in castVote\'s order', async () => {
  const reads = [];
  page.length = 0;
  const store = loadStore({ reads });
  window.AppView = {
    _noteOwnVote(id, vote) { page.push(['own', id, vote]); },
    _publishVoteSaved(id, vote, epoch) { page.push(['saved', id, vote, epoch]); },
  };
  window.Notifications = { refresh() { page.push(['notifications']); } };

  store.noteApprovedHere(9, 2, null);
  await settle();

  assert.ok(store.approvedHere(9, 2), 'the vote\'s own version is matched');
  assert.ok(store.approvedHere(9, null), 'so is a reader with no epoch of its own (an older card)');
  assert.equal(store.approvedHere(9, 3), null, 'a newer version\'s card asks again');
  assert.equal(store.approvedHere(8, 2), null, 'another change is not matched');
  assert.deepEqual(page, [
    ['read', true],
    ['event', 'homeroom-bot-work-changed'],
    ['own', 9, 'yes'], ['saved', 9, 'yes', 2], ['notifications'],
  ], 'the page hears the vote in castVote\'s order, one tray event per Yes (#5484): the fresh read is asked for, then the event fires, then the bridges');
  assert.deepEqual(reads.map((r) => r && r.fresh), [true], 'the change\'s state is read again fresh, once');
});

test('none of the page announcements throwing stops the rest, and the vote is kept all the same', async () => {
  const calls = [];
  const store = loadStore();
  window.AppView = {
    _noteOwnVote() { calls.push('own'); throw new Error('not on this page'); },
    _publishVoteSaved() { calls.push('saved'); },
  };
  window.Notifications = { refresh() { calls.push('notifications'); } };

  store.noteApprovedHere(5, null, null);
  await settle();

  assert.deepEqual(calls, ['own', 'saved', 'notifications'], 'each call ran, its own try held the throw');
  assert.ok(store.approvedHere(5, null), 'the vote itself is recorded');
});

// ── The card, reopened ──

const ACTIONS = [
  { id: 'try', label: 'Try it', style: 'secondary', type: 'preview', sessionId: 9 },
  { id: 'approve', label: 'Approve', style: 'primary', type: 'vote', sessionId: 9, epoch: 2 },
  { id: 'change', label: 'Change something', style: 'secondary', type: 'reply' },
];
const readyMeta = (epoch) => ({
  kind: 'proposal', appName: 'Plant Pal', appSlug: 'plant-pal', askedText: 'Add a weekly reminder',
  ready: { group: false, last: true, waitingOn: [], more: 0 }, status: 'open', sessionId: 9, epoch,
  actions: ACTIONS.map((action) => (action.type === 'vote' ? { ...action, epoch } : action)),
});
const message = (id, meta) => ({
  id, sender: { id: 1, username: 'homeroom_bot', bot: true }, content: '', metadata: { homeroomBot: meta },
});

function readyCard(store) {
  return loadTsx(READY, { stubs: { './bot-activity-store': store } });
}

test('a ready card reopened after the Yes cast here still says You approved it, with no Approve again', async () => {
  const store = loadStore();
  window.AppView = { _noteOwnVote() {}, _publishVoteSaved() {} };
  window.Notifications = { refresh() {} };
  store.noteApprovedHere(9, 2, null);

  const { BotReadyCard } = readyCard(store);
  const html = renderToHtml(createElement(BotReadyCard, { message: message(31, readyMeta(2)), conversationId: 42 }));
  assert.match(html, /data-bot-ready="approved"/);
  assert.match(html, />You approved it\. It goes live in a minute or two\.</);
  assert.ok(!/data-bot-ready-action/.test(html), 'no Try it / Approve / Change something offered again');

  // The bot sent a newer version: that card asks again.
  const newer = renderToHtml(createElement(BotReadyCard, { message: message(32, readyMeta(3)), conversationId: 42 }));
  assert.match(newer, /data-bot-ready="open"/);
  assert.match(newer, /data-bot-ready-action="approve"><span>Approve<\/span>/);
});

// ── The vote is recorded only once the server has said yes ──

test('the Yes is recorded in the ok branches alone, and the drawer\'s row reads the record', () => {
  const ready = read(READY);
  const at = ready.indexOf('  async function press(');
  assert.ok(at > -1, 'press is found');
  const press = ready.slice(at, ready.indexOf('\n  }\n', at));
  assert.match(press, /if \(out\.ok\) \{ noteApprovedHere\(action\.sessionId, epoch, out\.goesLive \|\| null\);/);
  assert.equal(press.indexOf('noteApprovedHere'), press.lastIndexOf('noteApprovedHere'),
    'recorded once, and only there');
  assert.match(ready, /approvedHere\(vote\.sessionId, vote\.epoch \?\? null\)/,
    'the reopened card reads the record into its state');

  const strip = read(STRIP);
  const approve = strip.slice(strip.indexOf('  async function approve() {'), strip.indexOf('\n  }\n', strip.indexOf('  async function approve() {')));
  assert.match(approve, /if \(out\.ok\) \{ noteApprovedHere\(sessionId, ready\?\.epoch \?\? null, out\.goesLive \|\| null\); loadBotWork\(\); return; \}/,
    'recorded before the tray reads again');
  assert.match(read(STORE), /export function useApprovedHere\(/,
    'the record has a React reader: the strip\'s row does not subscribe to the cards\' snapshot');
  assert.match(strip, /const approved = useApprovedHere\(sessionId, ready\?\.epoch \?\? null\);/,
    'the row subscribes to the record, so a Yes cast anywhere on the page (the card\'s included) redraws it at once');
  // #5506: nor to someone who does not build on the project (lookOnly).
  assert.match(strip, /const canApprove = !!ready\?\.approve && !!sessionId && !approved && !lookOnly;/,
    'a row whose Yes is in stops offering Approve');
});