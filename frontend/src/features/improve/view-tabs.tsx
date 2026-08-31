/**
 * #improve-views — the app's three views as ONE segmented control.
 *
 * ── What it replaced, and why ──────────────────────────────────────────
 *
 * Three stacked rows (label, muted detail, chevron) plus, while you were on
 * the Board, an indented `Kanban | Feed` pair underneath the middle one. Four
 * controls and two levels of hierarchy for a choice between three things —
 * and the second level was the tell: Kanban and Feed WERE Board and Activity.
 * Both draw `#dev-body` from the same cached cards, one by column and one
 * newest-first, and the only thing that made them a "layout" rather than a
 * destination was that the header renamed the screen when you switched.
 *
 * So the layout became the route (see the alias block in public/js/app.js's
 * restoreFromHash), the sub-strip retired, and what is left is a flat
 * three-way choice — which is a segmented control, not a list of rows.
 *
 * ── One strip, ONE surface ─────────────────────────────────────────────
 *
 * The Improve panel renders it, and nothing else does. The header chip's menu
 * carried a second copy for a while, on the reasoning that "which part of
 * this app am I looking at" is fair to answer from either surface. In use it
 * was the wrong question in that place: the chip's menu is the APP PICKER, so
 * a strip about the app you are already in sat between you and the list you
 * opened it for. It also made the menu the only surface where two different
 * kinds of navigation shared one panel.
 *
 * What replaced it is not another copy — it is the header's back arrow, which
 * leads OUT of a Board or an Activity feed to the app itself (see
 * ../header/platform-header.tsx). One way in, from the panel; one way out,
 * from the bar.
 *
 * ── Anchors, not the Tabs primitive ────────────────────────────────────
 *
 * @/components/ui/tabs.tsx renders `<button>` triggers, and Board and Activity
 * are hash routes: cmd/ctrl-click, middle-click and "open in new tab" have to
 * work on them, the same rule tests/nav-new-tab.test.js pins across the shell.
 * So the strip is written out here and borrows the primitive's CONVENTION
 * instead of its markup — `aria-current="page"` on the selected segment rather
 * than `aria-selected`, which belongs to `role="tab"`.
 *
 * The App segment stays a `<button>`: it is not a hash: on the self-hosted
 * platform row it goes home, and on an ordinary app it re-mounts the app frame
 * through `Improve.openApp()`. It calls `onNavigate` FIRST, which the anchors
 * get for free from the caller's own click handler — `openApp` dismisses the
 * Improve panel but knows nothing about the chip's menu, and neither
 * destination it reaches writes `location.hash` (both go through
 * history.pushState, which fires no `hashchange`), so the sheet's own
 * hashchange dismissal never runs.
 *
 * ── The ids and the data-* keys are load-bearing ───────────────────────
 *
 * `data-context-row="app" | "board" | "activity"` is what dapp.json's declared
 * checks select on. The keys named rows and now name segments; the key says
 * WHICH DESTINATION, which has not changed.
 *
 * The ids stay a PARAMETER even with one caller left. They were parameterised
 * because two surfaces rendered the strip at once and element ids cannot be
 * shared; with the chip's copy retired, `IMPROVE_VIEW_IDS` is the only map and
 * it holds `#improve-views` / `#app-context-row-*` exactly as they were, which
 * is what every declared check and `getElementById` already names.
 */

import type { ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { useDevViewMode } from '../dev-board/view-mode-store';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';

/** The recessed track, the same well the quick actions sit in. */
const TRACK =
  'shrink-0 flex items-stretch gap-0.5 rounded-xl p-0.5 bg-zinc-100 dark:bg-white/5';

/*
 * THE PILL'S RADIUS IS THE TRACK'S INNER RADIUS, AND IT IS NOT THE STOCK ONE.
 *
 * A rounded box nested in a rounded box has one correct radius: the outer
 * radius less the gap between them. TRACK is `rounded-xl p-0.5`, so the well
 * the pill sits in has a 2px inset and the pill's corner has to be
 * `xl - 2px`. Anything tighter leaves a crescent of track showing at each end
 * of the strip, which is what "the white box overlaps the grey weirdly" was.
 *
 * This read `0.625rem` — 10px, which is exactly `xl - 2` in stock Tailwind,
 * where `xl` is 12px. It is not 12px here: tailwind.config.js overrides the
 * whole radius scale (`lg: 0.75rem, xl: 1rem, 2xl: 1.25rem, 3xl: 1.5rem`), so
 * the track is 16px and the pill needed 14px all along. The arithmetic was
 * right and the constant it was done against was not, which is the failure
 * mode a hard-coded arbitrary value has and a token does not.
 *
 * If TRACK's radius or padding ever moves, this moves with it —
 * tests/app-switcher-dropdown.test.js recomputes it from both.
 */
const SEG =
  'flex flex-1 basis-0 min-w-0 items-center justify-center h-8 px-1 rounded-[0.875rem] '
  + 'text-sm font-medium transition-colors un-touch-target';

/*
 * The selected segment is a RAISED surface, not a tint.
 *
 * @/components/ui/tabs.tsx's SECTION_TAB_ACTIVE inverts to near-black, which
 * is right for a strip floating on the page ground. This one sits inside a
 * white panel, so the same figure/ground move runs the other way: the track
 * is the recess and the selected segment is the page-coloured card lifted out
 * of it. Violet ink carries the accent without a second filled shape next to
 * the quick-action well directly above.
 */
const SEG_ACTIVE =
  'bg-white text-violet-700 shadow-sm dark:bg-zinc-800 dark:text-violet-400';

const SEG_REST =
  'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100';

function segClass(active: boolean): string {
  return SEG + ' ' + (active ? SEG_ACTIVE : SEG_REST);
}

/** The Improve panel's ids — the ones every existing selector already names. */
export const IMPROVE_VIEW_IDS = {
  root: 'improve-views',
  app: 'app-context-row-app',
  board: 'app-context-row-board',
  activity: 'app-context-row-activity',
} as const;

/**
 * Which of the three the current view is, or null.
 *
 * `topic` counts as the Board: a card opened full-screen is still the board's
 * content, and the segment going blank when you tap a card read as the
 * navigation losing its place. The general chat (`chat`) and a dev session
 * (`sessions`) are neither, and select nothing — they are reached from a
 * notification or a card, not from this strip.
 */
export function activeAppView(
  tab: string | null,
  subTab: string | null,
  mode: string,
): 'app' | 'board' | 'activity' | null {
  if (tab !== 'dev') return 'app';
  if (subTab === 'forum' || subTab === 'topic') {
    return mode === 'feed' ? 'activity' : 'board';
  }
  return null;
}

export function AppViewTabs({ ids, onNavigate, className }: {
  /** Element ids for the track and its three segments. */
  ids: { root: string; app: string; board: string; activity: string };
  onNavigate: () => void;
  className?: string;
}): ReactNode {
  const { name, slug, selfHosted, tab, subTab } = useStoreState(improveStore);
  const mode = useDevViewMode();
  const active = activeAppView(tab, subTab, mode);

  // The platform's own row is not an iframe, so its first segment is Home —
  // the same relabelling the row it replaces carried (#1386).
  const appLabel = selfHosted ? 'Home' : 'App';

  return (
    <div
      id={ids.root}
      className={className ? `${TRACK} ${className}` : TRACK}
      role="group"
      aria-label={name ? `${name}: which view` : 'Which view'}
    >
      <button
        id={ids.app}
        data-context-row="app"
        type="button"
        aria-current={active === 'app' ? 'page' : 'false'}
        className={segClass(active === 'app')}
        onClick={() => { onNavigate(); Improve.openApp(); }}
      >
        <span className="min-w-0 truncate">{appLabel}</span>
      </button>
      <a
        id={ids.board}
        data-context-row="board"
        href={slug ? `#app/${slug}/board` : '#'}
        aria-current={active === 'board' ? 'page' : 'false'}
        className={segClass(active === 'board')}
        onClick={onNavigate}
      >
        <span className="min-w-0 truncate">Board</span>
      </a>
      <a
        id={ids.activity}
        data-context-row="activity"
        href={slug ? `#app/${slug}/activity` : '#'}
        aria-current={active === 'activity' ? 'page' : 'false'}
        className={segClass(active === 'activity')}
        onClick={onNavigate}
      >
        <span className="min-w-0 truncate">Activity</span>
      </a>
    </div>
  );
}
