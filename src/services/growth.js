'use strict';

// Growth: what newcomers do since the landing page went live, counted in
// groups, not accounts. The reading behind Admin › Journey
// (frontend/src/features/admin/admin-journey.tsx).
//
// The early community (Season 1 and every account from before the landing
// page) made almost all of the activity the older dashboards count: on
// 17 Nov 2026, 46 of Admin › Analytics' 53 weekly active users were Season 1
// accounts. So every person here carries whether they belong to it, and the
// page shows newcomers unless asked for everyone.
//
// One payload, read once: a row per person, the weeks each was active, and
// the groups. The page filters it (when, who, compare, scope) in the
// browser; at the size Homeroom is, that is a few hundred rows.
//
// Definitions:
//   real person      Journey's REAL_PERSON_SQL plus its left-out list.
//   early community  a real person enrolled in a season that ended before
//                    ERA_START, or whose account is older than ERA_START.
//   connected        a later account brought in by the early community:
//                    admitted by one, invited through a waitlist link of
//                    one, or joined through an invite link one made.
//   newcomer         a real person who is neither; or a waitlist admit
//                    since ERA_START with no account yet (team addresses
//                    are not people).
//   opened           any trace inside Homeroom (a floor: a visit can leave
//                    none).
//   stayed           30 seconds or more in an app on some day.
//   time in an app   each person's longest visit (bestSeconds) and their
//                    visits counted into TIME_BINS (visitBins), since the era.
//   acted            started a change, voted on one, or wrote in a project.
//   group            a project in a week where GROUP_MIN or more people of
//                    the reading's scope acted; it came back when it had
//                    such a week again later.
// Weeks run Monday to Sunday, UTC.

const journey = require('./journey');

// The landing page and the social launch: the start of the era this page
// reads. A constant, not a setting: changing it changes every definition.
const ERA_START = '2026-09-14';
const GROUP_MIN = 3;
const STAY_SECONDS = 30;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// The lower edges of the time-in-an-app histogram, in seconds: 1–4 s, 5–9 s,
// 10–19 s, 20–29 s, then 30–59 s, 1–2 min, 2–5 min, 5–15 min, 15 min+. The
// 30-second bar sits on an edge, so the chart shows both sides of it.
const TIME_BINS = [1, 5, 10, 20, 30, 60, 120, 300, 900];

// $1 the era's start, $2 the 30-second bar, $3 reserved name patterns,
// $4 left-out ids (journey.realPersonParams).
const PEOPLE_SQL = `WITH real AS (
    SELECT u.id, u.username, u.created_at, u.admitted_by FROM users u WHERE ${journey.REAL_PERSON_SQL}
  ), season_early AS (
    SELECT DISTINCT e.user_id FROM user_enrollments e JOIN seasons s ON s.id = e.season_id
     WHERE s.ends_at < $1::timestamptz
  ), early AS (
    SELECT r.id FROM real r
     WHERE r.created_at < $1::timestamptz OR r.id IN (SELECT season_early.user_id FROM season_early)
  ), connected AS (
    SELECT r.id FROM real r
     WHERE r.id NOT IN (SELECT early.id FROM early)
       AND (r.admitted_by IN (SELECT early.id FROM early)
         OR EXISTS (SELECT 1 FROM waitlist_signups w JOIN waitlist_signups wi ON wi.id = w.invited_by
                     WHERE w.linked_user_id = r.id AND wi.linked_user_id IN (SELECT early.id FROM early))
         OR EXISTS (SELECT 1 FROM community_invite_redemptions rd JOIN community_invites ci ON ci.id = rd.invite_id
                     WHERE rd.user_id = r.id AND ci.created_by IN (SELECT early.id FROM early)))
  )
  SELECT r.id AS user_id, r.username, r.created_at,
         r.id IN (SELECT early.id FROM early) AS early,
         r.id IN (SELECT season_early.user_id FROM season_early) AS season_early,
         r.id IN (SELECT connected.id FROM connected) AS connected,
         (SELECT MIN(w.released_at) FROM waitlist_signups w
           WHERE w.linked_user_id = r.id AND w.released_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM test_waitlist_releases t WHERE t.signup_id = w.id)) AS admitted_at,
         (SELECT MIN(rd.created_at) FROM community_invite_redemptions rd WHERE rd.user_id = r.id) AS link_at,
         (SELECT w.answers->'discovery'->>'source' FROM waitlist_signups w
           WHERE w.linked_user_id = r.id ORDER BY w.submitted_at, w.id LIMIT 1) AS heard,
         (EXISTS (SELECT 1 FROM events e WHERE e.user_id = r.id AND e.event_type = 'ui_experience')
           OR EXISTS (SELECT 1 FROM app_activity a WHERE a.user_id = r.id)
           OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.user_id = r.id)
           OR EXISTS (SELECT 1 FROM conversation_messages cm WHERE cm.sender_id = r.id)
           OR EXISTS (SELECT 1 FROM pr_votes v WHERE v.user_id = r.id)
           OR EXISTS (SELECT 1 FROM apps ap WHERE ap.created_by = r.id)
           OR EXISTS (SELECT 1 FROM issues i WHERE i.created_by = r.id)
           OR EXISTS (SELECT 1 FROM community_members mb WHERE mb.user_id = r.id AND mb.source <> 'auto')) AS opened,
         EXISTS (SELECT 1 FROM app_activity a WHERE a.user_id = r.id AND a.seconds_spent >= $2::int) AS stayed,
         GREATEST(
           (SELECT MAX(a.date)::timestamptz FROM app_activity a WHERE a.user_id = r.id),
           (SELECT MAX(e.created_at) FROM events e WHERE e.user_id = r.id AND e.event_type = 'ui_experience'),
           (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.user_id = r.id),
           (SELECT MAX(cm.created_at) FROM conversation_messages cm WHERE cm.sender_id = r.id)) AS last_seen
    FROM real r
   ORDER BY r.id`;

// Waitlist admits since the era who have no account yet. $1 the era's start,
// $2 left-out ids: an admit at an address of the team (its domains, or a +tag
// of an admin's or a left-out account's address) is not a person. The
// domains are journey.TEAM_DOMAINS, spelled out so scripts/check-sql.js can
// read the query statically (tests/growth.test.js holds the two equal).
const NO_ACCOUNT_SQL = `SELECT w.id AS signup_id, w.released_at, w.answers->'discovery'->>'source' AS heard
    FROM waitlist_signups w
   WHERE w.released_at >= $1::timestamptz AND w.linked_user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM test_waitlist_releases t WHERE t.signup_id = w.id)
     AND NOT (LOWER(split_part(w.email, '@', 2)) IN ('onhomeroom.com', 'usernodelabs.org', 'usernodelabs.com')
       OR LOWER(regexp_replace(w.email, '\\+[^@]*@', '@')) IN (
         SELECT LOWER(regexp_replace(tm.email, '\\+[^@]*@', '@')) FROM users tm
          WHERE tm.email IS NOT NULL AND (tm.is_admin OR tm.id = ANY($2::int[]))))
   ORDER BY w.released_at, w.id`;

// The admit mail of every waitlist admit since the era, by the account it
// was linked to or its own id: whether a link in it was followed, an open was
// seen, or it is only on record. Opens are kept apart because image proxies
// make them. $1 the era's start.
const MAIL_SQL = `SELECT w.id AS signup_id, w.linked_user_id,
         (w.release_link_followed_at IS NOT NULL OR EXISTS (
            SELECT 1 FROM mail_deliveries d JOIN mail_events me ON me.delivery_id = d.id
             WHERE d.kind = 'waitlist_released' AND LOWER(d.recipient) = LOWER(w.email) AND me.type = 'clicked')) AS clicked,
         EXISTS (SELECT 1 FROM mail_deliveries d JOIN mail_events me ON me.delivery_id = d.id
                  WHERE d.kind = 'waitlist_released' AND LOWER(d.recipient) = LOWER(w.email) AND me.type = 'opened') AS opened,
         EXISTS (SELECT 1 FROM mail_deliveries d
                  WHERE d.kind = 'waitlist_released' AND LOWER(d.recipient) = LOWER(w.email)) AS on_record
    FROM waitlist_signups w
   WHERE w.released_at >= $1::timestamptz
     AND NOT EXISTS (SELECT 1 FROM test_waitlist_releases t WHERE t.signup_id = w.id)`;

// Time in an app since the era, per person and bin: a visit is one row of
// app_activity (a person in one app on one day). $1 the era's start, $2 the
// bins' lower edges (TIME_BINS).
const TIME_SQL = `SELECT a.user_id, width_bucket(a.seconds_spent, $2::int[]) AS bin,
         COUNT(1)::int AS visits, MAX(a.seconds_spent)::int AS longest
    FROM app_activity a
   WHERE a.user_id IS NOT NULL AND a.seconds_spent > 0 AND a.date >= $1::date
   GROUP BY a.user_id, width_bucket(a.seconds_spent, $2::int[])`;

// The weeks each person was active since a week before the era: 30 seconds
// in an app, or an act. $1 the era's start, $2 the 30-second bar.
const ACTIVE_WEEKS_SQL = `SELECT DISTINCT x.user_id, to_char(date_trunc('week', x.at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week FROM (
    SELECT a.user_id, a.date::timestamp AT TIME ZONE 'UTC' AS at FROM app_activity a WHERE a.seconds_spent >= $2::int
    UNION ALL SELECT m.user_id, m.created_at FROM chat_messages m WHERE m.msg_type = 'message'
    UNION ALL SELECT cm.sender_id, cm.created_at FROM conversation_messages cm
    UNION ALL SELECT v.user_id, v.created_at FROM pr_votes v
    UNION ALL SELECT iv.user_id, iv.created_at FROM issue_votes iv
    UNION ALL SELECT i.created_by, i.created_at FROM issues i
    UNION ALL SELECT cs.user_id, cs.created_at FROM chat_sessions cs
  ) x
   WHERE x.user_id IS NOT NULL AND x.at >= $1::timestamptz - INTERVAL '7 days'`;

// The last seven days, by depth, and whether Admin › Analytics' WAU counts
// the person (any heartbeat, message, vote, kudos or request). $1 now,
// $2 the 30-second bar.
const LAST_WEEK_SQL = `WITH t AS (SELECT $1::timestamptz - INTERVAL '7 days' AS since)
  SELECT u.id AS user_id,
         (EXISTS (SELECT 1 FROM events e, t WHERE e.user_id = u.id AND e.event_type = 'ui_experience' AND e.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM app_activity a, t WHERE a.user_id = u.id AND a.date >= (t.since AT TIME ZONE 'UTC')::date)) AS opened,
         EXISTS (SELECT 1 FROM app_activity a, t WHERE a.user_id = u.id AND a.seconds_spent >= $2::int
                  AND a.date >= (t.since AT TIME ZONE 'UTC')::date) AS used,
         (EXISTS (SELECT 1 FROM chat_messages m, t WHERE m.user_id = u.id AND m.msg_type = 'message' AND m.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM conversation_messages cm, t WHERE cm.sender_id = u.id AND cm.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM pr_votes v, t WHERE v.user_id = u.id AND v.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM issue_votes iv, t WHERE iv.user_id = u.id AND iv.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM issues i, t WHERE i.created_by = u.id AND i.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM chat_sessions cs, t WHERE cs.user_id = u.id AND cs.created_at >= t.since)) AS contributed,
         (EXISTS (SELECT 1 FROM app_activity a, t WHERE a.user_id = u.id AND a.seconds_spent > 0 AND a.date >= (t.since AT TIME ZONE 'UTC')::date)
           OR EXISTS (SELECT 1 FROM chat_messages m, t WHERE m.user_id = u.id AND m.msg_type = 'message' AND m.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM conversation_messages cm, t WHERE cm.sender_id = u.id AND cm.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM pr_votes v, t WHERE v.user_id = u.id AND v.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM issue_votes iv, t WHERE iv.user_id = u.id AND iv.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM pr_kudos k, t WHERE k.giver_user_id = u.id AND k.created_at >= t.since)
           OR EXISTS (SELECT 1 FROM issues i, t WHERE i.created_by = u.id AND i.created_at >= t.since)) AS analytics_wau
    FROM users u
   WHERE u.id = ANY($3::int[])`;

// Every act inside a project since a week before the era, by week: the
// material groups are read from. The platform's own project is not a group.
// $1 the era's start.
const PROJECT_ACTS_SQL = `SELECT DISTINCT x.app_id, x.user_id, to_char(date_trunc('week', x.at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week FROM (
    SELECT cs.app_id, cs.user_id, cs.created_at AS at FROM chat_sessions cs
    UNION ALL SELECT cs.app_id, v.user_id, v.created_at FROM pr_votes v JOIN chat_sessions cs ON cs.id = v.session_id
    UNION ALL SELECT m.app_id, m.user_id, m.created_at FROM chat_messages m WHERE m.msg_type = 'message'
  ) x JOIN apps ap ON ap.id = x.app_id
   WHERE x.user_id IS NOT NULL AND x.app_id IS NOT NULL AND x.at >= $1::timestamptz - INTERVAL '7 days'
     AND ap.slug NOT LIKE 'usernode%'`;

// What a list of projects is called and how its building went. $1 app ids.
const GROUP_APPS_SQL = `SELECT ap.id, ap.name, ap.slug, ap.created_at, ap.view_visibility,
         (SELECT COUNT(cs.id) FROM chat_sessions cs WHERE cs.app_id = ap.id AND cs.status = 'merged')::int AS builds,
         (SELECT MIN(cs.merged_at) FROM chat_sessions cs WHERE cs.app_id = ap.id AND cs.status = 'merged') AS first_build_at
    FROM apps ap WHERE ap.id = ANY($1::int[])`;

// One group's session, as events on a timeline. $1 the app id.
const GROUP_TIMELINE_SQL = `SELECT 'made' AS kind, ap.created_at AS at, ap.created_by AS user_id, NULL::timestamptz AS until
    FROM apps ap WHERE ap.id = $1::int
  UNION ALL SELECT 'joined', mb.joined_at, mb.user_id, NULL::timestamptz
    FROM community_members mb JOIN apps ap ON ap.community_id = mb.community_id
   WHERE ap.id = $1::int AND mb.source <> 'auto'
  UNION ALL SELECT 'build', cs.created_at, cs.user_id, cs.merged_at
    FROM chat_sessions cs WHERE cs.app_id = $1::int AND cs.status = 'merged'
  UNION ALL SELECT 'message', m.created_at, m.user_id, NULL::timestamptz
    FROM chat_messages m WHERE m.app_id = $1::int AND m.msg_type = 'message'
   ORDER BY at`;

function weekOf(date) {
  return journey.isoDay(journey.weekStart(date));
}

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

/**
 * The groups among `scope` (a Set of user ids): projects with a week where
 * GROUP_MIN or more of them acted. Each carries its qualifying weeks and the
 * people who acted in them.
 */
function groupsAmong(acts, scope) {
  const byAppWeek = new Map();
  for (const a of acts) {
    if (!scope.has(a.userId)) continue;
    const key = `${a.appId}|${a.week}`;
    if (!byAppWeek.has(key)) byAppWeek.set(key, { appId: a.appId, week: a.week, people: new Set() });
    byAppWeek.get(key).people.add(a.userId);
  }
  const groups = new Map();
  for (const w of byAppWeek.values()) {
    if (w.people.size < GROUP_MIN) continue;
    if (!groups.has(w.appId)) groups.set(w.appId, { appId: w.appId, weeks: [], people: new Set() });
    const g = groups.get(w.appId);
    g.weeks.push(w.week);
    for (const p of w.people) g.people.add(p);
  }
  return [...groups.values()].map((g) => ({
    appId: g.appId, weeks: g.weeks.sort(), people: [...g.people].sort((a, b) => a - b),
    cameBack: g.weeks.length >= 2,
  }));
}

/** The weeks from the one before the era to the current one, as ISO Mondays. */
function eraWeeks(now) {
  const out = [];
  const end = journey.weekStart(now).getTime();
  for (let t = journey.weekStart(new Date(`${ERA_START}T00:00:00Z`)).getTime(); t <= end; t += WEEK_MS) {
    out.push(journey.isoDay(new Date(t)));
  }
  return out;
}

async function reading(pool, { leftOutIds = [], now = new Date() } = {}) {
  const params = [ERA_START, STAY_SECONDS, ...journey.realPersonParams(leftOutIds)];
  const [{ rows: people }, { rows: noAccount }, { rows: mail }, { rows: weeks }, { rows: acts }, { rows: times }] = await Promise.all([
    pool.query(PEOPLE_SQL, params),
    pool.query(NO_ACCOUNT_SQL, [ERA_START, (leftOutIds || []).map(Number)]),
    pool.query(MAIL_SQL, [ERA_START]),
    pool.query(ACTIVE_WEEKS_SQL, [ERA_START, STAY_SECONDS]),
    pool.query(PROJECT_ACTS_SQL, [ERA_START]),
    pool.query(TIME_SQL, [ERA_START, TIME_BINS]),
  ]);
  const ids = people.map((p) => Number(p.user_id));
  const { rows: lastWeek } = await pool.query(LAST_WEEK_SQL, [now, STAY_SECONDS, ids]);

  const weeksBy = new Map();
  for (const w of weeks) {
    const id = Number(w.user_id);
    if (!weeksBy.has(id)) weeksBy.set(id, new Set());
    weeksBy.get(id).add(String(w.week));
  }
  const lastBy = new Map(lastWeek.map((r) => [Number(r.user_id), r]));
  const timeBy = new Map();
  for (const t of times) {
    const id = Number(t.user_id);
    const bin = Number(t.bin) - 1;
    if (bin < 0 || bin >= TIME_BINS.length) continue;
    if (!timeBy.has(id)) timeBy.set(id, { best: 0, visits: TIME_BINS.map(() => 0) });
    const cur = timeBy.get(id);
    cur.visits[bin] += Number(t.visits) || 0;
    cur.best = Math.max(cur.best, Number(t.longest) || 0);
  }
  const mailBySignup = new Map(mail.map((m) => [Number(m.signup_id), m]));
  const mailByUser = new Map(mail.filter((m) => m.linked_user_id != null).map((m) => [Number(m.linked_user_id), m]));
  const mailState = (m) => (!m ? null : m.clicked ? 'clicked' : m.opened ? 'opened' : m.on_record ? 'sent' : 'not_on_record');

  const rows = people.map((p) => {
    const id = Number(p.user_id);
    const last = lastBy.get(id) || {};
    const way = p.link_at ? 'link' : p.admitted_at ? 'waitlist' : 'signup';
    const cameAt = way === 'link' ? p.link_at : (p.admitted_at || p.created_at);
    return {
      key: `u${id}`, userId: id, name: p.username || null,
      early: !!p.early, seasonEarly: !!p.season_early, connected: !!p.connected,
      way, admittedDay: p.admitted_at ? journey.isoDay(p.admitted_at) : null, cameAt: iso(cameAt),
      heard: p.heard || null, mail: mailState(mailByUser.get(id)),
      opened: !!p.opened, stayed: !!p.stayed, lastSeen: iso(p.last_seen),
      bestSeconds: timeBy.get(id)?.best || null, visitBins: timeBy.get(id)?.visits || TIME_BINS.map(() => 0),
      activeWeeks: [...(weeksBy.get(id) || [])].sort(),
      last7: { opened: !!last.opened, used: !!last.used, contributed: !!last.contributed, analyticsWau: !!last.analytics_wau },
    };
  });
  for (const w of noAccount) {
    rows.push({
      key: `w${w.signup_id}`, userId: null, name: null, early: false, seasonEarly: false, connected: false,
      way: 'waitlist', admittedDay: journey.isoDay(w.released_at), cameAt: iso(w.released_at),
      heard: w.heard || null, mail: mailState(mailBySignup.get(Number(w.signup_id))),
      opened: false, stayed: false, lastSeen: null, bestSeconds: null, visitBins: TIME_BINS.map(() => 0), activeWeeks: [],
      last7: { opened: false, used: false, contributed: false, analyticsWau: false },
    });
  }

  const projectActs = acts.map((a) => ({ appId: Number(a.app_id), userId: Number(a.user_id), week: String(a.week) }));
  const newcomerIds = new Set(rows.filter((r) => r.userId && !r.early && !r.connected).map((r) => r.userId));
  const everyoneIds = new Set(rows.filter((r) => r.userId).map((r) => r.userId));
  const newcomers = groupsAmong(projectActs, newcomerIds);
  const everyone = groupsAmong(projectActs, everyoneIds);
  const appIds = [...new Set([...newcomers, ...everyone].map((g) => g.appId))];
  const { rows: apps } = appIds.length ? await pool.query(GROUP_APPS_SQL, [appIds]) : { rows: [] };
  const appBy = new Map(apps.map((a) => [Number(a.id), a]));
  const withApp = (g) => {
    const a = appBy.get(g.appId) || {};
    const made = a.created_at ? new Date(a.created_at).getTime() : null;
    const first = a.first_build_at ? new Date(a.first_build_at).getTime() : null;
    return {
      ...g, name: a.name || null, slug: a.slug || null, private: a.view_visibility === 'private',
      madeAt: iso(a.created_at), builds: Number(a.builds) || 0,
      firstBuildMinutes: made != null && first != null ? Math.max(0, Math.round((first - made) / 60000)) : null,
    };
  };

  return {
    demo: false,
    eraStart: ERA_START,
    groupMin: GROUP_MIN,
    staySeconds: STAY_SECONDS,
    timeBins: TIME_BINS,
    weeks: eraWeeks(now),
    thisWeek: weekOf(now),
    people: rows,
    groups: { newcomers: newcomers.map(withApp), everyone: everyone.map(withApp) },
  };
}

/** One group's session: when it was made, who joined, builds and messages. */
async function groupTimeline(pool, appId) {
  const { rows } = await pool.query(GROUP_TIMELINE_SQL, [appId]);
  return {
    appId,
    events: rows.map((r) => ({ kind: r.kind, at: iso(r.at), userId: r.user_id == null ? null : Number(r.user_id), until: iso(r.until) })),
  };
}

module.exports = {
  ERA_START,
  GROUP_MIN,
  STAY_SECONDS,
  TIME_BINS,
  PEOPLE_SQL: PEOPLE_SQL,
  NO_ACCOUNT_SQL: NO_ACCOUNT_SQL,
  MAIL_SQL: MAIL_SQL,
  ACTIVE_WEEKS_SQL: ACTIVE_WEEKS_SQL,
  LAST_WEEK_SQL: LAST_WEEK_SQL,
  PROJECT_ACTS_SQL: PROJECT_ACTS_SQL,
  TIME_SQL: TIME_SQL,
  GROUP_APPS_SQL: GROUP_APPS_SQL,
  GROUP_TIMELINE_SQL: GROUP_TIMELINE_SQL,
  groupsAmong,
  eraWeeks,
  reading,
  groupTimeline,
};
