// Homeroom bot's lists under a look (frontend/src/features/ai/frame-
// list.tsx), version 2 (11 Nov 2026; the mockups' s08, s09 and s14): the
// content of the standard page (./lists.tsx) in the first tour's layout.
// The head with the bot's tile, the search disc and New chat (14 Nov 2026:
// labelled, the page's one primary; there is no Main Chat card), the projects
// as tabs, then four labelled groups of one card each (Needs you, Waiting &
// in progress, Live this week, History), every row one line under its
// project's name. Both faces draw the rows ./lines.ts builds.
//
// Run with: node --test tests/ai-frame-list.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const LIST = 'frontend/src/features/ai/frame-list.tsx';

const homeroom = { slug: 'homeroom', name: 'Homeroom', icon_url: null, icon_emoji: null };
const corner = { slug: 'game-corner', name: 'Game Corner', icon_url: null, icon_emoji: '🎮' };
const need = (key, title, app, number, over) => ({
  key, title, app, who: 'me', sub: { id: 'messages:ai.row.where', values: { project: app.name, number } }, pill: { id: 'messages:ai.pill.decide' },
  href: `#app/${app.slug}/dev/issues/${number}`, rootId: null, threadId: number, unread: 0, at: null, ...over,
});
const thread = (id, title, app, stage) => ({
  threadId: id, number: id, kind: 'request', title, app, change: null, href: `#app/${app.slug}/dev/issues/${id}`, group: 'next',
  work: { stage, line: null }, by: 'bot', at: null,
});
const base = {
  heroLine: { id: 'messages:ai.hero.both', values: { needs: 3, next: 2 } },
  lit: null, ready: true, owed: 2,
  rows: [need('need:question:1', 'Which part should zoom in?', corner, 402), need('need:decide:2', 'Pick a direction', homeroom, 5998), need('private:3', 'Keep a vote in view', homeroom, 6198, { pill: null, rootId: 77 })],
  progress: [thread(6311, 'Fix the close button', homeroom, 'building'), thread(403, 'Daily streaks', corner, 'checking')],
  waiting: [], live: [], openRow() {}, openThread() {}, onDone() {}, picked: [], onPick() {}, onNew() {}, query: '', onQuery() {}, searchOpen: false, onSearch() {},
};
const render = (over) => renderComponent(LIST, 'AiFrameList', { ...base, ...over }, { cache: false });
const titles = (html) => [...html.matchAll(/<span class="fr-t">([^<]+)/g)].map((m) => m[1]);

test('the head: the bot\'s tile, the title with the counts, the search disc and New chat, labelled', () => {
  const html = render();
  assert.match(html, /^<div class="fr fr-pane" data-ai-frame-list=""><div class="fr-scroll fr-botpage"><div class="fr-head" data-ai-hero=""><span class="fr-tile"[^>]*><img[^>]*><\/span><div class="fr-tx"><h1 class="fr-title">Homeroom bot<\/h1><p class="fr-purpose" data-ai-hero-sub="">/);
  // 14 Nov 2026: New chat is the page's one primary, a kit button with a
  // plus and its words, where the round "+" was.
  assert.match(html, /<div class="fr-acts"><button type="button" class="fr-ib fr-more" aria-label="Search threads and messages" title="Search threads and messages" aria-expanded="false" data-ai-search-toggle="">.*?<\/button><button type="button" class="fr-btn fr-sm" data-bot-new-thread="" data-ai-new-chat=""><svg[^>]*>.*?<\/svg>New chat<\/button><\/div>/s);
  assert.doesNotMatch(html, /New thread/);
  assert.doesNotMatch(html, /data-ai-search=""/, 'the search field is drawn only while it is open');
  const open = render({ searchOpen: true });
  assert.match(open, /<div class="fr-search"><label class="fr-inp">.*?<input type="search" class="fr-v" placeholder="Search threads and messages" aria-label="Search threads and messages" data-ai-search="" value=""\/>/s);
  assert.ok(open.indexOf('data-ai-search=""') < open.indexOf('data-ai-project-filter'), 'between the head and the projects, as on the standard page');
});

test('the projects are tabs that toggle, as the standard chips do: All, the busiest, then "N more"', () => {
  const html = render();
  assert.deepEqual([...html.matchAll(/class="fr-tab[^"]*" aria-pressed="([a-z]+)"[^>]*>(?:<span class="fr-tile"[^>]*>.*?<\/span>)?([^<]+)/g)].map((m) => [m[2], m[1]]), [['All', 'true'], ['Homeroom', 'false'], ['Game Corner', 'false']]);
  assert.doesNotMatch(html, /<button type="button" class="fr-tab fr-on" aria-pressed="true">All<span class="fr-n">/, 'All carries no count of what needs you');
  const fresh = render({ rows: [need('need:question:1', 'New here', corner, 402, { unread: 2 })] });
  assert.match(fresh, />All<span class="fr-n" aria-label="1 new">1<\/span>/, 'only what is new is counted on a tab (#6262)');
  const apps = ['a', 'b', 'c', 'd', 'e'].map((slug) => ({ slug, name: slug.toUpperCase() }));
  const many = render({ progress: [], rows: apps.map((app, i) => need(`need:decide:${i}`, `T${i}`, app, i + 1)) });
  assert.match(many, /<button type="button" class="fr-tab" aria-haspopup="dialog" aria-expanded="false" data-ai-project-more="">2 more<svg/, 'the rest behind the standard picker');
  const src = read(LIST);
  assert.match(src, /onClick=\{\(\) => toggle\(app\.slug\)\}/, 'a tab toggles its project');
  assert.match(src, /<ProjectPicker sheet=\{phone\} anchor=\{more\} ranked=\{ranked\} picked=\{picked\} onToggle=\{toggle\}/);
});

test('there is no Main Chat card: the groups follow the projects, and a private thread\'s row carries its own new mark', () => {
  // 14 Nov 2026: every conversation with the bot is a thread.
  const html = render();
  assert.doesNotMatch(html, /data-ai-main-row|data-ai-main-unread|fr-card fr-main|Main Chat/);
  assert.match(html, /<div class="fr-stack"><section class="fr-sec" data-ai-list="work">/, 'Needs you leads the stack');
  assert.doesNotMatch(read(LIST), /main\.(lit|unread|open)|store\.header\.main|ai\.main\.new/);
  // A private thread with something new is new like any thread (#6262).
  const fresh = render({ rows: [need('private:3', 'Keep a vote in view', homeroom, 6198, { pill: null, rootId: 77, threadId: null, unread: 2 })] });
  assert.match(fresh, />All<span class="fr-n" aria-label="1 new">1<\/span>/);
});

test('Needs you is one group with one card: a project\'s name, then one line a row ending in its one word', () => {
  const html = render();
  assert.equal((html.match(/<h2 class="fr-cap">/g) || []).length, 2, 'Needs you and Waiting & in progress');
  assert.match(html, /<section class="fr-sec" data-ai-list="work"><div class="fr-sechead"><h2 class="fr-cap">Needs you · 2<\/h2><\/div><div class="fr-card"><div class="fr-list">/);
  const work = html.slice(html.indexOf('data-ai-list="work"'), html.indexOf('data-ai-list="busy"'));
  assert.deepEqual(titles(work), ['Game Corner', 'Which part should zoom in?', 'Homeroom', 'Pick a direction', 'Keep a vote in view']);
  assert.match(work, /<div class="fr-row fr-sm fr-proj" data-ai-project-head=""><span class="fr-tile"[^>]*>🎮<\/span><span class="fr-tx"><span class="fr-t">Game Corner<\/span><\/span><\/div>/);
  assert.match(work, /<button type="button" class="fr-row fr-sm fr-item" title="Game Corner · #402" data-ai-line="need"><span class="fr-ei fr-acc" aria-hidden="true"><svg.*?<\/svg><\/span><span class="fr-num fr-mono fr-d">#402<\/span><span class="fr-tx"><span class="fr-t">Which part should zoom in\?<\/span><\/span><span class="fr-pill fr-act" data-kind="act">Needs Reply<\/span><span class="sr-only">Game Corner · #402<\/span><\/button>/s,
    'its glyph in the accent, its number, its title, the blue word; the whole line is its tooltip');
  assert.match(work, /<div class="fr-rowx" data-ai-line-done=""><button type="button" class="fr-row fr-sm fr-item"[^>]*data-ai-line="private">.*?<span class="fr-meta">Only you<\/span>.*?<\/button><div class="relative " data-private-thread-menu="">/s,
    'a private thread asks nothing: grey words, and its ⋯ (Mark done) beside the row');
  assert.doesNotMatch(html, /needs you<|in progress<|fr-track|fr-s"/, 'no group per project, no five-stop line, no second line');
  assert.match(render({ lit: 'page:app/homeroom/dev/issues/5998' }), /class="fr-row fr-sm fr-item fr-on"[^>]*data-ai-lit="" aria-current="true"/);
});

test('#6672: Needs you lifts a project by its newest activity, so a recent private chat is not last', () => {
  const html = render({
    owed: 2,
    rows: [
      need('need:question:1', 'Which part should zoom in?', corner, 402, { at: '2026-11-11T12:00:00Z' }),
      need('private:3', 'Keep a vote in view', homeroom, 6198, { pill: null, rootId: 77, threadId: null, at: '2026-11-14T12:00:00Z' }),
    ],
  });
  const work = html.slice(html.indexOf('data-ai-list="work"'), html.indexOf('data-ai-list="busy"'));
  assert.deepEqual(titles(work), ['Homeroom', 'Keep a vote in view', 'Game Corner', 'Which part should zoom in?'],
    'the project talked in today comes before the one quiet for three days');
  assert.match(read(LIST), /const needs = useHeld\(recentGroupsFirst\(freshFirst\(needLines\)\)\);/,
    'the drawn order is the new-first pass, then the projects by recency, then held');
});

test('a project folds after its first rows behind its own Show more; what is new leads and is said', () => {
  const rows = Array.from({ length: 8 }, (_, i) => need(`need:decide:${i}`, `Row ${i}`, homeroom, 100 + i, i === 7 ? { unread: 1 } : {}));
  const html = render({ rows, owed: 8, progress: [] });
  const work = html.slice(html.indexOf('data-ai-list="work"'));
  assert.deepEqual(titles(work), ['Homeroom', 'Row 7', 'Row 0', 'Row 1', 'Row 2', 'Row 3', 'Show 3 more'], 'the new one first among the first five, the rest folded');
  assert.match(work, /<h2 class="fr-cap">Needs you · 8<span class="fr-pill fr-act fr-mini" data-kind="act">1 new<\/span><\/h2>/);
  assert.match(work, /class="fr-row fr-sm fr-item fr-fresh"[^>]*data-ai-fresh=""><span class="fr-new" aria-hidden="true" data-ai-dot=""><\/span>/);
  assert.match(work, /<div class="fr-rule" data-ai-earlier="">Earlier<\/div><button type="button" class="fr-row fr-sm fr-item fr-plain"/, 'the line between what is new and what was seen');
  assert.match(work, /<button type="button" class="fr-row fr-sm fr-more" aria-expanded="false" data-ai-group-more=""><span class="fr-tx"><span class="fr-t">Show 3 more<\/span><\/span><svg/);
  const src = read(LIST);
  assert.match(src, /groupRows\(dayHeads \? byDay\(g\.items\) : g\.items, first, open, !foldFresh\)/, 'folded by the standard list\'s own rule, which never hides the row you are on');
  assert.match(src, /const held = holding && drawn\.current \? holdOrder\(lines, drawn\.current\) : lines;/, '#6245: the order holds under the pointer');
});

test('Waiting & in progress, with Not moving folded as its last row; Live this week; all in the fixed order', () => {
  const wait = (id, title, app, stage) => ({ ...thread(id, title, app, stage), work: { stage, line: null } });
  const live = (id, title, app) => ({ ...thread(id, title, app, 'live'), kind: 'change', change: { number: id } });
  const html = render({
    progress: [thread(1, 'One', homeroom, 'building'), thread(2, 'Two', corner, 'checking'), thread(3, 'Three', homeroom, 'building'), thread(4, 'Four', homeroom, 'building'), thread(12, 'Twelve', homeroom, 'building')],
    waiting: [wait(5, 'Five', homeroom, 'up_for_vote'), wait(7, 'Seven', homeroom, 'stopped')],
    live: [live(8, 'Eight', homeroom), live(9, 'Nine', corner)],
  });
  assert.deepEqual([...html.matchAll(/data-ai-list="([a-z]+)"/g)].map((m) => m[1]), ['work', 'busy', 'live']);
  const busy = html.slice(html.indexOf('data-ai-list="busy"'), html.indexOf('data-ai-list="live"'));
  const still = (busy.match(/data-ai-still="">.*?<span class="fr-t">([^<]+)/s) || [])[1];
  assert.match(busy, /<h2 class="fr-cap">Waiting &amp; in progress · 7<\/h2>/, 'one count: under way, waiting and not moving');
  assert.match(still || '', /^Not moving · \d$/);
  assert.match(busy, /<div data-ai-still-part=""><button type="button" class="fr-row fr-sm fr-more" aria-expanded="false" data-ai-still="">/);
  assert.ok(busy.indexOf('data-ai-still-part') > busy.lastIndexOf('data-ai-group-more'), 'after the rows, the card\'s last row');
  assert.match(busy, /Show \d more/, 'a project\'s own Show more');
  const went = html.slice(html.indexOf('data-ai-list="live"'));
  assert.match(went, /<h2 class="fr-cap">Live this week · 2<\/h2>/);
  assert.match(went, /data-ai-line="live"><span class="fr-ei" aria-hidden="true">/);
  const src = read(LIST);
  assert.match(src, /\{stillShown \? <Groups lines=\{stillLines\}/, 'Not moving opens its rows in place');
  assert.match(src, /data-ai-older-tab=""/, '#6233: the reload note under Live this week');
});

test('History: its kinds as small buttons inside the card, months as rows, Earlier months as the last row', () => {
  const history = {
    ready: true, loading: false, failed: false, next: 'c1', more() {}, retry() {},
    rows: [
      { key: 'h1', number: 6369, title: 'Email templates, part 7', app: homeroom, href: '#app/homeroom/dev/changes/6369', at: '2026-11-08T10:00:00Z', kind: 'change', outcome: 'live', by: 'you' },
      { key: 'h2', number: 6204, title: 'Mobile app safe area', app: homeroom, href: '#app/homeroom/dev/issues/6204', at: '2026-10-21T10:00:00Z', kind: 'request', outcome: 'closed' },
    ],
  };
  const html = render({ history, historyKind: 'change', onHistoryKind() {}, openHistory() {} });
  const block = html.slice(html.indexOf('data-ai-frame-history'));
  assert.match(block, /<h2 class="fr-cap">History<\/h2><\/div><div class="fr-card"><div class="fr-list"><div class="fr-btnrow" role="group" aria-label="[^"]+" data-ai-history-kinds=""><button type="button" class="fr-btn fr-quiet fr-sm" aria-pressed="false" data-ai-history-kind="all">All<\/button><button type="button" class="fr-btn fr-sm" aria-pressed="true" data-ai-history-kind="change">Changes<\/button>/);
  assert.equal((block.match(/<h2 class="fr-cap">/g) || []).length, 1, 'months are rows of the one card, not groups');
  assert.deepEqual([...block.matchAll(/<h3 class="fr-t">([^<]+)<\/h3>/g)].map((m) => m[1]), ['November', 'October']);
  assert.deepEqual(titles(block), ['Homeroom', 'Email templates, part 7', 'Homeroom', 'Mobile app safe area', 'Earlier months']);
  assert.match(block, /<button type="button" class="fr-row fr-sm fr-more" data-ai-history-more="">/);
  assert.match(render({ history: { ...history, rows: [], next: null } }), /<p class="fr-txt" data-ai-history-empty="">Nothing finished yet\.<\/p>/);
  assert.match(render({ history: { ...history, ready: false } }), /<p class="fr-txt" role="status" data-ai-history-loading="">Loading your history<\/p>/);
  assert.doesNotMatch(render({ history, query: 'zzz', searchOpen: true }), /data-ai-frame-history/, 'a search with nothing finished in it folds the group away');
});

test('one project picked: the same lists narrowed to it, no project names over the rows', () => {
  const html = render({ picked: ['homeroom'] });
  assert.match(html, /class="fr-tab fr-on" aria-pressed="true" data-ai-chip="homeroom"><span class="fr-tile" style="--fr-ts:18px[^"]*"[^>]*>.*?<\/span>Homeroom</, 'the project\'s tile before its name, as on the standard chip');
  assert.doesNotMatch(html, /data-ai-project-head|Which part should zoom in|Daily streaks/);
  assert.match(html, /<h2 class="fr-cap">Needs you · 1<\/h2>/, 'the group counts what is shown');
  assert.match(html, /<h2 class="fr-cap">Waiting &amp; in progress · 1<\/h2>/);
  assert.doesNotMatch(html, /fr-track/, 'no five-stop line on a row');
  const empty = render({ picked: ['quiet'], appFor: (slug) => ({ slug, name: 'Quiet Place' }) });
  assert.match(empty, /<p class="fr-txt" data-ai-empty="project">[^<]*Quiet Place[^<]*<\/p>/, 'a project with nothing of yours says so by name');
});

test('what the standard list says when it has nothing, cannot read, or finds no match', () => {
  assert.match(render({ rows: [], owed: 0, progress: [] }), /<h2 class="fr-cap">Needs you<\/h2>.*?<p class="fr-txt" data-ai-empty="">/s);
  assert.match(render({ ready: false, rows: [], progress: [] }), /<p class="fr-txt" role="status" data-ai-loading="">/);
  assert.match(render({ ready: false, rows: [], progress: [], failed: 'unreachable' }), /<div class="fr-txt" role="status" data-ai-failed="unreachable">.*?<button type="button" class="fr-link" data-ai-retry="">Try again<\/button>/s);
  const none = render({ query: 'no such thing', searchOpen: true });
  assert.match(none, /<div class="fr-card fr-pad"><span data-ai-search-empty="">[^<]*no such thing[^<]*<\/span><\/div>/);
  assert.doesNotMatch(none, /data-ai-list=/);
  assert.deepEqual(titles(render({ query: 'zoom', searchOpen: true })), ['Game Corner', 'Which part should zoom in?']);
});

// 13 Nov 2026: the search also reads what was said in the chat with the bot
// and its threads (./search.ts); both faces draw the rows ./lines.ts builds.
test('a search lists the messages that match under the threads, as kit rows that are links', () => {
  const year = new Date().getFullYear();
  const found = {
    q: 'zoom', more: true, state: 'answered',
    rows: [
      { messageId: 71, rootId: null, threadTitle: null, mine: true, snippet: 'Could it zoom in on the map?', ranges: [[9, 13]], at: `${year}-11-03T12:00:00.000Z` },
      { messageId: 88, rootId: 60, threadTitle: 'Map ideas', mine: false, snippet: '…a pinch to zoom, then', ranges: [[14, 18]], at: `${year}-11-02T12:00:00.000Z` },
    ],
  };
  assert.doesNotMatch(render({ found }), /data-ai-list="found"|<mark/, 'nothing of it with no search on');
  const html = render({ query: 'zoom', searchOpen: true, found });
  assert.ok(html.indexOf('data-ai-list="work"') < html.indexOf('data-ai-list="found"'), 'under the matching threads');
  const group = html.slice(html.indexOf('data-ai-list="found"'));
  assert.match(group, /<h2 class="fr-cap">In your messages · 2<\/h2>/, 'the group\'s label, as every group\'s');
  const rows = [...group.matchAll(/<a class="fr-row fr-sm fr-item" href="([^"]+)" title="[^"]*" aria-label="([^"]*)" data-ai-found="(chat|thread)">(.*?)<\/a>/g)];
  assert.deepEqual(rows.map((m) => [m[1], m[3]]), [['#homeroom-bot/m/71', 'chat'], ['#homeroom-bot/thread/60/m/88', 'thread']],
    'a message whose thread the answer does not name asks the tab which it is in (ai/where.ts)');
  assert.match(rows[0][4], /<span class="fr-t" data-ai-found-words="">Could it <mark class="[^"]*var\(--fr-acc-t\)[^"]*">zoom<\/mark> in on the map\?<\/span><span class="fr-s" data-ai-found-place="">Your chat with Homeroom bot<\/span>/);
  assert.match(rows[1][4], /<span class="fr-s" data-ai-found-place="">Map ideas<\/span>/);
  assert.match(rows[0][2], /^You: Could it zoom in on the map\? · Your chat with Homeroom bot · /);
  assert.match(rows[1][2], /^Homeroom bot: …a pinch to zoom, then · Map ideas · /);
  assert.match(group, /<p class="fr-txt" data-ai-found-more="">These are the newest matches\. Type more to narrow them down\.<\/p>/);
  // Nothing anywhere, once the messages have answered: the one note says both.
  const none = render({ query: 'no such thing', searchOpen: true, found: { q: 'no such thing', rows: [], more: false, state: 'answered' } });
  assert.match(none, /<span data-ai-search-empty="">Nothing in your threads or messages matches “no such thing”<\/span>/);
  assert.doesNotMatch(render({ query: 'no such thing', searchOpen: true, found: null }), /data-ai-search-empty/, 'not before they answer');
  // The messages could not be read.
  const failed = render({ query: 'zoom', searchOpen: true, found: { q: 'zoom', rows: [], more: false, state: 'failed' } });
  assert.match(failed, /<div class="fr-txt" role="status" data-ai-search-failed="">Your messages could not be searched\. <button type="button" class="fr-link" data-ai-search-retry="">Try again<\/button><\/div>/);
});

test('the page draws this list in place of its own under a look, from the same rows, presses and search', () => {
  const src = read('frontend', 'src', 'features', 'ai', 'index.tsx');
  assert.match(src, /const frame = isFrameSkin\(useSkin\(\)\);/, 'after mount only: useSkin answers standard on the first render');
  assert.match(src, /\{frame \? \(\s*<AiFrameList\s+heroLine=\{heroLine\}\s+query=\{searchOpen \? query : ''\}\s+onQuery=\{setQuery\}\s+searchOpen=\{searchOpen\}\s+onSearch=\{setSearchOpen\}\s+searchRef=\{searchRef\}/);
  assert.match(src, /failed=\{failed\}\s+onRetry=\{\(\) => setMoved\(\(n\) => n \+ 1\)\}\s+rows=\{rows\}\s+owed=\{owed\}/);
  assert.match(src, /openRow=\{openRow\}\s+openThread=\{openThread\}\s+onDone=\{[^\n]+\}\s+picked=\{picked\}\s+onPick=\{pick\}/);
  assert.match(src, /history=\{history\}\s+historyKind=\{historyKind\}\s+onHistoryKind=\{pickKind\}\s+openHistory=\{openHistory\}\s+historyRef=\{historyRef\}\s+\/>/);
  assert.match(src, /data-frame-list=\{frame \? '' : undefined\}/);
  assert.doesNotMatch(src, /useFramePage\(/, 'the frame\'s bar named Main Chat on a phone; a thread and a new chat name themselves');
  const list = read(LIST);
  assert.doesNotMatch(list, /\bfetch\(|useEffect\(/, 'nothing is read or kept in the list itself');
  assert.match(list, /\} = useAiLines\(\{ query, lit, ready, rows, owed, progress, waiting, live, openRow, openThread, onDone, picked: pickedIn, onPick, appFor, history, openHistory, found \}\);/, 'the rows are the ones the standard list draws');
  assert.match(read('frontend/src/features/ai/lists.tsx'), /\} = useAiLines\(\{ query, lit, ready, rows, owed, progress, waiting, live, openRow, openThread, onDone, picked: pickedIn, onPick, appFor, history, openHistory, found \}\);/);
});

test('the list\'s New chat opens the same new chat as the standard head\'s', () => {
  const src = read('frontend', 'src', 'features', 'ai', 'index.tsx');
  assert.match(src, /onNew=\{openNewChat\}/);
  assert.match(src, /<NewChatButton onOpen=\{openNewChat\} \/>/, 'one door, set to the same project');
  assert.match(read(LIST), /<Btn small icon="plus" data-bot-new-thread="" data-ai-new-chat="" onClick=\{onNew\}>\{t\('messages:newThread\.start'\)\}<\/Btn>/);
});

test('the two panes: the list a narrow page alone, 520px beside an open item; the phone keeps its Ask bar', () => {
  const css = read('public', 'css', 'app.css');
  assert.match(css, /html\[data-skin\] #ai-screen\[data-frame-list\] \{ --ai-main-w: max\(360px, calc\(var\(--platform-usable-w\) - 520px\)\); \}/);
  assert.match(css, /html\[data-skin\] #ai-screen\[data-frame-list\]:not\(\[data-ai-open\]\) > \.fr-pane > \.fr-scroll \{ max-width: 784px; margin-inline: auto; \}/, 'with nothing open beside it the list is the kit\'s narrow page');
  assert.match(css, /html\[data-skin\] #ai-screen\[data-frame-list\] \.ai-main-pane \{ top: var\(--fr-shell-top\); background: none;[^}]*border-inline-start: 1px solid var\(--fr-line\);/);
  assert.match(css, /html\[data-skin\] #ai-screen\[data-frame-list\] #ai-main-divider \{ display: none; \}/, 'the width is the frame\'s, so the handle steps aside');
  assert.match(css, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) #ai-screen\[data-frame-list\] \.ai-main-pane \.messages-layout\[data-bot-threads\] \.chat-transcript \{ padding-inline: max\(32px, calc\(\(100% - 720px\) \/ 2\)\); \}/);
  assert.match(css, /html\[data-skin\] body:has\(#ai-screen\[data-frame-list\]:not\(\.hidden\)\) \{ --ai-main-w: max\(360px, calc\(var\(--platform-usable-w\) - 520px\)\); \}/);
  assert.doesNotMatch(css, /html\[data-skin\] #ai-screen\[data-frame-list\] \.ai-askbar,\s*html\[data-skin\] #ai-screen\[data-frame-list\] \.ai-askbar-gap \{ display: none; \}/, 'version 2: the Ask Homeroom bot bar is back over the phone\'s tab bar');
  assert.match(css, /html\[data-skin\] #ai-screen\[data-frame-list\] \.ai-askbar-card \{ flex-direction: row;/);
});

test('what the first tour invented is gone: its words left the catalog, and the list words itself as the standard page does', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'messages.json'));
  assert.deepEqual(Object.keys(en).filter((key) => key.startsWith('frame.bot.')), []);
  const list = read(LIST);
  assert.doesNotMatch(list, /frame\.bot\.|Track\b/);
  for (const id of ['ai.search.open', 'newThread.start', 'ai.filter.all', 'ai.filter.more', 'ai.work.titleCount', 'ai.busy.title', 'ai.up.stillCount', 'ai.live.title', 'ai.history.title', 'ai.work.showMore', 'ai.history.earlier', 'ai.search.messages', 'ai.search.more', 'ai.search.failed', 'ai.filter.emptyProject']) {
    assert.match(list, new RegExp(`'messages:${id.replace(/\./g, '\\.')}'`), id);
  }
  // What the search says when nothing matched is decided once for both faces (lines.ts).
  const lines = read('frontend', 'src', 'features', 'ai', 'lines.ts');
  for (const id of ['ai.search.none', 'ai.search.noneThreads', 'ai.search.inChat', 'ai.search.rowYou', 'ai.search.rowBot']) {
    assert.match(lines, new RegExp(`'messages:${id.replace(/\./g, '\\.')}'`), id);
  }
  assert.match(list, /data-ai-search-empty="">\{noneWords\}</);
});

test('s10: the column draws no head of its own: Main Chat\'s is gone, and a thread and a new chat bring theirs', () => {
  const src = read('frontend', 'src', 'features', 'ai', 'index.tsx');
  assert.doesNotMatch(src, /kit\('dhead'\)|data-ai-main-head|data-ai-main-close|ai-main-title|messages:ai\.main\./);
  assert.match(src, /\{conversationUp \? <EmbeddedConversation conversationId=\{botId!\} active=\{visible && columnOpen\} at=\{at\} threadsOnly \/> : null\}\n\s+<\/aside>/);
});

test('s11: a request in the column stands under the kit\'s open-item head; on a phone its page keeps the two back chips', () => {
  const css = read('public', 'css', 'app.css');
  const panel = 'html\\[data-skin\\] body:has\\(#ai-screen\\[data-frame-list\\]:not\\(\\.hidden\\)\\) ';
  assert.match(css, new RegExp(`${panel}\\.side-panel-head \\{ min-height: 68px; gap: 12px; padding-block: 8px; padding-inline: 32px; background: none; border-bottom: 1px solid var\\(--fr-line\\); \\}`));
  assert.match(css, new RegExp(`${panel}\\.side-panel-place > \\.app-icon-tile \\{ width: 40px; height: 40px; border-radius: 12px; \\}`));
  assert.match(css, new RegExp(`${panel}\\.side-panel-place-title \\{ font-size: 17px;`));
  assert.match(css, new RegExp(`${panel}\\.side-panel-ai-close \\{ width: 36px; height: 36px; border-radius: 50%;`));
  assert.match(css, /@media \(max-width: 767px\) \{\s*html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) #gc-thread-back:has\(> \.dev-topic-backs\) \{ display: flex;/,
    'the pair of chips (Homeroom bot, Workshop) is shown; a page with one chip keeps the bar\'s arrow alone');
  assert.match(read('frontend/src/features/dev-board/topic/topic-back.tsx'), /<div className="dev-topic-backs">/);
});

test('s12: a row with a ⋯ is lit as one, and a rule with words is the kit\'s', () => {
  const kit = read('frontend', 'looks', 'kit.css');
  assert.match(kit, /\.rowx:has\(>\.row\.on\)\{background:var\(--lit-t\)\}\.rowx>\.row\.on\{background:none\}/);
  assert.match(kit, /\.rule\{display:flex;align-items:center;gap:12px;font-size:12px;color:var\(--mut\)\}\n\.rule::after\{content:"";flex:1;height:1px;background:var\(--line\)\}/);
});

test('s13: New thread stays the product\'s pane in the column, wearing the kit: the starts are rows in one card', () => {
  const pane = read('frontend', 'src', 'features', 'messages', 'new-thread.tsx');
  assert.match(pane, /<aside className="messages-reply-pane platform-kb-column dc-lift dc-lift-session" aria-label=\{t\('messages:newThread\.title'\)\} data-bot-new-thread-pane=""/, 'not a sheet: the column, as today');
  const looks = JSON.parse(read('frontend', 'looks', 'looks.json'));
  assert.match(looks.wear.roots.card.to, /\.messages-starts-list:where\(#ai-screen\[data-frame-list\] \*\)/, 'the starts\' list wears the kit\'s card');
  const css = read('public', 'css', 'app.css');
  const at = 'html\\[data-skin\\] #ai-screen\\[data-frame-list\\] \\[data-bot-new-thread-pane\\] ';
  assert.match(css, new RegExp(`${at}\\.messages-start \\{ display: flex; gap: 12px; min-height: 60px; padding: 8px 16px; border-radius: 0; background: none; box-shadow: none;`));
  assert.match(css, new RegExp(`${at}\\.messages-start \\+ \\.messages-start \\{ border-top: 1px solid var\\(--fr-line2\\); \\}`));
  assert.match(css, new RegExp(`${at}\\.messages-project-chip \\{ height: 32px;[^}]*background: var\\(--fr-sunk\\);`), 'the project chip and the who-works-on-it chip as small quiet buttons');
});
