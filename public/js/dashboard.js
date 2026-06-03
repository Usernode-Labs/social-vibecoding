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
    { label: 'Total users', value: fmtInt(o.users.total) },
    { label: 'New (7d)', value: fmtInt(o.users.new_week) },
    { label: 'New (30d)', value: fmtInt(o.users.new_month) },
    { label: 'WAU / MAU', value: `${fmtInt(o.wau)} / ${fmtInt(o.mau)}` },
    { label: 'Apps', value: fmtInt(o.appsTotal) },
    { label: 'Promoted PRs', value: fmtInt(o.prs.promoted) },
    { label: 'Merged PRs', value: fmtInt(o.prs.merged) },
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

// ── Mini bar chart (growth) ───────────────────────────────────
function barChart(values, labels, color) {
  const max = Math.max(1, ...values);
  const W = 320, H = 90, n = values.length;
  const bw = n > 0 ? (W / n) : W;
  const bars = values.map((v, i) => {
    const h = Math.round((v / max) * (H - 14));
    const x = i * bw;
    const y = H - h;
    return `<rect x="${(x + 1).toFixed(1)}" y="${y}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h}" fill="${color}" rx="1">
      <title>${esc(labels[i])}: ${v}</title></rect>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="w-full" preserveAspectRatio="none" style="height:90px">${bars}</svg>`;
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
        ${barChart(vals, labels, s.color)}
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
    <svg viewBox="0 0 ${W} ${H}" class="w-full" style="height:120px">
      ${line(mau, '#60a5fa')}${line(wau, '#8b5cf6')}${dots}
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
      ${barChart(vals, labels, color)}
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
    const [overview, growth, retention, engagement] = await Promise.all([
      getJSON('/api/admin/analytics/overview'),
      getJSON('/api/admin/analytics/growth'),
      getJSON('/api/admin/analytics/retention'),
      getJSON('/api/admin/analytics/engagement'),
    ]);
    renderCounters(overview);
    renderGrowth(growth);
    renderRetention(retention);
    renderStickiness(retention.stickiness);
    renderEngagement(engagement);
    await loadFunnels();
  } catch (err) {
    if (err.forbidden) { showGate('Admin access required.'); return; }
    showGate('Failed to load dashboard data.');
  }
}

init();
