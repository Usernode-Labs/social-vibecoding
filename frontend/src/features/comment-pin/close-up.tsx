/**
 * The close-up at the top of the phone's comment sheet (#4554): the area of
 * the page around the open comment's pin, drawn from the view picture at a
 * pinch-and-pan zoom, so the person can check what they pinned without the
 * whole sheet covering the page.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { closeUpView, type Point, type Size } from './picture';

const HEIGHT = 150;
const START_ZOOM = 2;
const MAX_ZOOM = 4;

const midOf = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distOf = (a: Point, b: Point): number => Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));

/** The zoomed view of the pin, or, when the page has moved on since the pin, the comment's own thumbnail. */
export function CloseUp({ view, pin, own }: { view: string; pin: Point; own?: string | null }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const [picture, setPicture] = useState<Size | null>(null);
  const [pinched, setPinched] = useState(false);
  const [drawn, setDrawn] = useState(0);
  // Gesture math reads and writes these directly; `drawn` only asks for the
  // re-render, so a move never works from a state update it cannot see yet.
  const zoomRef = useRef(START_ZOOM);
  const panRef = useRef<Point>({ x: 0, y: 0 });
  type Gesture =
    | { mode: 'pan'; id: number; last: Point }
    | { mode: 'pinch'; ids: [number, number]; mid: Point; dist: number };
  const gesture = useRef<Gesture | null>(null);
  const points = useRef(new Map<number, Point>());

  // A new picture is a new view: back to the pin, at the starting zoom.
  useEffect(() => {
    zoomRef.current = START_ZOOM;
    panRef.current = { x: 0, y: 0 };
    setPicture(null);
    setDrawn((n) => n + 1);
  }, [view]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const read = () => setBoxWidth(box.clientWidth);
    read();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  const sync = () => setDrawn((n) => n + 1);
  const clampPan = (pan: Point, zoom: number): Point => {
    if (!picture || !boxWidth) return pan;
    return closeUpView({
      pin: { x: pin.x * picture.width, y: pin.y * picture.height },
      box: { width: boxWidth, height: HEIGHT },
      picture, zoom, pan,
    }).pan;
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const now = { x: e.clientX, y: e.clientY };
    points.current.set(e.pointerId, now);
    const g = gesture.current;
    if (!g) {
      gesture.current = { mode: 'pan', id: e.pointerId, last: now };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    if (g.mode === 'pan' && e.pointerId !== g.id) {
      // A second finger: the pan becomes a pinch about the two fingers.
      gesture.current = { mode: 'pinch', ids: [g.id, e.pointerId], mid: midOf(g.last, now), dist: distOf(g.last, now) };
      setPinched(true);
    }
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const now = { x: e.clientX, y: e.clientY };
    points.current.set(e.pointerId, now);
    if (g.mode === 'pan') {
      if (e.pointerId !== g.id) return;
      panRef.current = clampPan({ x: panRef.current.x - (now.x - g.last.x), y: panRef.current.y - (now.y - g.last.y) }, zoomRef.current);
      g.last = now;
      sync();
      return;
    }
    if (e.pointerId !== g.ids[0] && e.pointerId !== g.ids[1]) return;
    const a = points.current.get(g.ids[0]);
    const b = points.current.get(g.ids[1]);
    if (!a || !b) return;
    const mid = midOf(a, b);
    const dist = distOf(a, b);
    // The point of the picture under the fingers stays under them: the pan
    // takes up what the zoom change would otherwise shift (see the seam
    // comment on closeUpView: offset = centre - pin * base * zoom + pan).
    const zPrev = zoomRef.current;
    const z = Math.max(1, Math.min(MAX_ZOOM, zPrev * dist / g.dist));
    const c = { x: boxWidth / 2, y: HEIGHT / 2 };
    panRef.current = clampPan({
      x: mid.x - c.x - (g.mid.x - c.x - panRef.current.x) * (z / zPrev),
      y: mid.y - c.y - (g.mid.y - c.y - panRef.current.y) * (z / zPrev),
    }, z);
    zoomRef.current = z;
    g.mid = mid;
    g.dist = dist;
    sync();
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    points.current.delete(e.pointerId);
    if (g.mode === 'pan') {
      if (e.pointerId === g.id) gesture.current = null;
      return;
    }
    const left = g.ids.filter((id) => id !== e.pointerId && points.current.has(id));
    if (left.length) {
      const last = points.current.get(left[0]);
      if (last) gesture.current = { mode: 'pan', id: left[0], last };
    } else {
      gesture.current = null;
    }
  };

  const pinPx = picture ? { x: pin.x * picture.width, y: pin.y * picture.height } : null;
  const view2 = picture && boxWidth && pinPx
    ? closeUpView({ pin: pinPx, box: { width: boxWidth, height: HEIGHT }, picture, zoom: zoomRef.current, pan: panRef.current })
    : null;
  const scale = picture ? view2!.size.width / picture.width : 1;
  const handlers = own ? {} : {
    onPointerDown: onDown,
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
  };

  return (
    <div
      ref={boxRef}
      {...handlers}
      className="relative shrink-0 overflow-hidden rounded-[12px] bg-zinc-100 ring-1 ring-black/10 dark:bg-zinc-800 dark:ring-white/10"
      style={{ height: HEIGHT, touchAction: 'none' }}
    >
      {own ? (
        <>
          {/* The page has moved on since this comment was pinned, so the view
              picture would show somewhere else: its own picture instead, as
              it is, no zoom. */}
          <img src={own} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover object-left-top" />
          <span
            aria-hidden="true"
            className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-600 shadow-[0_0_0_1.5px_#fff]"
            style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
          />
        </>
      ) : (
        <>
          <img
            src={view}
            alt=""
            draggable={false}
            onLoad={(e) => setPicture({ width: e.currentTarget.naturalWidth || 1, height: e.currentTarget.naturalHeight || 1 })}
            className="absolute left-0 top-0 max-w-none select-none"
            style={view2
              ? { width: view2.size.width, height: view2.size.height, transform: `translate(${view2.offset.x}px, ${view2.offset.y}px)` }
              : { visibility: 'hidden' }}
          />
          {view2 && pinPx ? (
            <span
              aria-hidden="true"
              className="absolute h-2.5 w-2.5 rounded-full bg-violet-600 shadow-[0_0_0_1.5px_#fff]"
              style={{ left: view2.offset.x + pinPx.x * scale, top: view2.offset.y + pinPx.y * scale, transform: 'translate(-50%, -50%)' }}
            />
          ) : null}
          {pinched ? null : (
            <span className="absolute left-2 top-2 rounded-full bg-zinc-900/80 px-2 py-0.5 text-[11px] font-semibold text-white">Pinch to zoom</span>
          )}
        </>
      )}
    </div>
  );
}