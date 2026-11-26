import * as React from 'react';
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The filter chip and the rail it scrolls in.
 *
 * The deck's Changes screen leads with a horizontal rail of these: a text chip
 * ("All") followed by icon-only chips, one per kind. Selection is a SOLID
 * INVERSION — near-black fill, page-coloured ink — not a tint or an outline.
 * That is the language's one high-contrast state, and it is deliberately not
 * the accent: the accent means "actionable/mine", selection means "you are
 * looking at this subset", and colouring both blue would collapse the two.
 *
 * ── Why a `<button>` with `aria-pressed` and not a radio group ─────────
 *
 * The rail is a filter, and a filter chip is a toggle: the deck shows "All"
 * selected with the others available, and nothing about it implies exactly one
 * must be chosen. `aria-pressed` says that; `role="radio"` would promise
 * single-selection semantics the caller may not want. A caller that DOES want
 * exclusivity gets it by managing state, without fighting the roles.
 *
 * Note `shrink-0` on the chip and `overflow-x-auto` on the rail: without the
 * first, a rail wider than the viewport compresses its chips into ellipses
 * instead of scrolling.
 *
 * ── Its first consumer: Discover's filter chips ────────────────────────
 *
 * For a while nothing in the shell imported this: the deck leads its Changes
 * screen with a filter rail, and adding one was a navigation change the
 * reskin deliberately did not make. The navigation prototype then gave the
 * app directory one — All / Featured / Your apps / New above the list — and
 * features/apps/browse-screen.tsx draws it with this primitive at its `bar`
 * size. The two places that needed the language's SELECTION idiom without a
 * filter (features/improve/view-toggle.tsx and the Leaderboard's section
 * strip) still state it themselves, for the reason immediately below.
 *
 * ── What this is NOT for ──────────────────────────────────────────────
 *
 * A TABLIST. `features/improve/view-toggle.tsx` looks like a row of chips and
 * is not one: its segments are `role="tab"` with `aria-selected`, three
 * mutually exclusive views of the same thing. This component is a toggle and
 * says so with `aria-pressed`, and a node carrying both is wrong for assistive
 * tech — a tab is selected, not pressed. That toggle therefore states the
 * language's selection idiom itself rather than importing this. Sharing the
 * LOOK is not a reason to share the SEMANTICS.
 */

const chip = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full text-[1.0625rem] font-medium transition-colors',
  {
    variants: {
      selected: {
        true: 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900',
        false: 'bg-white text-zinc-900 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800',
      },
      shape: {
        // Icon-only chips are circles; text chips are pills with room to breathe.
        text: 'px-6',
        icon: 'aspect-square',
      },
      size: {
        // `rail` is the deck's own filter rail — a row of big, finger-sized
        // chips that IS the screen's primary control.
        rail: 'h-14 text-[1.0625rem] [&>svg]:h-6 [&>svg]:w-6',
        // `bar` is the same idiom shrunk to sit inside a header row beside a
        // title and an action button. Same shape, same selection inversion,
        // sized to the 36px controls the shell's bars are built from.
        bar: 'h-9 text-[0.9375rem] [&>svg]:h-5 [&>svg]:w-5',
      },
    },
    defaultVariants: { selected: false, shape: 'text', size: 'rail' },
  },
);

export interface ChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>,
    VariantProps<typeof chip> {}

export function Chip({ className, selected, shape, size, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected ?? false}
      className={cn(chip({ selected, shape, size }), className)}
      {...props}
    />
  );
}

/** How wide a rail's fade is, in CSS pixels. */
const FADE = 40;
const RAIL = 'flex gap-3 overflow-x-auto px-4 py-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

interface RailEdges { start: boolean; end: boolean }

/**
 * What makes a sideways row of chips say it scrolls (request 7029, and the
 * phone audit, request 7164: Needs you's chips "run off the right edge with
 * no hint that they scroll"). Two things, for any scroller a ref is on:
 *
 * - `edges`, which ends have chips past them, and `style`, the mask that
 *   fades those ends (the start is the right end in a right-to-left row). It
 *   is a mask, so it fades to whatever the row sits on,
 *   in either theme, and it goes when the row is scrolled to that end. A row
 *   that fits gets none.
 * - The pressed chip (`aria-pressed="true"`) is brought into view when the
 *   row is first drawn and whenever another chip is pressed, so a row never
 *   opens with its own selection off the edge. Only the row is scrolled,
 *   never the page.
 *
 * STATE IN AN EFFECT, NEVER IN THE FIRST RENDER: the first render carries no
 * mask and no mark, so a prerender and its hydration match. A scroller that
 * is not one (`display: contents`, as All items' filter chips are from
 * 640px) measures zero both ways and gets nothing.
 */
export function useRailFade(ref: RefObject<HTMLElement | null>): { edges: RailEdges; style: CSSProperties | undefined } {
  const [edges, setEdges] = useState<RailEdges>({ start: false, end: false });
  const [rtl, setRtl] = useState(false);
  const shown = useRef<Element | null>(null);
  const measure = useRef<(() => void) | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const sync = () => {
      // scrollLeft runs negative from the start in a right-to-left scroller.
      const at = Math.abs(el.scrollLeft);
      const start = at > 1;
      const end = at + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
      if (start || end) setRtl(getComputedStyle(el).direction === 'rtl');
    };
    measure.current = sync;
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    ro?.observe(el);
    return () => { measure.current = null; el.removeEventListener('scroll', sync); ro?.disconnect(); };
  }, [ref]);
  // After every render, and cheap. A chip that arrives or goes changes what
  // is past the edge without the row's own box changing, which the observer
  // above does not see; and the pressed chip is moved only when it is
  // another one than last time.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure.current?.();
    const pressed = el.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (pressed === shown.current) return;
    shown.current = pressed;
    if (!pressed || el.scrollWidth <= el.clientWidth) return;
    const rail = el.getBoundingClientRect();
    const chip = pressed.getBoundingClientRect();
    // Past either end by more than the fade: move it clear of the fade. The
    // sign of the move is the same in a right-to-left row, where scrollLeft
    // runs negative.
    if (chip.left < rail.left) el.scrollLeft -= rail.left + FADE - chip.left;
    else if (chip.right > rail.right) el.scrollLeft += chip.right - (rail.right - FADE);
  });
  const mask = edges.start || edges.end
    ? `linear-gradient(to ${rtl ? 'left' : 'right'}, ${edges.start ? 'transparent' : '#000'}, #000 ${FADE}px, #000 calc(100% - ${FADE}px), ${edges.end ? 'transparent' : '#000'})`
    : undefined;
  return { edges, style: mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined };
}

/**
 * The rail a row of chips scrolls in. Chips keep their own width (`shrink-0`
 * on the chip) with a gap between them, so on a narrow phone they never run
 * into each other: the row scrolls sideways instead, and fades toward
 * whichever edge has chips past it rather than cutting the last one off
 * against the edge (Evan, 30 Oct: wrapping to a second line read worse).
 * `useRailFade` above is the fade and the pressed chip kept in view.
 *
 * `[-ms-overflow-style:none]` / `[scrollbar-width:none]` / the webkit
 * pseudo-element together hide the scrollbar without killing the scroll — the
 * rail is finger-scrolled on the surface this language targets, and a visible
 * bar under a row of circles reads as a rendering fault.
 *
 * Its users are Needs you's vote kinds (features/workshop/vote-filter.tsx),
 * the notification kinds, the share sheet's two rows, Home's kind chips
 * (features/home/communities-to-join.tsx) and the AI page's History kinds
 * (features/ai/lists.tsx). A caller passes the spacing its surface needs,
 * since the rail sits in the page's gutter. The AI page's PROJECT chips
 * (features/ai/lists.tsx) keep their own copy, inside a sheet, whose
 * measurement `tests/rtl-geometry.test.js` pins.
 */
export function ChipRail({ className, children, style, ...props }: React.ComponentProps<'div'>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { edges, style: fade } = useRailFade(ref);
  return (
    <div
      ref={ref}
      className={cn(RAIL, className)}
      // The first render has no mask, so a prerender and its hydration match.
      style={fade ? { ...style, ...fade } : style}
      data-fade-start={edges.start ? '' : undefined}
      data-fade-end={edges.end ? '' : undefined}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * The same rail under the name it had while only some rails faded. Every
 * chip rail fades now (request 7029), so this is `ChipRail`.
 */
export const FadeRail = ChipRail;
