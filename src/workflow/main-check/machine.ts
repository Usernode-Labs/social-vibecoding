// main-check: the safety net under direct merges. One instance per app
// (`app:<id>`), created by the first check asked of it.
//
// A proposal's checks judge its own head against the main of the time, and
// it then merges as it stands, so every merge lands a tree nobody ran the
// checks against as a whole. So after each merge (merge-followups' message),
// and on any new main the drift poller sees, the repo's own unit suite runs
// once more on the commit (services/main-watch.js has the run and the rules
// it applies, and the history of each). Red PAUSES the app's merges (the
// merge gate's main_healthy step reads apps.main_check_paused_sha) until a
// green verdict or an admin's Resume.
//
//   idle ─CheckRequested→ running ─red→ confirming ─→ idle (a verdict)
//                            └───────green / error / skipped───→ idle
//   idle (paused) ─RecheckDue→ rechecking ─→ idle
//
//   - A first red is provisional: merges pause and the suite runs again.
//     Green then is passing (the flaky tests are recorded and a request
//     filed for each); red again is a confirmed red (a request to fix it is
//     filed for the Homeroom bot); red on other tests only is flakes; a
//     re-run that could not happen leaves the first red standing.
//   - A red made only of tests known to flake pauses nothing.
//   - A paused red is asked again by itself: after confirmRetryMs when its
//     confirmation could not run, after recheckMs when it was confirmed, at
//     most maxRechecks times (the instance's deadline).
//   - A newer commit while a run is under way: its own first run starts, and
//     the older run's verdict is recorded as superseded and changes nothing.
//
// Everything a run needs between its steps (the first red and its excerpts,
// whether merges were paused when it started) is the instance's, and the
// suite's run is resumable work: a process that dies mid-suite leaves the
// run to the next one, which reads its Jobs. The apps.main_check_* columns
// are the instance's projection.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Check, DomainWrite, Event, Json, Machine, MessageRequest, Outcome, TransitionContext, Tx, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { NO_FACTS, readFacts, testKey } from './facts.ts';
import type { Facts, Row } from './facts.ts';
import { parseGithubUrl as parseRepo } from '../rules/github-url.ts';

export const MACHINE = 'main-check';
export const appKey = (appId: number) => `app:${appId}`;

export const WORK = Object.freeze({
  suite: 'main.suite',
  flakes: 'main.flakes',
  fix: 'main.fixRequest',
});

export interface Deps {
  enabled: boolean;          // MAIN_WATCH_ENABLED
  confirm: boolean;          // MAIN_WATCH_CONFIRM: re-run a first red
  maxRechecks: number;       // MAIN_WATCH_RECHECKS
  recheckMs: number;         // MAIN_WATCH_RECHECK_MS
  confirmRetryMs: number;    // MAIN_WATCH_CONFIRM_RETRY_MS
}
export const DEFAULTS: Deps = { enabled: true, confirm: true, maxRechecks: 3, recheckMs: 15 * 60 * 1000, confirmRetryMs: 3 * 60 * 1000 };

// The switches, from the environment (each defaults to the above).
export function depsFromEnv(env: Record<string, string | undefined>): Deps {
  const on = (name: string) => !['0', 'false', 'off'].includes(String(env[name] ?? '1').trim().toLowerCase());
  const int = (name: string, fallback: number) => {
    const v = parseInt(String(env[name] ?? ''), 10);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    enabled: on('MAIN_WATCH_ENABLED'), confirm: on('MAIN_WATCH_CONFIRM'), maxRechecks: int('MAIN_WATCH_RECHECKS', DEFAULTS.maxRechecks),
    recheckMs: int('MAIN_WATCH_RECHECK_MS', DEFAULTS.recheckMs), confirmRetryMs: int('MAIN_WATCH_CONFIRM_RETRY_MS', DEFAULTS.confirmRetryMs),
  };
}

const WORK_RESULTS: ReadonlySet<string> = new Set(['WorkSucceeded', 'WorkFailed', 'WorkExhausted']);

// A red is taken for flaky tests only when it named this few (a dozen tests
// failing and then passing is the run's environment, not each test).
const MAX_FLAKES_PER_RED = 3;

// ── State ───────────────────────────────────────────────────────────────

type Phase = 'first' | 'confirm' | 'recheck';
interface Run {
  key: string;
  sha: string;
  phase: Phase;
  prNumber: number | null;
  sessionId: number | null;
  wasPaused: boolean;
  firstRun?: Json;             // confirm: the first red, as the suite said it
  firstExcerpts?: Json[];      // confirm: its failing tests' output, for a flake request
  before?: Json;               // recheck: the paused red's detail
  rechecks?: number;           // recheck: which one
}
export interface Data {
  appId: number;
  slug: string;
  repo: { owner: string; repo: string } | null;
  // The projection (apps.main_check_*).
  sha: string | null;
  state: string | null;
  at: string | null;
  detail: Json;
  pausedSha: string | null;
  resumedSha: string | null;
  n: number;
  run: Run | null;
  // Runs a newer commit took the row from, still to report.
  older: { key: string; sha: string; phase: Phase }[];
}
export type MCState = { name: 'idle' | 'running' | 'confirming' | 'rechecking'; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<MCState, { data: Data }>;

// ── Events ──────────────────────────────────────────────────────────────

const SHA = /^[0-9a-f]{40}$/;
const int = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optInt = (v: unknown, what: string) => (v == null ? null : int(v, what));
const sha = (v: unknown, what: string) => {
  const s = String(v || '').toLowerCase();
  if (!SHA.test(s)) throw new Error(`${what} must be a 40-character commit sha`);
  return s;
};

const EVENTS = {
  // A commit on main to check: a merge (merge-followups' message), or a new
  // main the drift poller saw.
  CheckRequested: (p: any) => ({ appId: int(p?.appId, 'appId'), sha: sha(p?.sha, 'sha'),
    sessionId: optInt(p?.sessionId, 'sessionId'), prNumber: optInt(p?.prNumber, 'prNumber') }),
  // An admin's "resume merges" for the current pause.
  Resume: (p: any) => ({ appId: int(p?.appId, 'appId'), by: typeof p?.by === 'string' ? p.by.slice(0, 80) : null }),
  // The instance's deadline: a paused red is asked again.
  RecheckDue: () => ({}),
};

// ── The rules (services/main-watch.js tells why each is so) ──────────────

const lower = (s: string | null | undefined) => String(s || '').toLowerCase();
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});

// The suite's own account of a red, without the bookkeeping kept around it.
export function redOf(detail: unknown): Record<string, any> {
  const d = obj(detail);
  const out: Record<string, any> = {};
  for (const key of ['summary', 'failureReason', 'failingTests', 'failingTestsComplete']) if (d[key] !== undefined) out[key] = d[key];
  return out;
}

const listed = (red: Record<string, any>) => (red.failingTestsComplete === true && Array.isArray(red.failingTests)
  && red.failingTests.length > 0 && red.failingTests.length <= MAX_FLAKES_PER_RED ? red.failingTests as { file?: string; test: string }[] : null);

// Two reds on one commit that share no failing test: each test that failed
// passed when the suite ran again, so each is a flake. Both lists complete
// and short. Every failing test's name, or null.
export function disjointReds(a: unknown, b: unknown): string[] | null {
  const first = listed(obj(a));
  const second = listed(obj(b));
  if (!first || !second) return null;
  const seen = new Set(first.map(testKey));
  if (second.some((t) => seen.has(testKey(t)))) return null;
  return [...first, ...second].map((t) => t.test);
}

// The failing tests' names when every one of them is a known flake, named in
// full; null otherwise.
export function knownFlakeNames(flakes: ReadonlySet<string>, red: unknown): string[] | null {
  const r = obj(red);
  const tests = Array.isArray(r.failingTests) ? r.failingTests as { file?: string; test: string }[] : [];
  if (!tests.length || r.failingTestsComplete !== true) return null;
  return tests.every((t) => flakes.has(testKey(t))) ? tests.map((t) => t.test) : null;
}

const flakedRed = (detail: Record<string, any>) => !!(detail.flake || detail.disjoint);

// What a verdict does to the pause: green, or a red of flakes only, clears
// it; a red sets it to its commit, unless an admin resumed that very commit;
// anything else (a run that could not happen) leaves it as it was.
function pausedAfter(d: Data, state: string, detail: Record<string, any>): string | null {
  const quiet = Array.isArray(detail.flakesOnly) && detail.flakesOnly.length > 0;
  if (state === 'passing' || quiet) return null;
  if ((state === 'failing' || state === 'confirming') && lower(d.resumedSha) !== lower(d.sha)) return d.sha;
  return d.pausedSha;
}

// ── Outcomes ────────────────────────────────────────────────────────────

const step = (name: Live['name'], data: Data, more: Omit<Outcome<MCState>, 'next'> = {}): Outcome<MCState> =>
  ({ next: { name, data }, ...more });

// The row, and a pause that started or ended (events MAIN_PAUSED /
// MAIN_RESUMED, which the proposal-pipeline topic's figure reads).
function rowWrites(d0: Data, d: Data, { by = null }: { by?: string | null } = {}): DomainWrite[] {
  const writes: DomainWrite[] = [{ type: 'row', appId: d.appId, state: d.state, sha: d.sha, at: d.at, detail: d.detail,
    pausedSha: d.pausedSha, resumedSha: d.resumedSha }];
  if (!d0.pausedSha && d.pausedSha) {
    writes.push({ type: 'pauseEvent', appId: d.appId, eventType: 'main_paused', metadata: { sha: d.pausedSha, confirming: d.state === 'confirming' } });
  } else if (d0.pausedSha && !d.pausedSha) {
    writes.push({ type: 'pauseEvent', appId: d.appId, eventType: 'main_resumed',
      metadata: { sha: by === 'admin' ? d0.pausedSha : (d.sha || d0.pausedSha), by: by || (d.state === 'passing' ? 'green' : 'flakes') } });
  }
  return writes;
}

const verdictWrite = (d: Data, sha: string, state: string, o: { superseded?: boolean; confirmed?: unknown; flake?: boolean } = {}): DomainWrite =>
  ({ type: 'verdict', appId: d.appId, sha, state, superseded: !!o.superseded,
    confirmed: o.confirmed == null ? null : !!o.confirmed, flake: !!o.flake });

// Main turned green (or flakes, or an admin resumed): the app's merge queue
// is asked for the merges the pause held back.
const kick = (d: Data, why: string): MessageRequest =>
  ({ to: { machine: 'merge-queue', key: appKey(d.appId) }, event: { type: 'MergeWanted', payload: { appId: d.appId, reason: `main-${why}` } }, appId: d.appId });

// `reuse`: the run may copy a pass of the merge's tree instead of running the
// suite (services/unit-suite-reuse.js findTreePass). Only a first run, and
// only while main is not paused: a confirmation asks whether a red is real,
// a recheck whether a paused red still stands, and a merge on a paused main
// is the one that re-tests it. Each of those runs the suite.
const suiteWork = (d: Data, run: Run): WorkRequest =>
  ({ kind: WORK.suite, key: run.key, input: { appId: d.appId, sha: run.sha, phase: run.phase,
    reuse: run.phase === 'first' && !run.wasPaused } });

// When a paused red is asked again, or null when it is not.
// A paused red with rechecks left.
function recheckable(d: Data, deps: Deps): boolean {
  const detail = obj(d.detail);
  const rechecks = Number.isInteger(detail.rechecks) ? detail.rechecks as number : 0;
  return deps.maxRechecks > 0 && d.state === 'failing' && !!d.sha && lower(d.pausedSha) === lower(d.sha) && rechecks < deps.maxRechecks;
}
function recheckTimer(d: Data, deps: Deps, now: Date): Outcome<MCState>['timer'] {
  if (!recheckable(d, deps)) return null;
  const detail = obj(d.detail);
  const wait = detail.confirmed === false ? deps.confirmRetryMs : deps.recheckMs;
  const from = d.at ? Date.parse(d.at) : now.getTime();
  return { at: new Date(Math.max(now.getTime(), from + wait)), event: { type: 'RecheckDue' } };
}

// A commit to check: the row is claimed for it, and its first run starts.
function claim(d0: Data, p: { sha: string; sessionId: number | null; prNumber: number | null }, ctx: TransitionContext): Outcome<MCState> {
  const wasPaused = !!d0.pausedSha || d0.state === 'failing' || d0.state === 'confirming';
  const n = d0.n + 1;
  const run: Run = { key: `suite:${n}`, sha: p.sha, phase: 'first', prNumber: p.prNumber, sessionId: p.sessionId, wasPaused };
  const older = d0.run ? [...d0.older, { key: d0.run.key, sha: d0.run.sha, phase: d0.run.phase }].slice(-10) : d0.older;
  const d: Data = { ...d0, sha: p.sha, state: 'running', at: ctx.now.toISOString(),
    detail: { prNumber: p.prNumber, sessionId: p.sessionId }, n, run, older };
  return step('running', d, { writes: rowWrites(d0, d), work: [suiteWork(d, run)], timer: null });
}

// The row's claim: a new commit, one never checked, or one whose last run
// could not happen.
const claimable = (d: { sha: string | null; state: string | null }, s: string) =>
  lower(d.sha) !== lower(s) || d.state == null || d.state === 'error';

// The verdict of a run that is over: stored, and what follows from it.
interface Verdict { state: string; detail: Record<string, any>; excerpts?: Json[] }
function settle(s: Live, run: Run, v: Verdict, f: Facts, ctx: TransitionContext, deps: Deps,
  { excerpts = [], keep = {} }: { excerpts?: Json[]; keep?: Record<string, any> } = {}): Outcome<MCState> {
  const d0 = s.data;
  const detail: Record<string, any> = run.phase === 'recheck' ? { ...keep, ...v.detail } : { prNumber: run.prNumber, sessionId: run.sessionId, ...v.detail };
  if (v.state === 'failing' && run.phase !== 'recheck') {
    const quiet = knownFlakeNames(f.flakes, redOf(v.detail));
    if (quiet) detail.flakesOnly = quiet;
  }
  const d1: Data = { ...d0, state: v.state, at: ctx.now.toISOString(), detail, run: null };
  const d: Data = { ...d1, pausedSha: pausedAfter(d1, v.state, detail) };
  const writes = [...rowWrites(d0, d), verdictWrite(d, run.sha, v.state, { confirmed: detail.confirmed, flake: flakedRed(detail) })];
  const messages: MessageRequest[] = [];
  const work: WorkRequest[] = [];
  const firstRun = run.phase === 'confirm' ? obj(run.firstRun) : null;
  const flakes = (mode: 'note' | 'request', o: Record<string, Json>) =>
    work.push({ kind: WORK.flakes, key: `flakes:${d.n}`, input: { appId: d.appId, sha: run.sha, mode, ...o } });
  if (run.phase === 'recheck') {
    const red = redOf(run.before);
    if (v.state === 'passing' || detail.flakesOnly) messages.push(kick(d, 'post-recheck'));
    if (v.state === 'passing') flakes('note', { reds: [red, obj(run.before).firstRun].filter(Boolean) as Json[], excerpts: [] });
    else if (detail.disjoint) flakes('note', { reds: [red, redOf(v.detail)] as Json[], excerpts: (v.excerpts || []) as Json[] });
    else if (detail.flakesOnly) flakes('request', { tests: (redOf(v.detail).failingTests || []) as Json[], excerpts: (v.excerpts || []) as Json[] });
  } else {
    if ((v.state === 'passing' && detail.flake) || detail.disjoint) messages.push(kick(d, 'post-flake'));
    else if ((v.state === 'passing' || detail.flakesOnly) && run.wasPaused) messages.push(kick(d, 'post-green'));
    if (v.state === 'passing' && detail.flake && firstRun) {
      flakes('note', { reds: [firstRun] as Json[], excerpts: (run.firstExcerpts || []) as Json[] });
    } else if (detail.disjoint) {
      flakes('note', { reds: [firstRun, redOf(detail)] as Json[], excerpts: [...(run.firstExcerpts || []), ...excerpts] as Json[] });
    } else if (detail.flakesOnly) {
      flakes('request', { tests: (redOf(detail).failingTests || []) as Json[], excerpts: [] });
    } else if (v.state === 'failing' && detail.confirmed === true) {
      // Broken, twice over: the Homeroom bot is asked to fix it.
      work.push({ kind: WORK.fix, key: `fix:${d.n}`, input: { appId: d.appId, sha: run.sha, prNumber: run.prNumber,
        detail: redOf(detail) as Json, excerpts: (excerpts.length ? excerpts : run.firstExcerpts || []) as Json[] } });
    }
  }
  return step('idle', d, { writes, work, messages, timer: recheckTimer(d, deps, ctx.now) });
}

// A run reported. `v` is what the suite said; a run that failed for good
// is a verdict that says nothing about main.
function reported(s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<MCState> {
  const d = s.data;
  const p = e.payload;
  const out = obj(p.result);
  const v: Verdict = e.type === 'WorkSucceeded' && typeof out.state === 'string'
    ? { state: out.state, detail: obj(out.detail), excerpts: Array.isArray(out.excerpts) ? out.excerpts as Json[] : [] }
    : { state: 'error', detail: { failureReason: String(p.error?.message || 'the run failed').slice(0, 600) } };
  // A run a newer commit took the row from: its verdict is kept (a
  // superseded green is still the newest merge known to pass, where a later
  // red's suspects are read from), and changes nothing else.
  const old = d.older.find((r) => r.key === p.workKey);
  if (old || !d.run || d.run.key !== p.workKey) {
    // As the run would have stored it: a first red unconfirmed, a red again
    // confirmed, a green after a red a flake (a recheck's is not kept).
    const keepIt = old && old.phase !== 'recheck' && (v.state === 'passing' || v.state === 'failing');
    const confirmed = v.state === 'failing' ? old?.phase === 'confirm' : null;
    const flake = old?.phase === 'confirm' && v.state === 'passing';
    const next = { ...d, older: d.older.filter((r) => r.key !== p.workKey) };
    return step(s.name, next, { writes: keepIt ? [verdictWrite(d, old.sha, v.state, { superseded: true, confirmed, flake })] : [] });
  }
  const run = d.run;
  // A run whose dead predecessor another process took first (main-watch.js
  // adoptRun) says nothing about main.
  if (v.state === 'superseded') Object.assign(v, { state: 'error', detail: { failureReason: 'another process took the run over' } });
  // A first red is provisional: merges pause, and the suite runs again.
  if (run.phase === 'first' && v.state === 'failing' && deps.confirm) {
    const quiet = knownFlakeNames(f.flakes, v.detail);
    const n = d.n + 1;
    const next: Run = { ...run, key: `suite:${n}`, phase: 'confirm', firstRun: v.detail as Json, firstExcerpts: (v.excerpts || []).slice(0, 10) };
    const d1: Data = { ...d, n, state: 'confirming', at: ctx.now.toISOString(), run: next,
      detail: { prNumber: run.prNumber, sessionId: run.sessionId, ...v.detail, confirming: true, ...(quiet ? { flakesOnly: quiet } : {}) } };
    const d2 = { ...d1, pausedSha: pausedAfter(d1, 'confirming', obj(d1.detail)) };
    return step('confirming', d2, { writes: rowWrites(d, d2), work: [suiteWork(d2, next)] });
  }
  if (run.phase === 'confirm') {
    const firstRun = obj(run.firstRun);
    if (v.state === 'passing') return settle(s, run, { state: 'passing', detail: { ...v.detail, flake: firstRun } }, f, ctx, deps, { excerpts: v.excerpts });
    if (v.state === 'failing') {
      const disjoint = disjointReds(firstRun, v.detail);
      return settle(s, run, { state: 'failing', detail: { ...v.detail, confirmed: true, firstRun, ...(disjoint ? { flakesOnly: disjoint, disjoint: true } : {}) } },
        f, ctx, deps, { excerpts: v.excerpts });
    }
    // The re-run could not happen: the first red stands, and says so.
    return settle(s, run, { state: 'failing', detail: { ...firstRun, confirmed: false, confirmation: v.detail } }, f, ctx, deps);
  }
  if (run.phase === 'recheck') {
    const before = obj(run.before);
    const red = redOf(before);
    const keep = { ...(before.prNumber !== undefined ? { prNumber: before.prNumber } : {}),
      ...(before.sessionId !== undefined ? { sessionId: before.sessionId } : {}), rechecks: run.rechecks };
    if (v.state === 'passing') return settle(s, run, { state: 'passing', detail: { ...v.detail, flake: red }, excerpts: v.excerpts }, f, ctx, deps, { keep });
    if (v.state === 'failing') {
      const disjoint = disjointReds(red, v.detail);
      const quiet = disjoint || knownFlakeNames(f.flakes, v.detail);
      return settle(s, run, { state: 'failing', excerpts: v.excerpts,
        detail: { ...v.detail, confirmed: true, firstRun: red, ...(quiet ? { flakesOnly: quiet } : {}), ...(disjoint ? { disjoint: true } : {}) } },
      f, ctx, deps, { keep });
    }
    // It could not run this time either: the red stands, one recheck spent.
    const { recheckingAt: _, ...rest } = before;
    const d1: Data = { ...d, state: 'failing', at: ctx.now.toISOString(), run: null,
      detail: { ...rest, rechecks: run.rechecks ?? 1, recheckError: v.detail } as Json };
    return step('idle', d1, { writes: rowWrites(d, d1), timer: recheckTimer(d1, deps, ctx.now) });
  }
  return settle(s, run, v, f, ctx, deps);
}

// A paused red asked again.
function recheck(s: Live, ctx: TransitionContext): Outcome<MCState> {
  const d = s.data;
  const before = obj(d.detail);
  const rechecks = (Number.isInteger(before.rechecks) ? before.rechecks as number : 0) + 1;
  const n = d.n + 1;
  const run: Run = { key: `suite:${n}`, sha: d.sha!, phase: 'recheck', prNumber: before.prNumber ?? null,
    sessionId: before.sessionId ?? null, wasPaused: true, before: before as Json, rechecks };
  const d1: Data = { ...d, n, run, detail: { ...before, rechecks, recheckingAt: ctx.now.toISOString() } };
  return step('rechecking', d1, { writes: rowWrites(d, d1), work: [suiteWork(d1, run)] });
}

function resume(s: Live, e: Event<any>): Outcome<MCState> {
  const d = s.data;
  const d1: Data = { ...d, resumedSha: d.pausedSha, pausedSha: null };
  return step(s.name, d1, { writes: rowWrites(d, d1, { by: 'admin' }), messages: [kick(d1, 'post-resume')], timer: null });
}

// An instance taken from the row.
function fromRow(appId: number, r: Row): Data {
  return { appId, slug: r.slug, repo: parseRepo(r.repoUrl), sha: r.sha, state: r.state, at: r.at, detail: r.detail as Json,
    pausedSha: r.pausedSha, resumedSha: r.resumedSha, n: 0, run: null, older: [] };
}

// ── The machine ─────────────────────────────────────────────────────────

const producer = (e: Event<any>): Check => (['route', 'system', 'message'].includes(e.source.kind) ? ok() : reject('not_a_producer'));
const adminOnly = (e: Event<any>): Check => (e.source.kind === 'admin' || e.source.kind === 'route' ? ok() : reject('admin_only'));
const timerOnly = (e: Event<any>): Check => (e.source.kind === 'timer' ? ok() : reject('timer_only'));

export function mainCheck(given: Partial<Deps> = {}): Machine<MCState, Facts> {
  const deps: Deps = { ...DEFAULTS, ...given };
  const live = (to: (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<MCState>) =>
    (s: MCState, e: Event<any>, f: Facts, ctx: TransitionContext) => to(s as Live, e, f, ctx);
  const keyOf = (e: Event<any>, ctx: TransitionContext): Check => (ctx.key === appKey(e.payload.appId) ? ok() : reject('key_mismatch'));
  const requested = {
    guard: (s: MCState, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      if (!deps.enabled) return reject('off');
      const k = keyOf(e, ctx);
      if (k !== true) return k;
      const d = s.name === NONE ? (f.row ? { sha: f.row.sha, state: f.row.state, repoUrl: f.row.repoUrl } : null) : { ...(s.data as Data), repoUrl: 'known' };
      if (!d) return reject('no_app');
      if (s.name === NONE ? !parseRepo(d.repoUrl) : !(s.data as Data).repo) return reject('no_repo');
      return claimable(d, e.payload.sha) ? ok() : reject('already_checked');
    },
    to: (s: MCState, e: Event<any>, f: Facts, ctx: TransitionContext) =>
      claim(s.name === NONE ? fromRow(e.payload.appId, f.row!) : (s.data as Data), e.payload, ctx),
  };
  const resumeEntry = {
    guard: (s: MCState, e: Event<any>, f: Facts, ctx: TransitionContext): Check => {
      const k = keyOf(e, ctx);
      if (k !== true) return k;
      const paused = s.name === NONE ? f.row?.pausedSha : (s.data as Data).pausedSha;
      return paused ? ok() : reject('not_paused');
    },
    to: (s: MCState, e: Event<any>, f: Facts, ctx: TransitionContext) => {
      if (s.name !== NONE) return resume(s as Live, e);
      // A paused row no instance holds: the pause lifts.
      return resume({ name: 'idle', data: fromRow(e.payload.appId, f.row!) }, e);
    },
  };
  const results = {
    WorkSucceeded: { to: live((s, e, f, ctx) => reported(s, e, f, ctx, deps)) },
    WorkFailed: { to: live((s, e, f, ctx) => reported(s, e, f, ctx, deps)) },
    WorkExhausted: { to: live((s, e, f, ctx) => reported(s, e, f, ctx, deps)) },
  };
  // The flake and fix filings report too; they change nothing here.
  const filings = new Set<string>([WORK.flakes, WORK.fix]);
  const resultsOf = (name: Live['name']) => Object.fromEntries(Object.entries(results).map(([k, entry]) => [k, {
    to: (s: MCState, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext) =>
      (filings.has(e.payload.kind) ? step(name, (s as Live).data) : entry.to(s, e, f, ctx)),
  }]));
  const table = (name: Live['name']) => ({
    CheckRequested: requested,
    Resume: resumeEntry,
    RecheckDue: name === 'idle'
      ? { guard: (s: MCState) => (!deps.enabled ? reject('off') : recheckable((s as Live).data, deps) ? ok() : reject('not_due')), to: live((s, e, f, ctx) => recheck(s, ctx)) }
      : { ignore: 'under_way' },
    ...resultsOf(name),
  });
  return defineMachine<MCState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['CheckRequested', 'Resume'],
    terminal: [],
    decode: (row) => ({ name: row.state, data: row.data } as MCState),
    facts: (tx: Tx, state: MCState, event: Event<any>) => {
      const appId = state.name === NONE ? Number((event.payload as any)?.appId) : (state.data as Data).appId;
      if (!Number.isInteger(appId) || appId <= 0) return Promise.resolve(NO_FACTS);
      return readFacts(tx, appId, { flakes: WORK_RESULTS.has(event.type) });
    },
    authorize: { CheckRequested: producer, Resume: adminOnly, RecheckDue: timerOnly },
    transitions: {
      [NONE]: {
        CheckRequested: requested,
        Resume: resumeEntry,
      },
      idle: table('idle'),
      running: table('running'),
      confirming: table('confirming'),
      rechecking: table('rechecking'),
    } as any,
    writes: {
      // The projection the merge gate, the board's banner and the API read
      // (main-watch.js describe, mergePause).
      row: async (tx: Tx, w: any) => tx.query(
        `UPDATE apps SET main_check_state = $2, main_check_sha = $3, main_check_at = $4::timestamptz,
                main_check_detail = $5::jsonb, main_check_paused_sha = $6, main_check_resumed_sha = $7
          WHERE id = $1`,
        [w.appId, w.state, w.sha, w.at, JSON.stringify(w.detail ?? {}), w.pausedSha, w.resumedSha]),
      // (An app deleted meanwhile keeps neither: its rows go with it.)
      pauseEvent: async (tx: Tx, w: any) => tx.query(
        `INSERT INTO events (app_id, event_type, metadata)
         SELECT $1, $2, $3::jsonb WHERE EXISTS (SELECT 1 FROM apps WHERE id = $1)`,
        [w.appId, w.eventType, JSON.stringify(w.metadata || {})]),
      // Every verdict, a superseded one too (main-red-fix.js reads them for
      // a later red's suspects).
      verdict: async (tx: Tx, w: any) => tx.query(
        `INSERT INTO main_watch_verdicts (app_id, sha, state, superseded, confirmed, flake)
         SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM apps WHERE id = $1)`,
        [w.appId, lower(w.sha), w.state, !!w.superseded, w.confirmed, !!w.flake]),
    },
    reply: async (tx, event, after) => (after.name === NONE ? null : { state: after.name, pausedSha: (after as Live).data.pausedSha }),
  });
}
