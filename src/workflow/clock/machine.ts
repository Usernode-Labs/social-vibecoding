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
// workflow-foundation's design-leader-duties.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, TransitionContext, WorkRequest, WorkResultPayload } from '../kernel/index.ts';

export const MACHINE = 'clock';
export const clockKey = (job: string) => `clock:${job}`;
export const runKind = (job: string) => `clock.${job}`;
export const itemKind = (job: string) => `clock.${job}.item`;

// The most targets one run hands back; the next run finds the rest.
export const MAX_ITEMS = 50;
// After a failed run the next is due sooner than its interval: from this,
// doubling, never later than the interval (a continuous job: 5 minutes).
const RETRY_FIRST_MS = 30 * 1000;
const CONTINUOUS_RETRY_MAX_MS = 5 * 60 * 1000;

type Name = 'waiting' | 'running' | 'retired';
interface Last { n: number; at: string; ok: boolean; ms: number | null; result: Json; error: string | null }
export interface Data {
  job: string;
  everyMs: number;               // 0: continuous, run again as soon as a run ends
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
  Arm: (p: any) => ({ job: job(p?.job), everyMs: every(p?.everyMs), firstDueAt: optTime(p?.firstDueAt) }),
  // Its deadline.
  Tick: () => ({}),
  // An admin asks for a run now.
  RunNow: () => ({}),
  // The release no longer defines the job.
  Retire: () => ({}),
};

const at = (ctx: TransitionContext, ms: number) => new Date(ctx.now.getTime() + ms);
const iso = (d: Date) => d.toISOString();
const timerAt = (due: string) => ({ at: new Date(due), event: { type: 'Tick' } });

// Start a run: one work item, and no deadline while it runs (the item's
// lease keeps it alive; its result sets the next).
function start(d: Data, ctx: TransitionContext, extra: WorkRequest[] = []): Outcome<CState> {
  const n = d.n + 1;
  return {
    next: { name: 'running', data: { ...d, n, running: n, startedAt: iso(ctx.now), again: false } },
    // The last run's result goes with it: what a job carries from one run to
    // the next (an alert level, the build it last ran under) is kept here,
    // never in a process.
    work: [...extra, { kind: runKind(d.job), key: `run:${n}`, input: { job: d.job, n, previous: d.kept } }],
    timer: null,
  };
}

function wait(d: Data, extra: Partial<Outcome<CState>> = {}): Outcome<CState> {
  return { next: { name: 'waiting', data: { ...d, running: null, startedAt: null } }, timer: timerAt(d.due), ...extra };
}

function retryInMs(d: Data, failures: number): number {
  const backoff = RETRY_FIRST_MS * 2 ** Math.min(10, failures - 1);
  return Math.min(backoff, d.everyMs > 0 ? d.everyMs : CONTINUOUS_RETRY_MAX_MS);
}

// The targets a run handed back (`items: [{ target, gen, input }]`), as one
// work item each, keyed by the target and its generation (`gen`: what makes
// a new try a new item, such as its attempts so far): the same target and
// generation found again asks for nothing new, and a target with an item
// still outstanding (`busy`) gets no second one.
const TARGET = /^[A-Za-z0-9:._-]{1,160}$/;
export const itemKey = (target: string, gen: string) => `item:${target}@${gen}`;
const targetOf = (workKey: string) => workKey.slice('item:'.length, workKey.lastIndexOf('@'));

function itemsOf(jobName: string, result: Json, busy: ReadonlySet<string>): { items: WorkRequest[]; status: Json } {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray((result as any).items)) {
    return { items: [], status: result ?? null };
  }
  const { items, ...status } = result as { items: Json[] } & Record<string, Json>;
  const out: WorkRequest[] = [];
  const seen = new Set<string>();
  for (const it of items.slice(0, MAX_ITEMS)) {
    const o = it && typeof it === 'object' && !Array.isArray(it) ? it as Record<string, Json> : null;
    const target = typeof o?.target === 'string' ? o.target : '';
    const gen = String(o?.gen ?? '0');
    if (!TARGET.test(target) || !TARGET.test(gen) || busy.has(target) || seen.has(target)) continue;
    seen.add(target);
    out.push({ kind: itemKind(jobName), key: itemKey(target, gen), input: { job: jobName, target, input: (o!.input ?? null) as Json } });
  }
  return { items: out, status: { ...status, items: out.length } };
}

// What a run's result needs to know: the targets with an item outstanding.
export interface Facts { busy: ReadonlySet<string> }
const NO_FACTS: Facts = { busy: new Set() };

function ran(s: Live, e: Event<WorkResultPayload>, f: Facts, ctx: TransitionContext): Outcome<CState> {
  const p = e.payload;
  const d = s.data;
  // An earlier run's late result (Run now raced it, a retired run): nothing.
  if (d.running == null || p.workKey !== `run:${d.running}`) return { next: s };
  const okRun = e.type === 'WorkSucceeded';
  const { items, status } = okRun ? itemsOf(d.job, p.result ?? null, f.busy) : { items: [], status: null };
  const ms = d.startedAt ? ctx.now.getTime() - Date.parse(d.startedAt) : null;
  const failures = okRun ? 0 : d.failures + 1;
  const last: Last = { n: d.running, at: iso(ctx.now), ok: okRun, ms, result: status, error: okRun ? null : (p.error?.message ?? 'failed').slice(0, 500) };
  const next: Data = {
    ...d, failures, last, kept: okRun ? status : d.kept,
    due: iso(okRun ? at(ctx, d.everyMs) : at(ctx, retryInMs(d, failures))),
  };
  if (s.name === 'retired') return { next: { name: 'retired', data: { ...next, running: null, startedAt: null } }, work: items };
  // A continuous job, or an admin's Run now during the run: at once.
  if ((okRun && d.everyMs === 0) || d.again) return start({ ...next, due: iso(ctx.now) }, ctx, items);
  return wait(next, { work: items });
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
    version: 1,
    // A job that runs every minute writes two events a run: a week of them is
    // history enough.
    retainDays: 7,
    events: EVENTS,
    create: ['Arm'],
    decode: (row) => (row.state === NONE ? { name: NONE, data: null } : { name: row.state as Name, data: row.data as Data }),
    // A run's result: its targets that still have an item outstanding.
    async facts(tx, state, event, ctx) {
      if (state.name === NONE || event.type === 'Arm' || event.type === 'Tick' || event.type === 'RunNow' || event.type === 'Retire') return NO_FACTS;
      if ((event.payload as WorkResultPayload).kind !== runKind(state.data.job)) return NO_FACTS;
      const { rows } = await tx.query(
        `SELECT work_key FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3 AND status <> 'settled'`,
        [MACHINE, ctx.key, itemKind(state.data.job)]);
      return { busy: new Set(rows.map((r: { work_key: string }) => targetOf(r.work_key))) };
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
              job: e.payload.job, everyMs: e.payload.everyMs, due: e.payload.firstDueAt ?? iso(ctx.now), n: 0,
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
            return wait({ ...d, everyMs: e.payload.everyMs, due: d.due > cap ? cap : d.due });
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
        RunNow: { to: (s: CState, _e: Event<any>, _f: Facts, ctx: TransitionContext) => start((s as Live).data, ctx) },
        Retire: { to: retire },
        ...results,
      },
      running: {
        Arm: { to: (s: CState, e: Event<any>): Outcome<CState> => ({ next: { name: 'running', data: { ...(s as Live).data, everyMs: e.payload.everyMs } } }) },
        Tick: { ignore: 'running' },
        RunNow: { to: (s: CState): Outcome<CState> => ({ next: { name: 'running', data: { ...(s as Live).data, again: true } } }) },
        Retire: { to: retire },
        ...results,
      },
      // Defined again by a later build: armed again, due one interval on.
      retired: {
        Arm: { to: (s: CState, e: Event<any>, _f: Facts, ctx: TransitionContext) => wait({ ...(s as Live).data, everyMs: e.payload.everyMs, due: iso(at(ctx, e.payload.everyMs)) }) },
        Tick: { ignore: 'retired' },
        RunNow: { ignore: 'retired' },
        Retire: { ignore: 'retired' },
        ...results,
      },
    } as any,
  });
}
