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
// ── #852 made the tab a community, and the chip's panel a switcher ─────
//
// The fourth tab is the community you are on (or All communities), and
// "Your communities" is how you change which: a sheet on a phone, a menu on a
// wide window, opened from the lit tab, the header's name and ⌄, and the All
// chip here (features/workshop/community-switcher.tsx). The "Which project?"
// panel both ends of the chip shared is gone. The switcher lists every
// community you are in, newest first, each saying who it is for and what it
// waits on you for; #3519 groups them like the All communities page's list,
// with the sections and "Show N more" of #3363.
//
// What is pinned, each a way the screens can be quietly wrong:
//
//   1. PICKING A COMMUNITY GOES TO ITS HUB, and All communities to the list.
//   2. THE SWITCHER SAYS WHICH ONE YOU ARE ON, and what each waits on you for.
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
const SCREEN = read('frontend/src/features/workshop/index.tsx');

const SCOPE = read('frontend/src/features/workshop/community-scope.ts');
const SWITCHER = read('frontend/src/features/workshop/community-switcher.tsx');

const screen = loadTsx('frontend/src/features/workshop/index.tsx');

const app = (slug, working, needs) => ({ slug, name: slug, working, needs });

test('picking a community goes to its hub, and All communities to the list', () => {
  const at = SCOPE.indexOf('export function goToCommunity(');
  const fn = SCOPE.slice(at, SCOPE.indexOf('\n}\n', at));
  assert.match(fn, /closeSwitcher\(\);/, 'the switcher closes either way');
  assert.match(fn, /setScope\(null\);[\s\S]*?_forgetWorkshopView[\s\S]*?window\.location\.hash = '#communities';/,
    'All communities is the list, by the same address the tab carries');
  assert.match(fn, /setScope\(slug\);\s*try \{ \(window as any\)\.AppView\?\._landOnHub\?\.\(slug\); \}/,
    'a community opens on its hub');
  assert.match(fn, /void app\?\.navigateToApp\?\.\(slug, 'dev'\);/);
  assert.ok(!fn.includes('startSession') && !fn.includes('giveFeedback'), 'nothing is started from the switcher');
  // Join or start a community is Discover.
  assert.match(SWITCHER, /data-switcher-join=""\s*onClick=\{\(\) => \{ closeSwitcher\(\); window\.location\.hash = '#apps'; \}\}/);
});

test('the switcher says which community you are on, who each is for, and what it waits on you for', () => {
  const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });
  const info = {
    garden: { slug: 'garden', name: 'Garden', iconUrl: null, iconEmoji: '🌱', iconColor: '#2e6660', audience: 'open', memberCount: 23, needs: 2 },
    club: { slug: 'club', name: 'Club', iconUrl: null, iconEmoji: null, iconColor: null, audience: 'invited', memberCount: 1, needs: 0 },
    notes: { slug: 'notes', name: 'Notes', iconUrl: null, iconEmoji: '📝', iconColor: null, audience: 'solo', memberCount: 1, needs: 0 },
  };
  const real = loadTsx('frontend/src/features/workshop/community-scope.ts');
  const render = (slug) => {
    const mod = loadTsx('frontend/src/features/workshop/community-switcher.tsx', {
      stubs: {
        './community-scope': {
          ...real,
          communityScopeStore: fixedStore({ slug, info, list: ['garden', 'club', 'notes'], totalNeeds: 2, switcher: 'tab', anchor: null }),
        },
      },
    });
    return renderToHtml(createElement(mod.SwitcherBody, {}));
  };
  const all = render(null);
  assert.match(all, /<h2 class="community-switcher-title" id="community-switcher-title">Your communities<\/h2>/);
  const rows = [...all.matchAll(/data-switcher-community="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['all', 'garden', 'club', 'notes'], 'All communities first, then each in the list\'s order');
  assert.match(all, /data-switcher-community="all" aria-current="true"/, 'with none chosen, All communities is the one you are on');
  assert.match(all, /All communities<\/span><span class="community-switcher-sub">3 communities<\/span>/);
  assert.match(all, /data-switcher-waiting="">2 to vote</, 'what they all wait on you for');
  assert.match(all, />Public · 23 members<\/span>/);
  assert.match(all, />Private · 1 member<\/span>/);
  assert.match(all, />Just you<\/span>/);
  assert.equal((all.match(/data-switcher-waiting/g) || []).length, 2, 'a zero says nothing');
  assert.ok(all.indexOf('data-switcher-join') > all.indexOf('data-switcher-community="notes"'), 'Join or start a community last');
  const one = render('garden');
  assert.match(one, /data-switcher-community="garden" aria-current="true"/, 'the tab\'s community is ticked');
  assert.doesNotMatch(one, /data-switcher-community="all" aria-current/);
  assert.match(one, /color-mix\(in srgb, #2e6660 12%, transparent\)/, 'and tinted in its own colour');
  // Grouped like the All communities page (#3519): the page's three labels in
  // its order, and each community drawn inside its own section.
  const atLabel = (label) => all.indexOf(`>${label}</h3>`);
  assert.ok(atLabel('Public communities') >= 0
    && atLabel('Public communities') < atLabel('Private communities')
    && atLabel('Private communities') < atLabel('Just you'),
    'the page\'s three section labels, in its order');
  assert.ok(all.indexOf('data-switcher-community="garden"') > atLabel('Public communities')
    && all.indexOf('data-switcher-community="garden"') < atLabel('Private communities'),
    'a community is drawn inside its own section');
  assert.ok(all.indexOf('data-switcher-community="all"') < atLabel('Public communities'),
    'All communities still leads the list');
});

test('#3519: the switcher folds a long section like the All communities page', () => {
  const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });
  const info = {};
  // Five open communities and one Just you: the open section folds, the solo
  // one is alone, and no private row means no Private communities label.
  const list = ['grove', 'field', 'orchard', 'meadow', 'terrace', 'notes'];
  for (const slug of list) {
    info[slug] = {
      slug, name: slug, iconUrl: null, iconEmoji: null, iconColor: null,
      audience: slug === 'notes' ? 'solo' : 'open', memberCount: 1, needs: 0,
    };
  }
  const real = loadTsx('frontend/src/features/workshop/community-scope.ts');
  const mod = loadTsx('frontend/src/features/workshop/community-switcher.tsx', {
    stubs: {
      './community-scope': {
        ...real,
        communityScopeStore: fixedStore({ slug: null, info, list, totalNeeds: 0, switcher: 'tab', anchor: null }),
      },
    },
  });
  const html = renderToHtml(createElement(mod.SwitcherBody, {}));
  const openSection = html.match(
    /<h3 class="community-switcher-section-label">Public communities<\/h3>[\s\S]*?<h3 class="community-switcher-section-label">Just you<\/h3>/,
  );
  assert.ok(openSection, 'the labels are drawn, each its own small muted caps');
  const fold = openSection[0].match(/<button type="button" class="community-switcher-row community-switcher-fold"[^>]*>/);
  assert.ok(fold, 'a five-row section ends in a fold row');
  assert.match(fold[0], /aria-expanded="false"/, 'folded, not open');
  assert.match(openSection[0], />Show 2 more<\/span>/, 'the fold names what is left, five out of five minus three');
  assert.ok(!fold[0].includes('data-switcher-community'), 'the fold is not a community row');
  assert.match(openSection[0], />Public communities<\/h3>/, 'the label carries no count — the fold says more are hidden');
  const soloTail = html.slice(html.indexOf('>Just you</h3>'));
  assert.ok(!soloTail.includes('community-switcher-fold'), 'a section of three or fewer draws no fold row');
  assert.doesNotMatch(html, /Private communities/, 'an empty section is left out');

  // The fold's three-then-five-then-fewer sequence is sections.ts's, the
  // All communities page's own (#3269) — pinned there in full; this is the
  // five-row shape the fold row above renders.
  const sections = loadTsx('frontend/src/features/workshop/sections.ts');
  let step = sections.sectionFold(5, sections.SECTION_LIMIT);
  assert.deepEqual(step, { shown: 3, label: 'Show 2 more', next: 8 });
  step = sections.sectionFold(5, step.next);
  assert.deepEqual(step, { shown: 5, label: 'Show fewer', next: sections.SECTION_LIMIT },
    'once every row is out, the same row folds the section back to three');
});

test('#3519: before the list answers, the loading note stays and no sections render', () => {
  const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });
  const real = loadTsx('frontend/src/features/workshop/community-scope.ts');
  const mod = loadTsx('frontend/src/features/workshop/community-switcher.tsx', {
    stubs: {
      './community-scope': {
        ...real,
        communityScopeStore: fixedStore({ slug: null, info: {}, list: null, totalNeeds: null, switcher: 'tab', anchor: null }),
      },
    },
  });
  const html = renderToHtml(createElement(mod.SwitcherBody, {}));
  assert.match(html, /data-switcher-loading="">Loading your communities/);
  assert.doesNotMatch(html, /community-switcher-section-label/, 'nothing to group yet');
});

test('#852: every class the switcher draws with has a rule, and the menu floats at a fixed size', () => {
  // A REAL REGRESSION. Deleting the two-column hub's rules took the block
  // under them with it, and the switcher rendered unstyled: its rows as
  // inline text, each icon at its natural size across the page. Nothing
  // failed, because nothing read the stylesheet for it.
  const CSS = read('public/css/app.css');
  const used = [...new Set(SWITCHER.match(/community-switcher(?:-[a-z]+)*/g))];
  const unstyled = used.filter((c) => !new RegExp(`\\.${c}(?![-\\w])[^{}]*\\{`).test(CSS));
  assert.deepEqual(unstyled, [], 'each community-switcher-* class the component uses is styled in app.css');
  assert.match(CSS, /\.community-switcher-menu \{[^}]*position: fixed;[^}]*width: 364px;/,
    'the wide menu floats, at a fixed width');
  assert.match(CSS, /\.community-switcher-scrim \{[^}]*position: fixed;/, 'the phone sheet sits over a scrim');
  assert.match(CSS, /\.community-switcher-tile \{[^}]*width: 40px; height: 40px;/, 'and a community\'s tile has a size');
  assert.match(CSS, /\.community-switcher-tile > img \{ width: 100%; height: 100%;/, 'which its icon fills rather than overflowing');
  assert.match(CSS, /\.platform-tab-tile > img \{ width: 100%; height: 100%;/, 'as the tab\'s tile does');
});

test('All items, the plus and now the tabs are gone; Needs you is a row (#3051)', () => {
  for (const id of ['workshop-tabs', 'workshop-tab-all', 'workshop-tab-empty', 'workshop-plus',
    'workshop-plus-change', 'workshop-plus-issue', 'workshop-plus-create', 'workshop-picker',
    'workshop-tab-status', 'workshop-tab-needs', 'workshop-total-working', 'workshop-total-needs']) {
    assert.ok(!SCREEN.includes(`id="${id}"`), `#${id} is not on the screen either`);
    assert.ok(!HTML.includes(`id="${id}"`), `#${id} is not in the shipped shell`);
  }
  // NOTHING FILTERS THE LIST OF APPS, which is the argument that retired the
  // old strip: the Needs you feed is a page of its own over the list, and
  // nothing narrows `rows` by it.
  assert.ok(!SCREEN.includes('filterRows'), 'the screen does not filter the app list');
  const store = read('frontend/src/features/workshop/workshop-store.js');
  assert.match(store, /^\s*tab: 'status',/m, 'the list is the default, and the prerender');
  assert.doesNotMatch(store, /scopeOpen/, 'Your communities keeps its own open flag (#852)');
  assert.doesNotMatch(store, /itemsError|^\s*items:/m, 'the items read left with the pane it filled');
  // The chip's module went with the chip and its panel (#852).
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/workshop/workshop-chrome.tsx')));
});

test('the Needs you row opens the feed over the list without redrawing it', () => {
  const html = () => renderToHtml(createElement(screen.WorkshopScreen, {}));
  screen.workshopStore.set({
    open: true, error: false, tab: 'status',
    rows: [app('staging-demo-your-app', 2, 3)],
  });
  let out = html();
  assert.match(out, /data-workshop-pane="status" class=""/);
  assert.match(out, /data-workshop-needs-open=""/);
  assert.doesNotMatch(out, /data-workshop-pane="needs"/, 'the feed renders only while showing');
  screen.workshopController.setTab('needs');
  out = html();
  assert.match(out, /data-workshop-pane="status" class="hidden"/);
  assert.match(out, /data-workshop-pane="needs"/);
  assert.match(out, /data-workshop-needs-back=""[^>]*aria-label="Back to Communities"/);
  assert.match(out, /data-workshop-app="staging-demo-your-app"/,
    'the list is still in the document, hidden, not unmounted');
  screen.workshopController.setTab('nonsense');
  assert.equal(screen.workshopStore.get().tab, 'status', 'anything else is the list');
  screen.workshopStore.set({ tab: 'status', rows: null });
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

test('#3051, #852: the header\'s "Communities" switcher is there at every width, and opens Your communities', () => {
  // #2759 took the all-apps chip off while the screen was only the list of
  // your apps; the owner asked for it back as "All apps" (#3051), leading the
  // page. #852 puts it in the bar at every width, where a phone already had
  // it (#3271): the bar is what says where you are.
  assert.doesNotMatch(SCREEN, /AllAppsScope|id="workshop-scope"/);
  assert.ok(!HTML.includes('id="workshop-scope"'), 'no chip in the cold document');
  assert.ok(!HTML.includes('id="community-switcher"'), 'and the switcher is behind a press');
  const html = renderHeader({ screen: 'workshop-screen' });
  assert.match(html, /<button id="header-scope-switch" type="button" class="[^"]*" data-community-switch="" aria-haspopup="dialog" aria-expanded="false" aria-controls="community-switcher" aria-label="Communities: all of yours, or open one">/);
  // The screen's own name (#852 review; it read "All", #3277), with "All
  // communities" kept for the switcher's first row.
  assert.match(html, /<span id="header-title-name" class="min-w-0 truncate">Communities<\/span>/, 'the word Communities');
  assert.doesNotMatch(html, /truncate">All<\/span>/);
  // The page still steps down past the header's notch before its first row.
  assert.match(SCREEN, /<div className="pt-5" aria-hidden="true" \/>/);
  assert.doesNotMatch(SCREEN, /<p className="px-4 pt-1 pb-2 flex flex-wrap/);
});

// ── #3363's sections live on the Communities screen ───────────────────
//
// The panel drew the screen's three audience sections from one shared module.
// The switcher lists communities in the screen's own order (orderRows), and
// #3519 groups them with the same groupRows, folded like the screen's list.

const SECTIONS_SRC = read('frontend/src/features/workshop/sections.ts');

test('#3363: the order is the screen\'s own, from one shared module', () => {
  for (const name of ['groupRows', 'orderRows', 'sectionFold', 'SECTION_LIMIT', 'SECTION_STEP', 'SECTIONS']) {
    assert.match(SECTIONS_SRC, new RegExp(`export (?:function|const) ${name}\\b`), `${name} lives in sections.ts`);
    assert.doesNotMatch(SCREEN, new RegExp(`(?:function|const) ${name}\\b`), `and the screen has no second ${name}`);
    assert.doesNotMatch(SCOPE, new RegExp(`(?:function|const) ${name}\\b`), 'nor the switcher\'s store');
  }
  assert.match(SCREEN, /from '\.\/sections';/);
  assert.match(SCOPE, /import \{ orderRows \} from '\.\/sections';/);
  assert.match(SCOPE, /const ordered = orderRows\(joined as any\)/, 'newest first, as the screen orders them');
});

/** A store that holds one state and never changes, for a static render. */
const fixed = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });

test('#852: a project page leads with its tabs, and All items with its way back under them; no panel of its own', () => {
  const WORKSHOP_PATH = 'frontend/src/features/dev-board/workshop/workshop.tsx';
  const real = loadTsx('frontend/src/features/dev-board/card/cards-store.ts');
  const page = (tab) => {
    const view = { ...real.EMPTY_WORKSHOP_VIEW, loading: false, slug: 'notes-ab12', tab };
    const mod = loadTsx(WORKSHOP_PATH, {
      stubs: { '../card/cards-store': { ...real, devWorkshopStore: fixed(view) } },
    });
    return renderToHtml(createElement(mod.DevWorkshop, {}));
  };
  assert.match(page('workshop'), /^<div class="dev-ws" data-ws-tab="workshop"><div class="dev-ws-tabs dev-ws-band" data-ws-band="">/);
  assert.match(page('all'), /^<div class="dev-ws" data-ws-tab="all"><div class="dev-ws-tabs dev-ws-band" data-ws-band="">[\s\S]*?<\/div><\/div><div class="dev-ws-tabs dev-ws-pagebar" data-ws-pagebar="">/);
  const ws = read(WORKSHOP_PATH);
  assert.doesNotMatch(ws, /AppWorkshopScope|useScopeInline|scopeFitsInline|data-ws-scope-inline|SCOPE_INLINE_/);
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /data-ws-scope-inline|\.dev-ws-scope\b/, 'the panel\'s CSS went with it');
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/workshop/app-scope-store.js')), 'and its store');
});

/** #header-title as rendered on an app route, with the stores it reads fixed. */
function renderHeader({
  viewMode = 'workshop', subTab = 'forum', screen = 'app-view', name = 'Recipe Box', selfHosted = false,
} = {}) {
  const mod = loadTsx('frontend/src/features/header/header-title.tsx', {
    stubs: {
      './header-title-store.js': { headerTitleStore: fixed({ text: name, subtitle: '' }) },
      '../nav/nav-store.js': { navStore: fixed({ screen }) },
      '../improve/improve-store.js': {
        improveStore: fixed({ tab: 'dev', subTab, name, iconUrl: null, iconEmoji: '🍲', selfHosted }),
      },
      '../dev-board/view-mode-store': { useDevViewMode: () => viewMode },
      '../workshop/community-scope': {
        communityScopeStore: fixed({ switcher: null }),
        toggleSwitcher: () => {},
      },
    },
  });
  return renderToHtml(createElement(mod.HeaderTitle, { titleRef: { current: null } }));
}

test('#2768, #3295, #852: on the app\'s Workshop the header\'s name opens Your communities, at every width', () => {
  const header = read('frontend/src/features/header/header-title.tsx');
  // Which screen: the Dev half's board route in its Workshop layout.
  assert.match(header,
    /const onWorkshop = inApp && tab === 'dev' && subTab === 'forum' && viewMode === 'workshop';/);
  // NO WIDTH IN IT. Until #3295 this was `onWorkshop && phone`, and a desktop
  // kept the name alone in the bar beside a chip in the page.
  assert.match(header, /const appSwitch = onWorkshop;/);
  assert.match(header, /const showTile = inApp;/);

  // A static render runs no effects, so the phone flag is still false: this
  // IS the desktop render. The tile and the app's name are one button that
  // opens Your communities.
  const html = renderHeader();
  assert.match(html,
    /<button id="header-app-switch" type="button" class="pointer-events-auto [^"]*" data-community-switch="" aria-haspopup="dialog" aria-expanded="false" aria-controls="community-switcher" aria-label="Recipe Box, switch community"><span id="header-app-tile"[^>]*>[\s\S]*?<\/span><\/span><span id="header-title-name" class="min-w-0 truncate">Recipe Box<\/span><svg/);

  // The Kanban layout has no scope panel, so there the strip is a tile and a
  // name, not a control.
  const kanban = renderHeader({ viewMode: 'kanban' });
  assert.doesNotMatch(kanban, /header-app-switch/);
  assert.match(kanban, /<span id="header-app-tile"[^>]*>[\s\S]*?<\/span><\/span><span class="min-w-0 flex items-baseline gap-1\.5"><span id="header-title-name" class="min-w-0 truncate">Recipe Box<\/span>/);

  // No width anywhere in it now: the Communities screen's "All" is the
  // bar's at every width too (#852).
  assert.match(header, /const allAppsSwitcher = screen === 'workshop-screen';/);
  assert.doesNotMatch(header, /PHONE_QUERY|usePhone/);
});

test('#3497: on Homeroom\'s own pages the switcher names it with the logotype, not the word', () => {
  // The Communities tab with Homeroom selected: the platform's own row, on
  // its hub. The bar names the platform with the logotype on Home, and the
  // switcher here used to be the one place it was plain type.
  const html = renderHeader({ name: 'Homeroom', selfHosted: true });
  const button = html.match(/<button id="header-app-switch"[\s\S]*?<\/button>/);
  assert.ok(button, 'the name is still the switcher');
  assert.match(button[0], /aria-label="Homeroom, switch community"/,
    'the button says the name in words, which is why the drawing can be decoration');
  const label = button[0].match(/<span id="header-title-name" class="min-w-0 truncate">([\s\S]*?)<\/span>/);
  assert.ok(label, 'the named slot and its truncation stay');
  assert.match(label[1], /^<svg class="h-5 w-\[77\.5px\]" fill="currentColor" viewBox="0 0 1236\.9 319\.2" aria-hidden="true">/,
    'the logotype, at the size Home draws it, in the bar\'s own ink');
  assert.doesNotMatch(label[1], /Homeroom/, 'drawn INSTEAD of the word, not beside it');
  assert.match(button[0], /<span id="header-app-tile"/, 'the community\'s tile still leads');
  assert.match(button[0], /<\/span><svg class="w-4 h-4 shrink-0"[^>]*aria-hidden="true">/, 'and the ⌄ still follows');

  // The platform is the self-hosted ROW, not a name: a project somebody
  // called Homeroom keeps its word.
  const namesake = renderHeader({ name: 'Homeroom', selfHosted: false });
  assert.match(namesake, /<span id="header-title-name" class="min-w-0 truncate">Homeroom<\/span>/);
  assert.doesNotMatch(namesake, /viewBox="0 0 1236\.9 319\.2"/);
});
