/**
 * "Welcome to Homeroom", as a page of its own: the account step for a
 * waitlist "You're in" mail's new account (Evan, 12 Oct 2026, from the hand-
 * drawn boards). It used to be the sign-in sheet's last step, "Welcome
 * <address>" over the story; now the story shows this in its place
 * (./landing.tsx), whether the link signed in as the page opened or a code
 * did after a used or expired link (the sheet's `onAccount`).
 *
 * The same frame as "What do you want to make?", the page that follows it
 * (../first-session/make.tsx): the wallpaper, the wordmark bar at the top
 * (at least 32px under the status bar's inset), and a centred 384px column
 * with the 16px gutter. Top to bottom: the people picture, "You're in" in
 * the make screen's eyebrow, "Welcome to Homeroom" in its heading, the
 * address, the username label and its field card, the note on how they sign
 * in, then, past a flexible spacer, Continue and the terms. The class
 * literals are the make screen's own, spelled again here rather than shared
 * so that file is untouched; tests/release-link-straight-flow.test.js holds
 * the two to the same values.
 *
 * Continue saves the username (`saveAccount`, the sheet's own request, which
 * mints the session) and then waits, busy with "Finishing…", until the shell
 * is ready to draw the make screen (#4904, the sheet's `finish`): what stands
 * on the wallpaper fades, the shell signs in, and the make screen rises on
 * the same wallpaper in the same tick, so no blank frame comes between.
 *
 * Rendered only once there is an account to welcome, never in the landing
 * interior's first render, so the markup the inventory reads is unchanged.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Wordmark } from '@/components/ui/wordmark';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useKeyboardSurface } from '../../lib/keyboard-surface';
import { SessionConfirmationNotice, useSessionConfirmation } from './session-confirmation';
import { blockedOffline, HANDLE_FIELD, sessionMintFailureMessage } from './shared';
import {
  type AccountStep,
  FinishingSpinner,
  HAND_OFF_MS,
  HOLD_FIELD_FOCUS,
  mayFocusByCodeNow,
  prefersReducedMotion,
  saveAccount,
  touchScreen,
} from './sign-in-sheet';
import { TermsNotice } from './waitlist-shared';

// The make screen's root, over the landing (z-[60], with "Signing you in…")
// rather than over the signed-in shell.
export const WELCOME_ROOT = 'platform-kb-surface fixed inset-0 z-[60] flex flex-col text-zinc-900 dark:text-zinc-100';
// The make screen's wordmark bar, column, eyebrow, heading, label over a
// card, the card and its field: the same literals (see the file header).
export const WELCOME_BAR = 'relative flex h-[max(52px,calc(env(safe-area-inset-top)+32px))] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)]';
export const WELCOME_COLUMN = 'mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))]';
export const WELCOME_EYEBROW = 'mt-4 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400';
export const WELCOME_TITLE = 'mt-2.5 text-balance text-[30px] font-extrabold leading-[34px]';
export const WELCOME_LABEL = 'mt-6 pb-2 text-[13px] text-zinc-500 dark:text-zinc-400';
export const WELCOME_CARD = 'overflow-hidden rounded-2xl bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';
const FIELD = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-800';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const INPUT = 'w-full border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
// The address, as the story greets it (./story.tsx).
export const WELCOME_EMAIL = 'mt-2 max-w-full text-[15px] leading-5 font-semibold text-zinc-700 dark:text-zinc-300 [overflow-wrap:anywhere]';
// Where the bar and the column start, settle and go: the make screen's rise,
// and on the way to it a fade over the same 200ms as the sheet's hand-off.
// Transform and opacity only, no delay, and nothing with reduced motion.
const ARRIVING = 'translate-y-6 opacity-0 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none';
const ARRIVED = 'translate-y-0 opacity-100 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none';
const LEAVING = 'pointer-events-none translate-y-0 opacity-0 transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none';
/*
 * ONE MOVE FOR THE KEYS (onboarding run two, 12 Oct 2026, iPhone 17 Safari).
 * A tap on the username moved the page five times in half a second: the
 * keys' band took Continue up the moment Safari reported it, the scroller
 * redrew without the field, the picture was scrolled half under the bar,
 * then away, then the title moved up. Now, on a touch screen, the field's
 * focus decides the layout at once (`typing`): the picture folds away over
 * the keys' own 300ms and the spacer above Continue goes, so what is left
 * fits above the keys and nothing needs scrolling to; Continue rides from
 * where it was to where it is (RIDE). Its blur puts both back the same way.
 */
const PICTURE_SHOWN = 'max-h-[180px] overflow-hidden opacity-100 transition-[max-height,opacity] duration-300 ease-out motion-reduce:transition-none';
const PICTURE_FOLDED = 'max-h-0 overflow-hidden opacity-0 transition-[max-height,opacity] duration-300 ease-out motion-reduce:transition-none';
/** Continue's ride to its place: the keys' own curve and time (native.js keyboard notes). */
const RIDE = { duration: 300, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' } as const;

export function WelcomePage({ account, beforeFinish }: {
  account: AccountStep;
  /**
   * Runs once the session exists and before the shell takes over, as the
   * sheet's does (the story's `startedFromStory`): answers whether the make
   * screen comes next, so the page waits for it and hands off.
   */
  beforeFinish: (kind: 'new') => boolean | Promise<boolean>;
}) {
  const t = useMessages('auth');
  const usernameField = useRef<HTMLInputElement>(null);
  // The keyboard surface's scroller, as on the make screen: a tap on the
  // field without iOS's pan, and the field revealed with Continue under it.
  const scrollerRef = useRef<HTMLDivElement>(null);
  useKeyboardSurface(scrollerRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const completion = useSessionConfirmation();
  const { finishLogin: confirmSession, clear: clearConfirmation } = completion;
  // One frame on the wallpaper alone, so the rise has a start.
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  // The caret for a hardware keyboard; on a phone the tap raises the keys.
  useEffect(() => {
    if (mayFocusByCodeNow()) usernameField.current?.focus({ preventScroll: true });
  }, []);
  const motion = leaving ? LEAVING : arrived ? ARRIVED : ARRIVING;

  // ONE MOVE FOR THE KEYS (above): folded while the field has the keys.
  const [typing, setTyping] = useState(false);
  const continueRef = useRef<HTMLDivElement>(null);
  const rideFrom = useRef<number | null>(null);
  // Going to the make screen, the page stays as it is while it fades.
  const handingOff = useRef(false);
  const fold = useCallback((next: boolean) => {
    if ((next && !touchScreen()) || handingOff.current) return;
    rideFrom.current = continueRef.current ? continueRef.current.getBoundingClientRect().top : null;
    setTyping(next);
  }, []);
  useLayoutEffect(() => {
    const el = continueRef.current;
    const from = rideFrom.current;
    rideFrom.current = null;
    if (!el || from == null || prefersReducedMotion() || typeof el.animate !== 'function') return;
    const d = Math.round(from - el.getBoundingClientRect().top);
    if (Math.abs(d) < 2) return;
    try { el.animate([{ transform: `translateY(${d}px)` }, { transform: 'translateY(0)' }], RIDE); } catch { /* it is simply there */ }
  }, [typing]);

  // Away to the make screen: what stands on the wallpaper fades, the keys go
  // down with it, and the make screen rises on the same wallpaper.
  const handOff = useCallback((): Promise<void> => {
    handingOff.current = true;
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    setLeaving(true);
    const ms = prefersReducedMotion() ? 0 : HAND_OFF_MS;
    return new Promise((resolve) => { window.setTimeout(resolve, ms); });
  }, []);

  const submit = useCallback(async () => {
    setError(null);
    const handle = account.needsUsername ? (usernameField.current?.value || '').trim() : null;
    if (handle === '') {
      setError(translate('auth:signInSheet.account.usernameMissing'));
      usernameField.current?.focus({ preventScroll: true });
      return;
    }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const saved = await saveAccount(handle);
      if (!saved.ok) {
        setError(saved.error);
        if (saved.field === 'username') usernameField.current?.focus({ preventScroll: true });
        return;
      }
      // Busy through the session read: the page goes only once the shell is
      // about to draw the make screen (#4904), and stays, with the notice,
      // when the session cannot be confirmed.
      clearConfirmation();
      const toMake = (await beforeFinish('new')) === true;
      const opened = await confirmSession(toMake ? handOff : undefined);
      if (!opened) setLeaving(false);
    } catch (err) {
      setError(sessionMintFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }, [account.needsUsername, beforeFinish, clearConfirmation, confirmSession, handOff]);

  return (
    <div
      role="dialog"
      aria-labelledby="welcome-page-title"
      data-welcome-page=""
      className={WELCOME_ROOT}
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      <div className={`${WELCOME_BAR} ${motion}`}>
        <Wordmark className="h-6 w-auto text-zinc-950 dark:text-white" />
      </div>
      <div ref={scrollerRef} data-welcome-page-scroll="" className="flex min-h-0 grow flex-col overflow-y-auto overscroll-contain">
        <form className={`${WELCOME_COLUMN} ${motion}`} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="text-center">
            {/* Decorative, as on the story: the words below say it. The
                file's own pixels reserve its box; drawn 200 by 150. */}
            <div data-welcome-page-picture={typing ? 'folded' : 'shown'} className={typing ? PICTURE_FOLDED : PICTURE_SHOWN}>
              <img
                src="/brand/people.png"
                alt=""
                width={816}
                height={612}
                draggable={false}
                className="mx-auto mt-4 block h-auto w-[200px] max-w-full"
              />
            </div>
            <p className={WELCOME_EYEBROW}>{t('auth:welcomePage.eyebrow')}</p>
            <h1 id="welcome-page-title" className={WELCOME_TITLE}>{t('auth:story.welcome')}</h1>
            <p data-welcome-page-email="" className={WELCOME_EMAIL}>{account.email}</p>
          </div>
          {account.needsUsername ? (
            <>
              <p className={WELCOME_LABEL}>{t('auth:signInSheet.account.leadWithUsername')}</p>
              <div className={WELCOME_CARD}>
                <div className={FIELD}>
                  <label htmlFor="welcome-page-username" className={LABEL}>{t('auth:signInSheet.account.usernameLabel')}</label>
                  <input
                    ref={usernameField}
                    id="welcome-page-username"
                    defaultValue={account.suggestedUsername}
                    autoComplete="username"
                    enterKeyHint="go"
                    className={INPUT}
                    placeholder={t('auth:signInSheet.usernamePlaceholder')}
                    onFocus={() => fold(true)}
                    onBlur={() => fold(false)}
                    {...HANDLE_FIELD}
                  />
                </div>
              </div>
            </>
          ) : null}
          {/* No password here (#4891): how they sign in, and where a password is added. */}
          <p data-welcome-page-code-note="" className="mt-3 text-[13px] text-zinc-500 dark:text-zinc-400">{t('auth:signInSheet.account.codeNote')}</p>
          {error ? <p role="alert" className="mt-3 text-[14px] text-red-700 dark:text-red-400">{error}</p> : null}
          <SessionConfirmationNotice completion={completion} />
          {typing ? null : <div className="grow" />}
          <div ref={continueRef} data-welcome-page-continue="">
            <Button
              type="submit"
              disabled={busy}
              layout="full"
              variant="pillAccent"
              size="pillLg"
              ink="solidLate"
              className="mt-6 flex items-center justify-center disabled:opacity-50"
              {...HOLD_FIELD_FOCUS}
            >
              {busy ? <><FinishingSpinner />{t('auth:signInSheet.account.finishing')}</> : t('auth:signInSheet.account.submit')}
            </Button>
            <TermsNotice className="mt-3" />
          </div>
        </form>
      </div>
    </div>
  );
}
