// clock: a platform job that runs on a schedule, on whichever process runs
// the workflow. One instance per job (`clock:<job>`): its deadline is when
// the job is next due, and each run is one work item (`clock.<job>`, at
// most one at a time across every process), so no job needs a leader. What
// the job found is kept as its last run, which is also the status admin
// screens read. A run may hand back targets for effects that must happen
// once each (a model call, a GitHub issue): each becomes a work item of its
// own, keyed by the target, so a second sweep finding the same target asks
// for nothing new, and a target whose earlier item is still outstanding
// gets no second one.
//
// The release's work arms every job this build defines (Arm, with its
// interval), so a release that changes an interval moves it, and retires the
// jobs it no longer defines (Retire: no deadline, its run cancelled). A job
// defined again is armed again.
//
// A job asked for, not scheduled (`onDemand`: an admin's fleet rollover, a
// reap of previews now) has no deadline: an admin's RunNow starts a run, its
// input saying who asked (`asked`), and one asked during a run is refused
// (`running`). Its handler does nothing for a run nobody asked for (an
// older build, which knows no on-demand job, arms it on its interval).
// workflow-foundation's design-leader-duties.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, TransitionContext, WorkRef, WorkRequest, WorkResultPayload } from '../kernel/index.ts';

export const MACHINE = 'clock';
export const clockKey = (job: string) => `clock:${job}`;
export const runKind = (job: string) => `clock.${job}`;
export const itemKind = (job: string) => `clock.${job}.item`;

// The most targets one run asks for: the largest sweep's whole list (the
// Workshop's 200 apps), so no target waits behind the same first ones every
// run. Only a list longer than this leaves the rest to the next run.
export const MAX_ITEMS = 200;
// After a failed run the next is due sooner than its interval: from this,
// doubling, never later than the interval (a continuous job: 5 minutes).
const RETRY_FIRST_MS = 30 * 1000;
const CONTINUOUS_RETRY_MAX_MS = 5 * 60 * 1000;

type Name = 'waiting' | 'running' | 'retired';
interface Last { n: number; at: string; ok: boolean; ms: number | null; result: Json; error: string | null }
// Who asked for an on-demand run (an admin).
export type Asked = { by: string | null; userId: number | null };

export interface Data {
  job: string;
  everyMs: number;               // 0: continuous, run again as soon as a run ends
  onDemand?: boolean;            // runs only when asked (RunNow): no deadline
  asked?: Asked | null;          // who asked for the run under way or next
  due: string;                   // when the next run is due
  n: number;                     // runs asked for so far
  running: number | null;        // the run under way
  startedAt: string | null;
  again: boolean;                // run again as soon as this one ends (Run now during a run)
  failures: number;              // runs failed in a row
  last: Last | null;
  kept: Json;                    // the last successful run's result: the next run's `previous`
  items: { ok: number; failed: number; lastError: { key: string; message: string; at: string } | null };
}
export type CState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<CState, { data: Data }>;

const job = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(s)) throw new Error('job must be a kebab-case name');
  return s;
};
const every = (v: unknown) => {
  if (!Number.isInteger(v) || (v as number) < 0) throw new Error('everyMs must be a whole number of milliseconds');
  return v as number;
};
const optTime = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

const EVENTS = {
  // The release arms the job: its interval, and on first arming when its
  // first run is due (the job's last run under the leader, else now).
  Arm: (p: any) => ({ job: job(p?.job), everyMs: every(p?.everyMs), firstDueAt: optTime(p?.firstDueAt), onDemand: !!p?.onDemand }),
  // Its deadline.
  Tick: () => ({}),
  // An admin asks for a run now (who, for the job's own record). `onDemand`:
  // the job runs only when asked, which this ask says too (an older build
  // armed it on an interval, knowing no on-demand job).
  RunNow: (p: any): Asked & { onDemand: boolean } => ({
    by: typeof p?.by === 'string' && p.by.trim() ? p.by.trim().slice(0, 100) : null,
    userId: Number.isSafeInteger(p?.userId) && p.userId > 0 ? p.userId : null,
    onDemand: p?.onDemand === true,
  }),
  // The release no longer defines the job.
  Retire: () => ({}),
};

const at = (ctx: TransitionContext, ms: number) => new Date(ctx.now.getTime() + ms);
const iso = (d: Date) => d.toISOString();
const timerAt = (due: string) => ({ at: new Date(due), event: { type: 'Tick' } });

// Start a run: one work item, and no deadline while it runs (the item's
// lease keeps it alive; its result sets the next).
function start(d: Data, ctx: TransitionContext, extra: WorkRequest[] = [], asked: Asked | null = null): Outcome<CState> {
  const n = d.n + 1;
  return {
    next: { name: 'running', data: { ...d, n, running: n, startedAt: iso(ctx.now), again: false, asked: null } },
    // The last run's result goes with it: what a job carries from one run to
    // the next (an alert level, the build it last ran under) is kept here,
    // never in a process.
    work: [...extra, { kind: runKind(d.job), key: `run:${n}`, input: { job: d.job, n, previous: d.kept, ...(asked ? { asked } : {}) } }],
    timer: null,
  };
}

// An on-demand job waits with no deadline.
function wait(d: Data, extra: Partial<Outcome<CState>> = {}): Outcome<CState> {
  return { next: { name: 'waiting', data: { ...d, running: null, startedAt: null } }, timer: d.onDemand ? null : timerAt(d.due), ...extra };
}

function retryInMs(d: Data, failures: number): number {
  const backoff = RETRY_FIRST_MS * 2 ** Math.min(10, failures - 1);
  return Math.min(backoff, d.everyMs > 0 ? d.everyMs : CONTINUOUS_RETRY_MAX_MS);
}

// The targets a run handed back (`items: [{ target, gen, input }]`), as one
// work item each, keyed by the target and its generation: the run's own
// number unless the job names one (`gen`, such as a row's attempts so far,
// when only a new attempt may ask again). So each run asks again for what is
// still owed; a target with an item still outstanding (`busy`) gets no
// second one, and the same target and generation never two. MAX_ITEMS counts
// what is asked for, after those.
const TARGET = /^[A-Za-z0-9:._-]{1,160}$/;
export const itemKey = (target: string, gen: string) => `item:${target}@${gen}`;
const targetOf = (workKey: string) => workKey.slice('item:'.length, workKey.lastIndexOf('@'));

function itemsOf(jobName: string, run: number, result: Json, f: Facts):
  { items: WorkRequest[]; cancel: WorkRef[]; status: Json } {
  const { outstanding, unfinished } = f;
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray((result as any).items)) {
    return { items: [], cancel: [], status: result ?? null };
  }
  const { items, ...status } = result as { items: Json[] } & Record<string, Json>;
  // A job only the newest build runs names its build: its targets are
  // claimed only by a process of it (clock/services.ts newestOnly). An item
  // an older build's run handed out is claimed by no process of this one,
  // and its own may be gone: once nobody works it (queued, or its lease
  // lapsed) it is given up, and its target asked for again. One a live
  // process of that build is working stays its own. (Its row was read
  // locked, so no process claims it between this read and the cancel.)
  const release = typeof status.release === 'string' ? status.release : null;
  const cancel: WorkRef[] = [];
  const busy = new Set<string>();
  const handedOn = new Map<string, string>();
  for (const [target, o] of outstanding) {
    if (release && o.release !== release && o.idle) {
      cancel.push({ kind: itemKind(jobName), key: o.key });
      handedOn.set(target, o.key);
    } else busy.add(target);
  }
  const out: WorkRequest[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (out.length >= MAX_ITEMS) break;
    const o = it && typeof it === 'object' && !Array.isArray(it) ? it as Record<string, Json> : null;
    const target = typeof o?.target === 'string' ? o.target : '';
    const gen = o?.gen == null ? `run${run}` : String(o.gen);
    if (!TARGET.test(target) || !TARGET.test(gen) || busy.has(target) || seen.has(target)) continue;
    seen.add(target);
    // What the target's last item did, when it did not finish (given up
    // here, cancelled, failed, out of tries): the new item carries on from
    // its checkpoint (`continues`), so an effect it made (a paid batch
    // submitted) is not made again. A target's progress is the target's,
    // not one item's.
    const from = handedOn.get(target) ?? unfinished.get(target);
    out.push({ kind: itemKind(jobName), key: itemKey(target, gen),
      input: { job: jobName, target, input: (o!.input ?? null) as Json, ...(release ? { release } : {}) },
      ...(from ? { continues: from } : {}) });
  }
  return { items: out, cancel, status: { ...status, items: out.length } };
}

// What a run's result needs to know: the targets with an item outstanding,
// with the release each was handed out for, and whether nobody works it now
// (queued, or claimed by a process whose lease lapsed).
interface Outstanding { key: string; release: string | null; idle: boolean }
// And, by target, the key of its latest item when that item ended without
// succeeding and kept a checkpoint.
export interface Facts { outstanding: ReadonlyMap<string, Outstanding>; unfinished: ReadonlyMap<string, string> }
const NO_FACTS: Facts = { outstanding: new Map(), unfinished: new Map() };

function ran(s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<CState> {
  const p = e.payload;
  const d = s.data;
  // An earlier run's late result (Run now raced it, a retired run): nothing.
  if (d.running == null || p.workKey !== `run:${d.running}`) return { next: s };
  const okRun = e.type === 'WorkSucceeded';
  const { items, cancel, status } = okRun ? itemsOf(d.job, d.running, p.result ?? null, f) : { items: [], cancel: [], status: null };
  const ms = d.startedAt ? ctx.now.getTime() - Date.parse(d.startedAt) : null;
  const failures = okRun ? 0 : d.failures + 1;
  const last: Last = { n: d.running, at: iso(ctx.now), ok: okRun, ms, result: status, error: okRun ? null : (p.error?.message ?? 'failed').slice(0, 500) };
  const next: Data = {
    ...d, failures, last, kept: okRun ? status : d.kept,
    due: iso(okRun ? at(ctx, d.everyMs) : at(ctx, retryInMs(d, failures))),
  };
  const given = cancel.length ? { cancel } : {};
  if (s.name === 'retired') return { next: { name: 'retired', data: { ...next, running: null, startedAt: null } }, work: items, ...given };
  // An admin's Run now during the run: at once.
  if (d.again) return { ...start({ ...next, due: iso(ctx.now) }, ctx, items, d.asked ?? null), ...given };
  // Asked for, not scheduled: it waits to be asked again, after a failure too.
  if (d.onDemand) return wait(next, { work: items, ...given });
  if (okRun && d.everyMs === 0) {
    // A continuous job runs again at once, unless it had nothing to do and
    // asked to rest (`restMs`: the push sender of a process that sends none).
    const rest = Math.min(Math.max(0, Number((status as any)?.restMs) || 0), CONTINUOUS_RETRY_MAX_MS);
    if (!rest) return { ...start({ ...next, due: iso(ctx.now) }, ctx, items), ...given };
    return wait({ ...next, due: iso(at(ctx, rest)) }, { work: items, ...given });
  }
  return wait(next, { work: items, ...given });
}

function itemDone(s: Live, e: Event<WorkResultPayload>, _f: Facts, ctx: TransitionContext): Outcome<CState> {
  const p = e.payload;
  const d = s.data;
  const okItem = e.type === 'WorkSucceeded';
  const items = okItem
    ? { ...d.items, ok: d.items.ok + 1 }
    : { ...d.items, failed: d.items.failed + 1, lastError: { key: p.workKey, message: (p.error?.message ?? 'failed').slice(0, 500), at: iso(ctx.now) } };
  return { next: { name: s.name, data: { ...d, items } } as CState };
}

const workResult = (s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<CState> =>
  (e.payload.kind === itemKind(s.data.job) ? itemDone(s, e, f, ctx) : ran(s, e, f, ctx));

const retire = (s: CState): Outcome<CState> => {
  const d = (s as Live).data;
  return {
    next: { name: 'retired', data: { ...d, running: null, startedAt: null, again: false } },
    timer: null,
    cancel: d.running == null ? [] : [{ kind: runKind(d.job), key: `run:${d.running}` }],
  };
};

export function clock() {
  const results = { WorkSucceeded: { to: workResult }, WorkFailed: { to: workResult }, WorkExhausted: { to: workResult } };
  return defineMachine<CState, Facts>({
    name: MACHINE,
    // 2: a newest-build job's targets carry its release (an older build's
    // transition would hand them out without it, unclaimable).
    version: 2,
    // A job that runs every minute writes two events a run: a week of them is
    // history enough.
    retainDays: 7,
    events: EVENTS,
    create: ['Arm'],
    decode: (row) => (row.state === NONE ? { name: NONE, data: null } : { name: row.state as Name, data: row.data as Data }),
    // A run's result: its targets that still have an item outstanding.
    async facts(tx, state, event, ctx) {
      if (state.name === NONE || event.type === 'Arm' || event.type === 'Tick' || event.type === 'RunNow' || event.type === 'Retire') return NO_FACTS;
      const p = event.payload as WorkResultPayload;
      // Only a run's result that hands targets back needs to know which are
      // busy (most jobs hand none).
      if (p.kind !== runKind(state.data.job) || !Array.isArray((p.result as any)?.items)) return NO_FACTS;
      // Locked: a process claims an item only while nobody holds its row
      // (services.ts claim, SKIP LOCKED), so what is read idle here stays
      // idle until this transition has given it up.
      const { rows } = await tx.query(
        `SELECT work_key, input->>'release' AS release,
                (status = 'queued' OR (status = 'running' AND lease_until <= now())) AS idle
           FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3 AND status <> 'settled'
            FOR UPDATE`,
        [MACHINE, ctx.key, itemKind(state.data.job)]);
      // Each target's latest settled item that kept a checkpoint and did not
      // succeed, unless an item of that target succeeded after it.
      const { rows: left } = await tx.query(
        `SELECT DISTINCT ON (t) t, work_key FROM (
            SELECT split_part(substr(w.work_key, 6), '@', 1) AS t, w.work_key, w.created_at FROM wf_work w
             WHERE w.machine = $1 AND w.key = $2 AND w.kind = $3 AND w.status = 'settled' AND w.checkpoint IS NOT NULL
               AND COALESCE(w.result->>'outcome', '') <> 'succeeded'
               AND NOT EXISTS (
                 SELECT 1 FROM wf_work n
                  WHERE n.machine = w.machine AND n.key = w.key AND n.kind = w.kind AND n.status = 'settled'
                    AND n.result->>'outcome' = 'succeeded' AND n.created_at > w.created_at
                    AND split_part(substr(n.work_key, 6), '@', 1) = split_part(substr(w.work_key, 6), '@', 1))) c
          ORDER BY t, created_at DESC`,
        [MACHINE, ctx.key, itemKind(state.data.job)]);
      return {
        outstanding: new Map(rows.map((r: { work_key: string; release: string | null; idle: boolean }) =>
          [targetOf(r.work_key), { key: r.work_key, release: r.release ?? null, idle: !!r.idle }])),
        unfinished: new Map(left.map((r: { t: string; work_key: string }) => [r.t, r.work_key])),
      };
    },
    authorize: {
      Arm: (e) => (e.source.kind === 'system' ? ok() : reject('system_only')),
      Tick: (e) => (e.source.kind === 'timer' || e.source.kind === 'system' ? ok() : reject('not_the_clock')),
      RunNow: (e) => (e.source.kind === 'admin' ? ok() : reject('admin_only')),
      Retire: (e) => (e.source.kind === 'system' ? ok() : reject('system_only')),
    },
    transitions: {
      [NONE]: {
        Arm: {
          to: (_s: CState, e: Event<any>, _f: Facts, ctx: TransitionContext) => {
            const d: Data = {
              job: e.payload.job, everyMs: e.payload.everyMs, onDemand: e.payload.onDemand, due: e.payload.firstDueAt ?? iso(ctx.now), n: 0,
              running: null, startedAt: null, again: false, failures: 0, last: null, kept: null, items: { ok: 0, failed: 0, lastError: null },
            };
            return wait(d);
          },
        },
        '*': { ignore: 'not_armed' },
      },
      waiting: {
        // A new interval: a due time further off than one interval from now
        // comes in to it.
        Arm: {
          to: (s: CState, e: Event<any>, _f: Facts, ctx: TransitionContext) => {
            const d = (s as Live).data;
            const cap = iso(at(ctx, e.payload.everyMs));
            return wait({ ...d, everyMs: e.payload.everyMs, onDemand: e.payload.onDemand, due: d.due > cap ? cap : d.due });
          },
        },
        Tick: {
          to: (s: CState, _e: Event<any>, _f: Facts, ctx: TransitionContext) => {
            const d = (s as Live).data;
            // A stale tick (the due time moved since it was set): wait on.
            if (Date.parse(d.due) > ctx.now.getTime()) return wait(d);
            return start(d, ctx);
          },
        },
        RunNow: {
          to: (s: CState, e: Event<any>, _f: Facts, ctx: TransitionContext) => {
            const d = (s as Live).data;
            return start({ ...d, onDemand: d.onDemand || e.payload.onDemand }, ctx, [], { by: e.payload.by, userId: e.payload.userId });
          },
        },
        Retire: { to: retire },
        ...results,
      },
      running: {
        Arm: { to: (s: CState, e: Event<any>): Outcome<CState> => ({ next: { name: 'running', data: { ...(s as Live).data, everyMs: e.payload.everyMs, onDemand: e.payload.onDemand } } }) },
        Tick: { ignore: 'running' },
        // An on-demand job asked again while it runs is refused: the admin
        // sees the run under way (two presses on two processes, one sweep).
        RunNow: {
          guard: (s: CState, e: Event<any>) => ((s as Live).data.onDemand || e.payload.onDemand ? reject('running') : ok()),
          to: (s: CState, e: Event<any>): Outcome<CState> => ({ next: { name: 'running', data: { ...(s as Live).data, again: true, asked: { by: e.payload.by, userId: e.payload.userId } } } }),
        },
        Retire: { to: retire },
        ...results,
      },
      // Defined again by a later build: armed again, due one interval on.
      retired: {
        Arm: { to: (s: CState, e: Event<any>, _f: Facts, ctx: TransitionContext) => wait({ ...(s as Live).data, everyMs: e.payload.everyMs, onDemand: e.payload.onDemand, due: iso(at(ctx, e.payload.everyMs)) }) },
        Tick: { ignore: 'retired' },
        RunNow: { ignore: 'retired' },
        Retire: { ignore: 'retired' },
        ...results,
      },
    } as any,
  });
}
