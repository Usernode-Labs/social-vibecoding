/**
 * A public project's page for a visitor with no account (features/auth/
 * landing.tsx draws it in Home's place for `#app/<slug>…` while signed
 * out, under the signed-out site's own bar: the wordmark, Sign in and Sign
 * up). A member sees the same page from the hub's ⋯, "See what visitors
 * see" (./visitor-view.tsx), and nothing on it differs for them.
 *
 * ONE PAGE, NO TABS (the hand-off of 11 Nov 2026). Top to bottom:
 *
 *   All communities   the way back to Home, a white sticker chip.
 *   The project card  its picture (the preview loop, else the featured
 *                     illustration, else its icon), its name and what it
 *                     says it is, and three buttons (./project-card.tsx).
 *                     Pressing the picture does what the first button does.
 *                     "Open <name>" where the app has a view for somebody
 *                     with no account (./guest-discover.tsx TryLink), else
 *                     "Sign up to open" with a line under it saying it needs
 *                     a free account. Join and Share beside it. No Pin.
 *                     Under the buttons, one line of who is around: who it
 *                     is for, how many are in it and how many were active
 *                     this week, numbers only (its own strip until the
 *                     signed-out page's redesign, 26 Nov 2026).
 *   Hearts and plays  how many times the app was played (or opened) and how
 *                     many accounts gave it a heart, with the heart to give
 *                     one (../popularity/hearts-plays.tsx). Signed out, the
 *                     heart asks to sign in and is given once the account
 *                     exists.
 *   The join card     "Made by the people who play it.", how many changes
 *                     went live this month, and Sign up to vote and suggest.
 *   Up for a vote     compact rows: a small after picture, the title and
 *                     the tally. Two, then "N more up for a vote". A row
 *                     opens the change (GuestChange): its before & after
 *                     with a slider, and Join to vote.
 *   Recently live     the last three changes that went live, each with
 *                     when and who said yes ("Approved by community" when
 *                     more than one person did), and how many more did
 *                     this month.
 *   Top contributors  the member hub's card, for visitors too
 *                     (./guest-contributors.tsx): the one place this page
 *                     names anybody.
 *
 * "What it's like", the strip of after pictures, is gone: it showed the
 * same changes as Recently live.
 *
 * Read from GET /api/public/apps/:slug/overview (src/services/
 * public-project.js), which carries no names on purpose: how many, not who.
 * Top contributors reads its own route. Taking part (Join, Vote, Sign up to
 * open) opens the sign-in sheet titled for it, and signing in lands back
 * here (`onIntent`).
 */

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/grouped-list';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, ShareIcon, UserGroupIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useCommunityColor } from '../../lib/community-color';
import { agoStamp } from '../../lib/timestamp';
import { GuestIcon, TryLink } from './guest-discover';
import { GuestContributors } from './guest-contributors';
import { GuestDiscussion } from './guest-discussion';
import { HeartsPlays, useHeart } from '../popularity/hearts-plays';
import { readHeart, type HeartState } from '../popularity/popularity';
import { CARD_GLASS_BTN, CARD_OPEN_BTN, CARD_ROUND_BTN, PEOPLE_CARD, ProjectCard } from './project-card';
import {
  type GuestApp, type GuestMerged, type GuestOverview, type GuestTopContributors, type GuestVote, MIN_ACTIVE,
  MIN_MEMBERS, canTryHere, fetchOverview, inHomeroomApp,
} from './guest-data';

/** What somebody tried to do: the sign-in sheet is titled for it. */
export type GuestIntent =
  | { kind: 'join'; app: GuestApp }
  | { kind: 'vote'; app: GuestApp; change: string }
  | { kind: 'ask'; app: GuestApp }
  | { kind: 'chat'; app: GuestApp }
  | { kind: 'heart'; app: GuestApp }
  | { kind: 'use'; app: GuestApp };

/** The changes each list shows before its "N more" row opens the rest. */
export const VOTES_SHOWN = 2;
export const LIVE_SHOWN = 3;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

const SECTION = 'mt-8 md:mt-9';
/**
 * The page's way back, a white sticker chip (27 Nov 2026): the surface's
 * white on the ink outline with the hard edge under it, drawn at 36px and
 * 44px to a finger (`un-touch-target`). It was a 44px pill in the header's
 * periwinkle tint, the header's own ink on a page that is not the header.
 */
export const BACK_CHIP = 'un-touch-target inline-flex h-9 items-center gap-1 self-start rounded-full bg-[var(--one-surface)] ps-2.5 pe-3.5 text-[14px] font-semibold text-[color:var(--one-ink)] shadow-[inset_0_0_0_1px_var(--one-edge-line),1.5px_1.5px_0_0_var(--one-edge-shade)]';
const ROW_LINE = 'shadow-[inset_0_-1px_0_var(--app-sheet-line)]';
/** A list's closing row ("10 more up for a vote"): the plane under the rows. */
const MORE_ROW = 'flex min-h-[56px] w-full items-center gap-3 bg-zinc-50 px-3.5 py-2 text-start dark:bg-zinc-800/60';
const MORE_PILL = 'inline-flex h-8 min-w-[56px] shrink-0 items-center justify-center rounded-lg bg-violet-100 px-2 text-[13px] font-bold text-violet-700 dark:bg-violet-950 dark:text-violet-300';

/** A game is played; anything else is used. */
function playsIt(app: GuestApp): boolean {
  return app.category === 'games';
}

/** Whether a change went live within the last thirty days (the month's count). */
function thisMonth(m: GuestMerged, now: number): boolean {
  const at = m.merged_at ? Date.parse(m.merged_at) : NaN;
  return Number.isFinite(at) && now - at <= MONTH_MS;
}

/** The words for who said yes to a change that went live (GuestMerged.approved_by), or null to say nothing. */
export function approvedId(by: GuestMerged['approved_by']): string | null {
  if (by === 'community') return 'auth:guest.project.approved.community';
  if (by === 'creator') return 'auth:guest.project.approved.creator';
  if (by === 'member') return 'auth:guest.project.approved.member';
  return null;
}

/** The project's tile on its colour, where a change has no picture anybody may see. */
function TilePicture({ app, color, className }: { app: GuestApp; color: string; className: string }) {
  return (
    <span className={cn('flex items-center justify-center overflow-hidden', className)} style={{ background: color }} aria-hidden="true">
      <GuestIcon app={app} size="sm" />
    </span>
  );
}

/**
 * One change up for a vote, as a row: its small after picture, its title,
 * the tally under it and a chevron. The row opens the change, where Join to
 * vote is. One form at every width: the rows sit in the side column from
 * 768px (27 Nov 2026), which is no wider than a phone, so the wide row a
 * 768 to 1023px window drew (a before & after badge, a line of the summary
 * and a Vote button) has no window left to show in.
 */
function VoteRow({ vote, app, color, last, onOpen }: {
  vote: GuestVote;
  app: GuestApp;
  color: string;
  last: boolean;
  onOpen: () => void;
}) {
  const t = useMessages('auth');
  const title = vote.title || t('auth:guest.project.untitledChange');
  const pic = vote.pictures?.after || null;
  return (
    <div data-guest-vote={vote.id} className={cn('flex items-center gap-2 pe-3.5', last ? '' : ROW_LINE)}>
      <button type="button" data-guest-vote-open="" className="flex min-h-[72px] min-w-0 flex-1 items-center gap-3.5 py-2.5 ps-3.5 text-start" onClick={onOpen}>
        <span className="relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-xl bg-zinc-100 dark:bg-zinc-800">
          {pic ? (
            <img src={pic} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover object-top" />
          ) : (
            <TilePicture app={app} color={color} className="h-full w-full" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{title}</span>
          <span className="block text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{t('auth:guest.project.yes', { count: vote.yes })}</span>
        </span>
        <ChevronRightIcon className="h-[18px] w-[18px] shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * A Recently live row's second line: when it went live, then who said yes,
 * a small green check and muted words ("1h ago ✓ Approved by community").
 * Nothing about the yeses when none was counted (a first version).
 */
function LiveLine({ merged }: { merged: GuestMerged }) {
  const t = useMessages('auth');
  const approved = approvedId(merged.approved_by);
  if (!merged.merged_at && !approved) return null;
  const stamp = merged.merged_at ? agoStamp(merged.merged_at) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
      {stamp ? <span title={stamp.title}>{stamp.text}</span> : null}
      {approved ? (
        <span data-guest-merged-approved={merged.approved_by || ''} className="inline-flex items-center gap-1">
          <CheckIcon className="h-3.5 w-3.5 shrink-0 text-[color:var(--state-ok)]" aria-hidden="true" />
          {t(approved)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A change opened from Up for a vote: its title and summary, its before and
 * after with a slider between them, the tally, and Join to vote. The page's
 * chip goes back to the project.
 */
export function GuestChange({ vote, app, signedIn = false, onBack, onIntent }: {
  vote: GuestVote;
  app: GuestApp;
  signedIn?: boolean;
  onBack: () => void;
  onIntent: (i: GuestIntent) => void;
}) {
  const t = useMessages('auth');
  const title = vote.title || t('auth:guest.project.untitledChange');
  const before = vote.pictures?.before || null;
  const after = vote.pictures?.after || null;
  // Where the seam is, from the left: Before shows to its left, After to its right.
  const [seam, setSeam] = useState(50);
  return (
    <div data-guest-change={vote.id} className="flex flex-col gap-4">
      <button
        type="button"
        data-guest-change-back=""
        aria-label={t('auth:guest.project.change.back', { project: app.name })}
        className={BACK_CHIP}
        onClick={onBack}
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        {app.name}
      </button>
      <article className={cn(PEOPLE_CARD, 'flex flex-col gap-3 p-4 md:p-5')}>
        <SectionHeader className="p-0">{t('auth:guest.project.upForVote')}</SectionHeader>
        <div>
          <h2 className="text-[20px] font-bold leading-[26px] text-zinc-900 dark:text-zinc-100">{title}</h2>
          {vote.summary ? <p className="mt-1 text-[15px] leading-[21px] text-zinc-600 dark:text-zinc-300">{vote.summary}</p> : null}
        </div>
        {after ? (
          <div className="flex flex-col gap-2.5">
            <div data-guest-change-compare="" className="relative h-[min(62vh,520px)] overflow-hidden rounded-2xl bg-zinc-50 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800">
              <img src={after} alt={t('auth:guest.project.after')} draggable={false} className="absolute inset-0 h-full w-full object-contain" />
              {before ? (
                <>
                  <img
                    src={before}
                    alt={t('auth:guest.project.before')}
                    draggable={false}
                    className="absolute inset-0 h-full w-full object-contain"
                    style={{ clipPath: `inset(0 ${100 - seam}% 0 0)` }}
                  />
                  <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-violet-600" style={{ insetInlineStart: `${seam}%` }} aria-hidden="true" />
                  <span className="absolute start-2.5 top-2.5 rounded-full bg-zinc-950/70 px-2 py-0.5 text-[11px] font-bold text-white">{t('auth:guest.project.before')}</span>
                </>
              ) : null}
              <span className="absolute end-2.5 top-2.5 rounded-full bg-zinc-950/70 px-2 py-0.5 text-[11px] font-bold text-white">{t('auth:guest.project.after')}</span>
            </div>
            {before ? (
              <label className="flex items-center gap-3 text-[13px] text-zinc-500 dark:text-zinc-400">
                <span aria-hidden="true">{t('auth:guest.project.before')}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={seam}
                  data-guest-change-slider=""
                  aria-label={t('auth:guest.project.change.slider')}
                  className="h-11 min-w-0 flex-1 accent-violet-600"
                  onChange={(e) => setSeam(Number(e.currentTarget.value))}
                />
                <span aria-hidden="true">{t('auth:guest.project.after')}</span>
              </label>
            ) : null}
          </div>
        ) : null}
        <div className={cn('flex flex-wrap items-center gap-3 pt-3', 'shadow-[inset_0_1px_0_var(--app-sheet-line)]')}>
          <span className="min-w-0 flex-1 text-[15px] text-zinc-600 dark:text-zinc-300">
            {t('auth:guest.project.change.tally', { yes: vote.yes, no: vote.no })}
          </span>
          {signedIn ? (
            <span data-guest-vote-later="" className="text-[13px] font-semibold text-zinc-500 dark:text-zinc-400">{t('auth:guest.project.voteLater')}</span>
          ) : (
            <Button
              type="button"
              variant="pillAccent"
              size="none"
              ink="solid"
              data-guest-change-join=""
              className="h-11 px-5 text-[15px] font-bold"
              onClick={() => onIntent({ kind: 'vote', app, change: title })}
            >
              {t('auth:guest.project.change.joinToVote')}
            </Button>
          )}
        </div>
      </article>
    </div>
  );
}

export function GuestProject({ app, onIntent, onOpenInside, onShare, onAllCommunities, signedIn = false, preview = false, initialOverview = null, initialContributors = null }: {
  /** The project's card from the public directory. */
  app: GuestApp;
  /**
   * An account still on the waitlist is looking (landing.tsx): every public
   * app opens for it, signed in, and joining and voting wait until it is let
   * in. A member's "See what visitors see" is NOT this: it is a visitor's
   * page exactly (./visitor-view.tsx).
   */
  signedIn?: boolean;
  /** The landing's pill class. The card draws its own buttons now; kept so callers need not change. */
  primaryClass?: string;
  onIntent: (intent: GuestIntent) => void;
  /** Open the app in the page's own viewer; `from` is what was pressed (Open, or the card's picture), for the app to grow out of. */
  onOpenInside: (app: GuestApp, from?: HTMLElement | null) => void;
  onShare: (app: GuestApp) => void;
  /** The All communities chip: back to Home. */
  onAllCommunities?: () => void;
  /**
   * A member looking at it from the hub's ⋯ (./visitor-view.tsx): the page
   * is a visitor's in every way, and Open hands the app to `onOpenInside`.
   */
  preview?: boolean;
  /** The overview already read (the visitor view reads it to find the app). */
  initialOverview?: GuestOverview | null;
  /** Top contributors already read (tests); otherwise the card reads its own. */
  initialContributors?: GuestTopContributors | null;
}) {
  const t = useMessages('auth');
  const color = useCommunityColor({ color: app.icon_color, iconUrl: app.icon_url, iconEmoji: app.icon_emoji, key: app.slug });
  const [overview, setOverview] = useState<GuestOverview | null>(initialOverview);
  const [loaded, setLoaded] = useState(!!initialOverview);
  // The change opened from Up for a vote, and whether each list is open in full.
  const [opened, setOpened] = useState<number | null>(null);
  const [allVotes, setAllVotes] = useState(false);
  const [allLive, setAllLive] = useState(false);

  useEffect(() => {
    let live = true;
    setOpened(null);
    setAllVotes(false);
    setAllLive(false);
    if (initialOverview && initialOverview.app.slug === app.slug) {
      setOverview(initialOverview);
      setLoaded(true);
      return () => { live = false; };
    }
    setOverview(null);
    setLoaded(false);
    void fetchOverview(app.slug).then((o) => {
      if (!live) return;
      setOverview(o);
      setLoaded(true);
    });
    return () => { live = false; };
  }, [app.slug, initialOverview]);

  // Whether the signed-in reader gave it a heart: undefined while asked.
  const [mine, setMine] = useState<HeartState | null | undefined>(undefined);
  useEffect(() => {
    if (!signedIn) return undefined;
    let live = true;
    setMine(undefined);
    void readHeart(app.slug).then((state) => { if (live) setMine(state); });
    return () => { live = false; };
  }, [app.slug, signedIn]);

  // A change opened, or closed again, starts at the top of the page.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.getElementById('auth-landing-scroll')?.scrollTo?.(0, 0);
    document.querySelector('[data-visitor-view-scroll]')?.scrollTo?.(0, 0);
  }, [opened]);

  const canTry = signedIn || canTryHere(app, inHomeroomApp());

  const now = Date.now();
  const votes = overview?.votes || [];
  const voteCount = Math.max(overview?.app.open_votes ?? app.open_votes ?? 0, votes.length);
  const merged = overview?.merged || [];
  const month = Math.max(0, Number(overview?.activity?.merged_month) || 0);
  // Counts only from the minimums (guest-data MIN_ACTIVE, MIN_MEMBERS): a
  // small one reads as a project nobody uses, so it says nothing.
  const activeWeek = Number(overview?.activity?.active_week) || 0;
  const active = activeWeek >= MIN_ACTIVE ? activeWeek : 0;
  const members = (app.member_count || 0) >= MIN_MEMBERS ? app.member_count || 0 : 0;
  const openVote = opened == null ? null : votes.find((v) => v.id === opened) || null;
  // HEARTS AND PLAYS (../popularity/). The counts are the directory's, and
  // the overview's once it has answered. A visitor has no heart of their
  // own; for somebody signed in the page asks whether they gave one, and a
  // read that fails is drawn as not given rather than as no panel.
  const plays = overview?.app.plays ?? app.plays ?? 0;
  const hearts = overview?.app.hearts ?? app.hearts ?? 0;
  const heart = useHeart({
    slug: app.slug,
    initial: !signedIn ? { hearted: false, hearts } : mine === undefined ? null : mine || { hearted: false, hearts },
    signedIn,
    onSignIn: () => onIntent({ kind: 'heart', app }),
  });

  const votesShown = allVotes ? votes : votes.slice(0, VOTES_SHOWN);
  const votesMore = Math.max(0, voteCount - votesShown.length);
  const liveShown = allLive ? merged : merged.slice(0, LIVE_SHOWN);
  const liveMore = Math.max(0, month - liveShown.filter((m) => thisMonth(m, now)).length);

  if (openVote) {
    return (
      <div data-guest-project={app.slug} className="mx-auto flex w-full max-w-3xl flex-col px-4 pb-10 pt-4">
        <GuestChange vote={openVote} app={app} signedIn={signedIn} onBack={() => setOpened(null)} onIntent={onIntent} />
      </div>
    );
  }

  const openLabel = t('auth:guest.project.openNamed', { project: app.name });
  // Whether Open keeps the app inside Homeroom (TryLink): then the picture does too.
  const openInside = signedIn || preview || app.guest_ready === true;
  // THE PICTURE DOES WHAT THE FIRST BUTTON SAYS (27 Nov 2026). Open where the
  // app can be tried: in the page's viewer, growing out of the picture, or
  // at the app's own address where Open's link goes there. Where the app
  // needs an account it asks to sign up for it, as "Sign up to open" does.
  const openFromPicture = (from: HTMLElement) => {
    if (!canTry) { onIntent({ kind: 'use', app }); return; }
    if (openInside || app.requires_login === false) { onOpenInside(app, from); return; }
    if (app.url && typeof window !== 'undefined') window.location.assign(app.url);
  };
  const actions = (
    <>
      {canTry ? (
        <TryLink app={app} inside={openInside} onOpenInside={onOpenInside} className={CARD_OPEN_BTN}>
          <span className="truncate">{openLabel}</span>
        </TryLink>
      ) : (
        <button type="button" data-guest-use="" className={CARD_OPEN_BTN} onClick={() => onIntent({ kind: 'use', app })}>
          <span className="truncate">{t('auth:guest.project.signUpToOpen')}</span>
        </button>
      )}
      {signedIn ? null : (
        <button type="button" data-guest-join-project="" className={CARD_GLASS_BTN} onClick={() => onIntent({ kind: 'join', app })}>
          {t('auth:guest.project.join')}
        </button>
      )}
      <button
        type="button"
        data-guest-share=""
        aria-label={t('auth:guest.project.share')}
        className={CARD_ROUND_BTN}
        onClick={() => onShare(app)}
      >
        <ShareIcon className="h-5 w-5" aria-hidden="true" />
      </button>
    </>
  );
  // Who is around, under the buttons: who it is for and how many are in it,
  // then how many were active this week, numbers only and each from its
  // minimum (guest-data MIN_MEMBERS, MIN_ACTIVE), where a small one reads as
  // a project nobody uses. Two whole messages on one line, a dot between.
  const facts = members || active ? (
    <p data-guest-people="" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[14px] leading-5 text-white/80">
      <UserGroupIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {members ? (
        <span data-guest-people-members="">
          <RichMessage
            id="auth:guest.project.audienceMembers"
            values={{ count: members }}
            components={[<b className="font-[650] text-white" />]}
          />
        </span>
      ) : null}
      {members && active ? <span aria-hidden="true">·</span> : null}
      {active ? (
        <b data-guest-people-active="" className="font-[650] text-white">
          {t('auth:guest.project.activeWeek', { count: active })}
        </b>
      ) : null}
    </p>
  ) : null;
  const note = (
    <>
      {facts}
      {canTry ? null : (
        <p data-guest-needs-account="" className="text-[14px] leading-5 text-white/80">
          {playsIt(app)
            ? t('auth:guest.project.needsAccountPlay', { project: app.name })
            : t('auth:guest.project.needsAccountUse', { project: app.name })}
        </p>
      )}
    </>
  );

  return (
    <div data-guest-project={app.slug} className="mx-auto flex w-full flex-col px-4 pb-10 pt-4">
      <button
        type="button"
        data-guest-all-communities=""
        className={cn(BACK_CHIP, 'mb-3.5')}
        onClick={() => onAllCommunities?.()}
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        {t('auth:guest.project.allCommunities')}
      </button>

      <ProjectCard
        place="guest"
        app={app}
        cover={app}
        color={color}
        description={app.description}
        actions={actions}
        note={note}
        onOpenPicture={openFromPicture}
        data-guest-project-band=""
      />

      {/* TWO COLUMNS FROM 768px (f-so2, 26 Nov 2026; from 1024px until
          27 Nov): as the member's hub, a side column of the join card, Up
          for a vote, Recently live and Top contributors, and the project's
          Discussion beside it. The column is 300px up to 1024px, where the
          Discussion still gets 416px of a 768px window (more than a phone
          gives it, and 768px is where it stops being the phone's preview),
          and 340px from there. Narrower, one column: on a phone (f-so3) the
          Discussion's card comes after Up for a vote, the side column's
          parts placed around it by `order` (the column is `contents`). */}
      <div data-guest-cols="" className="flex flex-col md:mt-8 md:grid md:grid-cols-[300px_minmax(0,1fr)] md:items-start md:gap-5 lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-6">
      <div data-guest-side="" className="contents md:flex md:min-w-0 md:flex-col md:[&>*:first-child]:mt-0">
      {/* Hearts and plays lead the column, above the join card (owner, 27 Nov
          2026): what a visitor reads first is how much it is played and liked. */}
      {heart.state ? (
        <div data-guest-popularity="" className={cn(SECTION, 'order-1 md:order-none')}>
          <HeartsPlays
            name={app.name}
            played={playsIt(app)}
            plays={plays}
            heart={heart.state}
            busy={heart.busy}
            onHeart={heart.toggle}
          />
        </div>
      ) : null}
      <section data-guest-made="" className={cn(SECTION, 'order-1 md:order-none')}>
        <div className={cn(PEOPLE_CARD, 'flex flex-col gap-4 p-4 md:p-5')}>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-bold leading-6 text-zinc-900 dark:text-zinc-100">
              {playsIt(app) ? t('auth:guest.project.madeByPlayers') : t('auth:guest.project.madeByUsers')}
            </h2>
            <p className="mt-1 text-[15px] leading-[21px] text-zinc-600 dark:text-zinc-300">
              {month > 0 ? t('auth:guest.project.membersVoteMonth', { count: month }) : t('auth:guest.project.membersVote')}
            </p>
          </div>
          {signedIn ? (
            <p className="text-[13px] font-semibold text-zinc-500 dark:text-zinc-400">{t('auth:guest.project.joinLater')}</p>
          ) : (
            <Button
              type="button"
              variant="pillAccent"
              size="none"
              ink="solid"
              data-guest-made-join=""
              className="h-12 w-full shrink-0 px-6 text-[16px] font-bold"
              onClick={() => onIntent({ kind: 'join', app })}
            >
              {t('auth:guest.project.signUpToVoteSuggest')}
            </Button>
          )}
        </div>
      </section>

      {votes.length ? (
        <section data-guest-votes="" className={cn(SECTION, 'order-2 md:order-none')}>
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <SectionHeader className="p-0">{t('auth:guest.project.upForVoteCount', { count: voteCount })}</SectionHeader>
            {!allVotes && votes.length > VOTES_SHOWN ? (
              <button type="button" data-guest-votes-all="" className="un-touch-target text-[15px] font-semibold text-violet-700 dark:text-violet-300" onClick={() => setAllVotes(true)}>
                {t('auth:guest.project.seeAllCount', { count: voteCount })}
              </button>
            ) : null}
          </div>
          <div className={cn(PEOPLE_CARD, 'overflow-hidden')}>
            {votesShown.map((v, i) => (
              <VoteRow
                key={v.id}
                vote={v}
                app={app}
                color={color}
                last={i === votesShown.length - 1 && !votesMore}
                onOpen={() => setOpened(v.id)}
              />
            ))}
            {votesMore ? (
              allVotes || votes.length <= VOTES_SHOWN ? (
                <div data-guest-votes-more="" className={MORE_ROW}>
                  <span className={MORE_PILL}>{t('auth:guest.project.morePill', { count: votesMore })}</span>
                  <span className="flex-1 text-[15px] font-semibold text-zinc-700 dark:text-zinc-300">{t('auth:guest.project.moreVotes', { count: votesMore })}</span>
                </div>
              ) : (
                <button type="button" data-guest-votes-more="" className={MORE_ROW} onClick={() => setAllVotes(true)}>
                  <span className={MORE_PILL}>{t('auth:guest.project.morePill', { count: votesMore })}</span>
                  <span className="flex-1 text-[15px] font-semibold text-violet-700 dark:text-violet-300">{t('auth:guest.project.moreVotes', { count: votesMore })}</span>
                  <ChevronRightIcon className="h-[18px] w-[18px] text-violet-700 dark:text-violet-300" aria-hidden="true" />
                </button>
              )
            ) : null}
          </div>
        </section>
      ) : null}

      {merged.length ? (
        <section data-guest-live="" className={cn(SECTION, 'order-4 md:order-none')}>
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <SectionHeader className="p-0">{t('auth:guest.project.recentlyLive')}</SectionHeader>
            {!allLive && merged.length > LIVE_SHOWN ? (
              <button type="button" data-guest-live-all="" className="un-touch-target text-[15px] font-semibold text-violet-700 dark:text-violet-300" onClick={() => setAllLive(true)}>
                {t('auth:guest.project.seeAll')}
              </button>
            ) : null}
          </div>
          <div className={cn(PEOPLE_CARD, 'overflow-hidden')}>
            {liveShown.map((m, i) => (
              <div key={m.id} data-guest-merged={m.id} className={cn('flex min-h-[64px] items-center gap-3 px-3.5 py-3', i < liveShown.length - 1 || liveMore ? ROW_LINE : '')}>
                <span className="h-10 w-16 shrink-0 overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-800">
                  {m.picture ? (
                    <img src={m.picture} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover object-top" />
                  ) : (
                    <TilePicture app={app} color={color} className="h-full w-full" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{m.title || t('auth:guest.project.untitledChange')}</div>
                  <LiveLine merged={m} />
                </div>
              </div>
            ))}
            {liveMore ? (
              !allLive && merged.length > LIVE_SHOWN ? (
                <button type="button" data-guest-live-more="" className={MORE_ROW} onClick={() => setAllLive(true)}>
                  <span className={MORE_PILL}>{t('auth:guest.project.morePill', { count: liveMore })}</span>
                  <span className="flex-1 text-[15px] font-semibold text-violet-700 dark:text-violet-300">{t('auth:guest.project.moreLive', { count: liveMore })}</span>
                  <ChevronRightIcon className="h-[18px] w-[18px] text-violet-700 dark:text-violet-300" aria-hidden="true" />
                </button>
              ) : (
                <div data-guest-live-more="" className={MORE_ROW}>
                  <span className={MORE_PILL}>{t('auth:guest.project.morePill', { count: liveMore })}</span>
                  <span className="flex-1 text-[15px] font-semibold text-zinc-700 dark:text-zinc-300">{t('auth:guest.project.moreLive', { count: liveMore })}</span>
                </div>
              )
            ) : null}
          </div>
        </section>
      ) : null}

      <div data-guest-side-contributors="" className="order-5 md:order-none">
        <GuestContributors slug={app.slug} initial={initialContributors} className={SECTION} />
      </div>
      </div>

      {/* The project's Discussion, read only: its posts and their replies,
          and "Start a post…" asking the visitor to sign in
          (./guest-discussion.tsx). A preview on a phone, whole from 768px. */}
      <div data-guest-talk="" className={cn(SECTION, 'order-3 min-w-0 md:order-none md:mt-0')}>
        <GuestDiscussion app={app} onSignIn={() => onIntent({ kind: 'chat', app })} />
      </div>
      </div>

      {!loaded ? <p className="mt-8 px-1 text-[15px] text-zinc-500 dark:text-zinc-400">{t('auth:guest.project.loading')}</p> : null}
    </div>
  );
}
