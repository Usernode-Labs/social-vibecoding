'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchJson, send } from './api.ts';
import { BTN } from './tokens.ts';
import {
  CheckField, EmptyState, ErrorState, Field, FormActions, FormError, FormGrid, Input, List,
  Panel, ScreenHeader, Select, Skeleton, Textarea,
} from './ui.tsx';
import type { Column } from './ui.tsx';

// App version — full CRUD over app_version_configs, one row per OS, plus the
// two things that answer "is the update gate actually doing anything?": the
// per-OS missing-rule warning and the last seven days of version checks.
//
// ── React-owned (#1120 slice 27) ──────────────────────────────────────
//
// Fourth screen through the portal seam. Nothing structural is new after
// Settings — the same list, form and state shapes — but two of this screen's
// parts were DERIVED views that the innerHTML version had to repaint by hand
// from a module global:
//
//   - `_renderAppVersionGate()` recomputed the missing-OS warning from
//     `_appver.items` and had to be called from `_loadAppVersions` alongside
//     the table repaint. It is a function of the items, so it is one now.
//   - `_appver.editingId` existed so `_saveAppVersion` could tell create from
//     edit after the form had been written into the DOM and lost its context.
//     The form is handed its row.
//
// The `os` select stays disabled while editing: the row is keyed by OS
// server-side, so changing it in place would be a create wearing an edit's
// URL.
//
// Ids are like-for-like — `admin-topo-av-*`, including the four `-f-` field
// ids tests/topochain-app-version-gate.test.js names.

const OSES = ['ios', 'android'] as const;
const OS_LABEL: Record<string, string> = { ios: 'iOS', android: 'Android' };

// What POST /app-version/check told a build. The gate answers `upgrade: 0` to
// everything when no active rule exists, which is exactly the state the
// warning above the table is about.
const UPGRADE_LABEL: Record<number, string> = {
  0: 'up to date',
  1: 'suggested update',
  2: 'forced update',
};

type Config = {
  id: number;
  os: string;
  min_build_number: number;
  recommended_build_number?: number | null;
  current_version?: string | null;
  update_url?: string | null;
  must_update_message?: string | null;
  should_update_message?: string | null;
  is_active: boolean;
};

type Activity = {
  total?: number;
  window_days?: number;
  by_os?: { os?: string; upgrade: number; count: number }[];
};

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

// Per-OS "no rule configured" warning. Without a row (or with the row
// inactive) POST /app-version/check answers `upgrade: 0` to EVERY build,
// including ones that should be forced to update — the gate is off, and
// nothing else on this screen says so.
function Gate({ items }: { items: Config[] }) {
  const missing = OSES.filter((os) => !items.some((c) => c.os === os && c.is_active));
  return (
    <>
      {missing.map((os) => (
        <div
          key={os}
          className="mb-3 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm sm:px-5"
        >
          <span className="font-semibold text-amber-800 dark:text-amber-300">
            {`No active version rule for ${OS_LABEL[os]}`}
          </span>
          <span className="text-amber-800/80 dark:text-amber-300/80">
            {` — every ${OS_LABEL[os]} build is told it is up to date, including old ones. `}
            {`Add an active config for ${os} to turn the update gate on.`}
          </span>
        </div>
      ))}
    </>
  );
}

// Last 7 days of version checks. Answers "is the gate doing anything?" — an
// all-zero table with traffic means the rule is permissive; no traffic at all
// means no shell is calling.
function ActivityTable({ activity }: { activity: Activity | null }) {
  if (!activity) return null;
  const days = activity.window_days ?? 7;
  if (!activity.total) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-4">
        {`No version checks in the last ${days} days — no app build has asked this platform whether it needs to update.`}
      </p>
    );
  }
  return (
    <>
      <h3 className="text-sm font-semibold mt-8 mb-3">
        {`Version checks · last ${days} days `}
        <span className="font-normal text-zinc-500 dark:text-zinc-400">
          {`(${activity.total} total)`}
        </span>
      </h3>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full">
          <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left">OS</th>
              <th className="px-3 py-2 text-left">Told</th>
              <th className="px-3 py-2 text-right">Checks</th>
            </tr>
          </thead>
          <tbody>
            {(activity.by_os || []).map((r, i) => (
              <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="px-3 py-1.5 text-sm">{r.os || '—'}</td>
                <td className="px-3 py-1.5 text-sm">{UPGRADE_LABEL[r.upgrade] || r.upgrade}</td>
                <td className="px-3 py-1.5 text-sm font-mono text-right">{r.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ConfigForm({
  existing, onClose, onSaved,
}: {
  existing: Config | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = existing == null;
  const [os, setOs] = useState(existing?.os || 'ios');
  const [currentVersion, setCurrentVersion] = useState(existing?.current_version || '');
  const [minBuild, setMinBuild] = useState(
    existing?.min_build_number == null ? '' : String(existing.min_build_number),
  );
  const [recBuild, setRecBuild] = useState(
    existing?.recommended_build_number == null ? '' : String(existing.recommended_build_number),
  );
  const [updateUrl, setUpdateUrl] = useState(existing?.update_url || '');
  const [isActive, setIsActive] = useState(existing ? existing.is_active : true);
  const [mustMsg, setMustMsg] = useState(existing?.must_update_message || '');
  const [shouldMsg, setShouldMsg] = useState(existing?.should_update_message || '');
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    const url = updateUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) { setError('Update URL must be http(s).'); return; }
    const rec = recBuild.trim();
    const body = {
      os,
      min_build_number: Number(minBuild.trim()),
      recommended_build_number: rec === '' ? null : Number(rec),
      current_version: currentVersion.trim() || null,
      update_url: url || null,
      must_update_message: mustMsg.trim() || null,
      should_update_message: shouldMsg.trim() || null,
      is_active: isActive,
    };
    const target = isNew
      ? '/api/v4/admin/app-version-configs'
      : `/api/v4/admin/app-version-configs/${encodeURIComponent(existing.id)}`;
    const { ok, data } = await send(isNew ? 'POST' : 'PUT', target, body);
    if (!ok || !data?.success) { setError((data && data.error) || 'Save failed.'); return; }
    onSaved();
  }, [os, minBuild, recBuild, currentVersion, updateUrl, mustMsg, shouldMsg, isActive,
    isNew, existing, onSaved]);

  return (
    <Panel
      title={isNew ? 'New app version config' : `Edit ${existing.os}`}
      subtitle="The gate compares build numbers. An inactive rule tells every build it is up to date."
      onClose={onClose}
      closeLabel="Close the app version form"
      footer={<FormActions onSave={save} onCancel={onClose} saveLabel="Save config" />}
    >
      <FormGrid>
        <Field label="OS *" htmlFor="admin-topo-av-f-os">
          {/* Disabled while editing: the row is keyed by OS server-side, so
              changing it in place would be a create wearing an edit's URL. */}
          <Select
            id="admin-topo-av-f-os"
            value={os}
            disabled={!isNew}
            onChange={(e) => setOs(e.target.value)}
          >
            {OSES.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        </Field>
        <Field
          label="Current version"
          htmlFor="admin-topo-av-f-current_version"
          help="Display only — the gate compares build numbers, not this string."
        >
          <Input
            id="admin-topo-av-f-current_version"
            type="text"
            value={currentVersion}
            onChange={(e) => setCurrentVersion(e.target.value)}
          />
        </Field>
        <Field
          label="Min build number *"
          htmlFor="admin-topo-av-f-min_build_number"
          help="FORCED update: builds below this are blocked until the user updates."
        >
          <Input
            id="admin-topo-av-f-min_build_number"
            type="number"
            min={1}
            value={minBuild}
            onChange={(e) => setMinBuild(e.target.value)}
          />
        </Field>
        <Field
          label="Recommended build number"
          htmlFor="admin-topo-av-f-recommended_build_number"
          help="SUGGESTED update: builds below this get a dismissible prompt. Leave blank for none."
        >
          <Input
            id="admin-topo-av-f-recommended_build_number"
            type="number"
            min={1}
            value={recBuild}
            onChange={(e) => setRecBuild(e.target.value)}
          />
        </Field>
        <Field
          label="Update URL"
          htmlFor="admin-topo-av-f-update_url"
          help="Must be http(s). Only sent when an update is required or suggested — leave it blank and a forced update gives the user nowhere to go."
          className="md:col-span-2"
        >
          <Input
            id="admin-topo-av-f-update_url"
            type="text"
            value={updateUrl}
            onChange={(e) => setUpdateUrl(e.target.value)}
          />
        </Field>
        <div className="md:col-span-2">
          <CheckField
            id="admin-topo-av-f-is_active"
            label="Active"
            help="Turn the update gate on for this OS."
            checked={isActive}
            onChange={setIsActive}
          />
        </div>
      </FormGrid>
      <div className="grid grid-cols-1 gap-4 mt-4">
        <Field label="Must-update message" htmlFor="admin-topo-av-f-must_update_message">
          <Textarea
            id="admin-topo-av-f-must_update_message"
            rows={3}
            value={mustMsg}
            onChange={(e) => setMustMsg(e.target.value)}
          />
        </Field>
        <Field label="Should-update message" htmlFor="admin-topo-av-f-should_update_message">
          <Textarea
            id="admin-topo-av-f-should_update_message"
            rows={3}
            value={shouldMsg}
            onChange={(e) => setShouldMsg(e.target.value)}
          />
        </Field>
      </div>
      <FormError message={error} />
    </Panel>
  );
}

function AppVersionScreen() {
  const write = canWrite();
  const [items, setItems] = useState<Config[] | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  // null = closed, 'new' = the create form, otherwise the id being edited.
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { ok, data, status } = await fetchJson('/api/v4/admin/app-version-configs');
    if (!alive.current) return;
    if (ok && data?.success) { setItems(data.data); setError(null); return; }
    setItems([]);
    setError({ status, message: (data && data.error) || null });
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      const { ok, data } = await fetchJson('/api/v4/admin/app-version-configs/check-activity');
      if (!alive.current) return;
      setActivity(!ok || !data?.success ? null : (data.data || {}));
    })();
  }, []);

  const remove = useCallback(async (id: number) => {
    if (!canWrite()) return;
    const ok = await topo()._confirm({
      title: 'Delete this app version config?',
      confirmLabel: 'Delete',
      danger: true,
      message: 'This cannot be undone.',
    });
    if (!ok) return;
    const res = await send('DELETE', `/api/v4/admin/app-version-configs/${encodeURIComponent(id)}`);
    if (res.ok && res.data?.success) load();
    else topo()._alert((res.data && res.data.error) || 'Delete failed.');
  }, [load]);

  const columns: Column<Config>[] = [
    { label: 'OS', primary: true, cell: (c) => c.os },
    {
      label: 'Min build',
      cell: (c) => c.min_build_number,
      tdClass: 'font-mono text-right',
      thClass: 'text-right',
    },
    {
      label: 'Recommended',
      cell: (c) => (c.recommended_build_number != null ? c.recommended_build_number : '—'),
      tdClass: 'font-mono text-right',
      thClass: 'text-right',
    },
    {
      label: 'Current version',
      cell: (c) => c.current_version || '—',
      tdClass: 'text-xs text-zinc-500',
    },
    {
      label: 'Active',
      cell: (c) => (c.is_active
        ? <span className="text-green-600 dark:text-green-400">active</span>
        : '—'),
    },
  ];

  const editingItem = editing === 'new' || editing == null
    ? null
    : (items || []).find((c) => c.id === editing) || null;

  return (
    <>
      <ScreenHeader
        title="App version"
        subtitle="One update rule per OS. Build numbers decide forced and suggested updates."
        actions={write ? (
          <button
            id="admin-topo-av-new"
            type="button"
            className={BTN.primarySm}
            onClick={() => setEditing('new')}
          >
            New config
          </button>
        ) : null}
      />
      <div id="admin-topo-av-gate">
        {items !== null && !error ? <Gate items={items} /> : null}
      </div>
      <div id="admin-topo-av-form">
        {editing != null && write ? (
          <ConfigForm
            key={String(editing)}
            existing={editingItem}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); load(); }}
          />
        ) : null}
      </div>
      <div id="admin-topo-av-table">
        {items === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState
            title="Couldn't load app version configs"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {items !== null && !error && !items.length ? (
          <EmptyState
            title="No app version configs yet"
            body="Without a rule per OS the update gate is off — every build is told it is up to date."
            action={write ? (
              <button
                id="admin-topo-av-empty-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setEditing('new')}
              >
                New config
              </button>
            ) : null}
          />
        ) : null}
        {items !== null && !error && items.length ? (
          <List
            items={items}
            rowKey={(c) => c.id}
            columns={columns}
            actions={write ? (c) => (
              <>
                <button
                  data-edit-av={c.id}
                  type="button"
                  className={BTN.row}
                  onClick={() => setEditing(c.id)}
                >
                  Edit
                </button>
                <button
                  data-delete-av={c.id}
                  type="button"
                  className={BTN.rowDanger}
                  onClick={() => remove(c.id)}
                >
                  Delete
                </button>
              </>
            ) : undefined}
          />
        ) : null}
      </div>
      <div id="admin-topo-av-activity">
        <ActivityTable activity={activity} />
      </div>
    </>
  );
}

export { AppVersionScreen };
