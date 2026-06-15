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
  const cards = [
    { label: 'Total users (all time)', value: fmtInt(o.users.total) },
    { label: 'New (7d)', value: fmtInt(o.users.new_week) },
    { label: 'New (30d)', value: fmtInt(o.users.new_month) },
    // WAU and MAU are two independent counts (distinct users active in the
    // last 7 vs 30 days), not a ratio — the "|" keeps that clear.
    { label: 'WAU | MAU', value: `${fmtInt(o.wau)} | ${fmtInt(o.mau)}` },
    { label: 'Apps', value: fmtInt(o.appsTotal) },
    // Live count of sessions currently in promoted/merging (not lifetime).
    { label: 'Promoted (open)', value: fmtInt(o.prs.promoted) },
    // Lifetime count of sessions that ever recorded a promoted_at.
    { label: 'Promoted PRs (all time)', value: fmtInt(o.prs.promoted_all_time) },
    { label: 'Merged PRs (all time)', value: fmtInt(o.prs.merged) },
    { label: 'Kudos given (all time)', value: fmtInt(o.kudosTotal) },
    { label: 'LLM spend today', value: dollars(o.llmSpendTodayCents) },
  ];
  document.getElementById('counters').innerHTML = cards.map((c) => `
    <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
      <div class="text-xs uppercase tracking-wide text-zinc-500">${esc(c.label)}</div>
      <div class="text-2xl font-bold mt-1">${esc(c.value)}</div>
    </div>`).join('');
}

// ── Funnel bars ───────────────────────────────────────────────
// stages: [{ label, value }]. Bar width is relative to the first stage;
// the caption shows the absolute count and the step-over-step conversion.
function renderFunnel(containerId, stages) {
  const top = stages[0]?.value || 0;
  const html = stages.map((s, i) => {
    const widthPct = top > 0 ? Math.max(2, Math.round((s.value / top) * 100)) : 0;
    const conv = i === 0
      ? '100%'
      : `${pct(s.value, stages[i - 1].value)}% of prev`;
    return `
      <div>
        <div class="flex items-center justify-between text-xs mb-1">
          <span class="text-zinc-300">${esc(s.label)}</span>
          <span class="text-zinc-500">${fmtInt(s.value)} · ${conv}</span>
        </div>
        <div class="h-6 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
          <div class="h-full bg-violet-600" style="width:${widthPct}%"></div>
        </div>
      </div>`;
  }).join('');
  document.getElementById(containerId).innerHTML = html;
}

function renderFunnels(f) {
  const d = f.dappUsage;
  renderFunnel('funnel-dapp', [
    { label: 'Signed up', value: d.signed_up },
    { label: 'Opened a dapp', value: d.opened_dapp },
    { label: 'Returned (2+ days)', value: d.returned },
    { label: 'Engaged socially', value: d.engaged },
    { label: 'Became a creator', value: d.creators },
  ]);

  const s = f.prSessions;
  renderFunnel('funnel-pr', [
    { label: 'Dev session started', value: s.started },
    { label: 'Produced a PR', value: s.produced_pr },
    { label: 'Promoted to group', value: s.promoted },
    { label: 'Received a vote', value: s.received_vote },
    { label: 'Merged', value: s.merged },
  ]);

  const u = f.prUsers;
  renderFunnel('funnel-pr-users', [
    { label: 'Started building', value: u.started },
    { label: 'Opened a PR', value: u.produced_pr },
    { label: 'Promoted a PR', value: u.promoted },
    { label: 'Got a PR merged', value: u.merged },
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
function barChart(values, labels, color, opts = {}) {
  const max = Math.max(1, ...values);
  const W = 320, H = 90, n = values.length, pad = 14;
  const bw = n > 0 ? (W / n) : W;
  const grid = opts.grid ? gridLines(W, H, 4, pad) : '';
  const bars = values.map((v, i) => {
    const h = Math.round((v / max) * (H - pad));
    const x = i * bw;
    const y = H - h;
    return `<rect x="${(x + 1).toFixed(1)}" y="${y}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h}" fill="${color}" rx="1">
      <title>${esc(labels[i])}: ${v}</title></rect>`;
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
  document.getElementById('growth').innerHTML = series.map((s) => {
    const vals = weeks.map((w) => Number(w[s.key]) || 0);
    const total = vals.reduce((a, b) => a + b, 0);
    return `
      <div>
        <div class="flex items-center justify-between text-xs mb-1">
          <span class="text-zinc-300">${esc(s.label)}</span>
          <span class="text-zinc-500">${fmtInt(total)} total</span>
        </div>
        ${barChart(vals, labels, s.color, { grid: true })}
        <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
          <span>${esc(labels[0] || '')}</span>
          <span>${esc(labels[labels.length - 1] || '')}</span>
        </div>
      </div>`;
  }).join('');
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

  const rows = cohorts.map((c) => {
    const cells = [];
    for (let k = 0; k <= maxOffset; k++) {
      const v = c.offsets[k];
      if (v == null) { cells.push('<td class="px-2 py-1 text-center text-zinc-700">·</td>'); continue; }
      const p = pct(v, c.cohortSize);
      const alpha = Math.max(0.06, Math.min(1, p / 100));
      cells.push(`<td class="px-2 py-1 text-center" style="background:rgba(139,92,246,${alpha})">
        <span class="text-[11px] ${p >= 45 ? 'text-white' : 'text-zinc-300'}">${p}%</span></td>`);
    }
    return `<tr>
      <td class="px-2 py-1 whitespace-nowrap text-zinc-300">${esc(weekLabel(c.cohortWeek))}</td>
      <td class="px-2 py-1 text-center text-zinc-400">${fmtInt(c.cohortSize)}</td>
      ${cells.join('')}
    </tr>`;
  }).join('');

  document.getElementById('retention-cohorts').innerHTML = cohorts.length
    ? `<table class="text-xs border-collapse"><thead><tr>${head.join('')}</tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="text-sm text-zinc-500">Not enough data yet.</p>';
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
    return `<circle cx="${x}" cy="${y}" r="2.5" fill="#8b5cf6"><title>${esc(labels[i])} — WAU ${wau[i]}, MAU ${mau[i]}, stickiness ${ratio}%</title></circle>`;
  }).join('');
  document.getElementById('stickiness').innerHTML = `
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
}

// ── Engagement tiers (custom DAU / WAU) ───────────────────────
function renderEngagement(e) {
  const weeks = e.weeks || [];
  const labels = weeks.map((w) => weekLabel(w.wk));
  const dau = weeks.map((w) => Number(w.dau) || 0);
  const wau = weeks.map((w) => Number(w.wau) || 0);

  const block = (containerId, latestId, vals, color) => {
    document.getElementById(containerId).innerHTML = `
      ${barChart(vals, labels, color, { grid: true })}
      <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
        <span>${esc(labels[0] || '')}</span>
        <span>${esc(labels[labels.length - 1] || '')}</span>
      </div>`;
    const latest = vals[vals.length - 1];
    document.getElementById(latestId).textContent =
      latest == null ? '' : `${fmtInt(latest)} this week`;
  };

  block('eng-dau', 'eng-dau-latest', dau, '#8b5cf6');
  block('eng-wau', 'eng-wau-latest', wau, '#34d399');
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
    tipStore[tipId] = `<div class="font-semibold">${esc(u.name)}</div>
      <div class="text-zinc-300 mb-1">#${i + 1} · ${v} dev session${v === 1 ? '' : 's'}</div>
      ${tipRow('Produced a PR', producedPr)}
      ${tipRow('Promoted to group', promoted)}
      ${tipRow('Received a vote', receivedVote)}
      ${tipRow('Merged', merged)}`;
    return `
      <rect x="${(x + 3).toFixed(1)}" y="${y}" width="${bw - 6}" height="${h}" fill="#8b5cf6" rx="2"></rect>
      <text x="${cx}" y="${y - 3}" text-anchor="middle" font-size="9" fill="currentColor" class="text-zinc-400">${v}</text>
      <text x="${cx}" y="${H - botPad + 12}" text-anchor="end" font-size="9" fill="currentColor"
            class="text-zinc-400" transform="rotate(-55 ${cx} ${H - botPad + 12})">${esc(short)}</text>
      <rect class="dc-hover" x="${x.toFixed(1)}" y="${topPad}" width="${bw.toFixed(1)}" height="${plot}"
            fill="#8b5cf6" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
  }).join('');
  el.innerHTML = `
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
function renderSpend(d) {
  const days = d.days || [];
  const el = document.getElementById('spend');
  if (!days.length) {
    el.innerHTML = '<p class="text-sm text-zinc-500">Not enough data yet.</p>';
    return;
  }
  const dollars = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
  const labels = days.map((x) => weekLabel(x.day));
  const vals = days.map((x) => Number(x.cents) || 0);
  const max = Math.max(1, ...vals);
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
    const v = vals[i];
    const h = (v / max) * plot;
    const barX = i * bw;
    const y = topPad + plot - h;
    const tipId = `spend-${i}`;
    tipStore[tipId] = `<div class="font-semibold">${esc(labels[i])}</div>
      <div class="text-zinc-300">${dollars(v)}</div>`;
    const bar = `<rect x="${(barX + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="#8b5cf6"></rect>`;
    const overlay = `<rect class="dc-hover" x="${barX.toFixed(1)}" y="${topPad}" width="${bw.toFixed(1)}" height="${plot}"
      fill="#8b5cf6" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
    return bar + overlay;
  }).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="w-full text-zinc-500" preserveAspectRatio="none" style="height:180px">
      ${grid}${bars}
    </svg>
    <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
      <span>${esc(labels[0] || '')}</span>
      <span>${esc(labels[labels.length - 1] || '')} (today)</span>
    </div>`;
  attachTooltip(el);
}

// ── Bootstrap ─────────────────────────────────────────────────
let currentCohort = 'all';

async function loadFunnels() {
  const f = await getJSON(`/api/admin/analytics/funnels?cohort=${encodeURIComponent(currentCohort)}`);
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

  try {
    const [overview, spend, growth, retention, engagement, topUsers, kudos] = await Promise.all([
      getJSON('/api/admin/analytics/overview'),
      getJSON('/api/admin/analytics/spend'),
      getJSON('/api/admin/analytics/growth'),
      getJSON('/api/admin/analytics/retention'),
      getJSON('/api/admin/analytics/engagement'),
      getJSON('/api/admin/analytics/top-users'),
      getJSON('/api/admin/analytics/kudos'),
    ]);
    renderCounters(overview);
    renderSpend(spend);
    renderGrowth(growth);
    renderRetention(retention);
    renderStickiness(retention.stickiness);
    renderEngagement(engagement);
    renderTopUsers(topUsers);
    renderKudos(kudos);
    await loadFunnels();
  } catch (err) {
    if (err.forbidden) { showGate('Admin access required.'); return; }
    showGate('Failed to load dashboard data.');
  }
}

init();
