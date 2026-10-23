'use strict';

// #3654: the benchmark's runs: launched by an admin (or by a live build's
// side configurations), their trials planned up front, run as durable
// builds, recorded, charged to their run and graded.
//
// Which trials run, and when, is the bench-lane machine's
// (src/workflow/bench-lane/): one instance, which claims each trial in the
// transition that sends its build (bot-build `trial:<id>@<nonce>`), so its
// limits hold across every process and through a restart:
//
//   * A run's `concurrency` (1 to 9) trials at once, the oldest run first;
//     of them at most three heavy ones (a build, a checks fix, a spec, a
//     first version or a capture: a container turn of many minutes); at most
//     eleven trials in flight across every run.
//   * Never while the live bot's live work (the requests a person is waiting
//     for, read or built) fills every live slot it has, `liveAtOnce`: the
//     benchmark waits for it, not the other way round. A later change's side
//     builds (services/bot-configs.js, kind `bot_config_later`) take only the
//     live slots live work leaves free.
//   * The cap. A trial starts only if what the run has spent, plus the
//     estimate of every trial of it running, plus this one's
//     (catalog.estimateTrialCost, deliberately pessimistic), stays inside the
//     run's cap; the first that would cross it ends the run there, and what
//     is left is `skipped_cap`. The bench user's weekly allowance is a
//     backstop (allowanceGate). What a trial under way spends cannot be
//     stopped mid-turn, so the cap can be overrun by at most the overrun of
//     the trials in flight.
//   * Cancellable: a cancelled run claims nothing more, its waiting trials
//     are cancelled, and its trials running are stopped by their build's
//     machine, wherever they run, and recorded cancelled.
//
// A trial is a durable build of the bot-build machine: a restart ends its
// lease, the next process carries it on from the last step it saved, and it
// is recorded once (recordTrial), charged in the same write, by whichever
// attempt finishes it, fenced by its build's key.
//
// Branches: a trial's `bench/` branch is deleted when it ends unless it
// holds commits (a build, a revision), which are kept BRANCH_KEEP_DAYS for
// a person to look at; the diff the judge reads is stored on the trial. A
// later change's side build's is kept while its pair waits for a pick, up
// to BRANCH_KEEP_WAITING_DAYS. The bench-sweep clock deletes them after.

const crypto = require('crypto');
const log = require('../logger');
const arms = require('./arms');
const catalog = require('./catalog');
const runner = require('./runner');
const dmSim = require('./dm-sim');
const taste = require('./taste');
const progress = require('./progress');
const snapshots = require('../homeroom-bot-snapshots');
const durableSteps = require('../durable-steps');

// The lane's limits are its machine's (src/workflow/bench-lane/): one
// run's trials at once (a studio run's own limit, studio.js MAX_CONCURRENCY,
// fits under it), heavy ones of one run, and every trial in flight.
const laneRules = require('../../workflow/bench-lane/machine.ts');
const laneFacts = require('../../workflow/bench-lane/facts.ts');
const { MAX_CONCURRENCY, MAX_HEAVY_PER_RUN, MAX_IN_FLIGHT } = laneRules;
const HEAVY_STAGES = Object.freeze([...laneFacts.HEAVY_STAGES]);
const MAX_MODELS = 10;
const MAX_REPEATS = 5;
const MIN_CAP_USD = 0.5;
const MAX_CAP_USD = 1000;
const DEFAULT_CAP_USD = 50;
const DEFAULT_REPEATS = 3;
// Builds and specs run once per model whatever `repeats` says: they are the
// expensive stages, and pass^k is a triage measure here.
// A capture (#3737) runs no model, so another attempt would take the same
// screenshots again.
const SINGLE_ATTEMPT_STAGES = Object.freeze(['build', 'spec', 'capture']);
const BRANCH_KEEP_DAYS = 7;
// A side build's branch whose pair still waits for a pick is kept past
// BRANCH_KEEP_DAYS, so the pair's compare link opens, but not for good: it
// sits on the live project's own repository. After this, the pair shows the
// diff stored on its trial (bot-configs.js diffSummary).
const BRANCH_KEEP_WAITING_DAYS = 30;
// A later change's side builds' runs (services/bot-configs.js LATER_SIDE_RUN_KIND).
const LATER_SIDE_RUN_KIND = laneFacts.LATER_SIDE_RUN_KIND;

function platform() {
  return require('../../workflow/platform.ts');
}

function token() {
  return crypto.randomBytes(12).toString('base64url');
}

function httpError(status, error) {
  return { ok: false, status, error };
}

// ── Launching ────────────────────────────────────────────────────────────

function validateLaunch(body) {
  const suites = require('./suites');
  const suiteId = Number(body.suiteId);
  if (!Number.isInteger(suiteId) || suiteId <= 0) return httpError(400, 'Pick a suite');
  // Each an arm: a model, or a model at an effort of its own
  // (`vendor/model@max`, services/bench/arms.js), as written once.
  const models = [...new Set((Array.isArray(body.models) ? body.models : [])
    .map((m) => arms.parseArm(m).arm).filter(Boolean))];
  if (!models.length) return httpError(400, 'Pick at least one model');
  if (models.length > MAX_MODELS) return httpError(400, `At most ${MAX_MODELS} models in one run`);
  const bad = models.find((m) => !arms.validArm(m));
  if (bad) return httpError(400, `${bad} is not an OpenRouter model id, or one at an effort (vendor/model@${arms.EFFORTS.join(', @')})`);
  const stages = [...new Set(Array.isArray(body.stages) ? body.stages : [])];
  if (!stages.length || stages.some((s) => !suites.TASK_STAGES.includes(s))) {
    return httpError(400, `stages must be some of ${suites.TASK_STAGES.join(', ')}`);
  }
  const repeats = body.repeats == null ? DEFAULT_REPEATS : Number(body.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) return httpError(400, `repeats must be 1 to ${MAX_REPEATS}`);
  const capUsd = body.capUsd == null ? DEFAULT_CAP_USD : Number(body.capUsd);
  if (!Number.isFinite(capUsd) || capUsd < MIN_CAP_USD || capUsd > MAX_CAP_USD) {
    return httpError(400, `The cap must be from $${MIN_CAP_USD} to $${MAX_CAP_USD}`);
  }
  const concurrency = body.concurrency == null ? 1 : Number(body.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    return httpError(400, `concurrency must be 1 to ${MAX_CONCURRENCY}`);
  }
  // Core v1's launcher: which stages take `repeats` (the rest run once).
  // Left out, every stage but a build or a spec repeats, as before.
  let repeatStages = null;
  if (body.repeatStages != null) {
    if (!Array.isArray(body.repeatStages) || body.repeatStages.some((s) => !suites.TASK_STAGES.includes(s))) {
      return httpError(400, `repeatStages must be some of ${suites.TASK_STAGES.join(', ')}`);
    }
    repeatStages = [...new Set(body.repeatStages)].filter((s) => !SINGLE_ATTEMPT_STAGES.includes(s));
  }
  // The catalog's baseline when it is in the run; else its first arm at the
  // bot's own effort, so an effort is read against its model's default.
  const baseline = models.includes(catalog.BASELINE) ? catalog.BASELINE
    : models.find((m) => !arms.parseArm(m).effort) || models[0];
  return {
    ok: true, suiteId, models, stages, repeats, capUsd: Math.round(capUsd * 100) / 100, concurrency, baseline, repeatStages,
    note: body.note ? String(body.note).slice(0, 500) : null,
  };
}

/** How many attempts a task at `stage` gets in a run. Pure. */
function attemptsFor(stage, { repeats, repeatStages = null }) {
  if (SINGLE_ATTEMPT_STAGES.includes(stage)) return 1;
  if (Array.isArray(repeatStages) && !repeatStages.includes(stage)) return 1;
  return repeats;
}

/**
 * The launcher's defaults (#3654 Core v1). Pure. The Core suite when it
 * exists (else the first frozen suite, else the newest), every catalog
 * candidate (the baseline first; a model entered for some stages only is
 * not applicable to the rest, which the run says per trial), every stage the
 * suite has tasks at, three repeats for triage and one for everything else,
 * and the $50 cap.
 */
const DEFAULT_STAGES = Object.freeze(['triage', 'dm']);

function launcherDefaults({ suites: all = [], coreSuiteId = null } = {}) {
  // The App bench studio's suite is launched from the studio, never as the
  // launcher's default (services/bench/studio.js).
  const list = all.filter((s) => s.name !== require('./studio').SUITE_NAME);
  const pick = list.find((s) => s.id === coreSuiteId) || list.find((s) => s.frozen_at) || list[0] || null;
  // Ticked by default: the cheap stages (triage, and DM, which is triage
  // turns), so a first Run of every model finishes under the $50 cap. Builds,
  // checks fixes and follow-ups cost one to two orders more per trial, and
  // eight models of them would stop at the cap part-way through; they are a
  // deliberate run of their own, ticked by hand.
  const stages = pick ? Object.keys(pick.counts || {})
    .filter((st) => DEFAULT_STAGES.includes(st) && (pick.counts[st] || 0) > 0) : [];
  const models = [catalog.BASELINE, ...catalog.CANDIDATES.map((c) => c.id).filter((id) => id !== catalog.BASELINE)];
  return {
    suiteId: pick ? pick.id : null,
    models,
    stages: stages.length ? stages : ['triage'],
    repeats: DEFAULT_REPEATS,
    repeatStages: ['triage'],
    capUsd: DEFAULT_CAP_USD,
  };
}

/** What each (model, stage) already cost per trial, for the estimates. */
async function costHistory(pool) {
  const { rows } = await pool.query(
    `SELECT tr.model, t.stage, tr.cost_usd::float8 AS cost
       FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id
      WHERE tr.cost_usd IS NOT NULL AND tr.status IN ('ok', 'model_fail', 'timeout')
      ORDER BY tr.id DESC LIMIT 5000`,
  );
  const map = new Map();
  for (const r of rows) {
    const key = `${r.model}|${r.stage}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(Number(r.cost));
  }
  return map;
}

/**
 * The trials a launch makes, decided up front, and what each is estimated to
 * cost, without writing anything. launchRun inserts this plan and
 * estimateRun shows it before anything is spent, so the figure the launcher
 * previews is the figure the launch records.
 */
async function planRun(pool, body = {}) {
  const v = validateLaunch(body);
  if (!v.ok) return v;
  const { rows: [suite] } = await pool.query('SELECT id, frozen_at FROM bench_suites WHERE id = $1', [v.suiteId]);
  if (!suite) return httpError(404, 'Suite not found');
  const { rows: tasks } = await pool.query(
    'SELECT id, stage, tags, reference FROM bench_tasks WHERE suite_id = $1 AND stage = ANY($2::text[]) ORDER BY id',
    [v.suiteId, v.stages],
  );
  if (!tasks.length) return httpError(409, 'The suite has no tasks at those stages');
  const models = await catalog.listModels(pool, v.models);
  const history = await costHistory(pool);
  const calibration = catalog.costCalibration(v.models.map((id) => catalog.modelInfo(models, id)), history);

  // `est` is the pessimistic figure the cap is scheduled against; `likely`
  // is what the trial will probably cost, for the preview (#3710); `range`
  // is what the launcher shows: a low and a high, and what they rest on.
  const plan = { task: [], stage: [], model: [], attempt: [], status: [], error: [], est: [], likely: [], range: [], token: [] };
  let estimate = 0;
  let likely = 0;
  for (const task of tasks) {
    const attempts = attemptsFor(task.stage, v);
    // A capture task (#3737) runs no model: once a run, under its baseline,
    // whatever models the run compares.
    const runsOn = task.stage === 'capture' ? [v.baseline] : v.models;
    for (const id of runsOn) {
      const info = catalog.modelInfo(models, id);
      const reason = dmSim.noAnswerReason(task) || taste.notRunnableReason(task)
        || (task.stage === 'capture' ? null : catalog.notApplicableReason(info, task.stage, task.tags?.prompt_chars));
      const past = history.get(`${id}|${task.stage}`) || [];
      const est = catalog.estimateTrialCost(info, task.stage, past);
      const probable = catalog.likelyTrialCost(info, task.stage, past, calibration);
      const range = catalog.costRange(info, task.stage, history, calibration);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        plan.task.push(task.id);
        plan.stage.push(task.stage);
        plan.model.push(id);
        plan.attempt.push(attempt);
        plan.status.push(reason ? 'not_applicable' : 'pending');
        plan.error.push(reason);
        plan.est.push(Math.round(est * 10000) / 10000);
        plan.likely.push(probable);
        plan.range.push(range);
        plan.token.push(token());
        if (!reason) { estimate += est; likely += probable; }
      }
    }
  }
  return { ok: true, v, suite, plan, estimate, likely, calibration };
}

/**
 * Room above the likely cost for the trials the lane holds at once: while
 * they run, the cap check counts each at its pessimistic estimate, so a cap
 * with no room above the likely cost stops the last trials early. The
 * dearest heavy trials the run can hold at once (MAX_HEAVY_PER_RUN), plus
 * its dearest light ones in the slots left. Pure.
 */
function capHeadroom(items, concurrency) {
  const slots = Math.max(1, Math.min(Number(concurrency) || 1, MAX_IN_FLIGHT));
  const heavySlots = Math.min(slots, MAX_HEAVY_PER_RUN);
  const heavy = items.filter((it) => HEAVY_STAGES.includes(it.stage)).map((it) => it.est).sort((a, b) => b - a);
  const light = items.filter((it) => !HEAVY_STAGES.includes(it.stage)).map((it) => it.est).sort((a, b) => b - a);
  const top = heavy.slice(0, heavySlots);
  // The slots left take light trials only: a run never holds more heavy ones.
  const rest = light.slice(0, slots - top.length);
  return [...top, ...rest].reduce((sum, n) => sum + n, 0);
}

/**
 * The cap a launch should get when nobody sets one (#3710): the likely cost
 * plus 15%, or plus the headroom the trials in flight need if that is more;
 * never more than the pessimistic total plus that headroom (the run fits
 * even if every trial costs what the dearest tenth have), whole dollars,
 * inside the lane's range. Pure.
 */
function suggestCap({ likelyUsd, pessimisticUsd, headroomUsd }) {
  const want = Math.max(likelyUsd * 1.15, likelyUsd + headroomUsd);
  const ceiling = pessimisticUsd + headroomUsd;
  return Math.min(MAX_CAP_USD, Math.max(1, Math.ceil(Math.min(want, ceiling))));
}

// How long a trial at each stage takes when a model has no history yet, in
// milliseconds: roughly the medians of the first production runs (#3654),
// rounded up.
const TRIAL_MS_FALLBACK = Object.freeze({
  triage: 60_000, dm: 60_000, spec: 300_000, build: 900_000, followup: 180_000, checks_fix: 240_000,
  // #3737, unmeasured: a first version's triage and doubled build clocks,
  // and a capture's install, boot and screenshots.
  first_version: 1_800_000, capture: 420_000,
});

/** The median duration of finished trials per (model, stage), for the time estimate. */
async function durationHistory(pool) {
  const { rows } = await pool.query(
    `SELECT tr.model, t.stage,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tr.duration_ms)::float8 AS ms
       FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id
      WHERE tr.duration_ms IS NOT NULL AND tr.status IN ('ok', 'model_fail', 'timeout')
      GROUP BY tr.model, t.stage`,
  );
  return new Map(rows.map((r) => [`${r.model}|${r.stage}`, Number(r.ms)]));
}

/**
 * About how long a run takes, from the time each of its trials should take.
 * Pure. The lane holds `concurrency` trials of a run at once, at most
 * MAX_HEAVY_PER_RUN of them heavy and at most MAX_IN_FLIGHT across runs, so
 * the run lasts at least as long as its heavy trials take spread over the
 * heavy slots, and as all its trials take spread over every slot. It is a
 * floor: live builds a person is waiting for go first.
 */
function estimateWallMs(items, concurrency) {
  const slots = Math.max(1, Math.min(Number(concurrency) || 1, MAX_IN_FLIGHT));
  const heavySlots = Math.max(1, Math.min(slots, MAX_HEAVY_PER_RUN));
  let heavyMs = 0;
  let allMs = 0;
  for (const it of items) {
    allMs += it.ms;
    if (HEAVY_STAGES.includes(it.stage)) heavyMs += it.ms;
  }
  return Math.round(Math.max(heavyMs / heavySlots, allMs / slots));
}

// What a stage's cost range rests on, strongest first (catalog.costRange).
const BASIS_ORDER = Object.freeze([null, 'none', 'own', 'stage', 'comparable', 'price', 'fixed']);

/**
 * What a launch with this body would do, without launching it: trials,
 * the ones not applicable, the estimate in dollars (per stage too), about
 * how long it takes, and the suite's state. The launcher calls it as the
 * settings change, so the price is on screen before anything is spent.
 */
async function estimateRun(pool, body = {}) {
  const planned = await planRun(pool, body);
  if (!planned.ok) return planned;
  const { v, suite, plan, estimate, likely, calibration } = planned;
  const durations = await durationHistory(pool);
  const byStage = {};
  const items = [];
  let low = 0;
  let high = 0;
  for (let i = 0; i < plan.task.length; i += 1) {
    const stage = plan.stage[i];
    if (!byStage[stage]) {
      byStage[stage] = { trials: 0, notApplicable: 0, estimateUsd: 0, likelyUsd: 0, lowUsd: 0, highUsd: 0, basis: null, from: null };
    }
    if (plan.status[i] === 'not_applicable') {
      byStage[stage].notApplicable += 1;
      continue;
    }
    const s = byStage[stage];
    const range = plan.range[i];
    s.trials += 1;
    s.estimateUsd += plan.est[i];
    s.likelyUsd += plan.likely[i];
    s.lowUsd += range.low;
    s.highUsd += range.high;
    low += range.low;
    high += range.high;
    // A stage's range rests on the weakest of its trials' (a model with no
    // history makes the whole stage a guess).
    if (BASIS_ORDER.indexOf(range.basis) > BASIS_ORDER.indexOf(s.basis)) { s.basis = range.basis; s.from = range.from; }
    items.push({ stage, est: plan.est[i], ms: durations.get(`${plan.model[i]}|${stage}`) ?? TRIAL_MS_FALLBACK[stage] ?? 120_000 });
  }
  const cents = (n) => Math.round(n * 100) / 100;
  for (const s of Object.values(byStage)) {
    s.estimateUsd = cents(s.estimateUsd); s.likelyUsd = cents(s.likelyUsd); s.lowUsd = cents(s.lowUsd); s.highUsd = cents(s.highUsd);
  }
  const headroomUsd = capHeadroom(items, v.concurrency);
  return {
    ok: true,
    trials: items.length,
    notApplicable: plan.task.length - items.length,
    // What it will probably cost, and at most: the pessimistic figure the
    // cap is scheduled against, the one a launch records.
    likelyUsd: cents(likely),
    estimateUsd: cents(estimate),
    // The range the launcher shows, each stage's resting on what it says in
    // byStage[stage].basis (catalog.costRange).
    lowUsd: cents(low),
    highUsd: cents(high),
    byStage,
    calibratedFrom: calibration.any ? calibration.any.from : 0,
    // Suggested from the range where it is above the single figure: a stage
    // priced from the stage it is most like would otherwise get a cap that
    // stops it after a trial or two.
    suggestedCapUsd: suggestCap({ likelyUsd: Math.max(likely, low), pessimisticUsd: Math.max(estimate, high), headroomUsd }),
    estimatedMs: estimateWallMs(items, v.concurrency),
    capUsd: v.capUsd,
    maxCapUsd: MAX_CAP_USD,
    suiteFrozen: !!suite.frozen_at,
  };
}

/**
 * Launch a run: one trial per task, model and attempt, decided up front. A
 * trial a model cannot take is recorded `not_applicable` with its reason at
 * once; the rest wait as `pending` for the lane.
 */
async function launchRun(pool, body = {}, { actorId = null } = {}) {
  const planned = await planRun(pool, body);
  if (!planned.ok) return planned;
  const { v, suite, plan, estimate } = planned;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [run] } = await client.query(
      `INSERT INTO bench_runs (suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, note, started_by)
       VALUES ($1, $2::text[], $3, $4::text[], $5, $6, $7, $8, $9)
       RETURNING *`,
      [v.suiteId, v.models, v.baseline, v.stages, v.repeats, v.capUsd, v.concurrency, v.note, actorId],
    );
    await client.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, error, est_cost_usd, item_token, finished_at)
       SELECT $1, t, m, a, s, e, est, tok, CASE WHEN s = 'not_applicable' THEN NOW() ELSE NULL END
         FROM UNNEST($2::int[], $3::text[], $4::int[], $5::text[], $6::text[], $7::numeric[], $8::text[])
              AS p(t, m, a, s, e, est, tok)`,
      [run.id, plan.task, plan.model, plan.attempt, plan.status, plan.error, plan.est, plan.token],
    );
    await client.query('COMMIT');
    await look();
    return {
      ok: true,
      run,
      trials: plan.task.length,
      notApplicable: plan.status.filter((s) => s === 'not_applicable').length,
      estimateUsd: Math.round(estimate * 100) / 100,
      suiteFrozen: !!suite.frozen_at,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The lane's machine looks again (a run launched, a trial added: `runId`,
 * reopened if it had ended). Never throws: its clock looks anyway.
 */
async function look(runId = null, deps = {}) {
  try {
    await (deps.platform || platform()).benchLook({ runId: runId == null ? null : Number(runId) });
  } catch (err) {
    log.warn('bench', 'Could not ask the bench lane to look', { runId, err: err.message });
  }
}

/**
 * Cancel a run (its machine decides): nothing more of it is claimed, its
 * waiting trials are cancelled, and its trials running are stopped by their
 * builds wherever they run, recorded cancelled when they end.
 */
async function cancelRun(pool, runId, deps = {}) {
  const out = await (deps.platform || platform()).benchCancelRun(Number(runId), { by: deps.by || 'an admin' });
  if (out.status === 'rejected') return httpError(out.reason === 'no_run' ? 404 : 409, 'The run is not running');
  if (out.status === 'faulted') return httpError(503, 'The run could not be cancelled just now. Try again.');
  return { ok: true };
}

/**
 * Cancel one trial (the studio's cancel, a side build given up): a waiting
 * one is cancelled at once; a running one is stopped by its build, wherever
 * it runs, and recorded cancelled when it ends. Resolves { ok, status } or a
 * refusal.
 */
async function cancelTrial(pool, trialId, deps = {}) {
  const out = await (deps.platform || platform()).benchCancelTrial(Number(trialId), { by: deps.by || 'an admin', why: deps.why || null });
  if (out.status === 'rejected') {
    if (out.reason === 'no_trial') return httpError(404, 'No such trial');
    return httpError(409, `That trial is already ${String(out.reason || '').replace(/^already_/, '')}`);
  }
  if (out.status === 'faulted') return httpError(503, 'The trial could not be cancelled just now. Try again.');
  return { ok: true, status: out.reply?.status || (out.status === 'pending' ? 'stopping' : 'cancelled') };
}

/**
 * A run with work added to it after it ended (a re-run trial, a reference
 * build handed in): the lane reopens it and picks the new trials up. A
 * cancelled run stays cancelled.
 */
async function reopenRun(pool, runId, deps = {}) {
  await look(runId, deps);
  return true;
}

// ── Running a trial ──────────────────────────────────────────────────────

function liveDeps(deps = {}) {
  const github = deps.github || require('../github');
  return {
    worker: deps.worker || require('../worker'),
    sessions: deps.sessions || require('../../routes/sessions'),
    agentTurn: deps.agentTurn || require('../agent-turn'),
    activeWorkers: deps.activeWorkers || require('../active-workers').activeWorkers,
    limits: deps.limits || require('../limits'),
    managedOpenRouter: deps.managedOpenRouter || require('../openrouter-managed-keys'),
    // The only GitHub a trial is ever handed.
    github: runner.guardedGithub(github),
    runHiddenChecks: deps.runHiddenChecks || null,
    afterTrial: deps.afterTrial || null,
    // The trial's durable steps (runTrial), which its stage runs on.
    durable: deps.durable || null,
  };
}

async function loadTrialContext(pool, trialId) {
  const { rows: [row] } = await pool.query(
    `SELECT tr.*, t.stage, t.snapshot_id, t.reference, t.tags, t.issue_number AS task_issue,
            a.id AS app_id, a.slug AS app_slug, a.name AS app_name, a.repo_url, a.self_hosted,
            r.baseline_model AS run_baseline, r.kind AS run_kind, r.shared_plans AS run_shared_plans
       FROM bench_trials tr
       JOIN bench_tasks t ON t.id = tr.task_id
       JOIN bench_runs r ON r.id = tr.run_id
       LEFT JOIN apps a ON a.id = t.app_id
      WHERE tr.id = $1`,
    [Number(trialId)],
  );
  return row || null;
}

// The studio's `today` preset (services/bench/studio.js): the live bot's own
// model for each stage, read when the trial runs.
const TODAY = 'today';

/**
 * What a studio trial is given beyond its task: its context pack's guidance
 * per stage, the model of each turn of a first version, and, for a
 * reference build, the model its session is stamped with (it runs none).
 * Empty for every other trial.
 */
async function studioContext(pool, config, row, settings) {
  const bot = require('../homeroom-bot');
  const botConfigs = require('../bot-configs');
  const out = {};
  if (row.context_pack_id) {
    const packs = require('./packs');
    const pack = await packs.packRow(pool, row.context_pack_id);
    if (!pack) throw new Error('the trial\'s context pack is gone');
    out.pack = pack;
    out.guidance = Object.fromEntries(packs.STAGES.map((st) => [st, packs.guidanceFor(pack, st) || null]));
  }
  // A configuration version (services/bot-configs.js) the trial builds by:
  // a side build of a live first version names it on the trial, a studio
  // arm as its model (`config:<id>`). `today` is not one: it is the live
  // bot's per-stage models, as it always was (below); the current
  // configuration is an arm of its own, `config:<its id>`.
  const namedId = row.bot_config_version_id || botConfigs.configIdOfModel(row.model);
  const version = namedId ? await botConfigs.versionById(pool, namedId) : null;
  const recipe = version ? botConfigs.recipeOf(version.recipe) : null;
  if (namedId && !recipe) throw new Error('the trial\'s configuration version is gone');
  if (recipe) {
    out.stageModels = { ...recipe.models };
    out.harnessOf = require('../homeroom-bot-live').recipeHarness;
    out.configVersionId = version.id;
    if (botConfigs.reviews(recipe)) out.reviewer = recipe.reviewer;
    // Its build-speed tweaks, which a first version's build applies.
    const tweaks = botConfigs.tweaksOf(recipe);
    if (tweaks.length) out.tweaks = tweaks;
    // Its effort and clocks per stage, where it names them (recipe.effort,
    // recipe.clocks), as a live build of it gets them.
    if (recipe.effort) out.efforts = { ...recipe.effort };
    if (recipe.clocks) out.clocks = { ...recipe.clocks };
    if (recipe.pack && !row.context_pack_id) {
      const packs = require('./packs');
      const pack = await packs.packRow(pool, recipe.pack);
      if (pack) {
        out.pack = pack;
        out.guidance = Object.fromEntries(packs.STAGES.map((st) => [st, packs.guidanceFor(pack, st) || null]));
      }
    }
    if (row.bot_config_version_id) out.sideBuild = { botRunId: row.bot_run_id || null, versionId: version.id };
  } else if (row.model === TODAY) {
    out.stageModels = {
      triage: bot.stageModel(settings, config, 'triage'),
      spec: bot.stageModel(settings, config, 'spec'),
      build: bot.stageModel(settings, config, 'build'),
    };
    if (!out.stageModels.build) throw new Error('no model is set for the bot\'s stages');
  }
  if (row.reference_label) out.sessionModel = row.run_baseline || catalog.BASELINE;
  // A run that shares its plans (bench/shared-plans.js): which of its
  // brief's plans this trial builds from, the attempt it was launched as
  // (a rerun keeps its trial's).
  if (row.run_shared_plans && row.stage === 'first_version' && !row.reference_label) {
    out.sharedPlan = { key: Number(row.plan_key) || Number(row.attempt) || 1 };
  }
  return out;
}

/**
 * The trial's session (and branch and base), on its row as soon as they
 * exist. Every session it opens is kept (`session_ids`: a first version's
 * triage, then its build), so a trial recorded as lost is charged for all of
 * them and puts all of them away.
 */
async function noteSession(pool, trialId, sessionId, { baseSha = null, branch = null } = {}) {
  try {
    await pool.query(
      `UPDATE bench_trials
          SET session_id = $2, base_sha = COALESCE($3, base_sha), build_branch = COALESCE($4, build_branch),
              session_ids = CASE WHEN $2 = ANY(session_ids) THEN session_ids ELSE array_append(session_ids, $2) END
        WHERE id = $1 AND status = 'running'`,
      [Number(trialId), Number(sessionId), baseSha || null, branch || null],
    );
  } catch (err) {
    log.warn('bench', 'Could not record a trial\'s session', { trialId, sessionId, err: err.message });
  }
}

// ── A trial as a durable build ───────────────────────────────────────────
//
// A trial the lane starts is a durable build of the workflow kernel's
// bot-build machine, `trial:<id>@<nonce>` (services/build-runs.js,
// docs/plans/bot-build-workflow.md), as the bot's own builds are. Its work
// item is claimed under a lease the kernel renews while the trial runs, and
// the trial's stage runs on durable steps over the item's checkpoint
// (runner.js): a restart ends the lease, the next process claims the item
// and runs executeTrial again, which carries the trial on from the last
// step it saved and follows a turn the restart caught.

/**
 * The machine's run of a trial (build-runs.js TARGETS.trial): the claimed
 * trial, run and recorded on `steps`. Only the build its claim named runs
 * it (`input.nonce`): one sent for a claim that did not happen (the trial
 * was cancelled meanwhile) finds it so and runs nothing. Resolves { status }.
 */
async function runTrial({ pool, config, id, input = {}, steps, deps = {} }) {
  const key = buildKeyOf(id, input?.nonce);
  const { rows: [trialRow] } = await pool.query('SELECT id, run_id, status, build_key FROM bench_trials WHERE id = $1', [Number(id)]);
  if (!trialRow) return { status: 'gone' };
  // Recorded by this build already: a restart came between the record and
  // its step being saved. What follows the record is done again.
  if (trialRow.status !== 'running' && trialRow.build_key === key) {
    await afterRecorded(pool, config, Number(id), deps);
    return { status: trialRow.status };
  }
  if (!claimedBy(trialRow, key)) return { status: trialRow.status === 'running' ? 'not_this_claim' : trialRow.status };
  return { status: await executeTrial(pool, config, trialRow, { ...deps, durable: steps, buildKey: key }) };
}

// What recordTrial does after its record that is safe to do twice: the
// trial's sessions put away, its grade, a side build's result. (The
// allowance's debit is not: a restart in that gap loses it, as it did.)
async function afterRecorded(pool, config, id, deps = {}) {
  const row = await loadTrialContext(pool, id);
  if (!row) return;
  const d = liveDeps(deps);
  const sessionIds = [...new Set([row.session_id, ...(row.session_ids || [])].filter(Boolean).map(Number))];
  const lifecycle = d.sessionLifecycle || require('../session-lifecycle');
  for (const sid of sessionIds) {
    await lifecycle.closeOwnSession({ pool, sessionId: sid, reason: 'bench' }).catch(() => {});
  }
  const grade = d.afterTrial || ((p, tid) => require('./graders').gradeTrial(p, tid, { github: d.github }));
  await Promise.resolve(grade(pool, id)).catch((err) => {
    log.warn('bench', 'After-trial grading failed', { trialId: id, err: err.message });
  });
  if (row.bot_config_version_id) await require('../bot-configs').finishSideTrial(pool, id);
}

function buildKeyOf(id, nonce) {
  return require('../build-runs').keyOf('trial', id, nonce || null);
}

// Whether the trial's claim is this build's. A trial claimed before claims
// named their build (an older release's lane) is every build's.
function claimedBy(row, key) {
  return row.status === 'running' && (!row.build_key || row.build_key === key);
}

/**
 * A durable trial whose build failed for good (its handler threw twice,
 * restarts caught it more often than the kernel carries a build on, or an
 * admin stopped it), or whose build ended without recording it (the lane
 * finds those: `bench.lost`), recorded through the finisher every trial
 * ends by (recordTrial): what its sessions spent charged to its run, its
 * sessions put away. Then the lane looks again: its slot is free. Throws
 * when it could not record it, so its work tries again.
 */
async function recordLostTrial({ pool, config, id, nonce = null, key: named = null, error = null }) {
  try {
    const row = await loadTrialContext(pool, id);
    const key = named || buildKeyOf(id, nonce);
    if (!row || !claimedBy(row, key)) return;
    const user = await runner.ensureBenchUser(pool, config);
    // Stopped (an admin's cancel): recorded as the cancel it was.
    const stopped = error?.code === 'stopped';
    const why = stopped ? 'cancelled by an admin'
      : `the trial could not be carried on (${String(error?.message || error || 'lost').slice(0, 300)})`;
    await recordTrial(pool, {
      trialRow: { id: row.id, run_id: row.run_id }, row, user, d: liveDeps(), buildKey: key,
      patch: { status: stopped ? 'cancelled' : 'infra_fail', error: why, session_id: row.session_id || null, session_ids: row.session_ids || [] },
    });
  } catch (err) {
    log.warn('bench', 'Could not record a lost trial', { trialId: id, err: err.message });
    throw err;
  } finally {
    await look();
  }
}

/**
 * Run one claimed trial and record it. Resolves its final status. Whatever
 * goes wrong is recorded on the trial; it throws only a stop (a durable
 * trial that is no longer this process's, which its next owner carries on).
 */
async function executeTrial(pool, config, trialRow, deps = {}) {
  const steps = durableSteps.of(deps);
  // Recorded already, by an attempt a restart caught just after.
  if (steps.has('recorded')) return steps.get('recorded');
  const startedMs = Number(await steps.once('started_ms', async () => Date.now())) || Date.now();
  const d = liveDeps(deps);
  const bot = require('../homeroom-bot');
  const row = await loadTrialContext(pool, trialRow.id);
  // A restart carried it on: how often, as the studio shows a trial that
  // ran across restarts (studio.js `resumed`), and whose turns it holds.
  if (row && steps.lostAttempts > 0) {
    await pool.query(
      `UPDATE bench_trials SET checkpoint = jsonb_build_object('handBacks', $2::int), recovered_at = NOW()
        WHERE id = $1 AND status = 'running'`,
      [row.id, steps.lostAttempts],
    ).catch(() => {});
  }
  let patch;
  let user = null;
  let watch = null;
  try {
    if (!row) throw new Error('the trial is gone');
    if (!row.app_id) throw new Error('the task\'s app is gone');
    const repo = bot.parseRepo(row.repo_url);
    if (!repo) throw new Error('the app has no GitHub repository');
    const snapshot = await snapshots.readSnapshot(pool, row.snapshot_id);
    if (!snapshot) throw new Error('the task\'s snapshot is gone');
    user = deps.user || await runner.ensureBenchUser(pool, config);
    const settings = await bot.readSettings(pool);
    const app = { id: row.app_id, slug: row.app_slug, name: row.app_name, repo_url: row.repo_url, self_hosted: row.self_hosted };
    const task = { id: row.task_id, stage: row.stage, reference: row.reference || {}, tags: row.tags || {} };
    const studio = await studioContext(pool, config, row, settings);
    // A core run's arm may name an effort (`vendor/model@max`): the trial
    // runs its model, every turn at that effort (runner.turnEffort).
    const arm = arms.parseArm(row.model);
    const model = studio.stageModels ? studio.stageModels.build : arm.model;
    // The skills it reached for and the looks it took, kept as they change,
    // and carried on with the trial after a restart.
    const seen = steps.get('watch') || null;
    watch = progress.tracker(pool, row.id, {
      log, skills: seen?.skills || null, looks: seen?.looks || null,
      ...(steps.active ? { keep: () => steps.set('watch', { skills: watch.skills(), looks: watch.looks() }) } : {}),
      ...(steps.resumed && row.progress ? { seed: row.progress } : {}),
      // Its whole transcript too (bench_trial_lines), every attempt's.
      transcript: {},
    });
    // A turn a restart caught is followed from its start: its looks are
    // counted again on those it began with, and the lines the transcript
    // holds already are not written again (progress.js replay).
    steps.listen(async (e) => {
      if (e.kind === 'turn_start') {
        await steps.set(`looks_at/${e.key}`, watch.looks());
      } else if (e.kind === 'turn_follow') {
        watch.replay({ looks: steps.get(`looks_at/${e.key}`) || null, skip: await linesSince(pool, row.id, e.activeTurn?.startedAt) });
      } else if (e.kind === 'turn_followed') {
        watch.replayed();
      }
    });
    patch = await runner.runStage({
      pool, config, stage: row.stage, task, snapshot, model, user, app, repo,
      trial: {
        id: row.id, run_id: row.run_id, attempt: row.attempt,
        reference_label: row.reference_label || null, capture_sha: row.capture_sha || null,
        base_sha: row.base_sha || null, build_commits: row.build_commits ?? null,
      },
      deps: d, budgets: runner.budgetsFor(settings, app, config, row.stage, studio.clocks || null),
      title: `Homeroom benchmark: run ${row.run_id}, trial ${row.id}`,
      ...studio,
      ...(arm.effort && !studio.stageModels ? { effort: arm.effort } : {}),
      onStep: (name) => watch.step(name),
      onActivity: (line) => watch.note(line),
      // Its run cancelled: nothing after this starts (a trial cancelled on
      // its own is stopped by its build, its work cancelled).
      skipCheck: async () => (await runCancelled(pool, row.run_id) ? 'cancelled by an admin' : null),
      // On the trial before its turn runs.
      onSession: async (sessionId, where) => {
        await noteSession(pool, row.id, sessionId, where);
      },
    });
    const skills = watch.skills();
    if (skills.invoked.length || skills.read.length || row.context_pack_id) {
      patch.parsed = { ...(patch.parsed || {}), skills };
    }
    // The looks its turns took in the in-loop browser, beside what its build
    // was told it could see and what its model was handed (runner.buildStage).
    const looks = watch.looks();
    if (patch.parsed?.sight || looks.screenshots || looks.snapshots || looks.navigations) {
      patch.parsed = { ...(patch.parsed || {}), sight: { told: null, passed: null, ...(patch.parsed?.sight || {}), ...looks } };
    }
    // Its time from its first attempt, restarts included.
    if (patch.duration_ms != null) patch.duration_ms = Math.max(Date.now() - startedMs, 0);
    patch = asPlatformFault(patch);
  } catch (err) {
    durableSteps.rethrowStop(err, `trial ${trialRow.id}`);
    patch = { status: 'infra_fail', error: `setup: ${err.message}` };
  } finally {
    if (watch) await watch.close();
  }
  return steps.once('recorded', () => recordTrial(pool, { trialRow, row, patch, user, d, buildKey: deps.buildKey || null }));
}

async function runCancelled(pool, runId) {
  const { rows: [r] } = await pool.query('SELECT status FROM bench_runs WHERE id = $1', [Number(runId)]);
  return r?.status === 'cancelled';
}

/** How many lines of a trial's transcript were written since `at` (a turn's start). */
async function linesSince(pool, trialId, at) {
  if (!at || !Number.isFinite(Date.parse(at))) return 0;
  const { rows: [r] } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM bench_trial_lines WHERE trial_id = $1 AND kind = 'line' AND at >= $2::timestamptz",
    [Number(trialId), at],
  );
  return Number(r?.n) || 0;
}

/**
 * A trial's turns are over: record what they did: the ledger cost, the
 * trial's row, the run's spend and the allowance debit, the sessions put
 * away, an empty branch deleted, and the deterministic grade. The run is
 * charged only by the call that recorded the trial, so recording it again
 * (a restart between this and its step being saved: executeTrial) charges
 * nothing twice.
 */
async function recordTrial(pool, { trialRow, row, patch, user, d, buildKey = null }) {
  // What the trial's own sessions spent, from the ledger: exact, and it
  // counts every attempt the turn made, failed ones included.
  const sessionIds = [...new Set([patch.session_id, ...(patch.session_ids || [])].filter(Boolean).map(Number))];
  let cost = Number.isFinite(patch.cost_usd) ? patch.cost_usd : null;
  // What the trial spent beside its agent turns, which the ledger below
  // does not hold: a first version's reviewer calls (services/bot-review.js),
  // and its plan at Make it and early first look (bench/runner.js earlySteps).
  const beside = (v) => (Number.isFinite(Number(v)) ? Math.max(Number(v), 0) : 0);
  const besideLedger = beside(patch.review_cost_usd) + beside(patch.helper_cost_usd);
  let inputTokens = patch.input_tokens ?? null;
  let outputTokens = patch.output_tokens ?? null;
  const routedModels = new Set();
  const ledger = { cost: 0, priced: 0, input: 0, output: 0 };
  for (const id of sessionIds) {
    // eslint-disable-next-line no-await-in-loop
    const usage = await runner.sessionUsage(pool, id).catch(() => null);
    if (!usage) continue;
    ledger.cost += Number(usage.cost) || 0;
    ledger.priced += Number(usage.priced) || 0;
    ledger.input += Number(usage.input_tokens) || 0;
    ledger.output += Number(usage.output_tokens) || 0;
    for (const m of usage.routed_models || []) routedModels.add(m);
  }
  if (ledger.priced > 0) cost = ledger.cost + besideLedger;
  // A trial that ran no turn (its plan was written, then it was cancelled)
  // still paid for the plan.
  else if (beside(patch.helper_cost_usd) > 0) cost = (Number.isFinite(cost) ? cost : 0) + beside(patch.helper_cost_usd);
  if (ledger.input > 0) inputTokens = ledger.input;
  if (ledger.output > 0) outputTokens = ledger.output;
  const charge = cost;
  // Which model OpenRouter actually served: a check that the trial ran what
  // it was meant to. Kept on the trial, never shown to a judge.
  const parsed = patch.parsed || routedModels.size
    ? { ...(patch.parsed || {}), ...(routedModels.size ? { routedModels: [...routedModels] } : {}) }
    : null;

  // The trial recorded and its run charged in one statement, and only by
  // the build its claim named: a crash between the two cannot lose the
  // charge, and a build of an earlier claim cannot record over a later one.
  const { rows: [after] } = await pool.query(
    `WITH recorded AS (
       UPDATE bench_trials tr
          SET status = CASE WHEN r.status = 'cancelled' THEN 'cancelled' ELSE $2 END,
              raw_output = $3, parsed = $4::jsonb, cost_usd = $5, input_tokens = $6, output_tokens = $7,
              -- With the time its earlier claims ran, when a restart split it.
              duration_ms = CASE WHEN $8::int IS NULL THEN NULL ELSE LEAST($8::bigint + tr.prior_ms, 2147483647)::int END,
              session_id = COALESCE($9, tr.session_id), base_sha = COALESCE($10, tr.base_sha),
              -- A lost or cancelled trial says no branch: the one it cut stays
              -- named, for the sweep.
              build_branch = COALESCE($11, tr.build_branch), build_sha = $12,
              build_commits = $13, diff = $14, changed_files = $15::jsonb, checks = $16::jsonb, error = $17,
              capture = $18::jsonb,
              finished_at = NOW()
         FROM bench_runs r
        WHERE tr.id = $1 AND r.id = tr.run_id AND tr.status = 'running'
          AND (tr.build_key IS NULL OR $20::text IS NULL OR tr.build_key = $20)
        RETURNING tr.status, tr.run_id
     ), charged AS (
       UPDATE bench_runs SET spent_usd = spent_usd + $19::numeric
        WHERE $19::numeric > 0 AND id IN (SELECT run_id FROM recorded)
     )
     SELECT status, run_id FROM recorded`,
    [trialRow.id, patch.status, patch.raw_output ?? null, parsed ? JSON.stringify(parsed) : null,
      cost, inputTokens, outputTokens, patch.duration_ms ?? null, sessionIds[0] || null,
      patch.base_sha || null, patch.build_branch || null, patch.build_sha || null,
      Number.isFinite(patch.build_commits) ? patch.build_commits : null,
      patch.diff ?? null, patch.changed_files ? JSON.stringify(patch.changed_files) : null,
      patch.checks ? JSON.stringify(patch.checks) : null,
      patch.error ? String(patch.error).slice(0, 1000) : null,
      patch.capture ? JSON.stringify(patch.capture) : null, charge > 0 ? charge : 0, buildKey],
  );
  if (charge > 0 && after) {
    try {
      if (user && await d.managedOpenRouter.usesIncludedKey(pool, user.id)) {
        await d.limits.recordSpend(pool, user.id, Math.round(charge * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('bench', 'Benchmark spend debit failed', { err: err.message });
    }
  }
  // Put the trial's sessions away; nobody opens them. Closed the way every
  // close goes, their workers destroyed with them.
  if (sessionIds.length && user) {
    const lifecycle = d.sessionLifecycle || require('../session-lifecycle');
    for (const id of sessionIds) {
      await lifecycle.closeOwnSession({ pool, sessionId: id, reason: 'bench' }).catch(() => {});
    }
  }
  // A branch with nothing on it is not kept. Nor is a first version's side
  // build's (services/bot-configs.js): it sits on the live project's own
  // repository, and its diff and screenshots are on the trial already. A
  // later change's side build keeps its commits for the sweep, as any build
  // trial does, so its pair's compare link opens while the pair waits.
  if (patch.build_branch && (!(patch.build_commits > 0) || (row?.bot_config_version_id && row?.run_kind !== LATER_SIDE_RUN_KIND)) && row?.repo_url) {
    await deleteBranch(pool, d.github, row.repo_url, patch.build_branch, trialRow.id);
  }
  // The deterministic grade, at once: a build's diff-scope rule reads the
  // branch while it is still there.
  const grade = d.afterTrial || ((p, id) => require('./graders').gradeTrial(p, id, { github: d.github }));
  await Promise.resolve(grade(pool, trialRow.id)).catch((err) => {
    log.warn('bench', 'After-trial grading failed', { trialId: trialRow.id, err: err.message });
  });
  // A side build's result, and the pairs it completes (services/bot-configs.js).
  if (row?.bot_config_version_id && after) await require('../bot-configs').finishSideTrial(pool, trialRow.id);
  log.info('bench', 'Trial finished', {
    trialId: trialRow.id, runId: trialRow.run_id, stage: row?.stage, status: after?.status || patch.status, costUsd: cost,
  });
  return after?.status || patch.status;
}

async function deleteBranch(pool, github, repoUrl, branch, trialId) {
  const bot = require('../homeroom-bot');
  const repo = bot.parseRepo(repoUrl);
  if (!repo) return false;
  try {
    await github.deleteBenchBranch(repo.owner, repo.repo, branch);
    await pool.query('UPDATE bench_trials SET branch_deleted_at = NOW() WHERE id = $1', [trialId]);
    return true;
  } catch (err) {
    log.warn('bench', 'Could not delete a benchmark branch', { branch, err: err.message });
    return false;
  }
}

/**
 * Kept branches past their time, deleted (the bench-sweep clock). A side
 * build's whose pair still waits for a pick is kept on, as recordTrial says
 * it is, until the pair is picked (or left out) or BRANCH_KEEP_WAITING_DAYS
 * pass: before, the sweep took it at seven days like any other, and the
 * pair's compare link stopped opening while the pair still waited.
 */
async function sweepBranches(pool, deps = {}) {
  // Each deletion spends the bot token's hourly budget, and nothing waits on
  // it: under the reserve it waits for the reset, at the clock's next run.
  const githubBudget = require('../github-budget');
  if (!githubBudget.budgetAllows('background')) return 0;
  const github = runner.guardedGithub(deps.github || require('../github'));
  const { rows } = await pool.query(
    `SELECT tr.id, tr.build_branch, a.repo_url
       FROM bench_trials tr
       JOIN bench_tasks t ON t.id = tr.task_id
       JOIN apps a ON a.id = t.app_id
      WHERE tr.build_branch IS NOT NULL AND tr.branch_deleted_at IS NULL
        AND tr.kept_at IS NULL
        AND tr.finished_at < NOW() - make_interval(days => $1)
        AND (tr.finished_at < NOW() - make_interval(days => $2)
             OR NOT EXISTS (
               SELECT 1 FROM bot_config_results cr
                 JOIN bot_config_pairs p ON p.side_result_id = cr.id
                WHERE cr.trial_id = tr.id AND p.status = 'waiting'))
      ORDER BY tr.id LIMIT 50`,
    [BRANCH_KEEP_DAYS, BRANCH_KEEP_WAITING_DAYS],
  );
  let n = 0;
  for (const r of rows) {
    if (!githubBudget.budgetAllows('background')) return n;
    // eslint-disable-next-line no-await-in-loop
    if (await deleteBranch(pool, github, r.repo_url, r.build_branch, r.id)) n += 1;
  }
  // A run's shared first commits (services/bench/scaffold.js), once the run
  // is over and they are as old as a build's branch may be: a reference
  // built later would have nothing to start from, and its order says so.
  const { rows: firsts } = await pool.query(
    `SELECT sc.id, sc.branch, a.repo_url
       FROM bench_scaffolds sc
       JOIN bench_runs r ON r.id = sc.run_id
       JOIN bench_tasks t ON t.id = sc.task_id
       JOIN apps a ON a.id = t.app_id
      WHERE sc.branch IS NOT NULL AND sc.branch_deleted_at IS NULL
        AND r.status NOT IN ('queued', 'running')
        AND sc.claimed_at < NOW() - make_interval(days => $1)
      ORDER BY sc.id LIMIT 50`,
    [BRANCH_KEEP_DAYS],
  );
  const bot = require('../homeroom-bot');
  for (const r of firsts) {
    if (!githubBudget.budgetAllows('background')) return n;
    const repo = bot.parseRepo(r.repo_url);
    if (!repo) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await github.deleteBenchBranch(repo.owner, repo.repo, r.branch);
      // eslint-disable-next-line no-await-in-loop
      await pool.query('UPDATE bench_scaffolds SET branch_deleted_at = NOW() WHERE id = $1', [r.id]);
      n += 1;
    } catch (err) {
      log.warn('bench', 'Could not delete a first commit\'s branch', { branch: r.branch, err: err.message });
    }
  }
  return n;
}

// ── What a cap or a cancel leaves ────────────────────────────────────────

/**
 * Side builds' results still pending whose trial has ended without a
 * result of its own: skipped at the cap, or cancelled. Each is finished as
 * one the lane recorded (bot-configs.js finishSideTrial): its result
 * skipped, with why, so none waits for good. `runId`: that run's only (the
 * lane's `bench.sides` work after a cap or a cancel); else every run's (the
 * bench-sweep clock). Resolves how many it settled; never throws.
 */
async function settleSideResults(pool, { runId = null } = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT tr.id FROM bot_config_results cr
         JOIN bench_trials tr ON tr.id = cr.trial_id
        WHERE cr.status = 'pending' AND cr.source = 'trial'
          AND tr.status NOT IN ('pending', 'running', 'awaiting')
          AND ($1::int IS NULL OR tr.run_id = $1)
        ORDER BY tr.id LIMIT 50`,
      [runId == null ? null : Number(runId)],
    );
    let n = 0;
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      if (await require('../bot-configs').finishSideTrial(pool, r.id)) n += 1;
    }
    if (n) log.info('bench', 'Settled side builds whose trial ended without a result', { results: n });
    return n;
  } catch (err) {
    log.warn('bench', 'Could not settle side builds\' results', { err: err.message });
    return 0;
  }
}

// A provider refusing the bench's key for its spending limit (run 196:
// OpenRouter's "403 Key limit exceeded (weekly limit)" on its last ten
// trials, each failed on its first request). It is the platform's fault,
// not the model's: the trial is an infra_fail, out of its arm's build rate,
// and the lane starts nothing new for PROVIDER_LIMIT_PAUSE_MS after it
// (its machine reads the pause from the trials; providerLimitPause for the
// studio), as it waits on the bench user's own allowance.
const { PROVIDER_LIMIT_RE, PROVIDER_LIMIT_PAUSE_MS } = laneFacts;

/** Whether a trial's error is its provider refusing the key for its spending limit. Pure. */
function providerLimitHit(error) {
  return PROVIDER_LIMIT_RE.test(String(error || ''));
}

// A review stopped by one of these could not finish what it found: run
// 196's trials 1498 and 1504 built, and their fix turns were refused.
const REVIEW_CUT_STOPS = new Set(['fix_failed', 'reviewer_error']);

/**
 * A trial's result, read as the platform's fault when providerLimitHit
 * says so: its model's failure, or a first version that built but whose
 * review was cut short by the refusal (its review's numbers would count a
 * review that never finished). Pure.
 */
function asPlatformFault(patch) {
  if (!patch) return patch;
  if (patch.status === 'model_fail' && providerLimitHit(patch.error)) return { ...patch, status: 'infra_fail' };
  const review = patch.parsed?.review;
  if (patch.status === 'ok' && review && REVIEW_CUT_STOPS.has(review.stop) && providerLimitHit(review.stopDetail)) {
    return { ...patch, status: 'infra_fail', error: `the review was cut short: ${review.stopDetail}` };
  }
  return patch;
}

/**
 * The lane's pause after a provider refused the key for its spending
 * limit: { until } while the last trial the bench finished (any run: they
 * share the key) was refused that way less than PROVIDER_LIMIT_PAUSE_MS
 * ago, else null. Read from the trials, so it holds in every process and
 * through a restart; once it is over, the next trial is the one that finds
 * out whether the key works again, and one that ends any other way lifts
 * it. Never throws.
 */
async function providerLimitPause(pool, { now = Date.now() } = {}) {
  try {
    const { rows: [last] } = await pool.query(
      `SELECT error, finished_at FROM bench_trials
        WHERE finished_at IS NOT NULL AND status NOT IN ('not_applicable', 'skipped_cap', 'cancelled')
        ORDER BY finished_at DESC LIMIT 1`,
    );
    if (!last || !providerLimitHit(last.error)) return null;
    const until = new Date(last.finished_at).getTime() + PROVIDER_LIMIT_PAUSE_MS;
    return until > now ? { until: new Date(until).toISOString() } : null;
  } catch (err) {
    log.warn('bench', 'Could not read whether the provider refused the bench key', { err: err.message });
    return null;
  }
}

/**
 * Whether the bench user's allowance lets a trial start: the lane's
 * `bench.gate` work (its machine calls no legacy code in a transition), the
 * user made first, with its included key. Resolves { ok, reason }.
 */
async function allowanceGate(pool, config, deps = {}) {
  const user = await runner.ensureBenchUser(pool, config);
  const budget = await (deps.limits || require('../limits')).checkBudget(pool, user.id);
  return budget.error ? { ok: false, reason: String(budget.reason || budget.error).slice(0, 200) } : { ok: true, reason: null };
}

/** The bench-sweep clock's run: kept branches past their time, results left waiting, the studio's previews. */
async function sweep(pool, deps = {}) {
  const branches = await sweepBranches(pool, deps).catch((err) => {
    log.warn('bench', 'Branch sweep failed', { err: err.message });
    return 0;
  });
  const sides = await settleSideResults(pool);
  const previews = await require('./studio').sweepPreviews(pool, deps).catch(() => 0);
  return { branches, sides, previews: Number(previews) || 0 };
}

/** Every run, newest first, with its progress. */
async function listRuns(pool, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT r.id, r.suite_id, s.name AS suite_name, s.version AS suite_version, r.models, r.baseline_model,
            r.stages, r.repeats, r.cap_usd::float8 AS cap_usd, r.concurrency, r.status,
            r.spent_usd::float8 AS spent_usd, r.note, r.created_at, r.started_at, r.finished_at,
            u.username AS started_by, COALESCE(c.counts, '{}'::jsonb) AS counts
       FROM bench_runs r
       JOIN bench_suites s ON s.id = r.suite_id
       LEFT JOIN users u ON u.id = r.started_by
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(status, n) AS counts
           FROM (SELECT status, COUNT(*)::int AS n FROM bench_trials WHERE run_id = r.id GROUP BY status) x
       ) c ON TRUE
      ORDER BY r.id DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)],
  );
  return rows;
}

/** The lane as the console shows it: its machine's, read from Postgres. */
async function laneStatus(deps = {}) {
  return (deps.platform || platform()).benchLaneStatus();
}

module.exports = {
  MAX_CONCURRENCY,
  HEAVY_STAGES,
  MAX_HEAVY_PER_RUN,
  MAX_IN_FLIGHT,
  MAX_MODELS,
  MAX_REPEATS,
  DEFAULT_CAP_USD,
  DEFAULT_REPEATS,
  SINGLE_ATTEMPT_STAGES,
  BRANCH_KEEP_DAYS,
  BRANCH_KEEP_WAITING_DAYS,
  validateLaunch,
  attemptsFor,
  launcherDefaults,
  planRun,
  estimateRun,
  estimateWallMs,
  capHeadroom,
  suggestCap,
  TRIAL_MS_FALLBACK,
  MAX_CAP_USD,
  launchRun,
  look,
  cancelRun,
  cancelTrial,
  reopenRun,
  TODAY,
  studioContext,
  loadTrialContext,
  executeTrial,
  runTrial,
  recordLostTrial,
  recordTrial,
  noteSession,
  sweepBranches,
  settleSideResults,
  sweep,
  allowanceGate,
  PROVIDER_LIMIT_PAUSE_MS,
  providerLimitHit,
  asPlatformFault,
  providerLimitPause,
  listRuns,
  laneStatus,
};
