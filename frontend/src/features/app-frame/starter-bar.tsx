/**
 * The bar over the starter (#15): "This is the starter for now. Back to the
 * first version".
 *
 * While Homeroom bot builds a project's first version, the App tab shows
 * that instead of the app, with "Show the starter for now" for anyone who
 * wants to see the template it was set up from (AppView._firstVersionView).
 * That button framed the starter and nothing led back: the screen that said
 * it was being built, its step and its chat, was gone for the rest of the
 * visit (Evan, first-session run-through, 5 October 2026). So the starter is
 * framed under this bar, and its button puts that screen back
 * (AppView.hideStarter), which reads the project again on the way.
 *
 * It sits at the top of the app's sheet, inside #app-frame-host, rather than
 * on the page ground above it: the sheet is the thing it is about, and the
 * app's tone (app.css, "THE BAR TAKES THE APP'S TONE") re-inks the tokens it
 * is drawn from, so it reads on a dark starter under the light shell too.
 * It is a quiet line with its one action in the accent, the way the make
 * screen's "Not sure yet? Look around first" and Home's panel links
 * (features/home/panels/ui.tsx) are drawn: no new kind of control.
 *
 * ── Why it cannot move the frame ────────────────────────────────────────
 *
 * ./app-frame.tsx renders this component unconditionally, BEFORE
 * `.app-launch-host`, so the wrapper that holds the frames is the host's
 * second child whether the bar draws anything or not. A bar appearing is an
 * insert before that wrapper, never a move of it, and the iframe inside is
 * not touched (tests/app-frame-identity.test.js). The host is a column, the
 * bar does not shrink, and the wrapper (overflow hidden, so no content
 * minimum) gives up the bar's height.
 *
 * Only for the app whose frame is mounted: the store says whose starter is
 * shown, and a different app's frame, or none, draws no bar.
 */

import type { ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { appFrameStore } from './app-frame-store.js';
import { starterStore } from './starter-store.js';

/** The bar's words, and its button's. */
export const STARTER_NOTE = 'This is the starter for now.';
export const STARTER_BACK = 'Back to the first version';

/** The app the bar is for: the starter's while it is the mounted frame, else ''. */
export function starterBarFor(starter: { slug: string }, frame: { slug: string }): string {
  return starter.slug && starter.slug === frame.slug ? starter.slug : '';
}

function hideStarter(slug: string): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av.hideStarter === 'function') av.hideStarter(slug);
}

export function StarterBarView({ slug }: { slug: string }): ReactNode {
  return (
    <div
      id="app-starter-bar"
      data-app-starter={slug}
      className="shrink-0 bg-[color:var(--bg-primary)] px-6 pb-2.5 pt-3 text-center text-[13px] leading-5 text-[color:var(--text-muted)] shadow-[inset_0_-1px_0_var(--app-sheet-line)]"
    >
      {`${STARTER_NOTE} `}
      <button
        type="button"
        id="app-starter-back"
        onClick={() => hideStarter(slug)}
        className="font-semibold text-[color:var(--accent)] hover:underline un-touch-target"
      >
        {STARTER_BACK}
      </button>
    </div>
  );
}

export function StarterBar(): ReactNode {
  const starter = useStoreState(starterStore);
  const frame = useStoreState(appFrameStore);
  const slug = starterBarFor(starter, frame);
  return slug ? <StarterBarView slug={slug} /> : null;
}
