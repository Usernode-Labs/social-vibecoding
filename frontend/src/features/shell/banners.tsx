import { useMessages } from '../../lib/i18n/react';

/**
 * The shell's amber banner — one of the first regions converted to a real
 * component in step 2 (#1078 chunk A). It is driven by CSS on a body class
 * and owns an interactive control, and is a wholly React-owned subtree:
 * nothing in public/js/** writes into it any more.
 *
 * Visibility and classes retain the legacy shell's ownership contract.
 */

/*
 * `#offline-banner`, the amber connectivity strip (#487), lived here until
 * the native-offline proposal (18 Nov 2026) moved its word into the header:
 * ../header/connection-status.tsx.
 */

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
  const t = useMessages();
  return (
    <div
      id="view-as-non-admin-banner"
      className="hidden bg-amber-500/15 text-amber-800 dark:text-amber-300 border-b border-amber-500/30 px-4 py-2 text-xs flex items-center justify-center gap-2"
    >
      <span>{t('core:banner.viewAsNonAdmin.text')}</span>
      <button
        id="view-as-non-admin-disable"
        className="underline hover:text-amber-600 dark:hover:text-amber-200"
        onClick={() => {
          localStorage.removeItem('viewAsNonAdmin');
          window.location.reload();
        }}
      >
        {t('core:banner.viewAsNonAdmin.switchBack')}
      </button>
    </div>
  );
}
