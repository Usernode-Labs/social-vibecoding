'use strict';

// The Communities screen's scope chip and its Needs you row (#2718, #3051).
//
// The screen answers "which of my apps wants something from me": a chip that
// says what you are looking at and narrows it, a row that totals the votes
// owed, and one row per app carrying both of its numbers.
//
// ── What this suite used to pin, and why it does not ──────────────────
//
// A TAB STRIP (Current status / Needs you / All items) and a PLUS. Both are
// retired from this screen on the owner's review, and the reason is worth
// keeping because it is the argument that would bring them back: those three
// words are the APP Workshop's, about one app's items. Up here the list is of
// APPS, each row already showing both figures, so the tabs hid whole apps to
// say what their rows were saying anyway — and the plus asked "which app?"
// before two questions ("propose a change", "report a problem") that can only
// be asked inside an app.
//
// AND THE SCOPE CHIP (#2759). It read "All apps" here and its panel listed
// your apps — but this screen IS that list, every row the way into its app's
// Workshop, so the chip was the page repeating itself.
//
// ── #3051 brought two of those back, on the owner's request ──────────
//
// The chip, reading "All apps", and two of the tabs: Current status and
// Needs you. The UI overhaul took the tabs away again: your in-flight items
// moved to Profile's Your changes, which left Current status holding only
// the list, so the list is the page and Needs you is ONE ROW at its top
// ("3 votes waiting on you") that opens the cross-community feed as a page
// with a way back. Nothing filters the list of apps, which is the argument
// above. All items and the plus stay retired: every item of every app is not
// a page, and the plus's two questions can still only be asked inside an app.
//
// Three things are still pinned, and each is a way the screens can be quietly
// wrong:
//
//   1. PICKING AN APP NAVIGATES, to that app's own Workshop.
//   2. THE NAVIGATION IS AWAITED, so a refused one cannot read as a
//      completed one.
//   3. THE NEEDS YOU ROW SAYS NOTHING OVER A ZERO, and totals every
//      project, not a filtered few.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const CHROME = read('frontend/src/features/workshop/workshop-chrome.tsx');
const SCREEN = read('frontend/src/features/workshop/index.tsx');

const screen = loadTsx('frontend/src/features/workshop/index.tsx');
const chrome = loadTsx('frontend/src/features/workshop/workshop-chrome.tsx');

const app = (slug, working, needs) => ({ slug, name: slug, working, needs });

test('picking an app navigates: the chip is the link out', () => {
  assert.match(CHROME, /await win\(\)\.App\?\.navigateToApp\?\.\(slug, 'dev'\);/,
    'picking an app goes to that app’s own Workshop');
  // NEVER DISABLED. Scoped to an app there is always somewhere to go (back
  // up to all of them), and at the all-apps end (#3051) there is always an
  // app to go into or, with none, the panel's own All apps row.
  assert.ok(!/disabled=\{/.test(CHROME), 'the chip is never a dead control');
});

test('the action waits for the navigation', () => {
  // It MATTERED more when the plus's two action rows landed here:
  // navigateToApp resolves once the app view has opened and the Improve
  // controller knows what it is about, and calling startSession() before that
  // started a change on whatever app the panel last pointed at. The scope
  // chip is the only caller left, so nothing runs after the await — the await
  // stays so a refused navigation cannot read as a completed one, and the
  // panel closes either way.
  const at = CHROME.indexOf('async function goToApp(');
  const fn = CHROME.slice(at, CHROME.indexOf('\n}\n', at));
  assert.match(fn, /await win\(\)\.App\?\.navigateToApp\?\.\(slug, 'dev'\);/);
  assert.match(fn, /\} catch \{/, 'and a refusal is caught rather than thrown at the screen');
  assert.ok(!fn.includes('startSession'), 'nothing is started from this screen any more');
  assert.ok(!fn.includes('giveFeedback'), 'nor reported from it');
});

test('All items, the plus and now the tabs are gone; Needs you is a row (#3051)', () => {
  for (const id of ['workshop-tabs', 'workshop-tab-all', 'workshop-tab-empty', 'workshop-plus',
    'workshop-plus-change', 'workshop-plus-issue', 'workshop-plus-create', 'workshop-picker',
    'workshop-tab-status', 'workshop-tab-needs', 'workshop-total-working', 'workshop-total-needs']) {
    assert.ok(!CHROME.includes(`id="${id}"`), `#${id} is not rendered`);
    assert.ok(!SCREEN.includes(`id="${id}"`), `#${id} is not on the screen either`);
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} is not in the shipped shell`);
  }
  // NOTHING FILTERS THE LIST OF APPS, which is the argument that retired the
  // old strip: the Needs you feed is a page of its own over the list, and
  // nothing narrows `rows` by it.
  assert.ok(!SCREEN.includes('filterRows'), 'the screen does not filter the app list');
  const store = read('frontend/src/features/workshop/workshop-store.js');
  assert.match(store, /^\s*tab: 'status',/m, 'the list is the default, and the prerender');
  assert.match(store, /^\s*scopeOpen: false,/m, 'the chip\'s panel ships closed');
  assert.doesNotMatch(store, /itemsError|^\s*items:/m, 'the items read left with the pane it filled');
  // ONE PANEL COMPONENT for both ends of the chip.
  assert.match(CHROME, /export const ALL_APPS_SCOPE_ID = 'workshop-scope';/);
  assert.match(CHROME, /<WorkshopPicker\n\s+id=\{panelId\}\n\s+apps=\{apps\}\n\s+scope=\{null\}/);
});

test('the Needs you row opens the feed over the list without redrawing it, and closes the chip\'s panel', () => {
  const html = () => renderToHtml(createElement(screen.WorkshopScreen, {}));
  screen.workshopStore.set({
    open: true, error: false, tab: 'status', scopeOpen: true,
    rows: [app('staging-demo-your-app', 2, 3)],
  });
  let out = html();
  assert.match(out, /data-workshop-pane="status" class=""/);
  assert.match(out, /data-workshop-needs-open=""/);
  assert.doesNotMatch(out, /data-workshop-pane="needs"/, 'the feed renders only while showing');
  assert.match(out, /id="workshop-scope-picker"/, 'the panel renders once open');
  screen.workshopController.setTab('needs');
  assert.equal(screen.workshopStore.get().scopeOpen, false, 'opening the feed closes the panel');
  out = html();
  assert.match(out, /data-workshop-pane="status" class="hidden"/);
  assert.match(out, /data-workshop-pane="needs"/);
  assert.match(out, /data-workshop-needs-back=""[^>]*aria-label="Back to Communities"/);
  assert.match(out, /data-workshop-app="staging-demo-your-app"/,
    'the list is still in the document, hidden, not unmounted');
  screen.workshopController.setTab('nonsense');
  assert.equal(screen.workshopStore.get().tab, 'status', 'anything else is the list');
  screen.workshopStore.set({ tab: 'status', scopeOpen: false, rows: null });
});

test('the Needs you row totals every project, and says nothing over a zero', () => {
  // The legend that totalled both figures is gone (your own work is
  // Profile's now); the votes total is the row's title, and it is drawn
  // only when a vote waits.
  const at = SCREEN.indexOf('const totals = all');
  const decl = SCREEN.slice(at, SCREEN.indexOf('const empty', at));
  assert.match(decl, /all\.length > 0/,
    'no totals with no apps: the empty card already says why the screen is bare');
  assert.match(decl, /acc\.needs \+ \(row\.needs \|\| 0\)/);
  assert.ok(!decl.includes('rows'), 'it sums `all`, every project');
  assert.match(SCREEN, /\{totals && totals\.needs > 0 \? \(\n\s*<section data-workshop-needs-door=""/);
  const dapp = JSON.parse(read('dapp.json'));
  assert.ok(!dapp.tests.some((t) => t.expectText === 'Votes waiting on you'),
    'no declared check waits for the retired legend');
  assert.ok(!HTML.includes('data-workshop-needs-door'),
    'a row read from data is not in a cold document');
});

test('#3051: the all-apps screen wears the All apps chip again (reverses #2759)', () => {
  // #2759 took it off while the screen was only the list of your apps. The
  // owner asked for it back as "All apps", heading the two tabs it scopes.
  assert.match(SCREEN, /<AllAppsScope\n/);
  assert.match(HTML, /<button id="workshop-scope" type="button"[^>]*aria-haspopup="menu" aria-expanded="false" aria-controls="workshop-scope-picker"/,
    'it ships closed in the cold document, naming its panel');
  assert.ok(!HTML.includes('id="workshop-scope-picker"'), 'and the panel is behind a press');
  const html = renderToHtml(createElement(chrome.WorkshopScope, {
    id: 'workshop-scope', open: false, scope: null, onToggle: () => {},
  }));
  assert.match(html, />All</, 'the word All (#3277)');
  assert.match(html, /aria-label="All your projects, or open one"/, 'and what All means, to a screen reader');
  // Its panel ticks All apps, and pressing that row only closes the panel:
  // navigating to the screen you are on would throw its scroll away.
  const panel = renderToHtml(createElement(chrome.WorkshopPicker, {
    id: 'workshop-scope-picker', scope: null, onClose: () => {},
    apps: [{ slug: 'notes-ab12', name: 'Notes' }],
  }));
  assert.match(panel, /id="workshop-scope-picker-all"[\s\S]*?<\/svg><\/span><span[^>]*><span[^>]*>All<\/span><\/span><svg/,
    'All carries the tick');
  assert.match(CHROME, /onClose\(\);\n\s*if \(scope === null\) return;\n\s*goToAllApps\(\);/);
  // The chip's row leads the screen, so it carries the header's notch
  // clearance; the legend line that sat under it is gone.
  assert.match(SCREEN, /<div className="px-4 pt-5 pb-2 flex flex-wrap items-center gap-x-3 gap-y-2">\n\s*<AllAppsScope/);
  assert.doesNotMatch(SCREEN, /<p className="px-4 pt-1 pb-2 flex flex-wrap/);
});

// ── #3363: the panel sorts like the Communities screen ─────────────────
//
// "Sort the 'all' community menu when clicked from the toolbar similar to
// the menu on the 'all' page (by type and by recents, with show more on
// each)." The panel draws the screen's three sections, newest first, three
// out and then "Show N more", from ONE module both files import.

const SECTIONS_SRC = read('frontend/src/features/workshop/sections.ts');

const pickerRows = [
  // Server order is deliberately NOT the order drawn.
  { slug: 'solo-old', name: 'Solo old', audience: 'solo', last_active_at: '2026-09-01T00:00:00Z' },
  { slug: 'open-1', name: 'Open one', audience: 'open', last_active_at: '2026-09-10T00:00:00Z' },
  { slug: 'open-5', name: 'Open five', audience: 'open', last_active_at: '2026-09-29T00:00:00Z' },
  { slug: 'inv-1', name: 'Private one', audience: 'invited', last_active_at: '2026-09-20T00:00:00Z' },
  { slug: 'open-2', name: 'Open two', audience: 'open', last_active_at: '2026-09-12T00:00:00Z' },
  { slug: 'open-4', name: 'Open four', audience: 'open', last_active_at: '2026-09-28T00:00:00Z' },
  { slug: 'open-3', name: 'Open three', audience: 'open', last_active_at: '2026-09-15T00:00:00Z' },
  { slug: 'mystery', name: 'Mystery', audience: 'weird', last_active_at: null },
];

const drawnSlugs = (html) => [...html.matchAll(/data-picker-app="([^"]+)"/g)].map((m) => m[1]);
const drawnSections = (html) => [...html.matchAll(/data-picker-section="([^"]+)"/g)].map((m) => m[1]);

test('#3363: the panel groups by audience, newest first, three out then "Show N more"', () => {
  const html = renderToHtml(createElement(chrome.WorkshopPicker, {
    id: 'workshop-scope-picker', scope: null, onClose: () => {}, apps: pickerRows,
  }));
  assert.deepEqual(drawnSections(html), ['open', 'invited', 'solo'],
    'Public communities, Private communities, Just you: the screen\'s order');
  const labels = ['Public communities', 'Private communities', 'Just you'].map((l) => html.indexOf(`<span>${l}</span>`));
  assert.ok(labels.every((at, i) => at > 0 && (i === 0 || at > labels[i - 1])), 'each section is labelled, in order');
  assert.match(html, /aria-label="6 in Public communities"/, 'the label counts the whole section');
  // Six public rows (the unknown audience reads as open, as on the screen):
  // the three most recent are out, and the fold says how many more.
  assert.deepEqual(drawnSlugs(html), ['open-5', 'open-4', 'open-3', 'inv-1', 'solo-old']);
  assert.match(html, /data-picker-more="open" aria-expanded="false"[^>]*>[\s\S]*?>Show 3 more</);
  assert.doesNotMatch(html, /data-picker-more="invited"|data-picker-more="solo"/,
    'a section of three or fewer has no fold row');
  // The "All" row still leads, ticked.
  assert.ok(html.indexOf('id="workshop-scope-picker-all"') < html.indexOf('data-picker-section='));
});

test('#3363: the order and the fold are the screen\'s own, from one shared module', () => {
  // The panel's sections are exactly what the screen's groupRows makes.
  const expected = screen.groupRows(pickerRows).map((s) => [s.key, s.rows.map((r) => r.slug)]);
  assert.deepEqual(expected, [
    ['open', ['open-5', 'open-4', 'open-3', 'open-2', 'open-1', 'mystery']],
    ['invited', ['inv-1']],
    ['solo', ['solo-old']],
  ]);
  // ONE COPY. Both files import ./sections, and the panel does not reach
  // into the screen for it (the screen imports the panel: that would be a
  // cycle).
  for (const name of ['groupRows', 'orderRows', 'sectionFold', 'SECTION_LIMIT', 'SECTION_STEP', 'SECTIONS']) {
    assert.match(SECTIONS_SRC, new RegExp(`export (?:function|const) ${name}\\b`), `${name} lives in sections.ts`);
    assert.doesNotMatch(SCREEN, new RegExp(`(?:function|const) ${name}\\b`), `and the screen has no second ${name}`);
    assert.doesNotMatch(CHROME, new RegExp(`(?:function|const) ${name}\\b`), `nor the panel`);
  }
  assert.match(SCREEN, /from '\.\/sections';/);
  assert.match(CHROME, /from '\.\/sections';/);
  assert.doesNotMatch(CHROME, /from '\.\/index'|from '\.'/, 'the panel never imports the screen');
});

test('#3363: section labels are not menu stops; the fold row is, and hands focus on', () => {
  const html = renderToHtml(createElement(chrome.WorkshopPicker, {
    id: 'workshop-scope-picker', scope: null, onClose: () => {}, apps: pickerRows,
  }));
  // Every section is a group named by its label, and the label is
  // presentation, not a row: menu-keys roves role="menuitem" only.
  for (const key of ['open', 'invited', 'solo']) {
    assert.match(html, new RegExp(`<div role="group" aria-labelledby="workshop-scope-picker-section-${key}" data-picker-section="${key}"><h2 [^>]*id="workshop-scope-picker-section-${key}" role="presentation"`));
  }
  const items = html.match(/role="menuitem"/g) || [];
  assert.equal(items.length, 1 + 5 + 1, 'All, the five rows out, and one fold row: nothing else is a stop');
  // Pressing the fold moves focus to the first row it revealed; "Show
  // fewer" (next below shown) leaves focus on the same row.
  assert.match(CHROME, /if \(fold\.next > fold\.shown\) revealFrom\.current = fold\.shown;\n\s*setLimit\(fold\.next\);/);
  assert.match(CHROME, /items\?\.\[from\]\?\.focus\(\{ preventScroll: true \}\);/);
});

test('#3363: on an app\'s Workshop the ticked app is never folded away', () => {
  // open-1 is the fifth most recent public row, behind the fold at three.
  const html = renderToHtml(createElement(chrome.WorkshopPicker, {
    id: 'dev-ws-scope-chip-picker', scope: { slug: 'open-1' }, onClose: () => {}, apps: pickerRows,
  }));
  assert.deepEqual(drawnSlugs(html).slice(0, 5), ['open-5', 'open-4', 'open-3', 'open-2', 'open-1'],
    'the section opens as far as the app you are on');
  assert.match(html, /data-picker-app="open-1">(?:(?!<\/button>)[\s\S])*M5 13l4 4L19 7/,
    'and it carries the tick');
  assert.match(html, /data-picker-more="open"[^>]*>[\s\S]*?>Show 1 more</);
});

// ── The same panel, scoped to one app (#2718 review, #3295) ───────────
//
// On an app's own Workshop the control is the HEADER's tile and name, at
// every width (#3295, the owner's request: "on desktop, put the community
// selector dropdown in the header, not either above the community hub /
// workshop tabs or to the left of those if the screen is wide"). A phone had
// that since #2768; a desktop drew its own chip above the tabs, or beside
// them on a wide window (#2837). That chip is gone, so the Workshop renders
// the panel alone, and only once the header has opened it.

/** A store that holds one state and never changes, for a static render. */
const fixed = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });

test('#3295: an app\'s Workshop draws no chip; its panel renders only once opened', () => {
  // Closed, which is every first render: nothing at all. No chip to hide at
  // one width and show at another, and no empty wrapper to cost `.dev-ws` a
  // row gap at the top of the page.
  const closed = renderToHtml(createElement(chrome.AppWorkshopScope, { slug: 'notes-ab12' }));
  assert.equal(closed, '');

  // Open: the panel, under the id the header's control names.
  const opened = loadTsx('frontend/src/features/workshop/workshop-chrome.tsx', {
    stubs: {
      './app-scope-store.js': {
        appScopeStore: fixed({ open: true }),
        APP_SCOPE_PANEL_ID: 'dev-ws-scope-chip-picker',
      },
    },
  });
  const html = renderToHtml(createElement(opened.AppWorkshopScope, { slug: 'notes-ab12' }));
  assert.match(html, /^<div class="dev-ws-scope" data-ws-scope=""><div id="dev-ws-scope-chip-picker"[^>]* role="menu"/);
  // #3302 named the panel "Which project?"; this test landed after it (#3305).
  assert.match(html, /Which project\?/);
  assert.match(html, /id="dev-ws-scope-chip-picker-all"/, 'All, the way back up');
  assert.doesNotMatch(html, /id="dev-ws-scope-chip"/, 'and no chip beside it');
  assert.doesNotMatch(html, /aria-haspopup/, 'the only control for it is the header\'s');
});

test('#3295: a page leads with its back bar at every width, with nothing to measure', () => {
  const WORKSHOP_PATH = 'frontend/src/features/dev-board/workshop/workshop.tsx';
  const real = loadTsx('frontend/src/features/dev-board/card/cards-store.ts');
  const view = { ...real.EMPTY_WORKSHOP_VIEW, loading: false, slug: 'notes-ab12', tab: 'all' };
  const mod = loadTsx(WORKSHOP_PATH, {
    stubs: { '../card/cards-store': { ...real, devWorkshopStore: fixed(view) } },
  });
  const html = renderToHtml(createElement(mod.DevWorkshop, {}));
  // The panel is shut on arrival, so the page's back bar is the root's first
  // child (the hub has no bar; a page leads with its way back).
  assert.match(html, /^<div class="dev-ws" data-ws-tab="all"><div class="dev-ws-tabs dev-ws-pagebar" data-ws-pagebar="">/);
  assert.doesNotMatch(html, /dev-ws-scope/);

  // #2837's measurement went with the chip it placed: nothing sets
  // `data-ws-scope-inline` and app.css has no rule for it, nor for a chip
  // inside `.dev-ws-scope`.
  const ws = read(WORKSHOP_PATH);
  assert.doesNotMatch(ws, /useScopeInline|scopeFitsInline|data-ws-scope-inline|SCOPE_INLINE_/);
  assert.match(ws, /\{slug \? <AppWorkshopScope slug=\{slug\} \/> : null\}/);
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /data-ws-scope-inline/);
  assert.doesNotMatch(css, /\.dev-ws-scope > button/);
  // On a desktop the panel keeps the menu's width the wide-window panel had,
  // in the one block written at that breakpoint (tests/dev-workshop.test.js).
  const wide = /@media \(min-width: 700px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(wide, 'the wide-screen block exists');
  assert.match(wide[1], /\n  \.dev-ws-scope > \[role='menu'\] \{ max-width: 420px; \}$/);
});

test('#2768: the panel\'s id is one spelling, shared with the header\'s control', () => {
  // The HEADER's tile and name open the panel; its `aria-controls` must name
  // the element the panel is. The all-apps chip derives its own panel's id
  // the same way, from its id plus `-picker`.
  const store = read('frontend/src/features/workshop/app-scope-store.js');
  assert.match(store, /export const APP_SCOPE_PANEL_ID = 'dev-ws-scope-chip-picker';/);
  assert.match(CHROME, /id=\{APP_SCOPE_PANEL_ID\}/, 'the panel wears it');
  assert.match(CHROME, /aria-controls=\{`\$\{id\}-picker`\}/, 'and the all-apps chip derives its own the same way');
  const header = read('frontend/src/features/header/header-title.tsx');
  assert.match(header, /aria-controls=\{APP_SCOPE_PANEL_ID\}/, 'and the header names it');
  assert.match(header, /onClick=\{\(\) => appScopeStore\.set\(\{ open: !scopeOpen \}\)\}/);
});

/** #header-title as rendered on an app route, with the stores it reads fixed. */
function renderHeader({ viewMode = 'workshop', subTab = 'forum' } = {}) {
  const mod = loadTsx('frontend/src/features/header/header-title.tsx', {
    stubs: {
      './header-title-store.js': { headerTitleStore: fixed({ text: 'Recipe Box', subtitle: '' }) },
      '../nav/nav-store.js': { navStore: fixed({ screen: 'app-view' }) },
      '../improve/improve-store.js': {
        improveStore: fixed({ tab: 'dev', subTab, name: 'Recipe Box', iconUrl: null, iconEmoji: '🍲' }),
      },
      '../dev-board/view-mode-store': { useDevViewMode: () => viewMode },
    },
  });
  return renderToHtml(createElement(mod.HeaderTitle, { titleRef: { current: null } }));
}

test('#2768, #3295: on the app\'s Workshop the header IS the switcher, at every width', () => {
  const header = read('frontend/src/features/header/header-title.tsx');
  // Which screen: the Dev half's board route in its Workshop layout.
  assert.match(header,
    /const onWorkshop = inApp && tab === 'dev' && subTab === 'forum' && viewMode === 'workshop';/);
  // NO WIDTH IN IT. Until #3295 this was `onWorkshop && phone`, and a desktop
  // kept the name alone in the bar beside a chip in the page.
  assert.match(header, /const switcher = onWorkshop;/);
  assert.match(header, /const showTile = inApp;/);

  // A static render runs no effects, so the phone flag is still false: this
  // IS the desktop render. The tile and the app's name are one button that
  // opens the Workshop's panel.
  const html = renderHeader();
  assert.match(html,
    /<button id="header-app-switch" type="button" class="pointer-events-auto [^"]*" aria-haspopup="menu" aria-expanded="false" aria-controls="dev-ws-scope-chip-picker" aria-label="Recipe Box, switch app"><span id="header-app-tile"[^>]*>[\s\S]*?<\/span><\/span><span id="header-title-name" class="min-w-0 truncate">Recipe Box<\/span><svg/);

  // The Kanban layout has no scope panel, so there the strip is a tile and a
  // name, not a control.
  const kanban = renderHeader({ viewMode: 'kanban' });
  assert.doesNotMatch(kanban, /header-app-switch/);
  assert.match(kanban, /<span id="header-app-tile"[^>]*>[\s\S]*?<\/span><\/span><span class="min-w-0 flex items-baseline gap-1\.5"><span id="header-title-name" class="min-w-0 truncate">Recipe Box<\/span>/);

  // The phone flag stays for the Communities screen's switcher (#3271), and
  // is still settled in an EFFECT, false first, so the hydrating render is
  // the prerender's whatever the window is.
  assert.match(header, /const allAppsSwitcher = screen === 'workshop-screen' && phone;/);
  assert.match(header, /const \[phone, setPhone\] = useState\(false\);/);
  assert.match(header, /const PHONE_QUERY = '\(max-width: 699\.98px\)';/);
});
