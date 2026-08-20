/**
 * The cog drawer's three stacked sections (#1191 slice 6, conversion 4).
 *
 * The only writer of the DOM below #work-drawer-list. ./work-drawer.js decides
 * what is in flight — which unread session notifications are pinned, which of
 * the viewer's sessions survive the promoted-duplicate filter, what tally and
 * lifecycle each proposal carries — and this file renders those descriptors,
 * class string for class string.
 *
 * ── One row, one renderer ──────────────────────────────────────────────
 *
 * The "Needs attention" rows are `NotificationRow` from
 * ../notifications/notifications-list.tsx, the same component the bell paints
 * its own list with. Until this conversion they were an HTML-string twin of it
 * (`rowHtml` in notifications.js, reached through `Notifications._renderRow`),
 * kept honest only by both being built from one descriptor. Now there is one
 * implementation, so the two drawers cannot drift at all.
 *
 * ── What still crosses as markup ───────────────────────────────────────
 *
 * `lifeChipHtml` — MergeStatus.badgeHtml's output. Same call as the browse
 * detail's version pill: a pure string builder in a still-legacy classic
 * script, which escapes its own input and reads no DOM. Rendering it keeps ONE
 * owner of the merge-lifecycle badge across the four surfaces that draw it.
 *
 * ── Initial render ─────────────────────────────────────────────────────
 *
 * `sections === null` renders nothing, and both the empty hint and the header's
 * "Mark all read" render `hidden` — exactly the markup the hand-written shell
 * shipped, which the SSG pass in frontend/scripts/build-shell.mjs has to
 * reproduce or hydration `console.error`s.
 */

import { Fragment, type ReactNode } from 'react';

import { NotificationRow, type NotificationRowView } from '../notifications/notifications-list';
import { useStoreState } from '../../lib/use-store-state';
import { workDrawerStore } from './work-drawer-store.js';

type PillView = { yes: number; majority: number; advisory: number; cls: string };

type SessionRowView = {
  id: number;
  href: string;
  appName: string;
  title: string;
  time: string | null;
  status: { label: string; cls: string } | null;
  busy: boolean;
};

type ProposalRowView = {
  kind: 'pr' | 'gov';
  id: number;
  href: string;
  appName: string;
  title: string;
  fallback?: boolean;
  lifeChipHtml?: string | null;
  pill: PillView;
  busy?: boolean;
};

type Section =
  | { key: 'pending'; label: string; rows: NotificationRowView[] }
  | { key: 'sessions'; label: string; rows: SessionRowView[] }
  | { key: 'proposals'; label: string; rows: ProposalRowView[] };

/** The row anchor's class string, shared by all three proposal/session rows. */
const LINK_CLASS = 'flex items-center gap-2 px-3 py-2.5 border-b border-zinc-200 '
  + 'dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors';

const APP_CLASS = 'text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[30%] truncate';
const TITLE_CLASS = 'text-sm text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 truncate';

/**
 * #1329: the session/proposal rows are plain hash links, and on touch the
 * drawer rides inside a modal kit bottom sheet that would otherwise stay
 * presented over the screen the link opens. The controller's dismiss is
 * sheet-gated, so the desktop dropdown's keep-open behaviour is untouched —
 * and default is deliberately NOT prevented: the hash navigation stays the
 * anchor's job. Reached off `window` for the same reason
 * ../notifications/notifications-list.tsx reads its controller that way:
 * ./work-drawer.js must stay reachable as a classic-script-shaped global.
 */
function dismissSheetForNav(): void {
  const wd = typeof window !== 'undefined' ? (window as any).WorkDrawer : null;
  wd?._dismissSheetForNav?.();
}

function SectionHeader({ label }: { label: string }): ReactNode {
  return (
    <div className="px-3 py-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/40">{label}</div>
  );
}

/** The "working…" tag: the dev chat's spinner arc, then the word. */
function BusyTag(): ReactNode {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-500 shrink-0">
      <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>
      working…
    </span>
  );
}

function SessionRow({ row }: { row: SessionRowView }): ReactNode {
  return (
    <a href={row.href} className={LINK_CLASS} onClick={dismissSheetForNav}>
      <span className={APP_CLASS}>{row.appName}</span>
      <span className={TITLE_CLASS}>{row.title}</span>
      {row.time ? (
        <span className="text-[0.7rem] text-zinc-400 dark:text-zinc-500 shrink-0">{row.time}</span>
      ) : null}
      {row.status ? (
        <span className={`text-[0.65rem] font-medium ${row.status.cls} uppercase shrink-0`}>{row.status.label}</span>
      ) : null}
      {row.busy ? <BusyTag /> : null}
    </a>
  );
}

/**
 * The tally pill, plus the advisory chip when the app runs invited approvers.
 *
 * The string version put a literal space between the two; both are children of
 * the row's `flex … gap-2`, where a whitespace-only text node is not rendered
 * at all, so dropping it changes nothing on screen — and a `{' '}` between two
 * elements is what tests/shell-build.test.js refuses (React #418).
 */
function Pill({ pill }: { pill: PillView }): ReactNode {
  return (
    <>
      <span className={`inline-flex items-center text-[0.7rem] font-mono font-medium px-1.5 py-0.5 rounded ${pill.cls}`}>
        {`${pill.yes} / ${pill.majority}`}
      </span>
      {pill.advisory > 0 ? (
        <span
          className="inline-flex items-center text-[0.65rem] font-medium px-1 py-0.5 rounded bg-zinc-500/10 text-zinc-500 shrink-0"
          title={`${pill.advisory} advisory Yes vote${pill.advisory === 1 ? '' : 's'} from non-approvers — they don't count toward merging`}
        >{`+${pill.advisory} advisory`}</span>
      ) : null}
    </>
  );
}

function ProposalRow({ row }: { row: ProposalRowView }): ReactNode {
  return (
    <a href={row.href} className={LINK_CLASS} onClick={dismissSheetForNav}>
      <span className={APP_CLASS}>{row.appName}</span>
      <span className={TITLE_CLASS}>{row.title}</span>
      {row.fallback ? (
        <span
          className="inline-flex items-center text-[0.65rem] font-medium px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500 shrink-0"
          title="AI naming was unavailable when this proposal was created, so it shows a placeholder title. A descriptive title will be generated automatically."
        >Auto-title pending</span>
      ) : null}
      {row.lifeChipHtml ? (
        <span className="shrink-0" dangerouslySetInnerHTML={{ __html: row.lifeChipHtml }} />
      ) : null}
      <Pill pill={row.pill} />
      {row.busy ? <BusyTag /> : null}
      {row.kind === 'gov' ? (
        <span className="text-[0.65rem] font-medium text-violet-400 uppercase shrink-0">In vote</span>
      ) : null}
    </a>
  );
}

function SectionBody({ section }: { section: Section }): ReactNode {
  if (section.key === 'pending') {
    // touch={false}: the HTML flavour this replaced carried no swipe tray, and
    // these rows sit inside the kit's bottom sheet on touch.
    return <>{section.rows.map((row) => <NotificationRow key={row.id} view={row} touch={false} />)}</>;
  }
  if (section.key === 'sessions') {
    return <>{section.rows.map((row) => <SessionRow key={row.id} row={row} />)}</>;
  }
  return <>{section.rows.map((row) => <ProposalRow key={`${row.kind}${row.id}`} row={row} />)}</>;
}

export function WorkDrawerBody(): ReactNode {
  const state = useStoreState(workDrawerStore) as {
    sections: Section[] | null;
    empty: boolean;
    markAll: boolean;
  };
  const sections = state.sections || [];

  return (
    <>
      {/*
          Fragments, not wrapper divs: the string version concatenated each
          header and its rows straight into the list, so they are siblings and
          have to stay siblings — dapp.json selects rows as direct descendants
          of #work-drawer-list.
      */}
      <div id="work-drawer-list" className="flex-1 overflow-y-auto">
        {sections.map((section) => (
          <Fragment key={section.key}>
            <SectionHeader label={section.label} />
            <SectionBody section={section} />
          </Fragment>
        ))}
      </div>
      <div
        id="work-drawer-empty"
        className={state.empty
          ? 'px-4 py-6 text-sm text-zinc-500 text-center'
          : 'hidden px-4 py-6 text-sm text-zinc-500 text-center'}
      >
        Nothing in flight — start a dev session from any app's Dev tab.
      </div>
    </>
  );
}

/** The header button, whose `hidden` is the same piece of state. */
export function WorkDrawerMarkAll(): ReactNode {
  const state = useStoreState(workDrawerStore) as { markAll: boolean };
  const cls = 'text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200';
  return (
    <button id="work-drawer-mark-all" className={state.markAll ? cls : `hidden ${cls}`}>
      Mark all read
    </button>
  );
}
