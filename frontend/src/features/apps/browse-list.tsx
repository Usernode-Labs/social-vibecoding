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
import { AppIconContent, AppPills, appIconKind, hasAppPills } from './app-card-view';

type RowView = {
  app: Record<string, any>;
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
const ADD_ON = 'bg-emerald-500 border-emerald-500 text-white';
const ADD_OFF = 'border-violet-500 dark:border-violet-400 text-violet-600 '
  + 'dark:text-violet-400 bg-white dark:bg-zinc-900 hover:bg-violet-50 dark:hover:bg-violet-950';

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
      onPointerDown={warm}
      onMouseEnter={warm}
      inset="none"
      chevron={false}
      leading={(
        <div
          className="app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg"
          data-icon={appIconKind(view.app)}
        >
          <AppIconContent app={view.app} />
        </div>
      )}
      title={(
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">{view.name}</span>
          <span className={`status-dot ${view.statusDot} shrink-0`} title={view.status}></span>
        </span>
      )}
      subtitle={(
        <>
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
        {view.added ? 'Added' : 'Add'}
      </button>
        </>
      )}
    />
  );
}

export function BrowseRows({ rows }: { rows: RowView[] | null }): ReactNode {
  if (!rows) return null;
  return <>{rows.map((view) => <Row key={view.slug} view={view} />)}</>;
}
