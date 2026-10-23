// shots-eval: the trials of before & after shots evals (services/
// shots-eval.js), an admin's comparison of shots agent recipes on merged
// proposals. One instance (`evals`), so its limits hold however many
// processes run the workflow: at most `concurrency` trials at once, never
// two on one proposal, never beside the proposal's own shots run, and each
// eval's cap: what it spent, plus what its trials running have spent (or
// their estimate, when more), plus the next one's estimate.
//
// Each trial it grants is its own work here, phase by phase, the steps the
// shots machine (shots/) runs for a proposal, on the trial's attempt id:
// its copies (eval.copies), its shots agent with the arm's model, prompts
// and time (eval.agent, a turn this instance's work owns), where its screens
// differ, with its files kept (eval.compare), and, however it ends, the
// cleanup of everything it made (eval.cleanup, tried until it is done). Its
// row moves with it; its end is written once its cleanup is done, with its
// cost (the larger of what the proxy billed and what Claude Code reported),
// which goes on its eval in the same write.
//
// A cancel stops what runs (its work cancelled, its turn stopped by its
// record, its row marked stopping so its work stops at its next step), and
// the trial is cleaned up as any other; copies still being built are left
// to stop there, and their cleanup waits for them. A phase past its time
// ends the trial the same way, and so does its row ended elsewhere.
//
// workflow-foundation's design-step4-lanes.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, TransitionContext, WorkRequest, WorkRef, WorkResultPayload } from '../kernel/index.ts';
import { settleAttempt } from './costs.ts';
import { ACTIVE_STATES, readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = 'shots-eval';
export const KEY = 'evals';
export const WORK = Object.freeze({
  copies: 'eval.copies', agent: 'eval.agent', compare: 'eval.compare', cleanup: 'eval.cleanup', pairs: 'eval.pairs',
});

export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 4;
// How long building the copies may take, and the agent past its budget.
export const COPIES_MS = 30 * 60 * 1000;
export const AGENT_SLACK_MS = 10 * 60 * 1000;
export const COMPARE_MS = 10 * 60 * 1000;
// The shots agent busy or gone at its dispatch: tried again this soon, at
// most this often, while a minute of its budget is left.
export const AGENT_RETRY_MS = 20 * 1000;
// How long a trial's cleanup waits for copies it stopped to say so.
export const AWAIT_COPIES_MS = 10 * 60 * 1000;
// With nothing due, a look this often all the same: an ask to look that was
// lost (a launch whose Look failed) waits no longer.
export const IDLE_LOOK_MS = 10 * 60 * 1000;
const MAX_BUSY_RETRIES = 2;
const MIN_RETRY_LEFT_MS = 60 * 1000;

type Phase = 'copies' | 'agent' | 'compare' | 'cleanup';
type End = { state: 'verified' | 'failed' | 'cancelled'; code?: string | null; reason?: string | null;
  verdict?: Json; planHash?: string | null; trace?: Json };
export interface Trial {
  id: number; evalId: number; sessionId: number; attempt: string; appSlug: string | null;
  phase: Phase; due: string | null;
  agentMs: number; agentStarted: string | null; dispatches: number; busy: number; died: boolean; retryAt: string | null;
  // The agent may still run: its cleanup stops its turn.
  stopTurn: boolean;
  // Its copies, stopped, still to say so: its cleanup waits for them.
  awaitCopies?: boolean;
  end: End | null;
  // What the agent saved, kept for the files: its slots and its plan's hash.
  slots?: string[]; planHash?: string | null; trace?: Json;
  attempts: number;
}
export interface Data { trials: Record<string, Trial> }
export type EState = { name: 'open'; data: Data } | { name: typeof NONE; data: null };
type Live = Extract<EState, { data: Data }>;

const EVENTS = {
  // Look again: an eval launched.
  Look: () => ({}),
  EvalCancelled: (p: any) => {
    if (!Number.isInteger(p?.evalId) || p.evalId <= 0) throw new Error('evalId must be a positive integer');
    return { evalId: p.evalId as number };
  },
  Tick: () => ({}),
};

export interface Deps { concurrency: number; defaultAgentMs: number }

const iso = (ms: number) => new Date(ms).toISOString();
const keyOf = (kind: string, t: Trial, extra = '') => `${kind}:${t.id}:${t.attempt}${extra}`;
const work = (kind: string, t: Trial, input: Json, extra = ''): WorkRequest => ({ kind, key: keyOf(kind.split('.')[1], t, extra), input });
const agentKey = (t: Trial) => `:${t.dispatches}`;

// What runs of a trial now, cancelled when it ends early.
function outstanding(t: Trial): WorkRef[] {
  if (t.phase === 'copies') return [{ kind: WORK.copies, key: keyOf('copies', t) }];
  if (t.phase === 'agent' && !t.retryAt) return [{ kind: WORK.agent, key: keyOf('agent', t, agentKey(t)) }];
  if (t.phase === 'compare') return [{ kind: WORK.compare, key: keyOf('compare', t) }];
  return [];
}

const cleanupWork = (t: Trial): WorkRequest =>
  work(WORK.cleanup, t, { attemptId: t.attempt, sessionId: t.sessionId, appSlug: t.appSlug, stopTurn: t.stopTurn } as Json);

// The trial ends: what runs of it cancelled, its row marked stopping (its
// work stops at its next step), and its cleanup. Copies still being built
// are left to stop there and say so (they would build on after a cleanup
// that ran beside them), and the cleanup waits for them, as the shots
// machine's does.
interface Ending { trial: Trial; work: WorkRequest | null; cancel: WorkRef[]; writes: any[] }
function cleanup(t: Trial, end: End, ctx: TransitionContext, { copiesSettled = false } = {}): Ending {
  const awaitCopies = t.phase === 'copies' && !copiesSettled;
  const stopTurn = t.stopTurn || t.phase === 'agent';
  const trial: Trial = {
    ...t, phase: 'cleanup', due: awaitCopies ? iso(ctx.now.getTime() + AWAIT_COPIES_MS) : null, retryAt: null, stopTurn,
    end: t.end && t.end.state !== 'verified' ? t.end : end, ...(awaitCopies ? { awaitCopies: true } : {}),
  };
  return {
    trial,
    cancel: outstanding(t).filter((w) => !(awaitCopies && w.kind === WORK.copies)),
    work: awaitCopies ? null : cleanupWork(trial),
    writes: end.state === 'verified' ? [] : [{ type: 'stopping', trialId: t.id, attemptId: t.attempt }],
  };
}

// `ended`: trials this transition ended (its write lands after the facts
// were read: their rows still read active there), and `charged`, what their
// ends put on each eval's spend, which the facts do not hold yet either.
interface Step { data: Data; writes: any[]; work: WorkRequest[]; cancel: WorkRef[]; ended: Set<number>; charged: Map<number, number> }

function apply(st: Step, c: Ending) {
  st.data = { trials: { ...st.data.trials, [c.trial.id]: c.trial } };
  if (c.work) st.work.push(c.work);
  st.cancel.push(...c.cancel);
  st.writes.push(...c.writes);
}

// Grant what may start now, and set the clock: every trial's next due
// time, and a minute while trials wait on a proposal busy with its own.
function decide(s0: Step, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<EState> {
  // A trial of this machine's whose row no longer reads it running (ended
  // or put back elsewhere): stopped and cleaned up here.
  const st: Step = { ...s0, writes: s0.writes.slice(), work: s0.work.slice(), cancel: s0.cancel.slice() };
  for (const t of Object.values(s0.data.trials)) {
    if (t.phase === 'cleanup') continue;
    const row = f.mine.get(t.id);
    if (row && row.attemptId === t.attempt && ACTIVE_STATES.includes(row.state)) continue;
    apply(st, cleanup(t, row?.state === 'cancelled'
      ? { state: 'cancelled' }
      : { state: 'failed', code: 'shots_eval_ended', reason: 'The trial was ended elsewhere while it ran.' }, ctx));
  }
  let d = st.data;
  const writes = st.writes;
  const workOut = st.work;
  const cancel = st.cancel;
  const now = ctx.now.getTime();
  const active = f.active.filter((a) => !s0.ended.has(a.id));
  const mine = Object.values(d.trials);
  const sessionsBusy = new Set<number>([...active.map((a) => a.sessionId), ...mine.map((t) => t.sessionId)]);
  const activeIds = new Set<number>([...active.map((a) => a.id), ...mine.map((t) => t.id)]);
  let running = activeIds.size;
  // An eval's money: what it spent, plus each trial of it running at what
  // it has spent so far or its estimate, the larger.
  const spentSoFar = new Map(active.map((a) => [a.id, Math.max(a.proxyCents, a.reportedCents)]));
  const evalOf = (id: number) => active.find((a) => a.id === id)?.evalId ?? d.trials[id]?.evalId;
  const committed = (evalId: number) => [...activeIds]
    .filter((id) => evalOf(id) === evalId)
    .reduce((sum, id) => sum + Math.max(spentSoFar.get(id) || 0, f.estimateCents), 0);
  const skip = new Set<number>();
  let waiting = false;
  for (const p of f.planned) {
    if (running >= deps.concurrency) break;
    if (skip.has(p.evalId) || sessionsBusy.has(p.sessionId)) continue;
    if (f.liveShots.has(p.sessionId)) { waiting = true; continue; }
    const ev = f.evals.find((e) => e.id === p.evalId);
    if (!ev) continue;
    if (ev.spent + (st.charged.get(p.evalId) || 0) + committed(p.evalId) + f.estimateCents > ev.cap) {
      // Wait for what is under way, then stop the eval there.
      if (!committed(p.evalId)) writes.push({ type: 'capped', evalId: p.evalId });
      skip.add(p.evalId);
      continue;
    }
    const t: Trial = {
      id: p.id, evalId: p.evalId, sessionId: p.sessionId, attempt: p.attemptId, appSlug: p.appSlug,
      phase: 'copies', due: iso(now + COPIES_MS), agentMs: p.agentMs || deps.defaultAgentMs, agentStarted: null,
      dispatches: 0, busy: 0, died: false, retryAt: null, stopTurn: false, end: null, attempts: p.attempts + 1,
    };
    writes.push({ type: 'claim', trialId: p.id, attemptId: p.attemptId });
    workOut.push(work(WORK.copies, t, {
      trialId: p.id, attemptId: p.attemptId, sessionId: p.sessionId, intent: p.intent as Json,
      baseSha: p.baseSha, headSha: p.headSha, budgetMs: t.agentMs,
    } as Json));
    d = { trials: { ...d.trials, [p.id]: t } };
    sessionsBusy.add(p.sessionId);
    activeIds.add(p.id);
    running += 1;
  }
  // An eval with nothing waiting and nothing running is done (the write
  // checks again).
  for (const ev of f.evals) {
    const left = f.planned.some((p) => p.evalId === ev.id) || [...activeIds].some((id) => evalOf(id) === ev.id);
    if (!left) writes.push({ type: 'done', evalId: ev.id });
  }
  const times: number[] = [];
  for (const t of Object.values(d.trials)) {
    if (t.due) times.push(Date.parse(t.due));
    if (t.retryAt) times.push(Date.parse(t.retryAt));
  }
  if (waiting) times.push(now + 60 * 1000);
  const due = times.filter((x) => Number.isFinite(x) && x > now);
  if (!due.length) due.push(now + IDLE_LOOK_MS);
  const timer = due.length ? { at: new Date(Math.min(...due)), event: { type: 'Tick' } } : null;
  return { next: { name: 'open', data: d }, writes, work: workOut, cancel, timer };
}

const start = (s: EState): Step => ({
  data: s.name === NONE ? { trials: {} } : (s as Live).data, writes: [], work: [], cancel: [], ended: new Set(), charged: new Map(),
});

// The clock: phases past their time end their trial; a re-dispatch due runs.
function tick(s: EState, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<EState> {
  const st = start(s);
  const now = ctx.now.getTime();
  for (const t of Object.values(st.data.trials)) {
    // Copies that never said they stopped: cancelled, and cleaned up anyway.
    if (t.awaitCopies && t.due && Date.parse(t.due) <= now) {
      const next: Trial = { ...t, awaitCopies: false, due: null };
      st.data = { trials: { ...st.data.trials, [t.id]: next } };
      st.cancel.push({ kind: WORK.copies, key: keyOf('copies', t) });
      st.work.push(cleanupWork(next));
      continue;
    }
    if (t.retryAt && Date.parse(t.retryAt) <= now) {
      const left = Date.parse(t.agentStarted!) + t.agentMs - now;
      const next: Trial = { ...t, retryAt: null, dispatches: t.dispatches + 1 };
      st.data = { trials: { ...st.data.trials, [t.id]: next } };
      st.work.push(work(WORK.agent, next, { attemptId: t.attempt, sessionId: t.sessionId, trialId: t.id, budgetMs: Math.max(left, MIN_RETRY_LEFT_MS) } as Json, agentKey(next)));
      continue;
    }
    if (t.due && Date.parse(t.due) <= now && t.phase !== 'cleanup') {
      apply(st, cleanup(t, { state: 'failed', code: 'shots_eval_timeout', reason: `The trial ran out of time while ${t.phase === 'copies' ? 'its copies were built' : t.phase === 'agent' ? 'the shots agent worked' : 'its shots were kept'}.` }, ctx));
    }
  }
  return decide(st, f, ctx, deps);
}

function cancelled(s: EState, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<EState> {
  const st = start(s);
  const evalId = e.payload.evalId as number;
  st.writes.push({ type: 'evalCancelled', evalId });
  for (const t of Object.values(st.data.trials)) {
    if (t.evalId !== evalId || t.phase === 'cleanup') continue;
    apply(st, cleanup(t, { state: 'cancelled' }, ctx));
  }
  // As the write leaves it: no longer running, nothing of it waiting.
  const after: Facts = { ...f, evals: f.evals.filter((ev) => ev.id !== evalId), planned: f.planned.filter((p) => p.evalId !== evalId) };
  return decide(st, after, ctx, deps);
}

const trialOfWork = (d: Data, p: WorkResultPayload): Trial | null => {
  const m = /^[a-z]+:(\d+):([0-9a-f]{32})/.exec(p.workKey);
  const t = m ? d.trials[m[1]] : null;
  return t && t.attempt === m![2] ? t : null;
};

function result(s: Live, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<EState> {
  const st = start(s);
  const p = e.payload as WorkResultPayload;
  const ok = e.type === 'WorkSucceeded';
  const r = (ok ? p.result : null) as any;
  if (p.kind === WORK.pairs) return decide(st, f, ctx, deps);
  const t = trialOfWork(st.data, p);
  const put = (x: Trial | null, id: number) => {
    const trials = { ...st.data.trials };
    if (x) trials[id] = x; else delete trials[id];
    st.data = { trials };
  };
  // `copiesSettled`: the copies' own result ends it.
  const failWith = (x: Trial, code: string, reason: string, extra: Partial<End> = {}, copiesSettled = false) => {
    apply(st, cleanup(x, { state: 'failed', code, reason, ...extra }, ctx, { copiesSettled }));
  };
  if (!t) return decide(st, f, ctx, deps);
  // Copies a cleanup waited for, stopped: now the cleanup.
  if (p.kind === WORK.copies && t.phase === 'cleanup' && t.awaitCopies && p.workKey === keyOf('copies', t)) {
    const next: Trial = { ...t, awaitCopies: false, due: null };
    put(next, t.id);
    st.work.push(cleanupWork(next));
    return decide(st, f, ctx, deps);
  }
  const failure = (fallback: string) => ({ code: String(r?.failed?.code || p.error?.code || 'shots_eval_failed').slice(0, 64), reason: String(r?.failed?.message || p.error?.message || fallback).slice(0, 2000) });
  if (p.kind === WORK.copies && t.phase === 'copies' && p.workKey === keyOf('copies', t)) {
    if (!ok || r?.failed) { const fl = failure('Its copies could not be built.'); failWith(t, fl.code, fl.reason, {}, true); }
    else if (r?.stale) failWith(t, 'shots_eval_ended', 'The trial ended while its copies were built.', {}, true);
    else {
      const next: Trial = { ...t, phase: 'agent', agentStarted: ctx.now.toISOString(), dispatches: 1,
        due: iso(ctx.now.getTime() + t.agentMs + AGENT_SLACK_MS), stopTurn: true };
      put(next, t.id);
      st.writes.push({ type: 'moved', trialId: t.id, attemptId: t.attempt, state: 'exploring' });
      st.work.push(work(WORK.agent, next, { attemptId: t.attempt, sessionId: t.sessionId, trialId: t.id, budgetMs: t.agentMs } as Json, agentKey(next)));
    }
  } else if (p.kind === WORK.agent && t.phase === 'agent' && p.workKey === keyOf('agent', t, agentKey(t))) {
    const x: Trial = t;
    const outcome = String(r?.agent?.outcome || (ok ? 'completed' : 'failed'));
    const left = Date.parse(t.agentStarted!) + t.agentMs - ctx.now.getTime();
    if (ok && !r?.passed && left >= MIN_RETRY_LEFT_MS && ((outcome === 'busy' && t.busy < MAX_BUSY_RETRIES) || (outcome === 'died' && !t.died))) {
      put({ ...x, busy: x.busy + (outcome === 'busy' ? 1 : 0), died: x.died || outcome === 'died', retryAt: iso(ctx.now.getTime() + AGENT_RETRY_MS) }, t.id);
    } else if (ok && r?.passed) {
      const next: Trial = { ...x, phase: 'compare', due: iso(ctx.now.getTime() + COMPARE_MS), stopTurn: false,
        slots: Array.isArray(r.slots) ? r.slots.map(String) : [], planHash: r.manifestHash ?? null, trace: r.trace ?? null };
      put(next, t.id);
      st.work.push(work(WORK.compare, next, { attemptId: t.attempt, trialId: t.id, verdict: r.verdict, slots: next.slots, headSha: null, planHash: next.planHash } as Json));
    } else if (!ok) {
      const fl = failure('The shots agent stopped.');
      failWith({ ...x, stopTurn: true }, fl.code, fl.reason);
    } else {
      // Not passed: the agent stopped, or its changes failed or were not all shot.
      const stoppedEarly = outcome !== 'completed' && !r?.skippedAny;
      const code = stoppedEarly ? String(r?.agent?.code || 'shots_agent_failed') : r?.failedCount ? 'shots_change_failed' : 'shots_capture_incomplete';
      const reason = stoppedEarly ? String(r?.agent?.message || 'The shots agent stopped.') : String((r?.failedCount ? r?.failedReason : r?.incompleteReason) || 'The shots agent did not save a before and after shot.');
      failWith({ ...x, stopTurn: outcome !== 'completed' }, code.slice(0, 64), reason.slice(0, 2000), { verdict: r?.verdict ?? null, trace: r?.trace ?? null });
    }
  } else if (p.kind === WORK.compare && t.phase === 'compare' && p.workKey === keyOf('compare', t)) {
    if (!ok || r?.failed) { const fl = failure('Its shots could not be kept.'); failWith(t, fl.code, fl.reason); }
    else {
      st.writes.push({ type: 'moved', trialId: t.id, attemptId: t.attempt, state: 'reviewing', verdict: r?.verdict ?? null, planHash: t.planHash ?? null });
      apply(st, cleanup(t, { state: 'verified', verdict: r?.verdict ?? null, planHash: t.planHash ?? null, trace: t.trace ?? null }, ctx));
    }
  } else if (p.kind === WORK.cleanup && t.phase === 'cleanup' && p.workKey === keyOf('cleanup', t)) {
    // Done, or given up after its tries (an admin sees it in Admin →
    // Workflows): the trial's end is written either way, with its cost.
    st.writes.push({ type: 'ended', trialId: t.id, attemptId: t.attempt, evalId: t.evalId, end: t.end, cleaned: ok, attempts: t.attempts });
    put(null, t.id);
    st.ended.add(t.id);
    // What the write charges its eval, for this transition's own cap check.
    const row = f.active.find((a) => a.id === t.id && a.attemptId === t.attempt);
    const cents = Math.max(row?.proxyCents || 0, row?.reportedCents || 0);
    st.charged.set(t.evalId, (st.charged.get(t.evalId) || 0) + cents);
    st.work.push({ kind: WORK.pairs, key: `pairs:${t.evalId}:${t.id}:${t.attempt}`, input: { evalId: t.evalId } });
  }
  return decide(st, f, ctx, deps);
}

export function shotsEval(deps: Deps) {
  const look = { to: (s: EState, e: Event<any>, f: Facts, ctx: TransitionContext) => decide(start(s), f, ctx, deps) };
  const clock = { to: (s: EState, e: Event<any>, f: Facts, ctx: TransitionContext) => tick(s, e, f, ctx, deps) };
  const cancel = {
    guard: (_s: any, _e: Event<any>, f: Facts) => (!f.eval ? reject('no_eval') : f.eval.status === 'running' ? ok() : reject('not_running')),
    to: (s: EState, e: Event<any>, f: Facts, ctx: TransitionContext) => cancelled(s, e, f, ctx, deps),
  };
  const results = { to: (s: Live, e: Event<any>, f: Facts, ctx: TransitionContext) => result(s, e, f, ctx, deps) };
  const system = (e: Event<any>) => (['system', 'admin'].includes(e.source.kind) ? ok() : reject('not_the_platform'));
  return defineMachine<EState, Facts>({
    name: MACHINE,
    version: 1,
    events: EVENTS,
    create: ['Look', 'Tick', 'EvalCancelled'],
    decode: (r) => ({ name: r.state as 'open', data: r.data as Data }),
    facts: (tx, s, e) => readFacts(tx, {
      evalId: e.payload?.evalId ?? null, mine: s.name === NONE ? [] : Object.keys((s as Live).data.trials).map(Number),
    }),
    authorize: {
      Look: system, EvalCancelled: system,
      Tick: (e) => (e.source.kind === 'timer' || e.source.kind === 'system' ? ok() : reject('not_the_clock')),
    },
    transitions: {
      [NONE]: { Look: look, Tick: clock, EvalCancelled: cancel,
        WorkSucceeded: { ignore: 'not_started' }, WorkFailed: { ignore: 'not_started' }, WorkExhausted: { ignore: 'not_started' } },
      open: { Look: look, Tick: clock, EvalCancelled: cancel, WorkSucceeded: results, WorkFailed: results, WorkExhausted: results },
    } as any,
    writes: {
      // A trial no longer planned here was changed outside this lock: the
      // transition is tried again on what the rows say now, so no work goes
      // for a claim that did not happen.
      claim: async (tx, w) => {
        const { rowCount } = await tx.query(
          `UPDATE shots_eval_trials
              SET state = 'provisioning', attempts = attempts + 1, started_at = NOW(), updated_at = NOW(), stopping_at = NULL
            WHERE id = $1 AND attempt_id = $2 AND state = 'planned'`, [w.trialId, w.attemptId]);
        if (!rowCount) throw Object.assign(new Error(`trial ${w.trialId} changed while it was granted`), { code: '40001' });
      },
      stopping: async (tx, w) => {
        await tx.query('UPDATE shots_eval_trials SET stopping_at = COALESCE(stopping_at, NOW()) WHERE id = $1 AND attempt_id = $2',
          [w.trialId, w.attemptId]);
      },
      moved: async (tx, w) => {
        await tx.query(
          `UPDATE shots_eval_trials
              SET state = $3, updated_at = NOW(), hard_verdict = COALESCE($4::jsonb, hard_verdict), plan_hash = COALESCE($5, plan_hash)
            WHERE id = $1 AND attempt_id = $2 AND state IN ('provisioning', 'exploring', 'reviewing')`,
          [w.trialId, w.attemptId, w.state, w.verdict == null ? null : JSON.stringify(w.verdict), w.planHash ?? null]);
      },
      // The trial's end, its attempt's cost settled on it and on its eval
      // (costs.ts: the larger of what the proxy billed and what Claude Code
      // reported; what comes later charges only what it adds).
      ended: async (tx, w) => {
        const e = (w.end || { state: 'failed', code: 'shots_eval_failed', reason: 'The trial ended without shots.' }) as End;
        await settleAttempt(tx, { trialId: w.trialId, attemptId: w.attemptId });
        const trace = { ...((e.trace as object) || {}), ...(w.cleaned ? {} : { cleanupFailed: true }) };
        await tx.query(
          `UPDATE shots_eval_trials
              SET state = CASE WHEN state = 'cancelled' THEN 'cancelled' ELSE $3 END,
                  hard_verdict = COALESCE($4::jsonb, hard_verdict), plan_hash = COALESCE($5, plan_hash),
                  trace_summary = COALESCE(trace_summary, '{}'::jsonb) || $6::jsonb,
                  failure_code = CASE WHEN $3 = 'failed' THEN $7 ELSE failure_code END,
                  failure_reason = CASE WHEN $3 = 'failed' THEN $8 ELSE failure_reason END,
                  completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
            WHERE id = $1 AND attempt_id = $2`,
          [w.trialId, w.attemptId, e.state, e.verdict == null ? null : JSON.stringify(e.verdict), e.planHash ?? null,
            JSON.stringify(trace), e.code ?? null, e.reason ?? null]);
      },
      capped: async (tx, w) => {
        await tx.query(
          `WITH ev AS (UPDATE shots_eval_runs SET status = 'capped', finished_at = NOW() WHERE id = $1 AND status = 'running' RETURNING id)
           UPDATE shots_eval_trials SET state = 'cancelled', completed_at = NOW(), updated_at = NOW()
            WHERE eval_run_id IN (SELECT id FROM ev) AND state = 'planned'`, [w.evalId]);
      },
      done: async (tx, w) => {
        await tx.query(
          `UPDATE shots_eval_runs SET status = 'done', finished_at = NOW()
            WHERE id = $1 AND status = 'running'
              AND NOT EXISTS (SELECT 1 FROM shots_eval_trials WHERE eval_run_id = $1
                                AND state IN ('planned', 'provisioning', 'exploring', 'reviewing'))`, [w.evalId]);
      },
      // Cancelled: the eval, and every trial of it not ended (a running
      // one's row reads cancelled at once; its cleanup writes its cost).
      evalCancelled: async (tx, w) => {
        await tx.query(
          `WITH ev AS (UPDATE shots_eval_runs SET status = 'cancelled', finished_at = NOW() WHERE id = $1 AND status = 'running' RETURNING id)
           UPDATE shots_eval_trials SET state = 'cancelled', completed_at = NOW(), updated_at = NOW()
            WHERE eval_run_id IN (SELECT id FROM ev) AND state IN ('planned', 'provisioning', 'exploring', 'reviewing')`, [w.evalId]);
      },
    },
  });
}
