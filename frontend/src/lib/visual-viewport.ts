/**
 * WHERE THE SCREEN IS, WHEN THE KEYBOARD HAS MOVED IT (#2765).
 *
 * The kit tells the page how TALL the strip above the on-screen keyboard is:
 * `--un-kb-inset` on <html>, the layout-viewport height the keys cover
 * (native.js keyboardInset). It does not say where that strip STARTS, and
 * its centred surfaces assume the top — `.un-modal` sits at
 * `50% - var(--un-kb-inset) / 2`, the middle of the strip only while the
 * visual viewport begins at the layout viewport's top edge.
 *
 * iOS does not keep it there. To reveal a focused field it PANS the visual
 * viewport down inside the layout viewport, and a `position: fixed` box is
 * laid out against the layout viewport, so it does not move with the pan.
 * The kit's own measurements (#1938) have an installed app at a 403px pan
 * under a 409px visual viewport on an 812px layout: what is on screen is
 * the band 403–812, and the kit's modal is centred at 204. Give feedback
 * shows it at its mildest: tap the description and iOS pans just far enough
 * to clear it, the dialog re-centres into the strip ABOVE that pan, and it
 * lands pressed against the top edge with its heading cut off. Open it with
 * the keys already up and the page panned all the way, and almost none of
 * it is on screen.
 *
 * So this module publishes the missing half, `visualViewport.offsetTop`, as
 * `--platform-vv-top` on <html>, beside the kit's inset, and app.css moves
 * the modal down by it (a `translate`, so it keeps iOS's timing — see
 * app.css). Where nothing pans — Android measured offsetTop 0 in
 * the same table, and desktop never has a keyboard — the property stays 0px
 * and the modal sits exactly where the kit puts it.
 *
 * Pinch zoom is not a keyboard pan: a zoomed visual viewport reports an
 * offset for the zoom, and following it would drag the dialog around the
 * layout under the viewer's fingers. The kit forces its inset to 0 while
 * zoomed for the same reason, so this reads 0 there too.
 *
 * THE PAN IS THE KEYBOARD'S, so it is published only while the kit reports
 * one (`html.un-kb`). The two terms of the modal's `top` must describe the
 * same moment. The kit clears its inset the moment the field blurs (native.js
 * keyboardCanBeUp), while iOS keeps reporting the pan until its retraction
 * has finished. A pan with no inset put the dialog's centre that far below
 * the middle of the screen, and it slid down as iOS unwound the pan.
 */

export const VV_TOP_PROP = '--platform-vv-top';
/** The kit's "keyboard up" class on <html> (native.js keyboard tracker). */
export const KB_CLASS = 'un-kb';

type ViewportLike = Pick<VisualViewport, 'offsetTop' | 'scale'>;

/** How far, in whole px, the visual viewport's top edge sits below the
 *  layout viewport's. 0 while pinch-zoomed, and for anything unreadable. */
export function visualViewportTop(vv: ViewportLike | null | undefined): number {
  if (!vv) return 0;
  const scale = Number(vv.scale);
  if (!Number.isFinite(scale) || Math.abs(scale - 1) > 0.01) return 0;
  const top = Number(vv.offsetTop);
  if (!Number.isFinite(top) || top <= 0) return 0;
  return Math.round(top);
}

type DocLike = {
  documentElement: {
    style: Pick<CSSStyleDeclaration, 'setProperty'>;
    classList: Pick<DOMTokenList, 'contains'>;
  };
};
type ObserverLike = new (callback: () => void) => {
  observe(target: unknown, options: { attributes: boolean; attributeFilter: string[] }): void;
};
type WinLike = {
  visualViewport?: (ViewportLike & Pick<EventTarget, 'addEventListener'>) | null;
  MutationObserver?: ObserverLike;
};

/**
 * Follow the visual viewport and keep `--platform-vv-top` current.
 *
 * Written IN the viewport event, not a frame later: the pan is a
 * `translate` that has to land in the frame iOS scrolls the page, and a
 * frame's delay showed the dialog riding the page off for that frame. The
 * same two events the kit's tracker listens to. Writes only on a change —
 * a scrolling page fires `scroll` here every frame. The kit's `un-kb` class
 * is watched too, and read the moment it changes: the kit sets it in its
 * own frame and clears it in the blur itself, and this follows before
 * either paints. Returns the apply step, for tests.
 */
export function initVisualViewportTop(doc: DocLike, win: WinLike): () => void {
  const vv = win.visualViewport;
  let last = 0; // the stylesheet's fallback: unset reads as 0px
  const apply = () => {
    const top = doc.documentElement.classList.contains(KB_CLASS) ? visualViewportTop(vv) : 0;
    if (top === last) return;
    last = top;
    doc.documentElement.style.setProperty(VV_TOP_PROP, `${top}px`);
  };
  if (!vv) return apply;
  vv.addEventListener('resize', apply, { passive: true });
  vv.addEventListener('scroll', apply, { passive: true });
  if (win.MutationObserver) {
    new win.MutationObserver(apply).observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  apply();
  return apply;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  initVisualViewportTop(document, window);
}
