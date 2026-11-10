// Homeroom bot's list in the one frame (frontend/src/features/ai/frame-
// list.tsx), as the 2026-11-06 screen tour draws it (s08, s09, s14): the
// page's head, tabs by project, a search, Main Chat's row, then a group per
// project of the threads that need you. It is the product's own list
// (./lists.tsx) with another face: the same rows, words and presses, built
// by ./model.ts and handed in by the page.
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
  main: { lit: false, unread: 0, open() {} }, lit: null, ready: true,
  rows: [need('need:question:1', 'Which part should zoom in?', corner, 402), need('need:decide:2', 'Pick a direction', homeroom, 5998), need('private:3', 'Keep a vote in view', homeroom, 6198, { pill: null })],
  progress: [thread(6311, 'Fix the close button', homeroom, 'building'), thread(403, 'Daily streaks', corner, 'checking')],
  waiting: [], live: [], openRow() {}, openThread() {}, picked: [], onPick() {}, onNew() {}, query: '', onQuery() {},
};
const render = (over) => renderComponent(LIST, 'AiFrameList', { ...base, ...over }, { cache: false });

test('the list is the kit\'s pane: the head with its counts and one action, tabs, a search', () => {
  const html = render();
  assert.match(html, /^<div class="fr fr-pane" data-ai-frame-list=""><div class="fr-scroll"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Homeroom bot<\/h1><p class="fr-purpose"><span>3<\/span>|^<div class="fr fr-pane" data-ai-frame-list=""><div class="fr-scroll"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Homeroom bot<\/h1><p class="fr-purpose">Needs you: /);
  assert.match(html, /<div class="fr-acts"><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>New thread<\/button><\/div>/s);
  assert.deepEqual([...html.matchAll(/class="fr-tab[^"]*" aria-pressed="[a-z]+">([^<]+)</g)].map((m) => m[1]), ['All', 'Homeroom', 'Game Corner'],
    'All, then the projects with the most going on');
  assert.match(html, /<button type="button" class="fr-tab fr-on" aria-pressed="true">All<span class="fr-n">3<\/span><\/button>/, 'All says how many need you');
  assert.match(html, /placeholder="Search your threads"/);
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('Main Chat first, then a group per project of what needs you, each row ending in its one word', () => {
  const html = render();
  const main = html.indexOf('>Main Chat<');
  const cornerAt = html.indexOf('>Game Corner · needs you<');
  const homeAt = html.indexOf('>Homeroom · needs you<');
  assert.ok(main > -1 && cornerAt > main && homeAt > cornerAt, 'in the order the page hands them');
  assert.match(html, /<span class="fr-t">Main Chat<\/span><span class="fr-s">Ask anything, across every project<\/span>/);
  assert.match(html, /<span class="fr-lead fr-acc" aria-hidden="true"><svg[^>]*>.*?<\/svg><\/span><span class="fr-tx"><span class="fr-t">Which part should zoom in\?<\/span><span class="fr-s">Game Corner · #402<\/span><\/span><span class="fr-pill fr-act" data-kind="act">Needs Reply<\/span>/s,
    'a glyph for what it asks, the title, where it is, and the blue word');
  assert.match(html, /<span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Keep a vote in view<\/span>.*?<span class="fr-meta">Only you<\/span>/s,
    'a private thread asks nothing: grey words, no blue');
  assert.equal((html.match(/data-kind="act"/g) || []).length, 2);
  assert.doesNotMatch(html, /in progress</, 'work in progress is shown once a project is picked');
});

test('the row whose thread is open is lit, Main Chat\'s when it is the chat beside the list', () => {
  assert.match(render({ main: { lit: true, unread: 2, open() {} } }),
    /<button type="button" class="fr-row fr-on">.*?<span class="fr-t">Main Chat<\/span>.*?<span class="fr-pill fr-act" data-kind="act">2 new<\/span>/s);
  const lit = render({ lit: 'page:app/homeroom/dev/issues/5998' });
  assert.equal((lit.match(/class="fr-row fr-on"/g) || []).length <= 1, true, 'at most one row is lit');
});

test('a picked project narrows the list to it and adds its work in progress, with the five-stop line', () => {
  const html = render({ picked: ['homeroom'] });
  assert.match(html, /<button type="button" class="fr-tab fr-on" aria-pressed="true">Homeroom<\/button>/);
  assert.doesNotMatch(html, />Main Chat<|Game Corner · needs you/, 'the other project and Main Chat step aside');
  assert.match(html, />Homeroom · needs you</);
  const busy = html.slice(html.indexOf('>Homeroom · in progress<'));
  assert.match(busy, /<span class="fr-t">Fix the close button<\/span><span class="fr-s">Homeroom bot<\/span><\/span><span class="fr-track fr-mini" role="img" aria-label="Build"><span class="fr-st fr-done" aria-hidden="true">Plan<\/span><span class="fr-st fr-now" aria-hidden="true">Build<\/span><span class="fr-st" aria-hidden="true">Checks<\/span>/,
    'Plan done, Build under way, the rest to come');
  assert.doesNotMatch(busy, /Daily streaks/, 'another project\'s work is not listed');
});

test('search narrows by title, project or number; nothing left says so', () => {
  assert.match(render({ query: 'zoom' }), />Which part should zoom in\?</);
  assert.doesNotMatch(render({ query: 'zoom' }), />Pick a direction<|>Main Chat</);
  assert.match(render({ query: 'no such thing' }), /<div class="fr-card fr-pad">Nothing needs you here\. Ask Homeroom bot anything in Main Chat\.<\/div>/);
});

test('the page draws this list in place of its own under a look, from the same rows and presses', () => {
  const src = read('frontend', 'src', 'features', 'ai', 'index.tsx');
  assert.match(src, /const frame = isFrameSkin\(useSkin\(\)\);/, 'after mount only: useSkin answers standard on the first render');
  assert.match(src, /\{frame \? \(\s*<AiFrameList\s+heroLine=\{heroLine\}\s+main=\{\{ lit: lit === 'main', unread, open: openMain \}\}/);
  assert.match(src, /openRow=\{openRow\}\s+openThread=\{openThread\}\s+picked=\{picked\}\s+onPick=\{pick\}/);
  assert.match(src, /data-frame-list=\{frame \? '' : undefined\}/);
  assert.match(src, /<div className=\{kit\('dhead'\)\}>/, 'the open item\'s head is the kit\'s');
  assert.match(src, /useFramePage\(frame && phone && visible && level === 1 && !threadUp \? \[mainTitle\] : null, listAgain\)/,
    'on a phone the frame\'s bar names the open chat and goes back to the list');
  const list = read('frontend', 'src', 'features', 'ai', 'frame-list.tsx');
  assert.doesNotMatch(list, /\bfetch\(|useEffect\(/, 'nothing is read or kept in the list itself');
});

test('the two panes sit as the tour draws them: the list 520px, the open item the rest', () => {
  const css = read('public', 'css', 'app.css');
  assert.match(css, /html\[data-skin\] #ai-screen\[data-frame-list\] \{ --ai-main-w: max\(360px, calc\(var\(--platform-usable-w\) - 520px\)\); \}/);
  assert.match(css, /html\[data-skin\] #ai-screen\[data-frame-list\]:not\(\[data-ai-open\]\) > \.fr-pane > \.fr-scroll \{ max-width: 720px; \}/, 'with nothing open beside it the list is a page of one column, not the whole width');
  assert.match(css, /html\[data-skin\] #ai-screen\[data-frame-list\] \.ai-main-pane \{ top: var\(--fr-shell-top\); background: none;[^}]*border-inline-start: 1px solid var\(--fr-line\);/);
  assert.match(css, /html\[data-skin\] #ai-screen\[data-frame-list\] #ai-main-divider \{ display: none; \}/, 'the width is the frame\'s, so the handle steps aside');
  // A request opened from a row stands in the column through the shell's
  // side panel (the tour's s11), which is in <body>: it takes the column's
  // width and line there, so it ends where the list ends.
  assert.match(css, /html\[data-skin\] body:has\(#ai-screen\[data-frame-list\]:not\(\.hidden\)\) \{ --ai-main-w: max\(360px, calc\(var\(--platform-usable-w\) - 520px\)\); \}/);
  assert.match(css, /html\[data-skin\] body:has\(#ai-screen\[data-frame-list\]:not\(\.hidden\)\) \.side-panel \{ top: var\(--fr-shell-top\); border-radius: 0; background: none; box-shadow: none; border-inline-start: 1px solid var\(--fr-line\); \}/);
  assert.match(css, /html\[data-skin\] #ai-screen\[data-frame-list\] \.ai-askbar,\s*html\[data-skin\] #ai-screen\[data-frame-list\] \.ai-askbar-gap \{ display: none; \}/);
});

test('the list\'s words are catalog text', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'messages.json'));
  for (const k of ['frame.bot.new', 'frame.bot.all', 'frame.bot.search', 'frame.bot.mainLine', 'frame.bot.groupNeeds', 'frame.bot.needs', 'frame.bot.groupProgress', 'frame.bot.progress', 'frame.bot.onlyYou', 'frame.bot.quiet', 'frame.bot.newCount']) {
    assert.ok(en[k] && typeof en[k].text === 'string' && en[k].description, k);
  }
});

test('the list\'s New thread starts the blank thread, as the standard "+" does', () => {
  // The kit's button is not the standard NewThreadButton, so it must do
  // both halves itself: bring the column into view, then start the thread.
  const src = read('frontend', 'src', 'features', 'ai', 'index.tsx');
  assert.match(src, /onNew=\{\(\) => \{ openBlank\(\); if \(botId\) startNewThread\(botId\); \}\}/);
  assert.match(read('frontend', 'src', 'features', 'messages', 'new-thread.tsx'), /onClick=\{\(\) => \{ onOpen\?\.\(\); startNewThread\(conversationId\); \}\}/, 'the same two halves, in the same order');
});

test('History: what finished, by month, as the You tab\'s three lists (your changes, requests, votes)', () => {
  // The tour's s46 to s48 are the bot tab's history, filtered by kind. The
  // kinds are small buttons on the group's label; each month is a group of
  // rows ending in what became of the item.
  const history = {
    ready: true, loading: false, failed: false, next: 'c1', more() {}, retry() {},
    rows: [
      { key: 'h1', number: 6369, title: 'Email templates, part 7', app: homeroom, href: '#app/homeroom/dev/changes/6369', at: '2026-11-08T10:00:00Z', kind: 'change', outcome: 'live', by: 'you' },
      { key: 'h2', number: 6204, title: 'Mobile app safe area', app: homeroom, href: '#app/homeroom/dev/issues/6204', at: '2026-10-21T10:00:00Z', kind: 'request', outcome: 'closed' },
      { key: 'h3', number: 6198, title: 'The bot tab as the one place', app: homeroom, href: '#app/homeroom/dev/changes/6198', at: '2026-10-20T10:00:00Z', kind: 'vote', outcome: 'live', myVote: 'yes' },
    ],
  };
  const html = render({ history, historyKind: 'change', onHistoryKind() {}, openHistory() {} });
  const block = html.slice(html.indexOf('data-ai-frame-history'));
  assert.match(block, /<h2 class="fr-cap">History<\/h2><span class="fr-btnrow" role="group" aria-label="[^"]+"><button type="button" class="fr-btn fr-quiet fr-sm" aria-pressed="false">All<\/button><button type="button" class="fr-btn fr-sm" aria-pressed="true">Changes<\/button><button type="button" class="fr-btn fr-quiet fr-sm" aria-pressed="false">Requests<\/button><button type="button" class="fr-btn fr-quiet fr-sm" aria-pressed="false">Votes<\/button><button type="button" class="fr-btn fr-quiet fr-sm" aria-pressed="false">Only you<\/button><\/span>/);
  assert.deepEqual([...block.matchAll(/<h2 class="fr-cap">([^<]+)<\/h2>/g)].map((m) => m[1]).slice(1), ['November', 'October'], 'a group per month');
  assert.deepEqual([...block.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]), ['Email templates, part 7', 'Mobile app safe area', 'The bot tab as the one place']);
  assert.match(block, /<span class="fr-lead fr-ok"[^>]*>.*?<\/span><span class="fr-tx"><span class="fr-t">Email templates, part 7<\/span><span class="fr-s">Homeroom · #6369<\/span><\/span><span class="fr-meta">Live [^<]+<\/span>/s, 'a live change in green, where it is, and when it went live');
  assert.match(block, /<button type="button" class="fr-link">Earlier months<\/button>/);
  assert.match(render({ history: { ...history, rows: [], next: null } }), /<div class="fr-card fr-pad">Nothing finished yet\.<\/div>/);
  assert.match(render({ history: { ...history, ready: false } }), /<div class="fr-card fr-pad">Loading your history<\/div>/);
  assert.doesNotMatch(render({ history, query: 'zzz' }), /data-ai-frame-history/, 'a search with nothing finished in it folds the group away');
  const page = read('frontend', 'src', 'features', 'ai', 'index.tsx');
  assert.match(page, /history=\{history\}\s+historyKind=\{historyKind\}\s+onHistoryKind=\{pickKind\}\s+openHistory=\{openHistory\}\s+historyRef=\{historyRef\}\s+\/>/, 'the same history, kind and presses as the standard list');
});
