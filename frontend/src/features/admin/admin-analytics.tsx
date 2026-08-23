'use strict';

import { useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Analytics section of the admin console (#860) — the retired standalone
// /dashboard page, ported into #admin/analytics.
//
// Every chart, tooltip, toggle and (?) explainer is carried over verbatim
// from public/js/dashboard.js + public/dashboard.html. Hand-rolled SVG, so
// there is still no chart-lib dependency.
//
// The chart container ids (#counters, #spend, #gu-mau, #pu-l4,
// #spend-distribution, …) are unchanged — dapp.json's rendered checks pin
// them, and nothing else in the SPA uses those ids. The page-level
// #gate / #content are #admin-analytics-gate / #admin-analytics-content,
// which are generic enough to collide. The .dc-hover / .dc-info styles live
// in public/css/app.css scoped under #admin-analytics-root.
//
// #898 moved the "Progress estimator accuracy" card OUT of this section into
// its own #admin/estimator section (admin-estimator.tsx): everything left
// here is USER analytics, governed by the "Include admin users" checkbox,
// whereas the estimator card is platform analytics that deliberately ignores
// that flag.
//
// PERMISSIONS: admin-only, like every /api/admin/analytics/* endpoint it
// reads (adminMiddleware in src/routes/dashboard.js). Both full and
// view-only admins can see it — it's a pure read surface with no
// mutating controls, so there is no canAdminWrite gate here.
//
// ── React-owned (#1120 slice 15) ──────────────────────────────────────
//
// Tenth section through the seam and the biggest chart surface in the
// console: fourteen renderers, twelve `innerHTML` hosts, four toggle groups
// wired by walking the DOM and rewriting `btn.className`, and one checkbox
// whose change handler refetched ten endpoints.
//
// The SVG geometry is unchanged, line for line — every `W`, `H`, `topPad`,
// `plot`, `bw` and every `.toFixed(1)` is the same arithmetic producing the
// same coordinates. What changed is what the arithmetic RETURNS: a `<rect>`
// element instead of a `<rect …>` string. A chart is the worst place to
// "improve" while converting, because a coordinate that moves by a pixel is
// invisible in a diff and invisible in a test.
//
// Two things the conversion actually removes:
//
//   * Four `wire*Toggle` functions that each queried `.spend-btn` /
//     `.zero-btn` / `.cohort-btn` / `.retalign-btn`, looped over the nodes and
//     assigned a full `className` string per button to move the active
//     highlight. That is one `<ToggleGroup>` reading one piece of state.
//   * `attachTooltip(el)` called at the foot of eight renderers, each time on
//     a container that had just been replaced, guarded by a `dataset.tipBound`
//     flag so the repeats were no-ops. One delegation on the section root now.
//
// And one thing it deliberately does NOT remove: `esc()`. The tooltip lives
// in `#dc-tip` on <body> — outside the section's overflow, and therefore
// outside React — and its content is assigned with `innerHTML`. Builder and
// user names go into those strings, so every one of them is still escaped by
// hand. That is the whole remaining raw-HTML surface of this file.

const fmtInt = (n: any) => (n == null ? '—' : Number(n).toLocaleString());
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0);

/** Escape for the tooltip strings ONLY — see the header. */
function esc(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Admin accent colour (#341). A single amber, layered as the "admin" marker
// on every colour-differentiated chart — verified unused in the existing
// palette (indigo #6366f1, periwinkle #818cf8, green #34d399, blue #60a5fa, and
// the kudos ramp). It only appears while the "Include admin users" box is
// ticked; with the box off every chart looks exactly as it did before.
const ADMIN_COLOR = '#f59e0b';

// #361: system-token spend colour for the Daily-spend chart. A distinct
// sky/cyan, clearly separate from platform indigo (#6366f1), user-key
// green (#34d399), and admin amber (#f59e0b).
//
// These constants are for the chart MARKS — bars, lines, legend swatches —
// where a saturated mid-tone is exactly right. They are NOT for text: as ink
// on the light card this cyan measures 2.4:1 and the amber 2.2:1, and both
// were being used for readout lines. The legend and readout text carry
// `text-cyan-700 dark:text-cyan-400` / `text-amber-700 dark:text-amber-400`
// instead — same hue family, readable on both grounds, and a class rather
// than an inline style so it can vary by theme at all.
const SYSTEM_COLOR = '#06b6d4';
const SPEND_PLATFORM = '#6366f1';
const SPEND_USERKEY = '#34d399';

const dollars = (c: any) => `$${(Number(c || 0) / 100).toFixed(2)}`;

// Both preferences below are read at module-EVALUATION time, which the SSG
// prerender pass performs in Node (#1082 chunk E) — hence the `typeof window`
// guard on each. The browser answer is unchanged: an absent key already meant
// `false`, which is also the default the guard yields.

// Include-admins checkbox (#1). Default OFF (exclude admins); persisted so an
// operator's preference survives reloads.
const ADMIN_KEY = 'dashIncludeAdmins';
const INITIAL_INCLUDE_ADMINS = typeof window !== 'undefined'
  && localStorage.getItem(ADMIN_KEY) === 'true';

// Whether the muted $0 (no-spend) bucket is drawn. Default OFF: the $0 block
// dwarfs the paid buckets, so hiding it makes the paid distribution readable.
const SPEND_DIST_ZERO_KEY = 'dashSpendDistIncludeZero';
const INITIAL_SPEND_DIST_ZERO = typeof window !== 'undefined'
  && localStorage.getItem(SPEND_DIST_ZERO_KEY) === 'true';

// ── Hover tooltip ─────────────────────────────────────────────
// Native SVG <title> tooltips are slow and only fire over the painted bar, so
// columns with a short/zero bar feel "dead". Instead each chart lays a
// full-height transparent hover rect over every column tagged with
// data-tip-id, and we look the rich HTML up from this store on hover. The
// floating div follows the cursor and flips to stay on-screen.
const tipStore: Record<string, string> = {};

function ensureTip(): HTMLElement {
  let t = document.getElementById('dc-tip');
  if (!t) {
    t = document.createElement('div');
    t.id = 'dc-tip';
    t.style.cssText = 'position:fixed;z-index:50;pointer-events:none;display:none;max-width:260px;';
    t.className = 'rounded-md bg-zinc-900 text-zinc-100 text-xs px-2 py-1.5 shadow-lg border border-zinc-700';
    document.body.appendChild(t);
  }
  return t;
}

/**
 * One mouse-following delegation on the section root, and its teardown. The
 * container is React's; the tooltip is not — the handler only ever writes
 * `#dc-tip`, never anything inside the container.
 */
function attachTooltip(container: HTMLElement): () => void {
  const tip = ensureTip();
  const onMove = (e: MouseEvent) => {
    const el = (e.target as Element)?.closest?.('[data-tip-id]') as HTMLElement | null;
    const html = el && tipStore[el.dataset.tipId as string];
    if (!html) { tip.style.display = 'none'; return; }
    tip.innerHTML = html;
    tip.style.display = 'block';
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  };
  const onLeave = () => { tip.style.display = 'none'; };
  container.addEventListener('mousemove', onMove);
  container.addEventListener('mouseleave', onLeave);
  return () => {
    container.removeEventListener('mousemove', onMove);
    container.removeEventListener('mouseleave', onLeave);
  };
}

// Show the floating tip anchored to an element's box (used for keyboard focus
// on the (?) icons, where there's no cursor to follow).
function showTipAt(el: Element, html: string): void {
  if (!html) return;
  const tip = ensureTip();
  tip.innerHTML = html;
  tip.style.display = 'block';
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let x = r.left;
  let y = r.bottom + 6;
  if (x + t.width > window.innerWidth) x = window.innerWidth - t.width - 4;
  if (y + t.height > window.innerHeight) y = r.top - t.height - 6;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}

/**
 * Register a chart's per-column tooltip copy. Effect rather than render: the
 * old code filled the store inside the `.map` that built the markup, so the
 * two could only agree because one pass produced both.
 */
function useTips(prefix: string, htmls: string[]): void {
  useEffect(() => {
    htmls.forEach((html, i) => { tipStore[`${prefix}-${i}`] = html; });
  });
}

// ── (?) info icons ────────────────────────────────────────────
// Plain-language explanation per chart/box. Keyed by the data-info attribute
// on each .dc-info icon in the markup below.
const INFO: Record<string, string> = {
  'include-admins': 'Admin accounts (including view-only admins) are excluded from every number on this page by default, so operator/test activity does not skew the stats. Tick this to include them.',
  counters: 'At-a-glance totals. WAU | MAU are two independent counts — distinct users active in the last 7 vs 30 days, not a ratio. "Promoted (open)" is sessions live in promoted/merging right now; the all-time counts never leave their bucket.',
  spend: 'LLM spend per day for the last 30 days. <b>Platform key</b> is spend billed to the platform key (this is what the daily caps track); <b>User key</b> is spend billed to users\' own Anthropic keys (display only); <b>Both</b> stacks them.',
  funnels: 'Each stage shows the count reaching that milestone and the step-over-step conversion. "Promoted" = a session opened for group vote; "Merged" = landed in production. Use the cohort buttons to scope to recent signups.',
  growth: 'New signups, apps, and promoted/merged PRs bucketed per ISO week. Hover any bar for that week\'s exact count.',
  'general-users': 'A general user is anyone active during the period (any tracked action — used a dapp, sent a chat message, or sent a dev-session message). <b>DAU</b> is distinct users active that day; <b>WAU</b> is a 7-day rolling window (distinct users in the trailing 7 days, recomputed every day); <b>MAU</b> is a 30-day rolling window. Daily points over the last 90 days. Hover for the exact date and count.',
  retention: 'Each row is a signup-week cohort; each cell is the share of that cohort active (any tracked action) in a given week. Hover a cell for the exact counts. Use the <b>Align</b> toggle to line cohorts up on real calendar weeks (default) or by cohort age (Week 0, Week 1, …).',
  'power-users': 'A power user, evaluated over a 7-day window, both used dapps &ge; 3 times that week (counting each use of any dapp) AND did &ge; 3 visible developer actions (each a kudos given, vote cast, or proposal made). <b>Power-user WAU</b> is a 7-day rolling count; <b>Consistency (L4)</b> stacks, per day, how many of the trailing 4 weeks each user was a power user (1/4…4/4). Hover for exact counts.',
  'top-users': 'The 30 most prolific builders by lifetime dev sessions started, highest on the left. Hover a bar for the per-outcome breakdown (PRs produced, promoted, voted, merged).',
  'spend-by-builder': 'The 30 biggest LLM spenders, highest on the left. The toggle re-ranks by <b>Platform key</b> spend, <b>User key</b> (BYOK) spend, or <b>Both</b>. Hover a bar for the full breakdown.',
  kudos: 'Per ISO week, how many users gave 0, 1, 2, 3, 4–5, 6–10 or 11+ kudos (everyone gets a budget of 20/week). The 0 bucket is registered users who gave none that week, making this a participation view rather than a raw count. Counts direct PR kudos only — issue-bounty pledges draw on the same weekly allowance but are not in this series.',
  'spend-distribution': 'Per day, how many users\' platform-key AI spend (what the daily caps track) fell into each dollar bucket. The <b>$0</b> bucket is every registered user (as of that day) with no platform spend — it usually dwarfs the paid buckets, so it is hidden by default; use the <b>Show $0</b> toggle to include it. The top tier splits <b>$20+ capped</b> (heavy spenders with no usable own key — blocked at the cap) from <b>$20+ own key</b> (heavy spenders who had a personal Anthropic key configured, or spent on it that day, so could keep going). The "has own key" signal is a current snapshot corrected by that day\'s own-key spend, so past-day attribution is approximate.',
};

// Per-card Overview definitions (#341). Keyed by a stable card id, mirroring
// the chart-level INFO map. Each is the plain-language definition of how that
// card's number is actually computed (see <Counters/> + the /overview SQL).
const CARD_INFO: Record<string, string> = {
  'total-users': 'Count of all registered accounts (admins excluded unless the box above is ticked).',
  'new-7d': 'Accounts that signed up in the last 7 days.',
  'new-30d': 'Accounts that signed up in the last 30 days.',
  'wau-mau': 'Two independent counts, not a ratio. <b>WAU</b> = distinct users who took any tracked action (used a dapp, sent a chat message, or sent a dev-session message) in the last 7 days. <b>MAU</b> = the same, over the last 30 days. The General-users section below charts these same definitions as daily rolling windows.',
  'apps': 'Published apps that aren\'t self-hosted and aren\'t deleted.',
  'promoted-open': 'Live count of dev sessions sitting in the "promoted" or "merging" state right now (not a lifetime total).',
  'promoted-all': 'Every dev session that was ever opened for a group vote.',
  'merged-all': 'Every dev session that landed in production.',
  'kudos': 'Total kudos handed out across all users.',
  'llm-today': 'Today\'s platform-key LLM spend (the spend the daily caps track), in dollars.',
};

// Both maps are constant, so their copy is registered once at module scope
// rather than by a `wireInfoIcon` pass over the rendered DOM.
for (const [k, v] of Object.entries(INFO)) tipStore[`info-${k}`] = v;
for (const [k, v] of Object.entries(CARD_INFO)) tipStore[`card-${k}`] = v;

/** The (?) icon: mouse tooltip via the root delegation, keyboard via focus. */
function InfoIcon({ info, card }: { info?: string; card?: string }) {
  const html = info ? INFO[info] : CARD_INFO[card as string];
  const attrs = info ? { 'data-info': info } : { 'data-card-info': card };
  return (
    <span
      className="dc-info"
      {...attrs}
      data-tip-id={info ? `info-${info}` : `card-${card}`}
      tabIndex={0}
      role="button"
      aria-label="What is this?"
      onFocus={(ev) => showTipAt(ev.currentTarget, html)}
      onBlur={() => { ensureTip().style.display = 'none'; }}
    >?</span>
  );
}

// Short "Mar 3" style label for a week-start. The API returns these as
// 'YYYY-MM-DD' text; we also tolerate full ISO strings / Date objects so a
// stray value can never render as "Invalid Date".
function weekLabel(d: any): string {
  if (!d) return '';
  const s = String(d);
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Same formatting — kept as its own name so day-resolution call sites read
// clearly.
const dayLabel = weekLabel;

async function getJSON(url: string): Promise<any> {
  const res = await fetch(url);
  if (res.status === 403 || res.status === 401) {
    const err: any = new Error('forbidden');
    err.forbidden = true;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const EMPTY = <p className="text-sm text-zinc-500 dark:text-zinc-400">Not enough data yet.</p>;

/** A colour swatch + label, the inline-swatch idiom every legend here uses. */
function Swatch({ color, outline, children }: { color: string; outline?: boolean; children: string }) {
  return (
    <span>
      <span className="inline-block w-3 h-3 rounded-sm align-middle"
        style={outline ? { border: `2px solid ${color}` } : { background: color }} />
      {` ${children}`}
    </span>
  );
}

/**
 * The small "Non-admin / Admin" swatch legend. Rendered only while admins are
 * included; the non-admin swatch defaults to indigo but can be set to a
 * chart's own base colour.
 */
function AdminLegend({ includeAdmins, nonAdminColor = '#6366f1' }: { includeAdmins: boolean; nonAdminColor?: string }) {
  if (!includeAdmins) return null;
  return (
    <div className="flex items-center gap-3 text-[10px] text-zinc-400 mb-2">
      <Swatch color={nonAdminColor}>Non-admin</Swatch>
      <Swatch color={ADMIN_COLOR}>Admin</Swatch>
    </div>
  );
}

/**
 * Horizontal gridlines for a chart of height H drawn over usable height
 * (H - pad). `steps` evenly spaced lines from baseline to top. Uses
 * currentColor at low opacity so it adapts to light/dark theme.
 */
function GridLines({ W, H, steps, pad }: { W: number; H: number; steps: number; pad: number }) {
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const y = (H - (i / steps) * (H - pad)).toFixed(1);
    // eslint-disable-next-line react/no-array-index-key
    out.push(<line key={i} x1="0" y1={y} x2={W} y2={y} stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.5" />);
  }
  return <>{out}</>;
}

/** The padded variant the big charts use: four lines across `plot`. */
function PlotGrid({ W, topPad, plot }: { W: number; topPad: number; plot: number }) {
  const out = [];
  for (let i = 0; i <= 4; i += 1) {
    const y = (topPad + (i / 4) * plot).toFixed(1);
    // eslint-disable-next-line react/no-array-index-key
    out.push(<line key={i} x1="0" y1={y} x2={W} y2={y} stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.5" />);
  }
  return <>{out}</>;
}

const TOGGLE_ON = 'px-2 py-1 rounded bg-violet-600 text-white';
const TOGGLE_OFF = 'px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800';

/**
 * The four toggle rows (spend mode ×2, cohort, retention alignment, $0) were
 * four `wire*` functions that queried their buttons, looped, and assigned a
 * full className per button. One component, one piece of state.
 */
function ToggleGroup<T extends string>({
  cls, attr, value, options, onChange, ...rest
}: {
  cls: string; attr: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void;
} & Record<string, any>) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs" {...rest}>
      {options.map(([v, label]) => (
        <button key={v} type="button" {...{ [attr]: v }}
          className={`${cls} ${v === value ? TOGGLE_ON : TOGGLE_OFF}`}
          onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

// ── Counters ──────────────────────────────────────────────────
function Counters({ o }: { o: any }) {
  // Each card carries a stable id keying its per-card (?) definition (#341).
  const cards = [
    { id: 'total-users', label: 'Total users (all time)', value: fmtInt(o.users.total) },
    { id: 'new-7d', label: 'New (7d)', value: fmtInt(o.users.new_week) },
    { id: 'new-30d', label: 'New (30d)', value: fmtInt(o.users.new_month) },
    // WAU and MAU are two independent counts (distinct users active in the
    // last 7 vs 30 days), not a ratio — the "|" keeps that clear.
    { id: 'wau-mau', label: 'WAU | MAU', value: `${fmtInt(o.wau)} | ${fmtInt(o.mau)}` },
    { id: 'apps', label: 'Apps', value: fmtInt(o.appsTotal) },
    // Live count of sessions currently in promoted/merging (not lifetime).
    { id: 'promoted-open', label: 'Promoted (open)', value: fmtInt(o.prs.promoted) },
    // Lifetime count of sessions that ever recorded a promoted_at.
    { id: 'promoted-all', label: 'Promoted PRs (all time)', value: fmtInt(o.prs.promoted_all_time) },
    { id: 'merged-all', label: 'Merged PRs (all time)', value: fmtInt(o.prs.merged) },
    { id: 'kudos', label: 'Kudos given (all time)', value: fmtInt(o.kudosTotal) },
    { id: 'llm-today', label: 'LLM spend today', value: dollars(o.llmSpendTodayCents) },
  ];
  return (
    <>
      {cards.map((c) => (
        <div key={c.id} className="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
          <div className="flex items-start justify-between gap-1">
            <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{c.label}</div>
            <InfoIcon card={c.id} />
          </div>
          <div className="text-2xl font-bold mt-1">{c.value}</div>
        </div>
      ))}
    </>
  );
}

// ── Funnel bars ───────────────────────────────────────────────
// stages: [{ label, value, admin }]. Bar width is relative to the first
// stage's total; the caption shows the absolute count and the step-over-step
// conversion. When admins are included (#341) each stage bar splits into a
// non-admin (indigo) segment plus an amber admin segment.
function Funnel({ stages, includeAdmins }: { stages: any[]; includeAdmins: boolean }) {
  const stageTotal = (s: any) => (Number(s.value) || 0) + (Number(s.admin) || 0);
  const top = stages[0] ? stageTotal(stages[0]) : 0;
  const anyAdmin = includeAdmins && stages.some((s) => (Number(s.admin) || 0) > 0);
  return (
    <>
      <AdminLegend includeAdmins={includeAdmins} nonAdminColor="#4f46e5" />
      {stages.map((s, i) => {
        const value = Number(s.value) || 0;
        const admin = Number(s.admin) || 0;
        const total = value + admin;
        // Width relative to the first stage's total. Keep a 2% floor on a
        // non-zero total so a tiny stage is still visible.
        const naW = top > 0 ? (value / top) * 100 : 0;
        const adW = top > 0 ? (admin / top) * 100 : 0;
        const floor = total > 0 && naW + adW < 2 ? 2 - (naW + adW) : 0;
        const conv = i === 0 ? '100%' : `${pct(total, stageTotal(stages[i - 1]))}% of prev`;
        const count = anyAdmin && admin > 0 ? `${fmtInt(total)} · ${fmtInt(admin)} admin` : fmtInt(total);
        return (
          <div key={s.label}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-zinc-600 dark:text-zinc-300">{s.label}</span>
              <span className="text-zinc-500 dark:text-zinc-400">{`${count} · ${conv}`}</span>
            </div>
            <div className="h-6 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden flex">
              <div className="h-full bg-violet-600" style={{ width: `${(naW + floor).toFixed(2)}%` }} />
              <div className="h-full" style={{ width: `${adW.toFixed(2)}%`, background: ADMIN_COLOR }} />
            </div>
          </div>
        );
      })}
    </>
  );
}

// ── Mini bar chart (growth) ───────────────────────────────────
function BarChart({
  values, labels, color, grid, adminValues, tipPrefix, tips,
}: {
  values: number[]; labels: string[]; color: string; grid?: boolean;
  adminValues?: number[]; tipPrefix?: string; tips?: string[];
}) {
  const admin = adminValues || [];
  // Scale to the per-column total so the stacked admin segment never clips.
  const max = Math.max(1, ...values.map((v, i) => v + (Number(admin[i]) || 0)));
  const W = 320; const H = 90; const n = values.length; const pad = 14;
  const bw = n > 0 ? (W / n) : W;
  const rich = !!(tipPrefix && tips);
  useTips(tipPrefix || 'unused', rich ? (tips as string[]) : []);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-zinc-500 dark:text-zinc-400"
      preserveAspectRatio="none" style={{ height: '90px' }}>
      {grid ? <GridLines W={W} H={H} steps={4} pad={pad} /> : null}
      {values.map((v, i) => {
        const a = Number(admin[i]) || 0;
        const hBase = Math.round((v / max) * (H - pad));
        const hAdmin = Math.round((a / max) * (H - pad));
        const x = i * bw;
        const yBase = H - hBase;
        const yAdmin = yBase - hAdmin;
        const x0 = (x + 1).toFixed(1);
        const w = Math.max(1, bw - 2).toFixed(1);
        return (
          // eslint-disable-next-line react/no-array-index-key
          <g key={i}>
            <rect x={x0} y={yBase} width={w} height={hBase} fill={color} rx="1">
              {rich ? null : <title>{`${labels[i]}: ${v}`}</title>}
            </rect>
            {a > 0 ? <rect x={x0} y={yAdmin} width={w} height={hAdmin} fill={ADMIN_COLOR} rx="1" /> : null}
            {rich ? (
              <rect className="dc-hover" x={x.toFixed(1)} y="0" width={bw.toFixed(1)} height={H}
                fill={color} fillOpacity="0" pointerEvents="all" data-tip-id={`${tipPrefix}-${i}`} />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

// ── Daily line chart ──────────────────────────────────────────
// A polyline over ~90 daily points (too dense for per-day bars). Each point
// gets a tiny dot plus a full-height transparent hit-band so the whole column
// is hoverable.
function LineChart({
  values, color, grid, tipPrefix, tips,
}: { values: number[]; color: string; grid?: boolean; tipPrefix?: string; tips?: string[] }) {
  const n = values.length;
  const W = 320; const H = 90; const pad = 14;
  const vals = values.map((v) => Number(v) || 0);
  const max = Math.max(1, ...vals);
  const step = n > 1 ? W / (n - 1) : W;
  const x = (i: number) => i * step;
  const y = (v: number) => H - (v / max) * (H - pad);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const rich = !!(tipPrefix && tips);
  useTips(tipPrefix || 'unused', rich ? (tips as string[]) : []);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-zinc-500 dark:text-zinc-400" style={{ height: '90px' }}>
      {grid ? <GridLines W={W} H={H} steps={4} pad={pad} /> : null}
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      {vals.map((v, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <g key={i}>
          <rect className="dc-hover" x={(x(i) - step / 2).toFixed(1)} y="0"
            width={Math.max(1, step).toFixed(1)} height={H}
            fill={color} fillOpacity="0" pointerEvents="all"
            {...(rich ? { 'data-tip-id': `${tipPrefix}-${i}` } : {})} />
          <circle cx={x(i).toFixed(1)} cy={y(v).toFixed(1)} r="1.5" fill={color} />
        </g>
      ))}
    </svg>
  );
}

// ── Stacked bar chart ─────────────────────────────────────────
// `stacks` is an array (one per column) of segment arrays, bottom-to-top.
// `colors[si]` paints segment si. Used by the power-user L4 chart.
function StackedBarChart({
  stacks, colors, grid, tipPrefix, tips,
}: { stacks: number[][]; colors: string[]; grid?: boolean; tipPrefix?: string; tips?: string[] }) {
  const n = stacks.length;
  const W = 320; const H = 90; const pad = 14;
  const totals = stacks.map((s) => s.reduce((a, b) => a + (Number(b) || 0), 0));
  const max = Math.max(1, ...totals);
  const bw = n > 0 ? (W / n) : W;
  const rich = !!(tipPrefix && tips);
  useTips(tipPrefix || 'unused', rich ? (tips as string[]) : []);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-zinc-500 dark:text-zinc-400"
      preserveAspectRatio="none" style={{ height: '90px' }}>
      {grid ? <GridLines W={W} H={H} steps={4} pad={pad} /> : null}
      {stacks.map((segs, i) => {
        const x = i * bw;
        const x0 = (x + 0.4).toFixed(1);
        const w = Math.max(0.6, bw - 0.8).toFixed(1);
        let cursor = H;
        const rects: React.ReactNode[] = [];
        segs.forEach((seg, si) => {
          const val = Number(seg) || 0;
          if (val <= 0) return;
          const h = (val / max) * (H - pad);
          cursor -= h;
          rects.push(
            // eslint-disable-next-line react/no-array-index-key
            <rect key={si} x={x0} y={cursor.toFixed(1)} width={w} height={h.toFixed(1)} fill={colors[si]} />,
          );
        });
        return (
          // eslint-disable-next-line react/no-array-index-key
          <g key={i}>
            {rects}
            {rich ? (
              <rect className="dc-hover" x={x.toFixed(1)} y="0" width={bw.toFixed(1)} height={H}
                fill={colors[colors.length - 1]} fillOpacity="0" pointerEvents="all"
                data-tip-id={`${tipPrefix}-${i}`} />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** The `first … last` caption under a 90-day chart. */
function Axis({ labels, lastSuffix }: { labels: string[]; lastSuffix?: string }) {
  return (
    <div className="flex justify-between text-[10px] text-zinc-500 dark:text-zinc-400 mt-1">
      <span>{labels[0] || ''}</span>
      <span>{`${labels[labels.length - 1] || ''}${lastSuffix || ''}`}</span>
    </div>
  );
}

function Growth({ g, includeAdmins }: { g: any; includeAdmins: boolean }) {
  const weeks = g.weeks || [];
  const labels = weeks.map((w: any) => weekLabel(w.wk));
  const series = [
    { key: 'new_users', label: 'New users', color: '#6366f1' },
    { key: 'new_apps', label: 'New apps', color: '#818cf8' },
    { key: 'promoted_prs', label: 'Promoted PRs', color: '#34d399' },
    { key: 'merged_prs', label: 'Merged PRs', color: '#60a5fa' },
  ];
  return (
    <>
      {/* The legend spans the full grid width so it reads as one chart-wide key. */}
      {includeAdmins ? <div className="sm:col-span-2"><AdminLegend includeAdmins /></div> : null}
      {series.map((s) => {
        const vals = weeks.map((w: any) => Number(w[s.key]) || 0);
        const adminVals = weeks.map((w: any) => Number(w[`${s.key}_admin`]) || 0);
        const total = vals.reduce((a: number, b: number) => a + b, 0);
        const totalAdmin = adminVals.reduce((a: number, b: number) => a + b, 0);
        const showAdmin = includeAdmins && totalAdmin > 0;
        const tips = vals.map((_: number, i: number) => `<div class="font-semibold">${esc(s.label)}</div>
        <div class="text-zinc-300">Week of ${esc(labels[i] || '')}</div>
        <div class="text-zinc-300">${fmtInt(vals[i] + adminVals[i])}${includeAdmins && adminVals[i] > 0 ? ` · ${fmtInt(adminVals[i])} admin` : ''}</div>`);
        return (
          <div key={s.key}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-zinc-600 dark:text-zinc-300">{s.label}</span>
              <span className="text-zinc-500 dark:text-zinc-400">
                {`${fmtInt(total + totalAdmin)} total${showAdmin ? ` · ${fmtInt(totalAdmin)} admin` : ''}`}
              </span>
            </div>
            <BarChart values={vals} labels={labels} color={s.color} grid
              adminValues={adminVals} tipPrefix={`growth-${s.key}`} tips={tips} />
            <Axis labels={labels} />
          </div>
        );
      })}
    </>
  );
}

// ── Retention cohort grid ─────────────────────────────────────
// `mode` selects the alignment:
//   'calendar' (default) — columns are absolute calendar weeks.
//   'cohort' — columns are W0, W1, … from each cohort's own signup week.
function addWeeksISO(dateStr: string, k: number): string {
  const dt = new Date(`${String(dateStr)}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + k * 7);
  return dt.toISOString().slice(0, 10);
}

function Retention({ r, mode }: { r: any; mode: string }) {
  const cohorts = ((r && r.cohorts) || []).slice()
    .sort((a: any, b: any) => (a.cohortWeek < b.cohortWeek ? 1 : -1)); // newest first

  // Every cell's tip copy, keyed exactly as the cell's data-tip-id.
  const tips: Record<string, string> = {};
  const cellTip = (v: number, size: number, headLabel: string, ci: number, key: string) => {
    const p = pct(v, size);
    tips[`ret-${ci}-${key}`] = `<div class="font-semibold">${esc(headLabel)}</div>
        <div class="text-zinc-300">${fmtInt(v)} of ${fmtInt(size)} active</div>
        <div class="text-zinc-300">${p}% retained</div>`;
  };
  useEffect(() => {
    for (const [k, v] of Object.entries(tips)) tipStore[k] = v;
  });

  if (!cohorts.length) return EMPTY;

  // One coloured cell. `key` makes the tooltip id unique within the row.
  const Cell = (v: number | null | undefined, size: number, headLabel: string, ci: number, key: string) => {
    if (v == null) {
      return <td key={key} className="px-2 py-1 text-center text-zinc-400 dark:text-zinc-700">·</td>;
    }
    const p = pct(v, size);
    const alpha = Math.max(0.06, Math.min(1, p / 100));
    cellTip(v, size, headLabel, ci, key);
    return (
      <td key={key} className="px-2 py-1 text-center" data-tip-id={`ret-${ci}-${key}`}
        style={{ background: `rgba(139,92,246,${alpha})`, cursor: 'pointer' }}>
        <span className={`text-[11px] ${p >= 45 ? 'text-white' : 'text-zinc-600 dark:text-zinc-300'}`}>{`${p}%`}</span>
      </td>
    );
  };

  const head: React.ReactNode[] = [
    <th key="_c" className="text-left px-2 py-1 font-medium text-zinc-400">Cohort</th>,
    <th key="_u" className="px-2 py-1 font-medium text-zinc-400">Users</th>,
  ];
  let rows: React.ReactNode[];

  if (mode === 'cohort') {
    let maxOffset = 0;
    for (const c of cohorts) for (const k of Object.keys(c.offsets)) maxOffset = Math.max(maxOffset, Number(k));
    maxOffset = Math.min(maxOffset, 11); // keep the triangle readable
    for (let k = 0; k <= maxOffset; k += 1) {
      head.push(<th key={`w${k}`} className="px-2 py-1 font-medium text-zinc-400">{`W${k}`}</th>);
    }
    rows = cohorts.map((c: any, ci: number) => {
      const cells = [];
      for (let k = 0; k <= maxOffset; k += 1) {
        cells.push(Cell(c.offsets[k], c.cohortSize, `${weekLabel(c.cohortWeek)} cohort · Week ${k}`, ci, `w${k}`));
      }
      return (
        <tr key={c.cohortWeek}>
          <td className="px-2 py-1 whitespace-nowrap text-zinc-600 dark:text-zinc-300">{weekLabel(c.cohortWeek)}</td>
          <td className="px-2 py-1 text-center text-zinc-400">{fmtInt(c.cohortSize)}</td>
          {cells}
        </tr>
      );
    });
  } else {
    // Calendar aligned — shared, sorted set of absolute week columns.
    const weekSet = new Set<string>();
    const cal = cohorts.map((c: any) => {
      const map: Record<string, number> = {};
      for (const k of Object.keys(c.offsets)) {
        const wk = addWeeksISO(c.cohortWeek, Number(k));
        map[wk] = c.offsets[k];
        weekSet.add(wk);
      }
      return map;
    });
    const allCols = Array.from(weekSet).sort(); // ascending YYYY-MM-DD
    const cols = allCols.slice(Math.max(0, allCols.length - 12)); // keep readable
    for (const wk of cols) {
      head.push(<th key={wk} className="px-2 py-1 font-medium text-zinc-400 whitespace-nowrap">{weekLabel(wk)}</th>);
    }
    rows = cohorts.map((c: any, ci: number) => (
      <tr key={c.cohortWeek}>
        <td className="px-2 py-1 whitespace-nowrap text-zinc-600 dark:text-zinc-300">{weekLabel(c.cohortWeek)}</td>
        <td className="px-2 py-1 text-center text-zinc-400">{fmtInt(c.cohortSize)}</td>
        {cols.map((wk) => Cell(cal[ci][wk], c.cohortSize,
          `${weekLabel(c.cohortWeek)} cohort · week of ${weekLabel(wk)}`, ci, wk))}
      </tr>
    ));
  }

  return (
    <table className="text-xs border-collapse">
      <thead><tr>{head}</tr></thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

// ── General users (DAU / WAU / MAU daily rolling windows) ──────
//
// The three chart hosts keep their ids WRITTEN OUT at the call sites below
// rather than passed in as props. dapp.json's declared #admin/analytics checks
// select on `#gu-mau` and friends, and tests/admin-heavy-sections-island.test.js
// reads those ids straight out of the manifest and greps for `id="…"` here —
// a prop would satisfy the render and defeat the grep.
function DailySeries({
  daily, dataKey, color, def,
}: { daily: any[]; dataKey: string; color: string; def: string }) {
  const labels = daily.map((r) => dayLabel(r.day));
  const vals = daily.map((r) => Number(r[dataKey]) || 0);
  const tips = vals.map((_, i) => `<div class="font-semibold">${esc(labels[i] || '')}</div>
        <div class="text-zinc-300">${fmtInt(vals[i])} users</div>
        <div class="text-zinc-500 dark:text-zinc-400 mt-1 text-[11px]">${def}</div>`);
  if (!daily.length) return EMPTY;
  return (
    <>
      <LineChart values={vals} color={color} grid tipPrefix={`gu-${dataKey}`} tips={tips} />
      <Axis labels={labels} />
    </>
  );
}

/** `N latest`, the caption beside each of the three headings. */
function latestLabel(daily: any[], dataKey: string): string {
  if (!daily.length) return '';
  return `${fmtInt(Number(daily[daily.length - 1][dataKey]) || 0)} latest`;
}

// ── Power users (rolling WAU + L4 consistency) ────────────────
// Four indigo shades for the L4 buckets: light (1/4) → dark (4/4).
const L4_COLORS = ['#c7d2fe', '#818cf8', '#4f46e5', '#3730a3'];

function PowerUserWau({ wau }: { wau: any[] }) {
  const labels = wau.map((r) => dayLabel(r.day));
  const vals = wau.map((r) => Number(r.count) || 0);
  const tips = vals.map((_, i) => `<div class="font-semibold">${esc(labels[i] || '')}</div>
          <div class="text-zinc-300">${fmtInt(vals[i])} power users</div>
          <div class="text-zinc-500 dark:text-zinc-400 mt-1 text-[11px]">Trailing 7-day window.</div>`);
  return (
    <>
      <LineChart values={vals} color="#6366f1" grid tipPrefix="pu-wau" tips={tips} />
      <Axis labels={labels} />
    </>
  );
}

function PowerUserL4({ l4 }: { l4: any[] }) {
  const labels = l4.map((r) => dayLabel(r.day));
  const stacks = l4.map((r) => [Number(r.b1) || 0, Number(r.b2) || 0, Number(r.b3) || 0, Number(r.b4) || 0]);
  const tips = stacks.map((s, i) => {
    const total = s.reduce((a, b) => a + b, 0);
    return `<div class="font-semibold">${esc(labels[i] || '')}</div>
          <div class="text-zinc-300">${fmtInt(total)} power users (trailing 4 wks)</div>
          <div class="text-zinc-400 mt-1 text-[11px]">4/4 ${fmtInt(s[3])} · 3/4 ${fmtInt(s[2])} · 2/4 ${fmtInt(s[1])} · 1/4 ${fmtInt(s[0])}</div>`;
  });
  return (
    <>
      <div className="flex items-center gap-3 text-[10px] text-zinc-400 mb-2">
        {(['1/4', '2/4', '3/4', '4/4'] as const).map((lab, i) => (
          <Swatch key={lab} color={L4_COLORS[i]}>{lab}</Swatch>
        ))}
      </div>
      <StackedBarChart stacks={stacks} colors={L4_COLORS} grid tipPrefix="pu-l4" tips={tips} />
      <Axis labels={labels} />
    </>
  );
}

// ── Top users by dev sessions started ─────────────────────────
// Descending left-to-right bars, one per user. Labels rotate under each bar
// (truncated); exact username + count live in the hover tooltip.
function TopUsers({ users, includeAdmins }: { users: any[]; includeAdmins: boolean }) {
  const vals = users.map((u) => Number(u.sessions) || 0);
  const max = Math.max(1, ...vals);
  const H = 200; const topPad = 14; const botPad = 52; // room for value + rotated label
  const plot = H - topPad - botPad;
  const bw = 26; // per-bar slot
  const W = users.length * bw;
  const tipRow = (label: string, n: number) =>
    `<div class="flex justify-between gap-3 text-zinc-400"><span>${label}</span><span class="text-zinc-300">${n}</span></div>`;
  const tips = users.map((u, i) => {
    const isAdmin = includeAdmins && !!u.is_admin;
    return `<div class="font-semibold">${esc(u.name)}${isAdmin ? ' (admin)' : ''}</div>
        <div class="text-zinc-300 mb-1">#${i + 1} · ${vals[i]} dev session${vals[i] === 1 ? '' : 's'}</div>
        ${tipRow('Produced a PR', Number(u.produced_pr) || 0)}
        ${tipRow('Promoted to group', Number(u.promoted) || 0)}
        ${tipRow('Received a vote', Number(u.received_vote) || 0)}
        ${tipRow('Merged', Number(u.merged) || 0)}`;
  });
  useTips('top', tips);
  return (
    <>
      <AdminLegend includeAdmins={includeAdmins} />
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ height: '200px', minWidth: `${W}px` }}
          className="text-zinc-500 dark:text-zinc-400">
          <PlotGrid W={W} topPad={topPad} plot={plot} />
          {users.map((u, i) => {
            const v = vals[i];
            const h = Math.round((v / max) * plot);
            const x = i * bw;
            const y = topPad + (plot - h);
            const cx = x + bw / 2;
            const short = u.name.length > 10 ? `${u.name.slice(0, 9)}…` : u.name;
            // Each bar is a single user, so an admin builder gets the whole bar
            // in amber (#341) instead of the usual indigo.
            const barColor = includeAdmins && u.is_admin ? ADMIN_COLOR : '#6366f1';
            return (
              // eslint-disable-next-line react/no-array-index-key
              <g key={i}>
                <rect x={(x + 3).toFixed(1)} y={y} width={bw - 6} height={h} fill={barColor} rx="2" />
                <text x={cx} y={y - 3} textAnchor="middle" fontSize="9" fill="currentColor" className="text-zinc-400">{v}</text>
                <text x={cx} y={H - botPad + 12} textAnchor="end" fontSize="9" fill="currentColor"
                  className="text-zinc-400" transform={`rotate(-55 ${cx} ${H - botPad + 12})`}>{short}</text>
                <rect className="dc-hover" x={x.toFixed(1)} y={topPad} width={bw.toFixed(1)} height={plot}
                  fill="#6366f1" fillOpacity="0" pointerEvents="all" data-tip-id={`top-${i}`} />
              </g>
            );
          })}
        </svg>
      </div>
    </>
  );
}

// ── Kudos giving distribution (weekly) ────────────────────────
// One stacked bar per week. Segments = number of users whose kudos-giving that
// week fell in each band: 0, 1, 2, 3, 4–5, 6–10, 11+ (0 = registered users who
// gave none). Bands, not exact counts, since #964 raised the weekly allowance
// to 20 — see the endpoint's comment in routes/dashboard.js.
const KUDOS_SEGS = [
  { key: 'g0', label: '0', color: '#3f3f5a' },
  { key: 'g1', label: '1', color: '#c4b5fd' },
  { key: 'g2', label: '2', color: '#818cf8' },
  { key: 'g3', label: '3', color: '#6366f1' },
  { key: 'g4_5', label: '4–5', color: '#4f46e5' },
  { key: 'g6_10', label: '6–10', color: '#3730a3' },
  { key: 'g11p', label: '11+', color: '#4c1d95' },
];

/**
 * The shared stacked-column body of the kudos and spend-distribution charts:
 * same 640x180 frame, same four gridlines, same per-column hover overlay.
 */
function StackedColumns({
  rows, segs, tipPrefix,
}: { rows: any[]; segs: Array<{ key: string; color: string }>; tipPrefix: string }) {
  const totals = rows.map((x) => segs.reduce((a, s) => a + (Number(x[s.key]) || 0), 0));
  const max = Math.max(1, ...totals);
  const W = 640; const H = 180; const topPad = 14; const botPad = 18; const n = rows.length;
  const plot = H - topPad - botPad;
  const bw = W / n;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-zinc-500 dark:text-zinc-400"
      preserveAspectRatio="none" style={{ height: '180px' }}>
      <PlotGrid W={W} topPad={topPad} plot={plot} />
      {rows.map((w, i) => {
        let acc = 0; // running height from baseline, in value units
        const x = i * bw;
        return (
          // eslint-disable-next-line react/no-array-index-key
          <g key={i}>
            {segs.map((s) => {
              const v = Number(w[s.key]) || 0;
              if (v <= 0) return null;
              const h = (v / max) * plot;
              const yBottom = topPad + plot - (acc / max) * plot;
              acc += v;
              const y = yBottom - h;
              return (
                <rect key={s.key} x={(x + 1).toFixed(1)} y={y.toFixed(1)}
                  width={Math.max(1, bw - 2).toFixed(1)} height={h.toFixed(1)} fill={s.color} />
              );
            })}
            <rect className="dc-hover" x={x.toFixed(1)} y={topPad} width={bw.toFixed(1)} height={plot}
              fill="#6366f1" fillOpacity="0" pointerEvents="all" data-tip-id={`${tipPrefix}-${i}`} />
          </g>
        );
      })}
    </svg>
  );
}

function Kudos({ weeks }: { weeks: any[] }) {
  const labels = weeks.map((w) => weekLabel(w.wk));
  const row = (label: string, num: number) =>
    `<div class="flex justify-between gap-3"><span class="text-zinc-400">${label}</span><span>${num}</span></div>`;
  // Per-week breakdown tooltip covering the full column height. Banded buckets
  // can't yield an exact kudos total any more (a "6–10" bucket is 6..10 each),
  // so the headline reports the one figure the bands DO give exactly — how
  // many people gave at all that week — rather than a weighted guess dressed
  // up as a count.
  const tips = weeks.map((w, i) => {
    const n11p = Number(w.g11p) || 0; const n6_10 = Number(w.g6_10) || 0; const n4_5 = Number(w.g4_5) || 0;
    const n3 = Number(w.g3) || 0; const n2 = Number(w.g2) || 0; const n1 = Number(w.g1) || 0;
    const n0 = Number(w.g0) || 0;
    const givers = n11p + n6_10 + n4_5 + n3 + n2 + n1;
    return `<div class="font-semibold mb-1">${esc(labels[i])}${i === weeks.length - 1 ? ' (current)' : ''}</div>
        <div class="mb-1">${givers} giver${givers === 1 ? '' : 's'} this week</div>
        <div class="text-[11px] leading-tight">
          ${row('gave 11+', n11p)}${row('gave 6–10', n6_10)}${row('gave 4–5', n4_5)}${row('gave 3', n3)}${row('gave 2', n2)}${row('gave 1', n1)}${row('gave 0', n0)}
        </div>`;
  });
  useTips('kudos', tips);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400 mb-2">
        <span className="text-zinc-500 dark:text-zinc-400">Kudos given that week:</span>
        {KUDOS_SEGS.slice().reverse().map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: s.color }} />{s.label}
          </span>
        ))}
      </div>
      <StackedColumns rows={weeks} segs={KUDOS_SEGS} tipPrefix="kudos" />
      <Axis labels={labels} lastSuffix=" (current)" />
    </>
  );
}

// ── Daily spend distribution (last 30 days) ───────────────────
// b0 first (bottom, muted), paid buckets ascending, $20+ split at the top:
// capped (red) then kept-going-on-own-key (indigo). The $0 bucket is dropped
// when the "Hide $0" toggle is active so the paid buckets rescale to fill the
// chart; totals/max, bars, legend and tooltip all derive from `segs`.
const SPEND_DIST_SEGS = [
  { key: 'b0', label: '$0', color: '#3f3f5a' },
  { key: 'b1', label: '$0.01–$5', color: '#34d399' },
  { key: 'b2', label: '$5–$10', color: '#a3e635' },
  { key: 'b3', label: '$10–$15', color: '#fbbf24' },
  { key: 'b4', label: '$15–$19.99', color: '#fb923c' },
  { key: 'b5', label: '$20+ capped', color: '#ef4444' },
  { key: 'b6', label: '$20+ own key', color: '#a855f7' },
];

function SpendDistribution({ days, includeZero }: { days: any[]; includeZero: boolean }) {
  const segs = includeZero ? SPEND_DIST_SEGS : SPEND_DIST_SEGS.filter((s) => s.key !== 'b0');
  const totals = days.map((x) => segs.reduce((a, s) => a + (Number(x[s.key]) || 0), 0));
  const labels = days.map((x) => weekLabel(x.day));
  const row = (label: string, color: string, v: number) =>
    `<div class="flex justify-between gap-3"><span class="text-zinc-400"><span class="inline-block w-2 h-2 rounded-sm align-middle mr-1" style="background:${color}"></span>${label}</span><span>${fmtInt(v)}</span></div>`;
  const tips = days.map((x, i) => `<div class="font-semibold mb-1">${esc(labels[i])}${i === days.length - 1 ? ' (today)' : ''}</div>
        <div class="mb-1">${fmtInt(totals[i])} user${totals[i] === 1 ? '' : 's'}</div>
        <div class="text-[11px] leading-tight">
          ${segs.slice().reverse().map((s) => row(s.label, s.color, Number(x[s.key]) || 0)).join('')}
        </div>`);
  useTips('spend-dist', tips);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400 mb-2">
        {segs.slice().reverse().map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: s.color }} />{s.label}
          </span>
        ))}
      </div>
      <StackedColumns rows={days} segs={segs} tipPrefix="spend-dist" />
      <Axis labels={labels} lastSuffix=" (today)" />
    </>
  );
}

// ── Daily spend (last 30 days) ────────────────────────────────
function Spend({
  days, mode, includeAdmins, systemCapCents,
}: { days: any[]; mode: string; includeAdmins: boolean; systemCapCents: number }) {
  const labels = days.map((x) => weekLabel(x.day));
  const plat = days.map((x) => Number(x.platform_cents) || 0);
  const byok = days.map((x) => Number(x.user_key_cents) || 0);
  // Admin-attributed portion per day, stacked as an amber cap on top of the
  // non-admin remainder so each bar's total height is unchanged.
  const platAdmin = days.map((x) => Number(x.platform_cents_admin) || 0);
  const byokAdmin = days.map((x) => Number(x.user_key_cents_admin) || 0);
  // #361: system-token spend per day — its own budget, stacked as an extra
  // cyan segment on top of every bar regardless of the toggle mode.
  const sys = days.map((x) => Number(x.system_cents) || 0);
  const totals = days.map((_, i) =>
    (mode === 'platform' ? plat[i] : mode === 'user' ? byok[i] : plat[i] + byok[i]) + sys[i]);
  const max = Math.max(1, ...totals);
  const W = 640; const H = 180; const topPad = 14; const botPad = 18; const n = days.length;
  const plot = H - topPad - botPad;
  const bw = W / n;

  const tips = days.map((_, i) => {
    const detail = mode === 'both'
      ? `<div class="flex justify-between gap-3"><span class="text-zinc-400">Platform</span><span>${dollars(plat[i])}</span></div>
           <div class="flex justify-between gap-3"><span class="text-zinc-400">User key</span><span>${dollars(byok[i])}</span></div>
           <div class="flex justify-between gap-3 border-t border-zinc-700 mt-1 pt-1"><span class="text-zinc-400">Total</span><span>${dollars(plat[i] + byok[i])}</span></div>`
      : `<div class="text-zinc-300">${dollars(totals[i])}</div>`;
    // Admin portion for the active mode (#341): tooltip-only breakout.
    const adminCents = mode === 'platform' ? platAdmin[i] : mode === 'user' ? byokAdmin[i] : platAdmin[i] + byokAdmin[i];
    const adminLine = includeAdmins && adminCents > 0
      ? `<div class="flex justify-between gap-3 text-[11px] text-amber-700 dark:text-amber-400"><span>of which admin</span><span>${dollars(adminCents)}</span></div>`
      : '';
    // #361: system-token spend line, shown whenever the day had any.
    const systemLine = sys[i] > 0
      ? `<div class="flex justify-between gap-3 text-[11px] text-cyan-700 dark:text-cyan-400"><span>System tokens</span><span>${dollars(sys[i])}</span></div>`
      : '';
    return `<div class="font-semibold">${esc(labels[i])}</div>${detail}${systemLine}${adminLine}`;
  });
  useTips('spend', tips);

  // Amber "Admin spend" swatch appears whenever the box is on and the active
  // mode has any admin spend. Not reusing <AdminLegend/> here: its "Non-admin"
  // swatch is hard-coded indigo and would mismatch the green (User key) and
  // dual-colour (Both) cases.
  const adminTotals = days.map((_, i) =>
    (mode === 'platform' ? platAdmin[i] : mode === 'user' ? byokAdmin[i] : platAdmin[i] + byokAdmin[i]));
  const hasAdminSpend = includeAdmins && adminTotals.some((v) => v > 0);
  const hasSystemSpend = sys.some((v) => v > 0);
  const anyLegend = mode === 'both' || hasAdminSpend || hasSystemSpend;
  // #361: "System tokens today: $X.XX / $cap" readout — today is the last day
  // in the series; cap from /api/admin/limits.
  const systemToday = sys.length ? sys[sys.length - 1] : 0;

  return (
    <>
      <div className="text-[11px] mb-2 text-cyan-700 dark:text-cyan-400">
        {`System tokens today: ${dollars(systemToday)} / ${dollars(systemCapCents)}`}
      </div>
      {anyLegend ? (
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-zinc-400 mb-2">
          {mode === 'both' ? <Swatch color={SPEND_PLATFORM}>Platform key</Swatch> : null}
          {mode === 'both' ? <Swatch color={SPEND_USERKEY}>User key (BYOK)</Swatch> : null}
          {hasAdminSpend ? <Swatch color={ADMIN_COLOR}>Admin spend</Swatch> : null}
          {hasSystemSpend ? <Swatch color={SYSTEM_COLOR}>System tokens</Swatch> : null}
        </div>
      ) : null}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-zinc-500 dark:text-zinc-400"
        preserveAspectRatio="none" style={{ height: '180px' }}>
        <PlotGrid W={W} topPad={topPad} plot={plot} />
        {days.map((_, i) => {
          const barX = i * bw;
          const w = Math.max(1, bw - 2).toFixed(1);
          const x0 = (barX + 1).toFixed(1);
          // Admin-attributed cents for the active mode (0 when the box is off).
          const pAdmin = includeAdmins ? platAdmin[i] : 0;
          const uAdmin = includeAdmins ? byokAdmin[i] : 0;
          // Compose each bar as a bottom-up stack: the non-admin remainder in
          // its mode colour, then the admin spend as an amber cap.
          const stack = (mode === 'both'
            ? [
              { value: Math.max(0, plat[i] - pAdmin), color: SPEND_PLATFORM },
              { value: Math.max(0, byok[i] - uAdmin), color: SPEND_USERKEY },
              { value: pAdmin + uAdmin, color: ADMIN_COLOR },
            ]
            : mode === 'user'
              ? [
                { value: Math.max(0, byok[i] - uAdmin), color: SPEND_USERKEY },
                { value: uAdmin, color: ADMIN_COLOR },
              ]
              : [
                { value: Math.max(0, plat[i] - pAdmin), color: SPEND_PLATFORM },
                { value: pAdmin, color: ADMIN_COLOR },
              ])
            // #361: system-token segment, always on top, in every mode.
            .concat([{ value: sys[i], color: SYSTEM_COLOR }]);
          let yCursor = topPad + plot;
          const rects: React.ReactNode[] = [];
          stack.forEach((s, si) => {
            if (s.value <= 0) return;
            const h = (s.value / max) * plot;
            yCursor -= h;
            rects.push(
              // eslint-disable-next-line react/no-array-index-key
              <rect key={si} x={x0} y={yCursor.toFixed(1)} width={w} height={Math.max(0, h).toFixed(1)} fill={s.color} />,
            );
          });
          return (
            // eslint-disable-next-line react/no-array-index-key
            <g key={i}>
              {rects}
              <rect className="dc-hover" x={barX.toFixed(1)} y={topPad} width={bw.toFixed(1)} height={plot}
                fill="#6366f1" fillOpacity="0" pointerEvents="all" data-tip-id={`spend-${i}`} />
            </g>
          );
        })}
      </svg>
      <Axis labels={labels} lastSuffix=" (today)" />
    </>
  );
}

// ── Spend by builder (top 30) ─────────────────────────────────
function SpendByBuilder({
  builders, mode, includeAdmins,
}: { builders: any[]; mode: string; includeAdmins: boolean }) {
  const valueOf = (b: any) => {
    const p = Number(b.platform_cents) || 0;
    const u = Number(b.user_key_cents) || 0;
    return mode === 'platform' ? p : mode === 'user' ? u : p + u;
  };
  // Re-sort descending by the selected mode so bars stay ordered.
  const sorted = builders.slice().sort((a, b) => valueOf(b) - valueOf(a));
  const vals = sorted.map(valueOf);
  const max = Math.max(1, ...vals);
  const H = 200; const topPad = 14; const botPad = 52;
  const plot = H - topPad - botPad;
  const bw = 26;
  const W = sorted.length * bw;
  const color = mode === 'user' ? SPEND_USERKEY : SPEND_PLATFORM;
  const tipRow = (label: string, val: number) =>
    `<div class="flex justify-between gap-3 text-zinc-400"><span>${label}</span><span class="text-zinc-300">${dollars(val)}</span></div>`;
  const tips = sorted.map((b, i) => {
    const p = Number(b.platform_cents) || 0;
    const u = Number(b.user_key_cents) || 0;
    const isAdmin = includeAdmins && !!b.is_admin;
    return `<div class="font-semibold">${esc(b.name)}${isAdmin ? ' (admin)' : ''}</div>
        <div class="text-zinc-300 mb-1">#${i + 1} · ${dollars(valueOf(b))}</div>
        ${tipRow('Platform key', p)}
        ${tipRow('User key (BYOK)', u)}
        ${tipRow('Total', p + u)}${isAdmin ? '<div class="mt-1 text-[11px] text-amber-700 dark:text-amber-400">admin</div>' : ''}`;
  });
  useTips('builder', tips);
  const anyLegend = mode === 'both' || includeAdmins;
  return (
    <>
      {anyLegend ? (
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-zinc-400 mb-2">
          {mode === 'both' ? <Swatch color={SPEND_PLATFORM}>Platform key</Swatch> : null}
          {mode === 'both' ? <Swatch color={SPEND_USERKEY}>User key (BYOK)</Swatch> : null}
          {/* Admin marker is an outline here (#341), so its swatch is outlined. */}
          {includeAdmins ? <Swatch color={ADMIN_COLOR} outline>Admin builder</Swatch> : null}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ height: '200px', minWidth: `${W}px` }}
          className="text-zinc-500 dark:text-zinc-400">
          <PlotGrid W={W} topPad={topPad} plot={plot} />
          {sorted.map((b, i) => {
            const p = Number(b.platform_cents) || 0;
            const u = Number(b.user_key_cents) || 0;
            const x = i * bw;
            const cx = x + bw / 2;
            const short = b.name.length > 10 ? `${b.name.slice(0, 9)}…` : b.name;
            // Admin builders get an amber OUTLINE (#341), not a fill swap —
            // the fill is already occupied by the platform/user/both colours.
            const isAdmin = includeAdmins && !!b.is_admin;
            const outline = isAdmin ? { stroke: ADMIN_COLOR, strokeWidth: 2 } : {};
            let segs: React.ReactNode;
            if (mode === 'both') {
              const hp = Math.round((p / max) * plot);
              const hu = Math.round((u / max) * plot);
              const yp = topPad + (plot - hp);
              const yu = yp - hu;
              segs = (
                <>
                  <rect x={(x + 3).toFixed(1)} y={yp} width={bw - 6} height={hp} fill={SPEND_PLATFORM} rx="2" {...outline} />
                  <rect x={(x + 3).toFixed(1)} y={yu} width={bw - 6} height={hu} fill={SPEND_USERKEY} rx="2" {...outline} />
                </>
              );
            } else {
              const v = valueOf(b);
              const h = Math.round((v / max) * plot);
              const y = topPad + (plot - h);
              segs = <rect x={(x + 3).toFixed(1)} y={y} width={bw - 6} height={h} fill={color} rx="2" {...outline} />;
            }
            return (
              // eslint-disable-next-line react/no-array-index-key
              <g key={i}>
                {segs}
                <text x={cx} y={H - botPad + 12} textAnchor="end" fontSize="9" fill="currentColor"
                  className="text-zinc-400" transform={`rotate(-55 ${cx} ${H - botPad + 12})`}>{short}</text>
                <rect className="dc-hover" x={x.toFixed(1)} y={topPad} width={bw.toFixed(1)} height={plot}
                  fill="#6366f1" fillOpacity="0" pointerEvents="all" data-tip-id={`builder-${i}`} />
              </g>
            );
          })}
        </svg>
      </div>
    </>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────
// Append the includeAdmins flag to any analytics URL — plus the page's own
// ?demo=1 when present (#891). Every chart here reads `events` / `llm_usage` /
// `progress_estimates`, all `staging:private` and therefore EMPTY in a
// prod-cloned staging DB; the endpoints substitute deterministic demo payloads
// behind `IS_STAGING && ?demo=1`, but that never fired because the flag was
// dropped here. A strict no-op in production. Guarded for the SSG prerender
// pass, which evaluates this module in Node (#1082 chunk E).
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';

const H3 = 'text-lg font-semibold inline-flex items-center';
const SUB = 'text-xs text-zinc-500 dark:text-zinc-400 mb-4';
const H4 = 'text-sm font-semibold text-zinc-500 dark:text-zinc-400';

const SPEND_MODES: Array<['platform' | 'user' | 'both', string]> = [
  ['platform', 'Platform key'], ['user', 'User key'], ['both', 'Both'],
];

function AnalyticsSection() {
  const [gate, setGate] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [funnels, setFunnels] = useState<any>(null);
  const [includeAdmins, setIncludeAdmins] = useState(INITIAL_INCLUDE_ADMINS);
  const [cohort, setCohort] = useState('all');
  const [retAlign, setRetAlign] = useState('calendar');
  const [spendMode, setSpendMode] = useState<'platform' | 'user' | 'both'>('platform');
  const [builderMode, setBuilderMode] = useState<'platform' | 'user' | 'both'>('platform');
  const [spendDistIncludeZero, setSpendDistIncludeZero] = useState(INITIAL_SPEND_DIST_ZERO);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // One host-level delegation drives every tooltip in the section. The
  // tooltip node lives on <body> so it can escape the section's overflow — it
  // must be removed here or it would linger (and keep showing stale copy)
  // after the section is gone.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const detach = attachTooltip(root);
    return () => {
      detach();
      const tip = document.getElementById('dc-tip');
      if (tip) tip.remove();
      for (const k of Object.keys(tipStore)) {
        if (!k.startsWith('info-') && !k.startsWith('card-')) delete tipStore[k];
      }
    };
  }, []);

  const withAdmins = (url: string) => {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}includeAdmins=${includeAdmins}${DEMO ? '&demo=1' : ''}`;
  };

  // Admin check up front. The data endpoints are independently enforced
  // server-side; this is just for a clean message. We do NOT navigate away on
  // an auth failure: a transient 401 shouldn't bounce an admin, and keeping
  // the shell rendered makes the page coherent under headless checks.
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const me = await getJSON('/api/auth/me');
        if (!alive.current) return;
        if (!me.user?.isAdmin) { setGate('Admin access required.'); return; }
        setAuthed(true);
      } catch {
        if (alive.current) setGate('Sign in as an admin to view analytics.');
      }
    })();
  }, []);

  // Every analytics endpoint, refetched when the admin flag flips. The old
  // module did this from the checkbox's change handler; it is a dependency
  // now, which is also why the flag can't get out of step with the payload.
  useEffect(() => {
    if (!authed) return;
    (async () => {
      try {
        const [overview, spend, growth, retention, generalUsers, powerUsers,
          topUsers, kudos, spendByBuilder, spendDistribution, limits] = await Promise.all([
          getJSON(withAdmins('/api/admin/analytics/overview')),
          getJSON(withAdmins('/api/admin/analytics/spend')),
          getJSON(withAdmins('/api/admin/analytics/growth')),
          getJSON(withAdmins('/api/admin/analytics/retention')),
          getJSON(withAdmins('/api/admin/analytics/general-users')),
          getJSON(withAdmins('/api/admin/analytics/power-users')),
          getJSON(withAdmins('/api/admin/analytics/top-users')),
          getJSON(withAdmins('/api/admin/analytics/kudos')),
          getJSON(withAdmins('/api/admin/analytics/spend-by-builder')),
          getJSON(withAdmins('/api/admin/analytics/spend-distribution')),
          // #361: system-token cap for the "today / cap" readout. Tolerate a
          // failure (non-admin-write tokens still GET it) — default stays 2500.
          getJSON('/api/admin/limits').catch(() => null),
        ]);
        if (!alive.current) return;
        setData({
          overview, spend, growth, retention, generalUsers, powerUsers,
          topUsers, kudos, spendByBuilder, spendDistribution,
          systemCapCents: limits && Number.isFinite(Number(limits.system_tokens_daily_limit_cents))
            ? Number(limits.system_tokens_daily_limit_cents) : 2500,
        });
      } catch (err: any) {
        if (!alive.current) return;
        setGate(err.forbidden ? 'Admin access required.' : 'Failed to load analytics data.');
      }
    })();
  }, [authed, includeAdmins]);

  // The funnels have their own cohort dimension, so they refetch on their own.
  useEffect(() => {
    if (!authed) return;
    (async () => {
      try {
        const f = await getJSON(withAdmins(`/api/admin/analytics/funnels?cohort=${encodeURIComponent(cohort)}`));
        if (alive.current) setFunnels(f);
      } catch { /* keep the previous funnel */ }
    })();
  }, [authed, includeAdmins, cohort]);

  const d = data;
  const daily = (d?.generalUsers && d.generalUsers.daily) || [];
  const wau = (d?.powerUsers && d.powerUsers.wau) || [];
  const l4 = (d?.powerUsers && d.powerUsers.l4) || [];
  const lastL4 = l4.length
    ? [Number(l4[l4.length - 1].b1) || 0, Number(l4[l4.length - 1].b2) || 0,
      Number(l4[l4.length - 1].b3) || 0, Number(l4[l4.length - 1].b4) || 0]
    : [0, 0, 0, 0];

  return (
    <div id="admin-analytics-root" ref={rootRef}>
      <h2 className="text-lg font-semibold mb-4">Analytics</h2>
      {gate ? <div id="admin-analytics-gate" className="text-zinc-500 dark:text-zinc-400 text-center py-20">{gate}</div> : null}

      {gate ? null : (
        <main id="admin-analytics-content" className="space-y-6">
          {/* Global controls */}
          <section className="flex items-center gap-2">
            <label className="inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400 cursor-pointer select-none">
              <input id="include-admins" type="checkbox"
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-600 focus:ring-violet-500"
                checked={includeAdmins}
                onChange={(e) => {
                  setIncludeAdmins(e.target.checked);
                  localStorage.setItem(ADMIN_KEY, String(e.target.checked));
                }} />
              <span>Include admin users in stats</span>
            </label>
            <InfoIcon info="include-admins" />
          </section>

          {/* Counters — ten cards: 5-across from xl fills the now-full-width
              console with two even rows instead of four very wide tiles. */}
          <section>
            <div className="flex items-center mb-2">
              <h3 className={H4}>Overview</h3>
              <InfoIcon info="counters" />
            </div>
            <div id="counters" className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-5 gap-3">
              {d ? <Counters o={d.overview} /> : null}
            </div>
          </section>

          {/* Daily spend */}
          <section className={`${AdminUI.card} p-4`}>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
              <h3 className={H3}>Daily spend<InfoIcon info="spend" /></h3>
              <ToggleGroup data-spend-toggle="spend" cls="spend-btn" attr="data-mode" value={spendMode}
                options={SPEND_MODES} onChange={setSpendMode} />
            </div>
            <p className={SUB}>LLM spend per day, last 30 days. Hover a bar for the amount.</p>
            <div id="spend">
              {d ? (((d.spend && d.spend.days) || []).length
                ? <Spend days={d.spend.days} mode={spendMode} includeAdmins={includeAdmins}
                  systemCapCents={d.systemCapCents} />
                : EMPTY) : null}
            </div>
          </section>

          {/* Funnels */}
          <section className={`${AdminUI.card} p-4`}>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
              <h3 className={H3}>Funnels<InfoIcon info="funnels" /></h3>
              <div className="flex flex-wrap items-center gap-1 text-xs">
                <span className="text-zinc-500 dark:text-zinc-400 mr-1">Cohort:</span>
                <ToggleGroup cls="cohort-btn" attr="data-cohort" value={cohort} onChange={setCohort} options={[
                  ['all', 'All time'], ['90d', 'Last 90d'], ['30d', 'Last 30d'], ['14d', 'Last 14d'],
                  ['7d', 'Last 7d'], ['3d', 'Last 3d'], ['1d', 'Last 1d'],
                ]} />
              </div>
            </div>
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <h4 className={`${H4} mb-3`}>Users using dapps</h4>
                <div id="funnel-dapp" className="space-y-2">
                  {funnels ? <Funnel includeAdmins={includeAdmins} stages={[
                    { label: 'Signed up', value: funnels.dappUsage.signed_up, admin: funnels.dappUsage.signed_up_admin },
                    { label: 'Opened a dapp', value: funnels.dappUsage.opened_dapp, admin: funnels.dappUsage.opened_dapp_admin },
                    { label: 'Returned (2+ days)', value: funnels.dappUsage.returned, admin: funnels.dappUsage.returned_admin },
                    { label: 'Engaged socially', value: funnels.dappUsage.engaged, admin: funnels.dappUsage.engaged_admin },
                    { label: 'Became a creator', value: funnels.dappUsage.creators, admin: funnels.dappUsage.creators_admin },
                  ]} /> : null}
                </div>
              </div>
              <div>
                <h4 className={`${H4} mb-3`}>Promoting PRs (dev sessions)</h4>
                <div id="funnel-pr" className="space-y-2">
                  {funnels ? <Funnel includeAdmins={includeAdmins} stages={[
                    { label: 'Dev session started', value: funnels.prSessions.started, admin: funnels.prSessions.started_admin },
                    { label: 'Produced a PR', value: funnels.prSessions.produced_pr, admin: funnels.prSessions.produced_pr_admin },
                    { label: 'Promoted to group', value: funnels.prSessions.promoted, admin: funnels.prSessions.promoted_admin },
                    { label: 'Received a vote', value: funnels.prSessions.received_vote, admin: funnels.prSessions.received_vote_admin },
                    { label: 'Merged', value: funnels.prSessions.merged, admin: funnels.prSessions.merged_admin },
                  ]} /> : null}
                </div>
                <h4 className={`${H4} mt-5 mb-3`}>Promoting PRs (distinct users)</h4>
                <div id="funnel-pr-users" className="space-y-2">
                  {funnels ? <Funnel includeAdmins={includeAdmins} stages={[
                    { label: 'Started building', value: funnels.prUsers.started, admin: funnels.prUsers.started_admin },
                    { label: 'Opened a PR', value: funnels.prUsers.produced_pr, admin: funnels.prUsers.produced_pr_admin },
                    { label: 'Promoted a PR', value: funnels.prUsers.promoted, admin: funnels.prUsers.promoted_admin },
                    { label: 'Got a PR merged', value: funnels.prUsers.merged, admin: funnels.prUsers.merged_admin },
                  ]} /> : null}
                </div>
              </div>
            </div>
          </section>

          {/* Growth */}
          <section className={`${AdminUI.card} p-4`}>
            <h3 className={`${H3} mb-1`}>Growth<InfoIcon info="growth" /></h3>
            <p className={SUB}>New signups, apps, promoted &amp; merged PRs per week.</p>
            <div id="growth" className="grid sm:grid-cols-2 gap-6">
              {d ? <Growth g={d.growth} includeAdmins={includeAdmins} /> : null}
            </div>
          </section>

          {/* General users (DAU / WAU / MAU, daily rolling windows) + retention */}
          <section className={`${AdminUI.card} p-4`}>
            <h3 className={`${H3} mb-1`}>General users<InfoIcon info="general-users" /></h3>
            <p className={SUB}>
              Anyone active during the period. Daily over the last 90 days — DAU per day, WAU a 7-day rolling window, MAU a 30-day rolling window.
            </p>
            <div className="grid lg:grid-cols-3 gap-6">
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">DAU</span>
                  <span id="gu-dau-latest" className="text-zinc-500 dark:text-zinc-400">{latestLabel(daily, 'dau')}</span>
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-2">Distinct users active that day.</p>
                <div id="gu-dau">
                  {d ? <DailySeries daily={daily} dataKey="dau" color="#6366f1"
                    def="Distinct users active that day." /> : null}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">WAU</span>
                  <span id="gu-wau-latest" className="text-zinc-500 dark:text-zinc-400">{latestLabel(daily, 'wau')}</span>
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-2">Distinct users active in the trailing 7 days.</p>
                <div id="gu-wau">
                  {d ? <DailySeries daily={daily} dataKey="wau" color="#60a5fa"
                    def="Distinct users active in the trailing 7 days." /> : null}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">MAU</span>
                  <span id="gu-mau-latest" className="text-zinc-500 dark:text-zinc-400">{latestLabel(daily, 'mau')}</span>
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-2">Distinct users active in the trailing 30 days.</p>
                <div id="gu-mau">
                  {d ? <DailySeries daily={daily} dataKey="mau" color="#34d399"
                    def="Distinct users active in the trailing 30 days." /> : null}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between flex-wrap gap-2 mt-8 mb-3">
              <h4 className={H4}>Retention cohorts</h4>
              <div className="flex flex-wrap items-center gap-1 text-xs">
                <span className="text-zinc-500 dark:text-zinc-400 mr-1">Align:</span>
                {/* Re-pivots the cached payload — no refetch. */}
                <ToggleGroup cls="retalign-btn" attr="data-retalign" value={retAlign} onChange={setRetAlign} options={[
                  ['calendar', 'Calendar aligned'], ['cohort', 'By cohort age'],
                ]} />
              </div>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
              Cohort = signup week. Each cell is the share of that cohort active (any action) in a given week.
            </p>
            <div id="retention-cohorts" className="overflow-x-auto">
              {d ? <Retention r={d.retention} mode={retAlign} /> : null}
            </div>
          </section>

          {/* Power users (rolling WAU + L4 consistency) */}
          <section className={`${AdminUI.card} p-4`}>
            <h3 className={`${H3} mb-1`}>Power users<InfoIcon info="power-users" /></h3>
            <p className={SUB}>
              A power user (per week) used dapps &ge; 3&times; AND did &ge; 3 developer actions (kudos, votes, or proposals). Daily over the last 90 days.
            </p>
            <div className="grid lg:grid-cols-2 gap-6">
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">Power-user WAU</span>
                  <span id="pu-wau-latest" className="text-zinc-500 dark:text-zinc-400">
                    {wau.length ? `${fmtInt(Number(wau[wau.length - 1].count) || 0)} latest` : ''}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-2">Distinct power users over the trailing 7 days.</p>
                <div id="pu-wau">{d ? (wau.length ? <PowerUserWau wau={wau} /> : EMPTY) : null}</div>
              </div>
              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-semibold text-zinc-700 dark:text-zinc-300">Consistency (L4)</span>
                  <span id="pu-l4-latest" className="text-zinc-500 dark:text-zinc-400">
                    {l4.length ? `${fmtInt(lastL4.reduce((a, b) => a + b, 0))} latest` : ''}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-2">
                  Per day, users stacked by how many of the trailing 4 weeks they were a power user.
                </p>
                <div id="pu-l4">{d ? (l4.length ? <PowerUserL4 l4={l4} /> : EMPTY) : null}</div>
              </div>
            </div>
          </section>

          {/* Top users by dev sessions */}
          <section className={`${AdminUI.card} p-4`}>
            <h3 className={`${H3} mb-1`}>Top builders<InfoIcon info="top-users" /></h3>
            <p className={SUB}>Top 30 users by lifetime dev sessions started, highest on the left. Hover a bar for the per-outcome breakdown.</p>
            <div id="top-users">
              {d ? (((d.topUsers && d.topUsers.users) || []).length
                ? <TopUsers users={d.topUsers.users} includeAdmins={includeAdmins} /> : EMPTY) : null}
            </div>
          </section>

          {/* Spend by builder */}
          <section className={`${AdminUI.card} p-4`}>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
              <h3 className={H3}>Spend by builder<InfoIcon info="spend-by-builder" /></h3>
              <ToggleGroup data-spend-toggle="spend-by-builder" cls="spend-btn" attr="data-mode" value={builderMode}
                options={SPEND_MODES} onChange={setBuilderMode} />
            </div>
            <p className={SUB}>Top 30 users by lifetime LLM spend, highest on the left. Hover a bar for the platform / user-key breakdown.</p>
            <div id="spend-by-builder">
              {d ? (((d.spendByBuilder && d.spendByBuilder.builders) || []).length
                ? <SpendByBuilder builders={d.spendByBuilder.builders} mode={builderMode} includeAdmins={includeAdmins} />
                : EMPTY) : null}
            </div>
          </section>

          {/* Daily spend distribution (user counts per spend bucket) */}
          <section className={`${AdminUI.card} p-4`}>
            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
              <h3 className={H3}>Daily spend distribution<InfoIcon info="spend-distribution" /></h3>
              <ToggleGroup data-zero-toggle="spend-distribution" cls="zero-btn" attr="data-zero"
                value={spendDistIncludeZero ? 'show' : 'hide'}
                options={[['hide', 'Hide $0'], ['show', 'Show $0']]}
                onChange={(v) => {
                  setSpendDistIncludeZero(v === 'show');
                  localStorage.setItem(SPEND_DIST_ZERO_KEY, String(v === 'show'));
                }} />
            </div>
            <p className={SUB}>
              Number of users by daily AI spend bucket, last 30 days. The two $20+ bars split users who hit the daily cap from those who continued on their own API key. $0 (no-spend) users are hidden by default — use &quot;Show $0&quot; to include them.
            </p>
            <div id="spend-distribution">
              {d ? (((d.spendDistribution && d.spendDistribution.days) || []).length
                ? <SpendDistribution days={d.spendDistribution.days} includeZero={spendDistIncludeZero} />
                : EMPTY) : null}
            </div>
          </section>

          {/* Kudos giving distribution */}
          <section className={`${AdminUI.card} p-4`}>
            <h3 className={`${H3} mb-1`}>Kudos participation<InfoIcon info="kudos" /></h3>
            <p className={SUB}>
              Per week, how many users gave 0, 1, 2, 3, 4–5, 6–10 or 11+ kudos
              (everyone gets a budget of 20/week).
              The 0 bucket is registered users who gave none that week.
            </p>
            <div id="kudos-weekly">
              {d ? (((d.kudos && d.kudos.weeks) || []).length ? <Kudos weeks={d.kudos.weeks} /> : EMPTY) : null}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

let host: Element | null = null;

const AdminAnalytics = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <AnalyticsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminAnalytics = AdminAnalytics;

export { AdminAnalytics };
