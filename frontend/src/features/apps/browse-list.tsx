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

import { CheckIcon, PlusIcon } from '@/components/ui/icons';
import { ListRow, SectionHeader } from '@/components/ui/grouped-list';
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
          {/* `truncate`, not just `block` (QA 2026-09-24 Q10): the subtitle box
              clips, so without its own ellipsis this line was cut mid-word
              ("Reviewed workir") on a phone. */}
          {view.app.directory?.label ? (
            <span className="block truncate text-xs text-zinc-600 dark:text-zinc-400">{view.app.directory.label}</span>
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
        aria-label={view.added ? undefined : 'Add to Your apps'}
        title={view.addTitle}
        onClick={(e) => {
          e.stopPropagation();
          controller()?.toggleRowAdded(view);
        }}
      >
        {view.added
          ? <CheckIcon className="w-3.5 h-3.5" strokeWidth="3" aria-hidden="true" />
          : <PlusIcon className="w-3.5 h-3.5" strokeWidth="3" aria-hidden="true" />}
        {/* #1553: "Add" alone never said add to WHAT, so the row spelled out
            "Add to Your apps". QA 2026-09-24 Q10: that 127px pill left the
            app's NAME ten characters on a desktop box and nothing at all at
            1024. The visible label is "+ Add" again, and the destination
            stays where #1553 put it for everyone who is not reading the
            glyph: the accessible name and the title attribute both say
            "Add to Your apps". "Added" is a state and stays short. */}
        {view.added ? 'Added' : 'Add'}
      </button>
        </>
      )}
    />
  );
}

export function BrowseRows({ rows, curated = false, grouped = true, moreExpanded = false }: {
  rows: RowView[] | null;
  /** Tuck the `more` tier (demos, apps needing fixes) behind Show more. */
  curated?: boolean;
  /**
   * Also split the rest under tier headings. Recommended only (#1912): a
   * metric sort keeps one list in its own order, and still gets Show more.
   */
  grouped?: boolean;
  moreExpanded?: boolean;
}): ReactNode {
  if (!rows) return null;
  const renderRows = (items: RowView[]) => items.map((view) => <Row key={view.slug} view={view} />);
  if (!curated) return <>{renderRows(rows)}</>;
  const shown = rows.filter((view) => view.directoryTier !== 'more');
  const ready = rows.filter((view) => view.directoryTier === 'ready');
  const unreviewed = rows.filter((view) => view.directoryTier !== 'ready' && view.directoryTier !== 'more');
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
      {grouped ? (
        <>
          {ready.length ? <SectionHeader className={headingClass}>Reviewed working apps</SectionHeader> : null}
          {renderRows(ready)}
          {unreviewed.length ? <SectionHeader className={headingClass}>Not yet reviewed</SectionHeader> : null}
          {renderRows(unreviewed)}
        </>
      ) : renderRows(shown)}
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
            ? 'md:col-span-full md:grid md:grid-cols-2 xl:grid-cols-3 md:gap-3'
            : 'hidden'}>
            {moreExpanded ? renderRows(more) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
