import * as React from 'react';

import { cn } from '@/lib/utils';
import { PLANE_FILL } from './grouped-list';

/**
 * The run's trace, drawn by the shell itself.
 *
 * ── Why there is no map library ───────────────────────────────────────
 *
 * A tile map is a cross-origin dependency on somebody else's uptime, and
 * the shell loads NO cross-origin assets (tests/pwa-shell-wiring.test.js),
 * precaches everything for offline use, and vendors nothing that could
 * draw a map (public/vendor holds marked, DOMPurify and qrcodejs). Adding
 * one would break all three invariants for a single screen. So the trace is
 * drawn here: an SVG polyline normalized to the track's own bounding box,
 * in the platform's violet on the platform's card, with a start marker and
 * a finish marker.
 *
 * ── What it is honest about ───────────────────────────────────────────
 *
 * There is no basemap, so this shows the SHAPE of the run and not where in
 * the world it was — which is the whole of what a self-drawn trace can say,
 * and the reason the card is not labelled with a place. A run with no
 * location, or with a single fix, draws no line: it says so in a plain
 * line instead of rendering a degenerate dot the eye would read as a route
 * that is somewhere.
 *
 * ── One owner for the SVG ─────────────────────────────────────────────
 *
 * This file is the shell's only `<svg>` outside icons.tsx and the wordmark,
 * and it is deliberately here rather than under features/**: that tree's
 * rule is that a raw `<svg>` beside it is a glyph that escaped the icon
 * module (tests/shell-icon-set.test.js), and a data chart is not a glyph.
 * It carries no path DATA — no `d=` anywhere — so it adds nothing to the
 * icon set's inventory.
 */

export interface RouteMapPoint {
  lat: number;
  lng: number;
}

/** The box the trace is normalized into. A constant, not a measurement. */
const BOX = 100;

/** A usable fix: two real numbers in range. */
function usable(point: RouteMapPoint): boolean {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lng)
    && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
}

/**
 * The points as SVG coordinates in a 0..BOX square, one scale for both
 * axes so the shape is not stretched, centred in the box. Exported so a
 * test can drive the projection without a DOM.
 */
export function projectRoute(points: RouteMapPoint[]): Array<{ x: number; y: number }> {
  const list = (points || []).filter(usable);
  if (list.length === 0) return [];
  const lats = list.map((p) => p.lat);
  const lngs = list.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  // A track that never moved on one axis has a zero span, and dividing by
  // it would put every point at infinity. Treated as a hairline instead, so
  // a perfectly straight out-and-back still draws a line.
  const spanLat = Math.max(maxLat - minLat, 1e-6);
  const spanLng = Math.max(maxLng - minLng, 1e-6);
  const pad = 6;
  const scale = (BOX - pad * 2) / Math.max(spanLat, spanLng);
  // Centre the shorter axis, so a north-south run is a vertical line in the
  // middle of the card rather than one pinned to an edge.
  const width = spanLng * scale;
  const height = spanLat * scale;
  const offsetX = pad + (BOX - pad * 2 - width) / 2;
  const offsetY = pad + (BOX - pad * 2 - height) / 2;
  return list.map((point) => ({
    x: offsetX + (point.lng - minLng) * scale,
    // Latitude grows north and SVG y grows down.
    y: offsetY + (maxLat - point.lat) * scale,
  }));
}

export function RouteMap({ points, className }: {
  points: RouteMapPoint[];
  className?: string;
}) {
  const projected = projectRoute(points);
  const drawable = projected.length >= 2;
  const start = drawable ? projected[0] : null;
  const finish = drawable ? projected[projected.length - 1] : null;
  return (
    <div
      data-route-map={drawable ? 'trace' : 'empty'}
      className={cn(
        PLANE_FILL,
        'mx-4 flex h-56 items-center justify-center overflow-hidden rounded-[20px]',
        'shadow-[inset_0_0_0_1px_var(--app-sheet-line)] sm:h-72',
        className,
      )}
    >
      {drawable ? (
        <svg
          className="h-full w-full"
          viewBox={`0 0 ${BOX} ${BOX}`}
          role="img"
          aria-label="The path you ran"
          preserveAspectRatio="xMidYMid meet"
        >
          <polyline
            points={projected.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
            fill="none"
            className="stroke-violet-600 dark:stroke-violet-400"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {start ? (
            <circle cx={start.x} cy={start.y} r="3" className="fill-violet-600 dark:fill-violet-400" />
          ) : null}
          {finish ? (
            <circle
              cx={finish.x}
              cy={finish.y}
              r="3"
              className="fill-white stroke-violet-600 dark:fill-zinc-900 dark:stroke-violet-400"
              strokeWidth="2"
            />
          ) : null}
        </svg>
      ) : (
        <p className="px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No map for this run.
        </p>
      )}
    </div>
  );
}
