'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Maintenance campaigns section of the admin console (#860, #853) — the one
// block on the retired standalone /admin page that the console never picked
// up, ported into #admin/campaigns.
//
// Fleet-wide platform maintenance: "New campaign" here only PROPOSES — it
// opens a kind='maintenance_campaign' governance issue on the platform app,
// and the engine starts when that vote passes (or an admin force-applies
// the proposal). This section tracks per-app fan-out progress and offers
// retry / re-run-checks / merge-all-green once PRs exist.
//
// The `#admin/campaigns/<id>` deep link is owned entirely by this module —
// read at mount so a link pre-expands that campaign, written back with
// replaceState on expand/collapse, guarded on '#admin/campaigns' — the same
// pattern admin-topochain.js uses for its sub-nav, rather than teaching
// admin-console.js general multi-level routing. The old `#campaign-<id>`
// form is mapped by public/admin.html's redirect stub.
//
// PERMISSIONS: visible to any admin (isAdmin — full and view-only); every
// mutating control is gated on AdminConsole.canWrite() (canAdminWrite), so
// a view-only admin sees the list and the per-app states but no New
// campaign form, no Retry, no Re-run checks and no Merge-all-green. The
// server enforces this independently on /api/campaigns/*.
//
// ── React-owned (#1120 slice 11) ──────────────────────────────────────
//
// Sixth section through the seam, and the first that MUTATES. Three things
// the old shape was doing by hand that the conversion removes outright:
//
//   * Button state through the button. Retry, Re-run checks and Merge all
//     green each set `btn.disabled = true` and rewrote `btn.textContent`,
//     then relied on the next `refreshCampaignDetail()` to put the label
//     back — so an in-flight label survived exactly as long as nothing else
//     repainted. Those are three pieces of row state now.
//   * A poll that had to know what the UI was doing. The 8s tick skipped any
//     detail containing `.campaign-merge-green-btn:disabled`, by
//     querySelector, because refreshing mid-merge wiped the in-progress
//     buttons it had just written. The row simply does not refetch while it
//     is merging.
//   * `campaign-detail-status`, found with
//     `btn.closest('div')?.querySelector('.campaign-detail-status')` — a
//     sibling lookup that depended on the exact wrapper the template emitted.
//
// The expanded set stays a Set, because the deep link and the poll both
// address campaigns by id and more than one can be open at once.

interface CampaignApp {
  appId: number;
  slug: string;
  state?: string;
  prUrl?: string;
  prNumber?: number;
  checkState?: string;
  sessionId?: number;
  error?: string;
}

interface Campaign {
  id: number;
  title: string;
  status: string;
  created_by_username?: string;
  created_at: string;
  merged_apps: number;
  total_apps: number;
  failed_apps?: number;
}

interface CampaignDetail extends Campaign {
  instructions?: string;
  apps?: CampaignApp[];
}

const canWrite = () => !!(typeof window !== 'undefined'
  && (window as any).AdminConsole && (window as any).AdminConsole.canWrite());

// Reuse the console's non-throwing fetch helper: an /api/* route that falls
// through to the SPA shell on auth loss returns 200 + HTML, and res.json() on
// that throws.
async function fetchJson(url: string): Promise<{ status: number; ok: boolean; data: any }> {
  const console_ = typeof window !== 'undefined' ? (window as any).AdminConsole : null;
  if (console_?.fetchJson) return console_.fetchJson(url);
  try {
    const res = await fetch(url);
    if (!res.ok) return { status: res.status, ok: false, data: null };
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { status: res.status, ok: true, data: null };
    return { status: res.status, ok: true, data: await res.json().catch(() => null) };
  } catch {
    return { status: 0, ok: false, data: null };
  }
}

function alertMsg(message: string): void {
  const ui = typeof window !== 'undefined' ? (window as any).PlatformUI : null;
  if (ui?.alert) ui.alert({ title: 'Maintenance campaigns', message: String(message) });
  else { try { window.alert(message); } catch { /* headless */ } }
}

async function confirmMsg(opts: Record<string, unknown>): Promise<boolean> {
  const ui = typeof window !== 'undefined' ? (window as any).PlatformUI : null;
  if (ui?.confirm) return ui.confirm(opts);
  try {
    return window.confirm([opts.title, opts.message].filter(Boolean).join('\n\n'));
  } catch { return false; }
}

// ── Sub-hash (#admin/campaigns/<id>) ─────────────────────────────────
function readSubId(): number | null {
  const m = String(location.hash || '').match(/^#admin\/campaigns\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function writeSubHash(id: number | null): void {
  if (!String(location.hash || '').startsWith('#admin/campaigns')) return;
  const target = id ? `#admin/campaigns/${id}` : '#admin/campaigns';
  if (location.hash !== target) history.replaceState(null, '', target);
}

const APP_BADGE: Record<string, [string, string]> = {
  pending: ['bg-zinc-500/10 text-zinc-500', 'Pending'],
  running: ['bg-violet-500/10 text-violet-500', 'Running'],
  pr_open: ['bg-sky-500/10 text-sky-600 dark:text-sky-400', 'PR open'],
  merged: ['bg-green-500/10 text-green-600 dark:text-green-400', 'Merged'],
  skipped: ['bg-zinc-500/10 text-zinc-400', 'Skipped'],
  failed: ['bg-red-500/10 text-red-500', 'Failed'],
};

function AppBadge({ state }: { state?: string }) {
  const [cls, label] = (state && APP_BADGE[state]) || ['bg-zinc-500/10 text-zinc-400', state || '—'];
  return (
    <span className={`text-[0.65rem] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${cls} shrink-0`}>
      {label}
    </span>
  );
}

const CHECK_CLASS = (s?: string) => (s === 'passing' ? 'text-green-500'
  : (s === 'failing' || s === 'error') ? 'text-red-500 dark:text-red-400'
    : 'text-zinc-500 dark:text-zinc-400');

const ROW_LINK = 'text-xs text-violet-500 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-300 shrink-0';

// POST one session recheck; resolves when the server accepted it (including
// the "already running" coalesce response).
async function postRecheck(sessionId: number | string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/recheck`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

function AppRow({
  app, campaignId, write, onDone,
}: { app: CampaignApp; campaignId: number; write: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState<'' | 'retry' | 'recheck'>('');

  const retry = async () => {
    setBusy('retry');
    const res = await fetch(`/api/campaigns/${campaignId}/apps/${app.appId}/retry`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alertMsg(`Retry failed: ${data.error || `HTTP ${res.status}`}`);
    }
    onDone();
  };

  const recheck = async () => {
    setBusy('recheck');
    try {
      await postRecheck(app.sessionId!);
    } catch (err: any) {
      alertMsg(`Re-run checks failed: ${err.message}`);
    }
    onDone();
  };

  const showRetry = write && (app.state === 'failed' || app.state === 'skipped');
  // Failing/error checks on an open campaign PR: offer the same manual re-run
  // as the proposal card (#447). POSTs to the session recheck endpoint, which
  // stamps 'pending' and rebuilds staging if the preview is gone — the 8s
  // poll refreshes the row.
  const showRecheck = write && app.state === 'pr_open' && app.sessionId
    && (app.checkState === 'failing' || app.checkState === 'error');

  return (
    <li className="p-2 rounded bg-white dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-sm truncate">{app.slug}</span>
        <span className="flex items-center gap-2">
          {app.prUrl ? (
            <a href={app.prUrl} target="_blank" rel="noopener"
              className="text-violet-500 dark:text-violet-400 hover:underline text-xs">
              {`PR #${app.prNumber || '?'}`}
            </a>
          ) : null}
          {app.checkState ? <span className={`text-xs ${CHECK_CLASS(app.checkState)}`}>{`checks: ${app.checkState}`}</span> : null}
          <AppBadge state={app.state} />
          {showRecheck ? (
            <button type="button" className={`campaign-recheck-btn ${ROW_LINK}`}
              disabled={busy === 'recheck'} onClick={recheck}>
              {busy === 'recheck' ? 'Rechecking…' : 'Re-run checks'}
            </button>
          ) : null}
          {showRetry ? (
            <button type="button" className={`campaign-retry-btn ${ROW_LINK}`}
              disabled={busy === 'retry'} onClick={retry}>
              {busy === 'retry' ? 'Retrying…' : 'Retry'}
            </button>
          ) : null}
        </span>
      </div>
      {app.error ? <div className="text-xs text-red-500 dark:text-red-400 mt-0.5 break-words">{app.error}</div> : null}
    </li>
  );
}

function CampaignRow({
  c, open, write, tick, onToggle, onReloadList,
}: {
  c: Campaign; open: boolean; write: boolean; tick: number;
  onToggle: (id: number) => void; onReloadList: () => void;
}) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [merging, setMerging] = useState(false);
  const [recheckingAll, setRecheckingAll] = useState(false);
  const [status, setStatus] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    const { data } = await fetchJson(`/api/campaigns/${c.id}`);
    if (!alive.current) return;
    if (!data?.campaign) { setFailed(true); return; }
    setFailed(false);
    setDetail(data.campaign);
  }, [c.id]);

  // The poll's mid-flight guard, which used to be a
  // `.campaign-merge-green-btn:disabled` querySelector: a row that is merging
  // or queueing rechecks simply does not refetch.
  useEffect(() => {
    if (!open || merging || recheckingAll) return;
    refresh();
  }, [open, tick, merging, recheckingAll, refresh]);

  const apps = detail?.apps || [];
  // "Green" = open campaign PR whose checks pass — what merge-green will
  // force-merge (mirrors the server-side query in fleet-maintenance.mergeGreen).
  const green = apps.filter((a) => a.state === 'pr_open'
    && (a.checkState === 'passing' || a.checkState === 'skipped')).length;
  // Bulk companion to the per-row Re-run checks button. Each recheck is
  // fire-and-forget server-side; the loop below just queues them.
  const failingChecks = apps.filter((a) => a.state === 'pr_open' && a.sessionId
    && (a.checkState === 'failing' || a.checkState === 'error'));

  const recheckAll = async () => {
    setRecheckingAll(true);
    let bad = 0;
    for (const a of failingChecks) {
      try { await postRecheck(a.sessionId!); } catch { bad += 1; }
      if (alive.current) {
        setStatus(`Queued rechecks — ${bad ? `${bad} failed to queue, ` : ''}watching for results…`);
      }
    }
    if (!alive.current) return;
    setRecheckingAll(false);
    refresh();
  };

  const mergeGreen = async () => {
    const ok = await confirmMsg({
      title: 'Merge all green?',
      message: 'Force-merge every campaign PR whose checks pass? Each merge triggers a production rebuild of that app.',
      confirmLabel: 'Merge all green',
      destructive: true,
    });
    if (!ok) return;
    setMerging(true);
    setStatus('Merging sequentially — this can take a while…');
    try {
      const res = await fetch(`/api/campaigns/${c.id}/merge-green`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const merged = (data.results || []).filter((r: any) => r.merged).length;
      const bad = (data.results || []).length - merged;
      alertMsg(`Merge-green done: ${merged} merged${bad ? `, ${bad} failed (see per-app rows)` : ''}.`);
    } catch (err: any) {
      alertMsg(`Merge-green failed: ${err.message}`);
    }
    if (!alive.current) return;
    setMerging(false);
    onReloadList();
  };

  const statusCls = c.status === 'running' ? 'text-violet-500'
    : c.status === 'done' ? 'text-green-600 dark:text-green-400' : 'text-zinc-400';

  return (
    <div className="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3" id={`admin-campaign-${c.id}`}>
      <div className="flex items-center justify-between gap-3 cursor-pointer"
        data-campaign-toggle={c.id} onClick={() => onToggle(c.id)}>
        <div className="min-w-0">
          <div className="font-medium truncate">{c.title}</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {`#${c.id} · `}<span className={statusCls}>{c.status}</span>
            {` · by ${c.created_by_username || 'platform'} · ${new Date(c.created_at).toLocaleString()}`}
          </div>
        </div>
        <div className="text-xs font-mono shrink-0">
          {`${c.merged_apps}/${c.total_apps} merged`}
          {c.failed_apps ? <>{' · '}<span className="text-red-500">{`${c.failed_apps} failed`}</span></> : null}
        </div>
      </div>
      <div className={`mt-2${open ? '' : ' hidden'}`} data-campaign-detail={c.id}>
        {failed ? <p className="text-xs text-red-500 dark:text-red-400">Failed to load campaign detail.</p> : null}
        {!failed && detail ? (
          <>
            <details className="mb-2">
              <summary className="text-xs text-zinc-500 dark:text-zinc-400 cursor-pointer">Instructions</summary>
              <pre className="text-xs text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap mt-1 p-2 rounded bg-white dark:bg-zinc-900 max-h-48 overflow-y-auto">
                {detail.instructions || ''}
              </pre>
            </details>
            <ul className="space-y-1">
              {apps.length
                ? apps.map((a) => (
                  <AppRow key={a.appId} app={a} campaignId={c.id} write={write} onDone={refresh} />
                ))
                : <li className="text-xs text-zinc-500 dark:text-zinc-400">No target apps.</li>}
            </ul>
            <div className="flex items-center justify-end gap-2 mt-2">
              <span className="campaign-detail-status text-xs text-zinc-500 dark:text-zinc-400">{status}</span>
              {write && failingChecks.length > 0 ? (
                <button type="button" className={`campaign-recheck-all-btn ${AdminUI.btn.primarySm}`}
                  disabled={recheckingAll} onClick={recheckAll}>
                  {recheckingAll ? 'Rechecking…' : `Re-run failing checks (${failingChecks.length})`}
                </button>
              ) : null}
              {write && green > 0 ? (
                <button type="button" disabled={merging} onClick={mergeGreen}
                  className="campaign-merge-green-btn rounded-lg bg-green-600 hover:bg-green-500 px-3 py-1.5 text-xs font-medium text-white transition-colors">
                  {merging ? 'Merging…' : `Merge all green (${green})`}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

const FORM_INPUT = 'w-full rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm';

function CampaignsSection() {
  const write = canWrite();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    const deep = typeof window !== 'undefined' ? readSubId() : null;
    return new Set(deep ? [deep] : []);
  });
  const [tick, setTick] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [targets, setTargets] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formStatus, setFormStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadCampaigns = useCallback(async () => {
    const { data } = await fetchJson('/api/campaigns');
    if (!alive.current) return;
    setCampaigns(Array.isArray(data?.campaigns) ? data.campaigns : []);
    setLoaded(true);
  }, []);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  // Live progress while a fan-out runs: cheap per-campaign status poll, but
  // only for campaigns the admin has expanded — each open row listens for the
  // tick. Cleared on unmount, which destroy() causes.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 8000);
    return () => { clearInterval(timer); };
  }, []);

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      writeSubHash(next.has(id) ? id : (next.size ? Array.from(next)[0] : null));
      return next;
    });
  };

  const submit = async () => {
    const t = title.trim();
    const ins = instructions.trim();
    const raw = targets.trim();
    if (!t) { setFormStatus({ msg: 'Title is required.', ok: false }); return; }
    if (!ins) { setFormStatus({ msg: 'Instructions are required.', ok: false }); return; }
    const targetFilter = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;
    setSubmitting(true);
    try {
      // Campaign proposals live on the self-hosted platform app's issues
      // surface; resolve its slug first.
      const meta = await fetchJson('/api/campaigns/meta');
      const slug = meta.data?.selfAppSlug;
      if (!slug) throw new Error('Platform self-app not found — is self-hosting configured?');
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'maintenance_campaign',
          title: t,
          payload: { instructions: ins, ...(targetFilter ? { targetFilter } : {}) },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!alive.current) return;
      setFormStatus({
        msg: 'Proposal opened on the platform app — the campaign starts when the vote passes (or an admin applies it).',
        ok: true,
      });
      setTitle(''); setInstructions(''); setTargets('');
    } catch (err: any) {
      if (alive.current) setFormStatus({ msg: `Propose failed: ${err.message}`, ok: false });
    } finally {
      if (alive.current) setSubmitting(false);
    }
  };

  return (
    <div id="admin-campaigns-root" className={`${AdminUI.card} p-4`}>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h2 className={AdminUI.cardTitle}>Maintenance campaigns</h2>
        <div className="flex items-center gap-3">
          <button id="admin-refresh-campaigns" type="button" className={`${AdminUI.btn.link} text-xs`}
            onClick={loadCampaigns}>Refresh</button>
          {write ? (
            <button id="admin-new-campaign-btn" type="button" className={AdminUI.btn.primary}
              onClick={() => setFormOpen((v) => !v)}>New campaign</button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
        Fleet-wide platform maintenance. A campaign fans one set of AI instructions out across every app as its own PR;
        this list tracks per-app progress.
      </p>
      {write ? (
        <div id="admin-campaign-form" className={`${formOpen ? '' : 'hidden '}mb-4 rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3 space-y-2`}>
          <input id="admin-campaign-title" type="text" maxLength={200} className={FORM_INPUT}
            placeholder="Campaign title — becomes each app's PR title"
            value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea id="admin-campaign-instructions" rows={6} maxLength={20000} className={`${FORM_INPUT} font-mono`}
            placeholder="Instructions for the AI — what to change in each app, with code snippets where helpful. The AI reads each repo and applies these per-app."
            value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          <input id="admin-campaign-targets" type="text" className={`${FORM_INPUT} font-mono`}
            placeholder="Optional: comma-separated app slugs to target (blank = every app)"
            value={targets} onChange={(e) => setTargets(e.target.value)} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Submitting opens a governance proposal on the platform app. The campaign starts when the vote passes, or when an admin applies the proposal.
            </p>
            <button id="admin-campaign-submit-btn" type="button" className={`${AdminUI.btn.primary} shrink-0`}
              disabled={submitting} onClick={submit}>Propose campaign</button>
          </div>
          <p id="admin-campaign-form-status"
            className={formStatus ? `text-xs ${formStatus.ok ? 'text-green-500' : 'text-red-500 dark:text-red-400'}` : 'text-xs hidden'}>
            {formStatus ? formStatus.msg : ''}
          </p>
        </div>
      ) : null}
      <div id="admin-campaign-list" className="space-y-2">
        {campaigns.map((c) => (
          <CampaignRow key={c.id} c={c} write={write} tick={tick}
            open={expanded.has(c.id)} onToggle={toggle} onReloadList={loadCampaigns} />
        ))}
      </div>
      <p id="admin-campaign-empty"
        className={`text-sm text-zinc-500 dark:text-zinc-400${loaded && !campaigns.length ? '' : ' hidden'}`}>
        No campaigns yet.
      </p>
    </div>
  );
}

let host: Element | null = null;

const AdminCampaigns = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <CampaignsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminCampaigns = AdminCampaigns;

export { AdminCampaigns };
