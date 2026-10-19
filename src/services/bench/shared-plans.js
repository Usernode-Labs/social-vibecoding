'use strict';

// A studio run's shared plans (App bench, after run 193, 14 Oct 2026).
//
// A first version's plan is most of what decides how it looks, and each
// trial used to make its own: run 193 compared two build settings on six
// builds each, every one from a plan of its own, and its blind judge's
// verdict could not be told apart from which plan each build was given. A
// run launched with `sharedPlans` makes each brief's plan ONCE per pack and
// repeat (its `plan_key`, the attempt it was launched as), and every arm
// builds from it: the plan from the description, its early first look, and
// the spec the build works from (bench_shared_plans). Arms are then
// compared on the same spec, and the run pays for one plan where it paid for
// one per arm (the plan was about two thirds of a first version's cost).
//
// The first trial to need a plan claims its row and makes it, through its
// own first-version path (bench/runner.js firstVersionStage); the others
// wait for its spec and build from it (buildAndPropose's presetSpec). A
// claim left `making` past CLAIM_STALE_SECONDS (its process died and its
// trial was not carried on), or `failed`, is taken over by the next trial
// that needs it; a durable trial carried on after a restart takes its own
// claim back at once, as bench/scaffold.js does.

const log = require('../logger');

const CLAIM_STALE_SECONDS = 30 * 60;
const WAIT_MS = 30 * 60 * 1000;
const POLL_MS = 5000;

const ROW_SQL = `SELECT id, status, claimed_by, claimed_at, plan, build_note, early_look, spec_md, spec_html,
                        plan_usd, look_usd, maker_trial_id, error
                   FROM bench_shared_plans`;

/** A row as the runner reads it. Pure. */
function rowOut(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    status: row.status,
    claimedBy: row.claimed_by || null,
    plan: row.plan || null,
    buildNote: row.build_note || '',
    earlyLook: row.early_look || null,
    specMd: row.spec_md || null,
    specHtml: row.spec_html || null,
    planUsd: row.plan_usd == null ? null : Number(row.plan_usd),
    lookUsd: row.look_usd == null ? null : Number(row.look_usd),
    makerTrialId: row.maker_trial_id == null ? null : Number(row.maker_trial_id),
    error: row.error || null,
  };
}

async function readRow(pool, { runId, taskId, packId = null, key }) {
  const { rows } = await pool.query(
    `${ROW_SQL} WHERE run_id = $1 AND task_id = $2 AND COALESCE(context_pack_id, 0) = COALESCE($3::int, 0) AND plan_key = $4`,
    [Number(runId), Number(taskId), packId == null ? null : Number(packId), Number(key)],
  );
  return rowOut(rows[0]);
}

async function readById(pool, id) {
  const { rows } = await pool.query(`${ROW_SQL} WHERE id = $1`, [Number(id)]);
  return rowOut(rows[0]);
}

/**
 * The plan for (run, task, pack, key), for `trialId`: { role: 'maker', id }
 * when this trial is to make it (it claimed the row, or took over one that
 * was failed, stale or its own), else { role: 'waiter', id } for one some
 * other trial is making, or { role: 'ready', id } for one already made.
 * Throws only on a database error.
 */
async function claim(pool, { runId, taskId, packId = null, key, trialId }) {
  const by = `trial:${Number(trialId)}`;
  const { rows: [made] } = await pool.query(
    `INSERT INTO bench_shared_plans (run_id, task_id, context_pack_id, plan_key, claimed_by, maker_trial_id)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id`,
    [Number(runId), Number(taskId), packId == null ? null : Number(packId), Number(key), by, Number(trialId)],
  );
  if (made) return { role: 'maker', id: Number(made.id) };
  const row = await readRow(pool, { runId, taskId, packId, key });
  if (!row) throw new Error('the shared plan\'s record is gone');
  if (row.status === 'ready') return { role: 'ready', id: row.id };
  const taken = await takeOver(pool, row.id, by, trialId);
  return taken ? { role: 'maker', id: row.id } : { role: 'waiter', id: row.id };
}

/** Take a failed, stale or own claim over for `by`. True when taken. */
async function takeOver(pool, id, by, trialId) {
  const { rows: [taken] } = await pool.query(
    `UPDATE bench_shared_plans
        SET status = 'making', claimed_at = NOW(), claimed_by = $3, maker_trial_id = $4, error = NULL
      WHERE id = $1 AND (status = 'failed' OR (status = 'making' AND (
              claimed_at < NOW() - make_interval(secs => $2) OR claimed_by = $3)))
      RETURNING id`,
    [Number(id), CLAIM_STALE_SECONDS, by, Number(trialId)],
  );
  return !!taken;
}

/** The maker's plan and early first look, saved as soon as they exist (the spec comes later). */
async function savePlanned(pool, id, { plan, buildNote, earlyLook = null, planUsd = null, lookUsd = null }) {
  await pool.query(
    `UPDATE bench_shared_plans
        SET plan = $2::jsonb, build_note = $3, early_look = $4, plan_usd = $5, look_usd = $6, claimed_at = NOW()
      WHERE id = $1 AND status = 'making'`,
    [Number(id), plan ? JSON.stringify(plan) : null, buildNote || '', earlyLook || null,
      Number.isFinite(planUsd) ? planUsd : null, Number.isFinite(lookUsd) ? lookUsd : null],
  );
}

/** The maker's spec: the plan is ready for every arm. */
async function saveSpec(pool, id, { specMd, specHtml = null }) {
  await pool.query(
    `UPDATE bench_shared_plans SET status = 'ready', spec_md = $2, spec_html = $3, error = NULL, ready_at = NOW()
      WHERE id = $1 AND status = 'making'`,
    [Number(id), String(specMd), specHtml ? String(specHtml) : null],
  );
}

/** The maker could not make it: the next trial that needs it takes it over. Never throws. */
async function saveFailed(pool, id, error) {
  try {
    await pool.query(
      "UPDATE bench_shared_plans SET status = 'failed', error = $2 WHERE id = $1 AND status = 'making'",
      [Number(id), String(error || 'failed').slice(0, 500)],
    );
  } catch (err) {
    log.warn('bench', 'Could not mark a shared plan failed', { id, err: err.message });
  }
}

/**
 * Wait for the plan `id` some other trial is making: resolves { row } once
 * it is ready, { take: true } once it is this trial's to make (it failed, or
 * its claim went stale), or { error } on time out or a cancel
 * (`stopped()`, polled). Never throws but on a database error.
 */
async function waitFor(pool, id, {
  trialId, stopped = null, waitMs = WAIT_MS, pollMs = POLL_MS, now = Date.now,
} = {}) {
  const by = `trial:${Number(trialId)}`;
  const until = now() + waitMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const row = await readById(pool, id);
    if (!row) return { error: 'the shared plan\'s record is gone' };
    if (row.status === 'ready' && row.specMd) return { row };
    // eslint-disable-next-line no-await-in-loop
    if (await takeOver(pool, id, by, trialId)) return { take: true };
    // eslint-disable-next-line no-await-in-loop
    const stop = stopped ? await stopped() : null;
    if (stop) return { error: stop, stopped: true };
    if (now() + pollMs > until) return { error: 'the shared plan was not ready in time' };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { const t = setTimeout(resolve, pollMs); if (typeof t.unref === 'function') t.unref(); });
  }
}

/**
 * Why a run's arms cannot share their plans, or null when they can: every
 * arm must plan alike, with the same triage and spec models, `lean_plan`
 * (the one tweak that changes the spec, homeroom-bot-live.js specPrompt) on
 * or off in all of them, and no configuration's own pack (the run's packs
 * are kept apart by the plan's key). `arms` is [{ label, triage, spec,
 * leanPlan, pack }]. Pure.
 */
function mismatchOf(arms) {
  const list = Array.isArray(arms) ? arms : [];
  if (!list.length) return null;
  const sig = (a) => JSON.stringify([a.triage || null, a.spec || null, !!a.leanPlan, a.pack || null]);
  const first = list[0];
  const other = list.find((a) => sig(a) !== sig(first));
  if (!other) return null;
  const what = [
    (first.triage || null) !== (other.triage || null) ? 'triage model' : null,
    (first.spec || null) !== (other.spec || null) ? 'spec model' : null,
    !!first.leanPlan !== !!other.leanPlan ? 'lean_plan' : null,
    (first.pack || null) !== (other.pack || null) ? 'configuration pack' : null,
  ].filter(Boolean).join(', ');
  return `${first.label} and ${other.label} would not plan alike (${what}), so they cannot share their plans`;
}

module.exports = {
  CLAIM_STALE_SECONDS,
  WAIT_MS,
  POLL_MS,
  rowOut,
  readRow,
  readById,
  claim,
  savePlanned,
  saveSpec,
  saveFailed,
  waitFor,
  mismatchOf,
};
