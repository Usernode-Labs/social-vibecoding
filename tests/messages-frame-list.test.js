// The Messages list in the one frame (frontend/src/features/messages/frame-
// list.tsx), version 2 of the screen tour's s15 and s20: the first tour's
// layout (the page's head, People and Agents as tabs, the conversations as
// the kit's one row) holding what the standard list holds: the product's
// search, a group's member count, "N new", an agent chat's project and
// state, this week's agent chats with the older ones behind "N older
// chats", and the archived ones behind "Show archived". It is the product's
// own list (./index.tsx ConversationList) with another face: the pane
// builds each row, folds Agents by the standard rule and hands them in.
//
// Run with: node --test tests/messages-frame-list.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const LIST = 'frontend/src/features/messages/frame-list.tsx';
const PANE = 'frontend/src/features/messages/index.tsx';

const row = (key, title, over) => ({
  key, lead: null, title, line: 'ignore', time: '4d ago', timeTitle: '7 Nov 2026, 10:02', fresh: null, status: null, active: false,
  href: `#messages/${key}`, onClick() {}, ...over,
});
const state = { loading: false, error: null, onRetry() {}, offline: false, empty: false, onStart() {}, searched: null };
const base = {
  people: [
    row('4', 'evan', { active: true }),
    row('9', 'Evan / Lukas / Salah / Drea', { line: '@evan: going to make some changes', fresh: '2 new', members: { count: 4, words: '4 members' } }),
    row('12', 'Bruno', { line: 'test (edit)', time: '14 Aug' }),
  ],
  agents: [
    row('session:t1', 'Simplify the admin console', { line: 'Homeroom · Handed off · 29 Oct', time: null, status: { text: 'Handed off', kind: '' } }),
  ],
  older: 2,
  olderRows: [],
  olderOpen: false,
  onOlder() {},
  archive: null,
  unread: 2,
  tab: 'people', onTab() {}, query: '', onQuery() {}, onNew() {}, state,
};
const OLDER = [
  row('session:s2', 'New Needs you', { line: 'Homeroom · 29 Oct', time: null, status: { text: 'Ready', kind: 'ok' } }),
  row('mayor:7', '#4098 · Add support for diagrams', { line: 'Homeroom · No active change', time: '12 Oct', said: ', finished' }),
];
const render = (over) => renderComponent(LIST, 'MessagesFrameList', { ...base, ...over }, { cache: false });
// A conversation's name is in the span that is cut short; a fold's words are the title itself.
const titles = (html) => [...html.matchAll(/<span class="fr-t">(?:<span class="fr-cut">)?([^<]+)/g)].map((m) => m[1]);

test('the list is the kit\'s pane: the head with one sentence and one action, two tabs, the product\'s search under them', () => {
  const html = render();
  assert.match(html, /^<div class="fr fr-pane" data-messages-frame-list="" data-inbox-tab="people"><div class="fr-scroll"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Messages<\/h1><p class="fr-purpose">People and groups you talk to\.<\/p><\/div><div class="fr-acts"><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>New message<\/button><\/div><\/div>/s);
  assert.match(html, /<button type="button" class="fr-tab fr-on" aria-pressed="true">People<span class="fr-n">2<\/span><\/button><button type="button" class="fr-tab" aria-pressed="false">Agents<\/button><\/nav><div class="fr-search">/,
    'People says how many messages from people are unread, as the standard heading does; Agents says nothing');
  assert.match(html, /<input type="search" class="fr-v" placeholder="Search" aria-label="Search messages" value=""\/>/, 'the standard search\'s own words');
  assert.equal((html.match(/type="search"/g) || []).length, 1, 'one field, under the tabs at every width');
  const src = read(LIST);
  for (const id of ['messages:inbox.new.button', 'messages:inbox.section.people', 'messages:inbox.section.agents', 'messages:inbox.searchPlaceholder', 'messages:inbox.searchLabel']) {
    assert.ok(src.includes(`'${id}'`), `${id} is the standard list's own id`);
  }
});

test('a conversation with something new ends in the blue pill, the others in a grey time; a group says how many are in it', () => {
  const html = render();
  assert.deepEqual(titles(html), ['evan', 'Evan / Lukas / Salah / Drea', 'Bruno'], 'People holds the conversations, in the order the pane hands them');
  assert.match(html, /<span class="fr-t"><span class="fr-cut">Evan \/ Lukas \/ Salah \/ Drea<\/span><span class="fr-pill fr-mini" role="img" aria-label="4 members" title="4 members"><svg[^>]*>.*?<\/svg>4<\/span><\/span><span class="fr-s">@evan: going to make some changes<\/span><\/span><span class="fr-pill fr-act" data-kind="act">2 new<\/span>/s,
    'the count is the figure after a people glyph, and the words to a screen reader');
  assert.match(html, /<span class="fr-t"><span class="fr-cut">Bruno<\/span><\/span><span class="fr-s">test \(edit\)<\/span><\/span><span class="fr-meta" title="7 Nov 2026, 10:02">14 Aug<\/span>/, 'the time carries the whole instant');
  assert.equal((html.match(/data-kind="act"/g) || []).length, 1, 'blue only where something waits');
  assert.equal((html.match(/fr-mini/g) || []).length, 1, 'a direct message has no count');
  assert.match(render({ people: [row('5', 'helper', { tag: 'AI' })] }), /<span class="fr-t"><span class="fr-cut">helper<\/span><span class="fr-pill fr-mini" data-kind="none">AI<\/span><\/span>/, 'a bot\'s direct message keeps its badge');
  // A long group name is what gives way: the count after it keeps its place in the row (visual pass, v2 finding 5).
  const css = read('public/css/app.css');
  assert.ok(css.includes('html[data-skin] [data-messages-frame-list] .fr-row .fr-t:has(> .fr-cut) { display: flex; align-items: center; min-width: 0; }'));
  assert.ok(css.includes('html[data-skin] [data-messages-frame-list] .fr-row .fr-t > .fr-cut { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'));
});

test('the open conversation\'s row is lit, and every row is a link to its own address', () => {
  const html = render();
  assert.match(html, /<a class="fr-row fr-on" href="#messages\/4" aria-current="page" data-inbox-row="[^"]+">/);
  assert.equal((html.match(/<a class="fr-row/g) || []).length, 3);
  assert.equal((html.match(/class="fr-row fr-on"/g) || []).length, 1);
});

test('Agents is the second tab: its sentence, this week\'s chats, then "N older chats" as the card\'s centred link', () => {
  const html = render({ tab: 'agents' });
  assert.match(html, /<p class="fr-purpose">Chats with coding agents\.<\/p>/);
  assert.doesNotMatch(html, /Homeroom bot tab|Older chats with coding agents/, 'the first tour\'s sentence sending new work to the bot is gone');
  assert.match(html, /placeholder="Search"/, 'the same search');
  assert.match(html, /<button type="button" class="fr-tab fr-on" aria-pressed="true">Agents<\/button>/);
  assert.doesNotMatch(html, /fr-cap/, 'no counted label over the group');
  assert.deepEqual(titles(html), ['Simplify the admin console', '2 older chats']);
  assert.match(html, /<span class="fr-s">Homeroom · Handed off · 29 Oct<\/span><\/span><span class="fr-pill" data-kind="none">Handed off<\/span>/, 'a change in flight: the project, what is known and when on the line, its state the pill');
  assert.match(html, /<button type="button" class="fr-row fr-sm fr-showall" aria-expanded="false" data-inbox-more="agents"><span class="fr-tx"><span class="fr-t">2 older chats<\/span><\/span><\/button><\/div><\/section>/,
    'the link ends the card and says it is shut');
  assert.equal(message('messages:inbox.older.show_one').replace('{{count}}', '1'), '1 older chat');
});

test('pressed, the link stays where it was and the older chats open under it', () => {
  const html = render({ tab: 'agents', olderOpen: true, olderRows: OLDER });
  assert.deepEqual(titles(html), ['Simplify the admin console', 'Hide older chats', 'New Needs you', '#4098 · Add support for diagrams']);
  assert.match(html, /aria-expanded="true" data-inbox-more="agents"/);
  assert.match(html, /<span class="fr-s">Homeroom · 29 Oct<\/span><\/span><span class="fr-pill fr-ok" data-kind="ok">Ready<\/span>/);
  assert.match(html, /<span class="fr-t"><span class="fr-cut">#4098 · Add support for diagrams<\/span><span class="sr-only">, finished<\/span><\/span><span class="fr-s">Homeroom · No active change<\/span><\/span><span class="fr-meta" title="7 Nov 2026, 10:02">12 Oct<\/span>/,
    'an agent chat with no change says so, ends in its date, and says what it is doing to a screen reader');
});

test('Show archived ends the card where the standard list offers it, and opens the archived chats under their own label', () => {
  const shut = render({ tab: 'agents', older: 0, archive: { open: false, onToggle() {}, rows: null, error: '', onRetry() {} } });
  assert.match(shut, /<button type="button" class="fr-row fr-sm fr-showall" aria-expanded="false" data-inbox-archived=""><span class="fr-tx"><span class="fr-t">Show archived<\/span><\/span><\/button><\/div><\/section>/);
  assert.doesNotMatch(shut, /data-inbox-section="archived"/);
  assert.doesNotMatch(render({ tab: 'agents' }), /Show archived/, 'not offered: not drawn');
  assert.doesNotMatch(render({ archive: { open: true, onToggle() {}, rows: [], error: '', onRetry() {} } }), /archived/i, 'People has none of it');
  const open = (over) => render({ tab: 'agents', older: 0, archive: { open: true, onToggle() {}, rows: null, error: '', onRetry() {}, ...over } });
  assert.match(open(), /Hide archived<\/span><\/span><\/button><\/div><\/section><section class="fr-sec" data-inbox-section="archived"><div class="fr-sechead"><h2 class="fr-cap">Archived<\/h2><\/div><p class="fr-txt" role="status">Loading conversations<\/p>/);
  assert.match(open({ rows: [] }), /<div class="fr-card fr-pad">No archived agent chats\.<\/div>/);
  assert.match(open({ error: 'Could not load.' }), /<div class="fr-txt" role="status">Could not load\. <button type="button" class="fr-link">Try again<\/button><\/div>/);
  assert.deepEqual(titles(open({ rows: [OLDER[1]] })), ['Simplify the admin console', 'Hide archived', '#4098 · Add support for diagrams']);
  assert.match(render({ tab: 'agents', agents: [], older: 0, archive: { open: false, onToggle() {}, rows: null, error: '', onRetry() {} } }), /Show archived/,
    'with no open chat left the link is still the way to the archived ones');
});

test('what the list says when it has nothing to list is the standard list\'s sentence', () => {
  const none = { people: [], agents: [], older: 0 };
  assert.match(render({ ...none, state: { ...state, empty: true } }), /<div class="fr-card fr-pad fr-text"><div class="fr-sub15">No messages yet<\/div><p class="fr-txt">Start a direct conversation or bring a group together\.<\/p><div class="fr-btnrow"><button type="button" class="fr-btn fr-quiet fr-sm">New conversation<\/button><\/div><\/div>/,
    'an empty inbox: the product\'s words and its one action');
  assert.match(render({ ...none, state: { ...state, searched: 'zz' } }), /<div class="fr-card fr-pad"><span data-inbox-search-empty="">No messages match “zz”\.<\/span><\/div>/, 'a search that matched nothing names what was typed');
  assert.match(render({ people: [], state }), /<div class="fr-card fr-pad">Nothing here yet\.<\/div>/, 'a tab with nothing while the other has rows');
  const loading = render({ ...none, state: { ...state, loading: true } });
  assert.match(loading, /<p class="fr-txt" role="status" data-inbox-loading="">Loading conversations<\/p>/);
  assert.doesNotMatch(loading, /Nothing here yet|No messages yet/, 'nothing says "nothing" before the list has been read');
  const failed = render({ ...none, state: { ...state, error: 'Could not load conversations.' } });
  assert.match(failed, /<div class="fr-txt" role="status" data-inbox-failed="">Could not load conversations\. <button type="button" class="fr-link">Try again<\/button><\/div>/);
  assert.doesNotMatch(failed, /Nothing here yet/);
  // Try again pressed: the read is under way with no conversation in hand, and no tab says it is empty (visual pass, v2 finding 4).
  const retrying = render({ people: [], state: { ...state, reading: true } });
  assert.doesNotMatch(retrying, /Nothing here yet|No messages yet/);
  assert.match(read(PANE), /reading: !!snap\.loadingList && !snap\.conversations\.length,/);
  assert.match(render({ state: { ...state, offline: true } }), /<div class="fr-note fr-wait"><svg[^>]*>.*?<\/svg><div>Offline\. Queued messages retry when you reconnect\.<\/div><\/div>/s);
});

test('what the first tour invented is gone from the catalog, and the words are the standard list\'s', () => {
  const catalog = JSON.parse(read('frontend/locales/en/messages.json'));
  const frame = Object.keys(catalog).filter((id) => id.startsWith('frame.inbox.') || id.startsWith('frame.new.'));
  assert.deepEqual(frame.sort(), ['frame.inbox.agentsPurpose', 'frame.inbox.none', 'frame.inbox.purpose'],
    'only the two sentences under the title and an empty tab\'s line are the frame\'s own');
  assert.doesNotMatch(read(LIST), /frame\.inbox\.(new|tabPeople|tabAgents|search|agentsSearch|agentsCount)/);
});

test('the list pane hands its own conversations to the kit list under a look, and only then', () => {
  const src = read(PANE);
  assert.match(src, /const frame = isFrameSkin\(useSkin\(\)\);/);
  const block = src.slice(src.indexOf('  if (frame) {\n    const me = Number'), src.indexOf("aria-label={t('messages:inbox.listName')}"));
  assert.ok(block.length > 2000, 'the frame branch is one block ahead of the standard list');
  assert.match(block, /color=\{swatchFor\(face\?\.username \|\| name \|\| '\?'\)\}/, 'a person with no picture wears the colour they wear everywhere');
  assert.match(block, /const face = c\.kind === 'group' && !invited\s+\? c\.members\.find\(\(member\) => member\.status === 'member' && Number\(member\.id\) !== me\) \|\| null\s+: peer;/,
    'a group wears the face of someone in it who is not you');
  assert.match(block, /members: Number\.isFinite\(count\) && count > 0 \? \{ count, words: t\('messages:inbox\.memberCount', \{ count \}\) \} : null,/, 'the member count in GroupMemberCount\'s words; a zero says nothing');
  assert.match(block, /const fold = shownInSection\('agents', agentEntries, \{ expanded: agentsExpanded, searching, openKey, keep: asksForYou \}\);/,
    'Agents folds by the standard list\'s own rule and state');
  assert.match(block, /onOlder=\{\(\) => setAgentsExpanded\(!agentsExpanded\)\}/);
  assert.match(block, /const archive = mounted && !!agentChatsShown && !searching && \(!fold\.older \|\| agentsExpanded\);/, 'Show archived where the standard list offers it');
  assert.match(block, /onToggle: \(\) => setArchivedOpen\(!archivedOpen\),/);
  assert.match(block, /unread=\{unreadFromPeople\}/, 'the People tab counts what the standard heading counts');
  assert.match(block, /line: m\.busy \? t\('messages:agent\.row\.working'\) : dotText\(\[m\.focusApp\?\.name, status\]\),/, 'an agent chat\'s line is MayorSessionRow\'s');
  assert.match(block, /const state = sessionRowState\(sn\);/, 'a change in flight says the state SessionRow\'s pill says');
  assert.match(block, /empty: !snap\.loadingList && !snap\.error && !!snap\.listLoaded && !inbox\.length,/);
  assert.match(block, /onStart: \(\) => openDialog\('messagesCreate'\),/);
  assert.match(block, /<NewMessageSheet\s+choices=\{NEW_CHOICES\}\s+onPick=\{\(choice\) => \{ setFrameNew\(false\); window\.setTimeout\(\(\) => startNew\(choice\), 0\); \}\}/,
    'New message hands over to the product\'s own starts (tests/messages-frame-new.test.js)');
  assert.doesNotMatch(block, /known|createDirect|createGroup/, 'nothing is picked or created by the list any more');
  assert.match(src, /data-frame-list=""/);
  const states = read('frontend/src/features/improve/session-row.tsx');
  assert.match(states, /export function sessionRowState\(session: SessionRowView\): \{ label: string; kind: 'act' \| 'wait' \| 'ok' \| 'bad' \| '' \} \{\s+const \{ label \} = stateOf\(session\);/, 'the word is stateOf\'s, never a second wording');
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\] \.messages-list-pane\[data-frame-list\] \{ flex: 0 0 520px; width: 520px; \}/, 'the list is the split\'s 520px pane');
  assert.match(css, /html\[data-skin\] \.messages-layout\.messages-list-page > \.messages-list-pane\[data-frame-list\] \{ max-width: none; margin: 0; \}/, 'with nothing open the list stays where it is');
  assert.match(css, /html\[data-skin\] \.messages-layout\.messages-list-page:has\(> \[data-frame-list\]\) > \.messages-thread-pane \{ display: flex; \}/, 'and the pane beside it says nothing is open');
  assert.match(css, /html\[data-skin\] \.messages-layout:has\(> \[data-frame-list\]\) > \.messages-thread-pane \{[^}]*border-inline-start: 1px solid var\(--fr-line\);/, 'one line between the two panes');
  assert.match(css, /html\[data-skin\] \.messages-layout:has\(> \[data-frame-list\]\) > \.messages-thread-pane \{[^}]*border-top: 0;/, 'and no second: the pane is a dc-lift sheet whose top hairline drew a line under the header');
  // The kit's pane clips its scroll (`.fr-pane .fr-scroll { overflow:
  // hidden }`, in the compiled kit, which comes after the shell's rules at
  // the same weight), so on a phone the list could not scroll at all: the
  // shell's rule names the pane twice and wins, and the list pane scrolls.
  assert.match(css, /html\[data-skin\] \.fr\.fr-pane,\s*html\[data-skin\] \.fr\.fr-pane > \.fr-scroll \{ overflow: visible; \}/);
  assert.match(css, /html\[data-skin\] \.messages-layout:has\(> \[data-frame-list\]\) \{ background: none; backdrop-filter: none; -webkit-backdrop-filter: none; box-shadow: none; border-radius: 0; border-top: 0; \}/, 'nor the strip the layout is: the tour\'s Messages sits flat under the header');
});
