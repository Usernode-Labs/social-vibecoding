/**
 * The browse screen's level-1 rows (#1191 slice 6, conversion 3).
 *
 * The only writer of the DOM below #browse-list. ./browse.js decides which
 * apps show and in what order; this file turns each row descriptor into the
 * markup the hand-written shell used to get from Browse.renderAppRow, class
 * string for class string.
 *
 * ONE row markup, two layouts. The phone list and the wide-screen 2/3-column
 * box grid are the same element — the grid is Tailwind classes on the
 * #browse-list container (./browse-screen.tsx) and the box treatment is
 * `.browse-row` in app.css. No matchMedia here, and no re-render on resize.
 *
 * The row can't BE an anchor (it wraps its own Add button), so NavLink is
 * asked to intercept a modified click on the mounted node rather than the
 * markup carrying an href. Browse.rowHref repeats the same guards
 * Browse.openRow applies, so an inert row — a staging ?demo=1 tile, or a
 * click that landed on Add — stays inert under cmd/middle-click too.
 *
 * INITIAL RENDER: `rows === null` until the first _renderList, and that
 * renders nothing at all — which is exactly the empty #browse-list the
 * hand-written shell shipped and the SSG prerender has to reproduce.
 */

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { GlobeIcon, PlusIcon } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { Button } from '@/components/ui/button';
import { useMessages } from '../../lib/i18n/react';
import { AppIconContent, AppIconLink, AppPills, appIconKind, hasAppPills } from './app-card-view';

type RowView = {
  app: Record<string, any>;
  directoryTier?: 'ready' | 'unreviewed' | 'more';
  slug: string;
  name: string;
  meta: string;
  status: string;
  statusDot: string;
  demo: boolean;
  openable: boolean;
  added: boolean;
  /** A joined row's Open: the app can run, and it is not an inert fixture. */
  canOpen?: boolean;
  /** In "Recommended for you", the default list's first section (#5267). */
  recommended?: boolean;
  addTitle: string;
};

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Browse : null) || null;
}

const ADD_BASE = 'browse-add-btn shrink-0 inline-flex items-center gap-1 rounded-full '
  + 'border px-3 py-1.5 text-xs font-medium transition-colors ';
// Join and Open are the same filled neutral pill, the App Store's Get / Open
// (#5267). A joined row used to say "✓ Joined", and down a directory where
// most rows were joined that was a column of a state nobody needed told; it
// now offers the next thing to do with the app, opening it. Filled neutral,
// not an accent outline: the row sits on a white card, and an outlined
// control on a floating surface is the shape the language never draws (see
// the `neutral` variant in @/components/ui/button.tsx).
const ADD_FILL = 'border-transparent bg-zinc-100 dark:bg-zinc-800 text-zinc-900 '
  + 'dark:text-zinc-100 hover:bg-zinc-200 dark:hover:bg-zinc-700';

/**
 * The label a Discover row shows under its name, from the API's
 * `directory` (src/services/discovery-curation.js), or null.
 *
 * REVIEW STATE IS NOT SHOWN (#5267). "Reviewed working", "Not yet reviewed"
 * and "Needs re-review" (states `working`, `unreviewed` and `outdated`) are
 * the admin console's moderation vocabulary: the directory used to group by
 * them under headings and, where no heading said it, label each row. People
 * browsing see the apps in the same order without the words; an admin finds
 * the unreviewed ones under the "Not yet reviewed" chip, and Admin › Featured
 * apps keeps every distinction. A label that says what a person can DO
 * about an app stays: Demo, Needs fixes, Not running, Needs an icon, which
 * are the rows under Show more.
 */
const REVIEW_STATES = new Set(['working', 'unreviewed', 'outdated']);
export function rowDirectoryLabel(directory?: { state?: string; label?: string } | null): string | null {
  if (!directory?.label) return null;
  if (directory.state && REVIEW_STATES.has(directory.state)) return null;
  return directory.label;
}

/** How many rows down the list load their icons without waiting: a phone's
    first screen, or the first rows of the wide window's grid. */
const EAGER_ICON_ROWS = 12;

function Row({ view, eager = false }: {
  view: RowView;
  /** On the first screen: its icon loads at once (AppIconContent `eager`). */
  eager?: boolean;
}): ReactNode {
  const t = useMessages('discover');
  const rowRef = useRef<HTMLDivElement | null>(null);

  // NavLink.wireModified binds its own listeners to the node, so it runs in an
  // effect against the mounted element. ONCE PER NODE (#3620): it has no way
  // to unbind, and this effect used to re-run whenever the descriptor changed
  // identity, which every list render does. Each run added another click
  // listener, so one tap opened the row two or three times, and each open was
  // a history entry at the same address: Back from the hub it opened stayed on
  // the hub, two and three times over, before it reached Discover. The
  // listeners read the descriptor through a ref instead, so the guards they
  // apply are always the current row's.
  const latest = useRef<RowView>(view);
  latest.current = view;
  useEffect(() => {
    const node = rowRef.current;
    if (!node) return;
    const nav = (window as any).NavLink;
    const hrefFor = (e: MouseEvent) => {
      const view = latest.current;
      if ((e.target as Element)?.closest?.('.browse-add-btn, .app-icon-link')) return null;
      return controller()?.rowHref(view) ?? null;
    };
    const activate = (e: MouseEvent) => {
      const view = latest.current;
      if ((e.target as Element)?.closest?.('.browse-add-btn, .app-icon-link')) return;
      controller()?.openRow(view);
    };
    if (nav) nav.wireModified(node, hrefFor, activate);
    else node.addEventListener('click', activate as EventListener);
    return () => {
      if (!nav) node.removeEventListener('click', activate as EventListener);
    };
  }, []);

  const warm = () => controller()?.warmRow(view);
  const label = rowDirectoryLabel(view.app.directory);

  return (
    <ListRow
      ref={rowRef}
      className={`browse-row ${view.openable ? 'cursor-pointer' : 'cursor-default'}`}
      data-slug={view.slug}
      data-demo={view.demo ? 'true' : undefined}
      data-directory-state={view.app.directory?.state}
      onPointerDown={warm}
      onMouseEnter={warm}
      inset="none"
      chevron={false}
      contentClassName="browse-row-content"
      titleClassName="browse-row-title"
      subtitleClassName="browse-row-meta"
      leading={(
        <AppIconLink
          nested
          slug={view.demo ? null : view.slug}
          name={view.name}
          className="app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg"
          data-icon={appIconKind(view.app)}
        >
          <AppIconContent app={view.app} eager={eager} />
        </AppIconLink>
      )}
      title={(
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="browse-row-name truncate">{view.name}</span>
          {/* A DOT ONLY WHEN SOMETHING IS WRONG. Green on every running app
              is a light that is always on, which says nothing; the meta line
              already names a status that is not "running". */}
          {view.statusDot !== 'running' ? (
            <span className={`status-dot ${view.statusDot} shrink-0`} title={view.status}></span>
          ) : null}
        </span>
      )}
      subtitle={(
        <>
          {/* `truncate`, not just `block` (QA 2026-09-24 Q10): the subtitle box
              clips, so without its own ellipsis this line was cut mid-word
              ("Reviewed workir") on a phone. */}
          {label ? (
            <span className="block truncate text-xs text-zinc-600 dark:text-zinc-400">{label}</span>
          ) : null}
          <span className="block truncate">{view.meta}</span>
          {hasAppPills(view.app) ? (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              {/* ONE pill: the first thing that asks for attention, else
                  the visibility. A row of three chips under a meta line
                  was more to read than the app's own name. */}
              <AppPills app={view.app} limit={1} />
            </span>
          ) : null}
        </>
      )}
      trailing={(
        <>
      {/* No `type` — the hand-written row shipped a bare <button>, and it sits
          in no form, so the default submit type is inert either way. Both
          buttons keep `browse-add-btn` and `data-added`: the row's own click
          skips that class, and the declared checks select on the pair. */}
      {!view.added ? (
        <button
          className={ADD_BASE + ADD_FILL}
          data-slug={view.slug}
          data-added="false"
          data-action="join"
          aria-label={t('discover:list.join.named', { app: view.name })}
          title={view.addTitle}
          onClick={(e) => {
            e.stopPropagation();
            controller()?.toggleRowAdded(view);
          }}
        >
          <PlusIcon className="w-3.5 h-3.5" strokeWidth="3" aria-hidden="true" />
          {/* JOIN, not Add (communities, stage 1): it puts YOU in the app's
              community, which is what lets you propose and vote, and it
              still pins the app. QA 2026-09-24 Q10's width rule holds: the
              visible label is one short word and the accessible name
              carries the rest, "Join <app>". */}
          {t('discover:list.join.action')}
        </button>
      ) : view.canOpen ? (
        <button
          className={ADD_BASE + ADD_FILL}
          data-slug={view.slug}
          data-added="true"
          data-action="open"
          aria-label={t('discover:list.open.named', { app: view.name })}
          title={view.addTitle}
          onClick={(e) => {
            e.stopPropagation();
            controller()?.openRowApp(view);
          }}
        >
          {t('discover:list.open.action')}
        </button>
      ) : null}
        </>
      )}
    />
  );
}

/**
 * The "Open site" row (#5364): drawn while the search text is a web address,
 * above every app row. An app row cannot be an anchor because it wraps its
 * own Join button; this row wraps nothing, so it IS one — an absolute external
 * href with target="_blank", which NavLink has nothing to do with (it is never
 * handed to wireModified, and the router does not intercept it). It carries no
 * data-slug, so every selector that reads `.browse-row[data-slug]` and the
 * Join button skip it.
 */
function SiteRow({ site }: { site: { href: string; label: string } }): ReactNode {
  const t = useMessages('discover');
  return (
    <ListRow
      as="a"
      href={site.href}
      target="_blank"
      rel="noopener noreferrer"
      className="browse-row browse-site-row md:col-span-full"
      inset="none"
      chevron={false}
      contentClassName="browse-row-content"
      titleClassName="browse-row-title"
      subtitleClassName="browse-row-meta"
      leading={(
        // The grey tile an app's icon would sit in, holding a globe: the row
        // leaves Homeroom, so it has no app artwork.
        <IconTile className="w-11 h-11 shrink-0 rounded-xl" aria-hidden="true">
          <GlobeIcon className="w-5 h-5" aria-hidden="true" />
        </IconTile>
      )}
      title={<span className="browse-row-name truncate">{site.label}</span>}
      subtitle={<span className="block truncate">{t('discover:site.subtitle')}</span>}
    />
  );
}

export function BrowseRows({ rows, site = null, curated = false, grouped = true, moreExpanded = false }: {
  rows: RowView[] | null;
  /**
   * The "Open site" row's descriptor from Browse.siteFor, or null: while the
   * search text is a web address, one row above the app matches offers to
   * open that site in a new tab (#5364).
   */
  site?: { href: string; label: string } | null;
  /** Tuck the `more` tier (demos, apps needing fixes) behind Show more. */
  curated?: boolean;
  /**
   * Also split the rest under tier headings. Recommended only (#1912): a
   * metric sort keeps one list in its own order, and still gets Show more.
   */
  grouped?: boolean;
  moreExpanded?: boolean;
}): ReactNode {
  const t = useMessages('discover');
  if (!rows) return null;
  const siteRow = site ? <SiteRow site={site} /> : null;
  // The rows a first screen shows load their icons at once (#11); the rest
  // wait until they are scrolled near. Counted down the list as drawn.
  let drawn = 0;
  const renderRows = (items: RowView[]) => items.map((view) => (
    <Row key={view.slug} view={view} eager={drawn++ < EAGER_ICON_ROWS} />
  ));
  if (!curated) return <>{siteRow}{renderRows(rows)}</>;
  const shown = rows.filter((view) => view.directoryTier !== 'more');
  // The default list's two sections (#5267): "Recommended for you" (the
  // featured apps you are not in, Browse.recommendedApps) and then the rest,
  // reviewed apps first as the Recommended order puts them, under one
  // heading. The rest is "More apps" under a Recommended section and "All
  // apps" where there is none. No heading names a review state any more.
  const picked = shown.filter((view) => view.recommended);
  const rest = shown.filter((view) => !view.recommended);
  const more = rows.filter((view) => view.directoryTier === 'more');
  // A LABEL OVER A CARD GROUP, so it is @/components/ui/grouped-list's
  // SectionHeader and not a fourth hand-written heading: the rows under it are
  // that file's ListRow, and on the phone #browse-list IS the card they sit in
  // (`browse-pane-body`). It stays an <h2> with the label as its only child —
  // dapp.json's `?sort=users` check reads `#browse-list...:not(:has(h2))` to
  // say the ungrouped list draws no tier headings at all.
  //
  // `md:col-span-full` is the only thing added: at md+ the container is a 2/3
  // column grid and a heading has to span it. The gutter comes from the
  // primitive, which is a fix as well as a consolidation — the hand-written
  // `px-3` did not line up with ListRow's `px-4` text column.
  const headingClass = 'md:col-span-full';
  return (
    <>
      {siteRow}
      {grouped && anyReviewed ? (
        <>
          {picked.length ? <SectionHeader className={headingClass}>{t('discover:list.heading.recommended')}</SectionHeader> : null}
          {renderRows(picked)}
          {rest.length ? (
            <SectionHeader className={headingClass}>
              {picked.length ? t('discover:list.heading.moreApps') : t('discover:list.heading.allApps')}
            </SectionHeader>
          ) : null}
          {renderRows(rest)}
        </>
      ) : renderRows(shown)}
      {more.length ? (
        <>
          <div className="md:col-span-full p-3">
            <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
              {t('discover:list.more.note')}
            </p>
            <Button
              type="button"
              variant="neutral"
              ink="neutral"
              aria-expanded={moreExpanded}
              aria-controls="browse-more-apps"
              onClick={() => controller()?.toggleMore()}
            >
              {moreExpanded ? t('discover:list.more.showLess') : t('discover:list.more.showMore', { count: more.length })}
            </Button>
          </div>
          <div id="browse-more-apps" className={moreExpanded
            ? 'md:col-span-full md:grid md:grid-cols-2 xl:grid-cols-3 md:gap-3'
            : 'hidden'}>
            {moreExpanded ? renderRows(more) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
