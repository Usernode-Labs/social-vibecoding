/**
 * A launcher tile that has not arrived yet.
 *
 * The authed launcher (`#app-list`, ../home/app-grid.tsx) draws these. The
 * signed-out directory (`../auth/landing.tsx`) has its own placeholder in the
 * website's look, so it no longer uses this copy.
 *
 * `.app-card` is deliberately NOT on these. It carries the hover transition
 * and — more to the point — it is what the kit's placement recognizer and
 * `App._tileFor(slug)` select on; a placeholder answering either of those
 * queries is a tile that can be long-pressed, dragged, or zoomed into, and it
 * has no app behind it.
 */

import type { ReactNode } from 'react';

export function SkeletonTile(): ReactNode {
  return (
    <div className="relative rounded-xl p-3 flex flex-col items-center text-center gap-1.5">
      <div className="w-14 h-14 rounded-2xl bg-zinc-200 dark:bg-zinc-800 shrink-0"></div>
      <div className="w-full h-[26px] flex justify-center pt-1">
        <div className="h-2.5 w-2/3 rounded bg-zinc-200/70 dark:bg-zinc-800/70"></div>
      </div>
    </div>
  );
}

/**
 * What a placeholder block is waiting for, said in a few words over it
 * (#6894): a small tag in the middle of the grey shapes, so a slow load names
 * what is coming instead of only pulsing at the reader. The block its caller
 * positions it against must be `relative`; the tag is taken out of flow so it
 * adds no height and does not move the page when the real content lands.
 *
 * `role="status"` makes it the section's one announcement — screen readers
 * hear the same words the sighted reader sees.
 *
 * It must never carry `animate-pulse`: the app's launch cover
 * (public/js/native-chrome.js, `shellPainted`) waits for that class to be gone.
 */
export function LoadingCaption({ text }: { text: string }): ReactNode {
  return (
    <p role="status" data-loading-caption="" className="pointer-events-none absolute inset-0 z-[1] m-0 flex items-center justify-center">
      <span className="rounded-full bg-white/90 px-3 py-1 text-[13px] font-medium leading-5 text-zinc-500 dark:bg-zinc-900/90 dark:text-zinc-400">{text}</span>
    </p>
  );
}

/**
 * `n` of them, pulsing together, with one `LoadingCaption` over the geometry —
 * a reader should hear the block's words once, not a description of however
 * many decorative rectangles.
 *
 * The pulsing grid comes FIRST so `#app-list`, which is `position: relative`,
 * is what the caption is positioned against — and so the app's launch cover
 * still finds the pulse within its first characters.
 *
 * `className` is the GRID the caller draws into: the launcher is a fixed 4
 * columns, and the placeholders have to sit in the same cells the real tiles
 * will.
 */
export function TileSkeleton({ n, label, className }: {
  n: number;
  label: string;
  className: string;
}): ReactNode {
  return (
    <>
      <div className={`${className} animate-pulse`} aria-hidden="true">
        {Array.from({ length: n }, (_, i) => <SkeletonTile key={i} />)}
      </div>
      <LoadingCaption text={label} />
    </>
  );
}
