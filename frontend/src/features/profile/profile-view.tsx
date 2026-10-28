/**
 * The contents of `#profile-root` (#1191 slice 6, conversion 1).
 *
 * Thin by construction: every branch below reads a field off the view
 * ./profile-store.js derives, and holds no opinion of its own about what the
 * screen should say. That split is what keeps the root `node --test` suite able
 * to assert on this screen's behaviour — it has no JSX transform, so a decision
 * expressed in this file would be a decision no test could reach.
 *
 * Me is the navigation prototype's Me (`scrMe`), regrouped by the navigation
 * review: the profile card and three stat cards, then the row lists of
 * ./account-panel.tsx — "Your work", "Rewards" (Challenges & standings,
 * Kudos) and "Account" (Friends, App slots), with a Settings card at the foot
 * on a phone. On a wide window (lg and up) the own profile is two columns:
 * who you are and your Account group on the left, Your work and Rewards on
 * the right — see ./profile-store.js's header for where each part of the
 * older, longer Profile went.
 *
 * The initial store state is `open: false`, whose view is `kind: 'empty'` and
 * renders nothing at all. That is the empty `#profile-root` the hand-written
 * shell shipped, so the prerender pass emits it and hydration matches. Data
 * arrives only from ./profile.js's effects, never from a render.
 */

import { type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { PLANE_FILL } from '@/components/ui/grouped-list';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import {
  buildProfileView,
  publicAvatarView,
  profileStore,
} from './profile-store.js';
import { Profile } from './profile.js';
import { KUDOS_PARKED } from '../leaderboard/kudos-parked';
import { AccountPanel, AdminPanel, RewardsPanel, SettingsPanel, WeekPanel, WorkPanel } from './account-panel';
import { FeedbackSheet } from './feedback-sheet';
import { FriendsSheet } from './friends-sheet';
import { ProfileEditSheet } from './profile-edit-sheet';
import { PublicProfileCard } from './public-profile-card';

/** The round picture, or the initial-in-a-circle fallback — the idiom the rest
 *  of the app already uses for people. */
function IdentityAvatar({ url, initial }: { url: string | null; initial: string }): ReactNode {
  if (url) {
    return (
      <img
        className="w-14 h-14 rounded-full object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0"
        src={url}
        alt=""
      />
    );
  }
  return (
    <div
      className={
        'w-14 h-14 text-xl rounded-full shrink-0 flex items-center justify-center '
        + 'font-bold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
      }
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}

/** Identity card (#982) — who this profile belongs to, and the way in to
 *  editing it. The prototype's compact card: the name, one muted line of
 *  facts ("@handle · Building since March 2026 · 3 apps"), then the bio. */
function IdentityCard({ identity }: { identity: any }): ReactNode {
  const t = useMessages('profile');
  return (
    <div
      id="profile-identity-card"
      className={`rounded-2xl ${PLANE_FILL} p-4 mb-3`}
    >
      {/*
          QA 2026-09-24 Q30e: on a phone "Edit profile" took the right half of
          the row, cutting the name to "[Staging de…" and wrapping the facts
          line to four lines. Below `sm` the button drops under the text,
          lined up with it (avatar 56px + gap 12px), and the name and facts
          get the card's whole width. From `sm` up it is the one row it was.
      */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-1 min-w-0 items-center gap-3">
          <IdentityAvatar url={identity.avatarUrl} initial={identity.initial} />
          <div className="flex-1 min-w-0">
            {/* Two lines at most, then an ellipsis: a long display name wraps
                rather than losing its end at the first line. */}
            <div className="text-[1.0625rem] font-bold break-words line-clamp-2">{identity.name}</div>
            {identity.sub ? (
              // Wraps rather than truncating: a fact cut off mid-word is not
              // a fact.
              <div className="text-sm text-zinc-500 dark:text-zinc-400">
                {identity.sub}
              </div>
            ) : null}
          </div>
        </div>
        <Button
          id="profile-edit-btn"
          layout="shrink"
          variant="neutral"
          size="sm"
          ink="neutral"
          className="self-start ml-[68px] sm:self-auto sm:ml-0"
          onClick={() => Profile.showEditSheet()}
        >
          {t('profile:identity.edit')}
        </Button>
      </div>
      {/*
          The bio is deliberately plain text, not markdown: React renders it as
          a text child, which is the whole safety story — no HTML string is ever
          built for it, here or anywhere.
      */}
      {identity.bio ? (
        /*
            `break-words` is load-bearing (#1612): a bio is free text, so it can
            be one 280-character word or a pasted URL with no space in it, and
            `whitespace-pre-line` alone leaves that on a single line — it spills
            past the card and gives the whole screen a horizontal scrollbar.
            `overflow-wrap: break-word` breaks such a run only when it would not
            otherwise fit, so ordinary prose still wraps at spaces and nothing
            else about the card changes.
        */
        <p className="text-sm text-zinc-600 dark:text-zinc-300 mt-3 whitespace-pre-line break-words">
          {identity.bio}
        </p>
      ) : null}
      {identity.chips.length ? (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {identity.chips.map((chip: any) => (
            <a
              key={chip.key}
              className={chip.className}
              href={chip.href}
              {...(chip.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              {chip.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// #5249: two stat cards while kudos is parked (merged, challenges), so the
// grid has two columns then. Complete literals, for Tailwind's extractor.
const STAT_GRID = KUDOS_PARKED ? 'grid grid-cols-2 gap-2 mb-2' : 'grid grid-cols-3 gap-2 mb-2';
const STAT_COUNT = KUDOS_PARKED ? 2 : 3;

/** The three stat cards (the prototype's `.stat`): merged, kudos, challenges.
 *  Numbers the Me screen never had until GET /api/me/summary added them up. */
function StatCards({ stats }: { stats: Array<{ key: string; value: string; label: string }> }): ReactNode {
  return (
    <div id="profile-stats" className={STAT_GRID}>
      {stats.map((stat) => (
        <div
          key={stat.key}
          data-profile-stat={stat.key}
          className={`rounded-2xl ${PLANE_FILL} px-2 py-3 text-center`}
        >
          <div className="text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{stat.value}</div>
          <div className="text-[0.8125rem] text-zinc-500 dark:text-zinc-400">{stat.label}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * The profile's loading state, at the SCREEN's own shape.
 *
 * It was the words "Loading profile…" centred in an otherwise empty screen.
 * What arrives now is the regrouped Me: the profile card, three stat cards,
 * the three "Your work" rows and the row groups after them, and this stands
 * in for each at its own geometry — the card's `rounded-2xl p-4` face with
 * the 56px avatar, a name and a facts line, and the Edit button's shape at
 * its right end (leaving it out would let the name line run to an edge the
 * real card never reaches); three short cards in a row; and lists of rows
 * with a leading tile and two lines of text. The skeleton takes the two-
 * column grid the loaded page uses (below lg it is the same single column),
 * so the page does not jump when the data arrives.
 */
function ProfileSkeleton(): ReactNode {
  const t = useMessages('profile');
  return (
    <SkeletonGroup label={t('profile:screen.loading')}>
      <div className="lg:grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-6 lg:items-start">
        <div className="lg:col-start-1 lg:row-start-1">
          <div className={`rounded-2xl ${PLANE_FILL} p-4 mb-3`}>
            <div className="flex items-center gap-3">
              <Skeleton shape="circle" className="w-14 h-14" />
              <div className="flex-1 min-w-0">
                <Skeleton className="w-40 h-4" />
                <Skeleton shape="muted" className="mt-2 w-48" />
              </div>
              <Skeleton shape="block" className="w-24 h-8 rounded-full" />
            </div>
          </div>
          {/* The three stat cards: a figure over its label. */}
          <div className={STAT_GRID}>
            {Array.from({ length: STAT_COUNT }, (_, i) => (
              <div key={i} className={`rounded-2xl ${PLANE_FILL} px-2 py-3 flex flex-col items-center`}>
                <Skeleton shape="block" className="w-8 h-6" />
                <Skeleton shape="muted" className="mt-1.5 w-14" />
              </div>
            ))}
          </div>
        </div>
        {/* Your work, then Rewards: the right column's rows. */}
        <div className="lg:col-start-2 lg:row-start-1 lg:row-span-2">
          {[3, KUDOS_PARKED ? 1 : 2].map((count, group) => (
            <div key={group} className={`mt-8 rounded-2xl ${PLANE_FILL}`}>
              {Array.from({ length: count }, (_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3.5">
                  <Skeleton shape="block" className="w-11 h-11 rounded-xl" />
                  <div className="flex-1 min-w-0">
                    <Skeleton className={i % 2 ? 'w-28' : 'w-40'} />
                    <Skeleton shape="muted" className="mt-2 w-48" />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        {/* Account: the two rows under the stats on the left. */}
        <div className="lg:col-start-1 lg:row-start-2">
          <div className={`mt-8 rounded-2xl ${PLANE_FILL}`}>
            {Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5">
                <Skeleton shape="block" className="w-11 h-11 rounded-xl" />
                <div className="flex-1 min-w-0">
                  <Skeleton className={i % 2 ? 'w-28' : 'w-40'} />
                  <Skeleton shape="muted" className="mt-2 w-48" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SkeletonGroup>
  );
}

export function ProfileRoot(): ReactNode {
  const state = useStoreState(profileStore);
  // Subscribed before the view is built: its lines are read as it is.
  const t = useMessages('profile');
  const view = buildProfileView(state);

  if (view.kind === 'empty') return null;
  if (view.kind === 'loading') return <ProfileSkeleton />;
  // signedOut is checked BEFORE error — see buildProfileView. A lapsed session
  // is a normal state, and the connection-error copy blames the network for it.
  if (view.kind === 'signedOut') {
    return (
      <div className="py-12 text-center lg:max-w-2xl lg:mx-auto">
        <div className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          {t('profile:signedOut.text')}
        </div>
        <a
          className={
            'inline-flex items-center justify-center px-4 min-h-[44px] rounded-lg '
            + 'bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium'
          }
          href="#login"
        >
          {t('profile:signedOut.signIn')}
        </a>
      </div>
    );
  }
  if (view.kind === 'error') {
    return (
      <div className="text-sm text-zinc-500 py-8 text-center dark:text-zinc-400 lg:max-w-2xl lg:mx-auto">
        {t('profile:screen.loadFailed')}
      </div>
    );
  }
  if (view.kind === 'publicNotFound') {
    return (
      <div className="text-sm text-zinc-500 py-12 text-center dark:text-zinc-400 lg:max-w-2xl lg:mx-auto">{t('profile:public.unavailable')}</div>
    );
  }
  if (view.kind === 'public') {
    // Another person's profile keeps the one column, at today's width.
    return (
      <div className="lg:max-w-2xl lg:mx-auto">
        <PublicProfileCard
          profile={view.profile}
          allowReport={view.allowReport}
          allowMessage={view.allowMessage}
          friendship={view.friendship}
        />
      </div>
    );
  }

  return (
    <>
      {state.sheetOpen ? (
        <ProfileEditSheet
          avatarUrl={view.identity.avatarUrl}
          initial={view.identity.initial}
          publicControls={view.publicControls}
          publicStatus={state.publicStatus}
          publishing={state.publishing}
          previewOpen={state.previewOpen}
          cropSource={state.cropSource}
          pendingPhoto={state.pendingAvatarUrl ? 'new' : state.pendingRemove ? 'removed' : null}
        />
      ) : null}
      {/* #3186: "Your feedback", the list `#profile?feedback` opens. */}
      {state.feedbackOpen ? <FeedbackSheet view={view.feedback} /> : null}
      {/* #2386: private to you, the Friends row's card (UI overhaul). */}
      {state.friendsOpen ? (
        <FriendsSheet
          view={view.friends ?? { loaded: false, incoming: [], friends: [], outgoing: [] }}
          pendingId={state.friendsPending ?? null}
          status={state.friendsStatus || ''}
        />
      ) : null}
      {/*
          Two columns from lg (the navigation review): who you are on the
          left, with your Account group under it; Your work and Rewards on
          the right, spanning both rows. Below lg the three blocks stack in
          this same DOM order: card, stats, Your work, Rewards, Your week
          (#5963, when there is time to show), Account, Settings. "Your
          work" (UI overhaul): Your changes, Your requests and Your votes,
          each a view of the Your work screen. "Rewards": Challenges &
          standings and Kudos. "Your week": the minutes per app since Monday
          and the three weeks before. "Account": Friends and App slots. Admin & moderation, the native node / wallet / staking rows
          and Log out are in Settings (features/settings/account-rows.tsx);
          the Settings card under this ends the screen at every width (#5557).
          Your contributions, which closed the screen, is gone: Your changes
          lists every merged one.
      */}
      <div className="lg:grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-6 lg:items-start">
        <div className="lg:col-start-1 lg:row-start-1">
          <IdentityCard identity={view.identity} />
          <StatCards stats={view.stats} />
        </div>
        <div className="lg:col-start-2 lg:row-start-1 lg:row-span-2">
          <WorkPanel rows={view.rows} />
          <RewardsPanel rows={view.rows} />
          <WeekPanel week={view.week} />
        </div>
        <div className="lg:col-start-1 lg:row-start-2">
          <AccountPanel rows={view.rows} />
          <SettingsPanel />
          <AdminPanel />
        </div>
      </div>
    </>
  );
}

export { publicAvatarView };
