/**
 * HEARTS AND PLAYS, the panel: one card in the side column of a project's
 * hub, for a member (../dev-board/workshop/workshop.tsx) and on the
 * signed-out project page (../guest/guest-project.tsx).
 *
 * Two cells, a hairline between them, each a small grey label over its
 * number:
 *
 *   Plays    how many times the app was played, one per person per day,
 *            signed in or not. An app that is not a game is opened, so its
 *            label is Opens. Under MIN_PLAYS the cell is left out: a new app
 *            does not look unused.
 *   Hearts   the heart, then how many accounts gave one. The heart is the
 *            panel's one button: a tinted circle before it is given, and,
 *            given, a red heart on a quiet circle (a state that is done gets
 *            no fill). Pressing it again takes the heart back. With no
 *            hearts yet the cell says "Be the first".
 *
 * The plays cell leads because it is the larger number and nothing in it can
 * be pressed; the heart sits beside its own count.
 *
 * `useHeart` is the heart's state for a page: what the server said, moved at
 * once on a press and put back if the save fails. A visitor with no account
 * has no heart to give: `onSignIn` opens the sign-in sheet, and the heart is
 * kept for the account (./popularity.ts rememberHeart) and given by the
 * first panel drawn for that app once somebody is signed in.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { HeartIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { useMessages } from '../../lib/i18n/react';
import { rememberHeart, saveHeart, shownPlays, takePendingHeart, type HeartState } from './popularity';

/** The card, as the lists beside it are drawn: 20px, one hairline. */
const CARD = 'flex overflow-hidden rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';
const CELL = 'flex min-w-0 flex-1 flex-col items-center gap-1 px-4 pb-3.5 pt-3';
const CELL_LINE = 'shadow-[inset_1px_0_0_var(--app-sheet-line)]';
const LABEL = 'text-xs font-semibold leading-4 tracking-[0.02em] text-zinc-500 dark:text-zinc-400';
const NUMBER = 'text-[26px] font-bold leading-9 tracking-[-0.01em] tabular-nums text-zinc-900 dark:text-zinc-100';
const FIRST = 'text-[15px] font-semibold leading-9 text-zinc-900 dark:text-zinc-100';
const HEART = 'un-touch-target flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-60';
const HEART_GIVE = 'bg-rose-100 text-rose-700 hover:bg-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:hover:bg-rose-900';
const HEART_GIVEN = 'bg-white text-rose-600 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-50 dark:bg-zinc-900 dark:text-rose-400 dark:hover:bg-zinc-800';

/**
 * A page's heart for one app. `initial` is what the page's own read said
 * (null until it has answered); a press moves it at once and the save's
 * answer settles it. `signedIn` false: pressing asks to sign in instead.
 */
export function useHeart({ slug, initial, signedIn, onSignIn }: {
  slug: string;
  initial: HeartState | null;
  signedIn: boolean;
  onSignIn?: () => void;
}): { state: HeartState | null; busy: boolean; toggle: () => void } {
  const [state, setState] = useState<HeartState | null>(initial);
  const [busy, setBusy] = useState(false);
  const live = useRef(state);
  live.current = state;
  const hearted = initial ? initial.hearted : null;
  const hearts = initial ? initial.hearts : null;
  // The page's read answered, or answered again: it is what stands.
  useEffect(() => {
    setState(hearted == null || hearts == null ? null : { hearted, hearts });
  }, [slug, hearted, hearts]);

  const save = useCallback((next: boolean) => {
    const before = live.current;
    if (!before || before.hearted === next) return;
    setBusy(true);
    setState({ hearted: next, hearts: Math.max(0, before.hearts + (next ? 1 : -1)) });
    void saveHeart(slug, next).then((saved) => {
      setState(saved || before);
      setBusy(false);
    });
  }, [slug]);

  // The heart a visitor pressed before they had an account, given once the
  // page has read where things stand for them.
  const known = !!state;
  useEffect(() => {
    if (!signedIn || !known) return;
    if (takePendingHeart(slug)) save(true);
  }, [slug, signedIn, known, save]);

  const toggle = useCallback(() => {
    if (!signedIn) {
      rememberHeart(slug);
      onSignIn?.();
      return;
    }
    const now = live.current;
    if (now) save(!now.hearted);
  }, [slug, signedIn, onSignIn, save]);

  return { state, busy, toggle };
}

/** The panel. Draws nothing until the counts are known. */
export function HeartsPlays({ name, played, plays, heart, busy = false, onHeart, className, ...data }: {
  /** The app's name, for the heart's accessible name. */
  name: string;
  /** A game is played; anything else is opened. */
  played: boolean;
  plays: number;
  heart: HeartState | null;
  busy?: boolean;
  onHeart: () => void;
  className?: string;
} & { [key: `data-${string}`]: string | undefined }) {
  const t = useMessages('home');
  if (!heart) return null;
  const used = shownPlays(plays);
  return (
    <section {...data} data-hearts-plays="" aria-label={played ? t('home:popularity.labelPlays') : t('home:popularity.labelOpens')} className={cn(CARD, className)}>
      {used ? (
        <div data-hearts-plays-used={String(used)} className={CELL}>
          <span className={LABEL}>{played ? t('home:popularity.plays') : t('home:popularity.opens')}</span>
          <span className={NUMBER}>{used.toLocaleString()}</span>
        </div>
      ) : null}
      <div data-hearts-plays-hearts={String(heart.hearts)} className={cn(CELL, used ? CELL_LINE : '')}>
        <span className={LABEL}>{t('home:popularity.hearts')}</span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            data-heart={heart.hearted ? 'given' : ''}
            aria-pressed={heart.hearted}
            aria-label={heart.hearted ? t('home:popularity.takeBack', { app: name }) : t('home:popularity.give', { app: name })}
            disabled={busy}
            className={cn(HEART, heart.hearted ? HEART_GIVEN : HEART_GIVE)}
            onClick={onHeart}
          >
            <HeartIcon className={cn('h-5 w-5', heart.hearted ? 'fill-current' : '')} aria-hidden="true" />
          </button>
          {heart.hearts
            ? <span className={NUMBER}>{heart.hearts.toLocaleString()}</span>
            : <span className={FIRST} data-hearts-plays-first="">{t('home:popularity.beFirst')}</span>}
        </span>
      </div>
    </section>
  );
}
