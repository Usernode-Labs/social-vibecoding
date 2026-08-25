import { useCallback, useEffect, useRef, useState } from 'react';

import { XIcon } from '@/components/ui/icons';
import { useHiddenClass } from '../../lib/legacy-dom';
import {
  detectMobileOs, installOffer, storeLabel, type InstallOffer, type StoreUrls,
} from './detect';

/**
 * `#mobile-install-banner` — the phone-browser strip offering the native app
 * (#1372).
 *
 * Sits directly under `#offline-banner`, and is the same SHAPE as it: an
 * in-flow `shrink-0` strip in the header column, which `public/css/app.css`
 * lifts to `position: fixed` while `body.has-install-strip` is set. That is
 * how the offline banner floats over content instead of displacing it, and
 * the two stack — offline at `z-60`, this at `z-59`, so a connectivity
 * warning is never covered by an advert for an app you cannot download while
 * offline.
 *
 * ── Why the body class ─────────────────────────────────────────────────
 *
 * A fixed strip covers whatever is at the top of the document, so the body
 * gains `padding-top` for exactly as long as the strip is up. `body` is not
 * React-owned (app.js writes `is-offline`, `is-view-as-non-admin` and others
 * to it), so toggling one more class from an effect is the established seam
 * rather than a new one.
 *
 * ── Why the markup renders even when there is nothing to offer ─────────
 *
 * AGENTS.md: an island's INITIAL render must emit exactly the empty/hidden
 * markup, with the data loaded in an effect. A first render that disagrees
 * with the prerendered document is a hydration mismatch, React `console.error`s
 * it, and a console error on any route fails proposal checks. So the strip is
 * always in the document, `hidden`, and the offer only ever toggles the class
 * through a ref — never the rendered `className`, which must stay a constant
 * for the reason lib/legacy-dom.ts explains.
 *
 * The practical consequence is worth stating plainly: with no store listing
 * published, `GET /api/public/mobile-app` answers `{ios: null, android: null}`
 * and this element is inert markup that no one ever sees. It turns itself on
 * the day an admin pastes a URL into App version.
 */

const DISMISS_KEY = 'mobileInstallBannerDismissed';
const BODY_CLASS = 'has-install-strip';

/** Every read below is in a try/catch: Safari throws on storage in private mode. */
function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* A dismissal that cannot be persisted still hides the strip for this page. */
  }
}

/** Launched from a home-screen icon rather than a browser tab. */
function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    // iOS Safari predates the media query and reports it here instead.
    return (window.navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

function isNativeApp(): boolean {
  const bridge = (window as { usernode?: { isNative?: boolean } }).usernode;
  return !!(bridge && bridge.isNative === true);
}

export function MobileInstallBanner() {
  const ref = useRef<HTMLDivElement>(null);
  const [urls, setUrls] = useState<StoreUrls | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [offer, setOffer] = useState<InstallOffer | null>(null);

  // The fetch is skipped entirely for anyone who cannot be offered anything —
  // a desktop visitor, the native app, an installed PWA, someone who already
  // said no. That is most pageviews, and this is one request each.
  useEffect(() => {
    const nav = window.navigator;
    const onAPhone = detectMobileOs(nav.userAgent || '', nav.maxTouchPoints || 0) !== null;
    if (!onAPhone || isNativeApp() || isStandalone() || readDismissed()) return undefined;

    let live = true;
    fetch('/api/public/mobile-app')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (live && body) setUrls({ ios: body.ios ?? null, android: body.android ?? null });
      })
      .catch(() => {
        /* Offline, or the endpoint is unreachable: no banner, no console noise. */
      });
    return () => { live = false; };
  }, []);

  // Recomputed from the real environment whenever the inputs change, rather
  // than trusted from the effect above — the eligibility probe there is a
  // cheap "is this a phone", not the decision.
  useEffect(() => {
    const nav = window.navigator;
    setOffer(installOffer({
      ua: nav.userAgent || '',
      maxTouchPoints: nav.maxTouchPoints || 0,
      native: isNativeApp(),
      standalone: isStandalone(),
      dismissed: dismissed || readDismissed(),
      urls,
    }));
  }, [urls, dismissed]);

  useHiddenClass(ref, !offer);

  // The strip is fixed, so it covers the top of the document while it is up.
  useEffect(() => {
    const { body } = document;
    if (!body) return undefined;
    body.classList.toggle(BODY_CLASS, !!offer);
    return () => body.classList.remove(BODY_CLASS);
  }, [offer]);

  const dismiss = useCallback(() => {
    writeDismissed();
    setDismissed(true);
  }, []);

  return (
    <div
      ref={ref}
      id="mobile-install-banner"
      className="hidden shrink-0 items-center gap-2 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 text-xs"
    >
      <img src="/icons/icon-192.png" alt="" aria-hidden="true" className="w-8 h-8 rounded-lg shrink-0" />
      <div className="min-w-0 flex-1 text-left leading-tight">
        <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate">Usernode</div>
        <div className="text-zinc-500 dark:text-zinc-400 truncate">
          {offer ? `Get the app on ${storeLabel(offer.os, offer.url)}` : 'Get the app'}
        </div>
      </div>
      <a
        id="mobile-install-open"
        href={offer ? offer.url : undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 inline-flex items-center h-7 px-3 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-colors un-touch-target"
      >
        Get
      </a>
      <button
        id="mobile-install-dismiss"
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install banner"
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors un-touch-target"
      >
        <XIcon className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
