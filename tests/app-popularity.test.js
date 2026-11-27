'use strict';
// Hearts and plays, the screen's half (frontend/src/features/popularity/) and
// the routes that feed it. The counting itself, against a real database, is
// tests/app-popularity-postgres.test.js.
//
//   - what a count says and when it says nothing;
//   - the panel drawn: plays (or opens) then hearts, the heart before its
//     number, given and not, a new app, and nothing until the counts are in;
//   - a card's foot: hearts and plays lead it and stand where "N active" did;
//   - the directory sorted by plays and by hearts;
//   - a visitor's play reported once per app per day, and only once the app
//     has stayed open; a visitor's heart kept for the account they make;
//   - the routes: who may heart, and what the visitor's route takes.
//
// Run with: node --test tests/app-popularity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const LOGIC = 'frontend/src/features/popularity/popularity.ts';
const PANEL = 'frontend/src/features/popularity/hearts-plays.tsx';
const CARD = 'frontend/src/features/communities/card.tsx';
const DATA = 'frontend/src/features/guest/guest-data.ts';
const LANDING = 'frontend/src/features/auth/landing.tsx';
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const panel = (props) => renderComponent(PANEL, 'HeartsPlays', { name: 'Game Corner', played: true, onHeart() {}, ...props });

test('a count too small to read as busy says nothing: plays from 20, a card\'s hearts from 10', () => {
  const { shownPlays, shownCardHearts, MIN_PLAYS, MIN_CARD_HEARTS } = loadTsx(LOGIC);
  assert.equal(MIN_PLAYS, 20);
  assert.equal(MIN_CARD_HEARTS, 10);
  assert.equal(shownPlays(19), 0);
  assert.equal(shownPlays(20), 20);
  assert.equal(shownPlays('6930'), 6930);
  assert.equal(shownPlays(undefined), 0);
  assert.equal(shownCardHearts(9), 0);
  assert.equal(shownCardHearts(10), 10);
  assert.equal(shownCardHearts(-3), 0);
});

test('the panel: plays then hearts, each a label over its number, the heart before its count', () => {
  const html = panel({ plays: 6930, heart: { hearted: false, hearts: 58 } });
  assert.match(html, /^<section data-hearts-plays="" aria-label="Plays and hearts"/);
  const plays = html.indexOf('data-hearts-plays-used="6930"');
  const hearts = html.indexOf('data-hearts-plays-hearts="58"');
  assert.ok(plays > 0 && hearts > plays, 'the plays cell leads');
  assert.match(html, new RegExp(`>${message('home:popularity.plays')}</span><span[^>]*>6,930</span>`));
  // The heart is the one button, named for the app, and comes before its number.
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /<button type="button" data-heart="" aria-pressed="false" aria-label="Heart Game Corner"/);
  assert.ok(html.indexOf('<button') < html.indexOf('>58</span>'), 'the heart sits to the left of its number');
  assert.match(html, /bg-rose-100/);
  assert.doesNotMatch(html, /fill-current/, 'an outline until it is given');
  assert.doesNotMatch(html, /this week/, 'no weekly figure');
});

test('the panel, hearted: a filled heart on a quiet circle, and the button takes it back', () => {
  const html = panel({ plays: 6930, heart: { hearted: true, hearts: 59 } });
  assert.match(html, /<button type="button" data-heart="given" aria-pressed="true" aria-label="Take your heart back from Game Corner"/);
  assert.match(html, /fill-current/);
  assert.doesNotMatch(html, /bg-rose-100/, 'a state that is done gets no fill');
  assert.match(html, />59<\/span>/);
});

test('the panel for an app that is not a game says Opens; a new app says Be the first and no plays', () => {
  const tool = panel({ played: false, plays: 2180, heart: { hearted: false, hearts: 34 } });
  assert.match(tool, /aria-label="Opens and hearts"/);
  assert.match(tool, new RegExp(`>${message('home:popularity.opens')}</span><span[^>]*>2,180</span>`));
  assert.doesNotMatch(tool, />Plays</);

  const fresh = panel({ plays: 7, heart: { hearted: false, hearts: 0 } });
  assert.doesNotMatch(fresh, /data-hearts-plays-used/, 'a plays figure under the minimum is left out');
  assert.match(fresh, new RegExp(`data-hearts-plays-first="">${message('home:popularity.beFirst')}</span>`));
  assert.doesNotMatch(fresh, />0</, 'a zero says nothing');
  assert.doesNotMatch(fresh, /shadow-\[inset_1px_0_0/, 'one cell, no hairline beside it');

  // Both cells and no hearts yet, in a card too narrow for the words on one
  // line: they wrap beside the heart. Two of their lines are the heart's
  // height (2 x 1.125rem = h-9), so the card stays the height it has with a
  // number. They had the number's own 2.25rem line, and a wrap made the cell
  // twice as tall (27 Nov 2026).
  const narrow = panel({ plays: 183, heart: { hearted: false, hearts: 0 } });
  const first = narrow.match(/<span class="([^"]*)" data-hearts-plays-first="">/);
  assert.ok(first, 'the words are drawn beside the plays cell');
  assert.match(first[1], /(^| )leading-\[1\.125rem\]( |$)/, 'half the heart\'s height a line');
  assert.match(first[1], /(^| )text-sm( |$)/);
  assert.match(first[1], /(^| )text-start( |$)/, 'a wrapped pair of lines starts at the heart');
  assert.doesNotMatch(first[1], /leading-9/, 'not the number\'s line height');
  assert.match(narrow, /<button[^>]*class="[^"]*\bh-9 w-9 shrink-0\b/, 'the heart keeps its size beside them');

  assert.equal(panel({ plays: 6930, heart: null }), '', 'nothing until the counts are known');
});

test('a card\'s foot: a heart and its count, then the plays where "N active" stood, then what went live', () => {
  const draw = (props) => renderComponent(CARD, 'CommunityWeek', props);
  const full = draw({ active: 36, live: 11, plays: 6930, hearts: 58 });
  assert.match(full, /<span class="cm-week-in"><span class="inline-flex items-center gap-1" data-cm-hearts="58"><svg/);
  assert.match(full, /<b[^>]*aria-hidden="true">58<\/b><span class="sr-only">58 hearts<\/span><\/span><span data-cm-plays="6930">6,930 plays<\/span><span class="cm-week-live">11 changes live this week<\/span>/);
  assert.doesNotMatch(full, /active/, 'the plays stand where the active count stood');
  // Not a game: opens. Under ten hearts: no heart on the card.
  assert.match(draw({ active: 5, live: 3, plays: 310, hearts: 4, played: false }),
    /<span class="cm-week-in"><span data-cm-plays="310">310 opens<\/span><span class="cm-week-live">3 changes live this week<\/span>/);
  // No plays to show: the card keeps its active count, and its hearts lead it.
  assert.match(draw({ active: 6, live: 0, plays: 12, hearts: 0 }), /<span class="cm-week-in"><span>6 active this week<\/span><\/span>/);
  assert.match(draw({ active: 6, live: 2, plays: 0, hearts: 12 }), /data-cm-hearts="12".*<span>6 active<\/span><span class="cm-week-live">2 changes live this week<\/span>/);
  assert.equal(draw({ active: 0, live: 0, plays: 3, hearts: 2 }), '', 'nothing worth a line');
  // The directory's row carries them to the card, a game played and anything else opened.
  const { communityFromDirectory } = loadTsx(CARD);
  const row = { slug: 'g', name: 'G', plays: 40, hearts: 11, category: 'games' };
  assert.deepEqual(
    (({ plays, hearts, played }) => ({ plays, hearts, played }))(communityFromDirectory(row)),
    { plays: 40, hearts: 11, played: true },
  );
  assert.equal(communityFromDirectory({ ...row, category: 'tools' }).played, false);
});

test('the directory sorts by most played and most hearts, and Communities to join offers both', () => {
  const { sortApps, SORTS } = loadTsx(DATA);
  const apps = [
    { slug: 'a', name: 'A', plays: 100, hearts: 9 },
    { slug: 'b', name: 'B', plays: 3000, hearts: 2 },
    { slug: 'c', name: 'C', hearts: 40 },
    { slug: 'd', name: 'D', plays: 100, hearts: 9 },
  ];
  assert.ok(SORTS.includes('played') && SORTS.includes('hearts'));
  assert.deepEqual(sortApps(apps, 'played').map((a) => a.slug), ['b', 'a', 'd', 'c'], 'ties keep the directory\'s order');
  assert.deepEqual(sortApps(apps, 'hearts').map((a) => a.slug), ['c', 'a', 'd', 'b']);
  const { JOIN_SORTS } = loadTsx('frontend/src/features/home/communities-to-join.tsx');
  assert.deepEqual([...JOIN_SORTS], ['new', 'popular', 'trending', 'played', 'hearts', 'name']);
  assert.equal(message('home:join.sort.played'), 'Most played');
  assert.equal(message('home:join.sort.hearts'), 'Most hearts');
});

test('a visitor\'s heart opens the sign-in sheet titled for it, and counts as a way a sign-up began', () => {
  const { intentTitle } = loadTsx(LANDING);
  const t = (id, params) => message(id, params);
  const app = { slug: 'game-corner', name: 'Game Corner' };
  assert.equal(intentTitle({ kind: 'heart', app }, t, false), 'Sign up to heart Game Corner');
  assert.equal(intentTitle({ kind: 'heart', app }, t, true), 'Create your account to heart Game Corner');
  assert.ok(require('../src/services/sign-up-from').SIGN_UP_FROM.includes('heart'));
  assert.match(read('frontend/src/features/auth/sign-up-from.ts'), /'chat',\n {2}'heart',/);
  // The page asks to sign in for it, and both project pages draw the panel.
  assert.match(read('frontend/src/features/guest/guest-project.tsx'), /onSignIn: \(\) => onIntent\(\{ kind: 'heart', app \}\)/);
  assert.match(read('frontend/src/features/guest/guest-project.tsx'), /<div data-guest-popularity=""/);
  assert.match(read('frontend/src/features/dev-board/workshop/hub-cards.tsx'), /<section className="dev-ws-hub-section" data-ws-hub-popularity="">/);
  // It leads the side column on both pages: above For you on the hub (at
  // every width: app.css orders it first where the column is laid out by
  // `order`), and above the join card signed out.
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.ok(lander.indexOf('<PopularityCard slug={slug}') > 0);
  assert.ok(lander.indexOf('<PopularityCard slug={slug}') < lander.indexOf('<ForYouCard'), 'above For you');
  assert.match(read('public/css/app.css'), /\.dev-ws-hub-side > \[data-ws-hub-popularity\] \{ order: 0; \}/);
  const guest = read('frontend/src/features/guest/guest-project.tsx');
  assert.ok(guest.indexOf('<div data-guest-popularity=""') < guest.indexOf('<section data-guest-made=""'), 'above the join card');
});

/** A browser's storage, timers and fetch, enough for the device's half. */
function withBrowser(run) {
  const store = new Map();
  const timers = [];
  const calls = [];
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  globalThis.window = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
  };
  globalThis.fetch = (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true, json: async () => ({}) }); };
  const fire = () => { for (const timer of timers.splice(0)) if (timer.live) timer.fn(); };
  try {
    return run({ store, timers, calls, fire });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
}

test('a visitor\'s play is reported after the app has stayed open, once per app per day from a browser', () => {
  withBrowser(({ store, timers, calls, fire }) => {
    const { watchVisitorPlay, visitorPlayedToday, VISITOR_PLAY_AFTER_MS, VISITOR_PLAYS_KEY } = loadTsx(LOGIC, { cache: false });
    const DAY1 = Date.parse('2026-11-27T10:00:00Z');
    const DAY2 = Date.parse('2026-11-28T10:00:00Z');
    // Closed before the wait is over: nothing is reported.
    const stop = watchVisitorPlay('game-corner', { now: () => DAY1 });
    assert.equal(timers[0].ms, VISITOR_PLAY_AFTER_MS);
    assert.equal(VISITOR_PLAY_AFTER_MS, 10000);
    stop();
    fire();
    assert.equal(calls.length, 0);
    // Kept open: one POST, with no cookie and no body.
    watchVisitorPlay('game-corner', { now: () => DAY1 });
    fire();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/public/apps/game-corner/plays');
    assert.deepEqual(calls[0].init, { method: 'POST', credentials: 'omit' });
    assert.equal(visitorPlayedToday('game-corner', DAY1), true);
    // Again the same day: not even a timer. Another app, or another day, is a new play.
    watchVisitorPlay('game-corner', { now: () => DAY1 });
    assert.equal(timers.length, 0);
    watchVisitorPlay('bread-bot', { now: () => DAY1 });
    fire();
    assert.equal(calls.length, 2);
    watchVisitorPlay('game-corner', { now: () => DAY2 });
    fire();
    assert.equal(calls.length, 3);
    assert.deepEqual(JSON.parse(store.get(VISITOR_PLAYS_KEY)), { 'game-corner': '2026-11-28' }, 'other days\' notes are dropped');
  });
});

test('a heart pressed with no account is kept for one app and given once', () => {
  withBrowser(({ store }) => {
    const { rememberHeart, takePendingHeart, PENDING_HEART_KEY } = loadTsx(LOGIC, { cache: false });
    assert.equal(takePendingHeart('game-corner'), false);
    rememberHeart('game-corner');
    assert.equal(store.get(PENDING_HEART_KEY), 'game-corner');
    assert.equal(takePendingHeart('bread-bot'), false, 'another app\'s page does not take it');
    assert.equal(takePendingHeart('game-corner'), true);
    assert.equal(takePendingHeart('game-corner'), false, 'given once');
    assert.equal(store.has(PENDING_HEART_KEY), false);
  });
  // Storage that refuses (a private window) keeps nothing and breaks nothing.
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('refused'); }, setItem() { throw new Error('refused'); }, removeItem() {} };
  try {
    const { rememberHeart, takePendingHeart, visitorPlayedToday } = loadTsx(LOGIC, { cache: false });
    rememberHeart('game-corner');
    assert.equal(takePendingHeart('game-corner'), false);
    assert.equal(visitorPlayedToday('game-corner'), false);
  } finally {
    if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved;
  }
});

test('the routes: any account that can see an app can heart it; a visitor\'s play names nobody', () => {
  const apps = read('src/routes/apps.js');
  assert.match(apps, /router\.get\('\/api\/apps\/:slug\/heart', async/);
  assert.match(apps, /router\.put\('\/api\/apps\/:slug\/heart', sameOriginBrowserOnly, setHeart\(true\)\);/);
  assert.match(apps, /router\.delete\('\/api\/apps\/:slug\/heart', sameOriginBrowserOnly, setHeart\(false\)\);/);
  const heart = apps.slice(apps.indexOf('const heartApp = async'), apps.indexOf("router.get('/api/apps/:slug/heart'"));
  assert.match(heart, /if \(!req\.user\?\.id\) return \{ status: 401/);
  assert.match(heart, /appAccess\.getAppForUser\(pool, req\.params\.slug, req\.user, 'view', appAccess\.ACCESS_COLUMNS\)/, 'seeing it is enough');
  assert.doesNotMatch(heart, /requireAppMembership|join_required|'collab'/, 'no membership gate: a heart is not taking part');
  assert.match(heart, /if \(!app \|\| app\.self_hosted\) return \{ status: 404/, 'the platform\'s own project has no app to heart');
  assert.match(apps, /popularity = await appPopularity\.summaryFor\(pool, app\.id, req\.user\?\.id \?\? null\);/);

  const pub = read('src/routes/public-api.js');
  const play = pub.slice(pub.indexOf("router.post('/api/public/apps/:slug/plays'"), pub.indexOf('// GET /api/public/apps/:slug/top-contributors'));
  assert.match(play, /^router\.post\('\/api\/public\/apps\/:slug\/plays', publicPlayLimiter, sameOriginBrowserOnly, async/);
  assert.match(play, /if \(!isPublicDirectoryApp\(app\) \|\| !guestReady\(app\)\) return res\.status\(404\)/, 'only an app a visitor can open here');
  assert.match(play, /anonymousSource\(clientIp\(req\), \{ key: config && config\.sessionSecret \}\)/);
  assert.doesNotMatch(play, /req\.user|req\.body|req\.cookies/, 'nothing about who, and nothing taken from the request but the app');
  assert.match(read('src/middleware/rate-limits.js'), /const publicPlayLimiter = makeLimiter\(\{[^}]*name: 'public-play'/);

  // The shots' sample project is given hearts and plays, on staging only.
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /stagingSeed\('seedStagingHeartsAndPlays', async \(pool, config\) => seedStagingHeartsAndPlays\(pool\)\)/);
  const seed = migrate.slice(migrate.indexOf('async function seedStagingHeartsAndPlays'), migrate.indexOf('// The signed-out project page\'s Discussion (26 Nov 2026)'));
  assert.match(seed, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/);
  assert.equal((seed.match(/ON CONFLICT DO NOTHING/g) || []).length, 2, 'idempotent');
});
