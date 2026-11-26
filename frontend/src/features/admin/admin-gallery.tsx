'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { changeHref } from '../../lib/change-href';
import { linkKind } from '../../lib/repo-link.js';
import { ShotsPanel } from '../review-flow/shots-panel';
// The console's shared page parts (26 Nov 2026): the header, figures, tabs,
// bar, fields and badges are the ones every admin page draws with.
import { BTN } from './topochain/tokens.ts';
import {
  Badge, EmptyState, ErrorState, Field, Figures, FormGrid, Input, Panel, ScreenHeader, Select,
  TabPanel, Tabs, Toolbar,
} from './topochain/ui.tsx';
import type { Figure } from './topochain/ui.tsx';

// Screenshot gallery section of the admin console (#860) — the retired
// standalone /gallery page, ported into #admin/gallery.
//
// A proposal's before & after shots are drawn by the one viewer every
// surface draws (../review-flow/shots-panel.tsx), so the gallery shows
// exactly what a reviewer sees. A capture from before shots keeps its tiles.
//
// Tiles are rendered by AppView.visualsTilesHtml in GALLERY MODE —
// { preload: 'none', overlay: false } — so recordings are click-to-play
// and the SPA-only comparison overlay isn't wired. Reusing that renderer
// is deliberate: the gallery must show exactly what a reviewer sees on a
// proposal card, including the fell-back / no-before captions, and a
// second renderer would drift. app-view.js is already loaded by the SPA
// shell, so the standalone page's own <script src="/js/app-view.js"> is
// gone.
//
// PERMISSIONS: admin-only, enforced by the inline `req.user?.isAdmin` 403
// gate on /api/gallery/* (src/routes/gallery.js). Read-only surface, so
// full and view-only admins both get it. The one exception is the shots-runs
// CSV link (ExportRuns below): a bulk download is write-gated server-side,
// so only a full admin is offered it.
//
// ── React-owned (#1120 slice 7) ───────────────────────────────────────
//
// Second section through the seam `admin-e2e.tsx` established: same
// `{ render(host), destroy() }` shape, `mountLegacyPortal` in place of the
// `innerHTML` assignment. What this one adds over the e2e report is that it
// FETCHES, so it is the section that shows what the conversion is actually
// worth:
//
//   * The four `hidden` toggles — the gate, the content wrapper, the stats
//     strip, the Load-older button and the empty note — were five
//     `classList.toggle` calls reaching for elements by id after every
//     request. They are all derived from state here, so a request that
//     resolves after the operator has left cannot leave one of them
//     inconsistent with the others.
//   * The `if (!$('admin-gallery-proposals')) return;` guards were a
//     hand-rolled is-this-still-mounted check on a torn-down section. A
//     mounted ref does the same job without depending on the id still
//     resolving to THIS mount of the section.
//   * The app filter's `<option>` list was built with `createElement` +
//     `appendChild` into a node the same module also rendered. It is data now.
//
// The one thing that stays a raw HTML string is the tiles, and deliberately:
// `AppView.visualsTilesHtml` is the renderer a reviewer sees on a proposal
// card and the gallery must not drift from it. In gallery mode its output is
// inert — `<figure>` elements around a native `<video controls>`, no handlers,
// no ids — so React renders it once through `dangerouslySetInnerHTML` and
// nothing writes into it afterwards. That is a React-owned host, not a
// legacy-filled one.

const PAGE_LIMIT = 20;

// Guarded for the SSG prerender pass, which evaluates this module in Node
// (#1082 chunk E). In the browser this is the same boolean as before.
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';

interface Cursor { before: string; before_id: number }

interface Visuals { [key: string]: unknown }

interface Proposal {
  id: number;
  title?: string;
  appId?: number;
  appName?: string;
  appSlug?: string;
  prUrl?: string;
  prNumber?: number;
  mergedAt?: string;
  captureState?: string;
  captureReason?: string;
  visuals?: Visuals;
  shots?: {
    state?: string;
    failureReason?: string;
    [key: string]: unknown;
  } | null;
}

interface Stats {
  total: number;
  complete?: number;
  missing_recording?: number;
  missing_before?: number;
  before_fell_back?: number;
  root_only?: number;
  failed_or_skipped?: number;
  unknown_state?: number;
  shots_verified?: number;
  relevance_failure?: number;
  replay_failure?: number;
  unsupported_agent?: number;
  override?: number;
}

interface AppOption { value: string; label: string }

interface Applied { app: string; problem: string; nonce: number }

async function getJSON(url: string): Promise<any> {
  const resp = await fetch(url, { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function filterParams(applied: Applied): URLSearchParams {
  const params = new URLSearchParams();
  if (applied.app) params.set('app', applied.app);
  if (applied.problem) params.set('problem', applied.problem);
  // Staging demo rows (src/routes/gallery.js) — the SPA form is
  // /?demo=1#admin/gallery, so the flag rides in location.search.
  if (DEMO) params.set('demo', '1');
  return params;
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Capture-state chip. A NULL state means the proposal merged before capture
// outcomes were persisted — render it as "unknown" rather than mislabelling
// it as a success or a failure.
// It is repeated down the list, so it wears the shared Badge's soft tones:
// captured is done, and only a partial or failed capture is loud.
const CHIP: Record<string, { label: string; tone: string }> = {
  captured: { label: 'Captured', tone: 'mint' },
  partial: { label: 'Partial', tone: 'amber' },
  console_only: { label: 'No visual change expected', tone: 'zinc' },
  failed: { label: 'Capture failed', tone: 'red' },
};
const CHIP_UNKNOWN = { label: 'Outcome unknown', tone: 'zinc' };

const PROBLEMS: Array<[string, string]> = [
  ['', 'Any'],
  ['missing_recording', 'Missing recording'],
  ['missing_before', 'Missing before side'],
  ['before_fell_back', 'Before fell back to home page'],
  ['root_only', 'Screenshots of the front page only'],
  ['failed_or_skipped', 'Capture failed or skipped'],
  ['relevance_failure', 'Screenshots not relevant'],
  ['replay_failure', 'Screenshots failed'],
  ['unsupported_agent', 'Unsupported screenshot agent'],
  ['override', 'Screenshots waived'],
];

// The run states the shots-runs export filters on (services/shots-export.js
// STATE_FILTERS). `in_progress` is every run still under way.
const EXPORT_STATES: Array<[string, string]> = [
  ['', 'All states'],
  ['failed', 'Failed'],
  ['verified', 'Verified'],
  ['in_progress', 'In progress'],
  ['stale', 'Stale (newer commit)'],
  ['cancelled', 'Cancelled'],
  ['not_required', 'Not required'],
  ['overridden', 'Waived'],
];

const DOT = <span className="text-zinc-500 dark:text-zinc-500">·</span>;

function Chip({ state, reason }: { state?: string; reason?: string }) {
  const chip = (state && CHIP[state]) || CHIP_UNKNOWN;
  // The reason is the badge's tooltip; the shared Badge takes no title.
  return <span title={reason || undefined}><Badge label={chip.label} tone={chip.tone} /></span>;
}

const LINK = 'text-violet-700 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-300';

function ProposalCard({ p }: { p: Proposal }) {
  const appView = typeof window !== 'undefined' ? (window as any).AppView : null;
  // A v2 record owns this proposal's visual story even while pending or
  // failed. Never fall back to a route-only capture that may show a different
  // screen. Shots are drawn by the one before & after viewer a reviewer sees
  // (review-flow/shots-panel.tsx); a capture from before shots by AppView's
  // tiles.
  const shots = p.shots && typeof p.shots === 'object' ? p.shots : null;
  const tiles: string = !shots && appView && p.visuals
    ? appView.visualsTilesHtml(p.visuals, { preload: 'none', overlay: false })
    : '';
  const appLabel = p.appName || p.appSlug || `app ${p.appId}`;
  const merged = fmtDate(p.mergedAt);

  const meta: React.ReactNode[] = [];
  // PR#N leaves for a pull request on GitHub (or code on the git host). A
  // change kept in Homeroom is plain text: "Open proposal" below is its page.
  const prKind = p.prUrl ? linkKind(p.prUrl) : null;
  if (p.prUrl && p.prNumber && (prKind === 'github' || prKind === 'code')) {
    meta.push(
      <a key="pr" href={p.prUrl} target="_blank" rel="noopener"
        className="font-mono text-violet-700 dark:text-violet-400 hover:underline">PR#{p.prNumber}</a>,
    );
  } else if (p.prNumber) {
    meta.push(<span key="pr" className="font-mono text-zinc-500 dark:text-zinc-400">PR#{p.prNumber}</span>);
  }
  if (merged) meta.push(<span key="date">{merged}</span>);
  if (p.appSlug) {
    meta.push(
      <a key="open" href={`/${changeHref(p.appSlug, p.id, p.prNumber)}`} className={LINK}>Open proposal →</a>,
    );
  }

  return (
    <article className={`${AdminUI.card} p-3`}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{p.title || `Proposal ${p.id}`}</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {p.appSlug ? <a href={`/#app/${p.appSlug}/dev`} className={LINK}>{appLabel}</a> : appLabel}
            {meta.length ? <> {DOT} </> : null}
            {meta.map((node, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <span key={i}>{i ? <> {DOT} </> : null}{node}</span>
            ))}
          </div>
        </div>
        <div className="shrink-0"><Chip
          state={p.shots
            ? (p.shots.state === 'verified' ? 'captured'
              : (p.shots.state === 'failed' ? 'failed' : 'partial'))
            : p.captureState}
          reason={(p.shots?.failureReason as string | undefined) || p.captureReason}
        /></div>
      </div>
      {/* No tiles is a real state, not an error: console_only / failed
          proposals legitimately stored nothing. Say which, using the
          persisted reason. */}
      {shots ? <ShotsPanel source={{ shots, sessionId: Number(p.id) }} />
        : tiles
        ? <div dangerouslySetInnerHTML={{ __html: tiles }} />
        : (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 py-2">
            {p.captureReason || 'No screenshots were stored for this proposal.'}
          </div>
        )}
    </article>
  );
}

// The four headline counts for the current filter, as the page's figures.
// They come from the stats read the page already makes; before it answers,
// or when it fails, each is a dash.
function statFigures(s: Stats | null): Figure[] {
  const share = (n: number) => (s && s.total ? ` (${Math.round((n / s.total) * 100)}%)` : '');
  const one = (key: string, label: string, n: number | undefined, tone: Figure['tone'], withShare: boolean): Figure => ({
    key, tone, label: `${label}${withShare ? share(n || 0) : ''}`, value: s ? (n || 0) : null,
  });
  return [
    one('total', 'matching proposals', s?.total, 'sky', false),
    one('complete', 'complete', s?.complete, 'green', true),
    one('shots_verified', 'preview captured', s?.shots_verified, 'green', true),
    one('failed_or_skipped', 'failed / skipped', s?.failed_or_skipped, 'yellow', true),
  ];
}

// The rest of the counts for the current filter: one for each kind of
// problem the Problem filter can pick.
function ProblemCounts({ s }: { s: Stats }) {
  const pct = (n: number) => (s.total ? Math.round((n / s.total) * 100) : 0);
  const item = (label: string, n: number) => (
    <span key={label}>
      <strong className="text-zinc-700 dark:text-zinc-200">{n}</strong>
      {` ${label}`}{s.total ? ` (${pct(n)}%)` : ''}
    </span>
  );
  return (
    <section
      className={`flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400 ${AdminUI.card} px-3 py-2`}
    >
      {item('missing recording', s.missing_recording || 0)}
      {item('missing before', s.missing_before || 0)}
      {item('before fell back', s.before_fell_back || 0)}
      {item('front page only', s.root_only || 0)}
      {item('relevance failures', s.relevance_failure || 0)}
      {item('replay failures', s.replay_failure || 0)}
      {item('unsupported agents', s.unsupported_agent || 0)}
      {item('overrides', s.override || 0)}
      {s.unknown_state ? item('outcome not recorded', s.unknown_state) : null}
    </section>
  );
}

// Every shots run as a CSV (GET /api/admin/shots/export.csv), for debugging
// successes and failures in bulk. Unlike the gallery around it, the file
// covers every proposal, merged or not: most failed runs never merge.
//
// A plain link, not a fetch, the same as the Homeroom bot's export: the
// endpoint streams the file and the browser receives a download better than
// a Blob assembled in page memory. The endpoint is requireAdminWrite, so a
// view-only admin gets a note where the link would be.
function ExportRuns({ app }: { app: string }) {
  const canWrite = typeof window !== 'undefined' && !!(window as any).AdminConsole?.canWrite();
  const [state, setState] = useState('');
  const [since, setSince] = useState('');

  const params = new URLSearchParams();
  // The App filter's value is the app's slug; an app listed by numeric id
  // (no slug) is not one the export can name, so it falls back to all apps.
  if (app && !/^\d+$/.test(app)) params.set('app', app);
  if (state) params.set('state', state);
  if (since) params.set('since', since);
  const qs = params.toString();
  const href = `/api/admin/shots/export.csv${qs ? `?${qs}` : ''}`;

  return (
    <div id="admin-gallery-export-panel">
      <Panel
        title="Export screenshot runs"
        subtitle="One row per before & after run on every proposal, merged or not, with its failure details, timings and token use. Uses the App filter on the Proposals tab. Runs that did not verify are removed after 30 days unless they are still a proposal's latest run."
        footer={canWrite ? (
          <a id="admin-gallery-export" className={BTN.secondarySm} href={href} download>
            Download CSV
          </a>
        ) : (
          <span id="admin-gallery-export-readonly" className="text-xs text-zinc-500 dark:text-zinc-400">
            Downloading needs full admin access.
          </span>
        )}
      >
        <FormGrid>
          <Field label="State" htmlFor="admin-gallery-export-state">
            <Select id="admin-gallery-export-state"
              value={state} onChange={(e) => setState(e.target.value)}>
              {EXPORT_STATES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </Select>
          </Field>
          <Field label="Since" htmlFor="admin-gallery-export-since">
            <Input id="admin-gallery-export-since" type="date"
              value={since} onChange={(e) => setSince(e.target.value)} />
          </Field>
        </FormGrid>
      </Panel>
    </div>
  );
}

// The page holds two jobs, so each has a tab (26 Nov 2026): the merged
// proposals and their shots, and the export of every run. The export sat
// between the filters and the list, pushing the list down the page.
type GalleryTab = 'proposals' | 'export';
const GALLERY_TABS_ID = 'admin-gallery-tabs';

function GallerySection() {
  const [gate, setGate] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [apps, setApps] = useState<AppOption[]>([]);
  const [app, setApp] = useState('');
  const [problem, setProblem] = useState('');
  // Apply and Refresh both commit the draft filters. `nonce` is what makes
  // Refresh reload when nothing about the filters changed — the old code got
  // that for free by calling loadFirstPage() directly.
  const [applied, setApplied] = useState<Applied>({ app: '', problem: '', nonce: 0 });
  const [items, setItems] = useState<Proposal[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<GalleryTab>('proposals');

  const alive = useRef(true);
  const cursor = useRef<Cursor | null>(null);
  const loading = useRef(false);

  useEffect(() => () => { alive.current = false; }, []);

  // Admin check up front. The /api/gallery/* endpoints are independently
  // enforced server-side; this is only for a clean in-section message. We do
  // NOT navigate away on failure — a transient 401 shouldn't bounce an admin,
  // and it keeps the section coherent under headless checks.
  useEffect(() => {
    (async () => {
      let me: any = null;
      try {
        me = await getJSON('/api/auth/me');
      } catch {
        if (alive.current) setGate('Sign in as an admin to view the screenshot gallery.');
        return;
      }
      if (!alive.current) return;
      if (!me.user?.isAdmin) {
        setGate('Admins only. This section shows before/after screenshots for merged proposals.');
        return;
      }
      setReady(true);
      try {
        const { apps: list } = await getJSON(`/api/gallery/apps${DEMO ? '?demo=1' : ''}`);
        if (!alive.current) return;
        setApps((list || []).map((a: any) => ({
          value: a.slug || String(a.id),
          label: `${a.name || a.slug} (${a.proposal_count})`,
        })));
      } catch { /* non-fatal — the filter just stays "All apps" */ }
    })();
  }, []);

  const loadPage = useCallback(async (append: boolean, forFilters: Applied) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const params = filterParams(forFilters);
      params.set('limit', String(PAGE_LIMIT));
      if (append && cursor.current) {
        params.set('before', cursor.current.before);
        params.set('before_id', String(cursor.current.before_id));
      }
      const data = await getJSON(`/api/gallery/proposals?${params.toString()}`);
      if (!alive.current) return;
      const page: Proposal[] = data.proposals || [];
      setItems((prev) => (append ? prev.concat(page) : page));
      cursor.current = data.nextCursor || null;
      setHasMore(!!data.hasMore);
      setError(null);
    } catch (err: any) {
      if (!alive.current) return;
      if (!append) {
        setItems([]);
        setError(String(err && err.message ? err.message : err));
      }
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    cursor.current = null;
    loadPage(false, applied);
    (async () => {
      try {
        const { stats: s } = await getJSON(`/api/gallery/stats?${filterParams(applied).toString()}`);
        if (alive.current) setStats(s && typeof s.total === 'number' ? s : null);
      } catch {
        if (alive.current) setStats(null);
      }
    })();
  }, [ready, applied, loadPage]);

  const commit = () => setApplied((prev) => ({ app, problem, nonce: prev.nonce + 1 }));

  return (
    <div id="admin-gallery-root">
      <ScreenHeader
        title="Before & after gallery"
        subtitle="Before & after screenshots of each declared change on merged proposals, newest first. Historical proposals retain their legacy capture diagnostics."
      />
      {gate ? <div id="admin-gallery-gate"><EmptyState title={gate} /></div> : null}

      {ready ? (
        <main id="admin-gallery-content">
          {/* The headline counts for the current filter */}
          <Figures id="admin-gallery-stats" items={statFigures(stats)} />
          <Tabs<GalleryTab>
            id={GALLERY_TABS_ID}
            label="Before & after gallery"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: 'proposals', label: 'Proposals' },
              { key: 'export', label: 'Export runs' },
            ]}
          />
          <TabPanel tabsId={GALLERY_TABS_ID} tab="proposals" active={tab === 'proposals'}>
            {/* The filters are the list's, so they sit in the bar over it. */}
            <Toolbar>
              <div className="w-full sm:w-64">
                <Field label="App" htmlFor="admin-gallery-f-app">
                  <Select id="admin-gallery-f-app"
                    value={app} onChange={(e) => setApp(e.target.value)}>
                    <option value="">All apps</option>
                    {apps.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="w-full sm:w-64">
                <Field label="Problem" htmlFor="admin-gallery-f-problem">
                  <Select id="admin-gallery-f-problem"
                    value={problem} onChange={(e) => setProblem(e.target.value)}>
                    {PROBLEMS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="flex flex-wrap gap-2 self-end">
                <button id="admin-gallery-apply" type="button" onClick={commit}
                  className={BTN.primarySm}>Apply</button>
                <button id="admin-gallery-refresh" type="button" onClick={commit}
                  className={BTN.secondarySm}>Refresh</button>
              </div>
            </Toolbar>

            <div className="space-y-4">
              {stats ? <ProblemCounts s={stats} /> : null}

              <div id="admin-gallery-proposals" className="space-y-4">
                {error
                  ? <ErrorState title="Failed to load the gallery" message={error} />
                  : items.map((p) => <ProposalCard key={p.id} p={p} />)}
              </div>

              {/* Paged by a cursor with no total of its own, so it stays a
                  button and is not the shared scroll-to-load foot. */}
              <div className="flex justify-center">
                {hasMore ? (
                  <button id="admin-gallery-load-older" type="button"
                    onClick={() => loadPage(true, applied)}
                    className={BTN.secondary}>Load older</button>
                ) : null}
              </div>
              {!error && !items.length ? (
                <div id="admin-gallery-empty">
                  <EmptyState title="No merged proposals match these filters yet." />
                </div>
              ) : null}
            </div>
          </TabPanel>
          <TabPanel tabsId={GALLERY_TABS_ID} tab="export" active={tab === 'export'}>
            <ExportRuns app={app} />
          </TabPanel>
        </main>
      ) : null}
    </div>
  );
}

let host: Element | null = null;

const AdminGallery = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <GallerySection />);
  },

  // No timers or body-level listeners of its own — the tiles are inert markup
  // inside the section host, so dropping the portal is all the teardown this
  // section needs. It is also what cancels the in-flight requests' effects:
  // the component's cleanup clears `alive`, so a response that lands after
  // the operator has left writes nothing.
  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminGallery = AdminGallery;

export { AdminGallery };
