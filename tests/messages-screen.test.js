'use strict';

// Frontend contract for #488. These assertions deliberately pin the seams
// where a private, React-owned screen meets the classic hash router and REST
// API. The database behavior lives in platform-messaging-*.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = read('public/index.html');
const app = read('public/js/app.js');
const api = read('frontend/src/features/messages/api.ts');
const store = read('frontend/src/features/messages/store.ts');
const screen = read('frontend/src/features/messages/index.tsx');
const composer = read('frontend/src/features/messages/composer.tsx');
const row = read('frontend/src/features/messages/message-row.tsx');
const markdown = read('frontend/src/features/messages/format.tsx');
const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
const dapp = JSON.parse(read('dapp.json'));

test('Messages is a hidden React-owned top-level screen with global navigation', () => {
  assert.match(html, /<main id="messages-screen" class="hidden /);
  assert.match(html, /id="drawer-row-messages" href="#messages"/);
  assert.match(html, /id="drawer-messages-badge" class="hidden /);
  // The nav order check. THE UI OVERHAUL took Leaderboard out of the
  // hamburger — a link to shared progress belongs beside the shared progress,
  // so it is the Challenges area's now — and the four rows left are the
  // navigation the drawer was always for.
  // Streamlined order (owner review round 2): Notifications + Messages lead
  // the drawer above Your apps; Profile, Settings, Admin close it.
  assert.ok(dapp.tests.some((entry) => entry.expectSelector
    === '#drawer-top-rows > #drawer-row-notifications + #drawer-row-messages'));
  assert.ok(dapp.tests.some((entry) => entry.expectSelector
    === '#drawer-main-rows #drawer-row-profile + #drawer-row-settings + #drawer-row-admin'));
  assert.match(screen, /useVisibilityHiddenClass\(screenRef, 'messages-screen', false\)/);
  assert.match(app, /REACT_SCREEN_IDS:[\s\S]*?'messages-screen'/);
  assert.match(app, /parts\[0\] === 'messages'[\s\S]{0,600}navigateToMessages/);
});

test('deep links validate ids and route list/thread without a client events socket send', () => {
  const routeStart = app.indexOf("if (parts[0] === 'messages')");
  const messagesRoute = app.slice(routeStart, app.indexOf("if (parts[0] === 'topochain')", routeStart));
  assert.match(messagesRoute, /const conversationId = App\._numericSegment\(parts\[1\]\)/);
  assert.match(messagesRoute, /conversationId != null && conversationId <= 2147483647/,
    'SERIAL conversation ids retain their signed-int32 bound without constraining other hash routes');
  assert.match(messagesRoute, /App\.navigateToMessages\(/);
  assert.match(api, /id <= MAX_ID/);
  assert.match(store, /const target = validId\(conversationId\) \? `#messages\/\$\{conversationId\}` : '#messages'/);
  assert.match(store, /api\.setTyping\(conversationId, typing\)/,
    'typing uses its authenticated HTTP endpoint');
  assert.doesNotMatch(store, /eventsWs.*send|eventsWsSend/,
    'the global event socket remains server-to-client only');
});

test('the global unread badge loads only after auth and reconciles on reconnect', () => {
  const initialize = store.slice(store.indexOf('export function initializeMessagesStore()'),
    store.indexOf('\n}', store.indexOf('export function initializeMessagesStore()')) + 2);
  assert.match(initialize, /if \(window\.App\?\.user\) void loadConversations\(\)/,
    'an already-authenticated shell seeds the always-mounted badge store');
  assert.match(initialize, /else document\.addEventListener\('sv:authed', onAuthed, \{ once: true \}\)/,
    'an anonymous shell waits instead of issuing a session-gated request');
  assert.match(initialize, /document\.removeEventListener\('sv:authed', onAuthed\)/,
    'the auth listener is cleaned up if the island unmounts first');
  const resyncStart = app.indexOf('  resyncCurrentView() {');
  const resync = app.slice(resyncStart, app.indexOf('// #1038:', resyncStart));
  assert.match(resync, /window\.UsernodeReact\?\.messages\?\.refresh\?\.\(\)/);
  assert.doesNotMatch(resync, /_inMessages[\s\S]*messages\?\.refresh/,
    'reconnect refreshes the drawer badge even when the Messages screen is closed');
});

test('an invitation resolves metadata before deciding whether history may be fetched', () => {
  const fn = store.slice(store.indexOf('export async function loadThread('),
    store.indexOf('export async function loadOlder('));
  const detailAt = fn.indexOf('await api.getConversation(conversationId)');
  const statusAt = fn.indexOf("active.membershipStatus === 'member'");
  const messagesAt = fn.indexOf('await api.listMessages(conversationId)');
  assert.ok(detailAt > -1 && detailAt < statusAt && statusAt < messagesAt);
  assert.match(screen, /Accepting gives you access to the complete retained conversation history/);
  assert.match(api, /if \(raw === null \|\| \(action === 'decline'/,
    'a declined invitation never normalizes a synthetic id=0 conversation');
  assert.match(screen, /Decline &amp; block @\{requesterUser\.username\}/,
    'both direct and group invitations expose a pre-accept requester block action');
  const block = screen.slice(screen.indexOf('async function declineAndBlock()'),
    screen.indexOf('  return (', screen.indexOf('async function declineAndBlock()')));
  const apiAt = block.indexOf('await api.setBlock(requesterId, true)');
  const purgeAt = block.indexOf('await finishDirectBlock(conversationId)');
  assert.ok(apiAt > -1 && apiAt < purgeAt,
    'the committed global block/decline is followed immediately by local invitation purge');
});

test('message creation realtime carries ids and refetches viewer-authorized REST data', () => {
  for (const type of [
    'conversation_message_created', 'conversation_message_updated',
    'conversation_reaction_updated', 'conversation_read',
    'conversation_membership_changed', 'conversation_typing',
  ]) {
    assert.match(app, new RegExp(`case '${type}'`));
  }
  const created = store.slice(store.indexOf("case 'conversation_message_created'"),
    store.indexOf("case 'conversation_message_updated'"));
  assert.match(created, /loadThread\(conversationId, true\)/);
  assert.doesNotMatch(created, /normalizeMessage\(event\.message/,
    'WS must never trust a sender-hydrated private object card');
  assert.match(store, /filter\(\(item\) => item\.id !== optimisticId && item\.id !== message\.id\)/,
    'HTTP completion removes both optimistic and raced-in server rows');
  const reaction = store.slice(store.indexOf("case 'conversation_reaction_updated'"),
    store.indexOf("case 'conversation_read'"));
  assert.match(reaction, /loadThread\(conversationId, true\)/);
  assert.doesNotMatch(reaction, /event\.reactions|normalizeMessage/,
    'id-only reaction events rehydrate under current viewer access');
  const typing = store.slice(store.indexOf("case 'conversation_typing'"),
    store.indexOf('export function typingUsers'));
  assert.match(typing, /active\.members\.find/);
  assert.doesNotMatch(typing, /event\.username/,
    'id-only typing events resolve names from the authorized active roster');
});

test('attachment ids remain opaque hex and a denied preview stays null', () => {
  assert.match(api, /\^\[a-f0-9\]\{32\}\$/);
  assert.match(api, /attachment_ids = input\.attachmentIds/);
  assert.match(api, /rawViewUrl === null \? null/);
  assert.match(row, /html && attachment\.viewUrl \?/,
    'the UI offers preview only when the backend did');
});

test('composer and moderation payloads match the backend contracts', () => {
  assert.match(composer, /const MAX_ATTACHMENTS = 4/);
  assert.match(composer, /slice\(0, 8000\)/);
  const shareHandler = composer.slice(composer.indexOf('const onShare ='),
    composer.indexOf("window.addEventListener('usernode:messages-object-selected'"));
  assert.match(shareHandler, /if \(!conversationId\) return/,
    'a bare Messages screen leaves an external share pending for destination selection');
  const consumeAt = shareHandler.indexOf('takePendingShare()');
  const openAt = shareHandler.indexOf('messagesShare?.open');
  assert.ok(consumeAt > -1 && consumeAt < openAt,
    'a synchronously delivered share clears its fallback before opening');
  assert.match(composer, /if \(conversationId\) \{[\s\S]{0,120}takePendingShare\(\)/,
    'selecting or creating a destination consumes the one-shot on route change');
  assert.match(composer, /\}, \[conversationId\]\);/,
    'the pending-share effect follows destination changes');
  const share = store.slice(store.indexOf('export async function share('),
    store.indexOf('export function takePendingShare'));
  assert.match(share, /if \(conversationId\) \{[\s\S]{0,180}dispatchEvent/,
    'current-conversation shares remain immediate without consuming bare-list intent');
  const close = store.slice(store.indexOf('export function close()'),
    store.indexOf('export function isOpen()'));
  assert.match(close, /pendingShare = undefined/,
    'leaving Messages cancels an unplaced external share');
  assert.ok(composer.includes("match(/(?:^|\\s)@([^\\s@]*)$/)"));
  assert.ok(composer.includes("replace(/@([^\\s@]*)$/"),
    'mention completion and insertion support hyphenated and other valid usernames');
  assert.match(api, /query\.trim\(\)\.slice\(0, 255\)[\s\S]{0,80}scope=messages/,
    'recipient search excludes users blocked in either direction');
  for (const reason of ['harassment', 'spam', 'threats', 'hate', 'sexual_content', 'other']) {
    assert.match(row, new RegExp(`value="${reason}"`));
  }
  assert.match(row, /setReportDetail\(event\.target\.value\.slice\(0, 500\)\)/);
  assert.match(row, /maxLength=\{500\}/);
  assert.match(api, /detail: detail\.slice\(0, 500\)/,
    'report context matches the backend and schema retention limit');
  assert.match(api, /JSON\.stringify\(\{ reason, \.\.\.\(detail \? \{ detail:/);
});

test('blocking and access-revocation purge an active direct thread locally', () => {
  assert.match(screen, /await api\.setBlock\(peer\.id, true\); await finishDirectBlock\(conversationId\)/);
  const purge = store.slice(store.indexOf('export async function finishDirectBlock('),
    store.indexOf('export function draftFor('));
  assert.match(purge, /active: null/);
  assert.match(purge, /messages: \[\]/);
  assert.match(purge, /open\(null\)/);
  assert.match(purge, /await loadConversations\(true\)/);
  const list = store.slice(store.indexOf('export async function loadConversations('),
    store.indexOf('export async function loadThread('));
  assert.match(list, /if \(state\.loadingList && !force\) return/,
    'forced post-revocation refresh supersedes an in-flight stale list');
  assert.match(list, /const request = \+\+listRequest/);
  assert.match(list, /if \(request !== listRequest\) return/,
    'the stale request token cannot republish a blocked conversation');
  const membership = store.slice(store.indexOf("case 'conversation_membership_changed'"),
    store.indexOf("case 'conversation_typing'"));
  assert.match(membership, /refreshActiveAfterMembershipChange\(conversationId\)/);
  assert.match(store, /refreshActiveAfterMembershipChange[\s\S]{0,500}finishDirectBlock\(conversationId\)/,
    'a remote removal/block 404 follows the same purge-and-list path');
});

test('message Markdown delegates only to the established DOMPurify allowlist', () => {
  assert.match(markdown, /window\.DevChat\.renderMarkdown\(content, \{ breaks: true \}\)/);
  assert.match(devChat, /return DOMPurify\.sanitize\(html, \{/);
  assert.match(devChat, /ALLOW_DATA_ATTR: false/);
  assert.match(devChat, /ALLOWED_TAGS:/);
});

test('staging demo stays server-authored while the client forwards demo=1', () => {
  assert.match(api, /new URLSearchParams\(window\.location\.search\)\.get\('demo'\) !== '1'/);
  assert.doesNotMatch(store, /demoConversations|demoMessages|mockConversation/,
    'production client code never invents private conversation data');
});
