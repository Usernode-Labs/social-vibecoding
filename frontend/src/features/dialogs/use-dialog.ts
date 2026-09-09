/**
 * Shared scaffolding for the nine shell dialogs (#1078 chunk I).
 *
 * Every one of them has the same lifecycle — open, populate, submit, dismiss —
 * and until this chunk that lifecycle was spread across three places: the
 * `hidden` toggle in `public/js/**`, the backdrop-click handler in
 * `App.bindEvents`, and the kit lift in `PlatformUI.adoptStaticModal`. This
 * hook is those three, merged, with React state as the single owner.
 *
 * ── The contract each dialog island signs ─────────────────────────────
 *
 *   * `rootRef` goes on the modal root. React renders that node's className
 *     ONCE (it is a constant string) and never again, because the kit writes
 *     `platform-modal-adopted` to it; `useStaticModal` mutates `hidden`
 *     through `classList` instead.
 *   * `open()` / `close()` are the only ways the dialog's visibility changes.
 *     They are published on `window.UsernodeReact.dialogs.<name>` so the
 *     legacy modules can still drive the dialog by name.
 *   * `backdropProps` goes on the root. It reproduces the dismiss rule every
 *     `bindEvents` handler spelled out by hand: a click on the root itself or
 *     on `[data-modal-backdrop]` closes, and a click that arrives inside the
 *     opening gesture's ghost-click window does not.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { isDismissGuarded, useStaticModal } from '../../lib/static-modal';

export interface DialogController<T = void> {
  /** True while the dialog is presented. */
  readonly isOpen: () => boolean;
  /** Show the dialog. The payload is whatever the island's `onOpen` wants. */
  open: (payload?: T) => void;
  /** Hide the dialog and run the island's `onClose` cleanup. */
  close: () => void;
  /**
   * Hide the dialog WITHOUT running `onClose`, and show it again with
   * `resume()` without running `onOpen`.
   *
   * One caller: the feedback dialog's screenshot capture, which has to get
   * itself out of the photograph and then come back with the user's draft
   * intact. `close()` there would clear the very text the screenshot is being
   * attached to. Before this chunk it wrote `hidden` on the root directly and
   * `adoptStaticModal`'s observer turned that into a dismiss + re-present;
   * this is the same round trip with React in the loop.
   */
  suspend: () => void;
  /** Undo `suspend()`. */
  resume: () => void;
}

export interface UseDialogOptions<T> {
  /**
   * Ran in a layout effect after the root is revealed and the card has been
   * lifted into the kit shell, with whatever `open()` was passed.
   *
   * Layout, not a plain effect, for the same reason the reveal is: this is
   * where a dialog fills its fields, and doing it a frame later shows the
   * user the previous open's values first.
   */
  onOpen?: (payload: T | undefined) => void;
  /** Ran after the dialog is hidden — field resets, aborted requests. */
  onClose?: () => void;
  /**
   * Refuse to close. `import-pr` uses this while its POST is in flight: a
   * dismiss mid-request strands the user with an import they cannot see the
   * outcome of.
   */
  canClose?: () => boolean;
}

export interface UseDialogResult<T> {
  rootRef: React.RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  open: (payload?: T) => void;
  close: () => void;
  suspend: () => void;
  resume: () => void;
  backdropProps: { onClick: (event: MouseEvent<HTMLElement>) => void };
}

export function useDialog<T = void>(
  name: string,
  options: UseDialogOptions<T> = {},
): UseDialogResult<T> {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const payloadRef = useRef<T | undefined>(undefined);
  const opts = useRef(options);
  opts.current = options;

  // The same distinction, but held until the kit's EXIT lands rather than
  // being consumed by the next effect pass.
  //
  // `bookkeeping` is read by a layout effect on the close tick, which was
  // enough while onClose ran there too. It no longer does — the teardown waits
  // for the exit animation now — and a suspend's exit callback arrives long
  // after that pass, with the screenshot round trip still in progress. Without
  // this the feedback dialog's draft would be reset out from under the
  // screenshot it is being attached to, which is the exact bug suspend/resume
  // exists to prevent.
  const suspended = useRef(false);

  const open = useCallback((payload?: T) => {
    payloadRef.current = payload;
    // An ordinary open ends any suspension: whatever the round trip was, this
    // presentation is a fresh one and owns its own teardown.
    suspended.current = false;
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    if (opts.current.canClose && !opts.current.canClose()) return;
    setIsOpen(false);
  }, []);

  // A visibility change that is bookkeeping rather than a lifecycle event —
  // see DialogController.suspend. The flag is consumed by the single effect
  // pass it schedules, so an ordinary open/close either side of it still runs
  // its half.
  const bookkeeping = useRef(false);
  const suspend = useCallback(() => {
    bookkeeping.current = true;
    suspended.current = true;
    setIsOpen(false);
  }, []);
  const resume = useCallback(() => {
    bookkeeping.current = true;
    suspended.current = false;
    setIsOpen(true);
  }, []);

  // The live open state, readable from a callback that fires outside React's
  // render cycle — the kit's exit lands up to 300ms after the close.
  const openRef = useRef(false);
  openRef.current = isOpen;

  useStaticModal(rootRef, isOpen, {
    onKitDismiss: close,
    // The card stays on screen for the whole exit animation now, so teardown
    // that empties it has to wait for the end of that animation rather than
    // running on the close tick — otherwise the dialog visibly blanks while it
    // is still sliding away. See StaticModalOptions.onExited.
    onExited: () => {
      // Reopened while the exit was still playing: onOpen has already
      // repopulated the card, and this teardown belongs to the presentation it
      // replaced. Running it would wipe what the viewer is now looking at.
      if (openRef.current) return;
      // Mid-round-trip (a screenshot capture): the dialog is coming back with
      // its draft intact, so this close is bookkeeping and has no teardown.
      if (suspended.current) return;
      opts.current.onClose?.();
    },
    // A `public/js/**` straggler wrote `hidden` directly. Mirror it into
    // state so React, the kit and the DOM cannot disagree — see
    // StaticModalOptions.onExternalToggle.
    onExternalToggle: (nowOpen) => setIsOpen(nowOpen),
  });

  // Populate on the way in. Skips the mount pass: `isOpen` starts false and
  // the prerendered markup is already hidden, so there is no stale open.
  //
  // Layout, and declared after `useStaticModal` above, so the order within a
  // single pass is: reveal → lift into the kit shell → populate. A passive
  // effect would paint the previous open's values for a frame first.
  //
  // The matching `onClose` is NOT here any more: it emptied the card on the
  // close tick, which was invisible only for as long as the card was yanked
  // out of sight on that same tick. It rides the exit now, so its teardown
  // runs from `onExited` above.
  const mounted = useRef(false);
  useIsomorphicLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (bookkeeping.current) {
      bookkeeping.current = false;
      return;
    }
    if (isOpen) opts.current.onOpen?.(payloadRef.current);
  }, [isOpen]);

  const backdropProps = useMemo(
    () => ({
      onClick: (event: MouseEvent<HTMLElement>) => {
        const target = event.target as HTMLElement;
        const isBackdrop =
          target === event.currentTarget || target.dataset?.modalBackdrop !== undefined;
        if (!isBackdrop) return;
        if (isDismissGuarded(rootRef.current)) return;
        close();
      },
    }),
    [close],
  );

  // Publish the controller for `public/js/**`. The legacy entry points
  // (`App.showCreateModal`, `AppView.promptRename`, …) forward here.
  const controller = useMemo<DialogController<T>>(
    () => ({
      isOpen: () => !!rootRef.current && !rootRef.current.classList.contains('hidden'),
      open,
      close,
      suspend,
      resume,
    }),
    [open, close, suspend, resume],
  );
  useEffect(() => {
    const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
    const bridge = (host.UsernodeReact ||= {});
    const dialogs = (bridge.dialogs ||= {}) as Record<string, unknown>;
    dialogs[name] = controller;
    return () => {
      if (dialogs[name] === controller) delete dialogs[name];
    };
  }, [name, controller]);

  return { rootRef, isOpen, open, close, suspend, resume, backdropProps };
}
