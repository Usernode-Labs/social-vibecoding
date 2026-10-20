/**
 * The change page's hero: the after and the before of one screen, one over
 * the other, with a seam between them. Ported from the title-shots factory
 * prototype (the "restrained slider"), with its tuned values fixed:
 *
 * - At rest the seam sits on the left edge: the whole window is After. A
 *   black ›› handle hugs that edge.
 * - Drag anywhere sideways to move the seam. Past an edge it resists the way
 *   iOS does (rubber band); near the edges of what changed it settles softly
 *   (soft stops); a quick flick goes all the way. While it moves, the handle
 *   fades and the line thins, so the picture has the room.
 * - The pill at the bottom centre (where a thumb on it hides the least of
 *   the shot) names what most of the window shows (it
 *   changes at 60/40, not 50/50, so it never flickers). Its dark part is a
 *   little map of the seam. Tap it to flip the whole view at once; only the
 *   handle travels, a moment later, so tapping again and again to compare
 *   is calm. Hold it to peek at the other side.
 * - Each side keeps its colour while it holds at least half the window and
 *   fades to grey below that, so the eye goes to the side being looked at.
 *
 * Arrow keys move the seam, Enter or Space flips.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

import { ChevronDoubleLeftIcon, ChevronDoubleRightIcon, GripBarsIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import {
  focusBox, magnet, placeBox, rubberBand, seamStops,
  type Placement, type ReviewScreen,
} from './model';

const TAB_W = 30;
const TAB_H = 60;
const SWITCH_AT = 0.6;
const HANDLE_DELAY = 350;
const HOLD_TO_PEEK = 180;
const FLICK = 700;
const SNAP = 24;

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

function Chevrons({ dir }: { dir: 'right' | 'left' | 'bars' }) {
  const Glyph = dir === 'bars' ? GripBarsIcon : dir === 'right' ? ChevronDoubleRightIcon : ChevronDoubleLeftIcon;
  return <Glyph width={18} height={18} strokeWidth="2.2" aria-hidden="true" />;
}

export function CompareSlider({ screen, pair, ground, width, height, marks, near = true }: {
  screen: ReviewScreen | null;
  /** An older change's capture pair, with no regions: drawn whole. */
  pair?: { before: string | null; after: string | null } | null;
  ground: string;
  width: number;
  height: number;
  /** Whether the handle and pill show (they arrive a moment after the page lands). */
  marks: boolean;
  /** Load the images (false while the page is still far away). */
  near?: boolean;
}) {
  const t = useMessages('communities');
  const W = width;
  const before = screen ? screen.before.url : pair?.before || null;
  const after = screen ? screen.after.url : pair?.after || null;
  const canCompare = !!before && !!after;

  const place: Placement | null = screen && W > 0
    ? placeBox(screen, focusBox(screen, ['before', 'after'], 16), { w: W, h: height }, 1.6)
    : null;
  const stops = screen && place ? seamStops(screen, place, W) : [];

  // The seam's x in the window: 0 is all After.
  const [pos, setPos] = useState(0);
  const [view, setView] = useState<'after' | 'before'>('after');
  const [dragging, setDragging] = useState(false);
  const [peek, setPeek] = useState(false);
  // The handle's own edge while it travels after a flip ('hidden' while away).
  const [handle, setHandle] = useState<'shown' | 'hidden'>('shown');
  const posRef = useRef(0);
  const anim = useRef(0);
  const handleTimer = useRef(0);
  const holdTimer = useRef(0);
  const peeked = useRef(false);

  const put = useCallback((x: number) => {
    posRef.current = x;
    setPos(x);
    setView((v) => viewFor(Math.max(0, Math.min(1, x / Math.max(1, W))), v));
  }, [W]);

  // A new screen starts at rest.
  useLayoutEffect(() => {
    cancelAnimationFrame(anim.current);
    posRef.current = 0; setPos(0); setView('after'); setHandle('shown'); setPeek(false);
  }, [before, after]);
  useEffect(() => () => { cancelAnimationFrame(anim.current); clearTimeout(handleTimer.current); clearTimeout(holdTimer.current); }, []);

  const glide = useCallback((to: number, ms = 300) => {
    cancelAnimationFrame(anim.current);
    const from = posRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      put(from + (to - from) * easeOut(p));
      if (p < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, [put]);

  /* ── Drag ── */
  const drag = useRef<{ id: number; x0: number; y0: number; from: number; live: boolean; lastX: number; lastT: number; v: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!canCompare || !marks || (e.target as HTMLElement).closest('[data-rf-pill]')) return;
    cancelAnimationFrame(anim.current);
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from: posRef.current, live: false, lastX: e.clientX, lastT: performance.now(), v: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.live) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { drag.current = null; return; }
      if (Math.abs(dx) < 6) return;
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

  /* ── The pill: tap flips, hold peeks ── */
  const flip = () => {
    if (!canCompare) return;
    cancelAnimationFrame(anim.current);
    const to = posRef.current > W / 2 ? 0 : W;
    // The view cuts straight to the other side; only the handle travels,
    // after a short wait, so rapid taps do not send it back and forth.
    setHandle('hidden');
    put(to);
    setView(to > 0 ? 'before' : 'after');
    clearTimeout(handleTimer.current);
    handleTimer.current = window.setTimeout(() => setHandle('shown'), HANDLE_DELAY);
  };
  const pillDown = () => {
    peeked.current = false;
    clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => { peeked.current = true; setPeek(true); }, HOLD_TO_PEEK);
  };
  const pillUp = () => {
    clearTimeout(holdTimer.current);
    if (peek) setPeek(false);
  };
  const pillClick = () => {
    if (peeked.current) { peeked.current = false; return; }
    flip();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!canCompare) return;
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
  // While peeking, the other side fills the window.
  const shown = peek ? (share > 0.5 ? 0 : W) : clamped;
  const satBefore = saturationFor(shown / Math.max(1, W));
  const satAfter = saturationFor(1 - shown / Math.max(1, W));
  const word = peek ? (view === 'after' ? 'before' : 'after') : view;
  const atRight = clamped > W / 2;
  const tabX = Math.max(0, Math.min(W - TAB_W, clamped - (clamped <= 1 ? 0 : clamped >= W - 1 ? TAB_W : TAB_W / 2)));
  const chev = clamped <= 1 ? 'right' : clamped >= W - 1 ? 'left' : share < 0.25 ? 'right' : share > 0.75 ? 'left' : 'bars';

  const layerStyle = (sat: number): CSSProperties => (place
    ? { width: screen!.width, transform: `translate(${place.tx}px, ${place.ty}px) scale(${place.scale})`, transformOrigin: '0 0', filter: sat >= 0.999 ? 'none' : `grayscale(${(1 - sat).toFixed(3)})` }
    : { width: '100%', filter: sat >= 0.999 ? 'none' : `grayscale(${(1 - sat).toFixed(3)})` });

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
      data-rf-compare=""
    >
      <div className="rf-layer" style={layerStyle(satAfter)} aria-hidden="true">{img(after || before, after ? 'after' : 'before')}</div>
      {canCompare ? (
        <div className="rf-layer-clip" style={{ clipPath: `inset(0 ${(W - shown).toFixed(2)}px 0 0)` }} aria-hidden="true">
          <div className="rf-layer" style={layerStyle(satBefore)}>{img(before, 'before')}</div>
        </div>
      ) : null}
      {canCompare ? (
        <>
          <span className="rf-seam" style={{ transform: `translateX(${shown.toFixed(2)}px)`, opacity: marks && !peek ? 1 : 0 }} aria-hidden="true" />
          <span
            className={`rf-tab${atRight ? ' rf-tab-right' : ''}${clamped > 1 && clamped < W - 1 ? ' rf-tab-mid' : ''}`}
            style={{
              transform: `translate(${tabX.toFixed(2)}px, ${((height - TAB_H) / 2).toFixed(1)}px)`,
              opacity: marks && handle === 'shown' && !peek ? 1 : 0,
            }}
            aria-hidden="true"
          >
            <Chevrons dir={chev} />
          </span>
          <button
            type="button"
            className="rf-pill"
            data-rf-pill=""
            data-view={word}
            style={{ opacity: marks ? 1 : 0, ['--rf-g' as string]: `${(shown / Math.max(1, W)) * 100}%` }}
            aria-label={t(word === 'after' ? 'communities:review.compare.pillAfter' : 'communities:review.compare.pillBefore')}
            onPointerDown={pillDown}
            onPointerUp={pillUp}
            onPointerLeave={pillUp}
            onPointerCancel={pillUp}
            onContextMenu={(e) => e.preventDefault()}
            onClick={pillClick}
            tabIndex={-1}
          >
            <span className="rf-pill-word">{word === 'after' ? t('communities:review.compare.after') : t('communities:review.compare.before')}</span>
            <span className="rf-pill-dark" aria-hidden="true">
              <span className="rf-pill-word">{word === 'after' ? t('communities:review.compare.after') : t('communities:review.compare.before')}</span>
            </span>
          </button>
        </>
      ) : null}
    </div>
  );
}
