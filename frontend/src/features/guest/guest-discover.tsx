/**
 * The guest Discover: what a visitor with no account sees first
 * (features/auth/landing.tsx draws it under the story's short hero).
 *
 * ONE CARD FOR EVERY PROJECT (#landing cards, 29 Oct 2026). Featured is the
 * projects an admin featured that a visitor can try (guest-data
 * featuredApps), in one grid that reflows like any other: five across on a
 * wide screen, two on a phone, every card the same size and nothing
 * scrolling sideways. Under it All apps is the rest of the directory as the
 * same cards, twenty at a time (ten on a phone) with Show more; the "More
 * projects" rows are gone. Popular is the most people active first, so a
 * test app nobody uses never leads the list because it happens to be
 * tryable (sortApps). Search and the kinds still reach every project.
 *
 * A card is its picture, its name and one sentence, the project's own
 * description, at most two lines. On the picture a pill says how many
 * people used it lately, as a profile glyph and a number, from MIN_PEOPLE
 * (a zero says nothing; a screen reader hears it in words with the name).
 * Member counts, votes and the last change stay on the project's page.
 *
 * THE WHOLE CARD IS ONE LINK to the project's read-only page
 * (./guest-project.tsx), whose band leads with Try it, then Join, then the
 * community: there are no buttons on a card. The name is the link and
 * stretches over the card, so a tap anywhere opens it, a screen reader meets
 * one link per card, and the keyboard's focus ring goes round the whole
 * card. Its href is the clean `/app/<slug>` a search engine can follow
 * (ProjectLink); a plain click stays in the page at `#app/<slug>/workshop`,
 * also where a person lands once they sign in from there. Nothing on a card
 * is locked: the page behind it is readable by anyone. The landing's old
 * grid was taken away because 36 of its 41 tiles were locked
 * (docs/superpowers/specs/2026-09-18-logged-out-screens-design.md); a page
 * to read behind every card is what makes a grid worth having again.
 *
 * WHAT MAKES A TAP LOOK WORTH MAKING: the cards sit up off the page on a
 * soft shadow; a cover with no illustration is the project's icon, larger,
 * on its colour lit from the top left, with a blurred copy of the icon
 * glowing behind it; under a pointer the card rises, the glow brightens and
 * an arrow slides in (the arrow only there and under keyboard focus, so a
 * screen of cards at rest carries no repeated marker); a press gives under
 * the finger; and the picture grows into the project page's band as it
 * opens (./card-morph.ts).
 *
 * Above the grid: a search and the kinds of app the directory has; beside
 * All apps, the sort. What an account adds is the hero's to say
 * (features/auth/story.tsx), with its one button: the "Want to join in?"
 * card that said it again partway down is gone (Evan, 22 Oct 2026). Ways in
 * are asked for where somebody wants to do something (the project page's
 * Join, Vote, Ask), never as a wall.
 */

import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { Chip, ChipRail } from '@/components/ui/chip';
import { ArrowRightShortIcon, SearchIcon, UserIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { useMessages } from '../../lib/i18n/react';
import { useCommunityColor } from '../../lib/community-color';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { cardCover, morph, projectHero } from './card-morph';
import {
  type GuestApp,
  type GuestSort,
  MIN_PEOPLE,
  SORTS,
  canTryHere,
  featuredApps,
  inHomeroomApp,
  filterApps,
  presentCategories,
  projectHash,
  projectPath,
  sortApps,
} from './guest-data';

/** All apps shows this many cards at a time: four rows of five on a wide screen, five rows of two on a phone. */
const CARDS_STEP = 10;
const CARDS_STEP_WIDE = 20;

/** A project made in the last 30 days wears "New". */
const NEW_FOR_MS = 30 * 24 * 60 * 60 * 1000;

export const SMALL_CAPS_LABEL = 'text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400';

/**
 * The grid Featured and All apps share: as many 190px columns as fit, never
 * fewer than two (half the width, less half the gap, is the floor).
 */
const CARD_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(190px,calc(50%_-_6px)),1fr))] gap-3';

function isNew(app: GuestApp, now = Date.now()): boolean {
  const t = app.created_at ? Date.parse(app.created_at) : NaN;
  return Number.isFinite(t) && now - t < NEW_FOR_MS;
}

/** The app's icon, in the tile Discover's rows draw (app-card-view.tsx). `className` overrides the size's radius or shadow. */
export function GuestIcon({ app, size = 'md', eager = false, className }: { app: GuestApp; size?: 'sm' | 'md' | 'lg' | 'xl'; eager?: boolean; className?: string }) {
  const box = size === 'xl'
    ? 'w-20 h-20 rounded-[22px] text-4xl shadow-[0_6px_20px_rgba(0,0,0,0.18)]'
    : size === 'lg'
    ? 'w-16 h-16 rounded-2xl text-2xl shadow-[0_4px_14px_rgba(0,0,0,0.16)]'
    : size === 'sm' ? 'w-8 h-8 rounded-lg text-sm' : 'w-11 h-11 rounded-xl text-lg';
  return (
    <span
      className={cn('app-icon-tile shrink-0 overflow-hidden flex items-center justify-center font-bold', box, className)}
      data-icon={appIconKind(app)}
      aria-hidden="true"
    >
      <AppIconContent app={app} eager={eager} />
    </span>
  );
}

/**
 * A project's picture: the one its group chose for its Discover card
 * (`illustration_url`, its dark twin in the dark theme), else its icon large
 * on its own colour (lib/community-color.ts).
 */
export function GuestCover({ app, className, iconSize = 'lg', hero = false }: {
  app: GuestApp;
  className?: string;
  iconSize?: 'lg' | 'xl';
  /** The picture a Discover card grows into as its page opens (./card-morph.ts). */
  hero?: boolean;
}) {
  const color = useCommunityColor({ color: app.icon_color, iconUrl: app.icon_url, iconEmoji: app.icon_emoji, key: app.slug });
  if (app.illustration_url) {
    return (
      <span data-guest-hero={hero ? '' : undefined} className={cn('relative block overflow-hidden bg-zinc-200 dark:bg-zinc-800', className)}>
        <img
          src={app.illustration_url}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn('h-full w-full object-cover', app.illustration_dark_url ? 'dark:hidden' : '')}
        />
        {app.illustration_dark_url ? (
          <img src={app.illustration_dark_url} alt="" loading="lazy" draggable={false} className="hidden h-full w-full object-cover dark:block" />
        ) : null}
      </span>
    );
  }
  return (
    <span data-guest-hero={hero ? '' : undefined} className={cn('relative flex items-center justify-center overflow-hidden', className)} style={{ background: color }}>
      <GuestIcon app={app} size={iconSize} />
    </span>
  );
}

/**
 * A link to a project's page. Its href is the page's clean address
 * (guest-data projectPath), so a crawler reading Discover finds every public
 * project at the address its preview, canonical and sitemap name. A plain
 * click on Discover stays in the page and moves the fragment, as the cards
 * always did (#app/<slug>/workshop, the address signing in returns to); a
 * click that asks for a new tab or window, or one from an address that is
 * already a path, is the browser's, and the server opens the same page.
 */
export function ProjectLink({ slug, children, ...rest }: { slug: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (location.pathname !== '/') return;
    e.preventDefault();
    // The card's picture grows into the page's band (./card-morph.ts).
    morph(cardCover(slug), () => { location.hash = projectHash(slug); }, () => projectHero(slug));
  };
  return <a href={projectPath(slug)} onClick={onClick} {...rest}>{children}</a>;
}

/**
 * A card's picture: the illustration its group chose, else its icon larger
 * on its colour, lit from the top left, with a blurred copy of the icon
 * glowing behind it in its own colours. The people pill sits in its lower
 * left and, under a pointer or keyboard focus, an arrow in its lower right.
 */
function CardCover({ app, eager }: { app: GuestApp; eager: boolean }) {
  const t = useMessages('auth');
  const color = useCommunityColor({ color: app.icon_color, iconUrl: app.icon_url, iconEmoji: app.icon_emoji, key: app.slug });
  const people = app.active_users || 0;
  return (
    <span
      data-guest-card-cover=""
      className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden bg-zinc-200 shadow-[inset_0_-1px_0_var(--app-sheet-line)] dark:bg-zinc-800"
      style={app.illustration_url ? undefined : { background: color }}
    >
      {app.illustration_url ? (
        <>
          <img
            src={app.illustration_url}
            alt=""
            loading={eager ? 'eager' : 'lazy'}
            draggable={false}
            className={cn('absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100', app.illustration_dark_url ? 'dark:hidden' : '')}
          />
          {app.illustration_dark_url ? (
            <img
              src={app.illustration_dark_url}
              alt=""
              loading={eager ? 'eager' : 'lazy'}
              draggable={false}
              className="absolute inset-0 hidden h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100 dark:block"
            />
          ) : null}
        </>
      ) : (
        <>
          <span aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(120%_90%_at_22%_12%,rgba(255,255,255,0.28),rgba(255,255,255,0)_58%)]" />
          {app.icon_url ? (
            <img
              src={app.icon_url}
              alt=""
              aria-hidden="true"
              loading={eager ? 'eager' : 'lazy'}
              draggable={false}
              className="pointer-events-none absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 scale-[1.6] rounded-full object-cover opacity-70 blur-[26px] saturate-[1.6] transition duration-300 ease-out group-hover:scale-[2] group-hover:opacity-95 motion-reduce:transition-none"
            />
          ) : null}
          <span className="relative transition-transform duration-300 ease-out group-hover:-translate-y-[3px] group-hover:scale-[1.07] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 motion-reduce:group-hover:scale-100">
            <GuestIcon app={app} size="lg" eager={eager} className="rounded-[18px] shadow-[0_12px_26px_rgba(0,0,0,0.3),0_0_0_1px_rgba(255,255,255,0.28)]" />
          </span>
        </>
      )}
      {isNew(app) ? (
        <span className="absolute left-2 top-2 rounded-full bg-white px-2 py-0.5 text-xs font-bold text-zinc-950 dark:bg-zinc-900 dark:text-white">
          {t('auth:guest.card.new')}
        </span>
      ) : null}
      {people >= MIN_PEOPLE ? (
        <span
          data-guest-card-people=""
          aria-hidden="true"
          className="absolute bottom-2 left-2 inline-flex h-6 items-center gap-1 rounded-full bg-white/90 pl-1.5 pr-2 text-xs font-[650] tabular-nums text-zinc-800 shadow-[0_1px_3px_rgba(0,0,0,0.14)]"
        >
          <UserIcon className="h-3.5 w-3.5" />
          {people.toLocaleString()}
        </span>
      ) : null}
      <span
        aria-hidden="true"
        className="absolute bottom-2 right-2 flex h-8 w-8 -translate-x-2 items-center justify-center rounded-full bg-white/95 text-zinc-900 opacity-0 shadow-[0_2px_8px_rgba(0,0,0,0.2)] transition duration-150 ease-out group-hover:translate-x-0 group-hover:opacity-100 group-has-[a:focus-visible]:translate-x-0 group-has-[a:focus-visible]:opacity-100 motion-reduce:transition-none"
      >
        <ArrowRightShortIcon className="h-[18px] w-[18px]" />
      </span>
    </span>
  );
}

/**
 * A card. Its name is its one link, stretched over the whole card, so the
 * picture, the sentence and the gaps between them all open the project's
 * page, and nothing is a link inside a link.
 */
function Card({ app, eager, featured = false }: { app: GuestApp; eager: boolean; featured?: boolean }) {
  const t = useMessages('auth');
  const people = app.active_users || 0;
  return (
    <article
      data-guest-card={featured ? undefined : app.slug}
      data-guest-featured={featured ? app.slug : undefined}
      className="group relative flex min-w-0 flex-col overflow-hidden rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_1px_2px_rgba(0,0,0,0.05),0_10px_22px_-12px_rgba(0,0,0,0.22)] transition-[transform,box-shadow] duration-150 ease-out hover:-translate-y-1 hover:shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_2px_4px_rgba(0,0,0,0.05),0_22px_36px_-14px_rgba(0,0,0,0.34)] active:scale-[0.97] active:duration-75 has-[a:focus-visible]:outline has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-[3px] has-[a:focus-visible]:outline-violet-600 motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100 dark:bg-zinc-900 dark:has-[a:focus-visible]:outline-violet-400"
    >
      <CardCover app={app} eager={eager} />
      <span className="flex flex-1 flex-col px-3 pb-3.5 pt-2.5">
        {/* The pill on the picture is hidden from a screen reader, which
            hears its number in words with the name instead. */}
        <ProjectLink
          slug={app.slug}
          data-guest-card-link=""
          aria-label={people >= MIN_PEOPLE ? t('auth:guest.card.peopleLabel', { name: app.name, count: people }) : undefined}
          className="block truncate text-[15px] font-[650] leading-5 text-zinc-900 outline-none after:absolute after:inset-0 after:z-[1] after:rounded-[20px] after:content-[''] dark:text-zinc-100"
        >
          {app.name}
        </ProjectLink>
        {app.description ? (
          // No `block` beside line-clamp-2: it comes later in the stylesheet,
          // undid the clamp's display and let the text run to four lines
          // (#5851), so cards in a row grew apart.
          <span data-guest-card-about="" className="mt-0.5 line-clamp-2 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
            {app.description}
          </span>
        ) : null}
      </span>
    </article>
  );
}

/**
 * "Try it", where the app has a view for somebody with no account, else a
 * way to read about it. An app that answers a visitor with no credential at
 * all opens in the landing's own viewer, inside Homeroom; one that answers a
 * guest opens at its own address, where the app host gives the visitor a
 * guest's view, the "You're looking around" strip and "Make an account to
 * continue" (src/services/edge-gate.js, public/usernode-bridge.js).
 */
export function TryLink({ app, className, onOpenInside, inside = false, children }: {
  app: GuestApp;
  className: string;
  onOpenInside: (app: GuestApp) => void;
  /** Open it in the landing's viewer whatever it needs: the visitor is signed in (a waitlisted account). */
  inside?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={app.url}
      data-guest-try={app.slug}
      className={className}
      onClick={(e) => {
        if (inside || app.requires_login === false) {
          e.preventDefault();
          onOpenInside(app);
        }
      }}
    >
      {children}
    </a>
  );
}

function SortControl({ sort, onSort }: { sort: GuestSort; onSort: (s: GuestSort) => void }) {
  const t = useMessages('auth');
  const label: Record<GuestSort, string> = {
    trending: t('auth:guest.sort.trending'),
    new: t('auth:guest.sort.new'),
    built: t('auth:guest.sort.built'),
  };
  return (
    <div role="group" aria-label={t('auth:guest.sort.label')} className="flex rounded-full bg-black/5 p-[3px] dark:bg-white/10">
      {SORTS.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={s === sort}
          data-guest-sort={s}
          onClick={() => onSort(s)}
          className={cn(
            'min-h-11 rounded-full px-3 text-[13px] font-semibold',
            s === sort
              ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-800 dark:text-white'
              : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
          )}
        >
          {label[s]}
        </button>
      ))}
    </div>
  );
}

function CardGrid({ apps, featured = false }: { apps: GuestApp[]; featured?: boolean }) {
  if (!apps.length) return null;
  return (
    <div className={CARD_GRID}>
      {apps.map((app, i) => (
        <Card key={app.slug} app={app} eager={i < 5} featured={featured} />
      ))}
    </div>
  );
}

export function GuestDiscover({ apps, failed, hero, onRetry, signedIn = false }: {
  /** The public directory, or null while it loads. */
  apps: GuestApp[] | null;
  /** The directory could not be read. */
  failed: boolean;
  /** The story's short version, above everything (features/auth/story.tsx). */
  hero: ReactNode;
  /** Read the directory again, from the line that says it could not be. */
  onRetry?: () => void;
  /**
   * A waitlisted account is looking (landing.tsx): it is signed in, so
   * every public project opens for it, Featured holds every project an
   * admin featured, and nothing here asks it to sign up.
   */
  signedIn?: boolean;
}) {
  const t = useMessages('auth');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<GuestSort>('trending');
  const [shown, setShown] = useState(0);

  const all = apps || [];
  const kinds = useMemo(() => presentCategories(all), [all]);
  const browsing = !query.trim() && !category;
  const inApp = inHomeroomApp();
  const tryable = useCallback((app: GuestApp) => signedIn || canTryHere(app, inApp), [signedIn, inApp]);
  const featured = useMemo(() => (browsing ? featuredApps(all, tryable) : []), [all, browsing, tryable]);
  const list = useMemo(() => {
    const above = new Set(featured.map((a) => a.slug));
    // Sorted, then searched: the search's exact-name lead must survive the sort (#5891).
    return filterApps(sortApps(all, sort), query, category).filter((a) => !above.has(a.slug));
  }, [all, query, category, sort, featured]);
  useEffect(() => { setShown(0); }, [query, category, sort]);
  const wide = typeof window !== 'undefined' && window.matchMedia?.('(min-width: 768px)').matches;
  const step = wide ? CARDS_STEP_WIDE : CARDS_STEP;
  const cards = list.slice(0, shown || step);

  return (
    <div data-guest-discover="" className="flex flex-col gap-5">
      {hero}
      <div className="flex flex-col gap-5 px-4">
        <label className="flex h-11 items-center gap-2 rounded-[14px] bg-white px-3.5 text-zinc-400 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-500">
          <SearchIcon className="h-[18px] w-[18px] shrink-0" />
          <input
            type="search"
            data-guest-search=""
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('auth:guest.search.placeholder')}
            aria-label={t('auth:guest.search.label')}
            className="h-11 min-w-0 flex-1 bg-transparent text-base text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
        </label>

        {kinds.length ? (
          <ChipRail role="group" aria-label={t('auth:guest.categories.label')} className="-mx-4 -my-2 gap-2">
            <Chip size="bar" className="min-h-11" selected={!category} data-guest-category="all" onClick={() => setCategory(null)}>
              {t('auth:guest.category.all')}
            </Chip>
            {kinds.map((k) => (
              <Chip key={k} size="bar" className="min-h-11" selected={category === k} data-guest-category={k} onClick={() => setCategory(category === k ? null : k)}>
                {t(`auth:guest.category.${k}`)}
              </Chip>
            ))}
          </ChipRail>
        ) : null}

        {featured.length ? (
          <section className="flex flex-col gap-2.5">
            <h2 className={SMALL_CAPS_LABEL}>{t('auth:guest.featured')}</h2>
            <CardGrid apps={featured} featured />
          </section>
        ) : null}

        <section className="flex flex-col gap-3" aria-busy={apps ? undefined : true}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={SMALL_CAPS_LABEL}>{browsing ? t('auth:guest.all') : t('auth:guest.results')}</h2>
            <SortControl sort={sort} onSort={setSort} />
          </div>
          {!apps && !failed ? (
            <div className={CARD_GRID} aria-label={t('auth:guest.loading')}>
              {[0, 1, 2, 3].map((i) => <span key={i} className="aspect-[16/10] rounded-[20px] bg-black/5 dark:bg-white/10" />)}
            </div>
          ) : null}
          {failed ? (
            // The sentence, and the one thing to do about it (landing.tsx
            // has already tried twice more by itself before this shows).
            <div className="flex flex-col items-center gap-3 py-6">
              <p className="text-center text-[15px] text-zinc-500 dark:text-zinc-400">{t('auth:guest.loadFailed')}</p>
              {onRetry ? (
                <button
                  type="button"
                  data-guest-retry=""
                  // The same pill as Show more, below.
                  className="min-h-11 self-center rounded-full bg-white px-5 text-[15px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  onClick={onRetry}
                >
                  {t('auth:guest.retry')}
                </button>
              ) : null}
            </div>
          ) : null}
          <CardGrid apps={cards} />
          {list.length > cards.length ? (
            <button
              type="button"
              data-guest-show-more=""
              className="min-h-11 self-center rounded-full bg-white px-5 text-[15px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
              onClick={() => setShown(cards.length + step)}
            >
              {t('auth:guest.showMore')}
            </button>
          ) : null}
          {apps && !list.length ? (
            <p className="py-6 text-center text-[15px] text-zinc-500 dark:text-zinc-400">
              {browsing ? t('auth:guest.emptyAll') : t('auth:guest.empty')}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
