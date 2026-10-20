// What the shots eval machine reads inside a transition, under its own lock
// (one instance, so two trials are never granted at once): the evals still
// running and what each has spent, the trials waiting in their order, every
// trial whose row reads active (this machine's, and an older build's
// runner's during a rollout), the rows of the trials it holds, which
// proposals are busy (their own shots, or any turn), whether two releases
// serve at once, and what a trial is estimated to cost. And, for a cancel,
// the eval it names.

import type { Tx } from '../kernel/index.ts';
import { SHOTS_LIVE_STATES } from '../session-work.ts';

export const ACTIVE_STATES: readonly string[] = Object.freeze(['provisioning', 'exploring', 'reviewing']);
// The estimate before five trials have finished (services/shots-eval.js).
export const DEFAULT_TRIAL_CENTS = 300;
const ESTIMATE_HISTORY = 50;
// How many waiting trials of each eval are read: enough to pass over the
// proposals busy now, and an eval waiting at its cap holds none of another's.
const QUEUE_READ = 20;

export interface Eval { id: number; cap: number; spent: number }
export interface Planned {
  id: number; evalId: number; sessionId: number; attemptId: string; attempts: number; agentMs: number | null;
  baseSha: string; headSha: string; intent: unknown; appSlug: string | null;
}
export interface Active { id: number; evalId: number; sessionId: number; attemptId: string; attempts: number; proxyCents: number; reportedCents: number; stale: boolean; appSlug: string | null; evalStatus: string }
export interface Facts {
  evals: Eval[];
  planned: Planned[];
  active: Active[];
  // Proposals busy: their own shots run under way, or any turn (an earlier
  // trial's still shutting down): no trial starts beside it.
  liveShots: ReadonlySet<number>;
  // The rows of the trials this machine holds: their attempt and state now.
  mine: ReadonlyMap<number, { attemptId: string; state: string }>;
  // More than one release serving (a rollout under way): a trial's calls
  // could reach an older one, which does not bill them to the trial.
  rollout: boolean;
  estimateCents: number;
  // The eval a cancel names.
  eval: { id: number; status: string } | null;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// A trial an older build's runner kept beat every 30 seconds (its
// heartbeat); quiet this long, its process is gone.
export const STALE_SECONDS = 5 * 60;
// A process that has beaten this recently is alive (processes.js LIVE_SECONDS).
const SERVING_SECONDS = 45;

export async function readFacts(tx: Tx, p: { evalId?: number | null; mine?: number[] }): Promise<Facts> {
  const { rows: evalRows } = await tx.query(
    `SELECT id, cap_cents::float8 AS cap, spent_cents::float8 AS spent FROM shots_eval_runs WHERE status = 'running' ORDER BY id`);
  const { rows: activeRows } = await tx.query(
    `SELECT t.id, t.eval_run_id, t.session_id, t.attempt_id, t.attempts, t.proxy_cents::float8 AS proxy, t.reported_cents::float8 AS reported,
            t.updated_at < NOW() - make_interval(secs => $2) AS stale, a.slug AS app_slug, r.status AS eval_status
       FROM shots_eval_trials t
       JOIN shots_eval_runs r ON r.id = t.eval_run_id
       LEFT JOIN chat_sessions cs ON cs.id = t.session_id
       LEFT JOIN apps a ON a.id = cs.app_id
      WHERE t.state = ANY($1::text[])`, [ACTIVE_STATES, STALE_SECONDS]);
  const { rows: plannedRows } = await tx.query(
    `SELECT * FROM (
       SELECT t.id, t.eval_run_id, t.session_id, t.attempt_id, t.attempts, t.base_sha, t.head_sha, t.intent, t.position,
              (c.recipe->>'agentMinutes')::float8 AS agent_minutes, a.slug AS app_slug,
              ROW_NUMBER() OVER (PARTITION BY t.eval_run_id ORDER BY t.position) AS place
         FROM shots_eval_trials t
         JOIN shots_eval_runs r ON r.id = t.eval_run_id
         LEFT JOIN shots_eval_configs c ON c.id = t.config_id
         LEFT JOIN chat_sessions cs ON cs.id = t.session_id
         LEFT JOIN apps a ON a.id = cs.app_id
        WHERE t.state = 'planned' AND r.status = 'running') q
      WHERE place <= $1
      ORDER BY eval_run_id, position`, [QUEUE_READ]);
  const sessions = [...new Set(plannedRows.map((r: any) => Number(r.session_id)))];
  const liveShots = new Set<number>();
  if (sessions.length) {
    const { rows } = await tx.query(
      `SELECT cs.id FROM chat_sessions cs
        WHERE cs.id = ANY($1::int[])
          AND (COALESCE(cs.shots_state, '') IN ('planned', 'provisioning', 'exploring', 'replaying', 'reviewing')
               OR cs.active_turn IS NOT NULL
               OR EXISTS (SELECT 1 FROM wf_instances w WHERE w.machine = 'shots' AND w.key = 'session:' || cs.id
                             AND w.state = ANY($2::text[])))`, [sessions, SHOTS_LIVE_STATES]);
    for (const r of rows) liveShots.add(Number(r.id));
  }
  const { rows: costs } = await tx.query(
    `SELECT cost_cents::float8 AS cents FROM shots_eval_trials
      WHERE state IN ('verified', 'failed') AND cost_cents > 0
      ORDER BY completed_at DESC NULLS LAST LIMIT $1`, [ESTIMATE_HISTORY]);
  const sorted = costs.map((r: any) => Number(r.cents)).filter((c: number) => Number.isFinite(c) && c > 0).sort((a: number, b: number) => a - b);
  const estimateCents = sorted.length < 5 ? DEFAULT_TRIAL_CENTS
    : Math.max(1, Math.ceil(sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]));
  const mine = new Map<number, { attemptId: string; state: string }>();
  if (p.mine?.length) {
    const { rows } = await tx.query('SELECT id, attempt_id, state FROM shots_eval_trials WHERE id = ANY($1::int[])', [p.mine]);
    for (const r of rows) mine.set(Number(r.id), { attemptId: String(r.attempt_id), state: String(r.state) });
  }
  const { rows: [releases] } = await tx.query(
    `SELECT COUNT(DISTINCT release)::int AS n FROM platform_processes
      WHERE state = 'serving' AND heartbeat_at > NOW() - make_interval(secs => $1)`, [SERVING_SECONDS]);
  let named: Facts['eval'] = null;
  if (p.evalId) {
    const { rows: [e] } = await tx.query('SELECT id, status FROM shots_eval_runs WHERE id = $1', [p.evalId]);
    if (e) named = { id: Number(e.id), status: String(e.status) };
  }
  return {
    evals: evalRows.map((r: any) => ({ id: Number(r.id), cap: num(r.cap), spent: num(r.spent) })),
    planned: plannedRows.map((r: any) => ({
      id: Number(r.id), evalId: Number(r.eval_run_id), sessionId: Number(r.session_id), attemptId: String(r.attempt_id),
      attempts: num(r.attempts), agentMs: r.agent_minutes ? Math.round(Number(r.agent_minutes) * 60_000) : null,
      baseSha: String(r.base_sha), headSha: String(r.head_sha), intent: r.intent ?? null, appSlug: r.app_slug ?? null,
    })),
    active: activeRows.map((r: any) => ({
      id: Number(r.id), evalId: Number(r.eval_run_id), sessionId: Number(r.session_id), attemptId: String(r.attempt_id),
      attempts: num(r.attempts), proxyCents: num(r.proxy), reportedCents: num(r.reported), stale: !!r.stale, appSlug: r.app_slug ?? null, evalStatus: String(r.eval_status),
    })),
    liveShots,
    mine,
    rollout: num(releases?.n) > 1,
    estimateCents,
    eval: named,
  };
}
