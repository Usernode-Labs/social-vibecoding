/**
 * The bordered block every home panel is drawn in, and the controls its bar
 * and footer carry.
 *
 * A like-for-like port of `HomePanels._panelShell` / `_leaderboardLink` /
 * `_panelFooter` — same classes, same `data-*`, same order —
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
  if (stamps.createEnabled !== undefined) {
    out['data-create-enabled'] = String(stamps.createEnabled);
  }
  return out;
}

/**
 * WHICH TINT a card wears, from a string key.
 *
 * Discover's app cards and Challenges' challenge cards share one five-tint
 * palette (`.home-tint-1` … `-5` in app.css), and the tint is derived from
 * the card's own identity — an app slug, a challenge id — rather than from
 * its POSITION in the lane. Position would repaint the whole row whenever a
 * lane reorders, and an app people recognise by its green card would be blue
 * the next time they looked.
 *
 * Any stable spread will do, so this is the smallest one that is not a
 * pattern: a 32-bit rolling hash, folded to 1..5. It is deterministic across
 * the server prerender and the client, which matters — a tint that differed
 * between them would be a hydration mismatch, which console-errors and fails
 * the proposal checks.
 */
export function tintOf(key: string): string {
  // FNV-1a, which is what a rolling `* 31` hash is not: multiply-then-fold
  // clusters badly over short strings that share a shape (an app slug, a
  // challenge id), and the first draft put four of five demo cards on the
  // same tint. The xor-then-multiply order is the fix, and the final
  // avalanche step is what keeps two slugs differing in one letter apart.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return `home-tint-${(Math.abs(h) % 5) + 1}`;
}

/**
 * THE WHOLE CARD-COLOUR VOCABULARY, as data.
 *
 * Two sets, and the difference between them is who chooses:
 *
 *   TONES are CHOSEN. Twelve tone-50 colours from the HIG-muted palette
 *   (`.home-tone-cream` … `-gray` in app.css), offered in the featured
 *   illustration editor so an author can put their artwork on a colour that
 *   suits it. Named rather than numbered: `blue` survives the palette being
 *   reordered or a thirteenth hue being added, where an index does not, and
 *   the name is what the row is actually called in the palette.
 *
 *   LEGACY_TINTS are HASHED. The five `.home-tint-N` the launcher has always
 *   assigned from a card's own identity (see `tintOf`). They were also, very
 *   briefly, what the editor offered, so a handful of illustrations carry one
 *   as a stored number. They stay valid values — an author who picked one
 *   still sees it — but they are no longer offered.
 *
 * Both sets define the same three custom properties, so a card renders one
 * way whichever it wears. The class strings are complete literals, because
 * Tailwind's extractor is a regex over source text and the CSS here is
 * hand-written for the same reason.
 */
export const TONES = [
  'cream', 'yellow', 'orange', 'coral', 'pink', 'purple',
  'indigo', 'blue', 'teal', 'mint', 'sage', 'gray',
] as const;
export type Tone = (typeof TONES)[number];

export const LEGACY_TINTS = [1, 2, 3, 4, 5] as const;
export type LegacyTint = (typeof LEGACY_TINTS)[number];

const TONE_CLASS: Record<Tone, string> = {
  cream: 'home-tone-cream', yellow: 'home-tone-yellow', orange: 'home-tone-orange',
  coral: 'home-tone-coral', pink: 'home-tone-pink', purple: 'home-tone-purple',
  indigo: 'home-tone-indigo', blue: 'home-tone-blue', teal: 'home-tone-teal',
  mint: 'home-tone-mint', sage: 'home-tone-sage', gray: 'home-tone-gray',
};

const TINT_CLASS: Record<LegacyTint, string> = {
  1: 'home-tint-1', 2: 'home-tint-2', 3: 'home-tint-3', 4: 'home-tint-4', 5: 'home-tint-5',
};

/** A tone's own name, title-cased for a label. */
export function toneLabel(tone: Tone): string {
  return tone.charAt(0).toUpperCase() + tone.slice(1);
}

/**
 * The class for a stored card colour, or null for anything that is neither a
 * tone name nor one of the five legacy tints. Null is the signal to fall back,
 * so an unreadable value paints the card's own default rather than nothing.
 */
export function cardTintClass(value: unknown): string | null {
  if (typeof value === 'string') return TONE_CLASS[value as Tone] || null;
  return LEGACY_TINTS.includes(value as LegacyTint) ? TINT_CLASS[value as LegacyTint] : null;
}

/**
 * What a card actually wears: the colour chosen with its illustration when
 * there is one, otherwise the hash of its own identity. Deliberately one
 * function, because the fallback is the thing that has to match between the
 * server prerender and the client.
 */
export function cardTint(key: string, tint?: unknown): string {
  return cardTintClass(tint) || tintOf(key);
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
 *
 * THE HOMESCREEN DESIGN then restyled it: 16px at weight 550 in the primary ink (a true half-step on the
 * variable system faces iOS, Android and macOS ship; semibold where the
 * face has no 550), the
 * area title rather than a caption, with the area's link beside it at 14px
 * semibold in the brand periwinkle (--brand-ink) and no glyph in front of it.
 * The row's shape is label + link: the ⋮ that used to ride here is gone
 * Section hiding is retired (#1801).
 */
export function SectionHeading({ children, action }: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <h2 className="home-area-label flex items-center gap-2 pt-4 pb-1.5 text-base font-[550] leading-tight text-zinc-900 dark:text-zinc-100">
      <span className="min-w-0 flex-1 truncate whitespace-nowrap">{children}</span>
      {action}
    </h2>
  );
}

/**
 * Discover's one destination — the `#apps` directory.
 *
 * Lifted out of DiscoverPanel with the rest of the block's chrome, so the
 * section heading can render it beside the label. Same id, same classes, same
 * hash navigation: `#home-browse-btn` is selected on from dapp.json.
 */
export function BrowseLink() {
  return (
    <button
      type="button"
      id="home-browse-btn"
      className="home-panel-browse shrink-0 flex items-center gap-1 text-[14px] font-semibold text-[color:var(--brand-ink)] hover:underline whitespace-nowrap"
      title="Browse every app in the directory"
      aria-label="Browse all apps"
      onClick={(e) => {
        e.stopPropagation();
        // Through the hash, so the browse screen gets a real history entry and
        // the OS back gesture returns here.
        window.location.hash = '#apps';
      }}
    >
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
  panelKey, expanded, stamps, footer, plate = 'card', children,
}: {
  panelKey: string;
  expanded: boolean;
  stamps?: PanelStamps;
  footer?: ReactNode;
  /**
   * WHAT THE BLOCK SITS ON. Three answers, because the homescreen design
   * gave the three blocks three different ones and the article is still one
   * component:
   *
   *   'card'  — the white plate the blocks have always had. Create app.
   *   'soft'  — a translucent plate (`.home-challenges-plate`). Challenges
   *             draws its content as tinted cards, and an opaque white
   *             rectangle behind them would cover the wallpaper exactly
   *             where the page is tallest.
   *   'none'  — no plate at all. Discover's cards ARE the surface, and a
   *             box around a row of tinted cards is a second frame around
   *             things that already have one. It is also what lets the rail
   *             bleed to both screen edges.
   *
   * `home-panel-card` rides with 'card' only: it is the name of the plate,
   * and tests/home-panels-render.test.js asserts the pairing.
   */
  plate?: 'card' | 'soft' | 'none';
  children: ReactNode;
}) {
  const plateClass = plate === 'card'
    ? ' home-panel-card rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden'
    : (plate === 'soft' ? ' home-challenges-plate' : '');
  return (
    <article
      className={`home-panel${expanded ? ' home-panel--expanded' : ''}${plateClass}`}
      data-panel={panelKey}
      {...stampProps(stamps)}
    >
      {children}
      {footer || null}
    </article>
  );
}

/**
 * THE AREA'S WAY IN (#980, renamed #1916). `BrowseLink` verbatim — same 12px
 * link, same seat in the section heading — because it answers the same
 * question on the same screen. It renders in EVERY branch and at every width:
 * between seasons, where the block draws no footer at all, it is the only
 * control the area has.
 *
 * It reads "Open challenges" and lands on the Challenges tab of the
 * Leaderboard screen (#1916): the area is called Challenges, so a link out of
 * it that named a different thing read as a way somewhere else. It is still
 * the home screen's door to that screen — the standings are one tab over —
 * and the trailing chevron marks it as navigation rather than an action.
 */
export function LeaderboardLink() {
  return (
    <button
      type="button"
      className="home-panel-lb-browse shrink-0 flex items-center gap-1 text-[14px] font-semibold text-[color:var(--brand-ink)] hover:underline whitespace-nowrap"
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
  );
}

/**
 * The Challenges footer: the expand/collapse toggle on the left, the way out
 * to the Challenges tab on the right.
 *
 * That right-hand control says "Open challenges" and lands on
 * `#leaderboard/challenges` — the same label and the same destination as the
 * heading's link since #1916, so the two never disagree about where they go
 * (#980 was two controls one card apart reading alike but opening different
 * tabs). The footer copy is the one under the rows, for a reader who has just
 * scrolled past them.
 *
 * THE TOGGLE IS CONDITIONAL (#1824). It used to render whenever the block had
 * any rows, so a season with three challenges drew "See all 3 challenges"
 * under all three of them — a control whose label was false and whose click
 * refetched the same list. `expandable` is the view's answer to "would
 * expanding show a row that is not already on screen?", and when it is no,
 * the footer is just the way out. The count in the label is `total` for the
 * same reason it always was: the toggle only appears when there is more than
 * is drawn, so the number is never the number already on screen.
 */
export function PanelFooter({
  panelKey, total, expanded, expandable = true,
}: { panelKey: string; total: number; expanded: boolean; expandable?: boolean }) {
  const label = expanded
    ? 'Show less'
    : (total ? `See all ${total} challenges` : 'See all challenges');
  // One justify utility, never two: `justify-between` seats the toggle left
  // and the door right, and with no toggle a lone flex child would drift to
  // the left edge instead of staying under the rows it belongs to.
  return (
    <div
      className={expandable
        ? 'home-panel-footer flex-none flex items-center justify-between gap-2 px-2.5'
        : 'home-panel-footer flex-none flex items-center justify-end gap-2 px-2.5'}
    >
      {expandable ? (
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
      ) : null}
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
