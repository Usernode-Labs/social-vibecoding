'use strict';

import { useEffect, useMemo, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

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
//   - the format/tooltip helpers below are a deliberate second copy of the
//     ones in admin-analytics.js. Every console module carries its own
//     rather than sharing a util module — see the header of admin-merges.js;
//   - the mouse-following `<div id="dc-tip">` is appended to <body> so it can
//     escape the section's overflow, and removed on teardown. Analytics owns
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
//
// ── React-owned (#1120 slice 14) ──────────────────────────────────────
//
// Ninth section through the seam, and the first with a body-level escape
// hatch. `#dc-tip` is a mouse-following tooltip appended to <body> precisely
// so it can escape the section's `overflow`, which means it is NOT inside any
// React-owned subtree and is not modelled as state. It stays imperative — the
// hover delegation is attached to the section root by ref and the tooltip's
// own `innerHTML` is written by that handler — and the effect that installs it
// removes the node on cleanup. That is the documented legacy-host seam in
// AGENTS.md, applied to a node that lives outside the tree entirely.
//
// What did become state: the payload, the gate, and — the reason to bother —
// the tip STORE. It used to be filled as a side effect of building an HTML
// string (`tipStore[tipId] = …` inside the bar `.map`), so the store and the
// markup could only agree because they were produced in the same pass. The
// bars are components now and the store is filled by an effect keyed on the
// same data, which is the one ordering that cannot drift.

const fmtInt = (n: any) => (n == null ? '—' : Number(n).toLocaleString());

// ── Hover tooltip ─────────────────────────────────────────────
// Native SVG <title> tooltips are slow and only fire over the painted bar, so
// columns with a short/zero bar feel "dead". Instead the chart lays a
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
 * Wire mouse-following tooltips on a container via event delegation, and
 * return the teardown. The container is React's, the tooltip is not: the
 * handler only ever writes `#dc-tip`, never anything inside the container.
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
// on the (?) icon, where there's no cursor to follow).
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

// ── (?) info icons ────────────────────────────────────────────
// Plain-language explanation, keyed by the data-info attribute on the
// .dc-info icon in the markup below.
const INFO: Record<string, string> = {
  estimator: 'Predicted-vs-actual for the <b>experimental AI progress estimate</b> (Settings &rarr; Experimental). Each tick the estimator guesses how many seconds of coding remain; when the run ends the real remaining time is backfilled, and the gap between the two is the error. <b>Median error</b> is the typical gap. <b>Within &frac12;&times;&ndash;2&times;</b> is the share of guesses between half and double the real time. <b>Median bias</b> is signed: negative = optimistic (guessed too fast). <b>Unresolved</b> is guesses that never got matched to an outcome. A background sweep now resolves the ones orphaned by a mid-run restart, so this should sit near zero. Unlike every other chart here, this one <b>always includes admins</b>: the estimator is opt-in and default-OFF, so excluding them would leave it permanently empty.<br><br><b>v1 vs v2.</b> v1 was the original prompt, which told the model to &ldquo;bias toward the 2-10 minute window&rdquo;, and it obeyed flatly, and six values accounted for 87% of its guesses. v2 feeds it the <i>measured</i> run-length distribution instead. Calibration is delivered entirely through the prompt: <b>no multiplier is applied to the model&rsquo;s output</b>, because a correction factor fitted to one model silently distorts the estimate as soon as the model or its inputs improve.<br><br><b>Baselines.</b> A candidate has to beat two things, not nothing: a fixed constant, and the elapsed-only <i>oracle</i>, the best any predictor knowing only elapsed time could do, fitted to the answers. The oracle measures about 39% in band, which is why the retired 60% bar was unreachable by anything at all.<br><br><b>The guard.</b> Raw = what the model said tick to tick; displayed = what the user saw after the monotonicity guard. v1&rsquo;s raw projections slipped LATER on 65% of transitions (a treadmill: the finish moved a minute further away every minute). <b>Clamped</b> = the guard held the previous projection because an extension had no cause. <b>Floored</b> = the run outlived its estimate and the readout sat at the 30s floor for a tick before the next guess extended it; the countdown always shows a number.<br><br><b>Leaves experimental when</b>, on <b>v2 data only</b>: &ge; 200 scored guesses across 50+ runs from 5+ people, in-band share &ge; 45% (above both the 39% oracle and the 41% scale-corrected benchmark), median bias within &plusmn;60s, median error at or below the oracle baseline, projected finish pushed later on &le; 25% of consecutive readings with outright backwards jumps under 5%, and completion claims firing with 5+ minutes remaining under 10% of the time.',
};
tipStore['info-estimator'] = INFO.estimator;

// Short "Mar 3" style label for a single calendar day. The API returns these
// as 'YYYY-MM-DD' text; we also tolerate full ISO strings / Date objects so a
// stray value can never render as "Invalid Date".
function dayLabel(d: any): string {
  if (!d) return '';
  const s = String(d);
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

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

// ── Progress estimator accuracy (#891) ────────────────────────
//
// The bar the card states up front, so the decision is mechanical. Also
// reproduced in the (?) definition.
//
// #892 restated it. The old bar was 90s median error and a 0.60 in-band
// share; production measured the best POSSIBLE elapsed-only predictor at
// 0.39 in band, so 0.60 was unreachable by anything and the card could never
// have said yes. The new in-band bar of 0.45 sits above both that 0.39 oracle
// and the 0.41 scale-corrected benchmark, so clearing it proves the prompt
// work added something rather than just reproducing a lookup table. Median
// error is judged against the live oracle baseline rather than a fixed
// number, so it stays honest as the data grows.
const ESTIMATOR_BAR = {
  scored: 200, runs: 50, users: 5,
  withinBand: 0.45, biasS: 60,
  laterRate: 0.25, increasedRate: 0.05, unearnedClaimRate: 0.10,
};
// The prompt generation the bar is judged on — v1 is the superseded
// flat-prior prompt and must never be pooled into the verdict.
const CANDIDATE_PROMPT_VERSION = 2;

// Round to whole seconds FIRST, then split into m/s — rounding the remainder
// independently renders 119.5s as "1m 60s".
const fmtSecs = (v: any): string => {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const total = Math.round(Math.abs(n));
  if (total < 60) return `${sign}${total}s`;
  return `${sign}${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
};
const fmtPct = (v: any): string => (v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(0)}%`);

// Does the candidate clear every threshold? Returns null when there is simply
// not enough data yet — "not proven" is not the same as "failed".
//
// #892: judged on the CANDIDATE prompt version alone (pooling v1 in would
// drag the answer toward the prompt this change replaced), against the live
// oracle baseline rather than a fixed error number, and including the two
// display-quality gates — a countdown that walks backwards is a failure even
// if its numbers are good.
function estimatorVerdict(w: any, ctx: any): { ready: boolean; reason: string } | null {
  if (!w || !w.scored) return null;
  const c = ctx || {};
  const enough = w.scored >= ESTIMATOR_BAR.scored
    && w.runs >= ESTIMATOR_BAR.runs && w.users >= ESTIMATOR_BAR.users;
  if (!enough) return { ready: false, reason: `not enough v${CANDIDATE_PROMPT_VERSION} data yet` };
  const fails: string[] = [];
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

// Colour only the three decision metrics — green when the threshold is met,
// amber when it isn't. Sample-size and data-health tiles stay neutral.
const tone = (ok: boolean | null) => (ok == null
  ? 'text-zinc-500 dark:text-zinc-400'
  : ok ? 'text-green-800 dark:text-green-400' : 'text-amber-800 dark:text-amber-400');

function Tile({ label, value, cls, sub }: { label: string; value: string; cls?: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${cls || ''}`}>{value}</div>
      {sub ? <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{sub}</div> : null}
    </div>
  );
}

const TH_L = 'text-left font-medium py-1';
const TH_R = 'text-right font-medium py-1';
const TR = 'border-t border-zinc-200 dark:border-zinc-800';
const H4 = 'text-sm font-semibold text-zinc-500 dark:text-zinc-400';

function Breakdown({ title, rows, keyLabel }: { title: string; rows: any[]; keyLabel: string }) {
  return (
    <div>
      <h4 className={`${H4} mb-2`}>{title}</h4>
      {rows.length ? (
        <table className="text-xs w-full">
          <thead>
            <tr className="text-zinc-500 dark:text-zinc-400">
              <th className={TH_L}>{keyLabel}</th>
              <th className={TH_R}>Scored</th>
              <th className={TH_R}>Median err</th>
              <th className={TH_R}>In band</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={i} className={TR}>
                <td className="py-1 text-zinc-600 dark:text-zinc-300">{r.label}</td>
                <td className="py-1 text-right">{fmtInt(r.scored)}</td>
                <td className="py-1 text-right">{fmtSecs(r.medianAbsErrS)}</td>
                <td className="py-1 text-right">{fmtPct(r.withinBand)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="text-xs text-zinc-500 dark:text-zinc-400">No data yet.</p>}
    </div>
  );
}

function BaseRow({ label, b, note }: { label: string; b: any; note: string }) {
  if (!b) return null;
  return (
    <tr className={TR}>
      <td className="py-1 text-zinc-600 dark:text-zinc-300">
        {label}
        <div className="text-[10px] text-zinc-500 dark:text-zinc-400">{note}</div>
      </td>
      <td className="py-1 text-right">{fmtSecs(b.medianAbsErrS)}</td>
      <td className="py-1 text-right">{fmtPct(b.withinBand)}</td>
      <td className="py-1 text-right">{fmtSecs(b.medianBiasS)}</td>
    </tr>
  );
}

const CHART = { W: 640, H: 140, topPad: 12, botPad: 16 };

/**
 * 30-day daily median-error sparkline. Same bar idiom as the other charts,
 * with a per-day hover tooltip. The tip copy is registered by an effect keyed
 * on the same `daily` array the bars are drawn from — the old code filled the
 * store inside the `.map` that built the markup, so the two could only agree
 * by construction.
 */
function DailyChart({ daily, errBar }: { daily: any[]; errBar: number }) {
  useEffect(() => {
    daily.forEach((d, i) => {
      tipStore[`est-day-${i}`] = `<div class="font-semibold mb-1">${dayLabel(d.day)}</div>
          <div>median error ${fmtSecs(Number(d.medianAbsErrS) || 0)}</div>
          <div class="text-zinc-500 dark:text-zinc-400">${fmtInt(d.scored)} scored guess${d.scored === 1 ? '' : 'es'}</div>`;
    });
  }, [daily]);

  if (!daily.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">No scored guesses in the last 30 days.</p>;
  }
  const { W, H, topPad, botPad } = CHART;
  const plot = H - topPad - botPad;
  const bw = W / daily.length;
  const max = Math.max(errBar, ...daily.map((d) => Number(d.medianAbsErrS) || 0));
  const barY = topPad + plot - (errBar / max) * plot;
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-zinc-500 dark:text-zinc-400"
        preserveAspectRatio="none" style={{ height: '140px' }}>
        {/* #892: the dashed line is the ORACLE baseline (the best any
            elapsed-only predictor could do), not the retired fixed 90s bar —
            that is the number a day's error has to sit under to mean anything. */}
        <line x1="0" y1={barY.toFixed(1)} x2={W} y2={barY.toFixed(1)}
          stroke="currentColor" strokeOpacity="0.45" strokeWidth="0.75" strokeDasharray="4 3" />
        {daily.map((d, i) => {
          const v = Number(d.medianAbsErrS) || 0;
          const h = (v / max) * plot;
          const x = i * bw;
          const y = topPad + plot - h;
          return (
            // eslint-disable-next-line react/no-array-index-key
            <g key={i}>
              <rect x={(x + 1).toFixed(1)} y={y.toFixed(1)} width={Math.max(1, bw - 2).toFixed(1)}
                height={Math.max(0, h).toFixed(1)} fill={v > errBar ? '#f59e0b' : '#6366f1'} />
              <rect className="dc-hover" x={x.toFixed(1)} y={topPad} width={bw.toFixed(1)} height={plot}
                fill="#6366f1" fillOpacity="0" pointerEvents="all" data-tip-id={`est-day-${i}`} />
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-500 dark:text-zinc-400 mt-1">
        <span>{dayLabel(daily[0].day)}</span>
        <span>{`${fmtSecs(errBar)} oracle baseline (dashed)`}</span>
        <span>{dayLabel(daily[daily.length - 1].day)}</span>
      </div>
    </>
  );
}

function EstimatorCard({ e }: { e: any }) {
  const w = (e && e.last30d) || null;
  const all = (e && e.allTime) || null;
  if (!e || !all || !all.ticks) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Not enough data yet.</p>;
  }

  // #892: the headline tiles describe the CANDIDATE prompt version when there
  // is any of it, falling back to the 30-day window before v2 has produced
  // data. Judging the recalibration against a v1-dominated pool would answer
  // the wrong question.
  const versions = e.byPromptVersion || [];
  const cand = versions.find((v: any) => v.promptVersion === CANDIDATE_PROMPT_VERSION) || null;
  const head = (cand && cand.scored) ? cand : w;
  const headLabel = (cand && cand.scored) ? `v${CANDIDATE_PROMPT_VERSION}` : '30d';
  const baselines = e.baselines || null;
  const oracleErr = baselines && baselines.oracle ? baselines.oracle.medianAbsErrS : null;

  const errOk = (head.medianAbsErrS == null || oracleErr == null) ? null : head.medianAbsErrS <= oracleErr;
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

  const verdict = estimatorVerdict(head, { baselines, monotonicity: mono, completionClaims: claims });
  const priors = e.priors || null;

  // #892: split by prompt version. v1's bias swings from +81s early to -299s
  // late; v2's should stay flat, and this table is where that shows.
  const byElapsed = (e.byElapsed || []).map((r: any) => ({
    ...r,
    label: r.promptVersion == null ? r.bucket : `${r.bucket} · v${r.promptVersion}`,
  }));
  const byOutcome = (e.byOutcome || []).map((r: any) => ({ ...r, label: r.outcome }));
  const daily = (e.daily || []).filter((d: any) => d.medianAbsErrS != null);

  return (
    <>
      {/* ── v1 vs v2, the card's lead (#892) ──────────────────────────
          The whole point of the recalibration is "did feeding the model the
          measured distribution help?", and a pooled average cannot answer it.
          Rendered first, before the tiles, so that comparison is read first. */}
      {versions.length ? (
        <div className="mb-4">
          <h4 className={`${H4} mb-1`}>Prompt generation</h4>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-2">
            v1 told the model to bias toward a 2–10 minute window and it obeyed flatly.
            v2 gives it the measured run-length distribution instead: calibration through the
            prompt, with no multiplier on the model’s output.
          </p>
          <table className="text-xs w-full">
            <thead>
              <tr className="text-zinc-500 dark:text-zinc-400">
                <th className={TH_L}>Prompt</th>
                <th className={TH_R}>Scored</th>
                <th className={TH_R}>Median err</th>
                <th className={TH_R}>In band</th>
                <th className={TH_R}>Bias</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v: any) => (
                <tr key={v.promptVersion} className={TR}>
                  <td className="py-1 text-zinc-600 dark:text-zinc-300">
                    {`v${fmtInt(v.promptVersion)}`}
                    {v.promptVersion === CANDIDATE_PROMPT_VERSION
                      ? <> <span className="text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-400">candidate</span></>
                      : null}
                  </td>
                  <td className="py-1 text-right">{fmtInt(v.scored)}</td>
                  <td className="py-1 text-right">{fmtSecs(v.medianAbsErrS)}</td>
                  <td className="py-1 text-right">{fmtPct(v.withinBand)}</td>
                  <td className="py-1 text-right">{fmtSecs(v.medianBiasS)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label={`Scored guesses (${headLabel})`} value={fmtInt(head.scored)} cls={sampleOk ? '' : 'text-zinc-500 dark:text-zinc-400'}
          sub={`${fmtInt(head.runs)} runs · ${fmtInt(head.users)} users · need ${ESTIMATOR_BAR.scored}/${ESTIMATOR_BAR.runs}/${ESTIMATOR_BAR.users}`} />
        <Tile label="Median error" value={fmtSecs(head.medianAbsErrS)} cls={tone(errOk)}
          sub={oracleErr == null ? 'bar: ≤ the oracle baseline' : `bar: ≤ ${fmtSecs(oracleErr)} (oracle)`} />
        <Tile label="Within ½×–2×" value={fmtPct(head.withinBand)} cls={tone(bandOk)}
          sub={`bar: ≥ ${fmtPct(ESTIMATOR_BAR.withinBand)}`} />
        <Tile label="Median bias" value={fmtSecs(head.medianBiasS)} cls={tone(biasOk)}
          sub={head.medianBiasS == null ? `bar: ±${ESTIMATOR_BAR.biasS}s`
            : `${head.medianBiasS < 0 ? 'optimistic' : 'pessimistic'} · bar: ±${ESTIMATOR_BAR.biasS}s`} />
        {/* Treadmill: the share of consecutive readings that pushed the finish
            LATER. Computed on what the user SAW, so it measures the guard. */}
        <Tile label="Finish pushed later" value={fmtPct(disp && disp.laterRate)} cls={tone(laterOk)}
          sub={`shown · bar: ≤ ${fmtPct(ESTIMATOR_BAR.laterRate)}`} />
        <Tile label="Countdown went backwards" value={fmtPct(disp && disp.increasedRate)} cls={tone(backOk)}
          sub={`shown · bar: < ${fmtPct(ESTIMATOR_BAR.increasedRate)}`} />
        <Tile label="Held / floored" value={`${fmtPct(mono && mono.clampRate)} / ${fmtPct(mono && mono.flooredRate)}`}
          sub="guard held the projection · run outlived it" />
        <Tile label={'Unearned "nearly done"'} value={fmtPct(claims && claims.overFiveMinLeftRate)} cls={tone(claimOk)}
          sub={claims ? `${fmtInt(claims.ticks)} claims · ${fmtInt(claims.suppressed)} suppressed` : 'no claims yet'} />
        <Tile label="Within 60s" value={fmtPct(head.within60s)} sub="share of guesses inside a minute" />
        <Tile label="Unresolved" value={fmtPct(w.unresolvedRate)}
          sub={`${fmtInt(w.unresolved)} of ${fmtInt(w.ticks)} never matched`} />
        <Tile label="Toggle ON" value={fmtInt(e.usersEnabled)} sub="users opted in today" />
        <Tile label="Ran past estimate" value={fmtInt(w.ranPast)} sub="run outlived the guess" />
      </div>

      {verdict ? (
        <div className={`mt-3 text-sm ${verdict.ready ? 'text-green-800 dark:text-green-400' : 'text-amber-800 dark:text-amber-400'}`}>
          <b>{verdict.ready ? 'Ready to leave experimental' : 'Stays experimental'}</b>
          {`: ${verdict.reason} `}
          <span className="text-zinc-500 dark:text-zinc-400">(last 30 days)</span>
        </div>
      ) : (
        <div className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No scored guesses in the last 30 days yet.</div>
      )}

      {/* All-time line, mostly to expose the pre-fix unresolved tail next to
          the recent window — a falling unresolved rate is the
          estimator-teardown fix (#891) working. */}
      <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        {`All time: ${fmtInt(all.scored)} scored of ${fmtInt(all.ticks)} guesses · median error ${
          fmtSecs(all.medianAbsErrS)} · ${fmtPct(all.withinBand)} in band · ${fmtPct(all.unresolvedRate)} unresolved`}
      </div>

      {/* Baselines: what the estimator has to BEAT. Without these the card can
          only say "is it good?", never "is it better than doing no thinking at
          all?" — and the oracle row is what makes the restated in-band bar
          legible as achievable rather than arbitrary. */}
      {baselines ? (
        <div className="mt-4">
          <h4 className={`${H4} mb-2`}>Baselines to beat</h4>
          <table className="text-xs w-full">
            <thead>
              <tr className="text-zinc-500 dark:text-zinc-400">
                <th className={TH_L}>Predictor</th>
                <th className={TH_R}>Median err</th>
                <th className={TH_R}>In band</th>
                <th className={TH_R}>Bias</th>
              </tr>
            </thead>
            <tbody>
              <BaseRow label="Estimator" note={`prompt ${headLabel}`} b={{
                medianAbsErrS: head.medianAbsErrS,
                withinBand: head.withinBand,
                medianBiasS: head.medianBiasS,
              }} />
              <BaseRow label="Fixed constant" b={baselines.constant} note="say the same thing every time" />
              <BaseRow label="Elapsed-only oracle" b={baselines.oracle} note="best possible knowing only elapsed time" />
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Priors freshness. The numbers the prompt feeds the model are a
          committed constant, so they can go stale; this strip is the loop that
          closes. When it says stale, re-run the refresh SQL committed beside
          RUN_LENGTH_PRIORS in src/services/llm.js and open a small PR. */}
      {priors ? (
        <div className={`mt-4 rounded-lg border ${priors.stale
          ? 'border-amber-400/50 bg-amber-50 dark:bg-amber-900/10'
          : 'border-zinc-200 dark:border-zinc-800'} p-3`}>
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h4 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
              Run-length figures given to the model
            </h4>
            <span className={`text-xs ${priors.stale ? 'text-amber-800 dark:text-amber-400' : 'text-green-800 dark:text-green-400'}`}>
              {priors.stale ? 'Priors stale: re-run the committed refresh query and update the constant' : 'Priors current'}
            </span>
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 mb-2">
            {`Snapshot ${priors.snapshot.generatedOn} from ${fmtInt(priors.snapshot.scoredTicks)} scored guesses across ${
              fmtInt(priors.snapshot.runs)} runs since ${priors.snapshot.windowStart}. They change only when someone approves a change, never on their own.`}
            {priors.staleReasons && priors.staleReasons.length
              ? <><br /><b>{priors.staleReasons.join('; ')}</b></>
              : null}
          </p>
          <table className="text-xs w-full">
            <thead>
              <tr className="text-zinc-500 dark:text-zinc-400">
                <th className={TH_L}>Elapsed bucket</th>
                <th className={TH_R}>Told the model</th>
                <th className={TH_R}>Actually now</th>
                <th className={TH_R}>Drift</th>
              </tr>
            </thead>
            <tbody>
              {(priors.buckets || []).map((b: any) => (
                <tr key={b.bucket} className={TR}>
                  <td className="py-1 text-zinc-600 dark:text-zinc-300">{b.bucket}</td>
                  <td className="py-1 text-right">{fmtSecs(b.committedP50)}</td>
                  <td className="py-1 text-right">{fmtSecs(b.liveP50)}</td>
                  <td className={`py-1 text-right ${b.driftRatio != null && b.driftRatio > 0.25
                    ? 'text-amber-800 dark:text-amber-400' : ''}`}>{fmtPct(b.driftRatio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="grid sm:grid-cols-2 gap-6 mt-6">
        <Breakdown title="By how far into the run" rows={byElapsed} keyLabel="Elapsed" />
        <Breakdown title="By how the run ended" rows={byOutcome} keyLabel="Outcome" />
      </div>

      <h4 className={`${H4} mt-6 mb-2`}>Daily median error (30d)</h4>
      <DailyChart daily={daily} errBar={oracleErr != null ? oracleErr : 200} />
    </>
  );
}

// Staging demo passthrough: the page-level ?demo=1 has to reach the endpoint
// or src/routes/dashboard.js never substitutes the mock payload and every PR
// preview shows an empty section (progress_estimates is `staging:private`, so
// a prod-cloned staging DB has it schema-only). A strict no-op in production.
// NOTE: no includeAdmins — the endpoint deliberately ignores it (see header).
// Guarded for the SSG prerender pass, which evaluates this module in Node.
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';
const withDemo = (url: string) => `${url}${DEMO ? `${url.includes('?') ? '&' : '?'}demo=1` : ''}`;

function EstimatorSection() {
  const [gate, setGate] = useState<string | null>(null);
  const [payload, setPayload] = useState<any>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // One host-level delegation drives the mouse-following tooltip for the (?)
  // icons and the chart's hover rects. The tooltip node lives on <body> so it
  // can escape the section's overflow — it must be removed here or it would
  // linger (and keep showing stale copy) after the section is gone.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const detach = attachTooltip(root);
    return () => {
      detach();
      const tip = document.getElementById('dc-tip');
      if (tip) tip.remove();
      for (const k of Object.keys(tipStore)) if (k.startsWith('est-day-')) delete tipStore[k];
    };
  }, []);

  // Admin check up front. The data endpoint is independently enforced
  // server-side; this is just for a clean message. We do NOT navigate away on
  // an auth failure: a transient 401 shouldn't bounce an admin, and keeping
  // the shell rendered makes the page coherent under headless checks.
  useEffect(() => {
    (async () => {
      let me: any = null;
      try {
        me = await getJSON('/api/auth/me');
      } catch {
        if (alive.current) setGate('Sign in as an admin to view estimator accuracy.');
        return;
      }
      if (!alive.current) return;
      if (!me.user?.isAdmin) { setGate('Admin access required.'); return; }
      try {
        const data = await getJSON(withDemo('/api/admin/analytics/estimator'));
        if (alive.current) setPayload(data);
      } catch (err: any) {
        if (!alive.current) return;
        setGate(err.forbidden ? 'Admin access required.' : 'Failed to load estimator accuracy.');
      }
    })();
  }, []);

  return (
    <div id="admin-estimator-root" ref={rootRef}>
      <h2 className="text-lg font-semibold mb-4">Estimator accuracy</h2>
      {gate ? <div id="admin-estimator-gate" className="text-zinc-500 dark:text-zinc-400 text-center py-20">{gate}</div> : null}

      {gate ? null : (
        <main id="admin-estimator-content" className="space-y-6">
          {/* Progress estimator accuracy (#891, moved out of Analytics in #898) */}
          <section className={`${AdminUI.card} p-4`}>
            <h3 className="text-lg font-semibold mb-1 inline-flex items-center">
              Progress estimator accuracy
              <span className="dc-info" data-info="estimator" data-tip-id="info-estimator"
                tabIndex={0} role="button" aria-label="What is this?"
                onFocus={(ev) => showTipAt(ev.currentTarget, INFO.estimator)}
                onBlur={() => { ensureTip().style.display = 'none'; }}>?</span>
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
              How close the experimental AI progress estimate’s “time remaining” guesses land to the real remaining time. Last 30 days unless noted; always includes admins.
            </p>
            <div id="admin-estimator-card">
              {payload ? <EstimatorCard e={payload} /> : null}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

let host: Element | null = null;

const AdminEstimator = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <EstimatorSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminEstimator = AdminEstimator;

// `EstimatorCard` and `estimatorVerdict` are exported for
// tests/estimator-card-render.test.js, which renders the card against the
// staging demo payload rather than merely grepping it. See tests/lib/render-tsx.js.
export { AdminEstimator, EstimatorCard, estimatorVerdict };
