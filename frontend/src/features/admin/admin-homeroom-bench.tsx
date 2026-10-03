'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';

// The Homeroom bot console's Benchmark area (#admin/homeroom-bot/benchmark),
// #3654. Rendered by admin-homeroom-bot.tsx under its Benchmark tab, so it
// lives in that section's host and needs no host of its own.
//
// Laid out around the two things an admin comes here to do (#3710):
//
//   Run      "Run the full benchmark": the launcher starts on good settings
//            (every catalog candidate, every stage the suite has tasks at,
//            triage three times, as many at once as the lane allows) and
//            shows the trials, the estimated cost, about how long it takes
//            and the cap BEFORE anything is spent (POST runs/estimate, the
//            same plan a launch records). The cap follows the estimate plus
//            15% until it is set by hand. Every other choice sits under
//            "Change settings".
//   Answer   "Best model for each stage": the latest graded result for each
//            stage and model on the suite, merged across runs, a cell with
//            too few graded tasks marked as such, the best value per stage
//            outlined, and "Use for <stage>", which fills in the bot's
//            Settings form; the admin still presses Save there.
//   Runs     what ran of each run (skipped and cancelled trials said apart,
//            not counted as done), spend against the cap, cancel, and a run
//            waiting on the judge says so.
//   Results  one run in detail: accuracy, pass^k, cost per attempt and per
//            success, p50/p95 time, timeouts and platform faults apart, the
//            paired difference from the baseline with its 95% interval, a
//            cost-vs-quality chart with the Pareto frontier, slices by a tag,
//            judge agreement, the spot check, and the CSV.
//   Manage   Core v1's state and the suites (freeze, new version, delete,
//            tasks, sampler, PR import), folded away: occasional upkeep.
//
// PERMISSIONS: any admin reads; every button that writes is gated on
// AdminConsole.canWrite() here and requireAdminWrite on the server
// (routes/homeroom-bench.js). Grading itself happens in an admin's own
// Claude session through the connector, not here; this screen only shows
// the judge's grades and lets a person override one.

const BASE = '/api/admin/homeroom-bot/bench';

type Stage = 'triage' | 'spec' | 'build' | 'followup' | 'checks_fix' | 'dm' | 'first_version' | 'capture';
const STAGE_LABEL: Record<Stage, string> = {
  triage: 'Triage', spec: 'Spec', build: 'Build', followup: 'Follow-up', checks_fix: 'Checks fix', dm: 'DM',
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
interface Model {
  id: string; label: string; role: string | null; stages: string[] | null; contextTokens: number | null;
  inputPerMillion: number | null; outputPerMillion: number | null; inCatalog: boolean;
}
export type BenchModel = Model;
interface Run {
  id: number; suite_id?: number; suite_name: string; suite_version: number; models: string[]; baseline_model: string; stages: string[];
  repeats: number; cap_usd: number; spent_usd: number; status: string; counts: Record<string, number>;
  created_at: string; started_by: string | null; note: string | null;
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
  run: { id: number; status: string; capUsd: number; spentUsd: number; baseline: string; suiteName: string; suiteVersion: number; suiteFrozen: boolean; repeats: number; stages: Stage[] };
  rows: Row[]; paired: Paired[]; pareto: Point[];
  slice: { key: string; keys: string[]; groups: { stage: Stage; model: string; value: string; n: number; accuracy: number | null }[] };
  agreement: { n: number; agreement: number | null; tpr: number | null; tnr: number | null };
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
interface Estimate {
  trials: number; notApplicable: number; likelyUsd: number; estimateUsd: number; estimatedMs: number;
  capUsd: number; maxCapUsd: number; suggestedCapUsd: number; calibratedFrom: number;
  suiteFrozen: boolean; byStage: Record<string, { trials: number; notApplicable: number; estimateUsd: number; likelyUsd: number }>;
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

// The results table is the console's densest: seven columns of two-line
// cells at 1280px. The recipes' 1.5rem side padding leaves room for five, so
// this one table draws tighter cells (the recipe's colours, less padding).
const DENSE_TH = 'px-3 py-2 text-left align-bottom text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400';
const DENSE_TD = 'px-3 py-3 align-top';

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? 'not yet' : `${Math.round(v * 100)}%`;
}
function usd(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(Number(v)) ? 'not yet' : `$${Number(v).toFixed(digits)}`;
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

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
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

// #3737: one more task for the taste eval: a first version built from a
// brief on today's starter, or an app's repository captured at a commit (the
// before arm). A capture left without a brief takes the brief of the suite's
// first-version task on the same app.
export function TasteTaskForm({ suiteId, act }: {
  suiteId: number; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const [form, setForm] = useState({ kind: 'first_version', appSlug: '', appName: '', brief: '', sha: '' });
  const capture = form.kind === 'capture';
  return (
    <div className="space-y-2" id="admin-homeroom-bench-taste-form">
      <p className={AdminUI.label}>Taste eval: add a first version from a brief, or an app captured at a commit</p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className={AdminUI.label} htmlFor="admin-homeroom-bench-taste-kind">Kind</label>
          <select id="admin-homeroom-bench-taste-kind" className={`${AdminUI.select} mt-1`} value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="first_version">First version from a brief</option>
            <option value="capture">Capture an app at a commit (before)</option>
          </select>
        </div>
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

export function SuitesCard({ canWrite, suites, coreSuiteId, onChanged, say }: {
  canWrite: boolean; suites: Suite[]; coreSuiteId: number | null; onChanged: () => void; say: (text: string, tone?: Tone) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'frozen' | 'rotating'>('frozen');
  const [sampleStage, setSampleStage] = useState<Stage>('triage');
  const [sampleN, setSampleN] = useState('10');
  const [candidates, setCandidates] = useState<{ id: number; appSlug: string; issueNumber: number; tags: Record<string, string> }[] | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [imp, setImp] = useState({ appSlug: '', issueNumber: '', prNumber: '' });
  const [editing, setEditing] = useState<{ id: number; appName: string; brief: string; sha: string } | null>(null);
  const suite = suites.find((s) => s.id === selected) || null;

  const loadTasks = useCallback(async (id: number) => {
    try {
      const data = await send(`${BASE}/suites/${id}/tasks`, 'GET');
      setTasks(data.tasks || []);
    } catch (err: any) { say(`Could not read the tasks: ${err.message}`, 'err'); }
  }, [say]);
  useEffect(() => { if (selected) loadTasks(selected); else setTasks(null); }, [selected, loadTasks]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); say(ok); onChanged(); if (selected) loadTasks(selected); } catch (err: any) { say(err.message, 'err'); }
  };
  // Delete a suite made by mistake, after the console's own confirm. The
  // server re-checks every rule; its refusal is shown as it gave it.
  const remove = async (s: Suite) => {
    const label = `${s.name} v${s.version}`;
    const ok = await (window as any).AdminConsole?._confirm({
      title: `Delete ${label}?`,
      message: `This deletes the suite and its ${s.total === 1 ? '1 task' : `${s.total} tasks`}. It cannot be undone.`,
      confirmLabel: 'Delete suite',
      danger: true,
    });
    if (!ok) return;
    try {
      await send(`${BASE}/suites/${s.id}`, 'DELETE');
      if (selected === s.id) setSelected(null);
      say(`${label} is deleted.`);
      onChanged();
    } catch (err: any) { say(err.message, 'err'); }
  };
  const target = (s: Suite, stage: string, want: number) => `${STAGE_LABEL[stage as Stage] || stage} ${s.counts?.[stage] || 0} of ${want}`;
  const saveEdit = () => editing && act(async () => {
    await send(`${BASE}/tasks/${editing.id}/taste`, 'PATCH', {
      appName: editing.appName, brief: editing.brief, ...(editing.sha ? { sha: editing.sha } : {}),
    });
    setEditing(null);
  }, 'Saved: the next run uses the new brief; trials already run keep the one they ran on.');

  return (
    <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-suites">
      <div className={AdminUI.cardHeader}>
        <h3 className={AdminUI.cardTitle}>Suites</h3>
        <span className={AdminUI.cardDescription}>Tasks drawn from real runs; a frozen suite never changes</span>
      </div>
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table} id="admin-homeroom-bench-suite-table">
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>Suite</th>
              <th className={AdminUI.th}>Tasks</th>
              <th className={AdminUI.th}>Labelled</th>
              <th className={AdminUI.th}>State</th>
            </tr>
          </thead>
          <tbody>
            {suites.map((s) => (
              <tr className={AdminUI.trHover} key={s.id} data-bench-suite={s.id} data-bench-suite-taste={isTasteSuite(s) ? s.id : undefined}>
                <td className={AdminUI.td}>
                  <button type="button" className={AdminUI.btn.link} onClick={() => setSelected(selected === s.id ? null : s.id)}>
                    {`${s.name} v${s.version}`}
                  </button>
                  <div className={AdminUI.muted}>{s.kind === 'rotating' ? 'Rotating set' : 'Core'}</div>
                </td>
                <td className={`${AdminUI.td} text-sm`}>
                  {isTasteSuite(s)
                    ? `First versions ${s.counts?.first_version || 0} · Captures ${s.counts?.capture || 0}`
                    : s.kind === 'rotating'
                      ? `${s.total} of 20`
                      : [target(s, 'triage', 40), target(s, 'build', 20), `Follow-ups ${(s.counts?.followup || 0) + (s.counts?.checks_fix || 0)} of 5`, target(s, 'dm', 5)].join(' · ')}
                </td>
                <td className={AdminUI.td}>{`${s.labelled} of ${s.total}`}</td>
                <td className={AdminUI.td}>
                  {s.frozen_at ? <span className={AdminUI.badge.outline}>Frozen</span> : <span className={AdminUI.badge.secondary}>Open</span>}
                  {canWrite ? (
                    <span className="ml-2 inline-flex gap-1">
                      {!s.frozen_at && !(s.id === coreSuiteId && s.labelled < s.total) ? (
                        <button type="button" className={AdminUI.btn.outlineSm}
                          onClick={() => act(() => send(`${BASE}/suites/${s.id}/freeze`, 'POST', {}), `${s.name} v${s.version} is frozen.`)}>Freeze</button>
                      ) : null}
                      <button type="button" className={AdminUI.btn.outlineSm}
                        onClick={() => act(() => send(`${BASE}/suites/${s.id}/version`, 'POST', {}), `A new version of ${s.name}, open for edits.`)}>New version</button>
                      {s.deletable ? (
                        <button type="button" className={AdminUI.btn.destructiveSm} data-bench-suite-delete={s.id}
                          onClick={() => remove(s)}>Delete</button>
                      ) : null}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
            {!suites.length ? (
              <tr><td className={AdminUI.td} colSpan={4} id="admin-homeroom-bench-suites-empty">No suites yet. Make one below, then add runs to it from the verdicts table or the sampler.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {canWrite ? (
        <div className="flex flex-wrap items-end gap-2 mt-4">
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
          <button type="button" className={AdminUI.btn.primarySm} disabled={!name.trim()}
            onClick={() => act(() => send(`${BASE}/suites`, 'POST', { name, kind }), 'Suite made.').then(() => setName(''))}>Make suite</button>
        </div>
      ) : null}

      {suite ? (
        <div className="mt-4 space-y-3" id="admin-homeroom-bench-tasks">
          <div className={AdminUI.separator} />
          <p className={AdminUI.label}>{`Tasks in ${suite.name} v${suite.version}`}</p>
          {tasks == null ? <p className={AdminUI.loading}>Loading…</p> : (
            <div className={AdminUI.tableWrap}>
              <table className={AdminUI.table}>
                <thead className={AdminUI.thead}>
                  <tr>
                    <th className={AdminUI.th}>Stage</th><th className={AdminUI.th}>Request</th>
                    <th className={AdminUI.th}>Tags</th><th className={AdminUI.th}>Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (t.taste ? (
                    <tr className={AdminUI.trHover} key={t.id} data-bench-task={t.id} data-bench-taste-task={t.stage}>
                      <td className={AdminUI.td}>{STAGE_LABEL[t.stage]}</td>
                      <td className={AdminUI.td} colSpan={2}>
                        {editing?.id === t.id ? (
                          <div className="space-y-2">
                            <input aria-label="The app's name" className={AdminUI.input} value={editing.appName} maxLength={80}
                              onChange={(e) => setEditing({ ...editing, appName: e.target.value })} />
                            <textarea aria-label="The brief" className={AdminUI.textarea} rows={5} value={editing.brief}
                              onChange={(e) => setEditing({ ...editing, brief: e.target.value })} />
                            {t.stage === 'capture' ? (
                              <input aria-label="Commit" className={AdminUI.input} value={editing.sha} maxLength={40}
                                onChange={(e) => setEditing({ ...editing, sha: e.target.value })} />
                            ) : null}
                          </div>
                        ) : (
                          <>
                            <span className="font-medium">{t.taste.appName}</span>
                            <span className={`${AdminUI.muted} ml-1`}>{t.app_slug || 'an app no longer here'}</span>
                            {t.taste.placeholder ? <span className={`${AdminUI.badge.warn} ml-1`} data-bench-taste-placeholder={t.id}>placeholder brief: not run</span> : null}
                            {t.stage === 'capture' && t.taste.sha ? <span className={`${AdminUI.badge.outline} ml-1`}>{`at ${t.taste.sha.slice(0, 7)}`}</span> : null}
                            <span className={`${AdminUI.muted} block`}>{t.taste.brief.length > 180 ? `${t.taste.brief.slice(0, 179)}…` : t.taste.brief}</span>
                          </>
                        )}
                      </td>
                      <td className={`${AdminUI.td} text-sm`}>
                        {editing?.id === t.id ? (
                          <span className="inline-flex gap-1">
                            <button type="button" className={AdminUI.btn.primarySm} onClick={saveEdit}>Save</button>
                            <button type="button" className={AdminUI.btn.outlineSm} onClick={() => setEditing(null)}>Cancel</button>
                          </span>
                        ) : (
                          <>
                            Judged against its brief
                            {canWrite && !suite.frozen_at ? (
                              <>
                                <button type="button" className={`${AdminUI.btn.ghost} ml-2 text-xs`} data-bench-taste-edit={t.id}
                                  onClick={() => setEditing({ id: t.id, appName: t.taste!.appName, brief: t.taste!.brief, sha: t.taste!.sha || '' })}>edit</button>
                                <button type="button" className={`${AdminUI.btn.ghost} ml-1 text-xs`}
                                  onClick={() => act(() => send(`${BASE}/tasks/${t.id}`, 'DELETE'), 'Task removed.')}>remove</button>
                              </>
                            ) : null}
                          </>
                        )}
                      </td>
                    </tr>
                  ) : (
                    <tr className={AdminUI.trHover} key={t.id} data-bench-task={t.id}>
                      <td className={AdminUI.td}>{STAGE_LABEL[t.stage]}</td>
                      <td className={AdminUI.td}>{`${t.app_slug || 'an app no longer here'} #${t.issue_number ?? ''}`}{t.snapshot_source === 'import' ? <span className={`${AdminUI.badge.outline} ml-1`}>from a PR</span> : null}{scriptedAnswer(t) ? <span className={`${AdminUI.badge.outline} ml-1`} data-bench-scripted={t.id}>scripted answer</span> : null}</td>
                      <td className={`${AdminUI.td} text-sm`}>{['verdict', 'repo_size', 'request_type', 'difficulty'].map((k) => t.tags?.[k]).filter(Boolean).join(' · ')}</td>
                      <td className={`${AdminUI.td} text-sm`}>
                        {!t.reference_source && scriptedAnswer(t) ? 'Waiting for its label and the answer written for the requester' : t.reference_source ? `${String(t.reference?.verdict || t.reference?.action || (t.reference?.reference_pr ? `PR #${t.reference.reference_pr}` : 'set'))} (by ${t.reference_source === 'opus' ? 'the judge' : t.reference_source === 'merged_pr' ? 'a merged PR' : t.reference_source === 'authored' ? 'the suite\'s author' : 'a person'})` : 'Waiting for its label'}
                        {canWrite && !suite.frozen_at ? (
                          <button type="button" className={`${AdminUI.btn.ghost} ml-2 text-xs`}
                            onClick={() => act(() => send(`${BASE}/tasks/${t.id}`, 'DELETE'), 'Task removed.')}>remove</button>
                        ) : null}
                      </td>
                    </tr>
                  )))}
                  {!tasks.length ? <tr><td className={AdminUI.td} colSpan={4}>No tasks yet.</td></tr> : null}
                </tbody>
              </table>
            </div>
          )}
          {canWrite && !suite.frozen_at ? (
            <>
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
                    const data = await send(`${BASE}/sample?suiteId=${suite.id}&stage=${sampleStage}&n=${Number(sampleN) || 10}`, 'GET');
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
                      await send(`${BASE}/suites/${suite.id}/tasks`, 'POST', { runIds: ids, stage: sampleStage });
                      setCandidates(null);
                    }, 'Added to the suite.')}>Add the ticked ones</button>
                  ) : <p className={AdminUI.muted}>Nothing to propose: no recorded run at that stage can be replayed yet.</p>}
                </div>
              ) : null}
              <div className="flex flex-wrap items-end gap-2" id="admin-homeroom-bench-import">
                <div>
                  <label className={AdminUI.label} htmlFor="admin-homeroom-bench-import-app">Build task from a merged PR: app</label>
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
                  const data = await send(`${BASE}/suites/${suite.id}/import-pr`, 'POST', {
                    appSlug: imp.appSlug.trim(), issueNumber: Number(imp.issueNumber), prNumber: Number(imp.prNumber),
                  });
                  setImp({ appSlug: imp.appSlug, issueNumber: '', prNumber: '' });
                  return data;
                }, 'Imported: the request as it stood when the PR opened, its base commit, and the checks it added as hidden checks.')}>Import</button>
              </div>
              <TasteTaskForm suiteId={suite.id} act={act} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The stages a suite has tasks at, in the order the launcher lists them. */
function stagesWithTasks(suite: Suite | undefined): Stage[] {
  return suite ? STAGES.filter((st) => (suite.counts?.[st] || 0) > 0) : [];
}

/**
 * "Run the full benchmark". It opens on every candidate model and every
 * stage the suite has tasks at, triage three times (pass^k is read from
 * those), and as many trials at once as the lane allows. Each change asks
 * the server what the launch would be (POST runs/estimate), so the trials,
 * the likely cost (and the most it could cost), about how long it takes and
 * the cap are on screen before anything is spent. The cap follows the
 * server's suggestion (services/bench/lane.js suggestCap) until it is set by
 * hand; a cap below the likely cost says the run will stop early.
 */
export function Launcher({ suites, models, defaults, launcher, hiddenChecks, onLaunched, say }: {
  suites: Suite[]; models: Model[]; defaults: { capUsd: number; repeats: number; maxConcurrency: number };
  launcher: LauncherDefaults | null; hiddenChecks: string; onLaunched: () => void; say: (text: string, tone?: Tone) => void;
}) {
  const [suiteId, setSuiteId] = useState(launcher?.suiteId ? String(launcher.suiteId) : '');
  const [chosen, setChosen] = useState<Record<string, boolean>>(() => Object.fromEntries((launcher?.models || []).map((id) => [id, true])));
  const [extra, setExtra] = useState('');
  // null: every stage the picked suite has tasks at. An object once ticked by hand.
  const [stagesPicked, setStagesPicked] = useState<Record<string, boolean> | null>(null);
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
  const stages = stagesPicked ? STAGES.filter((st) => stagesPicked[st]) : allStages;
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
  const short = estimate && Number.isFinite(capUsd) && capUsd < estimate.likelyUsd;
  const tight = estimate && !short && Number.isFinite(capUsd) && capUsd < estimate.estimateUsd;
  const launch = async () => {
    setLaunching(true);
    try {
      const data = await send(`${BASE}/runs`, 'POST', body);
      say(`Run ${data.run.id} launched: ${data.trials} trials (${data.notApplicable} not applicable), estimated $${data.estimateUsd} against a $${Number(data.run.cap_usd).toFixed(2)} cap.${data.suiteFrozen ? '' : ' The suite is not frozen, so these results describe a set that can still change.'}`);
      onLaunched();
    } catch (err: any) { say(`Not launched: ${err.message}`, 'err'); }
    finally { setLaunching(false); }
  };
  const tick = (st: Stage, on: boolean) => setStagesPicked({ ...Object.fromEntries(stages.map((s) => [s, true])), [st]: on });
  const stageWords = stages.map((st) => ((st === 'triage' || st === 'first_version') && Number(repeats) > 1 ? `${STAGE_LABEL[st]} ×${repeats}` : STAGE_LABEL[st])).join(' · ');

  return (
    <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-launch">
      <div className={AdminUI.cardHeader}>
        <h3 className={AdminUI.cardTitle}>Run the full benchmark</h3>
        <span className={AdminUI.cardDescription}>Same prompts, worker and clocks as the bot; nothing is posted</span>
      </div>
      <p className="text-sm" id="admin-homeroom-bench-launch-summary">
        {suite ? `${suite.name} v${suite.version}${suite.frozen_at ? '' : ' (not frozen)'}` : 'No suite yet'}
        {` · ${modelIds.length} model${modelIds.length === 1 ? '' : 's'} · ${stageWords || 'no stage picked'}`}
      </p>
      <div className="flex flex-wrap gap-1.5 mt-2" id="admin-homeroom-bench-launch-models">
        {modelIds.map((id) => (
          <span key={id} className={id === launcher?.models?.[0] ? AdminUI.badge.secondary : AdminUI.badge.outline}>
            {`${shortModel(id, models)}${id === launcher?.models?.[0] ? ', baseline' : ''}`}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4" id="admin-homeroom-bench-estimate">
        {[
          ['Trials', estimate ? estimate.trials.toLocaleString() : '…', 'admin-homeroom-bench-estimate-trials',
            estimate && estimate.notApplicable ? `${estimate.notApplicable} not applicable` : ''],
          ['Likely cost', estimate ? `$${estimate.likelyUsd.toFixed(2)}` : '…', 'admin-homeroom-bench-estimate-cost',
            estimate ? `at most $${estimate.estimateUsd.toFixed(2)}` : ''],
          ['About how long', estimate ? duration(estimate.estimatedMs) : '…', 'admin-homeroom-bench-estimate-time', estimate ? 'at the least' : ''],
          ['Cap', Number.isFinite(capUsd) ? `$${capUsd.toFixed(2)}` : '…', 'admin-homeroom-bench-estimate-cap', capByHand ? 'set by hand' : 'suggested'],
        ].map(([label, value, id, sub]) => (
          <div key={id} className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3" id={id}>
            <div className={AdminUI.muted}>{label}</div>
            <div className="text-xl font-semibold mt-0.5 tabular-nums">{value}</div>
            {sub ? <div className={AdminUI.muted}>{sub}</div> : null}
          </div>
        ))}
      </div>
      <p className={`${AdminUI.muted} mt-2`} id="admin-homeroom-bench-estimate-note">
        {estimateError
          ? `No estimate: ${estimateError}`
          : estimate
            ? `Likely: what each model's trials have cost so far, or, for a model with none yet, its price scaled by how far the price-based guess overshot ${estimate.calibratedFrom ? `on the ${estimate.calibratedFrom} model and stage pairs that have run` : 'on earlier runs (none yet, so it is the guess itself)'}. At most: every trial costing what the dearest tenth have. Time is a floor: live builds a person is waiting for go first.`
            : 'Working out the estimate…'}
      </p>
      {short ? (
        <p className="text-sm text-amber-800 dark:text-amber-300 mt-1" id="admin-homeroom-bench-cap-warning">
          {`The cap is below the likely cost. The run stops when the next trial would cross $${capUsd.toFixed(2)}, and every trial left is skipped, so later tasks may not run on any model.`}
        </p>
      ) : tight ? (
        <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bench-cap-note">
          The cap covers the likely cost but not the most it could cost: if trials cost more than they have so far, the run stops early at the cap.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 mt-4">
        <button type="button" className={AdminUI.btn.primary} id="admin-homeroom-bench-launch-go"
          disabled={!suiteId || !modelIds.length || !stages.length || launching || !Number.isFinite(capUsd)} onClick={launch}>
          {`${everything ? 'Run everything' : 'Launch'}${Number.isFinite(capUsd) ? `, up to $${capUsd.toFixed(2)}` : ''}`}
        </button>
      </div>

      <details className="mt-4" id="admin-homeroom-bench-launch-settings">
        <summary className={`${AdminUI.btn.link} text-sm cursor-pointer`}>Change settings</summary>
        <div className="grid gap-4 md:grid-cols-2 mt-3">
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-suite">Suite</label>
            <select id="admin-homeroom-bench-launch-suite" className={`${AdminUI.select} mt-1`} value={suiteId}
              onChange={(e) => { setSuiteId(e.target.value); setStagesPicked(null); }}>
              {suites.map((s) => <option key={s.id} value={s.id}>{`${s.name} v${s.version}${s.frozen_at ? '' : ' (not frozen)'}`}</option>)}
            </select>
            <p className={`${AdminUI.label} mt-3`}>Stages</p>
            <div className="flex flex-wrap gap-3 mt-1">
              {STAGES.map((st) => (
                <label key={st} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={stages.includes(st)} disabled={!(suite?.counts?.[st])}
                    onChange={(e) => tick(st, e.target.checked)} />
                  <span>{`${STAGE_LABEL[st]}${suite ? ` (${suite.counts?.[st] || 0})` : ''}`}</span>
                </label>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 mt-3">
              <div>
                <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-repeats">{stages.includes('first_version') ? 'Repeats' : 'Triage repeats'}</label>
                <input id="admin-homeroom-bench-launch-repeats" type="number" min="1" max="5" className={`${AdminUI.input} mt-1`}
                  value={repeats} onChange={(e) => setRepeats(e.target.value)} />
              </div>
              <div>
                <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-cap">Cap, dollars</label>
                <input id="admin-homeroom-bench-launch-cap" type="number" min="0.5" max="1000" step="1" className={`${AdminUI.input} mt-1`}
                  value={cap} onChange={(e) => { setCap(e.target.value); setCapByHand(true); }} />
              </div>
              <div>
                <label className={AdminUI.label} htmlFor="admin-homeroom-bench-launch-concurrency">At once</label>
                <select id="admin-homeroom-bench-launch-concurrency" className={`${AdminUI.select} mt-1`} value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}>
                  {Array.from({ length: defaults.maxConcurrency }, (_, i) => String(i + 1)).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            </div>
            {capByHand ? (
              <button type="button" className={`${AdminUI.btn.ghost} text-xs mt-1`} id="admin-homeroom-bench-launch-cap-auto"
                onClick={() => setCapByHand(false)}>Set the cap from the estimate again</button>
            ) : null}
            <label className="flex items-center gap-1.5 text-sm mt-2">
              <input type="checkbox" id="admin-homeroom-bench-launch-repeat-all" checked={repeatAll} onChange={(e) => setRepeatAll(e.target.checked)} />
              <span>Repeat DM and follow-ups too</span>
            </label>
            <p className={`${AdminUI.muted} mt-2`}>
              Repeats apply to triage (pass^k is read from them) and first versions, and to DM and follow-ups when ticked; everything else runs once per model, and a capture once a run.
              The bench waits while the bot&apos;s live builds use every build slot.
            </p>
            <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bench-hidden-checks">{`Build trials: ${hiddenChecks}.`}</p>
          </div>
          <div>
            <p className={AdminUI.label}>Models</p>
            <div className="mt-1 space-y-1" id="admin-homeroom-bench-models">
              {models.map((m) => (
                <label key={m.id} className="flex items-start gap-2 text-sm" data-bench-model={m.id}>
                  <input type="checkbox" className="mt-1" checked={!!chosen[m.id]} onChange={(e) => setChosen({ ...chosen, [m.id]: e.target.checked })} />
                  <span>
                    <span className="font-medium">{m.label}</span>
                    {m.role ? <span className={`${AdminUI.badge.outline} ml-1`}>{m.role}</span> : null}
                    <span className={`${AdminUI.muted} block`}>
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
            <label className={`${AdminUI.label} block mt-3`} htmlFor="admin-homeroom-bench-launch-extra">Other OpenRouter models</label>
            <input id="admin-homeroom-bench-launch-extra" className={`${AdminUI.input} mt-1`} value={extra} placeholder="vendor/model, vendor/model"
              onChange={(e) => setExtra(e.target.value)} />
          </div>
        </div>
      </details>
    </div>
  );
}

// ── Best model for each stage ──────────────────────────────────────────

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
 * The answer, a block per stage: its models ranked by accuracy, each with
 * how many graded tasks it rests on and what a success cost; one with too
 * few graded tasks is drawn faint and says so; the best value is outlined
 * and named in the stage's heading. Blocks of cells rather than a table, so
 * eight models fit a phone without a sideways scroll. "Use for <stage>"
 * hands the model to the bot's Settings form, which still needs its Save
 * (#3710).
 */
export function BestModels({ best, models, suiteName, canUse, onUseModel }: {
  best: Best | null; models: Model[]; suiteName: string;
  canUse: boolean; onUseModel?: (stage: 'triage' | 'spec' | 'build' | 'followup', model: string) => void;
}) {
  const name = (id: string) => shortModel(id, models);
  return (
    <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-best">
      <div className={AdminUI.cardHeader}>
        <h3 className={AdminUI.cardTitle}>Best model for each stage</h3>
        <span className={AdminUI.cardDescription}>{suiteName ? `${suiteName}: the latest graded result per stage and model, across runs` : 'Across runs'}</span>
      </div>
      {best == null ? <p className={AdminUI.loading}>Loading…</p> : !best.stages.length ? (
        <p className={AdminUI.muted} id="admin-homeroom-bench-best-empty">Nothing graded on this suite yet. Run the benchmark, then ask an admin&apos;s Claude session to grade it.</p>
      ) : (
        <>
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
          <p className={`${AdminUI.muted} mt-4`}>
            The best value is the cheapest success among the models within five points of the most accurate. A faint
            cell rests on too few graded tasks to compare. Use for a stage fills in the bot&apos;s Settings; nothing changes
            until you press Save there. A checks fix runs on the bot&apos;s follow-up model; DM answers run on the platform default.
          </p>
        </>
      )}
    </div>
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

// #3737: the taste eval's arms side by side: how often each rubric criterion
// held, and the automatic checks and tells as averages per trial.
export function TasteTable({ rows, name }: { rows: Row[]; name: (id: string) => string }) {
  const line = (label: string, value: (t: TasteCell) => string, key: string) => (
    <tr className={AdminUI.trHover} key={key}>
      <td className={DENSE_TD}>{label}</td>
      {rows.map((r) => <td className={`${DENSE_TD} tabular-nums`} key={`${r.stage}-${r.model}`}>{value(r.taste as TasteCell)}</td>)}
    </tr>
  );
  return (
    <div id="admin-homeroom-bench-taste">
      <p className={AdminUI.label}>Taste, arm by arm</p>
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table} id="admin-homeroom-bench-taste-table">
          <thead className={AdminUI.thead}>
            <tr>
              <th className={DENSE_TH}>Criterion</th>
              {/* A capture runs no model: its column is the arm alone. */}
              {rows.map((r) => <th className={DENSE_TH} key={`${r.stage}-${r.model}`}>{r.stage === 'capture' ? STAGE_LABEL[r.stage] : `${STAGE_LABEL[r.stage]}, ${name(r.model)}`}</th>)}
            </tr>
          </thead>
          <tbody>
            {TASTE_CRITERIA.map((c) => line(c.label, (t) => {
              const got = t.criteria?.[c.id];
              return got ? `${pctOrDash(got.rate)} of ${got.n}` : '–';
            }, c.id))}
            {line('Booted', (t) => pctOrDash(t.bootedRate), 'booted')}
            {line('Console errors', (t) => numOrDash(t.checks?.consoleErrors), 'console')}
            {line('Overflow at 360 px', (t) => numOrDash(t.checks?.overflowAt360px), 'overflow')}
            {line('Tap targets under 44 px', (t) => numOrDash(t.checks?.tapTargetsUnder44px), 'tap')}
            {line('Low-contrast text, light / dark', (t) => `${numOrDash(t.checks?.lowContrastLight)} / ${numOrDash(t.checks?.lowContrastDark)}`, 'contrast')}
            {line('Tells: emoji, eyebrows, text-[px], hex', (t) => [t.tells?.emojiIcons, t.tells?.uppercaseEyebrows, t.tells?.arbitraryTextSizes, t.tells?.hexColours].map(numOrDash).join(' · '), 'tells')}
          </tbody>
        </table>
      </div>
      <p className={`${AdminUI.muted} mt-1`}>Criteria: the share of graded trials where the judge (or a person) said it held. Checks and tells: the average per trial.</p>
    </div>
  );
}

function Results({ runId, models, canWrite, say }: { runId: number; models: Model[]; canWrite: boolean; say: (text: string, tone?: Tone) => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [slice, setSlice] = useState('verdict');
  const [stage, setStage] = useState<Stage | ''>('');
  const [review, setReview] = useState<Review[] | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await send(`${BASE}/runs/${runId}/report?slice=${slice}`, 'GET');
      setReport(data);
      setStage((s) => s || (data.run.stages?.[0] ?? ''));
    } catch (err: any) { say(`Could not read the results: ${err.message}`, 'err'); }
  }, [runId, slice, say]);
  useEffect(() => { load(); }, [load]);
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
  if (!report) return <p className={AdminUI.loading} id="admin-homeroom-bench-results-loading">Loading…</p>;
  const name = (id: string) => shortModel(id, models);
  const a = report.agreement;
  return (
    <div className="space-y-4" id="admin-homeroom-bench-report">
      <p className={AdminUI.muted}>
        {`${report.run.suiteName} v${report.run.suiteVersion}${report.run.suiteFrozen ? '' : ' (not frozen)'}, baseline ${name(report.run.baseline)}. `}
        {`${usd(report.run.spentUsd)} of a ${usd(report.run.capUsd)} cap. Platform faults are kept out of accuracy; a timeout counts as a fail.`}
      </p>
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table} id="admin-homeroom-bench-results-table">
          <thead className={AdminUI.thead}>
            <tr>
              {['Stage and model', 'Accuracy', 'pass^k', 'Cost', 'Time', 'Faults', 'Not graded'].map((h) => (
                <th className={DENSE_TH} key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => {
              const notApplicable = r.trials > 0 && r.notApplicable === r.trials;
              return (
                <tr className={AdminUI.trHover} key={`${r.stage}-${r.model}`} data-bench-row={`${r.stage}:${r.model}`}>
                  <td className={DENSE_TD}>
                    <span className="font-medium">{name(r.model)}</span>
                    {r.baseline ? <span className={`${AdminUI.badge.outline} ml-1`}>baseline</span> : null}
                    <span className={`${AdminUI.muted} block`}>{STAGE_LABEL[r.stage]}</span>
                  </td>
                  <td className={DENSE_TD}>
                    {notApplicable ? 'not applicable' : pct(r.accuracy)}
                    <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : `${r.pass} of ${r.graded} graded`}</span>
                  </td>
                  <td className={DENSE_TD}>
                    {notApplicable ? '' : r.passK.k > 1 ? pct(r.passK.value) : 'once each'}
                    <span className={`${AdminUI.muted} block`}>{!notApplicable && r.passK.k > 1 ? `all ${r.passK.k} right, of ${r.passK.tasks} tasks` : ''}</span>
                  </td>
                  <td className={DENSE_TD}>
                    {notApplicable ? '' : `${usd(r.costPerAttempt, 3)} an attempt`}
                    <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : r.costPerSuccess == null ? 'no success yet' : `${usd(r.costPerSuccess, 3)} a success`}</span>
                  </td>
                  <td className={`${DENSE_TD} whitespace-nowrap`}>
                    {notApplicable ? '' : `${secs(r.p50Ms)} median`}
                    <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : `${secs(r.p95Ms)} p95`}</span>
                  </td>
                  <td className={DENSE_TD}>
                    {notApplicable ? '' : `${pct(r.timeoutRate)} timed out`}
                    <span className={`${AdminUI.muted} block`}>{notApplicable ? '' : `${pct(r.infraRate)} platform`}</span>
                  </td>
                  <td className={`${DENSE_TD} text-sm`}>
                    {[r.pending ? `${r.pending} for the judge` : null, r.unlabelled ? `${r.unlabelled} unlabelled` : null,
                      r.notApplicable ? `${r.notApplicable} not applicable` : null, r.skippedCap ? `${r.skippedCap} skipped at the cap` : null]
                      .filter(Boolean).join(', ')}
                  </td>
                </tr>
              );
            })}
            {!report.rows.length ? <tr><td className={DENSE_TD} colSpan={7}>No trials yet.</td></tr> : null}
          </tbody>
        </table>
      </div>

      {report.rows.some((r) => r.taste) ? <TasteTable rows={report.rows.filter((r) => r.taste)} name={name} /> : null}

      <div>
        <p className={AdminUI.label}>Against the baseline</p>
        <div className={AdminUI.tableWrap}>
          <table className={AdminUI.table} id="admin-homeroom-bench-paired">
            <thead className={AdminUI.thead}>
              <tr>{['Stage', 'Model', 'Difference', '95% interval', 'Tasks (apps)'].map((h) => <th className={AdminUI.th} key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {report.paired.filter((p) => p.n > 0).map((p) => (
                <tr className={AdminUI.trHover} key={`${p.stage}-${p.model}`}>
                  <td className={AdminUI.td}>{STAGE_LABEL[p.stage]}</td>
                  <td className={AdminUI.td}>{name(p.model)}</td>
                  <td className={AdminUI.td}>{p.diff == null ? 'not yet' : `${p.diff >= 0 ? '+' : ''}${Math.round(p.diff * 100)} points`}</td>
                  <td className={AdminUI.td}>{p.low == null || p.high == null ? 'not yet' : `${Math.round(p.low * 100)} to ${Math.round(p.high * 100)}`}</td>
                  <td className={AdminUI.td}>{`${p.n} (${p.apps})`}</td>
                </tr>
              ))}
              {!report.paired.length ? <tr><td className={AdminUI.td} colSpan={5}>Only the baseline ran.</td></tr> : null}
              {report.paired.length && !report.paired.some((p) => p.n > 0) ? <tr><td className={AdminUI.td} colSpan={5}>No task is graded on both a model and the baseline yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <p className={`${AdminUI.muted} mt-1`}>Each task scored on both models (the mean of its attempts); the interval resamples apps, not tasks, so one busy app cannot make it look surer than it is.</p>
      </div>

      <div>
        <div className="flex flex-wrap items-end gap-2">
          <p className={AdminUI.label}>Cost against quality</p>
          <div className="w-48">
            <select aria-label="Stage for the chart" className={AdminUI.select} value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
              {report.run.stages.map((st) => <option key={st} value={st}>{STAGE_LABEL[st]}</option>)}
            </select>
          </div>
        </div>
        <ParetoChart points={report.pareto.filter((p) => p.stage === stage)} models={models} />
      </div>

      <div>
        <div className="flex flex-wrap items-end gap-2">
          <p className={AdminUI.label}>Slices by</p>
          <div className="w-48">
            <select aria-label="Tag to slice by" className={AdminUI.select} value={slice} onChange={(e) => setSlice(e.target.value)} id="admin-homeroom-bench-slice">
              {report.slice.keys.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
            </select>
          </div>
        </div>
        <div className={AdminUI.tableWrap}>
          <table className={AdminUI.table} id="admin-homeroom-bench-slices">
            <thead className={AdminUI.thead}><tr>{['Stage', report.slice.key.replace('_', ' '), 'Model', 'Accuracy'].map((h) => <th className={AdminUI.th} key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {report.slice.groups.filter((g) => g.n > 0).map((g) => (
                <tr className={AdminUI.trHover} key={`${g.stage}-${g.value}-${g.model}`}>
                  <td className={AdminUI.td}>{STAGE_LABEL[g.stage]}</td>
                  <td className={AdminUI.td}>{g.value}</td>
                  <td className={AdminUI.td}>{name(g.model)}</td>
                  <td className={AdminUI.td}>{`${pct(g.accuracy)} of ${g.n}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div id="admin-homeroom-bench-judge">
        <p className={AdminUI.label}>The judge</p>
        <p className={AdminUI.muted} id="admin-homeroom-bench-agreement">
          {a.n ? judgeLine(a) : 'No person has spot-checked the judge on this run yet.'}
          {' Grades come from an admin\'s Claude session through the Homeroom connector: ask it to "grade the pending benchmark items".'}
        </p>
        <button type="button" className={`${AdminUI.btn.outlineSm} mt-2`} onClick={loadReview} id="admin-homeroom-bench-spot-check">Spot-check judged trials</button>
        {review ? (
          <div className="mt-2 space-y-3">
            {review.map((r) => (
              <div key={r.trialId} className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3 text-sm" data-bench-review={r.trialId}>
                <p className="font-medium">{`${stageLabel(r.item.stage)}: ${r.item.task.appName || r.item.task.issueTitle || 'a request'}`}</p>
                {r.item.shots?.length ? <TasteShots shots={r.item.shots} /> : null}
                <details className="mt-1">
                  <summary className={`${AdminUI.muted} cursor-pointer`}>What the candidate said (model hidden)</summary>
                  <pre className="whitespace-pre-wrap break-words text-xs mt-1">{JSON.stringify(r.item.candidate, null, 1)}</pre>
                  <p className={`${AdminUI.muted} mt-1`}>{`Reference: ${JSON.stringify(r.item.reference)}`}</p>
                </details>
                <p className="mt-1">{`Judge: ${r.opus?.verdict || 'not graded'}. ${r.opus?.critique || ''}`}</p>
                {r.human ? <p className={AdminUI.muted}>{`A person said ${r.human.verdict}.`}</p> : null}
                {canWrite ? (
                  <span className="inline-flex gap-1 mt-1">
                    <button type="button" className={AdminUI.btn.outlineSm} onClick={() => override(r.trialId, 'pass')}>Pass</button>
                    <button type="button" className={AdminUI.btn.outlineSm} onClick={() => override(r.trialId, 'fail')}>Fail</button>
                  </span>
                ) : null}
              </div>
            ))}
            {!review.length ? <p className={AdminUI.muted}>Nothing judged on this run yet.</p> : null}
          </div>
        ) : null}
      </div>
      {canWrite ? (
        <a className={AdminUI.btn.outlineSm} href={`${BASE}/runs/${runId}/trials.csv`} download id="admin-homeroom-bench-csv">Download trials as CSV</a>
      ) : null}
    </div>
  );
}

// How many of a suite's newest runs the matrix reads: enough to cover a full
// run and the partial ones before it, few enough to load at once.
const MATRIX_RUNS = 8;

/**
 * The suite the matrix answers for (the one the launcher starts on, else the
 * newest run's) and its newest runs that ran anything. Pure, and shared by
 * the Benchmark tab and the bot's Settings, so both read the same answer.
 */
export function matrixRunsFor(runs: Run[], launcher: LauncherDefaults | null): { suiteId: number | null; runs: Run[] } {
  const suiteId = launcher?.suiteId ?? runs[0]?.suite_id ?? null;
  return { suiteId, runs: runs.filter((r) => r.suite_id === suiteId && runCounts(r).ran > 0).slice(0, MATRIX_RUNS) };
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

export function BenchmarkArea({ canWrite, onUseModel }: {
  canWrite: boolean;
  onUseModel?: (stage: 'triage' | 'spec' | 'build' | 'followup', model: string) => void;
}) {
  const [suites, setSuites] = useState<Suite[]>([]);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [defaults, setDefaults] = useState({ capUsd: 50, repeats: 3, maxConcurrency: 8 });
  const [hiddenChecks, setHiddenChecks] = useState('');
  const [launcher, setLauncher] = useState<LauncherDefaults | null>(null);
  const [core, setCore] = useState<CoreStatus | null>(null);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [reports, setReports] = useState<Record<number, Report>>({});
  const [status, setStatus] = useState<{ text: string; tone: Tone } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const say = useCallback((text: string, tone: Tone = 'ok') => { if (alive.current) setStatus({ text, tone }); }, []);

  const load = useCallback(async () => {
    try {
      const [s, r, m] = await Promise.all([send(`${BASE}/suites`, 'GET'), send(`${BASE}/runs`, 'GET'), send(`${BASE}/models`, 'GET')]);
      if (!alive.current) return;
      setSuites(s.suites || []);
      setRuns(r.runs || []);
      setDefaults(r.defaults || defaults);
      setHiddenChecks(r.hiddenChecks || '');
      setLauncher(r.launcher || null);
      setModels(m.models || []);
      setSelectedRun((cur) => cur ?? (r.runs?.[0]?.id ?? null));
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

  const { suiteId: matrixSuiteId, runs: matrixRuns } = matrixRunsFor(runs || [], launcher);
  const matrixSuite = suites.find((s) => s.id === matrixSuiteId);
  const matrixKey = matrixRuns.map((r) => `${r.id}:${r.status}:${runCounts(r).ran}`).join(',');
  // Each run's report, for the matrix and for the runs still waiting on the
  // judge. A finished run's report is read once per visit; a running one
  // again whenever the list moves.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const want = matrixRuns.filter((r) => !reports[r.id] || r.status === 'running' || r.status === 'queued');
      if (!want.length) return;
      const got = await Promise.all(want.map(async (r) => {
        try { return [r.id, await send(`${BASE}/runs/${r.id}/report`, 'GET')] as const; } catch { return null; }
      }));
      if (cancelled || !alive.current) return;
      setReports((cur) => {
        const next = { ...cur };
        for (const g of got) if (g) next[g[0]] = g[1] as Report;
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [matrixKey]);
  const best = runs == null ? null : mergeBest(
    matrixRuns.filter((r) => reports[r.id]).map((r) => ({ runId: r.id, report: reports[r.id] })),
    matrixSuite?.counts, launcher?.models?.[0],
  );
  const pendingJudge = (id: number) => (reports[id]?.rows || []).reduce((s, row) => s + (row.pending || 0), 0);

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

  return (
    <div className="space-y-4" id="admin-homeroom-bench">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Benchmark</h2>
          <span className={AdminUI.cardDescription}>Which model each stage of the bot should run on</span>
        </div>
        <p className={AdminUI.muted} id="admin-homeroom-bench-intro">
          Real requests the bot has seen, replayed on other models with the bot's own prompts, worker and clocks. Nothing is
          posted, messaged or proposed, and every run stops at its dollar cap. Results are graded by rules where a rule can
          tell, and otherwise by Claude Opus on an admin's own plan through the Homeroom connector, blind to the model.
        </p>
        {status ? <p className={`mt-2 text-sm ${status.tone === 'err' ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`} role="status">{status.text}</p> : null}
      </div>

      {canWrite && suites.length ? (
        <Launcher key={launcher?.suiteId ?? 'none'} suites={suites} models={models} defaults={defaults} launcher={launcher}
          hiddenChecks={hiddenChecks} onLaunched={load} say={say} />
      ) : null}

      <BestModels best={best} models={models} suiteName={matrixSuite ? `${matrixSuite.name} v${matrixSuite.version}` : ''}
        canUse={canWrite} onUseModel={onUseModel} />

      <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-runs">
        <div className={AdminUI.cardHeader}>
          <h3 className={AdminUI.cardTitle}>Runs</h3>
          <span className={AdminUI.cardDescription}>Pick one to see its results below</span>
        </div>
        {runs == null ? <p className={AdminUI.loading}>Loading…</p> : (
          <div className={AdminUI.tableWrap}>
            <table className={AdminUI.table} id="admin-homeroom-bench-run-table">
              <thead className={AdminUI.thead}>
                <tr>{['Run', 'Stages', 'Models', 'Ran', 'Spent', 'State'].map((h) => <th className={DENSE_TH} key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const c = runCounts(r);
                  const waiting = pendingJudge(r.id);
                  return (
                    <tr className={AdminUI.trHover} key={r.id} data-bench-run={r.id}>
                      <td className={DENSE_TD}>
                        <button type="button" className={AdminUI.btn.link} aria-pressed={selectedRun === r.id} onClick={() => setSelectedRun(r.id)}>{`Run ${r.id}`}</button>
                        <span className={`${AdminUI.muted} block`}>{`${r.suite_name} v${r.suite_version}`}</span>
                        {r.note ? <span className={`${AdminUI.muted} block`}>{r.note}</span> : null}
                      </td>
                      <td className={`${DENSE_TD} text-sm`}>{(r.stages || []).map((st) => STAGE_LABEL[st as Stage] || st).join(', ')}</td>
                      <td className={`${DENSE_TD} text-sm`}>{r.models.map((m) => shortModel(m, models)).join(', ')}</td>
                      <td className={`${DENSE_TD} tabular-nums`} data-bench-run-ran={r.id}>
                        {`${c.ran} of ${c.planned}`}
                        <span className={`${AdminUI.muted} block`}>
                          {[
                            c.running ? `${c.running} running` : null,
                            c.skipped ? `${c.skipped} skipped at the cap` : null,
                            c.cancelled ? `${c.cancelled} cancelled` : null,
                          ].filter(Boolean).join(', ')}
                        </span>
                      </td>
                      <td className={`${DENSE_TD} tabular-nums`}>{`${usd(r.spent_usd)} of ${usd(r.cap_usd)}`}</td>
                      <td className={DENSE_TD}>
                        <span className={r.status === 'running' ? AdminUI.badge.secondary : r.status === 'capped' ? AdminUI.badge.warn : AdminUI.badge.outline}>{r.status}</span>
                        {waiting ? <span className={`${AdminUI.badge.warn} ml-1`} data-bench-run-judge={r.id}>{`${waiting} for the judge`}</span> : null}
                        {canWrite && (r.status === 'queued' || r.status === 'running') ? (
                          <button type="button" className={`${AdminUI.btn.ghost} ml-2 text-xs`} onClick={async () => {
                            try { await send(`${BASE}/runs/${r.id}/cancel`, 'POST', {}); say(`Run ${r.id} cancelled.`); load(); } catch (err: any) { say(err.message, 'err'); }
                          }}>cancel</button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {!runs.length ? <tr><td className={DENSE_TD} colSpan={6} id="admin-homeroom-bench-runs-empty">No runs yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        )}
        {runs && runs.some((r) => pendingJudge(r.id)) ? (
          <p className={`${AdminUI.muted} mt-2`} id="admin-homeroom-bench-judge-prompt">
            Trials waiting for the judge are graded in an admin&apos;s own Claude session with the Homeroom connector: ask it to &quot;grade the pending benchmark items&quot;.
          </p>
        ) : null}
      </div>

      {selectedRun ? (
        <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bench-results">
          <div className={AdminUI.cardHeader}>
            <h3 className={AdminUI.cardTitle}>{`Results of run ${selectedRun}`}</h3>
          </div>
          <Results key={selectedRun} runId={selectedRun} models={models} canWrite={canWrite} say={say} />
        </div>
      ) : null}

      <details id="admin-homeroom-bench-manage">
        <summary className={`${AdminUI.card} p-4 block cursor-pointer`}>
          <span className={AdminUI.cardTitle}>Suites and labelling</span>
          <span className={`${AdminUI.muted} block mt-1`}>
            {core?.suite
              ? `${core.definition.name} v${core.definition.version}: ${core.suite.total} tasks, ${core.suite.labelled} labelled${core.suite.frozen_at ? ', frozen' : ', not frozen yet'}. Making Core, freezing, new versions, sampling tasks and importing a merged pull request.`
              : 'Making Core, freezing, new versions, sampling tasks and importing a merged pull request.'}
          </span>
        </summary>
        <div className="space-y-4 mt-4">
          <CorePanel status={core} canWrite={canWrite} onMaterialize={materializeCore} onFreeze={freezeCore} />
          <SuitesCard canWrite={canWrite} suites={suites} coreSuiteId={core?.suite?.id ?? null} onChanged={() => { load(); loadCore(); }} say={say} />
        </div>
      </details>
    </div>
  );
}
