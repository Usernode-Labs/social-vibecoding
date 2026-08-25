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
// This hook switches the title to absolute positioning, centred in the space
// the two side groups leave — NOT at the viewport's middle (#1407).
//
// It used to centre on the viewport, requiring symmetric clearance equal to
// the WIDER group on both sides. That was the wrong target twice over. The
// groups are lopsided — a ~20px back button against a right group holding the
// view selector, the improve button and the hamburger — so a title at viewport
// centre sits visibly off-centre within the gap it actually occupies, drifting
// toward the narrow side. And demanding the wider group's width as clearance on
// BOTH sides throws away the room the narrow side has, so titles that would fit
// comfortably fell back to left-aligned for want of space that was there all
// along.
//
// Centring between the groups fixes both: the anchor is the midpoint of
// [leftW, headerW - rightW], and the fit test asks only whether the title fits
// in that gap. When it does not, we leave it in flex flow where it truncates
// cleanly from the right — the "centred if room, left-aligned otherwise"
// contract is unchanged, and there is still no state where a truncated title
// is also centred.
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

declare global {
  interface Window {
    /** features/header/use-header-layout.ts */
    HeaderLayout?: { refresh: () => void };
  }
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
      const headerW = header!.clientWidth;
      if (headerW <= 0) return;

      const leftW = leftGroup!.offsetWidth;
      const rightW = rightGroup!.offsetWidth;

      // The gap between the two groups, and its midpoint. This is the whole
      // change from the viewport-centred version: the title is centred on the
      // space it actually has rather than on the header, so the lopsidedness
      // of the groups moves the anchor instead of wasting the narrow side.
      const gapStart = leftW + SIDE_GAP_PX;
      const gapEnd = headerW - rightW - SIDE_GAP_PX;
      const availableForCenter = gapEnd - gapStart;

      const titleNaturalW = measureTitleNaturalWidth();

      const canCenter = availableForCenter > 0
        && titleNaturalW + JITTER_SLACK_PX <= availableForCenter;

      // Published as a custom property rather than an inline `left` so the
      // positioning rule stays in the stylesheet with the rest of the title's
      // geometry — this hook supplies the one number CSS cannot compute.
      // Written only when it is going to be used, so a left-aligned title
      // carries no stale offset from a width it no longer has.
      if (canCenter) {
        const centre = gapStart + availableForCenter / 2;
        title!.style.setProperty('--header-title-centre', `${Math.round(centre)}px`);
      } else {
        title!.style.removeProperty('--header-title-centre');
      }

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
