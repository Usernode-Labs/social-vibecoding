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
 * Top to bottom: the headline with its two buttons, how it works as three
 * steps (first, because the landing's button to this page says "How it
 * works for private communities"), the kinds of group it is for (cards,
 * each with what that group might make), who decides (what approval means
 * for the group, beside the four rules a community can pick), how a
 * community goes from just you to private to public, and a closing band
 * with the button again.
 * Each section is drawn its own way on purpose: six sections of identical
 * cards read as one long list.
 *
 * DRAWN IN THE WEBSITE'S LOOK (13 Nov 2026), as the landing's short story
 * is, and since 17 Nov 2026 in the landing's hero frame: clouds with a white
 * window for the headline, its words centred, the hero's lighter serif, the
 * landing's two pills (features/auth/story.tsx), and the people on the
 * window's bottom edge until this page has a picture of its own. Then bands
 * of the site's colours down the page, serif headings, sun on an ink
 * outline. Every colour is a variable of public/css/app.css's "THE WEBSITE'S
 * LOOK ON THE SIGNED-OUT PAGES", which the dark shell moves, so nothing here
 * names a dark class.
 *
 * THE APPROVAL RULES ARE THE PRODUCT'S: their names and lines are the Who
 * decides dialog's own messages (features/dialogs/who-decides.tsx), and the
 * three audiences are the Communities screen's nouns, so this page cannot
 * describe a rule or an audience the product does not have.
 *
 * ONE WAY IN: the button opens the landing's own start sheet, and says
 * "Join the waitlist" while new accounts wait, as the bar's does. The white
 * button beside it and the link in the last stage go back to the public
 * apps, plain links to `/`: this page and the guest Discover are two
 * addresses of one document.
 *
 * Mounted only at its address, never in the prerender, so nothing here is in
 * the landing's first commit.
 */

import type { ReactNode } from 'react';

import {
  BallotIcon,
  BookmarkIcon,
  CheckIcon,
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

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { noteSignUpFrom } from '../auth/sign-up-from';
import { HERO_PRIMARY, HERO_SECONDARY, SITE_DISPLAY, SITE_LABEL } from '../auth/story';

const SERIF = 'font-[family-name:var(--site-serif)] font-normal';
// The page's own headline.
const HEADLINE = `${SITE_DISPLAY} text-[31px] leading-[35px] tracking-[-0.03em] text-[color:var(--site-ink)] text-balance md:text-[46px] md:leading-[50px] xl:text-[54px] xl:leading-[58px]`;
// A section's heading: larger than a label over a card, smaller than the
// page's own headline.
const HEADING = `${SERIF} text-[28px] leading-[34px] tracking-[-0.01em] text-[color:var(--site-ink)] text-balance md:text-[38px] md:leading-[44px]`;
// The small label a band opens with, as the site sets "How it works".
const LABEL = 'text-[13px] leading-[18px] uppercase tracking-[0.05em] text-[color:var(--site-ink)]';
// The line under a heading, and the paragraph beside the rules.
const SUB = 'max-w-[640px] text-[17px] leading-[26px] text-[color:var(--site-muted)] text-balance';
// A white face on an ink outline: the site's card.
const CARD = 'rounded-[14px] border border-[color:var(--site-line)] bg-[var(--site-panel)]';
// A card's or a row's title, in the serif, over its line.
const ROW_TITLE = `${SERIF} text-[21px] leading-[26px] text-[color:var(--site-ink)]`;
const ROW_LINE = 'text-[15px] leading-[21px] text-[color:var(--site-muted)]';
// A link inside a sentence: ink, underlined (the site has no second accent).
const LINK = 'font-semibold text-[color:var(--site-ink)] underline decoration-1 underline-offset-[3px]';
// A band's own padding, top and bottom, inside the column's gutter.
const BAND = 'flex flex-col gap-6 px-4 py-12 md:gap-7 md:py-[68px]';
// The strip a window opens with, and one of its three dots.
const STRIP = 'flex h-6 items-center gap-1.5 border-b border-[color:var(--site-line)] px-2.5 md:h-8 md:px-3';
const DOT = 'h-2 w-2 rounded-full border border-[color:var(--site-line)] md:h-2.5 md:w-2.5';
// The glyph tile a kind of group leads with: one of three fills in turn. Sun
// keeps its ink glyph in the dark shell; the two pale fills follow the ink.
const TILE = 'flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] border border-[color:var(--site-line)]';
const TILE_FILLS = [
  'bg-[var(--site-sun)] text-[color:var(--site-on-sun)]',
  'bg-[var(--site-sky-pale)] text-[color:var(--site-ink)]',
  'bg-[var(--site-mint)] text-[color:var(--site-ink)]',
];
// The round sun disc a check, a rule's glyph and a stage's glyph sit on.
const SUN_DISC = 'flex shrink-0 items-center justify-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-sun)] text-[color:var(--site-on-sun)]';

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
    { key: 'friends', icon: <UserGroupIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.friends.title'), body: t('auth:guest.groups.for.friends.body') },
    { key: 'school', icon: <BookmarkIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.school.title'), body: t('auth:guest.groups.for.school.body') },
    { key: 'clubs', icon: <TrophyOutlineIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.clubs.title'), body: t('auth:guest.groups.for.clubs.body') },
    { key: 'studios', icon: <CupIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.studios.title'), body: t('auth:guest.groups.for.studios.body') },
    { key: 'neighbors', icon: <HomeIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.neighbors.title'), body: t('auth:guest.groups.for.neighbors.body') },
    { key: 'towns', icon: <NewspaperIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.towns.title'), body: t('auth:guest.groups.for.towns.body') },
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
      body: <RichMessage id="auth:guest.groups.private.open" components={[<a href="/" className={LINK} />]} />,
    },
  ];

  return (
    <div data-guest-groups="" className="flex w-full grow flex-col">
      {/* THE LANDING'S HERO FRAME (17 Nov 2026): the white window on the
          clouds, its words centred in the left part, the two buttons, and
          the people on the window's bottom edge. */}
      <section className="site-band site-clouds [--band:var(--site-sky)] px-3 pt-3 pb-4 md:px-6 md:pt-5 md:pb-6 lg:pb-20">
        <div className="border border-[color:var(--site-line)] bg-[var(--site-panel)] lg:grid lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)] lg:items-center">
          <div className="flex min-w-0 flex-col items-center px-4 pt-6 pb-6 text-center md:px-8 md:pt-10 md:pb-12 lg:ps-6 lg:pe-0 lg:pt-14 lg:pb-16">
            <div className={`${SITE_LABEL} hidden md:block`}>{t('auth:guest.groups.label')}</div>
            <h1 className={`${HEADLINE} md:mt-4`}>
              {t('auth:guest.groups.title')}
            </h1>
            <p className="mt-3 text-balance text-[17px] leading-[24px] text-[color:var(--site-muted)] md:mt-4 md:text-[20px] md:leading-[28px]">
              <RichMessage id="auth:guest.groups.sub" components={[<span className="block" />, <span className="block" />]} />
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2.5 md:mt-6">
              <button type="button" data-guest-groups-start="" className={HERO_PRIMARY} onClick={start}>
                {startLabel}
              </button>
              <a href="/" data-guest-groups-public="" className={HERO_SECONDARY}>
                {t('auth:guest.groups.explore')}
              </a>
            </div>
          </div>
          <div className="hidden min-w-0 self-end px-6 lg:block" aria-hidden="true">
            <img
              src="/brand/landing-people.webp"
              alt=""
              width={619}
              height={434}
              draggable={false}
              className="relative z-10 mx-auto -mb-14 h-auto w-[400px] max-w-full"
            />
          </div>
        </div>
      </section>

      <section className={`site-band [--band:var(--site-leaf)] ${BAND}`}>
        <div className="flex flex-col gap-2.5">
          <h2 className={LABEL}>{t('auth:guest.groups.how.heading')}</h2>
          <p className={`max-w-[620px] ${HEADING}`}>{t('auth:guest.groups.how.sub')}</p>
        </div>
        <ol className="grid gap-3.5 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex min-w-0 flex-col gap-2 rounded-[14px] bg-[var(--site-leaf-pale)] p-6">
              <span className="text-[13px] leading-[18px] font-medium tracking-[0.05em] text-[color:var(--site-muted)]">{`0${i + 1}`}</span>
              <h3 className={ROW_TITLE}>{s.title}</h3>
              <p className={ROW_LINE}>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={BAND}>
        <h2 className={HEADING}>{t('auth:guest.groups.for.heading')}</h2>
        <ul className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g, i) => (
            <li key={g.key} className={`${CARD} flex flex-col gap-3 p-5`}>
              <div className="flex items-center gap-3">
                <span className={`${TILE} ${TILE_FILLS[i % TILE_FILLS.length]}`} aria-hidden="true">{g.icon}</span>
                <h3 className={`min-w-0 ${ROW_TITLE}`}>{g.title}</h3>
              </div>
              <p className={ROW_LINE}>{g.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={`site-band [--band:var(--site-sun-pale)] ${BAND}`}>
        <h2 className={HEADING}>{t('auth:guest.groups.decides.heading')}</h2>
        <div className="grid items-start gap-x-10 gap-y-6 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-5">
            <p className="text-[17px] leading-[26px] text-[color:var(--site-muted)] md:text-lg md:leading-[27px]">{t('auth:guest.groups.decides.lead')}</p>
            <ul data-guest-groups-points="" className={`${CARD} flex flex-col gap-4 px-5 py-[18px]`}>
              {points.map((p) => (
                <li key={p.title} className="flex items-start gap-3">
                  <span className={`mt-0.5 h-[22px] w-[22px] ${SUN_DISC}`} aria-hidden="true">
                    <CheckIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <h3 className="text-base leading-[22px] font-semibold text-[color:var(--site-ink)]">{p.title}</h3>
                    <p className="text-sm leading-5 text-[color:var(--site-muted)]">{p.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0 border border-[color:var(--site-line)] bg-[var(--site-panel)] lg:col-span-2">
            <div className={`${STRIP} bg-[var(--site-sun)]`} aria-hidden="true">
              <span className="h-2 w-2 rounded-full border border-[color:var(--site-on-sun)] bg-[#e8452e] md:h-2.5 md:w-2.5" />
              <span className="h-2 w-2 rounded-full border border-[color:var(--site-on-sun)] bg-[#f2a531] md:h-2.5 md:w-2.5" />
              <span className="h-2 w-2 rounded-full border border-[color:var(--site-on-sun)] bg-[#3cc23c] md:h-2.5 md:w-2.5" />
            </div>
            <ul data-guest-groups-rules="" className="flex flex-col">
              {rules.map((r, i) => (
                <li
                  key={r.key}
                  data-guest-groups-rule={r.key}
                  className={i ? 'flex items-start gap-3.5 border-t border-[color:var(--site-line)] px-5 py-4' : 'flex items-start gap-3.5 px-5 py-4'}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-mint)] text-[color:var(--site-ink)]" aria-hidden="true">{r.icon}</span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <h3 className={ROW_TITLE}>{r.name}</h3>
                      {i === 0 ? (
                        <span className="inline-flex h-[22px] items-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-sky-pale)] px-2.5 text-xs font-semibold text-[color:var(--site-ink)]">
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
        </div>
      </section>

      <section className={BAND}>
        <div className="flex flex-col gap-2.5">
          <h2 className={HEADING}>{t('auth:guest.groups.private.heading')}</h2>
          <p className={SUB}>{t('auth:guest.groups.private.sub')}</p>
        </div>
        <ol data-guest-groups-stages="" className="grid gap-3.5 rounded-[14px] border border-[color:var(--site-line)] bg-[var(--site-sky-pale)] p-4 md:grid-cols-3 md:p-5">
          {stages.map((s) => (
            <li key={s.key} className={`${CARD} flex min-w-0 flex-col gap-2.5 p-5`}>
              <span className={`h-10 w-10 ${SUN_DISC}`} aria-hidden="true">{s.icon}</span>
              <h3 className={ROW_TITLE}>{s.title}</h3>
              <p className={ROW_LINE}>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section data-guest-groups-closing="" className="site-band [--band:var(--site-sun-deep)] flex flex-col items-center gap-3 px-4 py-14 text-center md:py-[72px]">
        <h2 className={`${SERIF} text-[34px] leading-10 tracking-[-0.015em] text-[color:var(--site-ink)] text-balance md:text-[46px] md:leading-[52px]`}>{t('auth:guest.groups.closing.title')}</h2>
        <p className="max-w-[480px] text-[17px] leading-[25px] text-[color:var(--site-muted)]">{t('auth:guest.groups.closing.body')}</p>
        <button
          type="button"
          data-guest-groups-start=""
          className="mt-2.5 inline-flex h-12 items-center justify-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-panel)] px-6 text-base font-medium text-[color:var(--site-ink)] shadow-[0_2px_0_var(--site-line)]"
          onClick={start}
        >
          {startLabel}
        </button>
      </section>
    </div>
  );
}
