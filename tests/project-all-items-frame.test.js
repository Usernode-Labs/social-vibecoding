// All items in the one frame (frontend/src/features/dev-board/workshop/frame/
// project-frame.tsx ProjectAllItemsFrame), as the 2026-11-06 screen tour
// draws it (s29): the Workshop's own page of every open request and change,
// the stages as the page's tabs, one row per item with the five-stop line
// and the word that says where it stands, Show beside them. The board's own
// columns (../card/cards-store.ts devKanbanStore) are its data; the Workshop
// page hands them in.
//
// Run with: node --test tests/project-all-items-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const FRAME = 'frontend/src/features/dev-board/workshop/frame/project-frame.tsx';

const item = (key, title, over = {}) => ({ key, title, line: `#${key.split(':')[1]} · Onboarding`, href: `#app/homeroom/dev/${key.replace(':', 's/')}`, mine: false, pill: null, ...over });
const cols = [
  { key: 'issues', title: 'Requests', items: [item('issue:6204', 'Mobile app does not respect the safe area', { word: 'Nobody on it' }), item('issue:6102', 'Add a way to mute one topic', { word: 'Planning', mine: true })] },
  { key: 'inprogress', title: 'Under way', items: [item('proposal:6317', 'Open the before and after viewer', { word: 'Building' })] },
  { key: 'inreview', title: 'In review', items: [item('proposal:6370', 'Email templates: keep translations', { pill: { kind: 'act', label: 'Vote' } }), item('proposal:6198', 'Make the bot tab the one place', { pill: { kind: 'wait', label: 'On votes' }, mine: true })] },
  { key: 'done', title: 'Done', items: [item('proposal:6369', 'Email templates, part 7', { word: 'Live' })] },
];
const base = {
  tabs: [{ key: 'status', label: 'Hub' }, { key: 'workshop', label: 'Workshop' }], tab: 'workshop', onTab() {}, onAsk() {},
  project: 'Homeroom', cols, loading: false, stage: '', onStage() {}, mine: false, onMine() {}, query: '', onQuery() {}, openKey: null, onOpen() {},
};
const render = (over) => renderComponent(FRAME, 'ProjectAllItemsFrame', { ...base, ...over }, { cache: false });
const titles = (html) => [...html.slice(0, html.indexOf('<h2 class="fr-cap">Show')).matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]);

test('the page: its title, how many are open and where, the stages as tabs', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-project-frame="all-kit"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">All items<\/h1><p class="fr-purpose">5 open requests and changes in Homeroom, newest first\.<\/p>/);
  assert.deepEqual([...html.matchAll(/<button type="button" class="fr-tab(?: fr-on)?" aria-pressed="(true|false)">([^<]*?)(?:<span class="fr-n">(\d+)<\/span>)?<\/button>/g)].map((m) => [m[2], m[1], m[3]]),
    [['All', 'true', undefined], ['Requests', 'false', '2'], ['Under way', 'false', '1'], ['In review', 'false', '2'], ['Done', 'false', '1']]);
  assert.match(html, /<input type="search" class="fr-v" placeholder="Search requests, changes or a number"/);
});

test('one row per item: its title and number, the five-stop line, the word or pill that says where it stands', () => {
  const html = render();
  assert.deepEqual(titles(html), ['Mobile app does not respect the safe area', 'Add a way to mute one topic', 'Open the before and after viewer', 'Email templates: keep translations', 'Make the bot tab the one place'], 'what is open; what went live is the Done tab\'s');
  assert.deepEqual(titles(render({ stage: 'done' })), ['Email templates, part 7']);
  assert.match(html, /<a class="fr-row" href="#app\/homeroom\/dev\/issues\/6204"[^>]*><span class="fr-tx"><span class="fr-t">Mobile app does not respect the safe area<\/span><span class="fr-s">#6204 · Onboarding<\/span><\/span><span class="fr-track fr-mini"[^>]*>.*?<\/span><span class="fr-meta">Nobody on it<\/span><svg[^>]*class="[^"]*go/s);
  assert.match(html, /Email templates: keep translations<\/span>.*?<span class="fr-pill fr-act" data-kind="act">Vote<\/span>/s);
  assert.match(html, /Make the bot tab the one place<\/span>.*?<span class="fr-pill fr-wait" data-kind="wait">On votes<\/span>/s);
  assert.match(html, /<h2 class="fr-cap">5 open<\/h2>/, 'the group counts what the page shows');
  assert.match(render({ openKey: 'proposal:6317' }), /<a class="fr-row fr-on" href="#app\/homeroom\/dev\/proposals\/6317" aria-current="page">/, 'the item open beside the list is lit');
});

test('a stage shows its own items; Show narrows to yours; the search box to what it says', () => {
  assert.deepEqual(titles(render({ stage: 'inreview' })), ['Email templates: keep translations', 'Make the bot tab the one place']);
  assert.deepEqual(titles(render({ mine: true })), ['Add a way to mute one topic', 'Make the bot tab the one place']);
  assert.deepEqual(titles(render({ query: '6317' })), ['Open the before and after viewer']);
  assert.deepEqual(titles(render({ query: 'email' })), ['Email templates: keep translations']);
  assert.match(render({ query: 'zzz' }), /<div class="fr-card fr-pad">Nothing matches that\.<\/div>/);
  assert.match(render({ cols: [], loading: true }), /<div class="fr-card fr-pad">Loading…<\/div>/);
  const side = render({ mine: true });
  assert.match(side, /<h2 class="fr-cap">Show<\/h2><\/div><div class="fr-card"><button type="button" class="fr-row fr-sm" aria-pressed="false"><span class="fr-lead"[^>]*>.*?<\/span><span class="fr-tx"><span class="fr-t">Everyone&#x27;s<\/span><\/span><\/button><button type="button" class="fr-row fr-sm fr-on" aria-pressed="true">.*?Only yours<\/span>/s);
});

test('every class is the kit\'s', () => {
  const classes = [...render().matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('the Workshop page draws it for All items under a look, from the board\'s own columns, and puts its board away', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /const kanban = useStoreState\(devKanbanStore\);/, 'the same view model the board renders');
  assert.match(src, /const frameAllUp = frame && !frameTopics && tab === 'all';/);
  assert.match(src, /\{frameAllUp \? frameAll\(\) : null\}/);
  assert.match(src, /\{frame && !frameTopics && tab !== 'status' && !frameWorkshopUp && !frameAllUp \? <ProjectFrameHead/, 'one kit head at a time');
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\] \.dev-ws > :is\(\[data-project-frame="topics"\], \[data-project-frame="workshop-kit"\], \[data-project-frame="all-kit"\]\) ~ \.dev-ws-tabbody \{ display: none; \}/);
});

test('a request nobody has taken ends in "Nobody on it", from the brief the board writes', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /word: pill && !asks \? pill\.label : \(b\?\.kind === 'request' && b\.unclaimed \? t\('project:frame\.allItems\.nobody'\) : null\),/);
  assert.match(read('public/js/app-view.js'), /unclaimed: AppView\._issueUnclaimed\(it\),/);
  assert.match(read('frontend/src/features/dev-board/card/model.ts'), /unclaimed\?: boolean;/);
});

test('the board\'s topics are rows of the context column, each with its people and its open items, to its channel (the standard By category view)', () => {
  const html = render({ topics: [
    { key: 'onboarding', name: 'Onboarding', icon: '🚪', people: 7, items: 7, href: '#app/homeroom/dev/c/onboarding' },
    { key: 'infra', name: 'Infra', icon: '', people: 1, items: 10, href: '#app/homeroom/dev/c/infra' },
  ] });
  assert.match(html, /<h2 class="fr-cap">Topics<\/h2><\/div><div class="fr-card"><a class="fr-row" href="#app\/homeroom\/dev\/c\/onboarding"><span class="fr-lead">🚪<\/span><span class="fr-tx"><span class="fr-t">Onboarding<\/span><span class="fr-s">7 people · 7 items<\/span><\/span><svg class="fr-ic fr-go"/);
  assert.match(html, /<span class="fr-t">Infra<\/span><span class="fr-s">1 person · 10 items<\/span>/);
  assert.ok(html.indexOf('>Show<') < html.indexOf('>Topics<'), 'under Show');
  assert.doesNotMatch(render(), /fr-cap">Topics/, 'none: no group');
  const page = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(page, /topics=\{v\.themes\.filter\(\(th\) => !th\.ungrouped && th\.topic\)\.map\(\(th\) => \(\{ key: th\.id, name: th\.name, icon: th\.icon, people: th\.people\.length, items: th\.counts\.open \+ th\.counts\.underway \+ th\.counts\.review, href: placeHref\(slug, channelPlace\(th\.topic!\.handle\)\) \}\)\)\}/);
});
