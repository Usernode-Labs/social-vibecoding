/**
 * PRIVATE COMMUNITIES: the page a visitor with no account reads at
 * `/communities` (features/auth/story.tsx COMMUNITIES_PATH), in the guest
 * Discover's place on the landing (features/auth/landing.tsx).
 *
 * WHO IT IS FOR (Evan, 13 Nov 2026). The landing's own pitch is the public
 * library: apps anyone can edit. A private community is a different promise
 * (its maker says who gets in and who approves a change), for somebody who
 * runs a group: friends, a school club, a city's bridge club, a studio
 * collective, a street, a town. So it is a page of its own, behind a door on
 * the landing, and the page the people who go looking for such groups send
 * them. Its job is to let an organizer picture their own group here and
 * start one.
 *
 * Top to bottom: the headline with one button, the kinds of group it is for
 * (cards, each with what that group might make), how it works as three
 * steps down one card, who decides (what approval means for the group,
 * beside the four rules a community can pick), how a community goes from
 * just you to private to public, and a closing band with the button again.
 * Each section is drawn its own way on purpose: six sections of identical
 * cards read as one long list.
 *
 * THE APPROVAL RULES ARE THE PRODUCT'S: their names and lines are the Who
 * decides dialog's own messages (features/dialogs/who-decides.tsx), and the
 * three audiences are the Communities screen's nouns, so this page cannot
 * describe a rule or an audience the product does not have.
 *
 * ONE WAY IN: the button opens the landing's own start sheet, and says
 * "Join the waitlist" while new accounts wait, as the bar's does. The links
 * back to the public apps are plain links to `/`: this page and the guest
 * Discover are two addresses of one document.
 *
 * Mounted only at its address, never in the prerender, so nothing here is in
 * the landing's first commit.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  BallotIcon,
  BookmarkIcon,
  CheckIcon,
  ChevronLeftIcon,
  CupIcon,
  GlobeIcon,
  HandRaisedIcon,
  HomeIcon,
  LockIcon,
  NewspaperIcon,
  TrophyOutlineIcon,
  UserCheckIcon,
  UserGroupIcon,
} from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { noteSignUpFrom } from '../auth/sign-up-from';

// A section's heading: larger than a label over a card, smaller than the
// page's own headline.
const HEADING = 'text-[22px] leading-7 font-extrabold text-zinc-900 text-balance md:text-[26px] md:leading-8 dark:text-zinc-100';
// The line under a heading, and the paragraph beside the rules.
const SUB = 'max-w-[640px] text-base leading-6 text-zinc-500 text-balance dark:text-zinc-400';
// A white card on the page's ground, the grouped list's face.
const CARD = 'rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_1px_2px_rgba(0,0,0,0.05)] dark:bg-zinc-900';
// A row's title over its line: the shell's 15 over 13 a step up, for a page
// that is read rather than scanned.
const ROW_TITLE = 'text-base leading-[22px] font-[650] text-zinc-900 dark:text-zinc-100';
const ROW_LINE = 'text-[15px] leading-[21px] text-zinc-500 dark:text-zinc-400';
// A link inside a sentence, in the story's blue.
const LINK = 'font-semibold text-violet-700 hover:underline dark:text-violet-400';
// The same link on the dark band.
const LINK_ON_DARK = 'font-semibold text-violet-300 hover:underline';
// The round glyph disc the rules and the steps lead with.
const DISC = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300';

export function GuestCommunities({ waitlist, onStart }: {
  /** New accounts wait in line: the button says so (guest-data newAccountsWait). */
  waitlist: boolean;
  /** The landing's own way in (its start sheet). */
  onStart: () => void;
}) {
  const t = useMessages('auth');
  const td = useMessages('dialogs');
  const tc = useMessages('communities');

  const start = () => { noteSignUpFrom('groups'); onStart(); };
  const startLabel = waitlist ? t('auth:guest.hero.joinWaitlist') : t('auth:guest.groups.start');

  const groups: { key: string; icon: ReactNode; title: string; body: string }[] = [
    { key: 'friends', icon: <UserGroupIcon />, title: t('auth:guest.groups.for.friends.title'), body: t('auth:guest.groups.for.friends.body') },
    { key: 'school', icon: <BookmarkIcon />, title: t('auth:guest.groups.for.school.title'), body: t('auth:guest.groups.for.school.body') },
    { key: 'clubs', icon: <TrophyOutlineIcon />, title: t('auth:guest.groups.for.clubs.title'), body: t('auth:guest.groups.for.clubs.body') },
    { key: 'studios', icon: <CupIcon />, title: t('auth:guest.groups.for.studios.title'), body: t('auth:guest.groups.for.studios.body') },
    { key: 'neighbors', icon: <HomeIcon />, title: t('auth:guest.groups.for.neighbors.title'), body: t('auth:guest.groups.for.neighbors.body') },
    { key: 'towns', icon: <NewspaperIcon />, title: t('auth:guest.groups.for.towns.title'), body: t('auth:guest.groups.for.towns.body') },
  ];

  const steps = [
    { title: t('auth:guest.groups.how.say.title'), body: t('auth:guest.groups.how.say.body') },
    { title: t('auth:guest.groups.how.invite.title'), body: t('auth:guest.groups.how.invite.body') },
    { title: t('auth:guest.groups.how.change.title'), body: t('auth:guest.groups.how.change.body') },
  ];

  const points = [
    { title: t('auth:guest.groups.decides.suggest.title'), body: t('auth:guest.groups.decides.suggest.body') },
    { title: t('auth:guest.groups.decides.see.title'), body: t('auth:guest.groups.decides.see.body') },
    { title: t('auth:guest.groups.decides.configure.title'), body: t('auth:guest.groups.decides.configure.body') },
  ];

  // The four presets a community picks from (services/governance-rules.js),
  // in the Who decides dialog's order and its words. A new one starts on the
  // first.
  const rules: { key: string; icon: ReactNode; name: string; line: string }[] = [
    { key: 'you_or_the_group', icon: <UserCheckIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.you_or_the_group.name'), line: td('dialogs:whoDecides.preset.you_or_the_group.line') },
    { key: 'two_yeses', icon: <UserGroupIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.two_yeses.name'), line: td('dialogs:whoDecides.preset.two_yeses.line') },
    { key: 'open_floor', icon: <HandRaisedIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.open_floor.name'), line: td('dialogs:whoDecides.preset.open_floor.line') },
    { key: 'group_vote', icon: <BallotIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.group_vote.name'), line: td('dialogs:whoDecides.preset.group_vote.line') },
  ];

  const stages: { key: string; icon: ReactNode; title: string; body: ReactNode }[] = [
    { key: 'solo', icon: <LockIcon className="h-[22px] w-[22px]" />, title: tc('communities:sections.solo.noun'), body: t('auth:guest.groups.private.solo') },
    { key: 'invited', icon: <UserGroupIcon className="h-[22px] w-[22px]" />, title: tc('communities:sections.invited.noun'), body: t('auth:guest.groups.private.invited') },
    {
      key: 'open',
      icon: <GlobeIcon className="h-[22px] w-[22px]" />,
      title: tc('communities:sections.open.noun'),
      body: <RichMessage id="auth:guest.groups.private.open" components={[<a href="/" className={LINK_ON_DARK} />]} />,
    },
  ];

  return (
    <div data-guest-groups="" className="mx-auto flex w-full flex-col gap-14 px-4 pb-12 pt-4 md:gap-[72px]">
      <section className="flex flex-col">
        <a
          href="/"
          data-guest-groups-back=""
          className="mb-5 inline-flex h-11 items-center gap-1 self-start rounded-full bg-[color:var(--brand-tint)] px-3.5 text-[15px] font-semibold text-[color:var(--brand-ink)] no-underline"
        >
          <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
          {t('auth:guest.groups.back')}
        </a>
        <div className="flex items-center gap-14">
          <div className="flex min-w-0 flex-1 flex-col items-start">
            <h1 className="text-[30px] leading-9 font-extrabold text-zinc-900 text-balance md:text-[40px] md:leading-[46px] dark:text-zinc-100">
              {t('auth:guest.groups.title')}
            </h1>
            <p className="mt-3.5 max-w-[640px] text-[17px] leading-[26px] text-zinc-500 md:text-lg md:leading-[27px] dark:text-zinc-400">
              {t('auth:guest.groups.lead')}
            </p>
            <Button
              type="button"
              variant="pillAccent"
              size="none"
              ink="solid"
              data-guest-groups-start=""
              className="mt-6 inline-flex h-12 items-center justify-center px-6 text-base font-[650]"
              onClick={start}
            >
              {startLabel}
            </Button>
            <p className="mt-3.5 text-[15px] leading-5 text-zinc-500 dark:text-zinc-400">
              <RichMessage id="auth:guest.groups.publicLine" components={[<a href="/" data-guest-groups-public="" className={LINK} />]} />
            </p>
          </div>
          <img
            src="/brand/people.png"
            alt=""
            width={816}
            height={612}
            draggable={false}
            className="hidden h-auto w-[340px] shrink-0 lg:block"
          />
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <h2 className={HEADING}>{t('auth:guest.groups.for.heading')}</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <li key={g.key} className={`${CARD} flex flex-col gap-3 p-5`}>
              <div className="flex items-center gap-3">
                <IconTile size="sm" aria-hidden="true">{g.icon}</IconTile>
                <h3 className="min-w-0 text-[17px] leading-[22px] font-[650] text-zinc-900 dark:text-zinc-100">{g.title}</h3>
              </div>
              <p className={ROW_LINE}>{g.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h2 className={HEADING}>{t('auth:guest.groups.how.heading')}</h2>
          <p className={SUB}>{t('auth:guest.groups.how.sub')}</p>
        </div>
        <ol className={`${CARD} flex flex-col p-6`}>
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-4">
              <div className="flex shrink-0 flex-col items-center" aria-hidden="true">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[17px] font-bold text-white">{i + 1}</span>
                {i < steps.length - 1 ? <span className="w-0.5 flex-1 bg-violet-200 dark:bg-violet-900" /> : null}
              </div>
              <div className={i < steps.length - 1 ? 'flex min-w-0 flex-col gap-1 pb-7 pt-2' : 'flex min-w-0 flex-col gap-1 pt-2'}>
                <h3 className="text-[17px] leading-[22px] font-[650] text-zinc-900 dark:text-zinc-100">{s.title}</h3>
                <p className={ROW_LINE}>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-5">
        <h2 className={HEADING}>{t('auth:guest.groups.decides.heading')}</h2>
        <div className="grid items-start gap-x-14 gap-y-5 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-5">
            <p className="text-[17px] leading-[26px] text-zinc-500 md:text-lg md:leading-[27px] dark:text-zinc-400">{t('auth:guest.groups.decides.lead')}</p>
            <ul data-guest-groups-points="" className={`${CARD} flex flex-col gap-4 px-5 py-[18px]`}>
              {points.map((p) => (
                <li key={p.title} className="flex items-start gap-3">
                  <span className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-violet-600 text-white" aria-hidden="true">
                    <CheckIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <h3 className={ROW_TITLE}>{p.title}</h3>
                    <p className="text-sm leading-5 text-zinc-500 dark:text-zinc-400">{p.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <ul data-guest-groups-rules="" className={`${CARD} flex min-w-0 flex-col overflow-hidden lg:col-span-2`}>
            {rules.map((r, i) => (
              <li
                key={r.key}
                data-guest-groups-rule={r.key}
                className={i ? 'flex items-start gap-3.5 px-5 py-4 shadow-[inset_0_1px_0_var(--app-sheet-line)]' : 'flex items-start gap-3.5 px-5 py-4'}
              >
                <span className={DISC} aria-hidden="true">{r.icon}</span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h3 className={ROW_TITLE}>{r.name}</h3>
                    {i === 0 ? (
                      <span className="inline-flex h-[22px] items-center rounded-full bg-violet-50 px-2.5 text-xs font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-300">
                        {t('auth:guest.groups.decides.default')}
                      </span>
                    ) : null}
                  </div>
                  <p className={ROW_LINE}>{r.line}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h2 className={HEADING}>{t('auth:guest.groups.private.heading')}</h2>
          <p className={SUB}>{t('auth:guest.groups.private.sub')}</p>
        </div>
        <ol data-guest-groups-stages="" className="grid gap-x-4 gap-y-7 rounded-3xl bg-zinc-900 p-6 text-white md:grid-cols-3 md:p-8 dark:bg-zinc-800">
          {stages.map((s, i) => (
            <li key={s.key} className="flex min-w-0 flex-col gap-2.5">
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/15 text-white">{s.icon}</span>
                {i < stages.length - 1 ? <span className="hidden h-px flex-1 bg-white/25 md:block" /> : null}
              </div>
              <h3 className="text-[17px] leading-[22px] font-[650] text-white">{s.title}</h3>
              <p className="text-[15px] leading-[21px] text-zinc-300 md:pe-4">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section data-guest-groups-closing="" className="flex flex-col items-center gap-2.5 rounded-3xl bg-violet-600 px-6 py-12 text-center text-white">
        <h2 className="text-[26px] leading-8 font-extrabold text-white text-balance md:text-[30px] md:leading-9">{t('auth:guest.groups.closing.title')}</h2>
        <p className="max-w-[520px] text-base leading-6 text-white">{t('auth:guest.groups.closing.body')}</p>
        <button
          type="button"
          data-guest-groups-start=""
          className="mt-2.5 inline-flex h-12 items-center justify-center rounded-full bg-white px-6 text-base font-[650] text-violet-800 hover:bg-violet-50"
          onClick={start}
        >
          {startLabel}
        </button>
      </section>
    </div>
  );
}
