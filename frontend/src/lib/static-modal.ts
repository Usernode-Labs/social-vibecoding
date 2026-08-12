/**
 * The static-modal adoption seam, brought inside React (#1078 chunk I).
 *
 * ── What this replaces ────────────────────────────────────────────────
 *
 * Until this chunk, `PlatformUI.adoptStaticModal` (public/js/platform-ui.js)
 * owned every one of the nine shell dialogs. It kept a hard-coded
 * `STATIC_MODAL_IDS` list, put a MutationObserver on each root's class list,
 * and when `hidden` came off it LIFTED THE CARD OUT of the root — swapping in
 * a comment placeholder — into the kit's `presentModal` shell.
 *
 * That is why every dialog had to stay markup-only: two owners wrote to the
 * same nodes, and the one React did not control moved React's DOM out from
 * under it. The lift now lives here, driven by React state, so there is
 * exactly one owner. `useStaticModal` is the whole seam; the dialog islands
 * hold the `open` state and this hook makes the DOM agree with it.
 *
 * ── Why a hook and not a kit-backed <Dialog> primitive ────────────────
 *
 * A `Dialog` primitive would have to render the card through a portal into a
 * container the kit owns. Two things in this repo rule that out:
 *
 *   1. The prerendered public/index.html must contain each card in its
 *      original place, inside `[data-modal-backdrop]`, with the same ids and
 *      class strings — `tests/baselines/shell-markup.json` and the 315
 *      dapp.json selector chains are written against exactly that tree.
 *      `renderToStaticMarkup` does not emit portal content, so a portal-based
 *      primitive would ship an empty backdrop.
 *   2. `presentModal` takes a `contentEl` it physically moves. Whatever React
 *      renders has to survive being relocated, which a portal container does
 *      not make any easier than the real card does.
 *
 * So the card stays where the shell put it and this hook performs the same
 * lift the legacy adopter did. That is safe for React for one specific
 * reason, and it is the reason every dialog renders its full structure
 * unconditionally: React only ever touches a node's PARENT when it inserts,
 * removes or reorders that node. The card is always mounted and never keyed
 * differently, so after hydration React never touches the backdrop's child
 * list again — every update lands inside the card, which the kit moves whole.
 *
 * ── Why not route on PlatformUI.isTouch() ─────────────────────────────
 *
 * `isTouch()` is the platform's usual sheet-vs-popover discriminator, but the
 * legacy adopter never consulted it: `adoptAll` gated on `kit()` alone, so
 * desktop browsers with the kit loaded got the presented modal too. Routing
 * on `isTouch()` here would change desktop presentation for all nine dialogs,
 * which this chunk is explicitly not allowed to do. The gate is kit presence,
 * exactly as before; `hasKit()` is the predicate.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';

import { useIsomorphicLayoutEffect } from './legacy-dom';

interface KitModalHandle {
  el?: HTMLElement | null;
  dismiss(): void;
}

interface PlatformUILike {
  hasKit(): boolean;
  modal(opts: { contentEl: HTMLElement; onDismiss?: () => void }): KitModalHandle | null;
}

function platformUI(): PlatformUILike | null {
  const host = window as unknown as { PlatformUI?: PlatformUILike };
  const ui = host.PlatformUI;
  return ui && typeof ui.modal === 'function' && typeof ui.hasKit === 'function' ? ui : null;
}

/**
 * The gesture guard `AppView.revealModal` used to stamp.
 *
 * A tap that opens a dialog on touch produces a trailing ghost click ~300ms
 * later, which lands on the freshly-revealed backdrop and closes it again.
 * Every backdrop handler ignores dismissals that arrive within this window of
 * the open, by reading `dataset.openedAt`. The stamp moves here so it happens
 * on the same tick as the reveal for every dialog, rather than only the ones
 * whose open path remembered to call `revealModal`.
 */
export const MODAL_GESTURE_GUARD_MS = 450;

/** True while `root` is still inside its opening gesture's ghost-click window. */
export function isDismissGuarded(root: HTMLElement | null | undefined): boolean {
  const at = root?.dataset ? Number(root.dataset.openedAt) : 0;
  return at > 0 && Date.now() - at < MODAL_GESTURE_GUARD_MS;
}

interface Adoption {
  handle: KitModalHandle;
  placeholder: Comment;
  card: HTMLElement;
}

/**
 * Present a dialog root's card inside the kit modal shell.
 *
 * Verbatim in behaviour from the retired `adoptStaticModal`: neutralize the
 * card's own chrome (the kit shell already draws surface, radius, shadow and
 * padding — stacking them gave double borders and doubled whitespace),
 * measure its design width first so the shell hugs it instead of defaulting
 * to 480px, and hide the legacy scrim while the kit owns presentation.
 */
function present(root: HTMLElement, onDismiss: () => void): Adoption | null {
  const ui = platformUI();
  if (!ui || !ui.hasKit()) return null;

  const backdrop = root.querySelector('[data-modal-backdrop]');
  const card = ((backdrop && backdrop.firstElementChild) || root.firstElementChild) as
    | HTMLElement
    | null;
  if (!card) return null;

  let designWidth: string | null = null;
  try {
    const mw = getComputedStyle(card).maxWidth;
    if (mw && mw.endsWith('px')) designWidth = mw;
  } catch {
    /* jsdom and very old engines: fall back to the kit default width */
  }

  card.classList.add('platform-modal-card');
  const placeholder = document.createComment('platform-modal-home');
  card.parentNode?.replaceChild(placeholder, card);
  root.classList.add('platform-modal-adopted');

  const handle = ui.modal({ contentEl: card, onDismiss });
  if (!handle) {
    // The kit refused the presentation — put the card back rather than
    // leaving the dialog invisible behind a `platform-modal-adopted` root.
    card.classList.remove('platform-modal-card');
    placeholder.parentNode?.replaceChild(card, placeholder);
    root.classList.remove('platform-modal-adopted');
    return null;
  }
  if (handle.el && designWidth) {
    handle.el.style.width = `min(${designWidth}, calc(100vw - 32px))`;
  }
  return { handle, placeholder, card };
}

/** Put the card back where the shell rendered it, undoing `present`. */
function restore(root: HTMLElement, adoption: Adoption): void {
  const { placeholder, card } = adoption;
  card.classList.remove('platform-modal-card');
  if (placeholder.parentNode) placeholder.parentNode.replaceChild(card, placeholder);
  root.classList.remove('platform-modal-adopted');
}

export interface StaticModalOptions {
  /**
   * Called when the KIT dismissed the modal on its own — backdrop tap or
   * Escape. The island turns this into `setOpen(false)` so React state stays
   * the source of truth; the hook has already restored the DOM by then.
   *
   * The legacy adopter had to synthesize a click on `[data-modal-backdrop]`
   * here, because the per-modal cleanup only existed inside those handlers.
   * Now that the dialogs own their own state, the close path is just the
   * state update, so the synthetic click is gone.
   */
  onKitDismiss?: () => void;
  /**
   * Called when something OUTSIDE React toggled `hidden` on the root.
   *
   * This is the legacy-compatibility bridge, and it is deliberately narrow:
   * it does not present anything itself, it only reports the class write so
   * the island can reconcile its state. Any `public/js/**` straggler that
   * still does `getElementById('…-modal').classList.remove('hidden')` — an
   * error path, a deep link, a module this chunk did not convert — therefore
   * still opens the dialog, through React, with the kit lift applied.
   */
  onExternalToggle?: (open: boolean) => void;
}

/**
 * Make a dialog root's presentation follow React state.
 *
 * `open` drives three things, in this order, all in a layout effect so the
 * class is right before the browser paints (a deferred toggle flashes the
 * dialog at its hidden state first):
 *
 *   1. the `openedAt` gesture stamp,
 *   2. `hidden` on the root, mutated through `classList` — never a rendered
 *      `className`, because the kit writes `platform-modal-adopted` to this
 *      same node and React would blow it away on the next re-render,
 *   3. the kit lift.
 */
export function useStaticModal(
  rootRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: StaticModalOptions = {},
): void {
  const adoptionRef = useRef<Adoption | null>(null);
  const opts = useRef(options);
  opts.current = options;

  const dismissFromKit = useCallback(() => {
    const root = rootRef.current;
    const adoption = adoptionRef.current;
    adoptionRef.current = null;
    if (root && adoption) restore(root, adoption);
    opts.current.onKitDismiss?.();
  }, [rootRef]);

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    if (open) {
      root.dataset.openedAt = String(Date.now());
      if (root.classList.contains('hidden')) root.classList.remove('hidden');
      if (!adoptionRef.current) adoptionRef.current = present(root, dismissFromKit);
    } else {
      const adoption = adoptionRef.current;
      adoptionRef.current = null;
      if (adoption) {
        restore(root, adoption);
        adoption.handle.dismiss();
      }
      if (!root.classList.contains('hidden')) root.classList.add('hidden');
    }
  }, [rootRef, open, dismissFromKit]);

  // Legacy-compatibility bridge — see StaticModalOptions.onExternalToggle.
  // Watching `class` is what the retired adopter did too, but this observer
  // has no side effect of its own: it reports, React decides.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new MutationObserver(() => {
      const nowOpen = !root.classList.contains('hidden');
      if (nowOpen !== open) opts.current.onExternalToggle?.(nowOpen);
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [rootRef, open]);

  // A dialog that unmounts while presented would otherwise leave the kit
  // shell on screen with a detached card in it.
  useEffect(
    () => () => {
      const root = rootRef.current;
      const adoption = adoptionRef.current;
      adoptionRef.current = null;
      if (adoption) {
        if (root) restore(root, adoption);
        adoption.handle.dismiss();
      }
    },
    [rootRef],
  );
}
