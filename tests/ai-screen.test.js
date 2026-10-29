'use strict';

// The AI tab's main view (#6019 follow-up): frontend/src/features/ai/.
// Plan v3: "what needs you comes first, then your private threads, with a
// lock on the tile, then Up next: what's moving without you, soonest first.
// Ask Homeroom bot opens Main."
//
// What this pins:
//   1. Your work's order: the Needs you feed, then private threads, then the
//      person's requests waiting on someone; a vote they owe is listed once.
//   2. Each row's words and its one pill, and where it goes.
//   3. The screen's first render is the prerender: hidden, the bot's name,
//      no rows; the lists load in effects, Main is docked only after mount.
//   4. The routes: #ai is the page, #ai/main and #ai/thread/<id> are Main.

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
  ], 'the heading counts the other six and Answer all opens them');
  assert.equal(rows.length, 12, 'Show more still opens every row, in order');
  const many = { ...work, private: Array.from({ length: 12 }, (_, i) => ({ rootId: 100 + i, title: `Idea ${i}`, kind: 'idea', app: null, at: null })) };
  assert.equal(foldWork(yourWork(needs, many)).length, WORK_FIRST, 'and the fold is never longer than the first eight');
});

test('Up next says what happens next, and the hero counts it', () => {
  const { nextWords, heroWords } = loadTsx(MODEL);
  const row = (what) => ({ threadId: 1, number: 7, app, what });
  assert.deepEqual(['going_live', 'merging', 'vote', 'building'].map((w) => words(nextWords(row(w)))), [
    'Garden club · #7 · Going live', 'Garden club · #7 · Merging',
    'Garden club · #7 · Up for a vote', 'Garden club · #7 · Being built',
  ]);
  assert.equal(words(heroWords(2, 3)), 'Needs you: 2 · Up next: 3');
  assert.equal(words(heroWords(0, 3)), 'Up next: 3');
});

test('the first render is the prerender: hidden, the bot\'s name, no rows; lists in effects', () => {
  const src = read('frontend/src/features/ai/index.tsx');
  assert.match(src, /id="ai-screen"\s+className="hidden flex-1 overflow-y-auto platform-safe-scroll"/);
  assert.match(src, /useVisibilityHiddenClass\(screenRef, 'ai-screen', false\);/);
  // Data only once the screen is shown to somebody signed in.
  assert.match(src, /if \(!visible \|\| typeof window === 'undefined' \|\| !\(window as any\)\.App\?\.user\) return undefined;/);
  assert.match(src, /readJson<AiWork>\(`\/api\/ai\/work\$\{qs\}`\)/);
  assert.match(src, /readJson<\{ items\?: NeedItem\[\] \}>\(`\/api\/workshop\/needs-feed\$\{qs\}`\)/);
  // Main docked beside it only on a wide window, after mount.
  assert.match(src, /const \[wide, setWide\] = useState\(false\);/);
  assert.match(src, /\{docked \? \(\s*<aside className="ai-main-pane"/);
  assert.match(src, /<EmbeddedConversation conversationId=\{botId!\} active=\{visible\} at=\{at\} \/>/);
  // Ask Homeroom bot opens Main; a private thread opens in it.
  assert.match(src, /<a href="#ai\/main" className="messages-composer-card ai-askbar-card"/);
  assert.match(src, /else go\(`#ai\/thread\/\$\{row\.rootId\}`\);/);
});

test('#ai is the page; #ai/main and #ai/thread/<id> are Main, on the Messages screen', () => {
  const app = read('public/js/app.js');
  assert.match(app, /if \(parts\[1\] !== 'main' && parts\[1\] !== 'thread'\) \{\s+App\.navigateToAi\(\);\s+return;\s+\}/);
  assert.match(app, /case 'ai': return \['main', 'thread'\]\.includes\(frag\.split\('\/'\)\[1\]\)\s+\? 'messages-screen'[^\n]*\n\s+: 'ai-screen';/);
  const store = read('frontend/src/features/messages/store.ts');
  // Main's arrow goes back to the page, and the inbox's drawer is not its.
  assert.match(store, /if \(botOnShow\(\) && !\(isMobile\(\) && state\.route\.threadRootId\)\) \{\s+app\.setBackIcon\?\.\('arrow', '#ai'\);/);
  assert.match(read('frontend/src/features/nav-drawer/messages-drawer.ts'), /if \(at\.conversationId && at\.bot\) return false;/);
});

test('the screen renders as the prerender does: hidden, the bot\'s name, Your work, the Ask bar, no rows', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/ai/index.tsx', 'AiScreen', {});
  // (React hoists the bot's picture as an image preload ahead of it.)
  assert.match(html, /^(<link rel="preload" as="image" href="\/brand\/homeroom-mark\.png"\/>)?<main id="ai-screen" class="hidden flex-1 overflow-y-auto platform-safe-scroll" data-page-bounce=""/);
  assert.match(html, /<h1 class="[^"]*">Homeroom bot<\/h1>/);
  assert.match(html, /Your work/);
  assert.match(html, /<a href="#ai\/main" class="messages-composer-card ai-askbar-card" aria-label="Ask Homeroom bot">/);
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
  assert.equal((src.match(/onClick=\{\(\) => openPublic\(row\.href, docked\)\}/g) || []).length, 2, 'Up next and Live this week');
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
