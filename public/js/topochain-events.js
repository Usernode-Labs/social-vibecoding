// Shared "which event should this screen open on?" rule, consumed by
// topochain-event-context.js — the module that owns the ONE event selection
// the Leaderboard screen's Topochain and Challenges tabs both read.
//
// Why this exists: `GET /api/v4/leaderboard` with no `season_event_id`
// resolves "current" strictly — internal = FALSE AND is_active = TRUE AND
// starts_at <= NOW() AND ends_at >= NOW() — and 404s when nothing is
// temporally running (src/routes/topochain/public.js). Between events that
// is the normal state of the world, and the leaderboard screen used to turn
// the 404 into a red error banner. The server rule is spec'd (SPEC 902-965,
// pinned by tests/topochain-public-api.test.js) and shared with the partner
// and mobile surfaces, so the fallback belongs on the client.
//
// The rule: prefer the event that is running right now; otherwise the most
// recent PAST event that will actually render standings. Callers pass the
// list straight from `GET /api/v4/season-events?include_past=1`, which is
// already filtered to `internal = FALSE` and ordered `starts_at DESC`
// server-side — so "most recent" is just the first match in list order.
//
// Keeping this in one place is the point: the standings and the challenge
// list must agree on which event they mean, or they silently describe
// different weeks. Before the leaderboard merge three separate screens each
// called this helper to stay in step; now one shared selection does, which
// is the same guarantee enforced structurally.
'use strict';

const TopochainEvents = {
  // Pick the event a screen should default to.
  //
  //   events   — array from GET /api/v4/season-events?include_past=1
  //   opts.requireLeaderboard
  //            — when true (the leaderboard screen), only consider events
  //              whose standings actually render. `display_leaderboard`
  //              false yields the same envelope with an empty list, which
  //              would look like a bug on a screen whose whole job is the
  //              table. The seasons/challenges screens don't care: they
  //              render the challenge list, not standings.
  //
  // Returns the chosen event object, or null when the list is empty (or
  // every entry is filtered out) — callers treat null as "no events at
  // all", which is a neutral empty state, not an error.
  pickDefault(events, opts) {
    const list = Array.isArray(events) ? events : [];
    if (!list.length) return null;
    const requireLeaderboard = !!(opts && opts.requireLeaderboard);

    // `display_leaderboard` is only meaningful when the payload carries it.
    // Treat an absent key as "yes" so this helper keeps working against an
    // older server that predates the field.
    const renders = (ev) => !requireLeaderboard ||
      ev.display_leaderboard === undefined || ev.display_leaderboard === true;

    // `is_current` is computed server-side on /api/v4/season-events. The
    // /challenges-api/seasons payload carries starts_at/ends_at but no
    // such flag, so derive it — one rule, both entity grains.
    const current = list.find((ev) => TopochainEvents.isCurrent(ev) && renders(ev));
    if (current) return current;

    // No event is running. Fall back to the most recent one that has
    // already ended — the list is starts_at DESC, so the first past entry
    // is the newest. Deliberately skips events that have not STARTED yet:
    // an upcoming event has no standings and no completed challenges, so
    // opening on it shows an empty screen with no explanation.
    const now = Date.now();
    const hasStarted = (ev) => {
      const t = Date.parse(ev.starts_at);
      return Number.isNaN(t) ? true : t <= now;
    };
    const past = list.find((ev) => hasStarted(ev) && renders(ev));
    if (past) return past;

    // Everything left is upcoming (or filtered out). Prefer the soonest
    // upcoming event over nothing at all — the list is DESC, so that's the
    // last entry.
    const upcoming = list.filter(renders);
    return upcoming.length ? upcoming[upcoming.length - 1] : null;
  },

  // Running right now. Prefers the server-computed flag when present
  // (/api/v4/season-events), else derives it from the window.
  isCurrent(ev) {
    if (!ev) return false;
    if (typeof ev.is_current === 'boolean') return ev.is_current;
    const start = Date.parse(ev.starts_at);
    const end = Date.parse(ev.ends_at);
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    const now = Date.now();
    return start <= now && now <= end;
  },

  // True when the chosen event is over — drives the "nothing is running
  // right now" caption and the picker's placeholder label.
  hasEnded(ev) {
    if (!ev) return false;
    if (TopochainEvents.isCurrent(ev)) return false;
    const t = Date.parse(ev.ends_at);
    return Number.isNaN(t) ? false : t < Date.now();
  },
};

// Explicitly publish onto the global. A top-level `const` in a CLASSIC
// script lives in script scope, NOT on `window` — so the consumers'
// `window.TopochainEvents` guard would silently see `undefined` and every
// screen would fall back to its old per-screen rule. (The other modules
// here get away with a bare `const` because they are referenced by bare
// name; this one is feature-detected, which is what makes the difference.)
if (typeof window !== 'undefined') window.TopochainEvents = TopochainEvents;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TopochainEvents };
}
