'use strict';

// The Workshop screen (#workshop): every app you have, with how much of its
// own Workshop page is addressed to you.
//
// Three things can go wrong here, and this file is organised around them.
//
// 1. THE TWO NUMBERS CAN DRIFT FROM WHAT THEY COUNT. The populations are
//    defined by `AppView._workshopView()` in public/js/app-view.js, which
//    builds them from the board's own endpoints; the screen's counts come out
//    of Postgres instead, in one query. Two derivations of one definition is
//    exactly the shape that rots, so the assertions below pin the query
//    against the statuses and predicates those endpoints use rather than
//    against a number somebody typed.
//
// 2. THE QUERY CAN ANSWER FOR THE WRONG VIEWER. Every predicate names `$1`;
//    with a NULL viewer `IS DISTINCT FROM` is true for every row and the
//    "needs you" count becomes "every promoted proposal on the platform".
//    The route refuses an anonymous caller for that reason, and that refusal
//    is asserted here rather than left to the middleware.
//
// 3. THE SCREEN CAN BREAK HYDRATION. It ships hidden and empty; a first
//    render that draws rows would mismatch the prerendered document, which
//    console.errors, which fails every proposal check on every route.
//
// Run with: node --test tests/workshop-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const route = require('../src/routes/workshop-overview');
const appJs = read('public/js/app.js');
const appViewJs = read('public/js/app-view.js');
const sheetTsx = read('frontend/src/features/app-context/app-context-sheet.tsx');

// ── 1. The counts query counts what the lander counts ──────────────────

test('"working" is the viewer\'s own work, in the lander\'s three shapes', () => {
  const sql = route.COUNTS_SQL;
  // The board's `_mySessions`: GET /api/me/active-sessions filtered to the
  // app, which selects `status IN ('active', 'promoted', 'paused')` with
  // `is_headless = FALSE` and which the board then narrows to active/paused.
  assert.match(sql, /my_sessions AS \(/);
  assert.match(sql, /cs\.status IN \('active', 'paused'\)/,
    'the viewer\'s dev sessions are the active and paused ones');
  assert.match(sql, /cs\.is_headless = FALSE/,
    'headless runs are not somebody\'s own work — /api/me/active-sessions excludes them too');
  // The board's `inReview` rows whose user_id is the viewer's: /promoted
  // returns 'promoted' AND 'merging', so a proposal mid-merge is still the
  // author's work in flight rather than vanishing off their row.
  assert.match(sql, /my_proposals AS \([\s\S]*?cs\.status IN \('promoted', 'merging'\)/);
  // #2227's case: a governance proposal you opened is your work too.
  assert.match(sql, /my_governance AS \([\s\S]*?i\.status = 'open'[\s\S]*?i\.created_by = \$1/);
  // Summed, not unioned — the three statuses are disjoint, so nothing is
  // double counted and no DISTINCT is needed to say so.
  assert.match(sql, /COALESCE\(ms\.n, 0\) \+ COALESCE\(mp\.n, 0\) \+ COALESCE\(mg\.n, 0\)\) AS working/);
});

test('"needs" is the votes owed, on the lander\'s own predicate', () => {
  const sql = route.COUNTS_SQL;
  // `_devCardMatches(kind, it, { needsVote: true })`: a proposal needs your
  // vote when `status === 'promoted' && !my_vote` — NOT 'merging', which is
  // past the decision.
  assert.match(sql, /owed_proposals AS \([\s\S]*?cs\.status = 'promoted'/);
  assert.doesNotMatch(
    /owed_proposals AS \(([\s\S]*?)\n  \),/.exec(sql)[1],
    /merging/,
    'a proposal already merging is not a vote anybody still owes',
  );
  // And it is not yours: the lander's `notMine` takes your own promoted
  // proposal out of this pane even though it satisfies "waiting on you",
  // because "What you are working on" has already claimed it.
  assert.match(sql, /cs\.user_id IS DISTINCT FROM \$1/);
  assert.match(sql, /i\.created_by IS DISTINCT FROM \$1/);
  // Governance votes live in their own table and carry no epoch.
  assert.match(sql, /FROM issue_votes iv[\s\S]*?iv\.issue_id = i\.id AND iv\.user_id = \$1/);
});

test('a vote counts as cast only under the proposal\'s current approval epoch', () => {
  // services/pr-vote-revision.js owns that rule for eighteen call sites; a
  // nineteenth that spelled `pv.approval_epoch = cs.approval_epoch` by hand
  // would be a copy that stops tracking the definition. The interpolation is
  // why this query is in the reviewed dynamic SQL baseline.
  const src = read('src/routes/workshop-overview.js');
  assert.match(src, /require\('\.\.\/services\/pr-vote-revision'\)/);
  assert.match(src, /\$\{currentVotePredicateSql\('pv', 'cs'\)\}/);
  const { currentVotePredicateSql } = require('../src/services/pr-vote-revision');
  assert.ok(
    route.COUNTS_SQL.includes(currentVotePredicateSql('pv', 'cs')),
    'the rendered query carries the shared predicate, whatever it currently says',
  );
});

test('every predicate names the viewer, and the route refuses one it has not got', async () => {
  const sql = route.COUNTS_SQL;
  // Five populations, each gated on $1. Without this the anonymous case is
  // not a smaller answer, it is the whole platform's.
  assert.equal((sql.match(/\$1/g) || []).length, 8,
    'the viewer appears in every CTE predicate and in the collaborator join');

  // The refusal itself, driven rather than grepped: `getPool` is called once
  // when the router is built, so a stub config is all it takes.
  const router = route.workshopOverviewRoutes({ databaseUrl: 'postgres://stub/stub' });
  const layer = router.stack.find((l) => l.route?.path === '/api/workshop/counts');
  assert.ok(layer, 'GET /api/workshop/counts is registered');
  let status = null;
  let body = null;
  await layer.route.stack[0].handle(
    { user: null, query: {}, params: {} },
    { status(code) { status = code; return this; }, json(payload) { body = payload; return this; } },
    () => {},
  );
  assert.equal(status, 401, 'no session, no counts — never a platform-wide tally');
  assert.deepEqual(body, { error: 'Not authenticated' });
});

test('the visibility filter is GET /api/apps\'s, so the two lists cannot disagree', () => {
  const sql = route.COUNTS_SQL;
  assert.match(sql, /\(NOT a\.self_hosted OR \$2::boolean\)/);
  assert.match(sql, /\(\$3::boolean OR a\.view_visibility = 'public' OR me\.user_id IS NOT NULL\)/);
  assert.match(read('src/routes/apps.js'), /\(NOT a\.self_hosted OR \$1::boolean\)/,
    'the clause this mirrors is still the one /api/apps applies');
  // And only apps with something on them are returned: the client reads a
  // missing slug as two zeroes, so a row per app would be payload for nothing.
  assert.match(sql, /\+ COALESCE\(op\.n, 0\) \+ COALESCE\(og\.n, 0\)\) > 0/);
});

test('the demo overlay never overwrites a real count', () => {
  const { withDemoCounts, DEMO_COUNTS } = route;
  // `issues` survives the staging clone, so a preview can have genuine
  // governance rows against a slug the overlay also names.
  const real = { 'staging-demo-your-app': { working: 7, needs: 0 } };
  const out = withDemoCounts(real);
  assert.deepEqual(out['staging-demo-your-app'], { working: 7, needs: 0 });
  assert.deepEqual(out['staging-demo-emoji-icon'], DEMO_COUNTS['staging-demo-emoji-icon']);
  assert.ok(Object.keys(DEMO_COUNTS).includes('staging-demo-your-app'),
    'the one demo row Home.isYours accepts has to be one of these, or the '
    + 'declared checks read a screen of zeroes');
  // Keyed to the rows GET /api/apps injects under the same flag, so a rename
  // there does not silently leave this pointing at nothing.
  const appsJs = read('src/routes/apps.js');
  for (const slug of Object.keys(DEMO_COUNTS)) {
    assert.ok(appsJs.includes(`'${slug}'`),
      `${slug} is still a demo row in src/routes/apps.js`);
  }
});

// ── 2. The screen ──────────────────────────────────────────────────────

test('the prerendered screen is hidden and its list is empty', () => {
  const html = renderComponent('frontend/src/features/workshop/index.tsx', 'WorkshopScreen', {});
  assert.match(html, /<main id="workshop-screen" class="hidden /,
    'the root ships hidden, with `hidden` first in a CONSTANT class string — '
    + 'useVisibilityHiddenClass writes that class, so React must not re-render it');
  const list = /<div id="workshop-list"[^>]*>([\s\S]*?)<p id="workshop-empty"/.exec(html);
  assert.ok(list, 'the list and the empty line are both in the prerender');
  assert.ok(!/data-workshop-app/.test(list[1]),
    'no rows in the first render — a fetch during render is the hydration mismatch');
  assert.match(html, /<p id="workshop-empty" class="hidden /,
    'and the empty line is hidden while the list has not answered, so an '
    + 'unloaded screen never reads as "you have no apps"');
  // The document the shell actually ships agrees.
  const shipped = read('public/index.html');
  assert.match(shipped, /<main id="workshop-screen" class="hidden /);
  assert.ok(!/data-workshop-app/.test(shipped));
});

test('a row goes to that app\'s own Workshop page, as an anchor', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const rows = mod.joinCounts([{ slug: 'notes-9206f8', name: 'Notes' }], {});
  assert.deepEqual(rows, [{ slug: 'notes-9206f8', name: 'Notes', working: 0, needs: 0 }],
    'a slug the counts endpoint said nothing about is two zeroes, not absent');
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /href=\{`\/app\/\$\{encodeURIComponent\(row\.slug\)\}\/workshop`\}/,
    'App._appUrl spells the lander /app/<slug>/workshop, so a copied address '
    + 'restores the same page cold');
  assert.match(src, /NavLink\?\.isNativeClick\?\.\(event\)/,
    'a modified click is the browser\'s — that is what makes this an anchor');
  assert.match(src, /App\?\.navigateToApp\?\.\(row\.slug, 'dev'\)/);
});

test('an app that wants a decision leads the list, and the rest keep their order', () => {
  const { orderRows } = loadTsx('frontend/src/features/workshop/index.tsx');
  const rows = orderRows([
    { slug: 'quiet-a', working: 0, needs: 0 },
    { slug: 'mine-a', working: 2, needs: 0 },
    { slug: 'quiet-b', working: 0, needs: 0 },
    { slug: 'owed-a', working: 0, needs: 1 },
    { slug: 'owed-b', working: 3, needs: 4 },
  ]);
  assert.deepEqual(rows.map((r) => r.slug),
    ['owed-a', 'owed-b', 'mine-a', 'quiet-a', 'quiet-b'],
    'votes owed, then your own work, then the quiet ones — and inside each '
    + 'band the platform\'s own "Your apps" order survives, because the sort '
    + 'is stable and the comparator answers 0');
  assert.ok(orderRows([]).length === 0);
});

test('the controller loads both reads and survives losing the counts', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore } = mod;
  const apps = [
    { slug: 'a', name: 'A', is_favorited: true },
    { slug: 'b', name: 'B', is_favorited: true },
  ];
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = { Home: { partitionApps: (list) => ({ yours: list, rest: [] }) } };
  try {
    const answers = new Map([
      ['/api/apps', { ok: true, json: async () => ({ apps }) }],
      ['/api/workshop/counts', { ok: true, json: async () => ({ counts: { b: { working: 1, needs: 2 } } }) }],
    ]);
    global.fetch = async (url) => answers.get(url) || { ok: false, json: async () => ({}) };
    await workshopController.open();
    assert.equal(workshopStore.get().open, true);
    assert.equal(workshopStore.get().error, false);
    assert.deepEqual(workshopStore.get().rows.map((r) => [r.slug, r.working, r.needs]),
      [['a', 0, 0], ['b', 1, 2]]);

    // THE COUNTS ARE THE OPTIONAL HALF. An app list with no numbers is still
    // a usable launcher; refusing to draw because one of two requests failed
    // is not. The app list is not optional, and losing it IS the error card.
    answers.set('/api/workshop/counts', { ok: false, json: async () => ({}) });
    await workshopController.reload();
    assert.equal(workshopStore.get().error, false);
    assert.deepEqual(workshopStore.get().rows.map((r) => r.needs), [0, 0]);

    answers.set('/api/apps', { ok: false, json: async () => ({}) });
    await workshopController.reload();
    assert.equal(workshopStore.get().error, true);

    // A LOAD THAT LANDS AFTER THE VIEWER LEFT PUBLISHES NOTHING. `open` is
    // the liveness flag, not decoration: without the check, a slow fetch
    // repaints a screen nobody is on and races the next entry's own load.
    answers.set('/api/apps', { ok: true, json: async () => ({ apps }) });
    workshopStore.set({ rows: [{ slug: 'kept', working: 9, needs: 9 }], error: false });
    const inFlight = workshopController.reload();
    workshopController.close();
    await inFlight;
    assert.deepEqual(workshopStore.get().rows.map((r) => r.slug), ['kept'],
      'the rows are left as they were, so a re-entry paints them at once');
    assert.equal(workshopController.isOpen(), false);
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

// ── 3. The route in, and the way back out ──────────────────────────────

test('coming back from an app re-reveals the screen', () => {
  // `_inWorkshop` and workshopController.isOpen() both stay true while the
  // viewer is inside an app they opened from here — navigateToApp reveals
  // #app-view through the kit's `after` callback, not through an exit chain,
  // so nothing clears either. A re-entry guard built on those would refuse
  // the one navigation this screen exists to support: the way back.
  const body = /\n  navigateToWorkshop\(\) \{([\s\S]*?)\n  \},/.exec(appJs);
  assert.ok(body, 'navigateToWorkshop is defined');
  assert.match(body[1], /if \(App\._inWorkshop && !App\.currentApp\) return;/,
    'the guard is the PAIR: the flag set, and no app on screen');
  assert.doesNotMatch(body[1], /workshop\?\.isOpen/,
    'not the island, which cannot tell "here" from "came from here"');
  // And both halves are written before the transition, because popstate and
  // hashchange land in the same tick — `_revealedScreen` is only assigned
  // inside the callback and would let the second run straight through.
  const beforeTransition = body[1].slice(0, body[1].indexOf('PlatformUI.transition('));
  assert.match(beforeTransition, /App\._inWorkshop = true;/);
  assert.match(beforeTransition, /App\.currentApp = null;/);
  // The other half of the same fact: nothing on the way into an app clears
  // the flag, which is what leaves the breadcrumb readable on the lander.
  const enter = appJs.slice(appJs.indexOf('  async navigateToApp('));
  const chain = enter.slice(0, enter.indexOf('PlatformUI.transition('));
  assert.doesNotMatch(chain, /_exitWorkshop/,
    'entering an app must not clear _inWorkshop — navigateToApp reads it');
});

test('#workshop is a route of its own', () => {
  assert.match(appJs, /if \(parts\[0\] === 'workshop'\) \{[\s\S]*?App\.navigateToWorkshop\(\);/,
    'restoreFromHash resolves it, so a bookmark and a cold boot both land here');
  assert.match(appJs, /navigateToWorkshop\(\) \{/);
  assert.match(appJs, /_exitWorkshop\(\) \{[\s\S]*?App\._inWorkshop = false;/);
  assert.match(appJs, /App\.setHeaderTitle\('Workshop'\)/);
  // The menu row is the door, and it sits between Home and Discover.
  const nav = /switcher-row-home([\s\S]*?)switcher-row-discover/.exec(sheetTsx);
  assert.ok(nav, 'the Platform group still runs Home → … → Discover');
  assert.match(nav[1], /id="switcher-row-workshop"/);
  assert.match(nav[1], /href="#workshop"/);
  assert.match(nav[1], /label="Workshop"/);
});

test('the app-entry breadcrumb has one writer and one clearer', () => {
  // Read by AppView._repaintDevBody to turn the Dev lander's house into a
  // real ← back to #workshop. Anything that can set it from a second place,
  // or fail to clear it, leaves an arrow pointing at a screen the viewer
  // never came from.
  const writes = appJs.match(/App\._appBackHref = /g) || [];
  assert.equal(writes.length, 2,
    'navigateToApp\'s write and _showOnlyScreen\'s clear — no more');
  assert.match(appJs, /^ {2}_appBackHref: null,$/m,
    'and the slot is declared on App with the prose that says who owns it');
  assert.match(appJs, /App\._appBackHref = App\._inWorkshop \? '#workshop' : null;/,
    'a BARE fragment: #back-btn\'s handler follows its href only when it '
    + 'startsWith("#"), and anything else falls through to navigateHome');
  assert.match(appJs, /if \(href && href\.startsWith\('#'\) && href\.length > 1\) \{/,
    'and that is still the rule the handler applies');
  // The mixed address the fragment produces — /app/<slug>/workshop#workshop —
  // is healed to /#workshop by restoreFromHash, which is what makes a
  // middle-click into a new tab land on the screen rather than the app.
  assert.match(appJs, /if \(rawHash && pathRoute && !rawHash\.startsWith\('app\/'\)\) \{/);
  assert.match(appJs, /if \(revealId !== 'app-view'\) App\._appBackHref = null;/,
    'revealing any other screen ends the app visit the breadcrumb was about');
});

test('the Dev lander points back at the Workshop screen, and only the lander', () => {
  assert.match(appViewJs, /if \(App\._appBackHref\) App\.setBackIcon\?\.\('arrow', App\._appBackHref\);/);
  // AFTER the lander's own title publish, which is inside the card-list
  // branch — the session, chat and topic sub-views all return before it, so
  // none of them inherits the arrow.
  const landerTitle = appViewJs.indexOf("App.setHeaderTitle?.(AppView.appData?.name || 'App', 'Workshop');");
  const arrow = appViewJs.indexOf('if (App._appBackHref) App.setBackIcon');
  assert.ok(landerTitle > 0 && arrow > landerTitle,
    'the override sits in the lander branch, under the title it belongs to');
  const chatBranch = appViewJs.indexOf("if (subTab === 'chat') {");
  assert.ok(chatBranch > 0 && chatBranch < landerTitle,
    'and the chat branch returns before it');
  // An arrow WITH an href is also what turns the phone's back gesture on.
  assert.match(read('frontend/src/features/header/native-back-navigation.ts'),
    /mode === 'arrow' && !!href/);
});
