/**
 * The change page's hero: the after and the before of one screen, one over
 * the other, with a seam between them. Ported from the title-shots factory
 * prototype (the "restrained slider"), with its tuned values fixed:
 *
 * - At rest the seam sits on the left edge: the whole window is After.
 * - Each side carries its own caption, printed on it in the title cards'
 *   mono capitals ("◷ Before · Today", "If it passes · After ✦"). The seam
 *   wipes a caption with its picture, so what is printed is what you see and
 *   nothing has to light up.
 * - Drag anywhere sideways to move the seam. Past an edge it resists the way
 *   iOS does (rubber band); near the edges of what changed it settles softly
 *   (soft stops); a quick flick goes all the way.
 * - The small switch at the bottom centre flips the whole view: Before on
 *   its left, After on its right, its knob on the side most of the window
 *   shows (it changes at 60/40, not 50/50, so it never flickers). A press
 *   leans the seam in, so the switch shows it slides before it is let go.
 * - Each side keeps its colour while it holds at least half the window and
 *   fades to grey below that, so the eye goes to the side being looked at.
 * - Hold the shot still for a moment and a round magnifier opens under the
 *   finger, showing what is there at about two and a half times its size. It
 *   follows the finger until you let go; the seam does not move while it is
 *   open.
 *
 * - Opened from the sheet, the change page hands it its framing (`place`)
 *   and the change to light: for a moment everything else on the screen is
 *   dimmed round one hard-edged hole (`veil`), drawn on each side's own
 *   picture so it rides every move and the seam wipes it with its side. Any
 *   touch on the picture ends it (`onTouch`).
 * - The after side's close-ups (denser stills of small parts of it) are
 *   laid over its screen still where they belong, so a change opened from
 *   a close-up plate, or held under the magnifier, stays sharp.
 *
 * Arrow keys move the seam, Enter or Space flips.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

import { HistoryIcon, SparklesIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import {
  densityOf, focusBox, magnet, placeBox, rubberBand, seamStops,
  type Box, type Placement, type ReviewScreen,
} from './model';

const SWITCH_AT = 0.6;
/** How far a press on the switch leans the seam in, as a share of the window. */
const LEAN = 0.08;
const FLICK = 700;
const SNAP = 24;
/** Holding still this long opens the magnifier; moving further than the slop cancels it. */
const HOLD_TO_ZOOM = 300;
const HOLD_SLOP = 6;
const LENS_ZOOM = 2.5;
const LENS_D = 132;
/** The gap between a touch point and the magnifier's lower edge. */
const LENS_LIFT = 24;

const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);

/** Full colour while a side holds at least half the window, grey toward none. */
export function saturationFor(share: number): number {
  return Math.max(0, Math.min(1, share / 0.5));
}

/** The pill's word, with hysteresis: it only changes once 60% shows the other side. */
export function viewFor(share: number, current: 'after' | 'before'): 'after' | 'before' {
  if (current === 'after' && share >= SWITCH_AT) return 'before';
  if (current === 'before' && share <= 1 - SWITCH_AT) return 'after';
  return current;
}

/**
 * The placement for the magnifier's inner layer: the window point `point`
 * lands at the circle's centre with the picture `zoom` times its drawn size,
 * so the magnifier shows the same picture as the slider, larger.
 */
export function lensPlace(place: Placement | null, point: { x: number; y: number }, zoom: number, d: number): Placement {
  const p = place || { scale: 1, tx: 0, ty: 0 };
  return {
    scale: p.scale * zoom,
    tx: d / 2 - (point.x - p.tx) * zoom,
    ty: d / 2 - (point.y - p.ty) * zoom,
  };
}

/**
 * The magnifier's top-left in the window: centred on `point`, raised by
 * `d / 2 + lift` for a finger, and kept whole inside the window.
 */
export function lensBox(point: { x: number; y: number }, size: { w: number; h: number }, d: number, lift = 0): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(size.w - d, point.x - d / 2)),
    y: Math.max(0, Math.min(size.h - d, point.y - d / 2 - (lift > 0 ? d / 2 + lift : 0))),
  };
}

export function CompareSlider({ screen, pair, ground, width, height, marks, near = true, place: given = null, veil = null, onTouch }: {
  screen: ReviewScreen | null;
  /** An older change's capture pair, with no regions: drawn whole. */
  pair?: { before: string | null; after: string | null } | null;
  ground: string;
  width: number;
  height: number;
  /** Whether the captions and the switch show (they arrive a moment after the page lands). */
  marks: boolean;
  /** Load the images (false while the page is still far away). */
  near?: boolean;
  /** Where the screen sits, when the page has framed it (model.ts openPlace). */
  place?: Placement | null;
  /** The landing dim: the hole it leaves, in screen points, and whether it shows. */
  veil?: { cut: Box | null; on: boolean } | null;
  /** A touch on the picture or the switch (it ends the landing dim). */
  onTouch?: () => void;
}) {
  const t = useMessages('communities');
  const W = width;
  const before = screen ? screen.before.url : pair?.before || null;
  const after = screen ? screen.after.url : pair?.after || null;
  const canCompare = !!before && !!after;

  const place: Placement | null = screen && W > 0
    ? given || placeBox(screen, focusBox(screen, ['before', 'after'], 16), { w: W, h: height }, densityOf(screen))
    : null;
  const stops = screen && place ? seamStops(screen, place, W) : [];

  // The seam's x in the window: 0 is all After.
  const [pos, setPos] = useState(0);
  const [view, setView] = useState<'after' | 'before'>('after');
  const [dragging, setDragging] = useState(false);
  const [pressed, setPressed] = useState(false);
  const posRef = useRef(0);
  const anim = useRef(0);
  // Where the seam was when a press on the switch leaned it in.
  const leanFrom = useRef<number | null>(null);
  // The magnifier: its point in the window, and whether a finger (not a
  // mouse) put it there, so it can be raised clear of the fingertip.
  const [lens, setLens] = useState<{ x: number; y: number; touch: boolean } | null>(null);
  const lensRef = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  const zoomTimer = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const putLens = useCallback((at: { x: number; y: number; touch: boolean } | null) => {
    lensRef.current = at;
    setLens(at);
  }, []);

  // While a flip glides, the knob keeps the side it was sent to.
  const pinned = useRef(false);
  const put = useCallback((x: number) => {
    posRef.current = x;
    setPos(x);
    if (!pinned.current) setView((v) => viewFor(Math.max(0, Math.min(1, x / Math.max(1, W))), v));
  }, [W]);

  // A new screen starts at rest.
  useLayoutEffect(() => {
    cancelAnimationFrame(anim.current);
    clearTimeout(zoomTimer.current);
    posRef.current = 0; setPos(0); setView('after'); setPressed(false);
    leanFrom.current = null; pinned.current = false;
    putLens(null);
  }, [before, after, putLens]);
  useEffect(() => () => { cancelAnimationFrame(anim.current); clearTimeout(zoomTimer.current); }, []);

  // `touch-action` is fixed when a touch starts, so scrolling is held off
  // with a native listener while the magnifier is open.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const hold = (e: TouchEvent) => { if (lensRef.current) e.preventDefault(); };
    el.addEventListener('touchmove', hold, { passive: false });
    return () => el.removeEventListener('touchmove', hold);
  }, []);

  const glide = useCallback((to: number, ms = 300, done?: () => void) => {
    cancelAnimationFrame(anim.current);
    const from = posRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      put(from + (to - from) * easeOut(p));
      if (p < 1) anim.current = requestAnimationFrame(step);
      else done?.();
    };
    anim.current = requestAnimationFrame(step);
  }, [put]);

  /* ── Drag ── */
  const drag = useRef<{ id: number; x0: number; y0: number; from: number; live: boolean; lastX: number; lastT: number; v: number } | null>(null);
  const pointAt = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    onTouch?.();
    if (!marks || !near || (!before && !after) || (e.target as HTMLElement).closest('[data-rf-switch]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancelAnimationFrame(anim.current);
    pinned.current = false;
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from: posRef.current, live: false, lastX: e.clientX, lastT: performance.now(), v: 0 };
    const id = e.pointerId;
    const from = pointAt(e);
    const touch = e.pointerType === 'touch';
    clearTimeout(zoomTimer.current);
    // With one side there is a hold to magnify, but the move handler never
    // lets the gesture go live as a drag.
    zoomTimer.current = window.setTimeout(() => {
      const d = drag.current;
      if (!d || d.id !== id || d.live || lensRef.current) return;
      putLens({ x: from.x, y: from.y, touch });
      try { rootRef.current?.setPointerCapture(id); } catch { /* fine */ }
    }, HOLD_TO_ZOOM);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (lensRef.current) {
      const p = pointAt(e);
      putLens({ x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(height, p.y)), touch: lensRef.current.touch });
      return;
    }
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.live) {
      if (Math.hypot(dx, dy) > HOLD_SLOP) clearTimeout(zoomTimer.current);
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { clearTimeout(zoomTimer.current); drag.current = null; return; }
      if (Math.abs(dx) < 6) return;
      if (!canCompare) return;
      d.live = true;
      setDragging(true);
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* fine */ }
    }
    const now = performance.now();
    d.v = ((e.clientX - d.lastX) / Math.max(1, now - d.lastT)) * 1000;
    d.lastX = e.clientX; d.lastT = now;
    let x = d.from + dx;
    if (x < 0) x = rubberBand(x, W);
    else if (x > W) x = W + rubberBand(x - W, W);
    else x = magnet(x, stops);
    put(x);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    clearTimeout(zoomTimer.current);
    if (lensRef.current) {
      putLens(null);
      drag.current = null;
      try { rootRef.current?.releasePointerCapture(e.pointerId); } catch { /* fine */ }
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || !d.live) return;
    setDragging(false);
    const x = posRef.current;
    let target = Math.max(0, Math.min(W, x));
    if (Math.abs(d.v) > FLICK) target = d.v > 0 ? W : 0;
    else {
      const all = [0, W, ...stops];
      const near = all.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a), all[0]);
      if (Math.abs(near - x) < SNAP) target = near;
    }
    glide(target, 280);
  };

  /* ── The switch: a press leans the seam in, a tap flips ── */
  const flip = () => {
    if (!canCompare) return;
    onTouch?.();
    const from = leanFrom.current ?? posRef.current;
    leanFrom.current = null;
    setPressed(false);
    const to = from > W / 2 ? 0 : W;
    // The knob says where the view is going at once; the seam glides there.
    pinned.current = true;
    setView(to > 0 ? 'before' : 'after');
    glide(to, 320, () => { pinned.current = false; });
  };
  const switchDown = () => {
    if (!canCompare) return;
    leanFrom.current = posRef.current;
    setPressed(true);
    glide(posRef.current > W / 2 ? posRef.current - W * LEAN : posRef.current + W * LEAN, 140);
  };
  // Let go off the switch, or the press was taken away: the seam goes back.
  const switchLeave = () => {
    if (leanFrom.current == null) return;
    const back = leanFrom.current;
    leanFrom.current = null;
    setPressed(false);
    glide(back, 160);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!canCompare || (e.target as HTMLElement).closest('[data-rf-switch]')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = W * 0.05 * (e.key === 'ArrowRight' ? 1 : -1);
      glide(Math.max(0, Math.min(W, posRef.current + step)), 160);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault(); glide(e.key === 'Home' ? 0 : W, 200);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); flip();
    }
  };

  const clamped = Math.max(0, Math.min(W, pos));
  const share = W ? clamped / W : 0;
  const shown = clamped;
  const satBefore = saturationFor(shown / Math.max(1, W));
  const satAfter = saturationFor(1 - shown / Math.max(1, W));
  const word = view;

  const lensSide: 'before' | 'after' = canCompare
    ? (lens && lens.x < shown ? 'before' : 'after')
    : (after ? 'after' : 'before');
  const lensPlacement = lens ? lensPlace(place, lens, LENS_ZOOM, LENS_D) : null;
  const lensAt = lens ? lensBox(lens, { w: W, h: height }, LENS_D, lens.touch ? LENS_LIFT : 0) : null;

  const layerStyle = (sat: number): CSSProperties => (place
    ? { width: screen!.width, transform: `translate(${place.tx}px, ${place.ty}px) scale(${place.scale})`, transformOrigin: '0 0', filter: sat >= 0.999 ? 'none' : `grayscale(${(1 - sat).toFixed(3)})` }
    : { width: '100%', filter: sat >= 0.999 ? 'none' : `grayscale(${(1 - sat).toFixed(3)})` });

  // The dim rides the layer's own transform, so it is on from the first frame
  // of a move and never trails it; it comes on at once and fades out.
  const veilAt = veil && veil.cut && place && screen ? (
    <span
      className="rf-veil-box"
      style={{ width: screen.width, height: Math.max(screen.before.height, screen.after.height), opacity: veil.on ? 1 : 0, transition: veil.on ? 'none' : undefined }}
      aria-hidden="true"
    >
      <span className="rf-veil" style={{ left: veil.cut.x, top: veil.cut.y, width: veil.cut.w, height: veil.cut.h, borderRadius: 10 / place.scale }} />
    </span>
  ) : null;

  const closeups = (which: 'before' | 'after') => (which === 'after' && near && place && screen && screen.closeups
    ? screen.closeups.map((c) => (
      <img key={c.url} src={c.url} alt="" draggable={false} className="rf-closeup" style={{ left: c.rect.x, top: c.rect.y, width: c.rect.w, height: c.rect.h }} />
    ))
    : null);

  const img = (url: string | null, which: 'before' | 'after') => (url && near ? (
    <img
      src={url}
      alt={which === 'after' ? t('communities:review.alt.after') : t('communities:review.alt.before')}
      draggable={false}
      className={place ? 'rf-shot-img' : 'rf-shot-img rf-shot-whole'}
      style={place ? { width: screen!.width, height: which === 'after' ? screen!.after.height : screen!.before.height } : undefined}
    />
  ) : null);

  return (
    <div
      ref={rootRef}
      className={`rf-compare${dragging ? ' rf-dragging' : ''}${canCompare ? '' : ' rf-compare-still'}`}
      style={{ width: W, height, background: ground }}
      role={canCompare ? 'slider' : 'img'}
      aria-label={canCompare ? t('communities:review.compare.label') : t('communities:review.alt.after')}
      aria-valuemin={canCompare ? 0 : undefined}
      aria-valuemax={canCompare ? 100 : undefined}
      aria-valuenow={canCompare ? Math.round(share * 100) : undefined}
      aria-valuetext={canCompare ? t(word === 'after' ? 'communities:review.compare.showingAfter' : 'communities:review.compare.showingBefore') : undefined}
      tabIndex={canCompare ? 0 : -1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      data-rf-compare=""
    >
      <div className="rf-layer" style={layerStyle(satAfter)} aria-hidden="true" data-rf-cam="">{img(after || before, after ? 'after' : 'before')}{closeups(after ? 'after' : 'before')}{veilAt}</div>
      {canCompare ? (
        <div className="rf-cap rf-cap-after" style={{ opacity: marks ? 1 : 0 }} aria-hidden="true">
          <span className="rf-cap-line">
            <RichMessage id="communities:review.compare.captionAfter" components={[<span className="rf-cap-dim" />]} />
            <SparklesIcon width={13} height={13} strokeWidth="2" />
          </span>
        </div>
      ) : null}
      {canCompare ? (
        <div className="rf-layer-clip" style={{ clipPath: `inset(0 ${(W - shown).toFixed(2)}px 0 0)` }} aria-hidden="true">
          <div className="rf-layer" style={layerStyle(satBefore)} data-rf-cam="">{img(before, 'before')}{veilAt}</div>
          <div className="rf-cap rf-cap-before" style={{ opacity: marks ? 1 : 0 }}>
            <span className="rf-cap-line">
              <HistoryIcon width={13} height={13} strokeWidth="2.2" />
              <RichMessage id="communities:review.compare.captionBefore" components={[<span className="rf-cap-dim" />]} />
            </span>
          </div>
        </div>
      ) : null}
      {canCompare ? (
        <>
          <span className="rf-seam" style={{ transform: `translateX(${shown.toFixed(2)}px)`, opacity: marks ? 1 : 0 }} aria-hidden="true" />
          <button
            type="button"
            className={pressed ? 'rf-switch rf-switch-pressed' : 'rf-switch'}
            data-rf-switch=""
            data-view={word}
            role="switch"
            aria-checked={word === 'before'}
            aria-label={t('communities:review.compare.switch')}
            style={{ opacity: marks ? 1 : 0 }}
            onPointerDown={switchDown}
            onPointerLeave={switchLeave}
            onPointerCancel={switchLeave}
            onContextMenu={(e) => e.preventDefault()}
            onClick={flip}
          >
            <span className="rf-switch-mark rf-switch-mark-before" aria-hidden="true"><HistoryIcon width={14} height={14} strokeWidth="2.2" /></span>
            <span className="rf-switch-mark rf-switch-mark-after" aria-hidden="true"><SparklesIcon width={14} height={14} strokeWidth="2" /></span>
            <span className="rf-knob" aria-hidden="true">
              <span className="rf-knob-icon rf-knob-before"><HistoryIcon width={16} height={16} strokeWidth="2.2" /></span>
              <span className="rf-knob-icon rf-knob-after"><SparklesIcon width={16} height={16} strokeWidth="2" /></span>
            </span>
          </button>
        </>
      ) : null}
      {lens && lensAt && lensPlacement ? (
        <span
          className="rf-lens"
          aria-hidden="true"
          style={{ transform: `translate(${lensAt.x.toFixed(2)}px, ${lensAt.y.toFixed(2)}px)`, background: ground }}
        >
          <span
            className="rf-layer"
            style={{
              width: place ? screen!.width : W,
              transform: `translate(${lensPlacement.tx.toFixed(2)}px, ${lensPlacement.ty.toFixed(2)}px) scale(${lensPlacement.scale})`,
              transformOrigin: '0 0',
            }}
          >
            {img(lensSide === 'after' ? after || before : before, lensSide)}
            {closeups(lensSide)}
          </span>
        </span>
      ) : null}
    </div>
  );
}
