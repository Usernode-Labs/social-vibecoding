// All items in the one frame (frontend/src/features/dev-board/workshop/frame/
// project-frame.tsx ProjectAllItemsFrame), version 2 of the screen tour's s29
// and s30: the kit's head around today's page, with the board's own search
// under it. The page has one view, the board by stage (request 6708), so the
// kit draws no grouping tabs and nothing beside the list: the board is the
// product's own, across the page, wearing the look, with its own filter
// chips over it. What the first tour drew is gone too: the stages as tabs,
// the flat list with the five-stop line, Everyone's or Only yours, the
// topics beside it, the head's buttons.
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

const base = {
  tabs: [{ key: 'status', label: 'Hub' }, { key: 'workshop', label: 'Workshop' }], tab: 'workshop', onTab() {}, onInvite() {},
  project: 'Homeroom', query: '', querySeq: 0, onQuery() {},
};
const render = (over) => renderComponent(FRAME, 'ProjectAllItemsFrame', { ...base, ...over }, { cache: false });

test('the page: its title and sentence, then the board\'s search; no buttons, no grouping tabs, nothing beside the board (request 6708)', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-project-frame="all-items" data-all-group="stage"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">All items<\/h1><p class="fr-purpose">Every request and change in Homeroom, by stage\.<\/p><\/div><\/div><div class="fr-search"><label class="fr-inp"><svg[^>]*>.*?<\/svg><input type="search" class="fr-v" placeholder="Search requests, changes, comments or #" aria-label="[^"]+" value=""\/><\/label><\/div><\/div><\/div>$/s);
  assert.doesNotMatch(html, /fr-acts|Ask for a change|Requests<|In review|fr-track/, 'no buttons, no stage tabs, no five-stop line');
  assert.doesNotMatch(html, /fr-tabs|fr-tab\b|By category|By stage/, 'no grouping tabs: the page has one view');
  assert.doesNotMatch(html, /fr-cols|>Show<|Order categories|fr-hcard|Discuss in/, 'no side column, and no second drawing of the categories');
  assert.match(render({ query: 'invite' }), /<label class="fr-inp fr-val">.*?value="invite"/s, 'the board\'s own text');
  // A caller still passing the old props changes nothing.
  assert.equal(render({ group: 'category', onGroup() {}, sort: { key: 'people', options: [{ key: 'people', label: 'By people' }], onSort() {} } }), html);
});

test('every class is the kit\'s', () => {
  const classes = [...render({ query: 'x' }).matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('the Workshop page draws it for All items under a look, driving the board\'s own search', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /const frameAllUp = frame && !frameTopics && tab === 'all';/);
  const all = src.slice(src.indexOf('const frameAll = (): ReactNode => ('), src.indexOf('const frameWorkshop = (): ReactNode => {'));
  assert.doesNotMatch(all, /group=|onGroup|sort=|filters=|_setWorkshopGroup/, 'no grouping, no switch, no side column to feed (request 6708)');
  assert.match(all, /querySelector<HTMLInputElement>\('#dev-kanban-search'\) : null;\s+if \(!box\) return;\s+box\.value = next;\s+callAppView\('_onKanbanSearchInput'\);/, 'the board reads its own search box, which stays mounted: comments and # included');
  assert.match(src, /const frameFilters = useStoreState<KanbanFiltersState>\(kanbanFiltersStore\);/);
  assert.ok(src.indexOf('const frameFilters = useStoreState<KanbanFiltersState>(kanbanFiltersStore);') < src.indexOf('const [bar, setBar] = useState<HTMLElement | null>(null);'), 'a hook, with the page\'s others at its top');
  assert.doesNotMatch(src, /frameStage|frameMine|frameQuery|frameKanban|AllItemRow/, 'the flat list\'s own state is gone');
  const catalog = JSON.parse(read('frontend/locales/en/project.json'));
  for (const id of ['allItems.group.label', 'allItems.group.category', 'allItems.group.stage', 'frame.allItems.show', 'frame.allItems.all', 'frame.allItems.search', 'frame.allItems.open_one', 'frame.allItems.everyone', 'frame.allItems.mine', 'frame.allItems.none', 'frame.allItems.loading', 'frame.allItems.nobody', 'frame.allItems.topicLine', 'frame.allItems.people_one', 'frame.allItems.items_one', 'frame.allItems.purpose_one']) {
    assert.equal(catalog[id], undefined, `${id} went with what it worded`);
  }
});

test('the list is the page\'s own, in the kit\'s content column and wearing the look', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  const A = 'html[data-skin] .dev-ws > [data-project-frame="all-items"]';
  assert.doesNotMatch(hand, /all-kit/);
  assert.match(hand, /html\[data-skin\] \.dev-ws > :is\(\[data-project-frame="topics"\], \[data-project-frame="workshop-kit"\]\) ~ \.dev-ws-tabbody \{ display: none; \}/, 'All items\' body is on show');
  assert.ok(hand.includes(`${A}[data-all-group="stage"] ~ .dev-ws-tabbody .dev-ws-allbar > .dev-ws-pagehead,\n${A}[data-all-group="stage"] ~ .dev-ws-tabbody #dev-kanban-search { display: none; }`), 'the bar keeps its filter chips over the board, and gives up what the kit\'s head draws');
  assert.doesNotMatch(hand, /\[data-all-group="category"\]|\.dev-ws-group/, 'nothing is laid out for a category view or a switch (request 6708)');
  // …by a rule that outweighs the 720px column every place's body is held to (it cut the Done column off).
  const wide = 'html[data-skin] .dev-ws:not([data-ws-tab="needs"]) > [data-project-frame="all-items"][data-all-group="stage"] ~ .dev-ws-tabbody > * { max-width: none; }';
  const column = 'html[data-skin] .dev-ws:not([data-ws-tab="needs"]) > [data-project-frame] ~ .dev-ws-tabbody > * { max-width: 720px; margin-inline: 0; }';
  assert.ok(hand.includes(wide), 'the board has the page\'s width');
  assert.ok(hand.includes(column));
  assert.doesNotMatch(hand, /\[data-all-group="stage"\] ~ \.dev-ws-tabbody > \* \{ max-width: none; \}[\s\S]*html\[data-skin\] \.dev-ws > \[data-project-frame="all-items"\]\[data-all-group="stage"\] ~ \.dev-ws-tabbody > \*/);
  // A category's name on two lines keeps its second line under its first: the glyph hangs before it.
  assert.ok(hand.includes(`${A} ~ .dev-ws-tabbody .dev-ws-theme-name { position: relative; min-height: 32px; padding-block: 4px; padding-inline-start: 44px; }`));
  // The search has the room of its placeholder, under the head.
  assert.ok(hand.includes('html[data-skin] [data-project-frame="all-items"] .fr-inner > .fr-search .fr-inp { max-width: 360px; padding-inline: 12px; }'));
  assert.ok(hand.includes('html[data-skin] #dev-workshop.dev-ws-has-board > .dev-ws > [data-project-frame] { max-width: none; margin-inline: 0; }'));
  assert.ok(hand.includes(`${A} ~ .dev-ws-tabbody :is(.dev-ws-pane-head, .dev-ws-pane-body) { padding: 0; border-radius: 0; background: none;`), 'the pane gives up its sheet');
  // The kit's side column hangs from its page over the room the 720px column leaves.
  const kit = read('frontend/looks/kit.css');
  assert.match(kit, /\.cols\.beside\{height:0\}\n\.cols\.beside>\.stack\{grid-column:2\}\n\.phone \.cols\.beside\{height:auto;margin-bottom:8px\}\n\.phone \.cols\.beside>\.stack\{grid-column:1\}/);
  // A category's card is the kit's card, the two labels its caps (the wear map).
  const wear = JSON.parse(read('frontend/looks/looks.json')).wear.roots;
  assert.ok(wear.card.to.includes('.dev-ws > [data-project-frame="all-items"] ~ .dev-ws-tabbody .dev-ws-theme'));
  assert.ok([wear.cap.to, ...(wear.cap.also || []).map((w) => w.to)].includes(':is(.dev-ws > [data-project-frame="all-items"] ~ .dev-ws-tabbody [data-ws-themes-head],.dev-ws > [data-project-frame="all-items"] ~ .dev-ws-tabbody .dev-ws-sort > .dev-ws-eyebrow)'), 'the category headings wear the kit\'s label, as a wearer of their own');
  const looks = css.slice(css.indexOf('/* looks:begin'));
  assert.match(looks, /\.dev-ws-theme[^{]*\{background:var\(--fr-surface\);border-radius:20px;/);
  const page = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(page, /<ThemeCard\s+theme=\{theme\}/, 'the cards, their lanes and their order are the page\'s');
  assert.match(page, /<DevKanban openKey=\{sideKey\} onOpen=\{openItem\} \/>/);
});
