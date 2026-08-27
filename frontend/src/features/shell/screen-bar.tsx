/**
 * `.screen-bar` — the shell's SECOND bar: the screen you are on, and what you
 * can do to it.
 *
 * ── The rule ───────────────────────────────────────────────────────────
 *
 * THE TOP BAR NAMES THE APP. THIS ONE NAMES THE SCREEN. Neither answers the
 * other's question, and neither is ever asked to.
 *
 *     ┌───────────────────────────────────────────┐
 *     │ (icon) Gym Tracker ⌄        (bell) Improve│  #platform-header
 *     ├───────────────────────────────────────────┤
 *     │ ← Board                                  +│  .screen-bar
 *     └───────────────────────────────────────────┘
 *
 * ── What this replaces, and why it is a BAR rather than a line of type ──
 *
 * The screen's name was a SUBTITLE inside the header chip: a 10px second
 * line stacked under the app's name, sized to fit a 28px pill
 * (`text-sm` + `mt-0.5` + `text-[0.625rem]` + `leading-none` = 26px inside
 * 28px). That arithmetic is the tell. The chip is one line of type wide and
 * the row it sits in is pinned from both directions by
 * tests/header-height-parity.test.js, so a second information layer had to
 * be shrunk into the gaps of the first rather than given a place to live.
 *
 * Three separate concessions were made to that one constraint — the 10px
 * subtitle, the session lifecycle pill exiled up into the header beside the
 * back arrow, and `New change` hidden below `sm` because a 375px strip could
 * not hold the change's own name as well. This bar is what stops paying:
 * 52px of its own, the same height as the bar above it, so the two read as
 * one block of chrome and the screen's name is a heading rather than a
 * caption.
 *
 * ── Where it does NOT appear ───────────────────────────────────────────
 *
 * Over the app itself. `#app/<slug>/app` is the app, full stop — the whole
 * point of the top bar's one contextual action is that the platform gets out
 * of the way there. A bar naming "App" above an app would be the third
 * answer to a question nobody asked.
 *
 * Nor on the root screens (Home, Discover, Messages, Settings, a profile).
 * Those have no screen WITHIN an app to name: the chip is already saying the
 * whole of where you are, which is why they never published a subtitle
 * either.
 *
 * ── The back slot ──────────────────────────────────────────────────────
 *
 * Optional, and it is where a nested screen's back control belongs — beside
 * the name of the thing you would be leaving, not stranded in the bar above
 * that names something else. The topic view drew its own `← Back` strip for
 * exactly this reason; it is this component now, so there is one idiom
 * rather than one per screen.
 *
 * A real `<a href>` (#1036), so cmd/ctrl-click, middle-click and "open in
 * new tab" work and the native WebView does not punt a plain tap out to the
 * system browser. The caller keeps its `NavLink.isNativeClick` guard.
 */

import type { ReactNode } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';

export interface ScreenBarProps {
  /** The screen's name — the heading this bar exists to carry. */
  title?: string;
  /** Where back goes. Omitted on a screen you cannot go up from. */
  backHref?: string;
  /** Plain-click handler for the back anchor; a modified click never reaches it. */
  onBackClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  /** Tooltip for the back anchor, since the glyph carries no label. */
  backTitle?: string;
  /** `id` for the back anchor, so existing callers keep their selector. */
  backId?: string;
  /** The screen's own actions, right-aligned. */
  children?: ReactNode;
}

/**
 * 52px, matching `#platform-header`'s own 52px content box, so the two bars
 * are one block rather than two sizes. `min-h` rather than `h`: an action
 * taller than the row should push the bar rather than overflow it, which is
 * the opposite of the header's rule and deliberate — nothing up there may
 * grow, everything down here may.
 */
const BAR = 'screen-bar flex items-center gap-2 px-3 min-h-[52px] shrink-0 '
  + 'border-b border-zinc-200 dark:border-zinc-800';

export function ScreenBar({
  title, backHref, onBackClick, backTitle, backId, children,
}: ScreenBarProps): ReactNode {
  return (
    <div className={BAR}>
      {backHref !== undefined ? (
        <a
          id={backId}
          className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-full
                     text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50
                     dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800
                     un-touch-target"
          aria-label="Back"
          title={backTitle}
          href={backHref}
          onClick={onBackClick}
        >
          <ChevronLeftIcon className="w-5 h-5" />
        </a>
      ) : null}
      {/*
          NOT an `h1`. The chip above is the screen's only h1 — one heading
          per screen is the rule the whole header rests on — and a second one
          here would put the app's name and the screen's name at the same
          level in the document outline, which is the very confusion the
          subtitle caused visually.
      */}
      <div className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </div>
      {children ? (
        <div className="shrink-0 flex items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}
