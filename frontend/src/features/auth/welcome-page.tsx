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
 * with the 16px gutter. Top to bottom: the people picture (140px wide,
 * 96px under 800px tall, folded away under 700px), "You're in" in the make
 * screen's eyebrow with the address beside it ("You're in · ada@…"),
 * "Welcome to Homeroom" in its heading, what Homeroom is ("Where groups
 * make their own apps." in the make screen's line under a heading, over one
 * grouped card of three rows: make an app, change it by asking, decide
 * together), the username label and its field card, then, past a flexible
 * spacer, Continue and the terms.
 *
 * THE ADDRESS UNDER THE EYEBROW (Evan, 20 Oct 2026). It stood alone between
 * the card and the username, and a note under the field said how they sign
 * in ("You sign in with a code we email you…"). "You're in" is what the
 * address is about, so it is the line under it, and the note is gone: the
 * page is for picking a name, and the sign-in sheet still says how signing
 * in works where it is asked. The three points are colour emoji on the make
 * screen's idea tile, as that screen's ideas are. The class literals are the make screen's own,
 * spelled again here rather than shared so that file is untouched;
 * tests/release-link-straight-flow.test.js holds the two to the same
 * values.
 *
 * WHAT HOMEROOM IS (Evan, 15 Oct 2026). The page welcomed people to a
 * place it never described. The card is the shell's grouped list on the
 * plane colour, and its rows are information, not actions: no chevron, no
 * tap, and the glyphs on the shell's one neutral tile in the muted ink,
 * because the accent marks an action (AGENTS.md, "Type and colour").
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
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
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
import { SignupOptIn } from './signup-opt-in';
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
// The address on its own line under "You're in": the row type's 15px, a
// step darker than the eyebrow, so it reads as the account, not a label.
export const WELCOME_EMAIL = 'mt-1 text-[15px] leading-5 font-medium text-zinc-700 dark:text-zinc-300 [overflow-wrap:anywhere]';
// The make screen's line under a heading (its import form's): here, what
// Homeroom is.
export const WELCOME_LEAD = 'mt-2.5 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400';
// What Homeroom is, three rows of one grouped card, as message ids
// (frontend/locales/en/auth.json) read when the page renders.
export const WELCOME_POINTS = [
  { key: 'make', title: 'auth:welcomePage.make.title', line: 'auth:welcomePage.make.line' },
  { key: 'ask', title: 'auth:welcomePage.ask.title', line: 'auth:welcomePage.ask.line' },
  { key: 'decide', title: 'auth:welcomePage.decide.title', line: 'auth:welcomePage.decide.line' },
] as const;
// In colour, as the make screen's ideas are (Evan, 20 Oct 2026): a sparkle
// for making, a speech bubble for asking, a ballot box for deciding.
const POINT_EMOJI = { make: '\u2728', ask: '\u{1F4AC}', decide: '\u{1F5F3}\uFE0F' } as const;
// Rows to read, not to tap: the 40px tile, as tall as the row's two lines,
// 8px of air (2px under 800px tall, where the row is its title alone, 44px)
// and a 12px gap, so
// the page fits a 390x844 phone above Continue with each line on one line
// (a narrower phone wraps them rather than cutting them off). The hairline
// starts where the words do, as the primitive's own insets do for its tile.
const POINT_ROW = 'gap-3 py-2 [&:not(:last-child)]:after:left-[4.25rem] [@media(max-height:799px)]:py-0.5';
// The make screen's idea tile (../first-session/make.tsx), a little smaller:
// the app tile's face and hairline, the emoji at 22px.
const POINT_TILE = 'app-icon-tile flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[22px] leading-none';
/*
 * SAFARI'S VISIBLE AREA (15 Oct 2026). With Safari's status area and its
 * bottom toolbar the page gets about 402x717 on an iPhone 17 and 390x664 on
 * a smaller iPhone, not the 844 the app gives it, and Continue was below
 * the fold at both. The sections sit a little closer than the make screen's
 * (the username 24px under the card, Continue 16px under the field), and
 * two heights take away what is not needed to
 * act (the product lead's pick, of three drawn at 402x717):
 *
 *   * 800px tall and up: all of it, the picture at 140px and the rows with
 *     their second lines.
 *   * Under 800px: the picture smaller, 96px wide, and the rows keep their
 *     titles and drop their second lines, a 44px row each.
 *   * Under 700px: the picture folded as well, the typing fold by a media
 *     query, since it is decoration.
 *
 * The rows and the account card always stay. It is CSS rather than a
 * state, so the first frame is already the right one.
 */
const SHORT_PICTURE = '[@media(max-height:699px)]:max-h-0 [@media(max-height:699px)]:opacity-0';
const SHORT_PICTURE_WIDTH = '[@media(max-height:799px)]:w-[96px]';
const SHORTER_LINE = 'whitespace-normal [@media(max-height:799px)]:hidden';
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
 * focus decides the layout at once (`typing`): the picture and what
 * Homeroom is (the line and its card) fold away over the keys' own 300ms
 * and the spacer above Continue goes, so what is left fits above the keys
 * and nothing needs scrolling to; Continue rides from where it was to where
 * it is (RIDE). Its blur puts them back the same way. The picture's
 * max-height is a little over the 113px it takes, so its fold moves from
 * the start. The card's height depends on how its lines wrap, so it folds
 * its grid row from 1fr to 0fr instead: no guessed height to clip a narrow
 * phone's card or to wait through.
 */
const PICTURE_SHOWN = `max-h-[120px] overflow-hidden opacity-100 transition-[max-height,opacity] duration-300 ease-out motion-reduce:transition-none ${SHORT_PICTURE}`;
const PICTURE_FOLDED = 'max-h-0 overflow-hidden opacity-0 transition-[max-height,opacity] duration-300 ease-out motion-reduce:transition-none';
const ABOUT_SHOWN = 'grid grid-rows-[1fr] opacity-100 transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none';
const ABOUT_FOLDED = 'grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none';
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
  // The sign-up form's "Homeroom news by email" box (#6044), unticked until ticked.
  const [newsByEmail, setNewsByEmail] = useState(false);
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
      const saved = await saveAccount(handle, { marketingEmail: account.needsUsername && newsByEmail });
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
  }, [account.needsUsername, newsByEmail, beforeFinish, clearConfirmation, confirmSession, handOff]);

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
                file's own pixels reserve its box; drawn 140 by 105 (96 by
                72 under 800px tall), 8px under the bar. */}
            <div data-welcome-page-picture={typing ? 'folded' : 'shown'} className={typing ? PICTURE_FOLDED : PICTURE_SHOWN}>
              <img
                src="/brand/people.png"
                alt=""
                width={816}
                height={612}
                draggable={false}
                className={`mx-auto mt-2 block h-auto w-[140px] max-w-full ${SHORT_PICTURE_WIDTH}`}
              />
            </div>
            <p className={WELCOME_EYEBROW}>{t('auth:welcomePage.eyebrow')}</p>
            <p data-welcome-page-email="" className={WELCOME_EMAIL}>{account.email}</p>
            <h1 id="welcome-page-title" className={WELCOME_TITLE}>{t('auth:story.welcome')}</h1>
          </div>
          {/* What Homeroom is: folded with the picture while the keys are up. */}
          <div
            data-welcome-page-about={typing ? 'folded' : 'shown'}
            aria-hidden={typing || undefined}
            className={typing ? ABOUT_FOLDED : ABOUT_SHOWN}
          >
            <div className="min-h-0 overflow-hidden">
              <p className={`${WELCOME_LEAD} text-center`}>{t('auth:welcomePage.lead')}</p>
              <GroupedList tone="plane" role="list" className="mx-0 mb-1 mt-3" data-welcome-page-points="">
                {WELCOME_POINTS.map((point) => {
                  return (
                    <ListRow
                      key={point.key}
                      role="listitem"
                      data-welcome-page-point={point.key}
                      chevron={false}
                      className={POINT_ROW}
                      leading={<span className={POINT_TILE} aria-hidden="true">{POINT_EMOJI[point.key]}</span>}
                      title={t(point.title)}
                      subtitle={t(point.line)}
                      titleClassName="whitespace-normal"
                      subtitleClassName={SHORTER_LINE}
                    />
                  );
                })}
              </GroupedList>
            </div>
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
              <div className="mt-3">
                <SignupOptIn id="welcome-page-news-email" kind="email" checked={newsByEmail} onChange={setNewsByEmail} />
              </div>
            </>
          ) : null}
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
              className="mt-4 flex items-center justify-center disabled:opacity-50"
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
