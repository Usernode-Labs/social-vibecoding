'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import { AdminUI } from './admin-console.js';
import { StudioPage } from './admin-bench-studio';

// The Homeroom bot console's Benchmark area (#admin/homeroom-bot/benchmark),
// #3654. Rendered by admin-homeroom-bot.tsx under its Benchmark tab, so it
// lives in that section's host and needs no host of its own.
//
// Four places, each with an address of its own below the tab's, and a sheet
// over them. It used to be one page 5,400px tall: the launcher, which spends
// money, above the reading; a run's results far below the runs, and no way to
// link to one; suite editing folded away at the bottom where nobody found it.
//
//   Overview   …/benchmark: what is happening now (runs in progress against
//              their caps, and how many trials wait for the judge, with the
//              words to ask for grading); which model each stage should use
//              on the default suite, beside the one in use, with "Use for
//              <stage>", which fills in the bot's Settings form (the admin
//              still presses Save there); the taste eval's latest scores; and
//              how the benchmark works, folded away.
//   Runs       …/benchmark/runs: what ran of each run (skipped and cancelled
//              trials said apart, never counted as done), spend against the
//              cap, cancel, a filter by suite, and a warning when a cap
//              stopped a run with most of its trials unrun.
//   One run    …/benchmark/runs/<id>: its facts, trial and spend bars, cancel
//              and the CSV, then all of its results: per stage and model
//              (accuracy, pass^k, cost per attempt and per success, p50/p95
//              time, timeouts and platform faults apart), against the
//              baseline with its 95% interval, cost against quality with the
//              Pareto frontier, slices by a tag, the judge and the spot
//              check. A taste run leads with its arms side by side, app by
//              app, then the rubric's criteria and the automatic checks.
//   Suites     …/benchmark/suites[/<id>]: the suites, and one suite's tasks,
//              with Freeze, New version and Delete where they are allowed,
//              Core v1's own state, taste briefs edited in their row, and one
//              Add task menu over the four ways to add a task.
//   Studio     …/benchmark/studio: the App bench studio's gallery of first
//              versions built from briefs, by model and context pack, beside
//              reference builds; its runs as they move, its packs and its
//              launcher (admin-bench-studio.tsx).
//   New run    a sheet over any of them: the launcher in four steps (suite,
//              stages, models, limits) beside what the run would do, asked
//              of the server before anything is spent (POST runs/estimate,
//              the same plan a launch records): its trials, its cost as a
//              range with what the range rests on, about how long it takes,
//              and the cap. A cap over $100 is confirmed first.
//
// The places replace the address rather than push it, as the console's tabs
// do, so they never re-route the console; an address opens its place.
//
// PERMISSIONS: any admin reads; every button that writes is gated on
// AdminConsole.canWrite() here and requireAdminWrite on the server
// (routes/homeroom-bench.js). Grading itself happens in an admin's own
// Claude session through the connector, not here; this screen only shows
// the judge's grades and lets a person override one.

const BASE = '/api/admin/homeroom-bot/bench';

type Stage = 'triage' | 'spec' | 'build' | 'followup' | 'checks_fix' | 'dm' | 'first_version' | 'capture';
const STAGE_LABEL: Record<Stage, string> = {
  triage: 'Triage', spec: 'Plan', build: 'Build', followup: 'Follow-up', checks_fix: 'Checks fix', dm: 'DM',
  first_version: 'First version', capture: 'Capture (before)',
};
const STAGES: Stage[] = ['triage', 'spec', 'build', 'followup', 'checks_fix', 'dm', 'first_version', 'capture'];
// #3737: the taste eval's two kinds, made from a brief or a commit rather
// than sampled from the bot's runs (services/bench/taste.js).
const TASTE_STAGES: Stage[] = ['first_version', 'capture'];
const SAMPLE_STAGES: Stage[] = STAGES.filter((st) => !TASTE_STAGES.includes(st));
// What a grade item calls a taste trial of either kind: the judge is never
// told which.
export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage as Stage] || (stage === 'taste' ? 'Taste' : stage);
}
// The taste rubric's criteria (services/bench/grading.js RUBRICS.taste), short.
export const TASTE_CRITERIA: { id: string; label: string }[] = [
  { id: 'hierarchy', label: 'Hierarchy' }, { id: 'type_scale', label: 'Type scale' }, { id: 'spacing', label: 'Spacing' },
  { id: 'accent', label: 'One accent' }, { id: 'both_looks', label: 'Both looks' }, { id: 'states', label: 'Empty, loading, error' },
  { id: 'copy', label: 'Copy' }, { id: 'no_tells', label: 'No tells' }, { id: 'works_at_390', label: 'Works at 390' },
  { id: 'kit_use', label: 'Kit use' }, { id: 'domain_fit', label: 'Domain fit' }, { id: 'would_ship', label: 'Would ship' },
];

// The bot's own model setting each benchmark stage informs (#3654 KEY_MODELS
// in services/homeroom-bot.js). A checks fix is a follow-up turn on the bot's
// proposal, so it shares that stage's model. DM has no model of its own: the
// bot answers DMs on the platform default.
export const BOT_STAGE_FOR: Partial<Record<Stage, 'triage' | 'spec' | 'build' | 'followup'>> = {
  triage: 'triage', spec: 'spec', build: 'build', followup: 'followup', checks_fix: 'followup',
};

// What an admin's own Claude session is asked, word for word, to grade the
// queue (services/mcp-charter.js answers exactly this).
export const JUDGE_PROMPT = 'grade the pending benchmark items';
// A cap above this is confirmed before a launch, as the connector's launch
// asks the person first (routes/homeroom-bench.js CONNECTOR_CONFIRM_CAP_USD).
const CONFIRM_CAP_USD = 100;

interface Suite {
  id: number; name: string; version: number; kind: 'frozen' | 'rotating'; notes: string | null;
  frozen_at: string | null; counts: Record<string, number>; total: number; labelled: number; created_by: string | null;
  // What the server would decide on Delete: unfrozen, no runs, not the default.
  runs?: number; is_default?: boolean; deletable?: boolean;
}
interface Task {
  id: number; stage: Stage; issue_number: number | null; app_slug: string | null; tags: Record<string, unknown>;
  reference: Record<string, unknown>; reference_source: string | null; snapshot_source: string | null;
  // A taste task's inputs (#3737).
  taste?: { appName: string; brief: string; template: string | null; sha: string | null; placeholder: boolean };
}
interface TasteCell {
  trials: number; criteria: Record<string, { rate: number; n: number }>; bootedRate: number | null;
  checks: Record<string, number | null>; tells: Record<string, number | null>;
}
// One taste trial, as the console's report lists it (services/bench/report.js tasteTrials).
interface TasteTrial {
  trialId: number; stage: Stage; model: string; attempt: number; status: string;
  appSlug: string; appName: string; booted: boolean | null; shots: { caption: string; artifactId: string }[];
  criteria: { held: number; of: number } | null;
}
interface Model {
  id: string; label: string; role: string | null; stages: string[] | null; contextTokens: number | null;
  inputPerMillion: number | null; outputPerMillion: number | null; inCatalog: boolean;
}
export type BenchModel = Model;
interface Run {
  id: number; suite_id?: number; suite_name: string; suite_version: number; models: string[]; baseline_model: string; stages: string[];
  repeats: number; cap_usd: number; spent_usd: number; status: string; counts: Record<string, number>;
  created_at: string; started_by: string | null; note: string | null;
  concurrency?: number; finished_at?: string | null;
}
interface Row {
  stage: Stage; model: string; baseline: boolean; trials: number; graded: number; pass: number; pending: number;
  unlabelled: number; notApplicable: number; skippedCap: number; accuracy: number | null;
  passK: { k: number; tasks: number; value: number | null }; costUsd: number; costPerTask: number | null; costPerAttempt: number | null;
  costPerSuccess: number | null; p50Ms: number | null; p95Ms: number | null; timeoutRate: number | null; infraRate: number | null;
  taste?: TasteCell;
}
interface Paired { stage: Stage; model: string; baselineModel: string; n: number; apps: number; diff: number | null; low: number | null; high: number | null }
interface Point { key: string; stage: Stage; model: string; cost: number | null; accuracy: number | null; frontier: boolean }
interface Report {
  run: {
    id: number; status: string; capUsd: number; spentUsd: number; baseline: string; suiteName: string; suiteVersion: number; suiteFrozen: boolean;
    repeats: number; stages: Stage[]; models?: string[]; createdAt?: string;
  };
  rows: Row[]; paired: Paired[]; pareto: Point[];
  slice: { key: string; keys: string[]; groups: { stage: Stage; model: string; value: string; n: number; accuracy: number | null }[] };
  agreement: { n: number; agreement: number | null; tpr: number | null; tnr: number | null };
  tasteTrials?: TasteTrial[];
}
interface CoreStatus {
  definition: { key: string; name: string; version: number; expected: Record<string, number>; valid: boolean };
  materialization: {
    status: 'running' | 'done' | 'failed';
    summary: {
      ready?: number; error?: string;
      stages?: Record<string, { ready: number; skipped: number }>;
      skipped?: { ref: string; stage: string | null; app: string | null; reason: string; transient?: boolean }[];
    };
    finishedAt: string | null;
    stale?: boolean;
  } | null;
  suite: { id: number; name: string; version: number; frozen_at: string | null; total: number; labelled: number } | null;
  running: boolean;
  githubEnabled?: boolean;
}
interface LauncherDefaults {
  suiteId: number | null; models: string[]; stages: string[]; repeats: number; repeatStages: string[]; capUsd: number;
}
// What a stage's cost range rests on (services/bench/catalog.js costRange).
type Basis = 'own' | 'stage' | 'comparable' | 'price' | 'fixed' | 'none';
interface StageEstimate {
  trials: number; notApplicable: number; estimateUsd: number; likelyUsd: number;
  lowUsd?: number; highUsd?: number; basis?: Basis | null; from?: string | null;
}
interface Estimate {
  trials: number; notApplicable: number; likelyUsd: number; estimateUsd: number; estimatedMs: number;
  lowUsd?: number; highUsd?: number;
  capUsd: number; maxCapUsd: number; suggestedCapUsd: number; calibratedFrom: number;
  suiteFrozen: boolean; byStage: Record<string, StageEstimate>;
}
interface Review {
  trialId: number;
  item: {
    stage: Stage | 'taste'; task: { request?: string; issueTitle?: string | null; appName?: string; brief?: string };
    candidate: Record<string, unknown>; reference: Record<string, unknown>;
    // A taste item's screenshots, by stored id (#3737).
    shots?: { caption: string; artifactId: string }[];
  };
  opus: { verdict: string; critique: string | null } | null;
  human: { verdict: string; critique: string | null } | null;
}
type Tone = 'ok' | 'err';
type Say = (text: string, tone?: Tone) => void;
type BotStage = 'triage' | 'spec' | 'build' | 'followup';

// The area's tables are the console's densest: the results table is seven
// columns of two-line cells in the 40rem a 1280px screen leaves beside the
// two menus. The recipes' 1.5rem side padding leaves room for five, so these
// tables draw tighter cells (the recipe's colours, less padding).
const DENSE_TH = 'px-2 py-2 text-left align-bottom text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400';
const DENSE_TD = 'px-2 py-3 align-top';
// A table wider than its box scrolls sideways inside it, never the page:
// each is drawn at least 40rem wide, which a 1280px screen holds whole.
const SCROLL = 'w-full overflow-x-auto';

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? 'not yet' : `${Math.round(v * 100)}%`;
}
function usd(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(Number(v)) ? 'not yet' : `$${Number(v).toFixed(digits)}`;
}
/** Dollars as a person says them: cents below ten, whole dollars above. */
function money(v: number): string {
  return `$${v >= 10 ? Math.round(v) : v.toFixed(2)}`;
}
function secs(ms: number | null | undefined): string {
  return ms == null || !Number.isFinite(ms) ? 'not yet' : `${Math.round(ms / 1000)}s`;
}
/** About how long, in the largest unit that reads naturally. */
export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return 'not yet';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 90) return `${min} min`;
  const h = ms / 3_600_000;
  return `${h < 10 ? Math.round(h * 2) / 2 : Math.round(h)} h`;
}
function shortModel(id: string, models: Model[]): string {
  return models.find((m) => m.id === id)?.label || id;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** When, briefly: "today 13:40", else "2 Oct". Pure. */
export function shortWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() === now.toDateString()) {
    return `today ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`}`;
}
/** "a", "a and b", "a, b and c". Pure. */
function andList(items: (string | number)[]): string {
  const s = items.map(String);
  return s.length < 2 ? (s[0] || '') : `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Where the area is (its own addresses) ───────────────────────────────

const BENCH_HASH = '#admin/homeroom-bot/benchmark';
export type BenchRoute =
  | { view: 'overview' }
  | { view: 'runs' }
  | { view: 'run'; id: number }
  | { view: 'suites'; id: number | null }
  | { view: 'studio' };

/** The place an address names; anything it does not name is the Overview. Pure. */
export function benchRouteFromHash(hash: string): BenchRoute {
  if (/^#admin\/homeroom-bot\/benchmark\/studio\/?$/.test(String(hash || ''))) return { view: 'studio' };
  const m = /^#admin\/homeroom-bot\/benchmark\/(runs|suites)(?:\/(\d+))?\/?$/.exec(String(hash || ''));
  if (!m) return { view: 'overview' };
  const id = m[2] ? Number(m[2]) : null;
  if (m[1] === 'runs') return id ? { view: 'run', id } : { view: 'runs' };
  return { view: 'suites', id };
}
/** The address of a place. Pure. */
export function benchHash(route: BenchRoute): string {
  if (route.view === 'runs') return `${BENCH_HASH}/runs`;
  if (route.view === 'run') return `${BENCH_HASH}/runs/${route.id}`;
  if (route.view === 'suites') return route.id ? `${BENCH_HASH}/suites/${route.id}` : `${BENCH_HASH}/suites`;
  if (route.view === 'studio') return `${BENCH_HASH}/studio`;
  return BENCH_HASH;
}
type Go = (route: BenchRoute) => void;

/**
 * A link to a place: a real address, so it can be opened in a new tab or
 * copied, that changes the place in this one without re-routing the console.
 */
function BenchLink({ to, go, className, children, id, current, data }: {
  to: BenchRoute; go: Go; className?: string; children: ReactNode; id?: string; current?: boolean; data?: Record<string, string | number>;
}) {
  const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(to);
  };
  const extra = Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [`data-${k}`, String(v)]));
  return (
    <a href={benchHash(to)} id={id} className={className} aria-current={current ? 'page' : undefined} onClick={onClick} {...extra}>
      {children}
    </a>
  );
}

// ── What a run did ──────────────────────────────────────────────────────

// A run's trials by what happened to them. `ran` is the work that was done;
// skipped and cancelled trials are counted apart, never as progress (#3710:
// a run the cap emptied read "132 of 132 trials").
const RAN = ['ok', 'model_fail', 'infra_fail', 'timeout'];
export function runCounts(r: Pick<Run, 'counts'>): { ran: number; planned: number; running: number; skipped: number; cancelled: number; notApplicable: number } {
  const c = r.counts || {};
  const n = (k: string) => Number(c[k] || 0);
  const all = Object.values(c).reduce((s, v) => s + Number(v || 0), 0);
  const notApplicable = n('not_applicable');
  return {
    ran: RAN.reduce((s, k) => s + n(k), 0),
    planned: all - notApplicable,
    running: n('running'),
    skipped: n('skipped_cap'),
    cancelled: n('cancelled'),
    notApplicable,
  };
}
/** A DM task whose requester never answered: its answer is written for them when it is labelled. */
export function scriptedAnswer(t: Pick<Task, 'stage' | 'tags' | 'reference'>): boolean {
  const script = t.reference?.dm_script as { source?: string } | undefined;
  return t.stage === 'dm' && (script?.source === 'scripted' || t.tags?.answer_source === 'scripted');
}

/** A run's state in plain words, and the badge it wears. Pure. */
export function runState(status: string): { label: string; badge: string } {
  if (status === 'running') return { label: 'Running', badge: AdminUI.badge.secondary };
  if (status === 'queued') return { label: 'Queued', badge: AdminUI.badge.default };
  if (status === 'done') return { label: 'Done', badge: AdminUI.badge.success };
  if (status === 'capped') return { label: 'Stopped at cap', badge: AdminUI.badge.warn };
  if (status === 'cancelled') return { label: 'Cancelled', badge: AdminUI.badge.outline };
  return { label: status, badge: AdminUI.badge.outline };
}

/** What ran of a run, in words: "82 of 132 · 50 skipped at the cap". Pure. */
export function trialWords(r: Pick<Run, 'counts'>): string {
  const c = runCounts(r);
  const faults = Number(r.counts?.infra_fail || 0);
  return [
    `${c.ran} of ${c.planned}`,
    c.running ? `${c.running} running` : null,
    c.skipped ? `${c.skipped} skipped at the cap` : null,
    c.cancelled ? (c.cancelled === c.planned ? 'all cancelled' : `${c.cancelled} cancelled`) : null,
    faults ? plural(faults, 'platform fault') : null,
  ].filter(Boolean).join(' · ');
}

/**
 * The runs a cap stopped with most of their trials unrun: their scores
 * describe part of the suite, and the screen says so. Pure.
 */
export function cappedShort(runs: Run[]): { id: number; share: number; suite: string }[] {
  return runs.filter((r) => r.status === 'capped').map((r) => {
    const c = runCounts(r);
    return { id: r.id, share: c.planned ? c.ran / c.planned : 0, suite: `${r.suite_name} v${r.suite_version}`, short: c.planned > 0 && c.skipped * 2 > c.planned };
  }).filter((x) => x.short).map(({ id, share, suite }) => ({ id, share, suite }));
}
export function cappedWarning(list: { id: number; share: number; suite: string }[]): string {
  if (!list.length) return '';
  const one = list.length === 1;
  const suites = [...new Set(list.map((x) => x.suite))];
  return `${one ? `Run ${list[0].id} stopped at its cap` : `Runs ${andList(list.map((x) => x.id))} stopped at their caps`}`
    + ` after ${andList(list.map((x) => `${Math.round(x.share * 100)}%`))} of ${one ? 'its' : 'their'} trials,`
    + ` so ${one ? 'its' : 'their'} scores cover only part of ${andList(suites)}.`
    + ' Raise the cap or narrow the models before trusting them.';
}

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Bars ────────────────────────────────────────────────────────────────

// Each part's fill. Every bar is read beside its numbers in words, so a
// colour is never the only way to tell the parts apart.
const BAR_FILL = {
  done: 'bg-emerald-600 dark:bg-emerald-500',
  running: 'bg-violet-400 dark:bg-violet-400',
  skipped: 'bg-amber-400 dark:bg-amber-500',
  cancelled: 'bg-zinc-300 dark:bg-zinc-600',
  spend: 'bg-zinc-600 dark:bg-zinc-300',
  spendHigh: 'bg-amber-500 dark:bg-amber-400',
} as const;
const BAR_LEGEND: [keyof typeof BAR_FILL, string][] = [['done', 'Done'], ['running', 'Running'], ['skipped', 'Skipped at the cap'], ['cancelled', 'Cancelled']];

function Bar({ parts, total }: { parts: [keyof typeof BAR_FILL, number][]; total: number }) {
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" aria-hidden="true">
      {total > 0 ? parts.filter(([, v]) => v > 0).map(([tone, v]) => (
        <div key={tone} className={BAR_FILL[tone]} style={{ width: `${Math.min(100, (v / total) * 100)}%` }} />
      )) : null}
    </div>
  );
}
function TrialBar({ run }: { run: Pick<Run, 'counts'> }) {
  const c = runCounts(run);
  return <Bar total={c.planned} parts={[['done', c.ran], ['running', c.running], ['skipped', c.skipped], ['cancelled', c.cancelled]]} />;
}
function SpendBar({ spent, cap }: { spent: number; cap: number }) {
  return <Bar total={Number(cap) || 0} parts={[[Number(spent) >= 0.9 * Number(cap) ? 'spendHigh' : 'spend', Number(spent) || 0]]} />;
}
function BarLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400" aria-hidden="true" id="admin-homeroom-bench-legend">
      {BAR_LEGEND.map(([tone, label]) => (
        <span key={tone} className="inline-flex items-center gap-1.5"><span className={`h-2 w-3 rounded-sm ${BAR_FILL[tone]}`} />{label}</span>
      ))}
    </div>
  );
}

/**
 * Where each point's name goes: beside the point, moved down a line at a
 * time while it would overlap a name already placed, so two models at the
 * same cost and accuracy stay readable (#3710: run 4's labels sat on top of
 * each other). Pure; widths are estimated from the text at 11px.
 */
export function placeLabels(points: { key: string; x: number; y: number; text: string }[], bottom: number): Record<string, number> {
  const placed: { x0: number; x1: number; y: number }[] = [];
  const out: Record<string, number> = {};
  const sorted = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const p of sorted) {
    const x0 = p.x + 9;
    const x1 = x0 + p.text.length * 6.2;
    let y = p.y + 4;
    for (let guard = 0; guard < 20; guard += 1) {
      const hit = placed.some((q) => x0 < q.x1 && q.x0 < x1 && Math.abs(q.y - y) < 12);
      if (!hit) break;
      y += 13;
    }
    y = Math.min(y, bottom);
    placed.push({ x0, x1, y });
    out[p.key] = y;
  }
  return out;
}

/**
 * Cost per attempt against accuracy, one point per model, for one stage. Model
 * identity is the direct label beside each point, not a colour; the Pareto
 * frontier is the filled points and the line through them. A native title
 * on each point is its tooltip; the results table above is its table view.
 */
export function ParetoChart({ points, models }: { points: Point[]; models: Model[] }) {
  const usable = points.filter((p) => p.cost != null && p.accuracy != null) as (Point & { cost: number; accuracy: number })[];
  if (!usable.length) return <p className={AdminUI.muted} id="admin-homeroom-bench-pareto-empty">No graded results at this stage yet.</p>;
  const W = 560; const H = 260; const L = 48; const R = 150; const T = 14; const B = 36;
  const maxCost = Math.max(...usable.map((p) => p.cost)) * 1.1 || 1;
  const x = (c: number) => L + (c / maxCost) * (W - L - R);
  const y = (a: number) => T + (1 - a) * (H - T - B);
  const frontier = usable.filter((p) => p.frontier).sort((a, b) => a.cost - b.cost);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const labelY = placeLabels(usable.map((p) => ({ key: p.key, x: x(p.cost), y: y(p.accuracy), text: shortModel(p.model, models) })), H - B - 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-2xl h-auto text-zinc-500 dark:text-zinc-400" role="img"
      aria-labelledby="admin-homeroom-bench-pareto-title" id="admin-homeroom-bench-pareto">
      <title id="admin-homeroom-bench-pareto-title">Cost per attempt against accuracy; filled points are the Pareto frontier</title>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" strokeOpacity="0.15" strokeWidth="1" />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="currentColor">{`${t * 100}%`}</text>
        </g>
      ))}
      <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="currentColor" strokeOpacity="0.4" strokeWidth="1" />
      {[0, 0.5, 1].map((f) => (
        <text key={f} x={x(maxCost * f)} y={H - B + 16} textAnchor="middle" fontSize="11" fill="currentColor">{`$${(maxCost * f).toFixed(maxCost * f < 1 ? 2 : 1)}`}</text>
      ))}
      <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="currentColor">Cost per attempt</text>
      {frontier.length > 1 ? (
        <polyline points={frontier.map((p) => `${x(p.cost)},${y(p.accuracy)}`).join(' ')}
          fill="none" stroke="#2a78d6" strokeWidth="2" strokeOpacity="0.6" />
      ) : null}
      {usable.map((p) => (
        <g key={p.key} data-pareto-point={p.model} data-frontier={p.frontier ? 'true' : 'false'}>
          <title>{`${shortModel(p.model, models)}: ${pct(p.accuracy)} at ${usd(p.cost, 3)} an attempt${p.frontier ? ', on the frontier' : ''}`}</title>
          <circle cx={x(p.cost)} cy={y(p.accuracy)} r="9" fill="transparent" />
          <circle cx={x(p.cost)} cy={y(p.accuracy)} r="5" strokeWidth="2"
            stroke={p.frontier ? '#2a78d6' : 'currentColor'} fill={p.frontier ? '#2a78d6' : 'none'} />
          <text x={x(p.cost) + 9} y={labelY[p.key]} fontSize="11" className="fill-zinc-700 dark:fill-zinc-300">{shortModel(p.model, models)}</text>
        </g>
      ))}
    </svg>
  );
}

const REPEATED: Stage[] = ['triage', 'dm', 'followup', 'checks_fix'];

/**
 * Core v1, the default suite: whether it is made yet, what was skipped and
 * why, how far labelling has got, and Freeze once every task has its
 * reference. Pure over its props; the area loads the status.
 */
export function CorePanel({ status, canWrite, onMaterialize, onFreeze }: {
  status: CoreStatus | null; canWrite: boolean; onMaterialize: () => void; onFreeze: (suiteId: number) => void;
}) {
  const name = status ? `${status.definition.name} v${status.definition.version}` : 'Core v1';
  const m = status?.materialization || null;
  const suite = status?.suite || null;
  // The server decides: a row left 'running' by a pass that died mid-way
  // (a redeploy) is stale, so it is not running and may be tried again.
  const running = !!status?.running;
  const interrupted = !running && m?.status === 'running';
  const skipped = m?.summary?.skipped || [];
  const stages = m?.summary?.stages || {};
  const allLabelled = !!suite && suite.total > 0 && suite.labelled === suite.total;
  let state: string;
  if (!status) state = 'Loading…';
  else if (running) state = 'Being made now: each request is read as it stood when the bot read it, one at a time.';
  else if (!m) state = status.githubEnabled === false
    ? 'Not made: GitHub is not configured here, so its requests cannot be read.'
    : 'Not made yet. It is made from its checked-in definition a little after the platform starts.';
  else if (interrupted) state = 'The last pass stopped partway (the server restarted while it worked). Try again to finish it.';
  else if (m.status === 'failed') state = `The last attempt failed: ${m.summary?.error || 'unknown error'}.`;
  else state = `${m.summary?.ready ?? suite?.total ?? 0} tasks ready, ${skipped.length} skipped.`;
  return (
    <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-core">
      <div className={AdminUI.cardHeader}>
        <h3 className={AdminUI.cardTitle}>{name}</h3>
        <span className={AdminUI.cardDescription}>The default suite: pick it and run</span>
      </div>
      <p className={AdminUI.muted}>
        Real requests stratified across the bot&apos;s verdicts and apps, four adversarial ones, builds from merged pull
        requests, the bot&apos;s red proposals and DM conversations. The bot&apos;s own verdict is never the reference.
      </p>
      <p className="mt-2 text-sm" id="admin-homeroom-bench-core-state">{state}</p>
      {m?.status === 'done' && Object.keys(stages).length ? (
        <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bench-core-stages">
          {Object.entries(stages).map(([st, c]) => `${STAGE_LABEL[st as Stage] || st} ${c.ready} ready${c.skipped ? `, ${c.skipped} skipped` : ''}`).join(' · ')}
        </p>
      ) : null}
      {skipped.length ? (
        <details className="mt-2" id="admin-homeroom-bench-core-skipped">
          <summary className={`${AdminUI.muted} cursor-pointer`}>{`Why ${skipped.length === 1 ? 'one task was' : `${skipped.length} tasks were`} skipped`}</summary>
          <ul className="mt-1 space-y-1 text-sm">
            {skipped.map((x) => (
              <li key={x.ref} data-core-skipped={x.ref}>{`${x.ref}: ${x.reason}${x.transient ? ' (may work on a retry)' : ''}`}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {suite ? (
        <p className="mt-2 text-sm" id="admin-homeroom-bench-core-labelled">
          {`${suite.labelled} of ${suite.total} labelled.`}
          {suite.frozen_at ? ' Frozen: results on it compare.'
            : allLabelled ? ' Every task has its reference; freeze it to start comparing results.'
              : ' To label the rest, ask an admin\'s Claude session with the Homeroom connector to label the Core v1 tasks (list_bench_grading_queue, kind label).'}
        </p>
      ) : null}
      {canWrite ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {suite && !suite.frozen_at && allLabelled ? (
            <button type="button" className={AdminUI.btn.primarySm} id="admin-homeroom-bench-core-freeze" onClick={() => onFreeze(suite.id)}>{`Freeze ${name}`}</button>
          ) : null}
          {status && status.githubEnabled !== false && !running && !suite?.frozen_at && (!m || m.status === 'failed' || interrupted || skipped.length) ? (
            <button type="button" className={AdminUI.btn.outlineSm} id="admin-homeroom-bench-core-materialize" onClick={onMaterialize}>
              {interrupted ? 'Try again' : m?.status === 'done' ? 'Try the skipped tasks again' : `Materialize ${name} now`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A suite of the taste eval's tasks (#3737). Pure. */
export function isTasteSuite(s: Pick<Suite, 'counts'>): boolean {
  return TASTE_STAGES.some((st) => (s.counts?.[st] || 0) > 0);
}
// The App bench studio's own suite (services/bench/studio.js SUITE_NAME): its
// first versions are read in the Studio place, by brief and arm, and never
// stand in for the taste eval on the Overview.
const STUDIO_SUITE_NAME = 'App bench studio';
export function isStudioSuite(s: Pick<Suite, 'name'>): boolean {
  return s.name === STUDIO_SUITE_NAME;
}

/** A suite's tasks against what it is meant to hold, in words. Pure. */
export function suiteCounts(s: Pick<Suite, 'counts' | 'kind' | 'total'>): string {
  const target = (stage: string, want: number) => `${STAGE_LABEL[stage as Stage] || stage} ${s.counts?.[stage] || 0} of ${want}`;
  if (isTasteSuite(s)) return `First versions ${s.counts?.first_version || 0} · Captures ${s.counts?.capture || 0}`;
  if (s.kind === 'rotating') return `${s.total} of 20`;
  return [target('triage', 40), target('build', 20), `Follow-ups ${(s.counts?.followup || 0) + (s.counts?.checks_fix || 0)} of 5`, target('dm', 5)].join(' · ');
}

// ── Suites: adding a task ───────────────────────────────────────────────

type AddKind = 'sample' | 'import' | 'first_version' | 'capture';
const ADD_KINDS: { key: AddKind; label: string; hint: string }[] = [
  { key: 'sample', label: 'Sample from past runs', hint: 'Requests the bot has already seen' },
  { key: 'import', label: 'Import a merged PR', hint: 'A build task, with the checks it added' },
  { key: 'first_version', label: 'First version from a brief', hint: 'The bot builds it from scratch' },
  { key: 'capture', label: 'Capture an app at a commit', hint: 'Screenshots only: the before side' },
];
type Act = (fn: () => Promise<unknown>, ok: string) => Promise<void>;

// #3737: one more task for the taste eval: a first version built from a
// brief on today's starter, or an app's repository captured at a commit (the
// before arm). A capture left without a brief takes the brief of the suite's
// first-version task on the same app. Opened from Add task with its kind
// picked, it asks for nothing else about the kind.
export function TasteTaskForm({ suiteId, act, kind }: {
  suiteId: number; act: Act; kind?: 'first_version' | 'capture';
}) {
  const [form, setForm] = useState({ kind: kind || 'first_version', appSlug: '', appName: '', brief: '', sha: '' });
  const capture = form.kind === 'capture';
  return (
    <div className="space-y-2" id="admin-homeroom-bench-taste-form">
      {kind ? null : <p className={AdminUI.label}>Taste eval: add a first version from a brief, or an app captured at a commit</p>}
      <div className="flex flex-wrap items-end gap-2">
        {kind ? null : (
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bench-taste-kind">Kind</label>
            <select id="admin-homeroom-bench-taste-kind" className={`${AdminUI.select} mt-1`} value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as 'first_version' | 'capture' })}>
              <option value="first_version">First version from a brief</option>
              <option value="capture">Capture an app at a commit (before)</option>
            </select>
          </div>
        )}
        <div>
          <label className={AdminUI.label} htmlFor="admin-homeroom-bench-taste-app">App</label>
          <input id="admin-homeroom-bench-taste-app" className={`${AdminUI.input} mt-1`} value={form.appSlug} placeholder="app slug"
            onChange={(e) => setForm({ ...form, appSlug: e.target.value })} />
        </div>
        <div>
          <label className={AdminUI.label} htmlFor="admin-homeroom-bench-taste-name">Name</label>
          <input id="admin-homeroom-bench-taste-name" className={`${AdminUI.input} mt-1`} value={form.appName} maxLength={80}
            placeholder={capture ? 'from its first version' : 'Ear Trainer'} onChange={(e) => setForm({ ...form, appName: e.target.value })} />
        </div>
        {capture ? (
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bench-taste-sha">Commit</label>
            <input id="admin-homeroom-bench-taste-sha" className={`${AdminUI.input} mt-1`} value={form.sha} maxLength={40}
              placeholder="40-character sha" onChange={(e) => setForm({ ...form, sha: e.target.value })} />
          </div>
        ) : null}
      </div>
      <label className={AdminUI.label} htmlFor="admin-homeroom-bench-taste-brief">Brief</label>
      <textarea id="admin-homeroom-bench-taste-brief" className={AdminUI.textarea} rows={4} value={form.brief}
        placeholder={capture ? 'Left empty: the brief of this suite\'s first-version task on the same app' : 'What the app\'s creator asked for, word for word'}
        onChange={(e) => setForm({ ...form, brief: e.target.value })} />
      <button type="button" className={AdminUI.btn.outlineSm} disabled={!form.appSlug.trim()} onClick={() => act(async () => {
        await send(`${BASE}/suites/${suiteId}/taste-tasks`, 'POST', {
          kind: form.kind, appSlug: form.appSlug.trim(), appName: form.appName.trim() || undefined,
          brief: form.brief.trim() || undefined, ...(capture ? { sha: form.sha.trim() } : { template: 'empty' }),
        });
        setForm({ ...form, appName: '', brief: '', sha: '' });
      }, capture ? 'Capture task added: a run screenshots the app at that commit, once, with no model.' : 'First-version task added.')}>Add task</button>
    </div>
  );
}

/** Tasks proposed from the bot's recorded runs, balanced; the ticked ones are added. */
function SampleForm({ suiteId, act, say }: { suiteId: number; act: Act; say: Say }) {
  const [sampleStage, setSampleStage] = useState<Stage>('triage');
  const [sampleN, setSampleN] = useState('10');
  const [candidates, setCandidates] = useState<{ id: number; appSlug: string; issueNumber: number; tags: Record<string, string> }[] | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2" id="admin-homeroom-bench-sampler">
        <div>
          <label className={AdminUI.label} htmlFor="admin-homeroom-bench-sample-stage">Propose tasks at</label>
          <select id="admin-homeroom-bench-sample-stage" className={`${AdminUI.select} mt-1`} value={sampleStage}
            onChange={(e) => setSampleStage(e.target.value as Stage)}>
            {SAMPLE_STAGES.map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
          </select>
        </div>
        <div>
          <label className={AdminUI.label} htmlFor="admin-homeroom-bench-sample-n">How many</label>
          <input id="admin-homeroom-bench-sample-n" type="number" min="1" max="100" className={`${AdminUI.input} mt-1 w-24`}
            value={sampleN} onChange={(e) => setSampleN(e.target.value)} />
        </div>
        <button type="button" className={AdminUI.btn.outlineSm} onClick={async () => {
          try {
            const data = await send(`${BASE}/sample?suiteId=${suiteId}&stage=${sampleStage}&n=${Number(sampleN) || 10}`, 'GET');
            setCandidates(data.picked || []);
            setPicked(Object.fromEntries((data.picked || []).map((c: { id: number }) => [c.id, true])));
            say(`${(data.picked || []).length} proposed from ${data.available} runs that can be replayed, balanced across verdicts, apps and repository sizes.`);
          } catch (err: any) { say(err.message, 'err'); }
        }}>Propose</button>
      </div>
      {candidates ? (
        <div className="space-y-1">
          {candidates.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!picked[c.id]} onChange={(e) => setPicked({ ...picked, [c.id]: e.target.checked })} />
              <span>{`${c.appSlug} #${c.issueNumber}`}</span>
              <span className={AdminUI.muted}>{[c.tags.verdict, c.tags.repo_size, c.tags.known_outcome].filter(Boolean).join(' · ')}</span>
            </label>
          ))}
          {candidates.length ? (
            <button type="button" className={AdminUI.btn.primarySm} onClick={() => act(async () => {
              const ids = candidates.filter((c) => picked[c.id]).map((c) => c.id);
              await send(`${BASE}/suites/${suiteId}/tasks`, 'POST', { runIds: ids, stage: sampleStage });
              setCandidates(null);
            }, 'Added to the suite.')}>Add the ticked ones</button>
          ) : <p className={AdminUI.muted}>Nothing to propose: no recorded run at that stage can be replayed yet.</p>}
        </div>
      ) : null}
    </div>
  );
}

/** A build task from a merged pull request: the request as it stood, its base, and the checks it added. */
function ImportForm({ suiteId, act }: { suiteId: number; act: Act }) {
  const [imp, setImp] = useState({ appSlug: '', issueNumber: '', prNumber: '' });
  return (
    <div className="flex flex-wrap items-end gap-2" id="admin-homeroom-bench-import">
      <div>
        <label className={AdminUI.label} htmlFor="admin-homeroom-bench-import-app">App</label>
        <input id="admin-homeroom-bench-import-app" className={`${AdminUI.input} mt-1`} value={imp.appSlug} placeholder="app slug"
          onChange={(e) => setImp({ ...imp, appSlug: e.target.value })} />
      </div>
      <div>
        <label className={AdminUI.label} htmlFor="admin-homeroom-bench-import-issue">Request #</label>
        <input id="admin-homeroom-bench-import-issue" className={`${AdminUI.input} mt-1 w-28`} value={imp.issueNumber}
          onChange={(e) => setImp({ ...imp, issueNumber: e.target.value })} />
      </div>
      <div>
        <label className={AdminUI.label} htmlFor="admin-homeroom-bench-import-pr">PR #</label>
        <input id="admin-homeroom-bench-import-pr" className={`${AdminUI.input} mt-1 w-28`} value={imp.prNumber}
          onChange={(e) => setImp({ ...imp, prNumber: e.target.value })} />
      </div>
      <button type="button" className={AdminUI.btn.outlineSm} onClick={() => act(async () => {
        const data = await send(`${BASE}/suites/${suiteId}/import-pr`, 'POST', {
          appSlug: imp.appSlug.trim(), issueNumber: Number(imp.issueNumber), prNumber: Number(imp.prNumber),
        });
        setImp({ appSlug: imp.appSlug, issueNumber: '', prNumber: '' });
        return data;
      }, 'Imported: the request as it stood when the PR opened, its base commit, and the checks it added as hidden checks.')}>Import</button>
    </div>
  );
}

/**
 * One menu over the four ways to add a task (it replaced three stacked
 * forms). It opens under the row of actions it sits in (that row is its
 * positioned box): across the row on a phone, at its right end above that.
 */
export function AddTaskMenu({ onPick }: { onPick: (kind: AddKind) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={box}>
      <button type="button" className={AdminUI.btn.primarySm} id="admin-homeroom-bench-add-task" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}>Add task</button>
      {open ? (
        <div role="menu" aria-label="Add task" id="admin-homeroom-bench-add-task-menu"
          className={`${AdminUI.card} absolute inset-x-0 top-full sm:left-auto sm:w-72 z-20 mt-2 p-1 shadow-xl ring-1 ring-zinc-200 dark:ring-zinc-700`}>
          {ADD_KINDS.map((k) => (
            <button key={k.key} type="button" role="menuitem" data-bench-add-kind={k.key}
              className="block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
              onClick={() => { setOpen(false); onPick(k.key); }}>
              <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{k.label}</span>
              <span className={`${AdminUI.muted} block`}>{k.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Suites: one suite ───────────────────────────────────────────────────

/** Who a task's reference is by, in words. */
function referenceWords(t: Task): string {
  if (!t.reference_source && scriptedAnswer(t)) return 'Waiting for its label and the answer written for the requester';
  if (!t.reference_source) return 'Waiting for its label';
  const what = String(t.reference?.verdict || t.reference?.action || (t.reference?.reference_pr ? `PR #${t.reference.reference_pr}` : 'set'));
  const by = t.reference_source === 'opus' ? 'the judge' : t.reference_source === 'merged_pr' ? 'a merged PR'
    : t.reference_source === 'authored' ? 'the suite\'s author' : 'a person';
  return `${what} (by ${by})`;
}

/**
 * One suite: what it holds, Freeze / New version / Delete where the server
 * would allow them, Core v1's state for the default suite, Add task, and its
 * tasks: a taste suite's first versions as cards whose brief is edited in
 * place and its captures as rows; any other suite's tasks as a table.
 */
export function SuiteDetail({ suite, isCore, core, canWrite, go, onChanged, say, onMaterialize, onFreezeCore }: {
  suite: Suite; isCore: boolean; core: CoreStatus | null; canWrite: boolean; go: Go;
  onChanged: () => void; say: Say; onMaterialize: () => void; onFreezeCore: (suiteId: number) => void;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [adding, setAdding] = useState<AddKind | null>(null);
  const [editing, setEditing] = useState<{ id: number; appName: string; brief: string; sha: string } | null>(null);
  const label = `${suite.name} v${suite.version}`;
  const open = !suite.frozen_at;

  const loadTasks = useCallback(async () => {
    try {
      const data = await send(`${BASE}/suites/${suite.id}/tasks`, 'GET');
      setTasks(data.tasks || []);
    } catch (err: any) { say(`Could not read the tasks: ${err.message}`, 'err'); }
  }, [suite.id, say]);
  useEffect(() => { loadTasks(); }, [loadTasks]);

  const act: Act = async (fn, ok) => {
    try { await fn(); say(ok); onChanged(); loadTasks(); } catch (err: any) { say(err.message, 'err'); }
  };
  // Delete a suite made by mistake, after the console's own confirm. The
  // server re-checks every rule; its refusal is shown as it gave it.
  const remove = async () => {
    const ok = await (window as any).AdminConsole?._confirm({
      title: `Delete ${label}?`,
      message: `This deletes the suite and its ${suite.total === 1 ? '1 task' : `${suite.total} tasks`}. It cannot be undone.`,
      confirmLabel: 'Delete suite',
      danger: true,
    });
    if (!ok) return;
    try {
      await send(`${BASE}/suites/${suite.id}`, 'DELETE');
      say(`${label} is deleted.`);
      onChanged();
      go({ view: 'suites', id: null });
    } catch (err: any) { say(err.message, 'err'); }
  };
  const newVersion = async () => {
    try {
      const data = await send(`${BASE}/suites/${suite.id}/version`, 'POST', {});
      say(`A new version of ${suite.name}, open for edits.`);
      onChanged();
      if (data?.suite?.id) go({ view: 'suites', id: data.suite.id });
    } catch (err: any) { say(err.message, 'err'); }
  };
  const saveEdit = () => editing && act(async () => {
    await send(`${BASE}/tasks/${editing.id}/taste`, 'PATCH', {
      appName: editing.appName, brief: editing.brief, ...(editing.sha ? { sha: editing.sha } : {}),
    });
    setEditing(null);
  }, 'Saved: the next run uses the new brief; trials already run keep the one they ran on.');
  const removeTask = (t: Task) => act(() => send(`${BASE}/tasks/${t.id}`, 'DELETE'), 'Task removed.');
  const startEdit = (t: Task) => t.taste && setEditing({ id: t.id, appName: t.taste.appName, brief: t.taste.brief, sha: t.taste.sha || '' });
  const editRow = (t: Task) => (
    <div className="space-y-2" data-bench-taste-editing={t.id}>
      <input aria-label="The app's name" className={AdminUI.input} value={editing?.appName || ''} maxLength={80}
        onChange={(e) => editing && setEditing({ ...editing, appName: e.target.value })} />
      <textarea aria-label="The brief" className={AdminUI.textarea} rows={5} value={editing?.brief || ''}
        onChange={(e) => editing && setEditing({ ...editing, brief: e.target.value })} />
      {t.stage === 'capture' ? (
        <input aria-label="Commit" className={AdminUI.input} value={editing?.sha || ''} maxLength={40}
          onChange={(e) => editing && setEditing({ ...editing, sha: e.target.value })} />
      ) : null}
      <span className="inline-flex gap-1">
        <button type="button" className={AdminUI.btn.primarySm} onClick={saveEdit}>Save</button>
        <button type="button" className={AdminUI.btn.outlineSm} onClick={() => setEditing(null)}>Cancel</button>
      </span>
    </div>
  );
  const tasteActions = (t: Task) => (canWrite && open ? (
    <span className="inline-flex gap-2">
      <button type="button" className={`${AdminUI.btn.ghost} text-xs`} data-bench-taste-edit={t.id} onClick={() => startEdit(t)}>Edit</button>
      <button type="button" className={`${AdminUI.btn.ghost} text-xs`} onClick={() => removeTask(t)}>Remove</button>
    </span>
  ) : null);

  const firsts = (tasks || []).filter((t) => t.taste && t.stage === 'first_version');
  const captures = (tasks || []).filter((t) => t.taste && t.stage === 'capture');
  const others = (tasks || []).filter((t) => !t.taste);

  return (
    <div className="space-y-4 min-w-0" id="admin-homeroom-bench-suite" data-bench-suite-detail={suite.id}>
      <section className={`${AdminUI.card} p-4`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className={AdminUI.cardTitle}>{label}</h3>
              {open ? <span className={AdminUI.badge.secondary}>Open for edits</span> : <span className={AdminUI.badge.outline}>Frozen</span>}
            </div>
            <p className={`${AdminUI.muted} mt-1`} data-bench-suite-counts={suite.id}>
              {`${suiteCounts(suite)} · ${suite.labelled} of ${suite.total} labelled${suite.runs ? ` · ${plural(suite.runs, 'run')}` : ''}`}
            </p>
            <p className={`${AdminUI.muted} mt-1`}>
              {isTasteSuite(suite)
                ? 'Each first version is built from its brief on today\'s starter, then screenshotted; each capture screenshots what shipped. Freeze it before runs you want to compare.'
                : open ? 'Tasks drawn from real runs. Freeze it before runs you want to compare: a frozen suite never changes.'
                  : 'Frozen: it never changes, so results on it compare. New version opens a copy for edits.'}
            </p>
            {suite.notes ? <p className="mt-1 text-sm">{suite.notes}</p> : null}
          </div>
          {canWrite ? (
            <div className="relative flex flex-wrap items-center gap-2" id="admin-homeroom-bench-suite-actions">
              {open && !(isCore && suite.labelled < suite.total) ? (
                <button type="button" className={AdminUI.btn.outlineSm} data-bench-suite-freeze={suite.id}
                  onClick={() => act(() => send(`${BASE}/suites/${suite.id}/freeze`, 'POST', {}), `${label} is frozen.`)}>Freeze</button>
              ) : null}
              <button type="button" className={AdminUI.btn.outlineSm} data-bench-suite-version={suite.id} onClick={newVersion}>New version</button>
              {suite.deletable ? (
                <button type="button" className={AdminUI.btn.destructiveSm} data-bench-suite-delete={suite.id} onClick={remove}>Delete</button>
              ) : null}
              {open ? <AddTaskMenu onPick={setAdding} /> : null}
            </div>
          ) : null}
        </div>
        {adding && canWrite && open ? (
          <div className="mt-4 space-y-3" id="admin-homeroom-bench-add-form" data-bench-add-form={adding}>
            <div className={AdminUI.separator} />
            <div className="flex items-center justify-between gap-2">
              <p className={AdminUI.label}>{ADD_KINDS.find((k) => k.key === adding)?.label}</p>
              <button type="button" className={`${AdminUI.btn.ghost} text-xs`} onClick={() => setAdding(null)}>Close</button>
            </div>
            {adding === 'sample' ? <SampleForm key="sample" suiteId={suite.id} act={act} say={say} />
              : adding === 'import' ? <ImportForm key="import" suiteId={suite.id} act={act} />
                : <TasteTaskForm key={adding} suiteId={suite.id} act={act} kind={adding} />}
          </div>
        ) : null}
      </section>

      {isCore ? <CorePanel status={core} canWrite={canWrite} onMaterialize={onMaterialize} onFreeze={onFreezeCore} /> : null}

      <section className={`${AdminUI.card} p-4 space-y-4`} id="admin-homeroom-bench-tasks">
        {tasks == null ? <p className={AdminUI.loading}>Loading…</p> : null}
        {tasks && !tasks.length ? (
          <p className={AdminUI.muted} id="admin-homeroom-bench-tasks-empty">{open ? 'No tasks yet. Add one from Add task.' : 'No tasks.'}</p>
        ) : null}
        {firsts.length ? (
          <div id="admin-homeroom-bench-taste-firsts">
            <h4 className="text-sm font-semibold mb-2">{'First versions '}<span className={AdminUI.badge.default}>{firsts.length}</span></h4>
            <div className="grid gap-3 md:grid-cols-2">
              {firsts.map((t) => (
                <div key={t.id} className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3 min-w-0" data-bench-task={t.id} data-bench-taste-task={t.stage}>
                  {editing?.id === t.id ? editRow(t) : (
                    <>
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{t.taste!.appName}</span>
                        <span className={AdminUI.muted}>{t.app_slug || 'an app no longer here'}</span>
                      </div>
                      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300 break-words">
                        {t.taste!.brief.length > 280 ? `${t.taste!.brief.slice(0, 279)}…` : t.taste!.brief}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        {t.taste!.placeholder
                          ? <span className={AdminUI.badge.warn} data-bench-taste-placeholder={t.id}>placeholder brief: not run</span>
                          : <span className={AdminUI.muted}>Judged against its brief</span>}
                        {tasteActions(t)}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {captures.length ? (
          <div id="admin-homeroom-bench-taste-captures">
            <h4 className="text-sm font-semibold mb-2">{'Captures, the before side '}<span className={AdminUI.badge.default}>{captures.length}</span></h4>
            <div className={SCROLL}>
              <table className={`${AdminUI.table} min-w-[36rem]`}>
                <thead className={AdminUI.thead}>
                  <tr><th className={DENSE_TH}>App</th><th className={DENSE_TH}>Commit</th><th className={DENSE_TH}>Judged against</th><th className={DENSE_TH}><span className="sr-only">Edit</span></th></tr>
                </thead>
                <tbody>
                  {captures.map((t) => (
                    <tr className={AdminUI.trHover} key={t.id} data-bench-task={t.id} data-bench-taste-task={t.stage}>
                      {editing?.id === t.id ? <td className={DENSE_TD} colSpan={4}>{editRow(t)}</td> : (
                        <>
                          <td className={DENSE_TD}>
                            <span className="font-medium">{t.taste!.appName}</span>
                            <span className={`${AdminUI.muted} block`}>{t.app_slug || 'an app no longer here'}</span>
                          </td>
                          <td className={`${DENSE_TD} text-sm`}>{t.taste!.sha ? <code className={AdminUI.kbd}>{t.taste!.sha.slice(0, 7)}</code> : 'no commit yet'}</td>
                          <td className={`${DENSE_TD} text-sm`}>
                            {t.taste!.placeholder
                              ? <span className={AdminUI.badge.warn} data-bench-taste-placeholder={t.id}>placeholder brief: not run</span>
                              : <span className="break-words">{t.taste!.brief.length > 120 ? `${t.taste!.brief.slice(0, 119)}…` : t.taste!.brief}</span>}
                          </td>
                          <td className={`${DENSE_TD} text-right`}>{tasteActions(t)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {others.length ? (
          <div className={SCROLL}>
            <table className={`${AdminUI.table} min-w-[40rem]`} id="admin-homeroom-bench-task-table">
              <thead className={AdminUI.thead}>
                <tr>
                  <th className={DENSE_TH}>Stage</th><th className={DENSE_TH}>Request</th>
                  <th className={DENSE_TH}>Tags</th><th className={DENSE_TH}>Reference</th>
                </tr>
              </thead>
              <tbody>
                {others.map((t) => (
                  <tr className={AdminUI.trHover} key={t.id} data-bench-task={t.id}>
                    <td className={DENSE_TD}>{STAGE_LABEL[t.stage]}</td>
                    <td className={DENSE_TD}>{`${t.app_slug || 'an app no longer here'} #${t.issue_number ?? ''}`}{t.snapshot_source === 'import' ? <span className={`${AdminUI.badge.outline} ml-1`}>from a PR</span> : null}{scriptedAnswer(t) ? <span className={`${AdminUI.badge.outline} ml-1`} data-bench-scripted={t.id}>scripted answer</span> : null}</td>
                    <td className={`${DENSE_TD} text-sm`}>{['verdict', 'repo_size', 'request_type', 'difficulty'].map((k) => t.tags?.[k]).filter(Boolean).join(' · ')}</td>
                    <td className={`${DENSE_TD} text-sm`}>
                      {referenceWords(t)}
                      {canWrite && open ? (
                        <button type="button" className={`${AdminUI.btn.ghost} ml-2 text-xs`} onClick={() => removeTask(t)}>remove</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * The suites, and the one picked (the address's, else the default suite):
 * the list, each suite with its state, and New suite; then the suite. The
 * list sits beside the suite where the console is wide enough, above it
 * where it is not (the console leaves a 1280px screen 40rem). Core v1's card
 * sits under the suite until Core is made, and in Core's own page after.
 */
export function SuitesPage({ suites, selectedId, core, coreSuiteId, canWrite, go, onChanged, say, onMaterialize, onFreezeCore }: {
  suites: Suite[]; selectedId: number | null; core: CoreStatus | null; coreSuiteId: number | null; canWrite: boolean; go: Go;
  onChanged: () => void; say: Say; onMaterialize: () => void; onFreezeCore: (suiteId: number) => void;
}) {
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'frozen' | 'rotating'>('frozen');
  const selected = suites.find((s) => s.id === selectedId) || suites.find((s) => s.id === coreSuiteId) || suites[0] || null;
  const make = async () => {
    try {
      const data = await send(`${BASE}/suites`, 'POST', { name, kind });
      say('Suite made.');
      setName('');
      setMaking(false);
      onChanged();
      if (data?.suite?.id) go({ view: 'suites', id: data.suite.id });
    } catch (err: any) { say(err.message, 'err'); }
  };
  return (
    <div className="grid gap-4 2xl:grid-cols-[18rem_minmax(0,1fr)] items-start" id="admin-homeroom-bench-suites-page">
      <div className="space-y-4 min-w-0">
        <div className={`${AdminUI.card} p-2`} id="admin-homeroom-bench-suites">
          <ul className="grid gap-1 sm:grid-cols-2 2xl:grid-cols-1" id="admin-homeroom-bench-suite-table" aria-label="Suites">
            {suites.map((s) => {
              const on = selected?.id === s.id;
              return (
                <li key={s.id} data-bench-suite={s.id} data-bench-suite-taste={isTasteSuite(s) ? s.id : undefined}>
                  <BenchLink to={{ view: 'suites', id: s.id }} go={go} current={on}
                    className={`block rounded-xl px-3 py-2 transition-colors ${on ? 'bg-violet-50 dark:bg-violet-500/10' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'}`}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{`${s.name} v${s.version}`}</span>
                      {s.frozen_at ? <span className={AdminUI.badge.outline}>Frozen</span> : <span className={AdminUI.badge.secondary}>Open</span>}
                    </span>
                    <span className={`${AdminUI.muted} block`}>
                      {`${plural(s.total, 'task')} · ${isTasteSuite(s) ? 'how first versions look' : s.kind === 'rotating' ? 'a rotating set' : s.id === coreSuiteId ? 'picks the model per stage' : 'core, versioned'}`}
                    </span>
                  </BenchLink>
                </li>
              );
            })}
            {!suites.length ? (
              <li className={`${AdminUI.muted} px-3 py-2`} id="admin-homeroom-bench-suites-empty">No suites yet. Make one, then add tasks to it from Add task.</li>
            ) : null}
          </ul>
          {canWrite ? (making ? (
            <div className="space-y-2 p-2" id="admin-homeroom-bench-suite-form">
              <div>
                <label className={AdminUI.label} htmlFor="admin-homeroom-bench-suite-name">New suite</label>
                <input id="admin-homeroom-bench-suite-name" className={`${AdminUI.input} mt-1`} value={name} maxLength={80}
                  placeholder="core" onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <label className={AdminUI.label} htmlFor="admin-homeroom-bench-suite-kind">Kind</label>
                <select id="admin-homeroom-bench-suite-kind" className={`${AdminUI.select} mt-1`} value={kind}
                  onChange={(e) => setKind(e.target.value as 'frozen' | 'rotating')}>
                  <option value="frozen">Core (versioned)</option>
                  <option value="rotating">Rotating set</option>
                </select>
              </div>
              <span className="inline-flex gap-1">
                <button type="button" className={AdminUI.btn.primarySm} disabled={!name.trim()} onClick={make}>Make suite</button>
                <button type="button" className={AdminUI.btn.outlineSm} onClick={() => setMaking(false)}>Cancel</button>
              </span>
            </div>
          ) : (
            <button type="button" className={`${AdminUI.btn.outlineSm} m-2`} id="admin-homeroom-bench-new-suite" onClick={() => setMaking(true)}>New suite</button>
          )) : null}
        </div>
      </div>
      <div className="space-y-4 min-w-0">
        {selected ? (
          <SuiteDetail key={selected.id} suite={selected} isCore={selected.id === coreSuiteId} core={core} canWrite={canWrite} go={go}
            onChanged={onChanged} say={say} onMaterialize={onMaterialize} onFreezeCore={onFreezeCore} />
        ) : null}
        {!core?.suite ? <CorePanel status={core} canWrite={canWrite} onMaterialize={onMaterialize} onFreeze={onFreezeCore} /> : null}
      </div>
    </div>
  );
}

// ── New run ─────────────────────────────────────────────────────────────

/** The stages a suite has tasks at, in the order the launcher lists them. */
function stagesWithTasks(suite: Suite | undefined): Stage[] {
  return suite ? STAGES.filter((st) => (suite.counts?.[st] || 0) > 0) : [];
}

/** The estimate's cost as a range: low and high where the server sent them, else the single figure and the most. Pure. */
export function estimateRange(e: Pick<Estimate, 'likelyUsd' | 'estimateUsd' | 'lowUsd' | 'highUsd'>): { low: number; high: number } {
  return { low: e.lowUsd ?? e.likelyUsd, high: e.highUsd ?? e.estimateUsd };
}
/** "$4.00 to $10", or one figure when the two meet: "about" it when it is a guess. Pure. */
export function rangeWords(low: number, high: number, guess = false): string {
  if (!(high > 0)) return '$0';
  if (Math.abs(high - low) < 0.005) return `${guess ? 'about ' : ''}${money(low)}`;
  return `${money(low)} to ${money(high)}`;
}
/** Whether any stage of an estimate is priced without trials of its own or of a stage like it. Pure. */
export function estimateGuessed(e: Pick<Estimate, 'byStage'>): boolean {
  return Object.values(e.byStage || {}).some((s) => s.trials > 0 && (s.basis === 'price' || s.basis === 'fixed'));
}
/**
 * What each stage's part of the range rests on, in words: its own trials,
 * the stage it is most like when nothing has run at it, or a guess from the
 * price. Never a confident figure with nothing behind it. Pure.
 */
export function estimateNote(e: Pick<Estimate, 'byStage'>): string {
  const by = Object.entries(e.byStage || {}).filter(([, s]) => s.trials > 0);
  const named = (list: [string, StageEstimate][]) => andList(list.map(([st]) => STAGE_LABEL[st as Stage] || st));
  const on = (b: Basis) => by.filter(([, s]) => s.basis === b);
  const parts: string[] = [];
  if (on('own').length) parts.push(`${named(on('own'))}: from what each model's own trials have cost so far.`);
  if (on('stage').length) parts.push(`${named(on('stage'))}: a model with no trials of its own there is priced from the other models' trials.`);
  const like = on('comparable');
  for (const from of [...new Set(like.map(([, s]) => s.from))]) {
    const these = like.filter(([, s]) => s.from === from);
    parts.push(`${named(these)}: none has run yet, so this range comes from ${STAGE_LABEL[from as Stage] || from} trials.`);
  }
  if (on('price').length) parts.push(`${named(on('price'))}: nothing like it has run yet, so this is a guess from each model's price.`);
  if (on('fixed').length) parts.push(`${named(on('fixed'))}: nothing like it has run and no price is known, so this is a fixed guess per trial.`);
  if (on('none').length) parts.push(`${named(on('none'))}: runs no model, so it costs nothing.`);
  return parts.join(' ');
}

type LaunchPreset = { suiteId?: number | null; stages?: Stage[] };
const LEGEND = 'text-sm font-semibold text-zinc-900 dark:text-zinc-100';

/**
 * The launcher, in four steps beside what the run would do. It opens on every
 * candidate model and every stage the suite has tasks at, triage three times
 * (pass^k is read from those), and as many trials at once as the lane allows
 * (or on what it was opened for: "Run more" on a stage). Each change asks the
 * server what the launch would be (POST runs/estimate), so the trials, the
 * cost as a range with what it rests on, about how long it takes and the cap
 * are on screen before anything is spent. The cap follows the server's
 * suggestion (services/bench/lane.js suggestCap) until it is set by hand; a
 * cap below the range says the run will stop early. A cap over $100 is
 * confirmed before the launch.
 */
export function Launcher({ suites, models, defaults, launcher, hiddenChecks, preset, onLaunched, say }: {
  suites: Suite[]; models: Model[]; defaults: { capUsd: number; repeats: number; maxConcurrency: number };
  launcher: LauncherDefaults | null; hiddenChecks: string; preset?: LaunchPreset;
  onLaunched: (runId?: number) => void; say: Say;
}) {
  const [suiteId, setSuiteId] = useState(preset?.suiteId ? String(preset.suiteId) : launcher?.suiteId ? String(launcher.suiteId) : '');
  const [chosen, setChosen] = useState<Record<string, boolean>>(() => Object.fromEntries((launcher?.models || []).map((id) => [id, true])));
  const [extra, setExtra] = useState('');
  // null: every stage the picked suite has tasks at. An object once ticked by hand.
  const [stagesPicked, setStagesPicked] = useState<Record<string, boolean> | null>(
    () => (preset?.stages?.length ? Object.fromEntries(preset.stages.map((st) => [st, true])) : null),
  );
  const [repeats, setRepeats] = useState(String(launcher?.repeats ?? defaults.repeats));
  const [repeatAll, setRepeatAll] = useState(false);
  const [cap, setCap] = useState(String(launcher?.capUsd ?? defaults.capUsd));
  const [capByHand, setCapByHand] = useState(false);
  const [concurrency, setConcurrency] = useState(String(defaults.maxConcurrency));
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimateError, setEstimateError] = useState('');
  const [launching, setLaunching] = useState(false);
  useEffect(() => {
    if (!suiteId && suites.length) setSuiteId(String((suites.find((s) => s.frozen_at) || suites[0]).id));
  }, [suites, suiteId]);
  const suite = suites.find((s) => String(s.id) === suiteId);
  const allStages = stagesWithTasks(suite);
  const stages = stagesPicked ? STAGES.filter((st) => stagesPicked[st] && allStages.includes(st)) : allStages;
  const modelIds = [...Object.keys(chosen).filter((k) => chosen[k]), ...extra.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)];
  const everything = !stagesPicked && !extra.trim() && (launcher?.models || []).every((id) => chosen[id]);
  const body = {
    suiteId: Number(suiteId), models: modelIds, stages,
    repeats: Number(repeats), capUsd: Number(cap), concurrency: Number(concurrency),
    // A first version is built `repeats` times too (#3737): the taste eval
    // reads each brief's spread, not one build.
    repeatStages: [...(repeatAll ? REPEATED : (launcher?.repeatStages || ['triage'])), ...(stages.includes('first_version') ? ['first_version'] : [])],
  };
  const bodyKey = JSON.stringify({ ...body, capUsd: 0 });

  // Ask for the estimate a moment after the settings settle, not on every keystroke.
  useEffect(() => {
    if (!suiteId || !modelIds.length || !stages.length) { setEstimate(null); return undefined; }
    let alive = true;
    const handle = window.setTimeout(async () => {
      try {
        const data = await send(`${BASE}/runs/estimate`, 'POST', body);
        if (!alive) return;
        setEstimate(data);
        setEstimateError('');
        if (!capByHand) setCap(String(data.suggestedCapUsd));
      } catch (err: any) {
        if (alive) { setEstimate(null); setEstimateError(err.message); }
      }
    }, 400);
    return () => { alive = false; window.clearTimeout(handle); };
  }, [bodyKey, capByHand]);

  const capUsd = Number(cap);
  const range = estimate ? estimateRange(estimate) : null;
  const guessed = !!estimate && estimateGuessed(estimate);
  const borrowed = !!estimate && Object.values(estimate.byStage || {}).some((s) => s.trials > 0 && s.basis === 'comparable');
  const short = range && Number.isFinite(capUsd) && capUsd < range.low;
  const tight = range && !short && Number.isFinite(capUsd) && capUsd < range.high;
  const launch = async () => {
    if (capUsd > CONFIRM_CAP_USD) {
      const ok = await (window as any).AdminConsole?._confirm?.({
        title: `Launch with a $${capUsd.toFixed(2)} cap?`,
        message: `This run can spend up to $${capUsd.toFixed(2)} of the platform's money before it stops${range ? `; its cost is estimated at ${rangeWords(range.low, range.high, guessed)}` : ''}.`,
        confirmLabel: `Launch, up to $${capUsd.toFixed(2)}`,
      });
      if (!ok) return;
    }
    setLaunching(true);
    try {
      const data = await send(`${BASE}/runs`, 'POST', body);
      say(`Run ${data.run.id} launched: ${data.trials} trials (${data.notApplicable} not applicable) against a $${Number(data.run.cap_usd).toFixed(2)} cap.${data.suiteFrozen ? '' : ' The suite is not frozen, so these results describe a set that can still change.'}`);
      onLaunched(data.run.id);
    } catch (err: any) { say(`Not launched: ${err.message}`, 'err'); }
    finally { setLaunching(false); }
  };
  const tick = (st: Stage, on: boolean) => setStagesPicked({ ...Object.fromEntries(stages.map((s) => [s, true])), [st]: on });
  const stageWords = stages.map((st) => ((st === 'triage' || st === 'first_version') && Number(repeats) > 1 ? `${STAGE_LABEL[st]} ×${repeats}` : STAGE_LABEL[st])).join(' · ');
  const tile = (label: string, value: string, id: string, sub: string, wide = false) => (
    <div key={id} className={`rounded-xl bg-white dark:bg-zinc-900 p-3 min-w-0${wide ? ' col-span-2' : ''}`} id={id}>
      <div className={AdminUI.muted}>{label}</div>
      <div className="text-lg font-semibold mt-0.5 tabular-nums break-words">{value}</div>
      {sub ? <div className={AdminUI.muted}>{sub}</div> : null}
    </div>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]" id="admin-homeroom-bench-launch">
      <div className="space-y-6 min-w-0">
        <fieldset id="admin-homeroom-bench-launch-suite">
          <legend className={LEGEND}>1. Suite</legend>
          <div className="grid gap-2 sm:grid-cols-2 mt-2">
            {suites.map((s) => {
              const on = String(s.id) === suiteId;
              return (
                <label key={s.id} data-bench-launch-suite={s.id}
                  className={`flex items-start gap-2 rounded-xl p-3 cursor-pointer ${on ? 'bg-violet-50 ring-2 ring-violet-500 dark:bg-violet-500/10' : 'bg-zinc-50 dark:bg-zinc-800/60'}`}>
                  <input type="radio" className="mt-1" name="admin-homeroom-bench-launch-suite" value={s.id} checked={on}
                    onChange={() => { setSuiteId(String(s.id)); setStagesPicked(null); }} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{`${s.name} v${s.version}${s.frozen_at ? '' : ' (not frozen)'}`}</span>
                    <span className={`${AdminUI.muted} block`}>{suiteCounts(s)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset id="admin-homeroom-bench-launch-stages">
          <legend className={LEGEND}>2. Stages</legend>
          <div className="flex flex-wrap gap-2 mt-2">
            {allStages.map((st) => (
              <label key={st} className="inline-flex items-center gap-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-3 py-2 text-sm">
                <input type="checkbox" checked={stages.includes(st)} onChange={(e) => tick(st, e.target.checked)} />
                <span>{STAGE_LABEL[st]}</span>
                <span className={AdminUI.muted}>{suite?.counts?.[st] || 0}</span>
              </label>
            ))}
            {suite && !allStages.length ? <p className={AdminUI.muted}>This suite has no tasks yet.</p> : null}
          </div>
        </fieldset>

        <fieldset>
          <legend className={LEGEND}>3. Models</legend>
          <div className="mt-2 space-y-2" id="admin-homeroom-bench-models">
            {models.map((m) => (
              <label key={m.id} className="flex items-start gap-2 text-sm" data-bench-model={m.id}>
                <input type="checkbox" className="mt-1" checked={!!chosen[m.id]} onChange={(e) => setChosen({ ...chosen, [m.id]: e.target.checked })} />
                <span className="min-w-0">
                  <span className="font-medium">{m.label}</span>
                  {m.role ? <span className={`${AdminUI.badge.outline} ml-1`}>{m.role}</span> : null}
                  <span className={`${AdminUI.muted} block break-words`}>
                    {[
                      m.id,
                      m.contextTokens ? `${Math.round(m.contextTokens / 1000)}K context` : 'context unknown',
                      m.inputPerMillion != null && m.outputPerMillion != null ? `$${m.inputPerMillion.toFixed(2)} in, $${m.outputPerMillion.toFixed(2)} out per million` : 'price unknown until a trial runs',
                      m.stages ? `${m.stages.join(' and ')} only` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className={LEGEND}>4. Limits</legend>
          <div className="grid grid-cols-3 gap-2 mt-2">
            <div>
              <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-repeats">{stages.includes('first_version') ? 'Repeats' : 'Triage repeats'}</label>
              <input id="admin-homeroom-bench-launch-repeats" type="number" min="1" max="5" className={`${AdminUI.input} mt-1`}
                value={repeats} onChange={(e) => setRepeats(e.target.value)} />
            </div>
            <div>
              <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-concurrency">At once</label>
              <select id="admin-homeroom-bench-launch-concurrency" className={`${AdminUI.select} mt-1`} value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}>
                {Array.from({ length: defaults.maxConcurrency }, (_, i) => String(i + 1)).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-cap">Cap, dollars</label>
              <input id="admin-homeroom-bench-launch-cap" type="number" min="0.5" max="1000" step="1" className={`${AdminUI.input} mt-1`}
                value={cap} onChange={(e) => { setCap(e.target.value); setCapByHand(true); }} />
            </div>
          </div>
          {capByHand ? (
            <button type="button" className={`${AdminUI.btn.ghost} text-xs mt-1`} id="admin-homeroom-bench-launch-cap-auto"
              onClick={() => setCapByHand(false)}>Set the cap from the estimate again</button>
          ) : null}
          <p className={`${AdminUI.muted} mt-2`}>
            Repeats apply to triage (pass^k is read from them) and first versions; everything else runs once per model, and a capture once a run.
          </p>
          <details className="mt-3" id="admin-homeroom-bench-launch-settings">
            <summary className={`${AdminUI.btn.link} text-sm cursor-pointer`}>More settings</summary>
            <div className="space-y-3 mt-2">
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" id="admin-homeroom-bench-launch-repeat-all" checked={repeatAll} onChange={(e) => setRepeatAll(e.target.checked)} />
                <span>Repeat DM and follow-ups too</span>
              </label>
              <div>
                <label className={`${AdminUI.label} block`} htmlFor="admin-homeroom-bench-launch-extra">Other OpenRouter models</label>
                <input id="admin-homeroom-bench-launch-extra" className={`${AdminUI.input} mt-1`} value={extra} placeholder="vendor/model, vendor/model"
                  onChange={(e) => setExtra(e.target.value)} />
              </div>
              <p className={AdminUI.muted}>The bench waits while the bot&apos;s live builds use every build slot.</p>
              <p className={AdminUI.muted} id="admin-homeroom-bench-hidden-checks">{`Build trials: ${hiddenChecks}.`}</p>
            </div>
          </details>
        </fieldset>
      </div>

      <aside className="lg:sticky lg:top-4 self-start space-y-3 rounded-2xl bg-zinc-50 dark:bg-zinc-800/60 p-4" aria-label="What this run will do">
        <h3 className="text-sm font-semibold">This run</h3>
        <p className="text-sm" id="admin-homeroom-bench-launch-summary">
          {suite ? `${suite.name} v${suite.version}${suite.frozen_at ? '' : ' (not frozen)'}` : 'No suite yet'}
          {` · ${modelIds.length} model${modelIds.length === 1 ? '' : 's'} · ${stageWords || 'no stage picked'}`}
        </p>
        <div className="grid grid-cols-2 gap-2" id="admin-homeroom-bench-estimate">
          {[
            tile('Likely cost', range ? rangeWords(range.low, range.high, guessed) : '…', 'admin-homeroom-bench-estimate-cost',
              estimate ? (guessed ? 'partly a guess: see below' : borrowed ? 'partly from a stage like it: see below' : 'from past trials') : '', true),
            tile('Trials', estimate ? estimate.trials.toLocaleString() : '…', 'admin-homeroom-bench-estimate-trials',
              estimate && estimate.notApplicable ? `${estimate.notApplicable} not applicable` : ''),
            tile('About how long', estimate ? duration(estimate.estimatedMs) : '…', 'admin-homeroom-bench-estimate-time', estimate ? 'at the least' : ''),
            tile('Stops at', Number.isFinite(capUsd) ? `$${capUsd.toFixed(2)}` : '…', 'admin-homeroom-bench-estimate-cap', capByHand ? 'the cap, set by hand' : 'the cap, suggested', true),
          ]}
        </div>
        <p className={AdminUI.muted} id="admin-homeroom-bench-estimate-note">
          {estimateError
            ? `No estimate: ${estimateError}`
            : estimate
              ? `${estimateNote(estimate) || 'From what each model\'s trials have cost so far.'} Time is a floor: live builds a person is waiting for go first.`
              : 'Working out the estimate…'}
        </p>
        {short ? (
          <p className="text-sm text-amber-800 dark:text-amber-300" id="admin-homeroom-bench-cap-warning">
            {`The cap is below even the low end of the range. The run stops when the next trial would cross $${capUsd.toFixed(2)}, and every trial left is skipped, so later tasks may not run on any model.`}
          </p>
        ) : tight ? (
          <p className="text-sm text-amber-800 dark:text-amber-300" id="admin-homeroom-bench-cap-note">
            {`The cap is below the top of the range (${money(range!.high)}): if trials cost what the dearest have, the run stops at the cap and the rest are skipped.`}
          </p>
        ) : null}
        <button type="button" className={`${AdminUI.btn.primary} w-full`} id="admin-homeroom-bench-launch-go"
          disabled={!suiteId || !modelIds.length || !stages.length || launching || !Number.isFinite(capUsd)} onClick={launch}>
          {`${everything ? 'Run everything' : 'Launch'}${Number.isFinite(capUsd) ? `, up to $${capUsd.toFixed(2)}` : ''}`}
        </button>
        <p className={AdminUI.muted}>Same prompts, worker and clocks as the bot. It spends platform money up to the cap; nothing is posted, messaged or proposed.</p>
      </aside>
    </div>
  );
}

/** The sheet the launcher opens in, over whichever place it was opened from. */
function NewRunSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={AdminUI.dialogOverlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="admin-homeroom-bench-new-run-title"
        id="admin-homeroom-bench-new-run-sheet" className={`${AdminUI.card} w-full max-w-5xl max-h-full overflow-y-auto p-4 sm:p-6 shadow-xl outline-none`}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className={AdminUI.sectionTitle} id="admin-homeroom-bench-new-run-title">New run</h2>
          <button type="button" className={`${AdminUI.btn.ghost} text-xl leading-none px-1`} aria-label="Close" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Which model each stage should use ──────────────────────────────────

interface Cell {
  stage: Stage; model: string; runId: number; accuracy: number | null; graded: number; pass: number; pending: number;
  costPerSuccess: number | null; costPerAttempt: number | null;
}
export interface Best {
  stages: Stage[];
  models: string[];
  cells: Record<string, Cell>;
  // The cell each stage would pick, `stage|model`, or absent when no cell has enough graded tasks.
  best: Partial<Record<Stage, string>>;
  // Graded tasks a cell needs before it is compared, per stage.
  enough: Partial<Record<Stage, number>>;
}

// A cell with fewer graded tasks than this is shown, not compared: ten, or
// most of the stage's tasks when the suite has fewer than that (Core v1 has
// five DM tasks and two checks fixes).
function enoughFor(stage: Stage, counts: Record<string, number> | undefined): number {
  const tasks = Number(counts?.[stage] || 0);
  return tasks ? Math.max(1, Math.min(10, Math.ceil(tasks * 0.8))) : 10;
}

/**
 * The latest graded result for each stage and model, merged across the
 * reports of one suite's runs, newest first; and per stage, the best value:
 * the cheapest per success among the models within five points of the most
 * accurate, counting only cells with enough graded tasks. Pure.
 */
export function mergeBest(reports: { runId: number; report: Pick<Report, 'rows'> }[], counts?: Record<string, number>, baseline?: string): Best {
  const cells: Record<string, Cell> = {};
  const stageSet = new Set<Stage>();
  const modelSet = new Set<string>();
  for (const { runId, report } of reports) {
    for (const r of report.rows || []) {
      const key = `${r.stage}|${r.model}`;
      if (cells[key] || (!r.graded && !r.pending)) continue;
      cells[key] = {
        stage: r.stage, model: r.model, runId, accuracy: r.accuracy, graded: r.graded, pass: r.pass, pending: r.pending,
        costPerSuccess: r.costPerSuccess, costPerAttempt: r.costPerAttempt,
      };
      stageSet.add(r.stage);
      modelSet.add(r.model);
    }
  }
  const stages = STAGES.filter((st) => stageSet.has(st));
  const models = [...modelSet].sort((a, b) => (a === baseline ? -1 : b === baseline ? 1 : a.localeCompare(b)));
  const best: Partial<Record<Stage, string>> = {};
  const enough: Partial<Record<Stage, number>> = {};
  for (const st of stages) {
    enough[st] = enoughFor(st, counts);
    const ok = models.map((m) => cells[`${st}|${m}`]).filter((c) => c && c.graded >= (enough[st] as number) && c.accuracy != null) as Cell[];
    if (!ok.length) continue;
    const top = Math.max(...ok.map((c) => c.accuracy as number));
    const near = ok.filter((c) => (c.accuracy as number) >= top - 0.05);
    near.sort((a, b) => (a.costPerSuccess ?? Infinity) - (b.costPerSuccess ?? Infinity) || (b.accuracy as number) - (a.accuracy as number));
    best[st] = `${st}|${near[0].model}`;
  }
  return { stages, models, cells, best, enough };
}

/**
 * Every model, stage by stage: its models ranked by accuracy, each with how
 * many graded tasks it rests on and what a success cost; one with too few
 * graded tasks is drawn faint and says so; the best value is outlined and
 * named in the stage's heading. Blocks of cells rather than a table, so
 * eight models fit a phone without a sideways scroll. "Use for <stage>"
 * hands the model to the bot's Settings form, which still needs its Save
 * (#3710). The Overview's table answers first; this is the detail under it.
 */
export function BestModels({ best, models, canUse, onUseModel }: {
  best: Best | null; models: Model[]; suiteName?: string;
  canUse: boolean; onUseModel?: (stage: BotStage, model: string) => void;
}) {
  const name = (id: string) => shortModel(id, models);
  if (best == null) return <p className={AdminUI.loading}>Loading…</p>;
  if (!best.stages.length) {
    return <p className={AdminUI.muted} id="admin-homeroom-bench-best-empty">Nothing graded on this suite yet. Run the benchmark, then ask an admin&apos;s Claude session to grade it.</p>;
  }
  return (
    <div className="space-y-5" id="admin-homeroom-bench-best-list">
      {best.stages.map((st) => {
        const botStage = BOT_STAGE_FOR[st];
        const pick = best.best[st];
        const enough = best.enough[st] as number;
        const cells = best.models.map((m) => best.cells[`${st}|${m}`]).filter(Boolean) as Cell[];
        const rank = (c: Cell) => (c.graded >= enough ? 0 : 1);
        cells.sort((a, b) => rank(a) - rank(b) || (b.accuracy ?? -1) - (a.accuracy ?? -1));
        const top = pick ? best.cells[pick] : null;
        return (
          <section key={st} data-bench-best-row={st}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h4 className="text-sm font-semibold">{STAGE_LABEL[st]}</h4>
              <span className={AdminUI.muted}>
                {top
                  ? `Best value: ${name(top.model)}, ${pct(top.accuracy)} at ${usd(top.costPerSuccess, 3)} a success`
                  : `Not enough graded yet: a model is compared from ${enough} graded tasks`}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mt-2">
              {cells.map((c) => {
                const thin = c.graded < enough;
                const isBest = pick === `${st}|${c.model}`;
                return (
                  <div key={c.model} data-bench-best-cell={`${st}|${c.model}`} data-best={isBest ? 'true' : 'false'} data-thin={thin ? 'true' : 'false'}
                    className={`rounded-xl p-3 bg-zinc-50 dark:bg-zinc-800/60 ${isBest ? 'ring-2 ring-violet-500' : ''} ${thin ? 'opacity-60' : ''}`}>
                    <div className="text-sm font-medium break-words">{name(c.model)}</div>
                    <div className="text-lg font-semibold tabular-nums">{c.graded ? pct(c.accuracy) : 'not graded'}</div>
                    <div className={`${AdminUI.muted} tabular-nums`}>
                      {[
                        c.graded ? `${c.graded} graded` : null,
                        c.costPerSuccess != null ? `${usd(c.costPerSuccess, 3)} a success` : null,
                        c.pending ? `${c.pending} for the judge` : null,
                      ].filter(Boolean).join(' · ')}
                    </div>
                    {thin && c.graded ? <div className={AdminUI.muted}>too few to compare</div> : null}
                    {isBest ? <span className={`${AdminUI.badge.secondary} mt-1`}>best value</span> : null}
                    {canUse && onUseModel && botStage && !thin && c.graded ? (
                      <button type="button" className={`${AdminUI.btn.link} text-xs block mt-1`} data-bench-use={`${st}|${c.model}`}
                        onClick={() => onUseModel(botStage, c.model)}>
                        {`Use for ${STAGE_LABEL[botStage]}`}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** The model a stage runs on now: its bot setting, or the platform default for DM. Pure. */
export function inUseFor(stage: Stage, inUse: Partial<Record<BotStage, string | null>> | null, defaultModel: string | null): string | null {
  if (!inUse) return null;
  const bot = BOT_STAGE_FOR[stage];
  if (bot) return inUse[bot] || defaultModel || null;
  return stage === 'dm' ? defaultModel : null;
}

/**
 * The answer, one row per stage of the default suite: the model in use, the
 * one recommended (or "Too few to call" below the graded threshold), why in
 * one line, how many graded tasks it rests on, and "Use for <stage>", which
 * fills in the bot's Settings and changes nothing until Save there. A stage
 * with too few graded offers "Run more" instead. Every model's cells are
 * under it, folded.
 */
export function StageTable({ best, models, suiteLabel, inUse, defaultModel, capNotes, canUse, onUseModel, onRunMore }: {
  best: Best | null; models: Model[]; suiteLabel: string;
  inUse: Partial<Record<BotStage, string | null>> | null; defaultModel: string | null;
  capNotes?: Partial<Record<Stage, string>>;
  canUse: boolean; onUseModel?: (stage: BotStage, model: string) => void; onRunMore?: (stage: Stage) => void;
}) {
  const name = (id: string) => shortModel(id, models);
  const showInUse = !!inUse;
  const answer = (c: Cell) => `${pct(c.accuracy)} right${c.costPerSuccess != null ? ` at ${usd(c.costPerSuccess, 3)} a success` : ''}`;
  return (
    <section className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-best" aria-labelledby="admin-homeroom-bench-best-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h3 className={AdminUI.cardTitle} id="admin-homeroom-bench-best-title">Which model each stage should use</h3>
          <p className={AdminUI.cardDescription}>{suiteLabel ? `${suiteLabel}: the latest graded result for each stage, across runs` : 'The latest graded result for each stage, across runs'}</p>
        </div>
      </div>
      {best == null ? <p className={AdminUI.loading}>Loading…</p> : !best.stages.length ? (
        <p className={AdminUI.muted} id="admin-homeroom-bench-best-empty">Nothing graded on this suite yet. Run the benchmark, then ask an admin&apos;s Claude session to grade it.</p>
      ) : (
        <>
          <div className={SCROLL}>
            <table className={`${AdminUI.table} min-w-[40rem]`} id="admin-homeroom-bench-best-table">
              <thead className={AdminUI.thead}>
                <tr>
                  <th className={DENSE_TH} scope="col">Stage</th>
                  {showInUse ? <th className={DENSE_TH} scope="col">In use now</th> : null}
                  <th className={DENSE_TH} scope="col">Recommended</th>
                  <th className={DENSE_TH} scope="col">Why</th>
                  <th className={`${DENSE_TH} text-right`} scope="col">Graded</th>
                  <th className={DENSE_TH} scope="col"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {best.stages.map((st) => {
                  const enough = best.enough[st] as number;
                  const cells = best.models.map((m) => best.cells[`${st}|${m}`]).filter(Boolean) as Cell[];
                  const pick = best.best[st] ? best.cells[best.best[st] as string] : null;
                  const now = inUseFor(st, inUse, defaultModel);
                  const nowCell = now ? best.cells[`${st}|${now}`] : null;
                  const botStage = BOT_STAGE_FOR[st];
                  const graded = Math.max(0, ...cells.map((c) => c.graded));
                  const pending = cells.reduce((s, c) => s + (c.pending || 0), 0);
                  // Beside the pick: the model in use, else the next most accurate that was compared.
                  const other = pick && nowCell && now !== pick.model && nowCell.graded
                    ? nowCell
                    : pick ? cells.filter((c) => c !== pick && c.graded >= enough && c.accuracy != null).sort((a, b) => (b.accuracy as number) - (a.accuracy as number))[0] : null;
                  let why = '';
                  if (pick) why = `${answer(pick)}${other ? `; ${name(other.model)} ${pct(other.accuracy)}${other.costPerSuccess != null ? ` at ${usd(other.costPerSuccess, 3)}` : ', no success yet'}` : ''}`;
                  else if (graded) why = `${graded} graded per model at most; a call needs ${enough}.${capNotes?.[st] ? ` ${capNotes[st]}` : ''}`;
                  else why = pending ? `${pending} wait for the judge.` : '';
                  return (
                    <tr className={AdminUI.trHover} key={st} data-bench-stage-row={st} data-bench-best-pick={pick ? pick.model : ''}>
                      <th className={`${DENSE_TD} text-left font-semibold`} scope="row">{STAGE_LABEL[st]}</th>
                      {showInUse ? <td className={`${DENSE_TD} text-sm min-w-[6rem]`} data-bench-in-use={st}>{now ? name(now) : '–'}</td> : null}
                      <td className={`${DENSE_TD} text-sm min-w-[6.5rem]`}>
                        {pick ? (
                          <>
                            <span className="font-semibold block">{name(pick.model)}</span>
                            {pick.model === now ? <span className={`${AdminUI.badge.success} mt-1`}>Keep: in use now</span> : null}
                          </>
                        )
                          : graded ? <span className={`${AdminUI.badge.warn} whitespace-nowrap`}>Too few to call</span>
                            : <span className={AdminUI.muted}>No graded trials yet</span>}
                      </td>
                      <td className={`${DENSE_TD} text-sm text-zinc-600 dark:text-zinc-300 tabular-nums`}>{why}</td>
                      <td className={`${DENSE_TD} text-right tabular-nums`}>{pick ? pick.graded : graded}</td>
                      <td className={`${DENSE_TD} text-right whitespace-nowrap`}>
                        {pick && canUse && onUseModel && botStage && pick.model !== now ? (
                          <button type="button" className={AdminUI.btn.outlineSm} data-bench-use={`${st}|${pick.model}`}
                            onClick={() => onUseModel(botStage, pick.model)}>{`Use for ${STAGE_LABEL[botStage]}`}</button>
                        ) : !pick && canUse && onRunMore ? (
                          <button type="button" className={AdminUI.btn.outlineSm} data-bench-run-more={st} onClick={() => onRunMore(st)}>Run more</button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details className="mt-3" id="admin-homeroom-bench-best-all">
            <summary className={`${AdminUI.btn.link} text-sm cursor-pointer`}>Every model, stage by stage</summary>
            <div className="mt-3">
              <BestModels best={best} models={models} canUse={canUse} onUseModel={onUseModel} />
            </div>
          </details>
        </>
      )}
    </section>
  );
}

/**
 * The judge against people, in words that hold when a rate has no trials
 * behind it yet (#3710: "of those a person failed, it failed not yet").
 */
export function judgeLine(a: Report['agreement']): string {
  const parts = [`Agrees with people on ${pct(a.agreement)} of the ${a.n} trial${a.n === 1 ? '' : 's'} a person also graded.`];
  parts.push(a.tpr == null ? 'A person has passed none of them yet.' : `Of those a person passed, it passed ${pct(a.tpr)}.`);
  parts.push(a.tnr == null ? 'A person has failed none of them yet.' : `Of those a person failed, it failed ${pct(a.tnr)}.`);
  return parts.join(' ');
}

// #3737: a taste trial's screenshots in the spot check, as the judge saw
// them: captioned with their screen size, look and state, nothing else.
export function TasteShots({ shots }: { shots: { caption: string; artifactId: string }[] }) {
  return (
    <div className="mt-2 flex gap-2 overflow-x-auto" data-bench-taste-shots>
      {shots.map((sh) => (
        <figure key={sh.artifactId} className="shrink-0 w-32">
          <a href={`${BASE}/artifacts/${sh.artifactId}`} target="_blank" rel="noopener noreferrer">
            <img src={`${BASE}/artifacts/${sh.artifactId}`} alt={sh.caption} loading="lazy"
              className="w-32 h-auto rounded-md ring-1 ring-zinc-200 dark:ring-zinc-700" />
          </a>
          <figcaption className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{sh.caption}</figcaption>
        </figure>
      ))}
    </div>
  );
}

const pctOrDash = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const numOrDash = (v: number | null | undefined) => (v == null ? '–' : String(Math.round(v * 10) / 10));

/** A taste arm's name: the capture is what shipped; a first version is its model's. */
function armName(r: Pick<Row, 'stage' | 'model'>, name: (id: string) => string): string {
  return r.stage === 'capture' ? STAGE_LABEL[r.stage] : `${STAGE_LABEL[r.stage]}, ${name(r.model)}`;
}

// #3737: the taste eval's arms side by side: how often each rubric criterion
// held, and the automatic checks and tells as averages per trial. A run's
// page shows the criteria and the checks as two tables (`part`); with one
// first version beside the capture, the criteria table says the change.
export function TasteTable({ rows, name, part = 'all' }: { rows: Row[]; name: (id: string) => string; part?: 'all' | 'criteria' | 'checks' }) {
  const line = (label: string, value: (t: TasteCell) => string, key: string, change?: string) => (
    <tr className={AdminUI.trHover} key={key}>
      <td className={DENSE_TD}>{label}</td>
      {rows.map((r) => <td className={`${DENSE_TD} tabular-nums`} key={`${r.stage}-${r.model}`}>{value(r.taste as TasteCell)}</td>)}
      {change !== undefined ? <td className={`${DENSE_TD} tabular-nums whitespace-nowrap`}>{change}</td> : null}
    </tr>
  );
  const before = rows.find((r) => r.stage === 'capture');
  const after = rows.filter((r) => r.stage === 'first_version');
  const withChange = part === 'criteria' && rows.length === 2 && !!before && after.length === 1;
  const changeOf = (id: string): string => {
    const a = after[0]?.taste?.criteria?.[id];
    const b = before?.taste?.criteria?.[id];
    if (!a?.n || !b?.n) return '–';
    const d = Math.round((a.rate - b.rate) * 100);
    return `${d > 0 ? '+' : ''}${d} points`;
  };
  const criteria = part !== 'checks';
  const checks = part !== 'criteria';
  return (
    <div id={part === 'checks' ? undefined : 'admin-homeroom-bench-taste'}>
      {part === 'all' ? <p className={AdminUI.label}>Taste, arm by arm</p> : null}
      <div className={SCROLL}>
        <table className={`${AdminUI.table} min-w-[32rem]`} id={part === 'checks' ? 'admin-homeroom-bench-taste-checks-table' : 'admin-homeroom-bench-taste-table'}>
          <thead className={AdminUI.thead}>
            <tr>
              <th className={DENSE_TH}>{part === 'checks' ? 'Measured on every screenshot' : 'Criterion'}</th>
              {/* A capture runs no model: its column is the arm alone. */}
              {rows.map((r) => <th className={DENSE_TH} key={`${r.stage}-${r.model}`}>{armName(r, name)}</th>)}
              {withChange ? <th className={DENSE_TH}>Change</th> : null}
            </tr>
          </thead>
          <tbody>
            {criteria ? TASTE_CRITERIA.map((c) => line(c.label, (t) => {
              const got = t.criteria?.[c.id];
              return got ? `${pctOrDash(got.rate)} of ${got.n}` : '–';
            }, c.id, withChange ? changeOf(c.id) : undefined)) : null}
            {checks ? (
              <>
                {line('Booted', (t) => pctOrDash(t.bootedRate), 'booted')}
                {line('Console errors', (t) => numOrDash(t.checks?.consoleErrors), 'console')}
                {line('Overflow at 360 px', (t) => numOrDash(t.checks?.overflowAt360px), 'overflow')}
                {line('Tap targets under 44 px', (t) => numOrDash(t.checks?.tapTargetsUnder44px), 'tap')}
                {line('Low-contrast text, light / dark', (t) => `${numOrDash(t.checks?.lowContrastLight)} / ${numOrDash(t.checks?.lowContrastDark)}`, 'contrast')}
                {line('Tells: emoji, eyebrows, text-[px], hex', (t) => [t.tells?.emojiIcons, t.tells?.uppercaseEyebrows, t.tells?.arbitraryTextSizes, t.tells?.hexColours].map(numOrDash).join(' · '), 'tells')}
              </>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className={`${AdminUI.muted} mt-1`}>
        {part === 'checks' ? 'The average per trial.'
          : part === 'criteria' ? 'The share of graded trials where the judge (or a person) said it held.'
            : 'Criteria: the share of graded trials where the judge (or a person) said it held. Checks and tells: the average per trial.'}
      </p>
    </div>
  );
}

/** A taste trial that has no screenshots to show, in words. */
function tasteTrialWords(t: TasteTrial): string {
  if (t.status === 'pending') return 'Queued';
  if (t.status === 'running') return t.stage === 'capture' ? 'Capturing' : 'Building';
  if (t.status === 'ok') return t.booted === false ? 'Did not boot: no screenshots' : 'No screenshots';
  if (t.status === 'skipped_cap') return 'Skipped at the cap';
  if (t.status === 'infra_fail') return 'Platform fault';
  if (t.status === 'model_fail') return 'Failed';
  if (t.status === 'timeout') return 'Timed out';
  if (t.status === 'not_applicable') return 'Not run';
  if (t.status === 'cancelled') return 'Cancelled';
  return t.status;
}

/**
 * #3737: a taste run's arms side by side, app by app: what shipped beside
 * each first version, as the screenshots the judge was shown, and how many
 * criteria each one's grade said held.
 */
export function TasteSideBySide({ trials, name }: { trials: TasteTrial[]; name: (id: string) => string }) {
  if (!trials.length) return <p className={AdminUI.muted}>No taste trials in this run.</p>;
  const armOf = (t: TasteTrial) => (t.stage === 'capture' ? 'capture' : `first_version|${t.model}`);
  const arms = [...new Set(trials.map(armOf))].sort((a, b) => (a === 'capture' ? -1 : b === 'capture' ? 1 : a.localeCompare(b)));
  const label = (k: string) => (k === 'capture' ? 'Before: what shipped' : `First version, ${name(k.slice(k.indexOf('|') + 1))}`);
  const apps = [...new Map(trials.map((t) => [t.appSlug, t.appName])).entries()];
  return (
    <div className="space-y-5" id="admin-homeroom-bench-taste-apps">
      {apps.map(([slug, appName]) => (
        <div key={slug} data-bench-taste-app={slug}>
          <p className="text-sm font-semibold">{appName}<span className={`${AdminUI.muted} ml-2 font-normal`}>{slug}</span></p>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {arms.map((k) => {
              const mine = trials.filter((t) => t.appSlug === slug && armOf(t) === k).sort((a, b) => a.attempt - b.attempt);
              return (
                <div key={k} className="min-w-0 rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3" data-bench-taste-arm={k}>
                  <p className={AdminUI.label}>{label(k)}</p>
                  {!mine.length ? <p className={`${AdminUI.muted} mt-1`}>Not in this run</p> : mine.map((t) => (
                    <div key={t.trialId} className="mt-2" data-bench-taste-trial={t.trialId}>
                      <div className="flex flex-wrap items-center gap-2">
                        {mine.length > 1 ? <span className={AdminUI.muted}>{`Attempt ${t.attempt}`}</span> : null}
                        {t.criteria
                          ? <span className={AdminUI.badge.outline}>{`${t.criteria.held} of ${t.criteria.of} criteria held`}</span>
                          : t.status === 'ok' ? <span className={AdminUI.badge.warn}>not graded yet</span> : null}
                      </div>
                      {t.status === 'ok' && t.shots.length ? <TasteShots shots={t.shots} /> : <p className="mt-1 text-sm">{tasteTrialWords(t)}</p>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── One run ─────────────────────────────────────────────────────────────

function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className={`${AdminUI.card} p-4 scroll-mt-4`} id={id} aria-labelledby={`${id}-title`}>
      <h3 className={`${AdminUI.cardTitle} mb-1`} id={`${id}-title`}>{title}</h3>
      {note ? <p className={`${AdminUI.muted} mb-3`}>{note}</p> : null}
      {children}
    </section>
  );
}

/**
 * One run: its facts, what ran of it against the cap, Cancel and the CSV,
 * and every part of its results, one after another with a list to jump
 * between them. Nothing of what the single page's Results showed is left
 * out; a taste run leads with its arms.
 */
function RunPage({ runId, run, models, canWrite, say, go, onCancel }: {
  runId: number; run: Run | undefined; models: Model[]; canWrite: boolean; say: Say; go: Go; onCancel: (id: number) => void;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [missing, setMissing] = useState(false);
  const [slice, setSlice] = useState('verdict');
  const [stage, setStage] = useState<Stage | ''>('');
  const [review, setReview] = useState<Review[] | null>(null);
  // A run in progress is read again whenever the list says it moved.
  const moving = run ? `${run.status}:${runCounts(run).ran}:${run.spent_usd}` : '';
  const load = useCallback(async () => {
    try {
      const data = await send(`${BASE}/runs/${runId}/report?slice=${slice}`, 'GET');
      setReport(data);
      setMissing(false);
      setStage((s) => s || (data.run.stages?.[0] ?? ''));
    } catch (err: any) {
      if (/not found/i.test(err.message)) setMissing(true);
      else say(`Could not read the results: ${err.message}`, 'err');
    }
  }, [runId, slice, say]);
  useEffect(() => { load(); }, [load, moving]);
  const loadReview = async () => {
    try { setReview((await send(`${BASE}/runs/${runId}/review?limit=10`, 'GET')).items || []); } catch (err: any) { say(err.message, 'err'); }
  };
  const override = async (trialId: number, verdict: 'pass' | 'fail') => {
    try {
      await send(`${BASE}/trials/${trialId}/grade`, 'POST', { verdict, critique: 'Spot check in the console.' });
      say(`Graded ${verdict} by a person: it overrides the judge.`);
      loadReview(); load();
    } catch (err: any) { say(err.message, 'err'); }
  };
  const name = (id: string) => shortModel(id, models);
  const jump = (id: string) => { try { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* non-fatal */ } };

  const back = <BenchLink to={{ view: 'runs' }} go={go} className={`${AdminUI.btn.link} text-sm`}>All runs</BenchLink>;
  if (missing) {
    return (
      <div className={`${AdminUI.card} p-4 space-y-2`} id="admin-homeroom-bench-run">
        <p className="text-sm" id="admin-homeroom-bench-run-missing">{`There is no run ${runId}.`}</p>
        {back}
      </div>
    );
  }
  if (!report) return <p className={AdminUI.loading} id="admin-homeroom-bench-results-loading">Loading…</p>;

  const r = report.run;
  const status = run?.status || r.status;
  const state = runState(status);
  const runModels = run?.models || r.models || [];
  const stages = (run?.stages || r.stages || []) as string[];
  const pending = report.rows.reduce((s, row) => s + (row.pending || 0), 0);
  const graded = report.rows.reduce((s, row) => s + (row.graded || 0), 0);
  const tasteRows = report.rows.filter((row) => row.taste).sort((a, b) => (a.stage === 'capture' ? -1 : b.stage === 'capture' ? 1 : 0));
  const taste = tasteRows.length > 0;
  const cap = run?.cap_usd ?? r.capUsd;
  const spent = run?.spent_usd ?? r.spentUsd;
  const a = report.agreement;
  const sections: [string, string][] = [
    ...(taste ? [['admin-homeroom-bench-taste-side', 'Side by side'], ['admin-homeroom-bench-taste-criteria', 'Criteria'], ['admin-homeroom-bench-taste-checks', 'Automatic checks']] as [string, string][] : []),
    ['admin-homeroom-bench-results', 'By stage and model'],
    ['admin-homeroom-bench-baseline', 'Against the baseline'],
    ['admin-homeroom-bench-chart', 'Cost against quality'],
    ['admin-homeroom-bench-slices-section', 'Slices'],
    ['admin-homeroom-bench-judge', 'The judge'],
  ];
  const facts = [
    `Started ${shortWhen(run?.created_at || r.createdAt) || 'at an unknown time'}${run?.started_by ? ` by ${run.started_by}` : ''}`,
    runModels.length > 3
      ? `${runModels.length} models, ${name(r.baseline)} the baseline`
      : runModels.map((m) => `${name(m)}${m === r.baseline && runModels.length > 1 ? ' (baseline)' : ''}`).join(', '),
    `${stages.map((st) => STAGE_LABEL[st as Stage] || st).join(', ')}${r.repeats > 1 ? `, up to ${r.repeats} attempts a task` : ''}`,
    run?.concurrency ? `${run.concurrency} at a time` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="space-y-4" id="admin-homeroom-bench-run" data-bench-run-page={runId}>
      <section className={`${AdminUI.card} p-4 space-y-4`} id="admin-homeroom-bench-run-header">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            {back}
            <div className="flex flex-wrap items-center gap-2">
              <h3 className={AdminUI.cardTitle}>{`Run ${runId} · ${r.suiteName} v${r.suiteVersion}`}</h3>
              <span className={state.badge} id="admin-homeroom-bench-run-state">{state.label}</span>
              {r.suiteFrozen ? null : <span className={AdminUI.badge.outline}>suite not frozen</span>}
            </div>
            <p className={AdminUI.muted} id="admin-homeroom-bench-run-facts">{facts}</p>
            {run?.note ? <p className={AdminUI.muted}>{run.note}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {canWrite ? (
              <a className={AdminUI.btn.outlineSm} href={`${BASE}/runs/${runId}/trials.csv`} download id="admin-homeroom-bench-csv">Download trials</a>
            ) : null}
            {canWrite && (status === 'queued' || status === 'running') ? (
              <button type="button" className={AdminUI.btn.destructiveSm} id="admin-homeroom-bench-run-cancel" onClick={() => onCancel(runId)}>Cancel run</button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3 space-y-2" id="admin-homeroom-bench-run-trials">
            <div className={AdminUI.muted}>Trials</div>
            {run ? (
              <>
                <div className="text-lg font-semibold tabular-nums">{`${runCounts(run).ran} of ${runCounts(run).planned} done`}</div>
                <TrialBar run={run} />
                <div className={`${AdminUI.muted} tabular-nums`}>{trialWords(run).split(' · ').slice(1).join(' · ') || (runCounts(run).notApplicable ? `${runCounts(run).notApplicable} not applicable` : 'Nothing skipped')}</div>
              </>
            ) : <div className="text-lg font-semibold tabular-nums">{`${report.rows.reduce((s, row) => s + row.trials, 0)} planned`}</div>}
          </div>
          <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3 space-y-2" id="admin-homeroom-bench-run-spent">
            <div className={AdminUI.muted}>Spent</div>
            <div className="text-lg font-semibold tabular-nums">{usd(spent)}<span className="ml-1 text-sm font-normal text-zinc-500 dark:text-zinc-400">{`of ${usd(cap)} cap`}</span></div>
            <SpendBar spent={spent} cap={cap} />
            <div className={AdminUI.muted}>{status === 'capped' ? 'Stopped at the cap: the trials left were skipped' : 'Platform faults are kept out of accuracy; a timeout counts as a fail'}</div>
          </div>
          <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3 space-y-2" id="admin-homeroom-bench-run-judge">
            <div className={AdminUI.muted}>Judge</div>
            <div className="text-lg font-semibold tabular-nums">{pending ? `${pending} wait for the judge` : graded ? `${graded} graded` : 'Nothing to grade yet'}</div>
            <div className={AdminUI.muted}>{pending ? `Ask an admin's Claude session to "${JUDGE_PROMPT}".` : 'Items join the queue as trials finish.'}</div>
          </div>
        </div>
        <nav aria-label="Run sections" className="flex flex-wrap gap-1" id="admin-homeroom-bench-run-nav">
          {sections.map(([id, label]) => (
            <button key={id} type="button" className={AdminUI.btn.outlineSm} data-bench-jump={id} onClick={() => jump(id)}>{label}</button>
          ))}
        </nav>
      </section>

      <div className="space-y-4" id="admin-homeroom-bench-report">
        {taste ? (
          <>
            <Section id="admin-homeroom-bench-taste-side" title="Side by side, app by app"
              note="The screenshots the judge was shown, light and dark, phone first. A grade says how many of the twelve criteria held.">
              <TasteSideBySide trials={report.tasteTrials || []} name={name} />
            </Section>
            <Section id="admin-homeroom-bench-taste-criteria" title={`The ${TASTE_CRITERIA.length} criteria, arm by arm`}>
              <TasteTable rows={tasteRows} name={name} part="criteria" />
            </Section>
            <Section id="admin-homeroom-bench-taste-checks" title="Automatic checks">
              <TasteTable rows={tasteRows} name={name} part="checks" />
            </Section>
          </>
        ) : null}

        <Section id="admin-homeroom-bench-results" title="By stage and model"
          note={`Baseline ${name(r.baseline)}. ${usd(spent)} of a ${usd(cap)} cap. Platform faults are kept out of accuracy; a timeout counts as a fail.`}>
          <div className={SCROLL}>
            <table className={`${AdminUI.table} min-w-[40rem]`} id="admin-homeroom-bench-results-table">
              <thead className={AdminUI.thead}>
                <tr>
                  {['Stage and model', 'Accuracy', 'pass^k', 'Cost', 'Time', 'Faults', 'Not graded'].map((h) => (
                    <th className={DENSE_TH} key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => {
                  const notApplicable = row.trials > 0 && row.notApplicable === row.trials;
                  return (
                    <tr className={AdminUI.trHover} key={`${row.stage}-${row.model}`} data-bench-row={`${row.stage}:${row.model}`}>
                      <td className={DENSE_TD}>
                        <span className="font-medium">{name(row.model)}</span>
                        {row.baseline ? <span className={`${AdminUI.badge.outline} ml-1`}>baseline</span> : null}
                        <span className={`${AdminUI.muted} block`}>{STAGE_LABEL[row.stage]}</span>
                      </td>
                      <td className={DENSE_TD}>
                        {notApplicable ? 'not applicable' : pct(row.accuracy)}
                        <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : `${row.pass} of ${row.graded} graded`}</span>
                      </td>
                      <td className={DENSE_TD}>
                        {notApplicable ? '' : row.passK.k > 1 ? pct(row.passK.value) : 'once each'}
                        <span className={`${AdminUI.muted} block`}>{!notApplicable && row.passK.k > 1 ? `all ${row.passK.k} right, of ${row.passK.tasks} tasks` : ''}</span>
                      </td>
                      <td className={DENSE_TD}>
                        {notApplicable ? '' : `${usd(row.costPerAttempt, 3)} an attempt`}
                        <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : row.costPerSuccess == null ? 'no success yet' : `${usd(row.costPerSuccess, 3)} a success`}</span>
                      </td>
                      <td className={`${DENSE_TD} whitespace-nowrap`}>
                        {notApplicable ? '' : `${secs(row.p50Ms)} median`}
                        <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : `${secs(row.p95Ms)} p95`}</span>
                      </td>
                      <td className={DENSE_TD}>
                        {notApplicable ? '' : `${pct(row.timeoutRate)} timed out`}
                        <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : `${pct(row.infraRate)} platform`}</span>
                      </td>
                      <td className={`${DENSE_TD} text-sm`}>
                        {[row.pending ? `${row.pending} for the judge` : null, row.unlabelled ? `${row.unlabelled} unlabelled` : null,
                          row.notApplicable ? `${row.notApplicable} not applicable` : null, row.skippedCap ? `${row.skippedCap} skipped at the cap` : null]
                          .filter(Boolean).join(', ')}
                      </td>
                    </tr>
                  );
                })}
                {!report.rows.length ? <tr><td className={DENSE_TD} colSpan={7}>No trials yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="admin-homeroom-bench-baseline" title="Against the baseline"
          note="Each task scored on both models (the mean of its attempts); the interval resamples apps, not tasks, so one busy app cannot make it look surer than it is.">
          <div className={SCROLL}>
            <table className={`${AdminUI.table} min-w-[36rem]`} id="admin-homeroom-bench-paired">
              <thead className={AdminUI.thead}>
                <tr>{['Stage', 'Model', 'Difference', '95% interval', 'Tasks (apps)'].map((h) => <th className={DENSE_TH} key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {report.paired.filter((p) => p.n > 0).map((p) => (
                  <tr className={AdminUI.trHover} key={`${p.stage}-${p.model}`}>
                    <td className={DENSE_TD}>{STAGE_LABEL[p.stage]}</td>
                    <td className={DENSE_TD}>{name(p.model)}</td>
                    <td className={DENSE_TD}>{p.diff == null ? 'not yet' : `${p.diff >= 0 ? '+' : ''}${Math.round(p.diff * 100)} points`}</td>
                    <td className={DENSE_TD}>{p.low == null || p.high == null ? 'not yet' : `${Math.round(p.low * 100)} to ${Math.round(p.high * 100)}`}</td>
                    <td className={DENSE_TD}>{`${p.n} (${p.apps})`}</td>
                  </tr>
                ))}
                {!report.paired.length ? <tr><td className={DENSE_TD} colSpan={5}>Only the baseline ran.</td></tr> : null}
                {report.paired.length && !report.paired.some((p) => p.n > 0) ? <tr><td className={DENSE_TD} colSpan={5}>No task is graded on both a model and the baseline yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="admin-homeroom-bench-chart" title="Cost against quality">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <label className={AdminUI.label} htmlFor="admin-homeroom-bench-chart-stage">Stage</label>
            <div className="w-48">
              <select id="admin-homeroom-bench-chart-stage" aria-label="Stage for the chart" className={AdminUI.select} value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
                {r.stages.map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
              </select>
            </div>
          </div>
          <ParetoChart points={report.pareto.filter((p) => p.stage === stage)} models={models} />
        </Section>

        <Section id="admin-homeroom-bench-slices-section" title="Slices">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <label className={AdminUI.label} htmlFor="admin-homeroom-bench-slice">Slices by</label>
            <div className="w-48">
              <select aria-label="Tag to slice by" className={AdminUI.select} value={slice} onChange={(e) => setSlice(e.target.value)} id="admin-homeroom-bench-slice">
                {report.slice.keys.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
              </select>
            </div>
          </div>
          <div className={SCROLL}>
            <table className={`${AdminUI.table} min-w-[32rem]`} id="admin-homeroom-bench-slices">
              <thead className={AdminUI.thead}><tr>{['Stage', report.slice.key.replace('_', ' '), 'Model', 'Accuracy'].map((h) => <th className={DENSE_TH} key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {report.slice.groups.filter((g) => g.n > 0).map((g) => (
                  <tr className={AdminUI.trHover} key={`${g.stage}-${g.value}-${g.model}`}>
                    <td className={DENSE_TD}>{STAGE_LABEL[g.stage]}</td>
                    <td className={DENSE_TD}>{g.value}</td>
                    <td className={DENSE_TD}>{name(g.model)}</td>
                    <td className={DENSE_TD}>{`${pct(g.accuracy)} of ${g.n}`}</td>
                  </tr>
                ))}
                {!report.slice.groups.some((g) => g.n > 0) ? <tr><td className={DENSE_TD} colSpan={4}>Nothing graded to slice yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="admin-homeroom-bench-judge" title="The judge">
          <p className={AdminUI.muted} id="admin-homeroom-bench-agreement">
            {a.n ? judgeLine(a) : 'No person has spot-checked the judge on this run yet.'}
            {` Grades come from an admin's Claude session through the Homeroom connector: ask it to "${JUDGE_PROMPT}".`}
          </p>
          <button type="button" className={`${AdminUI.btn.outlineSm} mt-2`} onClick={loadReview} id="admin-homeroom-bench-spot-check">Spot-check judged trials</button>
          {review ? (
            <div className="mt-2 space-y-3">
              {review.map((rv) => (
                <div key={rv.trialId} className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3 text-sm" data-bench-review={rv.trialId}>
                  <p className="font-medium">{`${stageLabel(rv.item.stage)}: ${rv.item.task.appName || rv.item.task.issueTitle || 'a request'}`}</p>
                  {rv.item.shots?.length ? <TasteShots shots={rv.item.shots} /> : null}
                  <details className="mt-1">
                    <summary className={`${AdminUI.muted} cursor-pointer`}>What the candidate said (model hidden)</summary>
                    <pre className="whitespace-pre-wrap break-words text-xs mt-1">{JSON.stringify(rv.item.candidate, null, 1)}</pre>
                    <p className={`${AdminUI.muted} mt-1 break-words`}>{`Reference: ${JSON.stringify(rv.item.reference)}`}</p>
                  </details>
                  <p className="mt-1">{`Judge: ${rv.opus?.verdict || 'not graded'}. ${rv.opus?.critique || ''}`}</p>
                  {rv.human ? <p className={AdminUI.muted}>{`A person said ${rv.human.verdict}.`}</p> : null}
                  {canWrite ? (
                    <span className="inline-flex gap-1 mt-1">
                      <button type="button" className={AdminUI.btn.outlineSm} onClick={() => override(rv.trialId, 'pass')}>Pass</button>
                      <button type="button" className={AdminUI.btn.outlineSm} onClick={() => override(rv.trialId, 'fail')}>Fail</button>
                    </span>
                  ) : null}
                </div>
              ))}
              {!review.length ? <p className={AdminUI.muted}>Nothing judged on this run yet.</p> : null}
            </div>
          ) : null}
        </Section>
      </div>
    </div>
  );
}

// ── Runs ────────────────────────────────────────────────────────────────

// A filter chip. It sits on the page's ground, not on a card, where the
// console's filled neutral (btn.outlineSm, zinc-100) is the ground's own
// colour, so an unpressed chip is drawn white.
function chip(on: boolean): string {
  return on
    ? 'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors bg-violet-600 text-white'
    : 'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors bg-white text-zinc-900 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800';
}

function modelsShort(ids: string[], models: Model[]): string {
  return ids.length > 3 ? `${ids.length} models` : ids.map((m) => shortModel(m, models)).join(', ');
}

/**
 * Every run, newest first: what ran of it beside its bar, spend against the
 * cap, its state in plain words, Cancel while it runs, and each one a link
 * to its own page. Filtered by suite; a cap that stopped a run with most of
 * its trials unrun is said above the table.
 */
function RunsPage({ runs, models, canWrite, pendingOf, go, onCancel }: {
  runs: Run[]; models: Model[]; canWrite: boolean; pendingOf: (id: number) => number; go: Go; onCancel: (id: number) => void;
}) {
  const [filter, setFilter] = useState<number | null>(null);
  const suites = [...new Map(runs.map((r) => [r.suite_id ?? 0, `${r.suite_name} v${r.suite_version}`])).entries()];
  const shown = filter == null ? runs : runs.filter((r) => (r.suite_id ?? 0) === filter);
  const warning = cappedWarning(cappedShort(shown));
  return (
    <div className="space-y-3" id="admin-homeroom-bench-runs-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {suites.length > 1 ? (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by suite" id="admin-homeroom-bench-run-filter">
            <button type="button" aria-pressed={filter == null} className={chip(filter == null)}
              onClick={() => setFilter(null)}>All suites</button>
            {suites.map(([id, label]) => (
              <button key={id} type="button" aria-pressed={filter === id} data-bench-run-filter={id}
                className={chip(filter === id)} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>
        ) : <span />}
        <BarLegend />
      </div>
      {warning ? (
        <p role="note" className="rounded-xl bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200" id="admin-homeroom-bench-capped-warning">{warning}</p>
      ) : null}
      <div className={`${AdminUI.card} p-2`} id="admin-homeroom-bench-runs">
        <div className={SCROLL}>
          <table className={`${AdminUI.table} min-w-[40rem]`} id="admin-homeroom-bench-run-table">
            <thead className={AdminUI.thead}>
              <tr>{['Run', 'What ran', 'Trials', 'Spent', 'State'].map((h) => <th className={DENSE_TH} key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const waiting = pendingOf(r.id);
                const state = runState(r.status);
                return (
                  <tr className={AdminUI.trHover} key={r.id} data-bench-run={r.id}>
                    <td className={DENSE_TD}>
                      <BenchLink to={{ view: 'run', id: r.id }} go={go} className={`${AdminUI.btn.link} text-sm`} data={{ 'bench-run-link': r.id }}>{`Run ${r.id}`}</BenchLink>
                      <span className={`${AdminUI.muted} block`}>{`${r.suite_name} v${r.suite_version} · ${shortWhen(r.created_at)}`}</span>
                    </td>
                    <td className={`${DENSE_TD} text-sm`}>
                      {(r.stages || []).map((st) => STAGE_LABEL[st as Stage] || st).join(', ')}
                      <span className={`${AdminUI.muted} block`}>{`${modelsShort(r.models, models)}${r.repeats > 1 ? `, up to ${r.repeats} attempts` : ''}`}</span>
                    </td>
                    <td className={`${DENSE_TD} min-w-[9rem]`} data-bench-run-ran={r.id}>
                      <TrialBar run={r} />
                      <span className="mt-1.5 block text-sm tabular-nums">{trialWords(r)}</span>
                    </td>
                    <td className={`${DENSE_TD} min-w-[7rem]`}>
                      <SpendBar spent={r.spent_usd} cap={r.cap_usd} />
                      <span className="mt-1.5 block text-sm tabular-nums">{`${usd(r.spent_usd)} of ${usd(r.cap_usd)}`}</span>
                    </td>
                    <td className={DENSE_TD}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className={state.badge}>{state.label}</span>
                        {waiting ? <span className={`${AdminUI.badge.warn} whitespace-nowrap`} data-bench-run-judge={r.id}>{`${waiting} for the judge`}</span> : null}
                        {canWrite && (r.status === 'queued' || r.status === 'running') ? (
                          <button type="button" className={AdminUI.btn.outlineSm} data-bench-run-cancel={r.id} onClick={() => onCancel(r.id)}>Cancel</button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {!shown.length ? <tr><td className={DENSE_TD} colSpan={5} id="admin-homeroom-bench-runs-empty">No runs yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────

/** Runs in progress against their caps, and what waits for the judge, with the words to ask for it. */
function NowStrip({ runs, pending, models, go, say }: { runs: Run[]; pending: number | null; models: Model[]; go: Go; say: Say }) {
  const [copied, setCopied] = useState(false);
  const live = runs.filter((r) => r.status === 'running' || r.status === 'queued');
  const latest = runs[0];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JUDGE_PROMPT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { say('Could not copy: select the words and copy them instead.', 'err'); }
  };
  return (
    <section aria-label="Happening now" id="admin-homeroom-bench-now" className={`${AdminUI.card} grid md:grid-cols-2 overflow-hidden`}>
      <div className="p-4 space-y-4 min-w-0">
        {live.length ? live.map((r) => (
          <div key={r.id} className="space-y-2" data-bench-now-run={r.id}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={runState(r.status).badge}>{runState(r.status).label}</span>
              <BenchLink to={{ view: 'run', id: r.id }} go={go} className={`${AdminUI.btn.link} text-sm`}>{`Run ${r.id} · ${r.suite_name} v${r.suite_version}`}</BenchLink>
              <span className={AdminUI.muted}>{modelsShort(r.models, models)}</span>
            </div>
            <TrialBar run={r} />
            <div className="flex flex-wrap justify-between gap-2 text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
              <span>{trialWords(r)}</span>
              <span>{`${usd(r.spent_usd)} of ${usd(r.cap_usd)} cap`}</span>
            </div>
          </div>
        )) : (
          <div className="space-y-1">
            <p className="text-sm font-medium">Nothing running now</p>
            {latest ? (
              <p className={AdminUI.muted}>
                {'The latest: '}
                <BenchLink to={{ view: 'run', id: latest.id }} go={go} className={AdminUI.btn.link}>{`Run ${latest.id}`}</BenchLink>
                {`, ${latest.suite_name} v${latest.suite_version}: ${runState(latest.status).label.toLowerCase()}, ${runCounts(latest).ran} of ${runCounts(latest).planned} trials ran, ${usd(latest.spent_usd)} spent.`}
              </p>
            ) : <p className={AdminUI.muted}>No run yet.</p>}
          </div>
        )}
      </div>
      <div className={`p-4 space-y-2 min-w-0 ${pending ? 'bg-amber-50 dark:bg-amber-500/10' : 'md:border-l md:border-zinc-100 md:dark:border-zinc-800'}`} id="admin-homeroom-bench-judge-now">
        {pending == null ? <p className={AdminUI.loading}>Loading…</p> : pending ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className={AdminUI.badge.warn}>Your turn</span>
              <span className="text-sm font-semibold" id="admin-homeroom-bench-judge-count">{`${plural(pending, 'trial')} ${pending === 1 ? 'waits' : 'wait'} for the judge`}</span>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-300" id="admin-homeroom-bench-judge-prompt">
              Ask an admin&apos;s own Claude session with the Homeroom connector, in these words. Grade before reading the results, so the numbers cannot sway the grades.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className={`${AdminUI.kbd} text-sm`} id="admin-homeroom-bench-judge-text">{JUDGE_PROMPT}</code>
              <button type="button" className={AdminUI.btn.outlineSm} id="admin-homeroom-bench-judge-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">Nothing waits for the judge</p>
            <p className={AdminUI.muted}>Trials join the judge&apos;s queue as they finish.</p>
          </>
        )}
      </div>
    </section>
  );
}

export interface TasteArm {
  key: string; stage: Stage; model: string; runId: number; trials: number;
  score: { held: number; of: number; graded: number } | null; scoredIn: number | null;
}
/** How many of the rubric's criteria held, their shares summed, of how many were answered; null before any grade. Pure. */
export function tasteScore(cell: TasteCell | undefined): { held: number; of: number; graded: number } | null {
  const answered = Object.values(cell?.criteria || {}).filter((c) => c && c.n > 0);
  if (!answered.length) return null;
  return { held: answered.reduce((s, c) => s + c.rate, 0), of: answered.length, graded: Math.max(...answered.map((c) => c.n)) };
}
/**
 * Each taste arm's latest graded score across a taste suite's runs (newest
 * first), and the run it is from; an arm nothing graded yet says how many
 * trials it has in its newest run. Captures first, then each model's first
 * versions. Pure.
 */
export function tasteArms(reports: { runId: number; report: Pick<Report, 'rows'> }[]): TasteArm[] {
  const arms = new Map<string, TasteArm>();
  for (const { runId, report } of reports) {
    for (const r of report.rows || []) {
      if (!r.taste) continue;
      const key = r.stage === 'capture' ? 'capture' : `${r.stage}|${r.model}`;
      const score = tasteScore(r.taste);
      const arm = arms.get(key);
      if (!arm) arms.set(key, { key, stage: r.stage, model: r.model, runId, trials: r.trials - (r.notApplicable || 0), score, scoredIn: score ? runId : null });
      else if (!arm.score && score) { arm.score = score; arm.scoredIn = runId; }
    }
  }
  return [...arms.values()].sort((a, b) => (a.stage === 'capture' ? -1 : b.stage === 'capture' ? 1 : a.key.localeCompare(b.key)));
}
const held = (n: number) => (Math.round(n * 10) / 10).toString();

/** The taste eval's latest score per arm, or how far it has got. */
function TasteCard({ suite, arms, latestRunId, models, go }: { suite: Suite; arms: TasteArm[] | null; latestRunId: number | null; models: Model[]; go: Go }) {
  return (
    <section className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-taste-card" aria-labelledby="admin-homeroom-bench-taste-card-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h3 className={AdminUI.cardTitle} id="admin-homeroom-bench-taste-card-title">How the bot&apos;s first versions look</h3>
          <p className={AdminUI.cardDescription}>{`${suite.name} v${suite.version} · ${suiteCounts(suite)} · judged blind from screenshots against ${TASTE_CRITERIA.length} design criteria`}</p>
        </div>
        {latestRunId ? <BenchLink to={{ view: 'run', id: latestRunId }} go={go} className={`${AdminUI.btn.link} text-sm`}>{`Open run ${latestRunId}`}</BenchLink> : null}
      </div>
      {arms == null ? <p className={AdminUI.loading}>Loading…</p> : !arms.length ? (
        <p className={AdminUI.muted} id="admin-homeroom-bench-taste-empty">Nothing has run on this suite yet: start a run of it from New run.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {arms.map((arm) => (
            <div key={arm.key} className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3" data-bench-taste-score={arm.key}>
              <div className={AdminUI.muted}>{arm.stage === 'capture' ? 'Before: what shipped' : `First versions, ${shortModel(arm.model, models)}`}</div>
              <div className="mt-0.5 text-2xl font-semibold tabular-nums">
                {arm.score ? held(arm.score.held) : '–'}
                <span className="ml-1 text-sm font-normal text-zinc-500 dark:text-zinc-400">{`of ${arm.score ? arm.score.of : TASTE_CRITERIA.length} criteria`}</span>
              </div>
              <div className={AdminUI.muted}>
                {arm.score
                  ? `${plural(arm.score.graded, 'trial')} graded, run ${arm.scoredIn}`
                  : `${plural(arm.trials, arm.stage === 'capture' ? 'capture' : 'build')} in run ${arm.runId}, not graded yet`}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function HowItWorks() {
  return (
    <details className={`${AdminUI.card} px-4`} id="admin-homeroom-bench-how">
      <summary className="cursor-pointer py-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">How the benchmark works</summary>
      <ul className="list-disc space-y-1 pb-4 pl-5 text-sm text-zinc-600 dark:text-zinc-300" id="admin-homeroom-bench-intro">
        <li>Real requests the bot has seen, replayed on other models with the bot&apos;s own prompts, worker and clocks.</li>
        <li>Nothing is posted, messaged or proposed, and every run stops at its dollar cap.</li>
        <li>Rules grade what a rule can tell; Claude Opus grades the rest on an admin&apos;s own plan through the Homeroom connector, blind to the model.</li>
        <li>The recommended model is the cheapest success among the models within five points of the most accurate. A stage with too few graded tasks is not called.</li>
        <li>Use for a stage fills in the bot&apos;s Settings; nothing changes until you press Save there. A checks fix runs on the bot&apos;s follow-up model; DM answers run on the platform default.</li>
      </ul>
    </details>
  );
}

// How many of a suite's newest runs the matrix reads: enough to cover a full
// run and the partial ones before it, few enough to load at once.
const MATRIX_RUNS = 8;

/**
 * The suite the matrix answers for and its newest runs that ran anything:
 * the one the launcher starts on (Core v1) once anything has run on it, else
 * the newest suite a model-picking run ran on (not a taste run's), so a Core
 * made but never run does not blank the answer. Pure, and shared by the
 * Benchmark tab and the bot's Settings, so both read the same answer.
 */
export function matrixRunsFor(runs: Run[], launcher: LauncherDefaults | null): { suiteId: number | null; runs: Run[] } {
  const ran = runs.filter((r) => runCounts(r).ran > 0);
  const preferred = launcher?.suiteId ?? null;
  const picksModels = (r: Run) => (r.stages || []).some((st) => !TASTE_STAGES.includes(st as Stage));
  const suiteId = preferred != null && ran.some((r) => r.suite_id === preferred)
    ? preferred
    : ran.find(picksModels)?.suite_id ?? preferred ?? runs[0]?.suite_id ?? null;
  return { suiteId, runs: ran.filter((r) => r.suite_id === suiteId).slice(0, MATRIX_RUNS) };
}

/**
 * What the bot's Settings shows beside each model picker: the catalog the
 * benchmark offers and the merged best-per-stage answer. One read of the
 * runs and their reports, the same selection the Benchmark tab makes.
 */
export async function loadBenchSummary(): Promise<{ models: Model[]; best: Best; defaultModel: string | null }> {
  const [s, r, m] = await Promise.all([send(`${BASE}/suites`, 'GET'), send(`${BASE}/runs`, 'GET'), send(`${BASE}/models`, 'GET')]);
  const { suiteId, runs } = matrixRunsFor(r.runs || [], r.launcher || null);
  const suite = (s.suites || []).find((x: Suite) => x.id === suiteId);
  const reports = await Promise.all(runs.map(async (run) => {
    try { return { runId: run.id, report: await send(`${BASE}/runs/${run.id}/report`, 'GET') as Report }; } catch { return null; }
  }));
  const ok = reports.filter(Boolean) as { runId: number; report: Report }[];
  return { models: m.models || [], best: mergeBest(ok, suite?.counts, r.launcher?.models?.[0]), defaultModel: m.baseline || null };
}

// ── The area ────────────────────────────────────────────────────────────

/** The title, the four places with their counts, and New run, over every place. */
function BenchHeader({ route, go, runs, suites, onNew, status }: {
  route: BenchRoute; go: Go; runs: Run[] | null; suites: Suite[] | null; onNew: (() => void) | null; status: { text: string; tone: Tone } | null;
}) {
  const here = route.view === 'run' ? 'runs' : route.view;
  const tabs: [string, string, number | null, BenchRoute][] = [
    ['overview', 'Overview', null, { view: 'overview' }],
    ['runs', 'Runs', runs ? runs.length : null, { view: 'runs' }],
    ['suites', 'Suites', suites ? suites.length : null, { view: 'suites', id: null }],
    ['studio', 'Studio', null, { view: 'studio' }],
  ];
  return (
    <div className="space-y-3" id="admin-homeroom-bench-header">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className={AdminUI.sectionTitle}>Benchmark</h2>
          <p className={AdminUI.muted}>Which model each stage of the bot should run on</p>
        </div>
        {onNew ? <button type="button" className={AdminUI.btn.primary} id="admin-homeroom-bench-new-run" onClick={onNew}>New run</button> : null}
      </div>
      <nav aria-label="Benchmark" className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800" id="admin-homeroom-bench-tabs">
        {tabs.map(([key, label, count, to]) => (
          <BenchLink key={key} to={to} go={go} id={`admin-homeroom-bench-tab-${key}`} current={here === key}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${here === key
              ? 'border-violet-600 text-zinc-900 dark:border-violet-400 dark:text-zinc-100'
              : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'}`}>
            {label}
            {count != null ? <span className={AdminUI.badge.default}>{count}</span> : null}
          </BenchLink>
        ))}
      </nav>
      {status ? (
        <p className={`text-sm ${status.tone === 'err' ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`} role="status" id="admin-homeroom-bench-status">{status.text}</p>
      ) : null}
    </div>
  );
}

const uniqueRuns = (list: Run[]) => [...new Map(list.map((r) => [r.id, r])).values()];

export function BenchmarkArea({ canWrite, active = true, inUse = null, defaultModel = null, onUseModel }: {
  canWrite: boolean;
  // Whether the Benchmark tab is the one on screen: the address is this
  // area's to write only then.
  active?: boolean;
  // The bot's model per stage now, and the platform default (the bot's own
  // Settings data, passed down; no read of its own).
  inUse?: Partial<Record<BotStage, string | null>> | null;
  defaultModel?: string | null;
  onUseModel?: (stage: BotStage, model: string) => void;
}) {
  const [route, setRoute] = useState<BenchRoute>(() => (typeof location !== 'undefined' ? benchRouteFromHash(location.hash) : { view: 'overview' }));
  const [suites, setSuites] = useState<Suite[] | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [defaults, setDefaults] = useState({ capUsd: 50, repeats: 3, maxConcurrency: 8 });
  const [hiddenChecks, setHiddenChecks] = useState('');
  const [launcher, setLauncher] = useState<LauncherDefaults | null>(null);
  const [core, setCore] = useState<CoreStatus | null>(null);
  const [reports, setReports] = useState<Record<number, Report>>({});
  const [reportsRead, setReportsRead] = useState(false);
  const [sheet, setSheet] = useState<{ preset?: LaunchPreset } | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: Tone } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const say = useCallback((text: string, tone: Tone = 'ok') => { if (alive.current) setStatus({ text, tone }); }, []);

  // The address follows the place while this tab is the one on screen,
  // replaced, never pushed; the console's routed mark follows it, so typing
  // a sibling address in reopens that place rather than being taken for the
  // address it already rendered.
  useEffect(() => {
    if (!active) return;
    try {
      const h = String(location.hash || '');
      if (!h.startsWith('#admin/homeroom-bot')) return;
      const target = benchHash(route);
      if (h !== target) history.replaceState(null, '', target);
      (window as any).AdminConsole?._markRouted?.();
    } catch { /* non-fatal */ }
  }, [active, route]);
  const go = useCallback<Go>((next) => {
    setRoute(next);
    try {
      window.requestAnimationFrame(() => {
        const top = document.getElementById('admin-homeroom-bench');
        if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' });
      });
    } catch { /* non-fatal */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, r, m] = await Promise.all([send(`${BASE}/suites`, 'GET'), send(`${BASE}/runs`, 'GET'), send(`${BASE}/models`, 'GET')]);
      if (!alive.current) return;
      setSuites(s.suites || []);
      setRuns(r.runs || []);
      setDefaults((d) => r.defaults || d);
      setHiddenChecks(r.hiddenChecks || '');
      setLauncher(r.launcher || null);
      setModels(m.models || []);
    } catch (err: any) { say(`Could not read the benchmark: ${err.message}`, 'err'); }
  }, [say]);
  const loadCore = useCallback(async () => {
    try {
      const data = await send(`${BASE}/core`, 'GET');
      if (alive.current) setCore(data);
    } catch (err: any) { say(`Could not read Core: ${err.message}`, 'err'); }
  }, [say]);
  useEffect(() => { load(); loadCore(); }, [load, loadCore]);
  const coreRunning = !!core && (core.running || core.materialization?.status === 'running');
  // A run in progress moves, and so does Core while it is being made; a
  // slow poll keeps their rows honest.
  useEffect(() => {
    const handle = window.setInterval(() => {
      if ((runs || []).some((r) => r.status === 'queued' || r.status === 'running')) load();
      if (coreRunning) { loadCore(); load(); }
    }, 20_000);
    return () => window.clearInterval(handle);
  }, [runs, load, loadCore, coreRunning]);

  const allRuns = runs || [];
  const { suiteId: matrixSuiteId, runs: matrixRuns } = matrixRunsFor(allRuns, launcher);
  const matrixSuite = (suites || []).find((s) => s.id === matrixSuiteId);
  // The taste suite the Overview reports on: the one with runs, else the newest.
  const tasteSuite = (suites || []).filter((s) => isTasteSuite(s) && !isStudioSuite(s)).sort((a, b) => (Number(b.runs || 0) > 0 ? 1 : 0) - (Number(a.runs || 0) > 0 ? 1 : 0) || b.id - a.id)[0] || null;
  const tasteRuns = tasteSuite ? allRuns.filter((r) => r.suite_id === tasteSuite.id && runCounts(r).ran > 0).slice(0, 4) : [];
  // Each report the Overview reads: the matrix's, the taste suite's, and
  // the newest runs' (what waits for the judge). A finished run's report is
  // read once per visit; a running one again whenever the list moves.
  const wanted = uniqueRuns([...matrixRuns, ...tasteRuns, ...allRuns.filter((r) => runCounts(r).ran > 0).slice(0, MATRIX_RUNS)]);
  const wantedKey = wanted.map((r) => `${r.id}:${r.status}:${runCounts(r).ran}`).join(',');
  useEffect(() => {
    if (runs == null) return undefined;
    let cancelled = false;
    (async () => {
      const want = wanted.filter((r) => !reports[r.id] || r.status === 'running' || r.status === 'queued');
      const got = await Promise.all(want.map(async (r) => {
        try { return [r.id, await send(`${BASE}/runs/${r.id}/report`, 'GET')] as const; } catch { return null; }
      }));
      if (cancelled || !alive.current) return;
      setReports((cur) => {
        const next = { ...cur };
        for (const g of got) if (g) next[g[0]] = g[1] as Report;
        return next;
      });
      setReportsRead(true);
    })();
    return () => { cancelled = true; };
  }, [wantedKey, runs == null]);
  const best = runs == null ? null : !reportsRead && matrixRuns.length ? null : mergeBest(
    matrixRuns.filter((r) => reports[r.id]).map((r) => ({ runId: r.id, report: reports[r.id] })),
    matrixSuite?.counts, launcher?.models?.[0],
  );
  const pendingOf = (id: number) => (reports[id]?.rows || []).reduce((s, row) => s + (row.pending || 0), 0);
  const pending = runs == null || (!reportsRead && wanted.length) ? null : wanted.reduce((s, r) => s + pendingOf(r.id), 0);
  const arms = !reportsRead && tasteRuns.length ? null : tasteArms(tasteRuns.filter((r) => reports[r.id]).map((r) => ({ runId: r.id, report: reports[r.id] })));
  // Why a stage cannot be called yet, when a cap cut the run that would have.
  const capNotes: Partial<Record<Stage, string>> = {};
  for (const r of allRuns.filter((x) => x.suite_id === matrixSuiteId && x.status === 'capped')) {
    const c = runCounts(r);
    for (const st of r.stages as Stage[]) if (!capNotes[st]) capNotes[st] = `Run ${r.id} stopped at its cap after ${c.ran} of ${c.planned} trials.`;
  }

  const materializeCore = async () => {
    try {
      await send(`${BASE}/core/materialize`, 'POST', {});
      say('Core is being made in the background; this card updates as it goes.');
      loadCore();
    } catch (err: any) { say(err.message, 'err'); }
  };
  const freezeCore = async (suiteId: number) => {
    try {
      await send(`${BASE}/suites/${suiteId}/freeze`, 'POST', {});
      say('Core is frozen: results on it can be compared from now on.');
      loadCore(); load();
    } catch (err: any) { say(err.message, 'err'); }
  };
  const cancelRun = async (id: number) => {
    try { await send(`${BASE}/runs/${id}/cancel`, 'POST', {}); say(`Run ${id} cancelled.`); load(); } catch (err: any) { say(err.message, 'err'); }
  };
  const canLaunch = canWrite && !!suites?.length;
  const openNew = useCallback((preset?: LaunchPreset) => setSheet({ preset }), []);
  const closeNew = useCallback(() => setSheet(null), []);

  let page: ReactNode;
  if (route.view === 'run') {
    page = <RunPage key={route.id} runId={route.id} run={allRuns.find((r) => r.id === route.id)} models={models} canWrite={canWrite} say={say} go={go} onCancel={cancelRun} />;
  } else if (route.view === 'runs') {
    page = runs == null ? <p className={AdminUI.loading}>Loading…</p>
      : <RunsPage runs={runs} models={models} canWrite={canWrite} pendingOf={pendingOf} go={go} onCancel={cancelRun} />;
  } else if (route.view === 'studio') {
    page = <StudioPage canWrite={canWrite} say={say} />;
  } else if (route.view === 'suites') {
    page = suites == null ? <p className={AdminUI.loading}>Loading…</p> : (
      <SuitesPage suites={suites} selectedId={route.id} core={core} coreSuiteId={core?.suite?.id ?? null} canWrite={canWrite} go={go}
        onChanged={() => { load(); loadCore(); }} say={say} onMaterialize={materializeCore} onFreezeCore={freezeCore} />
    );
  } else {
    page = (
      <div className="space-y-4" id="admin-homeroom-bench-overview">
        {runs == null ? <p className={AdminUI.loading}>Loading…</p> : <NowStrip runs={runs} pending={pending} models={models} go={go} say={say} />}
        <StageTable best={best} models={models} suiteLabel={matrixSuite ? `${matrixSuite.name} v${matrixSuite.version}${matrixSuite.frozen_at ? ', frozen' : ''}` : ''}
          inUse={inUse} defaultModel={defaultModel} capNotes={capNotes} canUse={canWrite} onUseModel={onUseModel}
          onRunMore={canLaunch ? (st) => openNew({ suiteId: matrixSuiteId, stages: [st] }) : undefined} />
        {tasteSuite ? <TasteCard suite={tasteSuite} arms={arms} latestRunId={tasteRuns[0]?.id ?? null} models={models} go={go} /> : null}
        <HowItWorks />
      </div>
    );
  }

  return (
    <div className="space-y-4" id="admin-homeroom-bench" data-bench-view={route.view}>
      <BenchHeader route={route} go={go} runs={runs} suites={suites} onNew={canLaunch ? () => openNew() : null} status={status} />
      {page}
      {sheet && canLaunch ? (
        <NewRunSheet onClose={closeNew}>
          <Launcher suites={suites || []} models={models} defaults={defaults} launcher={launcher} hiddenChecks={hiddenChecks}
            preset={sheet.preset} say={say}
            onLaunched={(id) => { setSheet(null); load(); if (id) go({ view: 'run', id }); }} />
        </NewRunSheet>
      ) : null}
    </div>
  );
}
