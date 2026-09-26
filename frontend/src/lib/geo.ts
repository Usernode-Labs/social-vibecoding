/**
 * The distance arithmetic behind a run's live total (#routes).
 *
 * ── Why this exists as well as the server's copy ──────────────────────
 *
 * The number that is STORED for a run is computed server-side, from the
 * rows, when the run finishes (src/services/run-routes.js) — it has to be,
 * because a number the client hands over is one nobody can reproduce from
 * the data, and a phone that slept mid-run would report a short one. But
 * the recorder still has to show a total that ticks up while you run, and
 * that number is computed here, on the fixes as they arrive.
 *
 * So there are two implementations of one rule and they have to agree, the
 * same arrangement `timestamp.ts` has with the two classic scripts that
 * cannot import it. tests/routes-screen.test.js EXECUTES both against one
 * table of fixes rather than grepping either, so a drift is a failure
 * rather than a slow divergence between what you watched and what was
 * saved.
 *
 * ── The accuracy filter ───────────────────────────────────────────────
 *
 * A fix the browser reports at 500 m of accuracy could be most of a
 * kilometre from where the person is. Summing those is how a trace through
 * a park reports a 40 km run, so a fix worse than ACCURACY_LIMIT_M is kept
 * in the trace and left out of the sum. A fix with no accuracy at all is
 * counted: the browser not saying is not evidence that it was bad.
 */

/** A fix worse than this many metres does not contribute to the distance. */
export const ACCURACY_LIMIT_M = 100;

/** A step longer than this is a reacquisition, not a step. */
export const MAX_STEP_M = 5000;

const EARTH_RADIUS_M = 6371008.8;

export interface GeoFix {
  lat: number;
  lng: number;
  accuracy_m?: number | null;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in metres between two fixes. */
export function haversineMeters(a: GeoFix, b: GeoFix): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A fix accurate enough to sum. */
export function trustedFix(fix: GeoFix): boolean {
  if (fix.accuracy_m === null || fix.accuracy_m === undefined) return true;
  if (!Number.isFinite(fix.accuracy_m)) return true;
  return fix.accuracy_m <= ACCURACY_LIMIT_M;
}

/**
 * The step a new fix adds to the running total: 0 when either end is
 * untrusted or when the jump is plainly a reacquisition rather than a step.
 */
export function routeStepMeters(previous: GeoFix | null, next: GeoFix): number {
  if (!previous) return 0;
  if (!trustedFix(previous) || !trustedFix(next)) return 0;
  const step = haversineMeters(previous, next);
  return step <= MAX_STEP_M ? step : 0;
}
