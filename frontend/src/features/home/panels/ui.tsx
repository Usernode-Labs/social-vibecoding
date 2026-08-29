/**
 * The bordered block every home panel is drawn in, and the controls its bar
 * and footer carry.
 *
 * A like-for-like port of `HomePanels._panelShell` / `_leaderboardLink` /
 * `_panelFooter` / `_fillFooter` — same classes, same `data-*`, same order —
 * so app.css's `--home-panel-max-h` cap, the dapp.json checks and the
 * screenshot assertions all keep matching. What changed is who owns the
 * listeners: they were eight `querySelectorAll` sweeps in `HomePanels._wire`,
 * re-run after every paint because the paint had just destroyed the nodes they
 * were on, and they are props here.
 *
 * `HomePanels` is read off `window` at call time rather than imported: this
 * file is loaded by the island, the module is loaded by the island, and every
 * read happens inside a handler long after both have evaluated. Importing it
 * would make the module graph circular for no gain.
 */

import type { ReactNode } from 'react';

import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisVerticalIcon,
  TrophyIcon,
} from '@/components/ui/icons';

import type { PanelStamps } from '../panels-store';

export function panels(): any {
  return (typeof window !== 'undefined' ? (window as any).HomePanels : null) || null;
}

/**
 * `data-*` for one block's article, as React props.
 *
 * The names are spelled out rather than built from the keys because Tailwind's
 * neighbour problem applies to attribute names too: a `data-${k}` prop is
 * invisible to anything grepping the source for the selector it serves, and
 * every one of these is selected on from dapp.json.
 */
export function stampProps(stamps: PanelStamps | undefined) {
  if (!stamps) return null;
  const out: Record<string, string> = {};
  if (stamps.featured !== undefined) out['data-featured'] = String(stamps.featured);
  if (stamps.popular !== undefined) out['data-popular'] = String(stamps.popular);
  if (stamps.rows !== undefined) out['data-rows'] = String(stamps.rows);
  if (stamps.fill !== undefined) out['data-fill'] = String(stamps.fill);
  if (stamps.createEnabled !== undefined) {
    out['data-create-enabled'] = String(stamps.createEnabled);
  }
  return out;
}

/**
 * The bordered block: title bar, body, optional footer.
 *
 * `flex-none` on the bar/footer and `.home-panel-rows` on the list are what
 * make app.css's height cap clip rather than grow;
 * `.home-panel--expanded` lifts the cap entirely.
 *
 * THE TITLE BAR IS NOT A DRAG HANDLE. It was one while these blocks were grid
 * items — the whole bar was the grab surface, and `_wire` had to stop the ⋮
 * button's pointerdown before the recognizer saw it. THE UI OVERHAUL fixed
 * them into sections; the grip, the cursor, the tooltip and that guard all
 * went together.
 */
export function PanelShell({
  panelKey, expanded, stamps, title, footer, children,
}: {
  panelKey: string;
  expanded: boolean;
  stamps?: PanelStamps;
  title: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article
      className={`home-panel home-panel-card${
        expanded ? ' home-panel--expanded' : ''
      } rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden`}
      data-panel={panelKey}
      {...stampProps(stamps)}
    >
      <div className="home-panel-bar flex-none flex items-center gap-2 px-3.5 pt-2.5 pb-1">
        {title}
        <button
          type="button"
          className="home-panel-menu un-touch-target shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 leading-none dark:text-zinc-400"
          data-panel-key={panelKey}
          aria-haspopup="menu"
          title="Widget options"
          aria-label="Widget options"
          onClick={(e) => {
            e.stopPropagation();
            panels()?.openMenu?.(panelKey, e.currentTarget);
          }}
        >
          <EllipsisVerticalIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        </button>
      </div>
      {children}
      {footer || null}
    </article>
  );
}

/** The block's own title text, truncating so a control beside it survives. */
export function PanelTitle({ children }: { children: ReactNode }) {
  return (
    <span className="home-panel-title min-w-0 flex-1 truncate whitespace-nowrap text-[0.9375rem] text-zinc-500 dark:text-zinc-500">
      {children}
    </span>
  );
}

/**
 * THE LEADERBOARD LINK (#980). Discover's browse control verbatim — same
 * violet 12px link, same icon-then-label shape, same place in the title bar —
 * because it answers the same question on the same screen. It renders in EVERY
 * branch and at every width: between seasons, where the block draws no footer
 * at all, it is the only control the area has.
 */
export function LeaderboardLink() {
  return (
    <button
      type="button"
      className="home-panel-lb-browse shrink-0 flex items-center gap-1 text-[12px] font-medium text-violet-700 dark:text-violet-400 hover:underline whitespace-nowrap"
      title="Open the Leaderboard screen"
      aria-label="Open leaderboard"
      onClick={(e) => {
        e.stopPropagation();
        // No kind: the bar's link is the widget's door to the SCREEN, not to
        // whichever board the fill below it happened to preview.
        panels()?.goToLeaderboard?.();
      }}
    >
      <TrophyIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="whitespace-nowrap">Open leaderboard</span>
    </button>
  );
}

/**
 * The Challenges footer: the expand/collapse toggle on the left, the way out
 * to the Challenges tab on the right.
 *
 * That right-hand control says "Open challenges", not "Go to leaderboard"
 * (#980) — it lands on `#leaderboard/challenges` while the bar's link lands on
 * the bare `#leaderboard`, and two affordances one card apart both reading
 * "leaderboard" but opening different tabs is worse than the ambiguity the
 * label was written to fix.
 */
export function PanelFooter({
  panelKey, total, expanded,
}: { panelKey: string; total: number; expanded: boolean }) {
  const label = expanded
    ? 'Show less'
    : (total ? `See all ${total} challenges` : 'See all challenges');
  return (
    <div className="home-panel-footer flex-none flex items-center justify-between gap-2 px-2.5">
      <button
        type="button"
        className="home-panel-expand flex items-center gap-1 text-[12px] font-medium text-violet-700 dark:text-violet-400 hover:underline whitespace-nowrap"
        data-panel-key={panelKey}
        aria-expanded={expanded}
        title={expanded ? 'Collapse this widget' : 'Show every challenge in this widget'}
        onClick={(e) => {
          e.stopPropagation();
          panels()?.toggleExpanded?.(panelKey);
        }}
      >
        <ChevronDownIcon
          className={`w-3 h-3 shrink-0 transition-transform${expanded ? ' rotate-180' : ''}`}
          strokeWidth="3"
          aria-hidden="true"
        />
        <span className="whitespace-nowrap">{label}</span>
      </button>
      <button
        type="button"
        className="home-panel-open flex items-center gap-1 text-[12px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-violet-600 dark:hover:text-violet-400 whitespace-nowrap"
        title="Go to the Challenges tab on the Leaderboard screen"
        aria-label="Open challenges"
        onClick={(e) => {
          e.stopPropagation();
          panels()?.goToChallenges?.();
        }}
      >
        <span className="whitespace-nowrap">Open challenges</span>
        <ChevronRightIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The footer for a block whose only rows are the leaderboard fill's: nothing
 * to expand and nothing to count, so one way out instead — and it names THE
 * BOARD ABOVE IT rather than "the leaderboard" (#980), because the bar's link
 * already goes to the screen and a footer repeating that word one card away
 * would read as two doors to one place.
 */
export function FillFooter({ kind }: { kind: 'topochain' | 'kudos' }) {
  const title = kind === 'kudos'
    ? 'Go to the Top users view on the Leaderboard screen’s Kudos tab'
    : 'Go to the Leaderboard screen';
  const label = kind === 'kudos' ? 'See full kudos board' : 'See full standings';
  return (
    <div className="home-panel-footer flex-none flex items-center justify-end gap-2 px-2.5">
      <button
        type="button"
        className="home-panel-lb-open flex items-center gap-1 text-[12px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-violet-600 dark:hover:text-violet-400 whitespace-nowrap"
        data-lb-kind={kind}
        title={title}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          panels()?.goToLeaderboard?.(kind);
        }}
      >
        <span className="whitespace-nowrap">{label}</span>
        <ChevronRightIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
      </button>
    </div>
  );
}
