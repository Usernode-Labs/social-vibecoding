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
// record), and the trial is cleaned up as any other. A phase past its time
// ends the trial the same way. A trial an older build's runner left (its
// heartbeat quiet: its process is gone) is cleaned up and queued again, once.
//
// workflow-foundation's design-step4-lanes.md is the design.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, TransitionContext, WorkRequest, WorkRef, WorkResultPayload } from '../kernel/index.ts';
import { readFacts } from './facts.ts';
import type { Facts } from './facts.ts';

export const MACHINE = 'shots-eval';
export const KEY = 'evals';
export const WORK = Object.freeze({
  copies: 'eval.copies', agent: 'eval.agent', compare: 'eval.compare', cleanup: 'eval.cleanup', pairs: 'eval.pairs',
});

export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 4;
// A trial is put back once when a restart (an older build's runner) cut it.
export const MAX_ATTEMPTS = 2;
export const INTERRUPTED_REASON = 'Homeroom restarted while this trial was being taken, twice.';
// How long building the copies may take, and the agent past its budget.
export const COPIES_MS = 30 * 60 * 1000;
export const AGENT_SLACK_MS = 10 * 60 * 1000;
export const COMPARE_MS = 10 * 60 * 1000;
// The shots agent busy or gone at its dispatch: tried again this soon, at
// most this often, while a minute of its budget is left.
export const AGENT_RETRY_MS = 20 * 1000;
const MAX_BUSY_RETRIES = 2;
const MIN_RETRY_LEFT_MS = 60 * 1000;

type Phase = 'copies' | 'agent' | 'compare' | 'cleanup';
type End = { state: 'verified' | 'failed' | 'cancelled' | 'requeue'; code?: string | null; reason?: string | null;
  verdict?: Json; planHash?: string | null; trace?: Json };
export interface Trial {
  id: number; evalId: number; sessionId: number; attempt: string; appSlug: string | null;
  phase: Phase; due: string | null;
  agentMs: number; agentStarted: string | null; dispatches: number; busy: number; died: boolean; retryAt: string | null;
  // The agent may still run: its cleanup stops its turn.
  stopTurn: boolean;
  reportedCents: number;
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

function cleanup(t: Trial, end: End, ctx: TransitionContext): { trial: Trial; work: WorkRequest; cancel: WorkRef[] } {
  const cancel = outstanding(t);
  const stopTurn = t.stopTurn || t.phase === 'agent';
  const trial: Trial = { ...t, phase: 'cleanup', due: null, retryAt: null, stopTurn, end: t.end && t.end.state !== 'verified' ? t.end : end };
  return {
    trial, cancel,
    work: work(WORK.cleanup, trial, { attemptId: t.attempt, sessionId: t.sessionId, appSlug: t.appSlug, stopTurn } as Json),
  };
}

// `ended`: trials this transition ended (its write lands after the facts
// were read: their rows still read active there).
interface Step { data: Data; writes: any[]; work: WorkRequest[]; cancel: WorkRef[]; ended: Set<number> }

// Grant what may start now, and set the clock: every trial's next due
// time, and a minute while trials wait on a proposal busy with its own.
function decide(s0: Step, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<EState> {
  let d = s0.data;
  const writes = s0.writes.slice();
  const workOut = s0.work.slice();
  const cancel = s0.cancel.slice();
  const now = ctx.now.getTime();
  // An older build's runner's trial whose process is gone: cleaned up here,
  // then queued again (or failed).
  const active = f.active.filter((a) => !s0.ended.has(a.id));
  for (const a of active) {
    if (d.trials[a.id] || !a.stale) continue;
    const t: Trial = {
      id: a.id, evalId: a.evalId, sessionId: a.sessionId, attempt: a.attemptId, appSlug: a.appSlug, phase: 'cleanup', due: null,
      agentMs: deps.defaultAgentMs, agentStarted: null, dispatches: 0, busy: 0, died: false, retryAt: null, stopTurn: true,
      reportedCents: 0, end: null, attempts: a.attempts,
    };
    const again = a.attempts < MAX_ATTEMPTS && a.evalStatus === 'running';
    const c = cleanup(t, again ? { state: 'requeue' } : { state: 'failed', code: 'shots_eval_interrupted', reason: INTERRUPTED_REASON }, ctx);
    d = { trials: { ...d.trials, [a.id]: c.trial } };
    workOut.push(c.work);
  }
  const mine = Object.values(d.trials);
  const sessionsBusy = new Set<number>([...active.map((a) => a.sessionId), ...mine.map((t) => t.sessionId)]);
  const activeIds = new Set<number>([...active.map((a) => a.id), ...mine.map((t) => t.id)]);
  let running = activeIds.size;
  // An eval's money: what it spent, plus each trial of it running at what
  // it has spent so far or its estimate, the larger.
  const proxyOf = new Map(active.map((a) => [a.id, a.proxyCents]));
  const evalOf = (id: number) => active.find((a) => a.id === id)?.evalId ?? d.trials[id]?.evalId;
  const committed = (evalId: number) => [...activeIds]
    .filter((id) => evalOf(id) === evalId)
    .reduce((sum, id) => sum + Math.max(proxyOf.get(id) || 0, f.estimateCents), 0);
  const skip = new Set<number>();
  let waiting = false;
  for (const p of f.planned) {
    if (running >= deps.concurrency) break;
    if (skip.has(p.evalId) || sessionsBusy.has(p.sessionId)) continue;
    if (f.liveShots.has(p.sessionId)) { waiting = true; continue; }
    const ev = f.evals.find((e) => e.id === p.evalId);
    if (!ev) continue;
    if (ev.spent + committed(p.evalId) + f.estimateCents > ev.cap) {
      // Wait for what is under way, then stop the eval there.
      if (!committed(p.evalId)) writes.push({ type: 'capped', evalId: p.evalId });
      skip.add(p.evalId);
      continue;
    }
    const t: Trial = {
      id: p.id, evalId: p.evalId, sessionId: p.sessionId, attempt: p.attemptId, appSlug: p.appSlug,
      phase: 'copies', due: iso(now + COPIES_MS), agentMs: p.agentMs || deps.defaultAgentMs, agentStarted: null,
      dispatches: 0, busy: 0, died: false, retryAt: null, stopTurn: false, reportedCents: 0, end: null, attempts: p.attempts + 1,
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
  // An older build's runner's trials: looked at again once they could be stale.
  if (active.some((a) => !d.trials[a.id])) times.push(now + 60 * 1000);
  const due = times.filter((x) => Number.isFinite(x) && x > now);
  const timer = due.length ? { at: new Date(Math.min(...due)), event: { type: 'Tick' } } : null;
  return { next: { name: 'open', data: d }, writes, work: workOut, cancel, timer };
}

const start = (s: EState): Step => ({ data: s.name === NONE ? { trials: {} } : (s as Live).data, writes: [], work: [], cancel: [], ended: new Set() });

// The clock: phases past their time end their trial; a re-dispatch due runs.
function tick(s: EState, e: Event<any>, f: Facts, ctx: TransitionContext, deps: Deps): Outcome<EState> {
  const st = start(s);
  const now = ctx.now.getTime();
  for (const t of Object.values(st.data.trials)) {
    if (t.retryAt && Date.parse(t.retryAt) <= now) {
      const left = Date.parse(t.agentStarted!) + t.agentMs - now;
      const next: Trial = { ...t, retryAt: null, dispatches: t.dispatches + 1 };
      st.data = { trials: { ...st.data.trials, [t.id]: next } };
      st.work.push(work(WORK.agent, next, { attemptId: t.attempt, sessionId: t.sessionId, trialId: t.id, budgetMs: Math.max(left, MIN_RETRY_LEFT_MS) } as Json, agentKey(next)));
      continue;
    }
    if (t.due && Date.parse(t.due) <= now && t.phase !== 'cleanup') {
      const c = cleanup(t, { state: 'failed', code: 'shots_eval_timeout', reason: `The trial ran out of time while ${t.phase === 'copies' ? 'its copies were built' : t.phase === 'agent' ? 'the shots agent worked' : 'its shots were kept'}.` }, ctx);
      st.data = { trials: { ...st.data.trials, [t.id]: c.trial } };
      st.work.push(c.work);
      st.cancel.push(...c.cancel);
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
    const c = cleanup(t, { state: 'cancelled' }, ctx);
    st.data = { trials: { ...st.data.trials, [t.id]: c.trial } };
    st.work.push(c.work);
    st.cancel.push(...c.cancel);
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
  const failWith = (x: Trial, code: string, reason: string, extra: Partial<End> = {}) => {
    const c = cleanup(x, { state: 'failed', code, reason, ...extra }, ctx);
    put(c.trial, x.id);
    st.work.push(c.work);
  };
  if (!t) return decide(st, f, ctx, deps);
  const failure = (fallback: string) => ({ code: String(r?.failed?.code || p.error?.code || 'shots_eval_failed').slice(0, 64), reason: String(r?.failed?.message || p.error?.message || fallback).slice(0, 2000) });
  if (p.kind === WORK.copies && t.phase === 'copies' && p.workKey === keyOf('copies', t)) {
    if (!ok || r?.failed) { const fl = failure('Its copies could not be built.'); failWith(t, fl.code, fl.reason); }
    else if (r?.stale) failWith(t, 'shots_eval_ended', 'The trial ended while its copies were built.');
    else {
      const next: Trial = { ...t, phase: 'agent', agentStarted: ctx.now.toISOString(), dispatches: 1,
        due: iso(ctx.now.getTime() + t.agentMs + AGENT_SLACK_MS), stopTurn: true };
      put(next, t.id);
      st.writes.push({ type: 'moved', trialId: t.id, attemptId: t.attempt, state: 'exploring' });
      st.work.push(work(WORK.agent, next, { attemptId: t.attempt, sessionId: t.sessionId, trialId: t.id, budgetMs: t.agentMs } as Json, agentKey(next)));
    }
  } else if (p.kind === WORK.agent && t.phase === 'agent' && p.workKey === keyOf('agent', t, agentKey(t))) {
    const reported = t.reportedCents + (Number(r?.reportedCents) || 0);
    const x: Trial = { ...t, reportedCents: reported };
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
      const c = cleanup(t, { state: 'verified', verdict: r?.verdict ?? null, planHash: t.planHash ?? null, trace: t.trace ?? null }, ctx);
      put(c.trial, t.id);
      st.writes.push({ type: 'moved', trialId: t.id, attemptId: t.attempt, state: 'reviewing', verdict: r?.verdict ?? null, planHash: t.planHash ?? null });
      st.work.push(c.work);
    }
  } else if (p.kind === WORK.cleanup && t.phase === 'cleanup' && p.workKey === keyOf('cleanup', t)) {
    // Done, or given up after its tries (an admin sees it in Admin →
    // Workflows): the trial's end is written either way, with its cost.
    st.writes.push({ type: 'ended', trialId: t.id, attemptId: t.attempt, evalId: t.evalId, end: t.end, reportedCents: t.reportedCents,
      cleaned: ok, attempts: t.attempts });
    put(null, t.id);
    st.ended.add(t.id);
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
    facts: (tx, _s, e) => readFacts(tx, { evalId: e.payload?.evalId ?? null }),
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
      claim: async (tx, w) => {
        await tx.query(
          `UPDATE shots_eval_trials
              SET state = 'provisioning', attempts = attempts + 1, started_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND attempt_id = $2 AND state = 'planned'`, [w.trialId, w.attemptId]);
      },
      moved: async (tx, w) => {
        await tx.query(
          `UPDATE shots_eval_trials
              SET state = $3, updated_at = NOW(), hard_verdict = COALESCE($4::jsonb, hard_verdict), plan_hash = COALESCE($5, plan_hash)
            WHERE id = $1 AND attempt_id = $2 AND state IN ('provisioning', 'exploring', 'reviewing')`,
          [w.trialId, w.attemptId, w.state, w.verdict == null ? null : JSON.stringify(w.verdict), w.planHash ?? null]);
      },
      // The trial's end, with its cost on it and on its eval, once: what
      // the proxy billed and what Claude Code reported, the larger, both
      // emptied in the same write. Put back (a restart cut it): a fresh
      // attempt, its earlier files gone.
      ended: async (tx, w) => {
        const e = (w.end || { state: 'failed', code: 'shots_eval_failed', reason: 'The trial ended without shots.' }) as End;
        const { rows: [cost] } = await tx.query(
          `WITH t AS (
             SELECT id, eval_run_id, GREATEST(proxy_cents, reported_cents + $3::numeric) AS cents
               FROM shots_eval_trials WHERE id = $1 AND attempt_id = $2 FOR UPDATE),
           trial AS (
             UPDATE shots_eval_trials s SET cost_cents = s.cost_cents + t.cents, proxy_cents = 0, reported_cents = 0
               FROM t WHERE s.id = t.id RETURNING t.eval_run_id, t.cents)
           UPDATE shots_eval_runs r SET spent_cents = r.spent_cents + trial.cents FROM trial WHERE r.id = trial.eval_run_id
           RETURNING trial.cents`, [w.trialId, w.attemptId, Number(w.reportedCents) || 0]);
        void cost;
        const trace = { ...((e.trace as object) || {}), ...(w.cleaned ? {} : { cleanupFailed: true }) };
        if (e.state === 'requeue') {
          await tx.query('DELETE FROM shots_eval_artifacts WHERE trial_id = $1', [w.trialId]);
          await tx.query(
            `UPDATE shots_eval_trials
                SET state = 'planned', attempt_id = md5(random()::text || clock_timestamp()::text), started_at = NULL, updated_at = NOW(),
                    recipe = NULL, hard_verdict = NULL, plan_hash = NULL, trace_summary = NULL, failure_code = NULL, failure_reason = NULL
              WHERE id = $1 AND attempt_id = $2 AND state IN ('provisioning', 'exploring', 'reviewing')`, [w.trialId, w.attemptId]);
          return;
        }
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
