/**
 * COMMUNITIES TO JOIN (One Home, #6361): the bottom of Home, signed in or
 * out. It is the signed-out directory's picture card (features/guest Card,
 * GuestCover), so the page a visitor browses before signing up is the page
 * they land on after. A card is the same either way (#6609): its picture,
 * one count, its name and its sentence, with no footer and no Join. The
 * whole card opens the project's page, where Join already sits next to what
 * the community is about; joining there takes the community off this list
 * (sv:membership-changed).
 *
 * Kind chips over the cards. Then FEATURED, the communities an admin
 * featured, in their order (featured_order), in the same wrapping grid as
 * the rest (#6434): the first group of the section, of the chosen kind, and
 * left out while a search is typed (its matches are the grid, featured
 * first). Then the rest under "More communities" whenever Featured is
 * shown, under All or a chosen kind (#6584, #6597): every community of the
 * kind that Featured does not already show, most used first, so no
 * community appears twice. The heading tells the rest apart from Featured;
 * when every community of the kind is featured there is nothing left and
 * it is not drawn. No heading while searching, or with nothing featured:
 * then there is one grid. More load as the reader reaches the end (an
 * IntersectionObserver on the last card's sentinel, inside Home's own
 * scroller), with two
 * placeholder cards while they come. The directory is
 * GET /api/public/apps, which answers every public project at once today,
 * so "more" pages through it here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Chip, ChipRail } from '@/components/ui/chip';

import { useMessages } from '../../lib/i18n/react';
import { CARD_GRID, Card, SMALL_CAPS_LABEL } from '../guest/guest-discover';
import { featuredApps, presentCategories, sortApps, type GuestApp } from '../guest/guest-data';
import { SectionHeading } from './panels/ui';
import { matchesQuery } from './use-home-query';

/** How many cards a page brings. */
export const JOIN_PAGE = 8;

export function joinOrder(apps: readonly GuestApp[]): GuestApp[] {
  const featured = featuredApps(apps);
  const first = new Set(featured.map((a) => a.slug));
  return [...featured, ...sortApps(apps, 'trending').filter((a) => !first.has(a.slug))];
}

export function CommunitiesToJoin({ apps, failed = false, exclude, signedIn, query, onRetry }: {
  /** The public directory, or null while it loads. */
  apps: GuestApp[] | null;
  /** The directory could not be read: say so, with a way to try again. */
  failed?: boolean;
  /** Communities already on this Home (joined or pinned), left out of the list. */
  exclude: ReadonlySet<string>;
  /** Only the heading and the ids the tours and declared checks find. */
  signedIn: boolean;
  query: string;
  /** Read the directory again, from the line that says it could not be. */
  onRetry?: () => void;
}) {
  const t = useMessages('home');
  const ta = useMessages('auth');
  const [kind, setKind] = useState<string | null>(null);
  const [shown, setShown] = useState(JOIN_PAGE);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const pool = useMemo(() => (apps || []).filter((a) => !exclude.has(a.slug)), [apps, exclude]);
  const kinds = useMemo(() => presentCategories(pool), [pool]);
  const featured = useMemo(() => (query ? [] : featuredApps(pool).filter((a) => !kind || a.category === kind)), [pool, kind, query]);
  const list = useMemo(() => {
    // Searching keeps the join order (featured first); otherwise this is the
    // rest, most used first, the featured ones left out because Featured
    // already shows them (#6597). When every community of the kind is
    // featured, nothing is left and the list is empty.
    const lead = new Set(featured.map((a) => a.slug));
    return (query ? joinOrder(pool) : sortApps(pool, 'trending').filter((a) => !lead.has(a.slug)))
      .filter((a) => !kind || a.category === kind)
      .filter((a) => matchesQuery(query, a.name, a.slug, a.description));
  }, [pool, kind, query, featured]);
  useEffect(() => { setShown(JOIN_PAGE); }, [kind, query]);
  const more = list.length > shown;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || typeof IntersectionObserver === 'undefined') return undefined;
    // The scroller the list is in: Home's own signed in, the landing's
    // (#auth-landing-scroll) signed out. An observer rooted on a box that
    // does not hold the cards never fires, which left a visitor with the
    // first page alone, the featured ones.
    const root = scrollParent(el);
    let timer = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || timer) return;
      setLoadingMore(true);
      // A beat, so the placeholders read as "more on the way" rather than a flash.
      timer = window.setTimeout(() => { timer = 0; setShown((n) => n + JOIN_PAGE); setLoadingMore(false); }, 250);
    }, { root, rootMargin: '0px 0px 600px 0px' });
    io.observe(el);
    return () => { io.disconnect(); if (timer) window.clearTimeout(timer); };
  }, [more, shown]);

  if (query && !list.length) return null;
  // Nothing drawn on a card depends on being signed in (#6609): a member and
  // a visitor get the same card, and Join is the project page's.
  // #6650: signed in, the section is Discover communities, under its own line.
  const heading = signedIn ? t('home:join.headingDiscover') : t('home:join.headingSignedOut');
  return (
    // The id is the signed-in Home's (the tours and the declared checks find
    // it); the landing draws the same section signed out, in the same
    // document, so it goes without one there.
    <section id={signedIn ? 'home-join-section' : undefined} data-home-join-section="" className={signedIn ? 'home-section-rule px-3 pb-6' : 'px-3 pb-6'} aria-busy={apps ? undefined : true}>
      <SectionHeading>{heading}</SectionHeading>
      {/* #6650: signed in, the heading says what the section is for. */}
      {signedIn ? <p className="m-0 -mt-1 pb-1 text-[13px] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">{t('home:join.sub')}</p> : null}
      {!query && kinds.length ? (
        <ChipRail role="group" aria-label={ta('auth:guest.categories.label')} className="-mx-3 gap-2 px-3 pt-1 pb-3">
          <Chip size="bar" className="min-h-11" selected={!kind} data-home-join-kind="all" onClick={() => setKind(null)}>
            {ta('auth:guest.category.all')}
          </Chip>
          {kinds.map((k) => (
            <Chip key={k} size="bar" className="min-h-11" selected={kind === k} data-home-join-kind={k} onClick={() => setKind(kind === k ? null : k)}>
              {ta(`auth:guest.category.${k}`)}
            </Chip>
          ))}
        </ChipRail>
      ) : null}
      {featured.length ? (
        <div data-home-join-featured="" className="pb-4">
          <h3 id={signedIn ? 'home-join-featured-label' : 'guest-join-featured-label'} className={`${SMALL_CAPS_LABEL} px-1 pb-2`}>{t('home:join.featured')}</h3>
          <div
            role="list"
            aria-labelledby={signedIn ? 'home-join-featured-label' : 'guest-join-featured-label'}
            className={`${CARD_GRID} px-1`}
          >
            {featured.map((app, i) => (
              <div key={app.slug} role="listitem" className="flex [&>article]:flex-1">
                <Card app={app} eager={i < 3} featured />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {failed ? (
        // #6354 review: a request that failed must say so and offer to try
        // again, rather than leaving the loading placeholders up forever.
        <div className="flex flex-col items-start gap-3 px-1 py-6" data-home-join-failed="">
          <p className="text-[14px] text-zinc-500 dark:text-zinc-400">{t('home:join.failed')}</p>
          {onRetry ? (
            <Button type="button" variant="pill" size="sm" className="min-h-11 px-5 py-0 un-touch-target"
              data-home-join-retry="" onClick={onRetry}>
              {t('home:join.retry')}
            </Button>
          ) : null}
        </div>
      ) : !apps ? (
        <div className={`${CARD_GRID} px-1`} aria-label={ta('auth:guest.loading')}>
          {[0, 1, 2, 3].map((i) => <span key={i} className="aspect-[16/10] rounded-[20px] bg-black/5 dark:bg-white/10" />)}
        </div>
      ) : list.length ? (
        <>
        {/* Featured above, so the rest gets a heading of its own: without it
            every card reads as featured (#6434, #6584). It is not drawn when
            nothing is left (every community of the kind is featured, #6597).
            A search leaves Featured out, and then there is one grid with no
            heading. */}
        {featured.length ? <h3 className={`${SMALL_CAPS_LABEL} px-1 pb-2`} data-home-join-rest="">{t('home:join.more')}</h3> : null}
        <div className={`${CARD_GRID} px-1`}>
          {list.slice(0, shown).map((app, i) => (
            <Card
              key={app.slug}
              app={app}
              eager={i < 4}
            />
          ))}
        </div>
        </>
      ) : featured.length ? null : (
        <p className="px-2 py-4 text-[14px] text-zinc-500 dark:text-zinc-400">
          {!pool.length && !kind && !query ? t('home:join.empty') : t('home:join.allJoined')}
        </p>
      )}
      {more ? (
        <>
          {loadingMore ? (
            <div className={`${CARD_GRID} px-1 pt-3`} aria-label={t('home:join.loadingMore')}>
              {[0, 1].map((i) => <span key={i} className="aspect-[16/10] animate-pulse rounded-[20px] bg-black/5 dark:bg-white/10" />)}
            </div>
          ) : null}
          <div ref={sentinel} className="h-px" data-home-join-more="" />
        </>
      ) : list.length > JOIN_PAGE ? (
        <p className="px-2 pt-5 text-center text-[13px] text-zinc-500 dark:text-zinc-400" data-home-join-end="">
          {kind ? t('home:join.endKind') : t('home:join.end')}
        </p>
      ) : null}
    </section>
  );
}

/** The nearest ancestor that scrolls, or null (the viewport). */
export function scrollParent(el: Element | null): Element | null {
  for (let node = el?.parentElement || null; node; node = node.parentElement) {
    const y = getComputedStyle(node).overflowY;
    if (y === 'auto' || y === 'scroll') return node;
  }
  return null;
}

/** The public directory, read once per page load (GET /api/public/apps). */
let directory: Promise<GuestApp[] | null> | null = null;
export function readDirectory(refresh = false): Promise<GuestApp[] | null> {
  if (refresh) directory = null;
  if (!directory) {
    // An answer the server never sends ends as a failed read, not as loading
    // placeholders left up for good (#6609 review): to the section, a held
    // request and one that failed are the same, and it has a Retry.
    const init: RequestInit = { credentials: 'same-origin' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(8000);
    }
    directory = fetch('/api/public/apps?include_wallets=0', init)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => (Array.isArray(body?.apps) ? body.apps as GuestApp[] : null))
      .catch(() => null)
      .then((apps) => { if (!apps) directory = null; return apps; });
  }
  return directory;
}
