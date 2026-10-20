'use strict';

import { useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';

// Homeroom bot → Calls (#admin/homeroom-bot/calls).
//
// The platform's short helper calls (titles, the plan at Make it, reads of a
// chat message to the bot, quick replies, the content review, …), read off
// the LLM telemetry they already record (llm-telemetry.js helperCallsReport,
// GET /api/admin/homeroom-bot/calls): per helper and per model its first
// attempt asked, how many calls, how many that model answered, how many
// were late, how many Haiku answered in its place, how long the whole call
// took, and what it cost. A change of the helper model (Settings → Models →
// Helper calls) shows as a second row for the same helper, so before and
// after read side by side. Read-only: any admin.

export interface HelperModelRow {
  model: string | null;
  calls: number;
  firstOkRate: number | null;
  lateRate: number | null;
  fallbackRate: number | null;
  unanswered: number;
  firstMs: { p50: number | null; p90: number | null };
  totalMs: { p50: number | null; p90: number | null };
  avgCostUsd: number | null;
  costUsd: number;
}

export interface HelperRow {
  component: string;
  calls: number;
  costUsd: number;
  limitMs?: number | null;
  models: HelperModelRow[];
}

export interface CallsPayload {
  days: number;
  to?: string;
  helperModel?: string | null;
  helpers: HelperRow[];
  totals: { calls: number; costUsd: number };
}

const DAYS = [1, 7, 30] as const;

// What each helper is, in the words the rest of the console uses.
const HELPER_LABEL: Record<string, string> = {
  issue_title: 'Request title preview',
  quick_replies: 'Quick replies',
  short_description: 'One-line description',
  chat_ask: 'A chat message to the bot',
  workshop_ask: 'The ask box',
  app_sketch: 'Sketch card',
  first_version_plan: 'Plan at Make it',
  first_version_look: 'Early first look',
  session_title: 'Change title',
  progress_estimate: 'Progress guess',
  challenge_grade: 'Challenge grade',
  challenge_grade_feedback: 'Challenge grade (feedback)',
  challenge_grade_proposal: 'Challenge grade (proposal)',
  report_summary: 'Report summary',
  content_review: 'Content review',
  small_change: 'Small-change tag',
};

export function helperLabel(component: string): string {
  return HELPER_LABEL[component] || component.replace(/_/g, ' ');
}

/** "0.6 s", "12 s", or '' for none. Pure. */
export function seconds(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const s = Number(ms) / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

/** "97%", or '' for none. Pure. */
export function percent(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x))) return '';
  const p = Number(x) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/** "$0.00012", a helper call's cost at the precision it has. Pure. */
export function callCost(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const v = Number(n);
  if (v === 0) return '$0';
  return v < 0.01 ? `$${v.toPrecision(2)}` : `$${v.toFixed(2)}`;
}

/** "z-ai/glm-5.3-flash" → "glm-5.3-flash"; Claude ids as they are. Pure. */
export function shortModel(id: string | null | undefined): string {
  if (!id) return 'unknown';
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function HelperCallsView({ payload, days, onDays, error = null }: {
  payload: CallsPayload | null; days: number; onDays: (d: number) => void; error?: string | null;
}) {
  const helpers = payload?.helpers || [];
  return (
    <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bot-calls">
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Helper calls</h2>
        <span className={AdminUI.cardDescription} id="admin-homeroom-bot-calls-total">
          {payload
            ? `${payload.totals.calls} call${payload.totals.calls === 1 ? '' : 's'} in the last ${payload.days} day${payload.days === 1 ? '' : 's'}, ${callCost(payload.totals.costUsd)}`
            : 'Loading…'}
        </span>
      </div>
      <div className="flex gap-2 mb-3" id="admin-homeroom-bot-calls-days">
        {DAYS.map((d) => (
          <button
            key={d} type="button" data-calls-days={d} aria-pressed={days === d}
            className={days === d ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
            onClick={() => onDays(d)}
          >{d === 1 ? 'Last day' : `Last ${d} days`}</button>
        ))}
      </div>
      <p className={`${AdminUI.muted} mb-3`} id="admin-homeroom-bot-calls-about">
        {`The short calls behind titles, the plan at Make it, reads of a chat message to the bot, quick replies, the content review and the rest, each counted once however many tries it took. They ask the helper model first${payload?.helperModel ? ` (${shortModel(payload.helperModel)} now)` : ''}, and Haiku 5.5 answers when it is late or its answer cannot be used. A change of the helper model shows as a second row for the same helper.`}
      </p>
      {error ? <p className="text-sm text-red-700 dark:text-red-300 mb-2" role="alert">{error}</p> : null}
      <div className={AdminUI.tableWrap}>
        <table className={`${AdminUI.table} min-w-[60rem]`} id="admin-homeroom-bot-calls-table">
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>Helper</th>
              <th className={AdminUI.th}>Asked first</th>
              <th className={AdminUI.th}>Calls</th>
              <th className={AdminUI.th}>Answered first time</th>
              <th className={AdminUI.th}>Late</th>
              <th className={AdminUI.th}>Haiku answered</th>
              <th className={AdminUI.th}>Time, median / 90th</th>
              <th className={AdminUI.th}>Cost per call</th>
            </tr>
          </thead>
          <tbody>
            {helpers.flatMap((h) => h.models.map((m, i) => (
              <tr className={AdminUI.trHover} key={`${h.component}|${m.model || ''}`} data-calls-helper={h.component} data-calls-model={m.model || ''}>
                <td className={AdminUI.td}>
                  {i === 0 ? (
                    <>
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">{helperLabel(h.component)}</div>
                      {h.limitMs ? <div className={`${AdminUI.muted} text-xs`}>{`Time limit ${seconds(h.limitMs)}`}</div> : null}
                    </>
                  ) : null}
                </td>
                <td className={`${AdminUI.td} font-mono text-xs`}>{shortModel(m.model)}</td>
                <td className={`${AdminUI.td} tabular-nums`}>{m.calls}</td>
                <td className={`${AdminUI.td} tabular-nums`}>{percent(m.firstOkRate)}</td>
                <td className={`${AdminUI.td} tabular-nums`}>{percent(m.lateRate)}</td>
                <td className={`${AdminUI.td} tabular-nums`}>
                  {percent(m.fallbackRate)}
                  {m.unanswered ? <div className={`${AdminUI.muted} text-xs`}>{`${m.unanswered} not answered`}</div> : null}
                </td>
                <td className={`${AdminUI.td} tabular-nums whitespace-nowrap`}>
                  {m.totalMs.p50 == null ? '' : `${seconds(m.totalMs.p50)} / ${seconds(m.totalMs.p90)}`}
                </td>
                <td className={`${AdminUI.td} tabular-nums`}>{callCost(m.avgCostUsd)}</td>
              </tr>
            )))}
            {payload && helpers.length === 0 ? (
              <tr>
                <td className={AdminUI.td} colSpan={8} id="admin-homeroom-bot-calls-empty">No helper calls in this window.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The Calls tab: the report for the days picked, read when the tab is first opened. */
export function HelperCalls() {
  const [days, setDays] = useState<number>(7);
  const [payload, setPayload] = useState<CallsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // The window on screen, so an answer for one switched away from is dropped.
  const shown = useRef(days);
  shown.current = days;
  useEffect(() => {
    const asked = days;
    setError(null);
    (window as any).AdminConsole.fetchJson(`/api/admin/homeroom-bot/calls?days=${asked}`)
      .then(({ ok, data }: { ok: boolean; data: unknown }) => {
        if (!alive.current || shown.current !== asked) return;
        if (ok && data && typeof data === 'object') setPayload(data as CallsPayload);
        else setError('Could not load the helper calls.');
      })
      .catch(() => { if (alive.current) setError('Could not load the helper calls.'); });
  }, [days]);
  return <HelperCallsView payload={payload} days={days} onDays={(d) => { setPayload(null); setDays(d); }} error={error} />;
}
