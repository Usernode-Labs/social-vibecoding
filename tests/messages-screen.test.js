'use strict';

// Frontend contract for #488. These assertions deliberately pin the seams
// where a private, React-owned screen meets the classic hash router and REST
// API. The database behavior lives in platform-messaging-*.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
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
  // A TAB since #2718, not a menu row. The destination and its address are
  // unchanged; what changed is that it is on screen instead of two taps down
  // inside a sheet you open to choose where to go.
  assert.match(html, /id="platform-tab-messages"[^>]*href="#messages"/);
  // #drawer-messages-badge stays retired, and the count that replaced it is
  // the TAB's. #1431 put an unread number on a header chat bubble and #1443
  // moved it onto the menu row; both made one incoming message light two
  // badges in two colours, and the one it lit sat inside a closed sheet. A
  // tab is visible without opening anything, which is the difference the
  // argument turned on.
  assert.doesNotMatch(html, /drawer-messages-badge/,
    'the retired row tag stays retired');
  assert.match(html, /id="platform-tabs-badge"/, 'the tab is what can carry a count');
  // The bar's order, pinned as a declared check. `+` rather than `~`: the
  // five tabs are adjacent siblings. Messages sits in the middle;
  // Communities (key `workshop`) comes after it, beside you. D (18 Oct
  // 2026): the communities you pinned, then your others, sit between
  // Messages and the Communities tab, drawn only on a desktop, and the
  // strip's apps that sat before Me (#4417) are gone: each community's app
  // is a row under it. v3: Messages' nested conversations follow it, an
  // empty element when shut.
  assert.ok(dapp.tests.some((entry) => entry.expectSelector
    === '#platform-tabs #platform-tab-home + #platform-tab-discover + #platform-tab-messages + #platform-rail-conversations'
      + ' + #platform-rail-pinned + #platform-rail-communities + #platform-tab-workshop[href="#communities"] + #platform-tab-me'),
  'a declared check pins the bar order');
  assert.match(screen, /useVisibilityHiddenClass\(screenRef, 'messages-screen', false\)/);
  // Membership INSIDE the array literal. The previous form,
  // /REACT_SCREEN_IDS:[\s\S]*?'messages-screen'/, matched the id anywhere
  // later in the file — SCREEN_IDS, getElementById('messages-screen'), the
  // route table — and so passed for the whole time the id was missing from
  // this list (#1431 took it out when Messages became a sheet; #1444 made
  // Messages a screen again and put it back everywhere except here). Two
  // owners of one `hidden` class was the result, and six declared checks
  // failed by the timing of whichever visibility publish came last.
  const reactOwned = /REACT_SCREEN_IDS:\s*\[([\s\S]*?)\]/.exec(app);
  assert.ok(reactOwned, 'REACT_SCREEN_IDS is an array literal');
  assert.match(reactOwned[1], /'messages-screen'/,
    'the island owns #messages-screen\'s hidden class, so app.js must publish, not toggle');
  assert.match(app, /parts\[0\] === 'messages'[\s\S]{0,1400}navigateToMessages/);
});

test('an app\'s channel address goes to its project page\'s Discussion tab; only Homeroom\'s archive stays here', () => {
  // #2718 review. The row was listed in this inbox and addressed as
  // `#app/<slug>/dev/chat` — a different SCREEN ROOT — so a row in this list
  // opened a full-window takeover with the app view's own back slot instead
  // of a pane beside the list. Both complaints it drew ("still one pane for
  // apps", "back goes to the workshop") were that one mismatch.
  //
  // #3653: the room is its project page's Discussion tab now, so the address
  // goes there (App._appChatToHub, tests/discussion-in-hub.test.js); the one
  // room still drawn here is Homeroom's archived app chat.
  const routeStart = app.indexOf("if (parts[0] === 'messages')");
  const messagesRoute = app.slice(routeStart, app.indexOf("if (parts[0] === 'topochain')", routeStart));
  assert.match(messagesRoute, /parts\[1\] === 'app' && parts\[2\]/, 'the inbox reads the address');
  // #2387: what follows the slug — a reply thread, a message link — rides
  // along as a fourth argument (App._messagesExtras).
  assert.match(messagesRoute, /if \(App\._appChatToHub\(parts\[2\], parts\.slice\(3\), hash\)\) return;\s*App\.navigateToMessages\(null, parts\[2\], null, App\._messagesExtras\(parts\.slice\(3\)\)\)/);
  // #2813 added the agent thread as a third argument, last in precedence;
  // #2387 the thread/link extras as a fourth.
  assert.match(app, /navigateToMessages\(conversationId, appSlug, agent, extras\)/);
  // The hub's record still names the room at this address; the hub's own
  // Discussion row opens the project page's Discussion place, where the
  // room is drawn whole, and links nowhere else.
  assert.match(read('src/routes/apps.js'), /href: `#messages\/app\/\$\{encodeURIComponent\(app\.slug\)\}`,/);
  assert.match(read('frontend/src/features/dev-board/workshop/hub-cards.tsx'),
    /data-ws-channel="preview"\s+data-ws-channel-open=""[\s\S]{0,120}onClick=\{onOpen\}/);
  // ONE THREAD IS OPEN: naming an app clears the conversation and the other
  // way round, so the pane never holds half of each.
  assert.match(store, /const nextSlug = nextId \? null : validSlug\(appSlug\);/);
  // The pane is a HOST for features/group-chat, not a second transcript.
  assert.match(screen, /function AppDiscussionThread/);
  assert.match(screen, /renderGroupChatTab\?\.\(\{ host: el, slug, name, readOnly, archived \}\)/);
  // …and it drops BOTH portals on the way out, the transcript's first.
  assert.match(screen, /unmountTranscript\?\.\(list\)[\s\S]{0,120}unmountGeneralChat\?\.\(el\)/);
  // The list collapses for a discussion exactly as it does for a thread.
  assert.match(screen, /snap\.route\.conversationId \|\| snap\.route\.appSlug \|\| snap\.route\.agent \? 'hidden md:flex' : 'flex'/);
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

test('the conversation list loads only after auth and reconciles on reconnect', () => {
  const initialize = store.slice(store.indexOf('export function initializeMessagesStore()'),
    store.indexOf('\n}', store.indexOf('export function initializeMessagesStore()')) + 2);
  assert.match(initialize, /if \(window\.App\?\.user\) void loadConversations\(\)/,
    'an already-authenticated shell seeds the always-mounted conversation store');
  assert.match(initialize, /else document\.addEventListener\('sv:authed', onAuthed, \{ once: true \}\)/,
    'an anonymous shell waits instead of issuing a session-gated request');
  assert.match(initialize, /document\.removeEventListener\('sv:authed', onAuthed\)/,
    'the auth listener is cleaned up if the island unmounts first');
  const resyncStart = app.indexOf('  resyncCurrentView() {');
  const resync = app.slice(resyncStart, app.indexOf('// #1038:', resyncStart));
  // #3705: `resync` — the list, and the conversation on screen with it.
  assert.match(resync, /window\.UsernodeReact\?\.messages\?\.resync\?\.\(\)/);
  assert.doesNotMatch(resync, /_inMessages[\s\S]*messages\?\.resync/,
    'reconnect refreshes the conversation list even when the Messages screen is closed');
  const storeResync = store.slice(store.indexOf('export async function resync('),
    store.indexOf('\n}', store.indexOf('export async function resync(')));
  assert.match(storeResync, /const reads = \[loadConversations\(true\)\];/,
    'the list is re-read whatever is on screen');
});

test('an invitation resolves metadata before deciding whether history may be fetched', () => {
  const fn = store.slice(store.indexOf('export async function loadThread('),
    store.indexOf('export async function loadOlder('));
  const detailAt = fn.indexOf('await api.getConversation(conversationId, read)');
  const statusAt = fn.indexOf("active.membershipStatus === 'member'");
  const messagesAt = fn.indexOf('await api.listMessages(conversationId, null, read)');
  assert.ok(detailAt > -1 && detailAt < statusAt && statusAt < messagesAt);
  assert.match(screen, /t\('messages:invitation\.invitedBy', \{ username: requesterUser\.username \}\)/);
  assert.match(message('messages:invitation.invitedBy', { username: 'ada' }), /^@ada invited you\. Accepting gives you access to the complete retained conversation history\.$/);
  assert.match(api, /if \(raw === null \|\| \(action === 'decline'/,
    'a declined invitation never normalizes a synthetic id=0 conversation');
  assert.equal(message('messages:invitation.declineAndBlock', { username: 'ada' }), 'Decline & block @ada');
  assert.match(screen, /t\('messages:invitation\.declineAndBlock', \{ username: requesterUser\.username \}\)/,
    'both direct and group invitations expose a pre-accept requester block action');
  const block = screen.slice(screen.indexOf('async function declineAndBlock()'),
    screen.indexOf('  return (', screen.indexOf('async function declineAndBlock()')));
  const apiAt = block.indexOf('await api.setBlock(requesterId, true)');
  const purgeAt = block.indexOf('await finishDirectBlock(conversationId)');
  assert.ok(apiAt > -1 && apiAt < purgeAt,
    'the committed global block/decline is followed immediately by local invitation purge');
});

// #3228: a group invitation names the group, how many people are already in
// it, and the inviter's note; without a note the card says who invited you,
// as before. The optional note field rides both dialogs that invite.
test('a group invitation names the group and carries the inviter\'s note', () => {
  const createDialog = read('frontend/src/features/messages/create-dialog.tsx');
  const membersDialog = read('frontend/src/features/messages/members-dialog.tsx');
  const types = read('frontend/src/features/messages/types.ts');
  assert.match(screen, /t\('messages:invitation\.groupSummary', \{ title: active\.title, count: active\.memberCount \|\| 0 \}\)/);
  assert.match(screen, /t\('messages:invitation\.addedYouWithNote', \{ username: requesterUser\.username, note: active\.inviteNote \}\)/);
  assert.equal(message('messages:invitation.groupSummary', { title: 'Friday demo crew', count: 4 }), 'Friday demo crew · 4 members');
  assert.equal(message('messages:invitation.groupSummary', { title: 'Friday demo crew', count: 1 }), 'Friday demo crew · 1 member');
  assert.equal(message('messages:invitation.addedYouWithNote', { username: 'ada', note: 'Planning the Friday demo' }), '@ada added you: Planning the Friday demo');
  assert.equal(message('messages:invitation.historyNotice'), 'Accepting gives you access to the complete retained conversation history.');
  // Without a note, today's "invited you" sentence stays.
  assert.match(screen, /t\('messages:invitation\.invitedBy', \{ username: requesterUser\.username \}\)/);
  // Both dialogs carry the optional note, capped at 140, through to the API.
  assert.match(createDialog, /t\('messages:create\.inviteNote'\)/);
  assert.match(createDialog, /createGroup\(title\.trim\(\), selected\.map\(\(user\) => user\.id\), note\.trim\(\) \|\| undefined\)/);
  assert.match(membersDialog, /t\('messages:members\.inviteNote'\)/);
  assert.match(membersDialog, /inviteMembers\(selected\.map\(\(user\) => user\.id\), note\.trim\(\) \|\| undefined\)/);
  assert.match(types, /inviteNote\?: string \| null/);
  assert.equal(message('messages:create.inviteNote'), 'Note for the people you invite (optional)');
});

// #5019: scrolling up near the top of a conversation reads the previous page
// in, in place of the button that used to sit at its top. The button returns
// only to retry a failed load.
test('a conversation loads earlier messages on scroll, one page at a time', () => {
  assert.match(screen, /import \{ centreInScroller, isNearTop, needsMoreHistory, useStickToBottom \} from '\.\/stick-to-bottom';/);
  const thread = screen.slice(screen.indexOf('function ConversationThread('), screen.indexOf('function ThreadActivityRow('));
  assert.ok(thread.length > 0);
  assert.match(thread, /if \(!isNearTop\(el\)\) return;/,
    'the scroll position decides, not a click');
  assert.match(thread, /olderGate\.current = \{ conversationId, nextBefore: snap\.nextBefore, loadingOlder: snap\.loadingOlder, loadingThread: snap\.loadingThread, olderFailed \}/,
    'the scroll listener reads the latest values through a ref, so it attaches once per scroller');
  assert.match(thread, /if \(!gate\.nextBefore \|\| gate\.loadingOlder \|\| gate\.loadingThread \|\| gate\.olderFailed\) return;/,
    'one page at a time, and nothing while loading or after a failure');
  assert.match(thread, /el\.addEventListener\('scroll', onScroll, \{ passive: true \}\)/);
  assert.match(thread, /return \(\) => el\.removeEventListener\('scroll', onScroll\)/,
    'the listener is removed with the conversation');
  assert.match(thread, /if \(!ok\) setOlderFailed\(true\)/,
    'a failed load restores the button as the manual retry');
  assert.match(thread, /useIsomorphicLayoutEffect\(\(\) => \{ setOlderFailed\(false\); \}, \[conversationId, snap\.nextBefore\]\)/,
    'a new conversation, or a new cursor, clears the failure');
  assert.match(thread, /if \(needsMoreHistory\(el\)\) maybeLoadOlder\(\)/,
    'a short thread keeps reading pages in until the screen fills');
  // The row where the button used to be: fixed height, the "Loading…" line
  // while it works, the button only after a failure.
  const olderRow = thread.slice(thread.indexOf('data-load-older=""') - 60);
  assert.ok(olderRow.length > 0);
  assert.match(olderRow, /className="flex h-12 items-center justify-center" data-load-older=""/);
  assert.match(olderRow, /role="status"/);
  assert.match(olderRow, /\{t\('messages:thread\.loadingOlder'\)\}/);
  assert.match(olderRow, /\{t\('messages:thread\.loadEarlier'\)\}/);
  // loadOlder says whether it read a page, and the scroll anchor follows it.
  const loadOlder = store.slice(store.indexOf('export async function loadOlder('), store.indexOf('function validId('));
  assert.match(loadOlder, /Promise<boolean>/);
  assert.match(loadOlder, /return false;/, 'only the failed request says false');
  assert.match(screen, /const ok = await loadOlder\(\);/);
  assert.match(screen, /return ok;/);
});

test('message creation realtime carries ids and refetches viewer-authorized REST data', () => {
  for (const type of [
    'conversation_message_created', 'conversation_message_updated',
    'conversation_reaction_updated', 'conversation_read',
    'conversation_membership_changed', 'conversation_typing',
  ]) {
    assert.match(app, new RegExp(`case '${type}'`));
  }
  // #2387: created and updated share one block (a thread reply re-reads its
  // thread as well as the conversation), so the slice runs to the next case.
  const created = store.slice(store.indexOf("case 'conversation_message_created'"),
    store.indexOf("case 'conversation_reaction_updated'"));
  assert.match(created, /loadThread\(conversationId, true\)/);
  assert.doesNotMatch(created, /normalizeMessage\(event\.message/,
    'WS must never trust a sender-hydrated private object card');
  assert.match(store, /filter\(\(item\) => item\.clientKey !== key && item\.id !== message\.id\)/,
    'HTTP completion removes both the local row and a raced-in server row');
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
  const sharedReport = fs.readFileSync(path.join(ROOT, 'frontend/src/features/dialogs/report.tsx'), 'utf8');
  assert.match(row, /openReport\(\{ targetType: 'conversation_message'/);
  for (const reason of ['harassment', 'spam', 'threats', 'hate', 'sexual_content', 'other']) assert.ok(sharedReport.includes(`['${reason}',`));
  assert.match(sharedReport, /maxLength=\{1000\}/);
  assert.match(sharedReport, /fetch\('\/api\/reports'/);

});

test('blocking and access-revocation purge an active direct thread locally', () => {
  assert.match(screen, /await setUserBlocked\(peer\.id, true\)/);
  assert.match(store, /await api\.setBlock\(userId, blocked\)/);
  assert.match(store, /await finishDirectBlock\(active\.id\)/);
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
  // `out`, because the sanitized html is cached before it is returned
  // (tests/dev-chat-smoothness.test.js pins that it is byte-identical).
  assert.match(devChat, /const out = DOMPurify\.sanitize\(html, \{/);
  assert.match(devChat, /ALLOW_DATA_ATTR: false/);
  assert.match(devChat, /ALLOWED_TAGS:/);
});

test('staging demo stays server-authored while the client forwards demo=1', () => {
  assert.match(api, /new URLSearchParams\(window\.location\.search\)\.get\('demo'\) !== '1'/);
  assert.doesNotMatch(store, /demoConversations|demoMessages|mockConversation/,
    'production client code never invents private conversation data');
});
