'use strict';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';

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
//     folded-in console section follows (see admin-console.js);
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
      t.className = 'rounded-md bg-gray-900 text-gray-100 text-xs px-2 py-1.5 shadow-lg border border-gray-700';
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
    estimator: 'Predicted-vs-actual for the <b>experimental AI progress estimate</b> (Settings &rarr; Experimental). Each tick the estimator guesses how many seconds of coding remain; when the run ends the real remaining time is backfilled, and the gap between the two is the error. <b>Median error</b> is the typical gap. <b>Within &frac12;&times;&ndash;2&times;</b> is the share of guesses between half and double the real time. <b>Median bias</b> is signed: negative = optimistic (guessed too fast). <b>Unresolved</b> is guesses that never got matched to an outcome &mdash; a background sweep now resolves the ones orphaned by a mid-run restart, so this should sit near zero. Unlike every other chart here, this one <b>always includes admins</b>: the estimator is opt-in and default-OFF, so excluding them would leave it permanently empty.<br><br><b>v1 vs v2.</b> v1 was the original prompt, which told the model to &ldquo;bias toward the 2-10 minute window&rdquo; &mdash; it obeyed flatly, and six values accounted for 87% of its guesses. v2 feeds it the <i>measured</i> run-length distribution instead. Calibration is delivered entirely through the prompt: <b>no multiplier is applied to the model&rsquo;s output</b>, because a correction factor fitted to one model silently distorts the estimate as soon as the model or its inputs improve.<br><br><b>Baselines.</b> A candidate has to beat two things, not nothing: a fixed constant, and the elapsed-only <i>oracle</i> &mdash; the best any predictor knowing only elapsed time could do, fitted to the answers. The oracle measures about 39% in band, which is why the retired 60% bar was unreachable by anything at all.<br><br><b>The guard.</b> Raw = what the model said tick to tick; displayed = what the user saw after the monotonicity guard. v1&rsquo;s raw projections slipped LATER on 65% of transitions (a treadmill: the finish moved a minute further away every minute). <b>Clamped</b> = the guard held the previous projection because an extension had no cause. <b>Floored</b> = the run outlived its estimate and the readout sat at the 30s floor for a tick before the next guess extended it; the countdown always shows a number.<br><br><b>Leaves experimental when</b>, on <b>v2 data only</b>: &ge; 200 scored guesses across 50+ runs from 5+ people, in-band share &ge; 45% (above both the 39% oracle and the 41% scale-corrected benchmark), median bias within &plusmn;60s, median error at or below the oracle baseline, projected finish pushed later on &le; 25% of consecutive readings with outright backwards jumps under 5%, and completion claims firing with 5+ minutes remaining under 10% of the time.',
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
  const EMPTY_MSG = '<p class="text-sm text-gray-500">Not enough data yet.</p>';

  // ── Progress estimator accuracy (#891) ────────────────────────
  //
  // Predicted-vs-actual for the experimental AI progress estimate, so the
  // "should it leave experimental?" call is made on numbers. Reads the
  // /estimator payload: two windows (30d + all time), an elapsed-bucket and
  // an outcome breakdown, and a 30-day daily median-error series.

  // The bar the card states up front, so the decision is mechanical. Also
  // reproduced in the (?) definition.
  //
  // #892 restated it. The old bar was 90s median error and a 0.60 in-band
  // share; production measured the best POSSIBLE elapsed-only predictor at
  // 0.39 in band, so 0.60 was unreachable by anything and the card could
  // never have said yes. The new in-band bar of 0.45 sits above both that
  // 0.39 oracle and the 0.41 scale-corrected benchmark, so clearing it
  // proves the prompt work added something rather than just reproducing a
  // lookup table. Median error is judged against the live oracle baseline
  // rather than a fixed number, so it stays honest as the data grows.
  const ESTIMATOR_BAR = {
    scored: 200, runs: 50, users: 5,
    withinBand: 0.45, biasS: 60,
    laterRate: 0.25, increasedRate: 0.05, unearnedClaimRate: 0.10,
  };
  // The prompt generation the bar is judged on — v1 is the superseded
  // flat-prior prompt and must never be pooled into the verdict.
  const CANDIDATE_PROMPT_VERSION = 2;

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

  // Does the candidate clear every threshold? Returns null when there is
  // simply not enough data yet — "not proven" is not the same as "failed".
  //
  // #892: judged on the CANDIDATE prompt version alone (pooling v1 in would
  // drag the answer toward the prompt this change replaced), against the
  // live oracle baseline rather than a fixed error number, and including the
  // two display-quality gates — a countdown that walks backwards is a
  // failure even if its numbers are good.
  function estimatorVerdict(w, ctx) {
    if (!w || !w.scored) return null;
    const c = ctx || {};
    const enough = w.scored >= ESTIMATOR_BAR.scored
      && w.runs >= ESTIMATOR_BAR.runs && w.users >= ESTIMATOR_BAR.users;
    if (!enough) return { ready: false, reason: `not enough v${CANDIDATE_PROMPT_VERSION} data yet` };
    const fails = [];
    const oracleErr = c.baselines && c.baselines.oracle ? c.baselines.oracle.medianAbsErrS : null;
    if (oracleErr != null && !(w.medianAbsErrS != null && w.medianAbsErrS <= oracleErr)) fails.push('median error vs oracle');
    if (!(w.withinBand != null && w.withinBand >= ESTIMATOR_BAR.withinBand)) fails.push('in-band share');
    if (!(w.medianBiasS != null && Math.abs(w.medianBiasS) <= ESTIMATOR_BAR.biasS)) fails.push('bias');
    const disp = c.monotonicity && c.monotonicity.displayed;
    if (disp && disp.laterRate != null && disp.laterRate > ESTIMATOR_BAR.laterRate) fails.push('finish pushed later too often');
    if (disp && disp.increasedRate != null && disp.increasedRate > ESTIMATOR_BAR.increasedRate) fails.push('countdown runs backwards');
    const claims = c.completionClaims;
    if (claims && claims.overFiveMinLeftRate != null
        && claims.overFiveMinLeftRate > ESTIMATOR_BAR.unearnedClaimRate) fails.push('unearned completion claims');
    return fails.length
      ? { ready: false, reason: `misses ${fails.join(', ')}` }
      : { ready: true, reason: 'meets every threshold' };
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
      ? 'text-gray-500'
      : ok ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400');
    const tile = (label, value, cls, sub) => `
      <div class="rounded-lg bg-gray-100 dark:bg-gray-800 p-3">
        <div class="text-xs uppercase tracking-wide text-gray-500">${esc(label)}</div>
        <div class="text-2xl font-bold mt-1 ${cls || ''}">${esc(value)}</div>
        ${sub ? `<div class="text-[11px] text-gray-500 mt-0.5">${esc(sub)}</div>` : ''}
      </div>`;

    // #892: the headline tiles describe the CANDIDATE prompt version when
    // there is any of it, falling back to the 30-day window before v2 has
    // produced data. Judging the recalibration against a v1-dominated pool
    // would answer the wrong question.
    const versions = e.byPromptVersion || [];
    const cand = versions.find((v) => v.promptVersion === CANDIDATE_PROMPT_VERSION) || null;
    const head = (cand && cand.scored) ? cand : w;
    const headLabel = (cand && cand.scored) ? `v${CANDIDATE_PROMPT_VERSION}` : '30d';
    const baselines = e.baselines || null;
    const oracleErr = baselines && baselines.oracle ? baselines.oracle.medianAbsErrS : null;

    const errOk = (head.medianAbsErrS == null || oracleErr == null)
      ? null : head.medianAbsErrS <= oracleErr;
    const bandOk = head.withinBand == null ? null : head.withinBand >= ESTIMATOR_BAR.withinBand;
    const biasOk = head.medianBiasS == null ? null : Math.abs(head.medianBiasS) <= ESTIMATOR_BAR.biasS;
    const sampleOk = head.scored >= ESTIMATOR_BAR.scored
      && head.runs >= ESTIMATOR_BAR.runs && head.users >= ESTIMATOR_BAR.users;

    const mono = e.monotonicity || null;
    const disp = (mono && mono.displayed) || null;
    const claims = e.completionClaims || null;
    const laterOk = !disp || disp.laterRate == null ? null : disp.laterRate <= ESTIMATOR_BAR.laterRate;
    const backOk = !disp || disp.increasedRate == null ? null : disp.increasedRate <= ESTIMATOR_BAR.increasedRate;
    const claimOk = !claims || claims.overFiveMinLeftRate == null
      ? null : claims.overFiveMinLeftRate <= ESTIMATOR_BAR.unearnedClaimRate;

    const tiles = [
      tile(`Scored guesses (${headLabel})`, fmtInt(head.scored), sampleOk ? '' : 'text-gray-500',
        `${fmtInt(head.runs)} runs · ${fmtInt(head.users)} users · need ${ESTIMATOR_BAR.scored}/${ESTIMATOR_BAR.runs}/${ESTIMATOR_BAR.users}`),
      tile('Median error', fmtSecs(head.medianAbsErrS), tone(errOk),
        oracleErr == null ? 'bar: ≤ the oracle baseline' : `bar: ≤ ${fmtSecs(oracleErr)} (oracle)`),
      tile('Within ½×–2×', fmtPct(head.withinBand), tone(bandOk), `bar: ≥ ${fmtPct(ESTIMATOR_BAR.withinBand)}`),
      tile('Median bias', fmtSecs(head.medianBiasS), tone(biasOk),
        head.medianBiasS == null ? `bar: ±${ESTIMATOR_BAR.biasS}s`
          : `${head.medianBiasS < 0 ? 'optimistic' : 'pessimistic'} · bar: ±${ESTIMATOR_BAR.biasS}s`),
      // Treadmill: the share of consecutive readings that pushed the finish
      // LATER. Computed on what the user SAW, so it measures the guard.
      tile('Finish pushed later', fmtPct(disp && disp.laterRate), tone(laterOk),
        `shown · bar: ≤ ${fmtPct(ESTIMATOR_BAR.laterRate)}`),
      tile('Countdown went backwards', fmtPct(disp && disp.increasedRate), tone(backOk),
        `shown · bar: < ${fmtPct(ESTIMATOR_BAR.increasedRate)}`),
      tile('Held / floored', `${fmtPct(mono && mono.clampRate)} / ${fmtPct(mono && mono.flooredRate)}`, '',
        'guard held the projection · run outlived it'),
      tile('Unearned "nearly done"', fmtPct(claims && claims.overFiveMinLeftRate), tone(claimOk),
        claims ? `${fmtInt(claims.ticks)} claims · ${fmtInt(claims.suppressed)} suppressed` : 'no claims yet'),
      tile('Within 60s', fmtPct(head.within60s), '', 'share of guesses inside a minute'),
      tile('Unresolved', fmtPct(w.unresolvedRate), '',
        `${fmtInt(w.unresolved)} of ${fmtInt(w.ticks)} never matched`),
      tile('Toggle ON', fmtInt(e.usersEnabled), '', 'users opted in today'),
      tile('Ran past estimate', fmtInt(w.ranPast), '', 'run outlived the guess'),
    ].join('');

    const verdict = estimatorVerdict(head, {
      baselines, monotonicity: mono, completionClaims: claims,
    });
    const verdictHtml = verdict
      ? `<div class="mt-3 text-sm ${verdict.ready ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}">
           <b>${verdict.ready ? 'Ready to leave experimental' : 'Stays experimental'}</b> — ${esc(verdict.reason)}
           <span class="text-gray-500">(last 30 days)</span>
         </div>`
      : '<div class="mt-3 text-sm text-gray-500">No scored guesses in the last 30 days yet.</div>';

    // ── v1 vs v2, the card's lead (#892) ──────────────────────────
    //
    // The whole point of the recalibration is "did feeding the model the
    // measured distribution help?", and a pooled average cannot answer it.
    // Rendered first, before the tiles, so that comparison is the first
    // thing read.
    const cmpRow = (v) => {
      if (!v) return '';
      const isCand = v.promptVersion === CANDIDATE_PROMPT_VERSION;
      return `<tr class="border-t border-gray-200 dark:border-gray-800">
        <td class="py-1 text-gray-600 dark:text-gray-300">
          v${fmtInt(v.promptVersion)}${isCand ? ' <span class="text-[10px] uppercase tracking-wide text-indigo-500">candidate</span>' : ''}
        </td>
        <td class="py-1 text-right">${fmtInt(v.scored)}</td>
        <td class="py-1 text-right">${esc(fmtSecs(v.medianAbsErrS))}</td>
        <td class="py-1 text-right">${esc(fmtPct(v.withinBand))}</td>
        <td class="py-1 text-right">${esc(fmtSecs(v.medianBiasS))}</td>
      </tr>`;
    };
    const versionHtml = versions.length ? `
      <div class="mb-4">
        <h4 class="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-1">Prompt generation</h4>
        <p class="text-[11px] text-gray-500 mb-2">
          v1 told the model to bias toward a 2&ndash;10 minute window and it obeyed flatly.
          v2 gives it the measured run-length distribution instead &mdash; calibration through the
          prompt, with no multiplier on the model&rsquo;s output.
        </p>
        <table class="text-xs w-full">
          <thead><tr class="text-gray-400">
            <th class="text-left font-medium py-1">Prompt</th>
            <th class="text-right font-medium py-1">Scored</th>
            <th class="text-right font-medium py-1">Median err</th>
            <th class="text-right font-medium py-1">In band</th>
            <th class="text-right font-medium py-1">Bias</th>
          </tr></thead>
          <tbody>${versions.map(cmpRow).join('')}</tbody>
        </table>
      </div>` : '';

    // Baselines: what the estimator has to BEAT. Without these the card can
    // only say "is it good?", never "is it better than doing no thinking at
    // all?" — and the oracle row is what makes the restated in-band bar
    // legible as achievable rather than arbitrary.
    const baseRow = (label, b, note) => (!b ? '' : `<tr class="border-t border-gray-200 dark:border-gray-800">
      <td class="py-1 text-gray-600 dark:text-gray-300">${esc(label)}<div class="text-[10px] text-gray-500">${esc(note)}</div></td>
      <td class="py-1 text-right">${esc(fmtSecs(b.medianAbsErrS))}</td>
      <td class="py-1 text-right">${esc(fmtPct(b.withinBand))}</td>
      <td class="py-1 text-right">${esc(fmtSecs(b.medianBiasS))}</td>
    </tr>`);
    const baselineHtml = baselines ? `
      <div class="mt-4">
        <h4 class="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2">Baselines to beat</h4>
        <table class="text-xs w-full">
          <thead><tr class="text-gray-400">
            <th class="text-left font-medium py-1">Predictor</th>
            <th class="text-right font-medium py-1">Median err</th>
            <th class="text-right font-medium py-1">In band</th>
            <th class="text-right font-medium py-1">Bias</th>
          </tr></thead>
          <tbody>
            ${baseRow('Estimator', {
              medianAbsErrS: head.medianAbsErrS,
              withinBand: head.withinBand,
              medianBiasS: head.medianBiasS,
            }, `prompt ${headLabel}`)}
            ${baseRow('Fixed constant', baselines.constant, 'say the same thing every time')}
            ${baseRow('Elapsed-only oracle', baselines.oracle, 'best possible knowing only elapsed time')}
          </tbody>
        </table>
      </div>` : '';

    // Priors freshness. The numbers the prompt feeds the model are a
    // committed constant, so they can go stale; this strip is the loop that
    // closes. When it says stale, re-run the refresh SQL committed beside
    // RUN_LENGTH_PRIORS in src/services/llm.js and open a small PR.
    const priors = e.priors || null;
    const priorsHtml = priors ? `
      <div class="mt-4 rounded-lg border ${priors.stale
        ? 'border-amber-400/50 bg-amber-50 dark:bg-amber-900/10'
        : 'border-gray-200 dark:border-gray-800'} p-3">
        <div class="flex items-baseline justify-between flex-wrap gap-2">
          <h4 class="text-sm font-semibold text-gray-600 dark:text-gray-300">
            Run-length figures given to the model
          </h4>
          <span class="text-xs ${priors.stale ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}">
            ${priors.stale ? 'Priors stale — re-run the committed refresh query and update the constant' : 'Priors current'}
          </span>
        </div>
        <p class="text-[11px] text-gray-500 mt-0.5 mb-2">
          Snapshot ${esc(priors.snapshot.generatedOn)} from ${fmtInt(priors.snapshot.scoredTicks)} scored guesses
          across ${fmtInt(priors.snapshot.runs)} runs since ${esc(priors.snapshot.windowStart)}.
          They change only when someone approves a change, never on their own.
          ${priors.staleReasons && priors.staleReasons.length
            ? `<br><b>${esc(priors.staleReasons.join('; '))}</b>` : ''}
        </p>
        <table class="text-xs w-full">
          <thead><tr class="text-gray-400">
            <th class="text-left font-medium py-1">Elapsed bucket</th>
            <th class="text-right font-medium py-1">Told the model</th>
            <th class="text-right font-medium py-1">Actually now</th>
            <th class="text-right font-medium py-1">Drift</th>
          </tr></thead>
          <tbody>${(priors.buckets || []).map((b) => `
            <tr class="border-t border-gray-200 dark:border-gray-800">
              <td class="py-1 text-gray-600 dark:text-gray-300">${esc(b.bucket)}</td>
              <td class="py-1 text-right">${esc(fmtSecs(b.committedP50))}</td>
              <td class="py-1 text-right">${esc(fmtSecs(b.liveP50))}</td>
              <td class="py-1 text-right ${b.driftRatio != null && b.driftRatio > 0.25
                ? 'text-amber-600 dark:text-amber-400' : ''}">${esc(fmtPct(b.driftRatio))}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>` : '';

    // All-time line, mostly to expose the pre-fix unresolved tail next to the
    // recent window — a falling unresolved rate is the estimator-teardown fix
    // (#891) working.
    const allTimeHtml = `<div class="mt-2 text-xs text-gray-500">
      All time: ${fmtInt(all.scored)} scored of ${fmtInt(all.ticks)} guesses ·
      median error ${esc(fmtSecs(all.medianAbsErrS))} ·
      ${esc(fmtPct(all.withinBand))} in band ·
      ${esc(fmtPct(all.unresolvedRate))} unresolved
    </div>`;

    const breakdown = (title, rows, keyLabel) => `
      <div>
        <h4 class="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2">${esc(title)}</h4>
        ${rows.length ? `<table class="text-xs w-full">
          <thead><tr class="text-gray-400">
            <th class="text-left font-medium py-1">${esc(keyLabel)}</th>
            <th class="text-right font-medium py-1">Scored</th>
            <th class="text-right font-medium py-1">Median err</th>
            <th class="text-right font-medium py-1">In band</th>
          </tr></thead>
          <tbody>${rows.map((r) => `<tr class="border-t border-gray-200 dark:border-gray-800">
            <td class="py-1 text-gray-600 dark:text-gray-300">${esc(r.label)}</td>
            <td class="py-1 text-right">${fmtInt(r.scored)}</td>
            <td class="py-1 text-right">${esc(fmtSecs(r.medianAbsErrS))}</td>
            <td class="py-1 text-right">${esc(fmtPct(r.withinBand))}</td>
          </tr>`).join('')}</tbody>
        </table>` : `<p class="text-xs text-gray-500">No data yet.</p>`}
      </div>`;

    // #892: split by prompt version. v1's bias swings from +81s early to
    // -299s late; v2's should stay flat, and this table is where that shows.
    const byElapsed = (e.byElapsed || []).map((r) => ({
      ...r,
      label: r.promptVersion == null ? r.bucket : `${r.bucket} · v${r.promptVersion}`,
    }));
    const byOutcome = (e.byOutcome || []).map((r) => ({ ...r, label: r.outcome }));

    // 30-day daily median-error sparkline. Same bar idiom as the other
    // charts, with a per-day hover tooltip.
    const daily = (e.daily || []).filter((d) => d.medianAbsErrS != null);
    let chart = '<p class="text-xs text-gray-500">No scored guesses in the last 30 days.</p>';
    if (daily.length) {
      const W = 640, H = 140, topPad = 12, botPad = 16;
      const plot = H - topPad - botPad;
      const bw = W / daily.length;
      // #892: the dashed line is the ORACLE baseline (the best any
      // elapsed-only predictor could do), not the retired fixed 90s bar —
      // that is the number a day's error has to sit under to mean anything.
      const errBar = oracleErr != null ? oracleErr : 200;
      const max = Math.max(errBar, ...daily.map((d) => Number(d.medianAbsErrS) || 0));
      const barY = topPad + plot - (errBar / max) * plot;
      const bars = daily.map((d, i) => {
        const v = Number(d.medianAbsErrS) || 0;
        const h = (v / max) * plot;
        const x = i * bw;
        const y = topPad + plot - h;
        const over = v > errBar;
        const tipId = `est-day-${i}`;
        tipStore[tipId] = `<div class="font-semibold mb-1">${esc(dayLabel(d.day))}</div>
          <div>median error ${esc(fmtSecs(v))}</div>
          <div class="text-gray-400">${fmtInt(d.scored)} scored guess${d.scored === 1 ? '' : 'es'}</div>`;
        return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}"
                  height="${Math.max(0, h).toFixed(1)}" fill="${over ? '#f59e0b' : '#6366f1'}"></rect>
                <rect class="dc-hover" x="${x.toFixed(1)}" y="${topPad}" width="${bw.toFixed(1)}" height="${plot}"
                  fill="#6366f1" fill-opacity="0" pointer-events="all" data-tip-id="${tipId}"></rect>`;
      }).join('');
      chart = `
        <svg viewBox="0 0 ${W} ${H}" class="w-full text-gray-500" preserveAspectRatio="none" style="height:140px">
          <line x1="0" y1="${barY.toFixed(1)}" x2="${W}" y2="${barY.toFixed(1)}"
                stroke="currentColor" stroke-opacity="0.45" stroke-width="0.75" stroke-dasharray="4 3" />
          ${bars}
        </svg>
        <div class="flex justify-between text-[10px] text-gray-500 mt-1">
          <span>${esc(dayLabel(daily[0].day))}</span>
          <span>${esc(fmtSecs(errBar))} oracle baseline (dashed)</span>
          <span>${esc(dayLabel(daily[daily.length - 1].day))}</span>
        </div>`;
    }

    el.innerHTML = `
      ${versionHtml}
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">${tiles}</div>
      ${verdictHtml}
      ${allTimeHtml}
      ${baselineHtml}
      ${priorsHtml}
      <div class="grid sm:grid-cols-2 gap-6 mt-6">
        ${breakdown('By how far into the run', byElapsed, 'Elapsed')}
        ${breakdown('By how the run ended', byOutcome, 'Outcome')}
      </div>
      <h4 class="text-sm font-semibold text-gray-500 dark:text-gray-400 mt-6 mb-2">Daily median error (30d)</h4>
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
  // Guarded for the SSG prerender pass, which evaluates this module in Node
  // (#1082 chunk E). In the browser this is the same boolean as before.
  const DEMO = typeof window !== 'undefined'
    && new URLSearchParams(location.search).get('demo') === '1';
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
      <div id="admin-estimator-gate" class="hidden text-gray-500 text-center py-20"></div>

      <main id="admin-estimator-content" class="hidden space-y-6">
        <!-- Progress estimator accuracy (#891, moved out of Analytics in #898) -->
        <section class="${AdminUI.card} p-4">
          <h3 class="text-lg font-semibold mb-1 inline-flex items-center">Progress estimator accuracy
            <span class="dc-info" data-info="estimator" tabindex="0" role="button" aria-label="What is this?">?</span>
          </h3>
          <p class="text-xs text-gray-500 mb-4">
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

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') window.AdminEstimator = AdminEstimator;
