'use strict';

// The AI tab's main view (#6019 follow-up): frontend/src/features/ai/.
// Plan v3: "what needs you comes first, then your private threads, with a
// lock on the tile, then Up next: what's moving without you, soonest first.
// Ask Homeroom bot opens Main." Up next is In progress since 29 Oct 2026,
// and Needs you here is the threads you are in (?in=threads).
//
// What this pins:
//   1. Your work's order: the Needs you feed, then private threads, then the
//      person's requests waiting on someone; a vote they owe is listed once.
//   2. Each row's words and its one pill, and where it goes.
//   3. The screen's first render is the prerender: hidden, the bot's name,
//      no rows; the lists load in effects, Main is docked only after mount.
//   4. The routes: #homeroom-bot is the page, #homeroom-bot/main and
//      #homeroom-bot/thread/<id> are Main; #ai, the old address, lands there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const MODEL = 'frontend/src/features/ai/model.ts';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const words = (p) => message(p.id, p.values);

const app = { slug: 'garden', name: 'Garden club', icon_url: null, icon_emoji: null };

test('Your work: what needs you, then private threads, then yours waiting, each once', () => {
  const { yourWork, needHref } = loadTsx(MODEL);
  const needs = [
    { kind: 'proposal', id: 11, number: 403, title: 'Dark mode', app },
    { kind: 'ballot', id: 12, number: 408, title: 'A or B', app, ballot: { number: 401, title: 'Night theme' } },
    { kind: 'question', id: 13, number: 390, title: 'Which camera?', app },
    { kind: 'governance', id: 14, number: null, title: 'Rename it', app },
  ];
  const work = {
    private: [
      { rootId: 91, title: 'A calendar idea', kind: 'idea', app: null, at: null },
      { rootId: 92, title: 'Sort by date', kind: 'draft_request', app, at: null },
    ],
    next: [],
    waiting: [
      { threadId: 5, number: 388, kind: 'work', title: 'Print view', app, change: null, href: '#app/garden/dev/issues/388', group: 'waiting', what: 'not_picked_up', at: null, quietDays: 10 },
      { threadId: 6, number: 390, kind: 'work', title: 'Photos', app, change: null, href: '#app/garden/dev/issues/390', group: 'waiting', what: 'not_picked_up', at: null },
    ],
    live: [],
  };
  const rows = yourWork(needs, work);
  assert.deepEqual(rows.map((r) => r.key), [
    'need:proposal:11', 'need:ballot:12', 'need:question:13', 'need:governance:14',
    'private:91', 'private:92',
    'waiting:5',
  ], '#390 is the question owed above, so it is not listed again');
  assert.deepEqual(rows.map((r) => r.pill && message(r.pill.id)), ['Vote', 'Pick one', 'Answer', 'Vote', null, null, null]);
  assert.equal(rows[1].title, 'Night theme', 'a ballot is named for the request its changes compete for');
  assert.equal(words(rows[1].sub), 'Garden club · #401');
  assert.equal(rows[1].href, '#app/garden/dev/issues/401', 'and is decided on its page');
  assert.equal(rows[0].href, '#app/garden/dev/changes/403');
  assert.equal(rows[2].href, '#app/garden/dev/issues/390');
  assert.equal(rows[3].href, '#app/garden/dev/governance/14');
  assert.equal(words(rows[3].sub), 'Garden club');
  // Private threads: a lock on the tile, and where they stand.
  assert.deepEqual([rows[4].who, words(rows[4].sub)], ['solo', 'Only you · Not in a community yet']);
  assert.deepEqual([rows[5].who, words(rows[5].sub)], ['me', 'Only you · Garden club · Not posted yet']);
  assert.equal(rows[4].rootId, 91, 'a private thread opens in Main');
  assert.equal(words(rows[6].sub), 'Garden club · #388 · Not picked up yet · quiet 10 days');
  assert.equal(needHref({ kind: 'proposal', id: 1, number: 2, href: '#somewhere' }), '#somewhere', 'a card that says where it goes');
  assert.equal(yourWork(null, null).length, 0);
});

test('a long queue of votes folds to three, so your private threads still show', () => {
  const { yourWork, foldWork, NEEDS_FIRST, WORK_FIRST } = loadTsx(MODEL);
  const needs = Array.from({ length: 9 }, (_, i) => ({ kind: 'proposal', id: i + 1, number: 500 + i, title: `Change ${i}`, app }));
  const work = {
    private: [
      { rootId: 91, title: 'A calendar idea', kind: 'idea', app: null, at: null },
      { rootId: 92, title: 'Sort by date', kind: 'draft_request', app, at: null },
    ],
    next: [],
    waiting: [{ threadId: 5, number: 388, kind: 'work', title: 'Print view', app, change: null, href: '#app/garden/dev/issues/388', group: 'waiting', what: 'not_picked_up', at: null }],
    live: [],
  };
  const rows = yourWork(needs, work);
  assert.equal(NEEDS_FIRST, 3);
  assert.deepEqual(foldWork(rows).map((r) => r.key), [
    'need:proposal:1', 'need:proposal:2', 'need:proposal:3',
    'private:91', 'private:92', 'waiting:5',
  ], 'the heading counts the other six and Show more opens them');
  assert.equal(rows.length, 12, 'Show more still opens every row, in order');
  const many = { ...work, private: Array.from({ length: 12 }, (_, i) => ({ rootId: 100 + i, title: `Idea ${i}`, kind: 'idea', app: null, at: null })) };
  assert.equal(foldWork(yourWork(needs, many)).length, WORK_FIRST, 'and the fold is never longer than the first eight');
});

test('In progress says what each waits on, and the hero counts it', () => {
  const { nextWords, heroWords } = loadTsx(MODEL);
  const row = (what, extra = {}) => ({ threadId: 1, number: 7, app, what, ...extra });
  assert.deepEqual([
    row('going_live'), row('merging'),
    row('vote', { myVote: 'yes' }), row('vote', { myVote: 'no' }), row('vote', { myVote: null }),
    row('building', { by: 'bot' }), row('building', { by: 'you' }), row('building', { by: 'someone' }),
  ].map((r) => words(nextWords(r))), [
    'Garden club · #7 · Going live', 'Garden club · #7 · Merging',
    'Garden club · #7 · Waiting for votes · you voted Yes', 'Garden club · #7 · Waiting for votes · you voted No',
    'Garden club · #7 · Waiting for votes',
    'Garden club · #7 · Homeroom bot is building it', 'Garden club · #7 · You\'re building it',
    'Garden club · #7 · Being built',
  ]);
  assert.equal(message('messages:ai.next.title'), 'In progress');
  assert.equal(words(heroWords(2, 3)), 'Needs you: 2 · In progress: 3');
  assert.equal(words(heroWords(0, 3)), 'In progress: 3');
});

test('Needs you here is the threads you are in; All votes opens every one you owe', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /readJson<\{ items\?: NeedItem\[\] \}>\(`\/api\/workshop\/needs-feed\?in=threads\$\{qs \? '&demo=1' : ''\}`\)/);
  assert.match(src, /<SecHead end=\{needs \? \(\s*<a href="\/\?ws=needs#communities"/, 'shown even when nothing here needs you');
  assert.equal(message('messages:ai.work.answerAll'), 'All votes');
  const route = read('src/routes/workshop-overview.js');
  assert.match(route, /pool\.query\(req\.query\.in === 'threads' \? NEEDS_FEED_IN_THREADS_SQL : NEEDS_FEED_SQL, \[/);
  const { NEEDS_FEED_SQL, NEEDS_FEED_IN_THREADS_SQL } = require('../src/routes/workshop-overview');
  assert.match(NEEDS_FEED_IN_THREADS_SQL, /AND \(o\.kind = 'question'\s+OR \(o\.thread_id IN \(SELECT mine\.thread_id FROM/, 'the bot\'s questions to you show wherever they are');
  assert.match(NEEDS_FEED_IN_THREADS_SQL, /f\.muted_at IS NOT NULL/, 'not a thread you muted');
  assert.ok(!NEEDS_FEED_SQL.includes('thread_followers f'), 'Communities › Needs you keeps every decision owed');
});

test('the first render is the prerender: hidden, the bot\'s name, no rows; lists in effects', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /id="ai-screen"\s+className="hidden flex-1 overflow-y-auto platform-safe-scroll"/);
  assert.match(src, /useVisibilityHiddenClass\(screenRef, 'ai-screen', false\);/);
  // Data only once the screen is shown to somebody signed in.
  assert.match(src, /if \(!visible \|\| typeof window === 'undefined' \|\| !\(window as any\)\.App\?\.user\) return undefined;/);
  assert.match(src, /readJson<AiWork>\(`\/api\/ai\/work\$\{qs\}`\)/);
  // Main docked beside it only on a wide window, after mount.
  assert.match(src, /const \[wide, setWide\] = useState\(false\);/);
  assert.match(src, /\{docked \? \(\s*<aside className="ai-main-pane"/);
  assert.match(src, /<EmbeddedConversation conversationId=\{botId!\} active=\{visible\} at=\{at\} \/>/);
  // Ask Homeroom bot opens Main; a private thread opens in it.
  assert.match(src, /<a href="#homeroom-bot\/main" className="messages-composer-card ai-askbar-card"/);
  assert.match(src, /else go\(`#homeroom-bot\/thread\/\$\{row\.rootId\}`\);/);
});

test('a page drawn before sign-in is confirmed asks again once it is, and its Ask bar starts at the rail', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  // app.js announces the signed-in viewer with sv:session, on a saved-session
  // boot and again once the server confirms it; both reads and the docked
  // chat go again then, instead of staying empty until a reload.
  assert.match(src, /const again = \(\) => setSession\(\(n\) => n \+ 1\);\s+document\.addEventListener\('sv:session', again\);\s+return \(\) => document\.removeEventListener\('sv:session', again\);/);
  assert.match(src, /return \(\) => \{ live = false; \};\s+\}, \[visible, session\]\);/);
  assert.match(src, /\}, \[visible, wide, botId, session\]\);/);
  assert.match(read('public/js/app.js'), /document\.dispatchEvent\(new CustomEvent\('sv:session', \{\s+detail: \{ user: App\.user, verifiedSession: true \},/,
    'the confirmation it waits for');
  // A wide window whose Main is not docked (yet, or at all) keeps the bar
  // on the page, clear of the sidebar.
  assert.match(read('public/css/app.css'), /#ai-screen \.ai-askbar \{\s+position: fixed;\s+(\/\*[^*]*\*+([^/*][^*]*\*+)*\/\s+)?left: calc\(var\(--platform-rail-w, 0px\) \+ var\(--platform-gutter, 0px\)\);\s+right: var\(--platform-gutter, 0px\);/);
});

test('#homeroom-bot is the page; /main and /thread/<id> are Main, on the Messages screen; #ai lands there', () => {
  const app = read('public/js/app.js');
  assert.match(app, /if \(parts\[1\] !== 'main' && parts\[1\] !== 'thread'\) \{\s+App\.navigateToAi\(\);\s+return;\s+\}/);
  assert.match(app, /case 'homeroom-bot':\s+case 'ai': return \['main', 'thread'\]\.includes\(frag\.split\('\/'\)\[1\]\)\s+\? 'messages-screen'[^\n]*\n\s+: 'ai-screen';/);
  // The old address is an alias: rewritten in place, then routed as the new one.
  assert.match(app, /if \(parts\[0\] === 'ai'\) \{[\s\S]*?history\.replaceState\(null, '', '#homeroom-bot' \+ \(parts\.length > 1 \? '\/' \+ parts\.slice\(1\)\.join\('\/'\) : ''\)\);[\s\S]*?parts\[0\] = 'homeroom-bot';\s+\}\s+if \(parts\[0\] === 'homeroom-bot'\) \{/);
  const store = read('frontend/src/features/messages/store.ts');
  // Main's arrow goes back to the page, and the inbox's drawer is not its.
  assert.match(store, /if \(botOnShow\(\) && !\(isMobile\(\) && state\.route\.threadRootId\)\) \{\s+app\.setBackIcon\?\.\('arrow', '#homeroom-bot'\);/);
  assert.match(read('frontend/src/features/nav-drawer/messages-drawer.ts'), /if \(at\.conversationId && at\.bot\) return false;/);
});

test('the screen renders as the prerender does: hidden, the bot\'s name, Your work, the Ask bar, no rows', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/index.tsx', 'AiScreen', {});
  // (React hoists the bot's picture as an image preload ahead of it.)
  assert.match(html, /^(<link rel="preload" as="image" href="\/brand\/homeroom-mark\.png"\/>)?<main id="ai-screen" class="hidden flex-1 overflow-y-auto platform-safe-scroll" data-page-bounce=""/);
  assert.match(html, /<h1 class="[^"]*">Homeroom bot<\/h1>/);
  assert.match(html, /Your work/);
  assert.match(html, /<a href="#homeroom-bot\/main" class="messages-composer-card ai-askbar-card" aria-label="Ask Homeroom bot">/);
  assert.ok(!html.includes('data-ai-row'), 'no rows before the effects read them');
  assert.ok(!html.includes('data-ai-main'), 'and Main is not docked before mount');
});

test('on a wide window: Main has its name over it, and a public row opens in the side panel in its place', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /<aside className="ai-main-pane" aria-labelledby="ai-main-title" data-ai-main="">\s+<header className="ai-main-head" data-ai-main-head="">/);
  assert.match(src, /<span id="ai-main-title"[^>]*>\s+\{t\('messages:store\.header\.main'\)\}/);
  assert.match(src, /\{t\('messages:ai\.main\.sub'\)\}/);
  assert.equal(message('messages:ai.main.sub'), 'Your chat with Homeroom bot. Only you can see it.');
  // A request, a change or a decision: the panel takes it when Main is docked; its page otherwise.
  assert.match(src, /if \(docked\) \{\s+try \{\s+if \(sidePanel\(\)\?\.take\?\.\(href\.replace\(\/\^#\/, ''\)\)\) return;/);
  assert.equal((src.match(/onClick=\{\(\) => openPublic\(row\.href, docked\)\}/g) || []).length, 2, 'In progress and Live this week');
  assert.match(src, /openPublic\(row\.href, docked\);\s+\};/, 'and Your work');
  // A private thread is Main's: the panel gives its place back first.
  assert.match(src, /sidePanel\(\)\?\.close\?\.\(\);\s+setAt\(\{ threadRootId: row\.rootId, focusMessageId: null \}\);/);
  // The panel may stand beside the AI tab's page, and stays while it is up.
  assert.match(read('frontend/src/features/side-panel/controller.ts'),
    /const besideAi = typeof A\._isScreenVisible === 'function' && A\._isScreenVisible\('ai-screen'\);/);
  assert.match(read('public/js/app.js'), /appPresence\?\.\(\(inApp \|\| screen === 'ai-screen'\) && !App\.chromeless\)/);
});

test('Main\'s column is held inside the window, and the panel takes its place', () => {
  const css = read('public/css/app.css');
  // A width chosen beside an app on a wide monitor must not run Main under the rail.
  assert.match(css, /#ai-screen \{\s+--ai-main-w: max\(320px, min\(var\(--side-panel-w, 400px\), calc\(100vw - var\(--platform-rail-w, 0px\) - 480px\)\)\);\s+\}/);
  assert.match(css, /#ai-screen\[data-ai-docked\] \{ padding-right: var\(--ai-main-w\); \}/);
  assert.match(css, /#ai-screen \.ai-main-pane \{[^}]*width: var\(--ai-main-w\);/);
  assert.match(css, /#ai-screen \.ai-main-pane > \.messages-layout \{ flex: 1 1 auto; height: auto; min-height: 0; \}/);
  assert.match(css, /html\[data-side-panel\] #ai-screen \.ai-main-pane \{ display: none; \}/);
  assert.match(css, /html\[data-side-panel\] #ai-screen\[data-ai-docked\] \{ padding-right: var\(--side-panel-w\); \}/);
});

test('the tab says Homeroom bot: a wide seat on a phone, two lines in the Duo column', () => {
  assert.equal(message('core:tabs.ai'), 'Homeroom bot');
  const css = read('public/css/app.css');
  // Measured in the bar's font: 79px of label in an 83-87px seat at 375-390, 76 in 80 at 360.
  assert.match(css, /#platform-tabs \{ grid-template-columns: 1fr 1\.3fr 1\.3fr 1fr 1fr; \}/,
    'Communities, second, and Homeroom bot, third, take the wide seats');
  assert.match(css, /#platform-tabs \{ grid-template-columns: 1fr 1\.2fr 1\.2fr 1fr 1fr; \}/, 'a little less on the smallest phones');
  assert.match(css, /:is\(#platform-tab-workshop, #platform-tab-ai\) \.platform-tab-label \{\s+letter-spacing: -\.02em;\s+overflow: visible;\s+text-overflow: clip;\s+\}/,
    'tightened and let out of the cell rather than cut');
  assert.match(css, /html\[data-side-strip\] #platform-tab-ai \.platform-tab-label \{\s+font-size: 9\.5px;\s+letter-spacing: -\.02em;\s+line-height: 1\.05;\s+white-space: normal;\s+text-align: center;\s+\}/,
    'the Duo column: "Homeroom" over "bot"');
});
