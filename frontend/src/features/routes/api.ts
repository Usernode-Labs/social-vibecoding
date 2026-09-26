/**
 * The Routes screen's HTTP surface (#routes).
 *
 * One thin module rather than fetches scattered through the component, so
 * the demo query, the shapes and the failure handling are each written
 * once. Every call goes to src/routes/run-routes.js, which is private by
 * construction: the server reads the viewer off the session, so nothing
 * here ever names a user, and a run that is not the viewer's answers a
 * generic 404.
 *
 * `?demo=1` is forwarded by every read. It is a strict no-op outside
 * staging (the route gates on USERNODE_ENV), and it exists so a preview of
 * an account with no runs is not a blank page — see the route's header.
 */

export interface RunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
  distance_meters: number | null;
  point_count: number;
  has_location: boolean;
  /** A ?demo=1 fixture's name. A real run has none: it is yours, it needs no label. */
  label?: string;
}

export interface RoutePoint {
  seq: number;
  lat: number;
  lng: number;
  recorded_at: string;
  accuracy_m: number | null;
}

/** The `?demo=1` flag, in the same spelling the rest of the shell reads it. */
export function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/** The demo run a declared check deep-links to, by its seeded id. */
export const DEMO_RUN_ID = 900101;

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = new Error(`routes request failed: ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

/** The viewer's own finished runs, newest first. */
export async function fetchRuns(demo: string): Promise<RunRow[]> {
  const data = await readJson<{ runs?: RunRow[] }>(await fetch(`/api/routes${demo}`));
  return Array.isArray(data.runs) ? data.runs : [];
}

/** One run and its trace. */
export async function fetchRun(id: number, demo: string): Promise<{ run: RunRow; points: RoutePoint[] }> {
  const data = await readJson<{ run: RunRow; points?: RoutePoint[] }>(
    await fetch(`/api/routes/${id}${demo}`),
  );
  return { run: data.run, points: Array.isArray(data.points) ? data.points : [] };
}

/** Start a run. The server stamps `started_at`; the client only says when it thinks it began. */
export async function startRun(demo: string): Promise<RunRow> {
  const data = await readJson<{ run: RunRow }>(await fetch(`/api/routes${demo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ started_at: new Date().toISOString() }),
  }));
  return data.run;
}

/** Append a batch of fixes. Idempotent server-side on (route_id, seq). */
export async function appendPoints(
  id: number,
  points: Array<Omit<RoutePoint, 'accuracy_m'> & { accuracy_m?: number | null }>,
  demo: string,
): Promise<number> {
  const data = await readJson<{ appended?: number }>(await fetch(`/api/routes/${id}/points${demo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }),
  }));
  return Number(data.appended) || 0;
}

/** Finalize. The distance and the point count come back from the server's own sum. */
export async function finishRun(id: number, demo: string): Promise<RunRow> {
  const data = await readJson<{ run: RunRow }>(await fetch(`/api/routes/${id}/finish${demo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finished_at: new Date().toISOString() }),
  }));
  return data.run;
}

export async function deleteRun(id: number, demo: string): Promise<void> {
  await readJson<{ deleted?: boolean }>(await fetch(`/api/routes/${id}${demo}`, { method: 'DELETE' }));
}
