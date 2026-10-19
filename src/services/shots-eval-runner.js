'use strict';

// Runs the trials of before & after shots evals (services/shots-eval.js) on
// the leader, one pass at a time like the benchmark lane (bench/lane.js):
// inert until an eval is launched, at most SHOTS_EVAL_CONCURRENCY trials at
// once, never two on one proposal, and never beside the proposal's own
// shots run.
//
// A trial is the real shots pipeline (shots-orchestrator.executeRun: the two
// exact revisions built, copies of the app's data, the personas signed in,
// the shots agent in the proposal's worker) with three things swapped:
//
//   its STATE   is the trial's row, through trialState() below, which
//       speaks the part of shots-state.js the pipeline uses. The proposal's
//       own shots slot is never read or written, nothing is told to anybody
//       watching the proposal, and the files go to shots_eval_artifacts.
//   its AGENT   runs with the arm's model, prompts and time budget.
//   its BILL    is the platform's. While a trial's shots turn runs, the
//       Anthropic proxy asks billsSession() and sends its calls on the
//       platform's key, gated only by the eval's cap (overCap), never by
//       the author's allowance or the system budget the sync turns live on,
//       and adds each call to the trial through noteSpend(). What it cost
//       is the larger of that and what Claude Code itself reported, and it
//       counts against the eval's cap.
//
// A trial whose heartbeat stops (the leader restarted) is put back in the
// queue with fresh names for its copies, once; after that it fails.

const github = require('./github');
const lifecycle = require('./lifecycle');
const log = require('./logger');
const orchestrator = require('./shots-orchestrator');
const shotsAgent = require('./shots-agent');
const shotsGc = require('./shots-gc');
const shotsState = require('./shots-state');
const evals = require('./shots-eval');
const worker = require('./worker');

const IDLE_MS = 60 * 1000;
const STALE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 2;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const INTERRUPTED_REASON = 'Homeroom restarted while this trial was being taken, twice.';

// trialId -> { trialId, attemptId, sessionId, runId, proxyCents, reportedCents, promise }.
// Each is this process's hold on the trial (services/processes.js): a
// draining process finishes it before it exits.
const inFlight = require('./processes').heldMap('shots_eval');
// sessionId -> the in-flight entry whose shots turn the platform pays for.
const billed = new Map();

let on = false;
let timer = null;
let runnerConfig = null;
let ticking = false;
let tickAgain = false;

function concurrency() {
  const n = Number.parseInt(process.env.SHOTS_EVAL_CONCURRENCY || '', 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CONCURRENCY) : DEFAULT_CONCURRENCY;
}

// ── Billing (read by routes/anthropic-proxy.js) ─────────────────────────

/** Whether this process is running a shots eval trial on the session. */
function billsSession(sessionId) {
  return billed.has(Number(sessionId));
}

/** Add one proxied model call's cost to the session's running trial. */
function noteSpend(sessionId, costCents) {
  const entry = billed.get(Number(sessionId));
  const cents = Number(costCents);
  if (entry && Number.isFinite(cents) && cents > 0) entry.proxyCents += cents;
}

/**
 * Whether `extraCents` more would take the session's running trial's eval
 * past its cap: what the eval had spent when the trial started, what the
 * trial has spent since, and the call in hand. Another trial of the same
 * eval running beside it is not seen, so an eval can end past its cap by
 * at most one trial.
 */
function overCap(sessionId, extraCents = 0) {
  const entry = billed.get(Number(sessionId));
  if (!entry || !(entry.capCents > 0)) return false;
  return entry.spentAtStartCents + entry.proxyCents + (Number(extraCents) || 0) > entry.capCents;
}

// A trial another platform process runs on the session (one finishing its
// work after a release, its shots agent's calls reaching this process): its
// id and how far its eval is from the cap, from the database. Null when no
// live process runs one. What the runner itself has billed is not seen here,
// so the eval can end past its cap by at most a trial, as it already could.
async function remoteTrialFor(pool, sessionId) {
  const { rows: [t] } = await pool.query(
    `SELECT t.id, t.proxy_cents, r.cap_cents, r.spent_cents FROM shots_eval_trials t
       JOIN shots_eval_runs r ON r.id = t.eval_run_id
      WHERE t.session_id = $1 AND t.state = ANY($2::text[])
      ORDER BY t.id DESC LIMIT 1`,
    [Number(sessionId), ACTIVE]);
  if (!t || !require('./processes').heldElsewhere('shots_eval', Number(t.id))) return null;
  return { trialId: Number(t.id), capCents: num(t.cap_cents), spentCents: num(t.spent_cents) + num(t.proxy_cents) };
}

/** Whether `extraCents` more would take that trial's eval past its cap. */
function remoteOverCap(trial, extraCents = 0) {
  return !!trial && trial.capCents > 0 && trial.spentCents + (Number(extraCents) || 0) > trial.capCents;
}

/** One proxied call of a trial another process runs, on the trial's row. */
async function noteRemoteSpend(pool, trialId, costCents) {
  const cents = Number(costCents);
  if (!(Number.isFinite(cents) && cents > 0)) return;
  await pool.query('UPDATE shots_eval_trials SET proxy_cents = proxy_cents + $2::numeric WHERE id = $1', [Number(trialId), cents]);
}

// ── A trial's state, in the shape the shots pipeline uses ───────────────

function stateError(code, message, status = 409) {
  return new shotsState.ShotsStateError(code, message, status);
}

const ACTIVE = ['provisioning', 'exploring', 'reviewing'];

/**
 * The part of shots-state.js that shots-orchestrator.executeRun and its
 * heartbeat call, kept on one trial's row. `runId` is always the trial's
 * attempt id; a trial cancelled meanwhile refuses every transition, which
 * ends the run at its next step.
 */
function trialState(trialId) {
  let provenance = null;
  const trialRow = async (pool, runId, { forUpdate = false, client = null } = {}) => {
    const { rows: [row] } = forUpdate
      ? await (client || pool).query(
        'SELECT * FROM shots_eval_trials WHERE id = $1 AND attempt_id = $2 FOR UPDATE',
        [trialId, String(runId || '')]
      )
      : await (client || pool).query(
        'SELECT * FROM shots_eval_trials WHERE id = $1 AND attempt_id = $2',
        [trialId, String(runId || '')]
      );
    return row || null;
  };
  const asRun = (row) => ({
    ...row,
    id: row.attempt_id,
    trial_id: row.id,
    current_run_id: row.attempt_id,
  });
  return {
    async getRun(pool, runId) {
      const row = await trialRow(pool, runId);
      if (!row) throw stateError('shots_run_not_found', 'Shots eval trial not found.', 404);
      return asRun(row);
    },

    async transitionRun(pool, runId, next, rawPatch = {}) {
      const patch = { ...rawPatch };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const row = await trialRow(pool, runId, { forUpdate: true, client });
        if (!row) throw stateError('stale_shots_operation', 'This trial was taken again or removed.');
        shotsState.assertTransition(row.state, next);
        const hard = patch.hardVerdict ?? row.hard_verdict;
        if (next === 'reviewing' && hard?.passed !== true) {
          throw stateError('shots_hard_verdict_required', 'Publishing shots requires at least one ready change.');
        }
        if (next === 'verified' && (!(patch.planHash ?? row.plan_hash) || hard?.passed !== true)) {
          throw stateError('shots_verdict_required', 'Published shots require a manifest and at least one ready change.');
        }
        if (next === 'failed' && !(patch.failureReason || row.failure_reason)) {
          throw stateError('shots_failure_reason_required', 'Failed shots requires a user-visible reason.');
        }
        if (patch.baseImageDigest || patch.headImageDigest || patch.fixtureFingerprint) {
          provenance = {
            fixtureFingerprint: patch.fixtureFingerprint || null,
            baseImageDigest: patch.baseImageDigest || null,
            headImageDigest: patch.headImageDigest || null,
          };
        }
        const trace = patch.traceSummary
          ? { ...patch.traceSummary, ...(provenance ? { provenance } : {}) }
          : null;
        const terminal = evals.TERMINAL_STATES.includes(next);
        const { rows: [updated] } = await client.query(
          `UPDATE shots_eval_trials
              SET state = $2,
                  updated_at = NOW(),
                  hard_verdict = COALESCE($3::jsonb, hard_verdict),
                  plan_hash = COALESCE($4, plan_hash),
                  trace_summary = COALESCE($5::jsonb, trace_summary),
                  failure_code = COALESCE($6, failure_code),
                  failure_reason = COALESCE($7, failure_reason),
                  completed_at = CASE WHEN $8::boolean THEN NOW() ELSE completed_at END
            WHERE id = $1
            RETURNING *`,
          [row.id, next,
            patch.hardVerdict ? JSON.stringify(patch.hardVerdict) : null,
            patch.planHash || null,
            trace ? JSON.stringify(trace) : null,
            patch.failureCode ? String(patch.failureCode).slice(0, 64) : null,
            patch.failureReason ? String(patch.failureReason).slice(0, 2000) : null,
            terminal]
        );
        await client.query('COMMIT');
        return asRun(updated);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    // The trial's lease, renewed while its runner is alive: recovery takes
    // back a trial whose lease has gone quiet (recoverStale).
    async heartbeatRun(pool, runId, phase) {
      const result = await pool.query(
        `UPDATE shots_eval_trials
            SET updated_at = NOW(),
                trace_summary = jsonb_set(COALESCE(trace_summary, '{}'::jsonb), '{progress}',
                  jsonb_build_object('phase', $3::text, 'at', NOW()), true)
          WHERE id = $1 AND attempt_id = $2 AND state IN ('provisioning', 'exploring', 'reviewing')`,
        [trialId, String(runId || ''), String(phase || '').slice(0, 64)]
      );
      return { active: (result.rowCount || 0) > 0 };
    },

    async storeArtifacts(pool, runId, artifacts, { headSha, planHash } = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [row] } = await client.query(
          `SELECT id FROM shots_eval_trials
            WHERE id = $1 AND attempt_id = $2 AND head_sha = $3 AND plan_hash = $4 AND state = 'reviewing'
            FOR UPDATE`,
          [trialId, String(runId || ''), String(headSha || ''), String(planHash || '')]
        );
        if (!row) throw stateError('stale_shots_operation', 'This trial no longer owns its shots; they were discarded.');
        await client.query('DELETE FROM shots_eval_artifacts WHERE trial_id = $1', [trialId]);
        // A trial stays light only (#4459): its dark shots are skipped, so
        // the table's six-column unique needs no theme.
        const kept = artifacts.filter((a) => a?.theme !== 'dark');
        for (const a of kept) {
          await client.query(
            `INSERT INTO shots_eval_artifacts
               (id, trial_id, story_id, viewport, side, variant, media, content_type,
                data, width, height, bytes, sha256, focus_rect)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
            [shotsState.newId(), trialId, a.storyId, a.viewport, a.side, a.variant, a.media, a.contentType,
              a.data, a.width, a.height, a.bytes, a.sha256, a.focusRect ? JSON.stringify(a.focusRect) : null]
          );
        }
        await client.query('COMMIT');
        return kept.length;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    // What executeRun hands back when it is done: the trial as it stands.
    async getForSession(pool) {
      const { rows: [row] } = await pool.query(
        'SELECT id, state, failure_code FROM shots_eval_trials WHERE id = $1',
        [trialId]
      );
      return row || null;
    },
  };
}

// The shots agent with the arm's prompts. Its model and budget ride on the
// trial's own config (executeTrial); what Claude Code reports a turn cost is
// kept for when the proxy did not see it.
function promptedAgent(resolved, entry, agent = shotsAgent) {
  return {
    ...agent,
    async dispatch(cfg, options, agentDeps) {
      const out = await agent.dispatch(cfg, {
        ...options, systemPrompt: resolved.systemPrompt, taskPrompt: resolved.taskPrompt,
      }, agentDeps);
      const usd = Number(out?.result?.costUsd);
      if (Number.isFinite(usd) && usd > 0) entry.reportedCents += usd * 100;
      return out;
    },
  };
}

async function executeTrial(pool, config, trial, entry, deps = {}) {
  const orch = deps.orchestrator || orchestrator;
  const adapter = trialState(trial.id);
  const run = {
    id: trial.attempt_id,
    trial_id: trial.id,
    session_id: trial.session_id,
    base_sha: trial.base_sha,
    head_sha: trial.head_sha,
    intent: trial.intent,
    state: 'provisioning',
    current_run_id: trial.attempt_id,
  };
  const heartbeat = orch.startRunHeartbeat(pool, trial.attempt_id, adapter);
  try {
    const { rows: [configRow] } = trial.config_id == null ? { rows: [null] } : await pool.query(
      'SELECT recipe FROM shots_eval_configs WHERE id = $1', [trial.config_id]
    );
    const resolved = evals.resolveRecipe(config, configRow ? configRow.recipe : null);
    await pool.query('UPDATE shots_eval_trials SET recipe = $2::jsonb WHERE id = $1', [trial.id, JSON.stringify(resolved.summary)]);
    const trialConfig = {
      ...config,
      shots: { ...(config.shots || {}), agentModel: resolved.model, maxAgentMs: resolved.budgetMs },
    };
    const row = await orch.loadSession(pool, trial.session_id);
    const { session, app } = orch.publicSessionAndApp(row);
    const revision = await orch.resolveRevisionContext(session, trial.head_sha, deps.github || github, {
      baseSha: trial.base_sha,
    });
    await orch.executeRun(trialConfig, {
      pool, run, session, app, revision,
      onProgress: heartbeat.onProgress,
      onAgentDiagnostic: heartbeat.onAgentDiagnostic,
      onAgentFinalResponse: heartbeat.onAgentFinalResponse,
    }, {
      ...(deps.injected || {}),
      github: deps.github || github,
      state: adapter,
      shotsAgent: promptedAgent(resolved, entry, deps.shotsAgent),
      notifyShots: () => {},
    });
  } catch (error) {
    // executeRun fails the trial itself; a step before it (the session, the
    // revisions) fails it here.
    await orch.failCurrentRun(pool, trial.attempt_id, error, adapter).catch(() => false);
    throw error;
  } finally {
    heartbeat.stop();
  }
}

// What the trial cost goes on it and on its eval, once.
async function settleCost(pool, entry) {
  // With what another process's proxy billed for it (noteRemoteSpend).
  const { rows: [row] } = await pool.query('SELECT proxy_cents FROM shots_eval_trials WHERE id = $1', [entry.trialId]);
  const proxied = entry.proxyCents + num(row?.proxy_cents);
  const cents = Math.round(Math.max(proxied, entry.reportedCents) * 10_000) / 10_000;
  if (!(cents > 0)) return 0;
  await pool.query(
    `WITH trial AS (
       UPDATE shots_eval_trials SET cost_cents = cost_cents + $2::numeric WHERE id = $1 RETURNING eval_run_id
     )
     UPDATE shots_eval_runs r SET spent_cents = r.spent_cents + $2::numeric FROM trial WHERE r.id = trial.eval_run_id`,
    [entry.trialId, cents]
  );
  return cents;
}

function start(pool, config, trial, deps = {}, { capCents = 0, spentCents = 0 } = {}) {
  const entry = {
    trialId: Number(trial.id),
    attemptId: trial.attempt_id,
    sessionId: Number(trial.session_id),
    runId: Number(trial.eval_run_id),
    capCents: num(capCents),
    spentAtStartCents: num(spentCents),
    proxyCents: 0,
    reportedCents: 0,
    promise: null,
  };
  inFlight.set(entry.trialId, entry);
  billed.set(entry.sessionId, entry);
  log.info('shots-eval', 'Trial started', {
    trialId: entry.trialId, evalId: entry.runId, sessionId: entry.sessionId, configId: trial.config_id ?? null,
  });
  entry.promise = (deps.executeTrial || executeTrial)(pool, config, trial, entry, deps)
    .catch((err) => {
      log.warn('shots-eval', 'Trial ended without shots', {
        trialId: entry.trialId, evalId: entry.runId, code: err?.code || null, error: String(err?.message || err).slice(0, 300),
      });
    })
    .finally(async () => {
      billed.delete(entry.sessionId);
      try {
        await settleCost(pool, entry);
        await evals.settlePairs(pool, entry.runId);
      } catch (err) {
        log.warn('shots-eval', 'Could not settle a finished trial', { trialId: entry.trialId, error: err.message });
      }
      inFlight.delete(entry.trialId);
      wake();
    });
  return entry;
}

// A trial whose lease went quiet on a runner that is gone: its copies are
// removed, and it is queued again under a fresh attempt id, or failed after
// MAX_ATTEMPTS.
async function recoverStale(pool, config, deps = {}) {
  const { rows } = await pool.query(
    `SELECT t.id, t.attempt_id, t.attempts, t.eval_run_id, r.status AS run_status, a.slug AS app_slug
       FROM shots_eval_trials t
       JOIN shots_eval_runs r ON r.id = t.eval_run_id
       JOIN chat_sessions cs ON cs.id = t.session_id
       LEFT JOIN apps a ON a.id = cs.app_id
      WHERE t.state IN ('provisioning', 'exploring', 'reviewing')
        AND t.updated_at < NOW() - make_interval(secs => $1::int)
        AND NOT (t.id = ANY($2::int[]))`,
    [Math.round(STALE_MS / 1000), [...inFlight.keys()]]
  );
  let requeued = 0;
  let failed = 0;
  for (const t of rows) {
    if (t.app_slug) {
      const errors = await (deps.cleanupRunResources || shotsGc.cleanupRunResources)(config, { id: t.attempt_id, app_slug: t.app_slug })
        .catch((err) => [err]);
      if (errors?.length) {
        log.warn('shots-eval', 'Could not remove an interrupted trial\'s copies', {
          trialId: t.id, errors: errors.map((e) => e.message).slice(0, 4),
        });
      }
    }
    const again = Number(t.attempts) < MAX_ATTEMPTS && t.run_status === 'running';
    const { rowCount } = again
      ? await pool.query(
        `UPDATE shots_eval_trials
            SET state = 'planned', attempt_id = $3, started_at = NULL, updated_at = NOW(),
                recipe = NULL, hard_verdict = NULL, plan_hash = NULL, trace_summary = NULL,
                failure_code = NULL, failure_reason = NULL
          WHERE id = $1 AND attempt_id = $2 AND state IN ('provisioning', 'exploring', 'reviewing')`,
        [t.id, t.attempt_id, evals.newAttemptId()]
      )
      : await pool.query(
        `UPDATE shots_eval_trials
            SET state = 'failed', failure_code = 'shots_eval_interrupted', failure_reason = $3,
                completed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND attempt_id = $2 AND state IN ('provisioning', 'exploring', 'reviewing')`,
        [t.id, t.attempt_id, INTERRUPTED_REASON]
      );
    if (rowCount) {
      if (again) requeued += 1; else failed += 1;
    }
  }
  return { requeued, failed };
}

// A trial cancelled while it runs: its shots turn is stopped, and its next
// state change, which the cancelled row refuses, ends the run.
async function stopCancelled(pool, deps = {}) {
  if (!inFlight.size) return 0;
  const { rows } = await pool.query(
    "SELECT id, session_id FROM shots_eval_trials WHERE id = ANY($1::int[]) AND state = 'cancelled'",
    [[...inFlight.keys()]]
  );
  const w = deps.worker || worker;
  for (const row of rows) {
    const entry = inFlight.get(Number(row.id));
    if (!entry || entry.stopping) continue;
    entry.stopping = true;
    if (w.getActiveTurnMode?.(row.session_id) === 'shots') {
      Promise.resolve(w.stopTurn(row.session_id)).catch(() => {});
    }
  }
  return rows.length;
}

async function capRun(pool, runId) {
  await pool.query(
    `UPDATE shots_eval_trials SET state = 'cancelled', completed_at = NOW(), updated_at = NOW()
      WHERE eval_run_id = $1 AND state = 'planned'`,
    [runId]
  );
  await pool.query(
    "UPDATE shots_eval_runs SET status = 'capped', finished_at = NOW() WHERE id = $1 AND status = 'running'",
    [runId]
  );
}

/** One pass: recover, settle, finish evals that are done, start trials. */
async function tick(pool, config, deps = {}) {
  const out = { started: 0, finished: 0, capped: 0, recovered: null, paused: null };
  if (ticking) { tickAgain = true; return { ...out, busy: true }; }
  ticking = true;
  try {
    out.recovered = await recoverStale(pool, config, deps);
    await stopCancelled(pool, deps);
    const { rows: runs } = await pool.query(
      `SELECT r.id, r.cap_cents, r.spent_cents::float8 AS spent_cents, r.est_cents,
              COUNT(t.id) FILTER (WHERE t.state = 'planned')::int AS planned,
              COUNT(t.id) FILTER (WHERE t.state IN ('provisioning', 'exploring', 'reviewing'))::int AS active,
              COUNT(t.id)::int AS trials
         FROM shots_eval_runs r
         LEFT JOIN shots_eval_trials t ON t.eval_run_id = r.id
        WHERE r.status = 'running'
        GROUP BY r.id
        ORDER BY r.id`
    );
    const open = [];
    for (const run of runs) {
      await evals.settlePairs(pool, run.id);
      const mine = [...inFlight.values()].filter((e) => e.runId === Number(run.id)).length;
      if (!run.planned && !run.active && !mine) {
        const { rowCount } = await pool.query(
          "UPDATE shots_eval_runs SET status = 'done', finished_at = NOW() WHERE id = $1 AND status = 'running'",
          [run.id]
        );
        out.finished += rowCount || 0;
      } else if (run.planned) {
        open.push(run);
      }
    }
    if (!open.length) return out;
    const perTrialCents = await evals.estimateTrialCents(pool);
    const skipRuns = new Set();
    const skipSessions = new Set();
    while (inFlight.size < concurrency()) {
      if ((deps.isShuttingDown || lifecycle.isShuttingDown)()) { out.paused = 'stopping'; break; }
      const busy = [...new Set([...[...inFlight.values()].map((e) => e.sessionId), ...skipSessions])];
      const { rows: [next] } = await pool.query(
        `SELECT t.*
           FROM shots_eval_trials t
           JOIN shots_eval_runs r ON r.id = t.eval_run_id
           JOIN chat_sessions cs ON cs.id = t.session_id
          WHERE t.state = 'planned' AND r.status = 'running'
            AND NOT (t.eval_run_id = ANY($1::int[]))
            AND NOT (t.session_id = ANY($2::int[]))
            AND COALESCE(cs.shots_state, '') NOT IN ('planned', 'provisioning', 'exploring', 'replaying', 'reviewing')
            AND NOT EXISTS (
              SELECT 1 FROM shots_eval_trials o
               WHERE o.session_id = t.session_id AND o.state IN ('provisioning', 'exploring', 'reviewing'))
          ORDER BY t.eval_run_id, t.position
          LIMIT 1`,
        [[...skipRuns], busy]
      );
      if (!next) break;
      // The proposal's own shots under way (a manual rerun of a merged
      // proposal, whose slot may still read as settled) keep it for the
      // next pass.
      if (await (deps.shotsRunning || shotsState.shotsRunning)(next.session_id)) {
        skipSessions.add(Number(next.session_id));
        continue;
      }
      const run = open.find((r) => Number(r.id) === Number(next.eval_run_id));
      const { rows: [money] } = await pool.query(
        'SELECT spent_cents::float8 AS spent, cap_cents FROM shots_eval_runs WHERE id = $1',
        [next.eval_run_id]
      );
      const running = [...inFlight.values()].filter((e) => e.runId === Number(next.eval_run_id)).length;
      if (num(money?.spent) + (running + 1) * perTrialCents > num(money?.cap_cents)) {
        // Wait for what is under way, then stop the eval there.
        if (!running) {
          await capRun(pool, next.eval_run_id);
          out.capped += 1;
        }
        skipRuns.add(Number(next.eval_run_id));
        out.paused = out.paused || 'cap';
        continue;
      }
      const { rows: [claimed] } = await pool.query(
        `UPDATE shots_eval_trials
            SET state = 'provisioning', attempts = attempts + 1, started_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND state = 'planned'
          RETURNING *`,
        [next.id]
      );
      if (!claimed) continue;
      start(pool, config, claimed, deps, { capCents: money?.cap_cents, spentCents: money?.spent });
      out.started += 1;
      if (run) run.planned -= 1;
    }
    return out;
  } finally {
    ticking = false;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function schedule(delayMs) {
  if (!on) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      const { getPool } = require('../db/pool');
      await tick(getPool(runnerConfig), runnerConfig);
    } catch (err) {
      log.error('shots-eval', 'Runner pass failed', { err: err.message });
    } finally {
      if (tickAgain) { tickAgain = false; schedule(0); } else schedule(IDLE_MS);
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Start the runner on the leader. Inert until an eval is launched. */
function startRunner(config) {
  if (on) return;
  on = true;
  runnerConfig = config;
  schedule(IDLE_MS);
}

function stopRunner() {
  on = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * A pass now. The runner runs on the leader, and an eval is launched
 * wherever the request landed (a web process never leads,
 * docs/plans/web-and-conductor.md): a process not running it asks the
 * others over the bus (ws.js 'shots_eval_wake'). True when the pass was
 * scheduled here.
 */
function wake() {
  if (wakeHere()) return true;
  try { require('./ws-bus').publish('shots_eval_wake', null, {}); } catch { /* the runner polls anyway */ }
  return false;
}

/** The bus half of wake(): a pass if the runner runs here, never a publish. */
function wakeHere() {
  if (!on) return false;
  schedule(0);
  return true;
}

function inFlightAttemptIds() {
  return [...inFlight.values()].map((e) => e.attemptId);
}

function resetForTests() {
  inFlight.clear();
  billed.clear();
  stopRunner();
  ticking = false;
  tickAgain = false;
}

module.exports = {
  STALE_MS,
  MAX_ATTEMPTS,
  INTERRUPTED_REASON,
  concurrency,
  billsSession,
  noteSpend,
  overCap,
  remoteTrialFor,
  remoteOverCap,
  noteRemoteSpend,
  trialState,
  promptedAgent,
  executeTrial,
  settleCost,
  start,
  recoverStale,
  stopCancelled,
  capRun,
  tick,
  startRunner,
  stopRunner,
  wake,
  wakeHere,
  inFlightAttemptIds,
  _inFlight: inFlight,
  _resetForTests: resetForTests,
};
