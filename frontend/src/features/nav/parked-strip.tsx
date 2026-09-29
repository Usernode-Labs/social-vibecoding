/**
 * #platform-parked — the app you left, one tap above the tab bar.
 *
 * ./parked-store.js carries the argument for why it exists and why it is not
 * the recency list. What lives here is the things the strip has to get right
 * as a CONTROL.
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
 * ── Resume goes BACK INTO the app, from wherever you are (#2762) ──────
 *
 * Since #2761 the mark's menu has no App segment, and this strip is the way
 * back into an app you stepped out of — including out to that same app's own
 * Workshop, discussion or change, which are platform screens with the bar up
 * and so show the strip. From there the app is still the one the router has
 * open, and re-opening it from scratch would reload a frame that is already
 * mounted. `App.openAppTab` is the router's own "this app, this tab" entry
 * point: it switches tabs for the open app and navigates for any other, and
 * it is what the chromeless pill uses for the same reason.
 *
 * ── It rides on the bar, and only where the bar is ─────────────────────
 *
 * The strip is a band on top of the platform's bar (a footer on the desktop
 * rail), so it is drawn exactly where that bar is: never over a running app,
 * never over the signed-out shell, never in chromeless. Before #2762 no app
 * was ever actually parked, so nothing asked; now one is kept in storage
 * across reloads, a reload can land on the signed-out shell, and the landing
 * screen must not offer the app. The bar's visibility is the store the bar
 * itself reads, and it is only ever applied as the `hidden` class below —
 * never rendered — so a value published before hydration cannot make the
 * first render disagree.
 *
 * On a FOLDED desktop rail the strip goes with the rail (app.css), and when
 * that rail peeks back over the page the strip rides on top of it. The
 * pointer crossing from the peeked rail onto the strip leaves the rail's
 * element, so the strip re-asserts the peek on its way in and hands back the
 * same grace period on its way out (./rail-peek.ts) — otherwise the rail and
 * the strip would fade away under the pointer that is about to press Resume.
 * Only while a peek is up: pointing at the strip never STARTS one.
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

import { useEffect, useRef, useState } from 'react';

import { XIcon } from '@/components/ui/icons';

import { useHiddenClass, useClassToggle, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { navStore } from './nav-store.js';
import { parkedStore, readParked, setParked } from './parked-store.js';
import { enterPeek, leavePeek } from './rail-peek';

// HOW LONG THE STRIP HOLDS ITS LAST APP WHILE IT ANIMATES OUT, matching the
// 180ms of `platform-parked-out` in app.css. Pure CSS cannot animate the
// exit: `hidden` flips straight to `display: none`, so the island holds the
// snapshot for this long and THEN applies `hidden`. Only the render is held —
// `setParked(null)` still clears the store and storage immediately, so a
// reload inside the window behaves exactly as it does today.
const EXIT_MS = 180;

/** The store's row, restated here so the snapshot can be typed. */
type ParkedApp = {
  slug: string;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
};

export function ParkedStrip() {
  const ref = useRef<HTMLDivElement | null>(null);
  const { app: parked } = useStoreState(parkedStore);
  // The bar's own answer, read the way the bar reads it. `true` is the
  // prerender, and it only ever reaches the DOM as a class.
  const barUp = useVisibility('platform-tabs', true);
  const { peek } = useStoreState(navStore);

  // ── The exit hold ──────────────────────────────────────────────────
  //
  // POST-MOUNT state only, like the app itself: the store's empty INITIAL is
  // what the prerendered document ships, so this adds nothing to the first
  // render. On a phone, the layout effect below snapshots the app the moment
  // the store lets go of it, and `app` — what this component renders, hides
  // and taps — becomes that snapshot for 180ms while the out animation
  // plays. The store and storage were already cleared by `setParked(null)`;
  // only the render is held, so a reload inside the window behaves exactly
  // as it does today. A new app parked during the hold cancels it and takes
  // the screen straight away (the strip never left, so its entrance does not
  // restart). Reduced motion skips the hold, so the strip vanishes the way
  // it did before the animation existed. The gate is the same 767px the CSS
  // applies the animations inside, so the desktop rail's footer clears as
  // promptly as it does today.
  const [leaving, setLeaving] = useState<ParkedApp | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveApp = useRef<ParkedApp | null>(null);
  liveApp.current = parked || liveApp.current;
  // A LAYOUT effect: the hold has to be decided in the same commit the store
  // let go of the app, BEFORE `hidden` follows it and before the browser
  // paints — otherwise the strip would hide for a frame and then come back
  // to animate out. (In the prerender pass no effect runs at all.)
  useIsomorphicLayoutEffect(() => {
    if (parked) {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
      setLeaving(null);
      return;
    }
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    if (!window.matchMedia('(prefers-reduced-motion: no-preference)').matches) return;
    const prior = liveApp.current;
    if (!prior) return;
    setLeaving(prior);
    exitTimer.current = setTimeout(() => setLeaving(null), EXIT_MS);
    return () => {
      clearTimeout(exitTimer.current);
      exitTimer.current = null;
    };
  }, [parked]);
  const app = parked || leaving;
  useHiddenClass(ref, !app || !barUp);
  useClassToggle(ref, 'platform-parked-out', !parked && !!app && !!barUp);

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
    <div
      ref={ref}
      id="platform-parked"
      className="platform-parked hidden"
      onMouseEnter={peek ? enterPeek : undefined}
      onMouseLeave={peek ? leavePeek : undefined}
    >
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
              window.App?.openAppTab?.(app.slug, 'app');
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
