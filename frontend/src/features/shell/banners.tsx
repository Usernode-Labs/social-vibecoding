import { useRef } from 'react';

import { Alert } from '@/components/ui/alert';
import { OFFLINE_BANNER_ID, offlineBannerVisible } from '../../lib/offline';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useVisibility } from '../../lib/visibility-store';

/**
 * The shell's two amber banners — the first regions converted to real
 * components in step 2 (#1078 chunk A).
 *
 * They are the proof slice on purpose: between them they exercise every
 * mechanism the later chunks depend on, on 48 lines of markup where a mistake
 * is obvious. The offline banner is driven by external state (the /health
 * probe, published into the visibility store), the view-as banner is driven by
 * CSS on a body class and owns an interactive control. Both are wholly
 * React-owned subtrees: nothing in public/js/** writes into either any more.
 *
 * The rendered DOM is byte-identical to the hand-written markup — same
 * attribute order, same class-string order, not merely the same class set —
 * which is what makes the before/after screenshots a real test of the wiring
 * rather than an assertion about it. In `public/index.html` the only change
 * either banner produces is the removal of the `/js/offline.js` script tag.
 */

/**
 * `#offline-banner` — "You're offline — showing saved content" (#487).
 *
 * Shown while the /health connectivity probe fails; everything on screen is
 * the last version that loaded successfully. Hidden the moment the probe
 * succeeds.
 *
 * Visibility comes from the store rather than props because the publisher is
 * `lib/offline.ts`, which runs at module scope — before this component's
 * effects, and before App.init() reads `Offline.isOffline()`. The initial
 * value is read from the same store so a `?shot=offline` deep link (which
 * pins the state during boot, in App._applyOfflineShot) is already reflected
 * on the first client render.
 *
 * The `hidden` class is applied through a ref rather than rendered, because
 * `className` on this element must stay a constant prop: React writes the
 * whole attribute when the prop changes, and public/js/platform-ui.js adds
 * classes to shell nodes at runtime. See lib/legacy-dom.ts.
 */
export function OfflineBanner() {
  const ref = useRef<HTMLDivElement>(null);
  // `false` = the state the prerendered markup shipped with (`hidden`), so
  // the hydrating render always matches the server markup exactly.
  const visible = useVisibility(OFFLINE_BANNER_ID, offlineBannerVisible());
  useHiddenClass(ref, !visible);

  return (
    <Alert ref={ref} id={OFFLINE_BANNER_ID} variant="banner" startHidden>
      You&apos;re offline — showing saved content
    </Alert>
  );
}

/**
 * `#view-as-non-admin-banner` — the persistent reminder that an admin has
 * flipped the "View as non-admin" toggle in Settings.
 *
 * Sits between the header and the main content so the admin can't forget
 * they're in preview mode (which would otherwise look indistinguishable from a
 * plain non-admin session).
 *
 * Visibility is deliberately NOT React state: public/css/app.css reveals it
 * from the `is-view-as-non-admin` body class that app.js sets during init.
 * That was a considered choice when the banner was written — a JS error
 * elsewhere on the page can never strand an admin in masked mode without the
 * visible reminder — and moving it into a component's state would quietly undo
 * it. The class stays in the markup for the same reason it always was: the CSS
 * rule flips `display` back to `flex`, so the element is inert until the body
 * class appears.
 *
 * The "Switch back" control's behaviour moved here from settings.js, which
 * bound it by id. It is a plain `<button>`, not the `Button` primitive: that
 * primitive's base carries `font-medium transition-colors`, which this control
 * has never had, and adding it would be a visual change.
 *
 * The wrapper is a plain `<div>` with a literal class string rather than the
 * `Alert` primitive, for one specific reason: this element's classes include
 * both `hidden` AND `flex`, which is exactly the deliberate conflict the CSS
 * rule above resolves. tailwind-merge treats them as one group and would drop
 * whichever came first, so `cn` cannot be in this path. See alert.tsx.
 */
export function ViewAsNonAdminBanner() {
  return (
    <div
      id="view-as-non-admin-banner"
      className="hidden bg-amber-500/15 text-amber-700 dark:text-amber-300 border-b border-amber-500/30 px-4 py-2 text-xs flex items-center justify-center gap-2"
    >
      <span>Viewing as non-admin (admin UI hidden).</span>
      <button
        id="view-as-non-admin-disable"
        className="underline hover:text-amber-600 dark:hover:text-amber-200"
        onClick={() => {
          localStorage.removeItem('viewAsNonAdmin');
          window.location.reload();
        }}
      >
        Switch back
      </button>
    </div>
  );
}
