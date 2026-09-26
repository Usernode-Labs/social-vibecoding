'use strict';

// Run routes (#routes) — the run itself, and the arithmetic behind it.
//
// A route is a person's own trace: the fixes they recorded while running,
// and the two numbers the screen shows for it. The screen lives at
// frontend/src/features/routes/ and the HTTP surface at
// src/routes/run-routes.js; what is here is the part both the API and its
// tests need to agree on — the distance math, the demo fixtures, and the
// SQL.
//
// ── The distance is the SERVER's ──────────────────────────────────────
//
// The recorder shows a running total while you run, but the number that is
// STORED is computed here, from the rows, when the run finishes. Two
// reasons, and both matter: a number the client hands over is a number
// nobody can reproduce from the data, and a reload mid-run (or a phone
// that slept) leaves the client's own tally short. `summarize()` is the
// one derivation, and it runs over whatever points actually landed.
//
// ── The accuracy filter ───────────────────────────────────────────────
//
// A fix the browser reports with `accuracy_m` of 500 is a fix that could be
// most of a kilometre from where the person actually is. Summing those
// into the distance is how a GPS trace reports a 40 km run through a park,
// so a fix worse than ACCURACY_LIMIT_M is EXCLUDED FROM THE SUM while still
// being stored — the trace is what happened, the distance is what is
// defensible. A fix with no accuracy at all is counted: the browser not
// saying is not evidence that it was bad.
//
// ── The demo fixtures ─────────────────────────────────────────────────
//
// A run is private by construction, so a staging preview of an account
// that has never recorded one is an empty list — which is honest and
// unreviewable. The `?demo=1` path (routes/run-routes.js) answers from
// DEMO_RUNS instead, read-only, owned by nobody. Run 2 has NO POINTS on
// purpose: it is the run that was recorded with no location, and it is what
// makes the degraded state visible in a preview that cannot grant GPS.

const EARTH_RADIUS_M = 6371008.8;
/** A fix worse than this many metres does not contribute to the distance. */
const ACCURACY_LIMIT_M = 100;
/** The distance shown for a fix-to-fix step that is plainly a jump, not a step. */
const MAX_STEP_M = 5000;
/** Caps. Both refuse politely; see routes/run-routes.js. */
const MAX_POINTS_PER_RUN = 20000;
const MAX_RUNS_PER_USER = 500;
/** A run started and never finished is swept after this long. */
const UNFINISHED_TTL_MS = 24 * 60 * 60 * 1000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in metres between two { lat, lng } fixes. */
function haversineMeters(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A fix is a usable position: two real numbers, in range. */
function usablePoint(point) {
  if (!point) return false;
  if (!finite(point.lat) || !finite(point.lng)) return false;
  if (point.lat < -90 || point.lat > 90) return false;
  if (point.lng < -180 || point.lng > 180) return false;
  return true;
}

/** A fix accurate enough to sum: see ACCURACY_LIMIT_M. */
function trustedPoint(point) {
  if (!usablePoint(point)) return false;
  if (point.accuracy_m === null || point.accuracy_m === undefined) return true;
  if (!finite(point.accuracy_m)) return true;
  return point.accuracy_m <= ACCURACY_LIMIT_M;
}

/**
 * The stored numbers for a run, from its points.
 *
 * `pointCount` counts every stored fix; `hasLocation` says there is a trace
 * to draw at all; `distanceMeters` sums the great-circle steps between
 * successive TRUSTED fixes, skipping a step that is plainly a jump rather
 * than a step (MAX_STEP_M) — a phone that lost GPS in a tunnel and
 * reacquired it two kilometres later must not add two kilometres nobody
 * ran.
 */
function summarize(points) {
  const list = (points || []).filter(usablePoint);
  let distanceMeters = 0;
  let previous = null;
  for (const point of list) {
    if (!trustedPoint(point)) continue;
    if (previous) {
      const step = haversineMeters(previous, point);
      if (step <= MAX_STEP_M) distanceMeters += step;
    }
    previous = point;
  }
  return {
    pointCount: list.length,
    hasLocation: list.length > 0,
    distanceMeters: Math.round(distanceMeters),
  };
}

/** Whole seconds between two instants, never negative, null when open. */
function durationSeconds(startedAt, finishedAt) {
  if (!finishedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

// ── The demo fixtures ───────────────────────────────────────────────────

/**
 * A deterministic little PRNG, so the demo trace is the same shape on every
 * boot and two previews of the same build draw the same line.
 */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * One plausible loop: a rounded rectangle walked once, with a metre or two
 * of jitter, sampled every few seconds. Not a real place — the coordinates
 * are a fixed offset from 0,0 and the shape is generated, not recorded.
 */
function demoTrace(seed, count, baseLat, baseLng, spanLat, spanLng, seconds) {
  const rand = seeded(seed);
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / count;
    const angle = t * Math.PI * 2;
    const lat = baseLat + spanLat * Math.sin(angle) + (rand() - 0.5) * 0.00002;
    const lng = baseLng + spanLng * (1 - Math.cos(angle)) * 0.5 + (rand() - 0.5) * 0.00002;
    points.push({
      seq: i,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      recorded_at: new Date(Date.parse('2026-08-18T06:12:00Z') + i * seconds * 1000).toISOString(),
      accuracy_m: Math.round((4 + rand() * 6) * 10) / 10,
      altitude_m: null,
      speed_mps: null,
    });
  }
  return points;
}

const DEMO_TRACES = Object.freeze({
  900101: demoTrace(101, 48, 0.0200, 0.0100, 0.0060, 0.0120, 30),
  900103: demoTrace(103, 36, 0.0400, 0.0300, 0.0045, 0.0090, 25),
});

/** The three runs a preview shows. Owned by nobody; written nowhere. */
const DEMO_RUNS = Object.freeze([
  Object.freeze({
    id: 900101,
    label: 'Staging demo run 1',
    started_at: '2026-08-18T06:12:00Z',
    finished_at: '2026-08-18T06:36:00Z',
  }),
  Object.freeze({
    id: 900102,
    label: 'Staging demo run 2',
    started_at: '2026-08-20T18:05:00Z',
    finished_at: '2026-08-20T18:17:00Z',
  }),
  Object.freeze({
    id: 900103,
    label: 'Staging demo run 3',
    started_at: '2026-08-23T07:40:00Z',
    finished_at: '2026-08-23T07:55:00Z',
  }),
]);

function demoPoints(id) {
  return (DEMO_TRACES[id] || []).map((point) => ({ ...point }));
}

/** One demo run, in the shape the list and the detail route both answer. */
function demoRun(id) {
  const run = DEMO_RUNS.find((r) => r.id === Number(id));
  if (!run) return null;
  const points = demoPoints(run.id);
  const summary = summarize(points);
  return {
    id: run.id,
    label: run.label,
    started_at: run.started_at,
    finished_at: run.finished_at,
    duration_seconds: durationSeconds(run.started_at, run.finished_at),
    distance_meters: summary.distanceMeters,
    point_count: summary.pointCount,
    has_location: summary.hasLocation,
  };
}

function demoList() {
  return { runs: DEMO_RUNS.map((run) => demoRun(run.id)), demo: true };
}

function demoDetail(id) {
  const run = demoRun(id);
  if (!run) return null;
  return { run, points: demoPoints(run.id), demo: true };
}

// ── The SQL ─────────────────────────────────────────────────────────────

const RUN_COLUMNS = `id, started_at, finished_at, duration_seconds,
        distance_meters, point_count, has_location`;

/** The viewer's own finished runs, newest first. Never anybody else's. */
async function listFor(pool, userId) {
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS}
       FROM run_routes
      WHERE user_id = $1 AND finished_at IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 100`,
    [userId]
  );
  return rows;
}

async function countFor(pool, userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM run_routes WHERE user_id = $1',
    [userId]
  );
  return rows[0] ? Number(rows[0].n) : 0;
}

async function createRun(pool, userId, startedAt) {
  const { rows } = await pool.query(
    `INSERT INTO run_routes (user_id, started_at)
     VALUES ($1, $2)
     RETURNING ${RUN_COLUMNS}`,
    [userId, startedAt]
  );
  return rows[0];
}

/** Owner check as part of the read: another person's id simply finds nothing. */
async function ownedRun(pool, userId, id) {
  const { rows } = await pool.query(
    `SELECT ${RUN_COLUMNS}
       FROM run_routes
      WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

/**
 * Append a batch of fixes. `ON CONFLICT DO NOTHING` on (route_id, seq) is
 * what makes a re-sent batch harmless: a reload mid-run replays the last
 * few fixes, and the trace stays the trace.
 */
async function appendPoints(pool, routeId, points) {
  if (!points.length) return 0;
  const seqs = points.map((p) => p.seq);
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const ats = points.map((p) => p.recorded_at);
  const accuracies = points.map((p) => (p.accuracy_m === undefined ? null : p.accuracy_m));
  const altitudes = points.map((p) => (p.altitude_m === undefined ? null : p.altitude_m));
  const speeds = points.map((p) => (p.speed_mps === undefined ? null : p.speed_mps));
  const { rowCount } = await pool.query(
    `INSERT INTO run_route_points
       (route_id, seq, lat, lng, recorded_at, accuracy_m, altitude_m, speed_mps)
     SELECT $1::bigint, s.seq, s.lat, s.lng, s.recorded_at, s.accuracy_m, s.altitude_m, s.speed_mps
       FROM unnest($2::int[], $3::float8[], $4::float8[], $5::timestamptz[],
                   $6::real[], $7::real[], $8::real[])
              AS s(seq, lat, lng, recorded_at, accuracy_m, altitude_m, speed_mps)
     ON CONFLICT (route_id, seq) DO NOTHING`,
    [routeId, seqs, lats, lngs, ats, accuracies, altitudes, speeds]
  );
  return rowCount || 0;
}

async function pointsFor(pool, routeId) {
  const { rows } = await pool.query(
    `SELECT seq, lat, lng, recorded_at, accuracy_m, altitude_m, speed_mps
       FROM run_route_points
      WHERE route_id = $1
      ORDER BY seq ASC`,
    [routeId]
  );
  return rows;
}

/**
 * Finalize: the two derived numbers come from the rows, never from the
 * caller. Re-finishing an already-finished run is a no-op on the timestamps
 * (COALESCE) but still recomputes, so a late batch that landed after the
 * Finish tap is reflected.
 */
async function finishRun(pool, userId, id, finishedAt) {
  const run = await ownedRun(pool, userId, id);
  if (!run) return null;
  const summary = summarize(await pointsFor(pool, id));
  const { rows } = await pool.query(
    `UPDATE run_routes
        SET finished_at = COALESCE(finished_at, $3::timestamptz),
            duration_seconds = $4::int,
            distance_meters = $5::int,
            point_count = $6::int,
            has_location = $7::boolean
      WHERE id = $1 AND user_id = $2
      RETURNING ${RUN_COLUMNS}`,
    [id, userId, finishedAt,
      durationSeconds(run.started_at, finishedAt),
      summary.distanceMeters, summary.pointCount, summary.hasLocation]
  );
  return rows[0] || null;
}

async function deleteRun(pool, userId, id) {
  const { rowCount } = await pool.query(
    'DELETE FROM run_routes WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return rowCount > 0;
}

/**
 * A run started and never finished is kept out of the list, and swept after
 * a day so a failed recording does not leave a phantom row behind forever.
 * Called from the boot maintenance phase.
 */
async function sweepUnfinished(pool) {
  const { rowCount } = await pool.query(
    `DELETE FROM run_routes
      WHERE finished_at IS NULL
        AND started_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
    [UNFINISHED_TTL_MS]
  );
  return rowCount || 0;
}

module.exports = {
  ACCURACY_LIMIT_M,
  MAX_POINTS_PER_RUN,
  MAX_RUNS_PER_USER,
  UNFINISHED_TTL_MS,
  DEMO_RUNS,
  haversineMeters,
  usablePoint,
  trustedPoint,
  summarize,
  durationSeconds,
  demoRun,
  demoList,
  demoDetail,
  listFor,
  countFor,
  createRun,
  ownedRun,
  appendPoints,
  pointsFor,
  finishRun,
  deleteRun,
  sweepUnfinished,
};
