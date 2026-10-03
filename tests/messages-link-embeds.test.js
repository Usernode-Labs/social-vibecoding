'use strict';

// #3660: card sharing and link embedding in chats.
//
//   1. A link in a DM or a discussion to one of Homeroom's OWN pages (a
//      request, a proposal, a governance question, an app, a community's hub
//      or its discussion) draws the card it names under the message. Only
//      Homeroom's addresses count, nothing is ever fetched for another
//      site's link, and the card is resolved for the reader
//      (tests/link-cards-server.test.js pins that half).
//   2. A card's ⋯ menu says "Share to…" and opens one dialog that posts the
//      card into the DM, group, #general or app discussion picked.
//
// This pins the client: which addresses are Homeroom's and which page each
// names, that an embed draws only an AVAILABLE answer, where the embeds and
// the dialog are wired, and that a card shared to a discussion is posted as
// a link the discussion then draws as that card.
//
// Run with: node --test tests/messages-link-embeds.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const links = loadTsx('frontend/src/features/messages/homeroom-links.ts');
const { homeroomLinks, homeroomLinkOf, sameItem, MAX_LINK_EMBEDS } = links;

const pages = (text, origin = null) => homeroomLinks(text, origin)
  .map(({ type, appSlug, issueNumber, sessionId, proposalId, href }) => ({
    type, appSlug, ...(issueNumber ? { issueNumber } : {}), ...(sessionId ? { sessionId } : {}),
    ...(proposalId ? { proposalId } : {}), href,
  }));

test('every page a Homeroom link can name, in both of the router’s spellings', () => {
  const at = (route) => pages(`see https://app.onhomeroom.com/${route}`)[0] || null;
  assert.deepEqual(at('app/recipes/dev/issues/12'),
    { type: 'issue', appSlug: 'recipes', issueNumber: 12, href: '#app/recipes/dev/issues/12' });
  assert.deepEqual(at('#app/recipes/dev/issues/12'),
    { type: 'issue', appSlug: 'recipes', issueNumber: 12, href: '#app/recipes/dev/issues/12' },
    'the fragment spelling, as the bot writes it');
  assert.deepEqual(at('app/recipes/dev/proposals/41'),
    { type: 'proposal', appSlug: 'recipes', sessionId: 41, href: '#app/recipes/dev/proposals/41' });
  assert.deepEqual(at('app/recipes/dev/shared/41'),
    { type: 'proposal', appSlug: 'recipes', sessionId: 41, href: '#app/recipes/dev/shared/41' },
    'a shared change opens the page it was linked at');
  assert.deepEqual(at('app/recipes/dev/governance/5'),
    { type: 'governance', appSlug: 'recipes', proposalId: 5, href: '#app/recipes/dev/governance/5' });
  for (const hub of ['app/recipes/workshop', 'app/recipes/board', 'app/recipes/dev', 'app/recipes/dev/issues', 'app/recipes/workshop/']) {
    assert.deepEqual(at(hub), { type: 'hub', appSlug: 'recipes', href: '#app/recipes/workshop' }, hub);
  }
  for (const room of ['app/recipes/dev/chat', 'app/recipes/group-chat', '#messages/app/recipes']) {
    assert.deepEqual(at(room), { type: 'discussion', appSlug: 'recipes', href: '#app/recipes/dev/chat' }, room);
  }
  assert.deepEqual(at('app/recipes'), { type: 'app', appSlug: 'recipes', href: '#app/recipes/app' });
  assert.deepEqual(at('app/recipes/app'), { type: 'app', appSlug: 'recipes', href: '#app/recipes/app' });
  // Pages that are not cards, and addresses that do not parse.
  for (const none of [
    '', '#messages/12', '#messages/12/m/40', '#profile/ada', '#settings', 'app/recipes/dev/sessions/new',
    'app/recipes/dev/issues/abc', 'app/recipes/dev/issues/0', 'app/recipes/dev/issues/99999999999',
    'app/Recipes/dev/issues/12', 'app/recipes/elsewhere', 'app/recipes/dev/settings/x',
  ]) {
    assert.equal(at(none), null, none || '(root)');
  }
  // "Copy link to message" writes the page's path AND a message fragment:
  // the router reads the fragment, so the link is the message, not the app.
  assert.equal(at('app/recipes/workshop#messages/12/m/40'), null);
});

test('only Homeroom’s own addresses count: never another site, never a lookalike', () => {
  const route = 'app/recipes/dev/issues/12';
  for (const host of ['https://app.onhomeroom.com', 'https://my.onhomeroom.com', 'https://onhomeroom.com', 'https://www.onhomeroom.com', 'https://APP.onhomeroom.com']) {
    assert.equal(pages(`${host}/${route}`).length, 1, host);
  }
  for (const host of [
    'https://onhomeroom.com.example', 'https://evilonhomeroom.com', 'https://staging.onhomeroom.com',
    'http://app.onhomeroom.com', 'https://app.onhomeroom.com:8443', 'https://ada:pw@app.onhomeroom.com',
    'https://example.com', 'ftp://app.onhomeroom.com',
  ]) {
    assert.deepEqual(pages(`${host}/${route}`), [], host);
  }
  // A Homeroom address carried INSIDE another site's link is that site's link.
  assert.deepEqual(pages(`https://example.com/?next=https://app.onhomeroom.com/${route}`), []);
  assert.deepEqual(pages(`https://example.com/#https://app.onhomeroom.com/${route}`), []);
  // This document's own origin counts, whatever it is (a staging preview, a
  // local stack), and only with its exact scheme and port.
  assert.equal(pages(`http://localhost:3000/${route}`, 'http://localhost:3000').length, 1);
  assert.deepEqual(pages(`http://localhost:3001/${route}`, 'http://localhost:3000'), []);
  assert.equal(pages(`https://pr-7.staging.example/${route}`, 'https://pr-7.staging.example').length, 1);
});

test('links in running text: markdown, punctuation, repeats and the cap', () => {
  const text = [
    'Look at [this request](https://app.onhomeroom.com/app/recipes/dev/issues/12).',
    'Same one: https://app.onhomeroom.com/#app/recipes/dev/issues/12, again.',
    'And the hub (https://app.onhomeroom.com/app/recipes/workshop)!',
    'Plus <https://app.onhomeroom.com/app/recipes/dev/chat> and https://example.com/app/recipes/dev/issues/3',
    'and https://app.onhomeroom.com/app/other/dev/proposals/9?',
  ].join('\n');
  assert.deepEqual(homeroomLinks(text, null).map((link) => link.key),
    ['issue:recipes:12', 'hub:recipes:', 'discussion:recipes:'],
    'each page once, in order, at most three');
  assert.equal(MAX_LINK_EMBEDS, 3);
  assert.equal(homeroomLinks(text, null, 10).length, 4, 'the fourth page is there past the cap');
  assert.deepEqual(homeroomLinks('', null), []);
  assert.deepEqual(homeroomLinks('no links here, just app/recipes/dev/issues/12', null), []);
});

test('a link to an item the message already carries as a card is not drawn twice', () => {
  const issue = homeroomLinkOf('https://app.onhomeroom.com/app/recipes/dev/issues/12', null);
  assert.equal(sameItem(issue, { type: 'issue', appSlug: 'recipes', issueNumber: 12 }), true);
  assert.equal(sameItem(issue, { type: 'issue', appSlug: 'recipes', issueNumber: 13 }), false);
  assert.equal(sameItem(issue, { type: 'issue', appSlug: 'other', issueNumber: 12 }), false);
  const proposal = homeroomLinkOf('https://app.onhomeroom.com/#app/recipes/dev/proposals/41', null);
  assert.equal(sameItem(proposal, { type: 'proposal', appSlug: 'recipes', sessionId: 41 }), true);
  assert.equal(sameItem(proposal, { type: 'spec', appSlug: 'recipes', sessionId: 41 }), false);
});

test('an embed draws the answers that came back available, and nothing else', async () => {
  const asked = [];
  const cards = loadTsx('frontend/src/features/messages/link-cards.tsx', {
    stubs: {
      './api': {
        resolveLinkCards: async (refs) => {
          asked.push(refs.map((ref) => ref.key));
          return refs.map((ref) => (ref.type === 'issue'
            ? { type: 'issue', available: true, appSlug: 'recipes', issueNumber: 12, title: 'Sort the list', subtitle: 'Recipes', state: 'open', author: 'ada', href: '#app/recipes/dev/issues/12' }
            : { type: ref.type, available: false }));
        },
      },
    },
  });
  const text = 'https://app.onhomeroom.com/app/recipes/dev/issues/12 and https://app.onhomeroom.com/app/secret/workshop';
  const draw = (props = {}) => renderToHtml(createElement(cards.LinkEmbeds, { text, ...props }));
  assert.equal(draw(), '', 'nothing while the answers are on their way');

  cards.requestLinkCards(homeroomLinks(text, null));
  cards.requestLinkCards(homeroomLinks(text, null));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(asked, [['issue:recipes:12', 'hub:secret:']], 'one request for both, asked once');

  const html = draw();
  assert.match(html, /class="messages-object-list messages-link-embeds" data-link-embeds=""/);
  assert.match(html, /<a href="#app\/recipes\/dev\/issues\/12" class="messages-object-card"/);
  assert.match(html, /Sort the list/);
  assert.equal((html.match(/messages-object-card/g) || []).length, 1,
    'the hub the reader cannot see draws no card, not an "Unavailable" one');
  assert.doesNotMatch(html, /Unavailable/);

  assert.equal(draw({ exclude: [{ type: 'issue', appSlug: 'recipes', issueNumber: 12 }] }), '',
    'a card already on the message is not drawn again');
  assert.equal(renderToHtml(createElement(cards.LinkEmbeds, { text: 'https://example.com/app/recipes/dev/issues/12' })), '');
  cards.resetLinkCards();
});

test('the two transcripts draw link cards under a person’s words', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /import \{ LinkEmbeds \} from '\.\/link-cards';/);
  assert.match(row, /\{message\.content && !message\.moderated \? <LinkEmbeds text=\{message\.content\} exclude=\{message\.objects\} \/> : null\}/,
    'a DM, a group and #general: never repeating a card the message carries');
  const transcript = read('frontend/src/features/group-chat/transcript.tsx');
  assert.match(transcript, /import \{ LinkEmbeds \} from '\.\.\/messages\/link-cards';/);
  const messageRow = transcript.slice(transcript.indexOf('export const MessageRow = memo('));
  assert.match(messageRow, /<Attachments items=\{msg\.attachments\} \/>[\s\S]*?\{msg\.text \? <LinkEmbeds text=\{msg\.text\} inboxOnly \/> : null\}/,
    'an app’s discussion: every person’s message, after its files');
  const css = read('public/css/app.css');
  assert.match(css, /\.gc-msg \.messages-link-embeds \.messages-object-card \{\s*background-color: var\(--dc-sheet-fill\);/,
    'outside the Messages layout the card wears the discussion’s own surface');
});

test('Share to… lists where the sharer can write, and posts a discussion share as its link', () => {
  const dialog = loadTsx('frontend/src/features/messages/share-to-dialog.tsx');
  const conversation = (over) => ({
    id: 1, kind: 'direct', title: 'Direct message', members: [], memberCount: 2, membershipStatus: 'member',
    myRole: 'member', canSend: true, canInvite: false, canManage: false, lastActivityAt: '', unreadCount: 0, ...over,
  });
  const rows = dialog.shareDestinations([
    conversation({ id: 1, peer: { id: 9, username: 'ada' } }),
    conversation({ id: 2, kind: 'group', title: 'Design crew', memberCount: 4 }),
    conversation({ id: 3, kind: 'channel', title: 'general', channelKey: 'general' }),
    conversation({ id: 4, membershipStatus: 'invited' }),
    conversation({ id: 5, canSend: false }),
    conversation({ id: 6, archived: true }),
  ], [
    { slug: 'recipes', name: 'Recipes', channel: 'recipes' },
    { slug: 'homeroom', name: 'Homeroom', channel: 'homeroom' },
  ], { me: 3, platform: 'homeroom' });
  assert.deepEqual(rows.map((row) => [row.key, row.kind, row.label, row.detail]), [
    ['c:1', 'direct', '@ada', 'Direct message'],
    ['c:2', 'group', 'Design crew', 'Group · 4 members'],
    ['c:3', 'channel', '#general', 'Everyone on Homeroom'],
    ['d:recipes', 'discussion', 'Recipes', '#recipes · Discussion'],
  ], 'no invitation, no request waiting on acceptance, nothing archived, and Homeroom’s own room is #general');

  // The link a discussion share posts is one the discussion draws as the
  // same card.
  for (const item of [
    { type: 'issue', appSlug: 'recipes', issueNumber: 12 },
    { type: 'proposal', appSlug: 'recipes', sessionId: 41 },
    { type: 'governance', appSlug: 'recipes', proposalId: 5 },
  ]) {
    const link = dialog.itemLink(item, 'https://app.onhomeroom.com');
    const page = homeroomLinkOf(link, null);
    assert.ok(page && sameItem(page, item), `${link} embeds as the card it shares`);
  }
  assert.equal(dialog.itemLink({ type: 'issue', appSlug: 'recipes', issueNumber: 12 }, 'https://app.onhomeroom.com'),
    'https://app.onhomeroom.com/app/recipes/dev/issues/12');
  const refused = (status, message) => new (loadTsx('frontend/src/features/messages/api.ts').MessagesApiError)(status, message);
  assert.equal(dialog.shareError(refused(404, 'App not found'), { kind: 'discussion', label: 'Recipes' }),
    'You can’t post in the Recipes discussion.', 'a discussion that hides who may post reads as the place');
  assert.equal(dialog.shareError(refused(403, 'Join Recipes to take part: members start changes, file requests, vote and chat there.'), { kind: 'discussion', label: 'Recipes' }),
    'Join Recipes to take part: members start changes, file requests, vote and chat there.');
  assert.equal(dialog.itemName({ type: 'issue', issueNumber: 12 }), 'Request #12');
  assert.equal(dialog.itemName({ type: 'proposal', sessionId: 41 }), 'Proposal #41');
});

test('Share to… is wired: the dialog, its sends, and the card menus that open it', () => {
  const source = read('frontend/src/features/messages/share-to-dialog.tsx');
  assert.match(source, /useDialog<ShareToPayload>\('shareTo'/);
  assert.match(source, /<DialogRoot id="share-to-dialog" layout="scroll"/);
  assert.match(source, /await shareToConversation\(choice\.conversation\.id, reference, note\)/,
    'a conversation takes the card as a shared item');
  assert.match(source, /await api\.postAppMessage\(choice\.slug, words \? `\$\{words\}\\n\\n\$\{link\}` : link\)/,
    'a discussion takes the card’s link');
  assert.match(source, /const rows = useMemo\(\(\) => \(dialog\.isOpen\s*\?/,
    'rows draw only while open, so the prerendered card is the same empty shell');
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /<ShareItemDialog \/>\s*<ShareToDialog \/>/);
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /export async function shareToConversation\(conversationId: number, object: SharedObjectReference, note = ''\)/);
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /request<unknown>\('\/api\/link-cards', \{ method: 'POST'/);
  assert.match(api, /request<unknown>\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/messages`/);

  const appView = read('public/js/app-view.js');
  const share = appView.slice(appView.indexOf('  _shareCardToMessages(reference) {'));
  assert.match(share.slice(0, 600), /const dialog = window\.UsernodeReact\?\.dialogs\?\.shareTo;\s*if \(dialog\) return dialog\.open\(card\);/);
  assert.equal((appView.match(/label: 'Share to…',/g) || []).length, 2, 'the issue and proposal ⋯ menus');
  assert.doesNotMatch(appView, /'Share to Messages'/);
});
