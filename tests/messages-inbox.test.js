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
//
// #2783 sections the list the way Discord does: the CHATS (people and
// agents) on the one clock, then the CHANNELS — #general, then one per app
// the viewer is a member of, including one nobody has spoken in yet.

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

test('one clock orders the chats, and the channels follow as their own section', () => {
  const merged = inbox.buildInbox({
    conversations: [
      { id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') },
      { id: 9, kind: 'channel', lastActivityAt: at('2026-01-09T00:00:00Z') },
    ],
    discussions: [
      { slug: 'quiet', lastAt: null },
      { slug: 'notes', lastAt: at('2026-01-03T00:00:00Z') },
    ],
    agents: [{ id: 'a1', updatedAt: at('2026-01-01T00:00:00Z') }],
    filter: 'all',
  });
  // A channel with newer activity does not jump over a DM: it is a room you
  // visit, not a conversation waiting on you. #general leads the channels,
  // then the apps newest first, and one nobody has spoken in sits last.
  assert.deepEqual(merged.map((e) => e.key), ['person:1', 'agent:a1', 'channel:9', 'app:notes', 'app:quiet']);
  assert.deepEqual(merged.map((e) => e.section), ['chats', 'chats', 'channels', 'channels', 'channels']);
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
  assert.deepEqual(inbox.INBOX_FILTERS.map((f) => f[0]), ['all', 'people', 'channels', 'agents']);
  assert.deepEqual(inbox.INBOX_FILTERS.map((f) => f[1]), ['All', 'People', 'Channels', 'Agents'],
    '"Apps" is "Channels" now (#2783)');
  for (const kind of ['person', 'channel', 'app', 'agent']) {
    assert.equal(inbox.admits('all', kind), true, `all admits ${kind}`);
  }
  assert.equal(inbox.admits('people', 'person'), true);
  assert.equal(inbox.admits('people', 'app'), false);
  assert.equal(inbox.admits('people', 'channel'), false, '#general is not a person');
  assert.equal(inbox.admits('channels', 'app'), true);
  assert.equal(inbox.admits('channels', 'channel'), true);
  assert.equal(inbox.admits('channels', 'person'), false);
  assert.equal(inbox.admits('agents', 'agent'), true);
  assert.equal(inbox.admits('agents', 'person'), false);
  const channelsOnly = inbox.buildInbox({
    conversations: [{ id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') }, { id: 9, kind: 'channel', lastActivityAt: null }],
    discussions: [{ slug: 'notes', lastAt: null }], agents: [], filter: 'channels',
  });
  assert.deepEqual(channelsOnly.map((e) => e.key), ['channel:9', 'app:notes']);
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

test('the "+" is back at the strip\'s trailing end, and opens a choice rather than guessing (#2778)', () => {
  // It was a disc at the far end of the filter row, taken off in #2718's
  // review because ONE control could only mean one of the things the inbox
  // holds. It comes back as a popover of three choices: DM, group, agent.
  const filters = SCREEN.slice(SCREEN.indexOf('function InboxFilters'));
  const body = filters.slice(0, filters.indexOf('\n}\n'));
  assert.ok(body.indexOf('messages-filter-track') < body.indexOf('<NewMessageButton />'),
    'the plus sits after the track, to the right of the filters');
  assert.ok(!SCREEN.includes('function InboxCompose'), 'the row of compose buttons under the strip is gone');
  assert.ok(!SCREEN.includes('id="messages-new-agent"'));

  const button = SCREEN.slice(SCREEN.indexOf('function NewMessageButton'));
  const fn = button.slice(0, button.indexOf('\n}\n'));
  assert.match(fn, /id="messages-new"/);
  assert.match(fn, /aria-haspopup="menu"/);
  // THE VOTE POPUP'S MECHANICS, shared rather than copied: placement from
  // the button's rect, dismissal on outside click / Escape / scroll / resize.
  assert.match(fn, /useAnchoredDismiss\(open, \[btnRef, popRef\], shut\);/);
  assert.match(fn, /placeUnderAnchor\(rect, \{ width: 240, height: 164 \}/);
  assert.match(fn, /createPortal\(/, 'portalled, so the list\'s scroller cannot clip it');
  assert.match(fn, /role="menu"/);
  assert.match(fn, /pu\.actionSheet\(\{/, 'a phone gets the kit\'s action sheet');
  const card = read('frontend/src/features/dev-board/card/dev-card.tsx');
  assert.match(card, /useAnchoredDismiss\(open, \[btnRef, popRef\], shut\);/, 'the vote picker reads the same helper');
  assert.match(card, /placeUnderAnchor\(rect, \{ width: w, height: h \}/);

  assert.match(SCREEN, /\{ key: 'direct', label: 'Direct message'/);
  assert.match(SCREEN, /\{ key: 'group', label: 'Group chat'/);
  assert.match(SCREEN, /\{ key: 'agent', label: 'Agent chat'/);
  const start = SCREEN.slice(SCREEN.indexOf('function startNew'));
  const starter = start.slice(0, start.indexOf('\n}\n'));
  assert.match(starter, /if \(choice === 'agent'\) openDialog\('messagesAgent'\);/,
    'Agent asks which app first');
  assert.match(starter, /else openDialog\('messagesCreate', choice\);/,
    'DM and group open the create flow on the matching tab');
  const create = read('frontend/src/features/messages/create-dialog.tsx');
  assert.match(create, /setMode\(tab === 'group' \? 'group' : 'direct'\)/);
});

test('Agent chat picks one of the viewer\'s apps and opens a new dev session there', () => {
  const dialog = read('frontend/src/features/messages/agent-dialog.tsx');
  assert.match(dialog, /id="messages-agent-dialog"/);
  assert.match(dialog, /useDialog\('messagesAgent'/);
  assert.match(dialog, /snap\.discussions/, 'the apps are the channels already loaded — no second list to disagree');
  assert.match(dialog, /Improve\.startSessionFor\(slug\)/);
  const improve = read('frontend/src/features/improve/improve-controller.js');
  const fn = improve.slice(improve.indexOf('async startSessionFor(slug)'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.match(body, /Improve\._nextSessionOrigin = '#messages';/, 'back goes up to Messages');
  assert.match(body, /navigateToApp\(slug, 'dev', ref, 'sessions'\)/, 'straight to /dev/sessions/new');
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
  // #2783: EVERY app the viewer is in is a channel, including one nobody has
  // spoken in — so the latest message is joined optionally, and those sort
  // after the ones with activity.
  assert.match(ROUTE, /LEFT JOIN latest ON latest\.app_id = mine\.id/);
  assert.match(ROUTE, /ORDER BY latest\.created_at DESC NULLS LAST/, 'newest first, silent last');
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

test('the filter row ships in the prerendered document, with the plus at its end', () => {
  for (const id of ['messages-filters', 'messages-filter-all', 'messages-filter-people',
    'messages-filter-channels', 'messages-filter-agents', 'messages-new']) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} is in the shipped shell`);
  }
  for (const id of ['messages-filter-apps', 'messages-compose', 'messages-new-agent']) {
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} is retired`);
  }
  assert.match(HTML, /id="messages-filter-agents"[^<]*>Agents<\/button><\/div><button[^>]*id="messages-new"/,
    'the plus is inside the strip, right after the track');
  assert.ok(!HTML.includes('id="messages-new-menu"'), 'the popover renders only when pressed');
  assert.ok(!HTML.includes('id="messages-filter-empty"'),
    'the narrowed-to-nothing note is not, because nothing has narrowed');
});

test('one row shape per kind; the channels are headed rather than pilled', () => {
  assert.match(SCREEN, /function GeneralChannelRow/);
  assert.match(SCREEN, /function AppChannelRow/);
  assert.match(SCREEN, /function AgentChatRow/);
  assert.doesNotMatch(SCREEN, /<KindPill kind="app" \/>/, 'a section heading says it once');
  assert.match(SCREEN, /<KindPill kind="agent" \/>/, 'an agent among the people still says so');
  assert.match(SCREEN, /chats: 'Chats',\s*channels: 'Channels',/);
  assert.match(SCREEN, /snap\.filter === 'all' && \(i === 0 \|\| shown\[i - 1\]\.section !== entry\.section\)/,
    'a heading over each section, under All only');
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
  const imports = SCREEN.slice(0, SCREEN.indexOf("} from '../global-chat/store';"));
  for (const name of ['initializeGlobalChat', 'removeGlobalChatThread', 'useGlobalChatState']) {
    assert.match(imports.slice(imports.lastIndexOf('import {')), new RegExp(`\\b${name},`));
  }
  const screen = SCREEN.slice(SCREEN.indexOf('export function MessagesScreen'));
  assert.match(screen, /void initializeGlobalChat\(\);/);
  // The same shape the button uses: a boot-time 401 is expected before
  // app.js has established the session, so `sv:authed` asks again. The call
  // is idempotent, so two surfaces asking costs one request.
  assert.match(screen, /window\.addEventListener\('sv:authed', retry\);/);
  assert.match(screen, /return \(\) => window\.removeEventListener\('sv:authed', retry\);/);
});

// ── A change is an agent conversation (#2770, #2772) ────────────────────

test('a change sorts on the same clock and files under Agents', () => {
  const merged = inbox.buildInbox({
    conversations: [{ id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') }],
    discussions: [],
    agents: [{ id: 'a1', updatedAt: at('2026-01-01T00:00:00Z') }],
    sessions: [{ key: 's7', lastActivityAt: at('2026-01-03T00:00:00Z') }],
    filter: 'all',
  });
  assert.deepEqual(merged.map((e) => e.key), ['session:s7', 'person:1', 'agent:a1']);
  assert.equal(inbox.admits('agents', 'session'), true, 'Agents admits a change');
  assert.equal(inbox.admits('people', 'session'), false);
  assert.equal(inbox.admits('channels', 'session'), false);
  const agentsOnly = inbox.buildInbox({
    conversations: [{ id: 1, lastActivityAt: at('2026-01-02T00:00:00Z') }],
    discussions: [], agents: [], sessions: [{ key: 's7', lastActivityAt: null }],
    filter: 'agents',
  });
  assert.deepEqual(agentsOnly.map((e) => e.key), ['session:s7']);
});

test('changes are read from the Improve store, drawn by SessionRow, and not gated on the chat flags', () => {
  assert.match(SCREEN, /useStoreState\(improveStore\)/, 'one list, the Improve store’s');
  assert.match(SCREEN, /<SessionRow\b/, 'drawn by the same row the bell’s Messages tab uses for agents');
  const list = SCREEN.slice(SCREEN.indexOf('function ConversationList'));
  const body = list.slice(0, list.indexOf('\n}\n'));
  assert.match(body, /const sessions: SessionRowView\[\] = mounted\s*\?/,
    'after mount only, so the first client render matches the prerender');
  assert.doesNotMatch(body.slice(body.indexOf('const sessions'), body.indexOf('const inbox')), /agentsOn/,
    'a change is not the experimental global chat');
  // #2813: the row's address is the inbox's own, so on a desktop the session
  // opens beside the list. On a phone the router swaps it for the session
  // itself and records Messages as where it hangs off.
  assert.match(SCREEN, /href: agentThreadAddress\(\{ kind: 'session', slug: session\.appSlug, id: session\.id \}\)/,
    'a row opens the conversation itself');
  assert.match(STORE, /`#app\/\$\{encodeURIComponent\(agent\.slug\)\}\/dev\/sessions\/\$\{agent\.id\}`/);
  assert.match(read('public/js/app.js'), /Improve\.enterSessionFrom\?\.\('#messages'\)/,
    'and records Messages as where it hangs off');
  assert.doesNotMatch(STORE, /sessions:/, 'and this store holds no second copy of that list');
});

// ── Channels as things a message can name (#2783) ─────────────────────

const channels = loadTsx('frontend/src/features/messages/channels.ts');
const overview = require('../src/routes/messages-overview');

test('#general and the viewer\'s apps are the channel directory, #general first', () => {
  const list = channels.channelDirectory(
    [{ id: 3, kind: 'direct', title: 'ada' }, { id: 7, kind: 'channel', title: 'general', channelKey: 'general' }],
    [{ slug: 'recipe-ab12', name: 'Recipe Box', channel: 'recipe-box' }, { slug: 'Odd_Slug', name: '42' }],
  );
  assert.deepEqual(list.map((c) => [c.handle, c.target]), [
    ['general', '#messages/7'],
    ['recipe-box', '#messages/app/recipe-ab12'],
  ], 'a handle must start with a letter, so an app whose only name is a number has none to be named by');
  assert.equal(channels.channelHref('general'), '#messages/channel/general');
});

test('#name is a channel only when the viewer has one; #123 stays an issue and PR#123 a PR', () => {
  const known = new Set(['general', 'recipe-box']);
  const segs = channels.tokenizeRefs('see #general and #recipe-box, not #todo — #123 and PR#9 @ada', known);
  assert.deepEqual(segs.filter((s) => s.type !== 'text'), [
    { type: 'channel', handle: 'general' },
    { type: 'channel', handle: 'recipe-box' },
    { type: 'ref', isPr: false, num: '123' },
    { type: 'ref', isPr: true, num: '9' },
    { type: 'mention', name: 'ada' },
  ]);
  assert.equal(segs.map((s) => s.value || '').join('').includes('#todo'), true, 'an unknown #word is left as text');
  assert.deepEqual(channels.tokenizeRefs('x#general', known), [{ type: 'text', value: 'x#general' }],
    'not inside a word');
});

test('the app chat chips the same channels, as a link and not as a drawer ref', () => {
  const gc = read('public/js/group-chat.js');
  assert.match(gc, /window\.UsernodeReact\?\.messages\?\.channels\?\.\(\)/, 'it reads the Messages store\'s directory');
  assert.match(gc, /link\.className = 'gc-channel-ref';/);
  assert.match(gc, /`#messages\/channel\/\$\{seg\.handle\}`/);
  assert.doesNotMatch(gc, /gc-ref gc-ref-channel/, 'never `.gc-ref`, which the chat sends to the activity drawer');
  const app = read('public/js/app.js');
  assert.match(app, /parts\[1\] === 'channel'[\s\S]{0,160}openChannel\?\.\(parts\[2\] \|\| ''\)/);
  assert.match(STORE, /export function openChannel\(raw: string\): void/);
  assert.match(STORE, /window\.location\.replace\(found\.target\)/, 'the link\'s own history entry is replaced');
});

test('an app\'s channel handle is its name folded, unique within the viewer\'s list', () => {
  assert.equal(overview.channelHandle('Recipe Box!'), 'recipe-box');
  assert.equal(overview.channelHandle('42'), null);
  const list = overview.channelHandles([
    overview.toDiscussion({ slug: 'recipe-ab12', name: 'Recipe Box' }),
    overview.toDiscussion({ slug: 'recipe-cd34', name: 'recipe box' }),
    overview.toDiscussion({ slug: 'general-99', name: 'General' }),
  ]);
  assert.deepEqual(list.map((d) => d.channel), ['recipe-box', 'recipe-cd34', 'general-99'],
    'a second "Recipe Box" and an app named General fall back to their slugs');
});

test('an app channel opened in Messages mounts its chat after React commits, so its composer is wired', () => {
  // renderGroupChatTab mounts the chat as a portal and then looks up
  // `#gc-input` to wire send, drafts and the @ / # menus. Called inside the
  // effect, the portal could not flush and nothing typed there ever sent.
  const thread = SCREEN.slice(SCREEN.indexOf('function AppDiscussionThread'));
  const body = thread.slice(0, thread.indexOf('\n}\n'));
  assert.match(body, /const timer = window\.setTimeout\(\(\) => \{\s*if \(live\) view\?\.renderGroupChatTab\?\.\(\{ host: el, slug, name, readOnly \}\);\s*\}, 0\);/);
  assert.match(body, /live = false;\s*window\.clearTimeout\(timer\);/);
});

// ── Bug h: the discussion pane's header tile is the app's own ────────────
//
// The pane header built its tile from `{ name }` alone, so `iconViewFor`
// could only ever fall through to the name's first letter: a "W" over the
// Whiteboard channel whose inbox row, one column to the left, wears the
// palette emoji. The header now draws the ROW's icon fields, and the app
// record the pane fetches when there is no row.

test('bug h: the discussion header draws the tile the inbox row draws', () => {
  const thread = SCREEN.slice(SCREEN.indexOf('function AppDiscussionThread'));
  const body = thread.slice(0, thread.indexOf('\n}\n'));
  // The row, once, feeding both the #handle and the artwork.
  assert.match(body, /const row = snap\.discussions\.find\(\(item\) => item\.slug === slug\) \|\| null;/);
  assert.match(body, /const handle = row\?\.channel \|\| null;/);
  // The row's own two fields first — the same pair AppChannelRow hands the
  // tile — and the fetched app record when there is no row.
  assert.match(body, /icon_url: row \? row\.iconUrl : \(ready \? context\.iconUrl : null\),/);
  assert.match(body, /icon_emoji: row \? row\.iconEmoji : \(ready \? context\.iconEmoji : null\),/);
  const header = body.slice(body.indexOf('<header className="messages-thread-header">'));
  assert.match(header, /data-icon=\{appIconKind\(iconRecord as never\)\}/);
  assert.match(header, /<AppIconContent app=\{iconRecord as never\} \/>/);
  assert.doesNotMatch(header, /\{ name \} as never/, 'never the name alone again');
  // ...which is what the row itself does, so the two tiles are one recipe.
  const rowFn = SCREEN.slice(SCREEN.indexOf('function AppChannelRow'));
  assert.match(rowFn.slice(0, rowFn.indexOf('\n}\n')),
    /icon_url: discussion\.iconUrl,\s*icon_emoji: discussion\.iconEmoji,/);
});

test('bug h: the discussion context carries the app artwork, for a header with no inbox row', async () => {
  // EXECUTED against the store, with `fetch` stubbed: a discussion opened by
  // address for an app the viewer has no channel row for (a non-member
  // following a link), whose record has an emoji, and one with an uploaded
  // icon — which `/api/apps/:slug` sends as the raw row's `icon_image_id`,
  // so the store spells the platform's own `/app-icons/<id>` address, as
  // src/routes/messages-overview.js does for the row.
  const { navStore } = loadTsx('frontend/src/features/nav/nav-store.js');
  const api = {
    MessagesApiError: class MessagesApiError extends Error {},
    strictId: (value) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null),
    listConversations: async () => [],
  };
  const store = loadTsx('frontend/src/features/messages/store.ts', {
    stubs: { './api': api, '../nav/nav-store.js': { navStore } },
  });
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const APPS = {
    'karaoke-77aa': { slug: 'karaoke-77aa', name: 'Karaoke Night', icon_emoji: '🎤', icon_image_id: null, can_collaborate: false },
    'garden-12ab': { slug: 'garden-12ab', name: 'Pixel Garden', icon_emoji: null, icon_image_id: 31, can_collaborate: true },
  };
  const saved = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = { location: { search: '', hash: '' }, App: { user: { id: 7 } } };
  globalThis.fetch = async (url) => {
    const m = /^\/api\/apps\/([^/?]+)$/.exec(url);
    if (m && APPS[m[1]]) return { ok: true, json: async () => ({ app: APPS[m[1]] }) };
    if (String(url).startsWith('/api/messages/app-discussions')) return { ok: true, json: async () => ({ discussions: [] }) };
    return { ok: false, json: async () => null };
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // The snapshot, read the way the pane reads it.
  const context = () => {
    let out = null;
    renderToHtml(createElement(() => { out = store.useMessagesSnapshot().discussionContext; return null; }));
    return out;
  };
  try {
    store.route(null, 'karaoke-77aa');
    await settle(); await settle(); await settle();
    assert.deepEqual({ ...context() }, {
      slug: 'karaoke-77aa', name: 'Karaoke Night', readOnly: true, iconUrl: null, iconEmoji: '🎤',
    });
    store.route(null, 'garden-12ab');
    await settle(); await settle(); await settle();
    assert.deepEqual({ ...context() }, {
      slug: 'garden-12ab', name: 'Pixel Garden', readOnly: false, iconUrl: '/app-icons/31', iconEmoji: null,
    });
  } finally {
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  }
});
