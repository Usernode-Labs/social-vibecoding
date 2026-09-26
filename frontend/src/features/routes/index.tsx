/**
 * `#routes-screen` — the runs you have recorded, and the one you are on.
 *
 * ── What it is for ─────────────────────────────────────────────────────
 *
 * A run leaves nothing behind: you went somewhere, and the only record is
 * what you remember of it. This screen is where a run becomes a thing you
 * can look at again — the path you took, drawn as a line, and the two
 * numbers that describe it. It is reached from Me → More → Routes and it is
 * the closest sibling of the Workshop screen: a header with the screen's
 * name, a SectionHeader over a card of rows, a leading tile, a title and a
 * one-line subtitle, and a tap that drills in.
 *
 * ── PRIVATE, and that is not a setting ─────────────────────────────────
 *
 * Only you can see your own runs. There is no shared feed and no route that
 * names anybody else's run; opening one that is not yours is refused the
 * same way a direct message to a stranger is (a generic 404, so the refusal
 * does not confirm the row exists). The API is private by construction —
 * src/routes/run-routes.js — and this screen never asks for anything else.
 *
 * ── The one primary action ─────────────────────────────────────────────
 *
 * **Start run**, a filled accent pill at the head of the screen. While a run
 * is in progress the same control is **Finish run** and takes the stop
 * treatment, and nothing on the screen competes with it. Under it, the live
 * line ticks: the elapsed time and the running distance, so you can pocket
 * the phone and glance at it mid-run.
 *
 * ── The two honest degradations ────────────────────────────────────────
 *
 * The recorder works with no location at all. When there is none, the
 * screen says so in plain words, the timer still runs, the run still saves,
 * and its map is simply empty — never a silent failure, and never a fast
 * PERMISSION_DENIED read as "the user said no" when the real cause is that
 * no capability was ever delegated. See `resolveLocation`.
 *
 * ── The island rules it keeps ──────────────────────────────────────────
 *
 * Nothing in `public/js/**` writes inside this root, so the region may hold
 * state. Its FIRST render is the shipped document — `hidden`, an empty
 * list, no rows — and every fetch runs from the controller's `open()` or
 * from a tap, never during render. Screen visibility is the shell's store
 * (`#routes-screen` is in App.REACT_SCREEN_IDS) and the root's `className`
 * is a constant, so the class has exactly one owner.
 */

import { useRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow, PLANE_FILL, SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { ClockIcon, MapPinIcon, PlayIcon } from '@/components/ui/icons';
import { RouteMap } from '@/components/ui/route-map';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { confirmAction } from '../../lib/confirm';
import { ACCURACY_LIMIT_M, routeStepMeters, trustedFix } from '../../lib/geo';
import { messageStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import {
  DEMO_RUN_ID, appendPoints, deleteRun, demoQuery, fetchRun, fetchRuns, finishRun, startRun,
  type RoutePoint, type RunRow,
} from './api';
import { routesStore } from './routes-store.js';

// The legacy router reads the DOM on the line after it routes, so the
// store's notification has to land synchronously. Same install, same
// reason, as features/workshop/index.tsx.
routesStore.setFlush(flushSync);

// ── The words ───────────────────────────────────────────────────────────
//
// One idea, one word: the screen is "Routes", the list is "Your runs", a
// run is "a run". The two lines a tester reads in a preview that cannot
// grant location are the spec's own sentences, spelled once here.
export const PRIVACY_LINE = 'Only you can see your runs.';
export const EMPTY_TITLE = 'No runs yet';
export const EMPTY_HINT = 'Tap Start run to record your first one.';
export const LOCATION_OFF = 'Location is off, so this run will not be drawn on a map.';
export const LOCATION_LOST = 'Location was lost. The run keeps recording, but the map stops where it was.';
export const NO_MAP_LINE = 'This run was recorded with no location.';

type LocationState = 'unknown' | 'on' | 'off';

// ── Formatting ──────────────────────────────────────────────────────────

/** Metres as the app's plainest reading of distance: kilometres. */
export function formatDistance(meters: number | null | undefined): string {
  const value = Number(meters);
  if (!Number.isFinite(value) || value <= 0) return '0 km';
  const km = value / 1000;
  // One decimal under 10 km (a run is 3.2 km, not 3 km), whole kilometres
  // above it, which is the same rounding a person does when they say it.
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Seconds as "24 min", or "1 h 05 min" past an hour. */
export function formatDuration(seconds: number | null | undefined): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '0 min';
  const total = Math.round(value);
  if (total < 60) return `${total} sec`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} h ${String(rest).padStart(2, '0')} min`;
}

/**
 * The row's title: the run's own time, in the app's existing wording
 * (lib/timestamp.ts) rather than a second date format invented here. The
 * demo fixtures carry their own "Staging demo run N" label, which is the
 * only name a run ever has — a real run is yours and needs none.
 */
export function rowTitle(run: RunRow, now = Date.now()): string {
  if (run.label) return run.label;
  const iso = run.finished_at || run.started_at;
  if (!iso) return 'Run';
  return messageStamp(iso, { now: new Date(now) }).text;
}

/** The row's second line: "3.2 km · 24 min", the app's own separator. */
export function rowSubtitle(run: RunRow): string {
  if (!run.has_location) return `${formatDuration(run.duration_seconds)} · no location`;
  return `${formatDistance(run.distance_meters)} · ${formatDuration(run.duration_seconds)}`;
}

/** The live line under the button, in the same two units and separator. */
export function liveLine(elapsed: number, meters: number, location: LocationState): string {
  const distance = formatDistance(meters);
  const time = formatDuration(elapsed);
  return location === 'off' ? time : `${distance} · ${time}`;
}

// ── Location ────────────────────────────────────────────────────────────

type UsernodeBridge = {
  hasCapability?: (capability: string) => boolean;
  requestPermission?: (capability: string) => Promise<{ state?: string; active?: boolean }>;
};

function bridge(): UsernodeBridge | null {
  const host = window as unknown as { usernode?: UsernodeBridge };
  return host?.usernode || null;
}

/** Is this document inside the platform shell's frame? */
export function isFramed(): boolean {
  try { return window.self !== window.top; } catch { return true; }
}

/**
 * Whether we can expect a location, and whether the frame is about to
 * reload under us.
 *
 * THE TWO SURFACES DIFFER, and the screen has to branch rather than assume
 * one:
 *
 *   TOP LEVEL (the normal case for a platform screen). The shell document
 *     is not in a frame, so the platform's gated-capability catalogue does
 *     not apply — geolocation is the browser's own API for this origin, and
 *     `usernode.requestPermission()` is NOT usable here: the bridge posts to
 *     `window.parent`, and at top level that is this window, so it rejects.
 *     `hasCapability` is the one bridge call that works standalone, and
 *     `true` where the browser exposes no policy — so it means "try it and
 *     see", not a guarantee.
 *   FRAMED (the staging preview, the landing viewer). The preview's iframe
 *     delegates no gated capability, so we ask the shell. A first grant
 *     RELOADS the frame, which is why `active: false` is a stop rather than
 *     a start: the reload is about to land, and starting a run into it
 *     would lose the run.
 *
 * 'unknown' is a real answer and means "use the browser's own API and find
 * out from its error". Nothing here treats a fast PERMISSION_DENIED as "the
 * user said no": error code 1 is reported as declined OR blocked, without
 * claiming which.
 */
export async function resolveLocation(): Promise<{ state: LocationState; reloading: boolean }> {
  const api = bridge();
  if (!isFramed()) {
    if (typeof api?.hasCapability === 'function' && api.hasCapability('geolocation') === false) {
      return { state: 'off', reloading: false };
    }
    return { state: 'unknown', reloading: false };
  }
  if (typeof api?.requestPermission === 'function') {
    try {
      const answer = await api.requestPermission('geolocation');
      if (answer?.state === 'granted' && answer.active === false) {
        return { state: 'off', reloading: true };
      }
      return { state: answer?.state === 'granted' ? 'on' : 'off', reloading: false };
    } catch {
      // A bridge that cannot answer is not a refusal: fall through and let
      // the browser's own API decide.
      return { state: 'unknown', reloading: false };
    }
  }
  return { state: 'unknown', reloading: false };
}

// ── The recorder ────────────────────────────────────────────────────────

type Fix = RoutePoint;

/**
 * Everything a run in progress needs, kept OUT of React: the watch id, the
 * tick, the batch buffer and the running total are all things a render must
 * not restart. One object, module scope, because there is exactly one
 * recorder and only ever one run at a time.
 */
const recorder = {
  runId: null as number | null,
  seq: 0,
  /** The last TRUSTED fix, so the total matches the server's own sum. */
  last: null as Fix | null,
  pending: [] as Fix[],
  total: 0,
  startedAt: 0,
  watchId: null as number | null,
  tick: null as ReturnType<typeof setInterval> | null,
  flush: null as ReturnType<typeof setInterval> | null,
  wakeLock: null as { release?: () => Promise<void> } | null,
};

function resetRecorder() {
  recorder.runId = null;
  recorder.seq = 0;
  recorder.last = null;
  recorder.pending = [];
  recorder.total = 0;
  recorder.startedAt = 0;
}

function stopTimers() {
  if (recorder.tick) { clearInterval(recorder.tick); recorder.tick = null; }
  if (recorder.flush) { clearInterval(recorder.flush); recorder.flush = null; }
}

function stopWatch() {
  if (recorder.watchId !== null && typeof navigator !== 'undefined') {
    try { navigator.geolocation?.clearWatch(recorder.watchId); } catch { /* already gone */ }
  }
  recorder.watchId = null;
  try { void recorder.wakeLock?.release?.(); } catch { /* the lock may have gone */ }
  recorder.wakeLock = null;
}

async function acquireWakeLock() {
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: string) => Promise<{ release?: () => Promise<void> }> };
    };
    recorder.wakeLock = (await nav.wakeLock?.request?.('screen')) || null;
  } catch {
    recorder.wakeLock = null;
  }
}

function onFix(position: GeolocationPosition) {
  if (!recorder.runId) return;
  const coords = position.coords;
  const fix: Fix = {
    seq: recorder.seq,
    lat: coords.latitude,
    lng: coords.longitude,
    recorded_at: new Date().toISOString(),
    accuracy_m: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
  };
  recorder.seq += 1;
  recorder.pending.push(fix);
  // The running total follows the SERVER's rule exactly (lib/geo.ts is the
  // same arithmetic as services/run-routes.js): only trusted fixes count,
  // and `last` only ever moves to a trusted one, so a bad fix neither adds
  // to the total nor becomes the anchor the next step is measured from.
  if (trustedFix(fix)) {
    recorder.total += routeStepMeters(recorder.last, fix);
    recorder.last = fix;
  }
  routesStore.set({
    locationState: 'on',
    liveMeters: Math.round(recorder.total),
    notice: null,
  });
  if (recorder.pending.length >= 20) void flushPoints();
}

function onFixError(error: GeolocationPositionError) {
  // Code 1 is "declined or blocked" and the two are the same code, so the
  // screen explains rather than accuses. A run that already has fixes keeps
  // them; only the line changes.
  const hasTrace = recorder.total > 0 || recorder.last !== null;
  routesStore.set({
    locationState: 'off',
    notice: hasTrace ? LOCATION_LOST : LOCATION_OFF,
  });
}

function watchLocation() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    routesStore.set({ locationState: 'off', notice: LOCATION_OFF });
    return;
  }
  try {
    recorder.watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 30000,
    });
  } catch {
    routesStore.set({ locationState: 'off', notice: LOCATION_OFF });
  }
}

/** Send what has not been sent. Idempotent server-side, so a re-send is safe. */
async function flushPoints() {
  const id = recorder.runId;
  if (!id || recorder.pending.length === 0) return;
  const batch = recorder.pending;
  recorder.pending = [];
  try {
    await appendPoints(id, batch, demoQuery());
  } catch {
    // Keep them: the next flush sends them again, and the append lands on
    // the same rows because (route_id, seq) is unique.
    recorder.pending = batch.concat(recorder.pending);
  }
}

async function startRecording() {
  const demo = demoQuery();
  const location = await resolveLocation();
  if (location.reloading) {
    // The frame is about to reload to apply the grant. Starting now would
    // start a run into a document that is going away.
    routesStore.set({ locationState: 'off', notice: LOCATION_OFF });
    return;
  }
  routesStore.set({ notice: location.state === 'off' ? LOCATION_OFF : null, locationState: location.state });
  let run: RunRow;
  try {
    run = await startRun(demo);
  } catch {
    routesStore.set({ notice: 'Could not start the run. Try again.' });
    return;
  }
  resetRecorder();
  recorder.runId = run.id;
  recorder.startedAt = Date.now();
  routesStore.set({
    recording: true,
    runId: run.id,
    elapsed: 0,
    liveMeters: 0,
    saving: false,
    notice: location.state === 'off' ? LOCATION_OFF : null,
  });
  recorder.tick = setInterval(() => {
    if (!recorder.runId) return;
    routesStore.set({ elapsed: Math.max(0, Math.round((Date.now() - recorder.startedAt) / 1000)) });
  }, 1000);
  recorder.flush = setInterval(() => void flushPoints(), 10000);
  watchLocation();
  void acquireWakeLock();
}

async function finishRecording() {
  const id = recorder.runId;
  if (!id) return;
  routesStore.set({ saving: true });
  // The watch stops first so no fix lands after the sum, then the buffer is
  // flushed so the server's own sum is over everything that was recorded.
  stopWatch();
  stopTimers();
  await flushPoints();
  try {
    const run = await finishRun(id, demoQuery());
    resetRecorder();
    routesStore.set({
      recording: false, runId: null, saving: false, elapsed: 0, liveMeters: 0,
      notice: null, locationState: 'unknown',
    });
    routesController.route(run.id);
    await routesController.reload();
  } catch {
    routesStore.set({ saving: false, notice: 'Could not save the run. Try again.' });
  }
}

// ── The list ────────────────────────────────────────────────────────────

function RowSkeletons(): ReactNode {
  return (
    <SkeletonGroup label="Loading your runs">
      {[0, 1, 2].map((i) => (
        <ListRow
          key={i}
          chevron={false}
          leading={<Skeleton shape="block" className="w-11 h-11 rounded-xl" />}
          title={<Skeleton className="max-w-[40%]" />}
          subtitle={<Skeleton className="max-w-[30%]" />}
        />
      ))}
    </SkeletonGroup>
  );
}

/**
 * The nothing-yet card. It offers the primary action in words rather than
 * repeating the button, and it ships `hidden` inside the list so the id and
 * the class stay on one element (a declared check selects
 * `#routes-empty.hidden` to prove the card is gone once there are rows).
 * A `div`, never an anchor: a row check selects `a[data-run-row]` and
 * `:first-of-type` is structural, so an anchor here would steal it.
 */
function EmptyCard({ show }: { show: boolean }): ReactNode {
  // `hidden` is RENDERED, and the id travels with it, so the declared check
  // `#routes-empty.hidden` reads exactly one meaning: the list has answered
  // and there is nothing in it. A load still in flight is the skeletons, and
  // the card is hidden then too, which is why `show` is passed rather than
  // inferred from the rows alone.
  return (
    <div id="routes-empty" className={show ? '' : 'hidden'} data-routes-empty="1">
      <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
        <IconTile size="sm" className="mb-1"><MapPinIcon /></IconTile>
        <p className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">{EMPTY_TITLE}</p>
        <p className="max-w-xs text-sm text-zinc-500 dark:text-zinc-400">{EMPTY_HINT}</p>
      </div>
    </div>
  );
}

function RunRowItem({ run }: { run: RunRow }) {
  return (
    <ListRow
      as="a"
      id={`routes-row-${run.id}`}
      href={`#routes/${run.id}`}
      data-run-row={run.id}
      leading={<IconTile size="sm"><MapPinIcon /></IconTile>}
      title={rowTitle(run)}
      subtitle={rowSubtitle(run)}
    />
  );
}

// ── The run's own page ──────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-[0.9375rem] font-[650] text-zinc-900 dark:text-zinc-100">{value}</div>
    </div>
  );
}

function RunDetail({ state }: { state: Record<string, any> }) {
  const run = state.detail as RunRow | null;
  const points = (state.detailPoints || []) as RoutePoint[];
  if (state.detailError) {
    return (
      <div className="px-4 pt-5">
        <div role="alert" className="rounded-[20px] px-6 py-8 text-center">
          <p className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">Could not open this run</p>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Check your connection and try again.</p>
          <Button type="button" variant="pillAccent" size="pill" className="mt-3" onClick={() => routesController.reload()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="px-4 pt-5">
        <SkeletonGroup label="Loading the run">
          <Skeleton shape="block" className="h-56 w-full rounded-[20px] sm:h-72" />
          <Skeleton className="mt-4 max-w-[40%]" />
        </SkeletonGroup>
      </div>
    );
  }
  return (
    <div data-run-detail={run.id}>
      <div className="px-4 pt-5 pb-3">
        <h2 className="text-[1.0625rem] font-[650] text-zinc-900 dark:text-zinc-100">{rowTitle(run)}</h2>
      </div>
      <RouteMap points={points} />
      {!run.has_location ? (
        <p className="px-4 pt-2 text-sm text-zinc-500 dark:text-zinc-400">{NO_MAP_LINE}</p>
      ) : null}
      <GroupedList id="routes-stats" className="mt-4" tone="plane">
        <div className="grid grid-cols-3 divide-x divide-zinc-200 dark:divide-zinc-800">
          <Stat label="Distance" value={run.has_location ? formatDistance(run.distance_meters) : 'Not recorded'} />
          <Stat label="Time" value={formatDuration(run.duration_seconds)} />
          <Stat label="Recorded" value={messageStamp(run.finished_at || run.started_at).title} />
        </div>
      </GroupedList>
      <div className="px-4 pt-4">
        <Button
          id="routes-delete"
          type="button"
          variant="pillDanger"
          ink="dangerTint"
          layout="full"
          size="pill"
          disabled={!!state.demo}
          onClick={() => void routesController.remove(run.id)}
        >
          Delete this run
        </Button>
        {state.demo ? (
          <p className="pt-2 text-center text-[0.8125rem] text-zinc-500 dark:text-zinc-400">
            This is a staging demo run. It is not yours and cannot be changed.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ── The screen ──────────────────────────────────────────────────────────

export function RoutesScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  const state = useStoreState(routesStore) as unknown as Record<string, any>;
  useVisibilityHiddenClass(screenRef, 'routes-screen', false);
  const runs = state.runs as RunRow[] | null;
  // The empty card's own `hidden` is published by the controller, not
  // derived here: a load in flight is NOT the empty state, and the id and
  // the class have to stay on one element for the declared check.
  const empty = !!runs && runs.length === 0 && !state.error && !state.detailId;
  return (
    <main
      ref={screenRef}
      id="routes-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: 'relative' }}
    >
      <div className="max-w-2xl mx-auto pb-8">
        {state.detailId ? <RunDetail state={state} /> : (
          <>
            {/* The privacy line leads, under the header, because it is the
                feature's hard rule and not a footnote: there is no setting
                behind it and no way to make a run public. */}
            <p id="routes-privacy" className="px-4 pt-5 text-sm text-zinc-500 dark:text-zinc-400">
              {PRIVACY_LINE}
            </p>
            {/* ONE PRIMARY ACTION. It is a `Button` from the shell's own
                primitive in both of its states, so the stop treatment is the
                kit's pillDanger rather than a hand-written red. */}
            <div className="px-4 pt-3">
              <Button
                id="routes-record-btn"
                type="button"
                data-routes-record={state.recording ? 'finish' : 'start'}
                variant={state.recording ? 'pillDanger' : 'pillAccent'}
                ink={state.recording ? 'dangerTint' : 'solid'}
                layout="full"
                size="pillLg"
                disabled={!!state.saving}
                className="inline-flex items-center justify-center gap-2"
                onClick={() => void (state.recording ? finishRecording() : startRecording())}
              >
                {state.recording ? (
                  <span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" />
                ) : (
                  <PlayIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                )}
                {state.recording ? 'Finish run' : 'Start run'}
              </Button>
            </div>
            {state.recording ? (
              <p
                id="routes-live"
                data-routes-live={state.locationState}
                className="px-4 pt-3 text-center text-[0.9375rem] font-[650] tabular-nums text-zinc-900 dark:text-zinc-100"
              >
                {liveLine(state.elapsed as number, state.liveMeters as number, state.locationState)}
              </p>
            ) : null}
            {/* The honest degradation, in the spec's own words, drawn
                whenever there is no location — never a silent failure. */}
            {state.notice ? (
              <p
                id="routes-location-note"
                role="status"
                className="px-4 pt-3 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400"
              >
                <ClockIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{state.notice}</span>
              </p>
            ) : null}
            <SectionHeader>Your runs</SectionHeader>
            {state.error ? (
              <div role="alert" className="px-6 py-8 text-center">
                <p className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">Could not load your runs</p>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Check your connection and try again.</p>
                <Button type="button" variant="pillAccent" size="pill" className="mt-3" onClick={() => void routesController.reload()}>
                  Try again
                </Button>
              </div>
            ) : (
              <GroupedList id="routes-list" tone="plane">
                <EmptyCard show={empty} />
                {runs === null ? <RowSkeletons /> : runs.map((run) => <RunRowItem key={run.id} run={run} />)}
              </GroupedList>
            )}
          </>
        )}
      </div>
      {/* `empty` is read by the controller to publish the card's `hidden`,
          the same way #workshop-empty keeps one meaning: the card is the
          list's own nothing-yet state and a load in flight is not it. */}
    </main>
  );
}

// ── The legacy seam ─────────────────────────────────────────────────────

/**
 * The same shape as `window.UsernodeReact.workshop`. `App.navigateToRoutes()`
 * calls `open()` on the still-hidden root and `_exitRoutes` calls `close()`
 * on the way out; `open` is the liveness flag a load checks before it
 * publishes, so a fetch that lands after the viewer has left cannot paint
 * rows into a screen they are no longer on.
 */
export const routesController = {
  open() {
    routesStore.set({ open: true });
    return routesController.reload();
  },
  close() {
    routesStore.set({ open: false, detailId: null, detail: null, detailPoints: null, detailError: false });
  },
  isOpen() {
    return !!routesStore.get().open;
  },
  /** Show one run's page, or the list when `id` is null. */
  route(id: number | null) {
    const next = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
    const state = routesStore.get();
    if (state.detailId === next) {
      // Same address: a re-entry (a hash echo, a Back onto this page) must
      // not throw the trace away and re-fetch it.
      if (next === null || state.detail || state.detailLoading) return Promise.resolve();
    }
    routesStore.set({
      detailId: next, detail: null, detailPoints: null, detailError: false,
      detailLoading: next !== null,
    });
    if (next === null) return Promise.resolve();
    return routesController.loadDetail(next);
  },
  async loadDetail(id: number) {
    try {
      const { run, points } = await fetchRun(id, demoQuery());
      if (!routesStore.get().open || routesStore.get().detailId !== id) return;
      routesStore.set({ detail: run, detailPoints: points, detailLoading: false, detailError: false });
    } catch (err) {
      if (!routesStore.get().open || routesStore.get().detailId !== id) return;
      routesStore.set({ detailLoading: false, detailError: true });
    }
  },
  /** Delete the run on screen, after asking. */
  async remove(id: number) {
    const ok = await confirmAction({
      title: 'Delete this run?',
      message: 'The path and its times are removed for good.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteRun(id, demoQuery());
    } catch {
      routesStore.set({ notice: 'Could not delete the run. Try again.' });
      return;
    }
    routesStore.set({ detailId: null, detail: null, detailPoints: null, detailError: false });
    try { if (location.hash.startsWith('#routes/')) location.hash = '#routes'; } catch { /* ignore */ }
    await routesController.reload();
  },
  /** Re-read the list. The detail read is separate: the two are different pages. */
  async reload() {
    const demo = demoQuery();
    routesStore.set({ error: false });
    let runs: RunRow[] | null = null;
    try {
      runs = await fetchRuns(demo);
    } catch {
      // Offline is a state, not a crash: the error card offers the same load
      // again rather than a page reload.
    }
    if (!routesStore.get().open) return;
    if (!runs) {
      routesStore.set({ error: true });
      return;
    }
    routesStore.set({ runs, error: false, demo: runs.some((run) => !!run.label) });
  },
};

if (typeof window !== 'undefined') {
  const host = (window as unknown as { UsernodeReact?: Record<string, unknown> });
  const bridgeHost = (host.UsernodeReact ||= {});
  bridgeHost.routes = routesController;
}

// Published so the declared checks can deep-link a seeded fixture without a
// second copy of its id, and so tests read one constant.
export { DEMO_RUN_ID, ACCURACY_LIMIT_M };
export { routesStore };
