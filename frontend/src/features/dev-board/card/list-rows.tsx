/**
 * The rows a card column is made of, shared by the feed's pinned-sessions
 * block and the kanban In-progress column: cards, the group dividers, the
 * session-filter note, and the archived-sessions toggle.
 *
 * ── The archived toggle is component state now ─────────────────────────
 *
 * `_archivedToggleHtml` shipped the list `hidden` and `_toggleArchivedList`
 * flipped classes from a delegated handler; every innerHTML repaint
 * collapsed it again. Under React the node survives repaints, so open state
 * is a `useState` here and the delegated branch is retired. The one
 * behavioural difference — a background WS repaint no longer snaps an open
 * list shut — is the reconciliation doing what the innerHTML could not.
 * The Unarchive button keeps its `data-unarchive-chip` hook: the #dev-body
 * delegated handler still owns that click (it disables the button and calls
 * `_unarchiveSession`), so the card list needs no closure for it.
 */

import { useState, type ReactNode } from 'react';

import { ChevronRightIcon } from '@/components/ui/icons';

import { CardIcon, DevCard } from './dev-card';
import type { ArchivedRow, ListRow } from './model';

function ArchivedBlock({ rows }: { rows: ArchivedRow[] }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-1" data-archived-block="">
      <button
        type="button"
        data-archived-toggle=""
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 inline-flex items-center gap-1"
      >
        <ChevronRightIcon
          data-archived-caret=""
          className="w-3 h-3 transition-transform"
          style={open ? { transform: 'rotate(90deg)' } : undefined}
        />
        {`Show archived (${rows.length})`}
      </button>
      <div data-archived-list="" className={open ? 'space-y-2 pt-2' : 'hidden space-y-2 pt-2'}>
        {rows.map((r) => (
          <div key={r.id} className={r.cls}>
            <CardIcon spec={r.icon} />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 break-words">{r.label}</span>
              <span className="block text-xs text-zinc-500 dark:text-zinc-500 truncate">Archived</span>
            </span>
            <button type="button" className="gc-vote-btn" data-unarchive-chip={r.id} title="Restore this session (reopens its PR)">
              Unarchive
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One row. The kanban's drag shell wraps this from the outside. */
export function ListRowView({ row }: { row: ListRow }): ReactNode {
  switch (row.t) {
    case 'card':
      return <DevCard model={row.card} />;
    case 'divider':
      return (
        <div className="dev-col-divider">
          <span className="dev-col-divider-label" title={row.d.title}>{row.d.label}</span>
        </div>
      );
    case 'note':
      return <div className="text-xs text-zinc-500 dark:text-zinc-500 italic px-0.5">{row.text}</div>;
    case 'archived':
      return <ArchivedBlock rows={row.rows} />;
    default:
      return null;
  }
}
