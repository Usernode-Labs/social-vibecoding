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
  SearchIcon,
  TrophyOutlineIcon,
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
 * A home-screen area's LABEL, and the controls that act on the block below it.
 *
 * ── Why the title moved back out of the card ──────────────────────────
 *
 * It lived inside the block's own bar, on the reasoning that N widgets could
 * not share one heading above a section — true while these were draggable grid
 * items and a section could hold several. THE UI OVERHAUL ended that: there is
 * exactly one block per section now, in a fixed order, so the heading has
 * exactly one thing to name.
 *
 * What that bought is the shape the owner's reference screen has: a quiet grey
 * label, then the white card it introduces, repeated down the page. A title
 * printed INSIDE the card competes with the card's own content for the same
 * surface and gives every area a second, smaller header bar; the label outside
 * lets each card be nothing but what it holds.
 *
 * ── …and why the CONTROLS followed it out ─────────────────────────────
 *
 * They did not, at first, and that was worse than leaving the title in. The
 * bar's remaining occupants — Discover's "Browse all apps", Challenges' "Open
 * leaderboard", the ⋮ every block carries — are all `shrink-0`, so with the
 * title gone the first row of every card was a strip of white with three
 * quarters of it empty and one link floating at the right. The card opened on
 * chrome instead of on content.
 *
 * A section header with the label left and its one action right is the shape
 * that row was always trying to be, and it is the reference screen's own
 * (name on the left, state on the right). So the heading is a ROW: `label`
 * takes the space, `action` sits at the end of it, and the card underneath
 * holds nothing but the block.
 *
 * NO `id`, deliberately: nothing selects these, and an id would have to be
 * recorded in tests/baselines/shell-markup.json for no one's benefit. The
 * class is `home-area-label` rather than the `home-section-header` this first
 * shipped as — that one is TAKEN (app.css sizes it 12px muted, and the widget
 * strip's caption and the search-results heading are it), and two different
 * labels sharing a class is a rule waiting to be changed for one of them.
 *
 * Sized and coloured as the block titles it replaces (`text-[0.9375rem]`,
 * zinc-500 — the shell's secondary ink), so the type itself is a MOVE rather
 * than a restyle.
 */
export function SectionHeading({ children, action }: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <h2 className="home-area-label flex items-center gap-2 pt-4 pb-1.5 text-[0.9375rem] leading-tight text-zinc-500 dark:text-zinc-500">
      <span className="min-w-0 flex-1 truncate whitespace-nowrap">{children}</span>
      {action}
    </h2>
  );
}

/**
 * The ⋮ that opens a block's own menu (hide this widget, and the rows
 * HomePanels.menuItems builds for it).
 *
 * It rides in the section heading beside the block's link — see
 * `SectionHeading` for why everything that is chrome ABOUT a block sits above
 * it rather than inside it. `data-panel-key` still names which block it acts
 * on, which is what it was for when the button lived in the card.
 */
export function PanelMenuButton({ panelKey }: { panelKey: string }) {
  return (
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
  );
}

/**
 * Discover's one destination — the `#apps` directory.
 *
 * Lifted out of DiscoverPanel with the rest of the block's chrome, so the
 * section heading can render it beside the ⋮. Same id, same classes, same
 * hash navigation: `#home-browse-btn` is selected on from dapp.json.
 */
export function BrowseLink() {
  return (
    <button
      type="button"
      id="home-browse-btn"
      className="home-panel-browse shrink-0 flex items-center gap-1 text-[12px] font-medium text-violet-700 dark:text-violet-400 hover:underline whitespace-nowrap"
      title="Browse every app in the directory"
      aria-label="Browse all apps"
      onClick={(e) => {
        e.stopPropagation();
        // Through the hash, so the browse screen gets a real history entry and
        // the OS back gesture returns here.
        window.location.hash = '#apps';
      }}
    >
      <SearchIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span className="whitespace-nowrap">Browse all apps</span>
    </button>
  );
}

/**
 * The bordered block: body, optional footer, and nothing else.
 *
 * IT HAS NO TITLE BAR ANY MORE. The bar held the block's title until the
 * heading moved out above the card, and then its controls followed (see
 * `SectionHeading`) — so the card begins on its own content. `.home-panel-bar`
 * is gone with it, along with the `user-select` and cursor rules app.css kept
 * for a strip that was once a drag handle.
 *
 * `flex-none` on the footer and `.home-panel-rows` on the list are what made
 * app.css's height cap clip rather than grow; `.home-panel--expanded` lifts
 * the cap entirely.
 */
export function PanelShell({
  panelKey, expanded, stamps, footer, children,
}: {
  panelKey: string;
  expanded: boolean;
  stamps?: PanelStamps;
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
      {children}
      {footer || null}
    </article>
  );
}

/**
 * THE LEADERBOARD LINK (#980). `BrowseLink` verbatim — same violet 12px link,
 * same icon-then-label shape, same seat in the section heading — because it
 * answers the same question on the same screen. It renders in EVERY branch and
 * at every width: between seasons, where the block draws no footer at all, it
 * is the only control the area has.
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
      <TrophyOutlineIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
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
          strokeWidth="2.5"
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
        <ChevronRightIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
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
        <ChevronRightIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      </button>
    </div>
  );
}
