// All items in the one frame (frontend/src/features/dev-board/workshop/frame/
// project-frame.tsx ProjectAllItemsFrame), version 2 of the screen tour's s29
// and s30: the kit's head, tabs and side column around today's page. The
// tabs are its two groupings with the board's own search at their end; Show
// (Filters, the active chips, the two quick filters) and Order categories
// stand beside the list. The list is the product's own (a card per
// category opening to its lanes, or the board by stage), laid in the kit's
// content column and wearing the look. What the first tour drew is gone:
// the stages as tabs, the flat list with the five-stop line, Everyone's or
// Only yours, the topics beside it, the head's buttons.
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
  project: 'Homeroom', group: 'category', onGroup() {}, query: '', querySeq: 0, onQuery() {},
  filters: { count: 0, chips: [], quick: { assignedToMe: false, yours: false }, onOpen() {}, onDismiss() {}, onQuick() {} },
  sort: { key: 'people', options: [{ key: 'people', label: 'By people' }, { key: 'activity', label: 'By activity' }, { key: 'open', label: 'By open items' }], onSort() {} },
};
const render = (over) => renderComponent(FRAME, 'ProjectAllItemsFrame', { ...base, ...over }, { cache: false });

test('the page: its title and sentence, no buttons, the two groupings as tabs with the board\'s search at their end', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-project-frame="all-items" data-all-group="category"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">All items<\/h1><p class="fr-purpose">Every request and change in Homeroom, grouped by category or by stage\.<\/p><\/div><\/div><nav class="fr-tabs" aria-label="[^"]+"><button type="button" class="fr-tab fr-on" aria-pressed="true">By category<\/button><button type="button" class="fr-tab" aria-pressed="false">By stage<\/button><div class="fr-end"><div class="fr-search fr-flush"><label class="fr-inp"><svg[^>]*>.*?<\/svg><input type="search" class="fr-v" placeholder="Search requests, changes, comments or #" aria-label="[^"]+" value=""\/><\/label><\/div><\/div><\/nav>/s);
  assert.match(html, /<\/nav><div class="fr-search fr-p"><label class="fr-inp">/, 'a phone has no room at the tabs\' end: the field under them');
  assert.doesNotMatch(html, /fr-acts|Ask for a change|Requests<|In review|fr-track/, 'no buttons, no stage tabs, no five-stop line');
  assert.match(render({ group: 'stage' }), /data-all-group="stage".*?<button type="button" class="fr-tab fr-on" aria-pressed="true">By stage</s);
  assert.match(render({ query: 'invite' }), /<label class="fr-inp fr-val">.*?value="invite"/s, 'the board\'s own text');
});

test('Show: Filters with how many are set and each active one with its ×, then the two quick filters as choices', () => {
  const html = render();
  const show = html.slice(html.indexOf('>Show<'), html.indexOf('>Order categories<'));
  assert.match(show, /<button type="button" class="fr-row fr-sm"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Filters<\/span><\/span><svg[^>]*fr-go/s);
  assert.match(show, /<button type="button" class="fr-row fr-sm" aria-pressed="false"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Assigned to you<\/span>/s);
  assert.match(show, /aria-pressed="false">.*?<span class="fr-t">Yours<\/span>/s, 'the product\'s own word for the second');
  const set = render({ filters: { ...base.filters, count: 2, chips: [{ key: 'q', label: 'Search: invite' }, { key: 'label', label: 'bug' }], quick: { assignedToMe: true, yours: false } } });
  assert.match(set, /<button type="button" class="fr-row fr-sm" aria-label="Filters \(2\)"><span class="fr-lead fr-acc" aria-hidden="true">.*?<span class="fr-t">Filters<\/span><\/span><span class="fr-pill fr-act" data-kind="act">2<\/span>/s);
  assert.match(set, /<div class="fr-btnrow fr-chips fr-inrow"><button type="button" class="fr-btn fr-quiet fr-sm fr-chip" aria-label="Remove filter: Search: invite">Search: invite<span aria-hidden="true">×<\/span><\/button><button[^>]*aria-label="Remove filter: bug">/, 'a narrowed page says what narrows it');
  assert.match(set, /<button type="button" class="fr-row fr-sm fr-on" aria-pressed="true">.*?<span class="fr-t">Assigned to you<\/span>/s);
  assert.doesNotMatch(render({ filters: { ...base.filters, quick: null } }), /Assigned to you|Yours/, 'signed out there is no "you"');
  assert.doesNotMatch(html, /Everyone|Only yours/);
});

test('Order categories: the product\'s three orders, the current one lit; by stage nothing stands beside the board', () => {
  const html = render({ sort: { ...base.sort, key: 'activity' } });
  const order = html.slice(html.indexOf('>Order categories<'));
  assert.deepEqual([...order.matchAll(/<button type="button" class="fr-row fr-sm( fr-on)?" aria-pressed="(true|false)">.*?<span class="fr-t">([^<]+)<\/span>/gs)].map((m) => [m[3], m[2]]),
    [['By people', 'false'], ['By activity', 'true'], ['By open items', 'false']]);
  assert.match(html, /<div class="fr-cols fr-beside"><div class="fr-stack fr-first"><section class="fr-sec">/, 'the kit draws the side column alone: the list under it is the page\'s own');
  assert.doesNotMatch(render({ sort: null }), /Order categories/);
  const stage = render({ group: 'stage' });
  assert.doesNotMatch(stage, /fr-cols|>Show<|Order categories/);
  assert.doesNotMatch(render(), /fr-hcard|Discuss in/, 'no second drawing of the categories');
});

test('every class is the kit\'s', () => {
  const classes = [...render({ filters: { ...base.filters, count: 1, chips: [{ key: 'q', label: 'x' }] } }).matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('the Workshop page draws it for All items under a look, driving the board\'s own grouping, search, filters and order', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /const frameAllUp = frame && !frameTopics && tab === 'all';/);
  const all = src.slice(src.indexOf('const frameAll = (): ReactNode => ('), src.indexOf('const frameWorkshop = (): ReactNode => {'));
  assert.match(all, /group=\{group === 'stage' \? 'stage' : 'category'\}\s+onGroup=\{\(key\) => \{ callAppView\('_setWorkshopGroup', key\); \}\}/, 'the published grouping, and the page\'s own switch');
  assert.match(all, /querySelector<HTMLInputElement>\('#dev-kanban-search'\) : null;\s+if \(!box\) return;\s+box\.value = next;\s+callAppView\('_onKanbanSearchInput'\);/, 'the board reads its own search box, which stays mounted: comments and # included');
  assert.match(all, /onOpen: \(\) => \{ callAppView\('_openKanbanFiltersDialog'\); \},\s+onDismiss: \(key\) => \{ callAppView\('_dismissKanbanFilter', key\); \},\s+onQuick: \(key\) => \{ callAppView\('_toggleKanbanQuickFilter', key\); \},/);
  assert.match(all, /onSort: \(key\) => \{ if \(key !== sortKey\) captureThemeTops\(\); setSortKey\(key as SortKey\); \},/, 'the cards keep their place across a re-sort, as the page\'s chips do it');
  assert.match(src, /const frameFilters = useStoreState<KanbanFiltersState>\(kanbanFiltersStore\);/);
  assert.ok(src.indexOf('const frameFilters = useStoreState<KanbanFiltersState>(kanbanFiltersStore);') < src.indexOf('const [bar, setBar] = useState<HTMLElement | null>(null);'), 'a hook, with the page\'s others at its top');
  assert.doesNotMatch(src, /frameStage|frameMine|frameQuery|frameKanban|AllItemRow/, 'the flat list\'s own state is gone');
  const catalog = JSON.parse(read('frontend/locales/en/project.json'));
  for (const id of ['frame.allItems.all', 'frame.allItems.search', 'frame.allItems.open_one', 'frame.allItems.everyone', 'frame.allItems.mine', 'frame.allItems.none', 'frame.allItems.loading', 'frame.allItems.nobody', 'frame.allItems.topicLine', 'frame.allItems.people_one', 'frame.allItems.items_one', 'frame.allItems.purpose_one']) {
    assert.equal(catalog[id], undefined, `${id} went with what it worded`);
  }
});

test('the list is the page\'s own, in the kit\'s content column and wearing the look', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  const A = 'html[data-skin] .dev-ws > [data-project-frame="all-items"]';
  assert.doesNotMatch(hand, /all-kit/);
  assert.match(hand, /html\[data-skin\] \.dev-ws > :is\(\[data-project-frame="topics"\], \[data-project-frame="workshop-kit"\]\) ~ \.dev-ws-tabbody \{ display: none; \}/, 'All items\' body is on show');
  assert.ok(hand.includes(`${A}[data-all-group="category"] ~ .dev-ws-tabbody .dev-ws-allbar,\n${A} ~ .dev-ws-tabbody .dev-ws-sort-opts { display: none; }`), 'the page\'s bar and order chips are put away, mounted: the kit draws them');
  assert.ok(hand.includes(`${A}[data-all-group="stage"] ~ .dev-ws-tabbody .dev-ws-allbar > :is(.dev-ws-pagehead, .dev-ws-group),\n${A}[data-all-group="stage"] ~ .dev-ws-tabbody #dev-kanban-search { display: none; }`), 'by stage the bar keeps its filter chips over the board');
  assert.ok(hand.includes(`${A}[data-all-group="stage"] ~ .dev-ws-tabbody > * { max-width: none; }`), 'the board has the page\'s width');
  assert.ok(hand.includes('html[data-skin] #dev-workshop.dev-ws-has-board > .dev-ws > [data-project-frame] { max-width: none; margin-inline: 0; }'));
  assert.ok(hand.includes(`${A} ~ .dev-ws-tabbody :is(.dev-ws-pane-head, .dev-ws-pane-body) { padding: 0; border-radius: 0; background: none;`), 'the pane gives up its sheet');
  // The kit's side column hangs from its page over the room the 720px column leaves.
  const kit = read('frontend/looks/kit.css');
  assert.match(kit, /\.cols\.beside\{height:0\}\n\.cols\.beside>\.stack\{grid-column:2\}\n\.phone \.cols\.beside\{height:auto;margin-bottom:8px\}\n\.phone \.cols\.beside>\.stack\{grid-column:1\}/);
  assert.match(hand, /html\[data-skin\] \.dev-ws > \[data-project-frame="all-items"\]\[data-all-group="category"\] ~ \.dev-ws-tabbody \{ min-height: 440px; \}/);
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
