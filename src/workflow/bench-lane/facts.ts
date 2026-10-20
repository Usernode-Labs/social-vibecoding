// What the bench lane reads inside a transition, under its own lock (one
// instance, so two grants are never decided at once): the runs still open,
// every trial running (claimed, whether its build has started or not), the
// trials waiting in each open run in the order they are taken, the live
// bot's slots in use and how many it has, and the provider's pause. And, for
// a cancel or a reopen, the run or the trial it names.

import type { Tx } from '../kernel/index.ts';
import { LANE_SETTING_KEYS, SLOTS_IN_USE_SQL, laneSettings } from '../rules/bot-loop.ts';

// Stages whose trial is a container turn of many minutes: a run takes at
// most MAX_HEAVY_PER_RUN of them at once (a studio run, its concurrency).
export const HEAVY_STAGES: ReadonlySet<string> = new Set(['build', 'checks_fix', 'spec', 'first_version', 'capture']);
// A later change's side builds' runs (services/bot-configs.js): they take
// only the live slots the live bot's work leaves free.
export const LATER_SIDE_RUN_KIND = 'bot_config_later';
// How many waiting trials of one run are read: enough to find the next
// light one behind the heavy ones a run holds.
const QUEUE_READ = 60;
// A provider refusing the bench's key for its spending limit (bench/lane.js
// providerLimitHit): nothing new starts for this long after it.
export const PROVIDER_LIMIT_RE = /key limit exceeded|insufficient credits|requires more credits/i;
export const PROVIDER_LIMIT_PAUSE_MS = 30 * 60 * 1000;

export interface Run { id: number; kind: string | null; concurrency: number; cap: number; spent: number }
export interface Trial { id: number; runId: number; est: number; heavy: boolean; laterSide: boolean; appId: number | null; claims: number; buildKey: string | null }
export interface Facts {
  liveAtOnce: number;
  liveInUse: number;
  runs: Run[];
  running: Trial[];
  waiting: ReadonlyMap<number, Trial[]>;
  pendingCount: ReadonlyMap<number, number>;
  providerPauseUntil: string | null;
  // The run or the trial an event names.
  run: (Run & { status: string; pending: number }) | null;
  trial: { id: number; runId: number; status: string; buildKey: string | null } | null;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const trialOf = (r: any): Trial => ({
  id: Number(r.id), runId: Number(r.run_id), est: Math.max(num(r.est), 0), heavy: HEAVY_STAGES.has(String(r.stage)),
  laterSide: r.run_kind === LATER_SIDE_RUN_KIND, appId: r.app_id == null ? null : Number(r.app_id),
  claims: num(r.claims), buildKey: r.build_key ?? null,
});

const TRIAL_COLUMNS = `tr.id, tr.run_id, tr.est_cost_usd::float8 AS est, tr.claims, tr.build_key, t.stage, t.app_id, r.kind AS run_kind`;

export async function readFacts(tx: Tx, p: { runId?: number | null; trialId?: number | null }, now: Date): Promise<Facts> {
  const { rows: settingRows } = await tx.query('SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])', [LANE_SETTING_KEYS]);
  const { liveAtOnce } = laneSettings(settingRows);
  const { rows: [live] } = await tx.query(`SELECT COUNT(*)::int AS n FROM (${SLOTS_IN_USE_SQL}) s`);
  const { rows: runRows } = await tx.query(
    `SELECT id, kind, concurrency, cap_usd::float8 AS cap, spent_usd::float8 AS spent
       FROM bench_runs WHERE status IN ('queued', 'running') ORDER BY id`);
  const runOf = (r: any): Run => ({ id: Number(r.id), kind: r.kind ?? null, concurrency: num(r.concurrency), cap: num(r.cap), spent: num(r.spent) });
  const runs: Run[] = runRows.map(runOf);
  let run: Facts['run'] = null;
  if (p.runId) {
    const { rows: [r] } = await tx.query(
      `SELECT r.id, r.kind, r.concurrency, r.cap_usd::float8 AS cap, r.spent_usd::float8 AS spent, r.status,
              (SELECT COUNT(*)::int FROM bench_trials WHERE run_id = r.id AND status = 'pending') AS pending
         FROM bench_runs r WHERE r.id = $1`, [p.runId]);
    if (r) run = { ...runOf(r), status: String(r.status), pending: num(r.pending) };
  }
  // Every trial running, whatever its run's state: a cancelled run's trial
  // still holds its slot until its build has recorded it.
  const { rows: runningRows } = await tx.query(
    `SELECT ${TRIAL_COLUMNS}
       FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id JOIN bench_runs r ON r.id = tr.run_id
      WHERE tr.status = 'running'`);
  const waiting = new Map<number, Trial[]>();
  const pendingCount = new Map<number, number>();
  // The open runs' queues, and the named run's (a reopen grants at once).
  const ids = [...new Set([...runs.map((r) => r.id), ...(run ? [run.id] : [])])];
  if (ids.length) {
    const { rows: counts } = await tx.query(
      `SELECT run_id, COUNT(*)::int AS n FROM bench_trials WHERE run_id = ANY($1::int[]) AND status = 'pending' GROUP BY run_id`, [ids]);
    for (const c of counts) pendingCount.set(Number(c.run_id), Number(c.n));
    const { rows: queued } = await tx.query(
      `SELECT * FROM (
         SELECT ${TRIAL_COLUMNS}, tr.attempt,
                ROW_NUMBER() OVER (PARTITION BY tr.run_id ORDER BY tr.attempt, tr.id) AS place
           FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id JOIN bench_runs r ON r.id = tr.run_id
          WHERE tr.run_id = ANY($1::int[]) AND tr.status = 'pending') q
        WHERE place <= $2 ORDER BY run_id, place`, [ids, QUEUE_READ]);
    for (const q of queued) {
      const list = waiting.get(Number(q.run_id)) || [];
      list.push(trialOf(q));
      waiting.set(Number(q.run_id), list);
    }
  }
  // The last trial the bench finished (any run: they share the key).
  const { rows: [last] } = await tx.query(
    `SELECT error, finished_at FROM bench_trials
      WHERE finished_at IS NOT NULL AND status NOT IN ('not_applicable', 'skipped_cap', 'cancelled')
      ORDER BY finished_at DESC LIMIT 1`);
  let providerPauseUntil: string | null = null;
  if (last && PROVIDER_LIMIT_RE.test(String(last.error || ''))) {
    const until = new Date(last.finished_at).getTime() + PROVIDER_LIMIT_PAUSE_MS;
    if (until > now.getTime()) providerPauseUntil = new Date(until).toISOString();
  }
  let trial: Facts['trial'] = null;
  if (p.trialId) {
    const { rows: [t] } = await tx.query('SELECT id, run_id, status, build_key FROM bench_trials WHERE id = $1', [p.trialId]);
    if (t) trial = { id: Number(t.id), runId: Number(t.run_id), status: String(t.status), buildKey: t.build_key ?? null };
  }
  return {
    liveAtOnce, liveInUse: num(live?.n), runs, running: runningRows.map(trialOf), waiting, pendingCount, providerPauseUntil, run, trial,
  };
}
