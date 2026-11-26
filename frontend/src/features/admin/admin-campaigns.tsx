'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { linkAttrs } from '../../lib/repo-link.js';
// The shared admin kit (26 Nov 2026): header, figures, fields, list and
// badges are the same parts every other admin page is drawn with.
import { Badge, Figures, Input, List, ScreenHeader, Textarea } from './topochain/ui.tsx';
import type { Column, Figure } from './topochain/ui.tsx';
import { BTN } from './topochain/tokens.ts';

// Maintenance campaigns section of the admin console (#860, #853) — the one
// block on the retired standalone /admin page that the console never picked
// up, ported into #admin/campaigns.
//
// Fleet-wide platform maintenance: "New campaign" here only PROPOSES — it
// opens a kind='maintenance_campaign' governance issue on the platform app,
// and the engine starts when that vote passes (or an admin force-applies
// the proposal). This section tracks per-app fan-out progress and offers
// retry / re-run-checks / merge-all-green once PRs exist, and Stop while it
// runs. Each move is an event on the campaign machine (src/workflow/campaign/).
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
// campaign form, no Retry, no Re-run checks, no Merge-all-green and no Stop. The
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
  // Its proposal's status (merge-all-green forces only those in review).
  sessionStatus?: string;
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

// Waiting for room to change its next app (src/workflow/campaign/machine.ts
// holdFor): the platform at the session limit's warning line, or the most
// of its own proposals it keeps up for a vote at once.
interface CampaignHold {
  reason: 'platform' | 'window';
  since: string;
  used: number;
  limit: number;
  ceiling: number;
  open: number;
  maxOpen: number;
}

interface CampaignDetail extends Campaign {
  instructions?: string;
  apps?: CampaignApp[];
  held?: CampaignHold | null;
  // Merging each of its proposals as soon as its checks pass: since when, by whom.
  autoMerge?: { at: string | null; by: string | null } | null;
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

// An app's state: the campaign's own record, or (merged, closed) what came
// of its proposal. It is repeated down a campaign's apps, so it takes the
// kit's soft tones, and red only for a failure.
const APP_BADGE: ReadonlyMap<string, [string, string]> = new Map([
  ['pending', ['zinc', 'Pending']],
  ['running', ['sky', 'Running']],
  ['pr_open', ['sky', 'PR open']],
  ['merged', ['mint', 'Merged']],
  ['closed', ['zinc', 'Closed']],
  ['underway', ['zinc', 'Back underway']],
  ['skipped', ['zinc', 'Skipped']],
  ['failed', ['red', 'Failed']],
  ['stopped', ['zinc', 'Not reached']],
]);

function AppBadge({ state }: { state?: string }) {
  const [tone, label] = (state && APP_BADGE.get(state)) || ['zinc', state || '—'];
  return <Badge tone={tone} label={label} />;
}

// A campaign's own status, beside its number in the header.
const CAMPAIGN_TONE: ReadonlyMap<string, string> = new Map([['running', 'sky'], ['done', 'mint']]);

const CHECK_CLASS = (s?: string) => (s === 'passing' ? 'text-green-800 dark:text-green-400'
  : (s === 'failing' || s === 'error') ? 'text-red-700 dark:text-red-400'
    : 'text-zinc-500 dark:text-zinc-400');

// POST one session recheck; resolves when the server accepted it (including
// the "already running" coalesce response).
async function postRecheck(sessionId: number | string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/recheck`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

type AppRowProps = { app: CampaignApp; campaignId: number; write: boolean; stopped: boolean; onDone: () => void };

function showsRetry({ app, write, stopped }: AppRowProps): boolean {
  return write && !stopped && (app.state === 'failed' || app.state === 'skipped');
}

// Failing/error checks on an open campaign PR: offer the same manual re-run
// as the proposal card (#447). POSTs to the session recheck endpoint, which
// stamps 'pending' and rebuilds staging if the preview is gone. The 8s
// poll refreshes the row.
function showsRecheck({ app, write }: AppRowProps): boolean {
  return !!(write && app.state === 'pr_open' && app.sessionId
    && (app.checkState === 'failing' || app.checkState === 'error'));
}

// One app's two actions, with the label each shows while it is under way.
function AppActions(props: AppRowProps) {
  const { app, campaignId, onDone } = props;
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

  return (
    <>
      {showsRecheck(props) ? (
        <button type="button" className={`campaign-recheck-btn ${BTN.row}`}
          disabled={busy === 'recheck'} onClick={recheck}>
          {busy === 'recheck' ? 'Rechecking…' : 'Re-run checks'}
        </button>
      ) : null}
      {showsRetry(props) ? (
        <button type="button" className={`campaign-retry-btn ${BTN.row}`}
          disabled={busy === 'retry'} onClick={retry}>
          {busy === 'retry' ? 'Retrying…' : 'Retry'}
        </button>
      ) : null}
    </>
  );
}

// A campaign's apps are plain records, so they are the shared list.
const APP_COLUMNS: Column<CampaignApp>[] = [
  {
    label: 'App',
    primary: true,
    cell: (app) => (
      <>
        <span className="font-mono text-sm">{app.slug}</span>
        {app.error ? <span className="block text-xs font-normal text-red-700 dark:text-red-400 mt-0.5 break-words">{app.error}</span> : null}
      </>
    ),
  },
  {
    label: 'PR',
    cell: (app) => {
      // A change kept in Homeroom opens its page here; a pull request on GitHub
      // in a new tab (lib/repo-link.js).
      const prLink = app.prUrl ? linkAttrs(app.prUrl) : null;
      return prLink ? (
        <a href={prLink.href} target={prLink.target} rel={prLink.rel}
          className="text-violet-700 dark:text-violet-400 hover:underline text-xs">
          {`PR #${app.prNumber || '?'}`}
        </a>
      ) : null;
    },
  },
  {
    label: 'Checks',
    cell: (app) => (app.checkState
      ? <span className={`text-xs ${CHECK_CLASS(app.checkState)}`}>{`checks: ${app.checkState}`}</span>
      : null),
  },
  { label: 'State', cell: (app) => <AppBadge state={app.state} /> },
];

function CampaignRow({
  c, open, write, tick, onToggle, onReloadList,
}: {
  c: Campaign; open: boolean; write: boolean; tick: number;
  onToggle: (id: number) => void; onReloadList: () => void;
}) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [merging, setMerging] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
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
  // force-merge (mirrors the campaign machine's facts, campaign/facts.ts readGreen).
  const green = apps.filter((a) => a.state === 'pr_open' && a.sessionStatus === 'promoted'
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
        setStatus(`Queued rechecks, ${bad ? `${bad} failed to queue, ` : ''}watching for results…`);
      }
    }
    if (!alive.current) return;
    setRecheckingAll(false);
    refresh();
  };

  const mergeGreen = async () => {
    const ok = await confirmMsg({
      title: 'Merge all green?',
      message: 'Force-merge every campaign PR whose checks pass now? Each merges as soon as its app\'s merge queue can, and triggers a production rebuild of that app.',
      confirmLabel: 'Merge all green',
      destructive: true,
    });
    if (!ok) return;
    setMerging(true);
    try {
      const res = await fetch(`/api/campaigns/${c.id}/merge-green`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const forced = Array.isArray(data.forced) ? data.forced.length : 0;
      if (alive.current) setStatus(data.pending ? 'Merge all green asked; the rows show each merge as it lands.'
        : `${forced} forced; the rows show each merge as it lands.`);
    } catch (err: any) {
      alertMsg(`Merge-green failed: ${err.message}`);
    }
    if (!alive.current) return;
    setMerging(false);
    onReloadList();
  };

  const stop = async () => {
    const ok = await confirmMsg({
      title: 'Stop this campaign?',
      message: 'No further app gets a change, and the one being changed now is abandoned. The PRs already opened stay up for their vote.',
      confirmLabel: 'Stop campaign',
      destructive: true,
    });
    if (!ok) return;
    setStopping(true);
    try {
      const res = await fetch(`/api/campaigns/${c.id}/stop`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err: any) {
      alertMsg(`Stop failed: ${err.message}`);
    }
    if (!alive.current) return;
    setStopping(false);
    refresh();
    onReloadList();
  };

  // A stopped campaign goes on with the apps the stop never reached, at the
  // pace its room allows (src/workflow/campaign/machine.ts holdFor).
  const notReached = apps.filter((a) => a.state === 'stopped').length;
  const resume = async () => {
    const ok = await confirmMsg({
      title: 'Resume this campaign?',
      message: `It goes on with the ${notReached} app${notReached === 1 ? '' : 's'} the stop never reached, one at a time, `
        + 'and waits whenever the platform is near its session limit or 10 of its proposals are up for a vote.',
      confirmLabel: 'Resume campaign',
    });
    if (!ok) return;
    setResuming(true);
    try {
      const res = await fetch(`/api/campaigns/${c.id}/resume`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err: any) {
      alertMsg(`Resume failed: ${err.message}`);
    }
    if (!alive.current) return;
    setResuming(false);
    refresh();
    onReloadList();
  };

  // Auto-merge: the campaign merges each of its proposals as soon as its
  // checks pass (src/workflow/campaign/machine.ts autoMerged), so a long one
  // runs through without anyone pressing "Merge all green" again.
  const openCount = apps.filter((a) => a.state === 'pr_open').length;
  const autoOn = !!detail?.autoMerge;
  const setAutoMerge = async (on: boolean) => {
    if (on) {
      const ok = await confirmMsg({
        title: 'Auto-merge green proposals?',
        message: 'Each of this campaign\'s proposals is merged as soon as its checks pass, without waiting for its vote, '
          + 'until you turn this off. It is the same merge as "Merge all green", in your name.',
        confirmLabel: 'Turn on auto-merge',
      });
      if (!ok) return;
    }
    setAutoSaving(true);
    try {
      const res = await fetch(`/api/campaigns/${c.id}/auto-merge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err: any) {
      alertMsg(`Auto-merge failed: ${err.message}`);
    }
    if (!alive.current) return;
    setAutoSaving(false);
    refresh();
  };

  const detailId = `admin-campaign-${c.id}-detail`;

  return (
    <div className={`${AdminUI.card} p-3`} id={`admin-campaign-${c.id}`}>
      {/* A real button, like the console's other expanders (Merges' run-head,
          account deletions), so the header opens from the keyboard and says
          whether it is open. Its children are spans: a button holds phrasing
          content only. */}
      <button type="button" className="w-full text-start flex items-center justify-between gap-3 cursor-pointer"
        data-campaign-toggle={c.id} aria-expanded={open} aria-controls={detailId}
        onClick={() => onToggle(c.id)}>
        <span className="block min-w-0">
          <span className="block font-medium truncate">{c.title}</span>
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            {`#${c.id} · `}<Badge tone={CAMPAIGN_TONE.get(c.status) || 'zinc'} label={c.status} />
            {` · by ${c.created_by_username || 'platform'} · ${new Date(c.created_at).toLocaleString()}`}
          </span>
        </span>
        <span className="block text-xs font-mono shrink-0">
          {`${c.merged_apps}/${c.total_apps} merged`}
          {c.failed_apps ? <>{' · '}<span className="text-red-700 dark:text-red-400">{`${c.failed_apps} failed`}</span></> : null}
        </span>
      </button>
      <div id={detailId} className={`mt-2${open ? '' : ' hidden'}`} data-campaign-detail={c.id}>
        {failed ? <p className="text-xs text-red-700 dark:text-red-400">Failed to load campaign detail.</p> : null}
        {!failed && detail ? (
          <>
            <details className="mb-2">
              <summary className="text-xs text-zinc-500 dark:text-zinc-400 cursor-pointer">Instructions</summary>
              <pre className="text-xs text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap mt-1 p-2 rounded bg-zinc-100 dark:bg-zinc-800 max-h-48 overflow-y-auto">
                {detail.instructions || ''}
              </pre>
            </details>
            {autoOn ? (
              <p className="campaign-auto-merge-on text-xs text-zinc-500 dark:text-zinc-400 mb-2">
                {`Auto-merge is on${detail.autoMerge?.by ? ` (turned on by ${detail.autoMerge.by})` : ''}: each proposal merges as soon as its checks pass.`}
              </p>
            ) : null}
            {detail.status === 'running' && detail.held ? (
              <p className="campaign-held text-xs text-amber-800 dark:text-amber-400 mb-2">
                {detail.held.reason === 'platform'
                  ? `Waiting for room: ${detail.held.used} of ${detail.held.limit} sessions are in use, and it changes its next app only below ${detail.held.ceiling}.`
                  : `Waiting: ${detail.held.open} of its proposals are up for a vote, the most it keeps open at once (${detail.held.maxOpen}). Merging or closing them lets it go on.`}
              </p>
            ) : null}
            {apps.length ? (
              <List<CampaignApp>
                items={apps}
                columns={APP_COLUMNS}
                rowKey={(a) => a.appId}
                actions={(a) => {
                  const row = { app: a, campaignId: c.id, write, stopped: detail.status === 'cancelled', onDone: refresh };
                  // Nothing to offer on this row: say so, and the list draws
                  // no actions column when no row has one.
                  return showsRecheck(row) || showsRetry(row) ? <AppActions {...row} /> : null;
                }}
              />
            ) : <p className="text-xs text-zinc-500 dark:text-zinc-400">No target apps.</p>}
            <div className="flex items-center justify-end gap-2 mt-2">
              <span className="campaign-detail-status text-xs text-zinc-500 dark:text-zinc-400">{status}</span>
              {write && failingChecks.length > 0 ? (
                <button type="button" className={`campaign-recheck-all-btn ${AdminUI.btn.primarySm}`}
                  disabled={recheckingAll} onClick={recheckAll}>
                  {recheckingAll ? 'Rechecking…' : `Re-run failing checks (${failingChecks.length})`}
                </button>
              ) : null}
              {write && detail.status === 'running' ? (
                <button type="button" className={`campaign-stop-btn ${AdminUI.btn.destructiveSm}`}
                  disabled={stopping} onClick={stop}>
                  {stopping ? 'Stopping…' : 'Stop campaign'}
                </button>
              ) : null}
              {write && detail.status === 'cancelled' && notReached > 0 ? (
                <button type="button" className={`campaign-resume-btn ${AdminUI.btn.primarySm}`}
                  disabled={resuming} onClick={resume}>
                  {resuming ? 'Resuming…' : `Resume campaign (${notReached} not reached)`}
                </button>
              ) : null}
              {write && (autoOn || openCount > 0 || detail.status === 'running') ? (
                <button type="button" className={`campaign-auto-merge-btn ${autoOn ? AdminUI.btn.outlineSm : AdminUI.btn.primarySm}`}
                  disabled={autoSaving} onClick={() => setAutoMerge(!autoOn)}>
                  {autoSaving ? 'Saving…' : autoOn ? 'Turn off auto-merge' : 'Auto-merge green'}
                </button>
              ) : null}
              {write && green > 0 ? (
                <button type="button" disabled={merging} onClick={mergeGreen}
                  className={`campaign-merge-green-btn ${AdminUI.btn.primarySm}`}>
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
      if (!slug) throw new Error('Platform self-app not found. Is self-hosting configured?');
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
        msg: 'Proposal opened on the platform app. The campaign starts when the vote passes (or an admin applies it).',
        ok: true,
      });
      setTitle(''); setInstructions(''); setTargets('');
    } catch (err: any) {
      if (alive.current) setFormStatus({ msg: `Propose failed: ${err.message}`, ok: false });
    } finally {
      if (alive.current) setSubmitting(false);
    }
  };

  // Counts the list already carries: nothing more is read for them.
  const figures: Figure[] = [
    { key: 'campaigns', label: 'Campaigns', value: loaded ? campaigns.length.toLocaleString() : null, tone: 'sky' },
    {
      key: 'running',
      label: 'Running',
      value: loaded ? campaigns.filter((c) => c.status === 'running').length.toLocaleString() : null,
      tone: 'green',
    },
    {
      key: 'failed',
      label: 'Apps failed',
      value: loaded ? campaigns.reduce((sum, c) => sum + (Number(c.failed_apps) || 0), 0).toLocaleString() : null,
      tone: 'yellow',
    },
  ];

  return (
    <div id="admin-campaigns-root">
      <ScreenHeader
        title="Maintenance campaigns"
        subtitle="Fleet-wide platform maintenance. A campaign fans one set of AI instructions out across every app as its own PR; this list tracks per-app progress."
        actions={(
          <>
            <button id="admin-refresh-campaigns" type="button" className={AdminUI.btn.outlineSm}
              onClick={loadCampaigns}>Refresh</button>
            {write ? (
              <button id="admin-new-campaign-btn" type="button" className={AdminUI.btn.primarySm}
                onClick={() => setFormOpen((v) => !v)}>New campaign</button>
            ) : null}
          </>
        )}
      />
      <Figures id="admin-campaign-figures" items={figures} />
      {write ? (
        <div id="admin-campaign-form" className={`${formOpen ? '' : 'hidden '}${AdminUI.card} mb-4 p-4 space-y-2`}>
          <Input id="admin-campaign-title" type="text" maxLength={200}
            placeholder="Campaign title, becomes each app's PR title"
            value={title} onChange={(e) => setTitle(e.target.value)} />
          <Textarea id="admin-campaign-instructions" rows={6} maxLength={20000}
            placeholder="Instructions for the AI: what to change in each app, with code snippets where helpful. The AI reads each repo and applies these per-app."
            value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          <Input id="admin-campaign-targets" type="text" className="font-mono"
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
            className={formStatus ? `text-xs ${formStatus.ok ? 'text-green-800 dark:text-green-400' : 'text-red-700 dark:text-red-400'}` : 'text-xs hidden'}>
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
