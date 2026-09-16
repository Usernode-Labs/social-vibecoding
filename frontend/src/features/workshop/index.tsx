/**
 * `#workshop-screen` — the Workshop across all of your apps.
 *
 * ── What it is for ─────────────────────────────────────────────────────
 *
 * Every app has a Workshop page: its Dev lander, which opens on "What you
 * are working on" and carries a "Needs you" tab beside it
 * (features/dev-board/workshop/workshop.tsx). That page answers "what is
 * happening in THIS app", and it is the right page — but the question a
 * person actually arrives with is one level up: WHICH of my apps wants
 * something from me right now. Answering it meant opening each app's
 * Workshop in turn, which is how a good screen becomes a chore.
 *
 * So this is the same two numbers, once per app, on one screen. A row says
 * how many items that app's own Workshop holds for you, and tapping it goes
 * to that Workshop — the existing page, not a copy of it. The header's back
 * control then points back here (see App.navigateToWorkshop and
 * `App._appBackHref` in public/js/app.js), so the two screens read as one
 * level and its drill-in rather than as two places that happen to link.
 *
 * ── Where the numbers come from ────────────────────────────────────────
 *
 * GET /api/workshop/counts (src/routes/workshop-overview.js), which answers
 * for every app in one query. NOT the board's own load: that is eight
 * requests per app, and at forty apps it is not a page. Its module header
 * documents the two populations and the one thing the "needs you" number
 * leaves out — the unclaimed GitHub issues at the tail of that deck, which
 * are not in Postgres — which is why this screen's own legend says "votes
 * waiting" rather than claiming the whole tab.
 *
 * The APP LIST is a second read, and deliberately a different one:
 * GET /api/apps plus `Home.partitionApps(...).yours`, exactly as the app
 * chip's menu composes its strip (features/app-context/app-context-sheet.tsx).
 * "Which apps are mine" is a decision the platform already makes once, and a
 * count endpoint that re-answered it in SQL would be a second copy of it that
 * could drift. The counts arrive keyed by slug and are joined onto those rows
 * here; a slug the endpoint said nothing about is two zeroes.
 *
 * ── The island rules it keeps ──────────────────────────────────────────
 *
 * Nothing in `public/js/**` writes inside this root, so the region may hold
 * state. Its FIRST render is the shipped document — `hidden`, an empty list,
 * no rows — and both fetches run from `open()`, never during render. Screen
 * visibility is the shell's store (`#workshop-screen` is in
 * App.REACT_SCREEN_IDS) and the root's `className` is a constant, so the
 * class has exactly one owner.
 */

import { useRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { ChevronRightIcon, HandRaisedIcon, SpeechCheckIcon } from '@/components/ui/icons';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { AppsLoadError } from '../apps/load-error';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { workshopStore } from './workshop-store.js';

// The legacy router reads the DOM on the line after it routes — the ?shot=
// capture fixtures assert the revealed screen inside the same task — so the
// store's notification has to land synchronously. Same install, same reason,
// as features/header/mount.ts.
workshopStore.setFlush(flushSync);

type WorkshopRow = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  working: number;
  needs: number;
};

type Counts = Record<string, { working?: number; needs?: number } | undefined>;

/** The demo flag the board's own fetches forward, in the same spelling. */
function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/**
 * The viewer's apps with their two counts, newest question first.
 *
 * Exported and pure so tests can drive the ordering without a fetch. The
 * order is the argument this screen makes: an app that needs a decision from
 * you outranks one where you have work of your own outstanding, which
 * outranks a quiet one — and inside each band the platform's own "Your apps"
 * order (favourite order, then activity) is preserved, because `sort` is
 * stable and this comparator answers 0 for two rows in the same band.
 */
export function orderRows(apps: WorkshopRow[]): WorkshopRow[] {
  const band = (row: WorkshopRow) => (row.needs > 0 ? 0 : (row.working > 0 ? 1 : 2));
  return apps.slice().sort((a, b) => band(a) - band(b));
}

/** Join a counts map onto the app rows. A slug with no entry is two zeroes. */
export function joinCounts(apps: Array<Omit<WorkshopRow, 'working' | 'needs'>>, counts: Counts): WorkshopRow[] {
  return apps.map((app) => {
    const found = counts[app.slug];
    return {
      ...app,
      working: Number(found?.working) || 0,
      needs: Number(found?.needs) || 0,
    };
  });
}

/**
 * One number with its glyph.
 *
 * TINTED ONLY WHEN IT IS NOT ZERO. A row of grey zeroes is the common case on
 * a big account, and painting those in the accent would make every app look
 * like it was asking for something. The glyphs are the ones the app's own
 * Workshop uses for the same two things — the raised hand for your own work,
 * the bubble-with-a-tick for the Needs-you deck — so the number here and the
 * pane it counts wear the same mark.
 */
function Count({ kind, n, label }: { kind: 'working' | 'needs'; n: number; label: string }) {
  const lit = n > 0;
  const tint = kind === 'needs'
    ? 'text-violet-700 dark:text-violet-300 bg-violet-500/10'
    : 'text-zinc-700 dark:text-zinc-200 bg-zinc-500/10';
  return (
    <span
      {...{ [`data-workshop-${kind}`]: String(n) }}
      // ONE accessible name, not a glyph plus a bare digit. The pill reads
      // "2 items you are working on" to a screen reader and carries the same
      // sentence as its pointer tooltip; the glyph is decoration, which is
      // what a legend a thumb cannot hover is for.
      aria-label={`${n} ${label}`}
      title={`${n} ${label}`}
      className={'shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 '
        + 'text-xs font-semibold tabular-nums '
        + (lit ? tint : 'text-zinc-400 dark:text-zinc-500')}
    >
      {kind === 'needs'
        ? <SpeechCheckIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        : <HandRaisedIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
      {n}
    </span>
  );
}

/**
 * One app.
 *
 * An ANCHOR to the app's own Workshop path, for the reason every navigation
 * control in this shell is one: cmd/ctrl-click, middle-click and "open in new
 * tab" all have to work. `/app/<slug>/workshop` is App._appUrl's own spelling
 * for that page (`boardView: 'workshop'`), so a copied address restores the
 * same screen cold. A plain primary click routes in place through
 * `App.navigateToApp`, which is also what records the back breadcrumb — it
 * reads `App._inWorkshop`, so the arrow appears because the visit came from
 * here rather than because this row asked for it. A modified click never
 * reaches the handler at all: the browser handles it natively, which is the
 * whole reason this is an anchor.
 */
function AppRow({ row }: { row: WorkshopRow }) {
  const label = row.name || row.slug;
  return (
    <a
      href={`/app/${encodeURIComponent(row.slug)}/workshop`}
      data-workshop-app={row.slug}
      className="flex items-center gap-3 px-4 py-3 min-h-[56px] hover:bg-zinc-500/5 transition-colors"
      onClick={(event) => {
        const win = window as any;
        if (win.NavLink?.isNativeClick?.(event)) return;
        event.preventDefault();
        win.App?.navigateToApp?.(row.slug, 'dev');
      }}
    >
      <span
        data-icon={appIconKind(row as any)}
        className={'app-icon-tile w-10 h-10 shrink-0 rounded-xl overflow-hidden '
          + 'flex items-center justify-center text-base font-bold'}
      >
        <AppIconContent app={row as any} />
      </span>
      <span className="min-w-0 flex-1 text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
        {label}
      </span>
      <Count kind="working" n={row.working} label="items you are working on" />
      <Count kind="needs" n={row.needs} label="votes waiting on you" />
      <ChevronRightIcon
        className="w-4 h-4 shrink-0 text-zinc-300 dark:text-zinc-600"
        aria-hidden="true"
      />
    </a>
  );
}

/** Four rows of the real geometry, so the list does not change shape on load. */
function RowSkeletons(): ReactNode {
  return (
    <SkeletonGroup label="Loading your apps">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 min-h-[56px]">
          <Skeleton shape="block" className="w-10 h-10 rounded-xl" />
          <Skeleton className="flex-1 max-w-[40%]" />
          <Skeleton shape="block" className="w-10 h-5 rounded-full" />
          <Skeleton shape="block" className="w-10 h-5 rounded-full" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

export function WorkshopScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  const state = useStoreState(workshopStore) as {
    open: boolean; rows: WorkshopRow[] | null; error: boolean;
  };
  useVisibilityHiddenClass(screenRef, 'workshop-screen', false);
  const rows = state.rows ? orderRows(state.rows) : null;

  return (
    <main
      ref={screenRef}
      id="workshop-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: 'relative' }}
    >
      <div className="max-w-2xl mx-auto p-3 sm:p-4">
        {/* ONE PANE, head and body, the shape the Workshop's own panes have:
            an eyebrow saying what the list is, the legend saying what the two
            columns mean, and the rows under it. The legend is not decoration
            — two bare numbers on a row are unreadable without it, and a
            tooltip is not available to a thumb. */}
        <section
          className={'rounded-[22px] overflow-hidden bg-white/80 dark:bg-zinc-900/80 '
            + 'ring-1 ring-zinc-900/5 dark:ring-white/10 backdrop-blur-xl'}
        >
          <div className="px-4 pt-4 pb-3">
            <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              Your apps
            </span>
            <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="inline-flex items-center gap-1">
                <HandRaisedIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                You are working on
              </span>
              <span className="inline-flex items-center gap-1">
                <SpeechCheckIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                Votes waiting on you
              </span>
            </p>
          </div>
          <div
            id="workshop-list"
            className={'border-t border-zinc-900/5 dark:border-white/10 '
              + 'divide-y divide-zinc-900/5 dark:divide-white/10'}
          >
            {state.error
              ? (
                <AppsLoadError
                  title="Couldn't load your workshop"
                  onRetry={() => { void workshopController.reload(); }}
                />
              )
              : rows === null
                ? <RowSkeletons />
                : rows.map((row) => <AppRow key={row.slug} row={row} />)}
          </div>
          {/* The nothing-to-show line, drawn only once the list has answered
              that there really is nothing — never while it is still loading,
              which is the state the skeletons above are for. */}
          <p
            id="workshop-empty"
            className={(rows && rows.length === 0 && !state.error ? '' : 'hidden ')
              + 'px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400'}
          >
            You have no apps yet. Discover finds the ones you can join.
          </p>
        </section>
      </div>
    </main>
  );
}

/**
 * The legacy seam, the same shape as `window.UsernodeReact.messages`.
 *
 * `App.navigateToWorkshop()` calls `open()` on the still-hidden root and
 * `_exitWorkshop` calls `close()` on the way out. `open` is not decoration:
 * it is the LIVENESS flag a load checks before it publishes, so a fetch that
 * lands after the viewer has left cannot paint rows into a screen they are no
 * longer on — and cannot race the next entry's own load. The re-entry guard
 * is the router's (see App.navigateToWorkshop), not this flag's, for the
 * reason its note gives.
 *
 * Both reads are fired together and the counts are tolerated as missing: an
 * app list with no numbers is a usable launcher, a screen that refuses to
 * draw because one of two requests failed is not. Losing the LIST is the
 * error card, because there is then nothing to draw.
 */
export const workshopController = {
  open() {
    workshopStore.set({ open: true });
    return workshopController.reload();
  },
  close() {
    workshopStore.set({ open: false });
  },
  isOpen() {
    return workshopStore.get().open;
  },
  async reload() {
    const demo = demoQuery();
    workshopStore.set({ error: false });
    let apps: Array<Omit<WorkshopRow, 'working' | 'needs'>> | null = null;
    let counts: Counts = {};
    try {
      const [appsRes, countsRes] = await Promise.all([
        fetch(`/api/apps${demo}`),
        fetch(`/api/workshop/counts${demo}`).catch(() => null),
      ]);
      if (appsRes.ok) {
        const data = await appsRes.json();
        const home = (window as any).Home;
        apps = home?.partitionApps
          ? home.partitionApps(data.apps || []).yours
          : (data.apps || []);
      }
      if (countsRes && countsRes.ok) {
        const data = await countsRes.json().catch(() => null);
        if (data && data.counts && typeof data.counts === 'object') counts = data.counts;
      }
    } catch {
      // Offline is a state, not a crash: fall through to the error card,
      // which offers the same load again rather than a page reload.
    }
    // Left the screen while this was in flight: say nothing. The rows are
    // kept as they were, so a re-entry paints the last list at once and
    // refreshes under it — the app strip in the chip's menu takes the same
    // view of a stale answer.
    if (!workshopStore.get().open) return;
    if (!apps) {
      workshopStore.set({ error: true });
      return;
    }
    workshopStore.set({ rows: joinCounts(apps, counts), error: false });
  },
};

if (typeof window !== 'undefined') {
  const host = (window as unknown as { UsernodeReact?: Record<string, unknown> });
  const bridge = (host.UsernodeReact ||= {});
  bridge.workshop = workshopController;
}

export { workshopStore };
