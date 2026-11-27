'use strict';

import { AdminUI } from '../admin-console.js';
import {
  draftTemplate, editedLabel, isLive, liveTemplate, type TemplateRow, type TemplatesPayload,
} from './shared';
import { languagesColumn } from './translations';

// The list everyone lands on: one row per action (every email Homeroom
// sends), with the version that is live, how many languages it is
// translated into and when it was last edited. "Show archived" opens each
// action's earlier versions under its row, with Restore, so a bad edit can be
// undone from here. A view-only admin sees the same list with View in place
// of Edit, and no write buttons.
//
// A draft (saved, never sent) shows beside the live version, or alone for an
// email nothing sends yet: the drip's, whose row also says what will send it.
// An email with both offers each to open, so the live version stays readable
// and editable while a draft waits, and its draft can be discarded. A drip's
// draft is all there is of it, so it is not offered to discard.

function ArchivedRows({ rows, canWrite, now, onRestore, onDeleteArchived }: {
  rows: TemplateRow[]; canWrite: boolean; now: number;
  onRestore: (row: TemplateRow) => void; onDeleteArchived: (row: TemplateRow) => void;
}) {
  if (!rows.length) {
    return (
      <tr className="bg-zinc-50/60 dark:bg-zinc-800/30">
        <td className="px-3 sm:px-6 py-2 text-xs text-zinc-500 dark:text-zinc-400" colSpan={5}>No earlier versions.</td>
      </tr>
    );
  }
  return (
    <>
      {rows.map((row) => (
        <tr key={row.id} data-email-version={row.id} className="bg-zinc-50/60 dark:bg-zinc-800/30 text-xs">
          <td className="px-3 sm:px-6 py-2 text-zinc-500 dark:text-zinc-400">Earlier version</td>
          <td className="px-3 sm:px-6 py-2">
            <span className="break-words">{row.name}</span>
            <span className="text-zinc-500 dark:text-zinc-400">{` v${row.version}`}</span>
          </td>
          <td className="px-3 sm:px-6 py-2">
            {row.deleted_at
              ? <span className={AdminUI.badge.destructive}>Deleted</span>
              : <span className={AdminUI.badge.default}>Archived</span>}
          </td>
          <td className="hidden md:table-cell px-3 sm:px-6 py-2 text-zinc-500 dark:text-zinc-400">{editedLabel(row, now)}</td>
          <td className="px-3 sm:px-6 py-2">
            {canWrite ? (
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" className={AdminUI.btn.outlineSm} onClick={() => onRestore(row)}>Restore</button>
                {row.deleted_at ? null : (
                  <button type="button" className={AdminUI.btn.outlineSm} onClick={() => onDeleteArchived(row)}>Delete</button>
                )}
              </div>
            ) : null}
          </td>
        </tr>
      ))}
    </>
  );
}

export function TemplateList({
  payload, canWrite, showArchived, now, onToggleArchived, onNew, onEdit, onDelete, onRestore, onDeleteArchived, onDiscardDraft,
}: {
  payload: TemplatesPayload;
  canWrite: boolean;
  showArchived: boolean;
  now: number;
  onToggleArchived: () => void;
  onNew: () => void;
  // `version`: which saved version to open when the email has both.
  onEdit: (action: string, version?: 'draft' | 'live') => void;
  onDelete: (row: TemplateRow) => void;
  onRestore: (row: TemplateRow) => void;
  onDeleteArchived: (row: TemplateRow) => void;
  onDiscardDraft?: (row: TemplateRow) => void;
}) {
  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className={AdminUI.muted}>Every email Homeroom sends, and the version of each that goes out now.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" id="email-templates-archived" className={AdminUI.btn.outlineSm}
            aria-pressed={showArchived} onClick={onToggleArchived}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          {canWrite ? (
            <button type="button" id="email-templates-new" className={AdminUI.btn.primarySm} onClick={onNew}>New template</button>
          ) : null}
        </div>
      </div>
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table} id="email-templates-table">
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>Action</th>
              <th className={AdminUI.th}>Template</th>
              <th className={`${AdminUI.th} hidden md:table-cell`}>Languages</th>
              <th className={`${AdminUI.th} hidden md:table-cell`}>Edited</th>
              <th className={AdminUI.th}><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {payload.actions.map((a) => {
              const live = liveTemplate(payload, a.action);
              const draft = draftTemplate(payload, a.action);
              const earlier = showArchived
                ? payload.templates
                  .filter((t) => t.action === a.action && !isLive(t) && t.status !== 'draft')
                  .sort((x, y) => y.version - x.version)
                : [];
              return [
                <tr key={a.action} data-email-action={a.action} className={AdminUI.trHover}>
                  <td className="px-3 sm:px-6 py-3 align-middle">
                    <span className="font-medium">{a.label}</span>
                    {a.drip ? (
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" data-email-trigger="">
                        {`When: ${a.drip.trigger}`}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 sm:px-6 py-3 align-middle">
                    {live ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-words">{live.name}</span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">{`v${live.version}`}</span>
                        <span className={AdminUI.badge.success}>Live</span>
                        {draft ? <span className={AdminUI.badge.warn} data-email-draft={draft.id}>{`Draft v${draft.version} waiting`}</span> : null}
                        {/* The two columns a phone has no room for, as one line. */}
                        <span className="md:hidden basis-full text-xs text-zinc-500 dark:text-zinc-400">
                          {`Languages: ${languagesColumn(payload, a.englishOnly, live)} · ${editedLabel(live, now)}`}
                        </span>
                      </div>
                    ) : draft ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-words">{draft.name}</span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">{`v${draft.version}`}</span>
                        <span className={AdminUI.badge.warn} data-email-draft={draft.id}>{a.drip ? 'Draft · Off' : 'Draft'}</span>
                        <span className="md:hidden basis-full text-xs text-zinc-500 dark:text-zinc-400">
                          {`Languages: ${languagesColumn(payload, a.englishOnly, draft)} · ${editedLabel(draft, now)}`}
                        </span>
                      </div>
                    ) : <span className={AdminUI.badge.warn}>{a.drip ? 'Off' : 'No live version'}</span>}
                  </td>
                  <td className="hidden md:table-cell px-3 sm:px-6 py-3 align-middle text-zinc-600 dark:text-zinc-300 max-w-[16rem]">
                    {live || draft ? languagesColumn(payload, a.englishOnly, (live || draft) as TemplateRow) : ''}
                  </td>
                  <td className="hidden md:table-cell px-3 sm:px-6 py-3 align-middle text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                    {live || draft ? editedLabel((live || draft) as TemplateRow, now) : ''}
                  </td>
                  <td className="px-3 sm:px-6 py-3 align-middle">
                    <div className="flex flex-wrap justify-end gap-2">
                      {live && draft ? (
                        <>
                          <button type="button" className={AdminUI.btn.outlineSm} data-email-open="draft" onClick={() => onEdit(a.action, 'draft')}>
                            {canWrite ? 'Edit draft' : 'View draft'}
                          </button>
                          <button type="button" className={AdminUI.btn.outlineSm} data-email-open="live" onClick={() => onEdit(a.action, 'live')}>
                            {canWrite ? 'Edit live' : 'View live'}
                          </button>
                        </>
                      ) : (
                        <button type="button" className={AdminUI.btn.outlineSm} onClick={() => onEdit(a.action)}>
                          {canWrite ? 'Edit' : 'View'}
                        </button>
                      )}
                      {canWrite && draft && !a.drip && onDiscardDraft ? (
                        <button type="button" className={AdminUI.btn.outlineSm} data-email-discard={draft.id} onClick={() => onDiscardDraft(draft)}>
                          Discard draft
                        </button>
                      ) : null}
                      {canWrite && live ? (
                        <button type="button" className={AdminUI.btn.outlineSm} onClick={() => onDelete(live)}>Delete</button>
                      ) : null}
                    </div>
                  </td>
                </tr>,
                showArchived ? (
                  <ArchivedRows key={`${a.action}-archived`} rows={earlier} canWrite={canWrite} now={now}
                    onRestore={onRestore} onDeleteArchived={onDeleteArchived} />
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
