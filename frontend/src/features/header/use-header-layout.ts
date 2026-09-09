// Header title positioning: viewport-centered when there's room,
// left-aligned in flex flow otherwise.
//
// This is public/js/header-layout.js (#1079 chunk B), which used to be an IIFE
// that ran on load, resolved `document.querySelector('header')` and walked
// `title.previousElementSibling` / `.nextElementSibling` to find the two side
// groups. #platform-header is a React island now, so the three elements arrive
// as refs from the component that renders them: the sibling walk — the one
// piece of this module a stray wrapper could silently break — is gone, and the
// rest of the algorithm is unchanged, comments included.
//
// The page header is a flex row of [back-btn wrapper][title][right group].
// In flex flow, the title's flex-1 cell sits between the back-btn wrapper
// (~20px) and the right group (4-5 icon buttons depending on app state —
// most secondary actions live in the drawer since #122, and the header
// slim-down moved the two commit pills, the fork label and the kudos
// badge in there too). Centering the title within its own cell yields a
// position that's offset from viewport center because the side groups
// have very different widths.
//
// The right group is nearly fixed-width now, so the centred mode wins far
// more often than it used to — but it still VARIES (the dev-console icon
// only appears once an app logs an error), so the measurement stays.
//
// This hook restores true viewport-centering when there's enough room
// for it, by switching the title to absolute positioning at left:50%.
// "Enough room" means the title's natural (un-truncated) width fits
// inside the header with symmetric clearance equal to the wider of the
// two side groups, plus a small breathing gap on each side. When the
// title is too wide to satisfy that, we leave it in flex flow where it
// truncates cleanly from the right.
//
// Why JS and not pure CSS: there's no CSS expression that means "make
// these two elements' margins equal to the wider of two third-party
// elements' widths". CSS subgrid + container queries get close but
// can't span the kind of asymmetric layout this header has. A JS
// observer is the simple and precise tool.

import type { RefObject } from 'react';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';

// Minimal breathing room between the title and the nearest side
// group's edge. Just enough to not look pinched; the user-facing rule
// is "centered unless that would overlap the pill", so we keep this
// small. The header already has px-4 padding, which gives the title
// 16px clearance from the viewport edges separately.
const SIDE_GAP_PX = 4;

// 1px float-jitter slack so the title doesn't flip-flop between
// modes on every frame at the exact threshold (subpixel rounding
// between the Range's getBoundingClientRect and the side groups'
// offsetWidth would otherwise oscillate).
const JITTER_SLACK_PX = 1;

// Below this the title is NEVER centred — it stays in flex flow, left-aligned
// beside the back/home icon, and truncates from the right.
//
// Two reasons, and the second is the one that made it a rule rather than a
// preference.
//
// A phone header has no room for the idiom. The right group carries the
// Improve button and the hamburger — around 140px — so the room left for a
// symmetrically-centred title is `390 - 2*140`, i.e. under 110px: a title
// short enough to qualify is rare, and one that does qualify sits in the
// middle of a bar whose only other content is pinned to the two edges, which
// reads as floating rather than as centred.
//
// And a near-miss is not a graceful one. Centring takes the title OUT of flex
// flow (`position: absolute`, `flex: none` — see app.css), and an absolutely
// positioned element has no cell to truncate against: it just runs over the
// right group. On a wide screen the arithmetic has tens of pixels of slack to
// absorb a late-arriving badge; at 390px it has none. So the narrow case gets
// the layout that degrades by clipping instead of the one that degrades by
// overlapping.
//
// 640px is the shell's own `sm` breakpoint, the same one the kanban tab strip
// and the rest of app.css switch on.
const CENTER_MIN_WIDTH_PX = 640;

declare global {
  interface Window {
    /** features/header/use-header-layout.ts */
    HeaderLayout?: { refresh: () => void };
  }
}

/**
 * Can the title sit at the header's exact centre without touching either side
 * group? Pure, and exported, because THIS is the part that was wrong: the
 * arithmetic is the whole behaviour and it is not observable from the outside
 * until a title overlaps a button.
 *
 * Everything is in viewport coordinates, so the caller measures rects and this
 * does no layout of its own.
 *
 * @param headerLeft   the header's border-box left edge
 * @param headerWidth  the header's border-box width
 * @param leftInner    the left group's RIGHT edge — its inner edge
 * @param rightInner   the right group's LEFT edge — its inner edge
 * @param titleNaturalW the title text's intrinsic width, not its flex cell's
 */
export function canCenterTitle({
  headerLeft, headerWidth, leftInner, rightInner, titleNaturalW,
}: {
  headerLeft: number;
  headerWidth: number;
  leftInner: number;
  rightInner: number;
  titleNaturalW: number;
}): boolean {
  if (headerWidth <= 0) return false;
  // See CENTER_MIN_WIDTH_PX: a phone never centres, whatever fits.
  if (headerWidth < CENTER_MIN_WIDTH_PX) return false;
  const center = headerLeft + headerWidth / 2;
  // Centring is symmetric, so the tighter side decides. A right group that
  // already reaches past the centre line makes this negative, which is the
  // honest answer: there is no room at all.
  const halfRoom = Math.min(center - leftInner, rightInner - center) - SIDE_GAP_PX;
  return titleNaturalW / 2 + JITTER_SLACK_PX <= halfRoom;
}

/**
 * Toggles `.is-centered` on the title as the header, the right group or the
 * title text change size. Runs as a LAYOUT effect: the class it writes is the
 * one thing about the header that isn't in the prerendered markup, and doing
 * it before the browser paints keeps the title from visibly jumping from
 * left-aligned to centred on first load — the same timing the classic script
 * got by running inline at the end of <body>.
 */
export function useHeaderLayout(
  headerRef: RefObject<HTMLElement | null>,
  leftGroupRef: RefObject<HTMLElement | null>,
  titleRef: RefObject<HTMLElement | null>,
  rightGroupRef: RefObject<HTMLElement | null>,
) {
  useIsomorphicLayoutEffect(() => {
    const header = headerRef.current;
    const leftGroup = leftGroupRef.current;
    const title = titleRef.current;
    const rightGroup = rightGroupRef.current;
    if (!header || !leftGroup || !title || !rightGroup) return;

    // Cached Range used to measure the title's *intrinsic* text width
    // (independent of the <h1>'s flex-stretched cell width). scrollWidth
    // and offsetWidth on the <h1> both report the cell width when
    // flex-1 has stretched it past the content — a hard-to-spot bug
    // where "plenty of room" makes the cell wide, scrollWidth reports
    // it as wide, and the algorithm falsely concludes the title doesn't
    // fit centered. A Range over the title's text nodes returns the
    // actual rendered text bounds, which is what we need.
    const measureRange = document.createRange();

    let pending = false;
    let frame = 0;

    function measureTitleNaturalWidth() {
      if (!title!.firstChild) return 0;
      measureRange.selectNodeContents(title!);
      const rect = measureRange.getBoundingClientRect();
      return rect.width;
    }

    function recompute() {
      pending = false;
      const headerRect = header!.getBoundingClientRect();
      if (headerRect.width <= 0) return;

      // MEASURED FROM THE SIDE GROUPS' INNER EDGES, not from their widths.
      //
      // The rule used to be `headerW - 2 * (max(leftW, rightW) + GAP)`, which
      // silently assumes each group is flush against the header's border box.
      // Neither is: the header is `px-4`, so a group's inner edge sits 16px
      // further in than its width implies, on both sides. That over-reported
      // the room by 32px and centred titles that then ran over the right
      // group — "Settings" at 390px overlapped the Improve button by 3px,
      // which is the report that found this.
      //
      // Rects instead. Both groups are flush to their own edge in either mode
      // (the title is `flex-1` in flow and `flex: none` when centred, and the
      // right group's `ml-auto` pins it either way), so measuring while
      // centred gives the same answer as measuring in flow — no oscillation.
      const canCenter = canCenterTitle({
        headerLeft: headerRect.left,
        headerWidth: headerRect.width,
        leftInner: leftGroup!.getBoundingClientRect().right,
        rightInner: rightGroup!.getBoundingClientRect().left,
        titleNaturalW: measureTitleNaturalWidth(),
      });

      title!.classList.toggle('is-centered', canCenter);
    }

    function schedule() {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(recompute);
    }

    // Re-evaluate on header size changes (viewport resize, devtools
    // open/close, sidebar toggle, etc.) and on right-group size changes
    // (the dev-console icon appearing when an app first logs an error, a
    // badge growing from 9 to 10+).
    const headerObserver = new ResizeObserver(schedule);
    headerObserver.observe(header);
    const rightObserver = new ResizeObserver(schedule);
    rightObserver.observe(rightGroup);

    // Expose a manual recompute hook for components that mutate the
    // right group via innerHTML and want an instant remeasure rather
    // than waiting on the next ResizeObserver tick. (Kudos.Budget._render
    // used to call this; its badge lives in the drawer now, so nothing in
    // tree does today — the hook stays for the next such component.)
    // app.js calls it optionally (`window.HeaderLayout?.refresh?.()`), and
    // this effect runs before DOMContentLoaded, so it is always published in
    // time for the call sites that matter.
    window.HeaderLayout = { refresh: schedule };

    // Title text changes (Home → AppView navigation, app rename, etc.)
    // don't fire ResizeObserver because the title's rendered width is
    // controlled by flex-1 in flow mode, not by its content. Watch the
    // text directly.
    const titleObserver = new MutationObserver(schedule);
    titleObserver.observe(title, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    schedule();

    // The classic script never tore down — it was a page-lifetime IIFE. The
    // island is mounted for the page's lifetime too, so this only runs under
    // React's StrictMode double-invoke and on a hot reload; without it those
    // would leave a second set of observers measuring the same header.
    return () => {
      headerObserver.disconnect();
      rightObserver.disconnect();
      titleObserver.disconnect();
      cancelAnimationFrame(frame);
      if (window.HeaderLayout?.refresh === schedule) delete window.HeaderLayout;
    };
  }, [headerRef, leftGroupRef, titleRef, rightGroupRef]);
}
