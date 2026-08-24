/**
 * The App / Feed / Kanban toggle (#1367) — one component, two homes.
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
 * ── All three segments render everywhere, home included (#1386) ────────
 *
 * They did not always. A self-hosted row — the platform's own app, which is
 * what home targets — has no per-slug iframe URL, so its App TAB does not
 * resolve: `App.switchTab('app')` coerces any request for it to the Dev forum.
 * A segment that silently redirects is a dead option in a control whose whole
 * job is saying where you are, so it was left out for that row, the same
 * exclusion the retired App/Dev switch made.
 *
 * That reasoning held for the tab and not for the DESTINATION. "The app
 * itself" is not missing for the platform — it simply is not an iframe. The
 * platform's product surface IS the home screen, which is the very screen
 * `Home.publishImproveTarget()` publishes this target from. So the segment
 * renders for the self-hosted row too and `Improve.openApp()` sends it home,
 * which closes the same one-way trip the toggle was built to fix: before this,
 * following Kanban out of home left a control reading Feed | Kanban with
 * NEITHER segment selected and nothing in it to get back.
 *
 * `active` needed no change to say so. On home no app is open, so the store's
 * `tab` is still `App.currentTab`'s own initial 'app' and the segment reads as
 * selected; opening the Dev half republishes 'dev' and Feed or Kanban takes
 * over.
 *
 * ── Why the platform's segment reads "Home" ────────────────────────────
 *
 * A segment names WHERE IT GOES, and for the platform that is the home screen,
 * not an app. Labelling it "App" there would name a destination that does not
 * exist — the platform has no app tab, which is the whole reason this segment
 * lands on home instead — so the label, the icon and the tooltip all follow the
 * destination together.
 *
 * `data-view-segment` does NOT: it stays "app" on both. It is the selector
 * contract dapp.json's declared checks and `select()` are written against, and
 * it identifies the segment's ROLE (the first, non-dev one), which is the same
 * on either row. A visible label is for the reader; the attribute is for the
 * code, and only one of them is about the destination.
 */

import { AppWindowIcon, BoardIcon, HomeIcon, ListLinesIcon } from '@/components/ui/icons';

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
    ? 'inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-xs font-medium transition-colors un-touch-target'
    : 'flex-1 inline-flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-full text-xs font-medium transition-colors un-touch-target';
  // SELECTION IS A SOLID NEAR-BLACK INVERSION, not an accent-coloured raised
  // pill — the widget language's one high-contrast state, and the same rule
  // @/components/ui/chip.tsx states for its own selected variant. It is
  // deliberately NOT the accent: the accent means "actionable", selection
  // means "you are looking at this view", and colouring both blue collapses
  // the two. The `shadow-sm` goes with it — the language separates by
  // figure/ground and fill, never by lifting one control off the page.
  return active
    ? `${base} bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900`
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
/*
 * The track's fill depends on WHAT IT SITS ON, which is the one thing the two
 * copies of this control do not share.
 *
 * zinc-100 IS the page ground in this palette (#eaeaea). The header copy sits
 * on that ground, so a zinc-100 track is invisible there and the three
 * segments read as loose labels — it has to be a raised white surface, like
 * the hamburger disc beside it. The panel copy sits inside the Improve sheet,
 * which is already white, so there the reverse is true and white is the
 * invisible one.
 *
 * Two literals rather than one: Tailwind's extractor is a regex over source
 * text, so neither can be assembled.
 */
const TRACK_BASE = 'items-center gap-0.5 rounded-full p-0.5';
/** On the page ground — the header copy. */
const TRACK_ON_GROUND = `${TRACK_BASE} bg-white dark:bg-zinc-900`;
/** On the Improve sheet's white surface — the panel copy. */
const TRACK_ON_CARD = `${TRACK_BASE} bg-zinc-100 dark:bg-zinc-800`;

export function ImproveViewToggle({ compact }: { compact: boolean }) {
  const { target, slug, selfHosted, tab } = useStoreState(improveStore);
  const mode = useDevViewMode();

  // Nothing improvable on screen → nothing to switch between. Same gate as
  // #improve-btn, so the two appear and disappear together rather than the
  // toggle outliving the button it sits beside.
  if (!target || !slug) return null;

  // `null` when the viewer is on a platform screen that is none of the three
  // (#1406 — settings, profile, messages). The control keeps its job of saying
  // where you are, and on those screens the honest answer is "not here": every
  // segment renders unselected rather than one of them claiming you.
  const active: Segment | null = tab === 'dev'
    ? (mode === 'kanban' ? 'kanban' : 'feed')
    : (tab === 'app' ? 'app' : null);
  // Capitalised binding: JSX reads a lowercase tag as a literal element name.
  const HomeSegmentIcon = selfHosted ? HomeIcon : AppWindowIcon;

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
          ? `hidden sm:inline-flex ${TRACK_ON_GROUND} h-7 mr-2`
          // Transitional (Streamlined Concept): the header copy is retired, so
          // until the app-context sheet takes over as the view switcher the
          // panel copy renders at EVERY width, not just under `sm`.
          : `flex ${TRACK_ON_CARD} w-full`
      }
      role="tablist"
      aria-label="App view"
    >
      <button
        type="button"
        role="tab"
        data-view-segment="app"
        aria-selected={active === 'app' ? 'true' : 'false'}
        className={segmentCls(active === 'app', compact)}
        onClick={() => select('app')}
        title={selfHosted ? 'The platform itself' : 'The app itself'}
      >
        <HomeSegmentIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        {selfHosted ? 'Home' : 'App'}
      </button>
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
