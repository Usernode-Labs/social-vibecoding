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
 * One thing stays per-screen and is therefore a prop: `href`. The waitlist's
 * anchor navigates natively via `href="#landing"`. (Sign-in and register
 * shipped an inert `href="#"` routed by a handler; both screens are gone,
 * the sign-in sheet being the one sign-in, and the handler with them.)
 *
 * POSITIONING IS NOT A PROP ANY MORE (QA 2026-09-24 Q8). Sign-in and register
 * used to pin the disc to the VIEWPORT (`fixed`), and the waitlist scrolled it
 * with its own column (`absolute`, #1875). The phone install strip is `fixed`
 * at the top of the viewport above these screens (z-45 over z-40), and each
 * screen moves down to clear it (app.css, "The mobile install strip") — but a
 * viewport-pinned disc does not move with its screen, so on every phone
 * browser the strip covered it: a white half-circle peeked out below "Get the
 * app" and a tap on it hit the strip. `absolute` resolves against the screen
 * root instead (`fixed inset-0` in the bounded shell, `relative` in document
 * flow), so wherever a strip moves the screen, the disc goes with it, and it
 * leaves with the page when a long form scrolls rather than letting the
 * heading slide under it. That is the waitlist's approach, now everyone's.
 *
 * Everything else (the `data-auth-back` attribute `public/css/app.css` styles
 * by, the positioning, the `aria-label`, the icon size, the safe-area offset)
 * is identical on every screen and is not configurable, which is the point.
 */

import { ChevronLeftIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';

/**
 * One complete literal: Tailwind's extractor is a regex over source text, so a
 * class name that is assembled at runtime is a class name that never gets
 * compiled.
 */
export const AUTH_BACK_CLASS =
  'absolute start-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white text-zinc-900 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800';

/** 0.75rem below the safe area, so the 44px disc clears a notch. */
const AUTH_BACK_STYLE = { top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' };

export interface AuthBackButtonProps {
  /** Where Back goes: `'#landing'`. */
  href: string;
}

export function AuthBackButton({ href }: AuthBackButtonProps) {
  const t = useMessages();
  return (
    <a
      href={href}
      data-auth-back=""
      className={AUTH_BACK_CLASS}
      style={AUTH_BACK_STYLE}
      aria-label={t('core:common.back')}
    >
      <ChevronLeftIcon className="w-6 h-6" aria-hidden="true" />
    </a>
  );
}
