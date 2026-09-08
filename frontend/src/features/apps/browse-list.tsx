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

import { CheckIcon } from '@/components/ui/icons';
import { ListRow } from '@/components/ui/grouped-list';
import { Button } from '@/components/ui/button';
import { AppIconContent, AppPills, appIconKind, hasAppPills } from './app-card-view';

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
  addTitle: string;
};

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Browse : null) || null;
}

const ADD_BASE = 'browse-add-btn shrink-0 inline-flex items-center gap-1 rounded-full '
  + 'border px-3 py-1.5 text-xs font-medium transition-colors ';
// emerald-700, not -500: white on #10b981 is 2.5:1 — a green you can see and a
// label you cannot read. -700 takes the same pill to 5.5:1 with the state
// unchanged.
const ADD_ON = 'bg-emerald-700 border-emerald-700 text-white';
// Filled neutral, not an accent outline: the row sits on a white card now, and
// an outlined control on a floating surface is the shape the language never
// draws (see the `neutral` variant in @/components/ui/button.tsx). ADD_ON stays
// a filled emerald because "Added" is a STATE, not an action.
const ADD_OFF = 'border-transparent bg-zinc-100 dark:bg-zinc-800 text-zinc-900 '
  + 'dark:text-zinc-100 hover:bg-zinc-200 dark:hover:bg-zinc-700';

function Row({ view }: { view: RowView }): ReactNode {
  const rowRef = useRef<HTMLDivElement | null>(null);

  // NavLink.wireModified binds its own listeners to the node, so it runs in an
  // effect against the mounted element. It re-binds whenever the descriptor
  // changes identity, which is also when the guards it closes over change.
  useEffect(() => {
    const node = rowRef.current;
    if (!node) return;
    const nav = (window as any).NavLink;
    const hrefFor = (e: MouseEvent) => {
      if ((e.target as Element)?.closest?.('.browse-add-btn')) return null;
      return controller()?.rowHref(view) ?? null;
    };
    const activate = (e: MouseEvent) => {
      if ((e.target as Element)?.closest?.('.browse-add-btn')) return;
      controller()?.openRow(view);
    };
    if (nav) nav.wireModified(node, hrefFor, activate);
    else node.addEventListener('click', activate as EventListener);
    return () => {
      if (!nav) node.removeEventListener('click', activate as EventListener);
    };
  }, [view]);

  const warm = () => controller()?.warmRow(view);

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
        <div
          className="app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg"
          data-icon={appIconKind(view.app)}
          // The same slug-derived identity tint the launcher grid draws. An
          // app that is a lilac tile on Home was a blank white square here,
          // which is the one thing a launcher icon must never be: different
          // per screen. app.css turns the attribute into the colour.
        >
          <AppIconContent app={view.app} />
        </div>
      )}
      title={(
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="browse-row-name truncate">{view.name}</span>
          <span className={`status-dot ${view.statusDot} shrink-0`} title={view.status}></span>
        </span>
      )}
      subtitle={(
        <>
          {view.app.directory?.label ? (
            <span className="block text-xs text-zinc-600 dark:text-zinc-400">{view.app.directory.label}</span>
          ) : null}
          <span className="block truncate">{view.meta}</span>
          {hasAppPills(view.app) ? (
            <span className="mt-1 flex flex-wrap items-center gap-1">
              <AppPills app={view.app} />
            </span>
          ) : null}
        </>
      )}
      trailing={(
        <>
      {/* No `type` — the hand-written row shipped a bare <button>, and it sits
          in no form, so the default submit type is inert either way. */}
      <button
        className={ADD_BASE + (view.added ? ADD_ON : ADD_OFF)}
        data-slug={view.slug}
        data-added={String(view.added)}
        aria-pressed={view.added}
        title={view.addTitle}
        onClick={(e) => {
          e.stopPropagation();
          controller()?.toggleRowAdded(view);
        }}
      >
        {view.added ? <CheckIcon className="w-3.5 h-3.5" strokeWidth="3" aria-hidden="true" /> : null}
        {/* #1553: "Add" alone never said add to WHAT. Every other surface that
            offers this already spells out the destination — the detail page's
            button, the app-chip menu, this button's own title attribute — so
            the row stops being the one place it is a guess. "Added" stays
            short: it is a state, and the row it sits on says which app. */}
        {view.added ? 'Added' : 'Add to Your apps'}
      </button>
        </>
      )}
    />
  );
}

export function BrowseRows({ rows, curated = false, moreExpanded = false }: {
  rows: RowView[] | null;
  curated?: boolean;
  moreExpanded?: boolean;
}): ReactNode {
  if (!rows) return null;
  const renderRows = (items: RowView[]) => items.map((view) => <Row key={view.slug} view={view} />);
  if (!curated) return <>{renderRows(rows)}</>;
  const ready = rows.filter((view) => view.directoryTier === 'ready');
  const unreviewed = rows.filter((view) => view.directoryTier !== 'ready' && view.directoryTier !== 'more');
  const more = rows.filter((view) => view.directoryTier === 'more');
  const heading = 'md:col-span-full px-3 pt-3 pb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300';
  return (
    <>
      {ready.length ? <h2 className={heading}>Reviewed working apps</h2> : null}
      {renderRows(ready)}
      {unreviewed.length ? <h2 className={heading}>Not yet reviewed</h2> : null}
      {renderRows(unreviewed)}
      {more.length ? (
        <>
          <div className="md:col-span-full p-3">
            <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
              Demos and apps needing fixes, setup, or an icon are still available below and in search.
            </p>
            <Button
              type="button"
              variant="neutral"
              ink="neutral"
              aria-expanded={moreExpanded}
              aria-controls="browse-more-apps"
              onClick={() => controller()?.toggleMore()}
            >
              {moreExpanded ? 'Show less' : `Show more (${more.length})`}
            </Button>
          </div>
          <div id="browse-more-apps" className={moreExpanded
            ? 'md:col-span-full md:grid md:grid-cols-2 lg:grid-cols-3 md:gap-3'
            : 'hidden'}>
            {moreExpanded ? renderRows(more) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
