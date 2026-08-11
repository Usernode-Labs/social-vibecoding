// Between-events landing state for the three topochain screens.
//
// The bug this pins: `GET /api/v4/leaderboard` with no `season_event_id`
// resolves "current" strictly (internal = FALSE AND is_active = TRUE AND
// starts_at <= NOW() AND ends_at >= NOW()) and 404s otherwise. Between
// events that is the normal state of the world — production has sat there
// since "Season 1" ended — and the leaderboard screen turned the 404 into
// a red error banner on its DEFAULT landing state.
//
// The server rule is spec'd (SPEC 902-965) and shared with the partner and
// mobile surfaces, so the fallback lives on the client in
// public/js/topochain-events.js. Two layers here:
//   1. Behavioural — exercise the real pickDefault/hasEnded/isCurrent.
//   2. Static — assert the three screens actually CALL it, so a future
//      edit can't quietly reintroduce a per-screen rule and let the
//      leaderboard and the challenge list describe different weeks.
//
// Run with: node --test tests/topochain-event-fallback.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_JS = path.join(__dirname, '..', 'public', 'js');
// The shared helper is still a classic script; its three consumers moved into
// the React bundle with the Leaderboard screen (#1083 chunk F), so the static
// half below resolves each side from where it actually lives now.
const LEADERBOARD_SRC = path.join(
  __dirname, '..', 'frontend', 'src', 'features', 'leaderboard');
const { TopochainEvents } = require(path.join(PUBLIC_JS, 'topochain-events.js'));

const DAY = 24 * 60 * 60 * 1000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString();

// The list shape `GET /api/v4/season-events?include_past=1` returns:
// already filtered to internal = FALSE, ordered starts_at DESC.
const ev = (id, startDays, endDays, extra = {}) => ({
  id,
  name: `Event ${id}`,
  starts_at: at(startDays),
  ends_at: at(endDays),
  is_active: true,
  is_current: startDays <= 0 && endDays >= 0,
  display_leaderboard: true,
  ...extra,
});

// ─── (a) an event is current ────────────────────────────────────────────

test('pickDefault: prefers the event running right now', () => {
  const upcoming = ev(3, 10, 20);
  const current = ev(2, -5, 5);
  const past = ev(1, -60, -30);
  // starts_at DESC, as the server returns it.
  const picked = TopochainEvents.pickDefault([upcoming, current, past]);
  assert.equal(picked.id, 2);
  assert.equal(TopochainEvents.hasEnded(picked), false,
    'a running event must not trigger the "nothing is running" caption');
});

// ─── (a2) the season aggregate outranks every single event (#999) ───────
//
// The bug: production's public events were Testnet Phase 0/1, the
// `type='season'` "Season 1" event (started 2026-03-16) and "Season 1 Beta"
// (started 2026-03-18). With nothing running, step (b) below picked the
// newest STARTED event — Beta, by a 48-hour margin — so the leaderboard
// opened on a three-week slice showing 1900.00 for the person the season
// had at 67973.66. A season's standings are the dataset "the leaderboard"
// means; individual events stay in the picker.

test('pickDefault: a started season event beats a more recently started regular one', () => {
  // The exact production shape, in list order (starts_at DESC).
  const beta = ev(8, -140, -118);                     // "Season 1 Beta"
  const season = ev(7, -143, -37, { type: 'season' }); // "Season 1"
  const phase1 = ev(3, -204, -188);
  const picked = TopochainEvents.pickDefault([beta, season, phase1]);
  assert.equal(picked.id, 7, 'the season aggregate, not the newest sub-event');
});

test('pickDefault: the season aggregate outranks an event running right now', () => {
  // Deliberate: the season board already includes the running event's
  // latest snapshots, and the picker offers the event-only view one click
  // away. Landing on the sub-event is what hid the season totals.
  const running = ev(2, -5, 5);
  const season = ev(1, -60, 60, { type: 'season' });
  assert.equal(TopochainEvents.pickDefault([running, season]).id, 1);
});

test('pickDefault: an UNSTARTED season event does not hijack the board', () => {
  // An organiser creating next season's wrap-up event in advance must not
  // move today's default onto a board whose hero reads "upcoming".
  const future = ev(2, 15, 30, { type: 'season' });
  const running = ev(1, -5, 5);
  assert.equal(TopochainEvents.pickDefault([future, running]).id, 1,
    'falls through to the pre-#999 rule');
});

test('pickDefault: the season step still respects requireLeaderboard', () => {
  const hiddenSeason = ev(2, -30, 30, { type: 'season', display_leaderboard: false });
  const shown = ev(1, -120, -90);
  assert.equal(TopochainEvents.pickDefault([hiddenSeason, shown], { requireLeaderboard: true }).id, 1,
    'a season event whose standings are switched off is skipped like any other');
  assert.equal(TopochainEvents.pickDefault([hiddenSeason, shown]).id, 2,
    'without the option it wins, and the standings pane shows its own copy');
});

test('pickDefault: a payload with no `type` key behaves exactly as before', () => {
  // /challenges-api/seasons carries no `type`, and neither does a server
  // predating the field — the helper must not read absent as "season".
  const newest = ev(2, -30, -10);
  const older = ev(1, -120, -90);
  assert.equal(TopochainEvents.pickDefault([newest, older]).id, 2);
  assert.equal(TopochainEvents.isSeasonAggregate(newest), false);
  assert.equal(TopochainEvents.isSeasonAggregate(null), false);
  assert.equal(TopochainEvents.isSeasonAggregate({ type: 'season' }), true);
});

test('the server-side twin orders the season step FIRST and guards on started', () => {
  // pickDefault (client) and DEFAULT_PUBLIC_EVENT_SQL (server) are two
  // hand-kept copies of one rule; the home widget resolves its board
  // through the SQL one, so a drift shows up as the home screen and the
  // leaderboard disagreeing about which board they mean.
  const { DEFAULT_PUBLIC_EVENT_SQL } = require('../src/services/topochain/event-standings');
  const seasonKey = DEFAULT_PUBLIC_EVENT_SQL.indexOf("type = 'season'");
  const runningKey = DEFAULT_PUBLIC_EVENT_SQL.indexOf('is_active = TRUE');
  assert.ok(seasonKey > -1, 'the SQL must prefer the season-type event');
  assert.ok(runningKey > -1, 'and still keep the running-event key');
  assert.ok(seasonKey < runningKey,
    'the season key must sort BEFORE the running-event key, or a live sub-event wins');
  // The guard, on the season key specifically (the ORDER BY's first line).
  const firstKey = DEFAULT_PUBLIC_EVENT_SQL.slice(seasonKey).split('\n')[0];
  assert.match(firstKey, /starts_at <= NOW\(\)/,
    'an unstarted season event must not be preferred');
  // Scope is unchanged: internal events and switched-off standings never win.
  assert.match(DEFAULT_PUBLIC_EVENT_SQL, /internal = FALSE AND display_leaderboard = TRUE/);
});

// ─── (b) none is current → newest ENDED public event ────────────────────

test('pickDefault: with nothing running, picks the most recent ended event', () => {
  const upcoming = ev(3, 10, 20);
  const recentPast = ev(2, -30, -10);
  const olderPast = ev(1, -120, -90);
  const picked = TopochainEvents.pickDefault([upcoming, recentPast, olderPast]);
  assert.equal(picked.id, 2, 'newest ended, not the oldest and not the upcoming one');
  assert.equal(TopochainEvents.hasEnded(picked), true,
    'the caption + "Most recent event" placeholder key off this');
});

test('pickDefault: skips an event whose leaderboard is switched off', () => {
  // display_leaderboard = false yields the same envelope with an EMPTY
  // list, which on a standings screen looks like a bug. The seasons and
  // challenges screens don't pass the flag — they render challenges.
  const hidden = ev(2, -30, -10, { display_leaderboard: false });
  const shown = ev(1, -120, -90);
  assert.equal(
    TopochainEvents.pickDefault([hidden, shown], { requireLeaderboard: true }).id, 1);
  assert.equal(
    TopochainEvents.pickDefault([hidden, shown]).id, 2,
    'without requireLeaderboard the newest event wins regardless');
});

test('pickDefault: an upcoming-only list falls back to the soonest upcoming', () => {
  // Better than rendering nothing: the screen shows the event that is
  // about to start rather than an empty state with no explanation.
  const later = ev(2, 30, 40);
  const sooner = ev(1, 10, 20);
  assert.equal(TopochainEvents.pickDefault([later, sooner]).id, 1);
});

// ─── (c) the event list is empty ────────────────────────────────────────

test('pickDefault: an empty list yields null, not a throw', () => {
  assert.equal(TopochainEvents.pickDefault([]), null);
  assert.equal(TopochainEvents.pickDefault(null), null);
  assert.equal(TopochainEvents.pickDefault(undefined), null);
});

test('hasEnded: null-safe and false for an event still running', () => {
  assert.equal(TopochainEvents.hasEnded(null), false);
  assert.equal(TopochainEvents.hasEnded(ev(1, -5, 5)), false);
  assert.equal(TopochainEvents.hasEnded(ev(1, -50, -5)), true);
});

// ─── seasons payload (no server-computed is_current) ────────────────────

test('isCurrent: derived from the window when the flag is absent', () => {
  // /challenges-api/seasons carries starts_at/ends_at but no is_current,
  // so the challenges screen depends on this derivation.
  const season = { id: 7, starts_at: at(-10), ends_at: at(10) };
  assert.equal(TopochainEvents.isCurrent(season), true);
  assert.equal(TopochainEvents.pickDefault([season]).id, 7);

  const endedSeason = { id: 8, starts_at: at(-100), ends_at: at(-50) };
  assert.equal(TopochainEvents.isCurrent(endedSeason), false);
  assert.equal(TopochainEvents.hasEnded(endedSeason), true);
});

test('isCurrent: unparseable dates are not current (never throws)', () => {
  assert.equal(TopochainEvents.isCurrent({ starts_at: 'nope', ends_at: 'nope' }), false);
  assert.equal(TopochainEvents.hasEnded({ ends_at: 'nope' }), false);
});

// ─── Static: the screens actually use the shared rule ───────────────────

// The three Topochain panes are bundle sources now; topochain-events.js is
// not. Resolve per file rather than from one directory.
const read = (f) => fs.readFileSync(
  path.join(f === 'topochain-events.js' ? PUBLIC_JS : LEADERBOARD_SRC, f), 'utf8');

// Since the leaderboard merge there is exactly ONE consumer of the shared
// rule: TopochainEventContext, which owns the event selection for both
// Topochain-domain tabs of the Leaderboard screen. The three per-screen
// pickers this used to police (topochain-leaderboard.js,
// topochain-seasons.js, challenges.js) collapsed into it — which is a
// stronger version of the same guarantee: the panes can no longer disagree
// about the period because they no longer each resolve one.
test('the one shared event selection resolves its default through TopochainEvents', () => {
  assert.match(read('topochain-event-context.js'), /TopochainEvents\.pickDefault\(/,
    'the event context must use the shared picker');
  // And no pane may quietly grow a second default-pick of its own again.
  for (const f of ['topochain-leaderboard.js', 'topochain-challenges.js']) {
    assert.doesNotMatch(read(f), /TopochainEvents\.pickDefault\(/,
      `${f} must read the shared selection, not resolve its own`);
  }
});

test('the shared default does not narrow to leaderboard-rendering events', () => {
  // The standings pane used to pass requireLeaderboard: true. The selection
  // is shared with the challenges pane now, and that pane renders fine for
  // an event whose standings are switched off — narrowing the shared
  // default would hide challenges for no reason. The standings pane still
  // has its own per-pane answer (`display_leaderboard === false` copy).
  // Strip comments: the module header explains in words WHY it doesn't pass
  // the option, which is documentation, not a usage.
  assert.doesNotMatch(
    read('topochain-event-context.js').replace(/\/\/[^\n]*/g, ''),
    /requireLeaderboard/);
  assert.match(read('topochain-leaderboard.js'), /display_leaderboard/,
    'the standings pane still handles a non-public leaderboard itself');
});

test('a 404 from /leaderboard no longer paints the red error banner', () => {
  const src = read('topochain-leaderboard.js');
  // The 404 branch must route to the neutral `_empty` copy. The red block
  // is reserved for `_error`, which a 404 must not set.
  assert.match(src, /if \(status === 404\)[\s\S]{0,400}_empty\s*=/,
    'a 404 sets the neutral empty state');
  assert.match(src, /if \(status === 404\)[\s\S]{0,400}_error\s*=\s*null/,
    'a 404 explicitly clears _error so the red banner cannot render');
});

test('the ended-event caption is wired to the fallback flag', () => {
  // One caption, in the shared event bar, so both tabs say the same thing.
  const ctx = read('topochain-event-context.js');
  assert.match(ctx, /_endedFallback/, 'the event bar tracks whether the fallback fired');
  assert.match(ctx, /TopochainEvents\.hasEnded\(pick\)/, 'and sets it from the shared rule');
  assert.match(ctx, /Nothing is running right now/, 'explanatory caption');
  // An explicit pick is not a fallback — the caption must clear.
  assert.match(ctx, /_endedFallback = false/);
  // ...but a silent server-resolved write-back is not a pick either way, so
  // it must NOT clear the caption.
  const sel = ctx.slice(ctx.indexOf('  select(id, opts) {'), ctx.indexOf('  async _loadDetail()'));
  assert.match(sel, /if \(!\(opts && opts\.silent\)\) TopochainEventContext\._endedFallback = false;/,
    'a silent write-back leaves the caption alone');
  // No pane may render a competing copy of the caption.
  for (const f of ['topochain-leaderboard.js', 'topochain-challenges.js']) {
    assert.doesNotMatch(read(f), /Nothing is running right now/,
      `${f} must not render a second copy of the caption`);
  }
});

test('the helper publishes itself onto window (classic-script scoping)', () => {
  // Caught in the browser, not by the unit tests above: a top-level
  // `const` in a classic script is script-scoped, so `window.X` is
  // undefined and every consumer's feature-detect silently fails back to
  // its old per-screen rule — the leaderboard 404s exactly as before.
  const src = read('topochain-events.js');
  assert.match(src, /window\.TopochainEvents = TopochainEvents/);

  // Prove it end to end in a script-like scope: eval the file with a fake
  // window and assert the global is populated.
  const sandboxWindow = {};
  new Function('window', 'module', src)(sandboxWindow, undefined);
  assert.ok(sandboxWindow.TopochainEvents,
    'evaluating the file must publish window.TopochainEvents');
  assert.equal(typeof sandboxWindow.TopochainEvents.pickDefault, 'function');
});

test('the shared helper ships to the browser before its consumers', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const helper = html.indexOf('/js/topochain-events.js"');
  assert.ok(helper > -1, 'topochain-events.js must be loaded by index.html');

  // All four consumers — the profile screen and the three Topochain panes —
  // are inside the React bundle since #1083 chunk F, so this is no longer a
  // tag-order comparison, and deliberately not one: the bundle tag sits in
  // the <head>, ABOVE every classic tag, and is still guaranteed to run after
  // all of them because `type="module"` is deferred. That is what keeps a
  // script-scoped `const TopochainEvents`, published onto window by a classic
  // tag, in place before a bundle consumer's first line. So what has to hold
  // is the module attribute, not a position — a classic bundle tag anywhere
  // would race the helper.
  assert.match(html, /<script type="module" src="\/shell\/assets\/shell\.js"><\/script>/,
    'the React bundle must be loaded by index.html, as a module script');
  for (const f of ['profile.js', 'topochain-event-context.js',
    'topochain-leaderboard.js', 'topochain-challenges.js']) {
    assert.equal(html.indexOf(`/js/${f}"`), -1,
      `${f} moved into the bundle — a revived classic tag would race the helper`);
  }

  // Offline parity: an asset the SPA needs but the SW doesn't cache is a
  // broken screen on a cold offline load. The four consumers ride in
  // /shell/assets/shell.js, which SHELL_ASSETS lists in their place.
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(sw, /'\/js\/topochain-events\.js'/);
  assert.match(sw, /'\/shell\/assets\/shell\.js'/);
});
