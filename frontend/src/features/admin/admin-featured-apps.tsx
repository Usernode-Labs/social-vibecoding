'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Featured apps (#admin/featured-apps).
//
// The admin-curated row under "Featured apps" on every user's home screen
// (frontend/src/features/home/home.js renderFindMore). One global ordered
// list: GET /api/admin/featured-apps returns it plus every other app, and PUT
// rewrites it wholesale from an ordered slug array — so the ↑/↓/Remove
// controls only ever reorder a local array and Save persists it in one
// request. Under it, the flagged apps: the one editorial state an app has,
// which takes it out of Discover and Featured (DiscoverFlags).
//
// Featuring a view-private app is safe: the home row is derived from
// GET /api/apps, which is visibility-filtered per viewer, so people who can't
// see the app simply don't get the tile.
//
// PERMISSIONS: view-only admins get the list read-only (the controls are
// omitted); requireAdminWrite on the PUT is the real boundary.
//
// ── Third section out of the chassis (#1120 slice 18) ─────────────────
//
// Same move as admin-overview.tsx and admin-codes.tsx. What this one drops is
// the pending-edit machinery: `_featured`, `_featuredMeta`,
// `_featuredAvailable` and `_featuredDirty` were four properties hanging off
// the console object, mutated in place by `_moveFeatured` (an `arr.splice`
// pair) and read back by `_renderFeaturedList`, which then re-bound three
// button handlers and rebuilt the picker's `<option>` list by hand. The
// pending order is one piece of state, the dirty flag is derived from it, and
// the picker is a filter over the metadata.
//
// `_moveFeatured` keeps the splice-pair reorder verbatim, on a copy: it is the
// operation the ↑/↓ buttons mean, and reimplementing it as a swap would change
// the behaviour for a delta other than ±1.

interface AppMeta {
  slug: string;
  name?: string;
  status?: string;
  icon_emoji?: string;
  icon_url?: string;
  /** Where it stands in Discover (src/services/discovery-curation.js). */
  directory?: { state?: string; tier?: string; label?: string | null; flagged?: boolean };
  has_illustration?: boolean;
}

const FEATURED_MAX = 12;

const ROW = 'flex items-center gap-2 rounded-md bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2 py-1.5';
const MOVE_BTN = 'px-1.5 py-0.5 text-xs rounded text-zinc-500 dark:text-zinc-400 hover:text-violet-800 dark:hover:text-violet-300 disabled:opacity-30';
const ICON = 'w-7 h-7 rounded-md bg-violet-500/10 flex items-center justify-center shrink-0';

/**
 * Tiny icon preview so a row is recognisable at a glance: the same priority as
 * the home tile (custom image > emoji > first letter).
 */
function AppIcon({ meta }: { meta: AppMeta }) {
  if (meta.icon_url) return <img src={meta.icon_url} alt="" className="w-7 h-7 rounded-md object-cover shrink-0" />;
  if (meta.icon_emoji) return <span className={`${ICON} text-base`} aria-hidden="true">{meta.icon_emoji}</span>;
  return <span className={`${ICON} text-xs font-bold`}>{((meta.name || '?').charAt(0)).toUpperCase()}</span>;
}

/**
 * Flags a featured app whose Discover card has no illustration of its own and
 * so falls back to its icon (#2615). Drawn only on an explicit `false` from the
 * read, so a row whose data has not arrived yet claims nothing.
 */
function NoIllustrationBadge({ meta }: { meta: AppMeta }) {
  if (meta.has_illustration !== false) return null;
  return (
    <span className={`${AdminUI.badge.warn} shrink-0`} data-featured-no-illustration={meta.slug}
      title="Discover shows this app’s icon until a featured illustration is added from the app’s page.">
      No illustration
    </span>
  );
}

// What featuring needs: an icon for its card, and no flag. The PUT refuses
// anything else (src/routes/admin-featured-apps.js).
function canFeature(app: AppMeta): boolean {
  return !!(app.icon_url || app.icon_emoji) && !app.directory?.flagged;
}

/**
 * Flagging (src/services/discovery-curation.js): the one editorial state an
 * app has. A flagged app is left out of Discover and Featured everywhere, and
 * flagging a featured app takes it off the list in the same request. There is
 * no review to pass: an app with an icon and no flag can be featured.
 */
function DiscoverFlags({ apps, canWrite, onChanged }: {
  apps: AppMeta[];
  canWrite: boolean;
  onChanged: (slug: string, flagged: boolean) => void;
}) {
  const [pick, setPick] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const flagged = apps.filter((a) => a.directory?.flagged);
  const unflagged = apps.filter((a) => !a.directory?.flagged);
  const setFlag = async (app: AppMeta, next: boolean) => {
    const name = app.name || app.slug;
    if (next) {
      const ok = await (window as any).AdminConsole._confirm({
        title: `Flag ${name}?`,
        message: 'It leaves Discover and Featured everywhere at once, the signed-out landing included. Its members keep it, and it still opens from a link.',
        confirmLabel: 'Flag app',
        danger: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    setMessage(next ? 'Flagging…' : 'Clearing the flag…');
    try {
      const res = await fetch(`/api/admin/apps/${encodeURIComponent(app.slug)}/discover-flag`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flagged: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMessage(next
        ? `Flagged ${name}: it is out of Discover${data.unfeatured ? ' and off the featured list' : ''}.`
        : `Cleared the flag on ${name}: it is back in Discover. Add it above to feature it again.`);
      setPick('');
      onChanged(app.slug, next);
    } catch (err: any) {
      setMessage(`Not saved: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="mt-5 pt-4 border-t border-zinc-200 dark:border-zinc-800" data-discover-flags="">
      <h3 className={AdminUI.sectionTitle}>Flagged apps</h3>
      <p className={`${AdminUI.muted} mb-3`}>
        A flagged app is left out of Discover and Featured everywhere: Discover, Home’s Discover rail and the signed-out landing. Flagging a featured app takes it off the list. Nothing else changes: its members keep it and it still opens from a link.
      </p>
      <div className="space-y-2 mb-3" id="admin-flagged-list">
        {!flagged.length
          ? <p className={AdminUI.muted}>No app is flagged.</p>
          : flagged.map((a) => (
            <div key={a.slug} className={ROW} data-flagged-row={a.slug}>
              <AppIcon meta={a} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium truncate">{a.name || a.slug}</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{a.slug}</span>
              </span>
              {canWrite ? (
                <button type="button" className={AdminUI.btn.outlineSm} disabled={saving}
                  data-unflag={a.slug} onClick={() => setFlag(a, false)}>Clear flag</button>
              ) : null}
            </div>
          ))}
      </div>
      {canWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          <select id="admin-flag-picker" value={pick} onChange={(e) => setPick(e.target.value)}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1.5 text-sm max-w-[16rem]">
            <option value="">Flag an app…</option>
            {unflagged.map((a) => <option key={a.slug} value={a.slug}>{a.name || a.slug}</option>)}
          </select>
          <button id="admin-flag-add" type="button" className={AdminUI.btn.destructiveSm}
            disabled={saving || !unflagged.some((a) => a.slug === pick)}
            onClick={() => {
              const app = unflagged.find((a) => a.slug === pick);
              if (app) setFlag(app, true);
            }}>Flag</button>
        </div>
      ) : null}
      <p role="status" className={`${AdminUI.muted} mt-2`}>{message}</p>
    </section>
  );
}

function FeaturedAppsSection() {
  const canWrite = !!(window as any).AdminConsole?.canWrite();
  const [featured, setFeatured] = useState<string[] | null>(null);
  const [meta, setMeta] = useState<Record<string, AppMeta>>({});
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [pick, setPick] = useState('');
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (preserveOrder = false) => {
    try {
      const res = await fetch('/api/admin/featured-apps');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!alive.current) return;
      const next: Record<string, AppMeta> = {};
      for (const a of [...(data.featured || []), ...(data.available || [])]) next[a.slug] = a;
      setMeta(next);
      if (!preserveOrder) {
        setFeatured((data.featured || []).map((a: AppMeta) => a.slug));
        setDirty(false);
      }
      setError(null);
    } catch (err: any) {
      if (alive.current) setError(String(err && err.message ? err.message : err));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Verbatim from the module: a splice-out/splice-in pair rather than a swap,
  // so a delta other than ±1 would still mean "move to that index".
  const move = (slug: string, delta: number) => {
    setFeatured((prev) => {
      const arr = (prev || []).slice();
      const i = arr.indexOf(slug);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= arr.length) return prev;
      arr.splice(j, 0, arr.splice(i, 1)[0]);
      return arr;
    });
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setStatus('Saving…');
    try {
      const res = await fetch('/api/admin/featured-apps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slugs: featured || [] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!alive.current) return;
      setStatus('Saved. Live on every home screen.');
      setSaving(false);
      load();
    } catch (err: any) {
      if (!alive.current) return;
      setStatus(`Save failed: ${err.message}`);
      setSaving(false);
    }
  };

  const slugs = featured || [];
  // The picker holds everything not currently in the list — including rows the
  // admin just removed but hasn't saved yet, so an accidental removal is
  // undoable without a reload.
  const chosen = new Set(slugs);
  const allApps = Object.values(meta)
    .sort((x, y) => String(x.name || x.slug).toLowerCase()
      .localeCompare(String(y.name || y.slug).toLowerCase()));
  const pool = allApps.filter((a) => !chosen.has(a.slug) && canFeature(a));

  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={AdminUI.cardTitle}>Featured apps</h2>
        <button id="admin-featured-refresh" type="button" className={`${AdminUI.btn.link} text-xs`}
          disabled={saving} onClick={() => load()}>Refresh</button>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
        {`These apps appear in the “Featured apps” row and on the signed-out landing, in this order. Apps a user has already added or cannot see are left out. Up to ${FEATURED_MAX} apps, each with an icon; a flagged app cannot be featured.`}
      </p>
      <div id="admin-featured-list" className="space-y-2 mb-3">
        {error
          ? <p className="text-sm text-red-400">{`Failed to load featured apps (${error})`}</p>
          : featured == null
            ? <p className={AdminUI.loading}>Loading…</p>
            : !slugs.length
              ? <p className="text-sm text-zinc-500 dark:text-zinc-400">No featured apps: the home row is hidden for everyone.</p>
              : slugs.map((slug, i) => {
                const m = meta[slug] || { slug, name: slug };
                const label = m.name || slug;
                return (
                  <div key={slug} className={ROW} data-featured-row={slug}>
                    <span className="w-5 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">{i + 1}</span>
                    <AppIcon meta={m} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">{label}</span>
                      <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{slug}</span>
                      {m.directory?.label ? (
                        <span className="block text-xs text-amber-700 dark:text-amber-400">
                          {`${m.directory.label}. Not shown in Featured.`}
                        </span>
                      ) : null}
                    </span>
                    <NoIllustrationBadge meta={m} />
                    {canWrite ? (
                      <>
                        <button type="button" data-featured-up={slug} className={MOVE_BTN} title="Move up"
                          aria-label={`Move ${label} up`} disabled={i === 0}
                          onClick={() => move(slug, -1)}>↑</button>
                        <button type="button" data-featured-down={slug} className={MOVE_BTN} title="Move down"
                          aria-label={`Move ${label} down`} disabled={i === slugs.length - 1}
                          onClick={() => move(slug, 1)}>↓</button>
                        <button type="button" data-featured-remove={slug} title="Remove"
                          className="px-1.5 py-0.5 text-xs rounded text-zinc-500 dark:text-zinc-400 hover:text-red-400"
                          aria-label={`Remove ${label}`}
                          onClick={() => {
                            setFeatured((prev) => (prev || []).filter((s) => s !== slug));
                            setDirty(true);
                          }}>×</button>
                      </>
                    ) : null}
                  </div>
                );
              })}
      </div>
      {canWrite ? (
        <>
          <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-zinc-200 dark:border-zinc-800">
            <select id="admin-featured-picker" value={pick} onChange={(e) => setPick(e.target.value)}
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1.5 text-sm max-w-[16rem]">
              <option value="">Add an app…</option>
              {pool.map((a) => <option key={a.slug} value={a.slug}>{a.name || a.slug}</option>)}
            </select>
            <button id="admin-featured-add" type="button"
              disabled={!pool.some((a) => a.slug === pick) || saving}
              className="px-3 py-1.5 rounded-md bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-sm"
              onClick={() => {
                if (!pool.some((a) => a.slug === pick)) return;
                if (slugs.length >= FEATURED_MAX) { setStatus(`At most ${FEATURED_MAX} apps.`); return; }
                setFeatured((prev) => (prev || []).concat([pick]));
                setDirty(true);
                setPick('');
              }}>Add</button>
            <span className="flex-1" />
            <button id="admin-featured-save" type="button" className={`${AdminUI.btn.primary} disabled:opacity-50`}
              disabled={!dirty || saving} onClick={save}>Save</button>
          </div>
          <p id="admin-featured-status" className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{status}</p>
        </>
      ) : (
        <p className="pt-3 border-t border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 dark:text-zinc-400">
          View-only admin: the list is read-only here.
        </p>
      )}
      <DiscoverFlags apps={allApps} canWrite={canWrite} onChanged={(slug, flagged) => {
        // A flag takes the app off the featured list on the server; take it
        // out of the unsaved order too, keeping the rest of it.
        if (flagged) setFeatured((prev) => (prev || []).filter((s) => s !== slug));
        load(true);
      }} />
    </div>
  );
}

let host: Element | null = null;

const AdminFeaturedApps = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <FeaturedAppsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminFeaturedApps = AdminFeaturedApps;

export { AdminFeaturedApps, DiscoverFlags, NoIllustrationBadge, canFeature };
