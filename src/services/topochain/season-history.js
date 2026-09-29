'use strict';

// Past seasons, who won them, who won each of their events, and where the
// viewer finished — the Leaderboard screen's History segment.
//
// The navigation prototype's Challenges page carries four segments,
// Challenges / Standings / History / Kudos, and History is the one the
// product never had: the event <select> above the standings reaches a past
// event one at a time, but nothing said "Season 2 ended in June, Lee won it,
// Maya took epoch 1, you came fourth". Every number here already existed —
// this module only reads it for ALL past seasons in one pass:
//
//   * a season is PAST once `seasons.ends_at` has gone by. Internal seasons
//     never surface publicly, the same rule every standings view applies.
//   * the SEASON winner is the top of that season's aggregate standings —
//     computeStandings({ seasonId }), the very query the Standings tab runs
//     for a season-type event — skipping podium-excluded accounts, exactly as
//     the rank column does.
//   * an EVENT winner ("epoch" in the prototype's words) is the top of that
//     event's latest snapshot, for every ended `regular` event of those
//     seasons with its leaderboard switched on, in ONE statement.
//   * "you finished #N" is the viewer's row in the season standings.
//
// ── Why it is cached ───────────────────────────────────────────────────
//
// An ended season's standings do not move, and computeStandings is the
// heaviest read the leaderboard has. Everything viewer-INDEPENDENT is built
// once and kept for HISTORY_TTL_MS (the home widget memoises its board the
// same way, src/routes/home-panels.js); the per-viewer line is a Map lookup
// on that. Concurrent misses share one build.
//
// Names go through resolveDisplayName, the chain the Standings tab itself
// prints, so "Lee won" names the row the reader will find on that tab.

const { computeStandings } = require('./standings');
const { resolveDisplayName } = require('./event-standings');
// `iso` is the v4 group's own date spelling (an explicit +00:00 offset).
const { num, iso } = require('../../routes/topochain/helpers');

// How far back History reaches. A season is weeks long, so six is a year
// or more of them — and it bounds the one expensive query per season.
const HISTORY_SEASON_LIMIT = 6;
const HISTORY_TTL_MS = 10 * 60 * 1000;

const PAST_SEASONS_SQL = `
  SELECT s.id, s.name, s.starts_at, s.ends_at
    FROM seasons s
   WHERE s.internal = FALSE
     AND s.ends_at < NOW()
   ORDER BY s.ends_at DESC, s.id DESC
   LIMIT $1
`;

const PAST_EVENTS_SQL = `
  SELECT se.id, se.name, se.season_id, se.starts_at, se.ends_at
    FROM season_events se
   WHERE se.season_id = ANY($1::bigint[])
     AND se.internal = FALSE
     AND se.display_leaderboard = TRUE
     AND se.type = 'regular'
     AND se.ends_at < NOW()
   ORDER BY se.starts_at ASC, se.id ASC
`;

// The latest snapshot per (event, user), then the best-ranked row per event
// that is not podium-excluded. Rank comes straight off the stored snapshot,
// as it does on the Standings tab for a regular event (EVENT_LEADERBOARD_SQL).
const EVENT_WINNERS_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (ls.season_event_id, ls.user_id)
           ls.season_event_id, ls.user_id, ls.rank, ls.total_points
      FROM leaderboard_snapshots ls
     WHERE ls.season_event_id = ANY($1::bigint[])
     ORDER BY ls.season_event_id, ls.user_id, ls.snapshot_at DESC, ls.id DESC
  )
  SELECT DISTINCT ON (l.season_event_id)
         l.season_event_id, l.user_id, l.total_points,
         u.email, u.telegram, u.discord, u.display_name, u.username
    FROM latest l
    JOIN users u ON u.id = l.user_id
   WHERE u.exclude_podium IS NOT TRUE
   ORDER BY l.season_event_id, l.rank ASC, l.total_points DESC, l.user_id ASC
`;

function points(value) {
  return Math.round(num(value) ?? 0);
}

// Pure (exported for tests): a standings / winner row → { name, points }.
function winnerOf(row) {
  if (!row) return null;
  return { name: resolveDisplayName(row) || 'anonymous', points: points(row.total_points) };
}

// Pure (exported for tests): assemble the viewer-independent history from
// the three reads. `standingsBySeason` maps a season id to its
// computeStandings rows. Returns { seasons, finishes } where `finishes` maps
// a season id to Map<userId, { rank, points }>.
function assembleHistory({ seasons, events, eventWinners, standingsBySeason }) {
  const winnerByEvent = new Map();
  for (const row of eventWinners || []) winnerByEvent.set(Number(row.season_event_id), row);
  const eventsBySeason = new Map();
  for (const ev of events || []) {
    const key = Number(ev.season_id);
    if (!eventsBySeason.has(key)) eventsBySeason.set(key, []);
    eventsBySeason.get(key).push({
      id: Number(ev.id),
      name: ev.name,
      ends_at: iso(ev.ends_at),
      winner: winnerOf(winnerByEvent.get(Number(ev.id))),
    });
  }

  const out = [];
  const finishes = new Map();
  for (const season of seasons || []) {
    const id = Number(season.id);
    const standings = (standingsBySeason && standingsBySeason.get(id)) || [];
    const seasonEvents = eventsBySeason.get(id) || [];
    // A season that ended with nobody on its board and no event decided has
    // nothing to tell anyone; leaving it out beats a card of dashes.
    if (!standings.length && !seasonEvents.some((ev) => ev.winner)) continue;
    const finish = new Map();
    for (const row of standings) {
      finish.set(Number(row.user_id), {
        rank: row.is_non_podium ? null : Number(row.rank) || null,
        points: points(row.total_points),
      });
    }
    finishes.set(id, finish);
    out.push({
      season_id: id,
      name: season.name,
      starts_at: iso(season.starts_at),
      ends_at: iso(season.ends_at),
      participants: standings.length,
      winner: winnerOf(standings.find((row) => !row.is_non_podium) || null),
      events: seasonEvents,
    });
  }
  return { seasons: out, finishes };
}

// Pure (exported for tests): the viewer's copy of the cached history.
function forViewer(base, viewerId) {
  const id = viewerId != null ? Number(viewerId) : null;
  return base.seasons.map((season) => {
    const finish = id != null ? base.finishes.get(season.season_id) : null;
    return { ...season, you: (finish && finish.get(id)) || null };
  });
}

async function buildHistory(pool, { limit = HISTORY_SEASON_LIMIT } = {}) {
  const { rows: seasons } = await pool.query(PAST_SEASONS_SQL, [limit]);
  if (!seasons.length) return { seasons: [], finishes: new Map() };
  const seasonIds = seasons.map((s) => Number(s.id));
  const { rows: events } = await pool.query(PAST_EVENTS_SQL, [seasonIds]);
  const eventIds = events.map((e) => Number(e.id));
  const [eventWinners, standingsList] = await Promise.all([
    eventIds.length
      ? pool.query(EVENT_WINNERS_SQL, [eventIds]).then((r) => r.rows)
      : Promise.resolve([]),
    // One aggregate per season, bounded by HISTORY_SEASON_LIMIT and cached
    // below. In sequence rather than all at once, so a cold cache costs the
    // pool one connection rather than six.
    (async () => {
      const list = [];
      for (const id of seasonIds) {
        // eslint-disable-next-line no-await-in-loop -- bounded, see above
        list.push([id, await computeStandings(pool, { seasonId: id })]);
      }
      return list;
    })(),
  ]);
  return assembleHistory({
    seasons, events, eventWinners, standingsBySeason: new Map(standingsList),
  });
}

let cache = { at: 0, value: null, pending: null };

async function seasonHistory(pool, { viewerId = null, now = Date.now() } = {}) {
  if (!cache.value || now - cache.at > HISTORY_TTL_MS) {
    if (!cache.pending) {
      cache.pending = buildHistory(pool)
        .then((value) => {
          cache = { at: Date.now(), value, pending: null };
          return value;
        })
        .catch((err) => {
          cache.pending = null;
          throw err;
        });
    }
    await cache.pending;
  }
  return forViewer(cache.value, viewerId);
}

function resetSeasonHistoryCache() {
  cache = { at: 0, value: null, pending: null };
}

// Staging-only ?demo=1 rows, used ONLY when the real read found no past
// season at all — a fresh staging database has no ended season, and the
// segment would otherwise be reviewable only as its empty state. Display
// only; nothing reads it back. Two seasons, the shape the prototype draws.
function demoSeasonHistory(now = Date.now()) {
  const day = 86400000;
  const at = (days) => iso(new Date(now - days * day));
  return [
    {
      season_id: -2, name: 'Staging demo season 2', starts_at: at(150), ends_at: at(90),
      participants: 14, winner: { name: 'lee', points: 3100 }, you: { rank: 4, points: 1520 },
      events: [
        { id: -21, name: 'Epoch 1', ends_at: at(130), winner: { name: 'maya', points: 980 } },
        { id: -22, name: 'Epoch 2', ends_at: at(110), winner: { name: 'lee', points: 1040 } },
        { id: -23, name: 'Epoch 3', ends_at: at(90), winner: { name: 'lee', points: 1110 } },
      ],
    },
    {
      season_id: -1, name: 'Staging demo season 1', starts_at: at(240), ends_at: at(180),
      participants: 9, winner: { name: 'maya', points: 2700 }, you: { rank: 6, points: 610 },
      events: [
        { id: -11, name: 'Epoch 1', ends_at: at(210), winner: { name: 'maya', points: 1300 } },
        { id: -12, name: 'Epoch 2', ends_at: at(180), winner: { name: 'sam', points: 1250 } },
      ],
    },
  ];
}

module.exports = {
  seasonHistory,
  resetSeasonHistoryCache,
  assembleHistory,
  forViewer,
  winnerOf,
  demoSeasonHistory,
  HISTORY_SEASON_LIMIT,
  HISTORY_TTL_MS,
  PAST_SEASONS_SQL,
  PAST_EVENTS_SQL,
  EVENT_WINNERS_SQL,
};
