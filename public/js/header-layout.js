// Header title positioning: viewport-centered when there's room,
// left-aligned in flex flow otherwise.
//
// The page header is a flex row of [back-btn wrapper][title][right group].
// In flex flow, the title's flex-1 cell sits between the back-btn wrapper
// (~20px) and the right group (variable width: 2 commit pills + ~5 icon
// buttons, anywhere from ~180px on mobile to ~560px on desktop). Centering
// the title within its own cell yields a position that's offset from
// viewport center because the side groups have very different widths.
//
// This script restores true viewport-centering when there's enough room
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

(function () {
  const header = document.querySelector('header');
  const title = document.getElementById('header-title');
  if (!header || !title) return;

  const leftGroup = title.previousElementSibling;
  const rightGroup = title.nextElementSibling;
  if (!leftGroup || !rightGroup) return;

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

  function measureTitleNaturalWidth() {
    if (!title.firstChild) return 0;
    measureRange.selectNodeContents(title);
    const rect = measureRange.getBoundingClientRect();
    return rect.width;
  }

  function recompute() {
    pending = false;
    const headerW = header.clientWidth;
    if (headerW <= 0) return;

    const leftW = leftGroup.offsetWidth;
    const rightW = rightGroup.offsetWidth;

    // For the title to sit at viewport center without overlapping the
    // wider of the two side groups, the clearance from viewport center
    // to the title's edge needs to be at least as wide as that group.
    // Geometric centering is symmetric, so the same clearance applies
    // on both sides. The constraint reduces to:
    //   titleNaturalW <= headerW - 2 * max(leftW, rightW) - 2 * GAP
    const sideClearance = Math.max(leftW, rightW) + SIDE_GAP_PX;
    const availableForCenter = headerW - 2 * sideClearance;

    const titleNaturalW = measureTitleNaturalWidth();

    const canCenter = titleNaturalW + JITTER_SLACK_PX <= availableForCenter;

    title.classList.toggle('is-centered', canCenter);
  }

  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(recompute);
  }

  // Re-evaluate on header size changes (viewport resize, devtools
  // open/close, sidebar toggle, etc.) and on right-group size changes
  // (deploy state pill flip, platform-version chip changes, app
  // navigation that swaps the per-app pill content, kudos budget
  // badge appearing).
  new ResizeObserver(schedule).observe(header);
  new ResizeObserver(schedule).observe(rightGroup);

  // Expose a manual recompute hook for components that mutate the
  // right group via innerHTML and want an instant remeasure rather
  // than waiting on the next ResizeObserver tick. Kudos.Budget._render
  // calls this after re-rendering the badge.
  window.HeaderLayout = { refresh: schedule };

  // Title text changes (Home → AppView navigation, app rename, etc.)
  // don't fire ResizeObserver because the title's rendered width is
  // controlled by flex-1 in flow mode, not by its content. Watch the
  // text directly.
  new MutationObserver(schedule).observe(title, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  schedule();
})();
