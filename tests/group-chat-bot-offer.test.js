'use strict';

// #6582: a tap under Homeroom bot's offer in a request's discussion (Propose
// to close under an "already works" note) says a refusal where it was tapped,
// and an offer that is gone for good leaves a line instead of its buttons.
//
// Step 3 (11 Nov 2026): a tap sends its card's id (the offer's in the
// message's metadata), and a refusal's code is kept by GroupChat for its
// message, so the line under the offer (transcript.tsx BotOfferStatus) says
// why in the reader's language and outlives the buttons the refusal takes
// away. An offer retired because what it was about moved on, or expired,
// says so too. The client's answer is pinned by running the module, the
// lines by rendering the request's rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
// What the sandboxed module answers, as plain values (its objects are another realm's).
const plain = (value) => JSON.parse(JSON.stringify(value));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadGroupChat(userId = 9, { fetch, toasts = [] } = {}) {
  const sandbox = {
    window: {},
    URLSearchParams,
    location: { search: '' },
    document: { getElementById: () => null, addEventListener() {} },
    App: { user: { id: userId } },
    PlatformI18n: englishPlatformI18n(),
    fetch,
  };
  // In a browser these are the same object; the module reads `window.App`.
  sandbox.window.App = sandbox.App;
  sandbox.window.PlatformUI = { toast: (...args) => toasts.push(args) };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  return sandbox.window.GroupChat;
}

const closeOffer = (status, over = {}) => ({
  homeroomBot: {
    kind: 'voice',
    offer: { id: 1, kind: 'close_request', status, forUserId: null, ...over },
    actions: status === 'open'
      ? [{ id: 'yes', label: 'Propose to close', style: 'primary' }, { id: 'no', label: 'Keep it open', style: 'secondary' }]
      : [],
  },
});

test('#6582: an offer that is gone, expired or retired is read, with no actions left to tap', () => {
  const gc = loadGroupChat(9);
  for (const status of ['gone', 'expired', 'retired']) {
    const view = gc._botOfferView(closeOffer(status));
    assert.ok(view, `${status} is a status the row reads`);
    assert.equal(view.status, status);
    assert.equal(view.forMe, true);
    assert.deepEqual(view.actions, [], 'nothing to tap');
  }
  assert.equal(gc._botOfferView(closeOffer('gone')).status, 'gone');
  // Its card's id, which a tap sends; a retired one keeps why.
  assert.equal(gc._botOfferView(closeOffer('open')).id, 1);
  assert.equal(gc._botOfferView(closeOffer('retired', { retired: 'close_vote' })).retired, 'close_vote');
});

test('#6582, step 3: a tap sends its card\'s id, and a refusal is kept for its message, never toasted', async () => {
  const toasts = [];
  const messageId = 238255;
  const seen = [];
  let answer = { ok: false, status: 410, body: { error: 'That offer is no longer needed.', code: 'retired', reason: 'close_vote' } };
  const gc = loadGroupChat(9, {
    toasts,
    async fetch(url, options) {
      seen.push({ url, body: JSON.parse(options.body) });
      return { ok: answer.ok, status: answer.status, async json() { return answer.body; } };
    },
  });
  gc.appSlug = 'usernode-2d5619';
  const out = await gc.decideBotOffer(messageId, 'yes', undefined, 77);
  assert.deepEqual(plain(out), { ok: false, code: 'retired' });
  assert.equal(seen[0].url, `/api/apps/usernode-2d5619/messages/${messageId}/bot-offer`);
  assert.deepEqual(seen[0].body, { choice: 'yes', offerId: 77 }, 'the card it is for');
  assert.deepEqual(plain(gc._offerRefusals.get(messageId)), { code: 'retired', reason: 'close_vote' });
  assert.deepEqual(plain(gc._botOfferView(closeOffer('open'), messageId).refused), { code: 'retired', reason: 'close_vote' },
    'the row reads it for as long as the chat is open');
  assert.equal(gc._botOfferView(closeOffer('open'), 1).refused, undefined, 'another message\'s offer has none');
  assert.equal(toasts.length, 0, 'the reason is shown under the offer, not toasted');

  // A tap that then goes through clears it.
  answer = { ok: true, status: 200, body: { ok: true } };
  assert.deepEqual(plain(await gc.decideBotOffer(messageId, 'yes', undefined, 77)), { ok: true, code: null });
  assert.equal(gc._offerRefusals.has(messageId), false);

  // No code of the server's: failed, the catalog's fallback line.
  answer = { ok: false, status: 400, body: {} };
  assert.deepEqual(plain(await gc.decideBotOffer(5, 'no')), { ok: false, code: 'failed' });
  assert.equal(seen[seen.length - 1].body.offerId, undefined, 'a client with no id sends none');
  // Sent, and the server already said what happened: nothing more is kept.
  answer = { ok: false, status: 409, body: { said: 'A vote is open.' } };
  assert.deepEqual(plain(await gc.decideBotOffer(6, 'yes', undefined, 3)), { ok: false, code: null });
  assert.equal(gc._offerRefusals.has(6), false);
  // The request never left: failed.
  const offline = loadGroupChat(9, { toasts, async fetch() { throw new Error('offline'); } });
  offline.appSlug = 'usernode-2d5619';
  assert.deepEqual(plain(await offline.decideBotOffer(1, 'yes', undefined, 3)), { ok: false, code: 'failed' });
  assert.equal(toasts.length, 0);
});

test('step 3: the line under an offer is drawn from its state and its refusal, and outlives its buttons', () => {
  const src = read('frontend/src/features/group-chat/transcript.tsx');
  const at = src.indexOf('export function BotOfferButtons');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /await controller\(\)\?\.decideBotOffer\?\.\(id, choice, many \? picks : undefined, offer\.id\)/, 'the tap names its card');
  assert.doesNotMatch(body, /setError/, 'the buttons keep no line of their own: it would go with them');
  const { renderComponent } = require('./lib/render-tsx');
  const rowBase = {
    id: 1, kind: 'message', username: 'homeroom_bot', time: '11:56', timeTitle: 't', bodyHtml: '<p>Already works.</p>',
    systemText: '', mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false, flash: false,
    showEdit: false, showBookmark: false, showReact: false, quote: null, reactions: [],
    attachments: [], voteRowClass: '', voteRef: null, specShare: null,
  };
  const lead = { earlier: false, placeholder: null, language: 'request', request: { loaded: true, githubMore: null } };
  const draw = (botOffer) => renderComponent('frontend/src/features/group-chat/transcript.tsx', 'RequestRows', {
    view: { lead, messages: [{ ...rowBase, botOffer }] },
  });
  const actions = [{ id: 'yes', label: 'Propose to close', primary: true }, { id: 'no', label: 'Keep it open', primary: false }];
  // Refused, with its buttons still up: the line is under them.
  const refused = draw({ status: 'open', forMe: true, kind: 'close_request', id: 7, actions, refused: { code: 'already_decided' } });
  assert.match(refused, /data-gc-bot-offer=""/);
  assert.match(refused, /role="status" data-gc-bot-offer-status="already_decided"[^>]*data-gc-bot-offer-error=""/);
  assert.ok(refused.includes(message('chat:group.botOffer.refused.alreadyDecided')));
  assert.ok(refused.indexOf('data-gc-bot-offer-status') > refused.indexOf('data-gc-bot-offer=""'), 'under the buttons');
  // Decided elsewhere meanwhile: the buttons go, the line stays.
  const decided = draw({ status: 'done', forMe: true, kind: 'close_request', id: 7, actions: [], refused: { code: 'already_decided' } });
  assert.doesNotMatch(decided, /data-gc-bot-offer=""/);
  assert.ok(decided.includes(message('chat:group.botOffer.refused.alreadyDecided')));
  // Retired, with why; expired; not for this viewer.
  assert.ok(draw({ status: 'retired', forMe: true, kind: 'overlap', retired: 'building', actions: [] })
    .includes(message('chat:group.botOffer.retired.building')));
  assert.ok(draw({ status: 'retired', forMe: true, kind: 'close_request', retired: 'close_vote', actions: [] })
    .includes(message('chat:group.botOffer.retired.closeVote')));
  assert.ok(draw({ status: 'retired', forMe: true, kind: 'overlap', retired: 'unheard_of', actions: [] })
    .includes(message('chat:group.botOffer.retired.other')));
  assert.ok(draw({ status: 'expired', forMe: true, kind: 'overlap', actions: [] }).includes(message('chat:group.botOffer.expired')));
  assert.ok(draw({ status: 'open', forMe: true, kind: 'overlap', actions, refused: { code: 'not_for_you' } })
    .includes(message('chat:group.botOffer.refused.notForYou')));
  assert.ok(draw({ status: 'open', forMe: true, kind: 'overlap', actions, refused: { code: 'failed' } })
    .includes(message('chat:group.botOffer.failed')));
  assert.doesNotMatch(draw({ status: 'retired', forMe: false, kind: 'overlap', retired: 'building', actions: [] }), /data-gc-bot-offer-status/);
  assert.doesNotMatch(draw({ status: 'open', forMe: true, kind: 'overlap', actions }), /data-gc-bot-offer-status/, 'an open offer says nothing');
});

test('#6582: a gone close offer\'s row draws the line where its buttons were', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const gone = { status: 'gone', forMe: true, kind: 'close_request', actions: [] };
  const rowBase = {
    id: 1, kind: 'message', username: 'homeroom_bot', time: '11:56', timeTitle: 't', bodyHtml: '<p>Already works.</p>',
    systemText: '', mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false, flash: false,
    showEdit: false, showBookmark: false, showReact: false, quote: null, reactions: [],
    attachments: [], voteRowClass: '', voteRef: null, specShare: null,
  };
  const lead = { earlier: false, placeholder: null, language: 'request', request: { loaded: true, githubMore: null } };
  const html = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'RequestRows', {
    view: { lead, messages: [{ ...rowBase, botOffer: gone }] },
  });
  assert.match(html, /data-gc-bot-offer-gone=""/);
  assert.ok(html.includes(message('chat:group.botOffer.goneClose')), 'the close offer\'s own line');
  assert.doesNotMatch(html, /data-gc-bot-offer=""/, 'no live buttons');
  assert.doesNotMatch(html, /Propose to close/);

  // Any other offer says only that it is gone: no ⋯ menu to point at.
  const other = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'RequestRows', {
    view: { lead, messages: [{ ...rowBase, botOffer: { ...gone, kind: 'copy_request' } }] },
  });
  assert.ok(other.includes(message('chat:group.botOffer.gone')), 'the plain line');
  assert.ok(!other.includes(message('chat:group.botOffer.goneClose')), 'not the close offer\'s');

  // Somebody else's gone offer draws nothing for this viewer.
  const theirs = renderComponent('frontend/src/features/group-chat/transcript.tsx', 'RequestRows', {
    view: { lead, messages: [{ ...rowBase, botOffer: { ...gone, forMe: false } }] },
  });
  assert.doesNotMatch(theirs, /data-gc-bot-offer-gone/);
});

test('#6582: both lines exist in the English catalog', () => {
  assert.equal(message('chat:group.botOffer.gone'), 'This offer is no longer available.');
  assert.match(message('chat:group.botOffer.goneClose'), /no longer available.*request’s ⋯ menu/);
});
