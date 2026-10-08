/**
 * #4387: the screens a first version's thumbnail shows on the App tab while
 * it is built, in its colour band (made taller, 340px) in place of its icon:
 *
 *   First look     from "Building it": the main screen the build's plan drew,
 *                  as a picture, in a phone-shaped frame. Pill: "First look ·
 *                  drawn from the plan".
 *   Real screens   from "Testing it", through "Ready to try": up to three
 *                  screens of the build itself, swiped, with page dots. Pill:
 *                  "Real screen · 4 min ago".
 *
 * The images are the server's, read by the project's members only
 * (public/js/app-view.js _firstVersionScreens names them); this draws
 * pictures and nothing else. A picture that will not load is left out, and
 * with none left the thumbnail is drawn as it was (`onEmpty`). Only on the
 * App tab: the made screen, the invite page, Home and the hub keep the
 * thumbnail.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** What the band draws (AppView._firstVersionScreens). */
export interface FirstVersionScreens {
  kind: 'first_look' | 'real';
  /** When the real screens were taken (ISO), for the pill. */
  at: string | null;
  images: string[];
}

export const FIRST_LOOK_PILL = 'First look · drawn from the plan';

/** "Real screen · 4 min ago" (a minute at least; hours past the hour). Pure. */
export function realScreenPill(at: string | null, now: number = Date.now()): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return 'Real screen';
  const minutes = Math.max(1, Math.floor((now - t) / 60000));
  return minutes < 60 ? `Real screen · ${minutes} min ago` : `Real screen · ${Math.floor(minutes / 60)} h ago`;
}

/** The pill's words for what the band shows. Pure. */
export function screensPill(screens: Pick<FirstVersionScreens, 'kind' | 'at'>, now?: number): string {
  return screens.kind === 'first_look' ? FIRST_LOOK_PILL : realScreenPill(screens.at, now);
}

/** Whether a band has anything to draw. Pure. */
export function hasScreens(screens: FirstVersionScreens | null | undefined): screens is FirstVersionScreens {
  return !!screens && (screens.kind === 'first_look' || screens.kind === 'real')
    && Array.isArray(screens.images) && screens.images.length > 0;
}

/** Ticks once a minute while mounted, for "N min ago". */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

// 270px tall at the phone's own shape (390 × 844), leaving the band's top
// to the pill and its foot to the page dots.
const FRAME = 'relative h-[270px] w-[125px] shrink-0 overflow-hidden rounded-[22px] bg-white shadow-[0_10px_28px_rgba(0,0,0,0.22),0_0_0_4px_rgba(17,17,20,0.9)]';

export function ScreensBand({ screens, name, onEmpty }: { screens: FirstVersionScreens; name: string; onEmpty: () => void }): ReactNode {
  const now = useMinute();
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [at, setAt] = useState(0);
  const track = useRef<HTMLDivElement | null>(null);
  const shown = screens.images.filter((src) => !failed.has(src)).slice(0, screens.kind === 'first_look' ? 1 : 3);
  useEffect(() => {
    if (!shown.length) onEmpty();
  }, [shown.length, onEmpty]);
  if (!shown.length) return null;
  const many = shown.length > 1;
  const page = Math.min(at, shown.length - 1);
  const go = (i: number) => {
    const el = track.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
    setAt(i);
  };
  return (
    <div className="absolute inset-0" data-first-version-screens={screens.kind}>
      <div
        ref={track}
        className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.clientWidth) setAt(Math.round(el.scrollLeft / el.clientWidth));
        }}
      >
        {shown.map((src, i) => (
          <div key={src} className="flex h-full w-full shrink-0 snap-center items-end justify-center pb-6">
            <div className={FRAME}>
              <img
                src={src}
                alt={screens.kind === 'first_look'
                  ? `A first look at ${name}, drawn from the plan`
                  : `${name}, real screen ${i + 1} of ${shown.length}`}
                className="h-full w-full object-cover object-top"
                draggable={false}
                onError={() => setFailed((prev) => new Set(prev).add(src))}
              />
            </div>
          </div>
        ))}
      </div>
      <span
        data-first-version-pill=""
        className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[12px] font-semibold leading-4 text-white"
      >
        {screensPill(screens, now)}
      </span>
      {many ? (
        <div className="absolute inset-x-0 bottom-0 flex justify-center gap-0.5" data-first-version-dots="">
          {shown.map((src, i) => (
            <button
              key={src}
              type="button"
              aria-label={`Screen ${i + 1} of ${shown.length}`}
              aria-current={i === page ? 'true' : undefined}
              onClick={() => go(i)}
              className="flex h-6 w-6 items-center justify-center"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${i === page ? 'bg-white' : 'bg-white/50'}`} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
