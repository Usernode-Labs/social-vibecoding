import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A donut showing one fraction, with the fraction written inside it.
 *
 * ── Why this is a primitive and not a component in a feature ───────────
 *
 * It is drawn with a raw `<svg>`, and `tests/shell-icon-set.test.js` allows
 * none of those under `frontend/src/features/**`: a raw `<svg>` there is a
 * glyph that escaped `@/components/ui/icons.tsx`, which is the whole point of
 * having one icon module. A progress ring is not a glyph — its geometry is a
 * function of the data — so it is not icons.tsx's to hold either. It belongs
 * where the language's other drawn things live, beside `chip`, `feed` and
 * `grouped-list`, which is also what makes it reusable: the leaderboard states
 * the same fraction the home screen's Challenges block does.
 *
 * ── Why an SVG and not a conic-gradient ───────────────────────────────
 *
 * `conic-gradient` needs no element and no arithmetic, and it cannot round the
 * arc's ends — a stroke stopping square reads as a pie chart, which is a
 * different (and wronger) claim about a quantity running from 0 to 100.
 *
 * ── The two numbers ───────────────────────────────────────────────────
 *
 * The radius is 15 in a 38-unit box, so the circumference is 2π × 15 = 94.25,
 * and it is written out rather than computed: it is the one value that has to
 * agree with the radius above it, and a reader can check a literal against a
 * literal. `rotate(-90)` starts the arc at twelve o'clock — without it a ring
 * at 25% fills the lower right, which nobody reads as "a quarter of the way".
 *
 * At zero the arc is not rendered at all. A round-capped stroke of length zero
 * still paints its two caps, which is an accent dot at twelve o'clock on
 * something nobody has started.
 */
const RING_R = 15;
const RING_C = 94.25;

/*
 * ── The orbit (`spinning`) ───────────────────────────────────────────
 *
 * #4199: a ring that is still being worked toward says so with a short arc
 * circling just outside it. It is opt-in, so the leaderboard's and the home
 * screen's rings draw exactly what they drew before. The orbit sits at
 * radius 20, past the 38-unit box, so the box and the layout around it do
 * not change; the svg lets it overflow. Its circumference, 2π × 20, is
 * written out for the same reason RING_C is. It turns only where motion is
 * welcome, and holds still otherwise: the arc then still says "going".
 * `transform-box: fill-box` makes the turn about the circle's own centre,
 * not the svg's origin.
 */
const ORBIT_R = 20;
const ORBIT_C = 125.66;

export interface ProgressRingProps extends Omit<React.SVGProps<SVGSVGElement>, 'children'> {
  /** 0-100. Callers round it themselves, so a ring and a bar always agree. */
  pct: number;
  /** The text inside — "1/6". Omit for a ring with no room to write in. */
  label?: React.ReactNode;
  /** The accessible name for the whole figure: "1 of 6 challenges done". */
  title: string;
  /** The arc's colour, as a Tailwind `stroke-*` class. Complete literals only. */
  arcClassName?: string;
  /**
   * The track's colour, as `stroke-*` classes merged over the default.
   * Complete literals only. For a ring on a surface the default's dark
   * zinc-800 matches, as the messages card's #2c2c2e does.
   */
  trackClassName?: string;
  /** Draw a short arc circling the ring: the work toward it is under way. */
  spinning?: boolean;
}

export function ProgressRing({
  pct, label, title, className, arcClassName, trackClassName, spinning = false, ...props
}: ProgressRingProps) {
  const filled = (Math.max(0, Math.min(100, pct)) / 100) * RING_C;
  return (
    <svg
      className={cn('shrink-0', className)}
      width="38"
      height="38"
      viewBox="0 0 38 38"
      role="img"
      aria-label={title}
      {...(spinning ? { overflow: 'visible', 'data-progress-ring-spinning': '' } : {})}
      {...props}
    >
      <circle
        cx="19"
        cy="19"
        r={RING_R}
        fill="none"
        strokeWidth="4"
        className={cn('stroke-zinc-200 dark:stroke-zinc-800', trackClassName)}
      />
      {filled > 0 ? (
        <circle
          cx="19"
          cy="19"
          r={RING_R}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${RING_C}`}
          transform="rotate(-90 19 19)"
          className={cn('stroke-violet-500', arcClassName)}
        />
      ) : null}
      {spinning ? (
        <circle
          cx="19"
          cy="19"
          r={ORBIT_R}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`18 ${ORBIT_C}`}
          className={cn('origin-center [transform-box:fill-box] stroke-violet-500 motion-safe:animate-[spin_1.6s_linear_infinite] motion-reduce:animate-none', arcClassName)}
        />
      ) : null}
      {label ? (
        <text
          x="19"
          y="22.5"
          textAnchor="middle"
          className="fill-zinc-900 text-[11px] font-semibold dark:fill-zinc-100"
        >
          {label}
        </text>
      ) : null}
    </svg>
  );
}
