'use strict';

// Messages is one inbox (#2718).
//
// It was the `conversations` domain and nothing else. An app's own
// discussion lived on that app's board and an agent chat lived in the
// Improve panel's list, so neither was findable from the one screen somebody
// opens looking for "what was said to me". One list, one clock, a mark on
// the rows that are not a person — which is what Slack and Teams do with a
// channel, a DM and a bot thread in one sidebar.
//
// Five things are pinned, and each is a way one list becomes three stacked:
//
//   1. ONE CLOCK. Sorted per-kind, an inbox is three lists in a trench coat.
//   2. A ROW WITH NO TIMESTAMP SORTS LAST. "We do not know when" is not
//      "just now", and an agent chat never opened would otherwise lead.
//   3. AGENT CHATS ARE NOT COPIED into this store. A second copy of a list
//      loaded and invalidated elsewhere is a copy that drifts.
//   4. THE DISCUSSIONS READ FAILS QUIETLY. Conversations are this screen's
//      reason to exist; a second request must not be able to blank it.
//   5. MEMBERSHIP, NOT VISIBILITY. A public app you have never joined is
//      something to go and read, not something in your messages.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const STORE = read('frontend/src/features/messages/store.ts');
const ROUTE = read('src/routes/messages-overview.js');

const inbox = loadTsx('frontend/src/features/messages/inbox.ts');

const at = (iso) => iso;

test('one clock orders all three kinds', () => {
  const merged = inbox.buildInbox({
    conversations: [{ id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') }],
    discussions: [{ slug: 'notes', lastAt: at('2026-01-03T00:00:00Z') }],
    agents: [{ id: 'a1', updatedAt: at('2026-01-01T00:00:00Z') }],
    filter: 'all',
  });
  assert.deepEqual(merged.map((e) => e.key), ['app:notes', 'person:1', 'agent:a1']);
});

test('a row with no timestamp sorts last, not first', () => {
  const merged = inbox.buildInbox({
    conversations: [{ id: 1, lastActivityAt: at('2020-01-01T00:00:00Z') }],
    discussions: [],
    agents: [{ id: 'never', updatedAt: null, createdAt: null }],
    filter: 'all',
  });
  assert.deepEqual(merged.map((e) => e.key), ['person:1', 'agent:never']);
});

test('an agent chat falls back to when it was created', () => {
  const merged = inbox.buildInbox({
    conversations: [],
    discussions: [],
    agents: [
      { id: 'new', createdAt: at('2026-02-02T00:00:00Z') },
      { id: 'old', createdAt: at('2026-01-01T00:00:00Z') },
    ],
    filter: 'all',
  });
  assert.deepEqual(merged.map((e) => e.key), ['agent:new', 'agent:old']);
});

test('each filter admits exactly its own kind, and All admits every one', () => {
  assert.deepEqual(inbox.INBOX_FILTERS.map((f) => f[0]), ['all', 'people', 'apps', 'agents']);
  for (const kind of ['person', 'app', 'agent']) {
    assert.equal(inbox.admits('all', kind), true, `all admits ${kind}`);
  }
  assert.equal(inbox.admits('people', 'person'), true);
  assert.equal(inbox.admits('people', 'app'), false);
  assert.equal(inbox.admits('apps', 'app'), true);
  assert.equal(inbox.admits('agents', 'agent'), true);
  assert.equal(inbox.admits('agents', 'person'), false);
});

test('agent chats are read, not copied', () => {
  assert.match(SCREEN, /useGlobalChatState\(\)/,
    'the screen reads the chat’s own store');
  // The word appears once in this store, in a comment about typing indicators
  // hopping between threads, so the check is on the STATE rather than on the
  // text: no field of it holds an agent-chat list.
  assert.doesNotMatch(STORE, /threads:/,
    'and this store holds no second copy of that list');
  assert.doesNotMatch(STORE, /agents:/);
  // …gated on the same two flags the Improve panel's list is, so a shell
  // with the feature off shows no Agents rows and no filter doing nothing.
  assert.match(SCREEN, /parityReady/);
  assert.match(SCREEN, /profiles\.globalChat\.enabled === true/);
});

test('the discussions read fails quietly', () => {
  const fn = STORE.slice(STORE.indexOf('export async function loadAppDiscussions'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(!response\.ok\) return;/, 'a bad status changes nothing');
  assert.match(body, /\} catch \{/, 'and neither does being offline');
  assert.doesNotMatch(body, /publish\(\{ error/, 'it never blanks the conversations');
});

test('what starts something sits under the strip, and says which kind', () => {
  // It was a disc beside the title, then a disc at the far end of the filter
  // row. Both were ONE control for an inbox that holds THREE kinds: it
  // opened the people dialog on the Agents tab as readily as on People.
  //
  // Under the strip, per tab, it can name what it does (#2718 review).
  assert.ok(!SCREEN.includes('messages-new-button'), 'the disc is retired');
  const filters = SCREEN.slice(SCREEN.indexOf('function InboxFilters'));
  assert.doesNotMatch(filters.slice(0, filters.indexOf('\n}\n')), /id="messages-new"/,
    'the filter row narrows and does nothing else');

  const compose = SCREEN.slice(SCREEN.indexOf('function InboxCompose'));
  const body = compose.slice(0, compose.indexOf('\n}\n'));
  assert.match(body, /const people = filter === 'all' \|\| filter === 'people';/);
  assert.match(body, /const agent = agentsOn && \(filter === 'all' \|\| filter === 'agents'\);/);
  // APPS OFFERS NOTHING, which is the honest answer: an app's discussion is
  // the app's and exists already, so there is nothing here to start.
  assert.match(body, /if \(!people && !agent\) return null;/);
  assert.match(body, /id="messages-new"[\s\S]{0,300}messagesCreate/,
    'the people half opens the same dialog it always did');
  assert.match(body, /id="messages-new-agent"[\s\S]{0,300}startNewGlobalChat\(\)/,
    'and the agent half starts a durable chat, the way Improve\'s own New chat does');
  // BOTH ARE `flex: 1`, so All splits the row evenly by construction rather
  // than by a width either of them carries.
  assert.match(read('public/css/app.css'), /\.messages-compose-btn \{[\s\S]{0,200}flex: 1 1 0;/);
});

test('the endpoint is members-only, newest first, one row per app', () => {
  assert.match(ROUTE, /JOIN app_collaborators me[\s\S]{0,80}me\.user_id = \$1 AND me\.status = 'member'/,
    'membership, not visibility');
  assert.match(ROUTE, /NOT a\.self_hosted OR \$2::boolean/,
    'and the platform’s own app keeps its admin gate');
  assert.match(ROUTE, /SELECT DISTINCT ON \(m\.app_id\)/, 'one row per app');
  assert.match(ROUTE, /ORDER BY m\.app_id, m\.created_at DESC, m\.id DESC/,
    'the id tiebreak matters: created_at defaults to NOW() and two messages '
    + 'in one transaction share it');
  assert.match(ROUTE, /WHERE m\.thread_type IS NULL/, 'the general thread, not a card’s');
  assert.match(ROUTE, /ORDER BY latest\.created_at DESC/, 'newest first');
  // No unread count, and its absence is honest: chat_messages has no
  // per-viewer read cursor, so a number here would be invented. Comments
  // stripped first — the file SAYS why there is none, and a prose match for
  // the thing being forbidden fails on the note explaining it.
  const code = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /unread/i);
});

test('the route is registered after the workshop one', () => {
  const server = read('server.js');
  assert.match(server, /const \{ messagesOverviewRoutes \} = require\('\.\/src\/routes\/messages-overview'\);/);
  assert.match(server, /app\.use\(messagesOverviewRoutes\(config\)\);/);
});

test('the filter row ships in the prerendered document', () => {
  for (const id of ['messages-filters', 'messages-filter-all', 'messages-filter-people',
    'messages-filter-apps', 'messages-filter-agents', 'messages-new']) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} is in the shipped shell`);
  }
  assert.ok(!HTML.includes('id="messages-filter-empty"'),
    'the narrowed-to-nothing note is not, because nothing has narrowed');
});

test('one row shape per kind, and only two of them wear a pill', () => {
  assert.match(SCREEN, /function AppDiscussionRow/);
  assert.match(SCREEN, /function AgentChatRow/);
  assert.match(SCREEN, /<KindPill kind="app" \/>/);
  assert.match(SCREEN, /<KindPill kind="agent" \/>/);
  const conversationRow = SCREEN.slice(SCREEN.indexOf('function ConversationRow'), SCREEN.indexOf('function KindPill'));
  assert.doesNotMatch(conversationRow, /KindPill/,
    'a person gets none: they are the majority, and a pill on every row says nothing');
});

// ── The agent half has to ask for itself (#2718 review) ────────────────

test('the inbox initialises the global-chat bootstrap it reads', () => {
  // `useGlobalChatState()` reads a store nothing on this screen was filling:
  // the only caller of initializeGlobalChat outside Settings was the Improve
  // panel's own New chat button. So an inbox opened without ever having
  // opened Improve saw `bootstrap: null` — which reads as "the feature is
  // off" — and drew no agent rows and no way to start one under the Agents
  // tab, which is what "there is no new agent button under agents" was.
  // `removeGlobalChatThread` joined them when the Improve panel retired: its
  // list of these chats was the only surface that offered the delete, so the
  // delete came to this one rather than going away (#2718 review).
  assert.match(SCREEN, /import \{ initializeGlobalChat, removeGlobalChatThread, startNewGlobalChat, useGlobalChatState \}/);
  const screen = SCREEN.slice(SCREEN.indexOf('export function MessagesScreen'));
  assert.match(screen, /void initializeGlobalChat\(\);/);
  // The same shape the button uses: a boot-time 401 is expected before
  // app.js has established the session, so `sv:authed` asks again. The call
  // is idempotent, so two surfaces asking costs one request.
  assert.match(screen, /window\.addEventListener\('sv:authed', retry\);/);
  assert.match(screen, /return \(\) => window\.removeEventListener\('sv:authed', retry\);/);
});
