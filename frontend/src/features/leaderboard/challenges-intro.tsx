/**
 * "How challenges work": the explainer at the top of the Challenges tab
 * (first-session run-through, 5 October 2026, item 17). A newcomer opened
 * the tab onto a progress line and a list of cards with nothing to say what
 * they were for. Evan chose the three-row version, and its words are his.
 *
 * ── Where it sits ──────────────────────────────────────────────────────
 *
 * First inside #tc-se-grid (./challenges-pane.tsx), above the viewer's own
 * standing. The grid steps aside while a challenge's page is open, and this
 * goes with it: the page is a level of the screen, and an explainer of the
 * list has no place on one challenge's page.
 *
 * ── Closing it ─────────────────────────────────────────────────────────
 *
 * The ✕ closes it on this device. The answer is kept in localStorage, keyed
 * by the account, the way this browser keeps the tour's "done"
 * (../home/tour/tour-storage.ts), so two accounts on one phone each get
 * their own. In its place a quiet "How challenges work" link brings it back.
 *
 * Per device rather than per account because there is no per-account
 * preference store to keep it in: each answer the account keeps is a column
 * and a route of its own (`users.tour_done_at`, POST /api/me/tour-done). A
 * card someone closed coming back on a new device costs one tap.
 *
 * Every access is wrapped, because Safari throws on storage in private mode.
 * A read that throws SHOWS the card; a close that cannot be stored still
 * closes it for this visit; a bring-back that cannot clear the flag still
 * brings it back now.
 *
 * ── The island rules ───────────────────────────────────────────────────
 *
 * Nothing here reaches the prerendered shell. ChallengesPane renders nothing
 * until the pane has mounted, which happens client side on its first open,
 * so this component's first render is never a hydration and it may read
 * storage in its state initializer. That is what keeps a closed card from
 * flashing open for a frame before an effect could close it. No ids: the
 * `data-challenges-intro` attribute names its state for checks and tests.
 *
 * ── The language ───────────────────────────────────────────────────────
 *
 * The shape Home's Getting started card had (retired by #4635): a
 * GroupedList in the plane tone, its header (a 15px title in sentence case,
 * the round ✕), and rows that are ListRows, 15 over 13 beside an IconTile.
 * The rows' lines are sentences, so they wrap rather than truncate. The
 * link is the accent as text only, as "Past seasons" is: nothing is filled,
 * because nothing here is an action that asks anything of the viewer.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';

import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { ArrowPathIcon, CheckIcon, TrophyIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';

// Message ids (frontend/locales/en/leaderboard.json), read when the card renders.
export const INTRO_TITLE = 'leaderboard:challenges.intro.title';

export const INTRO_ROWS = [
  { key: 'counts', title: 'leaderboard:challenges.intro.counts.title', subtitle: 'leaderboard:challenges.intro.counts.text' },
  { key: 'points', title: 'leaderboard:challenges.intro.points.title', subtitle: 'leaderboard:challenges.intro.points.text' },
  {
    key: 'weekly',
    title: 'leaderboard:challenges.intro.weekly.title',
    subtitle: 'leaderboard:challenges.intro.weekly.text',
  },
] as const;

const ICONS = { counts: CheckIcon, points: TrophyIcon, weekly: ArrowPathIcon } as const;

// ── This device's answer ───────────────────────────────────────────────

const KEY_PREFIX = 'usernode:challenges-intro-closed:';

/** The key for one account on this device; a signed-out viewer shares one. */
export function introKey(userId: number | null | undefined): string {
  return `${KEY_PREFIX}${userId == null ? 'guest' : userId}`;
}

/** Has this account closed the card on this device? False when storage refuses. */
export function readClosed(userId: number | null | undefined): boolean {
  try {
    return localStorage.getItem(introKey(userId)) === '1';
  } catch {
    return false;
  }
}

/** Remember the close, or forget it; a refusal changes nothing on screen. */
export function writeClosed(userId: number | null | undefined, closed: boolean): void {
  try {
    if (closed) localStorage.setItem(introKey(userId), '1');
    else localStorage.removeItem(introKey(userId));
  } catch {
    /* Private mode: the card closes, or comes back, for this visit only. */
  }
}

function viewerId(): number | null {
  const id = typeof window !== 'undefined'
    ? (window as unknown as { App?: { user?: { id?: number } | null } }).App?.user?.id
    : null;
  return typeof id === 'number' ? id : null;
}

// ── The two faces ──────────────────────────────────────────────────────

const HEAD = 'flex items-start gap-3 px-4 pb-1 pt-4';
const TITLE = 'min-w-0 flex-1 text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100';
const CLOSE = '-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-500/10 dark:text-zinc-400';
const LINK = 'mb-4 text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline';

export interface ChallengesIntroViewProps {
  closed: boolean;
  onClose: () => void;
  onOpen: () => void;
  closeRef?: Ref<HTMLButtonElement>;
  linkRef?: Ref<HTMLButtonElement>;
}

export function ChallengesIntroView({ closed, onClose, onOpen, closeRef, linkRef }: ChallengesIntroViewProps): ReactNode {
  const t = useMessages('leaderboard');
  if (closed) {
    return (
      <button ref={linkRef} type="button" className={LINK} data-challenges-intro="closed" onClick={onOpen}>
        {t(INTRO_TITLE)}
      </button>
    );
  }
  return (
    <section aria-label={t(INTRO_TITLE)} className="mb-4" data-challenges-intro="open">
      <GroupedList tone="plane" className="mx-0">
        <div className={HEAD}>
          <div className={TITLE}>{t(INTRO_TITLE)}</div>
          <button
            ref={closeRef}
            type="button"
            className={CLOSE}
            aria-label={t('leaderboard:challenges.intro.close')}
            title={t('core:common.close')}
            data-challenges-intro-close=""
            onClick={onClose}
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {INTRO_ROWS.map((row) => {
          const Icon = ICONS[row.key];
          return (
            <ListRow
              key={row.key}
              as="div"
              chevron={false}
              leading={<IconTile size="sm"><Icon aria-hidden="true" /></IconTile>}
              title={t(row.title)}
              subtitle={t(row.subtitle)}
              titleClassName="whitespace-normal"
              subtitleClassName="whitespace-normal"
            />
          );
        })}
      </GroupedList>
    </section>
  );
}

// ── The component the pane draws ───────────────────────────────────────

export function ChallengesIntro(): ReactNode {
  const [closed, setClosed] = useState(() => readClosed(viewerId()));
  // Focus follows a tap: closing puts it on the link that replaced the card,
  // and bringing the card back puts it on the card's ✕, rather than leaving
  // it on a button that is no longer there. Not on the first render.
  const toggled = useRef(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const linkRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    (closed ? linkRef : closeRef).current?.focus();
  }, [closed]);

  const set = (next: boolean) => {
    writeClosed(viewerId(), next);
    toggled.current = true;
    setClosed(next);
  };
  return (
    <ChallengesIntroView
      closed={closed}
      onClose={() => set(true)}
      onOpen={() => set(false)}
      closeRef={closeRef}
      linkRef={linkRef}
    />
  );
}
