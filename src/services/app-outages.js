'use strict';

// A project's app seen down, kept as one events row per app per minute:
//
//   app_unavailable  somebody opening the app got the unavailable page
//                    (routes/app-error.js) instead of the app
//   app_restarted    the watchdog (app-heal.js) found the app down and
//                    brought it back; metadata.count says how many times
//                    in that minute
//
// A minute is enough for what reads them (the Infra topic's figures,
// services/topic-figures.js) and keeps the rows bounded however often the
// page is hit: the unavailable page is served before sign-in, so this
// process writes an app's minute once and every later hit in it is
// dropped here. Homeroom's own app is never recorded: it has no watchdog
// and no unavailable page of its own.
//
// Fire and forget, like events.record: a lost row never fails the page or
// the heal that produced it.

const log = require('./logger');

const MINUTE_MS = 60 * 1000;
const TYPES = Object.freeze({ UNAVAILABLE: 'app_unavailable', RESTARTED: 'app_restarted' });
// What the watchdog reports when it brought an app back.
const RESTART_OUTCOMES = Object.freeze(['started', 'restarted', 'rebuilt', 'respawned']);
const MAX_SEEN = 2000;

const UNAVAILABLE_SQL = `
  INSERT INTO events (app_id, event_type, metadata, created_at)
  SELECT ap.id, 'app_unavailable', jsonb_build_object('minute', $2::text), to_timestamp($2::bigint * 60)
    FROM apps ap
   WHERE ap.slug = $1 AND ap.self_hosted IS NOT TRUE
  ON CONFLICT (app_id, event_type, (metadata->>'minute'))
    WHERE event_type IN ('app_unavailable', 'app_restarted') AND metadata ? 'minute'
  DO NOTHING`;

const RESTARTED_SQL = `
  INSERT INTO events (app_id, event_type, metadata, created_at)
  SELECT ap.id, 'app_restarted',
         jsonb_build_object('minute', $2::text, 'count', 1, 'outcome', $3::text, 'via', $4::text),
         to_timestamp($2::bigint * 60)
    FROM apps ap
   WHERE ap.id = $1 AND ap.self_hosted IS NOT TRUE
  ON CONFLICT (app_id, event_type, (metadata->>'minute'))
    WHERE event_type IN ('app_unavailable', 'app_restarted') AND metadata ? 'minute'
  DO UPDATE SET metadata = events.metadata
    || jsonb_build_object('count', COALESCE((events.metadata->>'count')::int, 0) + 1, 'outcome', $3::text)`;

// slug|minute already written by this process.
const seen = new Set();

const minuteOf = (now) => Math.floor(now / MINUTE_MS);

function remember(key) {
  seen.add(key);
  if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
}

/** The unavailable page was shown for `slug`. Never throws. */
function recordUnavailable(pool, slug, now = Date.now()) {
  if (!slug || !pool) return Promise.resolve();
  const minute = minuteOf(now);
  const key = `${slug}|${minute}`;
  if (seen.has(key)) return Promise.resolve();
  remember(key);
  try {
    return Promise.resolve(pool.query(UNAVAILABLE_SQL, [String(slug), String(minute)]))
      .then(() => {})
      .catch((err) => log.debug('app-outages', 'Could not record an unavailable app', { slug, err: err.message }));
  } catch (err) {
    log.debug('app-outages', 'Could not record an unavailable app', { slug, err: err && err.message });
    return Promise.resolve();
  }
}

/**
 * The watchdog's verdict on `app`; recorded only when it brought the app
 * back. `via`: 'sweep' (its own round) or 'visit' (somebody hit the page).
 * Never throws.
 */
function recordHealed(pool, app, result, via, now = Date.now()) {
  if (!pool || !app || app.self_hosted || !result || !RESTART_OUTCOMES.includes(result.status)) return Promise.resolve();
  try {
    return Promise.resolve(pool.query(RESTARTED_SQL, [Number(app.id), String(minuteOf(now)), result.status, via]))
      .then(() => {})
      .catch((err) => log.debug('app-outages', 'Could not record a restart', { slug: app.slug, err: err.message }));
  } catch (err) {
    log.debug('app-outages', 'Could not record a restart', { slug: app.slug, err: err && err.message });
    return Promise.resolve();
  }
}

function _resetForTests() {
  seen.clear();
}

module.exports = { TYPES, RESTART_OUTCOMES, recordUnavailable, recordHealed, _resetForTests };
