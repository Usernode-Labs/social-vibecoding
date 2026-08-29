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
 * ── One strip, two surfaces ────────────────────────────────────────────
 *
 * Rendered by BOTH the Improve panel and the header chip's menu, which is why
 * it is its own module. The chip's menu answers WHICH APP and the Improve
 * panel answers what you can do to it; "which part of this app am I looking
 * at" is a fair question to be able to answer from either, and answering it
 * differently in the two places would be two owners of one decision.
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
 * The ELEMENT ids cannot be shared, because two surfaces render this strip and
 * both are mounted at once — the Improve panel is always in the document, slid
 * off-screen. So each caller passes its own `idPrefix`: `improve-` keeps the
 * panel's `#improve-views` / `#app-context-row-*` exactly as they were, and the
 * chip's menu uses `switcher-`. `getElementById` and the declared checks go on
 * resolving to the panel's copy, which is the one they always meant.
 */

import type { ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { useDevViewMode } from '../dev-board/view-mode-store';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';

/*
 * The recessed track, the same well the quick actions sit in.
 *
 * CAPSULE IN CAPSULE, and it always was — `rounded-full` here only says out
 * loud what the browser already drew. The track is 36px tall (an `h-8`
 * segment plus `p-0.5` top and bottom) and carried `rounded-xl`; since the
 * radius scale moved that is 20px, and CSS scales all four radii by
 * 36/(20+20) = 0.9 when they overrun a side, so it rendered at 18px — exactly
 * half the height. A capsule.
 *
 * That matters because the concentric inner of an 18px corner at a 2px inset
 * is 16px, which is half of the segment's own 32px — a capsule too. So the
 * pill is `rounded-full` rather than the `rounded-lg` (12px) it drifted to:
 * concentric exactly, at any inset, with no number to keep in sync. It is
 * also the geometry @/components/ui/tabs.tsx already ships for the identical
 * strip (SECTION_TABS_LIST / SECTION_TAB_BASE are `rounded-full` on an `h-8`
 * segment in a `p-0.5` track) — this file borrows that convention everywhere
 * else, and the radius was the one place it had stopped.
 */
const TRACK =
  'shrink-0 flex items-stretch gap-0.5 rounded-full p-0.5 bg-zinc-100 dark:bg-white/5';

const SEG =
  'flex flex-1 basis-0 min-w-0 items-center justify-center h-8 px-1 rounded-full '
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

/** The chip menu's copy of the same strip. */
export const SWITCHER_VIEW_IDS = {
  root: 'switcher-views',
  app: 'switcher-view-app',
  board: 'switcher-view-board',
  activity: 'switcher-view-activity',
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
