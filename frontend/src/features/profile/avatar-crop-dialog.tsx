import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * "Position your photo": the step between choosing a profile photo and
 * staging it (#3525).
 *
 * The request, in the reporter's words: "pop something up that you set a
 * photo to a blank area, and then can drag around to choose the visible
 * part, before accepting". Picking a file used to stage the largest centred
 * square straight away (Profile._prepareAvatar), so the first sign of what
 * the circle would show was the circle itself, and the only way to change it
 * was to edit the file elsewhere. Now the file opens here first: a square
 * frame with the circle every avatar is drawn in marked on it, the photo
 * inside it to drag and zoom, and Use photo / Cancel. Nothing is staged until
 * Use photo, and nothing is uploaded until the editor's own Save, which the
 * copy says, because that second step was the other half of "more clarity".
 *
 * ── Why a second kit modal, and what that costs ───────────────────────
 *
 * It is presented the way the editor under it is (./profile-edit-sheet.tsx):
 * rendered in place, then its card handed to `PlatformUI.modal` through
 * lib/kit-surface.ts, with the no-kit fallback being the markup where React
 * put it. That keeps the three ways out the viewer already knows from every
 * other dialog, each meaning Cancel here: the kit's backdrop and Escape (it
 * dismisses only the topmost modal, and this one is presented last) and the
 * device Back, whose claim Profile.beginAvatarCrop takes above the editor's.
 *
 * Two things follow from stacking it over another kit modal:
 *
 *   * **The editor underneath is `inert` while this is up**, and the editor
 *     sets that, not this file. The kit's backdrop sits at z-index 9990 and
 *     its modal cards at 9992, so this modal's backdrop is BELOW the
 *     editor's card: lib/overlay-scrim.js dims it with a paint layer that
 *     never hit-tests, and without `inert` a tap on the dimmed Save button
 *     would still land.
 *   * **Its root renders AFTER the editor's card**, as the last child of
 *     `#profile-edit-root`. The card has been lifted into the kit and a
 *     comment holds its place, so React inserting a sibling BEFORE it would
 *     `insertBefore` against a node that is not there. Appending is safe.
 *
 * The same three constraints as the editor's own lift hold here, for the same
 * reasons: the root's and the card's `className` are constants (the kit
 * writes `platform-modal-adopted` and `platform-modal-card` through
 * classList), the card goes home in the layout-effect cleanup before React
 * unmounts it, and the root is the flagged node while the card is the lifted
 * one.
 *
 * ── The drag surface inside a scrolling modal ─────────────────────────
 *
 * `.un-modal` is a real scroller, and the kit has no swipe-to-dismiss on a
 * modal (only the bottom sheet has one). So the frame only has to keep the
 * browser from treating a drag on it as a scroll or a page zoom:
 * `touch-none` on the frame and nowhere else, so the rest of the card still
 * scrolls on a short phone. A drag that ends over the backdrop does not
 * dismiss: the kit dismisses on a CLICK that starts on the backdrop, and the
 * frame holds pointer capture for the whole gesture.
 *
 * It joins the kit's gesture arbiter the way the Needs-you swipe does
 * (features/dev-board/workshop/workshop.tsx): it claims the finger once the
 * press has moved, never on the press itself, so a tap on the frame is still
 * a tap (it focuses the frame for the arrow keys), and it lets go of the
 * press if a kit recognizer already owns it. There is no axis to decide
 * here, so the lock is a few pixels rather than the swipe's ten.
 *
 * ── What each input does ──────────────────────────────────────────────
 *
 * One finger or the mouse drags; two fingers pinch about their midpoint and
 * drag with it; the wheel (or a trackpad's pinch, which arrives as a wheel
 * with ctrlKey) zooms about the pointer; the slider zooms about the centre;
 * with the frame focused, the arrow keys move the photo (Shift for a bigger
 * step) and + / − zoom. All of it goes through ./avatar-crop.ts, which keeps
 * the square inside the photo whatever the input asks for.
 *
 * The state is this component's. A pointer move re-renders the dialog and
 * nothing else: the editor under it receives no new props while a drag runs.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { PhotoIcon, SpinnerArcIcon } from '@/components/ui/icons';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import {
  CROP_MAX_ZOOM,
  initialCrop,
  nudgeCrop,
  panCrop,
  photoPlacement,
  zoomCrop,
  zoomOf,
  type CropRect,
} from './avatar-crop';

/** What the step shows: the chosen file's object URL and its decoded size. */
export interface CropSource {
  url: string;
  width: number;
  height: number;
}

/**
 * The no-kit presentation: a dim over the page with the card centred on it.
 * Constant, because `platform-modal-adopted` lands here while the kit has the
 * card, and hides it.
 */
const ROOT_CLASS = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60';

/**
 * The frame. `touch-none` is the one line that keeps a drag here from
 * scrolling the modal (see above); `select-none` keeps a mouse drag from
 * starting a text selection in the card. At most 18rem across, and less on a
 * short screen (42dvh), so Use photo is still on screen without scrolling on
 * a 568px-tall phone.
 */
const STAGE_CLASS = 'relative w-full max-w-[min(18rem,42dvh)] mx-auto aspect-square overflow-hidden rounded-2xl '
  + 'bg-zinc-200 dark:bg-zinc-800 touch-none select-none cursor-grab data-[dragging]:cursor-grabbing '
  + 'outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 '
  + 'dark:focus-visible:ring-offset-zinc-900';

/** The press has to move this far before it is a drag rather than a tap. */
const DRAG_LOCK_PX = 3;

/** How far one wheel "line" or pixel zooms: e^(-delta × this). */
const WHEEL_ZOOM_PER_PX = 0.002;
const WHEEL_ZOOM_PER_LINE = 0.05;

/** The kit's gesture arbiter, through PlatformUI; null where the kit is not loaded. */
type GestureArbiter = { claim: (seq: string | number, token: unknown) => boolean };
function gestureArbiter(): GestureArbiter | null {
  const ui = (typeof window !== 'undefined'
    ? (window as unknown as { PlatformUI?: { gestures?: () => GestureArbiter | null } }).PlatformUI
    : undefined);
  try {
    const g = ui && typeof ui.gestures === 'function' ? ui.gestures() : null;
    return g && typeof g.claim === 'function' ? g : null;
  } catch {
    return null;
  }
}
const CROP_GESTURE_TOKEN = 'profile-photo-crop';

type Point = { x: number; y: number };

export function AvatarCropDialog({ source, onAccept, onCancel }: {
  source: CropSource;
  /** Stage the square. Resolves once the editor has it (or has said why not). */
  onAccept: (crop: CropRect) => Promise<void>;
  onCancel: () => void;
}): ReactNode {
  useUiLanguage();
  const { width, height } = source;
  const [crop, setCrop] = useState<CropRect>(() => initialCrop(width, height));
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // The latest square, for the handlers that read it outside a render.
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // The gesture in flight: every pointer that is down and where it last was,
  // where the first one went down, whether the arbiter gave us the finger,
  // and a pinch's starting spread and zoom.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; claimed: boolean } | null>(null);
  const pinch = useRef<{ spread: number; zoom: number; mid: Point } | null>(null);

  // Hand the card to the kit, exactly once, and put it back before React
  // removes it. Mirrors the editor's own adoption, including the rule that a
  // dismissal the kit reports AFTER our own teardown is ignored.
  useIsomorphicLayoutEffect(() => {
    const contentEl = cardRef.current;
    const flagEl = rootRef.current;
    if (!contentEl || !flagEl) return;
    // The kit focuses `[autofocus]` when the card is presented, else the card
    // itself. The frame is where the arrow keys work, so it is the one. Set
    // as an attribute because React's `autoFocus` focuses on mount instead,
    // and the lift that follows would take that focus straight away again.
    stageRef.current?.setAttribute('autofocus', '');
    let adoption: KitAdoption | null = null;
    adoption = adoptKitSurface({
      kind: 'modal',
      contentEl,
      adoptedOn: flagEl,
      home: 'placeholder',
      gate: 'kit',
      hugDesignWidth: true,
      // The backdrop or Escape: Cancel.
      onDismiss: () => {
        if (!adoption) return;
        adoption = null;
        onCancelRef.current();
      },
    });
    // The kit's shell is the dialog now (role="dialog", aria-modal), and it
    // has no name of its own. The kit owns that node, not React, so writing
    // to it is not a second owner of anything React renders.
    const shell = adoption?.handle.el;
    if (shell) {
      shell.setAttribute('aria-labelledby', 'profile-photo-crop-title');
      shell.setAttribute('aria-describedby', 'profile-photo-crop-help');
    }
    if (!adoption) stageRef.current?.focus({ preventScroll: true });
    return () => {
      if (!adoption) return;
      const handle = adoption;
      adoption = null;
      handle.release();
    };
  }, []);

  // The wheel, bound by hand: React's onWheel is passive, and a wheel over
  // the frame must zoom the photo rather than scroll the card.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      if (!(rect.width > 0)) return;
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? WHEEL_ZOOM_PER_LINE : WHEEL_ZOOM_PER_PX));
      setCrop((c) => zoomCrop(c, zoomOf(c, width, height) * factor, width, height, fx, fy));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [width, height]);

  const endGesture = () => {
    pointers.current.clear();
    gesture.current = null;
    pinch.current = null;
    setDragging(false);
  };

  const beginPinch = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    pinch.current = {
      spread: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      zoom: zoomOf(cropRef.current, width, height),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const stage = e.currentTarget;
    try { stage.setPointerCapture(e.pointerId); } catch { /* still tracked while over the frame */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture.current) gesture.current = { start: { x: e.clientX, y: e.clientY }, claimed: false };
    if (pointers.current.size === 2) beginPinch();
    // A tap is how a mouse or a keyboard user gets the arrow keys here.
    if (document.activeElement !== stage) stage.focus({ preventScroll: true });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(e.pointerId);
    const g = gesture.current;
    if (!last || !g) return;
    const next = { x: e.clientX, y: e.clientY };
    if (!g.claimed) {
      if (pointers.current.size < 2
        && Math.hypot(next.x - g.start.x, next.y - g.start.y) < DRAG_LOCK_PX) return;
      // The lock: claim the finger now, as the kit asks of an app gesture,
      // and let go of the press if a kit recognizer already has it.
      const arbiter = gestureArbiter();
      const seq = e.pointerType === 'touch' ? 'touch' : e.pointerId;
      if (arbiter && !arbiter.claim(seq, CROP_GESTURE_TOKEN)) { endGesture(); return; }
      g.claimed = true;
      setDragging(true);
    }
    pointers.current.set(e.pointerId, next);
    const frame = e.currentTarget.clientWidth;
    const p = pinch.current;
    if (p && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const rect = e.currentTarget.getBoundingClientRect();
      const fx = rect.width > 0 ? (mid.x - rect.left) / rect.width : 0.5;
      const fy = rect.height > 0 ? (mid.y - rect.top) / rect.height : 0.5;
      const zoom = p.zoom * (spread / p.spread);
      const dx = mid.x - p.mid.x;
      const dy = mid.y - p.mid.y;
      p.mid = mid;
      setCrop((c) => panCrop(zoomCrop(c, zoom, width, height, fx, fy), dx, dy, frame, width, height));
      return;
    }
    const dx = next.x - last.x;
    const dy = next.y - last.y;
    setCrop((c) => panCrop(c, dx, dy, frame, width, height));
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    // Down to one finger: it carries on dragging from where it is.
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) endGesture();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (busy || e.altKey || e.ctrlKey || e.metaKey) return;
    const next = nudgeCrop(cropRef.current, e.key, width, height, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    setCrop(next);
  };

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onAccept(cropRef.current);
    } finally {
      // Usually unmounted by now; a no-op then.
      setBusy(false);
    }
  };

  const zoom = zoomOf(crop, width, height);
  const placement = photoPlacement(crop, width, height);

  return (
    // `role="dialog"` on the ROOT: it is the dialog only in the no-kit
    // fallback. Adopted, the root is `display: none` and the kit's shell,
    // labelled above, is the dialog; a role on the card would nest a second.
    <div
      id="profile-photo-crop"
      ref={rootRef}
      className={ROOT_CLASS}
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-photo-crop-title"
      aria-describedby="profile-photo-crop-help"
    >
      <DialogCard id="profile-photo-crop-card" ref={cardRef}>
        <h2 id="profile-photo-crop-title" className="text-lg font-bold"><Message id="account:position_your_photo_34aa480b" /></h2>
        <p id="profile-photo-crop-help" className="mt-1 mb-4 text-sm text-zinc-600 dark:text-zinc-400"><Message id="account:drag_to_choose_the_part_of_your_photo_that_shows_7f6716a1" /></p>

        <Localized element={<div
          id="profile-photo-crop-stage"
          ref={stageRef}
          className={STAGE_CLASS}
          tabIndex={0}
          // `application`, so a screen reader in browse mode hands the arrow
          // keys to the frame instead of reading the next line with them.
          role="application"
          aria-roledescription="photo position" aria-label={catalogText("account:photo_position_drag_to_move_the_photo_or_use_the_8ad65b57")}
          data-dragging={dragging ? '' : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
          onKeyDown={onKeyDown}
        >
          <img
            src={source.url}
            alt=""
            draggable={false}
            className="absolute max-w-none pointer-events-none select-none"
            style={placement}
          />
          {/*
              The circle every avatar is drawn in, over the square that is
              uploaded: the corners outside it are dimmed rather than hidden,
              because a few places draw the photo as a rounded square.
          */}
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-full pointer-events-none border-2 border-white/90 shadow-[0_0_0_999px_rgb(0_0_0/0.45)]"
          />
        </div>} messages={{"aria-label":"account:photo_position_drag_to_move_the_photo_or_use_the_8ad65b57"}} />

        <div className="mt-4 flex items-center gap-3">
          <PhotoIcon aria-hidden="true" className="w-4 h-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
          <Localized element={<input
            id="profile-photo-zoom"
            type="range"
            min={1}
            max={CROP_MAX_ZOOM}
            step={0.01}
            value={zoom} aria-label={catalogText("account:zoom_509c517e")}
            aria-valuetext={`${Math.round(zoom * 100)}%`}
            disabled={busy}
            className="flex-1 min-w-0 h-11 accent-violet-600"
            onChange={(e) => {
              const next = Number(e.target.value);
              setCrop((c) => zoomCrop(c, next, width, height));
            }}
          />} messages={{"aria-label":"account:zoom_509c517e"}} />
          <PhotoIcon aria-hidden="true" className="w-6 h-6 shrink-0 text-zinc-500 dark:text-zinc-400" />
        </div>

        <div className="mt-4 flex gap-3">
          <Button
            type="button"
            id="profile-photo-cancel"
            layout="flex"
            variant="neutral"
            ink="neutral"
            className="min-h-[44px]"
            onClick={() => onCancel()}
          ><Message id="account:cancel_19766ed6" /></Button>
          <Button
            type="button"
            id="profile-photo-use"
            layout="flex"
            disabledStyle="dim60"
            className="min-h-[44px]"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => { void accept(); }}
          >
            {busy ? <SpinnerArcIcon className="inline-block h-4 w-4 mr-2 -mt-0.5 align-middle animate-spin" aria-hidden="true" /> : null}
            <LocalizedValue render={() => (busy ? tr("account:preparing_5d1fa38b") : tr("account:use_photo_66a0773a"))} />
          </Button>
        </div>
      </DialogCard>
    </div>
  );
}
