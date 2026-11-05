'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { TemplateList } from './email-templates/list';
import { draftFrom, ENGLISH_UNTIL_TRANSLATED, expectedLiveFor, TemplateEditor, TemplateForm } from './email-templates/editor';
import { LayoutEditor, LayoutList } from './email-templates/layouts';
import { layoutReplacements, ReplaceDialog, templateReplacements } from './email-templates/replace-dialog';
import { PreviewPane, PreviewView } from './email-templates/preview';
import {
  FailureNotice, isDirty, keepDraft, unusableOf, keptDraft, KeptDraftNotice, liveTemplate, PlaceholderList, readFailure, request, isLive,
  type Failure, type KeptDraft, type LayoutRow, type TemplateRow, type TemplatesPayload,
} from './email-templates/shared';
import {
  SavedBanner, TranslateProgressView, LanguageForm, translationSummary, languagesColumn, jobSummary, stateWords,
  UnusableLanguageNotice, LanguageSwitch, TranslateControlsView, translateBlocked, unusableReason, languageSaveRequest,
  retranslateBody, languageMove, keptLanguage, TranslateControls, type UnusableItem,
} from './email-templates/translations';

// Admin > Email templates (#admin/email-templates): every email Homeroom
// sends, written from templates an admin can edit here, and the layouts
// they are wrapped in. The routes are src/routes/admin-email-templates.js.
//
// One read (GET /api/admin/email-templates) answers every version of every
// template and layout, so the list, the editors and the replacement chooser
// all work from the same snapshot, and every write reloads it.
//
// PERMISSIONS: any admin can read and preview. Saving, deleting, restoring
// and the test send need a full admin; a view-only admin sees the same
// screens with those controls left out. The server enforces that on its own
// (requireAdminWrite); hiding them here only saves a refused request.

// `restore` is set only by Continue editing: opening the same editor by hand
// starts from what is live and leaves the kept draft, and its notice, alone.
type View =
  | { kind: 'list' }
  | { kind: 'template'; action: string; isNew: boolean; restore?: KeptDraft & { kind: 'template' } }
  | { kind: 'layout'; familyId: number | null; restore?: KeptDraft & { kind: 'layout' } };

type Dialog =
  | { kind: 'template'; live: TemplateRow }
  | { kind: 'layout'; live: LayoutRow };

type Banner =
  | { kind: 'ok'; text: string; unusable?: UnusableItem[]; translate?: { base: string; versionId: number } | null }
  | { kind: 'failure'; failure: Failure; retry?: () => void }
  | null;

const canWrite = () => !!(typeof window !== 'undefined'
  && (window as any).AdminConsole && (window as any).AdminConsole.canWrite());

const confirm = async (opts: { title: string; message: string; confirmLabel: string }): Promise<boolean> => {
  const consoleApi = typeof window !== 'undefined' ? (window as any).AdminConsole : null;
  return consoleApi ? !!(await consoleApi._confirm({ ...opts, destructive: true })) : false;
};

// What a delete did, named from the snapshot reloaded after it: which
// version of the email is live now, or where a layout's emails went.
function deletedText(kind: 'template' | 'layout', gone: TemplateRow | LayoutRow, result: any, fresh: TemplatesPayload | null): string {
  if (kind === 'template') {
    const liveId = result && typeof result.liveId === 'number' ? result.liveId : null;
    const now = fresh && liveId != null ? fresh.templates.find((t) => t.id === liveId) : null;
    if (now) return `${gone.name} v${gone.version} was deleted. ${now.name} v${now.version} is now live.`;
    return `${gone.name} v${gone.version} was deleted.`;
  }
  const movedTo = result && typeof result.movedTo === 'number' ? result.movedTo : null;
  const to = fresh && movedTo != null ? fresh.layouts.find((l) => l.family_id === movedTo && isLive(l)) : null;
  return to ? `The layout ${gone.name} was deleted. Its emails now use ${to.name}.` : `The layout ${gone.name} was deleted.`;
}

// Which email or layout an unusable translation belongs to, for the notice.
function unusableWhere(payload: TemplatesPayload, item: UnusableItem): string | null {
  if (item.action) return payload.actions.find((a) => a.action === item.action)?.label || item.action;
  if (item.layoutId != null) return `layout ${payload.layouts.find((l) => l.id === item.layoutId)?.name || ''}`.trim();
  return null;
}

function EmailTemplatesSection() {
  const write = canWrite();
  const [payload, setPayload] = useState<TemplatesPayload | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<'templates' | 'layouts'>('templates');
  const [view, setView] = useState<View>({ kind: 'list' });
  // Bumped on Reload, so an open editor starts again from the newer version.
  const [editorKey, setEditorKey] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogFailure, setDialogFailure] = useState<Failure | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  // Edits an editor was holding when the console last switched away.
  const [kept, setKept] = useState<KeptDraft | null>(() => keptDraft());
  // Where focus goes back to when the delete dialog closes: the button that
  // opened it, or the banner that says what the delete did.
  const opener = useRef<HTMLElement | null>(null);
  const bannerRef = useRef<HTMLDivElement | null>(null);
  const [focusBanner, setFocusBanner] = useState(0);
  useEffect(() => { if (focusBanner) bannerRef.current?.focus(); }, [focusBanner]);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const res = await request('/api/admin/email-templates');
    if (!alive.current) return null;
    if (!res.ok || !res.data || !Array.isArray(res.data.actions)) { setLoadFailed(true); return null; }
    setLoadFailed(false);
    setPayload(res.data);
    return res.data as TemplatesPayload;
  }, []);

  useEffect(() => { load(); }, [load]);

  const reload = async () => {
    setBanner(null);
    await load();
    // A restored draft was discarded by the Reload the editor asked about:
    // reopen on what is live now.
    setView((v) => (v.kind === 'list' ? v : { ...v, restore: undefined }));
    setEditorKey((k) => k + 1);
  };

  // A write from the list: on success reload and say what happened; on a
  // refusal say why, with Reload or Try again where they help.
  const run = async (url: string, method: string, body: unknown, done: string, again: () => void) => {
    setBanner(null);
    const res = await request(url, method, body);
    if (!alive.current) return;
    if (res.ok) {
      await load();
      setBanner({ kind: 'ok', text: done, unusable: unusableOf(res.data) });
      return;
    }
    setBanner({ kind: 'failure', failure: readFailure(res.status, res.data), retry: again });
  };

  const restoreTemplate = (row: TemplateRow) => {
    if (!payload) return;
    const live = liveTemplate(payload, row.action);
    run(`/api/admin/email-templates/${row.id}/restore`, 'POST', { expectedLiveId: live ? live.id : null },
      `${row.name} v${row.version} is live again.`, () => restoreTemplate(row));
  };

  const deleteArchivedTemplate = async (row: TemplateRow) => {
    const live = payload ? liveTemplate(payload, row.action) : null;
    const sure = await confirm({
      title: `Delete ${row.name} v${row.version}?`,
      message: 'This earlier version will no longer be offered to restore or as a replacement. The live version is not affected.',
      confirmLabel: 'Delete',
    });
    if (!sure || !alive.current) return;
    run(`/api/admin/email-templates/${row.id}`, 'DELETE', { expectedLiveId: live ? live.id : null }, `${row.name} v${row.version} was deleted.`,
      () => deleteArchivedTemplate(row));
  };

  const restoreLayout = (row: LayoutRow) => {
    if (!payload) return;
    const live = payload.layouts.find((l) => l.family_id === row.family_id && isLive(l));
    run(`/api/admin/email-layouts/${row.id}/restore`, 'POST', { expectedLiveId: live ? live.id : null },
      `${row.name} v${row.version} is live again.`, () => restoreLayout(row));
  };

  const openDialog = (next: Dialog) => {
    opener.current = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;
    setDialogFailure(null);
    setDialogBusy(false);
    setDialog(next);
  };

  const closeDialog = () => {
    setDialog(null);
    const back = opener.current;
    opener.current = null;
    if (back && back.isConnected) back.focus();
  };

  // A conflict in the dialog means the list was stale: close it and reload,
  // so the admin decides again on what is live now.
  const reloadFromDialog = async () => {
    setDialog(null);
    opener.current = null;
    await reload();
  };

  const confirmDialog = async (replacementId: number | null) => {
    if (!dialog) return;
    setDialogBusy(true);
    setDialogFailure(null);
    const url = dialog.kind === 'template'
      ? `/api/admin/email-templates/${dialog.live.id}`
      // A layout is deleted as a whole, by its family id.
      : `/api/admin/email-layouts/${dialog.live.family_id}`;
    // The live version this dialog was opened on, so a delete from a stale
    // list is refused instead of deleting something else.
    const body: Record<string, unknown> = { expectedLiveId: dialog.live.id };
    if (replacementId != null) body.replacementId = replacementId;
    const res = await request(url, 'DELETE', body);
    if (!alive.current) return;
    setDialogBusy(false);
    if (!res.ok) { setDialogFailure(readFailure(res.status, res.data)); return; }
    const gone = dialog.live;
    setDialog(null);
    opener.current = null;
    const fresh = await load();
    if (!alive.current) return;
    setBanner({ kind: 'ok', text: deletedText(dialog.kind, gone, res.data, fresh), unusable: unusableOf(res.data) });
    setFocusBanner((n) => n + 1);
  };

  const dialogNode = (() => {
    if (!dialog || !payload) return null;
    if (dialog.kind === 'template') {
      return (
        <ReplaceDialog title={`Delete ${dialog.live.name}?`}
          intro="Every email needs a live version, so choose which earlier version goes live in its place."
          choices={templateReplacements(payload, dialog.live)} required
          emptyText="There is no earlier version to put live instead, so this one cannot be deleted. Save a new version instead."
          confirmLabel="Delete and put the chosen version live" busy={dialogBusy} failure={dialogFailure}
          onConfirm={confirmDialog} onCancel={closeDialog} onReload={reloadFromDialog} />
      );
    }
    const using = payload.actions.filter((a) => {
      const t = liveTemplate(payload, a.action);
      return t && t.layout_family_id === dialog.live.family_id;
    }).length;
    return (
      <ReplaceDialog title={`Delete the layout ${dialog.live.name}?`}
        intro={using
          ? `${using === 1 ? '1 email wears' : `${using} emails wear`} this layout. Choose the layout they move to; each is checked against it first.`
          : 'No email wears this layout. Its earlier versions are deleted with it.'}
        choices={layoutReplacements(payload, dialog.live.family_id)} required={using > 0}
        emptyText="There is no other layout to move them to. Make one first, or give each email another layout (or None) in its editor."
        confirmLabel={using ? 'Move them and delete' : 'Delete layout'} busy={dialogBusy} failure={dialogFailure}
        onConfirm={confirmDialog} onCancel={closeDialog} onReload={reloadFromDialog} />
    );
  })();

  if (loadFailed) {
    return (
      <div className="space-y-3">
        <p className={AdminUI.muted}>Could not load the email templates.</p>
        <button type="button" className={AdminUI.btn.outlineSm} onClick={() => load()}>Try again</button>
      </div>
    );
  }
  if (!payload) return <p className={AdminUI.loading}>Loading…</p>;

  const now = Date.now();
  const back = () => { setView({ kind: 'list' }); };
  // After a save: back on the list, saying what went live, which
  // translations the save left unusable, and offering Translate for the
  // version just saved (an English-only email has nothing to offer).
  const saved = (text: string, unusable: UnusableItem[], translate: { base: string; versionId: number } | null) => async () => {
    await load();
    if (!alive.current) return;
    setView({ kind: 'list' });
    setBanner({ kind: 'ok', text, unusable, translate });
    setFocusBanner((n) => n + 1);
  };

  if (view.kind === 'template') {
    return (
      <TemplateEditor key={`t-${view.action}-${editorKey}`} payload={payload} action={view.action} isNew={view.isNew}
        restore={view.restore || null} canWrite={write} onDone={back} onReload={reload}
        onSaved={(row, unusable) => {
          const englishOnly = !!payload.actions.find((a) => a.action === row.action)?.englishOnly;
          saved(englishOnly ? `${row.name} v${row.version} is live.` : `${row.name} v${row.version} is live. ${ENGLISH_UNTIL_TRANSLATED}`, unusable,
            englishOnly ? null : { base: '/api/admin/email-templates', versionId: row.id })();
        }} />
    );
  }
  if (view.kind === 'layout') {
    return (
      <LayoutEditor key={`l-${view.familyId}-${editorKey}`} payload={payload} familyId={view.familyId}
        restore={view.restore || null} canWrite={write} onDone={back} onReload={reload}
        onSaved={(row, unusable) => saved(`${row.name} v${row.version} is live.`, unusable,
          { base: '/api/admin/email-layouts', versionId: row.id })()} />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800" role="tablist" aria-label="Email templates">
        {([['templates', 'Email templates'], ['layouts', 'Layouts']] as const).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} id={`email-templates-tab-${key}`}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === key
              ? 'border-violet-600 text-zinc-900 dark:text-zinc-100'
              : 'border-transparent text-zinc-500 dark:text-zinc-400'}`}
            onClick={() => { setTab(key); setBanner(null); }}>{label}</button>
        ))}
      </div>
      <div ref={bannerRef} tabIndex={-1} className="outline-none space-y-2" id="email-templates-banner">
        {banner && banner.kind === 'ok' ? (
          <SavedBanner text={banner.text} unusable={banner.unusable} translate={banner.translate}
            languages={payload.languages} labelFor={(item) => unusableWhere(payload, item)} onFinished={load} />
        ) : null}
        {banner && banner.kind === 'failure'
          ? <FailureNotice failure={banner.failure} onReload={reload} onRetry={banner.retry} />
          : null}
      </div>
      <KeptDraftNotice draft={kept} onDiscard={() => { keepDraft(null); setKept(null); }}
        onOpen={() => {
          if (!kept) return;
          // Taken out of the store as it is handed to the editor, which then
          // owns it: leaving that editor dirty keeps it again.
          keepDraft(null);
          setKept(null);
          if (kept.kind === 'template') { setTab('templates'); setView({ kind: 'template', action: kept.action, isNew: kept.isNew, restore: kept }); }
          else { setTab('layouts'); setView({ kind: 'layout', familyId: kept.familyId, restore: kept }); }
        }} />
      {tab === 'templates' ? (
        <TemplateList payload={payload} canWrite={write} showArchived={showArchived} now={now}
          onToggleArchived={() => setShowArchived((s) => !s)}
          onNew={() => setView({ kind: 'template', action: payload.actions[0]?.action || 'otp', isNew: true })}
          onEdit={(action) => setView({ kind: 'template', action, isNew: false })}
          onDelete={(live) => openDialog({ kind: 'template', live })}
          onRestore={restoreTemplate} onDeleteArchived={deleteArchivedTemplate} />
      ) : (
        <LayoutList payload={payload} canWrite={write} showArchived={showArchived} now={now}
          onToggleArchived={() => setShowArchived((s) => !s)}
          onNew={() => setView({ kind: 'layout', familyId: null })}
          onEdit={(familyId) => setView({ kind: 'layout', familyId })}
          onDelete={(live) => openDialog({ kind: 'layout', live })}
          onRestore={restoreLayout} />
      )}
      {dialogNode}
    </div>
  );
}

let host: Element | null = null;

const AdminEmailTemplates = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <EmailTemplatesSection />);
  },

  // Nothing polls. Dropping the portal unmounts the section, and a request
  // still in flight then lands on a component that is gone (the `alive` ref).
  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminEmailTemplates = AdminEmailTemplates;

export {
  AdminEmailTemplates, EmailTemplatesSection, TemplateList, TemplateForm, draftFrom, LayoutList, ReplaceDialog,
  templateReplacements, layoutReplacements, PreviewView, FailureNotice, PlaceholderList, readFailure,
  deletedText, isDirty, KeptDraftNotice, TemplateEditor, LayoutEditor, keepDraft, keptDraft, expectedLiveFor,
  SavedBanner, TranslateProgressView, LanguageForm, translationSummary, languagesColumn, jobSummary, stateWords,
  UnusableLanguageNotice, LanguageSwitch, TranslateControlsView, translateBlocked, unusableWhere,
  unusableReason, languageSaveRequest, retranslateBody, languageMove, keptLanguage, TranslateControls, unusableOf, PreviewPane,
};
