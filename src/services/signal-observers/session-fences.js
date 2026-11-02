'use strict';

// Reads the browser's session guard cut off where it never should have, and
// invite pages that fell back to the pitch because their read failed
// (#6002).
//
//   session_fence_public  a route fenced on a signed-out page, or a public
//                         route fenced at all, from at least MIN_SOURCES
//                         distinct sources within the hour, or
//                         MIN_ANONYMOUS_SOURCES when none is an account.
//                         Nothing private can be in flight on either, so
//                         the guard cut off a read for nothing: an invite
//                         link showed the waitlist pitch for five days that
//                         way (#5931) and nothing said so.
//   invite_pitch_failed   signed-out invite pages that settled on the pitch
//                         because the invite could not be read, at least
//                         PITCH_FAILED_MIN of them from MIN_SOURCES distinct
//                         sources, and PITCH_FAILED_SHARE of the day's
//                         landings.
//
// Signed-out reports arrive with no account (POST /api/ui-telemetry/
// anonymous), so anybody could send them. Two things keep a forger from
// filing a request: a SOURCE is what the collector itself saw, never what a
// client said (an account, or services/ui-telemetry.js anonymousSource: a
// keyed hash of the address and the day), so one address is one source
// however many visit ids it makes up; and both kinds are a person's to
// triage (platform-signals.js), never the bot's to build on.
//
// The shell reports both through UI telemetry (`session_fence` and
// `invite_settlement` UI events, public/js/ui-telemetry.js; validated and
// stored by services/ui-telemetry.js, which keeps only each read's route
// template, never an address). Everything said publicly is route templates,
// reasons, counts and build SHAs.
//
// Not here yet: the request's second rule, fences per 1,000 page loads
// jumping after a release. Signed-in reports come only from people who
// share usage analytics, so that rate needs its own care.

const MIN_SOURCES = 3;
// When no source is a signed-in account, every one is only a network seen
// by the collector: more of them are needed before a request is filed.
const MIN_ANONYMOUS_SOURCES = 5;
const enoughSources = (sources, min, minAnonymous) => {
  const list = [...sources];
  return list.some((s) => String(s).startsWith('u:')) ? list.length >= min : list.length >= minAnonymous;
};
const PITCH_FAILED_MIN = 3;
const PITCH_FAILED_SHARE = 0.02;
const HOUR_MS = 60 * 60 * 1000;

// One row per fenced route a report named, for the reports of the last 7
// days on a signed-out page or naming a public route, NEWEST first and at
// most $1 of them: past the cap it is the oldest that are left out, so a
// pile of old reports never hides the last hour. Ages are the database's
// clock.
const FENCES_SQL = `
  SELECT e.metadata->>'visitId' AS visit_id,
         COALESCE('u:' || e.user_id::text, 's:' || (e.metadata->>'source')) AS source,
         e.metadata->>'build' AS build,
         e.metadata->>'signedIn' = 'true' AS signed_in,
         x->>'path' AS path,
         x->>'reason' AS reason,
         x->>'public' = 'true' AS public,
         CASE WHEN x->>'count' ~ '^[0-9]{1,4}$' THEN (x->>'count')::int ELSE 1 END AS count,
         e.created_at,
         e.created_at > NOW() - interval '1 hour' AS in_hour
    FROM events e
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(e.metadata->'fences') = 'array' THEN e.metadata->'fences' ELSE '[]'::jsonb END) x
   WHERE e.event_type = 'ui_experience' AND e.metadata->>'kind' = 'session_fence'
     AND e.created_at > NOW() - interval '7 days'
     AND (e.user_id IS NOT NULL OR e.metadata ? 'source')
     AND (e.metadata->>'signedIn' = 'false' OR x->>'public' = 'true')
   ORDER BY e.created_at DESC
   LIMIT $1::int`;

// The last day's invite landings, counted by where they settled.
const LANDINGS_SQL = `
  SELECT e.metadata->>'settled' AS settled,
         COUNT(*)::int AS n,
         COUNT(DISTINCT COALESCE('u:' || e.user_id::text, 's:' || (e.metadata->>'source')))::int AS sources,
         COUNT(DISTINCT e.user_id)::int AS signed_in_sources,
         array_remove(array_agg(DISTINCT e.metadata->>'build'), NULL) AS builds
    FROM events e
   WHERE e.event_type = 'ui_experience' AND e.metadata->>'kind' = 'invite_settlement'
     AND e.created_at > NOW() - interval '24 hours'
     AND (e.user_id IS NOT NULL OR e.metadata ? 'source')
   GROUP BY e.metadata->>'settled'`;

const TEMPLATE_RE = /^\/api(?:\/(?::[A-Za-z0-9_]+|[A-Za-z0-9._~-]+|…)){0,12}$/;
const REASONS = new Set(['epoch', 'scope', 'native']);
const SETTLED = ['card', 'dead', 'failed', 'timeout'];

const iso = (v) => (v ? new Date(v).toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (xs, max = 8) => {
  const shown = xs.slice(0, max);
  return xs.length > max ? `${shown.join(', ')} and ${xs.length - max} more` : shown.join(', ');
};
const time = (v) => (v ? new Date(v).getTime() : 0);
const sha7 = (s) => (/^[0-9a-f]{7,40}$/.test(String(s || '')) ? String(s).slice(0, 7) : null);

/** Pure: the session_fence_public problems in rows of FENCES_SQL. */
function fenceItemsFrom(rows, { minSources = MIN_SOURCES, minAnonymous = MIN_ANONYMOUS_SOURCES, now = Date.now() } = {}) {
  const byPath = new Map();
  for (const r of rows || []) {
    const path = String(r.path || '');
    if (!TEMPLATE_RE.test(path) || !r.visit_id || !r.source || !REASONS.has(r.reason)) continue;
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(r);
  }
  const items = [];
  for (const [path, all] of byPath) {
    const inHour = (r) => (r.in_hour == null ? now - time(r.created_at) < HOUR_MS : r.in_hour === true);
    const hour = all.filter(inHour);
    const visits = new Set(hour.map((r) => r.visit_id));
    const sources = new Set(hour.map((r) => r.source));
    if (!enoughSources(sources, minSources, minAnonymous)) continue;
    const sum = (xs) => xs.reduce((n, r) => n + Math.max(1, Number(r.count) || 1), 0);
    const dayRows = all.filter((r) => now - time(r.created_at) < 24 * HOUR_MS || r.in_hour === true);
    const reasons = [...new Set(hour.map((r) => r.reason))].sort();
    const signedOut = hour.filter((r) => r.signed_in === false).length;
    const publicRoute = path.startsWith('/api/public/');
    const earliest = all.reduce((a, b) => (time(b.created_at) < time(a.created_at) ? b : a));
    const firstBuild = sha7(earliest.build);
    const builds = [...new Set(hour.map((r) => sha7(r.build)).filter(Boolean))].sort();
    // The other routes fenced on the same visits: what else the burst took.
    const others = [...new Set((rows || [])
      .filter((r) => visits.has(r.visit_id) && r.path !== path && TEMPLATE_RE.test(String(r.path || '')))
      .map((r) => r.path))].sort();
    items.push({
      kind: 'session_fence_public',
      key: path,
      topic: path.startsWith('/api/public/invites/') || signedOut ? 'onboarding' : 'infra',
      subject: { route: path },
      title: `Session guard cut off ${publicRoute ? 'a public read' : 'a signed-out read'}: ${path}`,
      summary: 'The browser\'s session guard (frontend/src/lib/api-cache-identity.ts) cut off reads of '
        + `${path} ${publicRoute ? '' : 'on pages nobody was signed in to '}`
        + `from ${plural(sources.size, 'source', 'sources')} within the last hour. `
        + 'Nothing private can be on its way there, so the read was thrown away for nothing, '
        + 'and the screen waiting for it showed its fallback instead.',
      occurrences: sources.size,
      evidence: {
        lines: [
          `${plural(sources.size, 'source', 'sources')}, ${plural(visits.size, 'visit', 'visits')} and ${plural(sum(hour), 'read', 'reads')} in the last hour, `
            + `${plural(new Set(dayRows.map((r) => r.visit_id)).size, 'visit', 'visits')} and `
            + `${plural(sum(dayRows), 'read', 'reads')} in the last 24 hours.`,
          `Why: ${reasons.join(', ')} (epoch: a session reset; scope: the partition cookie replaced; native: the app's session renewal moved).`,
          `Signed out on ${plural(signedOut, 'report', 'reports')} of ${hour.length} in the last hour.`,
          firstBuild
            ? `Started with build ${firstBuild}: the earliest that reported this route in 7 days, at ${iso(earliest.created_at)}.`
            : `First reported at ${iso(earliest.created_at)}; its build was not reported.`,
          builds.length ? `Builds in the last hour: ${list(builds, 6)}.` : null,
          others.length ? `Also cut off on the same visits: ${list(others)}.` : null,
        ].filter(Boolean),
        where: ['frontend/src/lib/api-cache-identity.ts'],
      },
    });
  }
  return items.sort((a, b) => b.occurrences - a.occurrences || (a.key < b.key ? -1 : 1));
}

/** Pure: the invite_pitch_failed problem in rows of LANDINGS_SQL, if any. */
function landingItemsFrom(rows, {
  min = PITCH_FAILED_MIN, share = PITCH_FAILED_SHARE, minSources = MIN_SOURCES, minAnonymous = MIN_ANONYMOUS_SOURCES,
} = {}) {
  const counts = Object.fromEntries(SETTLED.map((k) => [k, 0]));
  let failedSources = 0;
  let failedSignedIn = 0;
  const builds = new Set();
  for (const r of rows || []) {
    if (!SETTLED.includes(r.settled)) continue;
    counts[r.settled] += Math.max(0, Number(r.n) || 0);
    if (r.settled === 'failed') {
      failedSources += Math.max(0, Number(r.sources) || 0);
      failedSignedIn += Math.max(0, Number(r.signed_in_sources) || 0);
    }
    for (const b of Array.isArray(r.builds) ? r.builds : []) if (sha7(b)) builds.add(sha7(b));
  }
  const total = SETTLED.reduce((n, k) => n + counts[k], 0);
  const sourcesNeeded = failedSignedIn > 0 ? minSources : minAnonymous;
  if (counts.failed < min || failedSources < sourcesNeeded || counts.failed < total * share) return [];
  return [{
    kind: 'invite_pitch_failed',
    key: 'invite',
    subject: { page: 'invite' },
    title: `Invite links fell back to the pitch: the invite could not be read on ${plural(counts.failed, 'page', 'pages')}`,
    summary: 'Signed-out invite pages showed the waitlist pitch instead of the invite card because reading the '
      + `invite failed, on ${plural(counts.failed, 'page', 'pages')} of ${total} in the last 24 hours. `
      + 'This should stay near zero: the invite card is how an invited person joins.',
    occurrences: counts.failed,
    evidence: {
      lines: [
        `In the last 24 hours: the invite card ${counts.card}, the dead-link page ${counts.dead}, `
          + `the pitch after the read failed ${counts.failed}, the pitch after the read took too long ${counts.timeout}.`,
        `The failed reads came from ${plural(failedSources, 'source', 'sources')}.`,
        builds.size ? `Builds: ${list([...builds].sort(), 6)}.` : 'Builds: not reported.',
      ],
      where: ['frontend/src/features/auth/invite-card.tsx', 'GET /api/public/invites/:token'],
    },
  }];
}

const ROW_LIMIT = 20000;
async function run(pool, { now = Date.now(), rowLimit = ROW_LIMIT } = {}) {
  const [fences, landings] = await Promise.all([pool.query(FENCES_SQL, [rowLimit]), pool.query(LANDINGS_SQL)]);
  return [...fenceItemsFrom(fences.rows, { now }), ...landingItemsFrom(landings.rows)];
}

module.exports = {
  run,
  fenceItemsFrom,
  landingItemsFrom,
  FENCES_SQL,
  LANDINGS_SQL,
  MIN_SOURCES,
  MIN_ANONYMOUS_SOURCES,
  PITCH_FAILED_MIN,
  PITCH_FAILED_SHARE,
};
