'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Templates: every ready-made app and the image built for it ahead of time
// (src/services/starter-images.js). A project made from a ready-made app
// deploys that image instead of building its own, so its first run waits on
// no build. The image is built whenever the template's code changes (a
// release), keyed by what goes into it; this section says where each one
// stands, and Rebuild queues a fresh build of the current code, which the
// platform's leader picks up within a minute. The ready image stays in use
// until the new one replaces it.
//
// `admin-templates-*` ids and `data-template-*` attributes are what
// tests/starter-images.test.js names.

// The page's ?demo=1 rides along so a staging preview, where nothing is
// prebuilt, shows the section filled (routes/admin.js serves it only there).
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';

const console_ = () => (window as any).AdminConsole;

// Read again this often while a build is queued or under way.
const POLL_MS = 10000;

type TemplateRow = {
  id: string;
  title: string;
  key: string | null;
  status: string;
  imageRef: string | null;
  engine: string | null;
  buildMs: number | null;
  builtAt: string | null;
  startedAt: string | null;
  attempts: number;
  error: string | null;
  previousBuiltAt: string | null;
};

type Listing = { prebuilds: boolean; demo?: boolean; templates: TemplateRow[] };

// Mirrors starter-images.js list()'s statuses; an unknown one shows as it is.
const STATUSES: Record<string, { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: AdminUI.badge.success },
  building: { label: 'Building…', cls: AdminUI.badge.warn },
  queued: { label: 'Queued', cls: AdminUI.badge.default },
  missing: { label: 'Not built yet', cls: AdminUI.badge.default },
  failed: { label: 'Failed', cls: AdminUI.badge.destructive },
  unshared: { label: 'Builds per project', cls: AdminUI.badge.default },
};

// Local class recipes, complete literals (Tailwind reads this file's text).
const TemplatesUI = Object.freeze({
  tile: 'rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3',
  tileLabel: 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400',
  tileValue: 'text-2xl font-bold mt-1',
  lede: 'text-sm text-zinc-600 dark:text-zinc-400 mb-4',
  off: 'text-sm rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 p-3 mb-4',
  row: 'flex flex-wrap items-start justify-between gap-x-3 gap-y-1 p-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-800',
  rowMain: 'flex-1 min-w-0',
  rowTitle: 'text-sm font-medium',
  rowId: 'font-mono text-xs text-zinc-500 dark:text-zinc-400 ml-2',
  rowMeta: 'block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 break-all',
  rowError: 'block text-xs text-red-700 mt-0.5 dark:text-red-400 whitespace-pre-wrap break-words',
  rowRight: 'flex items-center gap-2 shrink-0',
});

function ago(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// What a row says under its title: when and how its image was built, which
// image, or what is happening now.
function meta(t: TemplateRow): string {
  const parts: string[] = [];
  if (t.status === 'building' && t.startedAt) parts.push(`started ${ago(t.startedAt)}`);
  if (t.builtAt) parts.push(`built ${ago(t.builtAt)}${t.buildMs != null ? ` in ${(t.buildMs / 1000).toFixed(1)}s` : ''}`);
  if (t.engine) parts.push(t.engine);
  if (t.imageRef) {
    const at = t.imageRef.indexOf('@sha256:');
    parts.push(at >= 0 ? `sha256:${t.imageRef.slice(at + 8, at + 20)}` : t.imageRef);
  }
  if (!t.imageRef && t.previousBuiltAt) parts.push(`last code's image built ${ago(t.previousBuiltAt)}`);
  if (t.status === 'failed' && t.attempts) parts.push(`${t.attempts} attempt${t.attempts === 1 ? '' : 's'}`);
  if (t.key) parts.push(`key ${t.key.slice(0, 12)}`);
  return parts.join(' · ');
}

function Tile({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className={TemplatesUI.tile}>
      <div className={TemplatesUI.tileLabel}>{label}</div>
      <div id={id} className={TemplatesUI.tileValue}>{value}</div>
    </div>
  );
}

function TemplateItem({ t, canWrite, busy, onRebuild }: {
  t: TemplateRow; canWrite: boolean; busy: boolean; onRebuild: (id: string) => void;
}) {
  const chip = STATUSES[t.status] || { label: t.status, cls: AdminUI.badge.default };
  const building = t.status === 'building';
  return (
    <div className={TemplatesUI.row} data-template-id={t.id} data-template-status={t.status}>
      <span className={TemplatesUI.rowMain}>
        <span className={TemplatesUI.rowTitle}>{t.title}</span>
        <code className={TemplatesUI.rowId}>{t.id}</code>
        <span className={TemplatesUI.rowMeta}>{meta(t)}</span>
        {t.error ? <span className={TemplatesUI.rowError}>{t.error.slice(-400)}</span> : null}
      </span>
      <span className={TemplatesUI.rowRight}>
        <span className={chip.cls}>{chip.label}</span>
        {canWrite && t.key ? (
          <button
            type="button"
            className={AdminUI.btn.outlineSm}
            data-template-rebuild={t.id}
            disabled={building || busy}
            onClick={() => onRebuild(t.id)}
          >
            Rebuild
          </button>
        ) : null}
      </span>
    </div>
  );
}

function TemplatesSection() {
  const canWrite = !!console_()?.canWrite();
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { data } = await console_().fetchJson(`/api/admin/templates${DEMO ? '?demo=1' : ''}`);
    if (!alive.current || !data || !Array.isArray(data.templates)) return;
    setListing(data as Listing);
  }, []);

  useEffect(() => { load(); }, [load]);

  // While anything is queued or building, read again; nothing to watch, no timer.
  const moving = !!listing?.templates.some((t) => t.status === 'building' || t.status === 'queued');
  useEffect(() => {
    if (!moving) return undefined;
    const timer = window.setInterval(() => { load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [moving, load]);

  const rebuild = useCallback(async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/admin/templates/${encodeURIComponent(id)}/rebuild`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console_()._alert((data && data.error) || `Rebuild not queued (HTTP ${res.status})`);
        return;
      }
      (window as any).PlatformUI?.toast?.('Rebuild queued. It starts within a minute.');
      if (alive.current && data && Array.isArray(data.templates)) setListing(data as Listing);
    } catch (err: any) {
      console_()._alert(`Rebuild not queued: ${err.message}`);
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);

  const rows = listing ? listing.templates : [];
  const count = (status: string) => rows.filter((t) => t.status === status).length;

  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={AdminUI.cardTitle}>Templates</h2>
        <button
          id="admin-refresh-templates"
          type="button"
          className={`${AdminUI.btn.link} text-xs`}
          onClick={() => load()}
        >
          Refresh
        </button>
      </div>
      <p className={TemplatesUI.lede}>
        Each ready-made app&apos;s image is built ahead of time, so a project made
        from it starts without building its own. It is built again whenever the
        template&apos;s code changes. Rebuild builds the current code afresh; the
        ready image stays in use until the new one replaces it.
      </p>
      {listing && !listing.prebuilds && !listing.demo ? (
        <p id="admin-templates-off" className={TemplatesUI.off}>
          Images are not built here (a staging preview, or STARTER_PREBUILDS=off),
          so new projects build their own.
        </p>
      ) : null}
      {listing?.demo ? (
        <p className="text-xs text-violet-700 dark:text-violet-400 mb-3">Staging demo data</p>
      ) : null}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <Tile id="admin-templates-ready" label="Ready" value={listing ? `${count('ready')} of ${rows.length}` : '—'} />
        <Tile id="admin-templates-building" label="Building or queued" value={listing ? String(count('building') + count('queued') + count('missing')) : '—'} />
        <Tile id="admin-templates-failed" label="Failed" value={listing ? String(count('failed')) : '—'} />
      </div>
      {!listing ? <p className={AdminUI.loading}>Loading…</p> : null}
      <div id="admin-templates-list" className="space-y-2">
        {rows.map((t) => (
          <TemplateItem key={t.id} t={t} canWrite={canWrite} busy={busy !== null} onRebuild={rebuild} />
        ))}
      </div>
      {!canWrite && listing ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3">
          View-only admin: you can see where each image stands, but not rebuild one.
        </p>
      ) : null}
    </div>
  );
}

let host: Element | null = null;

const AdminTemplates = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <TemplatesSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded for the SSG prerender.
if (typeof window !== 'undefined') (window as any).AdminTemplates = AdminTemplates;

export { AdminTemplates };
