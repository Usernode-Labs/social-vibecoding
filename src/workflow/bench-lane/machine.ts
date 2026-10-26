// bench-lane: the App bench's lane (services/bench/lane.js): which of the
// benchmark's trials run, and when. One instance (`lane`), as the bot's own
// lane (bot-lane/) is one, so the limits that span every run hold however
// many processes run the workflow: a run's `concurrency` trials at once (at
// most MAX_CONCURRENCY), at most MAX_HEAVY_PER_RUN of them heavy (a studio
// run: its concurrency), MAX_IN_FLIGHT across every run, none while the live
// bot's work fills its live slots, a later change's side builds only in the
// slots the live work leaves free, and each run's dollar cap: what it spent,
// plus every trial of it running at its estimate, plus the next one's.
//
// What is running is read from the trials' rows, under this lock: a trial
// is claimed by this machine's own write, in the transition that sends its
// build (bot-build `trial:<id>@<nonce>`), so a trial granted is counted at
// once and never lost between the two. Its build tells the lane its end
// (BuildEnded); a build lost is recorded by bot-build's `build.lost`, which
// asks the lane to look again. A cancel (a run, a trial) is decided here
// too: written in the transition, and the trials running are stopped by a
// StopRequested to their build, which always comes after the build's
// Requested from this same instance.
//
// The bench user's allowance is legacy code a transition does not call: a
// look of it (`bench.gate`) is work, kept for a minute, and nothing is
// granted while it is not known to allow it.
//
// workflow-foundation's design-step4-lanes.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, MessageRequest, Outcome, TransitionContext, WorkRequest, WorkResultPayload } from '../kernel/index.ts';
import { MACHINE as BOT_BUILD, buildKey } from '../bot-build/machine.ts';
import { LATER_SIDE_RUN_KIND, readFacts } from './facts.ts';
import type { Facts, Trial } from './facts.ts';

export const MACHINE = 'bench-lane';
export const KEY = 'lane';
export const WORK = Object.freeze({ gate: 'bench.gate', sides: 'bench.sides', lost: 'bench.lost' });

// One run's trials at once (a studio run's own limit, 9, fits under it),
// heavy ones of one run at once, and every trial in flight across runs.
export const MAX_CONCURRENCY = 9;
export const MAX_HEAVY_PER_RUN = 3;
export const MAX_IN_FLIGHT = 11;
// How long the allowance's look is good for.
export const GATE_FRESH_MS = 60 * 1000;
// Trials waiting on the live bot's slots or the allowance: looked at again
// this often (nothing tells the lane when a live slot frees).
export const WAIT_MS = 60 * 1000;
// While trials run, a look this often anyway: a lost build's record asks
// for one, and this is what catches that ask being lost.
export const RUNNING_LOOK_MS = 5 * 60 * 1000;
// And with nothing running, a look this often all the same: an ask to look
// that was lost (a launch whose Look failed, an older release's wake during
// a rollout) waits no longer than this.
export const IDLE_LOOK_MS = 10 * 60 * 1000;

type Name = 'open';
export interface Data {
  grants: number;
  gate: { at: string | null; ok: boolean; reason: string | null; n: number; running: number | null };
  sides: number;
}
export type LState = { name: Name; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<LState, { data: Data }>;

const posInt = (v: unknown, what: string) => {
  if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${what} must be a positive integer`);
  return v as number;
};
const optInt = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
const by = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);

const EVENTS = {
  // Look again: a run launched, a trial added (a rerun, a reference handed
  // in, side builds queued: `runId`, reopened if it had ended), a lost
  // build recorded.
  Look: (p: any) => ({ runId: optInt(p?.runId) }),
  RunCancelled: (p: any) => ({ runId: posInt(p?.runId, 'runId'), by: by(p?.by) }),
  // `why`: the words a pending one is cancelled with.
  TrialCancelled: (p: any) => ({ trialId: posInt(p?.trialId, 'trialId'), by: by(p?.by), why: typeof p?.why === 'string' ? p.why.slice(0, 300) : null }),
  // bot-build's answer: a trial's build ended.
  BuildEnded: (p: any) => ({ id: optInt(p?.id), outcome: typeof p?.outcome === 'string' ? p.outcome : null }),
  Tick: () => ({}),
};

const created = (): Data => ({ grants: 0, gate: { at: null, ok: false, reason: null, n: 0, running: null }, sides: 0 });
const live = (s: LState): Data => (s.name === NONE ? created() : (s as Live).data);
const at = (ctx: TransitionContext, ms: number) => new Date(ctx.now.getTime() + ms);
const gateFresh = (d: Data, ctx: TransitionContext) => !!d.gate.at && ctx.now.getTime() - Date.parse(d.gate.at) < GATE_FRESH_MS;

// `sides`: runs whose side builds' results may wait on a trial that will
// not run now (a cap, a cancel): finished by `bench.sides`.
interface Extra { writes?: any[]; messages?: MessageRequest[]; sides?: number[] }

// Grant what may start now, oldest run first, and set the clock.
function decide(d0: Data, f0: Facts, ctx: TransitionContext, extra: Extra = {}): Outcome<LState> {
  let d = d0;
  let f = f0;
  const writes: any[] = [...(extra.writes || [])];
  const messages: MessageRequest[] = [...(extra.messages || [])];
  const work: WorkRequest[] = [];
  // A skipped comparison no longer needs its trial. The periodic look must
  // recover cleanup lost during a rollout without admitting an old human
  // command: use the same cancellation write/build message as a fresh cancel.
  // Keep running trials charged to their slots until their builds record them.
  if (f.abandoned.length) {
    const waiting = new Map(f.waiting);
    const pendingCount = new Map(f.pendingCount);
    for (const t of f.abandoned) {
      if (t.status === 'running') {
        if (t.buildKey && !messages.some((m) => m.to.machine === BOT_BUILD && m.to.key === t.buildKey && m.event.type === 'StopRequested')) {
          messages.push(stopTo(t.buildKey, 'Homeroom'));
        }
      } else {
        waiting.set(t.runId, (waiting.get(t.runId) || []).filter((x) => x.id !== t.id));
        if (t.status === 'pending') pendingCount.set(t.runId, Math.max((pendingCount.get(t.runId) || 1) - 1, 0));
        writes.push({ type: 'trialCancelled', trialId: t.id, error: t.error || 'the build it was compared with was given up' });
      }
    }
    f = { ...f, waiting, pendingCount };
  }
  const running: Trial[] = f.running.slice();
  let blocked: 'live' | 'gate' | 'provider' | null = null;
  let stop = false;
  const sides = (runId: number) => {
    d = { ...d, sides: d.sides + 1 };
    work.push({ kind: WORK.sides, key: `sides:${d.sides}`, input: { runId } });
  };
  for (const runId of extra.sides || []) sides(runId);
  // Trials whose build ended without recording them: recorded lost (once
  // per build; the record is fenced by the trial's claim).
  for (const u of f.unrecorded) {
    work.push({ kind: WORK.lost, key: `lost:${u.buildKey || `trial:${u.id}`}`, input: { trialId: u.id, buildKey: u.buildKey } as Json });
  }
  for (const run of f.runs) {
    const mine = running.filter((t) => t.runId === run.id);
    const pending = f.pendingCount.get(run.id) || 0;
    // Nothing waiting, nothing running: done (the write checks again, so a
    // trial added meanwhile keeps it open).
    if (!pending && !mine.length) { writes.push({ type: 'done', runId: run.id }); continue; }
    if (stop) continue;
    let free = Math.min(run.concurrency, MAX_CONCURRENCY) - mine.length;
    const queue = (f.waiting.get(run.id) || []).slice();
    const heavyCap = run.kind === 'studio' ? Math.min(Math.max(run.concurrency, 1), MAX_IN_FLIGHT) : MAX_HEAVY_PER_RUN;
    while (free > 0 && queue.length) {
      if (running.length >= MAX_IN_FLIGHT) { stop = true; break; }
      if (f.liveInUse >= f.liveAtOnce) { blocked = 'live'; stop = true; break; }
      if (run.kind === LATER_SIDE_RUN_KIND && f.liveInUse + running.filter((t) => t.laterSide).length >= f.liveAtOnce) { blocked = 'live'; break; }
      if (f.providerPauseUntil) { blocked = 'provider'; stop = true; break; }
      if (!gateFresh(d, ctx)) { blocked = 'gate'; stop = true; break; }
      if (!d.gate.ok) { blocked = 'gate'; stop = true; break; }
      const heavyNow = mine.filter((t) => t.heavy).length;
      const i = queue.findIndex((t) => !t.heavy || heavyNow < heavyCap);
      if (i < 0) break;
      const next = queue[i];
      // A trial that spends nothing on a model (a capture, a reference
      // build's screenshots) cannot take the run past its cap.
      const committed = run.spent + mine.reduce((sum, t) => sum + t.est, 0);
      if (next.est > 0 && committed + next.est > run.cap + 1e-9) {
        // Wait for what is under way, then stop the run there.
        if (!mine.length) { writes.push({ type: 'capped', runId: run.id }); sides(run.id); }
        break;
      }
      queue.splice(i, 1);
      const grant = d.grants + 1;
      d = { ...d, grants: grant };
      const nonce = `c${next.claims + 1}.g${grant}`;
      const key = buildKey('trial', next.id, nonce);
      writes.push({ type: 'claim', trialId: next.id, runId: run.id, buildKey: key });
      messages.push({
        to: { machine: BOT_BUILD, key },
        event: { type: 'Requested', payload: { target: 'trial', id: next.id, nonce, input: {}, replyTo: { machine: MACHINE, key: KEY } } as Json },
        ...(next.appId ? { appId: next.appId } : {}),
      });
      const t = { ...next, buildKey: key };
      running.push(t);
      mine.push(t);
      free -= 1;
    }
  }
  // The allowance's look, when a grant waits on it.
  if (blocked === 'gate' && !gateFresh(d, ctx) && d.gate.running == null) {
    const n = d.gate.n + 1;
    d = { ...d, gate: { ...d.gate, n, running: n } };
    work.push({ kind: WORK.gate, key: `gate:${n}`, input: { n } });
  }
  const times: number[] = [];
  if (blocked === 'provider' && f.providerPauseUntil) times.push(Date.parse(f.providerPauseUntil));
  if (blocked === 'live' || (blocked === 'gate' && d.gate.running == null)) times.push(at(ctx, WAIT_MS).getTime());
  if (running.length) times.push(at(ctx, RUNNING_LOOK_MS).getTime());
  const due = times.filter((t) => Number.isFinite(t) && t > ctx.now.getTime());
  if (!due.length) due.push(at(ctx, IDLE_LOOK_MS).getTime());
  const timer = due.length ? { at: new Date(Math.min(...due)), event: { type: 'Tick' } } : null;
  return { next: { name: 'open', data: d }, writes, messages, work, timer };
}

const stopTo = (key: string, who: string | null): MessageRequest =>
  ({ to: { machine: BOT_BUILD, key }, event: { type: 'StopRequested', payload: { by: who || 'an admin' } as Json } });

function runCancelled(s: LState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<LState> {
  const runId = e.payload.runId as number;
  // Its trials running are stopped by their builds, wherever they run, and
  // recorded cancelled when they end (the run is).
  const messages = f.running.filter((t) => t.runId === runId && t.buildKey).map((t) => stopTo(t.buildKey!, e.payload.by));
  // The run as the write leaves it: no longer open.
  const after: Facts = { ...f, runs: f.runs.filter((r) => r.id !== runId) };
  return decide(live(s), after, ctx, { writes: [{ type: 'runCancelled', runId }], messages, sides: [runId] });
}

function trialCancelled(s: LState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<LState> {
  const t = f.trial!;
  const p = e.payload as { trialId: number; by: string | null; why: string | null };
  if (t.status === 'running') {
    return decide(live(s), f, ctx, { messages: t.buildKey ? [stopTo(t.buildKey, p.by)] : [] });
  }
  const waiting = new Map(f.waiting);
  waiting.set(t.runId, (f.waiting.get(t.runId) || []).filter((x) => x.id !== t.id));
  const pendingCount = new Map(f.pendingCount);
  if (t.status === 'pending') pendingCount.set(t.runId, Math.max((pendingCount.get(t.runId) || 1) - 1, 0));
  return decide(live(s), { ...f, waiting, pendingCount, abandoned: f.abandoned.filter((x) => x.id !== t.id) }, ctx, {
    writes: [{ type: 'trialCancelled', trialId: t.id, error: p.why || (p.by ? `cancelled by ${p.by}` : 'cancelled by an admin') }],
    sides: [t.runId],
  });
}

function look(s: LState, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<LState> {
  const runId = e.payload?.runId as number | null;
  // A trial added to a run that had ended (done, or capped): it runs again.
  if (runId && f.run && ['done', 'capped'].includes(f.run.status) && f.run.pending > 0) {
    const { status: _s, pending: _p, ...run } = f.run;
    const runs = [...f.runs, run].sort((a, b) => a.id - b.id);
    return decide(live(s), { ...f, runs }, ctx, { writes: [{ type: 'reopened', runId }] });
  }
  return decide(live(s), f, ctx);
}

function workDone(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext): Outcome<LState> {
  const p = e.payload as WorkResultPayload;
  let d = s.data;
  if (p.kind === WORK.gate && d.gate.running != null && p.workKey === `gate:${d.gate.running}`) {
    const r = (e.type === 'WorkSucceeded' ? p.result : null) as { ok?: boolean; reason?: string } | null;
    // A look that failed counts as not allowed, for a minute.
    d = { ...d, gate: { ...d.gate, running: null, at: ctx.now.toISOString(), ok: !!r?.ok, reason: r?.reason ?? (r ? null : 'the allowance could not be read') } };
  }
  return decide(d, f, ctx);
}

export function benchLane() {
  const any = (to: (s: any, e: Event<any>, f: Facts, ctx: TransitionContext) => Outcome<LState>) => ({ to });
  const cancelRun = {
    guard: (_s: any, _e: Event<any>, f: Facts) => (!f.run ? reject('no_run') : ['queued', 'running'].includes(f.run.status) ? ok() : reject('not_running')),
    to: runCancelled,
  };
  const cancelTrial = {
    guard: (_s: any, _e: Event<any>, f: Facts) => {
      if (!f.trial) return reject('no_trial');
      return ['pending', 'awaiting', 'running'].includes(f.trial.status) ? ok() : reject(`already_${f.trial.status}`);
    },
    to: trialCancelled,
  };
  const row = {
    Look: any(look), Tick: any(look), BuildEnded: any(look), RunCancelled: cancelRun, TrialCancelled: cancelTrial,
    WorkSucceeded: { to: workDone }, WorkFailed: { to: workDone }, WorkExhausted: { to: workDone },
  };
  const system = (e: Event<any>) => (['system', 'admin'].includes(e.source.kind) ? ok() : reject('not_the_platform'));
  return defineMachine<LState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['Look', 'Tick', 'BuildEnded', 'RunCancelled', 'TrialCancelled'],
    decode: (r) => ({ name: r.state as Name, data: r.data as Data }),
    facts: (tx, _s, e, ctx) => readFacts(tx, { runId: e.payload?.runId ?? null, trialId: e.payload?.trialId ?? null }, ctx.now),
    authorize: {
      Look: system, RunCancelled: system, TrialCancelled: system,
      BuildEnded: (e) => (e.source.kind === 'message' && e.source.from.machine === BOT_BUILD ? ok() : reject('bot_build_only')),
      Tick: (e) => (e.source.kind === 'timer' || e.source.kind === 'system' ? ok() : reject('not_the_clock')),
    },
    reply: async (_tx, e, _after, _ctx, f) => {
      if (e.type !== 'TrialCancelled' || !f.trial) return undefined;
      return { status: f.trial.status === 'running' ? 'stopping' : 'cancelled' } as Json;
    },
    transitions: {
      [NONE]: { ...row, WorkSucceeded: { ignore: 'not_started' }, WorkFailed: { ignore: 'not_started' }, WorkExhausted: { ignore: 'not_started' } },
      open: row,
    } as any,
    writes: {
      // The claim, and the run under way: its build's Requested is this
      // transition's message, so the two commit together.
      // A trial no longer pending here was changed outside this lock (an
      // older release's process, during a rollout): the transition is tried
      // again on what the rows say now, so no build goes for a claim that
      // did not happen.
      claim: async (tx, w) => {
        const { rowCount } = await tx.query(
          `UPDATE bench_trials SET status = 'running', claims = claims + 1, started_at = NOW(),
                  first_started_at = COALESCE(first_started_at, NOW()), checkpoint = NULL, build_key = $2
            WHERE id = $1 AND status = 'pending'`, [w.trialId, w.buildKey]);
        if (!rowCount) throw Object.assign(new Error(`trial ${w.trialId} changed while it was granted`), { code: '40001' });
        await tx.query(
          `UPDATE bench_runs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1 AND status = 'queued'`, [w.runId]);
      },
      // Done only with nothing of it waiting or running, read again here:
      // a trial added since the facts were read keeps it open.
      done: async (tx, w) => {
        await tx.query(
          `UPDATE bench_runs SET status = 'done', finished_at = NOW()
            WHERE id = $1 AND status IN ('queued', 'running')
              AND NOT EXISTS (SELECT 1 FROM bench_trials WHERE run_id = $1 AND status IN ('pending', 'running'))`, [w.runId]);
      },
      // The cap: what is left of it skipped, and the run capped, together.
      capped: async (tx, w) => {
        await tx.query(
          `WITH skipped AS (
             UPDATE bench_trials SET status = 'skipped_cap', finished_at = NOW() WHERE run_id = $1 AND status = 'pending' RETURNING id)
           UPDATE bench_runs SET status = 'capped', finished_at = NOW() WHERE id = $1 AND status IN ('queued', 'running')`, [w.runId]);
      },
      runCancelled: async (tx, w) => {
        await tx.query(
          `WITH run AS (
             UPDATE bench_runs SET status = 'cancelled', finished_at = NOW() WHERE id = $1 AND status IN ('queued', 'running') RETURNING id)
           UPDATE bench_trials SET status = 'cancelled', finished_at = NOW()
            WHERE run_id IN (SELECT id FROM run) AND status IN ('pending', 'awaiting')`, [w.runId]);
      },
      trialCancelled: async (tx, w) => {
        await tx.query(
          `UPDATE bench_trials SET status = 'cancelled', finished_at = NOW(), error = $2
            WHERE id = $1 AND status IN ('pending', 'awaiting')`, [w.trialId, w.error]);
      },
      reopened: async (tx, w) => {
        await tx.query(
          `UPDATE bench_runs SET status = 'running', finished_at = NULL
            WHERE id = $1 AND status IN ('done', 'capped')
              AND EXISTS (SELECT 1 FROM bench_trials WHERE run_id = $1 AND status = 'pending')`, [w.runId]);
      },
    },
  });
}
