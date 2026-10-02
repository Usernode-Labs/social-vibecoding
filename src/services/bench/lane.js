'use strict';

// #3654: the benchmark's lane: runs launched by an admin, their trials
// scheduled a few at a time, within each run's dollar cap.
//
// Shape, like the bot's own build lane (homeroom-bot.js "The build lane"):
//
//   * Leader only, on a timer of its own, woken when a run is launched or a
//     trial ends. In-flight trials live in this process; the claim is a
//     conditional UPDATE, so a second drainer could never take the same one.
//   * A run's `concurrency` (1 to 8) trials at once, the oldest run first;
//     of them at most three heavy ones (a build, a checks fix or a spec,
//     each a container turn of many minutes): when the run's next trial is
//     heavy and three of its heavy trials are under way, the lane takes its
//     next light one (triage, DM, follow-up) instead of holding the run.
//     And at most eight trials in flight across every run, counting the ones
//     restart recovery is finishing.
//   * Never while the live bot is using every build slot it has
//     (homeroom-bot isLiveLaneSaturated): the benchmark waits for the bot,
//     not the other way round.
//   * The cap. Before a trial is claimed, what the run has spent, plus the
//     estimate of every trial still under way, plus this trial's estimate
//     (catalog.estimateTrialCost, deliberately pessimistic), must stay inside
//     the run's cap; the first trial that would cross it ends the run's
//     scheduling, and every trial not yet run is marked `skipped_cap`. The
//     bench user's own weekly allowance is checked too, as a backstop. What
//     a trial already under way spends cannot be stopped mid-turn (usage is
//     only known when the turn ends), so the cap can be overrun by at most
//     the overrun of the trials in flight at that moment.
//   * Resumable. Trials are rows, and a trial's session is on its row from
//     the moment it opens. A restart that interrupts a trial does one of
//     two things (server.js adoptOrphanWorker):
//       - its turn is the last one the trial needs (a triage, a follow-up,
//         a checks fix, or a build's build turn) and its worker is still
//         running it: recovery follows the turn's journal to its end and
//         the trial is finished here (finishRecoveredTrial), through the
//         same finisher a trial run start to end uses (recordTrial), held
//         in this lane's slots while it runs;
//       - anything else (a build's spec turn, a DM conversation, a worker
//         that is gone): the turn is abandoned and the trial goes back to
//         `pending` at once (releaseTrial), what the interrupted attempt
//         spent charged to the run, or, after a second interruption, it is
//         `infra_fail`.
//     A trial nothing in this process holds and whose session has no turn
//     left is released on the lane's next pass (releaseOrphaned), and one
//     older than the longest a trial can take on the pass after that
//     (releaseStale), whatever else happened.
//   * Cancellable. A cancelled run claims nothing more, its pending trials
//     are `cancelled`, and its trials under way are stopped.
//
// Branches: a trial's `bench/` branch is deleted when it ends unless it
// holds commits (a build, a revision), which are kept BRANCH_KEEP_DAYS for
// a person to look at; the diff the judge reads is stored on the trial.

const crypto = require('crypto');
const log = require('../logger');
const catalog = require('./catalog');
const runner = require('./runner');
const dmSim = require('./dm-sim');
const snapshots = require('../homeroom-bot-snapshots');

const MAX_CONCURRENCY = 8;
// Heavy stages: at most this many of one run's at once.
const HEAVY_STAGES = Object.freeze(['build', 'checks_fix', 'spec']);
const MAX_HEAVY_PER_RUN = 3;
// Every trial in flight in this process, across runs.
const MAX_IN_FLIGHT = 8;
const MAX_MODELS = 10;
const MAX_REPEATS = 5;
const MIN_CAP_USD = 0.5;
const MAX_CAP_USD = 1000;
const DEFAULT_CAP_USD = 50;
const DEFAULT_REPEATS = 3;
// Builds and specs run once per model whatever `repeats` says: they are the
// expensive stages, and pass^k is a triage measure here.
const SINGLE_ATTEMPT_STAGES = Object.freeze(['build', 'spec']);
const MAX_CLAIMS = 2;
const BRANCH_KEEP_DAYS = 7;
const IDLE_MS = 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
// How long a claimed trial may go without this process holding it before
// the lane counts it an earlier process's. Only the leader runs trials, and
// a new leader is elected only once the old one has exited, so any trial it
// does not hold is orphaned; the grace is a margin, not the mechanism.
const ORPHAN_GRACE_SECONDS = 120;
const TWICE_INTERRUPTED = 'interrupted: the platform restarted during it twice';

const inFlight = new Map(); // trialId -> { runId, est, sessionId, promise, heavy, recovered? }
let laneOn = false;
let laneConfig = null;
let timer = null;
let ticking = false;
let tickAgain = false;
let lastTick = null;
let lastSweepAt = 0;

function token() {
  return crypto.randomBytes(12).toString('base64url');
}

function httpError(status, error) {
  return { ok: false, status, error };
}

// ── Launching ────────────────────────────────────────────────────────────

function validateLaunch(body) {
  const bot = require('../homeroom-bot');
  const suites = require('./suites');
  const suiteId = Number(body.suiteId);
  if (!Number.isInteger(suiteId) || suiteId <= 0) return httpError(400, 'Pick a suite');
  const models = [...new Set((Array.isArray(body.models) ? body.models : []).map((m) => String(m || '').trim()).filter(Boolean))];
  if (!models.length) return httpError(400, 'Pick at least one model');
  if (models.length > MAX_MODELS) return httpError(400, `At most ${MAX_MODELS} models in one run`);
  const bad = models.find((m) => !bot.MODEL_ID_RE.test(m));
  if (bad) return httpError(400, `${bad} is not an OpenRouter model id`);
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
  const baseline = models.includes(catalog.BASELINE) ? catalog.BASELINE : models[0];
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

function launcherDefaults({ suites: list = [], coreSuiteId = null } = {}) {
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
 * Launch a run: one trial per task, model and attempt, decided up front. A
 * trial a model cannot take is recorded `not_applicable` with its reason at
 * once; the rest wait as `pending` for the lane.
 */
async function launchRun(pool, body = {}, { actorId = null } = {}) {
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

  const plan = { task: [], model: [], attempt: [], status: [], error: [], est: [], token: [] };
  let estimate = 0;
  for (const task of tasks) {
    const attempts = attemptsFor(task.stage, v);
    for (const id of v.models) {
      const info = catalog.modelInfo(models, id);
      const reason = dmSim.noAnswerReason(task) || catalog.notApplicableReason(info, task.stage, task.tags?.prompt_chars);
      const est = catalog.estimateTrialCost(info, task.stage, history.get(`${id}|${task.stage}`) || []);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        plan.task.push(task.id);
        plan.model.push(id);
        plan.attempt.push(attempt);
        plan.status.push(reason ? 'not_applicable' : 'pending');
        plan.error.push(reason);
        plan.est.push(Math.round(est * 10000) / 10000);
        plan.token.push(token());
        if (!reason) estimate += est;
      }
    }
  }
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
    wake();
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

async function cancelRun(pool, runId, deps = {}) {
  const { rows } = await pool.query(
    `UPDATE bench_runs SET status = 'cancelled', finished_at = NOW()
      WHERE id = $1 AND status IN ('queued', 'running') RETURNING id`,
    [Number(runId)],
  );
  if (!rows.length) return httpError(409, 'The run is not running');
  await pool.query(
    "UPDATE bench_trials SET status = 'cancelled', finished_at = NOW() WHERE run_id = $1 AND status = 'pending'",
    [Number(runId)],
  );
  const worker = deps.worker || require('../worker');
  for (const [trialId, f] of inFlight) {
    if (f.runId !== Number(runId) || !f.sessionId) continue;
    Promise.resolve(worker.stopTurn(f.sessionId)).catch(() => {});
    log.info('bench', 'Stopping a trial of a cancelled run', { trialId });
  }
  return { ok: true };
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
  };
}

async function loadTrialContext(pool, trialId) {
  const { rows: [row] } = await pool.query(
    `SELECT tr.*, t.stage, t.snapshot_id, t.reference, t.tags, t.issue_number AS task_issue,
            a.id AS app_id, a.slug AS app_slug, a.name AS app_name, a.repo_url, a.self_hosted
       FROM bench_trials tr
       JOIN bench_tasks t ON t.id = tr.task_id
       LEFT JOIN apps a ON a.id = t.app_id
      WHERE tr.id = $1`,
    [Number(trialId)],
  );
  return row || null;
}

/** The trial's session (and branch and base), on its row as soon as they exist. */
async function noteSession(pool, trialId, sessionId, { baseSha = null, branch = null } = {}) {
  try {
    await pool.query(
      `UPDATE bench_trials
          SET session_id = $2, base_sha = COALESCE($3, base_sha), build_branch = COALESCE($4, build_branch)
        WHERE id = $1 AND status = 'running'`,
      [Number(trialId), Number(sessionId), baseSha || null, branch || null],
    );
  } catch (err) {
    log.warn('bench', 'Could not record a trial\'s session', { trialId, sessionId, err: err.message });
  }
}

/**
 * Run one claimed trial and record it. Resolves its final status. Never
 * throws: whatever goes wrong is recorded on the trial.
 */
async function executeTrial(pool, config, trialRow, deps = {}) {
  const d = liveDeps(deps);
  const bot = require('../homeroom-bot');
  const row = await loadTrialContext(pool, trialRow.id);
  let patch;
  let user = null;
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
    patch = await runner.runStage({
      pool, config, stage: row.stage, task, snapshot, model: row.model, user, app, repo,
      trial: { id: row.id, run_id: row.run_id, attempt: row.attempt },
      deps: d, budgets: runner.budgetsFor(settings, app, config, row.stage),
      title: `Homeroom benchmark: run ${row.run_id}, trial ${row.id}`,
      // Written before the turn runs: restart recovery finds the trial
      // through its session.
      onSession: async (sessionId, where) => {
        const f = inFlight.get(row.id);
        if (f) f.sessionId = sessionId;
        await noteSession(pool, row.id, sessionId, where);
      },
    });
  } catch (err) {
    patch = { status: 'infra_fail', error: `setup: ${err.message}` };
  }
  return recordTrial(pool, { trialRow, row, patch, user, d });
}

/**
 * A trial's turns are over: record what they did. Shared by a trial run
 * start to end (executeTrial) and one whose last turn restart recovery
 * followed (finishRecoveredTrial), so the two cannot drift: the ledger cost,
 * the trial's row, the run's spend and the allowance debit, the sessions put
 * away, an empty branch deleted, and the deterministic grade.
 *
 * `recovered` also requires the trial to still be on `sessionId`, charges
 * the run only when this recorded the trial (a release may already have
 * charged it), stamps recovered_at, and leaves the worker to recovery, which
 * still has the turn record to clear in it.
 */
async function recordTrial(pool, { trialRow, row, patch, user, d, recovered = false, sessionId = null }) {
  // What the trial's own session spent, from the ledger: exact, and it
  // counts every attempt the turn made, failed ones included.
  const sessionIds = [...new Set([patch.session_id, ...(patch.session_ids || [])].filter(Boolean))];
  let cost = Number.isFinite(patch.cost_usd) ? patch.cost_usd : null;
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
  if (ledger.priced > 0) cost = ledger.cost;
  if (ledger.input > 0) inputTokens = ledger.input;
  if (ledger.output > 0) outputTokens = ledger.output;
  // Which model OpenRouter actually served: a check that the trial ran what
  // it was meant to. Kept on the trial, never shown to a judge.
  const parsed = patch.parsed || routedModels.size
    ? { ...(patch.parsed || {}), ...(routedModels.size ? { routedModels: [...routedModels] } : {}) }
    : null;

  const { rows: [after] } = await pool.query(
    `UPDATE bench_trials tr
        SET status = CASE WHEN r.status = 'cancelled' THEN 'cancelled' ELSE $2 END,
            raw_output = $3, parsed = $4::jsonb, cost_usd = $5, input_tokens = $6, output_tokens = $7,
            duration_ms = $8, session_id = $9, base_sha = $10, build_branch = $11, build_sha = $12,
            build_commits = $13, diff = $14, changed_files = $15::jsonb, checks = $16::jsonb, error = $17,
            recovered_at = CASE WHEN $18::boolean THEN NOW() ELSE tr.recovered_at END,
            finished_at = NOW()
       FROM bench_runs r
      WHERE tr.id = $1 AND r.id = tr.run_id AND tr.status = 'running'
        AND ($19::int IS NULL OR tr.session_id = $19)
      RETURNING tr.status, tr.run_id`,
    [trialRow.id, patch.status, patch.raw_output ?? null, parsed ? JSON.stringify(parsed) : null,
      cost, inputTokens, outputTokens, patch.duration_ms ?? null, sessionIds[0] || null,
      patch.base_sha || null, patch.build_branch || null, patch.build_sha || null,
      Number.isFinite(patch.build_commits) ? patch.build_commits : null,
      patch.diff ?? null, patch.changed_files ? JSON.stringify(patch.changed_files) : null,
      patch.checks ? JSON.stringify(patch.checks) : null,
      patch.error ? String(patch.error).slice(0, 1000) : null,
      !!recovered, recovered && sessionId ? Number(sessionId) : null],
  );
  if (cost > 0 && (!recovered || after)) {
    await pool.query('UPDATE bench_runs SET spent_usd = spent_usd + $2 WHERE id = $1', [trialRow.run_id, cost]);
    try {
      if (user && await d.managedOpenRouter.usesIncludedKey(pool, user.id)) {
        await d.limits.recordSpend(pool, user.id, Math.round(cost * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('bench', 'Benchmark spend debit failed', { err: err.message });
    }
  }
  // Put the trial's sessions away; nobody opens them.
  if (sessionIds.length && user) {
    await pool.query(
      `UPDATE chat_sessions SET status = 'archived', archived_at = NOW()
        WHERE id = ANY($1::int[]) AND user_id = $2 AND status IN ('active', 'paused')`,
      [sessionIds, user.id],
    ).catch(() => {});
    if (!recovered) for (const id of sessionIds) Promise.resolve(d.worker.evictWorker?.(id)).catch(() => {});
  }
  // A branch with nothing on it is not kept.
  if (patch.build_branch && !(patch.build_commits > 0) && row?.repo_url) {
    await deleteBranch(pool, d.github, row.repo_url, patch.build_branch, trialRow.id);
  }
  // The deterministic grade, at once: a build's diff-scope rule reads the
  // branch while it is still there.
  const grade = d.afterTrial || ((p, id) => require('./graders').gradeTrial(p, id, { github: d.github }));
  await Promise.resolve(grade(pool, trialRow.id)).catch((err) => {
    log.warn('bench', 'After-trial grading failed', { trialId: trialRow.id, err: err.message });
  });
  log.info('bench', recovered ? 'Trial finished after a restart' : 'Trial finished', {
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

/** Kept branches past their time, deleted. Throttled; never throws. */
async function sweepBranches(pool, deps = {}, now = Date.now()) {
  if (now - lastSweepAt < SWEEP_EVERY_MS && !deps.force) return 0;
  lastSweepAt = now;
  const github = runner.guardedGithub(deps.github || require('../github'));
  const { rows } = await pool.query(
    `SELECT tr.id, tr.build_branch, a.repo_url
       FROM bench_trials tr
       JOIN bench_tasks t ON t.id = tr.task_id
       JOIN apps a ON a.id = t.app_id
      WHERE tr.build_branch IS NOT NULL AND tr.branch_deleted_at IS NULL
        AND tr.finished_at < NOW() - make_interval(days => $1)
      ORDER BY tr.id LIMIT 50`,
    [BRANCH_KEEP_DAYS],
  );
  let n = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await deleteBranch(pool, github, r.repo_url, r.build_branch, r.id)) n += 1;
  }
  return n;
}

// ── The lane ─────────────────────────────────────────────────────────────

/**
 * Trials a process that is gone left running. Back to pending once they are
 * older than the longest a trial can take, or failed after a second
 * interruption. Their sessions were abandoned by restart recovery.
 */
async function releaseStale(pool, settings) {
  const turnSeconds = Number(settings?.turnSeconds) || 1200;
  const bot = require('../homeroom-bot');
  const live = require('../homeroom-bot-live');
  const seconds = bot.PLATFORM_BUILD_TIME_FACTOR * (turnSeconds + live.SPEC_TURN_MAX_MS / 1000) + 600;
  const { rows } = await pool.query(
    `UPDATE bench_trials
        SET status = CASE WHEN claims < $3 THEN 'pending' ELSE 'infra_fail' END,
            error = CASE WHEN claims < $3 THEN NULL ELSE $4::text END,
            started_at = CASE WHEN claims < $3 THEN NULL ELSE started_at END,
            finished_at = CASE WHEN claims < $3 THEN NULL ELSE NOW() END
      WHERE status = 'running' AND started_at < NOW() - make_interval(secs => $1)
        AND NOT (id = ANY($2::int[]))
      RETURNING id, status`,
    [seconds, [...inFlight.keys()], MAX_CLAIMS, TWICE_INTERRUPTED],
  );
  if (rows.length) log.info('bench', 'Released trials an earlier process never finished', { trials: rows.length });
  return rows.length;
}

/**
 * A trial a restart interrupted, put back: `pending` for the lane to run
 * again from the start, or `infra_fail` after a second interruption (or
 * `cancelled` / `skipped_cap` when its run has stopped meanwhile). What the
 * interrupted attempt spent, as its session's ledger has it, is charged to
 * the run (spent_usd, so the cap stays honest) and to the bench allowance,
 * and kept on the trial in interrupted_cost_usd: the attempt that finishes
 * the trial records only its own session's cost, so nothing is counted
 * twice. Conditional on the trial still being `running` on `sessionId`, so a
 * second caller for the same interruption changes and charges nothing.
 * Resolves the trial's new status, or null when it was not released.
 */
async function releaseTrial(pool, { trialId, sessionId = null, why = 'interrupted', deps = {} }) {
  const usage = sessionId ? await runner.sessionUsage(pool, sessionId).catch(() => null) : null;
  const cost = usage && Number(usage.priced) > 0 ? Math.max(Number(usage.cost) || 0, 0) : 0;
  const { rows: [out] } = await pool.query(
    `WITH released AS (
       UPDATE bench_trials tr
          SET status = CASE WHEN r.status = 'cancelled' THEN 'cancelled'
                            WHEN r.status = 'capped' THEN 'skipped_cap'
                            WHEN tr.claims < $3 THEN 'pending'
                            ELSE 'infra_fail' END,
              error = CASE WHEN r.status IN ('cancelled', 'capped') OR tr.claims < $3 THEN NULL ELSE $5::text END,
              started_at = CASE WHEN r.status NOT IN ('cancelled', 'capped') AND tr.claims < $3 THEN NULL ELSE tr.started_at END,
              finished_at = CASE WHEN r.status NOT IN ('cancelled', 'capped') AND tr.claims < $3 THEN NULL ELSE NOW() END,
              session_id = CASE WHEN r.status NOT IN ('cancelled', 'capped') AND tr.claims < $3 THEN NULL ELSE tr.session_id END,
              interrupted_cost_usd = tr.interrupted_cost_usd + $4::numeric
         FROM bench_runs r
        WHERE tr.id = $1 AND r.id = tr.run_id AND tr.status = 'running'
          AND tr.session_id IS NOT DISTINCT FROM $2::int
        RETURNING tr.id, tr.run_id, tr.status
     ), charged AS (
       UPDATE bench_runs SET spent_usd = spent_usd + $4::numeric
        WHERE $4::numeric > 0 AND id IN (SELECT run_id FROM released)
        RETURNING id
     )
     SELECT released.id, released.run_id, released.status, (SELECT COUNT(*)::int FROM charged) AS charged
       FROM released`,
    [Number(trialId), sessionId == null ? null : Number(sessionId), MAX_CLAIMS, cost, TWICE_INTERRUPTED],
  );
  if (!out) return null;
  if (cost > 0) {
    try {
      const limits = deps.limits || require('../limits');
      const managedOpenRouter = deps.managedOpenRouter || require('../openrouter-managed-keys');
      const { rows: [s] } = await pool.query('SELECT user_id FROM chat_sessions WHERE id = $1', [Number(sessionId)]);
      if (s?.user_id && await managedOpenRouter.usesIncludedKey(pool, s.user_id)) {
        await limits.recordSpend(pool, s.user_id, Math.round(cost * 1e6) / 1e4, { byok: false });
      }
    } catch (err) {
      log.warn('bench', 'Benchmark spend debit failed', { trialId, err: err.message });
    }
  }
  log.info('bench', 'Released a trial a restart interrupted', {
    trialId: out.id, runId: out.run_id, status: out.status, costUsd: cost, why,
  });
  wake();
  return out.status;
}

/** The running trial on a session, released (releaseTrial). Never throws. */
async function releaseTrialOfSession(pool, sessionId, { why = 'interrupted', deps = {} } = {}) {
  try {
    const { rows: [t] } = await pool.query(
      "SELECT id FROM bench_trials WHERE session_id = $1 AND status = 'running' ORDER BY id DESC LIMIT 1",
      [Number(sessionId)],
    );
    if (!t) return null;
    return await releaseTrial(pool, { trialId: t.id, sessionId, why, deps });
  } catch (err) {
    log.warn('bench', 'Could not release a trial a restart interrupted', { sessionId, err: err.message });
    return null;
  }
}

/**
 * Trials an earlier process left running whose session has nothing left to
 * follow: never opened, gone, archived, or with no turn on record (its
 * worker was gone at the restart, or the turn was cleared). Restart recovery
 * owns a session while it has a turn record, and a trial recovery is
 * finishing is held in `inFlight`, so neither is touched. Released at once
 * rather than after the hour and a half releaseStale waits.
 */
async function releaseOrphaned(pool, deps = {}) {
  const { rows } = await pool.query(
    `SELECT tr.id, tr.session_id
       FROM bench_trials tr
       LEFT JOIN chat_sessions cs ON cs.id = tr.session_id
      WHERE tr.status = 'running'
        AND NOT (tr.id = ANY($1::int[]))
        AND tr.started_at < NOW() - make_interval(secs => $2)
        AND (cs.id IS NULL OR cs.active_turn IS NULL OR cs.status = 'archived')
      ORDER BY tr.id
      LIMIT 50`,
    [[...inFlight.keys()], ORPHAN_GRACE_SECONDS],
  );
  let n = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await releaseTrial(pool, { trialId: r.id, sessionId: r.session_id, why: 'no process or turn holds it', deps })) n += 1;
  }
  return n;
}

// ── After a restart ──────────────────────────────────────────────────────
//
// server.js adoptOrphanWorker hands a benchmark session's surviving worker
// here (recoveryPlan): a turn that is the trial's last is followed to its
// end by resumeDetachedTurn and finished by finishRecoveredTrial; any other
// is abandoned and its trial released.

/** The running trial a session belongs to, and whether its turn can be finished. */
async function recoveryPlan(pool, session, activeTurn) {
  const { rows: [t] } = await pool.query(
    `SELECT tr.id, r.status AS run_status
       FROM bench_trials tr JOIN bench_runs r ON r.id = tr.run_id
      WHERE tr.session_id = $1 AND tr.status = 'running'
      ORDER BY tr.id DESC LIMIT 1`,
    [Number(session.id)],
  );
  if (!t) return null;
  const trial = await loadTrialContext(pool, t.id);
  if (!trial) return null;
  // A cancelled run's turn is stopped, not followed.
  const resumable = t.run_status !== 'cancelled' && runner.resumableTurn(trial.stage, activeTurn);
  return { trial, resumable };
}

/**
 * Hold a lane slot for a trial recovery is finishing, the bot's
 * holdSlotDuringRecovery for the benchmark: the run's concurrency counts
 * it, the cap counts its estimate, releaseStale and releaseOrphaned skip it,
 * and a cancel stops it. Resolves (or rejects) with the recovery.
 */
function holdRecoveredTrial(trial, sessionId, recovery) {
  if (!trial || inFlight.has(trial.id)) return Promise.resolve(recovery);
  const entry = {
    runId: trial.run_id, est: Number(trial.est_cost_usd) || 0, sessionId, promise: null,
    heavy: HEAVY_STAGES.includes(trial.stage), recovered: true,
  };
  const promise = Promise.resolve(recovery).finally(() => {
    if (inFlight.get(trial.id) === entry) inFlight.delete(trial.id);
    wake();
  });
  entry.promise = promise.catch(() => null);
  inFlight.set(trial.id, entry);
  return promise;
}

/**
 * When the trial's own clock ends a recovered turn: the turn's start plus
 * the budget the live path gave it (a build turn's for a build, a turn's
 * otherwise), or null to leave it unbounded.
 */
async function recoveryDeadline(pool, config, session, activeTurn) {
  const startedMs = Date.parse(activeTurn?.startedAt || '');
  if (!Number.isFinite(startedMs)) return null;
  const plan = await recoveryPlan(pool, session, activeTurn);
  if (!plan) return null;
  const bot = require('../homeroom-bot');
  const settings = await bot.readSettings(pool);
  const app = { repo_url: plan.trial.repo_url, self_hosted: plan.trial.self_hosted };
  const budgets = runner.budgetsFor(settings, app, config, plan.trial.stage);
  return startedMs + (plan.trial.stage === 'build' ? budgets.buildMs : budgets.turnMs);
}

/**
 * A trial's last turn, followed to its end by restart recovery: read the
 * way the live stage reads it (runner.recoverStage) and recorded through
 * the same finisher (recordTrial). `result` is what the journal replay
 * returned; `timedOut` says the trial's clock, re-armed by recovery, ended
 * it. Never throws: whatever goes wrong puts the trial back in the queue
 * (releaseTrial), as though recovery had abandoned it.
 */
async function finishRecoveredTrial({ pool, config, session, activeTurn, result = {}, timedOut = false, deps = {} }) {
  try {
    const plan = await recoveryPlan(pool, session, activeTurn);
    if (!plan) {
      log.info('bench', 'A recovered benchmark turn has no running trial; nothing to record', { sessionId: session.id });
      return 'gone';
    }
    const row = plan.trial;
    if (!plan.resumable) throw new Error(`a ${row.stage} trial's ${activeTurn?.mode || 'unknown'} turn is not its last`);
    const d = liveDeps(deps);
    const bot = require('../homeroom-bot');
    const repo = bot.parseRepo(row.repo_url);
    if (!repo) throw new Error('the app has no GitHub repository');
    const snapshot = await snapshots.readSnapshot(pool, row.snapshot_id);
    if (!snapshot) throw new Error('the task\'s snapshot is gone');
    const task = { id: row.task_id, stage: row.stage, reference: row.reference || {}, tags: row.tags || {} };
    const patch = await runner.recoverStage({
      stage: row.stage, snapshot, task, session, activeTurn, result, timedOut, repo, deps: d,
      trial: { id: row.id, run_id: row.run_id, attempt: row.attempt },
      baseSha: row.base_sha || null, branch: row.build_branch || null,
    });
    if (!patch) throw new Error('nothing to finish');
    const startedMs = row.started_at ? new Date(row.started_at).getTime() : NaN;
    patch.duration_ms = Number.isFinite(startedMs) ? Math.max(Date.now() - startedMs, 0) : null;
    return await recordTrial(pool, {
      trialRow: { id: row.id, run_id: row.run_id }, row, patch, user: { id: session.user_id }, d,
      recovered: true, sessionId: session.id,
    });
  } catch (err) {
    log.warn('bench', 'Could not finish a recovered trial; putting it back in the queue', {
      sessionId: session?.id, err: err.message,
    });
    await releaseTrialOfSession(pool, session.id, { why: `recovery: ${err.message}`, deps });
    return 'released';
  }
}

/** End a run's scheduling at its cap: what is left is skipped. */
async function capRun(pool, runId) {
  await pool.query(
    "UPDATE bench_trials SET status = 'skipped_cap', finished_at = NOW() WHERE run_id = $1 AND status = 'pending'",
    [runId],
  );
  await pool.query(
    "UPDATE bench_runs SET status = 'capped', finished_at = NOW() WHERE id = $1 AND status IN ('queued', 'running')",
    [runId],
  );
  log.info('bench', 'Run reached its cap', { runId });
}

/**
 * Whether the next trial fits the cap: what was spent, plus every trial
 * under way at its estimate, plus this one's. Pure.
 */
function fitsCap({ spentUsd, capUsd, inFlightEst = 0, nextEst = 0 }) {
  return Number(spentUsd) + Number(inFlightEst) + Number(nextEst) <= Number(capUsd) + 1e-9;
}

/**
 * One pass: fill each open run's free slots, oldest run first. Returns what
 * it did. Never throws.
 */
async function tick(pool, config, deps = {}) {
  const out = { started: 0, paused: null, finished: [] };
  if (ticking) { tickAgain = true; return { ...out, busy: true }; }
  ticking = true;
  try {
    const bot = require('../homeroom-bot');
    const settings = await bot.readSettings(pool);
    await releaseStale(pool, settings);
    await releaseOrphaned(pool, deps).catch((err) => log.warn('bench', 'Orphaned-trial sweep failed', { err: err.message }));
    await sweepBranches(pool, deps).catch(() => {});
    const { rows: runs } = await pool.query(
      "SELECT * FROM bench_runs WHERE status IN ('queued', 'running') ORDER BY id",
    );
    const limits = deps.limits || require('../limits');
    let user = null;
    for (const run of runs) {
      const mine = [...inFlight.values()].filter((f) => f.runId === run.id);
      const { rows: [left] } = await pool.query(
        "SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending, COUNT(*) FILTER (WHERE status = 'running')::int AS running FROM bench_trials WHERE run_id = $1",
        [run.id],
      );
      if (!left.pending && !left.running && !mine.length) {
        await pool.query(
          "UPDATE bench_runs SET status = 'done', finished_at = NOW() WHERE id = $1 AND status IN ('queued', 'running')",
          [run.id],
        );
        out.finished.push(run.id);
        continue;
      }
      let free = Math.min(run.concurrency, MAX_CONCURRENCY) - mine.length;
      while (free > 0) {
        if (inFlight.size >= MAX_IN_FLIGHT) { out.paused = out.paused || 'lane_full'; break; }
        if ((deps.isLiveLaneSaturated || bot.isLiveLaneSaturated)(settings)) { out.paused = 'live_bot_busy'; break; }
        // eslint-disable-next-line no-await-in-loop
        user = user || deps.user || await runner.ensureBenchUser(pool, config);
        // eslint-disable-next-line no-await-in-loop
        const budget = await limits.checkBudget(pool, user.id);
        if (budget.error) { out.paused = 'bench_allowance'; break; }
        // eslint-disable-next-line no-await-in-loop
        // Its next trial in order, passing over heavy ones while three of
        // its heavy trials are under way.
        const heavyNow = [...inFlight.values()].filter((f) => f.runId === run.id && f.heavy).length;
        const { rows: [next] } = await pool.query(
          `SELECT tr.id, tr.est_cost_usd::float8 AS est, t.stage
             FROM bench_trials tr JOIN bench_tasks t ON t.id = tr.task_id
            WHERE tr.run_id = $1 AND tr.status = 'pending'
              AND ($2::boolean OR NOT (t.stage = ANY($3::text[])))
            ORDER BY tr.attempt, tr.id LIMIT 1`,
          [run.id, heavyNow < MAX_HEAVY_PER_RUN, HEAVY_STAGES],
        );
        if (!next) break;
        const { rows: [money] } = await pool.query(
          'SELECT spent_usd::float8 AS spent, cap_usd::float8 AS cap FROM bench_runs WHERE id = $1', [run.id],
        );
        const running = [...inFlight.values()].filter((f) => f.runId === run.id);
        const inFlightEst = running.reduce((sum, f) => sum + (f.est || 0), 0);
        if (!fitsCap({ spentUsd: money.spent, capUsd: money.cap, inFlightEst, nextEst: next.est || 0 })) {
          // Wait for what is under way, then stop the run there.
          if (!running.length) await capRun(pool, run.id);
          out.paused = out.paused || 'cap';
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const { rows: [claim] } = await pool.query(
          `UPDATE bench_trials SET status = 'running', claims = claims + 1, started_at = NOW()
            WHERE id = $1 AND status = 'pending'
            RETURNING id, run_id, est_cost_usd::float8 AS est`,
          [next.id],
        );
        if (!claim) continue;
        await pool.query(
          "UPDATE bench_runs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1 AND status = 'queued'",
          [run.id],
        );
        const entry = { runId: run.id, est: claim.est || 0, sessionId: null, promise: null, heavy: HEAVY_STAGES.includes(next.stage) };
        inFlight.set(claim.id, entry);
        entry.promise = executeTrial(pool, config, claim, { ...deps, user })
          .catch(async (err) => {
            log.error('bench', 'Trial threw', { trialId: claim.id, err: err.message });
            await pool.query(
              "UPDATE bench_trials SET status = 'infra_fail', error = $2, finished_at = NOW() WHERE id = $1 AND status = 'running'",
              [claim.id, `threw: ${String(err.message).slice(0, 500)}`],
            ).catch(() => {});
          })
          .finally(() => {
            inFlight.delete(claim.id);
            wake();
          });
        out.started += 1;
        free -= 1;
      }
    }
    return out;
  } catch (err) {
    log.error('bench', 'Lane pass failed', { err: err.message });
    return out;
  } finally {
    ticking = false;
    lastTick = { at: new Date().toISOString(), ...out, inFlight: inFlight.size };
  }
}

function schedule(delayMs) {
  if (!laneOn) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      const { getPool } = require('../../db/pool');
      await tick(getPool(laneConfig), laneConfig);
    } catch (err) {
      log.error('bench', 'Lane tick failed', { err: err.message });
    } finally {
      if (tickAgain) { tickAgain = false; schedule(0); } else schedule(IDLE_MS);
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Start the lane on the leader. Inert until a run is launched. */
function start(config) {
  if (laneOn) return;
  laneOn = true;
  laneConfig = config;
  schedule(IDLE_MS);
}

function stop() {
  laneOn = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** A pass now; a no-op on a Pod that is not running the lane. */
function wake() {
  if (!laneOn) return false;
  schedule(0);
  return true;
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

function laneStatus() {
  return { on: laneOn, inFlight: inFlight.size, lastTick };
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
  MAX_CLAIMS,
  BRANCH_KEEP_DAYS,
  validateLaunch,
  attemptsFor,
  launcherDefaults,
  launchRun,
  cancelRun,
  ORPHAN_GRACE_SECONDS,
  executeTrial,
  recordTrial,
  noteSession,
  sweepBranches,
  releaseStale,
  releaseTrial,
  releaseTrialOfSession,
  releaseOrphaned,
  recoveryPlan,
  holdRecoveredTrial,
  recoveryDeadline,
  finishRecoveredTrial,
  capRun,
  fitsCap,
  tick,
  start,
  stop,
  wake,
  listRuns,
  laneStatus,
  _inFlightForTests: () => inFlight,
  async _awaitTrialsForTests() {
    while (inFlight.size) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([...inFlight.values()].map((f) => f.promise));
    }
  },
  _resetForTests() {
    inFlight.clear(); laneOn = false; laneConfig = null; ticking = false; tickAgain = false; lastTick = null; lastSweepAt = 0;
    if (timer) clearTimeout(timer);
    timer = null;
  },
};
