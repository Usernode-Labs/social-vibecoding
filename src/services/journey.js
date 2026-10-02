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

// ── First mile ─────────────────────────────────────────────────────────
//
// Every admit date is a cohort, however small. A person is counted once, at
// their earliest admit; a member who already had access before that admit is
// not a newcomer and stays in Earlier members. Admitted addresses with no
// account yet are rows too: the waitlist row is all there is of them.
//
// Parameters, fixed for every first-mile query: $1 the admit day or the
// newcomer window, $2 now, $3 the reserved name patterns, $4 the left-out ids.

const ADMITTED_CTE = `admitted AS (
    SELECT DISTINCT ON (COALESCE('u' || w.linked_user_id::text, 'w' || w.id::text))
           w.id AS signup_id, w.email, w.released_at, w.linked_user_id
      FROM waitlist_signups w
     WHERE w.released_at IS NOT NULL
     ORDER BY COALESCE('u' || w.linked_user_id::text, 'w' || w.id::text), w.released_at, w.id
  )`;

const NEWCOMER_OR_NO_ACCOUNT = `(u.id IS NULL OR (
      (u.platform_access_granted_at IS NULL OR u.platform_access_granted_at >= a.released_at)
      AND ${REAL_PERSON_SQL}))`;

const COHORTS_SQL = `WITH ${ADMITTED_CTE}
  SELECT to_char((a.released_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS admitted,
         COUNT(u.id)::int AS with_account
    FROM admitted a
    LEFT JOIN users u ON u.id = a.linked_user_id
   WHERE a.released_at <= $2::timestamptz
     AND ($1::text IS NULL OR to_char((a.released_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') = $1::text)
     AND ${NEWCOMER_OR_NO_ACCOUNT}
   GROUP BY 1
   ORDER BY 1 DESC`;

// The facts of one person's first mile, read from the records that already
// exist (#3369 first-mile survey): the admit mail and the first login code in
// the mail log (kept 30 days), the account's own columns, the first time the
// shell was opened (the #general membership row or the first boot in UI
// telemetry), the first-run sheets as they were shown (telemetry), the
// welcome message's queue row, the earliest act of any kind, and the failed
// attempts the telemetry saw.
const PERSON_FACTS = `
    m.status AS mail_status, m.error AS mail_error, m.created_at AS mail_at,
    (SELECT MIN(d.created_at) FROM mail_deliveries d
      WHERE d.recipient = a.email AND d.kind = 'otp' AND d.created_at >= a.released_at) AS code_asked_at,
    u.id AS user_id, u.username, u.created_at AS account_at, u.password_set,
    u.has_platform_access, u.platform_access_granted_at AS access_at,
    u.needs_username_choice, u.needs_communities_choice, u.communities_onboarded_at,
    u.tour_done_at, u.getting_started_seen,
    LEAST(
      (SELECT MIN(cm.joined_at) FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id
        WHERE c.kind = 'channel' AND cm.user_id = u.id),
      (SELECT MIN(e.created_at) FROM events e
        WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
          AND e.metadata->>'kind' = 'screen_visit')
    ) AS opened_at,
    (SELECT MIN(e.created_at) FROM events e WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
        AND e.metadata->>'kind' = 'screen_visit' AND e.metadata->>'screen' = 'username_sheet') AS username_shown_at,
    (SELECT MIN(e.created_at) FROM events e WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
        AND e.metadata->>'kind' = 'screen_visit' AND e.metadata->>'screen' = 'join_sheet') AS join_shown_at,
    (SELECT MIN(e.created_at) FROM events e WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
        AND e.metadata->>'kind' = 'screen_visit') AS first_screen_at,
    q.status AS welcome_status, q.processed_at AS welcome_at,
    (SELECT MIN(cmsg.created_at) FROM conversation_messages cmsg
      WHERE q.conversation_id IS NOT NULL AND cmsg.conversation_id = q.conversation_id
        AND cmsg.sender_id = u.id AND cmsg.deleted_at IS NULL) AS welcome_reply_at,
    fa.at AS first_act_at, fa.kind AS first_act_kind,
    (SELECT COUNT(*)::int FROM events e WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
        AND (e.metadata->>'kind' IN ('loading_timeout', 'navigation_abandonment', 'boot_failure', 'server_failure')
          OR (e.metadata->>'kind' = 'action_outcome' AND e.metadata->>'outcome' = 'failure'))) AS failed_attempts,
    (SELECT COUNT(*)::int FROM events e WHERE e.user_id = u.id AND e.event_type = 'ui_experience'
        AND e.metadata->>'kind' = 'repeated_action') AS repeated_taps`;

const PERSON_JOINS = `
    LEFT JOIN LATERAL (
      SELECT d.status, d.error, d.created_at FROM mail_deliveries d
       WHERE a.email IS NOT NULL AND d.recipient = a.email AND d.kind = 'waitlist_released'
       ORDER BY d.created_at DESC, d.id DESC LIMIT 1
    ) m ON TRUE
    LEFT JOIN welcome_dm_queue q ON q.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT x.at, x.kind FROM (
        SELECT MIN(cmx.created_at) AS at, 'message' AS kind FROM chat_messages cmx
         WHERE cmx.user_id = u.id AND cmx.msg_type = 'message' AND cmx.deleted_at IS NULL
        UNION ALL SELECT MIN(cvx.created_at), 'message' FROM conversation_messages cvx
         WHERE cvx.sender_id = u.id AND cvx.deleted_at IS NULL
        UNION ALL SELECT MIN(pv.created_at), 'vote' FROM pr_votes pv WHERE pv.user_id = u.id
        UNION ALL SELECT MIN(iv.created_at), 'vote' FROM issue_votes iv WHERE iv.user_id = u.id
        UNION ALL SELECT MIN(fr.created_at), 'feedback' FROM feedback_reports fr WHERE fr.user_id = u.id
        UNION ALL SELECT MIN(i.created_at), 'request' FROM issues i WHERE i.created_by = u.id
        UNION ALL SELECT MIN(cs.created_at), 'change' FROM chat_sessions cs WHERE cs.user_id = u.id
        UNION ALL SELECT MIN(aa.date)::timestamptz, 'app' FROM app_activity aa WHERE aa.user_id = u.id
        UNION ALL SELECT MIN(cmb.joined_at), 'joined' FROM community_members cmb
         WHERE cmb.user_id = u.id AND cmb.source = 'joined'
      ) x WHERE x.at IS NOT NULL ORDER BY x.at LIMIT 1
    ) fa ON TRUE`;

const FIRST_MILE_ADMITTED_SQL = `WITH ${ADMITTED_CTE}
  SELECT a.signup_id, a.email, a.released_at, ${PERSON_FACTS}
    FROM admitted a
    LEFT JOIN users u ON u.id = a.linked_user_id
    ${PERSON_JOINS}
   WHERE to_char((a.released_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') = $1::text
     AND a.released_at <= $2::timestamptz
     AND ${NEWCOMER_OR_NO_ACCOUNT}
   ORDER BY a.released_at, a.signup_id`;

// People who got access in the newcomer window ($1 days before $2) with no
// admit of their own: a member's invite link, an activation code, a wallet,
// a direct grant. Their first mile starts at the account.
const FIRST_MILE_OTHER_WAY_SQL = `WITH ${ADMITTED_CTE}
  SELECT NULL::bigint AS signup_id, NULL::text AS email, NULL::timestamptz AS released_at,
         CASE WHEN u.admitted_by IS NOT NULL THEN 'invite_link' ELSE 'code_wallet_or_grant' END AS door,
         ${PERSON_FACTS}
    FROM users u
    LEFT JOIN admitted a ON FALSE
    ${PERSON_JOINS}
   WHERE u.has_platform_access
     AND u.platform_access_granted_at >= $2::timestamptz - make_interval(days => $1::int)
     AND u.platform_access_granted_at <= $2::timestamptz
     AND NOT EXISTS (
       SELECT 1 FROM waitlist_signups w
        WHERE w.linked_user_id = u.id AND w.released_at IS NOT NULL
          AND w.released_at <= u.platform_access_granted_at)
     AND ${REAL_PERSON_SQL}
   ORDER BY u.platform_access_granted_at, u.id`;

const MAIL_PROOF_DAYS = 30;

const FIRST_MILE_STEPS = Object.freeze([
  'admitted', 'mail_sent', 'code_asked', 'account', 'access', 'opened', 'username', 'join', 'first_act',
]);

/**
 * One person's first mile, step by step, from the facts row. Each step is
 * done (with its time where one exists), or, when a later step is done,
 * skipped (no record of it; the person is past it anyway) or unknown (its
 * proof has expired). The person sits at their furthest step; the first step
 * after it that is not done is where they are stuck, with the reason.
 */
function firstMileSteps(row, now = new Date()) {
  const t = (v) => (v ? new Date(v) : null);
  const nowMs = new Date(now).getTime();
  const admitted = t(row.released_at);
  const mailExpired = admitted && nowMs - admitted.getTime() > MAIL_PROOF_DAYS * DAY_MS;
  const hasAccount = row.user_id != null;
  const seen = row.getting_started_seen && typeof row.getting_started_seen === 'object' ? row.getting_started_seen : {};
  const facts = {
    admitted: admitted ? { done: true, at: admitted } : null,
    mail_sent: row.mail_status === 'sent'
      ? { done: true, at: t(row.mail_at) }
      : { done: false, stuck: row.mail_status ? `Mail not sent: ${row.mail_status}` : 'No admit mail on record',
        expired: mailExpired && !row.mail_status },
    code_asked: row.code_asked_at
      ? { done: true, at: t(row.code_asked_at) }
      : { done: false, stuck: 'Admitted, never asked for a login code', expired: mailExpired },
    account: hasAccount && row.password_set !== false
      ? { done: true, at: t(row.account_at) }
      : { done: false, stuck: hasAccount ? 'Account started, not finished' : 'Code mailed, no account' },
    access: row.has_platform_access ? { done: true, at: t(row.access_at) }
      : { done: false, stuck: 'In the waiting room' },
    opened: row.opened_at ? { done: true, at: t(row.opened_at) }
      : { done: false, stuck: 'Has access, never opened Homeroom' },
    // A flag with no time can be set before the person was ever inside (the
    // password step chooses one too), so it is done but never moves the
    // furthest step: `weak`.
    username: hasAccount && row.needs_username_choice === false
      ? { done: true, at: null, weak: true }
      : { done: false, stuck: row.username_shown_at ? 'Username sheet shown, not answered' : 'Username not chosen' },
    join: row.communities_onboarded_at
      ? { done: true, at: t(row.communities_onboarded_at), note: seen.join_answer || null }
      : (hasAccount && row.needs_communities_choice === false
        ? { done: true, at: null, note: 'not asked', weak: true }
        : { done: false, stuck: row.join_shown_at ? 'Join screen shown, not answered' : 'Join screen not answered' }),
    first_act: row.first_act_at ? { done: true, at: t(row.first_act_at), note: row.first_act_kind }
      : { done: false, stuck: 'Inside, no act yet' },
  };
  // Nobody is inside without a finished account: a started one has never
  // signed in, so the defaults on its row (no username to choose, no join
  // screen owed) say nothing about the steps after it.
  if (!facts.account.done) {
    for (const key of ['access', 'opened', 'username', 'join', 'first_act']) {
      if (facts[key].done) facts[key] = { done: false, stuck: facts[key].stuck || null };
    }
  }
  const order = admitted ? FIRST_MILE_STEPS : FIRST_MILE_STEPS.slice(FIRST_MILE_STEPS.indexOf('account'));
  let furthest = -1;
  order.forEach((key, i) => { if (facts[key] && facts[key].done && !facts[key].weak) furthest = i; });
  let stuckAt = null;
  const steps = order.map((key, i) => {
    const f = facts[key];
    if (f.done) return { key, state: 'done', at: f.at || null, note: f.note || null };
    // (A weak "done" above can sit after the stuck step: shown as done, it
    // does not hide where the person stopped.)
    if (i < furthest) return { key, state: f.expired ? 'unknown' : 'skipped', at: null, note: null };
    if (stuckAt == null) {
      stuckAt = key;
      return { key, state: 'stuck', at: null, note: f.expired ? 'Proof older than 30 days' : f.stuck };
    }
    return { key, state: 'not_yet', at: null, note: null };
  });
  const since = admitted || t(row.access_at);
  return {
    steps,
    furthest: furthest >= 0 ? order[furthest] : null,
    stuckAt,
    stuckReason: stuckAt ? steps.find((s) => s.key === stuckAt).note : null,
    daysSince: since ? Math.floor((nowMs - since.getTime()) / DAY_MS) : null,
    failedAttempts: row.failed_attempts || 0,
    repeatedTaps: row.repeated_taps || 0,
    tour: row.tour_done_at ? { ended: seen.tour_ended || null, step: seen.tour_step ?? null, at: t(row.tour_done_at) } : null,
    welcome: row.welcome_status ? { status: row.welcome_status, at: t(row.welcome_at), replied: !!row.welcome_reply_at } : null,
  };
}

function firstMilePerson(row, now) {
  const mile = firstMileSteps(row, now);
  return {
    signupId: row.signup_id != null ? Number(row.signup_id) : null,
    userId: row.user_id != null ? Number(row.user_id) : null,
    // A person with no account is known only by the address they joined
    // with, which Admin › Waitlist already shows to admins.
    name: row.username || row.email || null,
    hasAccount: row.user_id != null,
    door: row.door || (row.released_at ? 'admitted' : null),
    ...mile,
  };
}

/** Counts per step: how many of the cohort are past it (done or skipped). */
function firstMileCounts(people) {
  const keys = people.length && people[0].steps ? people[0].steps.map((s) => s.key) : [];
  return keys.map((key) => ({
    key,
    passed: people.filter((p) => {
      const step = p.steps.find((s) => s.key === key);
      return step && (step.state === 'done' || step.state === 'skipped' || step.state === 'unknown');
    }).length,
    stuck: people.filter((p) => p.stuckAt === key).map((p) => ({
      userId: p.userId, signupId: p.signupId, name: p.name, days: p.daysSince, reason: p.stuckReason,
      failedAttempts: p.failedAttempts,
    })),
  }));
}

function realPersonParams(leftOutIds) {
  return [[...RESERVED_PATTERNS], (leftOutIds || []).map(Number)];
}

/** The admit-date cohorts, newest first, with "Came in another way". */
async function cohorts(pool, { now = new Date(), leftOutIds = [] } = {}) {
  const { rows } = await pool.query(COHORTS_SQL, [null, now, ...realPersonParams(leftOutIds)]);
  const other = await pool.query(FIRST_MILE_OTHER_WAY_SQL, [NEWCOMER_DAYS, now, ...realPersonParams(leftOutIds)]);
  return {
    cohorts: rows.map((r) => ({ day: r.day, admitted: r.admitted, withAccount: r.with_account })),
    otherWay: { people: other.rows.length },
  };
}

/** One cohort's first mile: `day` is an admit day, or 'other_way'. */
async function firstMile(pool, { day, now = new Date(), leftOutIds = [] } = {}) {
  const params = realPersonParams(leftOutIds);
  const result = day === 'other_way'
    ? await pool.query(FIRST_MILE_OTHER_WAY_SQL, [NEWCOMER_DAYS, now, ...params])
    : await pool.query(FIRST_MILE_ADMITTED_SQL, [day, now, ...params]);
  const people = result.rows.map((row) => firstMilePerson(row, now));
  return {
    cohort: day,
    people,
    steps: firstMileCounts(people),
    notRecorded: {
      followedLink: notRecorded('Nothing records the admit mail being opened or its link followed.'),
    },
  };
}

// ── Stages, per week ───────────────────────────────────────────────────
//
// One yes or no per real person for the week [$1, $2); Stay also reads the
// week after, [$2, $5). $3 and $4 are the real-person parameters. Every
// source is bounded by the week, so the scan is a fortnight at most, except
// "came back to", which looks for an earlier day with the same app.

// Did anything we record in [from, to). Written out twice (this week and the
// next) so both stay static SQL.
const ARRIVE_THIS_WEEK = `
    SELECT aa.user_id FROM app_activity aa
     WHERE aa.date >= ($1::timestamptz AT TIME ZONE 'UTC')::date AND aa.date < ($2::timestamptz AT TIME ZONE 'UTC')::date
    UNION SELECT cmx.user_id FROM chat_messages cmx
     WHERE cmx.created_at >= $1::timestamptz AND cmx.created_at < $2::timestamptz AND cmx.user_id IS NOT NULL
    UNION SELECT cvx.sender_id FROM conversation_messages cvx
     WHERE cvx.created_at >= $1::timestamptz AND cvx.created_at < $2::timestamptz
    UNION SELECT csx.user_id FROM chat_session_messages smx JOIN chat_sessions csx ON csx.id = smx.session_id
     WHERE smx.role = 'user' AND smx.created_at >= $1::timestamptz AND smx.created_at < $2::timestamptz
    UNION SELECT pvx.user_id FROM pr_votes pvx WHERE pvx.created_at >= $1::timestamptz AND pvx.created_at < $2::timestamptz
    UNION SELECT ivx.user_id FROM issue_votes ivx WHERE ivx.created_at >= $1::timestamptz AND ivx.created_at < $2::timestamptz
    UNION SELECT frx.user_id FROM feedback_reports frx WHERE frx.created_at >= $1::timestamptz AND frx.created_at < $2::timestamptz
    UNION SELECT ex.user_id FROM events ex
     WHERE ex.event_type = 'ui_experience' AND ex.created_at >= $1::timestamptz AND ex.created_at < $2::timestamptz`;

const ARRIVE_NEXT_WEEK = `
    SELECT aa.user_id FROM app_activity aa
     WHERE aa.date >= ($2::timestamptz AT TIME ZONE 'UTC')::date AND aa.date < ($5::timestamptz AT TIME ZONE 'UTC')::date
    UNION SELECT cmx.user_id FROM chat_messages cmx
     WHERE cmx.created_at >= $2::timestamptz AND cmx.created_at < $5::timestamptz AND cmx.user_id IS NOT NULL
    UNION SELECT cvx.sender_id FROM conversation_messages cvx
     WHERE cvx.created_at >= $2::timestamptz AND cvx.created_at < $5::timestamptz
    UNION SELECT csx.user_id FROM chat_session_messages smx JOIN chat_sessions csx ON csx.id = smx.session_id
     WHERE smx.role = 'user' AND smx.created_at >= $2::timestamptz AND smx.created_at < $5::timestamptz
    UNION SELECT pvx.user_id FROM pr_votes pvx WHERE pvx.created_at >= $2::timestamptz AND pvx.created_at < $5::timestamptz
    UNION SELECT ivx.user_id FROM issue_votes ivx WHERE ivx.created_at >= $2::timestamptz AND ivx.created_at < $5::timestamptz
    UNION SELECT frx.user_id FROM feedback_reports frx WHERE frx.created_at >= $2::timestamptz AND frx.created_at < $5::timestamptz
    UNION SELECT ex.user_id FROM events ex
     WHERE ex.event_type = 'ui_experience' AND ex.created_at >= $2::timestamptz AND ex.created_at < $5::timestamptz`;

// A change that counts as "made a change": the person's own, with a pull
// request, and not one of the one-click or automatic kinds (maintenance,
// a clone, a rename proposal).
const OWN_CHANGE = `cs.pr_number IS NOT NULL
      AND cs.source IS DISTINCT FROM 'maintenance'
      AND cs.cloned_from_session_id IS NULL
      AND COALESCE(cs.branch_name, '') NOT LIKE 'rename/%'`;

const STAGES_SQL = `WITH real AS (
    SELECT u.id, u.username FROM users u WHERE ${REAL_PERSON_SQL}
  ), arrive AS (${ARRIVE_THIS_WEEK}
  ), arrive_next AS (${ARRIVE_NEXT_WEEK}
  ), found AS (
    SELECT f.user_id FROM (
      SELECT aa.user_id, aa.app_id, MIN(aa.date) AS first_day FROM app_activity aa GROUP BY aa.user_id, aa.app_id
    ) f JOIN apps ap ON ap.id = f.app_id
     WHERE f.first_day >= ($1::timestamptz AT TIME ZONE 'UTC')::date
       AND f.first_day < ($2::timestamptz AT TIME ZONE 'UTC')::date
       AND ap.created_by IS DISTINCT FROM f.user_id
       AND EXISTS (SELECT 1 FROM app_activity a2 WHERE a2.user_id = f.user_id AND a2.app_id = f.app_id
                     AND a2.date = f.first_day AND a2.seconds_spent >= 30)
  ), came_back AS (
    SELECT aa.user_id FROM app_activity aa
     WHERE aa.date >= ($1::timestamptz AT TIME ZONE 'UTC')::date AND aa.date < ($2::timestamptz AT TIME ZONE 'UTC')::date
       AND EXISTS (SELECT 1 FROM app_activity a2 WHERE a2.user_id = aa.user_id AND a2.app_id = aa.app_id AND a2.date < aa.date)
    UNION SELECT cmx.user_id FROM chat_messages cmx
     WHERE cmx.created_at >= $1::timestamptz AND cmx.created_at < $2::timestamptz AND cmx.msg_type = 'message'
       AND EXISTS (SELECT 1 FROM chat_messages c2 WHERE c2.user_id = cmx.user_id AND c2.app_id = cmx.app_id
                     AND c2.msg_type = 'message'
                     AND (c2.created_at AT TIME ZONE 'UTC')::date < (cmx.created_at AT TIME ZONE 'UTC')::date)
  ), activate AS (
    SELECT frx.user_id, 'feedback' AS kind FROM feedback_reports frx
     WHERE frx.created_at >= $1::timestamptz AND frx.created_at < $2::timestamptz
    UNION SELECT i.created_by, 'feedback' FROM issues i
     WHERE i.created_at >= $1::timestamptz AND i.created_at < $2::timestamptz AND i.created_by IS NOT NULL
    UNION SELECT pvx.user_id, 'vote' FROM pr_votes pvx WHERE pvx.created_at >= $1::timestamptz AND pvx.created_at < $2::timestamptz
    UNION SELECT ivx.user_id, 'vote' FROM issue_votes ivx WHERE ivx.created_at >= $1::timestamptz AND ivx.created_at < $2::timestamptz
    UNION SELECT cs.user_id, 'change' FROM chat_sessions cs
     WHERE cs.created_at >= $1::timestamptz AND cs.created_at < $2::timestamptz AND ${OWN_CHANGE}
  ), belong AS (
    SELECT pvx.user_id FROM pr_votes pvx JOIN chat_sessions cs ON cs.id = pvx.session_id JOIN real ra ON ra.id = cs.user_id
     WHERE pvx.created_at >= $1::timestamptz AND pvx.created_at < $2::timestamptz AND pvx.user_id <> cs.user_id
       AND COALESCE(cs.branch_name, '') NOT LIKE 'rename/%'
    UNION SELECT k.giver_user_id FROM pr_kudos k JOIN chat_sessions cs ON cs.id = k.session_id JOIN real ra ON ra.id = cs.user_id
     WHERE k.created_at >= $1::timestamptz AND k.created_at < $2::timestamptz AND k.giver_user_id <> cs.user_id
    UNION SELECT cmx.user_id FROM chat_messages cmx JOIN chat_sessions cs ON cmx.thread_type = 'session' AND cmx.thread_ref = cs.id
      JOIN real ra ON ra.id = cs.user_id
     WHERE cmx.created_at >= $1::timestamptz AND cmx.created_at < $2::timestamptz AND cmx.msg_type = 'message'
       AND cmx.user_id <> cs.user_id
  ), used AS (
    SELECT cs.user_id FROM chat_sessions cs
     WHERE cs.status = 'merged' AND cs.merged_at >= $1::timestamptz AND cs.merged_at < $2::timestamptz
       AND EXISTS (SELECT 1 FROM pr_votes pvx JOIN real ry ON ry.id = pvx.user_id
                    WHERE pvx.session_id = cs.id AND pvx.vote = 'yes' AND pvx.user_id <> cs.user_id
                      AND pvx.approval_epoch = cs.approval_epoch)
  ), invited AS (
    SELECT inv.admitted_by AS user_id FROM users inv JOIN real ri ON ri.id = inv.id
     WHERE inv.admitted_by IS NOT NULL AND inv.id IN (SELECT user_id FROM arrive)
  )
  SELECT r.id AS user_id, r.username,
         r.id IN (SELECT user_id FROM arrive) AS arrive,
         (r.id IN (SELECT user_id FROM found) OR r.id IN (SELECT user_id FROM came_back)) AS explore,
         r.id IN (SELECT user_id FROM activate) AS activate,
         ARRAY(SELECT DISTINCT ak.kind FROM activate ak WHERE ak.user_id = r.id ORDER BY ak.kind) AS activate_kinds,
         r.id IN (SELECT user_id FROM belong) AS belong,
         r.id IN (SELECT user_id FROM used) AS use,
         r.id IN (SELECT user_id FROM arrive_next) AS arrive_next,
         r.id IN (SELECT user_id FROM invited) AS invite
    FROM real r
   WHERE r.id IN (SELECT user_id FROM arrive)
      OR r.id IN (SELECT user_id FROM activate)
      OR r.id IN (SELECT user_id FROM used)
      OR r.id IN (SELECT user_id FROM invited)
   ORDER BY r.username`;

const STAGES = Object.freeze(['arrive', 'explore', 'activate', 'belong', 'use', 'stay', 'invite']);

/**
 * The week's stages. Stay needs the following week to have ended: until it
 * has, it is notRecorded ("known next Monday"), never a count.
 */
async function stages(pool, { week, now = new Date(), leftOutIds = [] } = {}) {
  const nextEnd = new Date(week.end.getTime() + WEEK_MS);
  const stayKnown = nextEnd.getTime() <= new Date(now).getTime();
  const { rows } = await pool.query(STAGES_SQL,
    [week.start, week.end, ...realPersonParams(leftOutIds), nextEnd]);
  const people = rows.map((r) => {
    const flags = {
      arrive: r.arrive, explore: r.explore, activate: r.activate, belong: r.belong,
      use: r.use, stay: stayKnown ? (r.arrive && r.arrive_next) : null, invite: r.invite,
    };
    // Where they stopped: the furthest stage reached this week, in order.
    let furthest = null;
    for (const key of STAGES) if (flags[key]) furthest = key;
    return { userId: Number(r.user_id), name: r.username, ...flags, activateKinds: r.activate_kinds || [], stoppedAt: furthest };
  });
  const counts = {};
  for (const key of STAGES) {
    counts[key] = key === 'stay' && !stayKnown
      ? notRecorded('Known once the following week has ended.')
      : people.filter((p) => p[key]).length;
  }
  const stoppedAt = {};
  for (const key of STAGES) {
    stoppedAt[key] = people.filter((p) => p.stoppedAt === key).map((p) => ({ userId: p.userId, name: p.name }));
  }
  return { week: week.label, finished: week.finished, counts, stoppedAt, people };
}

// ── Active groups ──────────────────────────────────────────────────────
//
// Every change that went live, with its project, its real author and the
// real people other than the author who said yes to the revision that
// merged. Merged changes number in the low thousands in total, so the weeks
// are bucketed here rather than in SQL. $1 is unused padding kept for the
// shared parameter layout: the end of the window, $2 now, $3/$4 real people.
const LIVE_CHANGES_SQL = `SELECT cs.id, cs.app_id, ap.slug, ap.name, ap.self_hosted,
         cs.merged_at, cs.user_id AS author_id, u.username AS author,
         ARRAY(SELECT pvx.user_id FROM pr_votes pvx JOIN users uy ON uy.id = pvx.user_id
                WHERE pvx.session_id = cs.id AND pvx.vote = 'yes' AND pvx.user_id <> cs.user_id
                  AND pvx.approval_epoch = cs.approval_epoch
                  AND uy.is_admin IS NOT TRUE AND uy.is_synthetic IS NOT TRUE
                  AND uy.participation_restricted_at IS NULL AND uy.anonymised_at IS NULL
                  AND NOT (LOWER(uy.username) LIKE ANY($3::text[]))
                  AND NOT (uy.id = ANY($4::int[]))
                ORDER BY pvx.user_id) AS yes_ids,
         ARRAY(SELECT uy.username FROM pr_votes pvx JOIN users uy ON uy.id = pvx.user_id
                WHERE pvx.session_id = cs.id AND pvx.vote = 'yes' AND pvx.user_id <> cs.user_id
                  AND pvx.approval_epoch = cs.approval_epoch
                  AND uy.is_admin IS NOT TRUE AND uy.is_synthetic IS NOT TRUE
                  AND uy.participation_restricted_at IS NULL AND uy.anonymised_at IS NULL
                  AND NOT (LOWER(uy.username) LIKE ANY($3::text[]))
                  AND NOT (uy.id = ANY($4::int[]))
                ORDER BY pvx.user_id) AS yes_names
    FROM chat_sessions cs
    JOIN apps ap ON ap.id = cs.app_id
    JOIN users u ON u.id = cs.user_id
   WHERE cs.status = 'merged' AND cs.merged_at IS NOT NULL
     AND cs.merged_at < $1::timestamptz AND cs.merged_at <= $2::timestamptz
     AND ${REAL_PERSON_SQL}`;

// Changes put to the group and still waiting, with no yes yet from another
// real person: the other half of "groups one short".
const WAITING_SQL = `SELECT cs.id, ap.slug, ap.name, cs.user_id AS author_id, u.username AS author, cs.promoted_at
    FROM chat_sessions cs
    JOIN apps ap ON ap.id = cs.app_id
    JOIN users u ON u.id = cs.user_id
   WHERE cs.status IN ('promoted', 'merging') AND COALESCE(ap.self_hosted, FALSE) = FALSE
     AND cs.promoted_at IS NOT NULL AND cs.promoted_at < $1::timestamptz AND cs.promoted_at <= $2::timestamptz
     AND ${REAL_PERSON_SQL}
     AND NOT EXISTS (SELECT 1 FROM pr_votes pvx JOIN users uy ON uy.id = pvx.user_id
                      WHERE pvx.session_id = cs.id AND pvx.vote = 'yes' AND pvx.user_id <> cs.user_id
                        AND pvx.approval_epoch = cs.approval_epoch
                        AND uy.is_admin IS NOT TRUE AND uy.is_synthetic IS NOT TRUE
                        AND uy.participation_restricted_at IS NULL AND uy.anonymised_at IS NULL
                        AND NOT (LOWER(uy.username) LIKE ANY($3::text[]))
                        AND NOT (uy.id = ANY($4::int[])))
   ORDER BY cs.promoted_at`;

/** Group the live changes of one week by project. */
function groupsForWeek(changes, week) {
  const byProject = new Map();
  for (const c of changes) {
    const at = new Date(c.merged_at).getTime();
    if (at < week.start.getTime() || at >= week.end.getTime()) continue;
    const g = byProject.get(c.slug) || {
      slug: c.slug, name: c.name, selfHosted: !!c.self_hosted, changes: 0, crossYes: false, members: new Map(),
    };
    g.changes += 1;
    g.members.set(Number(c.author_id), c.author);
    (c.yes_ids || []).forEach((id, i) => g.members.set(Number(id), (c.yes_names || [])[i]));
    if ((c.yes_ids || []).length) g.crossYes = true;
    byProject.set(c.slug, g);
  }
  return [...byProject.values()].map((g) => ({
    slug: g.slug,
    name: g.name,
    selfHosted: g.selfHosted,
    changes: g.changes,
    people: [...g.members.entries()].map(([userId, name]) => ({ userId, name })),
    active: !g.selfHosted && isActiveGroup(g.members.size, g.crossYes),
  }));
}

/**
 * Active groups for `week` with the standard lifecycle against the week
 * before and every earlier week; Homeroom's own project on a line of its own,
 * never counted; and the groups one short.
 */
async function activeGroups(pool, { week, now = new Date(), leftOutIds = [] } = {}) {
  const params = [week.end, now, ...realPersonParams(leftOutIds)];
  const { rows: changes } = await pool.query(LIVE_CHANGES_SQL, params);
  const before = previousWeek(week);
  const thisWeek = groupsForWeek(changes, week);
  const lastWeek = new Set(groupsForWeek(changes, before).filter((g) => g.active).map((g) => g.slug));
  // Every week before the one before: was the project an active group then?
  const earlierWeeks = new Map();
  for (const c of changes) {
    if (new Date(c.merged_at).getTime() >= before.start.getTime()) continue;
    const key = weekStart(c.merged_at).getTime();
    if (!earlierWeeks.has(key)) earlierWeeks.set(key, []);
    earlierWeeks.get(key).push(c);
  }
  const earlier = new Set();
  for (const [key, list] of earlierWeeks) {
    groupsForWeek(list, { start: new Date(key), end: new Date(key + WEEK_MS) })
      .filter((g) => g.active).forEach((g) => earlier.add(g.slug));
  }
  const active = thisWeek.filter((g) => g.active).map((g) => ({
    ...g, lifecycle: groupLifecycle({ thisWeek: true, lastWeek: lastWeek.has(g.slug), earlier: earlier.has(g.slug) }),
  }));
  const wentQuiet = [...lastWeek].filter((slug) => !active.some((g) => g.slug === slug))
    .map((slug) => {
      const g = groupsForWeek(changes, before).find((x) => x.slug === slug);
      return { slug, name: g ? g.name : slug, people: g ? g.people : [], lifecycle: 'went_quiet' };
    });
  const homeroom = thisWeek.find((g) => g.selfHosted) || null;
  const { rows: waiting } = await pool.query(WAITING_SQL, params);
  const oneShort = [
    ...thisWeek.filter((g) => !g.selfHosted && !g.active && g.people.length === 1)
      .map((g) => ({ slug: g.slug, name: g.name, people: g.people, why: 'one person had a change go live alone' })),
    ...waiting.map((w) => ({ slug: w.slug, name: w.name, people: [{ userId: Number(w.author_id), name: w.author }],
      why: 'a change is waiting for a yes from someone else', since: w.promoted_at })),
  ];
  return {
    week: week.label,
    finished: week.finished,
    count: active.length,
    groups: active,
    wentQuiet,
    homeroom: homeroom ? { changes: homeroom.changes, people: homeroom.people.length } : null,
    oneShort,
  };
}

// ── Coverage ───────────────────────────────────────────────────────────
//
// Is navigation actually arriving? Real people active this week by the
// server's own records, against those with navigation recorded; and rows per
// day per build, so a broken hook or an old cached shell shows as a gap in
// the data, not as people who stopped exploring. $5 is the navigation codes.
const COVERAGE_SQL = `WITH real AS (
    SELECT u.id FROM users u WHERE ${REAL_PERSON_SQL}
  ), active AS (${ARRIVE_THIS_WEEK}
  ), nav AS (
    SELECT e.user_id, (e.created_at AT TIME ZONE 'UTC')::date AS day, e.metadata->>'build' AS build
      FROM events e
     WHERE e.event_type = 'ui_experience' AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
       AND e.metadata->>'kind' = 'screen_visit' AND e.metadata->>'screen' = ANY($5::text[])
  )
  SELECT
    (SELECT COUNT(*)::int FROM real r WHERE r.id IN (SELECT user_id FROM active)) AS active_people,
    (SELECT COUNT(DISTINCT n.user_id)::int FROM nav n JOIN real r ON r.id = n.user_id) AS with_navigation,
    COALESCE((SELECT json_agg(json_build_object('day', to_char(d.day, 'YYYY-MM-DD'), 'build', d.build, 'rows', d.rows)
                ORDER BY d.day, d.build)
       FROM (SELECT n.day, COALESCE(n.build, 'unknown') AS build, COUNT(*)::int AS rows
               FROM nav n GROUP BY n.day, COALESCE(n.build, 'unknown')) d), '[]'::json) AS by_day`;

async function coverage(pool, { week, leftOutIds = [] } = {}) {
  const { NAV_SCREENS: nav } = require('./ui-telemetry');
  const { rows } = await pool.query(COVERAGE_SQL,
    [week.start, week.end, ...realPersonParams(leftOutIds), [...nav]]);
  const r = rows[0] || {};
  return {
    week: week.label,
    activePeople: r.active_people || 0,
    withNavigation: r.with_navigation || 0,
    byDay: r.by_day || [],
  };
}

module.exports = {
  COHORTS_SQL,
  COVERAGE_SQL,
  LIVE_CHANGES_SQL,
  WAITING_SQL,
  DAY_MS,
  FIRST_MILE_ADMITTED_SQL,
  FIRST_MILE_OTHER_WAY_SQL,
  FIRST_MILE_STEPS,
  STAGES,
  STAGES_SQL,
  FEW_MOVES,
  GROUP_MAX,
  GROUP_MIN,
  LOST_CUTOFFS,
  NEWCOMER_DAYS,
  REAL_PERSON_SQL,
  RESERVED_PATTERNS,
  VISIT_GAP_MS,
  WEEK_MS,
  activeGroups,
  cohorts,
  coverage,
  groupsForWeek,
  firstMile,
  firstMileCounts,
  firstMileSteps,
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
  stages,
  weekStart,
};
