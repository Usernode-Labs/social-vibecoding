// What a shots eval trial's attempt cost, kept per attempt
// (shots_eval_attempt_costs): what the Anthropic proxy billed for its calls
// and what Claude Code reported its dispatches cost, each a running total,
// and what its trial and eval were charged for it. An attempt is charged
// the larger of the two totals, from when its trial's end settles it; a
// call or a report that comes after (a straggler, a dispatch that returns
// after a cancel) charges only what it adds to that larger total, so
// nothing late is lost and nothing is counted twice.
//
// Every write takes the attempt's row first, then the trial's, then the
// eval's, so the proxy's notes and the trial's end never wait on each
// other in a cycle. Used by the machine's `ended` write and by the proxy
// and the agent's work (services/shots-eval.js).

interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

// Adds to an attempt's totals; resolves what is owed now (nothing until
// it is settled).
const ADD_SQL = `
  INSERT INTO shots_eval_attempt_costs AS c (attempt_id, trial_id, proxy_cents, reported_cents)
  VALUES ($1, $2, $3::numeric, $4::numeric)
  ON CONFLICT (attempt_id) DO UPDATE
     SET proxy_cents = c.proxy_cents + EXCLUDED.proxy_cents, reported_cents = c.reported_cents + EXCLUDED.reported_cents
  RETURNING c.trial_id, CASE WHEN c.settled_at IS NULL THEN 0
                             ELSE GREATEST(c.proxy_cents, c.reported_cents) - c.charged_cents END::float8 AS owed`;

// Charges what is owed to the attempt, its trial and its eval.
const CHARGE_SQL = `
  WITH a AS (
    UPDATE shots_eval_attempt_costs SET charged_cents = charged_cents + $3::numeric WHERE attempt_id = $1),
  t AS (
    UPDATE shots_eval_trials SET cost_cents = cost_cents + $3::numeric WHERE id = $2 RETURNING eval_run_id)
  UPDATE shots_eval_runs r SET spent_cents = r.spent_cents + $3::numeric FROM t WHERE r.id = t.eval_run_id`;

async function charge(q: Queryable, attemptId: string, trialId: number, owed: number): Promise<number> {
  if (!(owed > 0)) return 0;
  await q.query(CHARGE_SQL, [attemptId, trialId, owed]);
  return owed;
}

/**
 * Adds to an attempt's totals, and charges what that adds once it is
 * settled. `q` must be inside a transaction (the attempt's row stays
 * locked until the charge is written). Resolves what was charged.
 */
export async function addCost(q: Queryable, p: { trialId: number; attemptId: string; proxyCents?: number; reportedCents?: number }): Promise<number> {
  const proxy = Math.max(Number(p.proxyCents) || 0, 0);
  const reported = Math.max(Number(p.reportedCents) || 0, 0);
  if (!(proxy > 0 || reported > 0)) return 0;
  const { rows: [c] } = await q.query(ADD_SQL, [p.attemptId, p.trialId, proxy, reported]);
  return charge(q, p.attemptId, Number(c.trial_id), Number(c.owed));
}

/**
 * The trial's end settles its attempt: what an older release's runner's
 * proxy put on the trial's row for it moved into the attempt's totals, the
 * attempt marked settled, and the larger total charged (less what was
 * charged for it already). Inside the end's transaction. Resolves what was
 * charged.
 */
export async function settleAttempt(q: Queryable, p: { trialId: number; attemptId: string }): Promise<number> {
  await q.query(
    `INSERT INTO shots_eval_attempt_costs AS c (attempt_id, trial_id) VALUES ($1, $2)
     ON CONFLICT (attempt_id) DO UPDATE SET trial_id = c.trial_id`, [p.attemptId, p.trialId]);
  const { rows: [legacy] } = await q.query(
    `WITH old AS (SELECT id, proxy_cents FROM shots_eval_trials WHERE id = $1 AND attempt_id = $2 FOR UPDATE)
     UPDATE shots_eval_trials t SET proxy_cents = 0 FROM old WHERE t.id = old.id RETURNING old.proxy_cents::float8 AS cents`,
    [p.trialId, p.attemptId]);
  const { rows: [c] } = await q.query(
    `UPDATE shots_eval_attempt_costs
        SET proxy_cents = proxy_cents + $2::numeric, settled_at = COALESCE(settled_at, NOW())
      WHERE attempt_id = $1
      RETURNING trial_id, (GREATEST(proxy_cents, reported_cents) - charged_cents)::float8 AS owed`,
    [p.attemptId, Number(legacy?.cents) || 0]);
  return charge(q, p.attemptId, Number(c.trial_id), Number(c.owed));
}
