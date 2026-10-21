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
//    It rotted once already, and the `issues` table is where. That table
//    holds governance proposals AND a `general` twin row per request filed
//    through the platform, so a query over it with no `kind` predicate counts
//    the whole request board as votes owed — which is what put forty-six
//    votes waiting on an app whose board had three open requests. The kinds
//    are pinned below too: in this query, and in each of the four places the
//    list is still written out by hand.
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

const { createElement, loadTsx, renderComponent, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const { tokenize } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const route = require('../src/routes/workshop-overview');
const { botRequestedBySql } = require('../src/services/bot-requested-by');
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
  // #4538: a change Homeroom bot built from a request made for the viewer is
  // in that viewer's working count too, by the shared bot-request predicate
  // on $1 — the same one /promoted selects `requested_by_me` with, so the
  // Communities row and the strip it mirrors cannot disagree. OWED is
  // untouched: the bot is not the viewer, and the viewer still votes on it.
  assert.match(read('src/routes/workshop-overview.js'),
    /OR \$\{botRequestedBySql\('cs', '\$1'\)\}/,
    'the working predicate reads the shared fragment, spelled once');
  assert.match(route.MY_PROPOSALS_WHERE, /cs\.status IN \('promoted', 'merging'\)/);
  assert.ok(route.MY_PROPOSALS_WHERE.includes(botRequestedBySql('cs', '$1')),
    'the predicate is the shared fragment, not a second copy of the rule');
  assert.doesNotMatch(
    /const OWED_PROPOSALS_WHERE = `([\s\S]*?)`;/.exec(read('src/routes/workshop-overview.js'))[1],
    /botRequestedBySql/,
    'a bot change still counts as a vote owed (the bot is not the viewer)');
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

test('the two `issues` CTEs read governance proposals, never the request board', () => {
  // `issues` is two populations wearing one table name. Beside the governance
  // proposals it holds a `general` TWIN row per request filed through the
  // platform — the row that remembers who filed it, because GitHub files every
  // platform-authored issue as the bot. Nothing votes on a twin, and
  // `AppView._govProposals` drops them before the lander's deck ever sees one.
  // Counting them here is not a rounding error: a twin is only ever closed by
  // a passed close-issue vote, so it outlives its GitHub issue indefinitely
  // and the pile only grows.
  const src = read('src/routes/workshop-overview.js');
  assert.match(src, /require\('\.\.\/services\/governance-kinds'\)/);
  assert.equal((src.match(/\$\{governanceKindsSql\('i'\)\}/g) || []).length, 2,
    'both `issues` CTEs interpolate the shared predicate rather than spelling the kinds out');

  const { GOVERNANCE_KINDS, governanceKindsSql } = require('../src/services/governance-kinds');
  const cte = (name) => new RegExp(`${name} AS \\(([\\s\\S]*?)\\n  \\)`).exec(route.COUNTS_SQL)[1];
  for (const name of ['my_governance', 'owed_governance']) {
    assert.ok(
      cte(name).includes(governanceKindsSql('i')),
      `${name} renders the shared predicate, whatever it currently says`,
    );
  }
  // Named, never negated: a sixth kind added to the table becomes a vote
  // somebody owes only once somebody lists it here, which is the safe
  // direction for a number that asks people to do something.
  assert.ok(!GOVERNANCE_KINDS.includes('general'),
    'the request board\'s twin kind is not a thing anybody votes on');
});

test('every hand-written copy of the governance kinds still agrees with the constant', () => {
  const { GOVERNANCE_KINDS } = require('../src/services/governance-kinds');
  const expected = [...GOVERNANCE_KINDS].sort();
  const quoted = (text) => (text.match(/'([a-z_]+)'/g) || []).map((q) => q.slice(1, -1)).sort();

  // Four sites still spell the list out, on purpose. Three are static query
  // text, which scripts/check-sql.js validates against a real schema —
  // interpolating would move them into the reviewed dynamic-SQL baseline, a
  // weaker guarantee than the duplication costs. The fourth is browser script
  // with no module loader. Duplication is the cheaper trade only while
  // something notices drift, which is this test.
  const sqlCopies = [
    ...(read('src/routes/issues.js').match(/kind IN \([\s\S]*?\)/g) || []),
    ...(read('src/services/shared-objects.js').match(/kind IN \([\s\S]*?\)/g) || []),
  ];
  assert.equal(sqlCopies.length, 3,
    'a query reading `issues` by kind was added or removed; pin it here too');
  for (const copy of sqlCopies) assert.deepEqual(quoted(copy), expected);

  // And the client's, which is what the lander's "Needs your vote" deck is
  // actually built from. A kind missing there is a proposal nobody is asked
  // to vote on, however right the server's count is.
  const clientFilter = /_govProposals = [\s\S]*?\.filter\(\(i\) =>([\s\S]*?)\);/.exec(appViewJs);
  assert.ok(clientFilter, 'the client still filters `_govProposals` by kind');
  assert.deepEqual(quoted(clientFilter[1]), expected);
});

test('every predicate names the viewer, and the route refuses one it has not got', async () => {
  const sql = route.COUNTS_SQL;
  // Five populations, each gated on $1. Without this the anonymous case is
  // not a smaller answer, it is the whole platform's. #4538 added a ninth:
  // MY_PROPOSALS_WHERE's bot-request predicate, also on $1.
  assert.equal((sql.match(/\$1/g) || []).length, 9,
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
  // As /api/apps also does, a suspended app is left out for everyone: it
  // refuses to open, so a count, item or card for it would lead nowhere.
  for (const [name, q] of [['COUNTS_SQL', sql], ['ITEMS_SQL', route.ITEMS_SQL], ['NEEDS_FEED_SQL', route.NEEDS_FEED_SQL]]) {
    assert.match(q, /a\.moderation_suspended_at IS NULL\s+AND \(NOT a\.self_hosted OR \$2::boolean\)/,
      `${name} leaves out suspended apps`);
  }
  assert.match(read('src/routes/apps.js'), /WHERE a\.moderation_suspended_at IS NULL AND \(NOT a\.self_hosted OR \$1::boolean\)/);
  assert.match(read('src/routes/apps.js'), /\(NOT a\.self_hosted OR \$1::boolean\)/,
    'the clause this mirrors is still the one /api/apps applies');
  // And only apps with something on them are returned: the client reads a
  // missing slug as two zeroes, so a row per app would be payload for nothing.
  assert.match(sql, /\+ COALESCE\(op\.n, 0\) \+ COALESCE\(og\.n, 0\)\) > 0/);
});

test('#5023: the Workshop asks GET /api/apps for joined rows only, not the whole catalog', () => {
  const apps = read('src/routes/apps.js');
  assert.match(apps, /const joinedOnly = req\.query\.scope === 'joined' && userId != null;/);
  assert.match(apps, /AND \(NOT \$4::boolean OR cm\.user_id IS NOT NULL\)/,
    'the filter is the is_member column\'s own join, so a kept row is one the client kept before');
  assert.match(apps, /\[showSelfHosted, userId, isAdmin, joinedOnly\]/);
  for (const file of ['frontend/src/features/workshop/index.tsx', 'frontend/src/features/workshop/community-scope.ts']) {
    assert.match(read(file), /fetch\(`\/api\/apps\?scope=joined\$\{/, `${file} reads the joined scope`);
  }
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
  // Keyed to persisted catalog fixtures, so a rename cannot leave the
  // workshop's sample counts pointing at nonexistent apps.
  const appsJs = read('src/services/staging-apps.js');
  for (const slug of Object.keys(DEMO_COUNTS)) {
    assert.ok(appsJs.includes(`'${slug}'`),
      `${slug} is still a stored catalog fixture`);
  }
});

// ── 2. The screen ──────────────────────────────────────────────────────

/**
 * The one element carrying `id="workshop-empty"`, as its opening tag.
 *
 * Anchored to the ID rather than to a tag name or a whole-document regex: the
 * id is the API (dapp.json selects it, see below), the element it sits on is
 * this screen's to choose, and a test that pins the tag would have to be
 * rewritten by every restyle for no reader's benefit. It asserts there is
 * exactly ONE such element, which is the failure mode that matters — a
 * conversion that leaves the id on a wrapper AND on the card inside it
 * resolves the declared check against whichever comes first.
 */
function emptyTag(html) {
  const all = html.match(/<[a-z]+\b[^>]*\bid="workshop-empty"[^>]*>/g) || [];
  assert.equal(all.length, 1,
    'exactly one element carries id="workshop-empty" — dapp.json selects it');
  return all[0];
}

test('the prerendered screen is hidden and its list has no rows', () => {
  const html = renderComponent('frontend/src/features/workshop/index.tsx', 'WorkshopScreen', {});
  assert.match(html, /<main id="workshop-screen" class="hidden /,
    'the root ships hidden, with `hidden` first in a CONSTANT class string — '
    + 'useVisibilityHiddenClass writes that class, so React must not re-render it');
  assert.ok(!/data-workshop-app/.test(html),
    'no rows in the first render — a fetch during render is the hydration mismatch');
  assert.match(emptyTag(html), /\bclass="[^"]*\bhidden\b/,
    'and the empty card is hidden while the list has not answered, so an '
    + 'unloaded screen never reads as "you have no apps"');
  // THE CARD IS THE LIST'S FIRST CHILD, not its last, and that is structural
  // rather than cosmetic: GroupedList's row separator is
  // `[&:not(:last-child)]:after:*` on the ROW, so a note after the rows would
  // leave the last one drawing a hairline under nothing.
  const list = /<div[^>]*id="workshop-list"[^>]*>([\s\S]*?)$/.exec(html);
  assert.ok(list, '#workshop-list is in the prerender');
  assert.match(list[1].trimStart(), /^<div\b[^>]*id="workshop-empty"/);
  // The document the shell actually ships agrees.
  const shipped = read('public/index.html');
  assert.match(shipped, /<main id="workshop-screen" class="hidden /);
  assert.ok(!/data-workshop-app/.test(shipped));
});

// ── The empty state is a CARD (#2445) ──────────────────────────────────
//
// The UI consistency audit (#2383) found this one as a grey caption line
// where the rest of the product answers "there is nothing here" with a card
// that offers the next step: a title, a quieter second line and a trailing
// chevron, the whole plate tapping through. Home's Discover block took the
// same correction in #1913 (features/home/panels/discover.tsx) and lands on
// the same `#apps` directory, which is why that card is the specification
// here rather than a new shape.
//
// The two assertions below are separate on purpose. The first is about the
// LANGUAGE and may move with it. The second is a CONTRACT with dapp.json and
// may not.

test('the empty state is a card that offers the directory, not a grey caption', () => {
  const html = renderComponent('frontend/src/features/workshop/index.tsx', 'WorkshopScreen', {});
  const tag = emptyTag(html);

  // Title over subtitle over chevron, drawn by ListRow rather than by hand,
  // so the card is the same object every other row on this screen is. The card
  // is the anchor INSIDE the id-carrying wrapper — see the ordering test below
  // for why it may not be the wrapper itself.
  const from = html.indexOf(tag) + tag.length;
  const end = html.indexOf('</a>', from);
  assert.ok(end > from, 'the card inside it has an end tag');
  const inner = html.slice(from, end);

  // A link, so cmd-click, middle-click and "open in new tab" work — the same
  // argument AppRow makes for being an anchor.
  assert.match(inner, /^<div\b[^>]*>\s*<a\b[^>]*\bhref="#apps"/,
    'the card (a GroupedList of its own) is an anchor, and it goes where '
    + 'Discover\'s own empty card goes — the directory, where you join');

  assert.match(inner, /font-\[650\][^"]*">You haven’t joined anything yet</,
    'a title in the row\'s own subject weight — the list is the communities '
    + 'you are in, so the empty state says you are in none');
  assert.match(inner, /text-zinc-500[^"]*">Browse the directory to find a project to join\.</,
    'a quieter second line under it');
  assert.match(inner, /<svg[^>]*>\s*<path[^>]*d="M9 5l7 7-7 7"/,
    'and ListRow\'s trailing disclosure chevron — the "tap through" mark the '
    + 'audit says the caption was missing');

  // The old caption's shape is gone, not merely covered over.
  assert.doesNotMatch(html, /<p[^>]*id="workshop-empty"/,
    'the grey caption paragraph is retired');
  assert.doesNotMatch(html, /Find apps to add in the Discover section/,
    'and so is its sentence');
});

test('the empty card keeps the id and the `hidden` toggle dapp.json selects', () => {
  // dapp.json asserts `#workshop-empty.hidden` once the list has rows: the
  // card must therefore STAY IN THE DOCUMENT and be hidden by a class, never
  // be conditionally rendered away, and the id must stay on the element the
  // check resolves to rather than on a child of it.
  const dapp = read('dapp.json');
  assert.ok(dapp.includes('#workshop-empty.hidden'),
    'the declared check still selects the class toggle — if this line has to '
    + 'change, the markup change is wrong, not the check');

  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /id="workshop-empty" className=\{empty \? '' : 'hidden'\}/,
    'the id and the class toggle are on ONE element, and visibility is a '
    + 'class on it — the element is always rendered');

  // Both states, through the component rather than through the source. One
  // module instance for both renders: loadTsx bundles afresh on every call,
  // so a store written through a second copy would not be the one the
  // component reads.
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const render = () => emptyTag(renderToHtml(createElement(mod.WorkshopScreen, {})));

  assert.match(render(), /\bclass="[^"]*\bhidden\b/,
    'unanswered list: hidden, so the screen never reads as "you have no apps" '
    + 'before the fetch lands');

  mod.workshopStore.set({ open: true, rows: [], error: false });
  const shown = render();
  assert.doesNotMatch(shown, /\bclass="[^"]*\bhidden\b/,
    'an account with no apps: the same element, with the class off');

  mod.workshopStore.set({ rows: [{ slug: 'notes-9206f8', name: 'Notes', working: 0, needs: 0 }] });
  const withRows = render();
  assert.match(withRows, /\bclass="[^"]*\bhidden\b/,
    'a list with rows: the element is STILL THERE and hidden, which is the '
    + 'state dapp.json\'s `#workshop-empty.hidden` resolves against — '
    + 'conditional rendering would leave that check nothing to match');
});

/**
 * The direct element children of `#workshop-list`, as { tag, attrs }.
 *
 * `:first-of-type` is about SIBLINGS, so a regex over the flat string cannot
 * answer the question this file now has to ask; the repo's own tokenizer can.
 */
function listChildren(html) {
  const tokens = tokenize(html);
  const start = tokens.findIndex(
    (t) => t.kind === 'open' && t.attrs.some((a) => a.name === 'id' && a.value === 'workshop-list'),
  );
  assert.ok(start >= 0, '#workshop-list is in the render');
  const out = [];
  let depth = 0;
  for (const t of tokens.slice(start + 1)) {
    if (t.kind === 'open') {
      if (depth === 0) {
        const attrs = {};
        for (const a of t.attrs) attrs[a.name] = a.value === null ? '' : a.value;
        out.push({ tag: t.tag, attrs });
      }
      if (!t.selfClosing) depth++;
    } else if (t.kind === 'close') {
      if (depth === 0) break; // the list's own close tag
      depth--;
    }
  }
  return out;
}

test('#5296: #workshop-list holds the empty card, then ONE list of every community, under audience chips', () => {
  // THE LIST IS A WRAPPER (communities). Its children are the empty card and
  // one GroupedList of every row; it held one card per audience section, three
  // rows each behind "Show N more", until #5296. The declared checks select
  // through it with DESCENDANT combinators (`#workshop-list
  // a[data-workshop-app=…]`), so what this pins is the tree they resolve
  // against.
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const html = () => renderToHtml(createElement(mod.WorkshopScreen, {}));

  // The demo payload the declared check runs against (/?demo=1#workshop):
  // src/routes/apps.js demoIconApps' three member rows, one per audience.
  mod.workshopStore.set({
    open: true,
    error: false,
    tab: 'status',
    rows: [
      { slug: 'staging-demo-emoji-icon', name: 'Emoji', audience: 'solo', last_active_at: '2026-09-24T10:00:00Z', working: 0, needs: 5 },
      { slug: 'staging-demo-long-name', name: 'Long', audience: 'invited', member_count: 4, last_active_at: '2026-09-25T09:00:00Z', working: 4, needs: 1 },
      { slug: 'staging-demo-your-app', name: 'Your app', audience: 'open', member_count: 12, last_active_at: '2026-09-25T11:30:00Z', working: 2, needs: 3 },
    ],
  });

  const kids = listChildren(html());
  assert.equal(kids[0].attrs.id, 'workshop-empty', 'the empty card first');
  assert.notEqual(kids[0].tag, 'a', 'a wrapper, never an anchor among the rows');
  assert.match(kids[0].attrs.class || '', /\bhidden\b/, 'and hidden while there are rows');
  assert.equal(kids.length, 2, 'then one card, not a section per audience');
  assert.equal(kids[1].attrs['data-workshop-rows'], 'all', 'the card says which chip it shows');

  const out = html();
  assert.doesNotMatch(out, /data-workshop-section=/, 'no sections on the page');
  assert.doesNotMatch(out, /data-workshop-more=/, 'and no "Show N more"');
  assert.deepEqual([...out.matchAll(/data-workshop-app="([^"]+)"/g)].map((m) => m[1]),
    ['staging-demo-your-app', 'staging-demo-long-name', 'staging-demo-emoji-icon'], 'every row, most recent first');
  // The chips: All pressed, then the audiences in the order the sections had.
  assert.deepEqual([...out.matchAll(/data-workshop-chip="([^"]+)"/g)].map((m) => m[1]), ['all', 'open', 'invited', 'solo']);
  assert.match(out, /aria-pressed="true"[^>]*data-workshop-chip="all"|data-workshop-chip="all"[^>]*aria-pressed="true"/);
  assert.match(out, /aria-label="All, 3 communities"/);
  assert.match(out, /aria-label="1 in Public communities"/);
  for (const label of ['All', 'Public', 'Private', 'Just you']) {
    assert.match(out, new RegExp(`<span>${label}</span>`), `the ${label} chip is drawn`);
  }
  // The search box heads the list at every width, not only beside the sidebar.
  assert.match(out, /id="workshop-search"/);
  assert.match(out, /data-workshop-audience="invited"/, 'each row says its audience');
  assert.match(out, />12 members</, 'and its second line says who is in it');
  mod.workshopStore.set({ open: false, rows: null });
});

test('#5296: the chips and the search narrow the one list', () => {
  const { filterRows, audienceTallies } = loadTsx('frontend/src/features/workshop/index.tsx');
  const rows = [
    { slug: 'garden', name: 'Garden club', audience: 'open', working: 0, needs: 0 },
    { slug: 'flat', name: 'Flat 4B', audience: 'invited', working: 0, needs: 0 },
    { slug: 'notes', name: 'Notes', audience: 'solo', working: 0, needs: 0 },
    { slug: 'odd', name: 'Garden odd', audience: 'mystery', working: 0, needs: 0 },
  ];
  assert.deepEqual(filterRows(rows, 'all', '').map((r) => r.slug), ['garden', 'flat', 'notes', 'odd'], 'All is every row');
  assert.deepEqual(filterRows(rows, 'open', '').map((r) => r.slug), ['garden', 'odd'], 'an unknown audience reads as public');
  assert.deepEqual(filterRows(rows, 'solo', '').map((r) => r.slug), ['notes']);
  assert.deepEqual(filterRows(rows, 'all', 'garden').map((r) => r.slug), ['garden', 'odd'], 'the search matches names');
  assert.deepEqual(filterRows(rows, 'invited', 'garden'), [], 'inside the pressed chip');
  assert.deepEqual(audienceTallies(rows), { all: 4, open: 2, invited: 1, solo: 1 });
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /return matchRows\(inAudience, query\);/, 'the search is the drawer\'s own matcher');
  assert.match(src, /const q = query\.trim\(\);/, 'at every width');
});

test('#5296: every community is out at once, and an empty audience\'s chip is hidden', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const rows = Array.from({ length: 12 }, (_, i) => ({
    slug: `c${i}`, name: `C${i}`, audience: 'open', member_count: 3,
    last_active_at: new Date(Date.UTC(2026, 8, 20 - i)).toISOString(), working: 0, needs: 0,
  }));
  mod.workshopStore.set({ open: true, error: false, tab: 'status', rows });
  const html = renderToHtml(createElement(mod.WorkshopScreen, {}));
  assert.equal([...html.matchAll(/data-workshop-app="/g)].length, 12, 'all twelve, no fold');
  assert.doesNotMatch(html, /Show \d+ more/);
  assert.match(html, /class="[^"]*\bhidden\b[^"]*"[^>]*data-workshop-chip="solo"|data-workshop-chip="solo"[^>]*class="[^"]*\bhidden\b/,
    'a zero says nothing, and the chip stays in the document');
  mod.workshopStore.set({ open: false, rows: null });
});

test('UX audit: the chip rail fades while more chips are past its edge', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const out = renderToHtml(createElement(mod.AudienceChips, {
    tallies: { all: 3, open: 2, invited: 1, solo: 1 },
    pressed: 'all',
    onPress: () => {},
    scope: 'workshop',
  }));
  assert.match(out, /class="[^"]*\baudience-chips\b/, 'the rail says which row it is');
  assert.doesNotMatch(out, /data-more/, 'no fade until a measurement says there is more');
  const src = read('frontend/src/features/workshop/index.tsx');
  const fn = src.slice(src.indexOf('export function AudienceChips'));
  assert.match(fn, /el\.scrollLeft \+ el\.clientWidth < el\.scrollWidth - 1/,
    'more means a chip lies past the right edge');
  assert.match(fn, /'data-more': ''/, 'and that is what turns the fade on');
  const css = read('public/css/app.css');
  assert.match(css, /\.audience-chips\[data-more\] \{[\s\S]{0,300}mask-image: linear-gradient\(to right, #000 calc\(100% - 2rem\), transparent\)/,
    'the same 2rem fade Home\'s Discover lane uses');
});

test('UX audit: the search clears the Needs you card it follows', () => {
  // The card's section had no bottom margin, so the field touched it. The gap
  // only applies when something heads the list (the card or its skeleton).
  const css = read('public/css/app.css');
  assert.match(css, /section \+ \.workshop-search \{\s*margin-top: 12px;/);
});

test('the screen is built from the grouped-list primitives, not a copy of them', () => {
  // AGENTS.md: "a primitive nobody knows exists gets hand-written instead."
  // GroupedList / SectionHeader / ListRow ARE the widget language's primary
  // content shape — the section label over a borderless white card of
  // hairline-separated rows — and an earlier cut of this screen hand-rolled
  // all three, with a ring, a backdrop blur and `divide-y`, none of which the
  // language draws any more.
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /from '@\/components\/ui\/grouped-list'/);
  // SectionHeader left this list with the screen's own <h1> (#2718 review):
  // the bar above already says Workshop, and the one group on this screen is
  // the whole of it, so there is no group WITHIN a screen left to label.
  for (const name of ['GroupedList', 'ListRow']) {
    assert.match(src, new RegExp(`\\b${name}\\b`), `${name} is used`);
  }
  for (const wrong of [/\bdivide-y\b/, /\bbackdrop-blur/, /\bring-1\b/, /rounded-\[22px\]/]) {
    assert.doesNotMatch(src, wrong,
      'the card has no border, no blur and no hand-rolled radius — the '
      + 'language separates by figure/ground and GroupedList owns the shape');
  }
  // The leading tile is app.css's one face at the primitive's own geometry,
  // exactly as features/apps/browse-list.tsx draws it.
  assert.match(src, /app-icon-tile w-11 h-11 shrink-0 rounded-xl/);
  assert.match(src, /data-icon=\{appIconKind/);
});

test('a row goes to that app\'s own Workshop page, as an anchor', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const rows = mod.joinCounts([{ slug: 'notes-9206f8', name: 'Notes' }], {});
  assert.deepEqual(rows, [{ slug: 'notes-9206f8', name: 'Notes', working: 0, needs: 0 }],
    'a slug the counts endpoint said nothing about is two zeroes, not absent');
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /const href = `\/app\/\$\{encodeURIComponent\(row\.slug\)\}\/workshop`;[\s\S]{0,80}href=\{href\}/,
    'App._appUrl spells the lander /app/<slug>/workshop, so a copied address '
    + 'restores the same page cold');
  // Beside the sidebar a row pins or unpins its community from its
  // right-click menu, which keeps the link's Open in new tab (18 Oct 2026).
  assert.match(src, /onContextMenu=\{pinnable \? \(event: MouseEvent<HTMLElement>\) => \{\s*openPinMenu\(event, \{ slug: row\.slug,[^}]*\}, href\);/);
  assert.match(src, /NavLink\?\.isNativeClick\?\.\(event\)/,
    'a modified click is the browser\'s — that is what makes this an anchor');
  assert.match(src, /App\?\.navigateToApp\?\.\(row\.slug, 'dev'\)/);
});

test('rows go most recently active first; undated ones last, in the server\'s order', () => {
  const { orderRows } = loadTsx('frontend/src/features/workshop/index.tsx');
  const rows = orderRows([
    { slug: 'undated-a', working: 0, needs: 0, last_active_at: null },
    { slug: 'old', working: 0, needs: 4, last_active_at: '2026-09-01T00:00:00Z' },
    { slug: 'undated-b', working: 0, needs: 0 },
    { slug: 'new', working: 0, needs: 0, last_active_at: '2026-09-25T00:00:00Z' },
    { slug: 'mid', working: 2, needs: 0, last_active_at: '2026-09-20T00:00:00Z' },
  ]);
  assert.deepEqual(rows.map((r) => r.slug), ['new', 'mid', 'old', 'undated-a', 'undated-b'],
    'recency, not urgency: an ordering by "needs you" is how a quiet project '
    + 'falls off the bottom, and the counts on each row already say which ones '
    + 'are asking — and the sort is stable, so ties keep the server\'s order');
  assert.ok(orderRows([]).length === 0);
  // A ?demo=1 fixture row leads, whatever its time: on a staging clone the
  // backfill stamps every real membership newer than the fixture, and the
  // declared checks look for the fixture inside a section's first three.
  const withDemo = orderRows([
    { slug: 'real-new', working: 0, needs: 0, last_active_at: '2026-09-25T12:00:00Z' },
    { slug: 'staging-demo-your-app', demo: true, working: 2, needs: 3, last_active_at: '2026-09-01T00:00:00Z' },
    { slug: 'real-old', working: 0, needs: 0, last_active_at: '2026-09-02T00:00:00Z' },
  ]);
  assert.deepEqual(withDemo.map((r) => r.slug), ['staging-demo-your-app', 'real-new', 'real-old']);
});

test('groupRows: three sections in order, empty ones left out, an unknown audience read as open', () => {
  const { groupRows, SECTIONS, SECTION_LIMIT } = loadTsx('frontend/src/features/workshop/index.tsx');
  // A section's label is a message id; the words are what the English catalog holds for it.
  assert.deepEqual(SECTIONS.map((s) => [s.key, s.label]),
    [['open', 'communities:sections.open.label'], ['invited', 'communities:sections.invited.label'], ['solo', 'communities:sections.solo.label']]);
  assert.deepEqual(SECTIONS.map((s) => [s.key, message(s.label)]),
    [['open', 'Public communities'], ['invited', 'Private communities'], ['solo', 'Just you']]);
  assert.equal(SECTION_LIMIT, 3, 'three most recent, then "Show N more"');
  const out = groupRows([
    { slug: 'a', audience: 'solo', last_active_at: '2026-09-02T00:00:00Z', working: 0, needs: 0 },
    { slug: 'b', audience: 'open', last_active_at: '2026-09-01T00:00:00Z', working: 0, needs: 0 },
    { slug: 'c', audience: 'mystery', last_active_at: '2026-09-03T00:00:00Z', working: 0, needs: 0 },
    { slug: 'd', audience: 'solo', last_active_at: '2026-09-04T00:00:00Z', working: 0, needs: 0 },
  ]);
  assert.deepEqual(out.map((s) => [s.key, s.rows.map((r) => r.slug)]),
    [['open', ['c', 'b']], ['solo', ['d', 'a']]],
    'no Private communities section when there are none, and a row is never dropped');
});

test('"Show N more" reveals five at a time, then folds back (#3269)', () => {
  const { sectionFold, SECTION_STEP } = loadTsx('frontend/src/features/workshop/index.tsx');
  assert.equal(SECTION_STEP, 5);
  // Twelve rows: 3, then 8, then 12, then back to 3.
  let fold = sectionFold(12, 3);
  assert.deepEqual(fold, { shown: 3, label: 'Show 5 more', next: 8 });
  fold = sectionFold(12, fold.next);
  assert.deepEqual(fold, { shown: 8, label: 'Show 4 more', next: 13 }, 'the last press names what is left');
  fold = sectionFold(12, fold.next);
  assert.deepEqual(fold, { shown: 12, label: 'Show fewer', next: 3 });
  assert.deepEqual(sectionFold(12, fold.next), { shown: 3, label: 'Show 5 more', next: 8 });
  // Three or fewer: no fold at all.
  assert.deepEqual(sectionFold(3, 3), { shown: 3, label: null, next: 3 });
  assert.equal(sectionFold(0, 3).label, null);
});

test('rowSubtitle: one short fact, members for a community or group, recency for "Just you"', () => {
  const { rowSubtitle } = loadTsx('frontend/src/features/workshop/index.tsx');
  const now = Date.parse('2026-09-25T12:00:00Z');
  assert.equal(rowSubtitle({ slug: 'x', audience: 'open', member_count: 12, last_active_at: '2026-09-25T10:00:00Z', working: 0, needs: 0 }, now),
    '12 members', 'the section\'s order already says which moved last');
  assert.equal(rowSubtitle({ slug: 'x', audience: 'invited', member_count: 1, working: 0, needs: 0 }, now), '1 member');
  assert.equal(rowSubtitle({ slug: 'x', audience: 'solo', member_count: 1, last_active_at: '2026-09-25T11:55:00Z', working: 0, needs: 0 }, now),
    '5m ago', 'just you: when it last moved, never "1 member"');
  assert.equal(rowSubtitle({ slug: 'x', audience: 'solo', last_active_at: '2026-09-22T12:00:00Z', working: 0, needs: 0 }, now), '3d ago');
  assert.equal(rowSubtitle({ slug: 'x', audience: 'open', member_count: 0, working: 0, needs: 0 }, now), '');
  assert.equal(rowSubtitle({ slug: 'x', audience: 'solo', last_active_at: null, working: 0, needs: 0 }, now), '');
});

test('15 Oct 2026: a project with an invite link out and nobody in yet says "Invite link out", and stays under Just you', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const now = Date.parse('2026-09-25T12:00:00Z');
  const row = (over = {}) => ({
    slug: 'garden', name: 'Garden', audience: 'solo', member_count: 1, last_active_at: '2026-09-25T11:55:00Z',
    working: 0, needs: 0, ...over,
  });
  assert.equal(mod.rowSubtitle(row({ invite_link_out: true }), now), 'Invite link out', 'in place of when it last moved');
  assert.equal(mod.rowSubtitle(row({ invite_link_out: false }), now), '5m ago');
  assert.equal(mod.rowSubtitle(row(), now), '5m ago', 'an older server without the field: as before');
  assert.equal(message('communities:row.inviteOut'), 'Invite link out');
  // Which section it sits in is its audience's: a link out is not a member.
  mod.workshopStore.set({ open: true, error: false, tab: 'status', rows: [row({ invite_link_out: true }), row({ slug: 'club', name: 'Club', audience: 'invited', member_count: 3 })] });
  const html = renderToHtml(createElement(mod.WorkshopScreen, {}));
  assert.match(html, /data-workshop-app="garden"[\s\S]*?Invite link out/, 'saying so');
  assert.match(html, /data-workshop-app="garden" data-workshop-audience="solo"/, 'under Just you (its chip)');
  assert.deepEqual(mod.filterRows(mod.workshopStore.get().rows, 'invited', '').map((r) => r.slug), ['club'], 'not among the groups');
  mod.workshopStore.set({ open: false, rows: null });
  // One read for the whole list (GET /api/apps), never one per project; the
  // server says it only while nobody else is in it.
  const route = read('src/routes/apps.js');
  assert.match(route, /linksOut = await communityInvites\.linksOutFor\(pool, rows\.filter\(\(a\) => a\.is_member\)\.map\(\(a\) => a\.id\), userId\);/);
  assert.match(route, /invite_link_out: inviteLinkOut\(linksOut\.get\(Number\(a\.id\)\), a\.member_count\),/);
  const { inviteLinkOut } = require('../src/routes/apps');
  assert.equal(inviteLinkOut({ links: 1, joined: 0 }, 1), true);
  assert.equal(inviteLinkOut({ links: 2, joined: 1 }, 1), false, 'somebody came in through one');
  assert.equal(inviteLinkOut({ links: 1, joined: 0 }, '2'), false, 'somebody else is in it');
  assert.equal(inviteLinkOut(undefined, 1), false, 'no live link out');
  assert.equal(inviteLinkOut({ links: 0, joined: 0 }, 1), false);
  // It does not move the row: the audience is derived as it always was.
  assert.doesNotMatch(read('src/services/communities.js').slice(0, read('src/services/communities.js').indexOf('async function isMember(')), /community_invites/);
});

test('a row says its status in words, leaves zeroes out, and keeps both numbers in the document', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const line = (working, needs) => renderToHtml(createElement(mod.StatusLine, { working, needs }));
  const both = line(2, 3);
  assert.match(both, /<span data-workshop-working="2" class="[^"]*">2 in progress<\/span><span data-workshop-needs="3" class="[^"]*violet[^"]*">/,
    'working then needs, adjacent siblings: the declared check reads `[data-workshop-working] + [data-workshop-needs]`');
  assert.match(both, />3 to vote<\/span>$/);
  assert.match(both, /aria-hidden="true"> · </, 'the separator is decoration');
  const quiet = line(0, 0);
  assert.match(quiet, /data-workshop-working="0" class="hidden"/, 'a zero says nothing');
  assert.match(quiet, /data-workshop-needs="0" class="hidden"/);
  assert.doesNotMatch(line(0, 1), / · /, 'no separator ahead of the only half showing');
  assert.doesNotMatch(read('frontend/src/features/workshop/index.tsx'), /function Count\(/,
    'the glyph pills are gone from the rows');
});

test('#5296: a row has one pill, its votes, and the channel count steps aside for it', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const pill = renderToHtml(createElement(mod.VotePill, { count: 3 }));
  assert.match(pill, /data-workshop-vote-pill="3"[^>]*class="[^"]*rounded-full[^"]*violet/);
  assert.match(pill, />3 to vote<\/span>$/);
  // In the row the words stay in the document for the checks' adjacency, undrawn.
  const line = renderToHtml(createElement(mod.StatusLine, { working: 2, needs: 3, needsInPill: true }));
  assert.match(line, /data-workshop-working="2" class="[^"]*">2 in progress<\/span><span data-workshop-needs="3" class="hidden">/);
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /trailing=\{row\.needs > 0 \? <VotePill count=\{row\.needs\} \/> : null\}/,
    'the votes and nothing else: the unread is said in grey words on the second line (#18)');
  assert.match(src, /<StatusLine working=\{row\.working\} needs=\{row\.needs\} needsInPill \/>/);
  mod.workshopStore.set({
    open: true, error: false, tab: 'status',
    rows: [{ slug: 'garden', name: 'Garden', audience: 'open', member_count: 3, working: 0, needs: 2, owed: ['proposal:1@0', 'proposal:2@0'] }],
  });
  const html = renderToHtml(createElement(mod.WorkshopScreen, {}));
  assert.equal([...html.matchAll(/data-workshop-vote-pill="2"/g)].length, 1, 'one pill on the row');
  mod.workshopStore.set({ open: false, rows: null });
});

test('#5296: the page counts votes the way the tab does, so the two say the same number', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const rows = mod.joinCounts(
    [{ slug: 'homeroom', name: 'Homeroom', audience: 'open' }, { slug: 'flat', name: 'Flat', audience: 'invited' }],
    {
      homeroom: { working: 0, needs: 5, owed: ['proposal:11@0', 'proposal:12@0', 'proposal:13@0', 'proposal:14@0', 'governance:5'], unchosen: true },
      flat: { working: 0, needs: 1, owed: ['proposal:90@0'] },
    },
  );
  assert.equal(rows[0].unchosen, true, 'the counts\' flag rides on the row');
  assert.equal(rows[1].unchosen, undefined);
  const seen = rows.map(mod.unseenRow);
  assert.deepEqual(seen.map((r) => [r.slug, r.needs, r.owedCount]), [['homeroom', 0, 0], ['flat', 1, 1]],
    'an unchosen community\'s votes wait on nobody, here as on the tab');
  mod.workshopStore.set({ open: true, error: false, tab: 'status', rows });
  const html = renderToHtml(createElement(mod.WorkshopScreen, {}));
  assert.match(html, /1 vote waiting on you/, 'the tab\'s 1, not 6');
  assert.doesNotMatch(html, /data-workshop-vote-pill="5"/);
  mod.workshopStore.set({ open: false, rows: null });
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /import \{ takeCounts, votesWaiting \} from '\.\/community-scope';/, 'one definition, the tab\'s');
  assert.equal([...src.matchAll(/takeCounts\(/g)].length, 2, 'and both counts reads hand their answer to the tab');
  const scope = read('frontend/src/features/workshop/community-scope.ts');
  assert.match(scope, /badgeNeeds \+= votesWaiting\(info\[s\]\);/);
  assert.match(scope, /if \(st\.slug\) return votesWaiting\(st\.info\[st\.slug\]\);/);
});

test('the controller loads both reads and survives losing the counts', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore } = mod;
  // The list is MEMBERSHIP (Home.isJoined), not Home's "Your apps": a pin
  // alone ('pinned') is a shortcut, and is not one of your communities.
  const apps = [
    { slug: 'a', name: 'A', is_member: true },
    { slug: 'b', name: 'B', is_member: true },
    { slug: 'pinned', name: 'Pinned', is_favorited: true },
  ];
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = { Home: { isJoined: (app) => !!(app && app.is_member) } };
  try {
    const answers = new Map([
      ['/api/apps?scope=joined', { ok: true, json: async () => ({ apps }) }],
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

    answers.set('/api/apps?scope=joined', { ok: false, json: async () => ({}) });
    await workshopController.reload();
    assert.equal(workshopStore.get().error, true);

    // A LOAD THAT LANDS AFTER THE VIEWER LEFT PUBLISHES NOTHING. `open` is
    // the liveness flag, not decoration: without the check, a slow fetch
    // repaints a screen nobody is on and races the next entry's own load.
    answers.set('/api/apps?scope=joined', { ok: true, json: async () => ({ apps }) });
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

test('#4794: re-entering Needs you reloads the feed, and a vote cast in it stays cast', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore } = mod;
  const apps = [{ slug: 'a', name: 'A', is_member: true }];
  const item = (id, epoch) => ({
    kind: 'proposal', id, epoch, title: `Change ${id}`, summary: null, author: null,
    number: null, at: null, yes: 0, no: 0,
    app: { slug: 'a', name: 'A', icon_url: null, icon_emoji: null },
  });
  const countsFor = (ids) => ({ a: { working: 0, needs: ids.length, owed: ids.map((id) => `proposal:${id}@2`) } });
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = { Home: { isJoined: (app) => !!(app && app.is_member) } };
  try {
    const answers = new Map();
    const reads = [];
    global.fetch = async (url) => {
      reads.push(url);
      return answers.get(url) || { ok: false, json: async () => ({}) };
    };
    const feedAnswer = (items) => answers.set('/api/workshop/needs-feed', { ok: true, json: async () => ({ items, max: 0 }) });
    const countsAnswer = (counts) => answers.set('/api/workshop/counts', { ok: true, json: async () => ({ counts }) });
    answers.set('/api/apps?scope=joined', { ok: true, json: async () => ({ apps }) });
    feedAnswer([item(7, 2), item(8, 2)]);
    countsAnswer(countsFor([7, 8]));
    // A microtask flush: refreshNeeds() is fired, not awaited, by setTab.
    const settle = async () => {
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await workshopController.open();
    assert.equal(workshopStore.get().feed.length, 2);

    // OPENING THE FEED AGAIN READS AGAIN. setTab is the tab switch and the
    // quiet reload behind it: the counts and the feed, not the app list.
    reads.length = 0;
    workshopController.setTab('needs');
    await settle();
    assert.deepEqual(reads, ['/api/workshop/counts', '/api/workshop/needs-feed']);
    feedAnswer([item(8, 2)]);
    countsAnswer(countsFor([8]));
    workshopController.setTab('status');
    await settle();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8],
      'the feed takes the fresh answer, without a skeleton or a flash');
    assert.equal(workshopStore.get().rows[0].needs, 1, 'and so does the Needs you row');
    assert.equal(workshopStore.get().error, false);

    // A READ THAT FAILS LEAVES ITS HALF AS IT WAS. Offline is a state, not
    // an error card over the feed that was showing.
    answers.set('/api/workshop/needs-feed', { ok: false, json: async () => ({}) });
    workshopController.setTab('needs');
    await settle();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8], 'the feed is untouched');
    assert.equal(workshopStore.get().feedError, false);
    assert.equal(workshopStore.get().error, false);

    // A VOTE CAST IN THE FEED TAKES ITS CARD OUT AT ONCE, and every later
    // read keeps it out at the epoch it was voted at.
    feedAnswer([item(7, 2), item(8, 2)]);
    await workshopController.reload();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7, 8]);
    workshopController.answered(7, 2);
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8],
      'the answered card leaves the store while the viewer is still in the feed');
    workshopController.setTab('status');
    await settle();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8],
      'a read issued before the vote and landing after it cannot bring it back');
    // A NEWER EPOCH PASSES: the card changed under the vote and asks again.
    feedAnswer([item(7, 3), item(8, 2)]);
    workshopController.setTab('needs');
    await settle();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7, 8]);

    // LEFT THE SCREEN: setTab fetches nothing, and the answered set is
    // dropped with the visit — a fresh visit starts from the server's word.
    workshopController.close();
    reads.length = 0;
    workshopController.setTab('needs');
    await settle();
    assert.deepEqual(reads, [], 'a closed screen fetches nothing');
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

test('#5164: the open screen quietly re-reads what waits, and stops when it closes', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore, WORKSHOP_REFRESH_MS } = mod;
  assert.equal(WORKSHOP_REFRESH_MS, 30000, 'the quiet interval is about half a minute');
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  const priorDocument = global.document;
  const apps = [{ slug: 'a', name: 'A', is_member: true }];
  const counts = { a: { working: 1, needs: 0 } };
  try {
    const reads = [];
    const answers = new Map([
      ['/api/apps?scope=joined', { ok: true, json: async () => ({ apps }) }],
      ['/api/workshop/counts', { ok: true, json: async () => ({ counts }) }],
      ['/api/workshop/needs-feed', { ok: true, json: async () => ({ items: [], max: 0 }) }],
    ]);
    global.fetch = async (url, opts) => {
      reads.push([url, opts && opts.cache]);
      return answers.get(url) || { ok: false, json: async () => ({}) };
    };
    let visibility = 'visible';
    const visibilityListeners = new Set();
    global.document = {
      get visibilityState() { return visibility; },
      addEventListener(kind, fn) { if (kind === 'visibilitychange') visibilityListeners.add(fn); },
      removeEventListener(kind, fn) { visibilityListeners.delete(fn); },
    };
    const timers = [];
    let nextId = 1;
    global.window = {
      Home: { isJoined: (app) => !!(app && app.is_member) },
      setInterval(fn, ms) { const id = nextId++; timers.push({ id, fn, ms }); return id; },
      clearInterval(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    };
    const settle = async () => {
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await workshopController.open();
    assert.equal(workshopStore.get().open, true);
    assert.equal(timers.length, 1, 'the open screen runs ONE quiet timer');
    assert.equal(timers[0].ms, WORKSHOP_REFRESH_MS);
    assert.equal(visibilityListeners.size, 1, 'and listens for the tab coming back');

    // A VISIBLE TICK re-reads exactly the quiet reads, asking for the
    // CURRENT answer rather than the worker's saved copy.
    reads.length = 0;
    timers[0].fn();
    await settle();
    assert.deepEqual(reads, [
      ['/api/workshop/counts', 'no-cache'],
      ['/api/workshop/needs-feed', 'no-cache'],
    ]);

    // A HIDDEN TAB reads nothing: the return listener catches up instead.
    visibility = 'hidden';
    reads.length = 0;
    timers[0].fn();
    await settle();
    assert.deepEqual(reads, []);

    // RETURNING TO THE TAB reads at once, not at the next tick.
    visibility = 'visible';
    reads.length = 0;
    for (const fn of visibilityListeners) fn();
    await settle();
    assert.deepEqual(reads.map(([url]) => url), ['/api/workshop/counts', '/api/workshop/needs-feed']);

    // RE-ENTRY never stacks a second timer; leaving stops the watch.
    await workshopController.open();
    assert.equal(timers.length, 1, 'a second open replaces the timer, never adds one');
    workshopController.close();
    assert.equal(timers.length, 0, 'closing the screen stops the timer');
    assert.equal(visibilityListeners.size, 0, 'and its listener');
  } finally {
    if (priorDocument === undefined) delete global.document; else global.document = priorDocument;
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

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
  // the flag, so the pair above is what tells "here" from "came from here".
  const enter = appJs.slice(appJs.indexOf('  async navigateToApp('));
  const chain = enter.slice(0, enter.indexOf('PlatformUI.transition('));
  assert.doesNotMatch(chain, /_exitWorkshop/,
    'entering an app must not clear _inWorkshop — the way back reads it');
});

test('#communities is a route of its own, and #workshop still lands there', () => {
  assert.match(appJs, /if \(parts\[0\] === 'communities' \|\| parts\[0\] === 'workshop'\) \{[\s\S]*?App\.navigateToWorkshop\(\);/,
    'restoreFromHash resolves both, so an old bookmark and a cold boot land here');
  assert.match(appJs, /navigateToWorkshop\(\) \{/);
  assert.match(appJs, /_exitWorkshop\(\) \{[\s\S]*?App\._inWorkshop = false;/);
  assert.match(appJs, /App\.setHeaderTitle\(PlatformI18n\.t\('shell:title\.communities'\)\)/);
  assert.equal(message('shell:title.communities'), 'Communities');
  // THE DOOR IS A TAB (#2718), the middle one of five since the rename: the
  // screen is Communities to the people who use it, and keeps its key.
  const html = read('public/index.html');
  assert.match(html, /id="platform-tab-workshop"[^>]*href="#communities"/,
    'the unscoped screen is a tab');
  // The app menu keeps the SCOPED entrance — the link-out every mini-app host
  // in the study draws under a mini-app — as a plain "Go to workshop" row
  // (#2761). It spent a round as the App | Workshop strip's segment; the
  // owner asked for a row, not a toggle.
  assert.match(sheetTsx, /href=\{slug \? `#app\/\$\{encodeURIComponent\(slug\)\}\/workshop` : '#'\}/,
    "and the app's menu links out to it, scoped");
  assert.match(sheetTsx, /id="app-menu-row-workshop"/, 'as a row');
  assert.ok(!/AppViewTabs/.test(sheetTsx), 'and not as a toggle segment');
});

test('the ✕ knows the page the app was opened from, and forgets it with the visit', () => {
  // The breadcrumb this replaced said '#workshop' when the Workshop screen was
  // the origin and nothing otherwise, so the ✕ went Home from every other
  // page — a thread, Discover, Me. The ✕ now goes back to whichever page it
  // was (App.closeApp, driven for real in tests/app-close-origin.test.js);
  // what is pinned here is who writes that memory and who clears it.
  assert.ok(!/_appBackHref/.test(appJs), 'the Workshop-only breadcrumb is retired');
  assert.match(appJs, /^ {2}_appReturn: null,$/m,
    'the slot is declared on App with the prose that says who owns it');
  // Written as an app's App tab is about to come on screen, BEFORE its
  // entry is pushed over the page it was opened from — by navigateToApp…
  const enter = appJs.slice(appJs.indexOf('  async navigateToApp('));
  const noted = enter.indexOf("if (initialRoute.tab === 'app') App._noteAppReturn(slug);");
  const pushed = enter.indexOf('App.updateHash({ ref: initialRoute.ref });');
  assert.ok(noted > 0 && pushed > noted, 'noted before the app\'s own address is written');
  assert.ok(enter.indexOf('App._pinAppReturn();') > pushed, 'and pinned once it has been');
  // …and by switchTab, when the app's own Workshop hands over to the app.
  const sw = appJs.slice(appJs.indexOf('  async switchTab('));
  assert.match(sw, /if \(tab === 'app' && App\.currentTab !== 'app' && !options\?\.replaceRoute\) \{\s*App\._noteAppReturn\(App\.currentApp\);/);
  // One clearer: revealing any other screen ends the visit it was about.
  assert.match(appJs, /if \(revealId !== 'app-view'\) App\._appReturn = null;/,
    'revealing any other screen ends the app visit it was about');
  // The ✕ is App.closeApp's, ahead of the handler's own href-following rule —
  // which still serves every ARROW: the href IS the answer, and home is the
  // fallback for a screen that named no parent.
  const handler = appJs.slice(appJs.indexOf("document.getElementById('back-btn').addEventListener('click'"));
  const close = handler.indexOf("if (App.currentApp && App.currentTab === 'app' && App.closeApp()) return;");
  const follow = handler.indexOf("if (href && href.startsWith('#') && href.length > 1) {");
  assert.ok(close > 0 && follow > close, 'the ✕ is claimed before the href is followed');
  // The mixed address a fragment produces — /app/<slug>/workshop#workshop —
  // is still healed to /#workshop by restoreFromHash.
  assert.match(appJs, /if \(rawHash && pathRoute && !rawHash\.startsWith\('app\/'\)\) \{/);
});

test('the Dev lander needs no back arrow, because the rail is beside it', () => {
  // IT HAD ONE, and it was the whole of the way out: `App._appBackHref` said
  // the app had been opened from the Workshop screen, and the lander
  // published a ← to it. That was the best available answer on a surface
  // with no rail — and it only pointed anywhere at all for readers who
  // arrived by that one route.
  //
  // The rail is there now (#2718 review). The app's Workshop is a platform
  // screen scoped to one app, App._syncPlatformTabs keeps the bar up on it
  // and lights the Workshop tab, and that tab lands on the very screen the
  // arrow pointed at — for everyone, however they got here.
  assert.ok(!appViewJs.includes("App.setBackIcon?.('arrow', App._appBackHref)"),
    'the lander publishes no arrow of its own');
  assert.match(appViewJs, /App\.setBackIcon\?\.\('none'\);/,
    'and the sub-view reset is an empty slot, not the house');
  // The reset still sits ABOVE the branches, so the session's own ← survives
  // it and nothing else inherits that arrow. #2770 moved its destination: a
  // change is an agent conversation, so it hangs off Messages, not the board.
  const reset = appViewJs.indexOf("App.setBackIcon?.('none');");
  const session = appViewJs.indexOf("if (subTab === 'sessions' && ref) {");
  assert.ok(reset > 0 && session > reset,
    'the reset leads, so every sub-view that wants a slot claims it after');
  const sessionBranch = appViewJs.slice(session, appViewJs.indexOf('\n    }', session));
  assert.match(sessionBranch, /App\.setBackIcon\?\.\('arrow', '#messages'\);/,
    'and a session leads with a real ← up to Messages (#2770)');
  // The ✕ is the app TAB's alone (on a phone, or with the rail not kept
  // beside it), and it lands wherever the visit began.
  assert.match(read('public/js/app.js'), /return \['close', App\._closeAppHref\(\)\];/);
  // An arrow WITH an href is what turns the phone's back gesture on — still
  // true, and still what the session sub-view relies on.
  assert.match(read('frontend/src/features/header/native-back-navigation.ts'),
    /mode === 'arrow' && !!href/);
});

// ── One Workshop, two scopes (#2718 review) ────────────────────────────

test('the app\'s own Workshop keeps the rail, and lights the tab it came through', () => {
  // "should preserve the side bar. It doesn't need a back button anymore
  // because of the side bar."
  //
  // #app-view is TWO screens behind one id: the running app, which takes the
  // whole window because that is what makes it feel like a program, and on
  // the `dev` tab the platform's own Workshop for that app. The second is a
  // platform screen that happens to be scoped, and hiding the rail there left
  // it as the one such screen with no navigation at all.
  const appJs = read('public/js/app.js');
  const sync = appJs.slice(appJs.indexOf('  _syncPlatformTabs(revealId) {'));
  const body = sync.slice(0, sync.indexOf('\n  },\n'));
  assert.match(body, /const inApp = screen === 'app-view' && App\.currentTab === 'app';/,
    'the app itself covers the rail; its Workshop does not');
  // …except on a desktop, where the rail stays beside it by default (#3319,
  // tests/nav-rail-pinned.test.js).
  assert.match(body, /!!screen && !App\.chromeless && \(!inApp \|\| railPinned\),/);
  // The Workshop tab is lit, so the rail knows where you are — except on the
  // app's DISCUSSION, which is a row in the Messages inbox and lights that
  // instead (#2718 review).
  assert.match(body, /\? \(App\._isMessagesThread\(\) \? 'messages' : 'workshop'\)/,
    'and the Workshop tab is lit, so the rail knows where you are');

  // A TAB HOP inside the app crosses that line without a screen reveal, so
  // it is the only other place that has to re-sync.
  const hop = appJs.slice(appJs.indexOf('  async switchTab(tab, ref, subTab, options) {'));
  assert.match(hop.slice(0, hop.indexOf('\n  },\n')),
    /if \(App\._isScreenVisible\?\.\('app-view'\)\) App\._syncPlatformTabs\('app-view'\);/,
    'the rail moves with the tab');

  // And the Workshop's lander ends ABOVE the platform's bar: its floor takes
  // off the larger of that bar and the home-indicator strip. (The Workshop's
  // own tabs used to float at the foot and ride on the bar; they sit at the
  // head of the page now, #2767, so the floor is the only thing that has to
  // know about it.)
  const css = read('public/css/app.css');
  assert.match(css,
    /--ws-area: calc\([\s\S]*?max\(var\(--platform-tabs-h, 0px\), var\(--platform-safe-bottom, 0px\)\)\s*\);/);
});

test('the app\'s own Workshop switches communities through Your communities, the same switcher the tab opens (#852)', () => {
  // "should preserve the app switcher". The all-apps screen's chip says "All"
  // and picking a community goes to its hub; on a project page the coloured
  // header's name and ⌄ open the same switcher, whose All communities row is
  // the way back up. The in-page "Which project?" panel it replaced is gone.
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const scope = read('frontend/src/features/workshop/community-scope.ts');
  const header = read('frontend/src/features/header/header-title.tsx');
  assert.doesNotMatch(ws, /AppWorkshopScope|workshop-chrome/, 'no panel of the page\'s own');
  assert.match(header, /id="header-app-switch"\n\s+type="button"[\s\S]{0,600}onClick=\{\(e\) => toggleSwitcher\('header', e\.currentTarget\)\}/);
  // The page reads the app's name and artwork from the store the header's
  // tile reads, so the two cannot disagree about which community this is.
  assert.match(ws, /const app = useStoreState\(improveStore\);/);
  assert.match(ws, /name=\{app\.name \|\| undefined\}/);

  // ALL COMMUNITIES IS THE WAY BACK UP: a hash assignment, so the tab and
  // this are one route, and the page the tab reopened is forgotten. On a
  // phone it is the drawer's list instead (#5581), and the page stays for a
  // new account with no community to show it over.
  assert.match(scope, /if \(!slug\) \{\s*if \(phone\(\) && openDrawerList\(\)\) return;\s*setScope\(null\);\s*try \{ app\?\._forgetWorkshopView\?\.\(\); \}[\s\S]{0,160}window\.location\.hash = '#communities';/);
  // The community you are already on goes nowhere: re-navigating to the
  // current route would throw the page's scroll away, and it stays on the
  // place it shows. Another one opens on the place you were on, when it has
  // it: a switch keeps your page, as the phone's drawer does.
  assert.match(scope, /if \(onPage\) return;\s*landKeepingPlace\(slug\);\s*void app\?\.navigateToApp\?\.\(slug, 'dev'\);/);
  assert.doesNotMatch(scope, /_landOnHub/, 'a switch is not a door to the hub');
  // Its open flag is its own store's, not workshopStore's: the header and
  // the tab bar are other React roots.
  assert.match(scope, /switcher: SwitcherFrom \| null;/);
  // The list loads on open, and never during render.
  assert.match(scope, /communityScopeStore\.set\(\{ switcher: from, anchor \}\);\s*void loadCommunities\(\);/);
  assert.match(scope, /fetch\(`\/api\/apps\?scope=joined\$\{q\.replace\('\?', '&'\)\}`/);
});

// ── 4. The rows behind the counts (#3051) ──────────────────────────────
//
// The all-apps screen's two tabs list, item by item, what its two numbers
// count. The failure this section exists for is the one section 1 guards
// against for the counts: a SECOND spelling of the populations that drifts,
// so a row says "3 votes waiting" over a tab that lists two.

test('#3051: the items query reads the counts\' own five predicates, once each', () => {
  const src = read('src/routes/workshop-overview.js');
  // One definition per population, interpolated into both queries.
  for (const name of ['MY_SESSIONS_WHERE', 'MY_PROPOSALS_WHERE', 'MY_GOVERNANCE_WHERE',
    'OWED_PROPOSALS_WHERE', 'OWED_GOVERNANCE_WHERE']) {
    assert.equal((src.match(new RegExp(`const ${name} = `, 'g')) || []).length, 1, `${name} is defined once`);
    // The owed populations are read a third time, by the Needs you feed
    // (#3270), so the tab's cards and the counts beside it cannot disagree,
    // and a fourth by the same feed counted per project
    // (OWED_BY_COMMUNITY_SQL), so a per-project count agrees with that feed
    // about what is waiting and where.
    const reads = name.startsWith('OWED_') ? 4 : 2;
    assert.equal((src.match(new RegExp(`\\$\\{${name}\\}`, 'g')) || []).length, reads,
      `${name} is read by COUNTS_SQL and ITEMS_SQL alike${reads === 4 ? ', and by NEEDS_FEED_SQL and OWED_BY_COMMUNITY_SQL' : ''}`);
  }
  assert.equal((src.match(/\$\{VISIBLE_APP_WHERE\}/g) || []).length, 4,
    'and all four apply GET /api/apps\'s visibility filter');
  // The per-project count is the feed's own membership rule too.
  assert.match(route.OWED_BY_COMMUNITY_SQL,
    /JOIN community_members cm ON cm\.community_id = a\.community_id AND cm\.user_id = \$1/);
  const items = route.ITEMS_SQL;
  assert.ok(items.includes(require('../src/services/pr-vote-revision').currentVotePredicateSql('pv', 'cs')));
  assert.equal((items.match(new RegExp(require('../src/services/governance-kinds')
    .governanceKindsSql('i').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 2,
  'both `issues` branches read governance proposals, never the request board');
  // Five branches, in the order the sections are named.
  const sections = [...items.matchAll(/SELECT '(working|needs)'/g)].map((m) => m[1]);
  assert.deepEqual(sections, ['working', 'working', 'working', 'needs', 'needs']);
});

test('#3051: the items read is bounded per app and in all', () => {
  const sql = route.ITEMS_SQL;
  assert.match(sql, /PARTITION BY it\.app_id, it\.section/);
  assert.match(sql, /WHERE r\.rn <= \$4/);
  assert.match(sql, /LIMIT \$5/);
  // Newest-first rank ahead of slug, so the overall cap trims every app's
  // oldest rows before it drops any app's newest.
  assert.match(sql, /ORDER BY r\.rn, a\.slug, r\.section/);
  assert.ok(route.ITEMS_PER_APP > 0 && route.ITEMS_PER_APP <= 10);
  assert.ok(route.ITEMS_TOTAL > 0 && route.ITEMS_TOTAL <= 500);
});

test('#3051: GET /api/workshop/items refuses an anonymous caller', async () => {
  const router = route.workshopOverviewRoutes({ databaseUrl: 'postgres://stub/stub' });
  const layer = router.stack.find((l) => l.route?.path === '/api/workshop/items');
  assert.ok(layer, 'GET /api/workshop/items is registered');
  assert.ok(layer.route.methods.get && Object.keys(layer.route.methods).length === 1, 'and it only reads');
  let status = null;
  let body = null;
  await layer.route.stack[0].handle(
    { user: null, query: {}, params: {} },
    { status(code) { status = code; return this; }, json(payload) { body = payload; return this; } },
    () => {},
  );
  assert.equal(status, 401);
  assert.deepEqual(body, { error: 'Not authenticated' });
});

test('#3051: rows group by app and section, and the demo agrees with the demo counts', () => {
  const at = new Date('2026-09-24T09:00:00Z');
  const grouped = route.groupItems([
    { slug: 'a', section: 'working', kind: 'session', id: '4', title: 'T', status: 'active', at },
    { slug: 'a', section: 'needs', kind: 'governance', id: 5, title: null, status: 'rename', at: null },
    { slug: 'b', section: 'needs', kind: 'proposal', id: 6, title: 'P', status: 'promoted', at },
  ]);
  assert.deepEqual(grouped.a.working, [{ kind: 'session', id: 4, title: 'T', status: 'active', at: at.toISOString() }]);
  assert.deepEqual(grouped.a.needs.map((i) => [i.id, i.title, i.at]), [[5, '', null]]);
  assert.deepEqual(grouped.b.working, []);
  // The demo rows sit under the demo counts, so the preview's row and tab agree.
  for (const [slug, slot] of Object.entries(route.DEMO_ITEMS)) {
    assert.equal(slot.working.length, route.DEMO_COUNTS[slug].working, `${slug} working`);
    assert.equal(slot.needs.length, route.DEMO_COUNTS[slug].needs, `${slug} needs`);
  }
  const real = { 'staging-demo-your-app': { working: [], needs: [] } };
  assert.deepEqual(route.withDemoItems(real)['staging-demo-your-app'], { working: [], needs: [] },
    'real rows win, as they do for the counts');
});

test('the Needs you row names the communities waiting on you, and the tabs are gone', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const src = read('frontend/src/features/workshop/index.tsx');
  const rows = (names) => names.map((name, i) => ({ slug: `s${i}`, name, working: 0, needs: 1 }));
  assert.equal(mod.needsApps([
    { slug: 'owed', name: 'Owed', working: 0, needs: 7 },
    { slug: 'quiet', name: 'Quiet', working: 2, needs: 0 },
    { slug: 'bare', working: 0, needs: 1 },
  ]), 'Owed, bare', 'only the communities that owe a vote, by name (the slug when there is none)');
  assert.equal(mod.needsApps(rows(['A', 'B', 'C', 'D', 'E'])), 'A, B, C and 2 more');
  // One page: no Current status | Needs you strip, no summary legend, and no
  // list of your own items under the communities (Profile's Your changes).
  assert.doesNotMatch(src, /id="workshop-tab-(status|needs)"/);
  assert.doesNotMatch(src, /id="workshop-total-(working|needs)"/);
  assert.doesNotMatch(src, /\/api\/workshop\/items/, 'the screen no longer reads the items');
  assert.match(src, /data-workshop-needs-open=""/);
  // #3526: the title counts the votes not yet swiped past; with none new it
  // says how many were skipped, since the row is still the way to them.
  assert.match(src, /title=\{totals\.needs > 0\s*\? t\('communities:needsYou\.waiting', \{ count: totals\.needs \}\)\s*: t\('communities:needsYou\.skipped', \{ count: totals\.owed \}\)\}/);
  assert.deepEqual([1, 2].map((count) => message('communities:needsYou.waiting', { count })),
    ['1 vote waiting on you', '2 votes waiting on you']);
  assert.deepEqual([1, 2].map((count) => message('communities:needsYou.skipped', { count })),
    ['1 vote you skipped', '2 votes you skipped']);
  assert.match(src, /onClick=\{\(\) => workshopController\.setTab\('needs'\)\}/, 'the row opens the feed');
  assert.match(src, /data-workshop-needs-back=""/, 'and the feed has a way back');
  assert.doesNotMatch(src, /—'|'[^'\n]*—[^'\n]*'/, 'no em dash in the screen\'s copy');

  assert.equal(mod.tabFromQuery('?demo=1&ws=needs'), 'needs');
  assert.equal(mod.tabFromQuery('?ws=all'), null, 'All items is an app\'s own tab, not this screen\'s');
  assert.equal(mod.tabFromQuery(''), null);
});

test('the Needs you row is drawn only while a vote waits on you', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const html = () => renderToHtml(createElement(mod.WorkshopScreen, {}));
  mod.workshopStore.set({
    open: true, error: false, tab: 'status', scopeOpen: false,
    rows: [{ slug: 'garden', name: 'Garden', working: 0, needs: 2 }, { slug: 'swap', name: 'Swap', working: 1, needs: 1 }],
    feed: null, feedError: false, feedCapped: false,
  });
  let out = html();
  assert.match(out, /data-workshop-needs-door=""/);
  assert.match(out, /3 votes waiting on you/);
  assert.match(out, /Garden, Swap/);
  assert.match(out, />Review</);
  mod.workshopStore.set({ rows: [{ slug: 'swap', name: 'Swap', working: 1, needs: 0 }] });
  out = html();
  assert.doesNotMatch(out, /data-workshop-needs-door=/, 'nothing to say, so no row');
  mod.workshopStore.set({ open: false, tab: 'status', rows: null, feed: null, feedError: false });
});

test('#3270, #3488: the Needs you pane is one feed, every project mixed, drawn by a project\'s own feed', () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const html = () => renderToHtml(createElement(mod.WorkshopScreen, {}));
  const card = (kind, id, slug, extra = {}) => ({
    kind, id, title: `Item ${id}`, summary: null, author: 'ada', number: null, epoch: 2,
    at: null, yes: 1, no: 0, app: { slug, name: slug.toUpperCase(), icon_url: null, icon_emoji: null }, ...extra,
  });
  mod.workshopStore.set({
    open: true, error: false, tab: 'needs', scopeOpen: false,
    rows: [{ slug: 'garden', name: 'Garden', working: 0, needs: 2 }, { slug: 'swap', name: 'Swap', working: 0, needs: 1 }],
    feed: [card('proposal', 8, 'garden'), card('governance', 9, 'swap'), card('proposal', 7, 'garden')],
    feedError: false, feedCapped: false,
  });
  let out = html();
  const pane = out.slice(out.indexOf('data-workshop-pane="needs"'));
  // #3488: the project's own feed, not cards of this screen's own.
  assert.match(pane, /<div class="workshop-needs-feed" data-needs-reel=""><div class="dev-ws-needs" data-ws-needs="">/);
  assert.doesNotMatch(pane, /workshop-reel-card|data-needs-answer/, 'the old cards are gone');
  assert.deepEqual([...pane.matchAll(/data-ws-item="needs:(\w+):(\d+)"[^>]*data-ws-app="([\w-]+)"/g)].map((m) => `${m[3]}:${m[1]}`),
    ['garden:proposal', 'swap:governance', 'garden:proposal'], 'in the order the server mixed them, not grouped');
  assert.doesNotMatch(pane, /data-workshop-group=/, 'no list of lists any more');
  // Each item names its project, and its title opens its page there.
  assert.match(pane, /<a class="workshop-reel-app" data-ws-item-app="" href="#app\/swap\/workshop">/);
  assert.match(pane, /<h2 class="dev-ws-item-title"><a href="#app\/garden\/dev\/proposals\/8">Item 8<\/a><\/h2>/);
  assert.match(pane, /<h2 class="dev-ws-item-title"><a href="#app\/swap\/dev\/governance\/9">Item 9<\/a><\/h2>/);
  assert.match(pane, /class="dev-ws-eyebrow">Group decision · Waiting for your approval</, 'a group decision says what it is');
  assert.match(pane, /class="dev-ws-eyebrow">Change · Waiting for your approval</, 'and a change, in its page\'s words');
  // The rail, as a project's: Vote, Comments, Ask, Try it, More.
  assert.deepEqual([...pane.matchAll(/data-ws-rail-btn="(\w+)"/g)].map((m) => m[1]),
    ['vote', 'comments', 'ask', 'try', 'more']);
  // Each item names its project at the top of its caption, over its by-line.
  assert.match(pane, /<div class="dev-ws-item-caption"><a class="workshop-reel-app" data-ws-item-app=""[^>]*>[\s\S]*?<\/a><p class="dev-ws-item-by">/);
  assert.match(pane, /data-ws-rail-btn="more" data-card-menu="" data-card-menu-open="#app\/garden\/dev\/proposals\/8"/,
    'the ⋯ offers the card\'s page, the one entry that holds across projects');
  assert.match(pane, /class="dev-ws-needs-of">1 \/ 3</);
  assert.match(pane, /class="dev-ws-done-cta">Back to your communities</);
  assert.doesNotMatch(pane, /data-ws-done-hub/, 'the Communities screen has its own way on, and no Hub to go back to');

  mod.workshopStore.set({ feed: [] });
  out = html();
  assert.match(out.slice(out.indexOf('data-workshop-pane="needs"')), /data-needs-empty="">Nothing is waiting on your vote in any of your projects\./);
  mod.workshopStore.set({ feed: null, feedError: true });
  out = html();
  assert.match(out.slice(out.indexOf('data-workshop-pane="needs"')), /data-needs-error=""/);
  mod.workshopStore.set({ open: false, tab: 'status', rows: null, feed: null, feedError: false });
});

test('#3270: the controller reads the Needs you feed alongside, and survives losing it', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore } = mod;
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = { Home: { isJoined: (app) => !!(app && app.is_member) } };
  try {
    const answers = new Map([
      ['/api/apps?scope=joined', { ok: true, json: async () => ({ apps: [{ slug: 'a', name: 'A', is_member: true }] }) }],
      ['/api/workshop/counts', { ok: true, json: async () => ({ counts: { a: { working: 0, needs: 1 } } }) }],
      ['/api/workshop/needs-feed', { ok: true, json: async () => ({ items: [{ kind: 'proposal', id: 1, app: { slug: 'a' } }], max: 60 }) }],
    ]);
    const asked = [];
    global.fetch = async (url) => { asked.push(url); return answers.get(url) || { ok: false, json: async () => ({}) }; };
    await workshopController.open();
    assert.ok(!asked.includes('/api/workshop/items'), 'your own items are Profile\'s now, not this screen\'s');
    assert.ok(asked.includes('/api/workshop/needs-feed'), 'the Needs you feed is read with the other two (#3270)');
    assert.equal(workshopStore.get().feed.length, 1);
    assert.equal(workshopStore.get().feedCapped, false);

    answers.set('/api/workshop/needs-feed', { ok: false, json: async () => ({}) });
    await workshopController.reload();
    assert.equal(workshopStore.get().error, false, 'losing the feed is not the error card');
    assert.equal(workshopStore.get().feedError, true);
    assert.deepEqual(workshopStore.get().rows.map((r) => r.slug), ['a']);
    workshopController.close();
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

// ── #4417: By category leads with the project's topics ────────────────

test('By category: Topics, then Other categories, each topic with a door to its channel', () => {
  const WS = 'frontend/src/features/dev-board/workshop/workshop.tsx';
  const { orderThemesStable } = loadTsx(WS);
  const theme = (id, people, extra = {}) => ({
    id, people: Array.from({ length: people }, (_, i) => `u${i}`), lastActive: 0, counts: { open: 0 }, ...extra,
  });
  const topic = (id, people) => theme(id, people, { topic: { key: id, handle: id } });
  // The topics lead in the server's order (dapp.json's), whatever the sort;
  // the other categories sort among themselves; "Not yet grouped" stays last.
  const themes = [topic('onboarding', 1), theme('a', 2), topic('infra', 9), theme('b', 7), theme('z', 0, { ungrouped: true })];
  assert.deepEqual(orderThemesStable(null, themes, 'people').map((t) => t.id), ['onboarding', 'infra', 'b', 'a', 'z']);
  const held = { key: 'people', ids: ['b', 'a', 'infra', 'onboarding', 'z'] };
  assert.deepEqual(orderThemesStable(held, themes, 'people').map((t) => t.id).slice(0, 2), ['onboarding', 'infra'],
    'a held order never moves a topic down');

  const src = read(WS);
  // Two headings, and only when the project has topics: one without draws
  // its categories as it always did.
  assert.match(src, /\{themes\.some\(\(theme\) => theme\.topic\) \? \(\s*<SectionHeader className="pt-3" data-ws-themes-head="topics">\{t\('project:allItems\.themes\.topics'\)\}<\/SectionHeader>/);
  assert.equal(message('project:allItems.themes.topics'), 'Topics');
  assert.match(src, /themes\.some\(\(x\) => x\.topic\) && !theme\.topic && \(i === 0 \|\| themes\[i - 1\]\.topic\) \? \(\s*<SectionHeader className="pt-3" data-ws-themes-head="other">\{t\('project:allItems\.themes\.other'\)\}<\/SectionHeader>/);
  assert.equal(message('project:allItems.themes.other'), 'Other categories');
  // A topic card's foot is "Discuss in #name ›": an anchor with the channel's
  // own address, which opens it on the page and leaves the card shut.
  assert.match(src, /className="dev-ws-link dev-ws-topic-link"\s*data-ws-topic-channel=\{theme\.topic\.handle\}\s*href=\{placeHref\(slug, channelPlace\(theme\.topic\.handle\)\)\}/);
  assert.match(src, /\{t\('project:allItems\.theme\.discuss', \{ channel: theme\.topic\.handle \}\)\}/);
  assert.equal(message('project:allItems.theme.discuss', { channel: 'onboarding' }), 'Discuss in #onboarding ›');
  assert.match(src, /e\.stopPropagation\(\);/);
});

test('the Topics dialog: handles from names, and each row says its channel and its count', () => {
  const { handleFromName, topicRowLine } = loadTsx('frontend/src/features/dialogs/topics.tsx');
  assert.equal(handleFromName('Homeroom bot'), 'homeroom-bot');
  assert.equal(handleFromName('  Proposal  pipeline! '), 'proposal-pipeline');
  assert.equal(handleFromName('3D printing'), 'd-printing', 'a handle starts with a letter');
  assert.equal(handleFromName('Café'), 'cafe');
  const t = { kind: 'topic', key: 'onboarding', handle: 'onboarding', state: 'live', requests: 9 };
  assert.equal(topicRowLine(t), '#onboarding · 9 requests');
  assert.equal(topicRowLine({ ...t, requests: 1 }), '#onboarding · 1 request');
  assert.equal(topicRowLine({ ...t, requests: 0 }), '#onboarding', 'a zero says nothing');
  assert.equal(topicRowLine({ ...t, state: 'archived' }), '#onboarding · archived');
  assert.equal(topicRowLine({ ...t, handle: 'signup', state: 'merged', merged_into: 'onboarding' }, [t]),
    '#signup · merged into #onboarding');
});

// ── #4486: All items, a project Workshop's page ───────────────────────
//
// Not this screen, but the page its rows lead to: the project's All items,
// whose rows open the item's page in the panel the Workshop tab uses, and
// whose one-row head and pipeline stay on screen down a long column.

const workshopTsx = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const kanbanTsx = read('frontend/src/features/dev-board/card/dev-kanban.tsx');
const appCss = read('public/css/app.css');

test('#4486: a row on All items opens its page beside the board on a wide window, and a tab change closes it', () => {
  // The same panel, from the same handler: a plain click on a wide window,
  // anything else the row's own link (a phone: the page takes the screen).
  assert.match(workshopTsx, /if \(!sideWide\) return;\s*event\.preventDefault\(\);\s*setSideItem/);
  assert.match(workshopTsx, /<DevKanban openKey=\{sideKey\} onOpen=\{openItem\} \/>/, 'the board’s rows');
  assert.match(workshopTsx, /<WorkList rows=\{rows\} slug=\{slug\} openKey=\{openKey\} onOpen=\{onOpen\} variant="board" category=\{false\} \/>/,
    'and By category’s');
  // 16 Oct 2026: and from the bot's slots page (?ws=bot), one `sideOpen`.
  assert.match(workshopTsx, /const sideOpen = !!sideItem && \(tab === 'workshop' \|\| tab === 'all' \|\| tab === 'bot'\);/);
  assert.match(workshopTsx, /\{sideOpen && sideItem \? <TopicSidePanel item=\{sideItem\} onClose=\{closeSide\} \/> : null\}/);
  assert.match(workshopTsx, /data-ws-side-open=\{sideOpen \? '' : undefined\}/);
  // It closes whenever the tab changes, and when the window narrows.
  assert.match(workshopTsx, /useEffect\(\(\) => \{\s*setSideItem\(null\);\s*if \(tab !== 'workshop'\) setOpenWeek\(null\);\s*\}, \[tab\]\);/);
  assert.match(workshopTsx, /useEffect\(\(\) => \{\s*if \(!sideWide\) setSideItem\(null\);\s*\}, \[sideWide\]\);/);
  // The board keeps its place beside it: 316px columns, scrolling sideways,
  // the tapped column brought beside the panel and the strip following.
  assert.match(appCss, /#dev-workshop\.dev-ws-has-board:has\(> \.dev-ws\[data-ws-side-open\]\) \{ max-width: calc\(100% - 616px\); \}/);
  assert.match(appCss, /\.dev-ws\[data-ws-side-open\] :is\(#dev-kanban, \.dev-kanban-stages\) \{ grid-template-columns: repeat\(4, 316px\); \}/);
  assert.match(workshopTsx, /if \(c\.right > b\.right\) board\.scrollLeft \+= Math\.ceil\(c\.right - b\.right\);\s*else if \(c\.left < b\.left\) board\.scrollLeft -= Math\.ceil\(b\.left - c\.left\);\s*syncStrip\(board\);/);
});

test('#4486: the one-row head and the pipeline pin together under the project’s tabs', () => {
  // Both live in the pane head, which is what pins (position: sticky, under
  // the tabs at the measured offset), so the column names stay on screen.
  const head = workshopTsx.slice(workshopTsx.indexOf('<div className="dev-ws-pane-head">'), workshopTsx.indexOf('<div className="dev-ws-pane-body">'));
  assert.match(head, /<div className="dev-ws-allbar" data-ws-allbar="">\s*<PageBack[\s\S]*?eyebrow=\{false\}[\s\S]*?<GroupStrip group=\{group\} \/>[\s\S]*?<DevActionsRow/);
  assert.match(head, /\{group === 'stage' \? <StageStrip \/> : null\}/);
  assert.match(appCss, /\.dev-ws-pane-head \{\s*position: sticky; top: 0; z-index: 20;/);
  assert.match(appCss, /#dev-workshop \.dev-ws-pane-head \{\s*top: calc\(var\(--ws-pin-top, 0px\) \+ var\(--dev-ws-head-top, 0px\)\);/);
  // Pinned, on By stage, the row and the steps take the sheet's colour.
  assert.match(appCss, /#dev-workshop\.dev-ws-has-board \.dev-ws\[data-ws-head-pinned\] \.dev-ws-pane-head \{\s*background-color: var\(--dc-sheet-solid\);/);
  // The strip cannot share a sideways scroller with the board (that box
  // would be what it pinned to), so it follows the board's scroll instead.
  assert.match(kanbanTsx, /export function syncStrip\(board: HTMLElement \| null\): void \{/);
  assert.match(appCss, /\.dev-kanban-stages \{[^}]*overflow: hidden;/);
  // On a phone (#5029) the search keeps its own line and the switch and the
  // filters share the one under it: the chips fill the space beside the
  // switch instead of taking a line of their own.
  assert.match(appCss, /@media \(max-width: 639px\) \{[\s\S]*?\.dev-ws-allbar #dev-kanban-search \{ flex-basis: 100%; max-width: none; min-width: 0; \}\s*\.dev-ws-allbar #dev-filter-chips \{ flex: 1 1 0; min-width: 0; /);
});

// ── 4. #5463: a vote saved elsewhere marks the kept feed and the counts ─

test('#5463: a vote saved elsewhere takes the card and its counts down at once', async () => {
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore, publishVoteSaved } = mod;
  const apps = [{ slug: 'a', name: 'A', is_member: true }];
  const item = (id, epoch) => ({
    kind: 'proposal', id, epoch, title: `Change ${id}`, summary: null, author: null,
    number: null, at: null, yes: 0, no: 0,
    app: { slug: 'a', name: 'A', icon_url: null, icon_emoji: null },
  });
  const countsFor = (ids) => ({ a: { working: 0, needs: ids.length, owed: ids.map((id) => `proposal:${id}@2`) } });
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = { Home: { isJoined: (app) => !!(app && app.is_member) } };
  try {
    const answers = new Map();
    global.fetch = async (url) => answers.get(url) || { ok: false, json: async () => ({}) };
    answers.set('/api/apps?scope=joined', { ok: true, json: async () => ({ apps }) });
    // THE READS STILL ANSWER THE PRE-VOTE COPY: the whole point is that the
    // saved vote is applied without waiting for a read that knows it.
    answers.set('/api/workshop/needs-feed', { ok: true, json: async () => ({ items: [item(7, 2), item(8, 2)], max: 0 }) });
    answers.set('/api/workshop/counts', { ok: true, json: async () => ({ counts: countsFor([7, 8]) }) });

    await workshopController.open();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7, 8]);
    assert.equal(workshopStore.get().rows[0].needs, 2);
    assert.deepEqual(workshopStore.get().rows[0].owed, ['proposal:7@2', 'proposal:8@2']);

    // THE VOTE IS SAVED ON THE CHANGE'S OWN PAGE. The screen is open, the
    // feed is in front of the viewer, and neither the card nor the counts
    // wait for a read.
    publishVoteSaved(7, 'yes', 2);
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8],
      'the card leaves the feed at once');
    assert.equal(workshopStore.get().rows[0].needs, 1, 'and the "1 to vote" line drops it');
    assert.deepEqual(workshopStore.get().rows[0].owed, ['proposal:8@2']);

    // A READ ISSUED BEFORE THE VOTE AND LANDING AFTER IT brings neither back.
    await workshopController.refreshNeeds();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8]);
    assert.equal(workshopStore.get().rows[0].needs, 1);
    await workshopController.reload();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8]);
    assert.equal(workshopStore.get().rows[0].needs, 1);

    // A NEWER EPOCH PASSES: the card changed under the vote and asks again.
    answers.set('/api/workshop/needs-feed', { ok: true, json: async () => ({ items: [item(7, 3), item(8, 2)], max: 0 }) });
    answers.set('/api/workshop/counts', { ok: true, json: async () => ({ counts: { a: { working: 0, needs: 2, owed: ['proposal:7@3', 'proposal:8@2'] } } }) });
    await workshopController.refreshNeeds();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7, 8]);
    assert.equal(workshopStore.get().rows[0].needs, 2);

    // A ROW WITHOUT `owed` KEEPS ITS NUMBER: a count this cannot check is
    // never lowered on a guess.
    workshopStore.set({ rows: [{ slug: 'a', name: 'A', working: 0, needs: 3 }] });
    publishVoteSaved(8, 'no', 2);
    assert.equal(workshopStore.get().rows[0].needs, 3, 'no owed list, no lowering');

    // THE VOTE SAVED WHILE THE SCREEN IS CLOSED strips the kept copy too, so
    // the first paint on return is already right — even when the reads it
    // fires answer the pre-vote copy.
    workshopController.close();
    workshopStore.set({
      feed: [item(7, 2), item(8, 2)],
      rows: [{ slug: 'a', name: 'A', working: 0, needs: 2, owed: ['proposal:7@2', 'proposal:8@2'] }],
    });
    publishVoteSaved(8, 'yes', 2);
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7], 'stripped while closed');
    assert.equal(workshopStore.get().rows[0].needs, 1, 'the counts too');
    await workshopController.open();
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7],
      'the first paint on return already knows the vote');
    assert.equal(workshopStore.get().rows[0].needs, 1);
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});

// ── 5. #5462: the return to Communities reads fresh ────────────────────

test('#5462: re-entry asks no-cache, so a voted card stays gone after coming back', async () => {
  // The worker's boot lane answers a read whose network leg misses its
  // deadline with the saved copy; `close()` has cleared the answered set, so
  // without a fresh read the card voted while away is drawn as owed again.
  // This mock IS the worker: a boot read (no cache mode) answers the
  // PRE-VOTE copy, a `no-cache` read answers what the server holds now.
  const mod = loadTsx('frontend/src/features/workshop/index.tsx');
  const { workshopController, workshopStore } = mod;
  const apps = [{ slug: 'a', name: 'A', is_member: true }];
  const item = (id, epoch) => ({
    kind: 'proposal', id, epoch, title: `Change ${id}`, summary: null, author: null,
    number: null, at: null, yes: 0, no: 0,
    app: { slug: 'a', name: 'A', icon_url: null, icon_emoji: null },
  });
  const countsFor = (ids) => ({ a: { working: 0, needs: ids.length, owed: ids.map((id) => `proposal:${id}@2`) } });
  const priorWindow = global.window;
  const priorFetch = global.fetch;
  global.window = { Home: { isJoined: (app) => !!(app && app.is_member) } };
  try {
    const reads = [];
    const stale = { items: [item(7, 2), item(8, 2)], max: 0 };
    const current = { items: [item(8, 2)], max: 0 };
    const staleCounts = countsFor([7, 8]);
    const currentCounts = countsFor([8]);
    global.fetch = async (url, opts) => {
      const cache = opts && opts.cache;
      reads.push([url, cache]);
      const freshNow = cache === 'no-cache';
      if (url === '/api/workshop/counts') {
        return { ok: true, json: async () => ({ counts: freshNow ? currentCounts : staleCounts }) };
      }
      if (url === '/api/workshop/needs-feed') {
        return { ok: true, json: async () => (freshNow ? current : stale) };
      }
      return { ok: true, json: async () => ({ apps }) };
    };

    // THE FIRST ENTRY KEEPS THE BOOT LANE (#5164): no cache mode on any of
    // the three reads, and it answers the pre-vote copy — which is right,
    // because the vote has not happened yet.
    await workshopController.open();
    assert.deepEqual(reads, [
      ['/api/apps?scope=joined', undefined],
      ['/api/workshop/counts', undefined],
      ['/api/workshop/needs-feed', undefined],
    ], 'the cold first paint keeps the worker\'s fast lane');
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [7, 8]);

    // THE VOTE, then the trip back: close() drops the answered set, so the
    // re-entry cannot lean on it and has to ask the server.
    workshopController.answered(7, 2);
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8]);
    workshopController.close();
    reads.length = 0;
    await workshopController.open();
    assert.deepEqual(reads, [
      ['/api/apps?scope=joined', undefined],
      ['/api/workshop/counts', 'no-cache'],
      ['/api/workshop/needs-feed', 'no-cache'],
    ], 'the re-entry reads carry no-cache, and the apps read does not');
    assert.deepEqual(workshopStore.get().feed.map((it) => it.id), [8],
      'the voted card stays gone after the trip back');
    assert.equal(workshopStore.get().rows[0].needs, 1, 'and the Needs you row counts one');
    assert.equal(workshopStore.get().error, false);
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    global.fetch = priorFetch;
  }
});
