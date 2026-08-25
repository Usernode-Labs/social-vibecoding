'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchJson, send } from './api.ts';
import { BTN, PANEL_CLS } from './tokens.ts';
import {
  EmptyState, ErrorState, Field, FormActions, FormError, FormGrid, Input, List, Panel,
  ScreenHeader, Skeleton, Textarea, fmt,
} from './ui.tsx';
import type { Column } from './ui.tsx';

// Settings — full CRUD over the `topochain_*` numeric knobs the mobile app
// reads at runtime, plus the outbound-mail readiness card. Keyed by `key`,
// not by a numeric id, and /reset needs {confirm:true}.
//
// ── React-owned (#1120 slice 26) ──────────────────────────────────────
//
// Third screen through the portal seam, and the first CRUD one — so it is
// where the shared list, pager and form chrome had to become components
// (./ui.tsx). Two things that cost real code in the innerHTML version and
// cost none here:
//
//   - `_settings.editingKey` / `.isNew` were module globals because the form
//     was markup that had to be re-found by id after being written. They are
//     one `editing` state value now: null (closed), 'new', or the key.
//   - The form's error slot was rendered empty-and-hidden and revealed with
//     classList; it is a value that renders nothing when absent.
//
// The mail card is unchanged in substance and deliberately value-free: the
// endpoint reports PRESENCE only, never a provider URL or credential. The
// sender address is the one value it renders, and only because it is in the
// From header of every mail the platform sends.
//
// Ids are like-for-like — `admin-topo-set-*` and `admin-topo-mail-status`.

const KEY_PREFIX = 'topochain_';

type Setting = {
  key: string;
  value: number | string;
  description?: string | null;
  updated_at?: string | null;
};

type Provider = { name: string; label?: string; configured: boolean; missing?: string[] };
type MailStatus = {
  configured?: boolean;
  provider?: string;
  from?: string;
  usingDefaultFrom?: boolean;
  stagingLogOnly?: boolean;
  affectedFlows?: string[];
  providers?: Provider[];
  missing?: string[];
};

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="font-mono text-xs">{children}</code>
);

function Sender({ mail }: { mail: MailStatus }) {
  return (
    <div className="text-zinc-500 dark:text-zinc-400 mt-1">
      {'Sending as '}
      <Code>{mail.from || '(unset)'}</Code>
      {mail.usingDefaultFrom ? <span className="text-zinc-500 dark:text-zinc-400">{' (built-in default)'}</span> : null}
    </div>
  );
}

// Outbound-mail readiness. This card exists because both mail flows are
// always-200 by contract, so "no transport configured" is otherwise
// completely invisible.
function MailCard({ mail }: { mail: MailStatus | null }) {
  if (!mail) return null;

  // A staging preview is a clone of production data, so it can never reach a
  // real provider — say so plainly rather than letting a tester read a card
  // and wait for an inbox that will never fill.
  if (mail.stagingLogOnly) {
    return (
      <div className="rounded-xl border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 px-4 py-3 text-sm sm:px-5">
        <div className="font-semibold text-sky-800 dark:text-sky-300">
          Staging preview: email is rendered to the log, never delivered
        </div>
        <p className="text-sky-800/80 dark:text-sky-300/80 mt-1">
          This preview holds a clone of production data, so it must not mail real
          people. Login codes and links appear in the platform log
          (<Code>platform-mail</Code>) so you can complete a flow by hand.
        </p>
        <Sender mail={mail} />
      </div>
    );
  }

  if (mail.configured) {
    return (
      <div className={`${PANEL_CLS} px-4 py-3 text-sm sm:px-5`}>
        <span className="font-semibold text-emerald-700 dark:text-emerald-400">
          Email is configured
        </span>
        <span className="text-zinc-500 dark:text-zinc-400">
          {': login codes and waitlist confirmations are being sent via '}
          <span className="font-medium">{mail.provider || 'unknown'}</span>.
        </span>
        <Sender mail={mail} />
      </div>
    );
  }

  // Per-provider readiness, so the card says which provider needs what
  // instead of a flat "mail is broken".
  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm sm:px-5">
      <div className="font-semibold text-amber-800 dark:text-amber-300">
        Email is not deliverable: no mail sender configured
      </div>
      <p className="text-amber-800/80 dark:text-amber-300/80 mt-1">
        These flows still report success to the user but deliver nothing:
      </p>
      <ul className="list-disc ml-5 mt-1 text-amber-800/80 dark:text-amber-300/80">
        {(mail.affectedFlows || []).map((f) => <li key={f}>{f}</li>)}
      </ul>
      <p className="text-amber-800/80 dark:text-amber-300/80 mt-2">Providers:</p>
      <ul className="list-disc ml-5 mt-1 text-amber-800/80 dark:text-amber-300/80">
        {(mail.providers || []).map((p) => (
          <li key={p.name}>
            {`${p.label || p.name}: `}
            {p.configured
              ? <span className="text-emerald-700 dark:text-emerald-400">ready</span>
              : (
                <>
                  {'needs '}
                  {(p.missing || []).map((k, i) => (
                    <span key={k}>{i ? ', ' : ''}<Code>{k}</Code></span>
                  ))}
                </>
              )}
          </li>
        ))}
      </ul>
      <p className="text-amber-800/80 dark:text-amber-300/80 mt-2">
        {'Set '}
        {(mail.missing || []).map((k, i) => (
          <span key={k}>{i ? ', ' : ''}<Code>{k}</Code></span>
        ))}
        {' in the platform’s Platform variables panel, then redeploy. The mailbox '}
        {'behind those credentials must also be authorised to send as '}
        <Code>{mail.from || ''}</Code>.
      </p>
    </div>
  );
}

function SettingForm({
  existing, onClose, onSaved,
}: {
  existing: Setting | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState(existing?.key || '');
  const [value, setValue] = useState(existing == null ? '' : String(existing.value));
  const [description, setDescription] = useState(existing?.description || '');
  const [error, setError] = useState<string | null>(null);
  const isNew = existing == null;

  const save = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    const k = key.trim();
    const v = value.trim();
    if (!k.startsWith(KEY_PREFIX)) { setError(`Key must start with "${KEY_PREFIX}".`); return; }
    if (v === '' || Number.isNaN(Number(v)) || Number(v) < 0) {
      setError('Value must be a number >= 0.');
      return;
    }
    const body = {
      key: k,
      value: Number(v),
      description: description.trim() === '' ? null : description.trim(),
    };
    const url = isNew
      ? '/api/v4/admin/settings'
      : `/api/v4/admin/settings/${encodeURIComponent(existing.key)}`;
    const { ok, data } = await send(isNew ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) { setError((data && data.error) || 'Save failed.'); return; }
    onSaved();
  }, [key, value, description, isNew, existing, onSaved]);

  return (
    <Panel
      title={isNew ? 'New setting' : `Edit ${existing.key}`}
      subtitle={`Keys must start with ${KEY_PREFIX} and values are numbers the app reads at runtime.`}
      onClose={onClose}
      closeLabel="Close the setting form"
      footer={<FormActions onSave={save} onCancel={onClose} saveLabel="Save setting" />}
    >
      <FormGrid>
        <Field label={`Key * (must start with ${KEY_PREFIX})`} htmlFor="admin-topo-set-f-key">
          <Input
            id="admin-topo-set-f-key"
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <Field label="Value * (number ≥ 0)" htmlFor="admin-topo-set-f-value">
          <Input
            id="admin-topo-set-f-value"
            type="number"
            min={0}
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="admin-topo-set-f-description"
          className="md:col-span-2"
        >
          <Textarea
            id="admin-topo-set-f-description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </FormGrid>
      <FormError message={error} />
    </Panel>
  );
}

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

function SettingsScreen() {
  const write = canWrite();
  const [items, setItems] = useState<Setting[] | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [mail, setMail] = useState<MailStatus | null>(null);
  // null = closed, 'new' = the create form, otherwise the key being edited.
  // One value where the innerHTML version needed `editingKey` + `isNew`.
  const [editing, setEditing] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { ok, data, status } = await fetchJson('/api/v4/admin/settings');
    if (!alive.current) return;
    if (ok && data?.success) { setItems(data.data); setError(null); return; }
    setItems([]);
    setError({ status, message: (data && data.error) || null });
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      const { ok, data } = await fetchJson('/api/v4/admin/settings/mail-status');
      if (!alive.current) return;
      setMail(!ok || !data?.success ? null : (data.data || {}));
    })();
  }, []);

  const remove = useCallback(async (key: string) => {
    if (!canWrite()) return;
    const ok = await topo()._confirm({
      title: `Delete "${key}"?`,
      confirmLabel: 'Delete',
      danger: true,
      message: 'This cannot be undone.',
    });
    if (!ok) return;
    const res = await send('DELETE', `/api/v4/admin/settings/${encodeURIComponent(key)}`);
    if (res.ok && res.data?.success) load();
    else topo()._alert((res.data && res.data.error) || 'Delete failed.');
  }, [load]);

  const reset = useCallback(async () => {
    if (!canWrite()) return;
    const ok = await topo()._confirm({
      title: 'Reset settings to defaults?',
      message: 'Restores the 6 scoring-related topochain_* settings to their shipped defaults. Any other custom topochain_* settings are left untouched.',
      confirmLabel: 'Reset',
      danger: true,
    });
    if (!ok) return;
    const { ok: sendOk, data } = await send('POST', '/api/v4/admin/settings/reset', { confirm: true });
    if (sendOk && data?.success) load();
    else topo()._alert((data && data.error) || 'Reset failed.');
  }, [load]);

  const columns: Column<Setting>[] = [
    { label: 'Key', primary: true, cell: (s) => s.key, tdClass: 'text-xs font-mono' },
    { label: 'Value', cell: (s) => s.value, tdClass: 'font-mono text-right', thClass: 'text-right' },
    { label: 'Description', cell: (s) => s.description || '—', tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
    { label: 'Updated', cell: (s) => fmt(s.updated_at), tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
  ];

  const editingItem = editing === 'new'
    ? null
    : (items || []).find((s) => s.key === editing) || null;

  return (
    <>
      <ScreenHeader
        title="Settings"
        subtitle="Numeric knobs read by the mobile app, plus outbound-mail readiness."
        actions={write ? (
          <>
            <button
              id="admin-topo-set-new"
              type="button"
              className={BTN.primarySm}
              onClick={() => setEditing('new')}
            >
              New setting
            </button>
            <button
              id="admin-topo-set-reset"
              type="button"
              className={BTN.warnSm}
              onClick={reset}
            >
              Reset to defaults…
            </button>
          </>
        ) : null}
      />
      <div id="admin-topo-mail-status" className="mb-4">
        <MailCard mail={mail} />
      </div>
      <div id="admin-topo-set-form">
        {editing != null && write ? (
          <SettingForm
            key={editing}
            existing={editingItem}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); load(); }}
          />
        ) : null}
      </div>
      <div id="admin-topo-set-table">
        {items === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState
            title="Couldn't load settings"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {items !== null && !error && !items.length ? (
          <EmptyState
            title="No settings yet"
            body={`Settings are numeric knobs read by the mobile app. Keys must start with ${KEY_PREFIX}.`}
            action={write ? (
              <button
                id="admin-topo-set-empty-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setEditing('new')}
              >
                New setting
              </button>
            ) : null}
          />
        ) : null}
        {items !== null && !error && items.length ? (
          <List
            items={items}
            rowKey={(s) => s.key}
            columns={columns}
            actions={write ? (s) => (
              <>
                <button
                  data-edit-set={s.key}
                  type="button"
                  className={BTN.row}
                  onClick={() => setEditing(s.key)}
                >
                  Edit
                </button>
                <button
                  data-delete-set={s.key}
                  type="button"
                  className={BTN.rowDanger}
                  onClick={() => remove(s.key)}
                >
                  Delete
                </button>
              </>
            ) : undefined}
          />
        ) : null}
      </div>
    </>
  );
}

export { SettingsScreen };
