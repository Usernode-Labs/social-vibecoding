'use strict';

// client_errors: one script error that several visits hit within the hour.
//
// The shell reports a script error after boot as a `client_error` UI event
// (public/js/ui-telemetry.js; validated and stored by
// services/ui-telemetry.js): a fixed name, the message as a template with
// every value a placeholder, the first frame in Homeroom's own scripts, and
// `js_` + a hash of the name, the template and the frame's file as its
// errorCode. A visit reports a code once. This reads the last hour of them
// and returns one problem per code that at least CLIENT_ERROR_MIN_VISITS
// visits of at least CLIENT_ERROR_MIN_PEOPLE people hit; one that drops
// below either has stopped. Visit ids are the page's own, so one person can
// make as many as they like: the second person is what keeps one person
// from having a public request filed.
//
// Everything said publicly is counts, screen codes, build SHAs, the frame
// and the template. The template is the only text from the page, already
// placeholder-only and scrubbed when it was stored, and it goes in a fenced
// excerpt.

const { scrubText } = require('../platform-signal-evidence');

// A code is a problem from this many distinct visits within the hour, of
// this many people (visits with no account count as one person between
// them, so they alone never reach two).
const CLIENT_ERROR_MIN_VISITS = 3;
const CLIENT_ERROR_MIN_PEOPLE = 2;
// The screens of a first session (topic-figures.js SIGN_IN_SCREENS): an
// error most of whose visits were on them is onboarding's.
const FIRST_SESSION_SCREENS = Object.freeze(['username_sheet', 'terms_sheet', 'join_sheet', 'tour', 'ping_ask']);
const HOUR_MS = 60 * 60 * 1000;

// One row per code and visit over the last 24 hours, for the codes at least
// $1 visits of $2 people hit in the last hour: the visit's latest report of
// that code. Ages are the database's clock.
const CLIENT_ERRORS_SQL = `
  WITH hot AS (
    SELECT e.metadata->>'errorCode' AS code
      FROM events e
     WHERE e.event_type = 'ui_experience' AND e.metadata->>'kind' = 'client_error'
       AND e.created_at > NOW() - interval '1 hour'
     GROUP BY e.metadata->>'errorCode'
    HAVING COUNT(DISTINCT e.metadata->>'visitId') >= $1::int
       AND COUNT(DISTINCT e.user_id) + MAX(CASE WHEN e.user_id IS NULL THEN 1 ELSE 0 END) >= $2::int
  )
  SELECT DISTINCT ON (e.metadata->>'errorCode', e.metadata->>'visitId')
         e.metadata->>'errorCode' AS error_code,
         e.metadata->>'visitId' AS visit_id,
         e.user_id,
         e.metadata->>'screen' AS screen,
         e.metadata->>'build' AS build,
         e.metadata->>'errorName' AS error_name,
         e.metadata->>'template' AS template,
         e.metadata->>'frame' AS frame,
         e.created_at,
         e.created_at > NOW() - interval '1 hour' AS in_hour
    FROM events e
    JOIN hot h ON h.code = e.metadata->>'errorCode'
   WHERE e.event_type = 'ui_experience' AND e.metadata->>'kind' = 'client_error'
     AND e.created_at > NOW() - interval '24 hours'
   ORDER BY e.metadata->>'errorCode', e.metadata->>'visitId', e.created_at DESC
   LIMIT 20000`;

const CODE_RE = /^js_[a-z0-9]{6,16}$/;
const FRAME_RE = /^\/(?:js|shell\/assets)\/[A-Za-z0-9_.\/-]{1,160}:\d{1,7}:\d{1,7}$/;

const iso = (v) => (v ? new Date(v).toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (xs, max = 8) => {
  const shown = xs.slice(0, max);
  return xs.length > max ? `${shown.join(', ')} and ${xs.length - max} more` : shown.join(', ');
};
const time = (v) => (v ? new Date(v).getTime() : 0);

// Where in the repository a frame points: the classic scripts are served
// as they are; the shell bundle is built from frontend/.
function sourceHint(frame) {
  if (!frame) return null;
  const path = frame.replace(/:\d+:\d+$/, '');
  if (path.startsWith('/js/')) return `public${path}`;
  if (path.startsWith('/shell/assets/')) return `frontend/src (built into ${path}; the line and column are the built file's)`;
  return null;
}

// People among rows: each account once, and every visit with none as one.
function peopleIn(rows) {
  const ids = new Set(rows.map((r) => (r.user_id == null ? 'none' : String(r.user_id))));
  return ids.size;
}

/** Pure: the problems in rows of CLIENT_ERRORS_SQL. */
function itemsFrom(rows, {
  minVisits = CLIENT_ERROR_MIN_VISITS, minPeople = CLIENT_ERROR_MIN_PEOPLE, now = Date.now(),
} = {}) {
  const byCode = new Map();
  for (const r of rows || []) {
    const code = String(r.error_code || '');
    if (!CODE_RE.test(code) || !r.visit_id) continue;
    if (!byCode.has(code)) byCode.set(code, new Map());
    const visits = byCode.get(code);
    const seen = visits.get(r.visit_id);
    // One row per visit: its latest report of the code.
    if (!seen || time(r.created_at) > time(seen.created_at)) visits.set(r.visit_id, r);
  }
  const items = [];
  for (const [code, visits] of byCode) {
    const all = [...visits.values()];
    const inHour = (r) => (r.in_hour == null ? now - time(r.created_at) < HOUR_MS : r.in_hour === true);
    const hour = all.filter(inHour);
    const people = peopleIn(hour);
    if (hour.length < minVisits || people < minPeople) continue;
    const latest = all.reduce((a, b) => (time(b.created_at) > time(a.created_at) ? b : a));
    const frame = FRAME_RE.test(String(latest.frame || '')) ? latest.frame : null;
    const errorName = /^[A-Za-z]{1,40}$/.test(String(latest.error_name || '')) ? latest.error_name : 'Error';
    const template = scrubText(String(latest.template || '')).replace(/\s+/g, ' ').trim().slice(0, 160);
    const screens = [...new Set(all.map((r) => r.screen).filter(Boolean))].sort();
    const builds = [...new Set(all.map((r) => r.build).filter(Boolean))].sort();
    const firstSession = hour.filter((r) => FIRST_SESSION_SCREENS.includes(r.screen)).length;
    const topic = firstSession * 2 > hour.length ? 'onboarding' : 'infra';
    const hint = sourceHint(frame);
    items.push({
      kind: 'client_errors',
      key: code,
      topic,
      subject: { errorCode: code, errorName, frame },
      title: frame
        ? `Page error: ${errorName} at ${frame}`
        : `Page error: ${errorName}${template ? `: ${template}` : ''}`,
      summary: 'A script error keeps happening on Homeroom\'s pages after they load: the same error, '
        + `in ${plural(hour.length, 'visit', 'visits')} within the last hour. `
        + 'Whatever the page was doing when it threw did not finish.',
      occurrences: hour.length,
      evidence: {
        lines: [
          `${plural(hour.length, 'visit', 'visits')} in the last hour (${plural(people, 'person', 'people')}), `
            + `${plural(all.length, 'visit', 'visits')} in the last 24 hours, the last at ${iso(latest.created_at)}.`,
          screens.length ? `Screens: ${list(screens)}.` : null,
          builds.length ? `Builds: ${list(builds, 6)}.` : 'Builds: not reported.',
          `Error: ${errorName}, code ${code}.`,
          frame ? null : 'No frame in Homeroom\'s own scripts was on its stack.',
        ].filter(Boolean),
        excerpts: template ? [{ label: `${errorName} message, with every value replaced`, text: template }] : [],
        where: [frame, hint].filter(Boolean),
      },
    });
  }
  return items.sort((a, b) => b.occurrences - a.occurrences || (a.key < b.key ? -1 : 1));
}

async function run(pool, {
  now = Date.now(), minVisits = CLIENT_ERROR_MIN_VISITS, minPeople = CLIENT_ERROR_MIN_PEOPLE,
} = {}) {
  const { rows } = await pool.query(CLIENT_ERRORS_SQL, [minVisits, minPeople]);
  return itemsFrom(rows, { minVisits, minPeople, now });
}

module.exports = {
  run,
  itemsFrom,
  CLIENT_ERRORS_SQL,
  CLIENT_ERROR_MIN_VISITS,
  CLIENT_ERROR_MIN_PEOPLE,
  FIRST_SESSION_SCREENS,
};
