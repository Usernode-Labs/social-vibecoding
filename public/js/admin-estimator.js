'use strict';

// Estimator accuracy section of the admin console (#898) — the
// "Progress estimator accuracy" card lifted out of #admin/analytics into
// its own top-level section at #admin/estimator.
//
// Everything else in the Analytics section is USER analytics (signups,
// retention, spend, kudos, all governed by its "Include admin users"
// checkbox). This card is PLATFORM analytics — how good the experimental
// AI progress estimate is — and it deliberately ignores that checkbox, so
// it sat oddly there. The card itself is unchanged: same tiles, same
// verdict, same breakdowns, same daily chart, same (?) copy.
//
// Structural notes:
//
//   - `render(host)` / `destroy()`, the SECTION_MODULES contract every
//     folded-in console section follows (see public/js/admin-console.js);
//   - element ids are prefixed `admin-estimator-` (the card used a bare
//     `#estimator` mount, too generic to share a document with the other
//     sections);
//   - the format/tooltip helpers below are a deliberate second copy of the
//     ones in admin-analytics.js. Every console module carries its own
//     (admin-status, admin-node, admin-merges all do) rather than sharing a
//     util module — see the header of admin-merges.js;
//   - the mouse-following `<div id="dc-tip">` is appended to <body> so it can
//     escape the section's overflow, and removed in destroy(). Analytics owns
//     an identical one; only ONE section is ever mounted at a time (the
//     console tears the outgoing section down before rendering the next), so
//     the two can never fight over the id;
//   - `.dc-hover` / `.dc-info` styles live in public/css/app.css, scoped to
//     #admin-analytics-root AND #admin-estimator-root.
//
// The endpoint keeps its existing path, GET /api/admin/analytics/estimator —
// it is a server-side API route under the admin-gated /api/admin/analytics
// prefix (adminMiddleware in src/routes/dashboard.js) and has nothing to do
// with the client-side hash route. The mismatch with #admin/estimator is
// deliberate; don't "fix" it.
//
// Unlike every sibling analytics endpoint, /estimator ignores includeAdmins
// (the estimator is opt-in and default-OFF, so excluding admins would leave
// it permanently empty), so this module never sends the flag at all.
//
// PERMISSIONS: admin-only, enforced server-side by adminMiddleware. Both full
// and view-only admins can see it — a pure read surface with no mutating
// controls, so there is no canAdminWrite gate here.

const AdminEstimator = (() => {
  const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString());

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const $ = (id) => document.getElementById(id);

  // ── Module state ─────────────────────────────────────────────
  let host = null;

  // ── Hover tooltip ─────────────────────────────────────────────
  // Native SVG <title> tooltips are slow and only fire over the painted
  // bar, so columns with a short/zero bar feel "dead". Instead the chart
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
  // focus on the (?) icon, where there's no cursor to follow).
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
  // Plain-language explanation, keyed by the data-info attribute on the
  // .dc-info icon in the markup below.
  const INFO = {
    estimator: 'Predicted-vs-actual for the <b>experimental AI progress estimate</b> (Settings &rarr; Experimental). Each tick the estimator guesses how many seconds of coding remain; when the run ends the real remaining time is backfilled, and the gap between the two is the error. <b>Median error</b> is the typical gap. <b>Within &frac12;&times;&ndash;2&times;</b> is the share of guesses between half and double the real time — the honest bar for a deliberately vague estimate. <b>Median bias</b> is signed: negative = optimistic (guessed too fast). <b>Unresolved</b> is guesses that never got matched to an outcome — a data-health signal that should sit near zero. Unlike the charts in Analytics, this one <b>always includes admins</b>: the estimator is opt-in and default-OFF, so excluding them would leave it permanently empty.<br><br><b>Leaves experimental when</b>, using post-fix data only: &ge; 200 scored guesses across 50+ runs from 5+ people, median error &le; 90s, &ge; 60% within the &frac12;&times;&ndash;2&times; band, and median bias within &plusmn;60s.',
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

  // Wire the (?) icons. Idempotent — safe to call once after render.
  function wireInfoIcons() {
    if (!host) return;
    host.querySelectorAll('.dc-info[data-info]').forEach((el) => {
      const key = el.dataset.info;
      wireInfoIcon(el, `info-${key}`, INFO[key]);
    });
    // One host-level delegation drives the mouse-following tooltip for the
    // icons (and any other [data-tip-id] outside the chart container).
    attachTooltip(host);
  }

  // Short "Mar 3" style label for a single calendar day. The API returns
  // these as 'YYYY-MM-DD' text; we also tolerate full ISO strings / Date
  // objects so a stray value can never render as "Invalid Date".
  function dayLabel(d) {
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

  // Empty-state markup for a valid-but-empty payload.
  const EMPTY_MSG = '<p class="text-sm text-zinc-500">Not enough data yet.</p>';

  // ── Progress estimator accuracy (#891) ────────────────────────
  //
  // Predicted-vs-actual for the experimental AI progress estimate, so the
  // "should it leave experimental?" call is made on numbers. Reads the
  // /estimator payload: two windows (30d + all time), an elapsed-bucket and
  // an outcome breakdown, and a 30-day daily median-error series.

  // The bar the card states up front, so the decision is mechanical. Also
  // reproduced in the (?) definition.
  const ESTIMATOR_BAR = { scored: 200, runs: 50, users: 5, medianAbsErrS: 90, withinBand: 0.6, biasS: 60 };

  // Round to whole seconds FIRST, then split into m/s — rounding the
  // remainder independently renders 119.5s as "1m 60s".
  const fmtSecs = (v) => {
    if (v == null) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    const total = Math.round(Math.abs(n));
    if (total < 60) return `${sign}${total}s`;
    return `${sign}${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  };
  const fmtPct = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(0)}%`);

  // Does the given window clear every threshold? Returns null when there is
  // simply not enough data yet — "not proven" is not the same as "failed".
  function estimatorVerdict(w) {
    if (!w || !w.scored) return null;
    const enough = w.scored >= ESTIMATOR_BAR.scored
      && w.runs >= ESTIMATOR_BAR.runs && w.users >= ESTIMATOR_BAR.users;
    if (!enough) return { ready: false, reason: 'not enough data yet' };
    const fails = [];
    if (!(w.medianAbsErrS != null && w.medianAbsErrS <= ESTIMATOR_BAR.medianAbsErrS)) fails.push('median error');
    if (!(w.withinBand != null && w.withinBand >= ESTIMATOR_BAR.withinBand)) fails.push('in-band share');
    if (!(w.medianBiasS != null && Math.abs(w.medianBiasS) <= ESTIMATOR_BAR.biasS)) fails.push('bias');
    return fails.length ? { ready: false, reason: `misses ${fails.join(', ')}` } : { ready: true, reason: 'meets every threshold' };
  }

  function renderEstimator(e) {
    const el = $('admin-estimator-card');
    if (!el) return;
    const w = (e && e.last30d) || null;
    const all = (e && e.allTime) || null;
    if (!e || !all || !all.ticks) {
      el.innerHTML = EMPTY_MSG;
      return;
    }
    // Colour only the three decision metrics — green when the threshold is
    // met, amber when it isn't. Sample-size and data-health tiles stay neutral.
    const tone = (ok) => (ok == null
      ? 'text-zinc-500'
      : ok ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400');
    const tile = (label, value, cls, sub) => `
      <div class="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
        <div class="text-xs uppercase tracking-wide text-zinc-500">${esc(label)}</div>
        <div class="text-2xl font-bold mt-1 ${cls || ''}">${esc(value)}</div>
        ${sub ? `<div class="text-[11px] text-zinc-500 mt-0.5">${esc(sub)}</div>` : ''}
      </div>`;

    const errOk = w.medianAbsErrS == null ? null : w.medianAbsErrS <= ESTIMATOR_BAR.medianAbsErrS;
    const bandOk = w.withinBand == null ? null : w.withinBand >= ESTIMATOR_BAR.withinBand;
    const biasOk = w.medianBiasS == null ? null : Math.abs(w.medianBiasS) <= ESTIMATOR_BAR.biasS;
    const sampleOk = w.scored >= ESTIMATOR_BAR.scored
      && w.runs >= ESTIMATOR_BAR.runs && w.users >= ESTIMATOR_BAR.users;

    const tiles = [
      tile('Scored guesses (30d)', fmtInt(w.scored), sampleOk ? '' : 'text-zinc-500',
        `${fmtInt(w.runs)} runs · ${fmtInt(w.users)} users · need ${ESTIMATOR_BAR.scored}/${ESTIMATOR_BAR.runs}/${ESTIMATOR_BAR.users}`),
      tile('Median error', fmtSecs(w.medianAbsErrS), tone(errOk), `bar: ≤ ${ESTIMATOR_BAR.medianAbsErrS}s`),
      tile('Within ½×–2×', fmtPct(w.withinBand), tone(bandOk), `bar: ≥ ${fmtPct(ESTIMATOR_BAR.withinBand)}`),
      tile('Median bias', fmtSecs(w.medianBiasS), tone(biasOk),
        w.medianBiasS == null ? 'bar: ±60s'
          : `${w.medianBiasS < 0 ? 'optimistic' : 'pessimistic'} · bar: ±${ESTIMATOR_BAR.biasS}s`),
      tile('Within 60s', fmtPct(w.within60s), '', 'share of guesses inside a minute'),
      tile('Unresolved', fmtPct(w.unresolvedRate), '',
        `${fmtInt(w.unresolved)} of ${fmtInt(w.ticks)} never matched`),
      tile('Toggle ON', fmtInt(e.usersEnabled), '', 'users opted in today'),
      tile('Ran past estimate', fmtInt(w.ranPast), '', 'run outlived the guess'),
    ].join('');

    const verdict = estimatorVerdict(w);
    const verdictHtml = verdict
      ? `<div class="mt-3 text-sm ${verdict.ready ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}">
           <b>${verdict.ready ? 'Ready to leave experimental' : 'Stays experimental'}</b> — ${esc(verdict.reason)}
           <span class="text-zinc-500">(last 30 days)</span>
         </div>`
      : '<div class="mt-3 text-sm text-zinc-500">No scored guesses in the last 30 days yet.</div>';

    // All-time line, mostly to expose the pre-fix unresolved tail next to the
    // recent window — a falling unresolved rate is the estimator-teardown fix
    // (#891) working.
    const allTimeHtml = `<div class="mt-2 text-xs text-zinc-500">
      All time: ${fmtInt(all.scored)} scored of ${fmtInt(all.ticks)} guesses ·
      median error ${esc(fmtSecs(all.medianAbsErrS))} ·
      ${esc(fmtPct(all.withinBand))} in band ·
      ${esc(fmtPct(all.unresolvedRate))} unresolved
    </div>`;

    const breakdown = (title, rows, keyLabel) => `
      <div>
        <h4 class="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mb-2">${esc(title)}</h4>
        ${rows.length ? `<table class="text-xs w-full">
          <thead><tr class="text-zinc-400">
            <th class="text-left font-medium py-1">${esc(keyLabel)}</th>
            <th class="text-right font-medium py-1">Scored</th>
            <th class="text-right font-medium py-1">Median err</th>
            <th class="text-right font-medium py-1">In band</th>
          </tr></thead>
          <tbody>${rows.map((r) => `<tr class="border-t border-zinc-200 dark:border-zinc-800">
            <td class="py-1 text-zinc-600 dark:text-zinc-300">${esc(r.label)}</td>
            <td class="py-1 text-right">${fmtInt(r.scored)}</td>
            <td class="py-1 text-right">${esc(fmtSecs(r.medianAbsErrS))}</td>
            <td class="py-1 text-right">${esc(fmtPct(r.withinBand))}</td>
          </tr>`).join('')}</tbody>
        </table>` : `<p class="text-xs text-zinc-500">No data yet.</p>`}
      </div>`;

    const byElapsed = (e.byElapsed || []).map((r) => ({ ...r, label: r.bucket }));
    const byOutcome = (e.byOutcome || []).map((r) => ({ ...r, label: r.outcome }));

    // 30-day daily median-error sparkline. Same bar idiom as the Analytics
    // charts, with a per-day hover tooltip.
    const daily = (e.daily || []).filter((d) => d.medianAbsErrS != null);
    let chart = '<p class="text-xs text-zinc-500">No scored guesses in the last 30 days.</p>';
    if (daily.length) {
      const W = 640, H = 140, topPad = 12, botPad = 16;
      const plot = H - topPad - botPad;
      const bw = W / daily.length;
      const max = Math.max(ESTIMATOR_BAR.medianAbsErrS, ...daily.map((d) => Number(d.medianAbsErrS) || 0));
      // The threshold line makes "over the bar" readable at a glance.
      const barY = topPad + plot - (ESTIMATOR_BAR.medianAbsErrS / max) * plot;
      const bars = daily.map((d, i) => {
        const v = Number(d.medianAbsErrS) || 0;
        const h = (v / max) * plot;
        const x = i * bw;
        const y = topPad + plot - h;
        const over = v > ESTIMATOR_BAR.medianAbsErrS;
        const tipId = `est-day-${i}`;
        tipStore[tipId] = `<div class="font-semibold mb-1">${esc(dayLabel(d.day))}</div>
          <div>median error ${esc(fmtSecs(v))}</div>
          <div class="text-zinc-400">${fmtInt(d.scored)} scored guess${d.scored === 1 ? '' : 'es'}</div>`;
        return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}"
                  height="${Math.max(0, h).toFixed(1)}" fill="${over ? '#f59e0b' : '#8b5cf6'}"></rect>
                <rect class="dc-hover" x="${x.toFixed(1)}" y="${topPad}" width="${bw.toFixed(1)}" height="${plot}"
                  fill="#8b5cf6" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
      }).join('');
      chart = `
        <svg viewBox="0 0 ${W} ${H}" class="w-full text-zinc-500" preserveAspectRatio="none" style="height:140px">
          <line x1="0" y1="${barY.toFixed(1)}" x2="${W}" y2="${barY.toFixed(1)}"
                stroke="currentColor" stroke-opacity="0.45" stroke-width="0.75" stroke-dasharray="4 3" />
          ${bars}
        </svg>
        <div class="flex justify-between text-[10px] text-zinc-500 mt-1">
          <span>${esc(dayLabel(daily[0].day))}</span>
          <span>${esc(ESTIMATOR_BAR.medianAbsErrS)}s bar (dashed)</span>
          <span>${esc(dayLabel(daily[daily.length - 1].day))}</span>
        </div>`;
    }

    el.innerHTML = `
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">${tiles}</div>
      ${verdictHtml}
      ${allTimeHtml}
      <div class="grid sm:grid-cols-2 gap-6 mt-6">
        ${breakdown('By how far into the run', byElapsed, 'Elapsed')}
        ${breakdown('By how the run ended', byOutcome, 'Outcome')}
      </div>
      <h4 class="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2">Daily median error (30d)</h4>
      ${chart}`;
    attachTooltip(el);
  }

  // ── Load ──────────────────────────────────────────────────────

  // Staging demo passthrough: the page-level ?demo=1 has to reach the
  // endpoint or src/routes/dashboard.js never substitutes the mock payload
  // and every PR preview shows an empty section (progress_estimates is
  // `staging:private`, so a prod-cloned staging DB has it schema-only).
  // A strict no-op in production. NOTE: no includeAdmins — the endpoint
  // deliberately ignores it (see the header).
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';
  const withDemo = (url) => `${url}${DEMO ? (url.includes('?') ? '&' : '?') + 'demo=1' : ''}`;

  function showGate(msg) {
    const content = $('admin-estimator-content');
    const gate = $('admin-estimator-gate');
    if (content) content.classList.add('hidden');
    if (!gate) return;
    gate.textContent = msg;
    gate.classList.remove('hidden');
  }

  async function init() {
    // Admin check up front. The data endpoint is independently enforced
    // server-side; this is just for a clean message. We do NOT navigate away
    // on an auth failure: a transient 401 shouldn't bounce an admin, and
    // keeping the shell rendered makes the page coherent under headless
    // checks.
    let me = null;
    try {
      me = await getJSON('/api/auth/me');
    } catch {
      showGate('Sign in as an admin to view estimator accuracy.');
      return;
    }
    if (!me.user?.isAdmin) {
      showGate('Admin access required.');
      return;
    }
    // Section swapped out mid-load — bail rather than paint into a detached
    // tree.
    if (!$('admin-estimator-root')) return;

    $('admin-estimator-content')?.classList.remove('hidden');
    wireInfoIcons();

    try {
      const payload = await getJSON(withDemo('/api/admin/analytics/estimator'));
      if (!$('admin-estimator-root')) return;
      renderEstimator(payload);
    } catch (err) {
      if (err.forbidden) { showGate('Admin access required.'); return; }
      showGate('Failed to load estimator accuracy.');
    }
  }

  const MARKUP = `
    <div id="admin-estimator-root">
      <h2 class="text-lg font-semibold mb-4">Estimator accuracy</h2>
      <div id="admin-estimator-gate" class="hidden text-zinc-500 text-center py-20"></div>

      <main id="admin-estimator-content" class="hidden space-y-6">
        <!-- Progress estimator accuracy (#891, moved out of Analytics in #898) -->
        <section class="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800">
          <h3 class="text-lg font-semibold mb-1 inline-flex items-center">Progress estimator accuracy
            <span class="dc-info" data-info="estimator" tabindex="0" role="button" aria-label="What is this?">?</span>
          </h3>
          <p class="text-xs text-zinc-500 mb-4">
            How close the experimental AI progress estimate&rsquo;s &ldquo;time remaining&rdquo; guesses land to the real remaining time. Last 30 days unless noted; always includes admins.
          </p>
          <div id="admin-estimator-card"></div>
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
      host = null;
    },
  };
})();

window.AdminEstimator = AdminEstimator;
