'use strict';

// Analytics section of the admin console (#860) — the retired standalone
// /dashboard page, ported into #admin/analytics.
//
// Every chart, tooltip, toggle and (?) explainer is carried over verbatim
// from public/js/dashboard.js + public/dashboard.html. Vanilla JS +
// hand-rolled SVG, so there is still no chart-lib dependency. Structural
// changes only:
//
//   - the whole module lives in an IIFE exposing `render(host)` /
//     `destroy()`, so AdminConsole owns its lifetime (dashboard.js used
//     to run `init()` at import time);
//   - the mouse-following tooltip's `<div id="dc-tip">` is appended to
//     <body> (it must escape the section's overflow), so `destroy()`
//     removes it and clears the tip store — otherwise the delegation
//     would keep firing over a torn-down section;
//   - `attachTooltip` binds to the SECTION HOST rather than document.body:
//     every [data-tip-id] element this module renders is inside the host,
//     and a body-level binding would survive section switches;
//   - the chart container ids (#counters, #spend, #gu-mau, #pu-l4,
//     #spend-distribution, …) are unchanged — dapp.json's rendered
//     checks pin them, and nothing else in the SPA uses those ids.
//     The page-level #gate / #content became #admin-analytics-gate /
//     #admin-analytics-content, which are generic enough to collide.
//   - the .dc-hover / .dc-info styles moved to public/css/app.css scoped
//     under #admin-analytics-root.
//
// #898 moved the "Progress estimator accuracy" card OUT of this section into
// its own #admin/estimator section (public/js/admin-estimator.js): everything
// left here is USER analytics, governed by the "Include admin users"
// checkbox, whereas the estimator card is platform analytics that
// deliberately ignores that flag.
//
// PERMISSIONS: admin-only, like every /api/admin/analytics/* endpoint it
// reads (adminMiddleware in src/routes/dashboard.js). Both full and
// view-only admins can see it — it's a pure read surface with no
// mutating controls, so there is no canAdminWrite gate here.

const AdminAnalytics = (() => {
  const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString());
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Admin accent colour (#341). A single amber, layered as the "admin" marker
  // on every colour-differentiated chart — verified unused in the existing
  // palette (violet #8b5cf6, lilac #a78bfa, green #34d399, blue #60a5fa, and
  // the kudos ramp). It only appears while the "Include admin users" box is
  // ticked; with the box off every chart looks exactly as it did before.
  const ADMIN_COLOR = '#f59e0b';

  // #361: system-token spend colour for the Daily-spend chart. A distinct
  // sky/cyan, clearly separate from platform violet (#8b5cf6), user-key
  // green (#34d399), and admin amber (#f59e0b).
  const SYSTEM_COLOR = '#06b6d4';

  // ── Module state ─────────────────────────────────────────────
  let host = null;
  let currentCohort = 'all';
  // Retention alignment toggle. 'calendar' (default) lines cohorts up on real
  // calendar weeks; 'cohort' shows W0/W1/… by cohort age. The last retention
  // payload is cached so the toggle re-pivots client-side with no refetch.
  let retAlign = 'calendar';
  let lastRetention = null;
  let lastSpend = null;
  let lastSpendByBuilder = null;
  let lastSpendDistribution = null;
  let spendMode = 'platform'; // 'platform' | 'user' | 'both'
  let builderMode = 'platform'; // 'platform' | 'user' | 'both'
  // #361: the admin-configured system-token daily cap (cents), loaded
  // alongside the spend series so the "today / cap" readout can show it.
  let systemCapCents = 2500;

  // Include-admins checkbox (#1). Default OFF (exclude admins); persisted
  // so an operator's preference survives reloads.
  const ADMIN_KEY = 'dashIncludeAdmins';
  let includeAdmins = localStorage.getItem(ADMIN_KEY) === 'true';

  // Whether the muted $0 (no-spend) bucket is drawn. Default OFF: the $0 block
  // dwarfs the paid buckets, so hiding it makes the paid distribution readable.
  const SPEND_DIST_ZERO_KEY = 'dashSpendDistIncludeZero';
  let spendDistIncludeZero = localStorage.getItem(SPEND_DIST_ZERO_KEY) === 'true';

  const dollars = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
  const SPEND_PLATFORM = '#8b5cf6';
  const SPEND_USERKEY = '#34d399';

  // The small "Non-admin / Admin" swatch legend, reusing the inline-swatch
  // markup the spend "Both" legend already uses. Rendered only while admins
  // are included; the non-admin swatch defaults to violet but can be set to a
  // chart's own base colour.
  function adminLegend(nonAdminColor = '#8b5cf6') {
    if (!includeAdmins) return '';
    return `<div class="flex items-center gap-3 text-[10px] text-zinc-400 mb-2">
      <span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${nonAdminColor}"></span> Non-admin</span>
      <span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${ADMIN_COLOR}"></span> Admin</span>
    </div>`;
  }

  // ── Hover tooltip ─────────────────────────────────────────────
  // Native SVG <title> tooltips are slow and only fire over the painted
  // bar, so columns with a short/zero bar feel "dead". Instead each chart
  // lays a full-height transparent hover rect over every column tagged with
  // data-tip-id, and we look the rich HTML up from this store on hover. The
  // floating div follows the cursor and flips to stay on-screen.
  const tipStore = {};
  function ensureTip() {
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
  // Wire mouse-following tooltips on a container via event delegation. The
  // container element survives innerHTML swaps, so binding once is enough;
  // the dataset guard makes repeat calls no-ops.
  function attachTooltip(container) {
    if (!container || container.dataset.tipBound) return;
    container.dataset.tipBound = '1';
    const tip = ensureTip();
    container.addEventListener('mousemove', (e) => {
      const el = e.target.closest('[data-tip-id]');
      const html = el && tipStore[el.dataset.tipId];
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
    });
    container.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }

  // Show the floating tip anchored to an element's box (used for keyboard
  // focus on the (?) icons, where there's no cursor to follow).
  function showTipAt(el, html) {
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

  // ── (?) info icons ────────────────────────────────────────────
  // Plain-language explanation per chart/box. Keyed by the data-info
  // attribute on each .dc-info icon in the markup below.
  const INFO = {
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
  // card's number is actually computed (see renderCounters + the /overview SQL).
  const CARD_INFO = {
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

  // Register one (?) icon for keyboard focus + mouse hover: stash its copy in
  // the tip store, tag it with data-tip-id (the host-level delegation drives
  // the mouse tooltip), and wire focus/blur for keyboard access.
  function wireInfoIcon(el, tipId, html) {
    if (!html) return;
    tipStore[tipId] = html;
    el.dataset.tipId = tipId;
    el.addEventListener('focus', () => showTipAt(el, html));
    el.addEventListener('blur', () => { ensureTip().style.display = 'none'; });
  }

  // Wire the chart/section (?) icons. Idempotent — safe to call once after render.
  function wireInfoIcons() {
    if (!host) return;
    host.querySelectorAll('.dc-info[data-info]').forEach((el) => {
      const key = el.dataset.info;
      wireInfoIcon(el, `info-${key}`, INFO[key]);
    });
    // One host-level delegation drives the mouse-following tooltip for the
    // icons (and any other [data-tip-id] outside a chart container).
    attachTooltip(host);
  }

  // Short "Mar 3" style label for a week-start. The API returns these as
  // 'YYYY-MM-DD' text; we also tolerate full ISO strings / Date objects so
  // a stray value can never render as "Invalid Date".
  function weekLabel(d) {
    if (!d) return '';
    const s = String(d);
    const dt = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00Z') : new Date(s);
    if (isNaN(dt.getTime())) return '';
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  // Short "Mar 3" style label for a single calendar day. Same formatting as
  // weekLabel — kept as its own name so day-resolution call sites read clearly.
  function dayLabel(d) {
    return weekLabel(d);
  }

  async function getJSON(url) {
    const res = await fetch(url);
    if (res.status === 403 || res.status === 401) {
      const err = new Error('forbidden');
      err.forbidden = true;
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  const $ = (id) => document.getElementById(id);

  // ── Counters ──────────────────────────────────────────────────
  function renderCounters(o) {
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
    const el = $('counters');
    if (!el) return;
    el.innerHTML = cards.map((c) => `
      <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
        <div class="flex items-start justify-between gap-1">
          <div class="text-xs uppercase tracking-wide text-zinc-500">${esc(c.label)}</div>
          <span class="dc-info" data-card-info="${c.id}" tabindex="0" role="button" aria-label="What is this?">?</span>
        </div>
        <div class="text-2xl font-bold mt-1">${esc(c.value)}</div>
      </div>`).join('');
    // Register each per-card (?) icon: tip-store copy + focus wiring. The
    // host-level delegation (wired in init) already drives the mouse tooltip.
    cards.forEach((c) => {
      const icon = el.querySelector(`.dc-info[data-card-info="${c.id}"]`);
      if (icon) wireInfoIcon(icon, `card-${c.id}`, CARD_INFO[c.id]);
    });
  }

  // ── Funnel bars ───────────────────────────────────────────────
  // stages: [{ label, value, admin }]. Bar width is relative to the first
  // stage's total; the caption shows the absolute count and the step-over-step
  // conversion. When admins are included (#341) each stage bar splits into a
  // non-admin (violet) segment plus an amber admin segment.
  function renderFunnel(containerId, stages) {
    const stageTotal = (s) => (Number(s.value) || 0) + (Number(s.admin) || 0);
    const top = stages[0] ? stageTotal(stages[0]) : 0;
    const anyAdmin = includeAdmins && stages.some((s) => (Number(s.admin) || 0) > 0);
    const html = stages.map((s, i) => {
      const value = Number(s.value) || 0;
      const admin = Number(s.admin) || 0;
      const total = value + admin;
      // Width relative to the first stage's total. Keep a 2% floor on a
      // non-zero total so a tiny stage is still visible.
      const naW = top > 0 ? (value / top) * 100 : 0;
      const adW = top > 0 ? (admin / top) * 100 : 0;
      const floor = total > 0 && naW + adW < 2 ? 2 - (naW + adW) : 0;
      const conv = i === 0
        ? '100%'
        : `${pct(total, stageTotal(stages[i - 1]))}% of prev`;
      const count = anyAdmin && admin > 0
        ? `${fmtInt(total)} · ${fmtInt(admin)} admin`
        : fmtInt(total);
      return `
        <div>
          <div class="flex items-center justify-between text-xs mb-1">
            <span class="text-zinc-600 dark:text-zinc-300">${esc(s.label)}</span>
            <span class="text-zinc-500">${count} · ${conv}</span>
          </div>
          <div class="h-6 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden flex">
            <div class="h-full bg-violet-600" style="width:${(naW + floor).toFixed(2)}%"></div>
            <div class="h-full" style="width:${adW.toFixed(2)}%;background:${ADMIN_COLOR}"></div>
          </div>
        </div>`;
    }).join('');
    const el = $(containerId);
    if (el) el.innerHTML = adminLegend('#7c3aed') + html;
  }

  function renderFunnels(f) {
    const d = f.dappUsage;
    renderFunnel('funnel-dapp', [
      { label: 'Signed up', value: d.signed_up, admin: d.signed_up_admin },
      { label: 'Opened a dapp', value: d.opened_dapp, admin: d.opened_dapp_admin },
      { label: 'Returned (2+ days)', value: d.returned, admin: d.returned_admin },
      { label: 'Engaged socially', value: d.engaged, admin: d.engaged_admin },
      { label: 'Became a creator', value: d.creators, admin: d.creators_admin },
    ]);

    const s = f.prSessions;
    renderFunnel('funnel-pr', [
      { label: 'Dev session started', value: s.started, admin: s.started_admin },
      { label: 'Produced a PR', value: s.produced_pr, admin: s.produced_pr_admin },
      { label: 'Promoted to group', value: s.promoted, admin: s.promoted_admin },
      { label: 'Received a vote', value: s.received_vote, admin: s.received_vote_admin },
      { label: 'Merged', value: s.merged, admin: s.merged_admin },
    ]);

    const u = f.prUsers;
    renderFunnel('funnel-pr-users', [
      { label: 'Started building', value: u.started, admin: u.started_admin },
      { label: 'Opened a PR', value: u.produced_pr, admin: u.produced_pr_admin },
      { label: 'Promoted a PR', value: u.promoted, admin: u.promoted_admin },
      { label: 'Got a PR merged', value: u.merged, admin: u.merged_admin },
    ]);
  }

  // Horizontal gridlines for a chart of height H drawn over usable height
  // (H - pad). `steps` evenly spaced lines from baseline to top. Uses
  // currentColor at low opacity so it adapts to light/dark theme.
  function gridLines(W, H, steps, pad) {
    let out = '';
    for (let i = 0; i <= steps; i++) {
      const y = (H - (i / steps) * (H - pad)).toFixed(1);
      out += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="currentColor" stroke-opacity="0.12" stroke-width="0.5" />`;
    }
    return out;
  }

  // ── Mini bar chart (growth) ───────────────────────────────────
  function barChart(values, labels, color, opts = {}) {
    const admin = opts.adminValues || [];
    // Scale to the per-column total so the stacked admin segment never clips.
    const max = Math.max(1, ...values.map((v, i) => v + (Number(admin[i]) || 0)));
    const W = 320, H = 90, n = values.length, pad = 14;
    const bw = n > 0 ? (W / n) : W;
    const grid = opts.grid ? gridLines(W, H, 4, pad) : '';
    const rich = opts.tipPrefix && typeof opts.tip === 'function';
    const bars = values.map((v, i) => {
      const a = Number(admin[i]) || 0;
      const hBase = Math.round((v / max) * (H - pad));
      const hAdmin = Math.round((a / max) * (H - pad));
      const x = i * bw;
      const yBase = H - hBase;
      const yAdmin = yBase - hAdmin;
      const x0 = (x + 1).toFixed(1);
      const w = Math.max(1, bw - 2).toFixed(1);
      const adminRect = a > 0
        ? `<rect x="${x0}" y="${yAdmin}" width="${w}" height="${hAdmin}" fill="${ADMIN_COLOR}" rx="1"></rect>`
        : '';
      if (rich) {
        const tipId = `${opts.tipPrefix}-${i}`;
        tipStore[tipId] = opts.tip(i);
        return `<rect x="${x0}" y="${yBase}" width="${w}" height="${hBase}" fill="${color}" rx="1"></rect>${adminRect}` +
          `<rect class="dc-hover" x="${x.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}" fill="${color}" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
      }
      return `<rect x="${x0}" y="${yBase}" width="${w}" height="${hBase}" fill="${color}" rx="1">
        <title>${esc(labels[i])}: ${v}</title></rect>${adminRect}`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full text-zinc-500" preserveAspectRatio="none" style="height:90px">${grid}${bars}</svg>`;
  }

  function renderGrowth(g) {
    const weeks = g.weeks || [];
    const labels = weeks.map((w) => weekLabel(w.wk));
    const series = [
      { key: 'new_users', label: 'New users', color: '#8b5cf6' },
      { key: 'new_apps', label: 'New apps', color: '#a78bfa' },
      { key: 'promoted_prs', label: 'Promoted PRs', color: '#34d399' },
      { key: 'merged_prs', label: 'Merged PRs', color: '#60a5fa' },
    ];
    const el = $('growth');
    if (!el) return;
    const body = series.map((s) => {
      const vals = weeks.map((w) => Number(w[s.key]) || 0);
      const adminVals = weeks.map((w) => Number(w[`${s.key}_admin`]) || 0);
      const total = vals.reduce((a, b) => a + b, 0);
      const totalAdmin = adminVals.reduce((a, b) => a + b, 0);
      const showAdmin = includeAdmins && totalAdmin > 0;
      const tip = (i) => `<div class="font-semibold">${esc(s.label)}</div>
        <div class="text-zinc-300">Week of ${esc(labels[i] || '')}</div>
        <div class="text-zinc-300">${fmtInt(vals[i] + adminVals[i])}${includeAdmins && adminVals[i] > 0 ? ` · ${fmtInt(adminVals[i])} admin` : ''}</div>`;
      return `
        <div>
          <div class="flex items-center justify-between text-xs mb-1">
            <span class="text-zinc-600 dark:text-zinc-300">${esc(s.label)}</span>
            <span class="text-zinc-500">${fmtInt(total + totalAdmin)} total${showAdmin ? ` · ${fmtInt(totalAdmin)} admin` : ''}</span>
          </div>
          ${barChart(vals, labels, s.color, { grid: true, tipPrefix: `growth-${s.key}`, tip, adminValues: adminVals })}
          <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
            <span>${esc(labels[0] || '')}</span>
            <span>${esc(labels[labels.length - 1] || '')}</span>
          </div>
        </div>`;
    }).join('');
    // The legend spans the full grid width so it reads as one chart-wide key.
    const legend = includeAdmins
      ? `<div class="sm:col-span-2">${adminLegend()}</div>` : '';
    el.innerHTML = legend + body;
    attachTooltip(el);
  }

  // Empty-state markup shared by the daily charts.
  const EMPTY_MSG = '<p class="text-sm text-zinc-500">Not enough data yet.</p>';

  // ── Daily line chart ──────────────────────────────────────────
  // A polyline over ~90 daily points (too dense for per-day bars). Each
  // point gets a tiny dot plus a full-height transparent hit-band so the
  // whole column is hoverable.
  function lineChart(values, labels, color, opts = {}) {
    const n = values.length;
    const W = 320, H = 90, pad = 14;
    const vals = values.map((v) => Number(v) || 0);
    const max = Math.max(1, ...vals);
    const grid = opts.grid ? gridLines(W, H, 4, pad) : '';
    const step = n > 1 ? W / (n - 1) : W;
    const x = (i) => i * step;
    const y = (v) => H - (v / max) * (H - pad);
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const rich = opts.tipPrefix && typeof opts.tip === 'function';
    const overlay = vals.map((v, i) => {
      let attrs = '';
      if (rich) { const tipId = `${opts.tipPrefix}-${i}`; tipStore[tipId] = opts.tip(i); attrs = ` data-tip-id="${tipId}"`; }
      const band = `<rect class="dc-hover" x="${(x(i) - step / 2).toFixed(1)}" y="0" width="${Math.max(1, step).toFixed(1)}" height="${H}" fill="${color}" fill-opacity="0" pointer-events="all"${attrs}></rect>`;
      const dot = `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.5" fill="${color}"></circle>`;
      return band + dot;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full text-zinc-500" style="height:90px">${grid}` +
      `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" />${overlay}</svg>`;
  }

  // ── Stacked bar chart ─────────────────────────────────────────
  // `stacks` is an array (one per column) of segment arrays, bottom-to-top.
  // `colors[si]` paints segment si. Used by the power-user L4 chart.
  function stackedBarChart(stacks, labels, colors, opts = {}) {
    const n = stacks.length;
    const W = 320, H = 90, pad = 14;
    const totals = stacks.map((s) => s.reduce((a, b) => a + (Number(b) || 0), 0));
    const max = Math.max(1, ...totals);
    const grid = opts.grid ? gridLines(W, H, 4, pad) : '';
    const bw = n > 0 ? (W / n) : W;
    const rich = opts.tipPrefix && typeof opts.tip === 'function';
    const bars = stacks.map((segs, i) => {
      const x = i * bw;
      const x0 = (x + 0.4).toFixed(1);
      const w = Math.max(0.6, bw - 0.8).toFixed(1);
      let cursor = H;
      let rects = '';
      segs.forEach((seg, si) => {
        const val = Number(seg) || 0;
        if (val <= 0) return;
        const h = (val / max) * (H - pad);
        cursor -= h;
        rects += `<rect x="${x0}" y="${cursor.toFixed(1)}" width="${w}" height="${h.toFixed(1)}" fill="${colors[si]}"></rect>`;
      });
      let hover = '';
      if (rich) {
        const tipId = `${opts.tipPrefix}-${i}`;
        tipStore[tipId] = opts.tip(i);
        hover = `<rect class="dc-hover" x="${x.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}" fill="${colors[colors.length - 1]}" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
      }
      return rects + hover;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full text-zinc-500" preserveAspectRatio="none" style="height:90px">${grid}${bars}</svg>`;
  }

  // ── Retention cohort grid ─────────────────────────────────────
  // `mode` selects the alignment:
  //   'calendar' (default) — columns are absolute calendar weeks.
  //   'cohort' — columns are W0, W1, … from each cohort's own signup week.
  function addWeeksISO(dateStr, k) {
    const dt = new Date(String(dateStr) + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + k * 7);
    return dt.toISOString().slice(0, 10);
  }

  function renderRetention(r, mode) {
    const m = mode || retAlign || 'calendar';
    const cohorts = ((r && r.cohorts) || []).slice().sort((a, b) =>
      (a.cohortWeek < b.cohortWeek ? 1 : -1)); // newest first
    const el = $('retention-cohorts');
    if (!el) return;
    if (!cohorts.length) { el.innerHTML = EMPTY_MSG; return; }

    // One coloured cell. `key` makes the tooltip id unique within the row.
    const cell = (v, size, headLabel, ci, key) => {
      if (v == null) return '<td class="px-2 py-1 text-center text-zinc-400 dark:text-zinc-700">·</td>';
      const p = pct(v, size);
      const alpha = Math.max(0.06, Math.min(1, p / 100));
      const tipId = `ret-${ci}-${key}`;
      tipStore[tipId] = `<div class="font-semibold">${esc(headLabel)}</div>
        <div class="text-zinc-300">${fmtInt(v)} of ${fmtInt(size)} active</div>
        <div class="text-zinc-300">${p}% retained</div>`;
      return `<td class="px-2 py-1 text-center" data-tip-id="${tipId}" style="background:rgba(139,92,246,${alpha});cursor:pointer">
        <span class="text-[11px] ${p >= 45 ? 'text-white' : 'text-zinc-600 dark:text-zinc-300'}">${p}%</span></td>`;
    };

    const head = ['<th class="text-left px-2 py-1 font-medium text-zinc-400">Cohort</th>',
      '<th class="px-2 py-1 font-medium text-zinc-400">Users</th>'];
    let rows;

    if (m === 'cohort') {
      let maxOffset = 0;
      for (const c of cohorts) for (const k of Object.keys(c.offsets)) maxOffset = Math.max(maxOffset, Number(k));
      maxOffset = Math.min(maxOffset, 11); // keep the triangle readable
      for (let k = 0; k <= maxOffset; k++) head.push(`<th class="px-2 py-1 font-medium text-zinc-400">W${k}</th>`);
      rows = cohorts.map((c, ci) => {
        const cells = [];
        for (let k = 0; k <= maxOffset; k++) {
          cells.push(cell(c.offsets[k], c.cohortSize, `${weekLabel(c.cohortWeek)} cohort · Week ${k}`, ci, `w${k}`));
        }
        return `<tr>
          <td class="px-2 py-1 whitespace-nowrap text-zinc-600 dark:text-zinc-300">${esc(weekLabel(c.cohortWeek))}</td>
          <td class="px-2 py-1 text-center text-zinc-400">${fmtInt(c.cohortSize)}</td>
          ${cells.join('')}
        </tr>`;
      }).join('');
    } else {
      // Calendar aligned — shared, sorted set of absolute week columns.
      const weekSet = new Set();
      const cal = cohorts.map((c) => {
        const map = {};
        for (const k of Object.keys(c.offsets)) {
          const wk = addWeeksISO(c.cohortWeek, Number(k));
          map[wk] = c.offsets[k];
          weekSet.add(wk);
        }
        return map;
      });
      const allCols = Array.from(weekSet).sort(); // ascending YYYY-MM-DD
      const cols = allCols.slice(Math.max(0, allCols.length - 12)); // keep readable
      for (const wk of cols) head.push(`<th class="px-2 py-1 font-medium text-zinc-400 whitespace-nowrap">${esc(weekLabel(wk))}</th>`);
      rows = cohorts.map((c, ci) => {
        const map = cal[ci];
        const cells = cols.map((wk) =>
          cell(map[wk], c.cohortSize, `${weekLabel(c.cohortWeek)} cohort · week of ${weekLabel(wk)}`, ci, wk)).join('');
        return `<tr>
          <td class="px-2 py-1 whitespace-nowrap text-zinc-600 dark:text-zinc-300">${esc(weekLabel(c.cohortWeek))}</td>
          <td class="px-2 py-1 text-center text-zinc-400">${fmtInt(c.cohortSize)}</td>
          ${cells}
        </tr>`;
      }).join('');
    }

    el.innerHTML = `<table class="text-xs border-collapse"><thead><tr>${head.join('')}</tr></thead><tbody>${rows}</tbody></table>`;
    attachTooltip(el);
  }

  // ── General users (DAU / WAU / MAU daily rolling windows) ──────
  function renderGeneralUsers(g) {
    const daily = (g && g.daily) || [];
    const labels = daily.map((r) => dayLabel(r.day));
    const block = (containerId, latestId, key, color, def) => {
      const el = $(containerId);
      if (!el) return;
      const latestEl = $(latestId);
      if (!daily.length) { el.innerHTML = EMPTY_MSG; if (latestEl) latestEl.textContent = ''; return; }
      const vals = daily.map((r) => Number(r[key]) || 0);
      const tip = (i) => `<div class="font-semibold">${esc(labels[i] || '')}</div>
        <div class="text-zinc-300">${fmtInt(vals[i])} users</div>
        <div class="text-zinc-500 mt-1 text-[11px]">${def}</div>`;
      el.innerHTML = `${lineChart(vals, labels, color, { grid: true, tipPrefix: `gu-${key}`, tip })}
        <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
          <span>${esc(labels[0] || '')}</span>
          <span>${esc(labels[labels.length - 1] || '')}</span>
        </div>`;
      attachTooltip(el);
      if (latestEl) latestEl.textContent = `${fmtInt(vals[vals.length - 1])} latest`;
    };
    block('gu-dau', 'gu-dau-latest', 'dau', '#8b5cf6', 'Distinct users active that day.');
    block('gu-wau', 'gu-wau-latest', 'wau', '#60a5fa', 'Distinct users active in the trailing 7 days.');
    block('gu-mau', 'gu-mau-latest', 'mau', '#34d399', 'Distinct users active in the trailing 30 days.');
  }

  // ── Power users (rolling WAU + L4 consistency) ────────────────
  // Four violet shades for the L4 buckets: light (1/4) → dark (4/4).
  const L4_COLORS = ['#ddd6fe', '#a78bfa', '#7c3aed', '#5b21b6'];

  function l4Legend() {
    const items = [['1/4', L4_COLORS[0]], ['2/4', L4_COLORS[1]], ['3/4', L4_COLORS[2]], ['4/4', L4_COLORS[3]]];
    return '<div class="flex items-center gap-3 text-[10px] text-zinc-400 mb-2">' +
      items.map(([lab, c]) => `<span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${c}"></span> ${lab}</span>`).join('') +
      '</div>';
  }

  function renderPowerUsers(p) {
    // Rolling power-user WAU (daily line).
    const wau = (p && p.wau) || [];
    const wEl = $('pu-wau');
    const wLatest = $('pu-wau-latest');
    if (wEl) {
      if (!wau.length) { wEl.innerHTML = EMPTY_MSG; if (wLatest) wLatest.textContent = ''; }
      else {
        const labels = wau.map((r) => dayLabel(r.day));
        const vals = wau.map((r) => Number(r.count) || 0);
        const tip = (i) => `<div class="font-semibold">${esc(labels[i] || '')}</div>
          <div class="text-zinc-300">${fmtInt(vals[i])} power users</div>
          <div class="text-zinc-500 mt-1 text-[11px]">Trailing 7-day window.</div>`;
        wEl.innerHTML = `${lineChart(vals, labels, '#8b5cf6', { grid: true, tipPrefix: 'pu-wau', tip })}
          <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
            <span>${esc(labels[0] || '')}</span>
            <span>${esc(labels[labels.length - 1] || '')}</span>
          </div>`;
        attachTooltip(wEl);
        if (wLatest) wLatest.textContent = `${fmtInt(vals[vals.length - 1])} latest`;
      }
    }

    // L4 consistency (daily stacked bars: 1/4…4/4 of trailing four weeks).
    const l4 = (p && p.l4) || [];
    const lEl = $('pu-l4');
    const lLatest = $('pu-l4-latest');
    if (lEl) {
      if (!l4.length) { lEl.innerHTML = EMPTY_MSG; if (lLatest) lLatest.textContent = ''; return; }
      const labels = l4.map((r) => dayLabel(r.day));
      const stacks = l4.map((r) => [Number(r.b1) || 0, Number(r.b2) || 0, Number(r.b3) || 0, Number(r.b4) || 0]);
      const tip = (i) => {
        const s = stacks[i];
        const total = s.reduce((a, b) => a + b, 0);
        return `<div class="font-semibold">${esc(labels[i] || '')}</div>
          <div class="text-zinc-300">${fmtInt(total)} power users (trailing 4 wks)</div>
          <div class="text-zinc-400 mt-1 text-[11px]">4/4 ${fmtInt(s[3])} · 3/4 ${fmtInt(s[2])} · 2/4 ${fmtInt(s[1])} · 1/4 ${fmtInt(s[0])}</div>`;
      };
      lEl.innerHTML = `${l4Legend()}
        ${stackedBarChart(stacks, labels, L4_COLORS, { grid: true, tipPrefix: 'pu-l4', tip })}
        <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
          <span>${esc(labels[0] || '')}</span>
          <span>${esc(labels[labels.length - 1] || '')}</span>
        </div>`;
      attachTooltip(lEl);
      const last = stacks[stacks.length - 1] || [0, 0, 0, 0];
      if (lLatest) lLatest.textContent = `${fmtInt(last.reduce((a, b) => a + b, 0))} latest`;
    }
  }

  // ── Top users by dev sessions started ─────────────────────────
  // Descending left-to-right bars, one per user. Labels rotate under each
  // bar (truncated); exact username + count live in the hover tooltip.
  function renderTopUsers(d) {
    const users = d.users || [];
    const el = $('top-users');
    if (!el) return;
    if (!users.length) {
      el.innerHTML = EMPTY_MSG;
      return;
    }
    const vals = users.map((u) => Number(u.sessions) || 0);
    const max = Math.max(1, ...vals);
    const H = 200, topPad = 14, botPad = 52; // room for value + rotated label
    const plot = H - topPad - botPad;
    const bw = 26; // per-bar slot
    const W = users.length * bw;
    const grid = (() => {
      let out = '';
      for (let i = 0; i <= 4; i++) {
        const y = (topPad + (i / 4) * plot).toFixed(1);
        out += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="currentColor" stroke-opacity="0.12" stroke-width="0.5" />`;
      }
      return out;
    })();
    const bars = users.map((u, i) => {
      const v = vals[i];
      const h = Math.round((v / max) * plot);
      const x = i * bw;
      const y = topPad + (plot - h);
      const cx = x + bw / 2;
      const short = u.name.length > 10 ? u.name.slice(0, 9) + '…' : u.name;
      const tipId = `top-${i}`;
      const producedPr = Number(u.produced_pr) || 0;
      const promoted = Number(u.promoted) || 0;
      const receivedVote = Number(u.received_vote) || 0;
      const merged = Number(u.merged) || 0;
      const tipRow = (label, n) =>
        `<div class="flex justify-between gap-3 text-zinc-400"><span>${label}</span><span class="text-zinc-300">${n}</span></div>`;
      // Each bar is a single user, so an admin builder gets the whole bar in
      // amber (#341) instead of the usual violet, and "(admin)" in the header.
      const isAdmin = includeAdmins && !!u.is_admin;
      const barColor = isAdmin ? ADMIN_COLOR : '#8b5cf6';
      tipStore[tipId] = `<div class="font-semibold">${esc(u.name)}${isAdmin ? ' (admin)' : ''}</div>
        <div class="text-zinc-300 mb-1">#${i + 1} · ${v} dev session${v === 1 ? '' : 's'}</div>
        ${tipRow('Produced a PR', producedPr)}
        ${tipRow('Promoted to group', promoted)}
        ${tipRow('Received a vote', receivedVote)}
        ${tipRow('Merged', merged)}`;
      return `
        <rect x="${(x + 3).toFixed(1)}" y="${y}" width="${bw - 6}" height="${h}" fill="${barColor}" rx="2"></rect>
        <text x="${cx}" y="${y - 3}" text-anchor="middle" font-size="9" fill="currentColor" class="text-zinc-400">${v}</text>
        <text x="${cx}" y="${H - botPad + 12}" text-anchor="end" font-size="9" fill="currentColor"
              class="text-zinc-400" transform="rotate(-55 ${cx} ${H - botPad + 12})">${esc(short)}</text>
        <rect class="dc-hover" x="${x.toFixed(1)}" y="${topPad}" width="${bw.toFixed(1)}" height="${plot}"
              fill="#8b5cf6" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
    }).join('');
    el.innerHTML = `${adminLegend()}
      <div class="overflow-x-auto">
        <svg viewBox="0 0 ${W} ${H}" style="height:200px;min-width:${W}px" class="text-zinc-500">
          ${grid}${bars}
        </svg>
      </div>`;
    attachTooltip(el);
  }

  // ── Kudos giving distribution (weekly) ────────────────────────
  // One stacked bar per week. Segments = number of users whose kudos-giving
  // that week fell in each band: 0, 1, 2, 3, 4–5, 6–10, 11+ (0 = registered
  // users who gave none). Bands, not exact counts, since #964 raised the
  // weekly allowance to 20 — see the endpoint's comment in routes/dashboard.js.
  function renderKudos(d) {
    const weeks = d.weeks || [];
    const el = $('kudos-weekly');
    if (!el) return;
    if (!weeks.length) {
      el.innerHTML = EMPTY_MSG;
      return;
    }
    // 0 first (drawn at the bottom, muted); the giving bands stacked above
    // in the same six-step ramp. #964 rebanded the top three steps from the
    // exact counts 3/4/5 to 3, 4–5, 6–10, 11+ when the weekly allowance rose
    // to 20 — the colours are unchanged, so a week's bar keeps reading the
    // same way; only what the upper segments mean widened.
    const segs = [
      { key: 'g0', label: '0', color: '#3f3f5a' },
      { key: 'g1', label: '1', color: '#c4b5fd' },
      { key: 'g2', label: '2', color: '#a78bfa' },
      { key: 'g3', label: '3', color: '#8b5cf6' },
      { key: 'g4_5', label: '4–5', color: '#7c3aed' },
      { key: 'g6_10', label: '6–10', color: '#5b21b6' },
      { key: 'g11p', label: '11+', color: '#4c1d95' },
    ];
    const totals = weeks.map((w) => segs.reduce((a, s) => a + (Number(w[s.key]) || 0), 0));
    const max = Math.max(1, ...totals);
    const W = 640, H = 180, topPad = 14, botPad = 18, n = weeks.length;
    const plot = H - topPad - botPad;
    const bw = W / n;
    const grid = (() => {
      let out = '';
      for (let i = 0; i <= 4; i++) {
        const y = (topPad + (i / 4) * plot).toFixed(1);
        out += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="currentColor" stroke-opacity="0.12" stroke-width="0.5" />`;
      }
      return out;
    })();
    const labels = weeks.map((w) => weekLabel(w.wk));
    const isCurrent = (i) => i === weeks.length - 1;
    const bars = weeks.map((w, i) => {
      let acc = 0; // running height from baseline, in value units
      const x = i * bw;
      const segRects = segs.map((s) => {
        const v = Number(w[s.key]) || 0;
        if (v <= 0) return '';
        const h = (v / max) * plot;
        const yBottom = topPad + plot - (acc / max) * plot;
        acc += v;
        const y = yBottom - h;
        return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"></rect>`;
      }).join('');

      // Per-week breakdown tooltip covering the full column height. Banded
      // buckets can't yield an exact kudos total any more (a "6–10" bucket
      // is 6..10 each), so the headline reports the one figure the bands DO
      // give exactly — how many people gave at all that week — rather than a
      // weighted guess dressed up as a count.
      const n11p = Number(w.g11p) || 0, n6_10 = Number(w.g6_10) || 0, n4_5 = Number(w.g4_5) || 0;
      const n3 = Number(w.g3) || 0, n2 = Number(w.g2) || 0, n1 = Number(w.g1) || 0;
      const n0 = Number(w.g0) || 0;
      const givers = n11p + n6_10 + n4_5 + n3 + n2 + n1;
      const row = (label, num) => `<div class="flex justify-between gap-3"><span class="text-zinc-400">${label}</span><span>${num}</span></div>`;
      const tipId = `kudos-${i}`;
      tipStore[tipId] = `<div class="font-semibold mb-1">${esc(labels[i])}${isCurrent(i) ? ' (current)' : ''}</div>
        <div class="mb-1">${givers} giver${givers === 1 ? '' : 's'} this week</div>
        <div class="text-[11px] leading-tight">
          ${row('gave 11+', n11p)}${row('gave 6–10', n6_10)}${row('gave 4–5', n4_5)}${row('gave 3', n3)}${row('gave 2', n2)}${row('gave 1', n1)}${row('gave 0', n0)}
        </div>`;
      const overlay = `<rect class="dc-hover" x="${x.toFixed(1)}" y="${topPad}" width="${bw.toFixed(1)}" height="${plot}"
        fill="#8b5cf6" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
      return segRects + overlay;
    }).join('');
    const legend = segs.slice().reverse().map((s) =>
      `<span class="inline-flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-sm" style="background:${s.color}"></span>${s.label}</span>`
    ).join('');
    const lastLabel = labels[labels.length - 1] || '';
    el.innerHTML = `
      <div class="flex flex-wrap items-center gap-3 text-xs text-zinc-400 mb-2">
        <span class="text-zinc-500">Kudos given that week:</span>${legend}
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="w-full text-zinc-500" preserveAspectRatio="none" style="height:180px">
        ${grid}${bars}
      </svg>
      <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
        <span>${esc(labels[0] || '')}</span>
        <span>${esc(lastLabel)} (current)</span>
      </div>`;
    attachTooltip(el);
  }

  // ── Daily spend distribution (last 30 days) ───────────────────
  function renderSpendDistribution() {
    const d = lastSpendDistribution || {};
    const days = d.days || [];
    const el = $('spend-distribution');
    if (!el) return;
    if (!days.length) {
      el.innerHTML = EMPTY_MSG;
      return;
    }
    // b0 first (bottom, muted), paid buckets ascending, $20+ split at the top:
    // capped (red) then kept-going-on-own-key (violet). The $0 bucket is dropped
    // when the "Hide $0" toggle is active so the paid buckets rescale to fill the
    // chart; totals/max, bars, legend and tooltip all derive from `segs`.
    const allSegs = [
      { key: 'b0', label: '$0', color: '#3f3f5a' },
      { key: 'b1', label: '$0.01–$5', color: '#34d399' },
      { key: 'b2', label: '$5–$10', color: '#a3e635' },
      { key: 'b3', label: '$10–$15', color: '#fbbf24' },
      { key: 'b4', label: '$15–$19.99', color: '#fb923c' },
      { key: 'b5', label: '$20+ capped', color: '#ef4444' },
      { key: 'b6', label: '$20+ own key', color: '#a855f7' },
    ];
    const segs = spendDistIncludeZero ? allSegs : allSegs.filter((s) => s.key !== 'b0');
    const totals = days.map((x) => segs.reduce((a, s) => a + (Number(x[s.key]) || 0), 0));
    const max = Math.max(1, ...totals);
    const W = 640, H = 180, topPad = 14, botPad = 18, n = days.length;
    const plot = H - topPad - botPad;
    const bw = W / n;
    const grid = (() => {
      let out = '';
      for (let i = 0; i <= 4; i++) {
        const y = (topPad + (i / 4) * plot).toFixed(1);
        out += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="currentColor" stroke-opacity="0.12" stroke-width="0.5" />`;
      }
      return out;
    })();
    const labels = days.map((x) => weekLabel(x.day));
    const isCurrent = (i) => i === days.length - 1;
    const bars = days.map((x, i) => {
      let acc = 0; // running height from baseline, in value units
      const barX = i * bw;
      const segRects = segs.map((s) => {
        const v = Number(x[s.key]) || 0;
        if (v <= 0) return '';
        const h = (v / max) * plot;
        const yBottom = topPad + plot - (acc / max) * plot;
        acc += v;
        const y = yBottom - h;
        return `<rect x="${(barX + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"></rect>`;
      }).join('');
      // Per-day breakdown tooltip covering the full column height.
      const row = (label, color, v) =>
        `<div class="flex justify-between gap-3"><span class="text-zinc-400"><span class="inline-block w-2 h-2 rounded-sm align-middle mr-1" style="background:${color}"></span>${label}</span><span>${fmtInt(v)}</span></div>`;
      const tipId = `spend-dist-${i}`;
      tipStore[tipId] = `<div class="font-semibold mb-1">${esc(labels[i])}${isCurrent(i) ? ' (today)' : ''}</div>
        <div class="mb-1">${fmtInt(totals[i])} user${totals[i] === 1 ? '' : 's'}</div>
        <div class="text-[11px] leading-tight">
          ${segs.slice().reverse().map((s) => row(s.label, s.color, Number(x[s.key]) || 0)).join('')}
        </div>`;
      const overlay = `<rect class="dc-hover" x="${barX.toFixed(1)}" y="${topPad}" width="${bw.toFixed(1)}" height="${plot}"
        fill="#8b5cf6" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
      return segRects + overlay;
    }).join('');
    const legend = segs.slice().reverse().map((s) =>
      `<span class="inline-flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-sm" style="background:${s.color}"></span>${s.label}</span>`
    ).join('');
    el.innerHTML = `
      <div class="flex flex-wrap items-center gap-3 text-xs text-zinc-400 mb-2">${legend}</div>
      <svg viewBox="0 0 ${W} ${H}" class="w-full text-zinc-500" preserveAspectRatio="none" style="height:180px">
        ${grid}${bars}
      </svg>
      <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
        <span>${esc(labels[0] || '')}</span>
        <span>${esc(labels[labels.length - 1] || '')} (today)</span>
      </div>`;
    attachTooltip(el);
  }

  // ── Daily spend (last 30 days) ────────────────────────────────
  function renderSpend() {
    const days = (lastSpend && lastSpend.days) || [];
    const el = $('spend');
    if (!el) return;
    if (!days.length) {
      el.innerHTML = EMPTY_MSG;
      return;
    }
    const labels = days.map((x) => weekLabel(x.day));
    const plat = days.map((x) => Number(x.platform_cents) || 0);
    const byok = days.map((x) => Number(x.user_key_cents) || 0);
    // Admin-attributed portion per day, stacked as an amber cap on top of the
    // non-admin remainder so each bar's total height is unchanged.
    const platAdmin = days.map((x) => Number(x.platform_cents_admin) || 0);
    const byokAdmin = days.map((x) => Number(x.user_key_cents_admin) || 0);
    // #361: system-token spend per day — its own budget, stacked as an
    // extra cyan segment on top of every bar regardless of the toggle mode.
    const sys = days.map((x) => Number(x.system_cents) || 0);
    const totals = days.map((_, i) =>
      (spendMode === 'platform' ? plat[i] : spendMode === 'user' ? byok[i] : plat[i] + byok[i]) + sys[i]);
    const max = Math.max(1, ...totals);
    const W = 640, H = 180, topPad = 14, botPad = 18, n = days.length;
    const plot = H - topPad - botPad;
    const bw = W / n;
    const grid = (() => {
      let out = '';
      for (let i = 0; i <= 4; i++) {
        const y = (topPad + (i / 4) * plot).toFixed(1);
        out += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="currentColor" stroke-opacity="0.12" stroke-width="0.5" />`;
      }
      return out;
    })();
    const bars = days.map((x, i) => {
      const barX = i * bw;
      const w = Math.max(1, bw - 2).toFixed(1);
      const x0 = (barX + 1).toFixed(1);
      // Admin-attributed cents for the active mode (0 when the box is off).
      const pAdmin = includeAdmins ? platAdmin[i] : 0;
      const uAdmin = includeAdmins ? byokAdmin[i] : 0;
      // Compose each bar as a bottom-up stack: the non-admin remainder in its
      // mode colour, then the admin spend as an amber cap.
      const stack = (spendMode === 'both'
        ? [
            { value: Math.max(0, plat[i] - pAdmin), color: SPEND_PLATFORM },
            { value: Math.max(0, byok[i] - uAdmin), color: SPEND_USERKEY },
            { value: pAdmin + uAdmin, color: ADMIN_COLOR },
          ]
        : spendMode === 'user'
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
      let segs = '';
      for (const s of stack) {
        if (s.value <= 0) continue;
        const h = (s.value / max) * plot;
        yCursor -= h;
        segs += `<rect x="${x0}" y="${yCursor.toFixed(1)}" width="${w}" height="${Math.max(0, h).toFixed(1)}" fill="${s.color}"></rect>`;
      }
      const tipId = `spend-${i}`;
      const detail = spendMode === 'both'
        ? `<div class="flex justify-between gap-3"><span class="text-zinc-400">Platform</span><span>${dollars(plat[i])}</span></div>
           <div class="flex justify-between gap-3"><span class="text-zinc-400">User key</span><span>${dollars(byok[i])}</span></div>
           <div class="flex justify-between gap-3 border-t border-zinc-700 mt-1 pt-1"><span class="text-zinc-400">Total</span><span>${dollars(plat[i] + byok[i])}</span></div>`
        : `<div class="text-zinc-300">${dollars(totals[i])}</div>`;
      // Admin portion for the active mode (#341): tooltip-only breakout.
      const adminCents = spendMode === 'platform' ? platAdmin[i]
        : spendMode === 'user' ? byokAdmin[i] : platAdmin[i] + byokAdmin[i];
      const adminLine = includeAdmins && adminCents > 0
        ? `<div class="flex justify-between gap-3 text-[11px]" style="color:${ADMIN_COLOR}"><span>of which admin</span><span>${dollars(adminCents)}</span></div>`
        : '';
      // #361: system-token spend line, shown whenever the day had any.
      const systemLine = sys[i] > 0
        ? `<div class="flex justify-between gap-3 text-[11px]" style="color:${SYSTEM_COLOR}"><span>System tokens</span><span>${dollars(sys[i])}</span></div>`
        : '';
      tipStore[tipId] = `<div class="font-semibold">${esc(labels[i])}</div>${detail}${systemLine}${adminLine}`;
      const overlay = `<rect class="dc-hover" x="${barX.toFixed(1)}" y="${topPad}" width="${bw.toFixed(1)}" height="${plot}"
        fill="#8b5cf6" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
      return segs + overlay;
    }).join('');
    // Amber "Admin spend" swatch appears whenever the box is on and the active
    // mode has any admin spend. Not reusing adminLegend() here: its "Non-admin"
    // swatch is hard-coded violet and would mismatch the green (User key) and
    // dual-colour (Both) cases.
    const adminTotals = days.map((_, i) =>
      spendMode === 'platform' ? platAdmin[i]
        : spendMode === 'user' ? byokAdmin[i] : platAdmin[i] + byokAdmin[i]);
    const hasAdminSpend = includeAdmins && adminTotals.some((v) => v > 0);
    const modeSwatches = spendMode === 'both'
      ? `<span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${SPEND_PLATFORM}"></span> Platform key</span>
         <span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${SPEND_USERKEY}"></span> User key (BYOK)</span>`
      : '';
    const adminSwatch = hasAdminSpend
      ? `<span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${ADMIN_COLOR}"></span> Admin spend</span>`
      : '';
    // #361: a "System tokens" swatch appears whenever any day in the window
    // had system spend, in any mode (the segment is always charted).
    const hasSystemSpend = sys.some((v) => v > 0);
    const systemSwatch = hasSystemSpend
      ? `<span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${SYSTEM_COLOR}"></span> System tokens</span>`
      : '';
    const legend = (modeSwatches || adminSwatch || systemSwatch)
      ? `<div class="flex flex-wrap items-center gap-3 text-[10px] text-zinc-400 mb-2">${modeSwatches}${adminSwatch}${systemSwatch}</div>`
      : '';
    // #361: "System tokens today: $X.XX / $cap" readout — today is the last
    // day in the series; cap from /api/admin/limits (loaded in loadAll).
    const systemToday = sys.length ? sys[sys.length - 1] : 0;
    const systemReadout = `<div class="text-[11px] mb-2" style="color:${SYSTEM_COLOR}">System tokens today: ${dollars(systemToday)} / ${dollars(systemCapCents)}</div>`;
    el.innerHTML = `${systemReadout}${legend}
      <svg viewBox="0 0 ${W} ${H}" class="w-full text-zinc-500" preserveAspectRatio="none" style="height:180px">
        ${grid}${bars}
      </svg>
      <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
        <span>${esc(labels[0] || '')}</span>
        <span>${esc(labels[labels.length - 1] || '')} (today)</span>
      </div>`;
    attachTooltip(el);
  }

  // ── Spend by builder (top 30) ─────────────────────────────────
  function renderSpendByBuilder() {
    const builders = (lastSpendByBuilder && lastSpendByBuilder.builders) || [];
    const el = $('spend-by-builder');
    if (!el) return;
    if (!builders.length) {
      el.innerHTML = EMPTY_MSG;
      return;
    }
    const valueOf = (b) => {
      const p = Number(b.platform_cents) || 0;
      const u = Number(b.user_key_cents) || 0;
      return builderMode === 'platform' ? p : builderMode === 'user' ? u : p + u;
    };
    // Re-sort descending by the selected mode so bars stay ordered.
    const sorted = builders.slice().sort((a, b) => valueOf(b) - valueOf(a));
    const vals = sorted.map(valueOf);
    const max = Math.max(1, ...vals);
    const H = 200, topPad = 14, botPad = 52;
    const plot = H - topPad - botPad;
    const bw = 26;
    const W = sorted.length * bw;
    const color = builderMode === 'user' ? SPEND_USERKEY : SPEND_PLATFORM;
    const grid = (() => {
      let out = '';
      for (let i = 0; i <= 4; i++) {
        const y = (topPad + (i / 4) * plot).toFixed(1);
        out += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="currentColor" stroke-opacity="0.12" stroke-width="0.5" />`;
      }
      return out;
    })();
    const bars = sorted.map((b, i) => {
      const p = Number(b.platform_cents) || 0;
      const u = Number(b.user_key_cents) || 0;
      const x = i * bw;
      const cx = x + bw / 2;
      const short = b.name.length > 10 ? b.name.slice(0, 9) + '…' : b.name;
      const tipId = `builder-${i}`;
      const tipRow = (label, val) =>
        `<div class="flex justify-between gap-3 text-zinc-400"><span>${label}</span><span class="text-zinc-300">${dollars(val)}</span></div>`;
      // Admin builders get an amber OUTLINE (#341), not a fill swap — the fill
      // is already occupied by the platform/user/both colours.
      const isAdmin = includeAdmins && !!b.is_admin;
      const outline = isAdmin ? ` stroke="${ADMIN_COLOR}" stroke-width="2"` : '';
      tipStore[tipId] = `<div class="font-semibold">${esc(b.name)}${isAdmin ? ' (admin)' : ''}</div>
        <div class="text-zinc-300 mb-1">#${i + 1} · ${dollars(valueOf(b))}</div>
        ${tipRow('Platform key', p)}
        ${tipRow('User key (BYOK)', u)}
        ${tipRow('Total', p + u)}${isAdmin ? `<div class="mt-1 text-[11px]" style="color:${ADMIN_COLOR}">admin</div>` : ''}`;
      let segs;
      if (builderMode === 'both') {
        const hp = Math.round((p / max) * plot);
        const hu = Math.round((u / max) * plot);
        const yp = topPad + (plot - hp);
        const yu = yp - hu;
        segs = `<rect x="${(x + 3).toFixed(1)}" y="${yp}" width="${bw - 6}" height="${hp}" fill="${SPEND_PLATFORM}" rx="2"${outline}></rect>` +
          `<rect x="${(x + 3).toFixed(1)}" y="${yu}" width="${bw - 6}" height="${hu}" fill="${SPEND_USERKEY}" rx="2"${outline}></rect>`;
      } else {
        const v = valueOf(b);
        const h = Math.round((v / max) * plot);
        const y = topPad + (plot - h);
        segs = `<rect x="${(x + 3).toFixed(1)}" y="${y}" width="${bw - 6}" height="${h}" fill="${color}" rx="2"${outline}></rect>`;
      }
      return segs +
        `<text x="${cx}" y="${H - botPad + 12}" text-anchor="end" font-size="9" fill="currentColor"
              class="text-zinc-400" transform="rotate(-55 ${cx} ${H - botPad + 12})">${esc(short)}</text>` +
        `<rect class="dc-hover" x="${x.toFixed(1)}" y="${topPad}" width="${bw.toFixed(1)}" height="${plot}"
              fill="#8b5cf6" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
    }).join('');
    const modeLegend = builderMode === 'both'
      ? `<span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${SPEND_PLATFORM}"></span> Platform key</span>
         <span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${SPEND_USERKEY}"></span> User key (BYOK)</span>`
      : '';
    // Admin marker is an outline here (#341), so its legend swatch is outlined.
    const adminSwatch = includeAdmins
      ? `<span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="border:2px solid ${ADMIN_COLOR}"></span> Admin builder</span>`
      : '';
    const legend = (modeLegend || adminSwatch)
      ? `<div class="flex flex-wrap items-center gap-3 text-[10px] text-zinc-400 mb-2">${modeLegend}${adminSwatch}</div>`
      : '';
    el.innerHTML = `${legend}
      <div class="overflow-x-auto">
        <svg viewBox="0 0 ${W} ${H}" style="height:200px;min-width:${W}px" class="text-zinc-500">
          ${grid}${bars}
        </svg>
      </div>`;
    attachTooltip(el);
  }

  // Wire a three-way spend toggle (Platform key · User key · Both). `attr`
  // matches the data-spend-toggle value in the markup; `onChange(mode)`
  // re-renders the relevant chart.
  function wireSpendToggle(attr, onChange) {
    const group = host && host.querySelector(`[data-spend-toggle="${attr}"]`);
    if (!group) return;
    group.querySelectorAll('.spend-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.spend-btn').forEach((b) => {
          const active = b === btn;
          b.className = `spend-btn px-2 py-1 rounded ${active ? 'bg-violet-600 text-white' : 'bg-zinc-200 dark:bg-zinc-800'}`;
        });
        onChange(btn.dataset.mode);
      });
    });
  }

  // Wire the two-way "Hide $0 / Show $0" toggle on the spend-distribution chart.
  function wireZeroToggle() {
    const group = host && host.querySelector('[data-zero-toggle="spend-distribution"]');
    if (!group) return;
    const want = spendDistIncludeZero ? 'show' : 'hide';
    group.querySelectorAll('.zero-btn').forEach((b) => {
      const active = b.dataset.zero === want;
      b.className = `zero-btn px-2 py-1 rounded ${active ? 'bg-violet-600 text-white' : 'bg-zinc-200 dark:bg-zinc-800'}`;
    });
    group.querySelectorAll('.zero-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        spendDistIncludeZero = btn.dataset.zero === 'show';
        localStorage.setItem(SPEND_DIST_ZERO_KEY, String(spendDistIncludeZero));
        group.querySelectorAll('.zero-btn').forEach((b) => {
          const active = b === btn;
          b.className = `zero-btn px-2 py-1 rounded ${active ? 'bg-violet-600 text-white' : 'bg-zinc-200 dark:bg-zinc-800'}`;
        });
        renderSpendDistribution();
      });
    });
  }

  // ── Bootstrap ─────────────────────────────────────────────────
  // Append the includeAdmins flag to any analytics URL — plus the page's
  // own ?demo=1 when present (#891). Every chart here reads `events` /
  // `llm_usage` / `progress_estimates`, all `staging:private` and therefore
  // EMPTY in a prod-cloned staging DB; the endpoints substitute deterministic
  // demo payloads behind `IS_STAGING && ?demo=1`, but that never fired
  // because the flag was dropped here. Same pass-through the admin console
  // does for its status/node reads. A strict no-op in production.
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';
  function withAdmins(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}includeAdmins=${includeAdmins}${DEMO ? '&demo=1' : ''}`;
  }

  async function loadFunnels() {
    const f = await getJSON(withAdmins(`/api/admin/analytics/funnels?cohort=${encodeURIComponent(currentCohort)}`));
    renderFunnels(f);
  }

  function wireCohortButtons() {
    if (!host) return;
    host.querySelectorAll('.cohort-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        currentCohort = btn.dataset.cohort;
        host.querySelectorAll('.cohort-btn').forEach((b) => {
          const active = b.dataset.cohort === currentCohort;
          b.className = `cohort-btn px-2 py-1 rounded ${active ? 'bg-violet-600 text-white' : 'bg-zinc-200 dark:bg-zinc-800'}`;
        });
        try { await loadFunnels(); } catch { /* keep the previous funnel */ }
      });
    });
  }

  // Retention alignment buttons re-pivot the cached payload — no refetch.
  function wireRetAlign() {
    if (!host) return;
    host.querySelectorAll('.retalign-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        retAlign = btn.dataset.retalign;
        host.querySelectorAll('.retalign-btn').forEach((b) => {
          const active = b.dataset.retalign === retAlign;
          b.className = `retalign-btn px-2 py-1 rounded ${active ? 'bg-violet-600 text-white' : 'bg-zinc-200 dark:bg-zinc-800'}`;
        });
        if (lastRetention) renderRetention(lastRetention, retAlign);
      });
    });
  }

  function showGate(msg) {
    const content = $('admin-analytics-content');
    const gate = $('admin-analytics-gate');
    if (content) content.classList.add('hidden');
    if (!gate) return;
    gate.textContent = msg;
    gate.classList.remove('hidden');
  }

  // Fetch every analytics endpoint (with the current includeAdmins flag)
  // and (re)render. Shared by first load and the admin-checkbox toggle.
  async function loadAll() {
    const [overview, spend, growth, retention, generalUsers, powerUsers, topUsers, kudos, spendByBuilder, spendDistribution, limits] =
      await Promise.all([
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
    // Section swapped out mid-load — drop the payloads rather than paint
    // into a detached tree.
    if (!$('admin-analytics-root')) return;
    renderCounters(overview);
    if (limits && Number.isFinite(Number(limits.system_tokens_daily_limit_cents))) {
      systemCapCents = Number(limits.system_tokens_daily_limit_cents);
    }
    lastSpend = spend;
    renderSpend();
    renderGrowth(growth);
    lastRetention = retention;
    renderRetention(retention, retAlign);
    renderGeneralUsers(generalUsers);
    renderPowerUsers(powerUsers);
    renderTopUsers(topUsers);
    renderKudos(kudos);
    lastSpendByBuilder = spendByBuilder;
    renderSpendByBuilder();
    lastSpendDistribution = spendDistribution;
    renderSpendDistribution();
    await loadFunnels();
  }

  async function init() {
    // Admin check up front. The data endpoints are independently enforced
    // server-side; this is just for a clean message. We do NOT navigate away
    // on an auth failure: a transient 401 shouldn't bounce an admin, and
    // keeping the shell rendered makes the page coherent under headless
    // checks.
    let me = null;
    try {
      me = await getJSON('/api/auth/me');
    } catch {
      showGate('Sign in as an admin to view analytics.');
      return;
    }
    if (!me.user?.isAdmin) {
      showGate('Admin access required.');
      return;
    }
    if (!$('admin-analytics-root')) return;

    $('admin-analytics-content')?.classList.remove('hidden');
    wireCohortButtons();
    wireRetAlign();
    wireInfoIcons();

    // Spend toggles re-render from cached payloads (no refetch).
    wireSpendToggle('spend', (mode) => { spendMode = mode; renderSpend(); });
    wireSpendToggle('spend-by-builder', (mode) => { builderMode = mode; renderSpendByBuilder(); });
    // Hide/Show $0 toggle on the spend-distribution chart (re-render, no refetch).
    wireZeroToggle();

    // Include-admins checkbox: reflect persisted state, then reload all on change.
    const adminBox = $('include-admins');
    if (adminBox) {
      adminBox.checked = includeAdmins;
      adminBox.addEventListener('change', async () => {
        includeAdmins = adminBox.checked;
        localStorage.setItem(ADMIN_KEY, String(includeAdmins));
        try { await loadAll(); } catch { /* leave the last render up */ }
      });
    }

    try {
      await loadAll();
    } catch (err) {
      if (err.forbidden) { showGate('Admin access required.'); return; }
      showGate('Failed to load analytics data.');
    }
  }

  const MARKUP = `
    <div id="admin-analytics-root">
      <h2 class="text-lg font-semibold mb-4">Analytics</h2>
      <div id="admin-analytics-gate" class="hidden text-zinc-500 text-center py-20"></div>

      <main id="admin-analytics-content" class="hidden space-y-6">
        <!-- Global controls -->
        <section class="flex items-center gap-2">
          <label class="inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400 cursor-pointer select-none">
            <input id="include-admins" type="checkbox"
                   class="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-600 focus:ring-violet-500">
            <span>Include admin users in stats</span>
          </label>
          <span class="dc-info" data-info="include-admins" tabindex="0" role="button" aria-label="What is this?">?</span>
        </section>

        <!-- Counters -->
        <section>
          <div class="flex items-center mb-2">
            <h3 class="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Overview</h3>
            <span class="dc-info" data-info="counters" tabindex="0" role="button" aria-label="What is this?">?</span>
          </div>
          <!-- Ten cards: 5-across from xl fills the now-full-width console
               with two even rows instead of four very wide tiles. -->
          <div id="counters" class="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-5 gap-3"></div>
        </section>

        <!-- Daily spend -->
        <section class="${AdminUI.card} p-4">
          <div class="flex items-center justify-between flex-wrap gap-2 mb-1">
            <h3 class="text-lg font-semibold inline-flex items-center">Daily spend
              <span class="dc-info" data-info="spend" tabindex="0" role="button" aria-label="What is this?">?</span>
            </h3>
            <div class="flex items-center gap-1 text-xs" data-spend-toggle="spend">
              <button data-mode="platform" class="spend-btn px-2 py-1 rounded bg-violet-600 text-white">Platform key</button>
              <button data-mode="user" class="spend-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">User key</button>
              <button data-mode="both" class="spend-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">Both</button>
            </div>
          </div>
          <p class="text-xs text-zinc-500 mb-4">LLM spend per day, last 30 days. Hover a bar for the amount.</p>
          <div id="spend"></div>
        </section>

        <!-- Funnels -->
        <section class="${AdminUI.card} p-4">
          <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
            <h3 class="text-lg font-semibold inline-flex items-center">Funnels
              <span class="dc-info" data-info="funnels" tabindex="0" role="button" aria-label="What is this?">?</span>
            </h3>
            <div class="flex flex-wrap items-center gap-1 text-xs">
              <span class="text-zinc-500 mr-1">Cohort:</span>
              <button data-cohort="all" class="cohort-btn px-2 py-1 rounded bg-violet-600 text-white">All time</button>
              <button data-cohort="90d" class="cohort-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">Last 90d</button>
              <button data-cohort="30d" class="cohort-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">Last 30d</button>
              <button data-cohort="14d" class="cohort-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">Last 14d</button>
              <button data-cohort="7d" class="cohort-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">Last 7d</button>
              <button data-cohort="3d" class="cohort-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">Last 3d</button>
              <button data-cohort="1d" class="cohort-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">Last 1d</button>
            </div>
          </div>
          <div class="grid md:grid-cols-2 gap-6">
            <div>
              <h4 class="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mb-3">Users using dapps</h4>
              <div id="funnel-dapp" class="space-y-2"></div>
            </div>
            <div>
              <h4 class="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mb-3">Promoting PRs (dev sessions)</h4>
              <div id="funnel-pr" class="space-y-2"></div>
              <h4 class="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-5 mb-3">Promoting PRs (distinct users)</h4>
              <div id="funnel-pr-users" class="space-y-2"></div>
            </div>
          </div>
        </section>

        <!-- Growth -->
        <section class="${AdminUI.card} p-4">
          <h3 class="text-lg font-semibold mb-1 inline-flex items-center">Growth
            <span class="dc-info" data-info="growth" tabindex="0" role="button" aria-label="What is this?">?</span>
          </h3>
          <p class="text-xs text-zinc-500 mb-4">New signups, apps, promoted &amp; merged PRs per week.</p>
          <div id="growth" class="grid sm:grid-cols-2 gap-6"></div>
        </section>

        <!-- General users (DAU / WAU / MAU, daily rolling windows) + retention -->
        <section class="${AdminUI.card} p-4">
          <h3 class="text-lg font-semibold mb-1 inline-flex items-center">General users
            <span class="dc-info" data-info="general-users" tabindex="0" role="button" aria-label="What is this?">?</span>
          </h3>
          <p class="text-xs text-zinc-500 mb-4">Anyone active during the period. Daily over the last 90 days — DAU per day, WAU a 7-day rolling window, MAU a 30-day rolling window.</p>
          <div class="grid lg:grid-cols-3 gap-6">
            <div>
              <div class="flex items-center justify-between text-sm mb-1">
                <span class="font-semibold text-zinc-700 dark:text-zinc-300">DAU</span>
                <span id="gu-dau-latest" class="text-zinc-500"></span>
              </div>
              <p class="text-[11px] text-zinc-500 mb-2">Distinct users active that day.</p>
              <div id="gu-dau"></div>
            </div>
            <div>
              <div class="flex items-center justify-between text-sm mb-1">
                <span class="font-semibold text-zinc-700 dark:text-zinc-300">WAU</span>
                <span id="gu-wau-latest" class="text-zinc-500"></span>
              </div>
              <p class="text-[11px] text-zinc-500 mb-2">Distinct users active in the trailing 7 days.</p>
              <div id="gu-wau"></div>
            </div>
            <div>
              <div class="flex items-center justify-between text-sm mb-1">
                <span class="font-semibold text-zinc-700 dark:text-zinc-300">MAU</span>
                <span id="gu-mau-latest" class="text-zinc-500"></span>
              </div>
              <p class="text-[11px] text-zinc-500 mb-2">Distinct users active in the trailing 30 days.</p>
              <div id="gu-mau"></div>
            </div>
          </div>

          <div class="flex items-center justify-between flex-wrap gap-2 mt-8 mb-3">
            <h4 class="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Retention cohorts</h4>
            <div class="flex flex-wrap items-center gap-1 text-xs">
              <span class="text-zinc-500 mr-1">Align:</span>
              <button data-retalign="calendar" class="retalign-btn px-2 py-1 rounded bg-violet-600 text-white">Calendar aligned</button>
              <button data-retalign="cohort" class="retalign-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">By cohort age</button>
            </div>
          </div>
          <p class="text-xs text-zinc-500 mb-3">
            Cohort = signup week. Each cell is the share of that cohort active (any action) in a given week.
          </p>
          <div id="retention-cohorts" class="overflow-x-auto"></div>
        </section>

        <!-- Power users (rolling WAU + L4 consistency) -->
        <section class="${AdminUI.card} p-4">
          <h3 class="text-lg font-semibold mb-1 inline-flex items-center">Power users
            <span class="dc-info" data-info="power-users" tabindex="0" role="button" aria-label="What is this?">?</span>
          </h3>
          <p class="text-xs text-zinc-500 mb-4">A power user (per week) used dapps &ge; 3&times; AND did &ge; 3 developer actions (kudos, votes, or proposals). Daily over the last 90 days.</p>
          <div class="grid lg:grid-cols-2 gap-6">
            <div>
              <div class="flex items-center justify-between text-sm mb-1">
                <span class="font-semibold text-zinc-700 dark:text-zinc-300">Power-user WAU</span>
                <span id="pu-wau-latest" class="text-zinc-500"></span>
              </div>
              <p class="text-[11px] text-zinc-500 mb-2">Distinct power users over the trailing 7 days.</p>
              <div id="pu-wau"></div>
            </div>
            <div>
              <div class="flex items-center justify-between text-sm mb-1">
                <span class="font-semibold text-zinc-700 dark:text-zinc-300">Consistency (L4)</span>
                <span id="pu-l4-latest" class="text-zinc-500"></span>
              </div>
              <p class="text-[11px] text-zinc-500 mb-2">Per day, users stacked by how many of the trailing 4 weeks they were a power user.</p>
              <div id="pu-l4"></div>
            </div>
          </div>
        </section>

        <!-- Top users by dev sessions -->
        <section class="${AdminUI.card} p-4">
          <h3 class="text-lg font-semibold mb-1 inline-flex items-center">Top builders
            <span class="dc-info" data-info="top-users" tabindex="0" role="button" aria-label="What is this?">?</span>
          </h3>
          <p class="text-xs text-zinc-500 mb-4">Top 30 users by lifetime dev sessions started, highest on the left. Hover a bar for the per-outcome breakdown.</p>
          <div id="top-users"></div>
        </section>

        <!-- Spend by builder -->
        <section class="${AdminUI.card} p-4">
          <div class="flex items-center justify-between flex-wrap gap-2 mb-1">
            <h3 class="text-lg font-semibold inline-flex items-center">Spend by builder
              <span class="dc-info" data-info="spend-by-builder" tabindex="0" role="button" aria-label="What is this?">?</span>
            </h3>
            <div class="flex items-center gap-1 text-xs" data-spend-toggle="spend-by-builder">
              <button data-mode="platform" class="spend-btn px-2 py-1 rounded bg-violet-600 text-white">Platform key</button>
              <button data-mode="user" class="spend-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">User key</button>
              <button data-mode="both" class="spend-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">Both</button>
            </div>
          </div>
          <p class="text-xs text-zinc-500 mb-4">Top 30 users by lifetime LLM spend, highest on the left. Hover a bar for the platform / user-key breakdown.</p>
          <div id="spend-by-builder"></div>
        </section>

        <!-- Daily spend distribution (user counts per spend bucket) -->
        <section class="${AdminUI.card} p-4">
          <div class="flex items-center justify-between flex-wrap gap-2 mb-1">
            <h3 class="text-lg font-semibold inline-flex items-center">Daily spend distribution
              <span class="dc-info" data-info="spend-distribution" tabindex="0" role="button" aria-label="What is this?">?</span>
            </h3>
            <div class="flex items-center gap-1 text-xs" data-zero-toggle="spend-distribution">
              <button data-zero="hide" class="zero-btn px-2 py-1 rounded bg-violet-600 text-white">Hide $0</button>
              <button data-zero="show" class="zero-btn px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800">Show $0</button>
            </div>
          </div>
          <p class="text-xs text-zinc-500 mb-4">
            Number of users by daily AI spend bucket, last 30 days. The two $20+ bars split users who hit the daily cap from those who continued on their own API key. $0 (no-spend) users are hidden by default — use "Show $0" to include them.
          </p>
          <div id="spend-distribution"></div>
        </section>

        <!-- Kudos giving distribution -->
        <section class="${AdminUI.card} p-4">
          <h3 class="text-lg font-semibold mb-1 inline-flex items-center">Kudos participation
            <span class="dc-info" data-info="kudos" tabindex="0" role="button" aria-label="What is this?">?</span>
          </h3>
          <p class="text-xs text-zinc-500 mb-4">
            Per week, how many users gave 0, 1, 2, 3, 4&ndash;5, 6&ndash;10 or 11+ kudos
            (everyone gets a budget of 20/week).
            The 0 bucket is registered users who gave none that week.
          </p>
          <div id="kudos-weekly"></div>
        </section>
      </main>
    </div>`;

  return {
    render(sectionHost) {
      host = sectionHost;
      host.innerHTML = MARKUP;
      init();
    },

    // The floating tooltip lives on <body> so it can escape the section's
    // overflow — it must be removed here or it would linger (and keep
    // showing stale copy) after the section is gone.
    destroy() {
      const tip = document.getElementById('dc-tip');
      if (tip) tip.remove();
      for (const k of Object.keys(tipStore)) delete tipStore[k];
      lastSpend = null;
      lastRetention = null;
      lastSpendByBuilder = null;
      lastSpendDistribution = null;
      host = null;
    },
  };
})();

window.AdminAnalytics = AdminAnalytics;
