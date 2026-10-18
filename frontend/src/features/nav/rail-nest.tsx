/**
 * A ROW'S NESTED PART, in the desktop's sidebar of rows (v3, 18 Oct 2026).
 *
 * From 1024px the sidebar holds what the second column held: a community's
 * places open under its row while its page is up (./rail-communities.tsx),
 * and the conversations under Messages while the inbox is
 * (./rail-conversations.tsx). Only the part you are in is open, so moving
 * from one to the other shuts one as it opens the other.
 *
 * ── One clock for both ────────────────────────────────────────────────
 *
 * Each part animates its own height, the opening one from 0 and the shutting
 * one to 0, with the same duration and the same curve, and on the same
 * clock: the second to start in a beat takes the first one's start time
 * (`startTime` on the document timeline), so a part that only heard of the
 * move a frame or two later is not a frame or two behind. So their sum moves
 * one way, and the rows under them never rise before they fall, which is
 * what two clocks did in the mockup.
 *
 * THE HEIGHT IS THE CONTENT'S, AS IT GROWS. What is animated is the part's
 * one grid row, from `0fr` to `1fr` (or back): `1fr` is whatever the rows
 * inside measure on that frame, so topics that land from the community's
 * record mid-way are taken in, where a height measured at the start ended in
 * a jump. A part that is shutting keeps the rows it last drew until it
 * reaches 0, then goes. One pressed open again on its way shut turns round
 * from where it had reached.
 *
 * With reduced motion it opens and shuts at once.
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * A part is drawn only while it is open or shutting. Both parents open
 * theirs only once the client knows the window is a sidebar of rows
 * (./sidebar-rows.ts answers false on the first render), so the prerendered
 * document has none.
 */

import { useRef, useState, type HTMLAttributes, type ReactNode } from 'react';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';

/** How long a part takes to open or shut. */
export const NEST_MS = 260;
/** The curve both run on: quick to start, easing into place. */
export const NEST_EASE = 'cubic-bezier(.3,.7,.2,1)';

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** The part that began to move last, and when (wall clock). */
let leader: { motion: Animation; at: number } | null = null;

/**
 * Start `motion` with the part that began a beat ago, if one did, so both run
 * on one clock. An animation starts on the first frame drawn after it was
 * made (it waits while a new page is laid out), so a part made in the same
 * beat as one still waiting simply waits with it; one made after the other
 * has started takes its start time.
 */
function startTogether(motion: Animation): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (leader && now - leader.at < NEST_MS * 2 && leader.motion.playState !== 'finished') {
    const start = leader.motion.startTime;
    if (start !== null) motion.startTime = start;
    return;
  }
  leader = { motion, at: now };
}

export function NestSlot({ open, rows, children, ...rest }: {
  open: boolean;
  /** The part's rows, by selector: each fades in a beat after the one above it as the part opens. */
  rows?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  const [shown, setShown] = useState(open);
  // Opening draws it in this render; shutting waits for the animation.
  if (open && !shown) setShown(true);
  const kept = useRef<ReactNode>(null);
  if (open) kept.current = children;
  const ref = useRef<HTMLDivElement | null>(null);
  // Whether the element was on screen before this commit: a fresh one opens from 0.
  const present = useRef(false);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    const fresh = !present.current;
    present.current = !!el;
    if (!el) return;
    const still = reducedMotion() || typeof el.animate !== 'function';
    if (still) {
      if (!open) {
        present.current = false;
        setShown(false);
      }
      return;
    }
    // Where it is now: 0 for a fresh part, else what it has reached.
    let from = 0;
    if (!fresh) {
      const inner = el.firstElementChild as HTMLElement | null;
      const full = inner ? inner.scrollHeight : 0;
      from = full > 0 ? Math.min(1, el.getBoundingClientRect().height / full) : 0;
    }
    // Its own and its rows': a fade that held them out must not outlast a turn back.
    for (const running of el.getAnimations?.({ subtree: true }) || []) running.cancel();
    // `minmax(0px, …)`: the row may shrink past the rows' own padding, which the part clips.
    const motion = el.animate(
      [{ gridTemplateRows: `minmax(0px, ${from}fr)` }, { gridTemplateRows: open ? 'minmax(0px, 1fr)' : 'minmax(0px, 0fr)' }],
      { duration: NEST_MS, easing: NEST_EASE, fill: open ? 'none' : 'forwards' },
    );
    startTogether(motion);
    if (rows) {
      el.querySelectorAll<HTMLElement>(rows).forEach((row, i) => {
        // Made in the same task as the part's own, so they start on its frame.
        if (open) {
          row.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], {
            duration: NEST_MS, delay: Math.min(i, 8) * 12, easing: NEST_EASE, fill: 'backwards',
          });
        } else {
          row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: NEST_MS * 0.6, easing: 'ease-out', fill: 'forwards' });
        }
      });
    }
    if (!open) {
      motion.onfinish = () => {
        present.current = false;
        setShown(false);
      };
    }
  }, [open, shown]);

  if (!shown) return null;
  // The grid row is what moves; the inner box holds the rows and the line.
  return (
    <div ref={ref} {...rest} data-nest={open ? 'open' : 'closing'}>
      <div className="platform-rail-nest-in">{open ? children : kept.current}</div>
    </div>
  );
}
