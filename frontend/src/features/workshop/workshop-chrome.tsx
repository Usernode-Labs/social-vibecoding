/**
 * The Workshop's scope chip and the panel behind it (#2718, #2759, #2768,
 * #3051, #3295).
 *
 * ── Where it lives now ────────────────────────────────────────────────
 *
 * On BOTH ends of the Workshop again. On ONE APP's Workshop the header's
 * title is the chip (#3295, below): it says which app's Workshop you are in
 * and its panel offers the others, and All apps, which is the way back up to
 * the all-apps Workshop screen.
 *
 * #2759 took it off that all-apps screen: the screen was then a flat list of
 * your apps, so a chip whose panel was the same list again said one fact
 * twice. #3051 (the owner's request) brings it back as "All apps", because
 * the screen is no longer only that list: it has the app Workshop's own two
 * tabs, Current status and Needs you, read across every one of your apps, and
 * the chip is what says the tabs are about all of them rather than one. Its
 * panel is the same panel, with All apps ticked (`AllAppsScope` below).
 *
 * ── On an app's Workshop the control is the header's (#2768, #3295) ───
 *
 * The HEADER's icon and name open the panel
 * (features/header/header-title.tsx) — the header already names the app, so a
 * chip under it naming it again spent a row on nothing. A phone lost that chip
 * first (#2768); a desktop kept it, above the tabs or beside them on a wide
 * window (#2837), until the owner asked for it in the header there too
 * (#3295). So on an app's Workshop this file renders the PANEL only, at the
 * top of the page, right under the header that opened it. The open flag is
 * ./app-scope-store.js because the header is another React root.
 *
 * ── Why the panel expands IN PLACE rather than presenting ─────────────
 *
 * The panel is an ordinary child of the page. Not a sheet, not a dialog and
 * not an anchored panel, and that is a deliberate three-way no:
 *
 *   - A kit sheet needs a root in the prerendered document to adopt, an id in
 *     the shell's frozen inventory and a controller with a dismiss contract —
 *     all of it to show a list of your own apps.
 *   - @/components/ui/anchored-panel is fixed to the window's top-right
 *     corner, which is where the bell's panel goes and nowhere near a chip
 *     sitting in the page.
 *   - A popover would unmount while closed, and the first render has to be
 *     the chip alone.
 *
 * Expanding in place costs none of that: the Workshop mounts client-side into
 * a legacy host, nothing in public/js/** writes inside it, and a panel that
 * renders only once somebody has tapped is a panel no prerender ever sees.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import {
  CheckIcon, ChevronDownIcon, Squares2X2Icon,
} from '@/components/ui/icons';

import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { SectionHeader } from '@/components/ui/grouped-list';
import { focusFirstItem, roveMenuFocus } from '../../lib/menu-keys';
import { useStoreState } from '../../lib/use-store-state';
import { APP_SCOPE_PANEL_ID, appScopeStore } from './app-scope-store.js';
import {
  groupRows, SECTION_LIMIT, sectionFold, type WorkshopRow,
} from './grouping.js';

type PickerApp = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  audience?: string;
  member_count?: number;
  last_active_at?: string | null;
  demo?: boolean;
};

const win = () => window as unknown as {
  App?: { navigateToApp?: (slug: string, tab?: string) => Promise<unknown> | void };
};

/**
 * Go to `slug`'s own Workshop.
 *
 * It took a MODE too, while the plus's two action rows landed here: the await
 * was load-bearing there, because `navigateToApp` resolves once the Improve
 * controller knows what the app view is about and calling `startSession()`
 * before that would start a change on whatever app the panel was last pointed
 * at. The scope chip is the only caller left and there is nothing after the
 * navigation — but the await stays, so a refused navigation cannot look like
 * a completed one.
 */
async function goToApp(slug: string): Promise<void> {
  appScopeStore.set({ open: false });
  try {
    await win().App?.navigateToApp?.(slug, 'dev');
  } catch {
    // A navigation that failed has already told the viewer. The panel is
    // closed either way, which is the state this screen wants.
  }
}

/**
 * Up to the all-apps Workshop screen.
 *
 * A HASH ASSIGNMENT, not a call into App: this is the same address the rail's
 * Workshop tab carries, so the two ways of getting there are one route and
 * the browser's own history records it.
 */
function goToAllApps(): void {
  appScopeStore.set({ open: false });
  window.location.hash = '#communities';
}

const CHIP = 'inline-flex items-center gap-2 max-w-full h-9 pl-2 pr-2.5 rounded-full '
  + 'un-touch-target font-semibold text-sm disabled:opacity-60 '
  + 'border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)] '
  + 'text-[color:var(--brand-ink)]';

/**
 * "(icon) App name ⌄" — which app's Workshop this is, and the list behind it.
 *
 * `scope: null` is the all-apps end (#3051): the grid glyph the panel's own
 * All row wears, and the word "All" (#3277: the owner's call; the grid and
 * the list under it already say all of what). It is never disabled, because
 * there is always somewhere to go: another app, or back up to all of them.
 */
export function WorkshopScope({ open, id, scope, onToggle }: {
  open: boolean;
  id: string;
  /** The app this Workshop is showing, or null for all of your apps. */
  scope: PickerApp | null;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      className={CHIP}
      aria-haspopup="menu"
      aria-expanded={open ? 'true' : 'false'}
      aria-controls={`${id}-picker`}
      aria-label={scope ? undefined : 'All your projects, or open one'}
      onClick={() => onToggle(!open)}
    >
      {scope ? (
        <span
          aria-hidden="true"
          className="app-icon-tile shrink-0 w-6 h-6 rounded-lg overflow-hidden flex items-center justify-center text-xs font-bold"
          data-icon={appIconKind(scope as never)}
        >
          <AppIconContent app={scope as never} />
        </span>
      ) : (
        <Squares2X2Icon className="w-5 h-5 shrink-0 ml-0.5" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate">{scope ? (scope.name || scope.slug) : 'All'}</span>
      <ChevronDownIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
    </button>
  );
}

const ROW = 'w-full flex items-center gap-3 px-4 min-h-[44px] py-2 text-left text-sm '
  + 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';

function PanelRow({ id, leading, title, detail, trailing, onClick }: {
  id?: string;
  leading?: ReactNode;
  title: string;
  detail?: string;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button id={id} type="button" role="menuitem" className={ROW} onClick={onClick}>
      <span
        className="shrink-0 flex items-center justify-center w-8 h-8 text-zinc-500 dark:text-zinc-400"
        aria-hidden="true"
      >
        {leading}
      </span>
      <span className="min-w-0 flex-1 flex flex-col">
        <span className="truncate font-medium">{title}</span>
        {detail
          ? <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{detail}</span>
          : null}
      </span>
      {trailing}
    </button>
  );
}

/**
 * One section of the all-apps panel: its label with the count of the whole
 * group, its most recent rows, and the fold row that extends it.
 *
 * The same shape the Workshop screen's `Section` draws, dressed for the
 * menu: the label is the screen's own `SectionHeader` (small caps, with the
 * count of the whole section on its right), and the fold is a `PanelRow` —
 * the panel's row is a button with `role="menuitem"`, so the arrows and the
 * Escape contract the panel already carries (QA 2026-09-24 Q18) reach the
 * rows it reveals.
 */
function PickerSection({ label, rows, scope, onClose }: {
  label: string;
  rows: WorkshopRow[];
  scope: PickerApp | null;
  onClose: () => void;
}) {
  const [limit, setLimit] = useState(SECTION_LIMIT);
  const fold = sectionFold(rows.length, limit);
  const shown = rows.slice(0, fold.shown);
  return (
    <>
      {/* Tighter than the screen's `pt-6`, which separates a section from a
          whole page above it; inside the panel the header follows a row. */}
      <SectionHeader className="flex items-center gap-1.5 pt-2">
        <span>{label}</span>
        <span className="ml-auto tabular-nums" aria-label={`${rows.length} in ${label}`}>{rows.length}</span>
      </SectionHeader>
      {shown.map((app) => (
        <PanelRow
          key={app.slug}
          leading={(
            <span
              data-icon={appIconKind(app as never)}
              className="app-icon-tile w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center text-sm font-bold"
            >
              <AppIconContent app={app as never} />
            </span>
          )}
          title={app.name || app.slug}
          trailing={scope?.slug === app.slug
            ? <CheckIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
            : undefined}
          onClick={() => {
            onClose();
            if (scope?.slug === app.slug) return;
            void goToApp(app.slug);
          }}
        />
      ))}
      {rows.length > SECTION_LIMIT ? (
        <PanelRow
          title={fold.label || ''}
          onClick={() => setLimit(fold.next)}
        />
      ) : null}
    </>
  );
}

/**
 * The scope chip's panel: which workshop you are looking at.
 *
 * All apps first, then each of your apps, the one on screen carrying the
 * tick. On the all-apps screen (`scope: null`) the tick is on All apps and
 * that row only closes the panel, for the reason an app's own row does below.
 *
 * #3363: THE ALL-APPS PANEL MATCHES THE COMMUNITIES SCREEN's LIST. The same
 * grouping module the screen draws (`./grouping.ts`) splits the rows into
 * Public communities / Private communities / Just you, most recently active
 * first, and each section shows three with a "Show N more" fold row that
 * reveals five a press and folds back to "Show fewer" — the screen's own
 * rhythm, copied so the menu and the page agree about what "all" means.
 * The panel inside ONE app's Workshop stays flat: there the panel is the
 * way into another app, not a survey of all of them.
 */
export function WorkshopPicker({ apps, id, scope, onClose, panelRef }: {
  apps: PickerApp[] | null;
  id: string;
  /** The app this Workshop is showing, or null for all of your apps. */
  scope: PickerApp | null;
  onClose: () => void;
  /** The panel's root, for the keyboard handling in AppWorkshopScope. */
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  const rows = apps || [];
  const sections = scope === null ? groupRows(rows as WorkshopRow[]) : null;

  return (
    <div
      id={id}
      ref={panelRef}
      role="menu"
      aria-label="Which project?"
      className={'mx-4 mb-3 rounded-2xl overflow-hidden bg-white dark:bg-zinc-900 '
        + 'border border-zinc-200 dark:border-zinc-800'}
      // The arrows, Home and End move between the rows (QA 2026-09-24 Q18).
      // Tab is left alone: the panel expands in place, so Tab moving on
      // through the page is where it should go.
      onKeyDown={(event) => { roveMenuFocus(event, event.currentTarget); }}
    >
      <p className="px-4 pt-3 pb-2 flex flex-col">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Which project?</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">All your projects, or one of them.</span>
      </p>
      {/* ALL APPS IS THE WAY BACK UP — and the reason the app's Workshop
          needs no back arrow beyond the rail's own Workshop tab. */}
      <PanelRow
        id={`${id}-all`}
        leading={<Squares2X2Icon className="w-5 h-5" />}
        title="All"
        trailing={scope === null
          ? <CheckIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
          : undefined}
        onClick={() => {
          onClose();
          if (scope === null) return;
          goToAllApps();
        }}
      />
      {sections ? (
        sections.map((section) => (
          <PickerSection
            key={section.key}
            label={section.label}
            rows={section.rows}
            scope={scope}
            onClose={onClose}
          />
        ))
      ) : rows.map((app) => (
        <PanelRow
          key={app.slug}
          leading={(
            <span
              data-icon={appIconKind(app as never)}
              className="app-icon-tile w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center text-sm font-bold"
            >
              <AppIconContent app={app as never} />
            </span>
          )}
          title={app.name || app.slug}
          trailing={scope?.slug === app.slug
            ? <CheckIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
            : undefined}
          // THE APP YOU ARE ALREADY IN closes the panel and goes nowhere. A
          // row that re-navigates to the current route would throw this
          // screen's scroll position and its open windows away to arrive
          // where it started.
          onClick={() => {
            onClose();
            if (scope?.slug === app.slug) return;
            void goToApp(app.slug);
          }}
        />
      ))}
    </div>
  );
}


/* ════════════════════════════════════════════════════════════════════
   THE PANEL ON THE APP'S OWN WORKSHOP (#2718 review, #2768, #3295)
   ════════════════════════════════════════════════════════════════════

   "The workshop view, when clicked into an app, should preserve the app
   switcher, and should preserve the side bar."

   Picking an app NAVIGATES rather than filtering: one app's Workshop is its
   own screen inside that app, where its board, sessions and discussion
   already live. The rail stays up (App._syncPlatformTabs) with the Workshop
   tab lit, and the header's icon and name say which app you are in and are
   the way to another, at every width (#3295). There is no chip here any
   more: until #3295 a desktop drew one above the tabs, or beside them on a
   wide window (#2837), and hid it on a phone.

   ── Its open state is a store ────────────────────────────────────────

   ./app-scope-store.js, because the control that opens this panel is in the
   header, which is another React root. The flag is closed again whenever the
   app on screen changes or the Workshop unmounts, so a panel left open is
   never waiting on the next visit.

   ── And its own fetch ────────────────────────────────────────────────

   GET /api/apps, filtered by Home.isJoined exactly as the all-communities
   screen does — "which communities am I in" is a decision the platform
   already makes once (services/communities.js). It runs in an effect and
   never during render, on mount rather than on open, so the list is usually
   there by the time the header's control is pressed.
*/

/** The demo flag every board fetch forwards, in the same spelling. */
function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/**
 * Keyboard and outside presses for a scope panel (QA 2026-09-24 Q18).
 *
 * The panel only closed through its own chip (or a row). Now opening moves
 * focus to its first row, Escape closes it and puts focus back on whichever
 * control opened it (the chip, or on an app's Workshop the header's title)
 * and a press anywhere outside the panel and those controls closes it too.
 * The controls are found by the `aria-controls` they carry, and are spared
 * the outside press because their own click toggles.
 *
 * One hook for both ends of the chip (#3051): the app's Workshop and the
 * all-apps screen close their panels by the same rules.
 */
function usePanelDismiss(
  open: boolean,
  panelRef: RefObject<HTMLDivElement | null>,
  panelId: string,
  close: () => void,
): void {
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return undefined;
    const controlSel = `[aria-controls="${panelId}"]`;
    const focused = document.activeElement as HTMLElement | null;
    openerRef.current = focused && focused.matches?.(controlSel) ? focused : null;
    const opener = () => {
      const was = openerRef.current;
      if (was && was.isConnected && was.getClientRects().length) return was;
      return Array.from(document.querySelectorAll<HTMLElement>(controlSel))
        .find((el) => el.getClientRects().length > 0) || null;
    };
    focusFirstItem(panelRef.current);
    const onDown = (event: Event) => {
      const target = event.target as Element | null;
      if (!target || panelRef.current?.contains(target)) return;
      if (target.closest?.(controlSel)) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const back = opener();
      closeRef.current();
      back?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, panelId, panelRef]);
}

/**
 * The scope panel, for the Workshop of ONE app.
 *
 * `slug` is the app on screen, which the panel ticks. Nothing renders until
 * the header's control opens it (#3295), so the first render is empty at
 * every width. The chip that used to lead this markup, #dev-ws-scope-chip,
 * is gone rather than hidden: it had nowhere left to show.
 */
export function AppWorkshopScope({ slug }: { slug: string }) {
  const { open } = useStoreState(appScopeStore) as { open: boolean };
  const [apps, setApps] = useState<PickerApp[] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Keyboard and outside presses: see usePanelDismiss.
  usePanelDismiss(open, panelRef, APP_SCOPE_PANEL_ID, () => appScopeStore.set({ open: false }));

  // A panel left open does not outlive the app it was opened on, nor the
  // Workshop: the header's control would otherwise find it already open on
  // the next visit.
  useEffect(() => {
    appScopeStore.set({ open: false });
    return () => appScopeStore.set({ open: false });
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/apps${demoQuery()}`);
        if (!res.ok) return;
        const data = await res.json();
        const home = (window as unknown as {
          Home?: { isJoined?: (row: unknown) => boolean };
        }).Home;
        const list = (data.apps || []) as Array<PickerApp & { is_member?: boolean }>;
        const rows = list.filter((row) => (home?.isJoined ? home.isJoined(row) : !!row.is_member));
        if (!cancelled) setApps(rows);
      } catch {
        // OFFLINE IS SILENCE. The panel still offers the way back to all of
        // them — the list of the others is the only thing a refused request
        // costs, and a control that works is worth more than an error where a
        // menu should be.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!open) return null;
  return (
    <div className="dev-ws-scope" data-ws-scope="">
      <WorkshopPicker
        id={APP_SCOPE_PANEL_ID}
        apps={apps}
        // Only `slug` is read off it: the panel ticks this app's row.
        scope={{ slug }}
        onClose={() => appScopeStore.set({ open: false })}
        panelRef={panelRef}
      />
    </div>
  );
}


/* ════════════════════════════════════════════════════════════════════
   THE CHIP ON THE ALL-APPS SCREEN (#3051)
   ════════════════════════════════════════════════════════════════════ */

/** The all-apps chip's id. Its panel is this plus `-picker`. */
export const ALL_APPS_SCOPE_ID = 'workshop-scope';

/**
 * "All apps ⌄" at the head of the all-apps Workshop screen, and its panel.
 *
 * Controlled: the screen's own store holds the open flag (`scopeOpen`) and
 * the app list it already fetched (`rows`), so this adds no fetch and no
 * state of its own. The first render is the chip alone, closed, which is
 * what the prerender carries; the panel renders only once somebody taps.
 */
export function AllAppsScope({ apps, open, onToggle }: {
  apps: PickerApp[] | null;
  open: boolean;
  onToggle: (next: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = `${ALL_APPS_SCOPE_ID}-picker`;
  usePanelDismiss(open, panelRef, panelId, () => onToggle(false));
  return (
    <>
      <WorkshopScope id={ALL_APPS_SCOPE_ID} open={open} scope={null} onToggle={onToggle} />
      {open ? (
        // Its own line of the chip's flex row, LAST, so it drops under the
        // tabs rather than between the chip and them; full bleed, because
        // the panel draws its own `mx-4` gutter.
        <div className="order-last min-w-0 basis-[calc(100%+2rem)] -mx-4">
          <WorkshopPicker
            id={panelId}
            apps={apps}
            scope={null}
            onClose={() => onToggle(false)}
            panelRef={panelRef}
          />
        </div>
      ) : null}
    </>
  );
}
