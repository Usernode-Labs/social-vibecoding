// Admin analytics dashboard client. Fetches the /api/admin/analytics/*
// endpoints and renders counters, the two funnels, growth time series,
// and the retention cohort heatmap + WAU/MAU stickiness. Vanilla JS +
// hand-rolled SVG so there's no chart-lib dependency to ship.

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

// The small "Non-admin / Admin" swatch legend, reusing the inline-swatch
// markup the spend "Both" legend already uses. Rendered only while admins
// are included; the non-admin swatch defaults to violet but can be set to a
// chart's own base colour. `includeAdmins` is the module-level toggle below.
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
// attribute on each .dc-info icon in dashboard.html.
const INFO = {
  'include-admins': 'Admin accounts (including view-only admins) are excluded from every number on this page by default, so operator/test activity does not skew the stats. Tick this to include them.',
  counters: 'At-a-glance totals. WAU | MAU are two independent counts — distinct users active in the last 7 vs 30 days, not a ratio. "Promoted (open)" is sessions live in promoted/merging right now; the all-time counts never leave their bucket.',
  spend: 'LLM spend per day for the last 30 days. <b>Platform key</b> is spend billed to the platform key (this is what the daily caps track); <b>User key</b> is spend billed to users\' own Anthropic keys (display only); <b>Both</b> stacks them.',
  funnels: 'Each stage shows the count reaching that milestone and the step-over-step conversion. "Promoted" = a session opened for group vote; "Merged" = landed in production. Use the cohort buttons to scope to recent signups.',
  growth: 'New signups, apps, and promoted/merged PRs bucketed per ISO week. Hover any bar for that week\'s exact count.',
  retention: 'Each row is a signup-week cohort; each cell is the share of that cohort active (any tracked action) N weeks later. Hover a cell for the exact counts. Below, WAU/MAU stickiness charts weekly active vs trailing-28-day active.',
  engagement: 'Operator-defined engagement tiers (not the classic active-user counts above), charted weekly. Hover a bar for the exact value.',
  'top-users': 'The 30 most prolific builders by lifetime dev sessions started, highest on the left. Hover a bar for the per-outcome breakdown (PRs produced, promoted, voted, merged).',
  'spend-by-builder': 'The 30 biggest LLM spenders, highest on the left. The toggle re-ranks by <b>Platform key</b> spend, <b>User key</b> (BYOK) spend, or <b>Both</b>. Hover a bar for the full breakdown.',
  kudos: 'Per ISO week, how many users gave 0–5 kudos (everyone gets a budget of 5/week). The 0 bucket is registered users who gave none that week, making this a participation view rather than a raw count.',
};

// Per-card Overview definitions (#341). Keyed by a stable card id, mirroring
// the chart-level INFO map. Each is the plain-language definition of how that
// card's number is actually computed (see renderCounters + the /overview SQL).
const CARD_INFO = {
  'total-users': 'Count of all registered accounts (admins excluded unless the box above is ticked).',
  'new-7d': 'Accounts that signed up in the last 7 days.',
  'new-30d': 'Accounts that signed up in the last 30 days.',
  'wau-mau': 'Two independent counts, not a ratio. <b>WAU</b> = distinct users who took any tracked action (used a dapp, sent a chat message, or sent a dev-session message) in the last 7 days. <b>MAU</b> = the same, over the last 30 days. Different from the Engagement-tiers DAU/WAU bars lower down, which use custom operator definitions.',
  'apps': 'Published apps that aren\'t self-hosted and aren\'t deleted.',
  'promoted-open': 'Live count of dev sessions sitting in the "promoted" or "merging" state right now (not a lifetime total).',
  'promoted-all': 'Every dev session that was ever opened for a group vote.',
  'merged-all': 'Every dev session that landed in production.',
  'kudos': 'Total kudos handed out across all users.',
  'llm-today': 'Today\'s platform-key LLM spend (the spend the daily caps track), in dollars.',
};

// Register one (?) icon for keyboard focus + mouse hover: stash its copy in
// the tip store, tag it with data-tip-id (the body-level delegation drives
// the mouse tooltip), and wire focus/blur for keyboard access. Shared by the
// chart-level icons and the per-card Overview icons.
function wireInfoIcon(el, tipId, html) {
  if (!html) return;
  tipStore[tipId] = html;
  el.dataset.tipId = tipId;
  el.addEventListener('focus', () => showTipAt(el, html));
  el.addEventListener('blur', () => { ensureTip().style.display = 'none'; });
}

// Wire the chart/section (?) icons. Idempotent — safe to call once after render.
function wireInfoIcons() {
  document.querySelectorAll('.dc-info[data-info]').forEach((el) => {
    const key = el.dataset.info;
    wireInfoIcon(el, `info-${key}`, INFO[key]);
  });
  // One body-level delegation drives the mouse-following tooltip for the
  // icons (and any other [data-tip-id] outside a chart container).
  attachTooltip(document.body);
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

// ── Counters ──────────────────────────────────────────────────
function renderCounters(o) {
  const dollars = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
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
  document.getElementById('counters').innerHTML = cards.map((c) => `
    <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
      <div class="flex items-start justify-between gap-1">
        <div class="text-xs uppercase tracking-wide text-zinc-500">${esc(c.label)}</div>
        <span class="dc-info" data-card-info="${c.id}" tabindex="0" role="button" aria-label="What is this?">?</span>
      </div>
      <div class="text-2xl font-bold mt-1">${esc(c.value)}</div>
    </div>`).join('');
  // Register each per-card (?) icon: tip-store copy + focus wiring. The
  // body-level delegation (wired in init) already drives the mouse tooltip.
  cards.forEach((c) => {
    const el = document.querySelector(`.dc-info[data-card-info="${c.id}"]`);
    if (el) wireInfoIcon(el, `card-${c.id}`, CARD_INFO[c.id]);
  });
}

// ── Funnel bars ───────────────────────────────────────────────
// stages: [{ label, value, admin }]. Bar width is relative to the first
// stage's total; the caption shows the absolute count and the step-over-step
// conversion. When admins are included (#341) each stage bar splits into a
// non-admin (violet) segment plus an amber admin segment, the caption breaks
// out "total · N admin", and a small Non-admin/Admin legend is shown.
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
          <span class="text-zinc-300">${esc(s.label)}</span>
          <span class="text-zinc-500">${count} · ${conv}</span>
        </div>
        <div class="h-6 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden flex">
          <div class="h-full bg-violet-600" style="width:${(naW + floor).toFixed(2)}%"></div>
          <div class="h-full" style="width:${adW.toFixed(2)}%;background:${ADMIN_COLOR}"></div>
        </div>
      </div>`;
  }).join('');
  document.getElementById(containerId).innerHTML = adminLegend('#7c3aed') + html;
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
// opts.grid → draw horizontal gridlines behind the bars.
// opts.tipPrefix + opts.tip(i) → register rich per-column tooltips and lay
//   a full-height transparent hover overlay over each column (so even a
//   short/zero bar is hoverable). The caller must attachTooltip() on the
//   container afterwards.
// opts.adminValues → a parallel array of admin-attributed counts (#341);
//   each is stacked as a small amber sub-rect on top of its non-admin bar.
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
  const el = document.getElementById('growth');
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
          <span class="text-zinc-300">${esc(s.label)}</span>
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

// ── Retention cohort heatmap ──────────────────────────────────
function renderRetention(r) {
  const cohorts = (r.cohorts || []).slice().sort((a, b) =>
    a.cohortWeek < b.cohortWeek ? 1 : -1); // newest first
  let maxOffset = 0;
  for (const c of cohorts) {
    for (const k of Object.keys(c.offsets)) maxOffset = Math.max(maxOffset, Number(k));
  }
  maxOffset = Math.min(maxOffset, 11); // keep the triangle readable

  const head = ['<th class="text-left px-2 py-1 font-medium text-zinc-400">Cohort</th>',
    '<th class="px-2 py-1 font-medium text-zinc-400">Users</th>'];
  for (let k = 0; k <= maxOffset; k++) head.push(`<th class="px-2 py-1 font-medium text-zinc-400">W${k}</th>`);

  const rows = cohorts.map((c, ci) => {
    const cells = [];
    for (let k = 0; k <= maxOffset; k++) {
      const v = c.offsets[k];
      if (v == null) { cells.push('<td class="px-2 py-1 text-center text-zinc-700">·</td>'); continue; }
      const p = pct(v, c.cohortSize);
      const alpha = Math.max(0.06, Math.min(1, p / 100));
      const tipId = `ret-${ci}-${k}`;
      tipStore[tipId] = `<div class="font-semibold">${esc(weekLabel(c.cohortWeek))} cohort · Week ${k}</div>
        <div class="text-zinc-300">${fmtInt(v)} of ${fmtInt(c.cohortSize)} active</div>
        <div class="text-zinc-300">${p}% retained</div>`;
      cells.push(`<td class="px-2 py-1 text-center" data-tip-id="${tipId}" style="background:rgba(139,92,246,${alpha});cursor:pointer">
        <span class="text-[11px] ${p >= 45 ? 'text-white' : 'text-zinc-300'}">${p}%</span></td>`);
    }
    return `<tr>
      <td class="px-2 py-1 whitespace-nowrap text-zinc-300">${esc(weekLabel(c.cohortWeek))}</td>
      <td class="px-2 py-1 text-center text-zinc-400">${fmtInt(c.cohortSize)}</td>
      ${cells.join('')}
    </tr>`;
  }).join('');

  const el = document.getElementById('retention-cohorts');
  el.innerHTML = cohorts.length
    ? `<table class="text-xs border-collapse"><thead><tr>${head.join('')}</tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="text-sm text-zinc-500">Not enough data yet.</p>';
  attachTooltip(el);
}

function renderStickiness(rows) {
  if (!rows || !rows.length) {
    document.getElementById('stickiness').innerHTML = '<p class="text-sm text-zinc-500">Not enough data yet.</p>';
    return;
  }
  const labels = rows.map((r) => weekLabel(r.wk));
  const wau = rows.map((r) => Number(r.wau) || 0);
  const mau = rows.map((r) => Number(r.mau) || 0);
  const max = Math.max(1, ...mau, ...wau);
  const W = 640, H = 120, n = rows.length;
  const grid = gridLines(W, H, 4, 16);
  const step = n > 1 ? W / (n - 1) : W;
  const line = (vals, color) => {
    const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 16)).toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" />`;
  };
  const dots = rows.map((r, i) => {
    const ratio = r.mau > 0 ? Math.round((r.wau / r.mau) * 100) : 0;
    const x = (i * step).toFixed(1);
    const y = (H - (wau[i] / max) * (H - 16)).toFixed(1);
    const tipId = `stick-${i}`;
    tipStore[tipId] = `<div class="font-semibold">Week of ${esc(labels[i])}</div>
      <div class="text-zinc-300">WAU ${fmtInt(wau[i])} · MAU ${fmtInt(mau[i])}</div>
      <div class="text-zinc-300">Stickiness ${ratio}%</div>`;
    // A wide transparent hit-circle so the small dot is easy to hover.
    return `<circle cx="${x}" cy="${y}" r="2.5" fill="#8b5cf6"></circle>` +
      `<circle class="dc-hover" cx="${x}" cy="${y}" r="9" fill="#8b5cf6" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></circle>`;
  }).join('');
  const stickEl = document.getElementById('stickiness');
  stickEl.innerHTML = `
    <div class="flex items-center gap-4 text-xs text-zinc-400 mb-2">
      <span><span class="inline-block w-3 h-0.5 align-middle" style="background:#8b5cf6"></span> WAU</span>
      <span><span class="inline-block w-3 h-0.5 align-middle" style="background:#60a5fa"></span> MAU (28d)</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" class="w-full text-zinc-500" style="height:120px">
      ${grid}${line(mau, '#60a5fa')}${line(wau, '#8b5cf6')}${dots}
    </svg>
    <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
      <span>${esc(labels[0] || '')}</span>
      <span>${esc(labels[labels.length - 1] || '')}</span>
    </div>`;
  attachTooltip(stickEl);
}

// ── Engagement tiers (custom DAU / WAU) ───────────────────────
function renderEngagement(e) {
  const weeks = e.weeks || [];
  const labels = weeks.map((w) => weekLabel(w.wk));
  const dau = weeks.map((w) => Number(w.dau) || 0);
  const wau = weeks.map((w) => Number(w.wau) || 0);
  const dauAdmin = weeks.map((w) => Number(w.dau_admin) || 0);
  const wauAdmin = weeks.map((w) => Number(w.wau_admin) || 0);

  const block = (containerId, latestId, vals, adminVals, color, prefix, def) => {
    const tip = (i) => `<div class="font-semibold">${esc(prefix.toUpperCase())}</div>
      <div class="text-zinc-300">Week of ${esc(labels[i] || '')}</div>
      <div class="text-zinc-300">${fmtInt(vals[i] + adminVals[i])} users${includeAdmins && adminVals[i] > 0 ? ` · ${fmtInt(adminVals[i])} admin` : ''}</div>
      <div class="text-zinc-500 mt-1 text-[11px]">${def}</div>`;
    const el = document.getElementById(containerId);
    el.innerHTML = `
      ${adminLegend(color)}
      ${barChart(vals, labels, color, { grid: true, tipPrefix: `eng-${prefix}`, tip, adminValues: adminVals })}
      <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
        <span>${esc(labels[0] || '')}</span>
        <span>${esc(labels[labels.length - 1] || '')}</span>
      </div>`;
    attachTooltip(el);
    const latest = vals[vals.length - 1];
    const latestAdmin = adminVals[adminVals.length - 1] || 0;
    document.getElementById(latestId).textContent =
      latest == null ? '' : `${fmtInt(latest + latestAdmin)} this week`;
  };

  block('eng-dau', 'eng-dau-latest', dau, dauAdmin, '#8b5cf6', 'dau',
    'Used a dapp ≥ 4× OR promoted ≥ 1 session that week.');
  block('eng-wau', 'eng-wau-latest', wau, wauAdmin, '#34d399', 'wau',
    'Used a dapp ≥ 2× in the trailing 2 weeks.');
}

// ── Top users by dev sessions started ─────────────────────────
// Descending left-to-right bars, one per user. Labels rotate under each
// bar (truncated); exact username + count live in the hover tooltip.
function renderTopUsers(d) {
  const users = d.users || [];
  const el = document.getElementById('top-users');
  if (!users.length) {
    el.innerHTML = '<p class="text-sm text-zinc-500">Not enough data yet.</p>';
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
// One stacked bar per week. Segments = number of users who gave exactly
// 0/1/2/3/4/5 kudos that week (0 = registered users who gave none). The
// current (most recent) week is marked in the axis labels.
function renderKudos(d) {
  const weeks = d.weeks || [];
  const el = document.getElementById('kudos-weekly');
  if (!weeks.length) {
    el.innerHTML = '<p class="text-sm text-zinc-500">Not enough data yet.</p>';
    return;
  }
  // 0 first (drawn at the bottom, muted); 1..5 stacked above in a ramp.
  const segs = [
    { key: 'g0', label: '0', color: '#3f3f5a' },
    { key: 'g1', label: '1', color: '#c4b5fd' },
    { key: 'g2', label: '2', color: '#a78bfa' },
    { key: 'g3', label: '3', color: '#8b5cf6' },
    { key: 'g4', label: '4', color: '#7c3aed' },
    { key: 'g5', label: '5', color: '#5b21b6' },
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

    // Per-week breakdown tooltip covering the full column height.
    const n5 = Number(w.g5) || 0, n4 = Number(w.g4) || 0, n3 = Number(w.g3) || 0;
    const n2 = Number(w.g2) || 0, n1 = Number(w.g1) || 0, n0 = Number(w.g0) || 0;
    const totalKudos = n5 * 5 + n4 * 4 + n3 * 3 + n2 * 2 + n1;
    const givers = n5 + n4 + n3 + n2 + n1;
    const row = (label, n) => `<div class="flex justify-between gap-3"><span class="text-zinc-400">${label}</span><span>${n}</span></div>`;
    const tipId = `kudos-${i}`;
    tipStore[tipId] = `<div class="font-semibold mb-1">${esc(labels[i])}${isCurrent(i) ? ' (current)' : ''}</div>
      <div class="mb-1">${totalKudos} kudo${totalKudos === 1 ? '' : 's'} from ${givers} giver${givers === 1 ? '' : 's'}</div>
      <div class="text-[11px] leading-tight">
        ${row('gave 5', n5)}${row('gave 4', n4)}${row('gave 3', n3)}${row('gave 2', n2)}${row('gave 1', n1)}${row('gave 0', n0)}
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

// ── Daily spend (last 30 days) ────────────────────────────────
// One vertical bar per calendar day. Each bar carries a full-height
// transparent hover overlay (data-tip-id) so even $0 days are hoverable
// and show their amount — the same pattern renderTopUsers/renderKudos use.
// The three-way toggle (platform / user / both) is purely client-side:
// the endpoint returns both cost columns and we re-render from the cached
// payload. PLATFORM = '#8b5cf6', USER-KEY = '#34d399'.
const dollars = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
const SPEND_PLATFORM = '#8b5cf6';
const SPEND_USERKEY = '#34d399';
let lastSpend = null;
let spendMode = 'platform'; // 'platform' | 'user' | 'both'

function renderSpend() {
  const days = (lastSpend && lastSpend.days) || [];
  const el = document.getElementById('spend');
  if (!days.length) {
    el.innerHTML = '<p class="text-sm text-zinc-500">Not enough data yet.</p>';
    return;
  }
  const labels = days.map((x) => weekLabel(x.day));
  const plat = days.map((x) => Number(x.platform_cents) || 0);
  const byok = days.map((x) => Number(x.user_key_cents) || 0);
  // Admin-attributed portion per day (#341). Daily spend keeps its existing
  // colours and its bar stays the full total; the admin split is surfaced as
  // an "of which admin" line in the tooltip only. 0 when the box is off.
  const platAdmin = days.map((x) => Number(x.platform_cents_admin) || 0);
  const byokAdmin = days.map((x) => Number(x.user_key_cents_admin) || 0);
  const totals = days.map((_, i) =>
    spendMode === 'platform' ? plat[i] : spendMode === 'user' ? byok[i] : plat[i] + byok[i]);
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
    let segs = '';
    if (spendMode === 'both') {
      // Stacked: platform at the bottom, user-key above it.
      const hp = (plat[i] / max) * plot;
      const hu = (byok[i] / max) * plot;
      const yp = topPad + plot - hp;
      const yu = yp - hu;
      segs = `<rect x="${x0}" y="${yp.toFixed(1)}" width="${w}" height="${Math.max(0, hp).toFixed(1)}" fill="${SPEND_PLATFORM}"></rect>` +
        `<rect x="${x0}" y="${yu.toFixed(1)}" width="${w}" height="${Math.max(0, hu).toFixed(1)}" fill="${SPEND_USERKEY}"></rect>`;
    } else {
      const v = totals[i];
      const h = (v / max) * plot;
      const y = topPad + plot - h;
      const color = spendMode === 'user' ? SPEND_USERKEY : SPEND_PLATFORM;
      segs = `<rect x="${x0}" y="${y.toFixed(1)}" width="${w}" height="${Math.max(0, h).toFixed(1)}" fill="${color}"></rect>`;
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
    tipStore[tipId] = `<div class="font-semibold">${esc(labels[i])}</div>${detail}${adminLine}`;
    const overlay = `<rect class="dc-hover" x="${barX.toFixed(1)}" y="${topPad}" width="${bw.toFixed(1)}" height="${plot}"
      fill="#8b5cf6" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
    return segs + overlay;
  }).join('');
  const legend = spendMode === 'both' ? `
    <div class="flex items-center gap-3 text-[10px] text-zinc-400 mb-2">
      <span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${SPEND_PLATFORM}"></span> Platform key</span>
      <span><span class="inline-block w-3 h-3 rounded-sm align-middle" style="background:${SPEND_USERKEY}"></span> User key (BYOK)</span>
    </div>` : '';
  el.innerHTML = `${legend}
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
// Descending left-to-right bars, modeled on renderTopUsers. The toggle
// re-ranks and recolors from the cached payload (client-side, ≤30 rows).
let lastSpendByBuilder = null;
let builderMode = 'platform'; // 'platform' | 'user' | 'both'

function renderSpendByBuilder() {
  const builders = (lastSpendByBuilder && lastSpendByBuilder.builders) || [];
  const el = document.getElementById('spend-by-builder');
  if (!builders.length) {
    el.innerHTML = '<p class="text-sm text-zinc-500">Not enough data yet.</p>';
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
    // is already occupied by the platform/user/both colours, so an outline
    // composes with every toggle mode. The tooltip gains an "admin" line.
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
  const group = document.querySelector(`[data-spend-toggle="${attr}"]`);
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

// ── Bootstrap ─────────────────────────────────────────────────
let currentCohort = 'all';
// Include-admins checkbox (#1). Default OFF (exclude admins); persisted
// so an operator's preference survives reloads.
const ADMIN_KEY = 'dashIncludeAdmins';
let includeAdmins = localStorage.getItem(ADMIN_KEY) === 'true';

// Append the includeAdmins flag to any analytics URL.
function withAdmins(url) {
  return `${url}${url.includes('?') ? '&' : '?'}includeAdmins=${includeAdmins}`;
}

async function loadFunnels() {
  const f = await getJSON(withAdmins(`/api/admin/analytics/funnels?cohort=${encodeURIComponent(currentCohort)}`));
  renderFunnels(f);
}

function wireCohortButtons() {
  document.querySelectorAll('.cohort-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      currentCohort = btn.dataset.cohort;
      document.querySelectorAll('.cohort-btn').forEach((b) => {
        const active = b.dataset.cohort === currentCohort;
        b.className = `cohort-btn px-2 py-1 rounded ${active ? 'bg-violet-600 text-white' : 'bg-zinc-200 dark:bg-zinc-800'}`;
      });
      try { await loadFunnels(); } catch (_) {}
    });
  });
}

function showGate(msg) {
  document.getElementById('content').classList.add('hidden');
  const gate = document.getElementById('gate');
  gate.textContent = msg;
  gate.classList.remove('hidden');
}

async function init() {
  // Admin check up front. The data endpoints are independently enforced
  // server-side; this is just for a clean redirect / message.
  let me;
  try {
    me = await getJSON('/api/auth/me');
  } catch (_) {
    window.location.href = '/login.html';
    return;
  }
  if (!me.user?.isAdmin) {
    showGate('Admin access required.');
    setTimeout(() => { window.location.href = '/'; }, 1200);
    return;
  }

  document.getElementById('content').classList.remove('hidden');
  wireCohortButtons();
  wireInfoIcons();

  // Spend toggles re-render from cached payloads (no refetch).
  wireSpendToggle('spend', (mode) => { spendMode = mode; renderSpend(); });
  wireSpendToggle('spend-by-builder', (mode) => { builderMode = mode; renderSpendByBuilder(); });

  // Include-admins checkbox: reflect persisted state, then reload all on change.
  const adminBox = document.getElementById('include-admins');
  if (adminBox) {
    adminBox.checked = includeAdmins;
    adminBox.addEventListener('change', async () => {
      includeAdmins = adminBox.checked;
      localStorage.setItem(ADMIN_KEY, String(includeAdmins));
      try { await loadAll(); } catch (_) {}
    });
  }

  try {
    await loadAll();
  } catch (err) {
    if (err.forbidden) { showGate('Admin access required.'); return; }
    showGate('Failed to load dashboard data.');
  }
}

// Fetch every analytics endpoint (with the current includeAdmins flag)
// and (re)render. Shared by first load and the admin-checkbox toggle.
async function loadAll() {
  const [overview, spend, growth, retention, engagement, topUsers, kudos, spendByBuilder] =
    await Promise.all([
      getJSON(withAdmins('/api/admin/analytics/overview')),
      getJSON(withAdmins('/api/admin/analytics/spend')),
      getJSON(withAdmins('/api/admin/analytics/growth')),
      getJSON(withAdmins('/api/admin/analytics/retention')),
      getJSON(withAdmins('/api/admin/analytics/engagement')),
      getJSON(withAdmins('/api/admin/analytics/top-users')),
      getJSON(withAdmins('/api/admin/analytics/kudos')),
      getJSON(withAdmins('/api/admin/analytics/spend-by-builder')),
    ]);
  renderCounters(overview);
  lastSpend = spend;
  renderSpend();
  renderGrowth(growth);
  renderRetention(retention);
  renderStickiness(retention.stickiness);
  renderEngagement(engagement);
  renderTopUsers(topUsers);
  renderKudos(kudos);
  lastSpendByBuilder = spendByBuilder;
  renderSpendByBuilder();
  await loadFunnels();
}

init();
