'use strict';

// The admin Journey page's definitions (#3369, slice 1: the backend).
//
// One file holds every rule the page reads: who counts as a real person,
// what a week and a cohort are, when a group is active, how a visit is cut
// and when one looks lost. The queries live here too, as static SQL built
// only from the constants in this file, so `npm run lint:sql` checks every
// one of them against the real schema.
//
// Two conventions hold throughout:
//
//   * A fact that is not recorded is returned as `notRecorded(reason)`, never
//     as 0. The page prints "not recorded yet"; a zero would claim something.
//   * People are names and counts. Cohorts are one to four people, so no
//     endpoint returns a percentage.

const { NAV_SCREENS } = require('./ui-telemetry');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// A visit ends after this long with no telemetry of any kind from the person
// (a screen, an action or "hidden"). Same 30 minutes PostHog, Snowplow and
// Plausible use, and the telemetry client's own "returned" threshold.
const VISIT_GAP_MS = 30 * 60 * 1000;

// A newcomer is in their first 28 days with access.
const NEWCOMER_DAYS = 28;

// An active group: 2 to 6 real people in one project in one week.
const GROUP_MIN = 2;
const GROUP_MAX = 6;

// "Possibly lost": a visit that is fast, circling and ends with nothing.
// Named once, returned with every flag, tuned on the first cohorts. No
// published threshold exists for this combination; these are a start.
const LOST_CUTOFFS = Object.freeze({
  minSteps: 8,              // at least this many screens in the visit
  maxSecondsPerStep: 6,     // fast: on average no longer than this per screen
  minRepeatShare: 0.4,      // circling: 1 - (different screens / all screens)
  landingSeconds: 30,       // a landing: staying this long on one screen
});

// A next-step row with fewer moves than this is marked "few".
const FEW_MOVES = 10;

// Real people (#3369 rulings): not an admin (view-only admins included), not
// a bot, not restricted by moderation, not deleted, not a platform service
// account (the reserved name prefixes nobody else may take), and not on the
// admin-edited left-out list. Every query that names people uses this, with
// $3 = the reserved prefixes as LIKE patterns and $4 = the left-out ids.
const RESERVED_PATTERNS = Object.freeze(['usernode%', 'staging%']);
const REAL_PERSON_SQL = `u.is_admin IS NOT TRUE
  AND u.is_synthetic IS NOT TRUE
  AND u.participation_restricted_at IS NULL
  AND u.anonymised_at IS NULL
  AND NOT (LOWER(u.username) LIKE ANY($3::text[]))
  AND NOT (u.id = ANY($4::int[]))`;

function notRecorded(reason) {
  return { recorded: false, reason };
}

// ── Weeks ──────────────────────────────────────────────────────────────

/** Monday 00:00 UTC of the week holding `date`. */
function weekStart(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * The week a request asks for, as `{ start, end, label, finished }`. `raw` is
 * a YYYY-MM-DD Monday; anything else is refused (null). With no `raw`, the
 * last finished week: comparisons always use finished weeks, and the current
 * one is only ever shown as "so far".
 */
function parseWeek(raw, now = new Date()) {
  const current = weekStart(now);
  let start;
  if (raw == null || raw === '') {
    start = new Date(current.getTime() - WEEK_MS);
  } else {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    start = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || isoDay(start) !== raw) return null;
    if (start.getUTCDay() !== 1) return null;
    if (start.getTime() > current.getTime()) return null;
  }
  const end = new Date(start.getTime() + WEEK_MS);
  return {
    start,
    end,
    label: isoDay(start),
    finished: end.getTime() <= new Date(now).getTime(),
  };
}

/** The week before `week`. */
function previousWeek(week) {
  const start = new Date(week.start.getTime() - WEEK_MS);
  return { start, end: week.start, label: isoDay(start), finished: true };
}

/** An admit date as sent in a request: a real YYYY-MM-DD, or null. */
function parseDay(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || isoDay(d) !== raw ? null : raw;
}

// ── Groups ─────────────────────────────────────────────────────────────

/** Is a project's week an active group? `crossYes`: some change had a yes
 * from a real person other than its author. */
function isActiveGroup(memberCount, crossYes) {
  return crossYes === true && memberCount >= GROUP_MIN && memberCount <= GROUP_MAX;
}

/**
 * A group's place in the standard lifecycle, from three facts about the
 * project: active in the week, in the week before, and in any week before
 * that. Null when it is none of them (never active, or quiet two weeks).
 */
function groupLifecycle({ thisWeek, lastWeek, earlier }) {
  if (thisWeek && lastWeek) return 'still_active';
  if (thisWeek && earlier) return 'back';
  if (thisWeek) return 'new';
  if (lastWeek) return 'went_quiet';
  return null;
}

// ── Visits and paths ───────────────────────────────────────────────────

/**
 * Cut one person's telemetry rows into visits. `rows` are
 * `{ at: Date|string, kind, screen, via, appSlug }` in any order; they are
 * ordered by time, and a gap of VISIT_GAP_MS or more, or a screen reported
 * as "returned", starts a new visit. Each visit keeps only its navigation
 * steps (`steps`, with the time spent on each where known) plus its start and
 * end. Repeats of the same screen in a row are already dropped by the client.
 */
function splitVisits(rows, { gapMs = VISIT_GAP_MS } = {}) {
  const sorted = rows
    .map((r) => ({ ...r, t: new Date(r.at).getTime() }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t || (a.sequence || 0) - (b.sequence || 0));
  const visits = [];
  let current = null;
  let lastAt = null;
  const close = () => {
    if (!current) return;
    const steps = current.steps;
    for (let i = 0; i < steps.length; i += 1) {
      const next = i + 1 < steps.length ? steps[i + 1].t : current.hiddenAt || current.lastAt;
      steps[i].seconds = next != null && next >= steps[i].t ? Math.round((next - steps[i].t) / 1000) : null;
    }
    current.end = current.hiddenAt || current.lastAt;
    if (steps.length) visits.push(current);
    current = null;
  };
  for (const r of sorted) {
    const isStep = r.kind === 'screen_visit' && NAV_SCREENS.has(r.screen);
    const returned = isStep && r.via === 'returned';
    if (!current || (lastAt != null && r.t - lastAt >= gapMs) || returned) {
      close();
      current = { start: r.t, steps: [], hiddenAt: null, lastAt: r.t, acted: false };
    }
    if (isStep) {
      current.steps.push({ screen: r.screen, appSlug: r.appSlug || null, via: r.via || null, t: r.t });
      current.hiddenAt = null;
    } else if (r.kind === 'screen_hidden') {
      current.hiddenAt = r.t;
    } else if (r.kind === 'action_attempt' || r.kind === 'action_outcome') {
      current.acted = true;
    }
    current.lastAt = r.t;
    lastAt = r.t;
  }
  close();
  return visits;
}

/**
 * Flag a visit that is fast, circling and ends with nothing. Returns the
 * readings and the cut-offs used, so the page can say why. `acted` comes from
 * the visit (an action in the telemetry) or from the caller, who knows about
 * acts the telemetry does not see (a message, a vote).
 */
function lostReading(visit, { acted = false, cutoffs = LOST_CUTOFFS } = {}) {
  const steps = visit.steps || [];
  const n = steps.length;
  const distinct = new Set(steps.map((s) => `${s.screen}:${s.appSlug || ''}`)).size;
  const span = n ? Math.max(0, ((visit.end || steps[n - 1].t) - steps[0].t) / 1000) : 0;
  const secondsPerStep = n ? span / n : null;
  const repeatShare = n ? 1 - distinct / n : 0;
  const landed = steps.some((s) => s.seconds != null && s.seconds >= cutoffs.landingSeconds)
    || visit.acted === true || acted === true;
  const fast = n >= cutoffs.minSteps && secondsPerStep != null && secondsPerStep <= cutoffs.maxSecondsPerStep;
  const circling = n >= cutoffs.minSteps && repeatShare >= cutoffs.minRepeatShare;
  return {
    possiblyLost: fast && circling && !landed,
    steps: n,
    distinct,
    seconds: Math.round(span),
    secondsPerStep: secondsPerStep == null ? null : Math.round(secondsPerStep * 10) / 10,
    repeatShare: Math.round(repeatShare * 100) / 100,
    landed,
    cutoffs,
  };
}

/**
 * Next-step counts over a set of visits: for each screen, the moves away from
 * it, how many people made them, the top three next screens, "Other" for the
 * rest, and "Left" (the visit ended there) always. `visitsByPerson` is a Map
 * of person id → visits. Rows are flagged when Left or Back is the most
 * common next step, and marked "few" under FEW_MOVES.
 */
function nextSteps(visitsByPerson, { top = 3 } = {}) {
  const rows = new Map();
  const entries = new Map();
  const bump = (map, key, person) => {
    const row = map.get(key) || { moves: 0, people: new Set() };
    row.moves += 1;
    row.people.add(person);
    map.set(key, row);
  };
  for (const [person, visits] of visitsByPerson) {
    for (const visit of visits) {
      const steps = visit.steps || [];
      if (!steps.length) continue;
      bump(entries, steps[0].screen, person);
      for (let i = 0; i < steps.length; i += 1) {
        const from = steps[i].screen;
        const nextStep = steps[i + 1];
        const to = !nextStep ? 'left' : (nextStep.via === 'back' ? 'back' : nextStep.screen);
        const row = rows.get(from) || { moves: 0, people: new Set(), next: new Map() };
        row.moves += 1;
        row.people.add(person);
        bump(row.next, to, person);
        rows.set(from, row);
      }
    }
  }
  const out = [];
  for (const [screen, row] of rows) {
    const ranked = [...row.next.entries()]
      .filter(([to]) => to !== 'left')
      .sort((a, b) => b[1].moves - a[1].moves || a[0].localeCompare(b[0]));
    const shown = ranked.slice(0, top).map(([to, v]) => ({ to, moves: v.moves, people: v.people.size }));
    const rest = ranked.slice(top).reduce((sum, [, v]) => sum + v.moves, 0);
    const left = row.next.get('left');
    const leftMoves = left ? left.moves : 0;
    const mostCommon = [...row.next.entries()].sort((a, b) => b[1].moves - a[1].moves)[0];
    out.push({
      screen,
      moves: row.moves,
      people: row.people.size,
      next: shown,
      other: rest,
      left: { moves: leftMoves, people: left ? left.people.size : 0 },
      deadEnd: !!mostCommon && (mostCommon[0] === 'left' || mostCommon[0] === 'back'),
      few: row.moves < FEW_MOVES,
    });
  }
  out.sort((a, b) => b.moves - a.moves || a.screen.localeCompare(b.screen));
  const starts = [...entries.entries()]
    .map(([screen, v]) => ({ screen, visits: v.moves, people: v.people.size }))
    .sort((a, b) => b.visits - a.visits || a.screen.localeCompare(b.screen));
  return { rows: out, starts };
}

module.exports = {
  DAY_MS,
  FEW_MOVES,
  GROUP_MAX,
  GROUP_MIN,
  LOST_CUTOFFS,
  NEWCOMER_DAYS,
  REAL_PERSON_SQL,
  RESERVED_PATTERNS,
  VISIT_GAP_MS,
  WEEK_MS,
  groupLifecycle,
  isActiveGroup,
  isoDay,
  lostReading,
  nextSteps,
  notRecorded,
  parseDay,
  parseWeek,
  previousWeek,
  splitVisits,
  weekStart,
};
