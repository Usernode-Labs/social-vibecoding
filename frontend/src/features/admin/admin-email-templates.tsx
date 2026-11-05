'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { TemplateList } from './email-templates/list';
import { draftFrom, TemplateEditor, TemplateForm } from './email-templates/editor';
import { LayoutEditor, LayoutList } from './email-templates/layouts';
import { layoutReplacements, ReplaceDialog, templateReplacements } from './email-templates/replace-dialog';
import { PreviewView } from './email-templates/preview';
import {
  FailureNotice, liveTemplate, PlaceholderList, readFailure, request, isLive,
  type Failure, type LayoutRow, type TemplateRow, type TemplatesPayload,
} from './email-templates/shared';

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

type View =
  | { kind: 'list' }
  | { kind: 'template'; action: string; isNew: boolean }
  | { kind: 'layout'; familyId: number | null };

type Dialog =
  | { kind: 'template'; live: TemplateRow }
  | { kind: 'layout'; live: LayoutRow };

type Banner = { kind: 'ok'; text: string } | { kind: 'failure'; failure: Failure; retry?: () => void } | null;

const canWrite = () => !!(typeof window !== 'undefined'
  && (window as any).AdminConsole && (window as any).AdminConsole.canWrite());

const confirm = async (opts: { title: string; message: string; confirmLabel: string }): Promise<boolean> => {
  const consoleApi = typeof window !== 'undefined' ? (window as any).AdminConsole : null;
  return consoleApi ? !!(await consoleApi._confirm({ ...opts, destructive: true })) : false;
};

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
    setEditorKey((k) => k + 1);
  };

  // A write from the list: on success reload and say what happened; on a
  // refusal say why, with Reload or Try again where they help.
  const run = async (url: string, method: string, body: unknown, done: string, again: () => void) => {
    setBanner(null);
    const res = await request(url, method, body);
    if (!alive.current) return;
    if (res.ok) { await load(); setBanner({ kind: 'ok', text: done }); return; }
    setBanner({ kind: 'failure', failure: readFailure(res.status, res.data), retry: again });
  };

  const restoreTemplate = (row: TemplateRow) => {
    if (!payload) return;
    const live = liveTemplate(payload, row.action);
    run(`/api/admin/email-templates/${row.id}/restore`, 'POST', { expectedLiveId: live ? live.id : null },
      `${row.name} v${row.version} is live again.`, () => restoreTemplate(row));
  };

  const deleteArchivedTemplate = async (row: TemplateRow) => {
    const sure = await confirm({
      title: `Delete ${row.name} v${row.version}?`,
      message: 'This earlier version will no longer be offered to restore or as a replacement. The live version is not affected.',
      confirmLabel: 'Delete',
    });
    if (!sure || !alive.current) return;
    run(`/api/admin/email-templates/${row.id}`, 'DELETE', {}, `${row.name} v${row.version} was deleted.`,
      () => deleteArchivedTemplate(row));
  };

  const restoreLayout = (row: LayoutRow) => {
    if (!payload) return;
    const live = payload.layouts.find((l) => l.family_id === row.family_id && isLive(l));
    run(`/api/admin/email-layouts/${row.id}/restore`, 'POST', { expectedLiveId: live ? live.id : null },
      `${row.name} v${row.version} is live again.`, () => restoreLayout(row));
  };

  const openDialog = (next: Dialog) => { setDialogFailure(null); setDialogBusy(false); setDialog(next); };

  const confirmDialog = async (replacementId: number | null) => {
    if (!dialog) return;
    setDialogBusy(true);
    setDialogFailure(null);
    const url = dialog.kind === 'template'
      ? `/api/admin/email-templates/${dialog.live.id}`
      // A layout is deleted as a whole, by its family id.
      : `/api/admin/email-layouts/${dialog.live.family_id}`;
    const res = await request(url, 'DELETE', replacementId == null ? {} : { replacementId });
    if (!alive.current) return;
    setDialogBusy(false);
    if (!res.ok) { setDialogFailure(readFailure(res.status, res.data)); return; }
    const name = dialog.live.name;
    setDialog(null);
    await load();
    setBanner({ kind: 'ok', text: dialog.kind === 'template' ? `${name} was deleted, and the version you chose is live.` : `The layout ${name} was deleted.` });
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
          onConfirm={confirmDialog} onCancel={() => setDialog(null)} />
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
        onConfirm={confirmDialog} onCancel={() => setDialog(null)} />
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
  const saved = (text: string) => async () => {
    await load();
    if (!alive.current) return;
    setView({ kind: 'list' });
    setBanner({ kind: 'ok', text });
  };

  if (view.kind === 'template') {
    return (
      <TemplateEditor key={`t-${view.action}-${editorKey}`} payload={payload} action={view.action} isNew={view.isNew}
        canWrite={write} onDone={back} onReload={reload}
        onSaved={(row) => saved(`${row.name} v${row.version} is live.`)()} />
    );
  }
  if (view.kind === 'layout') {
    return (
      <LayoutEditor key={`l-${view.familyId}-${editorKey}`} payload={payload} familyId={view.familyId}
        canWrite={write} onDone={back} onReload={reload}
        onSaved={(row) => saved(`${row.name} v${row.version} is live.`)()} />
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
      {banner && banner.kind === 'ok' ? (
        <p className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300" role="status">
          {banner.text}
        </p>
      ) : null}
      {banner && banner.kind === 'failure'
        ? <FailureNotice failure={banner.failure} onReload={reload} onRetry={banner.retry} />
        : null}
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
};
