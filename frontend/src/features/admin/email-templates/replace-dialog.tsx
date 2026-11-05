'use strict';

import { useEffect, useRef, useState } from 'react';

import { AdminUI } from '../admin-console.js';
import { FailureNotice, isLive, type Failure, type TemplateRow, type TemplatesPayload } from './shared';

// The chooser a delete opens. Deleting the live version of an email puts an
// earlier one live in its place, and deleting a layout moves the emails that
// wear it to another one, so the admin picks what takes over before anything
// is deleted (the store refuses a delete without it: replacement_required).
// A choice that the server would refuse is shown, greyed, with the reason.

export interface ReplaceChoice { id: number; title: string; detail?: string; disabledReason?: string }

/** Earlier versions of this email that can go live instead of `live`, newest first. */
export function templateReplacements(payload: TemplatesPayload, live: TemplateRow): ReplaceChoice[] {
  const liveFamilies = new Set(payload.layouts.filter(isLive).map((l) => l.family_id));
  return payload.templates
    .filter((t) => t.action === live.action && t.id !== live.id && t.status === 'archived' && !t.deleted_at)
    .sort((a, b) => b.version - a.version)
    .map((t) => ({
      id: t.id,
      title: `${t.name} (v${t.version})`,
      detail: t.subject,
      // The store refuses a replacement whose layout was deleted: it would
      // go live pointing at nothing.
      ...(t.layout_family_id != null && !liveFamilies.has(t.layout_family_id)
        ? { disabledReason: 'Its layout was deleted, so it cannot go live.' } : {}),
    }));
}

/** Other live layouts the emails wearing `familyId` can move to, by family. */
export function layoutReplacements(payload: TemplatesPayload, familyId: number): ReplaceChoice[] {
  return payload.layouts
    .filter((l) => isLive(l) && l.family_id !== familyId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((l) => ({ id: l.family_id, title: l.name, detail: `v${l.version}` }));
}

export function ReplaceDialog({
  title, intro, choices, required, emptyText, confirmLabel, busy, failure, onConfirm, onCancel, onReload,
}: {
  title: string;
  intro: string;
  choices: ReplaceChoice[];
  // False when nothing needs to take over (a layout no email wears), which
  // makes this a plain "are you sure".
  required: boolean;
  emptyText?: string;
  confirmLabel: string;
  busy: boolean;
  failure: Failure | null;
  onConfirm: (replacementId: number | null) => void;
  onCancel: () => void;
  // Offered when the server says the list was stale (a conflict).
  onReload?: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  // Read by the key handler, which is bound once.
  const state = useRef({ busy, onCancel });
  state.current = { busy, onCancel };
  useEffect(() => {
    // Focus lands on the first choice that can be taken, else on the panel,
    // so a keyboard user starts inside the dialog. Escape closes it unless a
    // delete is already on its way.
    const first = panel.current?.querySelector<HTMLInputElement>('input[type="radio"]:not(:disabled)');
    (first || panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || state.current.busy) return;
      e.preventDefault();
      state.current.onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const usable = choices.filter((c) => !c.disabledReason);
  const ready = !busy && (!required || (picked !== null && usable.some((c) => c.id === picked)));
  return (
    <div className={AdminUI.dialogOverlay} role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div ref={panel} tabIndex={-1} className={`${AdminUI.dialogPanel} outline-none`} role="dialog" aria-modal="true"
        aria-labelledby="email-replace-title" id="email-replace-dialog">
        <h3 id="email-replace-title" className={AdminUI.cardTitle}>{title}</h3>
        <p className={`${AdminUI.muted} mt-2`}>{intro}</p>
        {required ? (
          choices.length ? (
            <fieldset className="mt-3 space-y-2 max-h-72 overflow-y-auto">
              <legend className="sr-only">Replacement</legend>
              {choices.map((c) => (
                <label key={c.id}
                  className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-800/60${c.disabledReason ? ' opacity-60' : ' cursor-pointer'}`}>
                  <input type="radio" name="email-replacement" value={c.id} className="mt-1"
                    checked={picked === c.id} disabled={!!c.disabledReason || busy}
                    onChange={() => setPicked(c.id)} />
                  <span className="min-w-0">
                    <span className="block font-medium break-words">{c.title}</span>
                    {c.detail ? <span className="block text-xs text-zinc-500 dark:text-zinc-400 break-words">{c.detail}</span> : null}
                    {c.disabledReason ? <span className="block text-xs text-amber-800 dark:text-amber-300">{c.disabledReason}</span> : null}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">{emptyText}</p>
        ) : null}
        {failure ? (
          <div className="mt-3">
            <FailureNotice failure={failure} onReload={onReload}
              onRetry={() => onConfirm(required ? picked : null)} />
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 mt-4">
          <button type="button" className={AdminUI.btn.outline} disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className={AdminUI.btn.destructive} disabled={!ready}
            onClick={() => onConfirm(required ? picked : null)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
