/**
 * #platform-parked — the app you left, one tap above the tab bar.
 *
 * ./parked-store.js carries the argument for why it exists and why it is not
 * the recency list. What lives here is the two things the strip has to get
 * right as a CONTROL.
 *
 * ── It is one target, and the ✕ is another ───────────────────────────
 *
 * The whole strip resumes the app — tile, name and pill alike — because a
 * shortcut whose tappable area is a 60px pill inside a full-width bar is a
 * shortcut you miss. The pill is a label INSIDE that target rather than a
 * button beside it: a nested button inside an anchor is invalid, browsers
 * split the markup on it, and it would give two targets where the design has
 * one plus a dismiss.
 *
 * The ✕ is that dismiss, and it means FORGET rather than hide: a strip that
 * comes back on the next screen swap is a strip you cannot get rid of, and
 * the handle's whole promise is that it is there until you are done with it.
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * The root ships in the document with `hidden` and nothing inside it, which
 * is what the store's empty INITIAL renders. The app arrives from storage in
 * an effect, so the prerendered document and the first client render agree —
 * and the root has an id in the shell's frozen inventory either way, which a
 * conditionally rendered element could not.
 *
 * `hidden` lands through useHiddenClass rather than a rendered className, the
 * same seam the tab bar below it uses: the class string is a constant, and
 * the CSS that reserves this strip's band reads that class
 * (`body:has(#platform-parked:not(.hidden))`), so React must never be the one
 * rewriting the attribute.
 */

import { useEffect, useRef } from 'react';

import { XIcon } from '@/components/ui/icons';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { parkedStore, readParked, setParked } from './parked-store.js';

export function ParkedStrip() {
  const ref = useRef<HTMLDivElement | null>(null);
  const { app } = useStoreState(parkedStore);
  useHiddenClass(ref, !app);

  // POST-MOUNT, and that is the whole of why it is an effect: a localStorage
  // read during the first render is a hydration mismatch. Once only — every
  // later change comes through the bridge, from the router.
  useEffect(() => {
    if (parkedStore.get().app) return;
    const stored = readParked();
    if (stored) parkedStore.set({ app: stored });
  }, []);

  const record = app
    ? { icon_url: app.iconUrl, icon_emoji: app.iconEmoji, name: app.name }
    : null;

  return (
    <div ref={ref} id="platform-parked" className="platform-parked hidden">
      {app && record ? (
        <>
          <a
            id="platform-parked-resume"
            className="platform-parked-open"
            // A REAL PATH, so a modified click opens the app in a tab —
            // which is a thing people do with this exact handle, to get the
            // app back without losing the conversation they are reading.
            href={`/app/${encodeURIComponent(app.slug)}`}
            onClick={(event) => {
              const nav = (window as unknown as {
                NavLink?: { isNativeClick?: (e: unknown) => boolean };
              }).NavLink;
              if (nav?.isNativeClick?.(event)) return;
              event.preventDefault();
              (window as unknown as {
                App?: { navigateToApp?: (slug: string, tab?: string) => void };
              }).App?.navigateToApp?.(app.slug, 'app');
            }}
          >
            <span
              data-icon={appIconKind(record)}
              className="app-icon-tile platform-parked-tile"
            >
              <AppIconContent app={record} />
            </span>
            <span className="platform-parked-name">{app.name}</span>
            <span className="platform-parked-pill">Resume</span>
          </a>
          <button
            id="platform-parked-forget"
            type="button"
            className="platform-parked-x"
            aria-label={`Forget ${app.name}`}
            onClick={() => setParked(null)}
          >
            <XIcon className="w-4 h-4" />
          </button>
        </>
      ) : null}
    </div>
  );
}
