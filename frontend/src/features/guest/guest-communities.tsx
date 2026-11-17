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
  ArrowRightShortIcon,
  BallotIcon,
  BoardIcon,
  BookmarkIcon,
  HandRaisedIcon,
  HashIcon,
  TrophyOutlineIcon,
  UserCheckIcon,
  UserGroupIcon,
  UserPlusIcon,
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
// A band's own padding, top and bottom, inside the column's gutter.
const BAND = 'flex flex-col gap-6 px-4 py-12 md:gap-7 md:py-[68px]';
// The glyph tile a kind of group leads with; its fill is named where it is drawn.
const TILE = 'flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[10px] border border-[color:var(--site-line)]';

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

  // The three kinds of group drawn as cards, then three more as a line each
  // under a rule (Drea's mock-up, 17 Nov 2026): six identical cards read as
  // a flat list.
  const friends = { title: t('auth:guest.groups.for.friends.title'), body: t('auth:guest.groups.for.friends.body') };
  const tinted: { key: string; icon: ReactNode; title: string; body: string; fill: string }[] = [
    { key: 'school', icon: <BookmarkIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.school.title'), body: t('auth:guest.groups.for.school.body'), fill: 'bg-[var(--site-sky-pale)]' },
    { key: 'clubs', icon: <TrophyOutlineIcon className="h-[22px] w-[22px]" />, title: t('auth:guest.groups.for.clubs.title'), body: t('auth:guest.groups.for.clubs.body'), fill: 'bg-[var(--site-mint)]' },
  ];
  const plain = [
    { key: 'studios', title: t('auth:guest.groups.for.studios.title'), body: t('auth:guest.groups.for.studios.body') },
    { key: 'neighbors', title: t('auth:guest.groups.for.neighbors.title'), body: t('auth:guest.groups.for.neighbors.body') },
    { key: 'towns', title: t('auth:guest.groups.for.towns.title'), body: t('auth:guest.groups.for.towns.body') },
  ];

  const steps = [
    { title: t('auth:guest.groups.how.say.title'), body: t('auth:guest.groups.how.say.body') },
    { title: t('auth:guest.groups.how.invite.title'), body: t('auth:guest.groups.how.invite.body') },
    { title: t('auth:guest.groups.how.change.title'), body: t('auth:guest.groups.how.change.body') },
  ];

  // The four presets a community picks from (services/governance-rules.js),
  // in the Who decides dialog's order and under its names. Each line here is
  // the short form of that dialog's own; a new community starts on the first.
  const rules: { key: string; icon: ReactNode; name: string; line: string }[] = [
    { key: 'you_or_the_group', icon: <UserCheckIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.you_or_the_group.name'), line: t('auth:guest.groups.rules.you_or_the_group') },
    { key: 'two_yeses', icon: <UserGroupIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.two_yeses.name'), line: t('auth:guest.groups.rules.two_yeses') },
    { key: 'open_floor', icon: <HandRaisedIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.open_floor.name'), line: t('auth:guest.groups.rules.open_floor') },
    { key: 'group_vote', icon: <BallotIcon className="h-5 w-5" />, name: td('dialogs:whoDecides.preset.group_vote.name'), line: t('auth:guest.groups.rules.group_vote') },
  ];

  // Just you, then a private community, then public if the group chooses.
  const stages = [
    { key: 'solo', label: tc('communities:sections.solo.noun') },
    { key: 'invited', label: tc('communities:sections.invited.noun') },
    { key: 'open', label: t('auth:guest.groups.private.publicIf') },
  ];

  // The hub in the hero's picture: every word is made up, and says so by
  // being a supper club.
  const hubRows: { key: string; icon: ReactNode; title: string; body: string; ask?: boolean }[] = [
    { key: 'needs', icon: <BallotIcon className="h-[18px] w-[18px]" />, title: t('auth:guest.groups.hub.needs.title'), body: t('auth:guest.groups.hub.needs.body'), ask: true },
    { key: 'workshop', icon: <BoardIcon className="h-[18px] w-[18px]" />, title: t('auth:guest.groups.hub.workshop.title'), body: t('auth:guest.groups.hub.workshop.body') },
    { key: 'chat', icon: <HashIcon className="h-[18px] w-[18px]" />, title: t('auth:guest.groups.hub.chat.title'), body: t('auth:guest.groups.hub.chat.body') },
  ];

  return (
    <div data-guest-groups="" className="flex w-full grow flex-col">
      {/* THE LANDING'S HERO FRAME (17 Nov 2026): the white window on the
          clouds, its words centred in the left part, the two buttons, and
          beside them a picture: a small community hub, drawn here (who is
          in it, how many were active, what needs you, its chat), as the
          landing's picture is of the communities page. */}
      <section className="site-band site-clouds [--band:var(--site-sky)] px-3 pt-3 pb-4 md:px-6 md:pt-5 md:pb-6">
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
          <div className="hidden min-w-0 px-8 py-10 lg:block" aria-hidden="true" data-guest-groups-hub="">
            <div className="relative mx-auto w-[400px] max-w-full -rotate-2">
              {/* The sun sheet behind it, as behind the landing's picture. */}
              <div className="absolute inset-0 translate-x-3 translate-y-3 rounded-[16px] border border-[color:var(--site-line)] bg-[var(--site-sun)]" />
              <div className="relative flex flex-col gap-3 rounded-[16px] border border-[color:var(--site-line)] bg-[var(--site-ground-card)] p-4 text-start">
                <div className="flex items-center gap-3">
                  <span className={`${TILE} bg-[var(--site-sun)] text-[color:var(--site-on-sun)]`}><UserGroupIcon className="h-[22px] w-[22px]" /></span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className={`${SERIF} truncate text-[19px] leading-[24px] text-[color:var(--site-ink)]`}>{t('auth:guest.groups.hub.name')}</span>
                    <span className="truncate text-[13px] leading-[18px] text-[color:var(--site-muted)]">{t('auth:guest.groups.hub.kind')}</span>
                  </div>
                  <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--site-line)] bg-[var(--site-panel)] px-3 text-[13px] font-medium text-[color:var(--site-ink)] shadow-[0_2px_0_var(--site-line)]">
                    <UserPlusIcon className="h-4 w-4" />
                    {t('auth:guest.groups.hub.invite')}
                  </span>
                </div>
                <div className="flex items-center gap-2.5 rounded-[12px] bg-[var(--site-sky-pale)] px-3 py-2">
                  <span className="flex -space-x-1.5 rtl:space-x-reverse">
                    {['bg-[#e8452e]', 'bg-[#2a8ce1]', 'bg-[#3cc23c]', 'bg-[#f2a531]'].map((fill) => (
                      <span key={fill} className={`h-6 w-6 rounded-full border border-[color:var(--site-line)] ${fill}`} />
                    ))}
                  </span>
                  <span className="text-[13px] leading-[18px] font-medium text-[color:var(--site-ink)]">{t('auth:guest.groups.hub.active')}</span>
                </div>
                <ul className="flex flex-col">
                  {hubRows.map((row, i) => (
                    <li key={row.key} className={i ? 'flex items-center gap-3 border-t border-[color:var(--site-line-soft)] py-2.5' : 'flex items-center gap-3 pb-2.5'}>
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-[color:var(--site-line)] bg-[var(--site-panel)] text-[color:var(--site-ink)]">{row.icon}</span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-[14px] leading-[19px] font-semibold text-[color:var(--site-ink)]">{row.title}</span>
                        <span className="truncate text-[13px] leading-[18px] text-[color:var(--site-muted)]">{row.body}</span>
                      </span>
                      {row.ask ? (
                        <span className="inline-flex h-7 shrink-0 items-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-sun)] px-3 text-[13px] font-medium text-[color:var(--site-on-sun)]">{t('auth:guest.groups.hub.vote')}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
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

      {/* WHO IT IS FOR: one large card on the sky, two tinted ones beside
          it, and three more kinds of group as a line each under a rule. */}
      <section className={BAND} data-guest-groups-for="">
        <div className="flex flex-col gap-2.5">
          <h2 className={HEADING}>{t('auth:guest.groups.for.heading')}</h2>
          <p className={SUB}>{t('auth:guest.groups.for.sub')}</p>
        </div>
        <div className="grid gap-3.5 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
          {/* The large card is on the site's own sky, faded out under its
              words: the page's one picture besides the hub in the hero. */}
          <article className="site-sky-card relative flex min-h-[240px] min-w-0 flex-col justify-end gap-2 overflow-hidden rounded-[18px] border border-[color:var(--site-line)] p-6 md:min-h-[300px] md:p-8">
            <span className={`${TILE} bg-[var(--site-sun)] text-[color:var(--site-on-sun)]`} aria-hidden="true"><UserGroupIcon className="h-[22px] w-[22px]" /></span>
            <h3 className={`${SERIF} mt-1 text-[30px] leading-[34px] tracking-[-0.01em] text-[color:var(--site-ink)] md:text-[40px] md:leading-[44px]`}>{friends.title}</h3>
            <p className="max-w-[340px] text-[17px] leading-[24px] text-[color:var(--site-muted)]">{friends.body}</p>
          </article>
          <div className="grid min-w-0 gap-3.5">
            {tinted.map((g) => (
              <article key={g.key} className={`flex min-w-0 items-start gap-4 rounded-[18px] border border-[color:var(--site-line)] p-5 md:p-6 ${g.fill}`}>
                <span className={`${TILE} bg-[var(--site-panel)] text-[color:var(--site-ink)]`} aria-hidden="true">{g.icon}</span>
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className={`${SERIF} text-[24px] leading-[29px] text-[color:var(--site-ink)]`}>{g.title}</h3>
                  <p className={ROW_LINE}>{g.body}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
        <ul className="grid gap-x-8 gap-y-5 border-t border-[color:var(--site-line-soft)] pt-6 md:grid-cols-3 md:divide-x md:divide-[color:var(--site-line-soft)] rtl:md:divide-x-reverse">
          {plain.map((g, i) => (
            <li key={g.key} className={i ? 'flex min-w-0 flex-col gap-1 md:ps-8' : 'flex min-w-0 flex-col gap-1'}>
              <h3 className={ROW_TITLE}>{g.title}</h3>
              <p className={ROW_LINE}>{g.body}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* YOUR GROUP, YOUR RULES: one line, the four rules as short cards,
          and how private it is as one row under them. It was a paragraph,
          three points and a window of four long rows, then a section of
          three cards about privacy. */}
      <section className={`site-band [--band:var(--site-sun-band)] ${BAND}`}>
        <div className="flex flex-col gap-2.5">
          <h2 className={HEADING}>{t('auth:guest.groups.decides.heading')}</h2>
          <p className={SUB}>{t('auth:guest.groups.decides.lead')}</p>
        </div>
        <ul data-guest-groups-rules="" className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {rules.map((r, i) => (
            <li key={r.key} data-guest-groups-rule={r.key} className={`${CARD} flex min-w-0 flex-col gap-2.5 p-5`}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-mint)] text-[color:var(--site-ink)]" aria-hidden="true">{r.icon}</span>
                {i === 0 ? (
                  <span className="inline-flex h-[22px] items-center rounded-full border border-[color:var(--site-line)] bg-[var(--site-sky-pale)] px-2.5 text-xs font-semibold text-[color:var(--site-ink)]">
                    {t('auth:guest.groups.decides.default')}
                  </span>
                ) : null}
              </div>
              <h3 className={ROW_TITLE}>{r.name}</h3>
              <p className={ROW_LINE}>{r.line}</p>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-3 pt-2 md:flex-row md:items-center md:gap-5">
          <h3 className={`${LABEL} shrink-0`}>{t('auth:guest.groups.private.heading')}</h3>
          <ol data-guest-groups-stages="" className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
            {stages.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2">
                {i ? <ArrowRightShortIcon className="h-5 w-5 shrink-0 text-[color:var(--site-ink)] rtl:-scale-x-100" aria-hidden="true" /> : null}
                <span className="inline-flex h-10 items-center rounded-[10px] border border-[color:var(--site-line)] bg-[var(--site-panel)] px-4 text-[15px] font-semibold text-[color:var(--site-ink)] shadow-[0_2px_0_var(--site-line)]">{s.label}</span>
              </li>
            ))}
          </ol>
        </div>
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
