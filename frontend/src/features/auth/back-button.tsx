/**
 * The anonymous shell's corner Back control — ONE implementation (#2444).
 *
 * Sign-in, register and the waitlist each carried their own copy of the same
 * anchor: a 44px opaque disc holding a ChevronLeftIcon, offset below the safe
 * area. Three copies drift, and the UI-consistency audit (#2383) caught the
 * waitlist's having been a bare "← Back" text link until #1875 brought it into
 * line by hand. So the markup lives here and the screens render it.
 *
 * This is a `.tsx` of its own rather than an export of `./shared`: that module
 * is a plain `.ts` of constants, types and hooks — no JSX compiles in it — and
 * two suites read it by its `shared.ts` path, so renaming it to add a
 * component would be churn in the wrong file.
 *
 * Two things stay per-screen and are therefore props:
 *
 * - `position`. Sign-in and register pin the disc to the viewport (`fixed`)
 *   over a centred column that does not scroll past it. The waitlist's column
 *   DOES scroll — it is a long survey — so its disc is `absolute` inside the
 *   screen's own scroller and leaves with the page (#1875: as `fixed` it let
 *   the step label and heading slide underneath and the two texts painted over
 *   each other).
 * - `href` + `onClick`. Sign-in and register ship an inert `href="#"` and
 *   route by assigning `location.hash`, exactly as the hand-written shell did;
 *   the waitlist's anchor navigates natively via `href="#landing"` and takes
 *   no handler. `public/js/auth-screens.js` also delegates clicks on
 *   `[data-auth-back]` for the screens it still owns, and both paths do the
 *   same thing.
 *
 * Everything else — the `data-auth-back` attribute `public/css/app.css` styles
 * by, the `aria-label`, the icon size, the safe-area offset — is identical on
 * every screen and is not configurable, which is the point.
 */

import type { MouseEvent } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';

/**
 * Everything but the positioning utility. Written as one complete literal:
 * Tailwind's extractor is a regex over source text, so a class name that is
 * assembled at runtime is a class name that never gets compiled. The two
 * callers below prepend `fixed` or `absolute`, each itself a bare literal in
 * this file's source.
 */
const AUTH_BACK_BASE =
  'left-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800';

/** Pinned to the viewport: sign-in and register. */
export const AUTH_BACK_FIXED_CLASS = `fixed ${AUTH_BACK_BASE}`;

/** Scrolls with the screen's own scroller: the waitlist. */
export const AUTH_BACK_ABSOLUTE_CLASS = `absolute ${AUTH_BACK_BASE}`;

/** 0.75rem below the safe area, so the 44px disc clears a notch. */
const AUTH_BACK_STYLE = { top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' };

export interface AuthBackButtonProps {
  /** `'#'` for the handler-routed screens, `'#landing'` for a plain link. */
  href: string;
  /** `fixed` over a static column, `absolute` inside a scroller. */
  position: 'fixed' | 'absolute';
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export function AuthBackButton({ href, position, onClick }: AuthBackButtonProps) {
  return (
    <a
      href={href}
      data-auth-back=""
      className={position === 'absolute' ? AUTH_BACK_ABSOLUTE_CLASS : AUTH_BACK_FIXED_CLASS}
      style={AUTH_BACK_STYLE}
      aria-label="Back"
      onClick={onClick}
    >
      <ChevronLeftIcon className="w-6 h-6" aria-hidden="true" />
    </a>
  );
}

/** The handler sign-in and register share: an inert href, routed by hash. */
export function backToLanding(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  location.hash = '#landing';
}
