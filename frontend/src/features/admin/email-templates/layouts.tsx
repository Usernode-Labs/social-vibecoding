'use strict';

import { useEffect, useRef, useState } from 'react';

import { AdminUI } from '../admin-console.js';
import { PreviewPane } from './preview';
import {
  confirmDiscard, editedLabel, errorsFor, FailureNotice, FieldErrors, isDirty, isLive, keepDraft,
  languagesLabel, liveTemplate, PlaceholderList, readFailure, request, useUnloadGuard,
  type Failure, type KeptDraft, type LayoutRow, type TemplatesPayload,
} from './shared';

// Layouts: the header and footer an email is wrapped in. Each email picks one
// and writes only its middle ({{content}}). A layout is a family of versions;
// its family id is what an email points at, what a delete takes and what a
// replacement names. A version id is what Restore takes.

/** The live emails wearing each layout family. */
export function wearersByFamily(payload: TemplatesPayload): Map<number, string[]> {
  const by = new Map<number, string[]>();
  for (const a of payload.actions) {
    const live = liveTemplate(payload, a.action);
    if (!live || live.layout_family_id == null) continue;
    if (!by.has(live.layout_family_id)) by.set(live.layout_family_id, []);
    by.get(live.layout_family_id)!.push(a.label);
  }
  return by;
}

function usedByLabel(labels: string[]): string {
  if (!labels.length) return 'Not used';
  return labels.length === 1 ? 'Used by 1 email' : `Used by ${labels.length} emails`;
}

export function LayoutList({
  payload, canWrite, showArchived, now, onToggleArchived, onNew, onEdit, onDelete, onRestore,
}: {
  payload: TemplatesPayload;
  canWrite: boolean;
  showArchived: boolean;
  now: number;
  onToggleArchived: () => void;
  onNew: () => void;
  onEdit: (familyId: number) => void;
  onDelete: (live: LayoutRow) => void;
  onRestore: (row: LayoutRow) => void;
}) {
  const live = payload.layouts.filter(isLive).sort((a, b) => a.name.localeCompare(b.name));
  const wearers = wearersByFamily(payload);
  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className={AdminUI.muted}>The header and footer each email is wrapped in.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" id="email-layouts-archived" className={AdminUI.btn.outlineSm}
            aria-pressed={showArchived} onClick={onToggleArchived}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          {canWrite ? (
            <button type="button" id="email-layouts-new" className={AdminUI.btn.primarySm} onClick={onNew}>New layout</button>
          ) : null}
        </div>
      </div>
      {live.length ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {live.map((l) => {
            const using = wearers.get(l.family_id) || [];
            // A deleted layout's versions are gone with it, so only a live
            // family's earlier versions can come back.
            const earlier = showArchived
              ? payload.layouts.filter((v) => v.family_id === l.family_id && v.id !== l.id && !v.deleted_at)
                .sort((a, b) => b.version - a.version)
              : [];
            return (
              <li key={l.family_id} data-email-layout={l.family_id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-words">{l.name}</span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">{`v${l.version}`}</span>
                      <span className={AdminUI.badge.success}>Live</span>
                    </div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5" title={using.join(', ')}>
                      {`${usedByLabel(using)} · ${languagesLabel(l.locales, false)} · ${editedLabel(l, now)}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={AdminUI.btn.outlineSm} onClick={() => onEdit(l.family_id)}>
                      {canWrite ? 'Edit' : 'View'}
                    </button>
                    {canWrite ? (
                      <button type="button" className={AdminUI.btn.outlineSm} onClick={() => onDelete(l)}>Delete</button>
                    ) : null}
                  </div>
                </div>
                {showArchived ? (
                  earlier.length ? (
                    <ul className="mt-2 space-y-1">
                      {earlier.map((v) => (
                        <li key={v.id} data-email-layout-version={v.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 px-3 py-1.5 text-xs">
                          <span className="min-w-0 break-words">{`${v.name} v${v.version} · ${editedLabel(v, now)}`}</span>
                          {canWrite ? (
                            <button type="button" className={AdminUI.btn.outlineSm} onClick={() => onRestore(v)}>Restore</button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">No earlier versions.</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : <p className={AdminUI.muted}>No layouts yet. Emails without one are complete HTML of their own.</p>}
    </div>
  );
}

interface LayoutDraft { name: string; html: string; text: string }

// The fields this form draws; an error for any other is listed above it.
const SHOWN = ['name', 'html', 'text'];

const STARTER: LayoutDraft = {
  name: '',
  html: '<!doctype html>\n<html>\n<body>\n<div style="display:none">{{preheader}}</div>\n{{content}}\n<p style="font-size:12px;color:#666">{{why}}</p>\n</body>\n</html>',
  text: '{{content}}\n\n{{why}}',
};

/**
 * Edits one layout family (or makes a new one when `familyId` is null). The
 * preview shows a chosen email's live version inside the unsaved layout.
 */
export function LayoutEditor({ payload, familyId, canWrite, onDone, onSaved, onReload, restore = null }: {
  payload: TemplatesPayload;
  familyId: number | null;
  canWrite: boolean;
  onDone: () => void;
  onSaved: (row: LayoutRow) => void;
  onReload: () => void;
  // A draft kept when the console left mid-edit, restored by Continue editing.
  restore?: (KeptDraft & { kind: 'layout' }) | null;
}) {
  const live = familyId == null ? null : payload.layouts.find((l) => l.family_id === familyId && isLive(l)) || null;
  // What the editor opened with: unsaved edits are measured against it.
  const [opened] = useState<LayoutDraft>(() => {
    if (restore) return restore.opened;
    return live ? { name: live.name, html: live.html, text: live.text } : STARTER;
  });
  // The live version this editor opened on, which Save expects: fixed, so
  // someone else's save in between is a conflict, restored drafts included.
  const [openedLiveId] = useState<number | null>(() => (restore ? restore.openedLiveId : live ? live.id : null));
  const [draft, setDraft] = useState<LayoutDraft>(() => (restore ? restore.draft : opened));
  const dirty = isDirty(draft, opened);
  useUnloadGuard(dirty);
  // As in the template editor: set when left on purpose, so unmounting with
  // unsaved edits otherwise keeps them for the section to offer back.
  const settled = useRef(false);
  const latest = useRef({ draft, dirty });
  latest.current = { draft, dirty };
  useEffect(() => () => {
    if (settled.current || !latest.current.dirty) return;
    keepDraft({ kind: 'layout', familyId, label: latest.current.draft.name || 'a new layout', draft: latest.current.draft, opened, openedLiveId });
  }, [familyId, opened, openedLiveId]);
  const leave = async () => {
    if (dirty && !(await confirmDiscard('Your changes to this layout are not saved. Leave and lose them?'))) return;
    settled.current = true;
    onDone();
  };
  const reload = async () => {
    if (dirty && !(await confirmDiscard('Reload discards your changes and shows the version saved now.', 'Reload'))) return;
    settled.current = true;
    onReload();
  };
  const [tab, setTab] = useState<'html' | 'text'>('html');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saving, setSaving] = useState(false);
  // Which email the preview wraps: one that wears this layout, else the sign-in code.
  const wearer = payload.actions.find((a) => {
    const t = liveTemplate(payload, a.action);
    return t && familyId != null && t.layout_family_id === familyId;
  });
  const [shown, setShown] = useState<string>(wearer ? wearer.action : 'otp');
  const readOnly = !canWrite;
  const err = (field: string) => errorsFor(failure, field);

  const save = async () => {
    if (saving || !canWrite) return;
    setSaving(true);
    setFailure(null);
    const res = await request('/api/admin/email-layouts', 'POST', {
      familyId, name: draft.name, html: draft.html, text: draft.text, expectedLiveId: openedLiveId,
    });
    setSaving(false);
    if (res.ok && res.data && res.data.layout) { settled.current = true; onSaved(res.data.layout); return; }
    const refused = readFailure(res.status, res.data);
    setFailure(refused);
    if (refused.kind === 'fields') {
      const first = refused.errors.find((x) => x.field === 'html' || x.field === 'text');
      if (first) setTab(first.field as 'html' | 'text');
    }
  };

  const set = (field: keyof LayoutDraft) => (ev: { target: { value: string } }) => {
    const value = ev.target.value;
    setDraft((d) => ({ ...d, [field]: value }));
  };
  const described = (id: string, errors: string[]) => (errors.length
    ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {});
  const shownInfo = payload.actions.find((a) => a.action === shown);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={AdminUI.btn.ghost} onClick={leave}>‹ All layouts</button>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={AdminUI.btn.outline} disabled={saving} onClick={leave}>Cancel</button>
            <button type="button" id="email-layout-save" className={AdminUI.btn.primary} disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : null}
      </div>
      {canWrite ? null : (
        <p className="rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          Editing needs full admin access. You can read this layout and preview it.
        </p>
      )}
      <FailureNotice failure={failure} shownFields={SHOWN} onReload={reload} onRetry={save} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={`${AdminUI.card} p-4 space-y-3 min-w-0`}>
          <div>
            <label htmlFor="email-layout-name" className={AdminUI.label}>Name</label>
            <input id="email-layout-name" className={`${AdminUI.input} mt-1`} value={draft.name} readOnly={readOnly}
              onChange={set('name')} {...described('email-layout-name', err('name'))} />
            <FieldErrors id="email-layout-name-error" messages={err('name')} />
          </div>
          <div>
            <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800" role="tablist" aria-label="Layout body">
              {(['html', 'text'] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k}
                  className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px ${tab === k
                    ? 'border-violet-600 text-zinc-900 dark:text-zinc-100'
                    : 'border-transparent text-zinc-500 dark:text-zinc-400'}`}
                  onClick={() => setTab(k)}>{k === 'html' ? 'HTML' : 'Text'}</button>
              ))}
            </div>
            <div className="mt-2">
              <label htmlFor={`email-layout-${tab}`} className={AdminUI.label}>{tab === 'html' ? 'HTML' : 'Text version'}</label>
              <textarea id={`email-layout-${tab}`} className={`${AdminUI.textarea} font-mono text-xs mt-1`} rows={18}
                spellCheck={false} value={draft[tab]} readOnly={readOnly} onChange={set(tab)}
                {...described(`email-layout-${tab}`, err(tab))} />
              <FieldErrors id={`email-layout-${tab}-error`} messages={err(tab)} />
            </div>
          </div>
        </div>
        <div className="space-y-4 min-w-0">
          <div className={`${AdminUI.card} p-4`}>
            <h3 className="text-sm font-semibold mb-2">Preview</h3>
            <PreviewPane base="/api/admin/email-layouts"
              body={{ action: shown, fields: { name: draft.name, html: draft.html, text: draft.text } }}
              mode={tab} languages={payload.languages} englishOnly={!!(shownInfo && shownInfo.englishOnly)}
              canWrite={canWrite} onFieldFailure={setFailure}
              extra={(
                <label className="block text-xs">
                  <span className="text-zinc-500 dark:text-zinc-400">Shown with</span>
                  <select className={`${AdminUI.select} mt-1`} value={shown} onChange={(ev) => setShown(ev.target.value)}>
                    {payload.actions.filter((a) => liveTemplate(payload, a.action))
                      .map((a) => <option key={a.action} value={a.action}>{a.label}</option>)}
                  </select>
                </label>
              )} />
          </div>
          <div className={`${AdminUI.card} p-4`}>
            <PlaceholderList placeholders={payload.layoutPlaceholders} required={['content']} />
          </div>
        </div>
      </div>
    </div>
  );
}
