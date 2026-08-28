// Spec sharing routed through Messages (#1343).
//
// Four seams, each of which a later refactor could silently undo:
//
//   1. The object-only message summary. A conversation message that carries
//      only a shared-object card (or only attachments) has empty content;
//      conversationMessageSummarySql (src/services/notifications.js) resolves
//      the display summary at the SQL boundary for all four consumers — the
//      dropdown list, the single-row fetch, the WS hydrate, and the
//      mobile-push worker — and messageSummary (src/services/conversations.js)
//      mirrors it for hydrated rows (the conversation list's latestSummary).
//   2. The /dev/spec deep link. A spec card's href must never point at the
//      owner-only dev-session route; the hash router parses, normalizes, and
//      re-serializes #app/<slug>/dev/spec/<sessionId>/<version>.
//   3. The dev-chat trigger. "Share in Messages" hands the version to
//      messagesController.share() — no fetch to the retired share-user route.
//   4. The staging fixtures. Conversation 910004's card-only message keeps
//      the fallback summary and the /dev/spec href reviewable in previews.
//
// The hash-router and fixture assertions are source-shape checks in the
// style of tests/hash-route-idempotence.test.js: public/js/** exposes no
// module seam, and the behaviour itself is covered by declared dapp.json
// checks against the staging preview.
//
// Run with: node --test tests/spec-share-messages.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const notifications = require('../src/services/notifications');
const conversations = require('../src/services/conversations');

const notificationsSource = read('src/services/notifications.js');
const pushWorkerSource = read('src/services/mobile-push-worker.js');
const conversationsSource = read('src/services/conversations.js');
const conversationRoutes = read('src/routes/conversations.js');
const sharedObjectsSource = read('src/services/shared-objects.js');
const appJs = read('public/js/app.js');
const appView = read('public/js/app-view.js');
const groupChat = read('public/js/group-chat.js');
const specViewerTsx = read('frontend/src/features/dev-chat/spec-viewer.tsx');
const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
const notificationsFe = read('frontend/src/features/notifications/notifications.js');
const storeTs = read('frontend/src/features/messages/store.ts');

// ── 1. Object-only message summaries ─────────────────────────────────────

const LABELS = {
  spec: 'Shared a spec version',
  app: 'Shared an app',
  github_issue: 'Shared an issue',
  code_proposal: 'Shared a code proposal',
  governance_proposal: 'Shared a governance proposal',
};

test('conversationMessageSummarySql falls back per object type, then attachments', () => {
  const sql = notifications.conversationMessageSummarySql('cm');
  assert.match(sql, /NULLIF\(cm\.content, ''\)/, 'non-empty content always wins');
  assert.match(sql, /conversation_message_objects/, 'keys on the stored object rows');
  assert.match(sql, /ORDER BY o\.position, o\.id LIMIT 1/, 'first card decides the label');
  for (const [type, label] of Object.entries(LABELS)) {
    assert.ok(sql.includes(`WHEN '${type}' THEN '${label}'`), `${type} labels as "${label}"`);
  }
  assert.match(sql, /conversation_message_attachments/, 'attachment-only messages get a label too');
  assert.ok(sql.includes("'Shared an attachment'"));
  // The fragment must key on object_type only — these queries run outside
  // any viewer's per-object access check, so a hydrated title cannot appear.
  assert.doesNotMatch(sql, /session_title|pr_title/);
});

test('all four conversation_message_content consumers use the shared fragment', () => {
  // notifications.js: hydrateAndPush, listForUser, getForUser.
  const inNotifications = notificationsSource.match(
    /\$\{conversationMessageSummarySql\('conversation_message'\)\} AS conversation_message_content/g
  ) || [];
  assert.equal(inNotifications.length, 3, 'WS hydrate + dropdown list + single-row fetch');
  // mobile-push-worker.js: loadDelivery.
  const inWorker = pushWorkerSource.match(
    /\$\{conversationMessageSummarySql\('conversation_message'\)\} AS conversation_message_content/g
  ) || [];
  assert.equal(inWorker.length, 1, 'the push worker reads the same summary');
  // No site regressed to the bare column.
  assert.ok(!notificationsSource.includes('conversation_message.content AS conversation_message_content'));
  assert.ok(!pushWorkerSource.includes('conversation_message.content AS conversation_message_content'));
});

test('messageSummary mirrors the SQL labels for hydrated rows', () => {
  const { messageSummary } = conversations;
  assert.equal(messageSummary(null), '');
  assert.equal(messageSummary({ content: 'hi', objects: [{ type: 'spec' }] }), 'hi');
  // Hydrated cards carry the PUBLIC type names.
  assert.equal(messageSummary({ content: '', objects: [{ type: 'spec' }] }), 'Shared a spec version');
  assert.equal(messageSummary({ content: '', objects: [{ type: 'app' }] }), 'Shared an app');
  assert.equal(messageSummary({ content: '', objects: [{ type: 'issue' }] }), 'Shared an issue');
  assert.equal(messageSummary({ content: '', objects: [{ type: 'proposal' }] }), 'Shared a code proposal');
  assert.equal(messageSummary({ content: '', objects: [{ type: 'governance' }] }), 'Shared a governance proposal');
  assert.equal(messageSummary({ content: '', objects: [], attachments: [{ id: 'x' }] }), 'Shared an attachment');
  assert.equal(messageSummary({ content: '', objects: [], attachments: [] }), '');
  // serializeConversation routes latestSummary through it.
  assert.match(conversationsSource, /latestSummary: accepted \? messageSummary\(latest\) : ''/);
});

// ── 2. The /dev/spec deep link ───────────────────────────────────────────

test('hydrateOne links spec cards to the share-gated spec panel route', () => {
  const specBranch = sharedObjectsSource.slice(
    sharedObjectsSource.indexOf("if (ref.object_type === 'spec')"),
  );
  assert.ok(specBranch.includes('/dev/spec/${row.session_id}/${row.version}'),
    'the card deep-links to the read-only spec panel');
  assert.ok(!specBranch.includes('/dev/sessions/'),
    'never the owner-only dev-session route, which 404s for recipients');
});

test('the hash router parses, normalizes, and re-serializes /dev/spec/:id/:version', () => {
  // Parse: #app/<slug>/dev/spec/<sessionId>/<version> → chat + spec ref.
  assert.match(appJs, /sec === 'spec' && parts\[4\] && parts\[5\]/);
  // Normalize: a malformed ref is dropped, a well-formed one is preserved.
  const normalize = appJs.slice(appJs.indexOf('_normalizeTab(tab, ref, subTab) {'));
  assert.match(normalize, /ref\.kind === 'spec'/);
  assert.match(normalize, /Number\.isInteger\(ref\.sessionId\) && ref\.sessionId > 0/);
  assert.match(normalize, /Number\.isInteger\(ref\.version\) && ref\.version > 0/);
  // Serialize: updateHash turns a live panel link into a spec ref and
  // _appUrl writes the deep link back. (#1472 moved URL building out of
  // updateHash into _appUrl, so the round trip is these two halves.)
  assert.match(appJs, /ref = \{ kind: 'spec', sessionId: specLink\.sessionId, version: specLink\.version \}/);
  assert.match(appJs, /dev\/spec\/\$\{norm\.ref\.sessionId\}\/\$\{norm\.ref\.version\}/);
  assert.match(appJs, /'governance', 'shared', 'spec'\]\)/);
});

test('the chat sub-view restores the panel and the panel close clears the link', () => {
  const chatSubView = appView.slice(
    appView.indexOf('_renderChatSubView(content, ref) {'),
    appView.indexOf('AppView.renderGroupChatTab();')
  );
  assert.match(chatSubView, /AppView\._devSpecLink = specRef/);
  assert.match(chatSubView, /GroupChat\._writeSpecPanelOpen\(AppView\.appData\.slug/);
  const closePanel = groupChat.slice(
    groupChat.indexOf('_closeSpecPanel() {'),
    groupChat.indexOf('_closeSpecPanel() {') + 2000
  );
  assert.match(closePanel, /AppView\._devSpecLink = null/);
});

test('historical spec_shared notifications take the same deep link', () => {
  const handler = notificationsFe.slice(
    notificationsFe.indexOf("item.kind === 'spec_shared'"),
  ).slice(0, 1600);
  assert.match(handler, /kind: 'spec', sessionId: item\.sessionId, version/);
  assert.match(handler, /dev\/spec\//);
});

// ── 3. The dev-chat trigger ──────────────────────────────────────────────

test('Share in Messages hands the version to messagesController.share()', () => {
  const fn = devChat.slice(devChat.indexOf('_shareSpecInMessages(version) {'));
  assert.match(fn, /window\.UsernodeReact && window\.UsernodeReact\.messages/);
  assert.match(fn, /type: 'spec'/);
  assert.match(fn, /sessionId: DevChat\.currentSession\.id/);
  assert.match(fn, /messages\.share\(reference\)/);
  // The retired route and its popover are gone from the client. (The
  // #dc-spec-viewer-share-user BUTTON id deliberately survives — only the
  // /share-user endpoint path must not.)
  assert.ok(!devChat.includes('/share-user'), 'no fetch to the retired endpoint');
  assert.ok(!devChat.includes('dc-spec-share-pop'), 'the username popover is retired');
  // The header's markup is the React component's since #1084 chunk G, so the
  // label and the retired popover are asserted there rather than on the module.
  assert.ok(!specViewerTsx.includes('dc-spec-share-pop'), 'the username popover is retired');
  assert.ok(specViewerTsx.includes("SHARE_USER_LABEL = 'Share in Messages'"),
    'the button is relabelled');
  assert.match(specViewerTsx, /_shareSpecInMessages\?\.\(version\)/,
    'the button calls the Messages hand-off through the controller');
});

test('a second pre-acceptance send keeps the card and explains the pending request', () => {
  assert.ok(storeTs.includes("Your message request is still pending. They'll see this once they accept."));
  const catchBlock = storeTs.slice(storeTs.indexOf('const pendingRequest ='));
  assert.match(catchBlock, /error\.status === 404/);
  assert.match(catchBlock, /kind === 'direct'/);
  assert.match(catchBlock, /setDraft\(conversationId, content\)/, 'the draft is restored for a retry');
});

// ── 4. Staging fixtures ──────────────────────────────────────────────────

test('the ?demo=1 fixtures cover the card-only message and the new href', () => {
  assert.ok(conversationRoutes.includes("title: 'Spec share fixture'"));
  assert.ok(conversationRoutes.includes("latestSummary: 'Shared a spec version'"),
    'the list row shows the fallback, never "No messages yet"');
  const hrefs = conversationRoutes.match(/#app\/usernode\/dev\/spec\/3327\/1/g) || [];
  assert.ok(hrefs.length >= 3, 'every demo spec card carries the /dev/spec deep link');
  assert.ok(!conversationRoutes.includes('/dev/sessions/3327'),
    'no demo spec card points at the owner-only session route');
  // The unavailable-card rendering stays covered.
  assert.ok(conversationRoutes.includes("{ type: 'spec', available: false }"));
});

test('sendMessage still writes the conversation-scoped spec grant', () => {
  assert.match(conversationsSource, /INSERT INTO chat_session_spec_conversation_shares/);
  assert.match(conversationsSource, /ON CONFLICT DO NOTHING/);
});
