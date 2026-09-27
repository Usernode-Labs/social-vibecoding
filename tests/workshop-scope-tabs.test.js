'use strict';

// The Workshop's scope chip and its totals (#2718).
//
// The screen answers "which of my apps wants something from me": a chip that
// says what you are looking at and narrows it, a legend that totals what is
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
// Needs you. The argument above is answered rather than ignored: these tabs
// do not filter the list of apps. Current status IS that list, unchanged,
// with your in-flight items under it; Needs you lists the votes waiting on
// you ITEM BY ITEM, grouped by app, from GET /api/workshop/items. All items
// and the plus stay retired: every item of every app is not a page, and the
// plus's two questions can still only be asked inside an app.
//
// Three things are still pinned, and each is a way the screens can be quietly
// wrong:
//
//   1. PICKING AN APP NAVIGATES, to that app's own Workshop.
//   2. THE NAVIGATION IS AWAITED, so a refused one cannot read as a
//      completed one.
//   3. THE TOTALS DO NOT REWORD THE LEGEND. A declared check pins the phrase
//      "Votes waiting on you" on this screen.

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

test('All items and the plus stay gone; Current status and Needs you are back (#3051)', () => {
  for (const id of ['workshop-tabs', 'workshop-tab-all', 'workshop-tab-empty', 'workshop-plus',
    'workshop-plus-change', 'workshop-plus-issue', 'workshop-plus-create', 'workshop-picker']) {
    assert.ok(!CHROME.includes(`id="${id}"`), `#${id} is not rendered`);
    assert.ok(!SCREEN.includes(`id="${id}"`), `#${id} is not on the screen either`);
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} is not in the shipped shell`);
  }
  // The two that came back ship in the cold document, the default one current.
  assert.match(HTML, /<button id="workshop-tab-status" type="button" data-workshop-tab="status" aria-current="page"/);
  assert.match(HTML, /<button id="workshop-tab-needs" type="button" data-workshop-tab="needs" aria-current="false"/);
  // THEY DO NOT FILTER THE LIST OF APPS, which is the argument that retired
  // the old strip. Both panes render; the list lives in Current status
  // untouched, and nothing narrows `rows` by a tab.
  assert.ok(!SCREEN.includes('filterRows'), 'the screen does not filter the app list');
  const store = read('frontend/src/features/workshop/workshop-store.js');
  assert.match(store, /^\s*tab: 'status',/m, 'Current status is the default, and the prerender');
  assert.match(store, /^\s*scopeOpen: false,/m, 'the chip\'s panel ships closed');
  // ONE PANEL COMPONENT for both ends of the chip.
  assert.match(CHROME, /export const ALL_APPS_SCOPE_ID = 'workshop-scope';/);
  assert.match(CHROME, /<WorkshopPicker\n\s+id=\{panelId\}\n\s+apps=\{apps\}\n\s+scope=\{null\}/);
});

test('#3051: the tabs switch panes without redrawing the list, and close the chip\'s panel', () => {
  const html = () => renderToHtml(createElement(screen.WorkshopScreen, {}));
  screen.workshopStore.set({
    open: true, error: false, tab: 'status', scopeOpen: true, itemsError: false,
    rows: [app('staging-demo-your-app', 2, 3)],
    items: {
      'staging-demo-your-app': {
        working: [{ kind: 'session', id: 7, title: 'Dark theme', status: 'active', at: null }],
        needs: [{ kind: 'proposal', id: 8, title: 'Sort by rating', status: 'promoted', at: null }],
      },
    },
  });
  let out = html();
  assert.match(out, /data-workshop-pane="status" class=""/);
  assert.doesNotMatch(out, /data-workshop-pane="needs"/, 'the Needs you pane renders only while showing');
  assert.match(out, /id="workshop-scope-picker"/, 'the panel renders once open');
  screen.workshopController.setTab('needs');
  assert.equal(screen.workshopStore.get().scopeOpen, false, 'a tab press closes the panel');
  out = html();
  assert.match(out, /data-workshop-pane="status" class="hidden"/);
  assert.match(out, /data-workshop-pane="needs"/);
  assert.match(out, /data-workshop-app="staging-demo-your-app"/,
    'the list is still in the document, hidden with its pane, not unmounted');
  screen.workshopController.setTab('nonsense');
  assert.equal(screen.workshopStore.get().tab, 'status', 'anything else is the default');
  screen.workshopStore.set({ tab: 'status', scopeOpen: false, rows: null, items: null });
});

test('the legend carries the totals, and says nothing when there is nothing', () => {
  // The design study put three count cards at the top of this screen. The
  // question they answer is real — the rows say which APPS need you, and
  // nothing said how much there is altogether — but a deck above a list whose
  // every row carries the same two figures is the third telling of one fact,
  // so the numbers went into the legend that already names the two glyphs.
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.match(screen, /id="workshop-total-working"/);
  assert.match(screen, /id="workshop-total-needs"/);
  // ACROSS EVERY APP, not the filtered tab: "how much is there" is not a
  // question whose answer should move when you change tabs.
  const at = screen.indexOf('const totals = all');
  const decl = screen.slice(at, screen.indexOf('const empty', at));
  assert.match(decl, /all\.length > 0/,
    'no totals with no apps — the empty card already says why the screen is bare');
  assert.match(decl, /acc\.working \+ \(row\.working \|\| 0\)/);
  assert.match(decl, /acc\.needs \+ \(row\.needs \|\| 0\)/);
  assert.ok(!decl.includes('rows'), 'it sums `all`, not the tab-filtered rows');
  // THE WORDS ARE NOT THE NUMBER'S TO CHANGE, which is the whole reason this
  // assertion exists in this shape. The totals first shipped as "2 working
  // on" / "3 waiting on your vote" — a rewording on the way past — and a
  // declared check pins the phrase "Votes waiting on you" on this screen, so
  // it went red on the platform's own run. The number is additive now: the
  // legend says what it always said and gains a figure at the end.
  assert.match(screen, /You are working on\n\s+\{totals \? <b id="workshop-total-working"/);
  assert.match(screen, /Votes waiting on you\n\s+\{totals \? <b id="workshop-total-needs"/);
  const dapp = JSON.parse(read('dapp.json'));
  const pinned = dapp.tests.find((t) => t.expectText === 'Votes waiting on you');
  assert.ok(pinned, 'the phrase is still a declared check\'s expectText');
  assert.ok(read('public/index.html').includes('Votes waiting on you'),
    'and the cold document still carries it, with no figure to wait for');
  assert.ok(!HTML.includes('id="workshop-total-working"'),
    'a figure read from data is not in a cold document');
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
  // The chip's row leads the screen now, so it carries the header's notch
  // clearance the legend carried while it led.
  assert.match(SCREEN, /<div className="px-4 pt-5 pb-2 flex flex-wrap items-center gap-x-3 gap-y-2">\n\s*<AllAppsScope/);
  assert.match(SCREEN, /<p className="px-4 pt-1 pb-2 flex flex-wrap/);
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
  assert.match(html, /Which workshop\?/);
  assert.match(html, /id="dev-ws-scope-chip-picker-all"/, 'All, the way back up');
  assert.doesNotMatch(html, /id="dev-ws-scope-chip"/, 'and no chip beside it');
  assert.doesNotMatch(html, /aria-haspopup/, 'the only control for it is the header\'s');
});

test('#3295: the Workshop leads with its tabs at every width, with nothing to measure', () => {
  const WORKSHOP_PATH = 'frontend/src/features/dev-board/workshop/workshop.tsx';
  const real = loadTsx('frontend/src/features/dev-board/card/cards-store.ts');
  const view = { ...real.EMPTY_WORKSHOP_VIEW, loading: false, slug: 'notes-ab12', tab: 'all' };
  const mod = loadTsx(WORKSHOP_PATH, {
    stubs: { '../card/cards-store': { ...real, devWorkshopStore: fixed(view) } },
  });
  const html = renderToHtml(createElement(mod.DevWorkshop, {}));
  // The panel is shut on arrival, so the tab strip is the root's first child.
  assert.match(html, /^<div class="dev-ws" data-ws-tab="all"><div class="dev-ws-tabs" data-ws-tabs="">/);
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
