/**
 * The browse screen's level-2 page (#1191 slice 6, conversion 3).
 *
 * The only writer of the DOM below #browse-detail. ./browse.js decides what
 * the page says — which of loading / missing / ready it is in, which action
 * rows survive the Home.menuItemsFor filter, what state the contributors card
 * is in — and this file renders that descriptor, class string for class
 * string.
 *
 * Two things ride across the seam rather than being re-derived here:
 *
 *  - `versionPillHtml`. AppView.renderAppVersionPillHTML is a pure string
 *    builder in the still-legacy app view: it reads no DOM and mutates
 *    nothing, so rendering its output as markup keeps ONE owner for the build
 *    chip instead of a second implementation that would drift the day the
 *    deploy states change. It is the app's own version metadata, not user
 *    prose.
 *  - the action rows' `run` closures, which stay on Browse._detailActions.
 *    The descriptor carries an index; the click hands the clicked BUTTON back
 *    to Browse._runDetailAction, so a keepOpen item (Check for updates) can
 *    flip its label in place exactly as it does inside the home card's
 *    popover.
 *
 * INITIAL RENDER: `detail === null` until the detail level is entered, and
 * that renders nothing — the empty, hidden #browse-detail the hand-written
 * shell shipped and the SSG prerender has to reproduce.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ArrowRightShortIcon, ChevronRightIcon } from '@/components/ui/icons';

import { AppIconContent, AppPills, appIconKind, hasAppPills } from './app-card-view';

type ContributorRowView = {
  who: string;
  rank: number;
  initial: string;
  merged: number;
  meta: string | null;
  pillTint: string;
};

type ContributorsView = {
  state: string;
  count: number | null;
  rows: ContributorRowView[];
  toggle: string | null;
  note: string | null;
};

type ActionView = {
  index: number;
  label: string;
  title: string | null;
  danger: boolean;
  disabled: boolean;
};

export type DetailView =
  | { state: 'loading' }
  | { state: 'missing' }
  | {
    state: 'ready';
    app: Record<string, any>;
    name: string;
    slug: string;
    versionPillHtml: string;
    forkedFrom: { name: string; href: string | null } | null;
    updatedRel: string | null;
    canOpen: boolean;
    openLabel: string;
    isAdded: boolean;
    favLabel: string;
    actions: ActionView[];
    contributors: ContributorsView;
  };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Browse : null) || null;
}

const NOTE_CLASS = 'px-3 py-3 text-sm text-zinc-500 dark:text-zinc-400';
const CARD_CLASS = 'mt-5 rounded-sm border border-[var(--frame-line)] bg-white dark:bg-zinc-900 overflow-hidden';

// The inset row hairline, as @/components/ui/grouped-list.tsx draws it: a
// pseudo-element on every row but the last, starting at the text column rather
// than the card's edge. `divide-y` on the parent is what these lists used, and
// it cannot inset — so its rules ran into the card's corner radius the moment
// the card stopped being a bordered rectangle. `text` depth (px-3) here: these
// rows lead with a rank number, not a tile.
const ROW_RULE = "[&:not(:last-child)]:after:absolute [&:not(:last-child)]:after:bottom-0 "
  + "[&:not(:last-child)]:after:left-3 [&:not(:last-child)]:after:right-0 "
  + "[&:not(:last-child)]:after:h-px [&:not(:last-child)]:after:bg-zinc-200 "
  + "dark:[&:not(:last-child)]:after:bg-zinc-800 [&:not(:last-child)]:after:content-['']";

function ContributorRow({ row }: { row: ContributorRowView }): ReactNode {
  return (
    <button
      type="button"
      className={`browse-contrib-row relative w-full text-left flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-zinc-500/5 ${ROW_RULE}`}
      data-username={row.who}
      title={`View @${row.who}’s proposals`}
      onClick={() => controller()?.openContributor(row.who)}
    >
      <div className="w-5 shrink-0 text-center text-xs font-mono text-zinc-500 dark:text-zinc-500">{row.rank}</div>
      <div className="w-8 h-8 shrink-0 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 flex items-center justify-center font-semibold text-xs">{row.initial}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{`@${row.who}`}</div>
        {row.meta ? (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{row.meta}</div>
        ) : null}
      </div>
      <div
        className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${row.pillTint}`}
        title="Proposals merged into this app"
      >{`${row.merged} merged`}</div>
    </button>
  );
}

function Contributors({ view }: { view: ContributorsView }): ReactNode {
  return (
    <div id="browse-detail-contributors" className={CARD_CLASS}>
      {/* The heading paints in every state (including loading) so the page
          doesn't jump when the fetch lands. */}
      <h3
        className="relative px-3 py-2.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100 after:absolute after:bottom-0 after:left-3 after:right-0 after:h-px after:bg-zinc-200 dark:after:bg-zinc-800 after:content-['']"
        title="The app&rsquo;s creator, its members, and everyone whose proposal has been merged into it"
      >
        Contributors
        {view.count == null ? null : (
          <span className="text-zinc-500 dark:text-zinc-500 font-normal">{` · ${view.count}`}</span>
        )}
      </h3>
      {view.note ? <p className={NOTE_CLASS}>{view.note}</p> : null}
      {view.rows.length ? (
<div>
          {view.rows.map((row) => <ContributorRow key={row.who} row={row} />)}
        </div>
      ) : null}
      {view.toggle ? (
        <button
          type="button"
          id="browse-contrib-toggle"
          className="w-full px-3 py-2.5 text-sm font-medium text-violet-700 dark:text-violet-400 text-left transition-colors hover:bg-zinc-500/5 border-t border-zinc-200 dark:border-zinc-800"
          onClick={() => controller()?.toggleContributors()}
        >{view.toggle}</button>
      ) : null}
    </div>
  );
}

function Missing(): ReactNode {
  return (
    <div className="text-sm text-zinc-500 dark:text-zinc-400">
      <p className="mb-3">That app isn&rsquo;t available.</p>
      {/* #1036: a real anchor, so a modified click stays the browser's. */}
      <a
        id="browse-detail-back"
        href="#apps"
        className="inline-block text-violet-700 hover:text-violet-400 dark:text-violet-400"
        onClick={(e) => {
          const nav = (window as any).NavLink;
          if (nav && nav.isNativeClick(e.nativeEvent)) return;
          e.preventDefault();
          location.hash = '#apps';
        }}
      >&larr; Back to all apps</a>
    </div>
  );
}

function Ready({ view }: { view: Extract<DetailView, { state: 'ready' }> }): ReactNode {
  const warm = () => controller()?.warmDetailApp(view.slug);
  return (
    <>
      <div className="flex items-start gap-4">
        <div
          className="app-icon-tile w-16 h-16 shrink-0 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-2xl"
          data-icon={appIconKind(view.app)}
        >
          <AppIconContent app={view.app} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 break-words">{view.name}</h2>
          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-500 break-all">{view.slug}</p>
          {view.versionPillHtml ? (
            <div className="mt-2" dangerouslySetInnerHTML={{ __html: view.versionPillHtml }} />
          ) : null}
          {/*
              Fork lineage, directly under the version it qualifies — the row
              that used to be the drawer footer's last line, moved to the app's
              own page (see Browse._renderDetail). Amber is retained as the
              lineage colour, and it stays TEXT rather than a filled pill: it
              is a note about where this app came from, not a status.

              A deleted source resolves to `href: null` and renders inert,
              which is also why the name is a text child and never markup.
          */}
          {view.forkedFrom ? (
            <p id="browse-detail-fork" className="mt-1 text-xs text-amber-600 dark:text-amber-400 truncate">
              {view.forkedFrom.href ? (
                <a
                  href={view.forkedFrom.href}
                  className="hover:underline"
                  title={`Forked from ${view.forkedFrom.name}: open the original`}
                >
                  {`\u2442 Forked from ${view.forkedFrom.name}`}
                </a>
              ) : (
                <span className="opacity-90" title="The original app no longer exists">
                  {`\u2442 Forked from ${view.forkedFrom.name}`}
                </span>
              )}
            </p>
          ) : null}
          {view.updatedRel ? (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{`Updated ${view.updatedRel}`}</p>
          ) : null}
          {hasAppPills(view.app) ? (
            <div className="flex flex-wrap items-center gap-1 mt-2">
              <AppPills app={view.app} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Button
          type="button"
          id="browse-detail-open"
          layout="iconRow"
          variant="roundedFull"
          size="lg"
          ink={view.canOpen ? 'fillLate' : 'unavailableLate'}
          disabled={!view.canOpen}
          onClick={() => controller()?.openDetailApp(view.slug)}
          onPointerDown={view.canOpen ? warm : undefined}
          onMouseEnter={view.canOpen ? warm : undefined}
        >
          {view.canOpen ? <ArrowRightShortIcon className="w-4 h-4" aria-hidden="true" /> : null}
          {view.openLabel}
        </Button>
        <button
          type="button"
          id="browse-detail-fav"
          // Filled neutral in both states, beside the filled accent "Open".
          // It was an emerald or violet OUTLINE, which is the shape the
          // language does not draw — and the emerald read as a success cue on
          // a control whose whole job is to be pressed again to undo.
          //
          // WHITE, not zinc-100: this pill sits on the PAGE GROUND, and in
          // this palette zinc-100 IS that ground (#eaeaea) — the fill was
          // invisible. zinc-100 is the neutral fill for a control on a white
          // card (the profile buttons, the browse rows' Add); on the ground
          // itself the neutral surface is white, the same as the header's
          // hamburger disc and an unselected chip.
          className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors bg-white hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-900 dark:text-zinc-100"
          data-added={String(view.isAdded)}
          onClick={() => controller()?.toggleDetailAdded(view.app)}
        >{view.favLabel}</button>
      </div>

      {view.actions.length ? (
        <div className="mt-5 rounded-sm border border-[var(--frame-line)] bg-white dark:bg-zinc-900 overflow-hidden">
          {view.actions.map((a) => (
            <button
              key={a.index}
              type="button"
              className={`browse-detail-action relative w-full flex items-center justify-between gap-2 px-3 py-3 text-sm text-left transition-colors hover:bg-zinc-500/5 ${ROW_RULE} ${
                a.danger ? 'text-red-700 dark:text-red-400' : 'text-zinc-700 dark:text-zinc-200'
              }`}
              data-action-index={a.index}
              title={a.title || undefined}
              disabled={a.disabled}
              onClick={(e) => controller()?._runDetailAction(a.index, e.currentTarget)}
            >
              <span>{a.label}</span>
              <ChevronRightIcon className="w-4 h-4 shrink-0 opacity-40" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}

      <Contributors view={view.contributors} />
    </>
  );
}

export function BrowseDetail({ detail }: { detail: DetailView | null }): ReactNode {
  if (!detail) return null;
  if (detail.state === 'loading') {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading&hellip;</p>;
  }
  if (detail.state === 'missing') return <Missing />;
  return <Ready view={detail} />;
}
