/**
 * The App / Feed / Kanban toggle (#1363) — one component, two homes.
 *
 * It replaces two rows of the Improve panel's "Development" section. Kanban and
 * "Latest development activity" were list rows with a chevron, which said
 * "navigate somewhere" when what they actually do is SWITCH WHICH VIEW of the
 * same app you are looking at. Three mutually exclusive destinations, one of
 * them always current, is a segmented control — so it is one now, and the third
 * segment is the app itself, which previously had no entry point in this panel
 * at all: once you had followed Kanban out of it there was nothing here to take
 * you back.
 *
 * ── Two homes, one component, and why it is not two ────────────────────
 *
 * On a phone the toggle lives INSIDE the panel, under "Give feedback". On a
 * wide screen it also renders in the header, immediately left of #improve-btn,
 * where switching views costs no taps at all — the request is "take it out of
 * the sidebar for quicker access", and a control you have to open a sheet to
 * reach is the thing being complained about.
 *
 * BOTH COPIES ARE ALWAYS RENDERED, and CSS decides which one is on screen:
 * `sm:hidden` on the panel's, `hidden sm:flex` on the header's. Rendering one
 * or the other from a width measurement would need a matchMedia subscription in
 * React, and would make the prerendered document depend on a viewport width the
 * SSG pass in build-shell.mjs does not have — a hydration mismatch on every
 * phone or every desktop, whichever way the default fell. `sm` is the same
 * 640px breakpoint the rest of the shell keys off.
 *
 * The two differ only in chrome: the header copy is pinned to the header's 28px
 * content row (`h-7`, the ceiling #improve-btn is pinned to for the same
 * reason), the panel copy is a full-width block with room to breathe.
 *
 * ── Where "active" comes from ──────────────────────────────────────────
 *
 * Two stores, because the state genuinely lives in two places: which HALF of
 * the app is on screen (App tab vs Dev area) is `improveStore.tab`, republished
 * from `App.switchTab()`; which DEV VIEW is showing is the dev-board's own
 * `view-mode-store`, which `AppView._setViewMode()` already publishes. Feed and
 * Kanban are only ever active while the Dev half is the one on screen, which is
 * exactly the `tab === 'dev' && mode === …` conjunction below.
 *
 * ── The App segment is conditional ─────────────────────────────────────
 *
 * A self-hosted row (the platform's own app, which is what home targets) has no
 * per-slug iframe URL, so its App tab does not resolve — `App.switchTab()`
 * coerces any request for it to the Dev forum. Rendering a segment that
 * silently redirects would be a dead option in a control whose whole job is
 * saying where you are, so it is not rendered there at all. That is the same
 * exclusion the retired App/Dev switch made, for the same reason.
 */

import { AppWindowIcon, BoardIcon, ListLinesIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { useDevViewMode } from '../dev-board/view-mode-store';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';

type Segment = 'app' | 'feed' | 'kanban';

/**
 * Every class is a COMPLETE literal in both branches.
 *
 * Tailwind's extractor is a regex over source text, so a class name assembled
 * at runtime is a class name that never gets compiled — AGENTS.md's rule for
 * the `cva` variant tables, and it applies just as much to a ternary.
 */
function segmentCls(active: boolean, compact: boolean): string {
  const base = compact
    ? 'inline-flex items-center gap-1 h-6 px-2 rounded-md text-xs font-medium transition-colors un-touch-target'
    : 'flex-1 inline-flex items-center justify-center gap-1.5 h-8 px-2 rounded-md text-xs font-medium transition-colors un-touch-target';
  return active
    ? `${base} bg-white dark:bg-zinc-900 text-violet-600 dark:text-violet-400 shadow-sm`
    : `${base} text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200`;
}

/**
 * The track, WITHOUT a display utility — each call site below supplies its own
 * as the FIRST class in the string.
 *
 * Deliberate: `hidden` and `inline-flex` are both display utilities, so which
 * one wins is decided by their order in Tailwind's generated stylesheet, not by
 * their order in the class attribute. Keeping display out of the shared run
 * means the two variants each state theirs exactly once and neither depends on
 * that ordering.
 */
const TRACK_CLS = 'items-center gap-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 p-0.5';

export function ImproveViewToggle({ compact }: { compact: boolean }) {
  const { target, slug, selfHosted, tab } = useStoreState(improveStore);
  const mode = useDevViewMode();

  // Nothing improvable on screen → nothing to switch between. Same gate as
  // #improve-btn, so the two appear and disappear together rather than the
  // toggle outliving the button it sits beside.
  if (!target || !slug) return null;

  const active: Segment = tab === 'dev' ? (mode === 'kanban' ? 'kanban' : 'feed') : 'app';

  const select = (segment: Segment) => {
    if (segment === 'app') Improve.openApp();
    else Improve.openDev(segment);
  };

  return (
    <div
      // Two copies means two ids; neither is in the prerendered document
      // (the control returns null without a target), so neither is part of
      // the shell's static id inventory. They exist for the declared checks
      // in dapp.json, which need to tell the header copy from the panel one.
      id={compact ? 'improve-view-toggle' : 'improve-view-toggle-panel'}
      className={
        compact
          ? `hidden sm:inline-flex ${TRACK_CLS} h-7 mr-2`
          : `flex sm:hidden ${TRACK_CLS} w-full`
      }
      role="tablist"
      aria-label="App view"
    >
      {selfHosted ? null : (
        <button
          type="button"
          role="tab"
          data-view-segment="app"
          aria-selected={active === 'app' ? 'true' : 'false'}
          className={segmentCls(active === 'app', compact)}
          onClick={() => select('app')}
          title="The app itself"
        >
          <AppWindowIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          App
        </button>
      )}
      <button
        type="button"
        role="tab"
        data-view-segment="feed"
        aria-selected={active === 'feed' ? 'true' : 'false'}
        className={segmentCls(active === 'feed', compact)}
        onClick={() => select('feed')}
        title="Feed — recent development activity, newest first"
      >
        <ListLinesIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Feed
      </button>
      <button
        type="button"
        role="tab"
        data-view-segment="kanban"
        aria-selected={active === 'kanban' ? 'true' : 'false'}
        className={segmentCls(active === 'kanban', compact)}
        onClick={() => select('kanban')}
        title="Kanban — work in flight, by column"
      >
        <BoardIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Kanban
      </button>
    </div>
  );
}
